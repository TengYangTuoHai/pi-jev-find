/**
 * TUI rendering for the find tool: a one-line call preview and a collapsed /
 * expanded result view with judge-calibrated score gauges and range heat.
 * Components are plain structural objects ({ render, invalidate }) so no
 * runtime pi-tui import is required.
 */
import type { Component } from "@earendil-works/pi-tui";
import { rankedHeat } from "./cascade/passages.ts";
import type { FindDetails, FindToolParams, FindHit } from "./types.ts";

/** The theme surface this renderer uses; structurally satisfied by pi's Theme. */
export interface ThemeLike {
	fg(name: string, text: string): string;
	bold(text: string): string;
}

/** Line ranges shown per hit in the expanded view. */
const RANGES_SHOWN = 3;
/** Heat gauge segments. */
const GAUGE_SEGMENTS = 10;

function component(render: (width: number) => string[]): Component {
	return {
		render,
		invalidate() {},
	};
}

/** Tabs to spaces; terminal-safe single line. */
function sanitize(text: string): string {
	return text.replace(/\t/g, "  ");
}

/** `0.94` → filled gauge `█████████░`. */
function gauge(p: number): string {
	const filled = Math.round(Math.min(1, Math.max(0, p)) * GAUGE_SEGMENTS);
	return "█".repeat(filled) + "░".repeat(GAUGE_SEGMENTS - filled);
}

/** Heat color: strong hits green, mid amber, weak dim. */
function heat(theme: ThemeLike, p: number, text: string): string {
	if (p >= 0.6) return theme.fg("success", text);
	if (p >= 0.4) return theme.fg("warning", text);
	return theme.fg("dim", text);
}

/** The pending call preview: `find "query" [in path]`. */
export function renderFindCall(args: Partial<FindToolParams>, theme: ThemeLike): Component {
	let text = theme.fg("toolTitle", theme.bold("find ")) + theme.fg("accent", sanitize(`"${args.query ?? ""}"`));
	if (args.path !== undefined) text += theme.fg("dim", ` in ${sanitize(args.path)}`);
	const keywords = args.grep_keywords ?? [];
	if (keywords.length > 0) text += theme.fg("dim", ` [${keywords.map(sanitize).join(", ")}]`);
	return component(() => [text]);
}

export function renderFindResult(
	details: FindDetails | undefined,
	isError: boolean,
	expanded: boolean,
	theme: ThemeLike,
): Component {
	if (details === undefined) {
		return component(() => [theme.fg(isError ? "error" : "dim", isError ? "find failed" : "find")]);
	}
	const { hits, stats, threshold, elapsedMs } = details;
	const lines: string[] = [];
	const head =
		hits.length === 0
			? theme.fg("warning", `no hits (τ ${threshold.toFixed(2)})`)
			: theme.fg("success", `${hits.length} hit${hits.length === 1 ? "" : "s"}`) +
				theme.fg("dim", ` (τ ${threshold.toFixed(2)}), strongest first`);
	lines.push(head);
	if (expanded) {
		for (const hit of hits) lines.push(...hitLines(hit, theme));
	}
	lines.push(
		theme.fg(
			"dim",
			`listed ${stats.filesListed} · judged ${stats.judged} · read ${stats.filesRead} files · ${stats.requests} requests · ${stats.inputTokens + stats.outputTokens} tokens · $${stats.cost.toFixed(4)} · ${(elapsedMs / 1000).toFixed(1)}s wall / ${(stats.apiMs / 1000).toFixed(1)}s api${stats.errors > 0 ? ` · ${stats.errors} errors` : ""}`,
		),
	);
	return component(() => lines);
}

function hitLines(hit: FindHit, theme: ThemeLike): string[] {
	const out: string[] = [];
	const score = hit.contentScore.toFixed(2);
	const coverage = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
	out.push(`${theme.fg("accent", sanitize(hit.rel))}  ${heat(theme, hit.contentScore, score)}  ${theme.fg("dim", coverage)}`);
	for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
		const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
		out.push(
			`  ${theme.fg("dim", sanitize(`${hit.rel}:${span}`))}  ${heat(theme, range.p, `${gauge(range.p)} ${range.p.toFixed(2)}`)}  ${sanitize(range.snippet)}`,
		);
	}
	return out;
}
