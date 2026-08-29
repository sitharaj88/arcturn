---
name: rag-architecture
description: Design or fix a retrieval pipeline on the stack that is already there — chunking per format, hybrid retrieval, query-time ACLs, freshness, routing and caching, each with its cost named.
---

Design the retrieval architecture for `$ARGUMENTS`, in `$CWD`.

**Read the repository first, and extend what exists.** A vector store, a
search cluster, an embedding job, a model gateway — whichever of these is
already running is the one you build on. A second retrieval stack beside the
first is how an organization ends up with two systems that disagree about
what is true.

## Where production RAG actually breaks

Design against these, by name, because they are where the failures cluster:

**Chunking that shreds evidence.** Fixed-size splitting cuts tables in half
and separates a function from its signature. Chunk per format: heading-aware
for prose, row- or section-aware for tables, symbol-aware for code, and keep
the parent-document reference so a retrieved chunk can be expanded.

**No query-side stage at all.** The highest-leverage improvement after
chunking is query understanding: rewriting and expansion, and **multi-turn
condensation** — turning "what about the second one?" into a standalone query.
Multi-turn is the dominant production shape, and a retriever fed a raw
follow-up retrieves nothing useful. Decide explicitly whether a hypothetical
document embedding (HyDE) earns its extra call. Classify queries for
*retrieval strategy*, not only for cost.

**Lexical-free retrieval.** Pure vector search misses exact identifiers —
error codes, SKUs, function names — which is a large share of real queries.
Hybrid (BM25 + vector) with a reranker.

**A reranker nobody costed.** Name the **retrieve-k → rerank-n cascade**: the
k you retrieve before reranking decides recall *and* cost. A cross-encoder
spends one forward pass **per candidate**, which is normally the dominant p99
latency term — reranking 100 candidates is 100 passes. A cost model without
the reranker in it is not a cost model.

**Filters treated as free.** There is no universally right place to filter.
Pre-filtering a graph index is exactly where recall silently collapses — an
aggressive pre-filter returns far fewer than k, or degrades toward a scan.
State the strategy and its recall cost: pre-filter, post-filter with
over-fetch, or a partitioned index. For a high-selectivity entitlement filter
— a user entitled to a fraction of a percent of the corpus — name the
over-fetch multiplier or the partitioning scheme, and measure recall **for a
low-entitlement identity**, never only for an admin.

**Unnamed embedding and index parameters.** Name the embedding model, its
dimension, and its cost per million tokens — then check the chunk size against
**the embedder's own context window**, because a chunk longer than the window
is silently truncated at embed time and no metric attributes that correctly.
Name the index type and its knobs (HNSW `M` / `ef_construction` / `ef_search`,
IVF `nlist` / `nprobe`, or flat) and the recall those settings buy.
Approximate search is approximate, and ANN recall loss is a retrieval failure
like any other.

**Silent staleness.** An index that never learns about deletions keeps
answering from documents that no longer exist, confidently. Every source
needs update *and* deletion propagation, and a stated staleness bound you
could put in a runbook: "a deleted document is unretrievable within N
minutes." Cover **orphan chunks** too: re-chunking a document into fewer
pieces strands the old ones unless deletes are keyed by parent document id,
and a stranded chunk answers from a ghost while passing every document-level
freshness check.

**Re-embedding treated as a line item instead of a plan.** Two different
operations hide here. Incremental: content-hash change detection so unchanged
chunks are never re-embedded — the largest ongoing cost lever there is.
Wholesale: changing the embedding model or the chunking strategy requires a
**full re-index behind a dual-index cutover**, because vectors from two models
are not comparable and a mixed-vintage index returns confident garbage. It is
the most expensive and most commonly botched operation in RAG maintenance;
plan it before you need it.

**Permissions stripped at ingestion.** If entitlement is decided when a
document is embedded, every later change is invisible and every user shares
one view. Filter at query time, bound to the caller's identity. This is not a
feature to defer — it decides the whole query path.

**A cache that undoes the filter.** A semantic cache keyed on the query
embedding alone serves user B the answer computed from user A's entitled
documents — silently, and *past a correct filter*, because the filter ran
correctly on the miss path. The entitlement set (or its hash) belongs in the
cache key, or the cache is per-tenant. A cold-cache ACL test passes either
way, which is why this one has to be designed rather than tested into
existence.

**Cost concentrated in the boring queries.** The expensive pattern is a high
volume of simple queries routed to a frontier model. Classify queries, route
the cheap classes to cheap models, and put a semantic cache in front of the
near-duplicates. State the expected cost per query with the arithmetic, and
remember that true cost includes re-embedding on corpus churn and the eval
runs — a multiple of raw inference, not a rounding error.

**Long context instead of retrieval.** It looks simpler, and the trade is
real but moves fast: published comparisons have put a large-window call at
roughly two orders of magnitude more per query than a retrieval call, and
multi-fact recall measurably below single-fact needle-test performance — but
those are somebody else's numbers on somebody else's corpus, and the frontier
moves. **Cost both, on your own corpus, and put the arithmetic in the ADR.**
Do not let this bullet decide it; it only tells you not to skip the
comparison.

## What to produce

An ADR with: the query path (rewriting, condensation) · chunking per format ·
the embedding model and index parameters · retrieval, ranking and the
retrieve-k → rerank-n cascade · the entitlement path with its filtering
mechanism and recall cost · cache keying · freshness, deletion propagation and
orphan chunks · re-embedding, incremental and wholesale · cost *and latency*
arithmetic · the gates with thresholds and the command that measures each ·
rejected alternatives with reasons.

Name every place you chose boring over clever, and why that is a feature.
Anything you could not determine is UNKNOWN with the question a human answers
— never a plausible guess wearing the clothes of a decision.
