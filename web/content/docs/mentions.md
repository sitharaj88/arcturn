---
title: "@-mentions & images"
description: Fuzzy file completion in the prompt editor, plus inline file content and image attachments.
section: Core concepts
order: 4.3
---

## Typing `@` to reference a file

Type `@` anywhere in the prompt — it's a completion trigger on any line of a multi-line
prompt, not just the first one. Arcturn walks the working directory, skipping `.git`,
`node_modules`, `dist`, and anything the workspace root's `.gitignore` excludes (a small
engine: `*` wildcards and the anchored-vs-anywhere distinction a plain entry like
`dist/` needs, but no negation and no `**`). The walk is capped at **20,000 files** and
cached for **5 seconds**, so typing quickly doesn't re-walk the tree on every keystroke.

Up to **ten** suggestions are ranked by fuzzy subsequence match against the path: every
matched character scores a point, a match right after a path boundary (`/`, `.`, `-`, `_`,
or the start of the string) scores five extra points, and a run of consecutive matched
characters scores an increasing bonus for each consecutive character. Shorter candidate
paths also get a small tie-breaking bonus (`max(0, 40 - length) * 0.05`). With an empty
query (just typed `@`), suggestions are the ten shortest paths instead, sorted
alphabetically as a tiebreak. A path containing whitespace is inserted pre-quoted:

```text
@"docs/release notes.md"
```

## What happens on submit

Right before the prompt reaches the agent, every `@path` token in the text is expanded —
in the TUI, in `-p`/`--print` non-interactive runs, and anywhere else a prompt is
submitted, so behavior is identical across every entry point. The `@token` itself is
**never removed or rewritten** — the model still sees exactly what you typed — this only
appends content or attaches images alongside it:

- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) under **5MB** are read and attached
  as vision content blocks. Over the cap, the token is left as-is and a `(too large)` note
  is appended to the prompt text instead of the file's bytes.
- **Every other file** up to **2MB** is read as UTF-8 and appended at the end of the
  prompt as a fenced block, itself capped at **2000 lines / 200KB** with a truncation
  marker (`… truncated (2000 line / 200KB cap)`) when either limit hits. A file over 2MB
  is never buffered at all — the token is left as-is with a `(too large to inline)` note.
- **Anything that doesn't resolve** — a path that doesn't exist, a directory, an absolute
  path elsewhere, or `../` traversal outside the working directory — is left completely
  untouched. No note, no error. This is also why `someone@example.com` in a sentence is
  never mistaken for a mention: a mention only starts at an `@` preceded by whitespace or
  the start of the string.

```text
Fix the null check in @src/agent.ts and compare the result against @docs/before.png
```

Here `src/agent.ts`'s content is appended as a fenced code block, and `before.png` (if
under 5MB) is attached as an image the model can actually look at.

### How a mention's path is found

A mention's path is everything after `@` up to the next whitespace character, or — if
what immediately follows `@` is a double quote — everything up to the matching closing
quote (an unterminated quote runs to the end of the string). Both forms are recognized on
submit exactly as they were during completion.

### Path safety

Resolution happens in two steps, both of which must pass:

1. **Lexical containment** — the path is resolved against the working directory and must
   equal it or fall under it; `../` traversal outside the root is rejected immediately.
2. **Real-path containment** — because a symlink *inside* the workspace can still point
   outside it, the final check compares `realpath()` of both the root and the resolved
   target. A mention is only expanded if the real, symlink-resolved path also stays under
   the real root.

Both checks fail closed: any error (a broken symlink, a permission error) is treated as
"does not resolve," which — per the rule above — leaves the mention completely untouched
rather than erroring.

## Extending completion

`createFileMentionSource(cwd, extraSources)` accepts additional namespaced sources —
the extension point future MCP-resource mentions (e.g. `@mcp:some-resource`) plug into.
A source whose `prefix` matches the start of the typed query is consulted instead of the
workspace file walk, and the remainder of the query is fuzzy-matched against its items'
`label`:

```json
{
  "prefix": "mcp:",
  "items": [
    { "value": "@mcp:design-doc", "label": "mcp:design-doc", "description": "Figma spec" }
  ]
}
```

A source's `items()` is synchronous — sources that need to fetch data asynchronously
should keep a warm cache and return from it, the same way the workspace walk itself is
cached for 5 seconds rather than re-walked per keystroke.

## Where this fits

`createFileMentionSource` implements the narrow `{ getSuggestions(prefix) }` shape rather
than the TUI's full `AutocompleteProvider`, so it stays trivially testable in isolation;
wiring it into the prompt editor is a thin adapter in the CLI's TUI wiring. `expandMentions`
runs once, over the final submitted text, in both the interactive TUI and `arcturn -p`
non-interactive mode (see [Getting started](/docs/getting-started#non-interactive-use)) —
one implementation, so a script piping a prompt through `-p` sees exactly the same
expansion a person typing in the terminal would.
