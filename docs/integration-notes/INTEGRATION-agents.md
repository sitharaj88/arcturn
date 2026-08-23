# Integrating markdown agents

This describes how `packages/cli/src/agents.ts` (new, not yet wired in) plugs
into the existing runtime. Nothing described here has been implemented in
`runtime.ts`, `skills.ts` or the `subagent` tool — those files were
deliberately left untouched. This is the plan for a follow-up change.

## What exists today

`packages/cli/src/agents.ts` exports:

- `interface AgentDef { name; description; systemPrompt; tools?: string[]; model?: string; source: string }`
- `parseAgentFrontmatter(raw: string)` — pure frontmatter/body splitter, exported for tests.
- `loadAgentDefs(roots: readonly string[], warnings: string[], validToolNames?: readonly string[]): Promise<AgentDef[]>`

It discovers `<root>/<name>.md` files (flat, no `SKILL.md`-style folder
variant), parses the same plain `key: value` frontmatter dialect
`packages/cli/src/skills.ts`'s `parseFrontmatter` uses, and returns one
`AgentDef` per file. Behaviour deliberately mirrors `loadSkills`
(`packages/cli/src/skills.ts:278`): a missing root is silently fine, an
empty body is a warning+skip, and later roots win name collisions with a
warning naming both files.

The one addition beyond what skills need is `validToolNames`: when passed,
each entry in a file's `tools:` list is checked against it and unknown
names are dropped with a warning rather than silently kept or rejecting the
whole file. Pass `BUILT_IN_TOOL_NAMES` (`packages/cli/src/runtime.ts:96`)
plus extension tool names, mirroring how `reservedToolNames` is threaded
into `loadExtensions` today (`runtime.ts:753`).

## 1. Discovering agent roots

`buildRuntime` (`packages/cli/src/runtime.ts:719`) already loads skills like
this, right after extensions are loaded (`runtime.ts:760-764`):

```ts
const skills = await loadSkills(
  [...new Set([join(paths.home, "skills"), join(paths.project, "skills")])],
  warnings,
);
extensions.commands.push(...skills.map(skillCommand));
```

Add the analogous call for agents, using the same `paths.home` /
`paths.project` roots (`packages/cli/src/paths.ts` — `ArcturnPaths.home` is
`~/.arcturn` by default, `ArcturnPaths.project` is `<cwd>/.arcturn`) but the `agents`
subdirectory instead of `skills`:

```ts
const agentDefs = await loadAgentDefs(
  [...new Set([join(paths.home, "agents"), join(paths.project, "agents")])],
  warnings,
  [...BUILT_IN_TOOL_NAMES, ...extensions.tools.map((t) => t.definition.name)],
);
```

This resolves to `~/.arcturn/agents/<name>.md` and `<cwd>/.arcturn/agents/<name>.md`,
consistent with the `.arcturn/agents/reviewer.md` example in the prompt that
motivated this change. `agentDefs` would need to be threaded into
`ArcturnRuntimeInit` (`runtime.ts:292`) — likely as `agents: Map<string, AgentDef>`
keyed by name — the same way `baseTools`, `themes` and `skills`-derived
commands already flow from `buildRuntime` into the constructed `ArcturnRuntime`.

## 2. Parameterizing `createSubagent`

Today `ArcturnRuntime.createSubagent(task: string): Agent`
(`runtime.ts:506-541`) always builds the same kind of child: read-only tools
unless the parent is in yolo mode, the fixed `subagentSystemPrompt(cwd,
canMutate)` (`runtime.ts:279-290`), and the parent's own model
(`this.model`, set from `resolveModelSpec` in `buildRuntime`).

To let a named markdown agent override any of that, change the signature to
accept an optional second argument:

```ts
createSubagent(task: string, def?: AgentDef): Agent {
  const yolo = this.permissionMode === "yolo";
  const investigative = new Set([...DEFAULT_READ_ONLY_TOOLS, "fetch"]);

  const allowedNames = def?.tools
    ? new Set(def.tools)
    : yolo
      ? undefined // full tool set, minus "subagent" itself (see below)
      : investigative;

  const tools = wrapToolsWithCheckpoints(
    this.#baseTools.filter((tool) => {
      if (tool.definition.name === "subagent") return false; // no recursive delegation
      return allowedNames ? allowedNames.has(tool.definition.name) : true;
    }),
    this.checkpoints,
  );

  const model = def?.model ? resolveModelSpec(def.model, this.env) : this.model;

  return new Agent({
    llm: this.llm,
    model,
    systemPrompt: def?.systemPrompt ?? subagentSystemPrompt(this.cwd, yolo),
    tools,
    cwd: this.cwd,
    maxTurns: SUBAGENT_MAX_TURNS,
    sessionStore: this.store,
    title: `subagent: ${task.slice(0, 60)}`,
    permissions: { /* unchanged */ },
    compaction: compactionOptionsFor(model),
    onPermissionAsk: (request) => this.#ask(request),
  });
}
```

Notes on the pieces that need care:

- **Tool filtering.** `def.tools` is already validated against
  `BUILT_IN_TOOL_NAMES` (plus extension tools) at load time by
  `loadAgentDefs`'s `validToolNames` parameter, so `createSubagent` can trust
  the list and just filter `this.#baseTools` by name — same pattern as the
  existing `investigative`/yolo filter, just driven by `def.tools` when
  present. The existing rule that a non-yolo child never gets mutating tools
  should still win when the *parent* is not in yolo mode: a stricter
  reading is `allowedNames = def?.tools ? new Set(def.tools).intersection(yolo
  ? allBaseToolNames : investigative) : ...` — i.e. a markdown agent's
  `tools:` list should narrow, not widen, what the permission mode already
  allows. This is a security-relevant decision the implementer should make
  deliberately, not copy from the sketch above verbatim.
- **`subagent` tool exclusion.** `runtime.ts:516` already special-cases
  dropping `"subagent"` from the yolo tool list to avoid unbounded
  delegation depth; the same drop should apply to a named agent's tool list
  regardless of what its frontmatter requests.
- **Model resolution.** `AgentDef.model` is a raw string (this module does
  not import `@arcturn/ai`, deliberately, to keep `agents.ts` dependency-
  free like `skills.ts`). The integration point must call
  `resolveModelSpec(def.model, env)` (`runtime.ts:162`, already used for the
  top-level `--model` flag) to turn it into the `ModelSpec` `AgentOptions.model`
  requires (`packages/core/src/agent.ts:49`), and should decide what happens
  on an unknown id — most likely let `ModelResolutionError` propagate so the
  `subagent` tool's `factory` catch block (`packages/core/src/subagent.ts:85-92`)
  turns it into a normal tool-error result rather than crashing the run.
- **System prompt.** `def.systemPrompt` replaces
  `subagentSystemPrompt(...)` outright — a markdown agent is expected to
  describe its own constraints (mutating or not, output shape, etc.) in its
  body, the same way a skill's body is the whole prompt template.

## 3. Exposing an `agent:` parameter on the `subagent` tool

The `subagent` tool itself lives in `@arcturn/core`
(`packages/core/src/subagent.ts`), not in `packages/cli`, so wiring "let the
model pick a named agent" through requires a change to that package — out of
scope for this change (`packages/core` was on the do-not-edit list), but the
shape is straightforward enough to specify:

1. `SubagentToolOptions.factory` (`subagent.ts:22`) currently has signature
   `(task: string) => Agent`. It would need to become
   `(task: string, agentName?: string) => Agent`, with the resolution of
   `agentName` to an `AgentDef` (and the "unknown agent name" error path)
   left to the closure the CLI passes in — `@arcturn/core` should stay
   unaware that markdown agents exist, exactly as it is already unaware of
   skills or extensions.
2. The tool's JSON schema (`subagent.ts:48-64`) would gain an optional
   `agent` property:
   ```ts
   agent: {
     type: "string",
     description:
       "Name of a specialized agent to delegate to (see the available agents " +
       "list in the system prompt), or omit for a general investigative agent.",
   },
   ```
   with `input.agent` read the same defensive way `input.task` and
   `input.description` already are (`subagent.ts:76-80`), and passed through
   to `options.factory(task, agent)`.
3. In `packages/cli/src/runtime.ts`, the `createSubagentTool({ factory })`
   call at `runtime.ts:787-792` becomes:
   ```ts
   createSubagentTool({
     factory: (task, agentName) => {
       if (!runtimeRef) throw new Error("The runtime is not ready yet.");
       const def = agentName ? runtimeRef.agents.get(agentName) : undefined;
       if (agentName && !def) {
         throw new Error(
           `Unknown agent "${agentName}". Available: ${[...runtimeRef.agents.keys()].join(", ")}`,
         );
       }
       return runtimeRef.createSubagent(task, def);
     },
   }),
   ```
   (the thrown error is caught by `subagent.ts:85-92` and surfaced as a
   normal tool error, not a crash).
4. The parent's system prompt (`buildSystemPrompt` /
   `collectSystemPromptContext` in `packages/cli/src/system-prompt.ts`)
   should list the available agent names and descriptions — the same way it
   presumably already surfaces skills/slash-commands — so the model knows
   what it can pass as `agent`. This is the natural place to render
   `agentDefs.map(d => \`- ${d.name}: ${d.description}\`)`.

None of point 3's `packages/core` change or point 4's system-prompt change
is implemented by this commit; `packages/cli/src/agents.ts` only provides
the loader (`loadAgentDefs`) and data shape (`AgentDef`) those changes would
consume.

## Verification performed for this change

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/agents.test.ts   # 14 tests, all passing
npx tsc -p packages/cli/tsconfig.json --noEmit   # clean
npx biome check packages/cli/src/agents.ts packages/cli/src/agents.test.ts  # clean
```
