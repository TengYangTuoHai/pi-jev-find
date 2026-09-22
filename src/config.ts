/**
 * Environment-driven configuration. Every knob is optional; defaults mirror
 * the jegrep / oh-my-pi jfind cascade budgets.
 */

export interface Budgets {
	/** Requests in flight per dispatched phase. */
	concurrency: number;
	/** Files per filename-ranking request. */
	nameBatch: number;
	/** Lexically ranked files that receive a filename judgment. */
	candidates: number;
	/** Files whose content is read and sketched. */
	files: number;
	/** Windows kept per read file. */
	windows: number;
	/** Bytes per passage window, tags included. */
	windowBytes: number;
	/** Bytes per sketch card. */
	sketchBytes: number;
	/** Complete passages verified across all files. */
	fullLimit: number;
}

export const DEFAULT_BUDGETS: Budgets = {
	concurrency: 16,
	nameBatch: 64,
	candidates: 128,
	files: 20,
	windows: 24,
	windowBytes: 8192,
	sketchBytes: 384,
	fullLimit: 40,
};

export interface JfConfig {
	enabled: boolean;
	budgets: Budgets;
}

function readInt(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): JfConfig {
	const budgets = { ...DEFAULT_BUDGETS };
	const b = budgets as { [K in keyof Budgets]: number };
	for (const key of Object.keys(DEFAULT_BUDGETS) as (keyof Budgets)[]) {
		b[key] = readInt(env, `JF_${key.toUpperCase()}`, DEFAULT_BUDGETS[key], 1, 10_000);
	}
	return {
		enabled: env.JF_ENABLED !== "0",
		budgets,
	};
}
