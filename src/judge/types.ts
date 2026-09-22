/**
 * Judge wire contract: the three request shapes the cascade sends, and the
 * answer shape every judge backend must produce. Mirrors the omp
 * `@oh-my-pi/pi-ai` noul surface (MIT, oh-my-pi); pi has no native noul API,
 * so {@link ../judge/pi-model-judge} emulates it with a chat completion.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

/** One probability question. `instructions` is self-contained per entry. */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
}

/** A judgment request: JSON state plus noul questions keyed by entry. */
export interface JudgeRequest {
	state: { readonly [key: string]: JsonValue };
	questions: Record<string, NoulQuestion>;
}

/** A yes-probability in [0,1], or absent when the judge produced nothing usable. */
export interface JudgeAnswer {
	noul?: number;
}

export interface JudgeUsage {
	input: number;
	output: number;
	cost: number;
}

export interface JudgmentResult {
	answers: Record<string, JudgeAnswer>;
	usage: JudgeUsage;
}

export interface Judge {
	judge(request: JudgeRequest, options: { signal?: AbortSignal }): Promise<JudgmentResult>;
}
