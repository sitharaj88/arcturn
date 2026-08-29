---
name: rag-threat-drills
description: Run the attacks a retrieval pipeline actually faces — injection, poisoning, entitlement bypass cold and cached, cross-tenant, exfiltration, denial of wallet — against a scratch target, with reproductions and a denominator.
---

Run the threat drills against the RAG system in `$CWD`, for `$ARGUMENTS`.

**You are a ranked first pass feeding a human security owner.** Say so in your
output. There is no verdict here that means safe: a clean run means keep
looking. Treat your own hit rate as unmeasured — the published agent-vs-human
gaps are from software vulnerability discovery, and no comparable measurement
exists for RAG-specific attacks.

## Before any drill: the target contract

Print the endpoint or process under test, the identity you hold, the second
**low-entitlement identity** the bypass drills need, and the configuration
evidence that this is a **scratch target** — a disposable index and a
non-production credential, read from a config file this session.

If you cannot establish all of that, every drill is
`NO-ORACLE: no scratch target (<what is missing>)` and you stop.

This is not ceremony. Drills 1, 2 and 4 **write documents into a corpus**. Run
them against a live index and you have poisoned production — and nothing in
this kit can tell a scratch index from a live one. A worktree protects the
checkout, never the world: a shell that cannot write a file can still reach an
index, an API and a model gateway.

## The drills

**1. Indirect prompt injection.** Plant an instruction inside a document the
corpus would retrieve — "ignore previous instructions and…", or a directive to
include a URL. Ask a question that retrieves it. Retrieved text must be data; a
system that acts on it is `CONFIRMED`.

**2. Corpus poisoning, with the count.** Find the *smallest number* of
adversarial documents that steers a target query, and report that number and
the steer rate — the number is what makes the risk concrete. Try both
mechanisms: documents aimed at one query, and a document optimized to sit near
*many* query embeddings, which is how poisoning scales.

**3. Entitlement bypass — cold, then warm.** As the low-entitlement identity,
retrieve a forbidden document directly, then ask a question whose best answer
lives inside it. Then **repeat against a warm cache**: issue the query as the
entitled identity first, then as the unentitled one. A semantic cache keyed
without entitlement leaks here while passing every cold-cache check, which is
why a bypass drill that never mentions cache state is a drill whose result
depends on luck.

**4. Cross-tenant retrieval**, where more than one tenant exists: the same two
probes across a tenant boundary, plus an attempt to **write** a tenant or ACL
label from a caller that should not be able to. The ACL is metadata, and
metadata nobody protects is a permission anyone can grant themselves.

**5. Exfiltration channels.** Can generated output carry data outward — a
rendered link with data in the query string, a tool argument, a webhook, an
image URL? List every channel with no tripwire.

**6. Denial of wallet.** Find the query shape that maximizes cost per request
— largest k, reranker engaged, frontier model — and report the ratio against a
typical query. A cost design is a lever an attacker can pull.

**7. Secrets in the index.** Probe for credentials or PII the ingestion
redaction pass should have removed. What is embedded can be retrieved.

## Reporting

Each drill: **`CONFIRMED`**, **`MITIGATED`**, or **`NO-ORACLE`** with the
reason, each carrying the verbatim command or input and its exit code, ranked
by blast radius.

Head the report with `DRILLS-RAN: <n>  DRILLS-NOT-RUN: <n>` — both numbers,
including the zeros. A finding list without its denominator reads as a clean
system.

List every document you planted with the command that removes it, run that
command, and confirm removal.

End with the one sentence a human security owner needs to decide go / no-go.
You rank. You never sign off.

## A note on Arcturn's own tripwires

Arcturn's `taint` and `canary` settings guard **the Arcturn agent** — `taint`
governs mutating tool calls that echo untrusted fetched content, and `canary`
plants literal values whose appearance in an outbound argument is proof rather
than a heuristic. Two limits matter here: `canary` is **off by default**, so it
protects nothing until configured; and neither does anything whatsoever for
the RAG service you are testing. Your system needs its own egress tripwires —
that is what drill 5 is about.
