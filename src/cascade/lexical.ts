/**
 * Lexical prior: per-file keyword occurrence counts from one ripgrep pass,
 * turned into IDF weights and a file score that ranks candidates before any
 * judgment is spent.
 *
 * Ported from oh-my-pi `packages/coding-agent/src/tools/jfind/lexical.ts`
 * (MIT); the native grep backend is replaced by `rg --json`. Deviation: rg
 * skips files over 16 MB (`--max-filesize`), so `filesScanned` counts files rg
 * actually searched rather than every file offered; IDF is clamped to
 * [0.5, 6], which bounds the effect on ranking.
 */
import { RgError, runRg } from "../rg.ts";
import { countOccurrences } from "./text.ts";

export interface GrepIndex {
	/** Lowercased, non-empty keywords; `perFileKw` vectors align with this. */
	keywords: string[];
	/** rel file path → per-keyword occurrence counts over matching lines. */
	perFileKw: Map<string, number[]>;
	/** Files the scan opened (rg `begin` events), including ones with no match. */
	filesScanned: number;
}

/** Regex-escape a literal keyword for the rg alternation. */
function escapeRegex(keyword: string): string {
	return keyword.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, "\\$&");
}

export interface GrepIndexOptions {
	includeHidden: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** rg `--json` events this module consumes; everything else is ignored. */
interface RgPathEvent {
	type: string;
	data?: { path?: { text?: string }; lines?: { text?: string } };
}
interface RgSummaryEvent {
	type: "summary";
	data?: { stats?: { searches?: number } };
}

/**
 * Count keyword occurrences (case-insensitive, any keyword) in every file under
 * `root`. Only lines containing a keyword are inspected, so counts are per
 * matching line rather than per file byte.
 */
export async function grepIndex(
	root: string,
	rawKeywords: readonly string[],
	options: GrepIndexOptions,
): Promise<GrepIndex> {
	const keywords = rawKeywords.map(keyword => keyword.toLowerCase()).filter(keyword => keyword.length > 0);
	const index: GrepIndex = { keywords, perFileKw: new Map(), filesScanned: 0 };
	if (keywords.length === 0) return index;
	const run = await runRg(
		root,
		[
			"--json",
			"--ignore-case",
			"--no-messages",
			"--max-filesize",
			"16M",
			...(options.includeHidden ? ["--hidden"] : []),
			"--",
			keywords.map(escapeRegex).join("|"),
		],
		{ signal: options.signal, timeoutMs: options.timeoutMs },
	);
	for (const raw of run.stdout.toString("utf8").split("\n")) {
		if (raw.length === 0) continue;
		let event: RgPathEvent | RgSummaryEvent;
		try {
			event = JSON.parse(raw) as RgPathEvent | RgSummaryEvent;
		} catch {
			continue;
		}
		if (event.type === "summary") {
			// The summary event is always emitted and reports the number of files
			// rg actually opened (searches), with or without matches — the corpus
			// size the IDF denominator needs. `begin` events would not do: rg only
			// emits them for files that matched.
			const searches = (event as RgSummaryEvent).data?.stats?.searches;
			if (typeof searches === "number") index.filesScanned = Math.max(index.filesScanned, searches);
		} else if (event.type === "match") {
			const match = event as RgPathEvent;
			const rel = match.data?.path?.text;
			const line = match.data?.lines?.text;
			if (rel === undefined || line === undefined) continue; // non-UTF-8 path payload
			let counts = index.perFileKw.get(rel);
			if (!counts) {
				counts = Array.from({ length: keywords.length }, () => 0);
				index.perFileKw.set(rel, counts);
			}
			const lower = line.toLowerCase();
			for (let k = 0; k < keywords.length; k++) {
				counts[k]! += countOccurrences(lower, keywords[k]!);
			}
		}
	}
	return index;
}

/**
 * Inverse document frequency per keyword, clamped to `[0.5, 6]`: rarity is
 * capped so a word occurring once in a test fixture cannot beat an
 * implementation that contains several query concepts repeatedly.
 */
export function idf(index: GrepIndex): number[] {
	return index.keywords.map((_, k) => {
		let df = 0;
		for (const counts of index.perFileKw.values()) {
			if ((counts[k] ?? 0) > 0) df++;
		}
		const weight = Math.log((index.filesScanned + 1) / (df + 1));
		return Math.min(6, Math.max(0.5, weight));
	});
}

/**
 * Lexical rank of a file: rare query terms count more, log-scaled frequency
 * keeps common words in a giant file from overwhelming a compact
 * implementation with several terms, and a keyword in the path is worth two
 * extra log-units.
 */
export function fileScore(
	counts: readonly number[],
	weights: readonly number[],
	rel: string,
	keywords: readonly string[],
): number {
	const lower = rel.toLowerCase();
	let score = 0;
	for (let k = 0; k < keywords.length; k++) {
		const inPath = lower.includes(keywords[k]!) ? 1 : 0;
		score += weights[k]! * (2 * inPath + Math.log1p(counts[k] ?? 0));
	}
	return score;
}

export { RgError };
