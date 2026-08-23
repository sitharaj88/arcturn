# Integration notes: cost preview

`packages/cli/src/cost-preview.ts` (+ `cost-preview.test.ts`) is a
self-contained, pure module — like `cost-guard.ts`, it was written and
tested without touching `runtime.ts`, `commands.ts`, `config.ts` or
`state-tools.ts`. This document is the wiring instructions for whoever picks
it up next.

It exports:

- `TurnSample` — `{ inputTokens, outputTokens, costUsd }`, one historical turn.
- `PlanShape` — `{ steps: number }`.
- `CostEstimate` — the forecast: `basis`, `turnsLow`/`turnsHigh`,
  optional `usdLow`/`usdHigh`, `confidence`, `sampleSize`, optional
  `medianTokensPerTurn`.
- `estimateFromHistory(history, plan, options?)` — primary estimator, median-based.
- `estimateFromModel(model, plan, assumptions?)` — fallback, uses `ModelSpec.cost`.
- `estimateCost({ history?, plan, model, ...assumptions })` — picks whichever
  of the above applies (history if non-empty, else the model).
- `formatEstimate(estimate, model)` — one readable line.

## 1. Where `/cost preview` goes in `commands.ts`

The existing `cost` command (`packages/cli/src/commands.ts`, around line
565) already branches on its `args` string for the `limit` subaction:

```ts
{
  name: "cost",
  description: "Show usage and cost, or set a ceiling with: limit <usd>",
  source: "built-in",
  run({ ui, runtime, args }) {
    const limitArg = /^limit\s+(.+)$/.exec(args.trim());
    if (limitArg) { /* ... existing /cost limit ... */ }
    const { usage, costUsd, turns } = runtime.metrics;
    ui.print([ /* ... existing summary ... */ ]);
  },
},
```

Add a second branch, checked before the existing summary fallthrough (order
doesn't matter relative to `limitArg`, since the two regexes are disjoint):

```ts
const previewArg = /^preview(?:\s+(\d+))?$/.exec(args.trim());
if (previewArg) {
  const steps = previewArg[1] ? Number(previewArg[1]) : runtime.agent.todos.length;
  const estimate = estimateCost({
    history: runtime.recentTurns,       // see §2 — does not exist yet
    plan: { steps },
    model: runtime.model,
  });
  ui.print(formatEstimate(estimate, runtime.model));
  return;
}
```

- `import { estimateCost, formatEstimate } from "./cost-preview.js";` at the
  top of `commands.ts`, alongside the existing `format.js` import.
- `/cost preview` with no argument previews the *current* todo list
  (`runtime.agent.todos.length` — see §3 for why todos are the right proxy
  for plan steps). `/cost preview 12` previews a hypothetical 12-step plan
  without needing a live todo list — useful for "roughly how much would a
  plan like this cost" before any plan tool call has happened.
- Update the command's `description` string to mention the new subaction,
  e.g. `"Show usage and cost, set a ceiling with: limit <usd>, or forecast with: preview [steps]"`.

This is additive to the existing `run()` body — the `limit` branch, the
summary fallthrough and the docstring are all left as they are; only a new
`if` and an updated `description` string are needed.

## 2. Sourcing `TurnSample`s — `runtime.metrics` is not enough

`ArcturnRuntime.metrics` (`runtime.ts` line ~356) is `{ turns, usage, costUsd }`
— **running totals only**. `estimateFromHistory` needs individual recent
turns to take a median of, which nothing in the runtime currently retains.

The natural, minimal addition (not made here, per this feature's
new-files-only constraint):

- Add a field to `ArcturnRuntime`, e.g. `recentTurns: TurnSample[] = []`.
- In `ArcturnRuntime.#onEvent`'s existing `if (event.type === "turnEnd")` branch
  (`runtime.ts` lines 876-884, right where `cost` is already computed via
  `calculateCostUsd(priced, event.usage)`), push one sample and cap the
  buffer:

  ```ts
  if (event.type === "turnEnd") {
    const priced = this.#answeringModel ?? this.model;
    const cost = event.usage.costUsd ?? calculateCostUsd(priced, event.usage) ?? 0;
    this.metrics = { /* ...unchanged... */ };

    // NEW: ring buffer for cost-preview.ts's estimateFromHistory.
    this.recentTurns.push({
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
      costUsd: cost,
    });
    if (this.recentTurns.length > RECENT_TURNS_LIMIT) this.recentTurns.shift();
  }
  ```

  A cap around 20-30 (`RECENT_TURNS_LIMIT`) comfortably clears
  `MEDIAN_CONFIDENCE_SAMPLE_SIZE` (8) for "medium" confidence while staying
  a trivial amount of memory — no persistence needed, it is fine for this to
  reset on process restart (a fresh session has no history anyway, so
  `estimateCost` falls back to `estimateFromModel`, which is exactly the
  desired behavior).
- Reset `recentTurns = []` alongside the existing `this.metrics = { turns: 0, ... }`
  reset in `startNewSession`/`/clear` (`runtime.ts` line ~807), so a
  forecast never mixes turns from an unrelated prior task.
- `shouldAbortForCost`'s cost-guard wiring at `runtime.ts` line ~1185
  (`getCostUsd: () => runtime.metrics.costUsd`) is untouched — the ring
  buffer is additive, not a replacement for the running total.

This is a ~10-line change confined to `runtime.ts`, deliberately not made
by this task (which may not edit existing files).

## 3. Where "steps" comes from — plan vs. todos

`createPlanTool` (`packages/core/src/state-tools.ts`) stores a plan as a
single markdown string (`{ plan: string }`), not a structured step list —
there is no `steps: number` anywhere in arcturn's plan representation. The
closest structured proxy is the sibling `todo` tool
(`createTodoTool`/`TodoItem[]`): agents in plan mode conventionally emit a
plan via `plan`, then immediately populate `todo` with the concrete
checklist for it, and `runtime.agent.todos` is live/queryable
(`/todos` already reads it, `commands.ts` line ~557).

So `PlanShape.steps` in practice means `runtime.agent.todos.length` at
forecast time — deliberately a proxy, not a parse of the markdown plan
text (parsing "the plan" into step-count would mean guessing at whatever
list/heading structure the model happened to use, which is far less
reliable than counting actual `todo` entries). `cost-preview.ts` takes
`{ steps: number }` rather than arcturn's own `TodoItem[]`/plan-string types so
it stays decoupled from `@arcturn/core` and `@arcturn/types`'s specific
shapes — the caller does the one-line extraction (`todos.length`).

## 4. Gating plan-mode approval

Plan approval happens in `packages/cli/src/interactive/app.ts`,
`#requestPlanApproval` (line ~624), which builds `planDialog(plan, glyphs)`
(`packages/cli/src/interactive/dialogs.ts` line ~167) and awaits the user's
choice (`once` / `always` / deny-and-revise).

To show the forecast *before* that approval:

1. `state.ts`'s `requestPlanApproval(plan: string, toolCallId: string)`
   fires from `agent.ts` (`#requestPlanApproval`, line ~473) right after the
   `plan` tool call and the `planUpdate` event (`agent.ts` line ~464). At
   that point `runtime.agent.todos` already reflects whatever the model set
   up before calling `plan` (agents are instructed to keep the todo list
   current), so `todos.length` is a reasonable step count *at the moment of
   approval*, not just when `/cost preview` is typed manually.
2. In `app.ts#requestPlanApproval`, before calling `planDialog`, compute
   `estimateCost({ history: this.#runtime.recentTurns, plan: { steps: this.#runtime.agent.todos.length }, model: this.#runtime.model })`
   and pass `formatEstimate(estimate, this.#runtime.model)` into
   `planDialog` as an extra line (e.g. a `costPreview?: string` parameter
   rendered under the plan body, above the once/always/deny choices).
3. This keeps the two approvals conceptually distinct, as intended: the
   dialog still asks "approve this *plan*?" — the cost line is
   informational context alongside it, not a separate gate. A stricter
   variant (approving a *budget*, not just seeing one) would compare the
   estimate's `usdHigh` against `runtime.costLimitUsd` and warn/refuse when
   it would blow the ceiling — that logic belongs in `#requestPlanApproval`
   itself, reusing `cost-guard.ts`'s `shouldAbortForCost` against
   `estimate.usdHigh` rather than the live spend.

None of `app.ts`, `dialogs.ts`, `agent.ts` or `state.ts` were touched by
this task; the above is the concrete, minimal-diff shape of that follow-up
change.

## Summary of required (not yet made) edits elsewhere

| File | Change |
|---|---|
| `packages/cli/src/runtime.ts` | Add `recentTurns: TurnSample[]` ring buffer, push in `#onEvent`'s `turnEnd` branch, reset alongside `metrics` reset. |
| `packages/cli/src/commands.ts` | Add `preview` subaction to the `cost` command; import `estimateCost`/`formatEstimate`. |
| `packages/cli/src/interactive/app.ts` | Compute and pass a `formatEstimate(...)` line into `planDialog` from `#requestPlanApproval`. |
| `packages/cli/src/interactive/dialogs.ts` | `planDialog` accepts and renders an optional cost-preview line. |

`packages/cli/src/cost-preview.ts` itself needs no further changes for any
of the above — it already exposes everything each call site needs.
