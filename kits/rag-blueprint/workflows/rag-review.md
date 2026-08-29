---
name: rag-review
description: Audit a retrieval system that already exists — measure what it never measured, attack it the way production will, and hand a person a ranked fix list separating what blocks from what costs.
continueOnError: false
stepTimeoutMs: 1800000
budgetUsd: 20
---
Run it as `/workflow rag-review <where the RAG system lives, and what it is for>`.

Most teams do not need a retrieval system built; they have one that quietly
answers wrong, leaks what it should not, or costs more than anyone budgeted.
This pipeline audits what exists.

**It writes no production code, but it is not read-only.** Stage 3's
`rag-eval-author` holds `write` and `edit`, so it runs on the write lane and
the evaluation suite it builds is applied to your checkout with `git apply`
when its step succeeds. Every other step runs on the read or exec lane and can
change nothing in your tree. Under plan mode the run stops at stage 3, after
paying for the survey and the threat model.

**Stage 4 needs a scratch target** for the same reason `rag-setup` does: the
drills write documents into a corpus, and the role refuses with
`NO-ORACLE: no scratch target` rather than guess. See SCRATCH-CORPUS-ONLY in
the README.

1. @rag-surveyor Survey the system described below as it is actually built, from the code. Report which sources are indexed, how documents are chunked per format, whether retrieval is lexical, vector or hybrid and whether anything reranks, where and whether entitlement is enforced and at which stage, whether the cache is keyed with entitlement, how the index updates and whether deletions and orphaned chunks propagate, which models are called on which paths, and what evaluation or monitoring exists today. Tie every finding to the file that proves it, and mark what you could not determine as UNKNOWN with the question a human must answer. End with sources enumerated against sources confirmed. System: {{input}}
2. @rag-threat-modeler Threat-model the system as surveyed below — as built, not as intended. Per threat give vector, blast radius, whether the current code mitigates it with the file cited or NOT MITIGATED, and the drill that would prove it. Cover injection through retrieved content, poisoning by both mechanisms, entitlement leaks including ingestion-only filtering and a cache keyed without entitlement, cross-tenant retrieval and who may write the tenant label, exfiltration channels, denial of wallet, secrets in the index, and the evaluation set as an attack surface. Rank by blast radius and cite no identifier you did not read this session. Survey: {{prev}}
3. @rag-eval-author If the text below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise build the evaluation suite this system probably does not have — that absence is the finding to lead with. Build the labelled set in two parts: a human-validated core that is the only part allowed to block, and a generated remainder marked advisory, produced with a different model than the system under test uses. Include a multi-turn subset and pairs reachable only by a low-entitlement identity, and record a set version and build date. The harness computes per source and per format: recall@k, MRR, filtered recall for the low-entitlement identity, deletion-propagation time, cost per query split by routing class and cache hit, and latency p50 and p95 decomposed. A cell under thirty pairs reports NO-ORACLE: insufficient sample; every rate carries a confidence interval. Where the system has no ADR, state each threshold as a proposal for a human rather than a discovered fact. Leave one command with a real exit code, documented. You hold no shell: run nothing, report no metric value. Survey and threats: {{prev}}
4. Measure it and attack it, from fresh context — both branches hold `bash` with neither `write` nor `edit`, so both are on the exec lane, disjoint by construction, and neither can edit the suite it runs:
   - @rag-eval-runner Establish and print the target and both identities, or report every metric as NO-ORACLE: no target and stop. Run `git diff --stat` over the eval-set and threshold files first and emit ORG-HALT: oracle tampered with if anything changed in this run. Then run the suite's one command, paste it with its exit code, and report every metric with its threshold as PASS, FAIL or NO-ORACLE, both denominators, and faithfulness as ADVISORY only after hand-labelling a sample and printing your agreement rate. Change no threshold. Suite: {{prev}}
   - @rag-red-teamer Establish and print the target first — endpoint, your identity, the low-entitlement identity, and the configuration evidence that this is a scratch index with a non-production credential — and if you cannot, report every drill as NO-ORACLE: no scratch target and stop. Then run the drills the threat model ranked highest: planted injection, poisoning with the smallest steering count, entitlement bypass cold and against a warm cache, cross-tenant probes where tenancy exists, exfiltration channels, denial of wallet, and secrets in the index. Report each as CONFIRMED, MITIGATED or NO-ORACLE with its reproduction and exit code, head the report with DRILLS-RAN and DRILLS-NOT-RUN, and remove every planted document confirming removal. Threats: {{prev}}
5. @rag-lead Turn the audit below into a fix list a team can act on this quarter. Re-emit any ORG-HALT line verbatim as your first line and stop. Otherwise rank every finding by blast radius or user-visible wrongness against implementation cost, and for each give the specific change, the file or component it lands in, and the measurement that will show it worked. Separate BLOCKING — leaked documents, unpatched injection paths, a cache serving across entitlements — from HIGH — wrong answers, stale indexes, orphaned chunks, filtered-recall collapse — from COST, quoting the measured cost per query and the routing or caching change that would reduce it, with no arithmetic you did not read in the inputs. Carry both denominators and every NO-ORACLE through; a gate that did not run never becomes a pass. End with the three changes that buy the most and one line beginning DECISION-REQUEST for the human. Propose; implement nothing. Audit: {{prev}}
