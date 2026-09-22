import { describe, expect, test } from "bun:test";
import { JevApiError, JevJudge, resolveJevConfig } from "../src/judge/jev-judge";
import type { JudgeRequest } from "../src/judge/types";

const REQUEST: JudgeRequest = {
	state: { search: "q" },
	questions: {
		e000: { type: "noul", instructions: "q0" },
		e001: { type: "noul", instructions: "q1" },
	},
};

function okResponse(
	answers: Record<string, unknown>,
	usage: { input_tokens: number; output_tokens: number; cost?: number } = { input_tokens: 11, output_tokens: 7 },
): Response {
	return new Response(
		JSON.stringify({ model: "jev-latest", answers, usage }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** fetch double capturing calls; replies per-invocation from the queue. */
function fetchWith(replies: Array<Response | number>): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
	const calls: { url: string; init: RequestInit }[] = [];
	let at = 0;
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const reply = replies[Math.min(at++, replies.length - 1)]!;
		return typeof reply === "number" ? new Response("boom", { status: reply }) : reply;
	}) as typeof fetch;
	return { fetch: impl, calls };
}

const CONFIG = { apiKey: "sk-test", baseUrl: "https://jev.example", model: "jev-test", keySource: "JEV_API_KEY" };

describe("JevJudge wire contract", () => {
	test("POSTs {state, model, questions} to /v1/systemone with bearer auth", async () => {
		const { fetch, calls } = fetchWith([
			okResponse({ e000: { type: "noul", noul: 0.87 }, e001: { type: "noul", noul: 0.05 } }, { input_tokens: 10, output_tokens: 4, cost: 0.001 }),
		]);
		const result = await new JevJudge(CONFIG, { fetch }).judge(REQUEST);
		const call = calls[0]!;
		expect(call.url).toBe("https://jev.example/v1/systemone");
		expect(call.init.method).toBe("POST");
		expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
		const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
		expect(body.state).toEqual({ search: "q" });
		expect(body.model).toBe("jev-test");
		expect(Object.keys(body.questions as object)).toEqual(["e000", "e001"]);
		expect(result.answers.e000).toMatchObject({ noul: 0.87 });
		expect(result.usage).toEqual({ input: 10, output: 4, cost: 0.001 });
	});

	test("cost defaults to zero when the API reports tokens only", async () => {
		const { fetch } = fetchWith([okResponse({ e000: { type: "noul", noul: 1 }, e001: { type: "noul", noul: 0 } })]);
		const result = await new JevJudge(CONFIG, { fetch }).judge(REQUEST);
		expect(result.usage.cost).toBe(0);
	});

	test("an envelope missing a question answer is a hard error", async () => {
		const { fetch } = fetchWith([okResponse({ e000: { type: "noul", noul: 0.5 } })]);
		await expect(new JevJudge(CONFIG, { fetch }).judge(REQUEST)).rejects.toThrow(/missing.*e001/);
	});
});

describe("JevJudge retry policy", () => {
	test("429 retries and succeeds on the second attempt", async () => {
		const { fetch, calls } = fetchWith([
			429,
			okResponse({ e000: { type: "noul", noul: 0.9 }, e001: { type: "noul", noul: 0.1 } }),
		]);
		const result = await new JevJudge(CONFIG, { fetch }).judge(REQUEST);
		expect(calls).toHaveLength(2);
		expect(result.answers.e000!.noul).toBe(0.9);
	});

	test("persistent 5xx exhausts attempts and surfaces the status", async () => {
		const { fetch, calls } = fetchWith([500, 500, 500]);
		await expect(new JevJudge(CONFIG, { fetch }).judge(REQUEST)).rejects.toMatchObject({ status: 500 });
		expect(calls).toHaveLength(3);
	});

	test("4xx is not retried", async () => {
		const { fetch, calls } = fetchWith([402]);
		await expect(new JevJudge(CONFIG, { fetch }).judge(REQUEST)).rejects.toBeInstanceOf(JevApiError);
		expect(calls).toHaveLength(1);
	});

	test("a pre-aborted signal never hits the network", async () => {
		const { fetch, calls } = fetchWith([okResponse({})]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			new JevJudge(CONFIG, { fetch }).judge(REQUEST, { signal: controller.signal }),
		).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});

describe("resolveJevConfig", () => {
	test("no key anywhere throws with the actionable variable names", () => {
		expect(() => resolveJevConfig({})).toThrow(/JEV_API_KEY.*TYPESAFE_API_KEY/s);
	});

	test("JEV_* wins over the TYPESAFE_* fallbacks; defaults apply", () => {
		const config = resolveJevConfig({ TYPESAFE_API_KEY: "old", TYPESAFE_BASE_URL: "https://t.example/", JEV_API_KEY: "new" });
		expect(config.apiKey).toBe("new");
		expect(config.keySource).toBe("JEV_API_KEY");
		expect(config.baseUrl).toBe("https://t.example");
		expect(config.model).toBe("jev-latest");
	});

	test("TYPESAFE_* alone still works (jegrep-compatible)", () => {
		const config = resolveJevConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_DEFAULT_MODEL: "jev-v2" });
		expect(config.apiKey).toBe("k");
		expect(config.keySource).toBe("TYPESAFE_API_KEY");
		expect(config.model).toBe("jev-v2");
		expect(config.baseUrl).toBe("https://api.typesafe.ai");
	});
});
