/**
 * pi-jev-find extension entry: registers the `find` tool (semantic grep with a
 * judge-calibrated cascade) and a `/find` status command.
 *
 * The tool contract and model-facing digest are ported from oh-my-pi
 * `packages/coding-agent/src/tools/jfind/index.ts` (MIT); the judge is the
 * native Jev probability API (System One), configured purely through
 * environment variables: JEV_API_KEY / JEV_BASE_URL / JEV_MODEL.
 */
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCascade } from "./cascade/cascade.ts";
import { rankedHeat } from "./cascade/passages.ts";
import { loadConfig } from "./config.ts";
import { JevJudge, resolveJevConfig } from "./judge/jev-judge.ts";
import { renderFindCall, renderFindResult } from "./render.ts";
import type { FindDetails, FindToolParams } from "./types.ts";

const parameters = Type.Object({
	query: Type.String({
		description: "what to find, in plain language (concept or behavior, not a regex)",
	}),
	grep_keywords: Type.Array(Type.String(), {
		description:
			"identifiers or terms likely to appear verbatim in matching source; steer lexical pre-ranking. [] when unsure",
	}),
	path: Type.Optional(Type.String({ description: "directory to search. Omitted -> the workspace root" })),
});

const DESCRIPTION = `Semantic grep: describe what you are looking for in plain language; returns the files and line ranges that implement it, each with a calibrated 0-1 relevance score. No index; searches the live workspace tree on every call.

- \`query\`: a concept or behavior ("where do we verify JWT tokens?", "retry budget for failed requests"), not a regex. Quoted phrases in \`query\` are matched whole.
- \`grep_keywords\`: identifiers, symbols, or terms likely to appear verbatim in matching source; they steer the lexical pre-ranking. Pass \`[]\` when nothing specific comes to mind.
- \`path\`: one directory to search; omit for the workspace root. Narrow it when you already know the subsystem.
- Results are strongest first as \`path:start-end score snippet\`; open ranges with \`read\`.
- Scores are absolute yes/no probabilities: comparable across calls; below ~0.4 is weak evidence, so widen the query or fall back to \`grep\` before concluding absence.
- \`grep\` is for exact strings, regexes, and known symbols; \`glob\` is for file names. Reach for them after \`find\` has narrowed the files, or when the target is literally a string.
- Every call spends judge requests over the search scope; batch related questions into one descriptive \`query\` instead of many narrow calls.`;

const PROMPT_SNIPPET =
	"find: semantic search — describe a behavior in plain language, get files and calibrated line ranges that implement it";

const PROMPT_GUIDELINES = [
	"When you do not already know where a behavior lives, call `find` once with a descriptive query instead of chaining guessed `grep` patterns and `glob` sweeps followed by speculative reads.",
	"`grep` and `glob` come after `find` has narrowed the files, or when the target is an exact string or file name.",
];

/** Line ranges shown per hit in the model-facing text, strongest first. */
const RANGES_SHOWN = 3;

function toDisplay(rel: string, root: string, cwd: string): string {
	const relative = path.relative(cwd, path.join(root, rel));
	if (relative.startsWith("..")) return rel;
	return relative.split(path.sep).join("/");
}

async function resolveRoot(rawPath: string | undefined, cwd: string): Promise<string> {
	const input = (rawPath ?? "").trim();
	if (input.length === 0) return path.resolve(cwd);
	const root = path.resolve(cwd, input);
	let stat: Stats;
	try {
		stat = await fs.stat(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Path not found: ${input}`);
		throw error;
	}
	if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${input}`);
	return root;
}

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

function formatDigest(
	query: string,
	scopePath: string | undefined,
	details: FindDetails,
	stats: FindDetails["stats"],
): string {
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
			for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
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

export default function jfindExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	if (!config.enabled) return;

	pi.registerTool({
		name: "find",
		label: "Find",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters,
		async execute(_toolCallId, params: FindToolParams, signal, onUpdate, ctx) {
			const query = params.query.trim();
			if (query.length === 0) throw new Error("`query` must be a non-empty description");
			const root = await resolveRoot(params.path, ctx.cwd);
			const scopePath =
				root === path.resolve(ctx.cwd)
					? undefined
					: `${path.relative(ctx.cwd, root).split(path.sep).join("/")}/`;
			const jev = resolveJevConfig();
			const judge = new JevJudge(jev);
			const started = performance.now();
			const result = await runCascade({
				root,
				query,
				extraKeywords: params.grep_keywords,
				judge,
				includeHidden: false,
				budgets: config.budgets,
				signal,
				onProgress: message =>
					onUpdate?.({ content: [{ type: "text", text: message }] } as AgentToolResult<FindDetails>),
			});
			const elapsedMs = performance.now() - started;
			const { stats, threshold, keywords } = result;
			const hits = result.hits.map(hit => ({ ...hit, rel: toDisplay(hit.rel, root, ctx.cwd) }));
			const details: FindDetails = { query, keywords, threshold, hits, stats, elapsedMs, cwd: ctx.cwd, scopePath };
			const digest = formatDigest(query, scopePath, details, stats);
			if (stats.requests > 0 && stats.errors === stats.requests) {
				throw new Error(
					`find failed — all ${stats.requests} judge requests failed:\n${stats.failures.join("\n") || "unknown errors"}`,
				);
			}
			return {
				content: [{ type: "text", text: digest }],
				details,
				usage: {
					input: stats.inputTokens,
					output: stats.outputTokens,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: stats.inputTokens + stats.outputTokens,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: stats.cost,
					},
				},
			};
		},
		renderCall(args, theme) {
			return renderFindCall(args, theme);
		},
		renderResult(result, options, theme) {
			const details = result.details as FindDetails | undefined;
			const isError = (result as { isError?: boolean }).isError === true;
			return renderFindResult(details, isError, options.expanded, theme);
		},
	});

	pi.registerCommand("find", {
		description: "pi-jev-find: show the resolved Jev judge and cascade budgets",
		handler: async (_args, ctx) => {
			const current = loadConfig();
			try {
				const jev = resolveJevConfig();
				ctx.ui.notify(`pi-jev-find judge: jev ${jev.model} @ ${jev.baseUrl} (key from ${jev.keySource})`, "info");
			} catch (error) {
				ctx.ui.notify(`pi-jev-find: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			ctx.ui.notify(
				`budgets: candidates=${current.budgets.candidates} files=${current.budgets.files} windows=${current.budgets.windows} windowBytes=${current.budgets.windowBytes} sketchBytes=${current.budgets.sketchBytes} fullLimit=${current.budgets.fullLimit} concurrency=${current.budgets.concurrency}`,
				"info",
			);
		},
	});
}
