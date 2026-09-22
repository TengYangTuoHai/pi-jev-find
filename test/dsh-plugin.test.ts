import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolResultView } from "@deepseek-ai/dsh-tools";
import { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { apply, Config, inject, name } from "../src/dsh/index";
import { findCardMeta, findViewFromMeta } from "../src/dsh/present";
import { runFind } from "../src/shared/run-find";
import type { FindDetails, FindToolParams } from "../src/types";

/**
 * Stand-in for the harness context: this plugin reads only `logger`, `tools`,
 * `systemPrompt`, `commands`, and `inject`, so a hand-rolled double exercises the
 * real registration path — including the schemas it hands the registry — without
 * booting a harness.
 */
type Section = { name: string; order: number; text: string | ((context: unknown) => string) };

function fakeContext(options: { withCommands?: boolean; withGrep?: boolean } = {}) {
	const registered: ToolDefinition[] = [];
	const sections: Section[] = [];
	const commands: { name: string; handler: () => { kind: string; text?: string } }[] = [];
	const warnings: string[] = [];
	const visible = new Set(options.withGrep === false ? [] : ["grep", "glob"]);
	const ctx = {
		logger: () => ({
			warn: (message: string) => warnings.push(message),
			info: () => {},
			error: () => {},
			debug: () => {},
		}),
		systemPrompt: {
			getSectionOrder: (sectionName: string) => (sectionName === "TOOL_GREP" ? 1500 : 0),
			section: (section: { name: string; order: number; text: () => string }) => {
				sections.push(section);
				return () => {};
			},
		},
		tools: {
			get: (toolName: string) => (visible.has(toolName) ? { name: toolName } : undefined),
			register: (definition: ToolDefinition) => {
				registered.push(definition);
				return () => {};
			},
		},
		commands: {
			register: (command: { name: string; handler: () => { kind: string; text?: string } }) => {
				commands.push(command);
				return () => {};
			},
		},
		inject: (_deps: string[], callback: (ctx: unknown) => void) => {
			if (options.withCommands !== false) callback(ctx);
		},
	};
	return { ctx: ctx as unknown as Context, registered, sections, commands, warnings };
}

/** The text a harness would assemble for one registered section. */
function sectionText(section: Section | undefined): string {
	if (section === undefined) throw new Error("no system-prompt section was registered");
	return typeof section.text === "string" ? section.text : section.text({});
}

/**
 * Run `body` with the judge environment variables cleared, so a test asserts the
 * plugin's own behavior rather than whatever the developer's shell exports.
 */
function withoutJevEnv<T>(body: () => T): T {
	const saved = ["JEV_API_KEY", "TYPESAFE_API_KEY"].map(name => [name, process.env[name]] as const);
	for (const [name] of saved) delete process.env[name];
	try {
		return body();
	} finally {
		for (const [name, value] of saved) {
			if (value !== undefined) process.env[name] = value;
		}
	}
}

/** Everything registered while a plugin with the given config loads. */
function load(config: Config, options: { withCommands?: boolean; withGrep?: boolean } = {}) {
	const fake = fakeContext(options);
	apply(fake.ctx, config);
	return fake;
}

describe("dsh plugin shape", () => {
	test("declares its name and exactly the services it registers against", () => {
		expect(name).toBe("pi-jev-find");
		expect(inject).toEqual(["tools", "systemPrompt"]);
	});

	test("keeps the find tool and its prompt section within the enforced DSH schema subset", () => {
		const { registered } = load(new Config({ apiKey: "sk-test" }));
		const definition = registered[0];
		expect(() => assertObjectJsonSchema(definition?.parameters)).not.toThrow();
		expect(() => assertSupportedJsonSchema(definition?.output.schema)).not.toThrow();
	});
});

describe("Config", () => {
	test("fills the defaults a deployment may omit", () => {
		const config = new Config({});
		expect(config.enabled).toBe(true);
		expect(config.timeoutMs).toBe(120_000);
	});

	test("keeps every explicitly set field", () => {
		const config = new Config({ candidates: 64, apiKey: "sk-test", model: "jev-v2", enabled: false, timeoutMs: 5_000 });
		expect(config.candidates).toBe(64);
		expect(config.apiKey).toBe("sk-test");
		expect(config.model).toBe("jev-v2");
		expect(config.enabled).toBe(false);
		expect(config.timeoutMs).toBe(5_000);
	});
});

describe("registered tool", () => {
	test("registers one tool named find, declaring a timeout and opting into parallel dispatch", () => {
		const { registered } = load(new Config({ apiKey: "sk-test" }));
		expect(registered.map(definition => definition.name)).toEqual(["find"]);
		expect(registered[0]?.timeoutMs).toBe(120_000);
		// A read-only search may join a parallel group with sibling calls — but only
		// once its arguments validate, because `defineTool` fails closed on invalid input.
		expect(registered[0]?.isConcurrencySafe?.({ query: "session expiry", grep_keywords: [] })).toBe(true);
		expect(registered[0]?.isConcurrencySafe?.({})).toBe(false);
	});

	test("the registered parameter schema accepts the documented argument shapes and rejects the rest", () => {
		const { registered } = load(new Config({ apiKey: "sk-test" }));
		const schema = registered[0]?.parameters;
		expect(validateJsonSchemaValue(schema as never, { query: "session expiry", grep_keywords: ["sess_ttl"] })).toEqual([]);
		expect(validateJsonSchemaValue(schema as never, { query: "session expiry", grep_keywords: [] })).toEqual([]);
		expect(validateJsonSchemaValue(schema as never, { query: "x", grep_keywords: [], path: "src" })).toEqual([]);
		// `grep_keywords` is required, and a scalar there is not a keyword list.
		expect(validateJsonSchemaValue(schema as never, { query: "x" }).length).toBeGreaterThan(0);
		expect(validateJsonSchemaValue(schema as never, { query: "x", grep_keywords: "nope" }).length).toBeGreaterThan(0);
		// The implicit parameter root is open by design, so a stale extra argument is
		// tolerated rather than turned into a hard argument failure.
		expect(validateJsonSchemaValue(schema as never, { query: "x", grep_keywords: [], max: 8 })).toEqual([]);
		// The nested array is not: a non-string keyword is a violation.
		expect(validateJsonSchemaValue(schema as never, { query: "x", grep_keywords: [1] }).length).toBeGreaterThan(0);
	});

	test("the registered output schema validates the canonical value and rejects extras", () => {
		const { registered } = load(new Config({ apiKey: "sk-test" }));
		const schema = registered[0]?.output.schema as never;
		const value = { text: "1 hit(s) …", meta: { total: 1, truncated: false, threshold: 0.2, files: [] } };
		expect(validateJsonSchemaValue(schema, value)).toEqual([]);
		expect(validateJsonSchemaValue(schema, { text: "x" }).length).toBeGreaterThan(0);
		expect(validateJsonSchemaValue(schema, { ...value, extra: 1 }).length).toBeGreaterThan(0);
	});

	test("the output renderer puts the digest text in front of the model", () => {
		const { registered } = load(new Config({ apiKey: "sk-test" }));
		const rendered = registered[0]?.output.render(undefined, { text: "the digest", meta: {} } as never);
		expect(rendered).toEqual([{ type: "text", text: "the digest" }]);
	});

	test("the presentation projection passes the card meta through unchanged", () => {
		const { registered } = load(new Config({ apiKey: "sk-test" }));
		const meta = { total: 2, truncated: false, threshold: 0.2, files: [] };
		expect(registered[0]?.output.presentationMeta?.(undefined, { text: "x", meta } as never)).toEqual(meta);
	});

	test("a presenter declines to render once the logged arguments no longer validate", () => {
		const { registered } = load(new Config({ apiKey: "sk-test" }));
		// `defineTool` guards every presenter with the parameter schema, so replaying a
		// log written against an older argument shape yields the generic card instead
		// of a throw or a wrong card.
		expect(registered[0]?.presentCall?.({})).toBeUndefined();
		expect(registered[0]?.presentResult?.({}, { content: [], isError: false })).toBeUndefined();
		expect(registered[0]?.presentCall?.({ query: "q", grep_keywords: [] })).toBeDefined();
	});

	test("adds a system prompt section next to the grep guidance that names the real tools", () => {
		const { sections } = load(new Config({ apiKey: "sk-test" }));
		expect(sections.map(section => section.name)).toEqual(["tool:find"]);
		expect(sections[0]?.order).toBe(1500 + 1);
		const text = sectionText(sections[0]);
		expect(text).toContain("find tool");
		expect(text).toContain("grep");
		// The pi-only discovery tool names must not leak into a harness prompt.
		expect(text).not.toContain("ffgrep");
		expect(text).not.toContain("ffind");
	});

	test("keeps working when the deployment's discovery tools are absent", () => {
		const { sections, registered } = load(new Config({ apiKey: "sk-test" }), { withGrep: false });
		expect(registered.map(definition => definition.name)).toEqual(["find"]);
		expect(sectionText(sections[0])).not.toContain("grep for exact strings");
	});

	test("registers no tool and warns when no Jev key resolves", () => {
		const { registered, sections, commands, warnings } = withoutJevEnv(() => load(new Config({})));
		expect(registered).toEqual([]);
		expect(sections).toEqual([]);
		expect(warnings[0]).toContain("find needs a Jev API key");
		// The status command still registers, so a broken deployment stays diagnosable.
		expect(commands.map(command => command.name)).toEqual(["find"]);
		expect(commands[0]?.handler().text).toMatch(/JEV_API_KEY/);
	});

	test("registers no tool when a budget field is not a positive integer", () => {
		const { registered, warnings } = load(new Config({ apiKey: "sk-test", windows: 0 }));
		expect(registered).toEqual([]);
		expect(warnings[0]).toContain("windows must be a positive integer");
	});

	test("honours enabled: false, registering no tool but keeping the status command", () => {
		const { registered, commands } = load(new Config({ apiKey: "sk-test", enabled: false }));
		expect(registered).toEqual([]);
		expect(commands[0]?.handler().text).toContain("not registered");
	});

	test("loads without the commands plugin and still registers the tool", () => {
		const { registered, commands } = load(new Config({ apiKey: "sk-test" }), { withCommands: false });
		expect(registered.map(definition => definition.name)).toEqual(["find"]);
		expect(commands).toEqual([]);
	});

	test("the status command reports the resolved endpoint and budgets, never the key", () => {
		const { commands } = load(new Config({ apiKey: "sk-secret", baseUrl: "https://jev.example/", model: "jev-v2" }));
		const text = commands[0]?.handler().text ?? "";
		expect(text).toContain("jev-v2 @ https://jev.example (key from plugin config)");
		expect(text).not.toContain("sk-secret");
		expect(text).toContain("candidates=128 files=20");
	});

});

describe("runFind end to end (stub judge transport)", () => {
	/** A judge transport answering every question with the same probability. */
	function stubFetch(p: number, calls: { count: number } = { count: 0 }): typeof fetch {
		return (async (_url: unknown, init?: RequestInit) => {
			calls.count++;
			const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, unknown> };
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: p };
			return new Response(
				JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
	}

	const args = (extra: Partial<FindToolParams> = {}): FindToolParams => ({
		query: "where do we verify webhook signatures?",
		grep_keywords: ["webhook", "hmac"],
		...extra,
	});

	test("produces a digest whose hits and card agree, range for range", async () => {
		const cwd = await workspace();
		const { details, digest } = await run({ cwd, params: args() });
		expect(details.hits.map(hit => hit.rel)).toContain("src/webhook.ts");
		expect(details.stats.requests).toBeGreaterThan(0);
		expect(details.stats.errors).toBe(0);

		expect(digest).toContain('hit(s) for "where do we verify webhook signatures?" (τ 0.20), strongest first');
		expect(digest.split("\n")[2]).toStartWith("src/webhook.ts  0.95  6 lines judged");
		const card = findViewFromMeta(JSON.parse(JSON.stringify(findCardMeta(details))));
		expect(card?.shape).toBe("matches");
		if (card?.shape !== "matches") throw new Error("expected a matches-shaped card");
		expect(card.files.map(file => file.path)).toEqual(details.hits.map(hit => hit.rel));
		const hitOf = (index: number) => {
			const hit = details.hits[index];
			if (hit === undefined) throw new Error(`no hit at index ${index}`);
			return hit;
		};
		for (const [index, file] of card.files.entries()) {
			expect(file.matches.map(match => match.lineNumber)).toEqual(hitOf(index).ranges.slice(0, 3).map(range => range.start));
			expect(digest).toContain(`${file.path}:${file.matches[0]?.lineNumber}`);
		}
	});

	test("rejects an empty query before spending a single judge request", async () => {
		const cwd = await workspace();
		const calls = { count: 0 };
		await expect(run({ cwd, params: args({ query: "   " }), fetch: stubFetch(0.9, calls) })).rejects.toThrow(/non-empty description/);
		expect(calls.count).toBe(0);
	});

	test("rejects a missing or non-directory path with actionable text", async () => {
		const cwd = await workspace();
		await expect(run({ cwd, params: args({ path: "nope/" }) })).rejects.toThrow(/Path not found: nope\//);
		await expect(run({ cwd, params: args({ path: "README.md" }) })).rejects.toThrow(/Path is not a directory: README\.md/);
	});

	test("narrows the scope and displays hit paths relative to it", async () => {
		const cwd = await workspace();
		const { details, digest } = await run({ cwd, params: args({ query: "webhook signature verification", path: "src" }) });
		expect(details.scopePath).toBe("src/");
		expect(digest).toContain("in src/");
		// Hit paths stay relative to the session cwd (not the narrowed scope), so the
		// model can hand them straight to `read`.
		expect(details.hits.map(hit => hit.rel)).toContain("src/webhook.ts");
		expect(digest).toContain("src/webhook.ts:1");
	});

	test("fails loudly when every judge request fails instead of reporting no hits", async () => {
		const cwd = await workspace();
		const failing = (async () => new Response("boom", { status: 400 })) as unknown as typeof fetch;
		await expect(run({ cwd, params: args(), fetch: failing })).rejects.toThrow(/judge requests failed/);
	});

	test("honours caller cancellation, which is what a DSH tool timeout relies on", async () => {
		const cwd = await workspace();
		const controller = new AbortController();
		controller.abort();
		await expect(run({ cwd, params: args(), signal: controller.signal })).rejects.toThrow();
	});
});

/** Run a find call with the documented judge endpoint and a permissive stub transport. */
async function run(options: {
	cwd: string;
	params: FindToolParams;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}): Promise<{ details: FindDetails; digest: string }> {
	return await runFind({
		cwd: options.cwd,
		params: options.params,
		judge: { apiKey: "sk-test", baseUrl: "https://jev.example", model: "jev-test" },
		fetch: options.fetch ?? permissiveFetch,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
}

const permissiveFetch = (async (_url: unknown, init?: RequestInit) => {
	const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, unknown> };
	const answers: Record<string, unknown> = {};
	for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.95 };
	return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}) as unknown as typeof fetch;

async function workspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-dsh-"));
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.writeFile(
		path.join(dir, "src", "webhook.ts"),
		[
			"import crypto from 'node:crypto';",
			"// Verify webhook HMAC signatures before processing.",
			"export function verifySignature(payload: string, header: string, secret: string): boolean {",
			"\tconst expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');",
			"\treturn crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));",
			"}",
			"",
		].join("\n"),
	);
	await fs.writeFile(path.join(dir, "README.md"), "# demo\n\nNothing about webhooks here.\n");
	return dir;
}
