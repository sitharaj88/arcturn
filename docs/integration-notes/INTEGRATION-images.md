# Integrating inline terminal images

This describes how to wire `packages/tui/src/images.ts` (new, standalone — no
existing file was touched) into the rest of arcturn. Nothing below has been applied yet;
it's a plan for whoever picks this up next.

## 1. Export from `packages/tui/src/index.ts`

Add a new export block, alongside the existing `ANSI`, `Components`, `Terminal`,
etc. sections (pick any consistent spot, e.g. after the `Width, wrapping,
truncation` block):

```ts
/* Inline images -------------------------------------------------------------- */
export {
  detectImageSupport,
  encodeItermImage,
  encodeKittyImage,
  type ImageDetectionEnv,
  imagePlaceholderLines,
  type ImageSupport,
  type ItermImageOptions,
  type KittyImageOptions,
  renderImage,
  type RenderImageOptions,
} from "./images.js";
```

That's the only change `index.ts` needs — `images.ts` has no dependency on any other
new surface, only on the existing `ESC`/`BEL` (from `./ansi.js`) and `stringWidth`
(from `./width.js`).

## 2. Wire into the CLI's `TranscriptFormatter`

`packages/cli/src/display.ts` currently throws image content blocks away as text,
in exactly two places — both identical one-liners inside `textOf`:

```ts
// packages/cli/src/display.ts:60 and :246
.map((block) => (block.type === "text" ? block.text : `[${block.mimeType} image]`))
```

`block` here is a `ToolResultMessage["content"]` entry; the image variant is
`ImageContent` (`packages/types/src/messages.ts`): `{ type: "image", data: string
/* base64 */, mimeType: string }`.

To render it inline instead of printing the bracketed placeholder:

```ts
import { detectImageSupport, renderImage } from "@arcturn/tui";

function textOf(content: ToolResultMessage["content"], support: ImageSupport): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      const bytes = Buffer.from(block.data, "base64");
      return renderImage(bytes, {
        support,
        altText: block.mimeType.startsWith("image/")
          ? `${block.mimeType.slice("image/".length)} image`
          : "image",
      });
    })
    .join("\n");
}
```

`support` should be computed once per process (`detectImageSupport()`, no args —
it reads `process.env`) and threaded down to `textOf`'s two call sites, the same way
`glyphs`/`width` are already threaded through `TranscriptOptions`. A `--no-images`
CLI flag, if wanted, is just `ARCTURN_NO_IMAGES=1` in the spawned environment or an
explicit `support: "none"` override — `detectImageSupport` already honours that env
var.

Only the two `textOf` call sites need to change; nothing else in `display.ts` reads
`ImageContent`.

## 3. The scrollback-vs-live-region constraint (read this before wiring anything)

This is the part that will silently corrupt the terminal if skipped.

Arcturn's TUI (`packages/tui/src/tui.ts`) repaints a bounded "live region" every frame
using differential rendering: it diffs the previous frame's lines against the new
ones and only rewrites the cells that changed, using cursor-relative moves. It has
**no concept of a pixel image occupying rows** — as far as the differential renderer
is concerned, every row is a line of character cells it's free to overwrite,
reflow, or partially redraw.

An image escape sequence (kitty's `ESC _G ... ESC \` or iTerm's `ESC ] 1337 ; File=
... BEL`) does not behave like a line of text:

- It place pixels starting at the cursor's current position and extends down/right
  from there, consuming terminal rows the renderer doesn't know about.
- If the differential renderer redraws over or through those rows on the next
  frame — e.g. because a spinner ticked, or the todo widget updated — it will
  move the cursor into the middle of the image, overwrite part of it with text,
  or in the worst case (kitty) leave a placement whose backing cell region no
  longer matches what's on screen, corrupting subsequent redraws in that area.

**The fix used throughout arcturn: images are only ever written to scrollback, via the
same `Terminal.write()` path the CLI already uses to print finished transcript
lines (the "print once, never touch again" lines that scroll up and off the live
region) — never as content inside a `Component` that `TUI`'s renderer owns and
redraws.**

Concretely:

- `renderImage(...)`'s escape-sequence output should be written directly with
  `terminal.write(seq)` (or `process.stdout.write`, depending on which layer you're
  in) at the moment a tool result is finalized and appended to the transcript —
  the same moment plain-text tool output is printed — not stored in a `Component`
  tree that gets redrawn.
- If a caller needs the *live* region to reserve visual space for an image that's
  about to be printed above it (e.g. so a status widget doesn't jump when the image
  appears), use `imagePlaceholderLines(rows, label)` to get plain text lines of the
  correct `stringWidth` for layout math — but those lines are bookkeeping only, a
  stand-in width/height calculation. They are never a substitute for actually
  printing the image, and the placeholder text itself is safe to put in a
  redrawable component precisely because it's plain text, not an escape sequence.
- Decide `rows` for the placeholder (and `maxRows` for `renderImage`) from a fixed
  policy (e.g. "screenshots render at up to 20 rows") — the protocols don't report
  back how many rows they actually consumed, so arcturn has to pick and enforce it.

In short: **compute the escape sequence with `renderImage`, print it once via
`write()` straight to scrollback, and only ever put its plain-text stand-in
(`imagePlaceholderLines` / the `renderImage` "none" fallback string) inside
anything the renderer might redraw.**

## Files

- `packages/tui/src/images.ts` (new) — `detectImageSupport`, `encodeKittyImage`,
  `encodeItermImage`, `renderImage`, `imagePlaceholderLines`.
- `packages/tui/src/images.test.ts` (new) — 32 tests covering the detection matrix
  (including the `ARCTURN_NO_IMAGES` opt-out and precedence between kitty/iterm
  signals), kitty chunking (multi-chunk flagging, id/columns/rows forwarding, empty
  and 200KB buffers), iTerm sequence shape/size/name/dimensions, `renderImage`'s
  three code paths including maxRows forwarding, and `imagePlaceholderLines`'
  line count, clamping, and uniform-width behavior (including wide-character
  labels).
- Not yet touched, described above for the next change: `packages/tui/src/index.ts`
  (add the export block) and `packages/cli/src/display.ts` (swap the two `textOf`
  bracket-text fallbacks for `renderImage`).
