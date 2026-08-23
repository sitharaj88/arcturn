# Wiring the model-invoked `skill` tool

Integration recipe for `packages/cli/src/skill-tool.ts` (new file, with
`skill-tool.test.ts`). Per the task's rules no existing file was edited —
everything below is an exact instruction for whoever wires it into
`runtime.ts` and `config.ts`.

The idea in one line: `skills.ts` already turns markdown files into slash
commands a *user* types; `skill-tool.ts` exposes the same discovered skill
collection to the *model* as one ordinary tool, `skill`, whose description
carries a compact index ("name — description") so the model can recognise
mid-task that a skill applies and pull it into context without the user
having typed anything.

---

## 1. What's already built

`packages/cli/src/skill-tool.ts` exports:

```ts
export const DEFAULT_SKILL_TOOL_MAX_BODY_CHARS = 8_000;

export interface CreateSkillToolOptions {
  registry: () => readonly Skill[];   // Skill from ./skills.js — reused, not redefined
  maxBodyChars?: number;               // default DEFAULT_SKILL_TOOL_MAX_BODY_CHARS
}

export function createSkillTool(options: CreateSkillToolOptions): Tool;
```

`Skill` (from `skills.ts`, unchanged) is reused as-is:

```ts
interface Skill {
  name: string;
  description: string;
  source: string;
  buildPrompt(args: string, cwd: string): string;
}
```

**No duplicated substitution logic.** `skill-tool.ts` calls
`skill.buildPrompt(args, ctx.cwd)` directly — the exact same expansion
`skillCommand` in `runtime.ts` drives for `/name` (`$ARGUMENTS`, `$1..$9`,
`$CWD`, `$SKILL_DIR`, frontmatter already stripped). `skills.ts` did not need
a new export for this: `buildPrompt` was already public on every `Skill`.
The only thing reimplemented locally in `skill-tool.ts` — deliberately, per
the task's dependency-free rule — is a small `textResult`/`errorResult`
pair, matching the same pattern already duplicated in `memory.ts` (see that
file's comment on why: `@arcturn/tools`'s `result-utils` helpers aren't
exported from its package root, and this module must not gain a new
cross-package coupling to reach them).

### Tool contract

- **name**: `"skill"`.
- **description**: a fixed preamble plus `"Available skills:\n" +` one line
  per skill *that has a non-empty `description` frontmatter*, sorted by
  name, `name — description`. A skill with no description is omitted from
  the index but remains callable by name — **document this to skill
  authors**: a skill meant to be found by the model needs the same
  `description:` frontmatter line it already needs to show up usefully in
  `/help`.
- **description freshness**: `definition` is a JS getter, not a fixed field
  — it rebuilds the index from `options.registry()` on every access. This
  was a deliberate lazy-over-eager choice: skills do not currently reload
  after `buildRuntime` runs in this codebase (there is no file watcher), so
  in practice the index is fixed for the process lifetime either way, but a
  lazy getter costs nothing extra (the tool list is read at most once or
  twice per turn) and means a *future* skill-reload feature (`/skills
  reload`, a directory watcher) picks up the new index automatically with no
  change to this file. If this ever shows up as measurably hot, memoizing on
  `registry()`'s identity (when the registry itself returns a stable array
  reference until something actually changes) is the cheap follow-up — not
  needed today.
- **input**: `{ name: string; args?: string }`. `args` is treated exactly
  like text typed after `/name` — passed straight to `buildPrompt`.
- **execute**: looks up `name` in `options.registry()`, returns the
  substituted body as the tool's text content (truncated at `maxBodyChars`
  with a trailing `…(truncated; …)` note if longer), with
  `details: { skill: name, chars: text.length }` (`chars` counts the
  *returned* — possibly truncated — text, matching how a caller would size
  a follow-up).
- **unknown skill**: `isError: true`, message `Unknown skill "<name>".`, plus
  up to 3 suggested names — substring matches (either direction) ranked
  above pure edit-distance guesses, ties broken by Levenshtein distance then
  name — or "No skills are currently loaded." when the registry is empty.
- **abort**: `ctx.signal.aborted` is checked at the top of `execute` and
  returns the same `"Aborted: …"` error shape every other built-in tool
  uses (`memory.ts`, etc.) — this tool does no I/O of its own, so abort
  handling is a defensive, near-free check rather than something that can
  actually interrupt work in progress.

---

## 2. `runtime.ts` — exact insertion point

Skills are already loaded once in `buildRuntime`, right before the
`extensions.commands.push(...)` line:

```ts
// runtime.ts, buildRuntime() — ALREADY THERE, unchanged
const skills = await loadSkills(
  [...new Set([join(paths.home, "skills"), join(paths.project, "skills")])],
  warnings,
);
extensions.commands.push(...skills.map(skillCommand));
```

`skills` (the resolved `Skill[]`) is exactly the array `createSkillTool`'s
`registry` should close over. Add the tool to `baseTools`, in the array
literal a little further down (currently ends `...extensions.tools`, right
before the "Lifecycle hooks wrap every tool exactly once here" comment —
around line 1340–1373 in the current file):

```ts
// runtime.ts, buildRuntime() — orchestrator edit
import { createSkillTool } from "./skill-tool.js";   // new import, alongside the other tool factories

const baseTools: Tool[] = [
  ...defaults.tools,
  createSearchCodeTool(),
  createTodoTool(),
  createPlanTool(),
  createMemoryTool({ /* unchanged */ }),
  createSubagentTool({ /* unchanged */ }),
  ...(config.skills?.modelInvoked === false
    ? []
    : [createSkillTool({ registry: () => skills })]),
  ...extensions.tools,
];
```

Notes on that insertion:

- `registry: () => skills` closes over the `const skills` already bound
  above — no restructuring needed, and it satisfies the "reuse the
  discovery collection, don't reimplement it" rule by construction.
- Placed **before** `...extensions.tools`, matching where every other
  first-party tool in this array sits, and so an extension tool literally
  named `skill` would still be rejected by the existing reserved-name
  collision guard (`BUILT_IN_TOOL_NAMES`) if `"skill"` is added there — see
  §4 below, this is required, not optional.
- Placed **after** `createSubagentTool`, no ordering requirement beyond
  "somewhere in `baseTools`" — tool order does not affect the model's
  ability to call any of them.
- The array is built once per `buildRuntime()` call, same lifecycle as
  every other entry — `createSkillTool`'s own lazy `definition` getter is
  what keeps its *description* fresh across the runtime's lifetime, not
  re-running this block.

This array (`baseTools`) then goes through the *existing* LSP → verify →
overlay → speculation → taint → canary → hooks wrap chain unchanged
(`toolsWithSymbols` … `hookedTools`, lines ~1410–1475) exactly like every
other built-in tool — `skill-tool.ts` needs no special-casing anywhere in
that chain. A sub-agent built through `ArcturnRuntime.createSubagent` only
gets read-only-safe tools by non-`yolo` default (`DEFAULT_READ_ONLY_TOOLS`
plus `fetch`); `skill` reads no filesystem state itself (only in-memory
`Skill.buildPrompt`, which the sub-agent's `#preHookTools` filter does not
special-case), so **add `"skill"` to `investigative`'s allowed set only if
you want sub-agents to load skills too** — the current filter in
`createSubagent` (`investigative = new Set([...DEFAULT_READ_ONLY_TOOLS,
"fetch"])`) excludes it by default, which is the safer starting posture
since a delegated sub-agent has no user to explain an unexpectedly-loaded
skill's instructions to.

## 3. Config flag: `skills.modelInvoked`

Add to `ArcturnConfig` (`config.ts`), alongside the existing top-level keys
(near `dryRun`, `canary`):

```ts
// config.ts, ArcturnConfig interface — orchestrator edit
export interface ArcturnConfig {
  // ... existing fields ...
  /** Model-invoked skill tool. Default true (on). */
  skills: { modelInvoked: boolean };
}
```

with the usual default/parse/merge triplet other booleans get (mirror
`dryRun`'s three call sites — `DEFAULT_CONFIG`, the `raw.dryRun !==
undefined` parse block, and the `layer.dryRun ?? base.dryRun` merge —
substituting the nested `skills.modelInvoked` shape). Default **on**
(`{ modelInvoked: true }`): the tool costs nothing when no skills are
loaded (`renderIndex` returns the empty-state line) and is the whole point
of the feature — opt-out (`{"skills": {"modelInvoked": false}}` in
`~/.arcturn/config.json` or `<cwd>/.arcturn/config.json`) is for a user who
wants skills to stay purely a typed-slash-command feature.

The `config.skills?.modelInvoked === false` check in §2 already matches
this shape; `?.` is deliberate for older config files parsed before this
key existed (falls through to the default-on `undefined !== false`
branch — no migration needed).

## 4. Reserved tool name

`BUILT_IN_TOOL_NAMES` (`runtime.ts`, currently a flat `readonly string[]`
including `"memory"`, `"todo"`, `"plan"`, `"subagent"`, …) must gain
`"skill"`:

```ts
// runtime.ts — orchestrator edit
export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "read", "write", "edit", "bash", "grep", "glob", "ls", "fetch", "websearch",
  "symbols", "search_code", "memory", "todo", "plan", "subagent",
  "skill",   // <-- add
];
```

This list feeds both `loadExtensions({ reservedToolNames: … })` and
`loadAgentDefs`'s tool-name validation, so without this addition an
extension or a markdown agent definition could register a conflicting
`skill` tool that silently shadows or gets shadowed by this one, depending
on load order — the same protection every other built-in tool already gets.

## 5. Composing with a deferred-tools / progressive-disclosure feature

There is currently **no** deferred-tools mechanism in this codebase (no
`alwaysActive` concept, no tool-search-then-load indirection like the one
this very harness uses) — `baseTools` is a flat list handed to the model
every turn. If one is added later, `skill` is a natural member of whatever
"always resolvable, never deferred" set such a feature defines: unlike a
narrow single-purpose tool, `skill`'s whole value is that its *description*
already IS the compact index a deferred-tools system would otherwise need
to reconstruct out-of-band — hiding `skill` itself behind a second layer of
indirection (a tool to discover the tool that discovers skills) would only
add a round trip with no benefit. Concretely, if a future
`deferredTools: string[]` config key or similar is added to `runtime.ts`'s
tool-assembly path, exclude `"skill"` from it by default (or document that
users who defer it accept the model needing an extra discovery step before
it can even see the skill index).

## 6. Summary of division of responsibility

| Concern | Owner |
|---|---|
| Discover `.md`/`SKILL.md` files, parse frontmatter, expand `$ARGUMENTS`/`$1..$9`/`$CWD`/`$SKILL_DIR`, resolve skill-vs-skill collisions | `skills.ts` (`loadSkills`) — unchanged |
| Turn a `Skill` into a slash command (`/name`) | `runtime.ts`'s existing `skillCommand` — unchanged |
| Turn the same `Skill[]` into a model-invoked tool (`skill`), with a name index, near-miss suggestions, and body truncation | `skill-tool.ts` (`createSkillTool`) — new |
| Add `createSkillTool({ registry: () => skills })` to `baseTools`, gated by `config.skills.modelInvoked` | orchestrator edit in `runtime.ts`, §2 |
| Reserve the `"skill"` tool name against extension/agent collisions | orchestrator edit to `BUILT_IN_TOOL_NAMES`, §4 |
| Define and default the `skills.modelInvoked` config key | orchestrator edit to `config.ts`, §3 |
