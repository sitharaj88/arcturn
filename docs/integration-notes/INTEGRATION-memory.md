# Wiring `memory.ts` into the runtime

This describes the integration for `packages/cli/src/memory.ts` /
`packages/cli/src/memory.test.ts`, which were added as **new, standalone
files** — nothing existing was edited. The pieces below are the concrete
follow-up changes to `runtime.ts`, `system-prompt.ts`, and `commands.ts` that
would wire memory into the live agent. None of them are made in this change;
this doc is the map for whoever does.

## 1. Where the memory directory lives

`paths.ts` already exposes `paths.project` = `<cwd>/.arcturn`. The memory
directory is one join away, no new field needed:

```ts
const memoryDir = join(paths.project, "memory"); // <cwd>/.arcturn/memory
```

(A user-scope `~/.arcturn/memory` is deliberately *not* proposed here — project
memory should stay project-scoped, same reasoning as `paths.projectConfig`
winning over `paths.userConfig`. If cross-project memory is wanted later it's
an additive second directory, not a change to this one.)

## 2. Loading memories and building the tool, in `runtime.ts`

In `createRuntime` (`packages/cli/src/runtime.ts`), memory loads alongside
the other project-scoped state — skills load at line 802-806, agents at
808-813. The natural spot is right after those, before `baseTools` is
assembled at line 853:

```ts
import { createMemoryTool, formatMemoriesForPrompt, loadMemories } from "./memory.js";

// ... alongside the skills/agents loads (~line 806-813):
const memoryDir = join(paths.project, "memory");
const memories = await loadMemories(memoryDir, warnings);
```

`createMemoryTool` needs to go into `baseTools` (line 853-871), next to
`createTodoTool()`/`createPlanTool()`:

```ts
const baseTools: Tool[] = [
  ...defaults.tools,
  createTodoTool(),
  createPlanTool(),
  createMemoryTool({
    dir: memoryDir,
    // See "reload-on-change" below for what this callback can and can't do.
  }),
  createSubagentTool({ /* ... unchanged ... */ }),
  ...extensions.tools,
];
```

Placing it in `baseTools` (rather than `extensions.tools`) means it flows
through the same hook/LSP/verify/checkpoint wrapping as every other built-in,
and its name becomes reserved automatically wherever `BUILT_IN_TOOL_NAMES` is
used as the reserved-name list for extensions/agents (line 795, 811) — see
§4.

## 3. Passing memories into the system prompt

`collectSystemPromptContext` (`packages/cli/src/system-prompt.ts`, line
153-195) is the assembly point. It gets a new optional field on
`SystemPromptContext`:

```ts
// SystemPromptContext, alongside `projectDoc` (line 22-40):
/** Rendered memory notes, when any are stored (see `formatMemoriesForPrompt`). */
memories?: string;
```

And `CollectContextOptions` (line 154-165) grows a matching input, since
memory loading is a filesystem read the caller already did (in `runtime.ts`,
per §2) rather than something `collectSystemPromptContext` should reach out
and do itself — it already follows this pattern for `toolNames` and `agents`,
both computed by the caller and simply threaded through:

```ts
// CollectContextOptions:
/** Pre-rendered memory section (from `formatMemoriesForPrompt`), if any. */
memories?: string;
```

`collectSystemPromptContext`'s body (line 175-195) just carries it through
like `append`/`toolNames` already do:

```ts
const context: SystemPromptContext = {
  cwd: options.cwd,
  platform: process.platform,
  date: now.toISOString().slice(0, 10),
  ...(options.append ? { append: options.append } : {}),
  ...(options.toolNames ? { toolNames: options.toolNames } : {}),
  ...(options.memories ? { memories: options.memories } : {}),
};
```

In `runtime.ts`'s call site (line 907-917):

```ts
const promptContext = await collectSystemPromptContext({
  cwd: paths.cwd,
  ...(config.systemPromptAppend === undefined ? {} : { append: config.systemPromptAppend }),
  toolNames: baseTools.map((tool) => tool.definition.name),
  ...(agentDefs.length === 0 ? {} : { agents: /* ... */ }),
  ...(memories.length === 0 ? {} : { memories: formatMemoriesForPrompt(memories) }),
  ...(options.skipRepoLookup ? { skipRepoLookup: true } : {}),
});
```

`buildSystemPrompt` (line 77-114) renders it as its own section, placed
**after** `# Project instructions (ARCTURN.md)` and **before**
`# User instructions` — memory is durable-but-model-written, so it sits
between the human-authored project doc and the human-authored session
override, in that trust order:

```ts
if (context.projectDoc && context.projectDoc.trim().length > 0) {
  sections.push(/* ... unchanged ... */);
}

if (context.memories && context.memories.trim().length > 0) {
  sections.push(
    `# Memory\nNotes you saved in earlier sessions via the \`memory\` tool. They may be ` +
      `stale — verify before relying on anything safety-critical.\n\n${context.memories.trim()}`,
  );
}

if (context.append && context.append.trim().length > 0) {
  sections.push(/* ... unchanged ... */);
}
```

The "may be stale, verify" line matters: unlike `ARCTURN.md` (user-curated,
presumed accurate) memory is model-written and can drift from reality (a file
gets renamed, a workaround stops being needed). Saying so in the prompt costs
one sentence and heads off the agent treating a six-month-old note as ground
truth.

## 4. `BUILT_IN_TOOL_NAMES` and a glyph

`packages/cli/src/runtime.ts`, line 108-122 — add `"memory"` to the array,
in the same rough position as `todo`/`plan` (state-management tools, not
filesystem-content tools):

```ts
export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "read", "write", "edit", "bash", "grep", "glob", "ls",
  "fetch", "websearch", "symbols",
  "todo", "plan", "memory",
  "subagent",
];
```

This is what makes `memory` a protected name for extension tools (line 795)
and agent tool references (line 811) — both already take
`BUILT_IN_TOOL_NAMES` as their reserved-name list, so nothing else changes.

`packages/cli/src/glyphs.ts` — add an entry to both `tools` maps (line
137-151 fancy, 182-196 ASCII):

```ts
// FANCY_GLYPHS.tools:
memory: "◆", // or a dedicated mark — todo(☰)/plan(✧) are already spoken for;
             // reuse is fine if nothing better fits, but check for other clashes first.

// ASCII_GLYPHS.tools:
memory: "^",
```

(Suggested marks only — pick whatever reads well against the rest of the set;
the important part is that both maps get an entry so `toolDefault`/`"◇"` /
`"-"` isn't the permanent fallback.)

## 5. A `/memory` command

Sketch for `packages/cli/src/commands.ts`, alongside `/clear` (line
245-258) — list/delete through the UI without a model round-trip (`/memory`
alone lists, `/memory delete <slug>` removes one; editing is intentionally
left to "ask the agent to update it" rather than an inline editor, since
`CommandUi` has no multi-line text input):

```ts
{
  name: "memory",
  description: "List or delete saved memory notes (memory write/edit go through the agent)",
  source: "built-in",
  async run({ ui, runtime, args }) {
    const memoryDir = join(runtime.paths.project, "memory");
    const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

    if (sub === "delete") {
      const slug = rest[0];
      if (!slug) {
        ui.notice("warn", "Usage: /memory delete <slug>");
        return;
      }
      // Reuse the tool's own validated delete path rather than unlink-ing
      // directly, so the same slug/path-escape checks apply from the UI too.
      const tool = createMemoryTool({ dir: memoryDir });
      const result = await tool.execute(
        { action: "delete", slug },
        runtime.fakeToolContext(), // see note below
      );
      ui.notice(result.isError ? "error" : "info", (result.content[0] as { text: string }).text);
      return;
    }

    const warnings: string[] = [];
    const memories = await loadMemories(memoryDir, warnings);
    if (memories.length === 0) {
      ui.print("No memories stored.");
      return;
    }
    ui.print(
      memories
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((m) => `${m.slug} — ${m.title} (${m.updatedAt.toISOString().slice(0, 10)})`),
    );
  },
},
```

The `runtime.fakeToolContext()` call is a placeholder: `CommandContext` has
no `ToolExecutionContext` today (commands aren't tool calls), so either (a)
`ArcturnRuntime` grows a small helper that builds a minimal
non-permission-requesting context for commands that want to reuse a tool's
validated logic, or (b) simpler: give `/memory delete` its own direct
`unlink` + the same slug-normalization function, duplicating ~10 lines rather
than threading a fake context through. (b) is probably the better call —
it's a UI-triggered action, not a model tool call, and doesn't need to look
like one.

## 6. Reload-on-change (read this before assuming memory is "live")

**A note the agent writes mid-session is not visible to itself until the
*next* session.** `buildSystemPrompt` runs once, at `createRuntime` time
(line 937); nothing re-renders it after that. `createMemoryTool`'s
`onChange` callback (per its `CreateMemoryToolOptions`) fires after every
write/delete, but wiring it up to actually mutate the live system prompt
means either:

- Re-running `buildSystemPrompt` and pushing the new string into whatever the
  provider client holds as the system prompt for the *next* turn (some
  providers accept a per-request system prompt override, which
  `ArcturnRuntime`/the LLM client would need to support — check `@arcturn/ai`'s
  client interface before assuming this is free), or
- Prompt-caching considerations: `buildSystemPrompt`'s output is presumably
  cached (system prompts are the textbook cache-prefix candidate); changing
  it mid-session busts that cache for every subsequent turn, not just the one
  after the write. `formatMemoriesForPrompt`'s deterministic ordering (§ its
  own docstring) exists precisely so that *unrelated* re-renders (e.g. same
  memory set, different process) don't busts caches — but an actual new note
  necessarily changes the text, so a cache bust on write is unavoidable
  either way, just worth knowing it's not free.

**Simplest honest mitigation:** don't try to make it live. Have the `memory`
tool's result text say so explicitly when it writes
(`"Saved memory \"slug\" — it will be available starting next session."`) —
`handleWrite` in `memory.ts` currently says `Saved memory "slug" (title).`
and could grow that clause — and treat `onChange` as reserved for a
lighter-weight use: e.g. invalidating an in-memory cache the `/memory`
command reads from, or nudging a "you have N unsaved-to-prompt memories"
status line, not re-assembling the system prompt. If true mid-session recall
is wanted later, the honest version is "the agent calls `memory list` again
this turn" (it already can — nothing stops it re-reading its own notes via
the tool, same session), not "the system prompt silently grew."

## Verification performed

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/memory.test.ts   # 31 passed
npx tsc -p packages/cli/tsconfig.json --noEmit   # clean
npx biome check packages/cli/src/memory.ts packages/cli/src/memory.test.ts  # clean
```

No existing file was modified by this change; `runtime.ts`, `system-prompt.ts`,
`commands.ts`, `config.ts`, `glyphs.ts` are all described above but untouched.
