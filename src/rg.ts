/**
 * Thin ripgrep runner shared by the lexical scan and the file listing — the
 * pi-jev-find replacement for omp's `@oh-my-pi/pi-natives` grep/glob (MIT,
 * oh-my-pi). `rg` is the same engine both projects ultimately rely on.
 *
 * Hardening: `RIPGREP_CONFIG_PATH` is cleared so a user config cannot inject
 * flags that break the `--json`/`--files` contracts; runs are killed on abort
 * signal or timeout; stderr is capped.
 */
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export type RgFailure = "missing" | "failed" | "timeout" | "aborted";

export class RgError extends Error {
	constructor(
		readonly kind: RgFailure,
		message: string,
	) {
		super(message);
		this.name = "RgError";
	}
}

export interface RgRun {
	/** 0 = matches, 1 = no matches (both success). */
	exitCode: number;
	/** Raw stdout bytes — callers decode (`--json` lines or `--files --null` paths). */
	stdout: Buffer;
}

export interface RgOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Run `rg` in `root` and collect stdout. Rejects with {@link RgError}:
 * `missing` when rg is not on PATH, `failed` on exit code > 1 (rg: 2), and
 * `timeout`/`aborted` when the run was killed.
 */
export async function runRg(root: string, args: readonly string[], options: RgOptions = {}): Promise<RgRun> {
	if (options.signal?.aborted) throw new RgError("aborted", "aborted");
	const child = spawn("rg", args, {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
	});
	const chunks: Buffer[] = [];
	let stderr = "";
	let killed: "timeout" | "aborted" | null = null;
	const closed = Promise.withResolvers<number | null>();

	child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < 4096) stderr += chunk.toString("utf8");
	});
	child.once("error", error => {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			closed.reject(new RgError("missing", "ripgrep (rg) is required but was not found on PATH"));
		} else {
			closed.reject(new RgError("failed", `rg failed to start: ${error.message}`));
		}
	});
	child.once("close", code => closed.resolve(code));

	const timer = setTimeout(() => {
		killed = "timeout";
		child.kill("SIGKILL");
	}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const onAbort = () => {
		killed = "aborted";
		child.kill("SIGKILL");
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const code = await closed.promise;
		if (killed === "aborted" || options.signal?.aborted) throw new RgError("aborted", "aborted");
		if (killed === "timeout") throw new RgError("timeout", `rg timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
		if (code === null) throw new RgError("failed", `rg terminated unexpectedly: ${stderr.trim()}`);
		const stdout = Buffer.concat(chunks);
		// Exit 2 with a completed search cycle (a `summary` event was emitted) means
		// rg finished but found nothing searchable ("No files were searched") or hit
		// per-file traversal errors; both are empty results, not tool failures.
		if (code > 1 && !stdout.includes('"summary"')) {
			throw new RgError("failed", `rg exited ${code}: ${stderr.trim()}`);
		}
		return { exitCode: code, stdout };
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
