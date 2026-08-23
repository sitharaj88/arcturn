# Integrating the model router

`packages/cli/src/router.ts` (+ `router.test.ts`) is a new, standalone module.
It is **not wired in anywhere yet** — this document is the map for doing that.
Per the task's hard rules, no existing file was edited to produce it; the
changes below are a plan, not a diff.

## What it gives you

```ts
export type RouteKind = "main" | "subagent" | "compaction" | "title";

export interface RouterConfig {
  main?: string;
  subagent?: string;
  compaction?: string;
  title?: string;
}

export function createModelRouter(
  config: RouterConfig,
  resolve: (id: string) => ModelSpec,
  fallback: ModelSpec,
): ModelRouter; // .specFor(kind), .warnings()

export function suggestCheapModel(
  candidates: ModelSpec[],
  main: ModelSpec,
): ModelSpec | undefined;

export function describeRoutes(
  router: ModelRouter,
  kinds?: readonly RouteKind[],
): string[];
```

Resolution is lazy, cached per kind, and never throws: an unresolvable
configured id falls back to `fallback` and is recorded in `router.warnings()`.
That property is exactly what `runtime.ts` needs — a stale
`route.subagent` id in `~/.arcturn/config.json` must not stop `arcturn` from
starting.

## 1. Config: a `route` key in `ArcturnConfig`

`packages/cli/src/config.ts` defines `ArcturnConfig` (line 39) and
`DEFAULT_CONFIG` (line 96), and validates unknown top-level keys against the
`KNOWN_KEYS` set (line 108) the same way `verify` (an optional nested config
object, see `VerifyConfig` in `verify.ts`) is already handled. Add `route`
the same way:

```ts
// ArcturnConfig, alongside `verify?: VerifyConfig;`
/** Per-call-site model overrides (sub-agents, compaction, titles). */
route?: RouterConfig;
```

```ts
// KNOWN_KEYS
"route",
```

No default entry is needed in `DEFAULT_CONFIG` — `route` being absent is
itself meaningful (`createModelRouter({}, ...)` routes everything to `main`),
so `ArcturnConfig.route` stays `undefined` until a config layer sets it, exactly
like `verify`. The three layers (built-in/user/project) already merge
object-valued keys with "later layer wins" semantics elsewhere in this file
(see how `hooks` and `permissions` accumulate vs. how scalar keys like
`thinking` just overwrite); `route` should overwrite wholesale per layer,
same as `verify` does today — a project `.arcturn/config.json` fully replaces a
user-level `route` block rather than merging field-by-field. Document that
choice next to the new field if it's surprising in review.

Example `.arcturn/config.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "route": {
    "subagent": "anthropic/claude-haiku-4-5",
    "compaction": "anthropic/claude-haiku-4-5",
    "title": "anthropic/claude-haiku-4-5"
  }
}
```

`route.main` is deliberately supported too (not just the three cheap
routes): it lets a config pin what "main" means for the router independently
of `--model`/`config.model`, which matters for the `--auto` sketch in
section 4 — `main` there should track the model surfaced through
`resolveModelSpec`, not silently drift.

## 2. `runtime.ts`: constructing the router and using it

### Construction — in `buildRuntime` (`runtime.ts` ~line 820)

Right after `model` is resolved:

```ts
const modelSpecs = modelIds.map((id) => resolveModelSpec(id, env));
const model = modelSpecs[0]!;
```

construct a router:

```ts
const router = createModelRouter(
  config.route ?? {},
  (id) => resolveModelSpec(id, env),
  model,
);
for (const warning of router.warnings()) warnings.push(warning);
```

Note `router.warnings()` is empty at this point — nothing has been resolved
yet (resolution is lazy). Reading it here is a no-op unless you eagerly touch
a route first; the real warning surfacing happens per-use below, or via a
one-time `describeRoutes(router)` call if you want to force + report
resolution at startup. Store the router on `ArcturnRuntime` (new `readonly
router: ModelRouter` field, set in the constructor from `ArcturnRuntimeInit`)
so `createSubagent` and compaction can reach it.

### `createSubagent` (`runtime.ts` line 537, model line 559)

Today:

```ts
const model = def?.model === undefined ? this.model : resolveModelSpec(def.model, this.#env);
```

The router slots in as the *middle* tier, between "runtime's current model"
and "agent's own override" — composing so the more specific choice always
wins:

```ts
const model =
  def?.model !== undefined
    ? resolveModelSpec(def.model, this.#env)   // markdown agent's own `model:` wins
    : this.router.specFor("subagent");         // else the configured/derived subagent route
```

This preserves the exact precedence the task calls out: a markdown agent's
own `model:` frontmatter (see `agents.ts` line 56 — "Model id override.
`undefined` means 'use the parent's model'") must still beat the route,
because it's a more specific, per-agent decision than a global "all
sub-agents get the cheap model" policy. Only when the agent def has no
`model:` does `specFor("subagent")` apply — which itself falls back to
`this.model` (via the router's "absent → main" rule, once `route.main` is
wired to track `this.model`) when `route.subagent` isn't configured, so
behavior for a config with no `route` block at all is unchanged from today.

One wrinkle: `this.model` can change mid-session via `setModel` (line 465),
but the router's `main` route is cached from construction. If `route.main`
was left unconfigured, cheap routes should probably still track whatever
`this.model` is *right now*, not the model at startup. Two ways to handle
it, pick one deliberately when wiring this in:

- Rebuild the router (or at least clear its cache) inside `setModel`, so a
  live model switch re-derives `subagent`/`compaction`/`title` too.
- Or treat `route.main` as fixed by design ("the router describes fixed
  policy, `/model` mid-session is an escape hatch") and document that
  `/model` does not retarget the cheap routes.

Given `setModel` already exists and is the norm for "the user changed their
mind mid-session," the first option is more consistent with today's
`ArcturnRuntime` semantics — but it's a real design decision, not a mechanical
wiring step, so it's called out rather than silently picked here.

### `compactionOptionsFor` usage (`runtime.ts` line 638, inside `#agentOptions`)

Today:

```ts
compaction: compactionOptionsFor(this.model),
```

`compactionOptionsFor` (line 280) only *sizes* the compaction budget from a
model's context window — it doesn't choose which model performs the
summarization call. That choice lives wherever compaction actually invokes
the LLM (inside `@arcturn/core`'s `Agent`/compaction path, which this task
does not touch). The integration point here is: pass
`this.router.specFor("compaction")` as the model whose context window sizes
the budget, since a cheap compaction model likely has a *different* context
window than `main` and the reserve/keep-recent split should be sized to
whichever model will actually run the summarization:

```ts
compaction: compactionOptionsFor(this.router.specFor("compaction")),
```

If `@arcturn/core`'s compaction call itself needs the *model* (not just
the budget), that would be a second call site inside `core`, out of scope
here — call it out as a follow-up rather than reaching into `core` under
this task's "new files only" constraint.

### Title generation

`runtime.ts` doesn't currently generate session titles from an LLM call
(session `title` is set from the delegated task text, e.g. line 568:
`` title: `subagent: ${task.slice(0, 60)}` `` — it's a truncation, not a
model call). If/when title generation becomes an LLM call (e.g. "summarize
this conversation into a 6-word title" for the session list), that call site
should request `router.specFor("title")`, matching the `subagent` and
`compaction` pattern above.

## 3. Composing with markdown agents — precedence summary

```
def.model (agent's own `model:` frontmatter)
  → wins outright if present
route.subagent (config's route.subagent, resolved via router.specFor("subagent"))
  → applies when def.model is absent
route.main / this.model
  → applies when route.subagent is also absent (router's own fallback rule)
```

This is a strict override chain, not a merge — exactly one of the three
decides the model for a given sub-agent call, matching how `def.tools` today
only *narrows* the parent's allowed set (line 546) while `def.model` fully
*replaces* the parent's model (line 559): the router's job is to fill the gap
between "no agent-specific override" and "runtime's current model" with a
policy decision, without disturbing either end of that existing chain.

## 4. `/model route` command sketch

`packages/cli/src/commands.ts` already has a `model` command (line 191) that
switches `runtime.model` via `runtime.setModel`. A sibling `route`
subcommand (or `model route` as a second word, mirroring how `model refresh`
already branches on `args.trim()` at line 196) would look like:

```ts
{
  name: "model", // extend the existing handler, or add a dedicated "route" command
  ...
  async run({ ui, runtime, args }) {
    const [sub, ...rest] = args.trim().split(/\s+/);
    if (sub === "route") {
      const arg = rest.join(" ");
      if (arg === "--auto") {
        const suggestion = suggestCheapModel(listModels(), runtime.model);
        if (!suggestion) {
          ui.notice("warn", "No cheaper same-provider, tool-capable model with known pricing found.");
          return;
        }
        ui.print([
          `Suggested cheap model: ${suggestion.id} (${suggestion.displayName})`,
          `$${suggestion.cost?.input}/Mtok input vs. $${runtime.model.cost?.input ?? "?"}/Mtok for ${runtime.model.id}.`,
          "Not applied — add it to route.subagent / route.compaction / route.title in .arcturn/config.json and restart.",
        ]);
        return;
      }
      // No args: show the current routes.
      ui.print(["Model routes:", ...describeRoutes(runtime.router).map((line) => `  ${line}`)]);
      for (const warning of runtime.router.warnings()) ui.notice("warn", warning);
      return;
    }
    // ...existing /model switch-model behavior below...
  },
}
```

Key points for whoever wires this in:

- `--auto` only *suggests* (per the task's design: "used by a `/model route
  --auto` sketch, not applied automatically") — it prints a suggestion and
  the config key to set by hand; it never calls `runtime.setModel` or writes
  config. Applying a suggested route is a deliberate, separate action (edit
  `.arcturn/config.json`, restart arcturn) so a heuristic pick never silently changes
  what a sub-agent run costs or what compaction does to context fidelity.
- Plain `/model route` (no args) is the read path: `describeRoutes` plus
  printing any accumulated `warnings()`, so a stale `route.subagent` id shows
  up in the UI once, in the same place a user would look to fix it.
- `suggestCheapModel` needs a `main` argument that is the *current* model
  (`runtime.model`, which already tracks `/model` switches), not a router
  route — it answers "what's cheaper than what I'm running now," independent
  of whatever `route.*` happens to already say.

## Verification

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/router.test.ts   # 16 tests, all passing
npx tsc -p packages/cli/tsconfig.json --noEmit   # router.ts/router.test.ts: 0 errors
```

The `tsc` run reports 4 pre-existing errors in `packages/cli/src/overlay.ts`
(an untracked file already present in the working tree, unrelated to this
task and not touched by it — a `Dirent<string>` vs. `Dirent<NonSharedBuffer>`
`@types/node` mismatch). `grep`-ing the `tsc` output for `router` returns no
matches: the new module and its test file introduce no type errors.
