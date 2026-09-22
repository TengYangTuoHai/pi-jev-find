import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clipBytes, countOccurrences, lines, readText, ReadTextError, takeChars } from "../src/cascade/text";

describe("lines", () => {
	test("rust-style splitting: no phantom line after trailing newline, CR stripped", () => {
		expect(lines("a\r\nb\n")).toEqual(["a", "b"]);
		expect(lines("a\n\nb")).toEqual(["a", "", "b"]);
		expect(lines("")).toEqual([]);
		expect(lines("\n")).toEqual([""]);
	});
});

describe("clipBytes", () => {
	test("never splits a code point at the byte budget", () => {
		const text = "aé你𝒜b"; // 1+2+3+4+1 = 11 bytes
		expect(clipBytes(text, 11)).toBe(text);
		expect(clipBytes(text, 10)).toBe("aé你𝒜");
		expect(clipBytes(text, 4)).toBe("aé"); // 1+2=3, +3 would exceed 4
		expect(clipBytes(text, 6)).toBe("aé你");
		expect(clipBytes("abc", 100)).toBe("abc");
	});
});

describe("takeChars / countOccurrences", () => {
	test("takes code points, not utf-16 units", () => {
		expect(takeChars("𝒜你b", 2)).toBe("𝒜你");
		expect(takeChars("ab", 5)).toBe("ab");
	});
	test("counts non-overlapping; empty needle is zero", () => {
		expect(countOccurrences("aaa", "aa")).toBe(1);
		expect(countOccurrences("abab", "ab")).toBe(2);
		expect(countOccurrences("x", "")).toBe(0);
	});
});

describe("readText", () => {
	test("binary files with NUL in the probe are rejected as binary", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-text-"));
		const file = path.join(dir, "blob.bin");
		await fs.writeFile(file, Buffer.concat([Buffer.from("ok\0"), Buffer.alloc(9000, 0x41)]));
		expect(readText(file, 1024 * 1024).then(() => "read", error => error.constructor.name)).resolves.toBe("ReadTextError");
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("blank files are rejected as empty", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-text-"));
		const file = path.join(dir, "blank.txt");
		await fs.writeFile(file, "\n \n\t\n");
		await expect(readText(file, 1024)).rejects.toMatchObject({ kind: "empty" });
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("a capped read trims to the last full line and reports truncation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-text-"));
		const file = path.join(dir, "long.txt");
		// Line 1 fits in 8 bytes; line 2 would not.
		await fs.writeFile(file, "12345\n890123\n");
		const read = await readText(file, 8);
		expect(read.text).toBe("12345\n");
		expect(read.bytes).toBe(6);
		expect(read.truncated).toBe(true);
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("missing files surface as io failures", async () => {
		expect(readText("/nonexistent/jfind/missing.txt", 100).then(() => "ok", (e: ReadTextError) => e.kind)).resolves.toBe("io");
	});
});
