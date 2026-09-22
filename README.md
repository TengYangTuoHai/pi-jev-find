# pi-jev-find

A semantic **find** tool for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — a standalone port of the [oh-my-pi](https://github.com/can1357/oh-my-pi) `jfind` cascade (itself derived from [jegrep](https://github.com/can1357/jegrep)).

`find` answers *"where does this codebase implement X?"* in one call: a four-stage cascade (lexical scan → filename ranking → passage judging → full-file verification) that uses ripgrep for the cheap stages and the **Jev** probability API ([TypeSafe System One](https://typesafe.ai)) for judgment, returning calibrated line ranges instead of keyword soup.

The judge is the native System One API — the same wire jegrep uses — so probabilities are absolute and calibrated, not emulated through a chat model.

## Install

```sh
pi install npm:pi-jev-find
```

or in a single project, copy/symlink `src/` under `.pi/extensions/` and run `/reload`.

Requires `rg` (ripgrep) on your `PATH`.

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

All knobs are environment variables; all are optional except the API key.

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

Run `/find` inside pi to see the resolved judge endpoint and budgets.

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
