/**
 * Shared result shapes. These mirror the omp `@oh-my-pi/pi-tui/tools/find`
 * types (MIT, oh-my-pi) so the cascade port stays shape-compatible.
 */

/** A judged line range: 1-based inclusive lines, yes-probability, one-line preview. */
export interface FindRange {
	start: number;
	end: number;
	p: number;
	snippet: string;
}

/** One file hit returned by the cascade. */
export interface FindHit {
	/** Root-relative display path with `/` separators. */
	rel: string;
	/** Name-judge probability when the filename was judged; undefined for lexical champions. */
	nameScore?: number;
	/** Best passage score across judged windows. */
	contentScore: number;
	/** Judged ranges, strongest first. */
	ranges: FindRange[];
	/** Lines actually inspected. */
	linesSeen: number;
	/** Whether the read was cut at the byte cap. */
	truncated: boolean;
}

/** Parameters of the find tool, matching the typebox schema in index.ts. */
export interface FindToolParams {
	query: string;
	grep_keywords: string[];
	path?: string;
}

/** Everything the renderer and the tool result need besides the raw digest. */
export interface FindDetails {
	query: string;
	keywords: string[];
	threshold: number;
	hits: FindHit[];
	stats: FindStats;
	elapsedMs: number;
	cwd: string;
	/** Display form of the search scope when narrower than cwd, with trailing slash. */
	scopePath?: string;
}

/** Cascade accounting surfaced to the renderer and stats footer. */
export interface FindStats {
	filesListed: number;
	requests: number;
	errors: number;
	judged: number;
	filesRead: number;
	fileBytes: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	apiMs: number;
	windowsJudged: number;
	windowsPruned: number;
	mapCards: number;
	failures: string[];
}
