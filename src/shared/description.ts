/**
 * Model-facing tool copy shared by the pi extension and the DSH plugin. The
 * discovery tools the copy points AWAY from are named differently per host
 * (`ffgrep`/`fffind` in pi, `grep`/`glob` in DSH), so the host injects them and
 * both hosts teach the model the same usage rules.
 */

/** Host-specific names of the cheaper discovery tools `find` complements. */
export interface DiscoveryToolNames {
	/** Exact-content search (regex/string), as the model must name it. */
	grep: string;
	/** File-name search, as the model must name it. */
	glob: string;
}

/** pi's one-line prompt snippet (its prompt-snippet mechanism). */
export const FIND_PROMPT_SNIPPET =
	"find: semantic search — plain-language query in, files + calibrated line ranges out; for concept lookups, unfamiliar code, or after greps miss";

/**
 * The tool description sent to the model.
 * @param names - the host's names for `grep` and `glob`.
 * @returns the complete description text.
 */
export function findDescription(names: DiscoveryToolNames): string {
	return `Semantic code search: describe what you want in plain language, get the files and exact line ranges that implement it, each with a calibrated 0-1 probability. No index; searches the live workspace tree on every call. A typical find takes a few seconds and costs a fraction of a cent.

WHEN TO USE (instead of grep):
- The words you'd use may NOT match the code's identifiers ("where do we expire sessions?" when the code says \`sess_ttl\`), or you don't know this codebase yet.
- One or two greps already missed or returned noise, and you would otherwise open many speculative files.
Do NOT use it for exact strings, regexes, or known symbols (that is ${names.grep} territory), nor for file names (${names.glob}) — those are cheaper and faster.

USAGE
- \`query\`: a concept or behavior ("where do we verify webhook signatures?", "retry budget for failed requests"), not a regex. Quoted phrases in \`query\` are matched whole.
- \`grep_keywords\`: identifiers or terms likely to appear verbatim in matching source; they steer lexical pre-ranking. Pass \`[]\` when nothing specific comes to mind.
- \`path\`: one directory to search; omit for the workspace root. Narrow it when you already know the subsystem.

RESULTS
- Hits are strongest first as \`path:start-end score snippet\`; open the ranges with \`read\`.
- Scores are absolute yes/no probabilities, comparable across calls; below ~0.4 is weak evidence — reword the query instead of concluding absence.
- Batch related questions into one descriptive \`query\` rather than several narrow calls.`;
}

/**
 * pi's standing prompt guidelines for the tool.
 * @param names - the host's names for `grep` and `glob`.
 * @returns one guideline per array entry.
 */
export function findPromptGuidelines(names: DiscoveryToolNames): string[] {
	return [
		`Exact strings, regexes, and known symbols belong to ${names.grep} (or rg via bash); file names belong to ${names.glob}.`,
		"When a grep missed or returned noise, or the concept's name in code may differ from your words, call `find` once with a descriptive query before reading files speculatively.",
	];
}
