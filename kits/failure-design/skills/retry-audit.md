---
name: retry-audit
description: Find every retry in this tree and report whether the operation underneath it is safe to run twice. An unproven retry over a write is reported as a live bug.
---

Find every retry in `$ARGUMENTS` (or the whole tree) and answer, for each one,
the question it silently assumes: **is the thing underneath safe to run twice?**

**Why this is the first audit worth running.** "Add a retry" is the most common
resilience change in software and, over a non-idempotent write, it is a
duplicate-charge, duplicate-order, duplicate-email bug. It fires only when the
first attempt succeeded and the response was lost — a timeout — which is
precisely the case that has no fixture. The retry looks like hardening in
review and behaves like a defect in production.

## Find them all

Retries hide at more layers than people remember. Search for each:

- Explicit loops and libraries — `retry`, `backoff`, `p-retry`, `tenacity`,
  `resilience4j`, `Polly`, `spring-retry`
- HTTP client configuration — `maxRetries`, `retryPolicy`, `retry_on`
- **The layers nobody counts**: a service mesh or sidecar retry policy, an API
  gateway or load balancer retry, an SDK's built-in retry (AWS and GCP clients
  retry by default), a message broker's redelivery, a job runner's
  `attempts:`, and the caller's own loop
- Framework defaults that are on unless switched off

**Multiply them.** Client 3 × gateway 3 × mesh 3 is twenty-seven attempts at a
dependency that is already failing, and that is a retry storm the reader is
aiming at themselves. Report the product, not the individual counts.

## Then classify what is underneath

For each retry, name the operation and classify it:

- **Read** — safe, note it and move on.
- **Write, idempotency proven** — cite what proves it: a unique constraint the
  database enforces, an idempotency key the *server* honours, a conditional
  write with an expected version, an upsert on a natural key. Point at the
  line.
- **Write, idempotency unproven** — `RETRY-UNSAFE`. Say what would double: the
  row, the message, the charge, the email. Name the check that would settle
  it, and note that `/mutation-probe`-style evidence is what settles it, not
  another reading.

**An idempotency key in the request is not proof.** It is only worth something
if the receiver enforces uniqueness on it and the check-then-write is atomic.
A key generated per *attempt* rather than per *logical operation* is not an
idempotency key at all — it is a random number, and it is a common bug.

## Also report

- **A retry with no timeout** — nothing bounds the total wait; the retry
  multiplies an unbounded one.
- **Retrying a timeout specifically** — the case where the work may already
  have committed. A policy that retries connection errors only is meaningfully
  safer than one that retries anything.
- **Retrying 4xx** — a client error retried is a client error repeated.
- **No jitter** — synchronised retries from many callers arrive as a
  thundering herd exactly when the dependency is weakest.

## Report

A table: retry site `path:line`, effective attempt count including every layer,
the operation, the classification, and what doubles if it is unsafe.

Rank `RETRY-UNSAFE` over writes first — each is a live bug, not a
recommendation.

End with `RETRIES: <n> / UNSAFE: <n> / UNPROVEN: <n>` and the searches you ran,
so recall can be judged rather than trusted.

Scope: $ARGUMENTS
