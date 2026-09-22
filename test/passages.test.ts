import { describe, expect, test } from "bun:test";
import {
	type HeatRange,
	mergeHeat,
	type Passage,
	plainContent,
	rankedHeat,
	selectWindows,
	sketch,
	windows,
} from "../src/cascade/passages";

const KW = ["verify", "signature"];
const W = [1, 1];

describe("windows", () => {
	test("windows cover every line exactly once and tag line numbers", () => {
		const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		const passages = windows(text, 120, KW, W);
		const tagged = passages.flatMap(passage => plainContent(passage).split("\n").filter(l => l.length > 0));
		expect(tagged).toHaveLength(30);
		expect(passages[0]!.start).toBe(1);
		expect(passages[passages.length - 1]!.end).toBe(30);
		// Contiguity: each window starts right after the previous one.
		for (let i = 1; i < passages.length; i++) {
			expect(passages[i]!.start).toBe(passages[i - 1]!.end + 1);
		}
	});

	test("byte budget holds unless a single line overflows it", () => {
		const text = `${"x".repeat(200)}\nshort\n${"y".repeat(300)}\n`;
		const passages = windows(text, 120, KW, W);
		for (const passage of passages) {
			if (passage.end > passage.start) expect(Buffer.byteLength(passage.text)).toBeLessThanOrEqual(120);
		}
	});

	test("score is idf-weighted log frequency over the window", () => {
		const quiet = windows("nothing here\n", 8192, KW, W)[0]!;
		const loud = windows("verify signature verify signature\n", 8192, KW, W)[0]!;
		expect(quiet.score).toBe(0);
		expect(loud.score).toBeGreaterThan(2);
	});
});

describe("selectWindows", () => {
	test("zero-score windows spread across the file instead of only the head", () => {
		const passages: Passage[] = Array.from({ length: 20 }, (_, i) => ({
			start: i * 10 + 1,
			end: i * 10 + 10,
			text: "",
			score: 0,
		}));
		const kept = selectWindows(passages, 4);
		expect(kept).toHaveLength(4);
		expect(kept[0]!.start).toBe(1);
		expect(kept[kept.length - 1]!.start).toBe(191); // reaches the tail
	});

	test("scored windows keep the best and return file order", () => {
		const passages: Passage[] = Array.from({ length: 10 }, (_, i) => ({
			start: i + 1,
			end: i + 1,
			text: "",
			score: i === 7 ? 9 : i === 2 ? 5 : 0,
		}));
		expect(selectWindows(passages, 2).map(p => p.start)).toEqual([3, 8]);
	});
});

describe("sketch", () => {
	test("sketch lines are verbatim source with line ids, in file order", () => {
		const passage: Passage = {
			start: 10,
			end: 12,
			text: "L10| header\nL11| verify(msg, sig)\nL12| return\n",
			score: 1,
		};
		const out = sketch(passage, KW, W, 384);
		const rows = out.split("\n");
		expect(rows[0]!.startsWith("10: ")).toBe(true);
		expect(out).toContain("11: verify(msg, sig)");
		// Emitted in file order even when a later line outranked the header.
		const ids = rows.map(row => Number.parseInt(row, 10));
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
	});

	test("the byte budget bounds the sketch", () => {
		const passage: Passage = {
			start: 1,
			end: 50,
			text: Array.from({ length: 50 }, (_, i) => `L${i + 1}| ${"detail ".repeat(12)}`).join(""),
			score: 1,
		};
		expect(Buffer.byteLength(sketch(passage, KW, W, 200))).toBeLessThanOrEqual(260);
	});
});

describe("mergeHeat / rankedHeat", () => {
	const heat = (start: number, end: number, p: number): HeatRange => ({ start, end, p, snippet: "" });

	test("adjacent and overlapping spans merge and keep the max probability", () => {
		const merged = mergeHeat([heat(10, 20, 0.8), heat(21, 30, 0.5), heat(40, 45, 0.9)], 0.2);
		expect(merged.map(r => [r.start, r.end, r.p])).toEqual([
			[40, 45, 0.9],
			[10, 30, 0.8],
		]);
	});

	test("gaps are never bridged and sub-threshold spans dropped", () => {
		const merged = mergeHeat([heat(10, 12, 0.19), heat(20, 22, 0.3), heat(25, 25, 0.6)], 0.2);
		expect(merged.map(r => r.start)).toEqual([25, 20]);
	});

	test("rankedHeat orders strongest-first and caps the limit", () => {
		const ranked = rankedHeat([heat(1, 2, 0.4), heat(5, 6, 0.9), heat(9, 9, 0)], 2);
		expect(ranked.map(r => r.start)).toEqual([5, 1]);
	});
});
