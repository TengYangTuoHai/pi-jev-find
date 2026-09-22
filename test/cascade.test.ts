import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCascade } from "../src/cascade/cascade";
import type { Judge, JudgeRequest, JudgmentResult } from "../src/judge/types";

/** Deterministic judge: noul values resolved per question key via a lookup. */
class FakeJudge implements Judge {
	readonly requests: JudgeRequest[] = [];
	usageCount = 0;

	constructor(
		private readonly answer: (request: JudgeRequest, key: string) => number,
		private readonly failAll = false,
	) {}

	judge(request: JudgeRequest): Promise<JudgmentResult> {
		this.requests.push(request);
		if (this.failAll) return Promise.reject(new Error("judge offline"));
		const answers: Record<string, { noul: number }> = {};
		for (const key of Object.keys(request.questions)) {
			answers[key] = { noul: this.answer(request, key) };
		}
		this.usageCount++;
		return Promise.resolve({
			answers,
			usage: { input: 1000, output: 100, cost: 0.01 },
		});
	}
}

async function workspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-cascade-"));
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.writeFile(
		path.join(dir, "src", "webhook.ts"),
		[
			"import crypto from 'node:crypto';",
			"// Verify webhook HMAC signatures before processing.",
			"export function verifyWebhookSignature(payload: string, signature: string): boolean {",
			"  const expected = crypto.createHmac('sha256', process.env.SECRET!).update(payload).digest('hex');",
			"  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));",
			"}",
			"",
		].join("\n"),
	);
	await fs.writeFile(path.join(dir, "src", "billing.ts"), "export function charge(amount: number) {\n  return amount * 2;\n}\n");
	await fs.writeFile(path.join(dir, "README.md"), "# demo\nMentions webhook signatures in passing only.\n");
	return dir;
}

describe("runCascade (fake judge)", () => {
	test("a verified implementation is reported with calibrated ranges", async () => {
		const dir = await workspace();
		// Name stage: high for webhook.ts (first in lexical order by name rank),
		// passage stages: high for webhook passages, low elsewhere.
		const judge = new FakeJudge((request, key) => {
			const tree = request.state.tree;
			if (tree !== undefined) {
				return typeof tree === "string" && tree.includes("webhook.ts") && key === "e000" ? 0.9 : 0.1;
			}
			const passages = request.state.passages as Record<string, unknown>;
			const text = JSON.stringify(passages);
			return text.includes("Hmac") || text.includes("HMAC") ? 0.9 : 0.05;
		});
		const result = await runCascade({
			root: dir,
			query: "webhook signature verification",
			extraKeywords: ["hmac"],
			judge,
			includeHidden: false,
			budgets: { concurrency: 4, nameBatch: 64, candidates: 128, files: 20, windows: 24, windowBytes: 8192, sketchBytes: 384, fullLimit: 40 },
		});
		const hit = result.hits.find(h => h.rel === "src/webhook.ts");
		expect(hit).toBeDefined();
		expect(hit!.contentScore).toBeGreaterThanOrEqual(0.9);
		expect(hit!.ranges.length).toBeGreaterThan(0);
		expect(hit!.ranges[0]!.p).toBeGreaterThanOrEqual(0.9);
		expect(hit!.ranges[0]!.start).toBeGreaterThan(0);
		// All three waves ran as batched JSON requests.
		const shapes = judge.requests.map(request => Object.keys(request.state));
		expect(shapes.some(keys => keys.includes("tree"))).toBe(true);
		expect(shapes.some(keys => keys.includes("passages") && keys.includes("files"))).toBe(true);
		expect(result.stats.filesListed).toBeGreaterThanOrEqual(3);
		expect(result.stats.judged).toBeGreaterThan(0);
		expect(result.stats.cost).toBeGreaterThan(0);
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("judge failures degrade coverage instead of throwing", async () => {
		const dir = await workspace();
		const judge = new FakeJudge(() => 1, true);
		const result = await runCascade({
			root: dir,
			query: "webhook signature verification",
			extraKeywords: [],
			judge,
			includeHidden: false,
		});
		expect(result.hits).toEqual([]);
		expect(result.stats.errors).toBe(result.stats.requests);
		expect(result.stats.requests).toBeGreaterThan(0);
		expect(result.stats.failures.some(failure => failure.includes("judge offline"))).toBe(true);
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("uniform zero judgments yield no hits but a live accounting trail", async () => {
		const dir = await workspace();
		const judge = new FakeJudge(() => 0);
		const result = await runCascade({
			root: dir,
			query: "webhook signature verification",
			extraKeywords: [],
			judge,
			includeHidden: false,
		});
		expect(result.hits).toEqual([]);
		expect(result.stats.windowsJudged).toBe(0); // sketch cutoff 0.45 prunes everything
		expect(result.stats.mapCards).toBeGreaterThan(0);
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("an empty directory produces a clean no-hit result", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-empty-"));
		const judge = new FakeJudge(() => 1);
		const result = await runCascade({
			root: dir,
			query: "anything",
			extraKeywords: [],
			judge,
			includeHidden: false,
		});
		expect(result.hits).toEqual([]);
		expect(result.stats.requests).toBe(0);
		expect(result.stats.filesListed).toBe(0);
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("abort before the first wave rejects with an abort error", async () => {
		const dir = await workspace();
		const controller = new AbortController();
		controller.abort();
		const judge = new FakeJudge(() => 1);
		await expect(
			runCascade({
				root: dir,
				query: "webhook",
				extraKeywords: [],
				judge,
				includeHidden: false,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		await fs.rm(dir, { recursive: true, force: true });
	});
});
