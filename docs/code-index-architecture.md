# Code index architecture

## The governing principle

**An index's token cost is what it puts in the model's context, not what it costs to
build.** Every design decision below follows from that. A retrieval tool that returns
whole file bodies is worse than `grep`, because it spends thousands of tokens to answer
a question the agent could have answered with a `file:line`.

So: **retrieval returns addresses, not content.** The agent then reads only what it
decides it needs, with the tools it already has.

## 1. Chunking — symbol-aware, never fixed windows

Fixed line-windows split functions in half and retrieve meaningless fragments. Chunk on
declaration boundaries instead. Each chunk carries:

| field | why |
|---|---|
| `file`, `startLine`, `endLine` | the address the agent will `read` |
| `kind` (function/class/method/type/const/…) | lets callers filter |
| `name`, `container` (e.g. `ClassName.method`) | the strongest retrieval signal in code |
| `signature` | what gets returned instead of the body |
| `doc` (leading comment/docstring) | carries intent that identifiers don't |
| `body` | **stored, not returned by default** |

Extraction is heuristic and dependency-free — regex/brace-aware scanners per language
family (TS/JS, Python, Go, Rust, Java/Kotlin, Ruby, PHP, C/C++, C#, Swift). It must
degrade gracefully: an unparsed file still indexes as one whole-file chunk with its path
and leading comment, never an error. Arcturn's existing LSP `symbols` tool is the precise
path when a server is running; this index is the always-available one.

## 2. Retrieval — hybrid, zero-cost by default

Pure vector search underperforms on code, because developers search for identifiers they
half-remember. Combine three cheap signals:

1. **BM25** over `name + container + signature + doc + identifier tokens`. Split
   camelCase/snake_case so `getUserById` matches "user id".
2. **Symbol-name scoring** — exact > prefix > subsequence, with a strong boost. If
   someone searches `TokenBucket`, the class named `TokenBucket` must rank first.
3. **Optional embeddings** via a pluggable `Embedder` — **off by default**, because
   embedding a repo costs real tokens. When configured, it adds semantic recall for
   "where do we handle retries" style queries.

Merge with **Reciprocal Rank Fusion** (`score = Σ 1/(k + rank)`, k≈60): parameter-free,
robust to incomparable score scales, and the standard choice for hybrid IR.

## 3. Token optimization — the heart of it

- Default `detail: "signatures"` → each hit is roughly `path:line  kind name(sig)  — doc
  first line`. Target **≤ 30 tokens per hit**, versus 200–500 for a body.
- `detail: "snippets"` adds ±3 lines; `"full"` returns bodies. The model must opt in.
- A hard **token budget** on the whole result (default ~1500), with an explicit
  `… N more matches (narrow with kind:/path:)` line when truncated. Never silently drop.
- Collapse multiple hits in one symbol; collapse many hits in one file into a file-level
  line with the best few.
- Return a **`nextStep` hint** naming the exact `read` call for the top hit, so the agent
  goes straight to content instead of re-searching.

## 4. Incremental indexing

- Key each file by **content hash**, not mtime — a `git checkout` rewrites mtimes and
  would trigger a full reindex.
- Persist under `~/.arcturn/index/<cwd-hash>/`; load on demand, reindex only changed files.
- Respect `.gitignore`; skip binaries (NUL sniff), lockfiles, `dist/`, `node_modules/`,
  minified files, and anything over a size cap.
- Indexing must be **interruptible and non-blocking** — never make a session wait on it.
- Corrupt or version-mismatched index → rebuild silently, never crash.

## 5. Storage

JSONL chunks plus a compact inverted index, both plain files. **No native dependencies**
— it must install and run everywhere Node does, matching the rest of the repo.

## 6. The tool surface

`search_code(query, { kind?, path?, limit?, detail? })`. Its description must teach the
model *when* to reach for it over `grep`: semantic/structural questions ("where is auth
handled") and symbol lookup, where `grep` is right for exact strings and regexes.

---

# Research findings (Aug 2026) and the revised plan

Four parallel research passes, sourced and in part measured on this machine.
The headline is uncomfortable and worth stating first.

## The evidence says an embedding index is *not* the next thing to build

- **SWE-Explore** (848 instances, 203 repos, 10 languages): one-shot retrieval —
  sparse *and* dense — sits "close to random" on repo-level localisation, while
  agentic explorers that grep → read → grep again reach HitFile ≈0.65. Iterative
  search beats better one-shot ranking, decisively.
- **Codebase-Memory**: a tree-sitter knowledge-graph index cut tokens ~10× but
  cut answer quality from **92% to 83%** against plain grep-and-read. Structure
  must *expand and rank* candidates, never *replace* exploration or *gate* them.
- **CORE-Bench**: embedding models scoring 71.7 nDCG@10 on classic code search
  collapse to **20.3** on issue→edit localisation. Classic code-search skill does
  not transfer to the agentic task.
- **Anthropic and Sourcegraph both removed embeddings** from their code context
  paths, citing staleness, privacy, operational cost, and grep outperforming.

The dominant failure mode across every study is **missing evidence, not bad
ranking** — patchers tolerate irrelevant context and collapse without core
evidence. So recall beats precision, and aggressive pruning is the dangerous
mistake.

## Where 100% accuracy is real, and where the claim would be dishonest

| Query class | Achievable | Verifiable without an LLM |
|---|---|---|
| Literal text occurrence | **100%** by construction | Yes — set equality vs a second scanner |
| Symbol definition | **~100%** for statically visible symbols | Yes — vs compiler/LSP |
| Structural pattern (`async fn returning Result`) | **~100% of parseable files** | Yes — vs a second AST query |
| Direct references / callers | 95–99% precision, **85–95% recall** | Partially |
| Conceptual ("where do we handle retries") | **HitFile 0.65–0.85**, span recall 0.15–0.4 | No |

A call graph is exhaustive only over *statically visible* code — PyCG measured
84.9% completeness on curated cases, and reflection, dynamic dispatch and DI
defeat it. A structural tool that reports "3 callers" as *the* callers is
therefore **worse than grep**, because it stops the agent looking. It must be
able to say "and N textual occurrences I could not resolve".

## Revised plan, in value-per-effort order

1. **Tool-call trace in the eval runner.** ✅ done — without it every claim below
   is unfalsifiable.
2. **Structural oracle suite.** Pin a repo snapshot, take ~200 symbols, generate
   ground truth from an independent authority (LSP references, or a second
   tree-sitter query), assert **exact set equality** in CI with no LLM. This is
   the only place a 100% claim is defensible, and it is free and deterministic.
3. **Split the tools by guarantee.** `find_symbol` / `find_references` /
   `search_structural` (exhaustive, and they say so) versus `search_code`
   (best-effort). The model routes for free, the routing is visible in the
   trace, and the "3 callers ≠ all callers" silent failure becomes impossible.
4. **tree-sitter via `web-tree-sitter`.** Measured here: zero native
   compilation, 1.64 s install, 703 files/s, lazy grammars ~1 ms each. It makes
   our 7,209-spurious-chunk class *structurally impossible* rather than patched,
   and yields scope paths free. Source grammars from `@vscode/tree-sitter-wasm`
   — the popular `tree-sitter-wasms` registry fails under current
   web-tree-sitter (ABI skew, upstream issue #5171). Budget ~24 MB of grammars
   and ~1 GB peak RSS; index in a child process that exits.
5. **Haystack eval tasks.** Current fixtures are 2–6 files, so retrieval is
   trivially solvable and *no* index change can move the score. Drop existing
   bugs into 300–1000-file workspaces and measure HitFile@first-edit,
   rounds-to-first-hit, and wasted reads from the trace.
6. **Graph-neighbourhood expansion.** BFS depth 1–2 over import/call/contains
   edges from top hits: **+13–20% Recall@20** in the closest published analogue
   (SpIDER). The best measured accuracy lever available.
7. **Recall-first loop discipline** — more rounds, span-level reads after a file
   hit, confidence-based stopping, union of decomposed narrow searches.
8. **Keep raw retriever scores.** RRF flattens margins (a perfect and a mediocre
   match both land near 1/60), so it cannot support abstention. Fuse only the
   fuzzy lanes; an exact symbol hit should pre-empt fusion, not be averaged into
   it. Upgrade to tuned convex-combination fusion once ~50–100 labelled queries
   exist (Bruch, TOIS 2023: beats RRF in and out of domain).
9. **Embeddings, last and opt-in.** They are genuinely ~3× better for
   natural-language→code (CoIR CodeSearchNet: BM25 26.75 vs dense 74.21) and no
   better than lexical for symbol lookup. Local via `@huggingface/transformers`
   costs **380 MB of node_modules** and ~25 min per 10M tokens; the API costs
   ~$2.66 for a 50k-file repo. Storage: `node:sqlite` + `sqlite-vec` (190 KB, no
   node-gyp) with binary vectors for the candidate pass (1.3 ms at 100k, 48
   B/vector) rescored against fp32. **Never `hnswlib-node`** — unconditional
   `node-gyp rebuild`, no prebuilds, unmaintained since 2024.

## Already in place

FTS5 ships inside Node's bundled SQLite, so BM25 is available with zero
dependencies. Our tokenizer already indexes identifiers **both whole and split**
(`getUserById` → `getuserbyid`, `get`, `user`, `by`, `id`), which is the
tokenization fix the literature values at up to +89% relative on code — the
single highest-ROI lexical change, and it is done.

---

# Final synthesis (four research passes)

## The binary was wrong — it is a three-way split

"Embeddings vs agentic search" is a false framing. The 2026 evidence supports:

| Architecture | Who | Effect |
|---|---|---|
| **Agentic lexical** (grep/read in a loop) | Claude Code, Cline, Zed, Continue.dev, Aider, Meta | **4–10×** over classical RAG in same-model comparisons |
| **Learned embeddings** | Cursor, Copilot, JetBrains Context | Real but **small**: Cursor's own online A/B is **+0.3% code retention** (+2.6% above 1,000 files) |
| **Precise structural indexes as tools** (LSP/SCIP/call graph) | Sourcegraph, Anthropic LSP plugins, Serena, Meta Glean | **The strongest 2026 result** |

## Structure is the biggest lever, and it is *cheaper*

Four independent groups, all 2026:

| System | Result |
|---|---|
| **SuperAGI** | Resolve **50.4 vs 41.9** (p=0.003); localisation acc@5 **84.5 vs 44.3**; **$2.30 vs $2.84 per solve** |
| **LARGER** | LocBench acc@5 **74.1 → 87.0** against Claude Code, **runtime halved** |
| **LocAgent** | File acc@5 **94.16** vs BM25 61.68 |
| **RepoGraph** | **+2.0–2.7 pp** resolve as a drop-in module across five host systems |

The mechanism is visible in SWE-Explore's numbers: **agentic search finds the right
files** (HitFile 0.667) **but not the right lines** (recall 0.154); **graph search
inverts that** (0.544 / 0.788). They are complementary on a different axis than
embeddings, which is why adding structure to a lexical agent compounds.

## Three findings that outrank retrieval entirely

1. **The tool interface matters more than the retriever.** SWE-agent ablations: removing
   search costs −2.3 pp, but a *badly designed* search interface costs **−6.0 pp — worse
   than having no search at all**. A 100-line window beats showing the whole file by
   5.3 pp. Context *discipline* beats context *volume*.
2. **Verification outranks localisation.** ORACLE-SWE ranks the value of perfect signals:
   **reproduction test ≫ edit location**. Agentless gained **+6.33 pp** from
   reproduction-test patch selection — larger than any localisation change in the paper.
   Even with oracle localisation, nothing exceeds 50% on Lite.
3. **Over-precise localisation slightly hurts.** Function-level localisation (45.6%)
   beats line-level (43.6%). Chasing span precision past the function boundary is
   negative work.

## Claims in circulation that are false

- **"Agentic search outperformed everything, by a lot"** — an embellishment. The actual
  quote is "we found agentic search out-performed RAG for the kinds of things people use
  Code for."
- **"Cursor dropped vectors"** — false. Cursor trained its own embedding model on agent
  session traces and shipped it in Nov 2025. Posts claiming otherwise cite each other.
- **"Cursor uses nomic-embed-text-v1.5, 768-dim"** — no vendor or reverse-engineered
  source exists. Treat as fabricated.

## The revised order

1. **A structural layer inside the loop** — symbol graph, definitions, references,
   neighbourhood expansion. Biggest measured gain, at *lower* cost per solve.
2. **Tool-interface discipline** — separate tools per guarantee, windowed reads,
   honest "N unresolved" reporting. Cheap, and the ablations say it dominates.
3. **A cheap repo map** — Aider's costs **~1k tokens** and milliseconds; Codebase-Memory
   indexes the Linux kernel in 3 minutes with ~1.2 s incremental updates.
4. **Verification loops** — reproduction tests before patch selection.
5. **Embeddings last**, opt-in, and expect a small win.

---

# The decisive evidence: two teams built embedding indexes and removed them

Source-verified against each repository's git history.

| | Built | Removed |
|---|---|---|
| **Continue.dev** | Full pipeline: SQLite chunks + FTS5 trigram/BM25 + LanceDB vectors + reranker, transformers.js MiniLM shipped in the VSIX | Un-defaulted **2025-06-30**, formally deprecated **2025-08-28**. Their `cn` CLI contains **zero vector code** — its `Search` tool is ripgrep. |
| **Zed** | `crates/semantic_index`: tree-sitter outline chunking, text-embedding-3-small, LMDB store, server-side embedding cache | Staff-gated **2024-10-23**, crate **deleted 2025-09-08** (−4,041 lines). The agent's 24 tools include no semantic search of any kind. |
| **Aider** | Never built one for code (embeddings are used only for `/help` over aider's own docs) | n/a — public position since 2023 |

Richard Feldman (Zed), the sharpest first-party rationale:

> "Model performance degrades with number of tokens used (even when well below
> the context window limit), and vector chunks are more prone to bloating the
> context window with unhelpful noise than more targeted search techniques.
> Claude Code doesn't do vector indexing, and neither does Zed."

Paul Gauthier (Aider):

> "Code has such a semantically useful structure that we should probably try and
> exploit that as much as possible before falling back to 'just search for stuff
> that seems similar'."

Two independent teams shipping a working index and then deleting it is stronger
evidence than any benchmark, because they paid the full cost of building it first.

## Aider is a third design point, and the most interesting one

It is neither embeddings nor agentic search: a **pre-computed, always-on,
token-budgeted structural summary injected into every request**, with relevance
steered by an implicit feedback loop — the model's own previous turns feed
`mentioned_idents` (×10 edge weight) and chat files (×50), so the map sharpens
toward whatever the conversation is about. tree-sitter tags → file-level
MultiDiGraph → personalised PageRank → budgeted render. 70.3% correct-file
identification on SWE-bench Lite, SOTA at the time.

Correction to a widely-repeated figure: the default budget is **not** 1024
tokens. Since v0.71.0 it is `clamp(context/8, 1024, 4096)` — so **4096** for any
modern model, and up to **8192** when no files are in the chat. Aider's own docs
still say 1k.

## What to copy, concretely

1. **A repo map.** Cheapest high-value structure available: milliseconds to
   build from mtime-cached tags, a few thousand tokens to carry.
2. **Tool descriptions that route.** Zed's tools actively steer the model —
   *"Prefer this tool to path search when searching for symbols"*. The SWE-agent
   ablation says a bad interface is worse than no search at all, so this is not
   cosmetic.
3. **Auto-outline instead of whole files.** Zed's `read_file` switches to a
   tree-sitter symbol outline above `AUTO_OUTLINE_SIZE = 16384` bytes rather
   than dumping the file. Directly attacks the noise problem Feldman names.
4. **Windowed reads.** 100-line windows beat whole files by 5.3 pp in ablation.

## Final position

Do not build an embedding index. Build the repo map, expose structure through
honestly-scoped tools, make the tool descriptions do the routing, and keep reads
windowed. That is the architecture the three teams who tried both converged on,
and it is also the cheapest.
