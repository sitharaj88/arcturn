---
title: Code search
description: search_code — an offline BM25 + structural index that returns file:line addresses instead of file bodies, with no embeddings and no network.
section: Core concepts
order: 4.2
---

`search_code` is the tool an agent reaches for when it half-remembers a name, or when the
question is structural — *where is auth handled*, *what parses the config*. It is backed by
`@arcturn/index`, an offline index of your repository built on BM25 and a declaration
scanner. No embeddings, no model calls, no network: the package contains no HTTP client at
all.

The CLI registers it unconditionally, alongside the nine tools from
[`@arcturn/tools`](/docs/tools). There is nothing to turn on.

## Addresses, not contents

A retrieval tool that hands back file bodies is worse than `grep`: it spends thousands of
tokens answering a question the agent could have answered with a `file:line`. So the
default result is one line per hit, and the agent reads what it decides it needs with the
`read` tool it already has.

```text
search_code({ "query": "where is auth handled" })

packages/core/src/auth/session.ts:42  function createSession(user: User): Session — Issues a signed…
packages/server/src/middleware.ts
  :18  function requireAuth(req, res, next) — Rejects requests without a valid bearer token.
  :51  const AUTH_HEADER = "authorization"
  + 3 more here (narrow with path:"packages/server/src/middleware.ts")
… 27 more matches not shown. Narrow with kind:"function", path:"src/**", or a more specific query.
Next: read({"path":"packages/core/src/auth/session.ts","offset":42,"limit":31}) for createSession.
```

Four things in that output are deliberate. Several hits in one file collapse under a single
path header, so the path is paid for once. A hit wholly contained in a better-ranked hit
from the same file — a method already covered by its class — is dropped outright. The
withheld count is stated, with the exact filters that would narrow it, so nothing is ever
silently lost. And the last line is the precise `read` call for the top hit, so the next
step costs no reasoning.

## Why BM25 and not embeddings

Embedding a repository is not free, and the cost lands in three places at once.

- **Tokens.** A 5,000-file codebase produces on the order of 100,000 chunks. Even at the
  ~40-token summaries this index would send — never bodies — that is millions of tokens
  through an embedding endpoint on the first pass, and more on every branch with new code.
- **Latency.** A query has to be embedded before it can be matched, so the first
  round trip is a network call. BM25 answers from a loaded snapshot in single-digit
  milliseconds.
- **Disclosure.** An embedding index sends your source, or summaries of it, to a third
  party. A lexical index never leaves the disk it was built on.

That last one is the decisive one for a tool whose whole point is being auditable. Arcturn's
default retrieval path costs zero tokens, zero network calls and zero new trust
relationships — and on the queries developers actually type (a half-remembered identifier, a
path fragment, a concept that appears verbatim in a doc comment) the BM25 + symbol hybrid is
already strong.

The seam is still there. `createSearchCodeTool({ embedder })` accepts an `Embedder`, and
vectors join the ranking as one more list rather than replacing anything, so a slow or
misbehaving embedder degrades to the lexical signals instead of breaking the search. It
earns its keep on queries whose vocabulary does not appear in the code at all — "rate
limiting" against a file that only ever says `TokenBucket`. **The CLI supplies no embedder**,
and there is no config key to add one; that is a library-level choice today.

## What gets indexed

Chunks land on **declaration boundaries**, never fixed line windows — a fixed window splits
a function in half and retrieves a meaningless fragment. Extraction is one scanner engine
driven by per-language rule tables, run over a masked mirror of the source in which comments
and string literals have been blanked out, so a `}` inside a string or a `class Foo` inside a
comment can never move the scanner.

| | |
|---|---|
| Languages scanned | TypeScript/JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), Python, Go, Rust, Java, Kotlin, Ruby, PHP, C, C++, C#, Swift, shell, Markdown |
| Chunk kinds | `function` `method` `class` `interface` `struct` `enum` `trait` `impl` `extension` `type` `const` `property` `module` `macro` `section` `file` |
| Everything else | One whole-file chunk, so no file is ever unfindable |
| Skipped | `.gitignore`d paths (honored per directory, the way git honors them), build and dependency directories, lockfiles, binary and font assets |
| Also skipped | Files over **1 MB**, files with a NUL in the first **8,000 bytes**, and minified files (any line ≥ 2,000 chars, or a mean line ≥ 400 chars in a file over 5,000 chars) |
| Walk ceiling | **50,000 files** |

Markdown headings become `section` chunks, which is why prose in this repository is
searchable by the same tool as its code. The scanner also tracks scope depth, so
`const engine = …` at module scope is a symbol while the identical line inside a
`describe("…", () => {` block is a local and is not indexed.

Extraction is heuristic and dependency-free on purpose: a real parser per language would
mean a dozen native or multi-megabyte dependencies, and this index has to run everywhere
Node does. The trade is recall, not correctness — a rule that fails to fire loses one chunk,
and the whole-file fallback keeps the file findable.

## How ranking works

Filters are applied **before** ranking, so `kind: "function"` changes which documents get
rank 1 rather than hiding rows after the fact. What survives the filter is ranked three
independent ways and fused.

```text
query ─┬─► BM25 over name/container/signature/doc/path/body terms   ×1 ─┐
       ├─► symbol-name scoring (exact ▸ prefix ▸ subsequence)       ×2 ─┼─► RRF ─► hits
       └─► embeddings, when an Embedder is supplied                 ×1 ─┘
```

**BM25** (`k1 = 1.2`, `b = 0.75`) gives two properties that matter on code: saturation, so
the tenth occurrence of `retry` in a function adds almost nothing over the third and a
repetitive file cannot dominate; and length normalization, so a one-line signature and a
300-line class are compared fairly. BM25 has no native notion of fields, so field weighting
is done the standard cheap way — by repeating a field's terms. The name counts **×4**, the
container and signature **×2**, the doc comment and path **×1**. Body identifiers are
included once each, deduplicated and capped at 400, which makes "the file that merely
mentions `TokenBucket`" findable while ensuring it can never out-rank the declaration
actually named `TokenBucket`.

Identifiers are tokenized **both whole and split** on camelCase, snake_case, kebab-case and
dotted boundaries, on the document side and the query side alike. That single decision is
what makes a plain lexical index behave semantically on code: `getUserById` is found by
`getUserById`, by `getUser`, and by "user id".

**Symbol-name scoring** is the signal that makes this feel like a code index rather than a
text search. It looks only at a chunk's name and container path and grades matches in widely
separated tiers — exact ▸ qualified-exact ▸ prefix ▸ qualified-suffix ▸ containment ▸
word-set ▸ subsequence — so a weaker tier can never overtake a stronger one. A small
within-tier bonus favors real declarations over the Markdown heading that documents them.
This list is weighted **×2** in the fusion, because on code "the thing actually named that"
is more often the intent than "the text that mentions it most".

**Reciprocal Rank Fusion** (`k = 60`) merges the lists. A BM25 score of 8.3, a symbol score
of 1040 and a cosine of 0.71 are not comparable numbers, and normalizing them needs
per-query calibration that is fragile in exactly the cases that matter. RRF throws the scores
away and keeps only the ranks: `score(d) = Σ weight / (60 + rank(d))`. It is parameter-free
apart from `k`, robust to a list being empty, and ties break on document ordinal — so the
same query against the same index returns the same order every time, which matters when an
agent may re-issue a query.

## Parameters

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | A symbol name (exact or partial), or a few words describing the behavior. |
| `kind` | string or string[] | no | Restrict to declaration kinds. The cheapest way to cut a noisy result down. |
| `path` | string | no | A glob (`src/**`, `*.py`) or a plain substring (`/auth/`). Repo-relative, forward slashes. |
| `limit` | number | no | Maximum hits. Default **20**. |
| `detail` | string | no | `signatures` (default), `snippets`, or `full`. |

`detail` is the whole token story. `signatures` is one line per hit; `snippets` adds a
bounded window of body lines; `full` returns bodies, capped at 60 lines per hit. The result
is capped by a **1,500-token budget** either way, and the budget stops the render rather than
truncating a line — an address the agent cannot act on is worse than one fewer hit.

A search that finds nothing is an answer, not an error: an empty index, an empty query or a
filter that excludes everything all return zero hits, with a message naming the filters to
drop and pointing at `grep` for exact strings.

## Where the index lives

Per repository, under `~/.arcturn/index/<16 hex chars of sha1(repo root)>` — `meta.json`,
`chunks.jsonl`, `postings.json`, and `vectors.json` only if an embedder ran. Plain files, no
native dependencies.

Three properties are load-bearing:

- **Files are keyed by content hash, never mtime.** A `git checkout`, a `git stash pop` or a
  fresh clone rewrites every mtime in the tree while changing almost no content. An
  mtime-keyed index would reindex the world on every branch switch.
- **Writes are atomic** — temp file, then rename — so a process killed mid-save leaves the
  previous good index in place rather than a corrupt one.
- **Any problem rebuilds silently.** A truncated JSONL line, a half-written postings file,
  an index written by an older Arcturn: none of these surface to you as an error. They mean
  "reindex", which costs seconds.

Indexing never makes a session wait. A search refreshes first under a wall-clock budget of
**4 seconds** (and skips the refresh entirely if the same root was refreshed under 2 seconds
ago), then answers from whatever is ready. A cold index gets the full budget and may return
partial, with the shortfall stated in the result:

```text
(The index is still warming up — 312 files scanned so far. Re-run for fuller coverage.)
```

The pass is interruptible between files, yields to the event loop every 24 files so a large
repository cannot starve a concurrent tool call or a UI render, and catches every per-file
failure — a file the OS will not let it read is skipped, never thrown.

Measured end to end on Arcturn's own repository (516 files, 7,773 chunks):

| | |
|---|---|
| Cold index, parsing everything | 0.86 s |
| Warm pass, nothing changed | 0.12 s, **zero** files re-chunked |
| Index on disk | 8.1 MB |
| Query latency | 9–10 ms |
| Tokens per hit, `signatures` | 26–31 (mean 29) |
| Tokens per hit, `full` | 84–346 (mean 185) |

## When to prefer it over grep

|  | `search_code` | `grep` | `symbols` |
|---|---|---|---|
| Needs a language server | no | no | **yes** ([LSP](/docs/lsp) must be on) |
| Half-remembered or conceptual queries | **yes** | no | no |
| Every literal occurrence of an exact string | no | **yes** | no |
| Ground-truth symbol table | approximate | no | **yes** |
| Covers Markdown, config, unknown file types | **yes** | **yes** | no |

Reach for `search_code` when you want where something is *defined* and only half-remember
the name, when the question is conceptual or structural, or when you want a map of the
symbols in an area before opening any file.

Reach for [`grep`](/docs/tools#grep) when you need **every** literal occurrence of an exact
string or regex — call sites, a config key, a TODO marker, a version string — or when the
text is not a symbol name, or lives in a file this index skips. Use
[`glob`](/docs/tools#glob) to find files by path pattern, and [`symbols`](/docs/lsp#symbols)
when a language server is running and you want that language's own exact definitions for one
file.

The tool's own description says all of this to the model, so it picks correctly without
being told in a prompt.

## Limits

**Extraction is approximate, not a symbol table.** The scanner is a set of per-language
regex rules over masked source, not a parser. It will miss declarations no rule covers, and
`symbols` is the precise path when a language server is running. This one is the
always-available path.

**It is not on the permission engine's read-only list.** `DEFAULT_READ_ONLY_TOOLS` is
`read`, `grep`, `glob`, `ls` and nothing else, and the runtime does not extend it, so
`search_code` reaches the [permission engine](/docs/permissions#resolution-order) like any
unclassified tool: `default` and `acceptEdits` prompt for it, and **`plan` mode denies it
outright** with "cannot run because it may modify state". It mutates nothing outside its own
index directory, so this is a classification gap rather than a hazard — but it is a prompt
you will see. A rule settles it for `default` and `acceptEdits`:

```json
{ "tool": "search_code", "specifier": "*", "action": "allow", "scope": "project" }
```

A rule cannot settle it in `plan` mode: plan-mode denial is evaluated *before* stored rules,
by design, so the only fix there is the engine's `readOnlyTools` option — which the CLI does
not expose in `.arcturn/config.json` today.

**The interactive CLI warms nothing at startup.** `CodeIndexService.ensureIndexed` exists so
a host can index at session start and make the first search instant; the CLI does not call
it, so the first `search_code` of a session in a large repository is the one that pays, and
may come back partial. The [MCP server](/docs/mcp-server) does construct the service
explicitly.

**None of the tuning is configurable from the CLI.** `indexRoot`, `refreshBudgetMs`,
`tokenBudget`, `maxFileBytes`, the walk options and `embedder` are all parameters of
`createSearchCodeTool`, and the CLI calls it with none of them. Changing any of them means
embedding the library, not editing a config file.

**Under deferred tools it is deferred.** `search_code` is not in
`DEFAULT_ALWAYS_ACTIVE_TOOLS`, so with [deferral](/docs/deferred-tools) on, the model pays
one `tool_search` round trip before it can call this at all. Add it to `alwaysActive` if
your work is search-heavy.

**The index is on your disk, and it is source text.** Chunk bodies are persisted under
`~/.arcturn/index`, outside the repository and outside anything `.gitignore` governs. It
never leaves the machine, but it is a second copy — worth knowing before you point Arcturn
at a repository you would not copy elsewhere.

## Related

- [Tools](/docs/tools) — the nine built-ins `search_code` is registered beside, including
  `grep` and `glob`.
- [LSP diagnostics](/docs/lsp#symbols) — the `symbols` tool, precise where a language server
  is running.
- [Deferred tools](/docs/deferred-tools) — what happens to this tool's schema when tool
  disclosure is on.
- [MCP server](/docs/mcp-server#search_code--read-only-always-on) — the same index, exposed
  to another agent read-only.
