# Wiring `/export` into Arcturn

This is a recipe, not a patch. `packages/cli/src/export.ts` and its test are
the only files this work added; nothing below has been applied to
`commands.ts`, `runtime.ts`, `packages/core`, or anywhere else. It documents
exactly where and how a follow-up change should wire the two together.

## What `export.ts` provides

```ts
import { exportHtml, exportMarkdown, suggestExportFilename } from "./export.js";

const md = exportMarkdown(messages, meta, options);
const html = exportHtml(messages, meta, options);
const filename = suggestExportFilename(meta, "md" /* | "html" */);
```

```ts
interface ExportMeta {
  title?: string;       // document title / <title>; defaults to "Arcturn Session"
  model?: string;        // shown in the header when given
  exportedAt?: string;   // ISO-8601 (or any Date-parseable string); drives the filename
}

interface ExportOptions {
  showThinking?: boolean; // include `thinking` content blocks; default false
}

function exportMarkdown(messages: readonly Message[], meta?: ExportMeta, options?: ExportOptions): string;
function exportHtml(messages: readonly Message[], meta?: ExportMeta, options?: ExportOptions): string;
function suggestExportFilename(meta: ExportMeta, format: "md" | "html"): string;
```

All three are pure functions — no filesystem access, no `Date.now()` calls.
`suggestExportFilename` derives its `yyyy-MM-dd-HHmm` (UTC) component from
`meta.exportedAt`; when that's missing or unparseable it falls back to the
Unix epoch (`1970-01-01-0000`) rather than reading the clock, so a caller
that wants a "now"-based name must pass `exportedAt: new Date().toISOString()`
(or similar) itself — this keeps `export.ts` deterministic and trivially
unit-testable.

Rendering notes a follow-up should know about:

- **Tool calls and results are paired by id.** `export.ts` scans the whole
  `messages` array up front to index every `ToolResultMessage` by
  `toolCallId`, so a `toolCall` content block renders its matching result
  inline (as a fenced/`<pre>` block inside the same collapsed `<details>`),
  regardless of how many other messages sit between the call and its result.
  A `toolResult` with no matching call anywhere in `messages` (e.g. history
  was truncated/compacted before the export slice starts) still renders, as
  its own `## Tool` / `<section class="turn tool">` block, so no data is
  silently dropped.
- **Tool result text is capped at 200 lines** with a trailing
  `… output truncated (N more lines) …` marker (Markdown) or the same text
  inside the `<pre>` (HTML). Truncation is purely line-count based, not size
  based — a follow-up that needs a byte cap too should add it on top, not
  inside `export.ts`.
- **`thinking` blocks are omitted unless `options.showThinking` is `true`.**
  Both formats otherwise render every block: `text`, `toolCall` (paired with
  its result), and — for `UserContent`/`ToolResultContent` — `image` blocks,
  which are always noted as `` `[image]` `` / `[image]` (never inlined; the
  base64 payload never appears in either export).
- **HTML escaping is total.** Every piece of user- or model-authored text
  (message text, tool names, JSON-stringified tool arguments, tool result
  text, thinking text) goes through one `escapeHtml` helper before landing
  in the page — this is what makes `exportHtml` safe to open directly in a
  browser even when a transcript contains `<script>` or `]]>`-shaped
  content from a tool result or a model response.

## 1. Where a `/export` command should live

Follow the shape already used by every other command in
`packages/cli/src/commands.ts` (`SlashCommand: { name, description, run(context) }`,
`context: { runtime, ui, args, commands }` — see `createBuiltInCommands()`).
Sketch:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exportHtml, exportMarkdown, suggestExportFilename } from "./export.js";

const exportCommand: SlashCommand = {
  name: "export",
  description: "Export this conversation to Markdown or HTML (/export [md|html])",
  source: "built-in",
  async run({ runtime, ui, args }) {
    const format = args.trim().toLowerCase() === "html" ? "html" : "md";
    const meta = {
      title: `arcturn session ${runtime.agent.sessionId}`, // or a cwd-derived label — see below
      model: runtime.agent.model.displayName ?? runtime.agent.model.id,
      exportedAt: new Date().toISOString(),
    };
    const content =
      format === "html"
        ? exportHtml(runtime.agent.messages, meta)
        : exportMarkdown(runtime.agent.messages, meta);
    const filename = suggestExportFilename(meta, format);
    const path = join(runtime.cwd, filename); // or paths.home, see §3
    await writeFile(path, content, "utf8");
    ui.notice("info", `Exported to ${path}`);
  },
};
```

Register it alongside the other built-ins returned from
`createBuiltInCommands()` in `commands.ts`.

## 2. Where the messages and metadata come from

- **Messages:** `runtime.agent.messages` (`packages/cli/src/runtime.ts` /
  `packages/core/src/agent.ts`) is already `readonly Message[]` — the exact
  type `exportMarkdown`/`exportHtml` accept. No conversion needed.
- **Model:** `runtime.agent.model` is a `ModelSpec` (`{ id, displayName, ... }`
  from `@arcturn/types`/`@arcturn/ai`); pass `.displayName ?? .id` as
  `meta.model`.
- **`exportedAt`:** the command handler is the right layer to call
  `new Date().toISOString()` — `export.ts` deliberately never does this
  itself (see above), so the orchestrator supplies "now" exactly once, at
  the command boundary, which is also what keeps `export.ts`'s tests
  deterministic.
- **Title:** `Agent` has no public getter for its private `#title` today
  (`packages/core/src/agent.ts`). A follow-up that wants a friendlier title
  than a bare session id should either add a `get title()` accessor to
  `Agent`, or derive one from something already public — e.g. the first
  user message's text (`oneLine(...)` from `format.ts` is already used
  elsewhere in `cli` for exactly this kind of clipping), or the workspace
  directory name (`runtime.cwd`). None of these need a change to
  `export.ts` itself; `ExportMeta.title` is a plain optional string.

## 3. Where the file should be written

`checkpoints.ts`'s integration doc established the convention of storing
session-scoped state under `paths.home` (`~/.arcturn` / `$ARCTURN_HOME`, from
`packages/cli/src/paths.ts`). Two reasonable choices for a follow-up to pick
between:

- **`runtime.cwd`** (the workspace root) — matches what a user of
  Claude Code's `/export` would expect: the file shows up right next to the
  project they're working in.
- **`join(paths.home, "exports", filename)`** — keeps the workspace clean,
  mirrors `~/.arcturn/checkpoints/<sessionId>` and `paths.sessions`, and gives a
  natural place for a future `/export --list` to enumerate past exports.

Either way, `suggestExportFilename(meta, format)` only returns a bare
filename (`arcturn-session-<yyyy-MM-dd-HHmm>.<md|html>`) — the command is
responsible for `join`-ing it with whichever directory is chosen, and for
`mkdir`-ing that directory first if it might not exist yet (`paths.ts`
already has helpers for this pattern — check what `checkpoints.ts`'s
`createCheckpointStore` does with `mkdir(dir, { recursive: true })` before
its first write, and mirror that).

## 4. Optional: a `--thinking` flag

`ExportOptions.showThinking` is wired but nothing in the sketch above
exposes it. A natural extension: `/export md --thinking` /
`/export html --thinking`, parsed out of `args` the same way other commands
in `commands.ts` tokenize their argument string, then passed through as
`{ showThinking: true }` to `exportMarkdown`/`exportHtml`.

## Summary of the follow-up work (not done here)

1. `commands.ts`: register an `/export [md|html] [--thinking]` `SlashCommand`
   per the sketch in §1, parsing `args` for format + the optional flag.
2. Decide and implement the write-target directory (§3) — `runtime.cwd` vs.
   `~/.arcturn/exports/<sessionId>/` — including `mkdir(..., { recursive: true })`
   before the first write.
3. Optionally add a public `get title()` (or similar) to `Agent` in
   `packages/core/src/agent.ts` if a friendlier default title than the
   session id is wanted; otherwise derive one from the first user message
   or `runtime.cwd` at the command layer.
