# `@arcturn/tui` — implementation notes

Working notes for the TUI package: dependencies we deliberately hand-rolled, design
decisions that constrain callers, and known gaps worth revisiting.

## Dependencies

The package ships with exactly the two preinstalled dependencies (`marked`,
`get-east-asian-width`). Everything else that would normally be a package was written
by hand rather than added:

| Would normally be | Hand-rolled as | Notes |
| --- | --- | --- |
| `ansi-regex` | `ANSI_SOURCE` / `stripAnsi` in `src/ansi.ts` | Covers CSI, SGR, OSC-8, private-mode sequences. |
| `chalk` / `picocolors` | `makeStyle` / `fg` / `bg` / `combine` in `src/ansi.ts` | Includes truecolor → 256 → 16 degradation and `NO_COLOR`/`FORCE_COLOR` detection. |
| `string-width` | `stringWidth` in `src/width.ts` | `Intl.Segmenter` graphemes + `get-east-asian-width`. |
| `wrap-ansi` | `wrapText` in `src/width.ts` | Word wrap with SGR state carried across breaks. |
| `cli-truncate` / `slice-ansi` | `truncateToWidth` / `sliceByWidth` | Wide glyphs clipped at a boundary degrade to a space so widths stay exact. |
| `cli-highlight` / `shiki` | `highlightCode` in `src/components/markdown.ts` | Regex heuristic, not a lexer — see "Known gaps". |
| `strip-ansi`, `ansi-escapes` | `src/ansi.ts` | |

**No new dependency is needed to reach feature parity with the brief.** If a future
task wants real syntax highlighting, `shiki` (large, async) or `cli-highlight` (built
on `highlight.js`) would be the candidates; the `MarkdownOptions.highlightCode` flag
and the `codeKeyword`/`codeString`/`codeComment`/`codeNumber` theme tokens are already
the seam for swapping the implementation.

## Design decisions that constrain callers

### 1. A frame never exceeds `terminal.rows`

`TUI.buildFrame` clips a taller frame to its **last** `rows` lines. This is the
invariant that makes the differential renderer safe: the whole rendered block is
always fully on screen, so relative cursor movement (`CSI nA` / `CSI nB`) can always
reach any row.

Other harnesses instead track a viewport offset over an unbounded logical buffer so
that appended content scrolls into the terminal's real scrollback. That is a nicer UX
for a chat transcript, but it needs the extra bookkeeping described in
`tui-main-screen.ts` (`previousViewportTop`, forced-scroll paths, bail-outs to full
redraw). We chose the simpler invariant. **Consequence:** content that scrolls off the
top of a Arcturn frame is gone, not in scrollback. A CLI that wants scrollback should
print transcript lines directly and keep only the live UI inside the `TUI`.

### 2. A line never exceeds `terminal.columns`

Over-wide lines are truncated by default (`TUIOptions.overflow: "truncate"`), or
wrapped with `overflow: "wrap"`. some harnesses throw instead, treating an over-wide line as a
component bug. Truncating is friendlier for a library, and the invariant matters just
as much: one terminal auto-wrap desynchronises every subsequent row calculation.

### 3. Only one overlay at a time

`TUI.setOverlay` holds a single modal, not a z-ordered stack, and restores the
previous focus when dismissed. A stack (as in some harnesses' overlay entries) can be layered
on later without changing the compositing code — `compositeOverlay` already works one
overlay at a time.

### 4. Escape resolution needs a timer

`KeyDecoder` is deliberately pure and synchronous: a lone `ESC` stays buffered because
it may be the start of a longer sequence. `KeyDecoder.flush()` resolves it. `TUI` wires
this to a `setTimeout` (`TUIOptions.escapeTimeout`, default 30 ms). Over SSH a larger
value (100 ms) is advisable; that is the caller's call.

### 5. Widths

- Ambiguous East Asian characters are treated as **narrow** (`ambiguousAsWide: false`),
  matching the Unicode recommendation for unknown context.
- Tabs count as a fixed `TAB_WIDTH` (4) columns rather than tab-stop-relative, and the
  `Editor` expands them to four spaces on insert. True tab stops would require tracking
  the column at which each tab occurs through wrapping and slicing.
- Emoji count as 2 columns, including ZWJ sequences and regional-indicator flags. This
  is deliberately conservative: undercounting causes auto-wrap drift, overcounting only
  leaves a gap.

### 6. Editor coordinates

`EditorState.cursorCol` is a **UTF-16 offset**, not a grapheme index and not a display
column. All movement and deletion operate on grapheme clusters, and `getCursor()`
converts to display columns. Callers implementing `AutocompleteProvider.applyCompletion`
must return UTF-16 offsets.

## Known gaps

1. **Code highlighting is a heuristic.** `highlightCode` recognises comments, string
   literals, numbers and one shared keyword set across all languages. Block comments
   are matched per line, so a `/* … */` spanning lines only highlights its first line.
   Good enough for a chat transcript; not a substitute for a lexer.

2. **SGR state tracking during wrap is approximate.** `SgrState` accumulates escape
   sequences and clears on `CSI 0m`, rather than modelling each attribute and its
   off-code (`22`, `24`, `39`, `49`, …). A wrapped line therefore re-opens every code
   seen since the last reset instead of the minimal set. Output is correct, just not
   minimal. a full ANSI-state tracker is the fuller approach if this ever matters.

3. **Kitty keyboard protocol is decode-only.** `CSI u` and `CSI 27;m;cp ~` sequences are
   parsed, but the package never negotiates the protocol (`CSI > 7 u`) nor distinguishes
   key-release/repeat events — that needs a terminal round-trip and a capabilities
   handshake, which is out of scope for a standalone rendering library.

4. **Mouse reports are swallowed.** SGR mouse sequences (`CSI < … M/m`) are consumed so
   they never leak into the editor as garbage text, but no mouse events are surfaced.

5. **No debounce on async autocomplete.** Every keystroke fires a provider call; stale
   responses are discarded via a request token, but a fast-typing user makes N calls.
   Providers doing filesystem or network work should debounce internally.

6. **`Box.getCursor()` needs a prior `render()`.** Child line offsets are recorded
   during `render`, so calling `getCursor()` before the first render returns
   coordinates based on stale offsets. `TUI` always renders first, so this only bites
   direct callers.

7. **Out of scope, as instructed:** alternate screen, terminal images (Kitty/iTerm2),
   LaTeX rendering, native modifier detection.

## Testing

All 233 tests run headlessly against `TestTerminal`; no test touches a real TTY.
The differential renderer is asserted at the byte level (exact escape sequences) so a
regression in cursor arithmetic fails loudly rather than merely looking wrong.

Colour output is deterministic in tests because `setColorLevel` overrides detection —
tests that assert on plain text set `ColorLevel.None` first.
