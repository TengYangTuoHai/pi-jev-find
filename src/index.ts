/**
 * pi extension entry: registers the `find` tool (semantic search with a
 * judge-calibrated cascade) and a `/find` status command.
 *
 * The tool contract and model-facing digest are ported from oh-my-pi
 * `packages/coding-agent/src/tools/jfind/index.ts` (MIT). Everything shared
 * with the DSH adapter lives under `src/shared/`; this file owns only the pi
 * surface: the typebox parameter schema, pi-tui renderers, the per-call usage
 * report, and the status command.
 *
 * The judge is the native Jev probability API (System One), configured purely
 * through environment variables: JEV_API_KEY / JEV_BASE_URL / JEV_MODEL.
 */
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { resolveJevConfig } from "./judge/jev-judge.ts";
import { renderFindCall, renderFindResult } from "./render.ts";
import { type DiscoveryToolNames, FIND_PROMPT_SNIPPET, findDescription, findPromptGuidelines } from "./shared/description.ts";
import { runFind } from "./shared/run-find.ts";
import type { FindDetails, FindStats, FindToolParams } from "./types.ts";

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

/** pi's discovery tools: the copy tells the model to reach for these first. */
const DISCOVERY_TOOLS: DiscoveryToolNames = { grep: "`ffgrep`/grep", glob: "`fffind`/glob" };

/** pi reports provider usage per call so its cost accounting includes the judge spend. */
function usageFromStats(stats: FindStats) {
	return {
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
	};
}

export default function jfindExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	if (!config.enabled) return;

	// Resolve the judge endpoint at startup. A listed-but-broken tool burns one
	// failed call and then never gets picked again for the whole session — skip
	// registration instead so the model only ever sees a working `find`.
	let judgeReady = true;
	try {
		resolveJevConfig();
	} catch (error) {
		judgeReady = false;
		console.error(`pi-jev-find: find tool NOT registered — ${error instanceof Error ? error.message : String(error)}`);
	}

	if (judgeReady) {
		pi.registerTool({
			name: "find",
			label: "Find",
			description: findDescription(DISCOVERY_TOOLS),
			promptSnippet: FIND_PROMPT_SNIPPET,
			promptGuidelines: findPromptGuidelines(DISCOVERY_TOOLS),
			parameters,
			async execute(_toolCallId, params: FindToolParams, signal, onUpdate, ctx) {
				const { details, digest } = await runFind({
					cwd: ctx.cwd,
					params,
					budgets: config.budgets,
					signal,
					onProgress: message =>
						onUpdate?.({ content: [{ type: "text", text: message }] } as AgentToolResult<FindDetails>),
				});
				return {
					content: [{ type: "text", text: digest }],
					details,
					usage: usageFromStats(details.stats),
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
	}

	// Always available as a status/diagnostic command, even without a key.
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
