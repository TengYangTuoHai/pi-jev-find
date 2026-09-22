import { describe, expect, test } from "bun:test";
import type { FindDetails, FindHit } from "../src/types";
import {
	CARD_META_MAX_BYTES,
	CARD_RANGES_MAX,
	CARD_RANGES_PER_FILE,
	findCardMeta,
	findViewFromMeta,
	presentFindCall,
	presentFindResult,
} from "../src/dsh/present";

function hit(rel: string, ranges: { start: number; end: number; p: number }[], contentScore = 0.8): FindHit {
	return {
		rel,
		contentScore,
		ranges: ranges.map(range => ({ ...range, snippet: `${rel} @ ${range.start}` })),
		linesSeen: 120,
		truncated: false,
	};
}

function details(hits: FindHit[], threshold = 0.2): FindDetails {
	return {
		query: "where do we verify webhook signatures?",
		keywords: ["webhook"],
		threshold,
		hits,
		stats: {
			filesListed: 10,
			requests: 4,
			errors: 0,
			judged: 9,
			filesRead: 2,
			fileBytes: 2048,
			inputTokens: 100,
			outputTokens: 20,
			cost: 0.001,
			apiMs: 500,
			windowsJudged: 6,
			windowsPruned: 1,
			mapCards: 1,
			failures: [],
		},
		elapsedMs: 1200,
		cwd: "/workspace",
	};
}

describe("presentFindCall", () => {
	test("quotes the query, names the scope when narrowed, and carries the keywords", () => {
		const view = presentFindCall({ query: "session expiry", grep_keywords: ["sess_ttl", "expire"], path: "src/" });
		expect(view).toEqual({
			card: "generic",
			title: 'Find "session expiry" in src/',
			kind: "search",
			rawInput: { query: "session expiry", path: "src/", grep_keywords: ["sess_ttl", "expire"] },
		});
	});

	test("omits the scope and the keywords when the call has neither", () => {
		expect(presentFindCall({ query: "retry budget", grep_keywords: [] })).toEqual({
			card: "generic",
			title: 'Find "retry budget"',
			kind: "search",
			rawInput: { query: "retry budget" },
		});
	});
});

describe("findCardMeta", () => {
	test("groups ranges by file with the strongest first and keeps the scores", () => {
		const meta = findCardMeta(
			details([hit("src/a.ts", [{ start: 40, end: 88, p: 0.51 }, { start: 10, end: 12, p: 0.94 }]), hit("src/b.ts", [{ start: 3, end: 3, p: 0.4 }])]),
		);
		expect(meta.total).toBe(3);
		expect(meta.truncated).toBe(false);
		expect(meta.files.map(file => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(meta.files[0]?.score).toBe(0.8);
		expect(meta.files[0]?.ranges.map(range => range.line)).toEqual([10, 40]);
		expect(meta.files[0]?.ranges[0]).toEqual({ line: 10, endLine: 12, p: 0.94, snippet: "src/a.ts @ 10" });
	});

	test("caps ranges per file and marks the card truncated without losing the true total", () => {
		const many = Array.from({ length: CARD_RANGES_PER_FILE + 2 }, (_, index) => ({
			start: index + 1,
			end: index + 1,
			p: 0.5,
		}));
		const meta = findCardMeta(details([hit("src/a.ts", many)]));
		expect(meta.total).toBe(many.length);
		expect(meta.files[0]?.ranges.length).toBe(CARD_RANGES_PER_FILE);
		expect(meta.truncated).toBe(true);
	});

	test("keeps the serialized meta inside its byte budget and stops adding files past it", () => {
		const hits = Array.from({ length: 40 }, (_, file) =>
			hit(
				`src/module-${file}/deeply-nested/path/file-${file}.ts`,
				Array.from({ length: CARD_RANGES_PER_FILE }, (_, index) => ({
					start: index,
					end: index,
					p: 0.9,
				})),
				file,
			),
		);
		const meta = findCardMeta(details(hits), 900);
		expect(new TextEncoder().encode(JSON.stringify(meta)).length).toBeLessThanOrEqual(900);
		expect(meta.truncated).toBe(true);
		expect(meta.total).toBe(hits.length * CARD_RANGES_PER_FILE);
		expect(meta.files.length).toBeLessThan(hits.length);
		expect(meta.files.length).toBeGreaterThan(0);
	});

	test("never exceeds the whole-card range cap", () => {
		const hits = Array.from({ length: 60 }, (_, file) =>
			hit(`src/f${file}.ts`, [
				{ start: 1, end: 2, p: 0.9 },
				{ start: 5, end: 6, p: 0.8 },
				{ start: 9, end: 10, p: 0.7 },
			]),
		);
		const meta = findCardMeta(details(hits));
		const rangeCount = meta.files.reduce((sum, file) => sum + file.ranges.length, 0);
		expect(rangeCount).toBeLessThanOrEqual(CARD_RANGES_MAX);
		expect(meta.truncated).toBe(true);
	});

	test("a zero-hit run yields an empty, non-truncated card", () => {
		const meta = findCardMeta(details([]));
		expect(meta).toEqual({ total: 0, truncated: false, threshold: 0.2, files: [] });
	});

	test("the default budget fits a realistic result without truncation", () => {
		const meta = findCardMeta(
			details(Array.from({ length: 6 }, (_, file) => hit(`src/f${file}.ts`, [{ start: file * 10, end: file * 10 + 4, p: 0.9 }]))),
		);
		expect(meta.truncated).toBe(false);
		expect(new TextEncoder().encode(JSON.stringify(meta)).length).toBeLessThan(CARD_META_MAX_BYTES);
	});
});

describe("findViewFromMeta", () => {
	test("narrows a projected meta into a matched-file search card", () => {
		const meta = findCardMeta(details([hit("src/a.ts", [{ start: 10, end: 12, p: 0.94 }]), hit("src/b.ts", [{ start: 3, end: 3, p: 0.4 }])]));
		const view = findViewFromMeta(meta);
		expect(view).toEqual({
			card: "search",
			shape: "matches",
			title: "find — 2 judged ranges (τ 0.20)",
			files: [
				{ path: "src/a.ts", matches: [{ lineNumber: 10, line: "src/a.ts @ 10" }] },
				{ path: "src/b.ts", matches: [{ lineNumber: 3, line: "src/b.ts @ 3" }] },
			],
			truncated: false,
			total: 2,
		});
	});

	test("narrows an empty card rather than reporting the projection as absent", () => {
		const view = findViewFromMeta(findCardMeta(details([])));
		expect(view).toEqual({ card: "search", shape: "matches", title: "find — 0 judged ranges (τ 0.20)", files: [], truncated: false, total: 0 });
	});

	test("returns undefined for replayed meta that no longer matches the shape", () => {
		expect(findViewFromMeta(undefined)).toBeUndefined();
		expect(findViewFromMeta("nope")).toBeUndefined();
		expect(findViewFromMeta({})).toBeUndefined();
		expect(findViewFromMeta({ total: 1, truncated: false, threshold: 0.2, files: [{ path: "a", score: 1, ranges: [{ line: 1 }] }] })).toBeUndefined();
		expect(findViewFromMeta({ total: "1", truncated: false, threshold: 0.2, files: [] })).toBeUndefined();
	});
});

describe("presentFindResult", () => {
	test("returns the search card for a successful call", () => {
		const meta = findCardMeta(details([hit("src/a.ts", [{ start: 10, end: 12, p: 0.94 }])]));
		const view = presentFindResult({ isError: false, meta, content: [] });
		expect(view.card).toBe("search");
	});

	test("keeps the failure text and never claims a search card for an error", () => {
		const meta = findCardMeta(details([hit("src/a.ts", [{ start: 10, end: 12, p: 0.94 }])]));
		const content = [{ type: "text" as const, text: "find failed — all 4 judge requests failed" }];
		expect(presentFindResult({ isError: true, meta, content })).toEqual({ card: "generic", title: "find failed", content });
	});

	test("falls back to a summarizing generic card when the meta cannot be narrowed", () => {
		const content = [{ type: "text" as const, text: "digest" }];
		const view = presentFindResult({ isError: false, meta: { total: 4 }, content });
		expect(view).toEqual({ card: "generic", content });
	});

	test("falls back to the raw content when even the summary is unavailable", () => {
		const content = [{ type: "text" as const, text: "digest" }];
		expect(presentFindResult({ isError: false, content })).toEqual({ card: "generic", content });
	});

	test("titles the fallback with the number of ranges the replayed meta still holds", () => {
		const content = [{ type: "text" as const, text: "digest" }];
		const meta = { files: [{ path: "src/a.ts", score: 0.9, ranges: [{ line: 1, endLine: 1, p: 0.9, snippet: "x" }] }] };
		expect(presentFindResult({ isError: false, meta, content })).toEqual({
			card: "generic",
			title: "find — 1 judged range",
			content,
		});
	});
});
