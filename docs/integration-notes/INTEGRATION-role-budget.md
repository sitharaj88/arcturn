# Wiring `budget:` frontmatter into `agents.ts`

This is the integration recipe for the other half of ENFORCED PER-ROLE
BUDGETS. `packages/cli/src/workflow.ts` now reads and enforces
`AgentDef.budget` in full — a role whose cumulative spend crosses it is
aborted mid-step, and an optional workflow-level `budgetUsd:` backstops the
whole run (RFC 0001 §3.2/§7.4/§8.4). None of that required touching
`agents.ts`, on purpose: this task's file ownership was scoped to
`workflow.ts`, the `kits/enterprise-org/agents/*.md` role files (docs
only) and `workflow.test.ts`, so the loader gained the field only as a
**type** (a `declare module "./agents.js"` augmentation inside `workflow.ts`
— see that file's doc comment right above it), not as parsed, populated
data. Until the diff below lands, every real role file's `budget:` line is
still inert in production — `AgentDef.budget` is always `undefined`, which
the enforcement code treats identically to "no budget declared" — even
though `workflow.ts`'s own tests (fake `AgentDef` fixtures built with
`{ ...role(...), budget: 1.5 }`) already exercise the enforcement path end to
end.

## What's already built (nothing here needs to change)

`packages/cli/src/workflow.ts` exports/uses, all already shipped:

- `declare module "./agents.js" { interface AgentDef { budget?: number } }` —
  the type augmentation. Stays exactly as it is; TypeScript's declaration
  merging means the diff below does not need (and must not add) a competing
  `budget` field declaration inside `agents.ts`'s own `AgentDef` interface —
  that would conflict.
- `roleBudgetUsd(def: AgentDef): number | undefined` — reads `def.budget`,
  returns it only when finite and `> 0` (mirrors `shouldAbortForCost`'s own
  "`0`/absent/negative/non-finite disables" convention exactly).
- Real-time per-attempt enforcement in `runStepWithDeadline` /
  `runStepAttempts`, threaded from `runWorkflow`'s step-dispatch loop.
- `roleBudgetExceededError` — the `"step 1 (@role) exceeded its $N budget
  (spent $M) …"` message.
- An optional run-level `budgetUsd:` workflow-frontmatter backstop (already
  fully self-contained in `workflow.ts`, not affected by this note at all).

`workflow.test.ts`'s `describe("runWorkflow — enforced per-role and run
budgets", …)` (11 cases) and `describe("parseWorkflow — budgetUsd
frontmatter …")` (4 cases) cover all of this against fake `AgentDef`/`runStep`
doubles — they do not depend on `agents.ts` at all, and stay green
untouched by the diff below.

## The one change: parse `budget:` the way `maxTurns:` already is

`packages/cli/src/agents.ts`'s own doc comment says it plainly today:

> Only `description`, `name`, `tools`, `model` and `maxTurns` keys are
> recognised; other keys (the org kit's `budget`, `consumes`, `produces`,
> etc.) are ignored, not rejected — this loader only cares about what it
> dispatches with.

That sentence needs `budget` removed from the ignored list, and the loader
needs to actually populate it. The shape to copy is `maxTurns:`'s, field for
field, with one semantic difference: `maxTurns: 0` is invalid (a turn count
of zero cannot run a step at all) and is dropped with a warning, but
`budget: 0` is a **valid, meaningful value** — RFC 0001 and
`shouldAbortForCost` both treat `0` as "the guard is off", the same way an
absent `budget:` line already is. So `budget: 0` must parse cleanly to
`0`/`undefined` (either is fine — `roleBudgetUsd` in `workflow.ts` treats
`0` and `undefined` identically), never warn, and never get dropped as if it
were a typo.

**1. `AgentDef` interface** (after the existing `maxTurns` field):

```ts
export interface AgentDef {
  // … name, description, systemPrompt, tools?, model? unchanged …
  /**
   * Per-agent turn ceiling, from `maxTurns:` frontmatter. `undefined` means
   * "use the dispatcher's default" (`createSubagent` falls back to
   * `config.subagentMaxTurns ?? SUBAGENT_MAX_TURNS`).
   */
  maxTurns?: number;
  /**
   * Per-assignment USD ceiling, from `budget:` frontmatter (RFC 0001
   * §3.2/§7.4/§8.4). `undefined` means "no ceiling"; `0` means the same
   * thing spelled explicitly. Enforced by `workflow.ts`'s
   * `roleBudgetUsd`/`runStepWithDeadline`, not by this loader — this field
   * is data, not a check.
   */
  budget?: number;
  /** Absolute path of the file the agent was loaded from. */
  source: string;
}
```

Do **not** also add this field via a second `declare module` — `workflow.ts`
already augments the type; adding it here too, as a real property on the
same interface in the same compilation, is a duplicate declaration TypeScript
will happily merge (structurally identical optional `number` fields don't
conflict), but there is no reason to carry both once this diff lands. Leave
`workflow.ts`'s augmentation exactly where it is: removing it is a
`workflow.ts` change, out of scope for this note, and harmless to leave in
place indefinitely (a `declare module` augmenting a field the target
interface already declares natively is a no-op).

**2. `Frontmatter` interface** (after `maxTurns`):

```ts
interface Frontmatter {
  description?: string;
  name?: string;
  tools?: string;
  model?: string;
  maxTurns?: string;
  budget?: string;
}
```

**3. `parseAgentFrontmatter`'s key switch** (after the `maxTurns` branch):

```ts
if (key === "description") frontmatter.description = value;
else if (key === "name") frontmatter.name = value;
else if (key === "tools") frontmatter.tools = value;
else if (key === "model") frontmatter.model = value;
else if (key === "maxTurns") frontmatter.maxTurns = value;
else if (key === "budget") frontmatter.budget = value;
```

**4. The doc comment's "Recognised keys" list** — add, after the `maxTurns`
bullet:

```
 * - `budget` — a per-assignment USD ceiling, e.g. `budget: 1.50`. Must be a
 *   non-negative, finite number; anything else (negative, non-numeric) is
 *   dropped with a warning rather than silently coerced, exactly like
 *   `maxTurns`. `0` and an absent `budget:` line both mean "no ceiling" —
 *   unlike `maxTurns: 0` (invalid), `budget: 0` is a normal, valid way to
 *   spell "disabled". Enforced by `workflow.ts`, not by this loader.
```

And update the sentence that currently lists `budget` among the ignored org
kit keys — drop `budget` from that list (`consumes`, `produces`, etc. stay,
since those remain genuinely unread by anything today).

**5. `loadCandidate`** (after the existing `maxTurns` block, which looks like
this today):

```ts
let maxTurns: number | undefined;
if (frontmatter.maxTurns !== undefined) {
  const parsed = Number(frontmatter.maxTurns);
  if (Number.isInteger(parsed) && parsed > 0) {
    maxTurns = parsed;
  } else {
    warnings.push(`${file}: "maxTurns" must be a positive integer (dropped)`);
  }
}
```

Add, right after it:

```ts
let budget: number | undefined;
if (frontmatter.budget !== undefined) {
  const parsed = Number(frontmatter.budget);
  // `0` is valid (explicitly disabled) — the floor is `>= 0`, not `> 0`,
  // unlike `maxTurns` above. A negative, non-finite or non-numeric value is
  // still a mistake worth a warning, not a silent fallback to "disabled".
  if (Number.isFinite(parsed) && parsed >= 0) {
    budget = parsed;
  } else {
    warnings.push(`${file}: "budget" must be a non-negative number (dropped)`);
  }
}
```

And add `budget` to the returned object, next to `maxTurns`:

```ts
return {
  name,
  description,
  systemPrompt: body.trim(),
  ...(tools === undefined ? {} : { tools }),
  ...(model === undefined ? {} : { model }),
  ...(maxTurns === undefined ? {} : { maxTurns }),
  ...(budget === undefined ? {} : { budget }),
  source: file,
};
```

## What this does *not* need to touch

- `INTEGRATION-agents.md` (how `runtime.ts` wires `loadAgentDefs` into
  `createSubagent`/dispatch) — `budget` is read by `workflow.ts`'s own
  `@role` dispatch path, not by `createSubagent`'s read-lane, so nothing
  about that wiring changes.
- `runtime.ts`, `commands.ts`, or any workflow-command call site — they
  already pass whatever `AgentDef` the resolver hands them straight through
  to `workflow.ts`'s `runWorkflow`/`createRuntimeRunStep`/
  `createRuntimeWriteLane`; once `loadCandidate` populates `.budget`, it
  arrives at the enforcement code with no further plumbing.
- `kits/enterprise-org/agents/*.md` — already carry real `budget:`
  values (they always did; the field was decorative, not absent) and this
  task's own pass added an explanatory comment under each one. Nothing there
  needs to change for this diff to take effect.

## Verification

```sh
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/agents.test.ts        # existing suite, must stay green
npx vitest run packages/cli/src/workflow.test.ts       # 215 tests, must stay green
node --input-type=module -e '
import { loadAgentDefs } from "./packages/cli/dist/agents.js";
const warnings = [];
const defs = await loadAgentDefs(["./kits/enterprise-org/agents"], warnings);
console.log(warnings.length, "warnings");
for (const d of defs) console.log(d.name, d.budget);
'
# ^ rebuild @arcturn/cli first (pnpm --filter @arcturn/cli run build) — every
#   role file should now report its real budget instead of `undefined`.
```

Add one or two small `agents.test.ts` cases mirroring its existing `maxTurns`
coverage: a valid `budget:` value populates `AgentDef.budget`; `budget: 0`
parses to a defined `0` (or is simply present, either is correct) with **no**
warning, unlike an invalid `maxTurns: 0`; a negative or non-numeric `budget:`
is dropped with a warning and the file still loads.
