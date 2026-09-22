/**
 * Thin ripgrep runner shared by the lexical scan and the file listing — the
 * pi-jev-find replacement for omp's `@oh-my-pi/pi-natives` grep/glob (MIT,
 * oh-my-pi). `rg` is the same engine both projects ultimately rely on.
 *
 * Binary resolution prefers the packaged `@vscode/ripgrep` build (the DeepSeek
 * Harness ships one, so no system install is required) and falls back to `rg`
 * on `PATH`. `JF_RG` overrides both, for a custom build.
 *
 * Hardening: `RIPGREP_CONFIG_PATH` is cleared so a user config cannot inject
 * flags that break the `--json`/`--files` contracts; runs are killed on abort
 * signal or timeout; stderr is capped.
 */
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Environment variable naming an explicit ripgrep binary. */
const RG_OVERRIDE_ENV = "JF_RG";

let binaryPromise: Promise<string> | undefined;

/**
 * Resolve the ripgrep binary once per process: `JF_RG`, then the packaged
 * `@vscode/ripgrep` build, then `rg` on `PATH`.
 * @returns the command `spawn` runs (an absolute path for the first two sources).
 */
function rgBinary(): Promise<string> {
	binaryPromise ??= (async () => {
		const override = process.env[RG_OVERRIDE_ENV]?.trim();
		if (override !== undefined && override.length > 0) return override;
		try {
			const packaged = (await import("@vscode/ripgrep")) as { rgPath?: string };
			if (typeof packaged.rgPath === "string" && packaged.rgPath.length > 0) return packaged.rgPath;
		} catch {
			// The packaged binary is absent — fall through to the PATH lookup.
		}
		return "rg";
	})();
	return binaryPromise;
}

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
 * Run ripgrep in `root` and collect stdout. Rejects with {@link RgError}:
 * `missing` when no ripgrep binary could be resolved or launched, `failed` on
 * exit code > 1 (rg: 2), and `timeout`/`aborted` when the run was killed.
 */
export async function runRg(root: string, args: readonly string[], options: RgOptions = {}): Promise<RgRun> {
	if (options.signal?.aborted) throw new RgError("aborted", "aborted");
	const command = await rgBinary();
	const child = spawn(command, args, {
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
			closed.reject(
				new RgError(
					"missing",
					`ripgrep not found: ${RG_OVERRIDE_ENV} is unset, the packaged @vscode/ripgrep binary is unavailable, and no rg is on PATH`,
				),
			);
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
