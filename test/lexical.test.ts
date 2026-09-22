import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileScore, grepIndex, idf } from "../src/cascade/lexical";

describe("idf", () => {
	test("rarity raises weight, clamped to [0.5, 6]", () => {
		const index = {
			keywords: ["rare", "everywhere"],
			perFileKw: new Map<string, number[]>([
				["a", [1, 5]],
				["b", [0, 7]],
				["c", [0, 3]],
			]),
			filesScanned: 1000,
		};
		const [rare = 0, everywhere = 0] = idf(index);
		expect(rare).toBeGreaterThan(everywhere);
		expect(rare).toBeLessThanOrEqual(6);
		expect(everywhere).toBeGreaterThanOrEqual(0.5);
	});

	test("a keyword in every file bottoms out at the 0.5 clamp", () => {
		const index = {
			keywords: ["kw"],
			perFileKw: new Map<string, number[]>([["a", [2]], ["b", [3]], ["c", [4]]]),
			filesScanned: 3,
		};
		expect(idf(index)[0]).toBe(0.5);
	});
});

describe("fileScore", () => {
	test("keyword in the path is worth two extra log-units", () => {
		const kw = ["retry"];
		const weights = [1];
		const inPath = fileScore([1], weights, "src/retry.ts", kw);
		const notInPath = fileScore([1], weights, "src/backoff.ts", kw);
		expect(inPath).toBeGreaterThan(notInPath + 1.9);
	});
});

describe("grepIndex (rg integration)", () => {
	test("counts case-insensitive occurrences per file and reports the corpus size", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-lex-"));
		await fs.writeFile(path.join(dir, "impl.ts"), "verify()\nVERIFY()\n");
		await fs.writeFile(path.join(dir, "other.ts"), "unrelated\n");
		const index = await grepIndex(dir, ["verify"], { includeHidden: false });
		expect(index.perFileKw.get("impl.ts")).toEqual([2]);
		expect(index.perFileKw.has("other.ts")).toBe(false);
		// `begin` events fire for every searched file, matched or not.
		expect(index.filesScanned).toBeGreaterThanOrEqual(2);
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("no keywords yields an empty index without spawning rg", async () => {
		const index = await grepIndex("/tmp", [], { includeHidden: false });
		expect(index.keywords).toEqual([]);
		expect(index.filesScanned).toBe(0);
	});
});
