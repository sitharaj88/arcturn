---
name: failure-review
description: Map what a service depends on, prove which of its writes are safe to retry, work every dependency through four failure modes, then record it — with retry safety gated on a run rather than a reading.
continueOnError: false
budgetUsd: 28
stepTimeoutMs: 2400000
---
Run it as `/workflow failure-review <the service, module or design to review>`.

The pipeline exists because of one asymmetry: the advice "add a retry" is
cheap, reads as hardening, and is a duplicate-effect bug whenever the operation
underneath it is not idempotent — a condition that only fires on a timeout,
which is the case nobody has a fixture for. So retry safety is decided by a
run, in stage 2, and no later stage may soften that verdict.

Stage 1 is read-lane and alone, because everything after it reasons over its
map. A dependency it misses is a dependency nobody reviews, which is why it
ends with an explicit `UNMAPPED` block rather than a tidy table.

Stage 2's two branches are disjoint by question and by lane. The oracle holds
`bash` with neither `write` nor `edit` — it drives operations twice in its own
worktree and cannot land anything. The critic holds no mutating tool at all
and reads. One establishes what is safe to retry; the other establishes what
happens when things degrade. Neither can do the other's job and neither can
change the tree.

Stage 3 is a person. Timeouts, breakers and retry policy are decisions about
what users see during an outage, and the trade — a slow success becoming a
fast error — is a product decision wearing engineering clothes.

Stage 4 is the only write-lane step, so the run fails immediately under plan
mode rather than after three stages it could not save.

1. @dependency-cartographer Map every call this target makes to something it does not control — outbound HTTP and gRPC, database, cache, queue publish and consume, object storage, DNS, subprocess, auth provider, feature flags, and any metrics or logging sink that can block. For each: the timeout with its path:line or NO TIMEOUT and never the library default, the retry count and backoff and what it retries on, the fallback the caller actually takes with an empty-result-on-failure called out as the silent case it is, and the blast radius upstream. Then flag retries with no timeout, caller timeouts shorter than the sum of a callee's retries, retries stacked at more than one layer, shared pools, and unbounded concurrency. End with MAPPED and an UNMAPPED block naming every call site you could not resolve and what would resolve it. Target: {{input}}
2. Two questions over the map below, neither able to write:
   - @idempotency-oracle If the map below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise take every operation that mutates something and that the map shows carrying a retry, and decide whether running it twice leaves the world as it was. Find a seam you can drive — a test, a fixture, a stub server, an in-memory adapter — and say which. Capture the observable effect of one run concretely as a count, a dump or a checksum, run it again with identical input as a retry would, and compare. Then do the timeout case, which is the one that matters: complete the operation and retry as though the response was lost. Report PROVEN-IDEMPOTENT, NOT-IDEMPOTENT or NO-ORACLE with both observations pasted, and never "should be idempotent" — an idempotency key in the source is a claim, worth something only if the store enforces uniqueness and the check-then-write is atomic, and both of those you can run. Map: {{prev}}
   - @failure-critic If the map below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise work every mapped dependency through four modes: down, slow, wrong and partial. Spend the most on slow, because a dependency answering just past the caller's patience exhausts a connection pool and takes down requests that never touched it, having never returned an error. For wrong, ask whether the code can tell an empty result from a failure. For partial, name where a write landed and its event did not. Recommend no retry for an operation whose idempotency is unproven — write RETRY-UNSAFE and the check that would settle it. Recommend no circuit breaker without saying what the caller returns while it is open. Claim no exactly-once, invent no latency or capacity number, and never write "handled" where you can write what actually happens at a path:line. End with RETRY-UNSAFE and SILENT lists. Map: {{prev}} Target: {{input}}
3. @dependency-cartographer Mode GATE. If either report below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise assemble the packet: keep anything the oracle ran strictly above anything the critic read, list every NOT-IDEMPOTENT operation that currently carries a retry as the top section because each one is a live duplicate-effect bug, then the SILENT paths, then the timeout and pool findings. Print counts for PROVEN-IDEMPOTENT, NOT-IDEMPOTENT, NO-ORACLE, RETRY-UNSAFE and SILENT including the zeros, and carry every UNMAPPED line forward verbatim. Then, only if the evidence genuinely leaves it open, emit exactly one ORG-ASK line carrying the whole question with its options and their costs on that single line — the question worth asking is usually what users should see while a breaker is open, since that is a product decision the engine cannot make. If the evidence settles it, say so and stop rather than pausing for the sake of a gate. Target: {{input}} Reports: {{prev}}
4. @resilience-author Write the failure-mode record. Re-read the files the reports cite and confirm each line before recording it. Split everything into Established, carrying its path:line or the stage whose command produced it, and Assumed — unconfirmed, carrying the check that would settle it. Record a retry as safe only where the oracle proved the operation idempotent, and carry that proof inline — the seam, both observations, and whether the timeout case was covered; everywhere else write RETRY-UNSAFE — unproven and name the check, never "likely safe". Carry the RETRY-UNSAFE and SILENT lists through verbatim rather than summarising them. For every proposal name the failure it prevents with the path:line of the gap and what it costs, because a breaker changes what callers see and a shorter timeout turns slow successes into errors. You have no shell, so cite measured numbers to the stage that measured them. Write one file into the repository's architecture or docs directory or docs/failure-modes.md, end with the path and the count of lines under each register. Decision: {{prev}} Run: {{journal}}
