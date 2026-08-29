---
name: rag-eval-suite
description: Build the suite that gates a retrieval system — a labelled set that is not leaked, metrics per source and format with a sample floor, latency and cost, a baseline — and one command with a real exit code.
---

Build the evaluation suite for the RAG system in `$CWD`, for `$ARGUMENTS`.

**The gate you are replacing is somebody trying six prompts and saying it feels
good.** That gate cannot catch a chunking regression in one format, an index
that stopped updating, a filter that collapsed recall for everyone except
admins, or a prompt change that doubled cost. Evals are the unit tests of this
system: they live in the repository, run in CI, and fail loudly.

## The labelled set, and why most of them are broken

Generating questions from the same chunks the retriever will return produces
questions shaped like their answers. Recall measured on those scores the
question generator, not the retriever — inflated in exactly the direction that
makes a team ship. A leaked golden set that blocks shipping is worse than no
gate, because it is signable.

So the set has two parts, and the suite prints which is which:

- **A human-validated core.** The only part allowed to block. A person
  confirmed each pair.
- **A generated remainder**, advisory, produced with **a different model** than
  the system under test uses to answer.

Include, deliberately:
- a **multi-turn subset**, because a single-turn set cannot see condensation break;
- pairs reachable only by a **low-entitlement identity**, because filtered
  recall is where entitlement designs quietly fail and an admin-only average
  hides it;
- **table-heavy and code-heavy** pairs, because that is where chunking fails.

Record a **set version and build date** in the file. A recall number without
the set version that produced it is not comparable to anything, including its
own history.

**Leakage check:** if generated-question recall greatly exceeds
human-question recall, that gap is a finding about the set, not a pass.

## The measurements

1. **Retrieval** — recall@k and MRR, per source *and* per format.
2. **Filtered retrieval** — the same, for the low-entitlement identity.
3. **Freshness** — delete a document, measure the time until it stops being
   retrievable, against the architecture's stated bound. Include an
   **orphan-chunk** case: re-chunk a document into fewer pieces and check the
   strays are gone.
4. **Cost per query** — split by routing class and cache hit/miss, compared
   against the ADR's predicted arithmetic, flagging drift.
5. **Latency** — p50/p95/p99 end to end, decomposed into retrieve, rerank and
   generate, cold and warm cache, against the surveyed target. A suite that
   gates cost and not latency ships a system that hits its budget at nine
   seconds a query.
6. **Faithfulness** — **advisory, never blocking.** It is a model judging a
   model. Hand-label a sample first and publish the judge's agreement rate
   against your labels; an unmeasured judge annotates, and an annotation is not
   a gate.

## Sample floor, baseline, drift

**A cell under 30 pairs reports `NO-ORACLE: insufficient sample (n=<k>)`, not
a rate.** Four sources times three formats is twelve cells; fifty pairs across
them is four per cell, and a percentage over four pairs is noise with a decimal
point. Report a confidence interval next to every rate.

**Record a baseline.** A threshold catches a floor breach; only a run-to-run
delta catches a twelve-point regression that lands above the floor — which is
exactly what a chunking regression in one format looks like.

**Re-validate on a schedule.** Corpora change: a pair whose labelled document
no longer exists is an invalid pair, not a miss, and a set built in March rots
by September without anyone touching it.

## Make it a gate, not a report

One command, **exiting non-zero when a blocking threshold is breached**,
documented in the repository and wired into CI. A suite a human must remember
to run is a report.

Split the writing from the running if you can: the role that authors the set
and the thresholds should not be the role that runs the suite and reports PASS.

## Honesty rules

Report every number against its threshold as PASS, FAIL, or `NO-ORACLE` with
the reason — never a silent skip, and never a threshold quietly lowered to make
the suite green. A threshold that had to move is a finding for a human, stated
as one, with the number it would have to become. Print both denominators: cells
measured against cells defined, pairs used against pairs in the set.
