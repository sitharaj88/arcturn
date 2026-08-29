---
title: Model routing
description: Reference for per-role model overrides (route config) and failover chains, and how they resolve.
section: Reference
order: 11.5
---

Arcturn juggles several kinds of model call with very different quality requirements: the
main conversation loop needs the flagship; a delegated sub-agent's work is often focused
and mechanical; a compaction summary is lossy by design already; a session-title
suggestion is a few words. `createModelRouter` (`packages/cli/src/router.ts`) lets each of
these use a different model instead of hard-coding one everywhere. See
[Model providers § Per-role routing](/docs/providers#per-role-routing) for the narrative
version; this page is the config-and-precedence reference.

## Route kinds

```ts
type RouteKind = "main" | "subagent" | "compaction" | "title";
```

| Kind | Used for | Live call sites |
|---|---|---|
| `main` | The main conversation loop. | Resolved model for the session. |
| `subagent` | Delegated sub-agent work, scouts, and team members. | `createSubagent` and `scoutAgent` in `runtime.ts`; `/team` member dispatch and cost accounting in `team.ts`. |
| `compaction` | Summarizing history when the context window fills. | Intended for `compactionOptionsFor`; lossy work already, so a cheaper model costs nothing in quality that compaction wasn't already spending. |
| `title` | Session-title suggestions. | Reserved for future use — today's session title is derived from the task text directly, not an LLM call. |

## Config shape

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "route": {
    "subagent": "anthropic/claude-haiku-4-5",
    "compaction": "anthropic/claude-haiku-4-5"
  }
}
```

`route` is a `RouterConfig`: each of the four route keys is an optional model id string,
plus an optional `tiers` map covered below. Leaving a key out is not "no route" — it falls
through per the precedence below, so an unconfigured `subagent` route still gets a sensible
model rather than erroring. `route` is loaded like `verify`: a layer that sets it replaces
the whole block, it does not merge field-by-field with a lower layer's `route` — so a
project `.arcturn/config.json` that sets `route.main` and says nothing else drops a
user-level `route.tiers` entirely rather than inheriting it.

## Tiers: portable model choices for role files and workflows

A markdown agent's `model:` frontmatter and a workflow step's `[tag]` (see
[Workflows](/docs/workflows)) both used to require a concrete catalog id
(`model: anthropic/claude-opus-5`) — fine for one deployment, dead on arrival for anyone
using a different provider, since every role file in a kit has to be hand-edited to retune
it. `route.tiers` fixes that with a layer of indirection: a config maps a handful of
symbolic names to whatever concrete id that deployment actually wants, and a role or step
names the tier instead of the vendor:

```json
{
  "route": {
    "tiers": {
      "judgment": "zai/glm-5.3",
      "build": "zai/glm-4.7",
      "cheap": "zai/glm-4.6"
    }
  }
}
```

```md
---
model: tier:judgment
---
```

```md
1. [tier:cheap] Reproduce this bug and quote the failing output: {{input}}
2. [tier:judgment] Write the minimal patch. Repro: {{prev}}
```

`tiers` is an open string map — there is no fixed tier vocabulary, a fleet of role files
just needs to agree on names (`judgment`/`build`/`cheap` above are a suggestion, not a
reserved set). `router.ts` exports `resolveModelTag(tag, router, resolve)` as the one place
that decides whether a `[tag]`/`model:` string is a `tier:<name>` reference or a concrete
id: a `tier:` prefix resolves through `router.specForTier(name)`, and anything else
resolves as a concrete id exactly as it always has — tiers are strictly additive, no
existing `[tag]` or `model:` value changes behavior.

Tier resolution follows the same never-crash contract as the rest of this module: a tier
name absent from `tiers` (including when `tiers` itself is unset) falls back to the
`subagent` route and records a warning via `router.warnings()`, rather than failing the
run — a tier a deployment hasn't gotten around to tuning yet must not be the reason a
portable role file cannot run. A *configured* tier whose id fails to resolve behaves like
any other route: caught, falls back to the router's fallback model, warns. Resolution is
lazy and cached per tier name, and `router.rebind(newFallback)` clears that cache too.

`workflow.ts` itself stays deliberately catalog-agnostic: a `[tag]` (or a role's `model:`,
for the worktree dispatch lanes) is handed as a raw string to whatever `ModelTagResolver`
the host injects, and it treats a `tier:`-prefixed string as just another valid tag — the
only workflow-side change tiers needed was widening the tag grammar to allow `:`. Whether
`tier:judgment` actually reaches `route.tiers` depends on that injected resolver being
built from `resolveModelTag(tag, router, resolve)` rather than a bare catalog lookup; a
host that wires the `ModelTagResolver` handed to `createWorkflowCommands` straight to
`resolveModelSpec` (ignoring tiers) still runs every existing workflow unchanged — a
concrete `[anthropic/claude-opus-5]` tag resolves exactly as before — it just won't
understand `tier:` tags until it composes in a `ModelRouter` built from `config.route`.

## Precedence

```text
main:      config.route.main !== undefined ? resolve(config.route.main) : fallback
<other>:   config.route[kind] !== undefined ? resolve(config.route[kind]) : specFor("main")
```

`fallback` is the model the session otherwise resolved to — typically whatever `--model`
or `config.model` produced. So the effective chain for, say, `subagent` is: **its own
configured route, else `main`'s route, else the fallback model** — the same "override,
then inherit" shape [named agents](/docs/sub-agents#precedence-narrowing-and-inheritance)
use for their own `model:` frontmatter, which itself sits one level above the `subagent`
route (agent's own `model:` wins first, `route.subagent` second, the running model third).

Resolution is **lazy and cached per kind** — nothing is resolved until
`router.specFor(kind)` is actually called, and after that the same `ModelSpec` is
returned without re-resolving. `router.rebind(newFallback)` clears the cache and adopts a
new fallback; call it after the session's main model changes (e.g. `/model <id>`), or
routes that defaulted to the old fallback keep resolving to it.

`route.main` is a **startup default, not a standing veto**: an explicit in-session
switch (`/model <id>`) clears it, so the pick governs every routed call — sub-agents,
tier fallbacks, workflow stages — not just the chat. The per-kind overrides and `tiers`
survive the switch; they are deliberate policy, not the pick. The pick also persists as
your default: `/model` writes it back to the user config, moving a user-layer
`route.main` with it (a project-layer config still outranks the user layer, on purpose).

## Failure handling: never blocks startup

If a configured route id fails to resolve — unknown model, a deregistered preset, a typo
— that's caught rather than thrown. The kind falls back to the router's fallback model,
and a warning is recorded (retrievable via `router.warnings()`, populated only once a
failing kind has actually been looked up). A stale model id left over in a config file
must never be the reason Arcturn fails to start or the main loop refuses to run.

## Failover chains: `config.model` as a list

Separately from per-role routing, `config.model` (and `--model`) accepts either a single
id or an array:

```json
{ "model": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"] }
```

A list is a **failover chain**, not a round-robin or a preference order applied per turn.
The head is primary — it drives compaction budget and the cost readout — and the rest are
tried only when the current attempt fails *before any output has streamed*. The full
mechanics (which errors trigger a switch, why a `start` event is held back until one
model actually commits) live in `@arcturn/ai`'s `createFailoverClient`, documented in
[Model providers § Failover chains](/docs/providers#failover-chains). The short version:
failover only ever happens pre-output, and only for transient errors
(`rateLimit`/`overloaded`/`network`) — an auth failure or a malformed request fails
identically on every link in the chain, so burning through it would be pointless.

`resolveModelSpec(id, env)` resolves one id at a time (and throws `ModelResolutionError`
on an unknown id or a missing API key); a model list is handled by mapping this function
over every entry, not by a separate list-aware resolver.

## Cost rationale

Per-role routing exists so a long session doesn't have to downgrade the main loop just to
afford everything running alongside it — a cheap model for sub-agent delegation,
compaction summaries, and scouting keeps the aggregate bill down while the model actually
carrying the conversation stays the flagship. `suggestCheapModel` (`router.ts`) is a
heuristic for finding a cheaper same-provider, tool-capable candidate by input cost — it's
advisory only (meant for a future `/model route --auto` sketch) and is never applied
automatically today.

## Related

- [Model providers](/docs/providers) — the full picture: provider adapters, presets,
  failover, consensus, and the live model catalog this router resolves ids against.
- [Sub-agents, plan mode & todos](/docs/sub-agents#precedence-narrowing-and-inheritance) —
  where the `subagent` route sits in a named agent's own model precedence.
- [Agent teams & background agents](/docs/teams) — the other consumer of `specFor("main")`
  and `specFor("subagent")`, for the supervisor and its members respectively.
- [Workflows](/docs/workflows) — the `[tag]`/`@role` step grammar tiers are meant to make
  portable, and the three dispatch lanes a resolved model feeds into.
