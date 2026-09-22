/**
 * Jev judge: native System One probability API (TypeSafe's `POST /v1/systemone`,
 * the same wire jegrep uses). The cascade's `JudgeRequest` — `{state, questions}` —
 * is forwarded verbatim with the model id; answers come back as absolute noul
 * probabilities, no chat-JSON emulation.
 *
 * Ported from oh-my-pi `packages/ai/src/judgment/typesafe.ts` (MIT), reduced to
 * the noul-only surface this cascade needs and driven entirely by environment
 * variables so the extension carries no provider plumbing:
 *
 * - `JEV_API_KEY` (or `TYPESAFE_API_KEY`, jegrep-compatible)
 * - `JEV_BASE_URL` (or `TYPESAFE_BASE_URL`; default `https://api.typesafe.ai`)
 * - `JEV_MODEL` (or `TYPESAFE_DEFAULT_MODEL`; default `jev-latest`)
 */
import type { Judge, JudgeRequest, JudgeAnswer, JudgmentResult } from "./types";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const JUDGMENT_ROUTE = "/v1/systemone";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;

/** Resolved Jev configuration, for the /find status line. */
export interface JevConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	/** Where the key came from: the environment variable name, or `plugin config` for a host override. Never the key itself. */
	keySource: string;
}

/** Host-supplied overrides; an unset field keeps its environment/default resolution. */
export interface JevConfigOverrides {
	apiKey?: string;
	baseUrl?: string;
	model?: string;
}

/** The plugin-config source label reported by {@link JevConfig.keySource}. */
const CONFIG_KEY_SOURCE = "plugin config";

function readEnv(env: Record<string, string | undefined>, name: string, fallbackName?: string): { value: string | undefined; source: string } {
	const primary = env[name]?.trim();
	if (primary !== undefined && primary.length > 0) return { value: primary, source: name };
	if (fallbackName === undefined) return { value: undefined, source: name };
	const fallback = env[fallbackName]?.trim();
	return { value: fallback !== undefined && fallback.length > 0 ? fallback : undefined, source: fallbackName };
}

/**
 * Resolve the Jev endpoint from the environment. `JEV_*` names win;
 * `TYPESAFE_*` names are honored as jegrep-compatible fallbacks. Throw a
 * user-actionable message when no API key is configured.
 *
 * @param env - environment to read (defaults to the process environment).
 * @param overrides - host configuration; a set field wins over its environment
 * variable, so a deployment can configure the endpoint entirely through plugin
 * config.
 */
export function resolveJevConfig(
	env: Record<string, string | undefined> = process.env,
	overrides: JevConfigOverrides = {},
): JevConfig {
	const overrideKey = overrides.apiKey?.trim();
	const key =
		overrideKey !== undefined && overrideKey.length > 0
			? { value: overrideKey, source: CONFIG_KEY_SOURCE }
			: readEnv(env, "JEV_API_KEY", "TYPESAFE_API_KEY");
	if (key.value === undefined) {
		throw new Error("find needs a Jev API key. Set JEV_API_KEY (or TYPESAFE_API_KEY) in the environment.");
	}
	const baseUrl = (overrides.baseUrl?.trim() || readEnv(env, "JEV_BASE_URL", "TYPESAFE_BASE_URL").value || DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const model = overrides.model?.trim() || readEnv(env, "JEV_MODEL", "TYPESAFE_DEFAULT_MODEL").value || DEFAULT_MODEL;
	return { apiKey: key.value, baseUrl, model, keySource: key.source };
}

/** Non-2xx response from the Jev API. */
export class JevApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "JevApiError";
	}
}

interface SystemOneResponse {
	model: string;
	answers: Record<string, JudgeAnswer & { type?: string }>;
	usage: { input_tokens: number; output_tokens: number; cost?: number };
}

function backoffMs(attempt: number, response: Response | undefined): number {
	const retryAfter = response?.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		if (Number.isFinite(seconds)) return Math.min(seconds * 1000, BACKOFF_MAX_MS);
	}
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/** A {@link Judge} served by the native System One probability API. */
export class JevJudge implements Judge {
	readonly model: string;
	readonly baseUrl: string;
	readonly #apiKey: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(
		config: JevConfig,
		options: { fetch?: typeof fetch; timeoutMs?: number } = {},
	) {
		this.model = config.model;
		this.baseUrl = config.baseUrl;
		this.#apiKey = config.apiKey;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async judge(request: JudgeRequest, options: { signal?: AbortSignal } = {}): Promise<JudgmentResult> {
		const signal = options.signal;
		const body = JSON.stringify({ state: request.state, model: this.model, questions: request.questions });
		let response: SystemOneResponse | undefined;
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			let http: Response;
			try {
				const timeout = AbortSignal.timeout(this.#timeoutMs);
				http = await this.#fetch(`${this.baseUrl}${JUDGMENT_ROUTE}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.#apiKey}`,
						Accept: "application/json",
						"Content-Type": "application/json",
					},
					body,
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				});
			} catch (error) {
				// Transport failures (network, timeout) are transient: bounded retry.
				if (signal?.aborted || attempt + 1 >= MAX_ATTEMPTS) throw error;
				await sleep(backoffMs(attempt, undefined), signal);
				continue;
			}
			if (http.ok) {
				response = (await http.json()) as SystemOneResponse;
				break;
			}
			const text = await http.text();
			const error = new JevApiError(`jev API error (${http.status}): ${text}`, http.status);
			const transient = http.status === 408 || http.status === 429 || http.status >= 500;
			if (!transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
			await sleep(backoffMs(attempt, http), signal);
		}
		if (response === undefined) throw new JevApiError("jev API returned no response", 0);
		// Every question must come back typed; a partial envelope is a hard error,
		// not silently unjudged entries.
		for (const id of Object.keys(request.questions)) {
			const answer = response.answers[id];
			if (answer === undefined || answer.type !== request.questions[id]?.type) {
				throw new JevApiError(`jev response is missing a "${request.questions[id]?.type}" answer for question "${id}"`, 0);
			}
		}
		return {
			answers: response.answers,
			usage: {
				input: response.usage.input_tokens,
				output: response.usage.output_tokens,
				cost: response.usage.cost ?? 0,
			},
		};
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(), ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true },
		);
	});
}
