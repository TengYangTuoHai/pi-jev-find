import { describe, expect, test } from "bun:test";
import type { ThemeLike } from "../src/render";
import { renderFindCall, renderFindResult } from "../src/render";
import type { FindDetails, FindStats } from "../src/types";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} satisfies ThemeLike;

function details(overrides: Partial<FindDetails> = {}): FindDetails {
	const stats: FindStats = {
		filesListed: 120,
		requests: 6,
		errors: 0,
		judged: 84,
		filesRead: 3,
		fileBytes: 20_000,
		inputTokens: 50_000,
		outputTokens: 900,
		cost: 0.0234,
		apiMs: 4200,
		windowsJudged: 5,
		windowsPruned: 19,
		mapCards: 24,
		failures: [],
	};
	return {
		query: "webhook verification",
		keywords: ["webhook"],
		threshold: 0.2,
		hits: [
			{
				rel: "src/webhook.ts",
				contentScore: 0.94,
				ranges: [{ start: 3, end: 6, p: 0.94, snippet: "export function verifyWebhookSignature(payload" }],
				linesSeen: 4,
				truncated: false,
			},
		],
		stats,
		elapsedMs: 5100,
		cwd: "/repo",
		...overrides,
	};
}

describe("renderFindCall", () => {
	test("one line: query quoted, path and keywords as decoration", () => {
		const out = renderFindCall({ query: "retry budget", path: "src/net", grep_keywords: ["retry"] }, theme);
		const line = out.render(80)[0]!;
		expect(line).toContain('find "retry budget"');
		expect(line).toContain("in src/net");
		expect(line).toContain("[retry]");
	});
});

describe("renderFindResult", () => {
	test("collapsed shows the hit count and the cost footer, not ranges", () => {
		const out = renderFindResult(details(), false, false, theme);
		const text = out.render(80).join("\n");
		expect(text).toContain("1 hit (τ 0.20), strongest first");
		expect(text).toContain("$0.0234");
		expect(text).not.toContain("verifyWebhookSignature");
	});

	test("expanded lists ranges with gauges, snippets and stats", () => {
		const out = renderFindResult(details(), false, true, theme);
		const text = out.render(80).join("\n");
		expect(text).toContain("src/webhook.ts");
		expect(text).toContain("src/webhook.ts:3-6");
		expect(text).toContain("0.94");
		expect(text).toContain("verifyWebhookSignature");
	});

	test("no-hit and missing-details paths render without throwing", () => {
		const empty = renderFindResult(details({ hits: [] }), false, false, theme).render(80).join("\n");
		expect(empty).toContain("no hits (τ 0.20)");
		const bare = renderFindResult(undefined, true, false, theme).render(80).join("\n");
		expect(bare).toContain("find failed");
	});
});
