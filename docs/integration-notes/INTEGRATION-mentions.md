# Wiring `@`-mentions into the interactive app

This describes how the orchestrator should connect `packages/cli/src/mentions.ts`
(`createFileMentionSource`, `expandMentions`) to `packages/cli/src/interactive/app.ts`.
Only `mentions.ts` and `mentions.test.ts` were added for this feature —
`packages/tui/src/components/editor.ts` needed **no changes**: its autocomplete
trigger already fires mid-line (see "Why no editor.ts changes were needed"
below), so `app.ts` is the only file that needs editing, and it is out of my
lane. Nothing else should change.

## What `mentions.ts` produces

```ts
export interface MentionSuggestion {
  readonly value: string;        // "@rel/path", pre-quoted if the path has spaces
  readonly label: string;
  readonly description?: string;
}

export interface MentionExtraSource {
  readonly prefix: string;       // e.g. "mcp:" — namespace the query must start with
  items(): readonly MentionSuggestion[];
}

export interface FileMentionSource {
  getSuggestions(prefix: string): MentionSuggestion[];
}

export function createFileMentionSource(
  cwd: string,
  extraSources?: readonly MentionExtraSource[],
): FileMentionSource;

export interface ExpandedMentions {
  text: string;            // original text, with injected file content appended
  images: ImageContent[];  // from "@arcturn/types"; [] when there were none
}

export async function expandMentions(text: string, cwd: string): Promise<ExpandedMentions>;
```

`createFileMentionSource` deliberately takes the *narrow* shape
(`getSuggestions(prefix)`) rather than the tui's full `AutocompleteProvider`
(`getSuggestions(context)`), so it stays independent of the tui and trivially
unit-testable. Adapting it into the editor's provider interface is a
one-line wrapper — see step 2.

## Step 1 — construct the mention source once

In `InteractiveApp`'s constructor (`packages/cli/src/interactive/app.ts`,
around line 114, near where `this.#commands` is built), create one mention
source for the app's lifetime:

```ts
import { createFileMentionSource, expandMentions } from "../mentions.js";
// ...
this.#mentions = createFileMentionSource(options.runtime.cwd);
```

Add `readonly #mentions: FileMentionSource;` to the field list (import the
type too). `ArcturnRuntime.cwd` (`packages/cli/src/runtime.ts:316`) is the
workspace root to pass — it's already a public readonly field on the
runtime the app holds.

If/when MCP resource mentions are added, pass a second argument:
`createFileMentionSource(options.runtime.cwd, [mcpResourceSource])` where
`mcpResourceSource` implements `{ prefix: "mcp:", items() }`.

## Step 2 — register `@` alongside `/` on the `PromptEditor`

`app.ts` currently builds its `PromptEditor` (lines 131–160) with:

```ts
autocompleteTriggers: ["/"],
autocomplete: {
  getSuggestions: (context) => {
    if (!context.prefix.startsWith("/")) return [];
    if (context.cursorLine !== 0) return [];
    const matches = this.#commands.complete(context.prefix);
    if (matches.length === 1 && `/${matches[0]?.name}` === context.prefix) return [];
    return matches.map((command) => ({ /* ... */ }));
  },
},
```

The `Editor`'s trigger detection (`packages/tui/src/components/editor.ts`,
`requestCompletions` + `currentToken`) already works mid-line — `currentToken()`
takes the trailing non-whitespace run of the current line up to the caret, so
typing `fix the bug in @src/ed` triggers exactly as `@` at the start of the
input would. `acceptCompletion()` also already replaces only that trailing
run (using `suggestionPrefix.length` to find the splice point), so no new
"replace only the current token" logic is needed. This is why no changes to
`editor.ts` were required — it was designed for this from the start; only
`app.ts`'s trigger list and dispatch callback are still slash-only.

Change the two options to dispatch on the trigger character:

```ts
autocompleteTriggers: ["/", "@"],
autocomplete: {
  getSuggestions: (context) => {
    if (context.prefix.startsWith("@")) {
      return this.#mentions.getSuggestions(context.prefix);
    }
    if (!context.prefix.startsWith("/")) return [];
    if (context.cursorLine !== 0) return [];
    const matches = this.#commands.complete(context.prefix);
    if (matches.length === 1 && `/${matches[0]?.name}` === context.prefix) return [];
    return matches.map((command) => ({ /* unchanged */ }));
  },
},
```

`createFileMentionSource(...).getSuggestions` is synchronous (it walks the
filesystem with sync `fs` calls and caches the listing for 5s), so no
`Promise` handling changes are needed in `requestCompletions` — it already
accepts a sync-or-async return.

Note the existing slash branch's `if (context.cursorLine !== 0) return [];`
guard does **not** apply to mentions — file mentions should work on any line
of a multi-line prompt, so don't copy that guard into the `@` branch (the
code above already doesn't).

## Step 3 — expand mentions right before `agent.prompt()`

In `InteractiveApp.#onSubmit` (`app.ts`, around line 496–532), the final
branch currently does:

```ts
try {
  await this.#runtime.agent.prompt(trimmed);
} catch (error) {
  // ...
}
```

`expandMentions` must run on `trimmed` here — after the slash-command and
steering branches (mentions in a `/command` or a steering message are not
expanded; only a genuine new prompt is), and before the call to
`agent.prompt`:

```ts
try {
  const expanded = await expandMentions(trimmed, this.#runtime.cwd);
  await this.#runtime.agent.prompt(
    expanded.images.length > 0 ? [text(expanded.text), ...expanded.images] : expanded.text,
  );
} catch (error) {
  // ... unchanged
}
```

`text` is `@arcturn/core`'s `text(value: string): TextContent` helper
(`packages/core/src/util/content.ts`, re-exported from the package root) —
add it to the existing `import type { ArcturnRuntime } from "../runtime.js"`-style
import block, e.g. `import { text } from "@arcturn/core";` (check what
`app.ts` already imports from `@arcturn/core`, if anything, and merge).

### Why the conditional instead of always building an array

`Agent.prompt` (`packages/core/src/agent.ts:347`) accepts
`string | UserContent[]`:

```ts
async prompt(input: string | UserContent[]): Promise<void>
```

and normalizes internally via `toUserContent`
(`packages/core/src/util/content.ts:47`), which wraps a bare string in
`[{ type: "text", text: input }]`. So passing `expanded.text` directly when
there are no images is exactly equivalent to wrapping it in `[text(...)]` —
the conditional above is a minor optimization, not a correctness requirement.
It is fine (and arguably simpler) to always pass
`[text(expanded.text), ...expanded.images]` instead, if that reads better
alongside the rest of `#onSubmit`.

### Exact `UserContent`/`ImageContent` shape

From `packages/types/src/messages.ts`:

```ts
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;      // base64-encoded bytes, no "data:" URI prefix
  mimeType: string;   // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

export type UserContent = TextContent | ImageContent;
```

`expandMentions`'s `images` array is already exactly
`ImageContent[]` — no conversion needed, just spread it after a `text(...)`
block.

## Behavioral notes for whoever wires this in

- `expandMentions` **never removes or rewrites `@token`s from the visible
  text** — it only appends injected file content (or a `"(too large)"` note
  for oversized images) at the end. The model sees both the user's original
  wording and the injected content.
- Nonexistent paths, directories, and anything resolving outside `cwd`
  (`../` traversal, or an absolute path elsewhere) are left completely
  untouched — no error, no note. This is deliberate: a `@` that was never
  meant as a file mention (an email-like token, or "email me@ 5pm") should
  not break the run.
- Double-quoted mentions (`@"path with spaces.txt"`) are supported in
  `expandMentions`'s parser. `createFileMentionSource`'s suggestion `value`
  pre-quotes any path containing whitespace (`@"my file.txt"`), so accepting
  a suggestion and later submitting round-trips correctly through
  `expandMentions`. Note the *live* dropdown itself can't be triggered
  mid-path-with-spaces (the editor's `currentToken()` stops at the first
  whitespace), so a user typing a quote-and-space path manually won't see
  suggestions update once they hit the space — only pre-existing
  suggestions accepted before the space, or paths without spaces, benefit
  from the dropdown. This is an editor-level limitation, not a mentions.ts
  one; it wasn't worth extending `editor.ts`'s token detection for.
- The file walk ignores `.git`, `node_modules`, `dist` unconditionally, plus
  whatever the workspace-root `.gitignore` adds (simple `*`-wildcard
  patterns only — no negation, no `**`). It's cached for 5 seconds per
  `FileMentionSource` instance, so create one per app/session, not per
  keystroke.
