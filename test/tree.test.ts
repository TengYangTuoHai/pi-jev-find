import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { eligibleFile, humanSize, listFiles, renderTree, type FileEntry } from "../src/cascade/tree";

describe("eligibleFile", () => {
	test("credential material is never searchable", () => {
		for (const rel of [".env", "config/.env.local", "ssh/id_rsa", "certs/server.pem", "state.tfstate"]) {
			expect(eligibleFile(rel, 100, true)).toBe(false);
		}
		expect(eligibleFile(".env.example", 100, true)).toBe(true);
	});

	test("build noise, lockfiles, and binaries are excluded", () => {
		for (const rel of ["dist/app.js", "node_modules/pkg/index.js", "package-lock.json", "logo.png", "app.min.js"]) {
			expect(eligibleFile(rel, 100, false)).toBe(false);
		}
	});

	test("hidden paths need includeHidden", () => {
		expect(eligibleFile(".github/workflows/ci.yml", 100, false)).toBe(false);
		expect(eligibleFile(".github/workflows/ci.yml", 100, true)).toBe(true);
	});

	test("zero-size files are excluded", () => {
		expect(eligibleFile("ok.ts", 0, false)).toBe(false);
	});
});

describe("humanSize", () => {
	test("unit ladder", () => {
		expect(humanSize(812)).toBe("812 B");
		expect(humanSize(3482)).toBe("3.4 KB");
		expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
	});
});

describe("renderTree", () => {
	const entry = (rel: string, size = 10): FileEntry => ({ path: `/r/${rel}`, rel, size });

	test("prefix-folded headers, tags, and blank-line placement", () => {
		const out = renderTree(
			[entry("top.md"), entry("src/a.ts"), entry("src/b.ts"), entry("src/deep/c.ts")],
			i => `e${String(i).padStart(3, "0")}`,
		);
		const rows = out.split("\n").filter(row => row.length > 0);
		// Blank line before the first root-level file's follower is structural:
		// root file, then a blank, then the dir header.
		expect(out.indexOf("# top.md")).toBe(-1); // file rows carry tags, not bare names
		expect(rows[0]).toMatch(/^# e000 top\.md \(10 B\)$/);
		expect(out).toContain("\n\n# src/\n");
		expect(out).toContain("## e001 a.ts");
		expect(out).toContain("### e003 c.ts");
		// Deeper headers after shallower files do not re-emit the parent header.
		expect(out.match(/# src\//g)).toHaveLength(1);
	});

	test("empty listing renders empty", () => {
		expect(renderTree([], () => "e000")).toBe("");
	});
});

describe("listFiles (rg integration)", () => {
	test("lists eligible files with sizes, skips deny dirs and secrets", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-tree-"));
		await fs.writeFile(path.join(dir, "app.ts"), "export const x = 1;\n");
		await fs.writeFile(path.join(dir, "notes.md"), "hello\n");
		await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
		await fs.writeFile(path.join(dir, "node_modules", "dep.js"), "module.exports = 1;\n");
		await fs.writeFile(path.join(dir, ".env"), "SECRET=1\n");
		const entries = await listFiles(dir, { includeHidden: false });
		expect(entries.map(entry => entry.rel)).toEqual(["app.ts", "notes.md"]);
		expect(entries[0]!.size).toBe(20);
		await fs.rm(dir, { recursive: true, force: true });
	});
});
