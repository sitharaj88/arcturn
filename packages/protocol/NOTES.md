# Notes — @arcturn/protocol

Implementation notes and places where this package worked around gaps in the
frozen `@arcturn/types` contracts rather than editing them.

## No `ProtocolError` type in `@arcturn/types`

`protocol.ts` documents that `@arcturn/protocol` "implements framing/validation"
but exports no type for a framing-level decode failure — reasonably, since
NDJSON framing is entirely a concern of this package, not the shared contracts.

`FrameDecoder.feed()` must never throw on malformed input (spec: "malformed
JSON on a line → emitted as a ProtocolError value (not a throw), stream keeps
going"), so `src/framing.ts` defines a local `ProtocolError` interface, tagged
with a `__kind: "protocolError"` sentinel and a `code: "malformedJson" |
"lineTooLong"` discriminant, plus a matching `isProtocolError()` type guard.
Consumers (e.g. `@arcturn/server`) narrow `feed()`'s `unknown[]` results with
`isProtocolError()` before treating a value as a parsed frame — this also
correctly handles the edge case where a legitimately parsed JSON value is
itself `null` or a primitive, which would otherwise be ambiguous with "no
frame yet".

## `ServerMessage`'s "response" variant has no discriminant beyond key presence

```ts
export type ServerMessage =
  | { kind: "response"; id: string; result: unknown }
  | { kind: "response"; id: string; error: { code: string; message: string } }
  | ...
```

Both arms share `kind: "response"`; TypeScript disambiguates structurally, but
at runtime the only signal is which of `result`/`error` is present as an own
key. `validateServerMessage()` uses `Object.hasOwn` to detect exactly one of
the two being present (an object with both, or neither, is rejected as
invalid) rather than guessing from `typeof`. Because `result: unknown`
legitimately includes `undefined`/`null`, presence-of-key is the only correct
test — `value.result !== undefined` would wrongly reject a response whose
result actually is `undefined`.

## `AgentEvent` is shallow-validated by design

Per the task brief, `validateServerMessage` only checks that an `event`
message's `event` field is `{ type: string, ...}` — it does not validate any
of `AgentEvent`'s ~20 variants deeply. This is intentional: `AgentEvent` is
defined in `@arcturn/core`'s domain (events.ts) and evolves independently;
deep validation here would duplicate and drift from that contract. If a
caller needs stronger guarantees on a specific event's shape, that's a
`@arcturn/core`/`@arcturn/server` concern, not this wire layer's.

## Nested-shape validators exported beyond the two-function contract

The brief specifies `validateClientRequest` and `validateServerMessage` as
the two entry points. `permissionDecision` params embed a `PermissionDecision`
(which embeds an optional `PermissionRule`), and the `sessions` message embeds
`SessionHeader[]`. Rather than inlining that logic, `src/validate.ts` factors
it into `validatePermissionRule`, `validatePermissionDecision`, and
`validateSessionHeader`, and exports all three from `src/index.ts` — they're
independently useful (e.g. a server validating a persisted rule file) and
keep the two main functions readable.

## Line-length guard checks both "already-terminated" and "still-buffering" lines

An earlier version of `FrameDecoder` only checked the trailing not-yet-newline-
terminated buffer against `maxLineLength`, which meant a single `feed()` call
containing one very long but *fully newline-terminated* line slipped through
uninspected (found and JSON.parsed via the normal per-line loop before the
trailing-buffer check ever ran). Fixed by checking each line's UTF-8 byte
length (via `Buffer.byteLength`) at the point it's extracted from the buffer,
in addition to the trailing-buffer check that guards against unbounded memory
growth while waiting for a terminator that may never arrive. Caught by a unit
test (`framing.test.ts` "errors an overlong frame and resyncs at the next
newline") during self-review, not by any ambiguity in the spec.

## `tsc` also emits colocated `*.test.ts` files into `dist/`

`packages/protocol/tsconfig.json` (pre-existing, out of this package's
editable scope per the task's RULES: only `src/`, colocated `*.test.ts`, and
this file) has `"include": ["src"]` with no test-file exclusion, so
`pnpm --filter @arcturn/protocol build` compiles `*.test.js`/`.d.ts` into
`dist/` alongside the real sources. `package.json`'s `"files": ["dist"]`
would therefore include compiled test output in a published package. Not
fixed here since it requires editing `tsconfig.json`/`package.json`, both
outside this package's allowed edit surface per the task brief; flagging for
whoever owns the scaffold to add `"exclude": ["src/**/*.test.ts"]`.

## Request id format

`nextRequestId()` / `RequestIdGenerator` produce ids of the form
`${randomPrefix}-${monotonicCounter.toString(36)}`, e.g. `a1b2c3d4-1a`. The
random prefix (`crypto.randomUUID().slice(0, 8)`, always available on Node
≥ 20's `globalThis.crypto`) gives collision resistance across independent
processes/generators; the base-36 monotonic counter guarantees uniqueness and
generation order within one generator without depending on timer resolution.
No requirement in `@arcturn/types` pins an id format — `ClientRequest.id`
is just `string` — so this is a free implementation choice, documented here
for anyone building a second client-side id generator that needs to avoid
colliding with this one (in practice: just use this one, or your own
`RequestIdGenerator` instance).
