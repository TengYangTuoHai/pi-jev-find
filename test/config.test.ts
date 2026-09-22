import { describe, expect, test } from "bun:test";
import { DEFAULT_BUDGETS, loadConfig } from "../src/config";

describe("loadConfig", () => {
	test("defaults apply with an empty environment", () => {
		const config = loadConfig({});
		expect(config.enabled).toBe(true);
		expect(config.budgets).toEqual(DEFAULT_BUDGETS);
	});

	test("JF_ budget overrides parse, clamp, and ignore garbage", () => {
		const config = loadConfig({ JF_CANDIDATES: "16", JF_WINDOWS: "not-a-number", JF_FILES: "0" });
		expect(config.budgets.candidates).toBe(16);
		expect(config.budgets.windows).toBe(DEFAULT_BUDGETS.windows);
		expect(config.budgets.files).toBe(1); // clamped to the minimum, not zeroed
	});

	test("JF_ENABLED=0 disables registration", () => {
		expect(loadConfig({ JF_ENABLED: "0" }).enabled).toBe(false);
		expect(loadConfig({ JF_ENABLED: "1" }).enabled).toBe(true);
	});
});
