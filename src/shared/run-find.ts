/**
 * Host-agnostic orchestration of one `find` call: validate the query, resolve
 * the search scope, judge it with the cascade, and render the model-facing
 * digest. The pi extension and the DSH plugin both call this, so a result is
 * identical whichever host runs the tool; only registration and presentation
 * stay host-specific.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runCascade } from "../cascade/cascade.ts";
import type { Budgets } from "../config.ts";
import { type JevConfigOverrides, JevJudge, resolveJevConfig } from "../judge/jev-judge.ts";
import type { FindDetails, FindToolParams } from "../types.ts";
import { formatDigest } from "./digest.ts";

/** Everything one find call needs from its host adapter. */
export interface FindRunOptions {
	/** Workspace root a relative `path` argument resolves against. */
	cwd: string;
	/** Validated tool arguments. */
	params: FindToolParams;
	/** Cascade budgets (already merged: host config over the env-derived values). */
	budgets?: Budgets;
	/** Judge endpoint overrides from host configuration; environment values still apply when unset. */
	judge?: JevConfigOverrides;
	/** Host cancellation; forwarded to every judge request and ripgrep run. */
	signal?: AbortSignal;
	/**
	 * Transport for judge requests. Defaults to the global `fetch`; a host can
	 * supply a proxied fetch (the harness's HTTP guidance, or a corporate proxy),
	 * and tests supply a stub.
	 */
	fetch?: typeof fetch;
	/** Phase narration for hosts that can surface progress on a pending call. */
	onProgress?: (message: string) => void;
}

/** One completed cascade run, in both its structured and model-facing forms. */
export interface FindRunResult {
	details: FindDetails;
	/** The text the model receives as the tool result. */
	digest: string;
}

/** Map a hit's cascade-relative path to its display form, relative to the host cwd when possible. */
function toDisplay(rel: string, root: string, cwd: string): string {
	const relative = path.relative(cwd, path.join(root, rel));
	if (relative.startsWith("..")) return rel;
	return relative.split(path.sep).join("/");
}

/** Resolve the search root: the workspace root, or the validated `path` argument under it. */
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

/**
 * Run one `find` call end to end.
 * @param options - call arguments, search scope, budgets, overrides, cancellation, and progress sink.
 * @returns the structured details plus the model-facing digest.
 * @throws Error when the query is empty, the path is unusable, or every judge request failed.
 */
export async function runFind(options: FindRunOptions): Promise<FindRunResult> {
	const query = options.params.query.trim();
	if (query.length === 0) throw new Error("`query` must be a non-empty description");
	const root = await resolveRoot(options.params.path, options.cwd);
	const scopePath =
		root === path.resolve(options.cwd)
			? undefined
			: `${path.relative(options.cwd, root).split(path.sep).join("/")}/`;
	const judge = new JevJudge(resolveJevConfig(process.env, options.judge ?? {}), options.fetch === undefined ? {} : { fetch: options.fetch });
	const started = performance.now();
	const result = await runCascade({
		root,
		query,
		extraKeywords: options.params.grep_keywords,
		judge,
		includeHidden: false,
		budgets: options.budgets,
		signal: options.signal,
		onProgress: options.onProgress,
	});
	const elapsedMs = performance.now() - started;
	const { stats, threshold, keywords } = result;
	const hits = result.hits.map(hit => ({ ...hit, rel: toDisplay(hit.rel, root, options.cwd) }));
	const details: FindDetails = { query, keywords, threshold, hits, stats, elapsedMs, cwd: options.cwd, scopePath };
	if (stats.requests > 0 && stats.errors === stats.requests) {
		throw new Error(
			`find failed — all ${stats.requests} judge requests failed:\n${stats.failures.join("\n") || "unknown errors"}`,
		);
	}
	return { details, digest: formatDigest(query, scopePath, details) };
}
