/**
 * DSH render intents for the `find` tool: a pending generic card carrying the
 * query, and a completed search card that groups the judged line ranges by file.
 *
 * The search card rides in the tool result's `presentationMeta`, which the host
 * persists with the session log and replays — so the meta is self-contained,
 * bounded, JSON-assignable, and defensively narrowed on read-back. The
 * model-facing digest stays the source of truth for the model (it carries the
 * exact `start-end` span and the calibrated probability of every range); the
 * card is a second, structured projection of the same hits for a UI.
 *
 * `SearchMatchesResultView` is DSH's shape for a content search grouped by file:
 * one entry per file with `{lineNumber, line}` matches. A judged RANGE has no
 * DSH analogue and `SearchLineMatch` has no score field, so each range is
 * projected as one match at its first line (`lineNumber: range.start`) with the
 * range's one-line snippet as its text: the card answers "which file, which
 * line", and the digest answers "how strong, exactly which span".
 *
 * @module pi-jev-find/dsh/present
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SearchFileMatches, SearchResultView, ToolCallView, ToolResultView } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { rankedHeat } from "../cascade/passages.ts";
import type { FindDetails, FindToolParams } from "../types.ts";

/** Ranges projected into the card per file. */
export const CARD_RANGES_PER_FILE = 3;
/** Ranges projected into the card across all files. */
export const CARD_RANGES_MAX = 60;
/** Byte budget for the serialized card meta. */
export const CARD_META_MAX_BYTES = 16 * 1024;

/** One judged range projected for the card. */
export type FindCardRange = {
	/** 1-based first line of the range. */
	line: number;
	/** 1-based last line; equals `line` for a single-line range. */
	endLine: number;
	/** Calibrated yes-probability of the range. */
	p: number;
	/** The range's one-line preview. */
	snippet: string;
};

/** One file's projected ranges. */
export type FindCardFile = {
	path: string;
	/** Best passage score across the file's judged windows. */
	score: number;
	/** Judged ranges, strongest first. */
	ranges: FindCardRange[];
};

/**
 * The `find` tool's private `tool/result` meta: the completed search card,
 * bounded so it stays cheap to persist and replay. Type aliases (not
 * interfaces) because the host validates the projected value as `JsonValue`,
 * which only an object *type* is assignable to.
 */
export type FindCardMeta = {
	/** Judged ranges the cascade found, before the card's own budget dropped any. */
	total: number;
	/** Whether the card carries fewer ranges than `total`. */
	truncated: boolean;
	/** Judge threshold the hits cleared, so a UI can label the score scale. */
	threshold: number;
	/** Files with their strongest judged ranges, strongest first. */
	files: FindCardFile[];
};

/** The pending-call card: what is being searched for, and where. */
export function presentFindCall(args: FindToolParams): ToolCallView {
	const title = args.path === undefined ? `Find "${args.query}"` : `Find "${args.query}" in ${args.path}`;
	const keywords = args.grep_keywords ?? [];
	const rawInput: Record<string, JsonValue> = { query: args.query };
	if (args.path !== undefined) rawInput.path = args.path;
	if (keywords.length > 0) rawInput.grep_keywords = [...keywords];
	return { card: "generic", title, kind: "search", rawInput };
}

/**
 * Project the details of a completed run into the card meta.
 * @param details - the run's structured details.
 * @param maxBytes - serialized-meta byte budget; trailing ranges drop past it.
 * @returns the card meta, with `truncated` set when anything was dropped.
 */
export function findCardMeta(details: FindDetails, maxBytes: number = CARD_META_MAX_BYTES): FindCardMeta {
	const total = details.hits.reduce((sum, hit) => sum + hit.ranges.length, 0);
	const files: FindCardFile[] = [];
	let kept = 0;
	for (const hit of details.hits) {
		if (kept >= CARD_RANGES_MAX) break;
		const ranges = rankedHeat(hit.ranges, Math.min(CARD_RANGES_PER_FILE, CARD_RANGES_MAX - kept)).map(range => ({
			line: range.start,
			endLine: range.end,
			p: range.p,
			snippet: range.snippet,
		}));
		kept += ranges.length;
		files.push({ path: hit.rel, score: hit.contentScore, ranges });
	}
	const meta: FindCardMeta = { total, truncated: kept < total, threshold: details.threshold, files };
	return capMeta(meta, maxBytes);
}

/**
 * Drop trailing ranges until the serialized meta fits `maxBytes`. The meta is
 * persisted with the session log and re-sent on every request, so an unbounded
 * card would be paid for on every turn; a deployment's output budget shrinks
 * the model-facing content, never this projection.
 */
function capMeta(meta: FindCardMeta, maxBytes: number): FindCardMeta {
	if (serializedBytes(meta) <= maxBytes) return meta;
	const files: FindCardFile[] = [];
	for (const file of meta.files) {
		const ranges: FindCardRange[] = [];
		for (const range of file.ranges) {
			const candidate: FindCardFile = { path: file.path, score: file.score, ranges: [...ranges, range] };
			const probe: FindCardMeta = { ...meta, files: [...files, candidate], truncated: true };
			if (serializedBytes(probe) > maxBytes) break;
			ranges.push(range);
		}
		if (ranges.length > 0) files.push({ path: file.path, score: file.score, ranges });
	}
	return { total: meta.total, truncated: true, threshold: meta.threshold, files };
}

/** The serialized size of one meta value in UTF-8 bytes. */
function serializedBytes(value: FindCardMeta): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Whether `value` is a valid {@link FindCardRange} (defensive narrowing of replayed meta). */
function isCardRange(value: unknown): value is FindCardRange {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const { line, endLine, p, snippet } = value as Record<string, unknown>;
	return typeof line === "number" && typeof endLine === "number" && typeof p === "number" && typeof snippet === "string";
}

/** Whether `value` is a valid {@link FindCardFile} (defensive narrowing of replayed meta). */
function isCardFile(value: unknown): value is FindCardFile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const { path, score, ranges } = value as Record<string, unknown>;
	return typeof path === "string" && typeof score === "number" && Array.isArray(ranges) && ranges.every(isCardRange);
}

/**
 * Narrow opaque live or replayed meta into a DSH search card. Malformed meta —
 * an older or hand-edited session log — yields `undefined` so the presenter can
 * fall back to the generic card instead of throwing during replay. A zero-hit
 * run narrows to a valid empty card, not to an absent projection: "no hits" is a
 * legitimate result a UI shows, not a missing one.
 * @param meta - the meta the tool projected (or replayed from a log).
 * @returns the search card, or `undefined` when the meta is unusable.
 */
export function findViewFromMeta(meta: unknown): SearchResultView | undefined {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	const record = meta as Record<string, unknown>;
	const { total, truncated, threshold, files } = record;
	if (typeof total !== "number" || typeof truncated !== "boolean" || typeof threshold !== "number") return undefined;
	if (!Array.isArray(files) || !files.every(isCardFile)) return undefined;
	const groups: SearchFileMatches[] = files.map(file => ({
		path: file.path,
		matches: file.ranges.map(range => ({ lineNumber: range.line, line: range.snippet })),
	}));
	return {
		card: "search",
		shape: "matches",
		title: `find — ${total} judged range${total === 1 ? "" : "s"} (τ ${threshold.toFixed(2)})`,
		files: groups,
		truncated,
		total,
	};
}

/** The number of ranges the meta carries, for the generic fallback's summary line. */
function metaRangeCount(meta: FindCardMeta): number {
	return meta.files.reduce((sum, file) => sum + file.ranges.length, 0);
}

/** Whether a replayed meta has at least the fields the fallback title reads. */
function metaSummary(meta: unknown): string | undefined {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	const files = (meta as Record<string, unknown>).files;
	if (!Array.isArray(files) || !files.every(isCardFile)) return undefined;
	const count = metaRangeCount({ total: 0, truncated: false, threshold: 0, files });
	return `find — ${count} judged range${count === 1 ? "" : "s"}`;
}

/**
 * The completed-call render intent: the search card when the call succeeded and
 * projected usable meta, otherwise a generic card that keeps the model-facing
 * content — a failure, or a replayed log whose meta did not survive narrowing.
 * @param result - the final model-facing result the host normalized.
 * @returns the completed-call view.
 */
export function presentFindResult(result: { isError: boolean; meta?: JsonValue; content: ContentBlock[] }): ToolResultView {
	if (result.isError) return { card: "generic", title: "find failed", content: result.content };
	const view = findViewFromMeta(result.meta);
	if (view !== undefined) return view;
	const title = metaSummary(result.meta);
	return title === undefined ? { card: "generic", content: result.content } : { card: "generic", title, content: result.content };
}
