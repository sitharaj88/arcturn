# Integrating the model router

`packages/cli/src/router.ts` (+ `router.test.ts`) began as a standalone,
unwired module, and this document was the map for wiring it. **The map has
since been walked**: the config key (§1), the runtime construction and
`subagent` consumption (§2), the compaction seam (`routedCompactionOptions`
in `runtime.ts`), LLM-generated session titles on the `title` route
(`session-title.ts`), and the `/model route` command family (§4) are all
live. Sections below are annotated where reality superseded the sketch.

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

**LANDED, with a different split than sketched:** core already had the seam
(`CompactionOptions.model`, consumed as `options.model ?? input.model`), so
no core change was needed. `routedCompactionOptions(seat, router)` in
`runtime.ts` still sizes the budget from the *seat* model (the window the
conversation actually lives in — not the summarizer's, as this note once
suggested) and adds `model` as a **live getter** that yields
`specFor("compaction")` only when `router.isRouted("compaction")` says a
compaction (or standing `route.main`) policy exists; otherwise `undefined`,
so an unrouted agent — a sub-agent on its own cheap model, a served session
with a per-session model — keeps compacting with the model in its seat.
The getter is read at compact time, which is what lets a mid-session
`/model route --auto` or `/model <id>` rebind govern the very next
compaction on agents constructed earlier.

### Title generation — LANDED

This is no longer an "if/when": `packages/cli/src/session-title.ts` is the
event-driven title generator (fire-once-per-session, triggered by the first
`runEnd` with `reason: "completed"` on an untitled session), and
`buildRuntime` wires it beside the cost guard. The LLM call requests
`router.specFor("title")` exactly as sketched here — through the *base*
client rather than the failover/consensus chain, because a title is a nicety
that should fail once and cheaply. It arms only for interactive sessions
(`ArcturnRuntime.sessionTitlesEligible`, set by the interactive app):
`--print`, serve and acp keep their contractual request streams — cassettes,
replay and the e2e "exactly one request reached the provider" pins would all
be polluted by a surprise second call. Sub-agent scratch sessions still get
their truncation title (`` `subagent: ${task.slice(0, 60)}` ``) at create
time, and the generator skips any session whose stored header already
carries a title. `sessionTitles: false` in config disables the whole path.

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

## 4. `/model route` command — LANDED

The sketch below shipped, with one deliberate upgrade over what this note
originally proposed: `--auto` no longer merely *suggests*. Now that the
router has a mutator (`ModelRouter.setRoute`) and the config a targeted
writer (`persistRoutePatch`), applying the pick is itself an explicit,
user-typed action — which was the whole reason suggestion-only existed. The
shipped shape, all inside the existing `model` command's handler
(`runModelRoute` in `commands.ts`), branching between `refresh` and the
model-id path:

- `/model route` — the read path, exactly as sketched: `describeRoutes`
  plus any accumulated `router.warnings()`, so a stale `route.subagent` id
  shows up once, in the place a user would look to fix it.
- `/model route --auto` — `suggestCheapModel(listModels(), runtime.model)`
  (the *current* model, which tracks `/model` switches), then applies the
  pick to the `subagent` AND `compaction` routes: live first
  (`setRoute` cannot fail), then persisted to the USER config only
  (`persistRoutePatch` merges into the existing `route` block; a failed
  save downgrades to a warning, like a failed `/model` pick). It refuses
  when no candidate qualifies, and refuses to route "up" when the cheapest
  candidate is not actually cheaper than the current model; an unpriced main
  model gets an honest caveat instead of a fake comparison. When the
  project-layer config carries its own `route` (which replaces wholesale),
  the command says so at write time.
- `/model route <subagent|compaction|title> <id>` and
  `/model route clear [kind]` — manual single-key management through the
  same live-then-persist pair. `main` is rejected with a pointer to
  `/model <id>`: the main route belongs to the pick/rebind lifecycle, and
  `setRoute`'s type (`Exclude<RouteKind, "main">`) makes that
  unrepresentable rather than merely discouraged.

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
