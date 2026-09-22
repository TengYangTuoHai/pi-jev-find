/**
 * DeepSeek Harness plugin: registers the `find` tool (semantic search with a
 * judge-calibrated cascade) on DSH's tool registry.
 *
 * The cascade, judge, and ripgrep layers are host-agnostic (`src/cascade`,
 * `src/judge`, `src/rg.ts`) and the shared orchestration in `src/shared/`
 * produces the same model-facing digest pi gets; this module owns only the DSH
 * surface: the plugin shape, the config schema, the parameter schema, the system
 * prompt section, and the `/find` status command.
 *
 * ## What DSH gives `find` that the pi adapter can only emulate
 *
 * - The packaged ripgrep binary (`@vscode/ripgrep`) replaces the system-`rg`
 *   requirement, so the tool works on any Node 22+ host.
 * - `timeoutMs` turns a hung cascade into a bounded tool failure through
 *   `exec.signal`, instead of an unbounded pending call.
 * - `presentResult` renders a real search card (files grouped, ranges listed)
 *   instead of a text block.
 *
 * ## What is genuinely unavailable
 *
 * There is no per-call progress channel: DSH renders a pending call from
 * `presentCall(args)` and updates it only once the result lands, so the
 * cascade's phase narration is dropped (the `onProgress` hook is simply not
 * passed). Token/cost accounting has no tool-level channel either — DSH
 * attributes usage to model calls, not to tools — so the judge spend stays in
 * the result's footer text rather than in any usage ledger.
 *
 * @module pi-jev-find/dsh
 */

import type { Context } from "@deepseek-ai/cordis";
// Type-only: pulls the `commands` context augmentation into this program so the
// `/find` handler below is typed without taking a runtime dependency on the plugin.
import type {} from "@deepseek-ai/dsh-commands";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { type Budgets, DEFAULT_BUDGETS, loadConfig } from "../config.ts";
import { type JevConfigOverrides, resolveJevConfig } from "../judge/jev-judge.ts";
import { findDescription } from "../shared/description.ts";
import { runFind } from "../shared/run-find.ts";
import type { FindToolParams } from "../types.ts";
import { findCardMeta, type FindCardMeta, presentFindCall, presentFindResult } from "./present.ts";

/** Cordis plugin name used by loader diagnostics. */
export const name = "pi-jev-find";

/** Services this plugin registers against; `commands` is injected separately (see {@link apply}). */
export const inject = ["tools", "systemPrompt"];

/** DSH's own discovery tools: the shipped description points the model at these first. */
const DISCOVERY_TOOLS = { grep: "`grep`", glob: "`glob`" };

/** Cooperative tool-call timeout budget (ms) when the deployment sets none. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Plugin configuration. Every cascade budget is a field, so a deployment can
 * retune the cascade and the judge endpoint from `cordis.patch.yml` without a
 * code edit.
 *
 * Precedence is plugin config, then the `JF_*`/`JEV_*` environment variables the
 * pi adapter documents, then the shared defaults — so one environment description
 * covers both hosts while a deployment that configures the plugin explicitly
 * never has its values overridden by ambient environment.
 */
export interface Config {
	/** Register the tool at all; `false` leaves `/find` as a status check. */
	enabled?: boolean;
	/** Jev API key. Falls back to `JEV_API_KEY` / `TYPESAFE_API_KEY`. */
	apiKey?: string;
	/** Jev API root. Falls back to `JEV_BASE_URL` / `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai`. */
	baseUrl?: string;
	/** Jev judgment model. Falls back to `JEV_MODEL` / `TYPESAFE_DEFAULT_MODEL`, then `jev-latest`. */
	model?: string;
	/** Cooperative tool-call timeout budget (ms), enforced through `exec.signal`. */
	timeoutMs?: number;
	/** Requests in flight per dispatched cascade phase. */
	concurrency?: number;
	/** Files per filename-ranking request. */
	nameBatch?: number;
	/** Lexically ranked files that receive a filename judgment. */
	candidates?: number;
	/** Files whose content is read and sketched. */
	files?: number;
	/** Windows kept per read file. */
	windows?: number;
	/** Bytes per passage window, tags included. */
	windowBytes?: number;
	/** Bytes per sketch card. */
	sketchBytes?: number;
	/** Complete passages verified across all files. */
	fullLimit?: number;
}

export const Config: z<Config> = z.object({
	enabled: z.boolean().default(true),
	apiKey: z.string(),
	baseUrl: z.string(),
	model: z.string(),
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	concurrency: z.number(),
	nameBatch: z.number(),
	candidates: z.number(),
	files: z.number(),
	windows: z.number(),
	windowBytes: z.number(),
	sketchBytes: z.number(),
	fullLimit: z.number(),
});

/** The config after schemastery applied its defaults. */
type ResolvedConfig = Required<Pick<Config, "enabled" | "timeoutMs">> & Omit<Config, "enabled" | "timeoutMs">;

/** Every cascade budget counts items or bytes — a non-positive value silently breaks the cascade's arithmetic. */
function assertPositiveInteger(field: string, value: number): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`pi-jev-find: ${field} must be a positive integer`);
	}
}

/**
 * Merge a deployment's budget fields over the `JF_*` environment budgets and the
 * shared defaults. The environment read goes through the same {@link loadConfig}
 * the pi adapter uses, so both hosts interpret an out-of-range `JF_*` value
 * identically (clamped, never thrown).
 * @param config - the resolved plugin configuration.
 * @returns the effective budgets; every field is a positive integer.
 * @throws Error when an explicit config field is not a positive integer.
 */
function resolveBudgets(config: Config): Budgets {
	const env = loadConfig().budgets;
	const budgets = { ...DEFAULT_BUDGETS };
	for (const key of Object.keys(DEFAULT_BUDGETS) as (keyof Budgets)[]) {
		const override = config[key];
		budgets[key] = typeof override === "number" ? override : env[key];
		assertPositiveInteger(key, budgets[key]);
	}
	return budgets;
}

/** The judge endpoint fields a deployment set, in the shape `resolveJevConfig` reads. */
function judgeOverrides(config: Config): JevConfigOverrides {
	const overrides: JevConfigOverrides = {};
	if (config.apiKey !== undefined) overrides.apiKey = config.apiKey;
	if (config.baseUrl !== undefined) overrides.baseUrl = config.baseUrl;
	if (config.model !== undefined) overrides.model = config.model;
	return overrides;
}

/** `candidates=128 files=20 …`, the status line both hosts print. */
function formatBudgets(budgets: Budgets): string {
	return (
		`candidates=${budgets.candidates} files=${budgets.files} windows=${budgets.windows} `
		+ `windowBytes=${budgets.windowBytes} sketchBytes=${budgets.sketchBytes} `
		+ `fullLimit=${budgets.fullLimit} concurrency=${budgets.concurrency}`
	).replace(/\s+/u, " ");
}

/** The canonical value one `find` call returns (the shape `output.schema` enforces). */
type FindValue = {
	/** The complete model-facing digest. */
	text: string;
	/** The bounded card meta the UI renders (and replays). */
	meta: FindCardMeta;
};

/**
 * Register the `find` tool and its system-prompt section.
 *
 * A misleading tool is worse than a missing one: DSH already ships `grep`/`glob`,
 * and a listed-but-broken `find` burns one failed call and then never gets picked
 * again for the whole session. So when no Jev key resolves, or the budgets are
 * invalid, the plugin logs the reason and registers only `/find`.
 *
 * @param ctx - plugin context; every registration is an effect cleaned up on unload.
 * @param config - resolved plugin configuration from schemastery.
 */
export function apply(ctx: Context, config: Config): void {
	const resolved = config as ResolvedConfig;
	const judge = judgeOverrides(resolved);
	const logger = ctx.logger("pi-jev-find");

	let budgets = DEFAULT_BUDGETS;
	let ready = true;
	try {
		assertPositiveInteger("timeoutMs", resolved.timeoutMs);
		resolveJevConfig(process.env, judge);
		budgets = resolveBudgets(resolved);
	} catch (error: unknown) {
		ready = false;
		logger.warn(`find tool NOT registered — ${error instanceof Error ? error.message : String(error)}`);
	}

	if (resolved.enabled && ready) {
		ctx.systemPrompt.section({
			name: "tool:find",
			order: ctx.systemPrompt.getSectionOrder("TOOL_GREP") + 1,
			text: () =>
				ctx.tools.get("grep") === undefined
					? "Use the find tool for concept lookups: a plain-language query returns files and calibrated line ranges."
					: "Use the find tool — not grep — when the words you would search for may differ from the code's identifiers "
						+ '(e.g. "where do we expire sessions?" when the code says `sess_ttl`), or when greps have already returned noise. '
						+ "Use grep for exact strings, regexes, and known symbols; glob for file names.",
		});

		ctx.tools.register(
			defineTool({
				name: "find",
				description: findDescription(DISCOVERY_TOOLS),
				parameters: {
					query: {
						type: "string",
						required: true,
						description: "what to find, in plain language (concept or behavior, not a regex)",
					},
					grep_keywords: {
						type: "array",
						required: true,
						items: { type: "string" },
						description:
							"identifiers or terms likely to appear verbatim in matching source; steer lexical pre-ranking. [] when unsure",
					},
					path: {
						type: "string",
						description: "directory to search. Omitted -> the workspace root; a relative path resolves against it",
					},
				},
				timeoutMs: resolved.timeoutMs,
				// A read-only search never conflicts with a sibling call.
				isConcurrencySafe: () => true,
				output: {
					// The digest text and the card meta are both produced once, by the
					// shared run and the presenter, so the model-facing text and the card
					// can never disagree about which ranges survived.
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							text: { type: "string", required: true, description: "The complete model-facing digest." },
							meta: { type: "json", required: true, description: "The bounded search-card metadata." },
						},
					},
					render: (_args, value) => [{ type: "text", text: value.text }],
					presentationMeta: (_args, value) => value.meta,
				},
				// The one place the cascade is driven: the search scope is the calling
				// agent's session workspace — never the server's launch directory — and
				// cancellation is the caller's signal, so a cancelled or timed-out call
				// stops every in-flight judge request and ripgrep run.
				async execute(args: FindToolParams, exec) {
					const { details, digest } = await runFind({
						cwd: exec.agent?.session.header.cwd ?? process.cwd(),
						params: args,
						budgets,
						judge,
						signal: exec.signal,
					});
					return { text: digest, meta: findCardMeta(details) };
				},
				presentCall: presentFindCall,
				presentResult: (_args, result) => presentFindResult(result),
			}),
		);
	}

	// A status command is not worth a hard dependency on the commands plugin —
	// `commands` is its own plugin, and a deployment without it should still get
	// the tool. `ctx.inject` runs this callback only once that service exists.
	ctx.inject(["commands"], child => {
		child.commands.register({
			name: "find",
			description: "Show the resolved Jev judge and cascade budgets",
			handler: () => {
				const lines: string[] = [];
				try {
					const jev = resolveJevConfig(process.env, judge);
					lines.push(`pi-jev-find judge: jev ${jev.model} @ ${jev.baseUrl} (key from ${jev.keySource})`);
				} catch (error: unknown) {
					lines.push(`pi-jev-find: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (resolved.enabled && ready) {
					lines.push(`pi-jev-find budgets: ${formatBudgets(budgets)}`);
				} else {
					lines.push("pi-jev-find: the find tool is not registered in this deployment");
				}
				return { kind: "success", text: lines.join("\n") };
			},
		});
	});
}
