# pi-jev-find

A semantic **find** tool for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a standalone port of the [oh-my-pi](https://github.com/can1357/oh-my-pi) `jfind` cascade (itself derived from [jegrep](https://github.com/can1357/jegrep)).

`find` answers *"where does this codebase implement X?"* in one call: a four-stage cascade (lexical scan → filename ranking → passage judging → full-file verification) that uses ripgrep for the cheap stages and the **Jev** probability API ([TypeSafe System One](https://typesafe.ai)) for judgment, returning calibrated line ranges instead of keyword soup.

The judge is the native System One API — the same wire jegrep uses — so probabilities are absolute and calibrated, not emulated through a chat model.

Both hosts register the same tool, run the same cascade, and show the model the same digest. Only registration and result presentation are host-specific — see [DeepSeek Harness](#deepseek-harness).

## Install

### pi

```sh
pi install npm:pi-jev-find
```

or in a single project, copy/symlink `src/` under `.pi/extensions/` and run `/reload`.

### DeepSeek Harness

```sh
dsh plugin --profile <name> add pi-jev-find
```

or, from a checkout, `dsh plugin --profile <name> add ./pi-jev-find`.

> The harness is a developer preview and its plugin API moves between releases: this adapter is built and tested against the 0.1 preview line (`@deepseek-ai/dsh-tools` `0.1.5-rc.1` and `0.1.7-alpha.1`, whose plugin surface for tools, prompt sections, and commands is identical). A 0.2 release is a breaking change; the declared peer ranges say so.

### ripgrep

No install needed: ripgrep ships with the package (`@vscode/ripgrep`), so both hosts work on a bare Node 22+/Bun host. `rg` on `PATH` is only used as a fallback if the packaged binary is unavailable, and `JF_RG=/path/to/rg` overrides both.

## What the model sees

```
find(query: "where do we validate webhook signatures?", max: 8)
→
src/billing/webhooks.ts
  41-89  0.94  hmac verification + timestamp tolerance
  212-248 0.71  retry queue re-checks signature on replay
src/lib/crypto/sign.ts
  ...
```

Each hit carries judge-calibrated probabilities; ranges are exact line spans, ready for a follow-up `read`.

## Configuration

All knobs are environment variables; all are optional except the API key. Under the harness every knob is also a plugin-config field, which wins over the environment variable of the same meaning — see [DeepSeek Harness](#deepseek-harness).

### Judge endpoint

| Variable | Fallback (jegrep-compatible) | Default | Meaning |
| --- | --- | --- | --- |
| `JEV_API_KEY` | `TYPESAFE_API_KEY` | — (required) | Bearer key for the System One API. |
| `JEV_BASE_URL` | `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | API root. |
| `JEV_MODEL` | `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Judgment model. |

The `find` tool is only offered to the model when a key resolves at startup; without one, pi-jev-find logs a warning and skips tool registration entirely (`/find` remains available as a status check). A listed-but-broken tool burns one failed call and teaches the model to avoid `find` for the rest of the session.

### Cascade budgets

| Variable | Default | Meaning |
| --- | --- | --- |
| `JF_ENABLED` | `1` | `0` disables the tool registration entirely. |
| `JF_CANDIDATES` | `128` | Max candidate files kept after the lexical scan. |
| `JF_FILES` | `20` | Max files whose names are judged. |
| `JF_WINDOWS` | `24` | Max passage windows judged per file. |
| `JF_WINDOW_BYTES` | `8192` | Passage window size in UTF-8 bytes. |
| `JF_SKETCH_BYTES` | `384` | Bytes per file sketch shown to the filename judge. |
| `JF_FULL_LIMIT` | `40` | Max files read fully in the verification stage. |
| `JF_CONCURRENCY` | `16` | Parallel judge requests. |
| `JF_RG` | — | Path to an explicit ripgrep binary, overriding the packaged build. |

Run `/find` inside pi to see the resolved judge endpoint and budgets.

## DeepSeek Harness

The package ships two entries and declares both:

- `src/index.ts` — the pi extension (`pi.extensions` in `package.json`).
- `lib/dsh/index.js` — the harness plugin, loaded through `cordis.patch.yml` (`dsh.bundle`). Built from the same source by `npm run build`; `prepare` runs it, so git installs work without a manual build step.

Everything below the surface is shared: `src/cascade`, `src/judge`, `src/rg.ts`, and the orchestration in `src/shared/` are host-agnostic. `src/dsh/` adds only the harness surface — the Cordis plugin shape, the config schema, the parameter schema, the system-prompt section, the `/find` status command, and the search card.

### Configure it

Override defaults in the profile's `cordis.patch.yml` (or in a `--patch` overlay):

```yaml
- insert:
    - id: pi-jev-find
      name: pi-jev-find/lib/dsh/index.js
      config:
        apiKey: sk-…          # or set JEV_API_KEY
        model: jev-v2
        candidates: 64
        timeoutMs: 60000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` registers no tool and leaves `/find` as a status check. |
| `apiKey` | — | Jev API key. Falls back to `JEV_API_KEY` / `TYPESAFE_API_KEY`. |
| `baseUrl` | `https://api.typesafe.ai` | Jev API root. Falls back to `JEV_BASE_URL` / `TYPESAFE_BASE_URL`. |
| `model` | `jev-latest` | Judgment model. Falls back to `JEV_MODEL` / `TYPESAFE_DEFAULT_MODEL`. |
| `timeoutMs` | `120000` | Tool-call timeout budget, enforced cooperatively through `exec.signal`. |
| `concurrency`, `nameBatch`, `candidates`, `files`, `windows`, `windowBytes`, `sketchBytes`, `fullLimit` | see [Cascade budgets](#cascade-budgets) | Cascade budgets; each falls back to its `JF_*` variable. |

As on pi, a deployment with no resolvable key registers no tool and logs why: DSH already ships `grep`/`glob`, and a listed-but-broken `find` would burn one failed call and then never be picked again for the session.

### What the harness does better

- **No `rg` requirement** — the packaged ripgrep binary is used.
- **Real result cards** — `presentResult` returns DSH's `card: 'search'` view (files grouped, ranges listed), with the bounded card metadata persisted alongside the session log so a replayed session still renders it.
- **Bounded, cancellable calls** — `timeoutMs` plus `exec.signal` reach every judge request and ripgrep run, and `isConcurrencySafe` lets `find` run beside sibling read-only calls.

### Known limitations

- **No progress on a pending call.** The harness renders a pending call from its arguments and updates it only when the result lands, so the cascade's phase narration has nowhere to go. The result reports the same accounting in its footer text instead.
- **No tool-level usage channel.** DSH attributes token and cost accounting to model calls, not tools, so the judge spend appears in the result footer (`… $0.0012 …`) and not in any usage ledger.
- **The workspace must be on the harness host.** Like DSH's own `grep`/`glob`, the cascade reads files directly; a remote or sandboxed deployment without a co-located filesystem cannot be searched.

## How it works

```
query ──► keywords (stopword split, camelCase split)
      ──► rg -i --json          lexical scores: idf-weighted hit counts   (CANDIDATES=128)
      ──► rg --files + filters  deny dirs, secrets, binaries             (FILES=20)
      ├─ stage 1: filename judge  "is <sketch of path> likely to contain <intent>? 0..1"
      ├─ stage 2: passage judge   per 8 KB window, line ranges + p
      └─ stage 3: full-file verify top hits, merge ranges
      ──► ranked hits with line ranges + probabilities
```

- Budgets mirror jegrep's published defaults; every request is one batched System One call, so a typical find costs a few cents at most.
- Secret files (`.env`, keys, pem, tfstate…) and VCS dirs never reach the judge.
- Lexical champions (top-2 files by keyword score) skip judging and are read directly.

## License

MIT — see [LICENSE](LICENSE). Derived from oh-my-pi's `jfind` (MIT, Can Bölük) and jegrep (MIT, Can Bölük).
