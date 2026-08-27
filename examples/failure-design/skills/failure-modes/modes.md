# The four modes

Reference for `/failure-modes`. Every dependency gets all four. Report what
*this* code does, at a `path:line`.

## 1. Down — connection refused, DNS failure, TLS failure

- How long before it is noticed — connect timeout, or the read timeout because
  no connect timeout was set?
- Is the error distinguishable from a timeout at the call site? They need
  different retry treatment: a connection refused never ran the work, a
  timeout may have.
- Does the failure surface, or become an empty result?
- If there is a health check, does it check this dependency or just the
  process?

## 2. Slow — responds, just past your patience

**Spend most of the review here.**

- What is the caller's timeout, and what is behind it: a connection pool, a
  thread pool, a semaphore, an event loop?
- Pool size × timeout = how long the whole pool can be held by this one
  dependency. Compute it and state it.
- What else uses that pool? Those requests fail too, and their failure has
  nothing to do with the slow dependency — this is how one degraded service
  becomes an outage.
- Is there a queue in front? How deep, and what happens when it is full —
  block, drop, or grow until memory runs out?
- Any concurrency limit into this dependency at all, or is it unbounded?
- Does a slow response still get retried? Retrying slow makes it slower.

## 3. Wrong — a success that is not

- Empty body, empty list, `null`, zero rows: can the code tell this from a
  legitimately empty result? **Usually not, and this is the most common silent
  outage.**
- Truncated or partial page treated as the whole set.
- Stale read from a cache or replica presented as current.
- A schema change: a field gone, a type changed, an enum value the code does
  not know. Is the parse strict or does it silently produce a default?
- An error the transport reports as success — a 200 with an error body, a gRPC
  OK with a failure field.

## 4. Partial — some of the work happened

- A batch where some items succeeded: is the result per-item, or one boolean?
- A write that landed and its event that did not — see `/consistency-check`.
- Pagination that failed part way: does the caller get four pages presented as
  seven, or an error?
- A multi-step operation interrupted between steps: what state is left, and
  does anything clean it up?
- A stream that ended early: distinguishable from a stream that ended?

## Language that hides the answer

| Avoid | Because | Write instead |
|---|---|---|
| "Handled" | Four different behaviours share the word | What the `catch` at `path:line` actually does |
| "Graceful degradation" | Names an intent, not a behaviour | What the caller receives, and what the user sees |
| "Exactly once" | Does not exist across a network | At-least-once with idempotent handling, or at-most-once with loss |
| "Should retry" | Assumes idempotency | `RETRY-SAFE` with the proof, or `RETRY-UNSAFE` with the check |
| "Fails fast" | Says nothing about what the caller gets | The error, and whether it is distinguishable from other errors |
| "Resilient" | Unfalsifiable | The mode it survives and the mode it does not |
| "p99 is fine" | Not a number you read | The dashboard, SLO or config, or `UNKNOWN` |

## Ranking

By user-visible consequence, not likelihood:

1. **Silent wrong answer** — nobody is paged, the data is bad
2. **Data loss or duplication** — irreversible or expensive to unwind
3. **Cascading failure** — unrelated traffic dies with it
4. **Visible error** — bad, and at least honest and observable
