import { describe, expect, test } from "bun:test";
import { entryKey, nameBatch, passageBatch, passageKey, sketchBatch } from "../src/cascade/questions";
import type { FileEntry } from "../src/cascade/tree";
import type { Passage } from "../src/cascade/passages";

const entry = (rel: string, size = 10): FileEntry => ({ path: `/r/${rel}`, rel, size });

describe("nameBatch", () => {
	test("one question per entry, keyed e000+, naming the file and the query", () => {
		const request = nameBatch("proj", "verify webhook signatures", [entry("src/webhook.ts"), entry("src/billing.ts")]);
		expect(Object.keys(request.questions)).toEqual(["e000", "e001"]);
		expect(request.questions.e000!.instructions).toContain('e000');
		expect(request.questions.e000!.instructions).toContain('"webhook.ts"');
		expect(request.questions.e000!.instructions).toContain("verify webhook signatures");
		expect(request.questions.e000!.type).toBe("noul");
	});

	test("state carries the tree listing and alphabetically ordered keys", () => {
		const request = nameBatch("proj", "q", [entry("a/x.ts"), entry("a/y.ts")]);
		const keys = Object.keys(request.state).sort();
		expect(Object.keys(request.state)).toEqual(keys);
		const tree = request.state.tree as string;
		expect(tree).toContain("# a/");
		expect(tree).toContain("e000 x.ts (10 B)");
		expect(tree).toContain("e001 y.ts (10 B)");
	});
});

describe("sketchBatch", () => {
	test("cards pack into files + passages tuples with sorted file keys", () => {
		const request = sketchBatch("q", [
			{ fileKey: "f1", rel: "src/one.ts", sketch: "10: one" },
			{ fileKey: "f0", rel: "src/zero.ts", sketch: "20: zero" },
		]);
		expect(Object.keys(request.questions)).toEqual(["p00", "p01"]);
		expect(request.state.files).toEqual({ f0: "src/zero.ts", f1: "src/one.ts" });
		expect(Object.keys(request.state.files as object)).toEqual(["f0", "f1"]);
		expect(request.state.passages).toEqual({
			p00: ["f1", "10: one"],
			p01: ["f0", "20: zero"],
		});
	});
});

describe("passageBatch", () => {
	test("passages are plain content keyed p00+ and instructions carry the query", () => {
		const passages: Passage[] = [
			{ start: 4, end: 5, text: "L4| verify(x)\nL5| done\n", score: 1 },
		];
		const request = passageBatch("verify signatures", "src/webhook.ts", passages);
		expect(request.state.passages).toEqual({ p00: "verify(x)\ndone\n" });
		expect(request.questions.p00!.instructions).toContain("verify signatures");
		expect(request.questions.p00!.instructions).not.toContain("{{key}}");
	});
});

describe("key formats", () => {
	test("entry and passage keys zero-pad", () => {
		expect(entryKey(7)).toBe("e007");
		expect(entryKey(123)).toBe("e123");
		expect(passageKey(3)).toBe("p03");
	});
});
