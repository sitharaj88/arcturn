# @arcturn/index

> **Internal to the arcturn CLI. Published so `arcturn` resolves; its API may change in any release without a major version bump.** Embedders should depend on [`@arcturn/core`](https://www.npmjs.com/package/@arcturn/core) and [`@arcturn/ai`](https://www.npmjs.com/package/@arcturn/ai), whose surfaces are the ones the SDK documents.

**A token-optimized code index for the [Arcturn](../../README.md) harness.**

> An index's token cost is what it puts in the model's context, not what it costs to build.

A retrieval tool that returns whole file bodies is *worse* than `grep`: it spends thousands of
tokens answering a question the agent could have answered with a `file:line`. So this index
returns **addresses, not content** — and the agent reads only what it decides it needs, with the
tools it already has.

```text
search_code("where is auth handled")

packages/core/src/auth/session.ts:42  function createSession(user: User): Session — Issues a signed…
packages/server/src/middleware.ts
  :18  function requireAuth(req, res, next) — Rejects requests without a valid bearer token.
  :51  const AUTH_HEADER = "authorization"
  + 3 more here (narrow with path:"packages/server/src/middleware.ts")
… 27 more matches not shown. Narrow with kind:"function", path:"src/**", or a more specific query.
Next: read({"path":"packages/core/src/auth/session.ts","offset":42,"limit":31}) for createSession.
```

That whole result is roughly 120 tokens. The same hits with bodies would be several thousand.

## How it relates to `symbols` and `grep`

|  | `symbols` (LSP) | `search_code` (this) | `grep` |
|---|---|---|---|
| Needs a language server | yes | **no** | no |
| Covers every file type | no | **yes** (incl. Markdown, config) | yes |
| Fuzzy / conceptual queries | no | **yes** | no |
| Exact strings and regexes | no | no | **yes** |
| Ground-truth symbol table | **yes** | approximate | no |

`symbols` is the *precise* path when a server is running. This is the *always-available* one.
`grep` remains right for every literal occurrence of an exact string. The `search_code` tool
description says exactly this to the model, so it picks correctly without being told.

## Architecture

```text
 walk ──► chunk ──────► store ──────────► search ────────► format ──► tool
  │        │             │                 │                │
  │        │             │                 │                └─ hard token budget,
  │        │             │                 │                   per-file collapsing,
  │        │             │                 │                   an explicit `read` hint
  │        │             │                 └─ BM25 ⊕ symbol-name ⊕ (optional) vectors,
  │        │             │                    merged by Reciprocal Rank Fusion (k = 60)
  │        │             └─ JSONL chunks + a compact inverted index,
  │        │                keyed by content hash so `git checkout` is free
  │        └─ declaration boundaries per language, never fixed windows;
  │           an unparseable file still indexes as one whole-file chunk
  └─ .gitignore-aware, binary/minified/oversize-skipping, interruptible
```

### Chunking

Fixed line-windows split functions in half and retrieve meaningless fragments, so chunks land on
declaration boundaries instead. Extraction is heuristic and dependency-free: one scanner engine
(`scanner.ts`) driven by per-language rule tables (`language.ts`), over a masked mirror of the
source (`mask.ts`) in which comments and string literals have been blanked. That masking pass is
what makes brace counting and declaration matching reliable — a `}` inside a string or a
`class Foo` inside a comment can never move the scanner.

The scanner also tracks **scope depth**, so `const engine = …` at module scope is a symbol while
the identical line inside `describe("…", () => {` is a local and is not indexed. On this
repository that distinction alone removes 6,700 junk chunks (14,497 → 7,773).

Languages: TypeScript/JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), Python, Go, Rust,
Java, Kotlin, Ruby, PHP, C, C++, C#, Swift, shell, and Markdown (headings become `section`
chunks). Everything else — and any file the scanner finds nothing in — indexes as a single
whole-file chunk, so no file is ever unfindable. `chunkFile` never throws.

### Retrieval

Three cheap signals, fused by Reciprocal Rank Fusion (`score = Σ w/(60 + rank)`), which is
parameter-free and robust to the fact that a BM25 score of 8.3, a symbol score of 1040, and a
cosine of 0.71 are not comparable numbers:

1. **BM25** over name + container + signature + doc + path + body identifiers, with field
   weighting applied by term repetition (name ×4, container/signature ×2). Identifiers are
   indexed both whole and split, so `getUserById` is found by "user id".
2. **Symbol-name scoring** — exact ▸ qualified-exact ▸ prefix ▸ containment ▸ word-set ▸
   subsequence, weighted ×2 in the fusion. This is what makes `TokenBucket` return the class
   named `TokenBucket` rather than the twelve files that mention it.
3. **Embeddings** — optional, **off by default**, because embedding a repository costs real
   tokens. See [`embedder.ts`](src/embedder.ts) for when it earns its keep.

### Token optimization

- `detail: "signatures"` (default) — one line per hit, held to ~30 tokens by a per-hit character
  budget that clips the *description*, never the address.
- `detail: "snippets"` — adds a bounded window of body lines (~2.5× the cost).
- `detail: "full"` — bodies, on request only (~4–10× the cost).
- A hard token budget (1500 by default) with an explicit `… N more matches not shown` line naming
  the filters that would narrow them. Nothing is ever silently dropped.
- Hits in one file collapse under a single path header; a hit contained in a better-ranked hit
  from the same file is dropped outright.
- Every result ends with the exact `read` call for the top hit.

### Incremental indexing

Files are keyed by **content hash, never mtime** — a `git checkout` rewrites every mtime in the
tree while changing almost no content, and an mtime-keyed index would reindex the world on every
branch switch. Indexing is interruptible (`AbortSignal` and a wall-clock deadline), yields to the
event loop every few files, and a partial pass is saved and usable. A corrupt, truncated, or
version-mismatched index rebuilds silently rather than surfacing an error.

## Usage

```ts
import { createSearchCodeTool } from "@arcturn/index";

const searchCode = createSearchCodeTool();
// register alongside the built-in tools; it indexes ctx.cwd on first use
```

Warm the index at session start so the first search is instant:

```ts
import { CodeIndexService, createSearchCodeTool } from "@arcturn/index";

const service = new CodeIndexService();
void service.ensureIndexed(process.cwd()); // fire and forget; never blocks
```

### Options

| option | default | meaning |
|---|---|---|
| `indexRoot` | `~/.arcturn/index` | where per-repository indexes live (`<root>/<sha1(cwd)>`) |
| `refreshBudgetMs` | `4000` | wall-clock budget for the refresh before a search |
| `minRefreshIntervalMs` | `2000` | minimum gap between refreshes of one root |
| `maxFileBytes` | `1_000_000` | per-file size cap |
| `tokenBudget` | `1500` | token ceiling for a rendered result |
| `walk` | — | `.gitignore` handling, extra ignores, file cap |
| `embedder` | *none* | opt-in semantic recall; costs real tokens |

### Integrating the tool

`@arcturn/index` intentionally does **not** depend on `@arcturn/tools`, so it mirrors that
package's `textResult` / `errorResult` / `abortedResult` / `resolvePath` helpers privately —
the same choice `packages/cli/src/lsp/symbols.ts` makes for the same reason. If the two packages
ever share a dependency edge, those four private functions in [`src/tool.ts`](src/tool.ts) should
be replaced with imports; nothing else in the package touches another package's internals.

## Measured on this repository

516 files, 7,773 chunks, measured end to end:

| | |
|---|---|
| Cold index (parse everything) | 0.86 s |
| Warm pass, nothing changed | 0.12 s, **zero** files re-chunked |
| Index on disk | 8.1 MB (`chunks.jsonl` 5.9 MB, `postings.json` 2.3 MB) |
| Query latency (8 queries, 7.7k chunks) | 9–10 ms |
| **Tokens per hit — `signatures`** | **26–31 (mean 29)** |
| Tokens per hit — `snippets` | 72–104 (mean 83) |
| Tokens per hit — `full` | 84–346 (mean 185) |
| Whole result at the default budget | 303–625 tokens (`signatures`) |

`full` costs **6.3×** what `signatures` costs for the same hits — which is why the model has to
ask for it.

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
