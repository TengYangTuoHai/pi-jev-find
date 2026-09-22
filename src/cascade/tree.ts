/**
 * The searchable file set and its model-facing listing. Files are listed once
 * up front (the cascade judges every candidate by name before reading any), so
 * the tree is a flat list of eligible files rather than a lazily expanded
 * directory graph. Eligibility deny-lists build noise, lockfiles, binaries, and
 * obvious credential material.
 *
 * Ported from oh-my-pi `packages/coding-agent/src/tools/jfind/tree.ts` (MIT):
 * the native glob backend is replaced by `rg --files`, and the prefix-folded
 * tree renderer is local (omp uses `@oh-my-pi/pi-utils` walkPathTree).
 */
import * as fs from "node:fs/promises";
import { runRg } from "../rg.ts";

/** One eligible file under the search root. */
export interface FileEntry {
	/** Absolute path. */
	path: string;
	/** Root-relative display path with `/` separators. */
	rel: string;
	size: number;
}

const DENY_DIRS: Record<string, true> = {
	".git": true,
	node_modules: true,
	target: true,
	dist: true,
	build: true,
	out: true,
	".next": true,
	".nuxt": true,
	".turbo": true,
	".cache": true,
	__pycache__: true,
	".venv": true,
	venv: true,
	".tox": true,
	coverage: true,
	".idea": true,
	".vscode": true,
	".gradle": true,
	".mypy_cache": true,
	".pytest_cache": true,
	".ruff_cache": true,
	".parcel-cache": true,
};

const DENY_FILES: Record<string, true> = {
	"Cargo.lock": true,
	"package-lock.json": true,
	"yarn.lock": true,
	"pnpm-lock.yaml": true,
	"bun.lock": true,
	"bun.lockb": true,
	"poetry.lock": true,
	"Pipfile.lock": true,
	"composer.lock": true,
	"Gemfile.lock": true,
	"go.sum": true,
	"flake.lock": true,
	".DS_Store": true,
	"Thumbs.db": true,
};

/** Credential files by exact name. Never listed or read, even when hidden files are included. */
const SECRET_FILES: Record<string, true> = {
	".env": true,
	".envrc": true,
	".netrc": true,
	".npmrc": true,
	".pypirc": true,
	".pgpass": true,
	".boto": true,
	".s3cfg": true,
	".dockercfg": true,
	".git-credentials": true,
	".htpasswd": true,
	htpasswd: true,
	credentials: true,
	"credentials.json": true,
	"client_secret.json": true,
	"service-account.json": true,
	id_rsa: true,
	id_dsa: true,
	id_ecdsa: true,
	id_ed25519: true,
};

/** Credential files by extension: keys, certificate stores, encrypted vaults, and infrastructure state that embeds secrets. */
const SECRET_EXT = [
	"pem",
	"key",
	"p12",
	"pfx",
	"jks",
	"keystore",
	"bks",
	"ppk",
	"kdbx",
	"gpg",
	"pgp",
	"asc",
	"der",
	"crt",
	"cer",
	"tfvars",
	"tfvars.json",
	"tfstate",
	"tfstate.backup",
];

const BINARY_EXT = [
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"ico",
	"bmp",
	"tiff",
	"psd",
	"svg",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	"zip",
	"gz",
	"tgz",
	"tar",
	"bz2",
	"xz",
	"zst",
	"7z",
	"rar",
	"pdf",
	"mp3",
	"mp4",
	"mov",
	"avi",
	"mkv",
	"wav",
	"ogg",
	"flac",
	"wasm",
	"so",
	"dylib",
	"dll",
	"exe",
	"o",
	"a",
	"class",
	"jar",
	"pyc",
	"pyo",
	"bin",
	"dat",
	"db",
	"sqlite",
	"sqlite3",
	"lock",
	"map",
	"min.js",
	"min.css",
	"snap",
	"pb",
	"onnx",
	"safetensors",
	"parquet",
	"arrow",
	"ipynb",
];

const ENV_TEMPLATES: Record<string, true> = {
	".env.example": true,
	".env.sample": true,
	".env.template": true,
	".env.dist": true,
};

/** `lower` ends with `.<ext>` for some `ext` in `exts`. */
function hasExt(lower: string, exts: readonly string[]): boolean {
	return exts.some(ext => lower.length > ext.length && lower.endsWith(`.${ext}`));
}

/** Credential material: exact names, `.env.*` variants (except committed templates), and key/vault extensions. */
function secret(name: string): boolean {
	if (Object.hasOwn(SECRET_FILES, name)) return true;
	if (name.startsWith(".env.")) return !Object.hasOwn(ENV_TEMPLATES, name);
	return hasExt(name.toLowerCase(), SECRET_EXT);
}

/** Whether a root-relative regular file is searchable. */
export function eligibleFile(rel: string, size: number, includeHidden: boolean): boolean {
	if (size <= 0) return false;
	const segments = rel.split("/");
	const name = segments[segments.length - 1]!;
	for (let i = 0; i < segments.length - 1; i++) {
		const dir = segments[i]!;
		if (Object.hasOwn(DENY_DIRS, dir) || (!includeHidden && dir.startsWith("."))) return false;
	}
	if (!includeHidden && name.startsWith(".")) return false;
	return !Object.hasOwn(DENY_FILES, name) && !secret(name) && !hasExt(name.toLowerCase(), BINARY_EXT);
}

export interface ListFilesOptions {
	includeHidden: boolean;
	signal?: AbortSignal;
}

/** Stats are I/O only; batch them instead of serializing thousands of round trips. */
const STAT_BATCH = 128;

async function statSizes(root: string, rels: readonly string[]): Promise<Map<string, number>> {
	const sizes = new Map<string, number>();
	for (let offset = 0; offset < rels.length; offset += STAT_BATCH) {
		const batch = rels.slice(offset, offset + STAT_BATCH);
		const stats = await Promise.allSettled(
			batch.map(rel => fs.stat(`${root}/${rel}`)),
		);
		for (let i = 0; i < stats.length; i++) {
			const result = stats[i]!;
			if (result.status === "fulfilled" && result.value.isFile()) {
				sizes.set(batch[i]!, result.value.size);
			}
		}
	}
	return sizes;
}

/**
 * Every eligible, non-gitignored regular file under `root`, in path order.
 * Symlinks are never followed (rg does not list them without `-L`).
 */
export async function listFiles(root: string, options: ListFilesOptions): Promise<FileEntry[]> {
	const run = await runRg(
		root,
		["--files", "--null", "--no-messages", ...(options.includeHidden ? ["--hidden"] : [])],
		{ signal: options.signal },
	);
	const rels = run.stdout
		.subarray(0, run.stdout.length > 0 && run.stdout[run.stdout.length - 1] === 0 ? run.stdout.length - 1 : run.stdout.length)
		.toString("utf8")
		.split("\0")
		.filter(rel => rel.length > 0);
	const sizes = await statSizes(root, rels);
	const entries: FileEntry[] = [];
	for (const rel of rels) {
		const size = sizes.get(rel);
		if (size === undefined || !eligibleFile(rel, size, options.includeHidden)) continue;
		entries.push({ path: `${root}/${rel}`, rel, size });
	}
	entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	return entries;
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `812 B`, `3.4 KB`, … */
export function humanSize(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/**
 * Model-facing listing of `entries` as a prefix-folded directory tree: one `#`
 * per depth, `# dir/` headers, and every file line tagged with its question key
 * (`# e017 name (size)`), with a blank line before every directory header and
 * every root-level file after the first line.
 */
export function renderTree(entries: readonly FileEntry[], tagOf: (index: number) => string): string {
	let out = "";
	let emitted = false;
	/** Directory segments currently active in the emitted header stack. */
	const stack: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const segments = entries[index]!.rel.split("/");
		const dirCount = segments.length - 1;
		let shared = 0;
		while (shared < dirCount && shared < stack.length && stack[shared] === segments[shared]) shared++;
		for (let depth = shared; depth < dirCount; depth++) {
			if (emitted) out += "\n";
			emitted = true;
			out += `${"#".repeat(depth + 1)} ${segments[depth]}/\n`;
		}
		stack.length = dirCount;
		for (let depth = shared; depth < dirCount; depth++) stack[depth] = segments[depth]!;
		if (emitted && dirCount === 0) out += "\n";
		emitted = true;
		const hashes = "#".repeat(dirCount + 1);
		out += `${hashes} ${tagOf(index)} ${segments[dirCount]!} (${humanSize(entries[index]!.size)})\n`;
	}
	return out;
}
