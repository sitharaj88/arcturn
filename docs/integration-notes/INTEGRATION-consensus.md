# Integrating consensus / divergence detection

`packages/ai/src/consensus.ts` adds `createConsensusClient` — an `LLMClient`
that runs the *same turn* on 2–3 models and reports their **disagreement** as an
uncertainty signal.

The premise: asking a model "are you sure?" is close to worthless, because the
same weights that produced the answer produce the confidence report. Running the
turn on independently trained models is not. Where they agree, proceed; where
they diverge — above all where they choose **different tool calls** — is exactly
where a human should look. Multi-provider support is universally treated as
redundancy (failover). This treats it as *epistemics*.

Nothing existing was modified. Shipping this needs one export line in
`packages/ai/src/index.ts`, one config key, and ~20 lines in the CLI runtime.

## Public surface (already implemented)

```ts
export type ConsensusLink = LLMClient | { client: LLMClient; model?: ModelSpec };
export type AgreementLevel = "full" | "partial" | "divergent";

export interface ConsensusVerdict {
  agreement: AgreementLevel;
  toolCallsMatch: boolean;   // highest-signal field
  textSimilarity: number;    // 0..1, worst case across the panel
  details: string[];         // empty === indistinguishable
  models: string[];          // primary first, includes unavailable members
}

export interface MessageDivergence {
  toolCallsDiffer: boolean;
  textSimilarity: number;
  stopReasonDiffers: boolean;
  details: string[];
}

export interface ConsensusOptions {
  onVerdict?: (verdict: ConsensusVerdict) => void;
  similarityThreshold?: number;  // default DEFAULT_SIMILARITY_THRESHOLD = 0.6
  sampleRate?: number;           // 0..1, default 1
  random?: () => number;         // injectable for deterministic tests
}

export function createConsensusClient(links, options?): LLMClient;
export function streamConsensus(links, request, options?): AsyncIterable<StreamEvent>;
export function compareMessages(a: AssistantMessage, b: AssistantMessage): MessageDivergence;
export function canonicalJson(value: unknown): string;
export function normalizeText(text: string): string;
export function textSimilarity(a: string, b: string): number;
export function formatVerdict(verdict: ConsensusVerdict): string;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
export const COMPARABLE_STOP_REASONS: readonly StopReason[];
```

Add to `packages/ai/src/index.ts` (alphabetically, between the `cost` and
`errors` blocks):

```ts
export {
  type AgreementLevel,
  canonicalJson,
  compareMessages,
  COMPARABLE_STOP_REASONS,
  type ConsensusLink,
  type ConsensusOptions,
  type ConsensusVerdict,
  createConsensusClient,
  DEFAULT_SIMILARITY_THRESHOLD,
  formatVerdict,
  type MessageDivergence,
  normalizeText,
  streamConsensus,
  textSimilarity,
} from "./consensus.js";
```

## Two design decisions to preserve

### 1. The primary streams verbatim; the verdict is advisory, out-of-band

`links[0]` is the primary. Its `StreamEvent` objects are re-yielded **by
identity** — no copy, no rewrite, no added latency to the first token. The
secondaries run concurrently, buffered to completion, and the verdict is handed
to `options.onVerdict` *after* the primary's stream ends, possibly after the
consumer's `for await` loop has already finished.

Gating the turn on agreement was rejected deliberately: it would hold every
token until the slowest model finished, turning a fast turn slow, and would make
the harness's behaviour depend on a heuristic text-similarity score. Consensus
says "look here", not "this is wrong". A host that wants a gate (e.g. pause
before executing a tool call when `agreement === "divergent"`) can build one on
top — that policy belongs to the caller.

A secondary that errors, throws, or hangs can therefore never break the turn: it
is recorded as `unavailable (<reason>)` in `details` and the primary's stream is
untouched. Abandoning the primary's stream aborts the secondaries so a cancelled
turn stops billing; the caller's `request.signal` is forwarded to them too.

**No verdict at all** is produced when: the panel was sampled out, there are no
secondaries, no `onVerdict` was given, the consumer bailed early, or the primary
itself errored/aborted. *Absence of a verdict is not agreement* — the UI must not
render "models agree" by default.

### 2. Comparison happens on the final assembled message

Diffing 2–3 live token streams against each other is intractable; models phrase
the same answer at different speeds and in different orders. So `compareMessages`
runs once, on the assembled `AssistantMessage` — the artefact the rest of the
harness actually acts on. Assembly reuses `completeFromStream` from
`packages/ai/src/internal/stream.ts`; nothing is re-implemented.

## The comparison heuristics

Three axes, descending order of signal:

1. **Tool calls (the point of the whole thing).** Same names, in the same order,
   with the same arguments? Arguments are compared as **canonical JSON**
   (recursively key-sorted, array order preserved), so `{"path":"a","limit":10}`
   and `{"limit":10,"path":"a"}` are the same call — key order is a provider
   serialisation artefact. Provider-assigned call **ids are ignored**; they never
   match across providers. A differing tool call means the models chose different
   *actions*, which no amount of similar prose makes safe, so it forces
   `"divergent"` on its own.
2. **Text.** Jaccard overlap of the lowercased, whitespace-collapsed word sets.
   Deliberately *not* semantic: an embedding model or an LLM judge would score
   paraphrase better but would add a network call, a cost, and a second opaque
   judgement to the very pipeline whose opacity this exists to reduce. Word
   overlap is transparent, free, and deterministic. Known limits, accepted: word
   order is ignored, and short texts are high-variance. Thinking blocks are
   excluded — reasoning traces are provider-shaped and often absent on one side,
   so comparing them is noise.
3. **Stop reason.** One model ending its turn while the other hit `maxTokens` is
   worth knowing even when the visible prefixes match.

Verdict rules (threshold injectable, default `0.6`):

| Condition | `agreement` |
| --- | --- |
| tool calls identical **and** similarity ≥ threshold | `"full"` |
| tool calls identical, similarity < threshold | `"partial"` |
| any secondary's tool calls differ | `"divergent"` |
| no secondary produced a comparable message | `"partial"`, details note it is unconfirmed |

Across a 3-model panel the **worst** case wins (lowest similarity, any
divergence): one dissenter is the signal, and averaging it away with an agreeing
model hides exactly what this exists to find.

## Cost: this multiplies token spend by N — state it, don't bury it

A 3-model panel bills roughly 3× the input *and* output tokens of a normal turn,
every turn. Mitigations built in:

- **`sampleRate`** (0..1, default 1) runs the panel on a fraction of turns.
  `0.1` ≈ one turn in ten — the cost knob to reach for first.
- Secondaries are **skipped entirely** when no `onVerdict` is supplied: a verdict
  nobody reads is not worth paying for.
- Only the *primary's* usage flows through the stream's `usage` events, so
  `runtime.ts`'s existing cost accounting (`#onEvent`, which prices from the
  answering model captured off the `start` event) **under-counts** a consensus
  session. This interacts with `config.maxCostUsd` / the cost guard: the ceiling
  will be reached later than real spend suggests. Either surface panel spend
  separately or document the gap — do not silently ignore it.

## Config key

```jsonc
{
  "model": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],  // failover chain (unchanged)
  "consensus": {
    // Cross-check models, primary first. The primary should normally be the
    // head of "model"; if omitted it is prepended automatically.
    "models": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "google/gemini-2.0-flash"],
    "sampleRate": 0.2,          // optional, default 1 — 1 in 5 turns at 3x cost
    "similarityThreshold": 0.6  // optional
  }
}
```

`consensus.models` with fewer than two entries is a no-op (and should warn).

### The five places `packages/cli/src/config.ts` must change

Mirror how `route` (a nested object) is already handled — it is the closest
template:

1. **`ArcturnConfig`** (lines 42–78): add `consensus?: ConsensusConfig;` with a
   TSDoc comment naming the N× cost.
2. **`DEFAULT_CONFIG`** (lines 102–114): leave it absent — off by default. An
   opt-in feature that triples spend must never be on by default.
3. **`KNOWN_KEYS`** (lines 118–134): add `"consensus"`, or the loader drops it
   with `unknown config key "consensus" (ignored)` (line 214).
4. **`parseConfigFile`** (lines 202–354): validate like the `route` block
   (lines 299–312) — `models` an array of non-empty strings, `sampleRate` a
   finite number clamped to 0..1, `similarityThreshold` a finite number in 0..1.
   Warn and drop rather than throw: a stale model id must never stop arcturn from
   starting.
5. **`mergeConfig`** (lines 362–390): use the optional-key conditional-spread
   idiom at lines 374–377 — the whole object replaces, it does not deep-merge.

A local `ConsensusConfig` interface belongs in `config.ts` (or next to
`RouterConfig` in `packages/cli/src/router.ts`, which documents the same
"caller injects `resolve`, a bad id must not stop startup" posture).

## Runtime wiring (`packages/cli/src/runtime.ts`)

The failover chain is built in `buildRuntime` at **lines 993–1026**. Consensus
goes immediately after it, wrapping the result:

```ts
import { createConsensusClient, formatVerdict } from "@arcturn/ai";

// ... existing lines 993-1026 produce `llm` (base client or failover chain) ...

const consensus = config.consensus;
const consensusSpecs =
  consensus && consensus.models.length > 1
    ? consensus.models.map((id) => resolveModelSpec(id, env))
    : [];

const llmWithConsensus =
  consensusSpecs.length > 1
    ? createConsensusClient(
        // The primary link is the failover chain built above, so a down
        // provider degrades the *primary* instead of breaking the panel.
        [
          { client: llm, model: consensusSpecs[0] },
          ...consensusSpecs.slice(1).map((spec) => ({ client: baseClient, model: spec })),
        ],
        {
          sampleRate: consensus?.sampleRate,
          similarityThreshold: consensus?.similarityThreshold,
          onVerdict: (verdict) => {
            if (verdict.agreement === "full") return;      // silence is the reward for agreeing
            const level = verdict.agreement === "divergent" ? "warn" : "info";
            runtimeRef?.notify(level, `consensus ${formatVerdict(verdict)}`);
          },
        },
      )
    : llm;
```

Then pass `llmWithConsensus` where `llm` is passed today into `ArcturnRuntimeInit`
(interface lines 315–343, field `llm: LLMClient` line 321).

Notes:

- **They compose, in this order.** `consensus(failover(retry(dispatch)))`.
  Each consensus link may itself be a failover chain — `ConsensusLink` is
  structurally identical to `FailoverLink` for exactly this reason. Wrapping the
  other way (`failover(consensus(...))`) would be wrong: failover would then
  restart the whole panel on a transient error in one member.
- `runtimeRef` (declared `let runtimeRef: ArcturnRuntime | undefined` at **line
  1034**, *after* the closure that reads it) is the same forward-declared slot
  `onFailover` already uses at line 1021. Verdicts always arrive mid-session, so
  `runtimeRef.notify` is the only channel that reaches the user — the startup
  `warnings[]` array is drained once and never read again.
- `model` stays `modelSpecs[0]`: `compactionOptionsFor(model)` (line 290) and the
  context-window budget must track the primary, not the panel.
- `resolveModelSpec` (lines 185–205) throws `ModelResolutionError` for an unknown
  id or missing API key, so a bad panel member fails fast at startup — consistent
  with how the failover chain behaves. If you would rather degrade than fail,
  catch per-id and push a startup warning instead.
- Members share the one cached `baseClient`, so N models means N requests, not N
  connections (`createClient` caches per `provider|baseUrl|apiKey`).

## Surfacing a verdict

### TUI — live notice + status-bar hint

Reuse the existing `notice` channel; **no type change needed**.
`ArcturnRuntime.notify(level, text)` (**runtime.ts:827–845**) fans
`{ type: "notice", level, text }` (`packages/types/src/events.ts:40–41`) out to
every subscriber, and `TranscriptFormatter#notice`
(`packages/cli/src/display.ts:560–572`) renders it with the `warn`/`info` glyph
and style. Map:

| `agreement` | notice |
| --- | --- |
| `"full"` | none — do not train the reader to ignore the channel |
| `"partial"` | `info`: `consensus partial: openai/gpt-4o: text similarity 0.41` |
| `"divergent"` | `warn`: `consensus divergent: openai/gpt-4o: tool call 0: name differs (read vs write)` |

`formatVerdict(verdict)` produces exactly those one-liners. For multi-line
detail, `display.ts` already splits on `\n` and indents continuations, so
`verdict.details.join("\n")` renders as an indented list under the glyph.

Because the verdict lands *after* the turn's events, the notice appears just
below the assistant message it refers to — which reads correctly ("that answer
was contested") and needs no reordering.

**Status bar** (`packages/cli/src/interactive/app.ts`, `StatusBar` field line 89,
segments set at lines 332–334, separator `" · "`): add one persistent segment so
the user knows the panel is on and what it last said, e.g. `⚖ 3-model` in the
normal style, switching to the warning style with a count after a divergence:
`⚖ 3-model · 2 diverged`. The rule of thumb: the status bar carries *state*
(consensus is enabled, N divergences this session); `notify` carries *events*
(this turn diverged, here is how).

### `--print` — a JSON event

`packages/cli/src/print.ts:92–101` subscribes to the runtime and emits
`JSON.stringify(event)` NDJSON for every `AgentEvent` when
`--output-format json`. Two options:

- **Zero-change path:** verdicts already ride the `notice` event, so they appear
  as `{"type":"notice","level":"warn","text":"consensus divergent: …"}` with no
  type change at all. Note `print.ts` deliberately does not duplicate notices to
  stderr in json mode, and drops `info` notices in text mode — so a `"partial"`
  verdict is invisible in `--print` text mode. Acceptable; `warn` still shows.
- **Structured path (recommended for machine consumers):** add one arm to the
  `AgentEvent` union in `packages/types/src/events.ts` (line 14 — described there
  as "the single source of truth consumed by TUI, server, and SDK"):

  ```ts
  | { type: "consensus"; agreement: AgreementLevel; toolCallsMatch: boolean;
      textSimilarity: number; details: string[]; models: string[] }
  ```

  which is `ConsensusVerdict` verbatim plus a tag. Emit it from the `onVerdict`
  hook alongside (or instead of) the notice, and add a `case "consensus"` to
  `TranscriptFormatter.format` (`display.ts:203+`). It then flows into
  `--print --output-format json`, the TUI, the WS server, and the SDK for free.
  A CI job can then grep for `"agreement":"divergent"` and fail the run — the
  gate the client itself refuses to be.

  Emit it *unconditionally* (including `"full"`) on this path: machine consumers
  want the negative result too, and the display layer decides what to show.

## Test coverage

`packages/ai/src/consensus.test.ts` — **40 tests, all passing.**

- `canonicalJson`: recursive key sorting; array order preserved; `null`,
  `undefined` properties, `NaN`.
- `textSimilarity`: identical → 1, disjoint → 0, both-empty → 1, one-empty → 0,
  partial overlap → exact fraction.
- `compareMessages`: identical → empty details; tool-call **ids** ignored;
  argument **key order** ignored; differing name / arguments / count each
  reported with specifics; stop-reason mismatch; thinking blocks excluded.
- End to end: identical responses → `"full"`; same tool calls, different wording
  → `"partial"`; different tool name → `"divergent"` with the exact detail line;
  different arguments → `"divergent"` quoting both; key order alone → `"full"`;
  worst-case across a 3-model panel.
- Robustness: a **throwing** secondary and an **erroring** secondary are recorded
  as unavailable with the primary's stream complete and unmodified; a healthy
  third member still votes; `onVerdict` throwing is swallowed.
- Cost/lifecycle: `sampleRate: 0` calls no secondary and emits no verdict (spy);
  injected `random` gates a 0.5 rate both ways; no `onVerdict` → no secondary
  call; abandoning the stream aborts the secondaries; the caller's
  `AbortSignal` propagates; no verdict when the primary errors or aborts.
- Pass-through: primary events compared by **object identity**, index by index,
  in every scenario; `complete()` resolves to the primary's message; per-link
  `request.model` override; bare-client links.

Mutation-checked: removing the key sort fails 3 tests; removing the abandon-abort
fails 1.

Verify:

```bash
npx vitest run packages/ai/src/consensus.test.ts
npx tsc -p packages/ai/tsconfig.json --noEmit
```
