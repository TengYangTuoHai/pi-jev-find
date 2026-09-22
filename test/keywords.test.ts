import { describe, expect, test } from "bun:test";
import { keywords, keywordsFromQuery } from "../src/cascade/keywords";

describe("keywordsFromQuery", () => {
	test("quoted phrases are kept whole and removed from tokenization", () => {
		expect(keywordsFromQuery('where do we call "verify signature" handlers')).toContain("verify signature");
		expect(keywordsFromQuery('where do we call "verify signature" handlers')).not.toContain("verify");
	});

	test("stopwords, digits, and sub-3-byte tokens are dropped", () => {
		const out = keywordsFromQuery("the 2 retry how aye");
		expect(out).toEqual(["retry", "aye"]);
	});

	test("cheap stemming covers inflections", () => {
		expect(keywordsFromQuery("spawned compacting")).toEqual(["spawn", "compact"]);
	});

	test("open quotes degrade to plain tokens (stemmed)", () => {
		expect(keywordsFromQuery('"unclosed phrase here')).toEqual(["unclos", "phrase", "here"]);
	});
});

describe("keywords", () => {
	test("extras are lowercased, deduplicated, and appended", () => {
		expect(keywords("retry budget", ["Retry", "BACKOFF", "retry"])).toEqual(["retry", "budget", "backoff"]);
	});
});
