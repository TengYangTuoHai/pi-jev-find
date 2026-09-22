/**
 * The model-facing result digest: hits strongest first as
 * `path:start-end score snippet`, then a one-line accounting footer. Shared by
 * both hosts so the model sees identical evidence whichever one runs the tool.
 */
import { rankedHeat } from "../cascade/passages.ts";
import type { FindDetails } from "../types.ts";

/** Line ranges shown per hit, strongest first. */
export const DIGEST_RANGES_SHOWN = 3;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * Render the complete model-facing text for one cascade result.
 * @param query - the trimmed natural-language query.
 * @param scopePath - display form of the search scope when narrower than the
 * workspace root (with trailing slash), else `undefined`.
 * @param details - everything the cascade reported besides the raw digest.
 * @returns the text the model receives as the tool result.
 */
export function formatDigest(query: string, scopePath: string | undefined, details: FindDetails): string {
	const stats = details.stats;
	const where = scopePath === undefined ? "" : ` in ${scopePath}`;
	const out: string[] = [];
	if (details.hits.length === 0) {
		out.push(`no hits for "${query}"${where} (τ ${details.threshold.toFixed(2)})`);
	} else {
		out.push(
			`${details.hits.length} hit(s) for "${query}"${where} (τ ${details.threshold.toFixed(2)}), strongest first`,
			"",
		);
		for (const hit of details.hits) {
			const coverage = hit.truncated
				? `${hit.linesSeen} lines judged, partial`
				: `${hit.linesSeen} lines judged`;
			out.push(`${hit.rel}  ${hit.contentScore.toFixed(2)}  ${coverage}`);
			for (const range of rankedHeat(hit.ranges, DIGEST_RANGES_SHOWN)) {
				const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
				out.push(`  ${hit.rel}:${span}  ${range.p.toFixed(2)}  ${range.snippet}`);
			}
		}
	}
	out.push(
		"",
		`listed ${stats.filesListed} · judged ${stats.judged} · read ${stats.filesRead} files (${formatBytes(stats.fileBytes)}) · ${stats.requests} requests · ${formatNumber(stats.inputTokens)} tokens · $${stats.cost.toFixed(4)} · ${formatDuration(details.elapsedMs)} wall / ${formatDuration(stats.apiMs)} api`,
	);
	if (stats.failures.length > 0) {
		out.push(`${stats.errors} of ${stats.requests} requests failed:`, ...stats.failures.map(failure => `  ${failure}`));
	}
	return out.join("\n");
}
