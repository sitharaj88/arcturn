/**
 * The webview's own script and stylesheet, as strings.
 *
 * They are inlined into the page under a nonce rather than shipped as files
 * under `media/` deliberately: the CSP in `webview-html.ts` grants
 * `script-src 'nonce-…'` and nothing else, and inlining means the sidebar has
 * no packaging dependency at all — esbuild bundles this module into
 * `dist/extension.js` and there is no second asset that a `.vscodeignore`
 * could drop from the VSIX.
 *
 * ## The rules the script keeps, all checked by `webview-html.test.ts`
 *
 * 1. **No HTML from strings.** Every node is built with `createElement` /
 *    `createElementNS` and filled with `textContent`. Assistant prose, tool
 *    arguments, tool results, model ids and session titles are all
 *    model- or engine-controlled text; the only safe way to render them is as
 *    text, so `innerHTML` and friends appear nowhere. This is also why the
 *    markdown renderer walks a *tree* (`webview-markdown.ts`) instead of
 *    concatenating tags: with no string of HTML anywhere, there is no place an
 *    injection could land.
 * 2. **Inbound messages are validated.** `KNOWN_HOST_MESSAGES` gates every
 *    `message` event before a field of it is read, and each branch rebuilds
 *    the fields it needs rather than trusting the shape — the mirror image of
 *    `parseWebviewMessage` on the host side.
 * 3. **No inline style attributes.** Not one `element.style.x = y` and no
 *    `setAttribute("style", …)`, so nothing here depends on how a host chooses
 *    to read `style-src` against CSSOM. The auto-growing composer, which is
 *    the one place that classically needs a measured pixel height, uses the
 *    grid/`attr()` mirror instead — see `.grow` in the stylesheet.
 *
 * Both strings must avoid a literal `</script` / `</style` sequence, which
 * would terminate the inline block early. They are written with `String.raw`
 * so that escapes belong to the *webview's* parser rather than to TypeScript's
 * — a `\d` in a regex has to survive this file intact — which in turn means a
 * literal backtick would end the template, so the shared `TICK` constant is
 * spelled as an escape.
 *
 * ## What lives here and what does not
 *
 * Anything that is a decision — how markdown parses, how the model list orders
 * and filters, how the session list orders and searches, how blocks group into
 * turns, what one line of a tool call says — lives in `webview-markdown.ts`,
 * `webview-models.ts`, `webview-sessions.ts` and `webview-transcript.ts`, each
 * shipped as source and each driven directly by a unit test. What is left in this file is the part that can only be checked
 * by looking at it: element creation, event wiring, and CSS.
 */

import { COMMAND_MENU_SOURCE } from "./webview-commands.js";
import { CONTEXT_SOURCE } from "./webview-context.js";
import { MARKDOWN_SOURCE } from "./webview-markdown.js";
import { MODEL_LIST_SOURCE } from "./webview-models.js";
import { PERMISSION_SOURCE } from "./webview-permission.js";
import { SESSION_LIST_SOURCE } from "./webview-sessions.js";
import { TRANSCRIPT_SOURCE } from "./webview-transcript.js";

/**
 * The sidebar's stylesheet.
 *
 * Every colour is a `--vscode-*` token, so light, dark and high-contrast are
 * the theme's problem and not this file's. Where a token is not guaranteed
 * across themes it is given a fallback that is (`--vscode-panel-border`,
 * `currentColor`) rather than a hex value.
 *
 * Type scale is derived from `--vscode-font-size` in `em`, so the panel
 * follows the editor's own zoom and accessibility settings instead of pinning
 * pixels.
 *
 * ## Motion
 *
 * Every animation in here is a sentence about state, and every one is
 * transform and opacity only — nothing that makes the compositor ask the
 * layout engine a question. None of them runs while the panel is idle: the
 * two infinite ones (the streaming caret, the working dots) live on elements
 * that only exist, or are only un-hidden, while a run is in flight.
 *
 * The rule they all obey is that **nothing already on screen re-animates**.
 * That is the mistake that makes a streaming panel strobe: an entrance on the
 * rendered markdown would replay on every delta, dozens of times a second,
 * for the length of a long answer. So entrances go on elements at the moment
 * they are *created* — a turn, a status badge — and never on anything the
 * reconciler repaints in place. `webview-render.test.ts` pins that: it drives
 * two deltas through one text block and asserts nothing inside it carries an
 * entrance class.
 *
 * The caret reads better than it is written, by accident of the same
 * reconciler. The markdown subtree is rebuilt on each delta, so the blink
 * restarts from its visible step every few milliseconds — solid while tokens
 * are landing, blinking only when the stream pauses, which is exactly the
 * distinction a reader wants.
 *
 * `prefers-reduced-motion: reduce` turns all of it off in one universal rule
 * rather than a list of names, because a per-animation opt-out is one new
 * `@keyframes` away from being wrong. Durations collapse to 1ms rather than
 * to `none`, so every animation still *lands on its end state* — a fill-mode
 * entrance stays visible, a fold stays folded — which is what keeps the panel
 * entirely usable rather than merely still. Nothing is hidden to stop it
 * moving. `webview-html.test.ts` asserts the shape of that block.
 *
 * ## Delete, on a session row
 *
 * The row stays the `option` the listbox owns and `aria-activedescendant`
 * points at, so the delete button rides beside it in a `role="presentation"`
 * wrapper rather than inside it — a nested button is markup a browser
 * silently takes apart. It is positioned over the row's reserved right
 * margin, so a click on it is never a click on the row underneath: deleting
 * and opening are two intents and they do not share a target.
 *
 * It is revealed with `opacity`, never `display`, because a control that only
 * exists on hover does not exist for a keyboard user. It stays in the tab
 * order and in the accessibility tree at all times, shows itself on hover, on
 * focus anywhere in the row, and whenever the row is the arrow-key selection
 * — and under forced colours, where a 0-opacity control would be invisible
 * even to a mouse, it is simply always on.
 */
export const SIDEBAR_STYLE = `
:root {
  color-scheme: light dark;
  --arc-gap: 8px;
  --arc-radius: 6px;
  --arc-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  --arc-muted: var(--vscode-descriptionForeground);
  --arc-surface: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  --arc-code-bg: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
  --arc-ok: var(--vscode-charts-green, var(--vscode-testing-iconPassed, currentColor));
  --arc-warn: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, currentColor));
  --arc-err: var(--vscode-editorError-foreground, var(--vscode-charts-red, currentColor));
  /*
   * The brand. Arcturn is named for an orange giant, and the site's accent is
   * that amber — but a fixed colour cannot be right on every backdrop, so it
   * is a token with a light-theme value rather than one constant. These are
   * the site's own accent tokens, lifted from globals.css unchanged, plus the
   * on-accent colour that keeps the send arrow legible against them. The
   * values live in the declarations below and are not repeated here: a colour
   * written twice is a colour that will disagree with itself.
   *
   * It is used only where identity belongs — the mark, the assistant's avatar,
   * the composer's focus ring, the send button. Links stay the theme's link
   * colour and a running tool stays the theme's blue: those are the editor's
   * vocabulary, and repainting them would be branding something that is not
   * ours to brand.
   */
  --arc-brand: #f2af48;
  --arc-brand-hover: #fad185;
  --arc-brand-on: #241a0a;
}

/*
 * VS Code stamps the workbench theme kind on the body, which is the only way
 * a webview can tell light from dark without guessing: the same amber that
 * reads as warm on a dark editor is a pale smear on a white one, so light
 * takes the site's darker accent and puts white on it.
 */
body.vscode-light {
  --arc-brand: #8a5216;
  --arc-brand-hover: #6f410f;
  --arc-brand-on: #ffffff;
}

/*
 * High contrast is not a palette to decorate. Both HC themes hand the border
 * and focus colours back to the theme, because a user in high contrast chose
 * those colours over anyone's brand — and the forced-colors rule below does the same
 * for the button.
 */
body.vscode-high-contrast, body.vscode-high-contrast-light {
  --arc-brand: var(--vscode-focusBorder, currentColor);
  --arc-brand-hover: var(--vscode-focusBorder, currentColor);
  --arc-brand-on: var(--vscode-button-foreground, currentColor);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  font-weight: var(--vscode-font-weight, normal);
  line-height: 1.5;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  overflow: hidden;
}
#root { position: relative; display: flex; flex-direction: column; height: 100vh; min-height: 0; }
.hidden { display: none !important; }
svg { flex: none; display: block; }

/* ---- header ---------------------------------------------------------- */

#header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--arc-border);
  background: var(--vscode-sideBarSectionHeader-background, transparent);
}
.brand { display: flex; color: var(--arc-brand); }
.session { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.session-title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-sub {
  font-size: 0.85em;
  color: var(--arc-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cost {
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
  color: var(--arc-muted);
  padding: 1px 6px;
  border: 1px solid var(--arc-border);
  border-radius: 999px;
  white-space: nowrap;
}
.icon-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  background: transparent;
  cursor: pointer;
}
.icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.icon-button:disabled { opacity: 0.4; cursor: default; }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

/* ---- connection card ------------------------------------------------- */

#banner {
  margin: 8px;
  padding: 10px;
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--arc-border));
  background: var(--vscode-inputValidation-warningBackground, var(--arc-surface));
  border-radius: var(--arc-radius);
}
#banner .banner-text { display: block; margin-bottom: 8px; white-space: pre-wrap; }
.engine-output {
  margin: 0 0 8px;
  padding: 6px 8px;
  max-height: 12em;
  overflow: auto;
  border-left: 2px solid var(--arc-err);
  background: var(--arc-code-bg);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
button.text-button {
  font: inherit;
  padding: 3px 10px;
  border: none;
  border-radius: 3px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  cursor: pointer;
}
button.text-button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}
button.text-button:hover { background: var(--vscode-button-hoverBackground); }
button.text-button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* ---- transcript ------------------------------------------------------ */

#transcript {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0 12px;
  outline-offset: -2px;
}
/*
 * Who spoke is carried by shape, not by a caption.
 *
 * This replaced a YOU / ARCTURN header on every single turn, for two reasons.
 * A caption above every message is chrome the eye has to step over on the way
 * to the content, twice per exchange, forever. And in a 380px sidebar the
 * answer needs the full width: code, diffs and tool rows all lose more to a
 * label column than the label was ever worth. The name is not gone, it moved
 * to aria-label on the section, where a screen reader still announces it and
 * a sighted reader is not charged for it.
 */
.turn { position: relative; padding: 2px 12px; }
.turn-user { padding-top: 14px; }
.turn-assistant { padding-bottom: 16px; }
.turn-user .turn-body {
  padding: 8px 10px;
  border: 1px solid var(--arc-border);
  border-radius: 10px;
  background: var(--arc-surface);
}
.turn-body > * + * { margin-top: 6px; }
/*
 * The answer, set apart from the working.
 *
 * Narration, six tool cards and the conclusion all sat on the same 6px, so
 * the eye had nothing to aim at and re-read the tool stack looking for the
 * point. This is rhythm rather than decoration: no new colour, no new weight,
 * just the gap that says the run finished and this is what came of it.
 */
.turn-assistant .turn-body > .text-block:last-child:not(:first-child) { margin-top: 12px; }

/*
 * The end of a turn, said once and left there.
 *
 * The hairline sweep underneath is a moment; this is the record. The time is
 * only ever the time this panel watched pass: a turn replayed out of session
 * history was never observed running here, so it says "Done" and stops rather
 * than inventing a number that would look exactly as authoritative.
 */
.turn-foot {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 10px;
  font-size: 0.85em;
  color: var(--arc-muted);
}
.turn-time { flex: none; }
.turn-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--arc-muted);
  font-size: inherit;
  opacity: 0;
  transition: opacity 120ms ease, color 120ms ease;
}
.turn:hover .turn-copy, .turn-copy:focus-visible { opacity: 1; }
.turn-copy:hover {
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
.turn-copy svg { width: 13px; height: 13px; }

/*
 * An edit, as the change it makes.
 *
 * Removed above added, tinted out of the theme's own pass and fail colours so
 * it survives a light editor, and with the sign kept in the gutter as well as
 * the tint so it still reads when the colour does not — on a colour-blind
 * reader, in high contrast, or in a screenshot.
 */
.diff {
  margin: 0;
  max-height: 22em;
  overflow: auto;
  border-radius: 4px;
  background: var(--arc-code-bg);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.86em;
  line-height: 1.5;
}
/* A blank line in a diff is a line: it keeps its row rather than collapsing. */
.diff-line { display: flex; align-items: baseline; min-height: 1.5em; }
.diff-sign {
  flex: none;
  width: 1.3em;
  padding-left: 5px;
  color: var(--arc-muted);
  user-select: none;
}
.diff-text {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.diff-del { background: color-mix(in srgb, var(--arc-err) 14%, transparent); }
.diff-del .diff-sign { color: var(--arc-err); }
.diff-add { background: color-mix(in srgb, var(--arc-ok) 14%, transparent); }
.diff-add .diff-sign { color: var(--arc-ok); }
.diff-more {
  display: block;
  padding: 4px 8px 5px;
  color: var(--arc-muted);
  font-style: italic;
}
.block-user { white-space: pre-wrap; overflow-wrap: anywhere; }

/* markdown */
.md :where(p, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, hr) { margin: 0; }
.md > * + * { margin-top: 8px; }
.md li > * + *, .md blockquote > * + * { margin-top: 5px; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
  font-weight: 600;
  line-height: 1.3;
  margin-top: 12px;
}
.md h1 { font-size: 1.25em; }
.md h2 { font-size: 1.15em; }
.md h3 { font-size: 1.05em; }
.md h4, .md h5, .md h6 { font-size: 1em; }
.md p { white-space: pre-wrap; overflow-wrap: anywhere; }
.md ul, .md ol { padding-left: 1.35em; }
.md li + li { margin-top: 2px; }
.md li.task { list-style: none; margin-left: -1.2em; }
.md li.task .box { display: inline-block; width: 1.1em; color: var(--arc-muted); }
.md li.task.done { color: var(--arc-muted); }
.md blockquote {
  padding-left: 10px;
  border-left: 2px solid var(--arc-border);
  color: var(--arc-muted);
}
.md hr { border: none; border-top: 1px solid var(--arc-border); }
.md a { color: var(--vscode-textLink-foreground); text-decoration: none; overflow-wrap: anywhere; }
.md a:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground); }
/*
 * Three kinds of code, three looks: inline is a bordered chip in the run of
 * prose, a fence is a titled card, tool output is a rule-marked pre under an
 * uppercase label. They used to share one background and blur together.
 */
.md code.inline {
  padding: 0.05em 0.35em;
  border: 1px solid color-mix(in srgb, var(--arc-border) 45%, transparent);
  border-radius: 3px;
  /*
   * Half-strength fill. At full strength this is a solid dark slab inside a
   * sentence, and a file path mentioned in passing ends up drawn heavier than
   * the send button — a phrase should not outrank a control.
   */
  background: color-mix(in srgb, var(--arc-code-bg) 55%, transparent);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.92em;
  overflow-wrap: anywhere;
}
.code-block {
  position: relative;
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius);
  background: var(--arc-code-bg);
  overflow: hidden;
}
/* A paragraph and the block it introduces are one thought, so: one gap. */
.md > p + .code-block,
.md > :where(h1, h2, h3, h4, h5, h6) + .code-block { margin-top: 3px; }
.code-block.code-open {
  border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 45%, var(--arc-border));
}
.code-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 4px 2px 8px;
  border-bottom: 1px solid var(--arc-border);
  font-size: 0.78em;
  color: var(--arc-muted);
}
.code-lang {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--arc-border) 45%, transparent);
  text-transform: lowercase;
  letter-spacing: 0.03em;
}
/* The basename, because 300px has no room for the path; the path is the title. */
.code-file {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--vscode-editor-font-family);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.code-writing { margin-left: auto; flex: none; font-style: italic; }
.code-copy {
  margin-left: auto;
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: none;
  border-radius: 3px;
  font: inherit;
  font-size: 1em;
  color: var(--arc-muted);
  background: transparent;
  opacity: 0.75;
  cursor: pointer;
}
.code-block:hover .code-copy, .code-copy:focus-visible { opacity: 1; }
.code-copy:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
/*
 * ~300px, and no gesture scrolls the panel back once something pushes it
 * sideways: a long line scrolls inside this box and nowhere else. overflow-y
 * is hidden, not auto — the fold below is the way out of a long block, and a
 * scroll region inside a scroll region is a trap.
 */
.code-block pre {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  overflow-y: hidden;
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, 0.92em);
  line-height: 1.45;
  tab-size: 2;
}
.code-clamped pre { max-height: 15.5em; }
.code-more {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  padding: 3px 8px;
  border: none;
  border-top: 1px solid var(--arc-border);
  font: inherit;
  font-size: 0.8em;
  color: var(--arc-muted);
  background: var(--arc-code-bg);
  cursor: pointer;
}
.code-more:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
/* Self-positioning fade: it sits on top of whatever the fold cut off. */
.code-clamped .code-more::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  height: 2.4em;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--arc-code-bg));
}
.code-more .chevron-down { transition: transform 140ms ease; }
.code-block:not(.code-clamped) .code-more .chevron-down { transform: rotate(180deg); }

/* ---- motion: see the doc comment above; transform and opacity only ---- */

/* Text is still being produced. Never after a code card, which says so itself. */
.streaming .md > *:last-child::after {
  content: "";
  display: inline-block;
  width: 0.5em;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--vscode-editorCursor-foreground, currentColor);
  animation: arc-blink 1.1s steps(2, start) infinite;
}
.streaming .md > .code-block:last-child::after { display: none; }
@keyframes arc-blink { to { visibility: hidden; } }

/* A turn arriving: this is new, and it is yours or its answer. */
.arc-enter { animation: arc-rise 180ms cubic-bezier(0.2, 0.7, 0.3, 1) both; }
@keyframes arc-rise { from { opacity: 0; transform: translateY(4px); } }

/* A status settling: running became done, or failed. */
.arc-pop { display: inline-block; animation: arc-pop 240ms cubic-bezier(0.2, 0.7, 0.3, 1) both; }
@keyframes arc-pop { from { opacity: 0; transform: scale(0.86); } }

/* A disclosure opening: this was folded and now it is not. */
.arc-reveal { animation: arc-reveal 160ms ease-out both; }
@keyframes arc-reveal { from { opacity: 0; transform: translateY(-3px); } }

/*
 * The turn ended: one pass of a hairline under the answer, then gone. Ends at
 * opacity 0, so landing on the last frame is landing on nothing.
 */
.turn-settled::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 0;
  height: 1px;
  transform-origin: left center;
  background: var(--vscode-textLink-foreground);
  animation: arc-settle 1s ease-out both;
}
@keyframes arc-settle {
  0% { opacity: 0; transform: scaleX(0.15); }
  22% { opacity: 0.65; transform: scaleX(1); }
  100% { opacity: 0; transform: scaleX(1); }
}

/*
 * "The model is working", for the gaps where nothing else is moving.
 * showWorking() in webview-transcript.ts decides when; this is what it looks
 * like. Hidden is display:none, so neither animation runs while idle.
 */
.working {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px 6px;
  font-size: 0.9em;
  color: var(--arc-muted);
}
.working-mark {
  display: flex;
  color: var(--vscode-textLink-foreground);
  animation: arc-breathe 1.9s ease-in-out infinite;
}
.working-dots { display: inline-flex; align-items: center; gap: 3px; }
.working-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  animation: arc-dot 1.25s ease-in-out infinite;
}
.working-dot:nth-child(2) { animation-delay: 0.15s; }
.working-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes arc-breathe { 50% { opacity: 0.45; transform: scale(0.9); } }
@keyframes arc-dot {
  0%, 65%, 100% { opacity: 0.3; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}

/* notices */
.notice {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  padding: 4px 0;
  font-size: 0.95em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--arc-muted);
}
.notice-warn { color: var(--arc-warn); }
.notice-error { color: var(--arc-err); }

/* ---- disclosures: thinking and tools --------------------------------- */

.disclosure {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: none;
  border-radius: 4px;
  text-align: left;
  font: inherit;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.disclosure:hover { background: var(--vscode-list-hoverBackground); }
.chevron { color: var(--arc-muted); transition: transform 120ms ease; }
.open > .disclosure .chevron { transform: rotate(90deg); }
.thinking .disclosure { color: var(--arc-muted); font-style: italic; }
.thinking-body {
  margin: 2px 0 0 22px;
  padding-left: 10px;
  border-left: 1px solid var(--arc-border);
  color: var(--arc-muted);
  font-style: italic;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool {
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius);
  background: var(--arc-surface);
  overflow: hidden;
  transition: border-color 180ms ease;
}
/*
 * Six greps in a row are one action, not six cards: outer corners, no gaps,
 * a hairline where two meet instead of two borders and 6px of air.
 */
.turn-body > .tool-group-first, .turn-body > .tool-group-mid {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.turn-body > .tool-group-mid, .turn-body > .tool-group-last {
  margin-top: 0;
  border-top: none;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.tool-group-mid > .disclosure, .tool-group-last > .disclosure {
  border-top: 1px solid color-mix(in srgb, var(--arc-border) 55%, transparent);
}
.tool > .disclosure { border-radius: 0; padding: 5px 8px; }
.tool-icon { color: var(--arc-muted); }
.tool-name {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.92em;
  flex: none;
}
.tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--arc-muted);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-badge {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8em;
  color: var(--arc-muted);
}
.tool-running .tool-icon { color: var(--vscode-textLink-foreground); }
.tool-running .tool-badge { color: var(--vscode-textLink-foreground); }
.tool-ok .tool-badge { color: var(--arc-ok); }
.tool-error .tool-badge, .tool-error .tool-icon { color: var(--arc-err); }
.tool-denied .tool-badge, .tool-awaitingPermission .tool-badge { color: var(--arc-warn); }
.tool-awaitingPermission { border-color: var(--arc-warn); }
.spinner { animation: arc-spin 900ms linear infinite; transform-origin: 50% 50%; }
@keyframes arc-spin { to { transform: rotate(360deg); } }
.tool-body { padding: 0 8px 8px; }
.tool-label {
  display: block;
  margin: 6px 0 2px;
  font-size: 0.78em;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--arc-muted);
}
/* Not a code card and not inline code: output, marked by a rule. */
.tool-pre {
  margin: 0;
  padding: 6px 8px;
  max-height: 18em;
  overflow: auto;
  border-left: 2px solid color-mix(in srgb, var(--arc-border) 90%, transparent);
  border-radius: 0 4px 4px 0;
  background: var(--arc-code-bg);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.86em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ---- empty state ----------------------------------------------------- */

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 20px 20px;
  text-align: center;
}
.empty-mark { color: var(--vscode-textLink-foreground); }
.empty-title { margin: 0; font-size: 1.1em; font-weight: 600; }
.empty-line { margin: 0; max-width: 34ch; color: var(--arc-muted); font-size: 0.92em; }
/*
 * The capability line. Quieter than the sentence above it because it is a
 * *fact about this engine* rather than a description of the product, and it is
 * only ever present when 'permissionState' actually answered — an engine that
 * did not report its tools leaves this element hidden and the empty state
 * reads exactly as it did before the line existed.
 */
.capability { font-size: 0.85em; opacity: 0.85; }
.starters { display: flex; flex-direction: column; gap: 6px; width: 100%; margin-top: 8px; }
.starter {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius);
  font: inherit;
  text-align: left;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.starter:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
.starter:disabled { opacity: 0.5; cursor: default; }
.starter .chevron { margin-left: auto; color: var(--arc-muted); }

/* ---- jump to latest -------------------------------------------------- */

.jump {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border: 1px solid var(--arc-border);
  border-radius: 999px;
  font: inherit;
  font-size: 0.85em;
  color: var(--vscode-foreground);
  background: var(--arc-surface);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  cursor: pointer;
  z-index: 3;
}
.jump-wrap { position: relative; height: 0; }

/* ---- dock: plan, permission, composer -------------------------------- */

#dock {
  position: relative;
  flex: none;
  border-top: 1px solid var(--arc-border);
  background: var(--vscode-sideBar-background);
  padding: 8px;
}
.plan-card {
  margin-bottom: 8px;
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius);
  background: var(--arc-surface);
  overflow: hidden;
}
.plan-body { padding: 0 10px 8px; }
.plan-text { margin: 0 0 6px; white-space: pre-wrap; color: var(--arc-muted); font-size: 0.92em; }
.todos { list-style: none; margin: 0; padding: 0; font-size: 0.92em; }
.todos li { display: flex; gap: 6px; align-items: flex-start; padding: 1px 0; }
.todos .box { flex: none; width: 1.1em; color: var(--arc-muted); }
.todo-done { color: var(--arc-muted); text-decoration: line-through; }
.todo-done .box { color: var(--arc-ok); }
.todo-inProgress .box { color: var(--vscode-textLink-foreground); }

/*
 * The permission surface: one region in the dock, two states.
 *
 * The STRIP is the old one-line marker, still shown on the one path that
 * raises a native modal — the panel was not visible when the request arrived,
 * so somebody who opens it afterwards is told why nothing is moving.
 *
 * The CARD is the request itself. It borders on the warning accent rather than
 * the link accent the review card uses, because this is the state a run sits
 * in until a person answers, and it is the strongest thing this panel says.
 */
.permission { margin-bottom: 8px; }
.permission-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--arc-warn);
  border-radius: var(--arc-radius);
  font-size: 0.9em;
  color: var(--arc-warn);
  background: var(--vscode-inputValidation-warningBackground, transparent);
}
.permission-ask {
  padding: 8px 9px;
  border: 1px solid var(--arc-warn);
  border-radius: var(--arc-radius);
  background: var(--arc-surface);
  font-size: 0.9em;
}
.permission-head { display: flex; align-items: center; gap: 6px; color: var(--arc-warn); }
.permission-title { flex: 1 1 auto; min-width: 0; font-weight: 600; }
.permission-desc { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
/*
 * Tool and subject as a two-column key/value grid rather than a sentence: at
 * 300px the subject is the part that matters ('rm -rf build'), and a label in
 * front of it that wraps is a label that hides it.
 */
.permission-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px 8px;
  margin-top: 6px;
  align-items: baseline;
}
.permission-key { color: var(--arc-muted); font-size: 0.9em; }
.permission-value {
  min-width: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.95em;
  overflow-wrap: anywhere;
}
/*
 * The arguments, exactly as the engine sent them and exactly as the native
 * modal would have rendered them. Capped by height rather than by characters
 * so nothing is hidden that the modal would have shown — a long argument
 * scrolls inside the card instead of pushing the buttons off the panel.
 */
.permission-args {
  margin: 6px 0 0;
  max-height: 11em;
  overflow: auto;
  padding: 5px 6px;
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, var(--arc-surface));
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.9em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.permission-origin { margin: 6px 0 0; color: var(--arc-muted); font-size: 0.9em; }
.permission-more { margin: 6px 0 0; color: var(--arc-warn); font-size: 0.9em; }
.permission-actions { display: flex; gap: 5px; margin-top: 8px; }
.permission-button {
  flex: 1 1 auto;
  padding: 4px 8px;
  border: 1px solid var(--arc-border);
  border-radius: 4px;
  font: inherit;
  font-size: 0.95em;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.permission-button:hover { background: var(--vscode-list-hoverBackground); }
.permission-button:disabled { opacity: 0.5; cursor: default; }
/*
 * Allow is the primary and it sits last, which is the editor's own order for
 * a confirming action. Focus lands on Deny, at the other end of the row — see
 * renderPermissionAsk in the script for why the safe answer is the one under
 * the keyboard.
 */
.permission-allow {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}
.permission-allow:hover { background: var(--vscode-button-hoverBackground); }
.permission-deny:hover { color: var(--arc-err); border-color: var(--arc-err); }

/*
 * The dry-run review card.
 *
 * Above the composer and below the permission strip, in the dock — which is to
 * say it is *always on screen* while changes are waiting, rather than behind a
 * command the user has to remember. That placement is the feature: a pending
 * change nobody notices is a pending change that gets applied unread, and the
 * whole point of dry run is that somebody reads it first.
 *
 * Bordered in the same accent the permission strip uses, because it is the
 * same kind of thing: the panel is holding something and waiting for a person.
 */
.dryrun {
  margin-bottom: 8px;
  padding: 7px 9px;
  border: 1px solid var(--vscode-textLink-foreground);
  border-radius: var(--arc-radius);
  background: var(--arc-surface);
  font-size: 0.9em;
}
.dryrun-head { display: flex; align-items: center; gap: 6px; }
.dryrun-text { flex: 1 1 auto; min-width: 0; font-weight: 600; }
.dryrun-files { margin-top: 5px; display: flex; flex-direction: column; gap: 1px; }
/*
 * One row per waiting file, and each one opens the diff. Truncating the path
 * from the LEFT: at 300px the tail of 'src/features/auth/session.ts' is what
 * identifies it, and a row ellipsised the usual way shows four directories and
 * no filename.
 */
.dryrun-file {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 2px 4px;
  border: none;
  border-radius: 3px;
  font: inherit;
  font-size: 0.95em;
  text-align: left;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.dryrun-file:hover { background: var(--vscode-list-hoverBackground); }
.dryrun-name {
  flex: 1 1 auto;
  min-width: 0;
  direction: rtl;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dryrun-kind { flex: none; font-size: 0.85em; color: var(--arc-muted); }
.dryrun-kind.dryrun-added { color: var(--arc-ok); }
.dryrun-note { margin: 5px 0 0; color: var(--arc-warn); }
.dryrun-actions { display: flex; gap: 5px; margin-top: 7px; }
.dryrun-button {
  flex: 1 1 auto;
  padding: 3px 8px;
  border: 1px solid var(--arc-border);
  border-radius: 4px;
  font: inherit;
  font-size: 0.95em;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.dryrun-button:hover { background: var(--vscode-list-hoverBackground); }
.dryrun-button:disabled { opacity: 0.5; cursor: default; }
.dryrun-primary {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}
.dryrun-primary:hover { background: var(--vscode-button-hoverBackground); }
.dryrun-danger:hover { color: var(--arc-err); border-color: var(--arc-err); }

/*
 * The workflow surface, styled as a sibling of the review card on purpose:
 * both are "the engine is holding something you need to look at", and a person
 * who has learnt to read one should not have to learn a second vocabulary for
 * the other. What differs is the accent — the review card borders on the link
 * colour because it is about files, this borders on the warning colour while a
 * run is waiting on a person, because that is the state a pipeline can sit in
 * for an hour if nobody notices it.
 */
.wf {
  margin-bottom: 8px;
  padding: 7px 9px;
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius);
  background: var(--arc-surface);
  font-size: 0.9em;
}
.wf.wf-waiting { border-color: var(--arc-warn); }
.wf-head { display: flex; align-items: center; gap: 6px; }
.wf-text { flex: 1 1 auto; min-width: 0; font-weight: 600; }
.wf-close {
  flex: none;
  padding: 0 4px;
  border: none;
  font: inherit;
  font-size: 1.1em;
  line-height: 1;
  color: var(--arc-muted);
  background: transparent;
  cursor: pointer;
}
.wf-close:hover { color: var(--vscode-foreground); }
.wf-list { margin-top: 5px; display: flex; flex-direction: column; gap: 1px; }
.wf-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 4px;
  border: none;
  border-radius: 3px;
  font: inherit;
  text-align: left;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.wf-row:hover { background: var(--vscode-list-hoverBackground); }
.wf-row-top { display: flex; align-items: baseline; gap: 6px; }
.wf-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-budget { flex: none; font-size: 0.85em; color: var(--arc-muted); }
.wf-row-meta { font-size: 0.85em; color: var(--arc-muted); }
/*
 * A lane chip per role, and the colour is the whole point of the row: 'read'
 * is muted because it can do nothing, 'exec' and 'write' are warned because
 * they can act, and the two unknowable lanes are error-coloured because a
 * pipeline carrying one cannot run at all.
 */
.wf-lanes { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
.wf-lane {
  padding: 0 4px;
  border: 1px solid var(--arc-border);
  border-radius: 3px;
  font-size: 0.8em;
  color: var(--arc-muted);
}
.wf-lane.lane-exec, .wf-lane.lane-write { color: var(--arc-warn); border-color: var(--arc-warn); }
.wf-lane.lane-unknown, .wf-lane.lane-undeclared { color: var(--arc-err); border-color: var(--arc-err); }
.wf-meta { margin: 4px 0 0; color: var(--arc-muted); }
.wf-question { margin: 6px 0 4px; color: var(--vscode-foreground); }
.wf-answer-label { display: block; font-size: 0.85em; color: var(--arc-muted); }
.wf-answer {
  width: 100%;
  margin-top: 2px;
  padding: 4px;
  border: 1px solid var(--arc-border);
  border-radius: 4px;
  font: inherit;
  font-size: 0.95em;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  resize: vertical;
}
.wf-actions { display: flex; gap: 5px; margin-top: 6px; }
.wf-button {
  flex: 1 1 auto;
  padding: 3px 8px;
  border: 1px solid var(--arc-border);
  border-radius: 4px;
  font: inherit;
  font-size: 0.95em;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.wf-button:hover { background: var(--vscode-list-hoverBackground); }
.wf-button:disabled { opacity: 0.5; cursor: default; }
.wf-primary {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}
.wf-primary:hover { background: var(--vscode-button-hoverBackground); }
.wf-note { margin: 5px 0 0; color: var(--arc-warn); }

/*
 * One control, not a text box with buttons bolted on (RFC 0005 §2).
 *
 * Everything the composer holds lives inside this one border: the chip row on
 * top, the textarea, and the bar with attach and context on the left, the two
 * chips in the middle and send on the right. The border is what makes it read
 * as a single object — a chip row *above* an input, with its own outline,
 * would read as two.
 *
 * Judged at 300px, which is the only width that matters here. What that forces
 * is the '.hint' rule below: with two chips in the bar there is no room for a
 * sentence, so at narrow widths the hint stops being *displayed* while staying
 * in the accessibility tree — the textarea's 'aria-describedby' points at it,
 * and accname includes a referenced element whether or not it is rendered.
 * A sighted user at 300px loses "Enter to send"; a screen reader user does
 * not lose anything at any width.
 */
.composer {
  border: 1px solid var(--vscode-input-border, var(--arc-border));
  border-radius: var(--arc-radius);
  background: var(--vscode-input-background);
}
/*
 * The composer wears the brand when it has the caret, and a second ring so the
 * highlight is visible without relying on hue alone — a 1px colour change is
 * not a focus indicator for anyone who cannot separate amber from grey.
 */
.composer:focus-within {
  border-color: var(--arc-brand);
  box-shadow: 0 0 0 1px var(--arc-brand);
}
.composer.dropping {
  border-color: var(--arc-brand);
  box-shadow: 0 0 0 1px var(--arc-brand);
}
@media (forced-colors: active) {
  .composer:focus-within, .composer.dropping {
    border-color: Highlight;
    box-shadow: 0 0 0 1px Highlight;
  }
}

/* ---- context chips --------------------------------------------------- */

/*
 * A render of the host's attachment set and nothing else. Wrapping rather than
 * scrolling: at 300px three chips are two rows, and a horizontally scrolling
 * strip inside a panel that cannot scroll sideways is a place things go to be
 * lost.
 */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 6px 0;
}
.context-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 1px 2px 1px 6px;
  border: 1px solid var(--arc-border);
  border-radius: 999px;
  font-size: 0.82em;
  background: var(--arc-surface);
}
.context-chip .chip-icon { color: var(--arc-muted); }
/*
 * A path is truncated at its head, because the basename is what identifies
 * it. Setting an rtl direction does that in one line and was what this used —
 * but it reorders bidi-neutral characters, so a leading slash moved to the
 * end and /etc/passwd rendered as etc/passwd/. A chip whose whole job is to
 * report a refused path may not show a path that is not the path. Two spans
 * instead: the directory shrinks and ellipsises, the basename never does,
 * and nothing is reordered.
 */
.chip-name {
  min-width: 0;
  display: flex;
  white-space: nowrap;
  overflow: hidden;
}
.chip-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip-base { flex: none; }
.chip-size { flex: none; color: var(--arc-muted); font-variant-numeric: tabular-nums; }
/*
 * A chip the engine refused. Marked by colour *and* by the sentence next to
 * it, never by colour alone: the reason is the whole reason the round trip
 * happened, and a user who cannot see the tint still reads why.
 */
/*
 * The chip that is not like the others.
 *
 * It has to be distinguishable *without* colour, because what separates it
 * from its neighbours is not a status: an '@' chip stays where the user put
 * it, and this one follows the caret. A dashed border says "provisional" in a
 * way a tint does not, the eye says what it is following, and the hover
 * spells both out for anyone who reads neither.
 */
.context-chip.chip-ambient {
  border-style: dashed;
  background: transparent;
}
.context-chip.chip-ambient .chip-name { color: var(--arc-muted); }
.context-chip.chip-bad { border-color: var(--arc-warn); }
.context-chip.chip-bad .chip-icon, .context-chip.chip-bad .chip-size { color: var(--arc-warn); }
.chip-remove {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: var(--arc-muted);
  background: transparent;
  cursor: pointer;
}
.chip-remove:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }

.tool-button {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  color: var(--vscode-icon-foreground, var(--arc-muted));
  background: transparent;
  cursor: pointer;
}
.tool-button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.tool-button:disabled { opacity: 0.4; cursor: default; }
/*
 * Auto-growing textarea with no measured pixel height: the wrapper is a
 * one-cell grid holding the textarea and a hidden ::after that mirrors the
 * text through attr(data-value). The mirror sets the row height, the textarea
 * fills it. No inline style, so nothing here depends on how a host treats
 * CSSOM under style-src.
 */
.grow { display: grid; }
.grow::after {
  content: attr(data-value) " ";
  visibility: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.grow > textarea, .grow::after {
  grid-area: 1 / 1 / 2 / 2;
  width: 100%;
  min-height: 2.6em;
  max-height: 40vh;
  padding: 8px 10px;
  border: none;
  font-family: inherit;
  font-size: inherit;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.grow > textarea {
  resize: none;
  overflow-y: auto;
  color: var(--vscode-input-foreground);
  background: transparent;
}
.grow > textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
.grow > textarea:focus-visible { outline: none; }
.grow > textarea:disabled { opacity: 0.6; }

.composer-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 6px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 0 1 auto;
  padding: 2px 6px 2px 7px;
  border: 1px solid var(--arc-border);
  border-radius: 999px;
  font: inherit;
  font-size: 0.85em;
  color: var(--arc-muted);
  background: transparent;
  cursor: pointer;
}
.chip:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.chip-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip:disabled { opacity: 0.5; cursor: default; }
/* Pushes the permission chip and the send button to the trailing edge. */
.composer-gap { flex: 1 1 auto; }
/*
 * The hint is no longer drawn. It stays in the DOM because it is the
 * textarea's aria-describedby, and a screen reader still needs to be told that
 * Enter sends and Escape stops — facts a sighted user reads off the button.
 * Clipped rather than 'display: none' so it is announced: accname includes a
 * referenced node either way, but a hidden node is skipped by some
 * screen-reader review cursors.
 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
/*
 * The 300px rule. The webview's viewport *is* the sidebar, so a viewport media
 * query is a container query here — and below this width the bar has two icon
 * buttons, two chips and a send button to fit. The sentence that used to
 * compete with them for the same row is gone; what is left is closing the gaps
 * so the chips keep their labels instead of ellipsising them.
 */
@media (max-width: 380px) {
  .composer-bar { gap: 3px; }
}
/*
 * Which chip gives ground, worked out at 300px.
 *
 * Inside a 300px panel the bar has about 270px, and after the two icon
 * buttons, the send button and the gaps there are roughly 184px left for two
 * chips that want about 260px. Something truncates, and it matters which.
 *
 * "Claude Sonne…" still identifies a model, and the full id is in the chip's
 * title and one click away in the list. "Accept edi…" identifies nothing — the
 * mode is a four-way choice about what the agent may do to your files, and
 * half of one of those words is a chip that lies by omission. So the model
 * absorbs nearly all of the shrinking (flex-shrink 1 against a large basis)
 * and the mode gives ground only as a last resort. Neither is ever removed:
 * a bar that dropped the mode chip at a narrow width would hide the control
 * most worth checking exactly when there is least room to check it.
 */
/*
 * Shrink first, never grow. Growing was how this chip used to absorb the row's
 * leftover width, back when there was nothing else to absorb it — and it left
 * a pill stretched across half a wide sidebar with its label alone at the far
 * left. The spacer owns the leftover now. The shrink order it was really for
 * survives: this gives ground at the normal rate and the mode chip at a
 * fifteenth of it, so a narrow panel eats the model id and keeps the mode.
 */
#model { flex: 0 1 auto; min-width: 3em; }
#mode { flex: 0 1 auto; flex-shrink: 0.15; min-width: 3em; }
#mode.mode-yolo { color: var(--arc-warn); border-color: var(--arc-warn); }
#mode.mode-plan { color: var(--vscode-textLink-foreground); }
#mode.mode-unknown .chip-label { font-style: italic; }
.send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: 4px;
  color: var(--arc-brand-on);
  background: var(--arc-brand);
  cursor: pointer;
}
.send:hover { background: var(--arc-brand-hover); }
/*
 * Forced colours ignore a background anyway; naming the system pair keeps the
 * arrow readable instead of leaving it to whatever the UA picks.
 */
@media (forced-colors: active) {
  .send { color: ButtonText; background: ButtonFace; border: 1px solid ButtonBorder; }
}
/*
 * Disabled is a different button, not a faded one. Forty per cent of a brand
 * colour is a smear on a light theme and takes the arrow with it — and since
 * the button is disabled whenever the box is empty, that smear is what the
 * composer looks like at rest. So it drops the accent entirely and wears the
 * editor's own disabled vocabulary, which reads as deliberate.
 */
.send:disabled {
  color: var(--vscode-disabledForeground, var(--arc-muted));
  background: transparent;
  border: 1px solid var(--arc-border);
  cursor: default;
}
.send:disabled:hover { background: transparent; }
.send.stop { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.send.stop:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* ---- model popover --------------------------------------------------- */

.popover {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  max-height: min(60vh, 420px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vscode-widget-border, var(--arc-border));
  border-radius: var(--arc-radius);
  background: var(--vscode-quickInput-background, var(--arc-surface));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.32);
  z-index: 10;
}
.popover-head { display: flex; align-items: center; gap: 6px; padding: 6px; border-bottom: 1px solid var(--arc-border); }
.popover-search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 7px;
  border: 1px solid var(--vscode-input-border, var(--arc-border));
  border-radius: 3px;
  font: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
}
.popover-status { padding: 8px 10px; font-size: 0.9em; color: var(--arc-muted); }
.popover-list { overflow-y: auto; padding: 4px; }
.group-head {
  padding: 6px 6px 2px;
  font-size: 0.75em;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--arc-muted);
}
.model-row, .session-row, .rewind-row {
  display: block;
  width: 100%;
  padding: 5px 7px;
  border: none;
  border-radius: 4px;
  font: inherit;
  text-align: left;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.model-row:hover, .model-row.active, .session-row:hover, .session-row.active,
.rewind-row:hover, .rewind-row.active {
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
}
.model-top, .session-top { display: flex; align-items: center; gap: 6px; }
.model-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.dot-present { color: var(--arc-ok); }
.dot-unknown { color: var(--arc-muted); }
.dot-absent { color: var(--arc-err); opacity: 0.75; }
/*
 * Shrink, never grow. With 'flex: 1 1 auto' the name took the whole row and
 * shoved the badge to the far edge, so 'GLM-5.2' and its CURRENT sat at
 * opposite ends of a sidebar with a hand's width of nothing between them — and
 * a badge that far from the thing it labels stops reading as its label. The
 * basis still shrinks, so a long id ellipsises rather than pushing the badge
 * off; what is left over now collects after the pair instead of inside it.
 */
.model-name, .session-name { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.model-current, .session-current {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 0.72em;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
}
.model-id, .model-meta {
  margin-left: 13px;
  font-size: 0.8em;
  color: var(--arc-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-row:hover .model-id, .model-row.active .model-id,
.model-row:hover .model-meta, .model-row.active .model-meta { color: inherit; opacity: 0.8; }
.model-id { font-family: var(--vscode-editor-font-family); }
.popover-empty { padding: 12px 10px; color: var(--arc-muted); font-size: 0.9em; text-align: center; }
.popover-title { flex: 1 1 auto; margin: 0; font-size: 0.95em; font-weight: 600; }

/* ---- the @ picker and the / menu -------------------------------------- */

/*
 * One popover for both, and deliberately so: what a user is doing in each case
 * is *typing in the composer*, and the list is a completion of what they have
 * typed rather than a separate place to search. So there is no search box here
 * — the composer is the search box — focus never leaves the textarea, and the
 * arrow keys, Enter and Escape are handled on it. That is the one structural
 * difference from the model popover above, which is opened by clicking a chip
 * and therefore has a field of its own to type into.
 *
 * It is shorter than the model list because it sits directly over the
 * composer: a 420px sheet would cover the message being written, and the
 * message is the thing the list is *about*.
 */
/*
 * Anchored to the top of the dock rather than to the bottom of the panel.
 *
 * 'bottom: 100%' inside a relatively positioned #dock puts the list directly
 * above everything the dock holds — the plan card, the permission card and the
 * composer — with no measured pixel and no inline style, so the message being
 * written stays visible while the list is up. That is the difference between
 * this and the model popover, which deliberately sits over the composer
 * because nothing is being typed into it.
 */
.suggest {
  top: auto;
  bottom: 100%;
  left: 8px;
  right: 8px;
  margin-bottom: 4px;
  max-height: min(46vh, 300px);
}
.suggest-row {
  display: block;
  width: 100%;
  padding: 5px 7px;
  border: none;
  border-radius: 4px;
  font: inherit;
  text-align: left;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.suggest-row:hover, .suggest-row.active {
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
}
.suggest-top { display: flex; align-items: center; gap: 6px; }
.suggest-name {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  white-space: nowrap;
  overflow: hidden;
}
.suggest-size { flex: none; font-size: 0.8em; color: var(--arc-muted); font-variant-numeric: tabular-nums; }
.suggest-meta {
  margin-left: 22px;
  font-size: 0.8em;
  color: var(--arc-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.suggest-row:hover .suggest-meta, .suggest-row.active .suggest-meta,
.suggest-row:hover .suggest-size, .suggest-row.active .suggest-size { color: inherit; opacity: 0.8; }
/* A candidate the engine refused: the reason is the row's whole content. */
.suggest-row.suggest-bad .suggest-name { text-decoration: line-through; opacity: 0.75; }
.suggest-row.suggest-bad .suggest-meta { color: var(--arc-warn); }

/* ---- the permission mode popover -------------------------------------- */

.mode-row {
  display: block;
  width: 100%;
  padding: 6px 7px;
  border: none;
  border-radius: 4px;
  font: inherit;
  text-align: left;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.mode-row:hover, .mode-row.active {
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
}
.mode-top { display: flex; align-items: center; gap: 6px; }
.mode-name { flex: 1 1 auto; min-width: 0; font-weight: 600; }
/*
 * The grant sentence wraps rather than ellipsising. It is the only thing on
 * this surface that changes what the agent may do to somebody's working
 * directory, and half of it is not enough to choose by.
 */
.mode-grants { margin-left: 22px; font-size: 0.85em; color: var(--arc-muted); }
.mode-row:hover .mode-grants, .mode-row.active .mode-grants { color: inherit; opacity: 0.85; }
.mode-row.mode-current .mode-name { color: var(--vscode-textLink-foreground); }
#mode-status { color: var(--arc-warn); }

/* ---- sessions: the history view, in the panel -------------------------- */

/*
 * A flow item rather than an overlay: it takes the space the transcript and
 * the composer were in, and the header and the connection card above it stay
 * put. A user who opens history on a dead engine can still see the card that
 * says why, and still press its Connect button.
 */
.fullview { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.fullview-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--arc-border);
}
.fullview-title { flex: 1 1 auto; margin: 0; font-size: 1em; font-weight: 600; }
.fullview-list { flex: 1 1 auto; min-height: 0; }
.session-new {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 8px 0;
  padding: 7px 10px;
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius);
  font: inherit;
  text-align: left;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
}
.session-new:hover {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder);
}
.session-new-where {
  margin-left: auto;
  min-width: 0;
  font-size: 0.85em;
  color: var(--arc-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-meta {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.8em;
  color: var(--arc-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-row:hover .session-meta, .session-row.active .session-meta { color: inherit; opacity: 0.8; }

/*
 * Rewind — the picker for the one control that deletes a person's files.
 *
 * A full-panel view rather than a popover, on the sessions view's terms: the
 * list is unbounded, and choosing a row replaces both the workspace and the
 * transcript, so there is nothing behind it worth keeping in sight.
 *
 * The warning is stated once, at the top, rather than repeated on every row.
 * A cost that appears N times reads as decoration by the third; a cost stated
 * once above the list is read.
 */
.rewind-warning {
  margin: 8px 8px 0;
  padding: 7px 9px;
  border: 1px solid var(--arc-border);
  border-left: 2px solid var(--arc-err);
  border-radius: var(--arc-radius);
  font-size: 0.85em;
  color: var(--arc-muted);
}
.rewind-top { display: flex; align-items: baseline; gap: 6px; }
.rewind-time {
  flex: 0 0 auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.8em;
  color: var(--arc-muted);
}
.rewind-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rewind-meta {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.8em;
  color: var(--arc-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Deletions get the error colour, because they are the half that loses work. */
.rewind-meta.deletes { color: var(--arc-err); }
.rewind-row:hover .rewind-meta, .rewind-row.active .rewind-meta { color: inherit; opacity: 0.85; }

/* Delete, on the row — see the doc comment above for why it is shaped so. */
.session-item { position: relative; }
.session-row { padding-right: 26px; }
.session-delete {
  position: absolute;
  top: 4px;
  right: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 3px;
  color: var(--arc-muted);
  background: transparent;
  opacity: 0;
  transition: opacity 120ms ease;
  cursor: pointer;
}
.session-item:hover .session-delete,
.session-item:focus-within .session-delete,
.session-row.active + .session-delete { opacity: 1; }
.session-delete:hover {
  color: var(--arc-err);
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
@media (forced-colors: active) { .session-delete { opacity: 1; } }

/* One rule over everything, not a list of names. See the doc comment above. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    animation-delay: 0ms !important;
    transition-duration: 1ms !important;
    transition-delay: 0ms !important;
    scroll-behavior: auto !important;
  }
}
`;

/** The page's own logic: element construction, event wiring, reconciliation. */
const CLIENT_SOURCE = String.raw`
"use strict";
(function () {
  var vscode = acquireVsCodeApi();

  /**
   * The only host messages this page will look at. Checked with hasOwnProperty
   * before a single field is read, so a message from anywhere else — or a
   * message whose type collides with something on Object.prototype — is
   * dropped rather than dispatched.
   */
  var KNOWN_HOST_MESSAGES = {
    state: 1, connection: 1, cost: 1, models: 1, session: 1, sessions: 1, showSessions: 1,
    context: 1, contextCandidates: 1, permission: 1, permissionAsk: 1, commands: 1, dryRun: 1,
    rewind: 1, workflows: 1
  };

  var SVG_NS = "http://www.w3.org/2000/svg";

  /*
   * Icons.
   *
   * Drawn from a table of primitives rather than loaded as a font: the CSP
   * grants font-src only the webview's own origin and localResourceRoots is
   * empty, so there is no codicon to reach for. Each entry is a list of
   * [tag, attributes] pairs, applied with setAttribute — never markup.
   */
  var STROKE = { fill: "none", stroke: "currentColor", "stroke-width": "1.25", "stroke-linecap": "round", "stroke-linejoin": "round" };
  function stroked(extra) {
    var out = {};
    for (var key in STROKE) if (Object.prototype.hasOwnProperty.call(STROKE, key)) out[key] = STROKE[key];
    for (var more in extra) if (Object.prototype.hasOwnProperty.call(extra, more)) out[more] = extra[more];
    return out;
  }
  var ICONS = {
    sparkle: [["path", { d: "M8 1.6l1.5 4.1 4.1 1.5-4.1 1.5L8 12.8 6.5 8.7 2.4 7.2l4.1-1.5z", fill: "currentColor" }],
              ["path", { d: "M12.9 10.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z", fill: "currentColor", opacity: "0.7" }]],
    terminal: [["rect", stroked({ x: "1.9", y: "2.6", width: "12.2", height: "10.8", rx: "1.6" })],
               ["path", stroked({ d: "M4.6 6.3L6.9 8l-2.3 1.7" })],
               ["path", stroked({ d: "M8.7 10.1h3" })]],
    file: [["path", stroked({ d: "M4.4 1.9h4.3L12 5.2v8.9H4.4z" })],
           ["path", stroked({ d: "M8.6 2v3.3h3.3" })]],
    edit: [["path", stroked({ d: "M2.7 13.4l.5-2.3 7.4-7.4 1.8 1.8-7.4 7.4z" })],
           ["path", stroked({ d: "M9.8 4.4l1.8 1.8" })]],
    search: [["circle", stroked({ cx: "7", cy: "7", r: "4.1" })],
             ["path", stroked({ d: "M10.1 10.1l3.4 3.4" })]],
    web: [["circle", stroked({ cx: "8", cy: "8", r: "5.9" })],
          ["path", stroked({ d: "M2.2 8h11.6" })],
          ["ellipse", stroked({ cx: "8", cy: "8", rx: "2.6", ry: "5.9" })]],
    list: [["path", stroked({ d: "M2.6 4.2h10.8M2.6 8h10.8M2.6 11.8h6.8" })]],
    tool: [["path", stroked({ d: "M8 1.9l6.1 3.1v5.9L8 14.1 1.9 10.9V5z" })]],
    plus: [["path", stroked({ d: "M8 3.2v9.6M3.2 8h9.6" })]],
    history: [["circle", stroked({ cx: "8", cy: "8", r: "5.9" })],
              ["path", stroked({ d: "M8 4.6V8l2.4 1.6" })]],
    send: [["path", stroked({ d: "M14 2.4L1.8 7.1l4.7 1.9 1.9 4.7z" })],
           ["path", stroked({ d: "M6.5 9L14 2.4" })]],
    stop: [["rect", { x: "4.2", y: "4.2", width: "7.6", height: "7.6", rx: "1.4", fill: "currentColor" }]],
    chevron: [["path", stroked({ d: "M6.2 3.6L10.6 8l-4.4 4.4" })]],
    arrowLeft: [["path", stroked({ d: "M13.2 8H3.4" })],
                ["path", stroked({ d: "M7.4 3.8L3.2 8l4.2 4.2" })]],
    chevronDown: [["path", stroked({ d: "M3.6 6.2L8 10.6l4.4-4.4" })]],
    check: [["path", stroked({ d: "M3.2 8.4l3.2 3.2 6.4-7.2" })]],
    close: [["path", stroked({ d: "M4 4l8 8M12 4l-8 8" })]],
    trash: [["path", stroked({ d: "M3.2 4.5h9.6" })],
            ["path", stroked({ d: "M6.4 4.5V3.3h3.2v1.2" })],
            ["path", stroked({ d: "M4.6 4.5l.6 8.2h5.6l.6-8.2" })],
            ["path", stroked({ d: "M6.9 6.9v3.6M9.1 6.9v3.6" })]],
    paperclip: [["path", stroked({ d: "M11.6 7.3l-4.3 4.3a2.4 2.4 0 0 1-3.4-3.4l5.1-5.1a1.6 1.6 0 0 1 2.3 2.3l-5 5a.8.8 0 0 1-1.2-1.1l4.5-4.5" })]],
    at: [["circle", stroked({ cx: "8", cy: "8", r: "2.3" })],
         ["path", stroked({ d: "M10.3 5.7v3a1.8 1.8 0 0 0 3.5 0 5.9 5.9 0 1 0-2.3 4.6" })]],
    shield: [["path", stroked({ d: "M8 1.9l5 1.9v4.1c0 3-2.1 5.2-5 6.2-2.9-1-5-3.2-5-6.2V3.8z" })]],
    eye: [["path", stroked({ d: "M1.3 8S3.9 3.6 8 3.6 14.7 8 14.7 8 12.1 12.4 8 12.4 1.3 8 1.3 8z" })],
          ["circle", stroked({ cx: "8", cy: "8", r: "1.9" })]],
    image: [["rect", stroked({ x: "2.1", y: "3.1", width: "11.8", height: "9.8", rx: "1.5" })],
            ["circle", stroked({ cx: "5.7", cy: "6.4", r: "1.1" })],
            ["path", stroked({ d: "M2.4 11.2l3.3-3 2.6 2.3 2.2-2 3.1 2.8" })]],
    copy: [["rect", stroked({ x: "5.6", y: "5.6", width: "8", height: "8", rx: "1.4" })],
           ["path", stroked({ d: "M11 4.1V3.7A1.3 1.3 0 0 0 9.7 2.4H3.7A1.3 1.3 0 0 0 2.4 3.7v6a1.3 1.3 0 0 0 1.3 1.3h.4" })]],
    warning: [["path", stroked({ d: "M8 2.4l6 10.4H2z" })],
              ["path", stroked({ d: "M8 6.6v3M8 11.3v.1" })]],
    error: [["circle", stroked({ cx: "8", cy: "8", r: "5.9" })],
            ["path", stroked({ d: "M8 4.9v3.6M8 10.8v.1" })]],
    info: [["circle", stroked({ cx: "8", cy: "8", r: "5.9" })],
           ["path", stroked({ d: "M8 7.4v3.7M8 5.1v.1" })]],
    spinner: [["circle", stroked({ cx: "8", cy: "8", r: "5.6", opacity: "0.25" })],
              ["path", stroked({ d: "M13.6 8A5.6 5.6 0 0 0 8 2.4", class: "spinner" })]]
  };

  /**
   * One icon as an <svg> element.
   *
   * Built node by node with createElementNS and setAttribute. The path data is
   * a literal from the table above — never anything the engine sent — so there
   * is no attribute here whose value a model can influence.
   */
  function icon(name, className) {
    var shapes = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : ICONS.tool;
    var root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("viewBox", "0 0 16 16");
    root.setAttribute("width", "16");
    root.setAttribute("height", "16");
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("focusable", "false");
    if (className) root.setAttribute("class", className);
    for (var i = 0; i < shapes.length; i += 1) {
      var shape = document.createElementNS(SVG_NS, shapes[i][0]);
      var attrs = shapes[i][1];
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) shape.setAttribute(key, attrs[key]);
      }
      root.appendChild(shape);
    }
    return root;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(className, label) {
    var node = el("button", className);
    node.type = "button";
    if (label) {
      node.setAttribute("aria-label", label);
      node.title = label;
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function post(message) {
    vscode.postMessage(message);
  }

  var $ = function (id) { return document.getElementById(id); };

  var sessionTitle = $("session-title");
  var sessionSub = $("session-sub");
  var costLabel = $("cost");
  var banner = $("banner");
  var bannerText = $("banner-text");
  var engineOutput = $("engine-output");
  var bannerActions = $("banner-actions");
  var transcript = $("transcript");
  var turnHost = $("turns");
  var workingRow = $("working");
  var emptyState = $("empty");
  var starters = $("starters");
  var jump = $("jump");
  var planCard = $("plan-card");
  var planToggle = $("plan-toggle");
  var planBody = $("plan-body");
  var planText = $("plan-text");
  var todoList = $("todos");
  var permission = $("permission");
  var promptBox = $("prompt");
  var grow = $("grow");
  var modelChip = $("model");
  var modelLabel = $("model-label");
  var hint = $("hint");
  var sendButton = $("send");
  var dock = $("dock");
  var sessionsButton = $("sessions");
  var sessionsView = $("sessions-view");
  var sessionsSearch = $("sessions-search");
  var sessionsStatus = $("sessions-status");
  var sessionsList = $("sessions-list");
  var sessionsNew = $("sessions-new");
  var popover = $("model-popover");
  var modelSearch = $("model-search");
  var modelStatus = $("model-status");
  var modelList = $("model-list");
  var planCount = $("plan-count");
  var permissionText = $("permission-text");
  var permissionStrip = $("permission-strip");
  var permissionAskCard = $("permission-ask");
  var permissionDesc = $("permission-desc");
  var permissionTool = $("permission-tool");
  var permissionSubject = $("permission-subject");
  var permissionArgs = $("permission-args");
  var permissionOrigin = $("permission-origin");
  var permissionMore = $("permission-more");
  var permissionActions = $("permission-actions");
  var chipRow = $("chips");
  var attachButton = $("attach");
  var contextButton = $("context");
  var suggestBox = $("suggest");
  var suggestStatus = $("suggest-status");
  var suggestList = $("suggest-list");
  var rewindView = $("rewind-view");
  var rewindStatusText = $("rewind-status");
  var rewindList = $("rewind-list");
  var wfSection = $("wf");
  var wfCatalog = $("wf-catalog");
  var wfCatalogIcon = $("wf-catalog-icon");
  var wfCatalogText = $("wf-catalog-text");
  var wfClose = $("wf-close");
  var wfList = $("wf-list");
  var wfRun = $("wf-run");
  var wfRunIcon = $("wf-run-icon");
  var wfRunText = $("wf-run-text");
  var wfRunMeta = $("wf-run-meta");
  var wfQuestions = $("wf-questions");
  var wfQuestionText = $("wf-question-text");
  var wfAnswer = $("wf-answer");
  var wfSendAnswer = $("wf-send-answer");
  var wfNote = $("wf-note");
  var dryRunCard = $("dryrun");
  var dryRunIcon = $("dryrun-icon");
  var dryRunText = $("dryrun-text");
  var dryRunFiles = $("dryrun-files");
  var dryRunNote = $("dryrun-note");
  var dryRunReview = $("dryrun-review");
  var dryRunApply = $("dryrun-apply");
  var dryRunDiscard = $("dryrun-discard");
  var modeChip = $("mode");
  var modeLabel = $("mode-label");
  var modePopover = $("mode-popover");
  var modeStatus = $("mode-status");
  var modeList = $("mode-list");
  var capability = $("capability");
  var composerBox = modeChip.parentNode ? modeChip.parentNode.parentNode : undefined;

  $("brand").appendChild(icon("sparkle"));
  $("empty-mark").appendChild(icon("sparkle"));
  $("new-session").appendChild(icon("plus"));
  $("new-session").setAttribute("aria-label", "New session");
  $("new-session").title = "New session";
  sessionsButton.appendChild(icon("history"));
  sessionsButton.setAttribute("aria-label", "Sessions");
  sessionsButton.title = "Sessions";
  $("rewind-back").appendChild(icon("arrowLeft"));
  $("rewind-back").setAttribute("aria-label", "Back to the conversation");
  $("rewind-back").title = "Back to the conversation";
  $("sessions-back").appendChild(icon("arrowLeft"));
  $("sessions-back").setAttribute("aria-label", "Back to the conversation");
  $("sessions-back").title = "Back to the conversation";
  $("model-close").appendChild(icon("close"));
  $("model-close").setAttribute("aria-label", "Close");
  $("model-icon").appendChild(icon("sparkle"));
  $("mode-icon").appendChild(icon("shield"));
  $("mode-close").appendChild(icon("close"));
  $("mode-close").setAttribute("aria-label", "Close");
  attachButton.appendChild(icon("paperclip"));
  attachButton.setAttribute("aria-label", "Attach files");
  attachButton.title = "Attach files";
  contextButton.appendChild(icon("at"));
  contextButton.setAttribute("aria-label", "Add context");
  contextButton.title = "Add workspace files as context";
  $("model-caret").appendChild(icon("chevronDown"));
  $("plan-chevron").appendChild(icon("chevron", "chevron"));
  $("permission-icon").appendChild(icon("warning"));
  $("permission-ask-icon").appendChild(icon("warning"));
  $("working-mark").appendChild(icon("sparkle"));
  // The one button's face is swapped in syncComposer, never duplicated: two
  // buttons meant two disabled rules, two labels and two chances to disagree
  // about whether a run is in flight.
  sendButton.appendChild(icon("send"));

  /* ---- page state ---------------------------------------------------- */

  var view = { blocks: [], todos: [], plan: undefined, running: false, pendingPermissions: 0, model: undefined };
  var connection = "idle";
  var models = { status: "loading", list: [], current: undefined };
  var chipModel = undefined;
  var announcedModel = undefined;
  var starterButtons = [];
  var stick = true;
  var activeModelRow = -1;
  var sessions = { status: "loading", list: [], current: undefined, cwd: "" };
  var activeSessionRow = -1;
  var planOpen = true;
  /*
   * The permission request this panel is showing, as the HOST projected it.
   *
   * 'undefined' means there is no card up — either nothing is pending, or the
   * host decided this one belongs in a native modal because the panel could
   * not be seen. The page never decides which surface a request gets and never
   * invents one: it renders what arrived and posts back which button was
   * pressed.
   *
   * 'permissionAnsweredId' is the id of the request a button has already been
   * pressed for. One answer per request, from this page: a second click on a
   * card the host has not yet taken down must not send a second decision.
   */
  var permissionAsk = undefined;
  var permissionAskId = undefined;
  var permissionAnsweredId = undefined;
  /* ---- RFC 0005 §2 state ---------------------------------------------- */
  /* The host owns the attachment set; this is only ever a render of it. */
  var chips = [];
  /*
   * The file the user is looking at, as the host last resolved it.
   *
   * Held apart from 'chips' because it *is* apart: 'chips' is the set somebody
   * assembled with '@' and a file dialog, and it changes only when they change
   * it; this one changes under them as they move around the editor. The row
   * renders both, and renders them differently, for exactly that reason.
   */
  var ambient = undefined;
  /*
   * The one popover shared by '@' and '/'. 'kind' is which of the two is open,
   * 'trigger' is the token in the composer it is completing, and 'query' is
   * what the last request asked for — an answer to anything else is dropped,
   * because a slow round trip must not repopulate a list the user has already
   * typed past.
   */
  var suggest = { kind: "", trigger: undefined, rows: [], active: -1, query: undefined };
  var suggestTimer = 0;
  var commands = { status: "loading", list: [] };
  /*
   * What the dry run is holding back, as the host last reported it.
   *
   * A render of the host's answer and nothing else — the page never counts
   * files itself and never remembers a set across a reload, because the only
   * thing that must be true of this card is that Apply lands what the card
   * says it will. 'busy' is local: it disables the buttons between a click and
   * the host's next 'dryRun' message, so a double click cannot send two
   * applies.
   */
  var dryRun = { status: "loading", changes: [], truncated: false, note: "" };
  var dryRunBusy = false;
  /*
   * The workflow catalog and the run being followed, as the HOST last reported
   * them.
   *
   * A render of the host's answer and nothing else. In particular the page
   * never derives a role's lane and never counts a run's progress from the
   * notices scrolling past in the transcript: the lane comes from the engine's
   * own classifier and the numbers come from the run journal, and a page that
   * kept its own tally would disagree with '/workflow status' in a terminal
   * looking at the same run.
   *
   * 'catalogOpen' is local view state — whether '/workflow' opened the list —
   * so a catalog the user dismissed does not reappear on the host's next
   * refresh. 'busy' disables the answer button between a click and that
   * refresh, so a double press cannot resume one run twice.
   */
  var workflows = { status: "loading", workflows: [], run: undefined, note: "" };
  var wfCatalogOpen = false;
  var wfBusy = false;
  /*
   * The turns this session could be rewound to, as the host last reported them.
   *
   * A render of the host's answer and nothing else. In particular the page
   * never invents a 'confirmation' and never edits one: it carries the token
   * back verbatim so the ENGINE can refuse a rewind whose cost has changed
   * since this list was painted. A page that regenerated it would be a page
   * vouching for a cost it did not compute.
   */
  var rewind = { status: "loading", checkpoints: [], truncated: false, note: "" };
  var activeRewindRow = -1;
  var permissionView = { status: "loading", mode: undefined, tools: [], note: "" };
  var activeModeRow = -1;
  /*
   * Motion bookkeeping. hydrated is false for the first paint of a transcript
   * and for the first after a session switch, so a restored conversation does
   * not animate its whole history in at once. wasRunning makes the end-of-turn
   * mark fire on the transition out of a run, not on every idle repaint.
   */
  var hydrated = false;
  var wasRunning = false;
  var lastAssistantTurn = null;
  // When this panel saw the current turn start, or 0 for a turn it never saw
  // start — a session reopened from history is already finished when it
  // arrives, and the footer says so instead of timing the reload.
  var runStartedAt = 0;
  // Whether this panel has ever seen the engine idle.
  //
  // Until it has, a turn that is running is a turn that started before the
  // panel was looking. Timing it from the moment of attach would put a number
  // on the screen that reads exactly like a measurement and is off by however
  // long the turn had already been going — the one case where saying nothing
  // is more informative than saying something.
  var seenIdle = false;

  /* ---- header, cost, session ----------------------------------------- */

  var shownSessionId = "";

  function renderSession(sessionId, title, cwd) {
    // The transcript is about to be a different conversation, which is the
    // only thing the history view was ever open to do. Whoever changed it —
    // a row, the header button, the palette — the list has finished its job.
    if (sessionId !== shownSessionId && sessionsOpen()) closeSessions(false);
    // A different conversation is a first paint again, not a hundred new turns.
    if (sessionId !== shownSessionId) hydrated = false;
    shownSessionId = sessionId;
    sessionTitle.textContent = title && title !== "" ? title : "Arcturn";
    // The folder, not the id. A ULID is the first thing a reader's eye lands
    // on under the title and the last thing it can use — what they actually
    // want to confirm is which workspace this session is touching. The id is
    // still one hover away, on the title attribute below.
    var sub = [];
    if (cwd) sub.push(cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || cwd);
    sessionSub.textContent = sub.join(" · ");
    sessionSub.title = [title || "", sessionId || "", cwd || ""].filter(Boolean).join("\n");
  }

  /* ---- markdown rendering -------------------------------------------- */

  function renderInline(nodes, into) {
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node || typeof node !== "object") continue;
      if (node.t === "text") { into.appendChild(document.createTextNode(String(node.v))); continue; }
      if (node.t === "br") { into.appendChild(document.createElement("br")); continue; }
      if (node.t === "code") { into.appendChild(el("code", "inline", node.v)); continue; }
      if (node.t === "link") {
        var anchor = el("a");
        // The href was allowlisted by scheme in parseMarkdown; nothing else
        // reaches this line. target/rel are literals, not model input.
        anchor.setAttribute("href", node.href);
        anchor.setAttribute("rel", "noopener noreferrer");
        anchor.title = node.href;
        renderInline(node.c || [], anchor);
        into.appendChild(anchor);
        continue;
      }
      var tag = node.t === "strong" ? "strong" : node.t === "em" ? "em" : node.t === "del" ? "del" : "";
      if (tag === "") continue;
      var wrap = el(tag);
      renderInline(node.c || [], wrap);
      into.appendChild(wrap);
    }
  }

  /*
   * Past this many lines a block folds. Judged at 300px, where ~14 lines is a
   * screenful: below it a block is something you read, above it a block is
   * something that buries what came before. It is also comfortably more than
   * a signature, a command or a three-line diff.
   */
  var CODE_FOLD_LINES = 14;

  /** The last path segment: 300px has room for a filename, not for a path. */
  function baseName(path) {
    var parts = String(path).replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || String(path);
  }

  function codeBlock(block) {
    var body = String(block.v === undefined || block.v === null ? "" : block.v);
    var open = block.open === true;
    var lines = body === "" ? 0 : body.split("\n").length;
    var wrap = el("div", "code-block" + (open ? " code-open" : ""));

    var head = el("div", "code-head");
    head.appendChild(el("span", "code-lang", block.lang || "text"));
    if (typeof block.file === "string" && block.file !== "") {
      var file = el("span", "code-file", baseName(block.file));
      file.title = block.file;
      head.appendChild(file);
    }
    if (open) {
      // A fence the model has not closed. Copying half of one is not a thing
      // anyone wants, and this says what the caret would have said.
      head.appendChild(el("span", "code-writing", "writing…"));
    } else {
      var copy = button("code-copy", "Copy code");
      copy.appendChild(icon("copy"));
      var copyText = el("span", "", "Copy");
      copy.appendChild(copyText);
      copy.addEventListener("click", function () {
        post({ type: "copy", text: body });
        copyText.textContent = "Copied";
        window.setTimeout(function () { copyText.textContent = "Copy"; }, 1400);
      });
      head.appendChild(copy);
    }
    wrap.appendChild(head);

    var pre = el("pre");
    pre.appendChild(el("code", "", body));
    wrap.appendChild(pre);

    // Never while the fence is open: folding around the top of a block whose
    // tail is being written is the opposite of useful.
    if (!open && lines > CODE_FOLD_LINES) {
      wrap.classList.add("code-clamped");
      var more = button("code-more");
      more.setAttribute("aria-expanded", "false");
      var moreText = el("span", "", "Show all " + String(lines) + " lines");
      more.appendChild(moreText);
      more.appendChild(icon("chevronDown", "chevron-down"));
      more.addEventListener("click", function () {
        var folded = wrap.classList.toggle("code-clamped");
        more.setAttribute("aria-expanded", folded ? "false" : "true");
        moreText.textContent = folded ? "Show all " + String(lines) + " lines" : "Show less";
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function renderBlocksInto(blocks, into) {
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      if (!block || typeof block !== "object") continue;
      if (block.t === "p") { var p = el("p"); renderInline(block.c || [], p); into.appendChild(p); continue; }
      if (block.t === "h") {
        var level = Math.min(6, Math.max(1, block.level || 1));
        var heading = el("h" + String(level));
        renderInline(block.c || [], heading);
        into.appendChild(heading);
        continue;
      }
      if (block.t === "code") { into.appendChild(codeBlock(block)); continue; }
      if (block.t === "hr") { into.appendChild(el("hr")); continue; }
      if (block.t === "quote") { var quote = el("blockquote"); renderBlocksInto(block.c || [], quote); into.appendChild(quote); continue; }
      if (block.t === "list") {
        var list = el(block.ordered ? "ol" : "ul");
        if (block.ordered && block.start !== 1) list.setAttribute("start", String(block.start));
        var items = block.items || [];
        for (var j = 0; j < items.length; j += 1) {
          var item = el("li");
          if (items[j].checked !== null && items[j].checked !== undefined) {
            item.className = items[j].checked ? "task done" : "task";
            item.appendChild(el("span", "box", items[j].checked ? "✓" : "▢"));
          }
          renderBlocksInto(items[j].c || [], item);
          list.appendChild(item);
        }
        into.appendChild(list);
        continue;
      }
    }
  }

  function markdown(text) {
    var host = el("div", "md");
    renderBlocksInto(parseMarkdown(text), host);
    return host;
  }

  /* ---- transcript blocks --------------------------------------------- */

  function disclosureButton(blockId, expanded) {
    var node = button("disclosure");
    node.setAttribute("aria-expanded", expanded ? "true" : "false");
    node.appendChild(icon("chevron", "chevron"));
    node.addEventListener("click", function () { post({ type: "toggle", blockId: blockId }); });
    return node;
  }

  function buildThinking(block) {
    var wrap = el("div", "thinking");
    var head = disclosureButton(block.id, !block.collapsed);
    head.appendChild(el("span", "", "Thought process"));
    wrap.appendChild(head);
    var body = el("div", "thinking-body", block.text);
    wrap.appendChild(body);
    return { el: wrap, head: head, body: body };
  }

  function buildTool(block) {
    var wrap = el("div", "tool");
    var head = disclosureButton(block.id, !block.collapsed);
    var iconSlot = el("span", "tool-icon");
    head.appendChild(iconSlot);
    var name = el("span", "tool-name");
    head.appendChild(name);
    var summary = el("span", "tool-summary");
    head.appendChild(summary);
    var badge = el("span", "tool-badge");
    head.appendChild(badge);
    wrap.appendChild(head);
    var body = el("div", "tool-body");
    wrap.appendChild(body);
    return { el: wrap, head: head, iconSlot: iconSlot, name: name, summary: summary, badge: badge, body: body };
  }

  function buildDiff(lines, hidden) {
    var wrap = el("div", "diff");
    for (var i = 0; i < lines.length; i += 1) {
      var sign = lines[i].sign;
      var kind = sign === "-" ? " diff-del" : sign === "+" ? " diff-add" : "";
      var row = el("div", "diff-line" + kind);
      row.appendChild(el("span", "diff-sign", sign));
      row.appendChild(el("span", "diff-text", lines[i].text));
      wrap.appendChild(row);
    }
    // Said, not silently dropped: a card that stops at 400 lines without
    // saying so reads as a complete change that happens to be 400 lines long.
    if (hidden > 0) {
      wrap.appendChild(
        el("span", "diff-more", hidden + (hidden === 1 ? " more line" : " more lines") + " not shown")
      );
    }
    return wrap;
  }

  function labelledPre(into, label, value) {
    if (!value) return;
    into.appendChild(el("span", "tool-label", label));
    into.appendChild(el("pre", "tool-pre", value));
  }

  var NOTICE_ICON = { info: "info", warn: "warning", error: "error" };

  function createBlockNode(block) {
    if (block.kind === "user") return { el: el("div", "block-user") };
    if (block.kind === "text") return { el: el("div", "text-block") };
    if (block.kind === "notice") {
      var wrap = el("div", "notice");
      var slot = el("span", "notice-icon");
      var text = el("span");
      wrap.appendChild(slot);
      wrap.appendChild(text);
      return { el: wrap, slot: slot, text: text };
    }
    if (block.kind === "thinking") return buildThinking(block);
    if (block.kind === "tool") return buildTool(block);
    return { el: el("div") };
  }

  /*
   * prev is the snapshot this element was last painted from, and it is here
   * for one reason: an animation saying "this just changed" has to know that
   * it just changed. A card that arrives already finished must not pop.
   */
  function paintBlock(entry, block, streaming, group, prev) {
    if (block.kind === "user") { entry.el.textContent = block.text; return; }
    if (block.kind === "text") {
      clear(entry.el);
      entry.el.appendChild(markdown(block.text));
      entry.el.className = streaming ? "text-block streaming" : "text-block";
      return;
    }
    if (block.kind === "notice") {
      entry.el.className = "notice notice-" + block.level;
      clear(entry.slot);
      entry.slot.appendChild(icon(NOTICE_ICON[block.level] || "info"));
      entry.text.textContent = block.text;
      return;
    }
    if (block.kind === "thinking") {
      entry.el.className = block.collapsed ? "thinking" : "thinking open";
      entry.head.setAttribute("aria-expanded", block.collapsed ? "false" : "true");
      entry.body.textContent = block.text;
      entry.body.className = "thinking-body" + (opening(prev, block) ? " arc-reveal" : "");
      entry.body.classList.toggle("hidden", block.collapsed);
      return;
    }
    if (block.kind === "tool") {
      // The badge is rebuilt on every repaint, which is what makes the
      // entrance retriggerable: a class re-added to an element that already
      // carries it restarts nothing, a freshly created one always runs.
      var settled = prev !== undefined && prev.kind === "tool" &&
        prev.status === "running" && block.status !== "running";
      entry.el.className = "tool tool-" + block.status + " tool-group-" + group +
        (block.collapsed ? "" : " open");
      entry.head.setAttribute("aria-expanded", block.collapsed ? "false" : "true");
      clear(entry.iconSlot);
      entry.iconSlot.appendChild(icon(toolIcon(block.name)));
      entry.name.textContent = block.name;
      entry.summary.textContent = toolSummary(block.argsText);
      clear(entry.badge);
      if (block.status === "running") entry.badge.appendChild(icon("spinner"));
      // A tool that worked says so with a mark, not a word. In a turn that ran
      // six greps, six green DONEs are the loudest thing on the screen and the
      // least informative — success is the expected case and does not need
      // announcing six times. Every other state keeps its word, because those
      // are the ones a reader has to act on. The mark is aria-hidden, so the
      // word goes to a screen reader either way.
      if (block.status === "ok") {
        entry.badge.appendChild(icon("check", settled ? "arc-pop" : ""));
        entry.badge.appendChild(el("span", "sr-only", toolStatusLabel(block.status)));
      } else {
        entry.badge.appendChild(
          el("span", settled ? "tool-status arc-pop" : "tool-status", toolStatusLabel(block.status))
        );
      }
      entry.head.title = block.name + (entry.summary.textContent ? " — " + entry.summary.textContent : "");
      entry.body.className = "tool-body" + (opening(prev, block) ? " arc-reveal" : "");
      entry.body.classList.toggle("hidden", block.collapsed);
      if (!block.collapsed) {
        clear(entry.body);
        var change = toolDiff(block.argsText, block.argsComplete);
        if (change === null) {
          labelledPre(entry.body, "Arguments", block.argsText);
        } else {
          entry.body.appendChild(el("span", "tool-label", change.label));
          entry.body.appendChild(buildDiff(change.lines, change.hidden));
          // Whatever the diff did not consume still shows: an edit reviewed
          // with replaceAll hidden from the reader is a worse card than the
          // raw JSON was.
          labelledPre(entry.body, "Other arguments", change.rest);
        }
        labelledPre(entry.body, "Output", block.progress);
        labelledPre(entry.body, "Result", block.result);
      }
      return;
    }
  }

  /** True only for the repaint that actually unfolds a disclosure. */
  function opening(prev, block) {
    return prev !== undefined && prev.collapsed === true && block.collapsed !== true;
  }

  /** Field-by-field, cheapest first: a block that did not change is not repainted. */
  function sameBlock(a, b, streamingA, streamingB) {
    if (a === undefined || a.kind !== b.kind || streamingA !== streamingB) return false;
    if (a.kind === "user" || a.kind === "text") return a.text.length === b.text.length && a.text === b.text;
    if (a.kind === "notice") return a.level === b.level && a.text === b.text;
    if (a.kind === "thinking") return a.collapsed === b.collapsed && a.text.length === b.text.length && a.text === b.text;
    if (a.kind === "tool") {
      return a.collapsed === b.collapsed && a.status === b.status && a.name === b.name &&
        a.argsText.length === b.argsText.length && a.argsText === b.argsText &&
        a.progress.length === b.progress.length && a.progress === b.progress &&
        a.result.length === b.result.length && a.result === b.result;
    }
    return false;
  }

  var TURN_LABEL = { user: "You", assistant: "Arcturn", notice: "" };

  function createTurn(role, entering) {
    var wrap = el("section", "turn turn-" + role + (entering ? " arc-enter" : ""));
    var body = el("div", "turn-body");
    // The speaker is drawn as shape and announced as a name: a sighted reader
    // gets the card, a screen reader gets the label, and neither one pays for
    // the other's affordance.
    if (TURN_LABEL[role]) wrap.setAttribute("aria-label", TURN_LABEL[role]);
    wrap.appendChild(body);
    return { el: wrap, body: body, blocks: new Map() };
  }

  var turnNodes = new Map();

  /**
   * Repaint the transcript without rebuilding it.
   *
   * Turns are keyed by their first block's id and blocks by their own, so a
   * stream of text deltas touches exactly one element. Nothing else is
   * detached, which is what keeps scroll position, text selection and the
   * expanded/collapsed state of everything above the caret intact — the old
   * renderer replaced the whole log on every delta and lost all three.
   */
  function renderTranscript(blocks) {
    var turns = groupTurns(blocks);
    var byId = new Map();
    for (var b = 0; b < blocks.length; b += 1) byId.set(blocks[b].id, blocks[b]);

    var lastTextId = "";
    if (view.running) {
      for (var s = blocks.length - 1; s >= 0; s -= 1) {
        if (blocks[s].kind === "text") { lastTextId = blocks[s].id; break; }
        if (blocks[s].kind === "tool" || blocks[s].kind === "user") break;
      }
    }

    lastAssistantTurn = null;
    var wanted = new Set();
    for (var w = 0; w < turns.length; w += 1) wanted.add(turns[w].key);
    turnNodes.forEach(function (entry, key) {
      if (!wanted.has(key)) {
        if (entry.el.parentNode === turnHost) turnHost.removeChild(entry.el);
        turnNodes.delete(key);
      }
    });

    for (var i = 0; i < turns.length; i += 1) {
      var turn = turns[i];
      var entry = turnNodes.get(turn.key);
      if (entry === undefined || entry.role !== turn.role) {
        if (entry !== undefined && entry.el.parentNode === turnHost) turnHost.removeChild(entry.el);
        entry = createTurn(turn.role, hydrated);
        entry.role = turn.role;
        turnNodes.set(turn.key, entry);
      }
      if (turn.role === "assistant") lastAssistantTurn = entry;
      if (turnHost.childNodes[i] !== entry.el) {
        turnHost.insertBefore(entry.el, turnHost.childNodes[i] || null);
      }

      var keep = new Set(turn.blockIds);
      entry.blocks.forEach(function (held, id) {
        if (!keep.has(id)) {
          if (held.el.parentNode === entry.body) entry.body.removeChild(held.el);
          entry.blocks.delete(id);
        }
      });

      for (var j = 0; j < turn.blockIds.length; j += 1) {
        var block = byId.get(turn.blockIds[j]);
        if (block === undefined) continue;
        var streaming = block.id === lastTextId;
        // Where this card sits in a run of tool calls — it changes under the
        // card as the next one arrives, so it is compared, not decided once.
        // Only for a tool: giving every block a group would make "what is
        // next to me" a field of a *text* block, and the delta that appends a
        // tool after a finished answer would repaint the answer — throwing
        // away the reader's selection and any code block they had unfolded.
        var group = "";
        if (block.kind === "tool") {
          var before = j > 0 ? byId.get(turn.blockIds[j - 1]) : undefined;
          var after = j + 1 < turn.blockIds.length ? byId.get(turn.blockIds[j + 1]) : undefined;
          group = toolGroup(before ? before.kind : "", after ? after.kind : "");
        }
        var held = entry.blocks.get(block.id);
        if (held === undefined) {
          held = createBlockNode(block);
          held.snapshot = undefined;
          entry.blocks.set(block.id, held);
        }
        if (held.group !== group || !sameBlock(held.snapshot, block, held.streaming, streaming)) {
          paintBlock(held, block, streaming, group, held.snapshot);
          held.snapshot = block;
          held.streaming = streaming;
          held.group = group;
        }
        if (entry.body.childNodes[j] !== held.el) {
          entry.body.insertBefore(held.el, entry.body.childNodes[j] || null);
        }
      }
    }

    emptyState.classList.toggle("hidden", blocks.length > 0);
    workingRow.classList.toggle("hidden", !showWorking(blocks, view.running));
    hydrated = true;
  }

  /* ---- plan and todos ------------------------------------------------ */

  function renderPlan(plan, todos) {
    var has = (plan && plan !== "") || (todos && todos.length > 0);
    planCard.classList.toggle("hidden", !has);
    if (!has) return;
    planText.textContent = plan || "";
    planText.classList.toggle("hidden", !plan);
    clear(todoList);
    var done = 0;
    for (var i = 0; i < todos.length; i += 1) {
      var todo = todos[i];
      var item = el("li", "todo-" + todo.status);
      var mark = todo.status === "done" ? "✓" : todo.status === "inProgress" ? "▸" : "▢";
      if (todo.status === "done") done += 1;
      item.appendChild(el("span", "box", mark));
      item.appendChild(el("span", "", todo.text));
      todoList.appendChild(item);
    }
    var count = todos.length > 0 ? String(done) + "/" + String(todos.length) : "";
    planCount.textContent = count;
  }

  /* ---- composer ------------------------------------------------------ */

  function ready() { return connection === "ready"; }

  function syncComposer() {
    grow.setAttribute("data-value", promptBox.value);
    var typed = promptBox.value.trim() !== "";
    var running = view.running;
    promptBox.disabled = !ready();
    // One button, three states — and the rule that decides them is "agree with
    // Enter", because a button that says Stop while Enter steers is two answers
    // to one question. Idle: Send. Running with something typed: Steer, exactly
    // what Enter does. Running with an empty box: Stop. Stopping never depends
    // on emptying the box — Escape aborts from anywhere in the composer.
    var action = !running ? "send" : typed ? "steer" : "stop";
    sendButton.dataset.action = action;
    sendButton.classList.toggle("stop", action === "stop");
    sendButton.disabled = action === "send" ? !ready() || !typed : !ready();
    var label =
      action === "stop" ? "Stop this run" : action === "steer" ? "Steer this run" : "Send";
    sendButton.setAttribute("aria-label", label);
    sendButton.title = action === "stop" ? label + " (Escape)" : label;
    if (sendButton.dataset.face !== action) {
      sendButton.dataset.face = action;
      clear(sendButton);
      sendButton.appendChild(icon(action === "stop" ? "stop" : "send"));
    }
    modelChip.disabled = !ready();
    modeChip.disabled = !ready();
    attachButton.disabled = !ready();
    contextButton.disabled = !ready();
    if (!ready()) closeSuggest();
    starterButtons.forEach(function (node) { node.disabled = !ready(); });

    // Only a screen reader reads this now, so it says what the keys do — the
    // things a sighted user reads off the button's own face and title.
    var words = [];
    if (!ready()) words.push("Not connected");
    else if (running && typed) words.push("Enter steers this run, Escape stops it");
    else if (running) words.push("Running. Escape stops it");
    else words.push("Enter to send, Shift+Enter for a new line");
    // Written only when it changed: this element is the textarea's
    // aria-describedby, and replacing its text node on every keystroke makes a
    // screen reader re-announce the same sentence as the user types.
    var hintText = words.join(" · ");
    if (hint.textContent !== hintText) hint.textContent = hintText;
    renderPermissionAsk();
  }

  function send() {
    var text = promptBox.value;
    if (!ready() || text.trim() === "") return;
    post({ type: "send", text: text });
    promptBox.value = "";
    // The menu was completing a token that has just left the box with the
    // message. Leaving it open would have it offering rows for text nobody
    // can see any more.
    closeSuggest();
    syncComposer();
    promptBox.focus();
  }

  /* ---- context chips -------------------------------------------------- */

  /*
   * The chip row is a render of the host's attachment set and nothing else.
   *
   * Removing a chip posts 'detach' and then does *nothing*: the row stays
   * exactly as it is until a fresh 'context' message arrives without it. The
   * host owns that set because the host is what 'send' actually attaches, and
   * a page that removed a chip optimistically could show a prompt carrying one
   * file while the wire carried another. Same argument as the session list's
   * delete, one surface along.
   */
  function renderChips() {
    clear(chipRow);
    chipRow.classList.toggle("hidden", chips.length === 0 && !ambient);
    // First, because it is the one that answers 'this file' in the prompt
    // somebody is about to type, and because a chip that moves position as
    // attachments come and go is a chip nobody can learn where to look for.
    if (ambient) chipRow.appendChild(ambientChip(ambient));
    for (var i = 0; i < chips.length; i += 1) {
      chipRow.appendChild(contextChip(chips[i]));
    }
  }

  /*
   * Split a path so the directory can shrink and the basename cannot. The
   * basename identifies the file, so '…/sidebar/index.ts' says more than
   * 'editors/vscode/src/si…'. Built as two text nodes rather than by setting
   * a direction, because reordering turned '/etc/passwd' into 'etc/passwd/'.
   */
  function pathName(cls, label) {
    var wrap = el("span", cls);
    var cut = label.lastIndexOf("/");
    if (cut === -1) {
      wrap.appendChild(el("span", "chip-base", label));
      return wrap;
    }
    wrap.appendChild(el("span", "chip-dir", label.slice(0, cut + 1)));
    wrap.appendChild(el("span", "chip-base", label.slice(cut + 1)));
    return wrap;
  }

  function contextChip(item) {
    var wrap = el("span", "context-chip" + (item.ok ? "" : " chip-bad"));
    wrap.setAttribute("role", "listitem");
    var mark = el("span", "chip-icon");
    mark.appendChild(icon(item.kind === "image" ? "image" : item.ok ? "file" : "warning"));
    wrap.appendChild(mark);
    wrap.appendChild(pathName("chip-name", item.label));
    var meta = contextMeta(item);
    if (meta !== "") wrap.appendChild(el("span", "chip-size", meta));
    wrap.title = item.label + (meta === "" ? "" : "\n" + meta);
    var remove = button("chip-remove", "Remove " + item.label);
    remove.appendChild(icon("close"));
    remove.addEventListener("click", function () { post({ type: "detach", id: item.id }); });
    wrap.appendChild(remove);
    return wrap;
  }

  /*
   * The ambient chip: the file the editor is showing, not one anybody attached.
   *
   * Different from 'contextChip' in three ways, and each of them is the same
   * point made once. The border is dashed and the icon is an eye, so the row
   * reads at a glance as "one of these is following me and the rest are not".
   * The second line is 'ambientMeta', which says 'whole file' when the label
   * names a selection — the engine's attachment carries a path and no range,
   * and a chip reading 'auth.ts:12-40' with nothing beside it would be letting
   * somebody believe twenty-eight lines were sent.
   *
   * And the dismiss control turns the *watching* off instead of removing the
   * chip. Removing it would last until the next keystroke in the editor, which
   * is not a control, it is a flicker.
   */
  function ambientChip(item) {
    var wrap = el("span", "context-chip chip-ambient" + (item.ok ? "" : " chip-bad"));
    wrap.setAttribute("role", "listitem");
    var mark = el("span", "chip-icon");
    mark.appendChild(icon(item.ok ? "eye" : "warning"));
    wrap.appendChild(mark);
    wrap.appendChild(pathName("chip-name", item.label));
    var meta = ambientMeta(item);
    if (meta !== "") wrap.appendChild(el("span", "chip-size", meta));
    wrap.title = ambientTitle(item);
    var off = button("chip-remove", "Stop including the file I have open");
    off.appendChild(icon("close"));
    off.addEventListener("click", function () { post({ type: "disableActiveEditorContext" }); });
    wrap.appendChild(off);
    return wrap;
  }

  /* ---- the @ picker and the / menu ------------------------------------ */

  /*
   * Both menus are completions of what is in the composer, so both are driven
   * from one place: every keystroke asks 'triggerAt' what token the caret is
   * in, and the answer decides which menu is open, or that none is.
   *
   * The caret is read from selectionStart when the host provides one. A
   * textarea that does not report a caret falls back to the end of the value,
   * which is where it is while somebody is typing — the case this feature
   * exists for.
   */
  function caretAt() {
    var at = promptBox.selectionStart;
    return typeof at === "number" ? at : promptBox.value.length;
  }

  function suggestOpen() { return !suggestBox.classList.contains("hidden"); }

  function closeSuggest() {
    if (!suggestOpen() && suggest.kind === "") return;
    suggestBox.classList.add("hidden");
    suggest = { kind: "", trigger: undefined, rows: [], active: -1, query: undefined };
    promptBox.setAttribute("aria-expanded", "false");
    promptBox.removeAttribute("aria-activedescendant");
  }

  /**
   * Decide what the composer's current token means, and act on it.
   *
   * Called from every input event. It is deliberately cheap and idempotent:
   * the trigger is recomputed rather than tracked, so a paste, an arrow key or
   * a click that moves the caret all land in the same place as typing.
   */
  function syncSuggest() {
    var trigger = triggerAt(promptBox.value, caretAt());
    if (trigger === undefined || !ready()) { closeSuggest(); return; }
    if (trigger.marker === "/") {
      suggest.kind = "command";
      suggest.trigger = trigger;
      if (commands.status === "loading") post({ type: "requestCommands" });
      renderCommandMenu();
      return;
    }
    suggest.kind = "context";
    suggest.trigger = trigger;
    requestCandidates(trigger.query);
  }

  /*
   * One request per pause, not one per keystroke. Every candidate the picker
   * shows costs the host a resolveContext round trip — that is what makes the
   * sizes real — so a fast typist must not leave a hundred of them in flight.
   */
  function requestCandidates(query) {
    if (suggestTimer) window.clearTimeout(suggestTimer);
    suggestTimer = window.setTimeout(function () {
      suggestTimer = 0;
      if (suggest.kind !== "context") return;
      suggest.query = query;
      post({ type: "resolveContext", query: query });
    }, 90);
  }

  function renderCandidates(query, items, status) {
    // An answer to a query the user has already typed past is not an answer to
    // anything on screen.
    if (suggest.kind !== "context" || suggest.query !== query) return;
    // An engine with no resolveContext cannot answer this honestly, and every
    // row would be a guess about a size. The picker closes rather than showing
    // an empty list, which would read as "your workspace has no files" — the
    // same choice the '/' menu makes for an engine with no listCommands.
    if (status === "unavailable") { closeSuggest(); return; }
    var shown = orderCandidates(items, suggest.trigger ? suggest.trigger.query : "");
    renderSuggestRows(shown, contextRow, "No workspace file matches that.");
  }

  function contextRow(item, index) {
    var row = button("suggest-row" + (item.ok ? "" : " suggest-bad"));
    row.setAttribute("role", "option");
    row.setAttribute("id", "suggest-row-" + String(index));
    var top = el("div", "suggest-top");
    var mark = el("span", "chip-icon");
    mark.appendChild(icon(item.kind === "image" ? "image" : item.ok ? "file" : "warning"));
    top.appendChild(mark);
    top.appendChild(pathName("suggest-name", item.label));
    row.appendChild(top);
    var meta = contextMeta(item);
    if (meta !== "") row.appendChild(el("div", "suggest-meta", meta));
    row.title = item.label + (meta === "" ? "" : "\n" + meta);
    row.addEventListener("click", function () { chooseCandidate(item); });
    return row;
  }

  /**
   * Attach the chosen file, and take the '@…' back out of the composer.
   *
   * The mention does not survive its own picker. The engine expands mentions
   * on the serve path *and* injects attachments, so leaving the text in would
   * inject the same file twice — and the chip row would stop being the whole
   * truth about what the next prompt carries. See 'webview-context.ts'.
   *
   * A candidate the engine refused is still clickable, and still attaches: the
   * host keeps it as a chip that says why, which is a better answer than a row
   * that does nothing when clicked.
   */
  function chooseCandidate(item) {
    if (suggest.trigger !== undefined) {
      var next = applyTrigger(promptBox.value, suggest.trigger, "");
      promptBox.value = next.text;
      if (typeof promptBox.setSelectionRange === "function") {
        promptBox.setSelectionRange(next.caret, next.caret);
      }
    }
    post({ type: "attach", paths: [item.path] });
    closeSuggest();
    syncComposer();
    promptBox.focus();
  }

  function renderCommandMenu() {
    if (commands.status === "unavailable") { closeSuggest(); return; }
    var typed = suggest.trigger ? suggest.trigger.query : "";
    var shown = orderCommands(filterCommands(runnableCommands(commands.list), typed));
    if (commands.status === "loading") {
      renderSuggestRows([], commandRow, "Loading this workspace's commands…");
      return;
    }
    renderSuggestRows(shown, commandRow, "No command matches that.");
  }

  function commandRow(command, index) {
    var row = button("suggest-row");
    row.setAttribute("role", "option");
    row.setAttribute("id", "suggest-row-" + String(index));
    var top = el("div", "suggest-top");
    var mark = el("span", "chip-icon");
    mark.appendChild(icon(command.kind === "skill" ? "sparkle" : "tool"));
    top.appendChild(mark);
    top.appendChild(el("span", "suggest-name", "/" + command.name));
    top.appendChild(el("span", "suggest-size", command.kind === "skill" ? "skill" : "built-in"));
    row.appendChild(top);
    var meta = commandMeta(command);
    if (meta !== "") row.appendChild(el("div", "suggest-meta", meta));
    row.title = "/" + command.name + (meta === "" ? "" : "\n" + meta);
    row.addEventListener("click", function () { chooseCommand(command); });
    return row;
  }

  /**
   * A skill is inserted; a built-in runs the panel surface it names.
   *
   * RFC 0005 §1.3 keeps skill execution on 'prompt' — a skill is prompt text,
   * and a second execution path would give one skill two behaviours. A
   * built-in is different: '/model' in the terminal opens a picker, so
   * '/model' here opens the picker this panel already has rather than sending
   * the model a message about wanting to change models.
   */
  function chooseCommand(command) {
    var action = builtinAction(command);
    if (suggest.trigger !== undefined) {
      var insert = action === "" ? commandInsert(command) : "";
      var next = applyTrigger(promptBox.value, suggest.trigger, insert);
      promptBox.value = next.text;
      if (typeof promptBox.setSelectionRange === "function") {
        promptBox.setSelectionRange(next.caret, next.caret);
      }
    }
    closeSuggest();
    syncComposer();
    if (action === "model") { openModels(); return; }
    if (action === "permissions") { openModes(); return; }
    if (action === "sessions") { post({ type: "command", command: "sessions" }); return; }
    if (action === "clear") { post({ type: "command", command: "newSession" }); return; }
    // The dry-run three run the review card's own controls, so '/diff' and the
    // Review button are one implementation — which is the only way the two
    // cannot come to mean different things. '/apply' and '/discard' go through
    // the same host handlers the buttons do, confirmation included.
    if (action === "diff") { post({ type: "showDiff" }); return; }
    if (action === "apply") { requestApply(); return; }
    if (action === "discard") { requestDiscard(); return; }
    // '/rewind' opens the picker rather than sending anything: the terminal's
    // '/rewind' opens a picker too, and a composer that mailed the model a
    // note about wanting to go back would be a different command wearing the
    // same name.
    if (action === "rewind") { openRewind(); return; }
    // Cost has no verb of its own: the numbers ride turnEnd on the session the
    // panel is already subscribed to, so the row opens the breakdown the host
    // already holds rather than asking the engine a second time.
    if (action === "cost") { post({ type: "command", command: "cost" }); return; }
    // '/workflow' opens the catalog pane, which is where a run is started, and
    // it is the only door — the same rule '/model' follows. Inserting the text
    // instead would send the model a message about wanting to run a pipeline.
    if (action === "workflow") { openWorkflows(); return; }
    promptBox.focus();
  }

  function renderSuggestRows(rows, build, emptyWords) {
    clear(suggestList);
    suggest.rows = [];
    for (var i = 0; i < rows.length; i += 1) {
      var node = build(rows[i], i);
      suggest.rows.push({ el: node, value: rows[i] });
      suggestList.appendChild(node);
    }
    var words = rows.length === 0 ? emptyWords : "";
    suggestStatus.textContent = words;
    suggestStatus.classList.toggle("hidden", words === "");
    suggestBox.classList.remove("hidden");
    promptBox.setAttribute("aria-expanded", "true");
    highlightSuggestion(rows.length === 0 ? -1 : 0);
  }

  function highlightSuggestion(index) {
    suggest.active = index;
    for (var i = 0; i < suggest.rows.length; i += 1) {
      suggest.rows[i].el.classList.toggle("active", i === index);
    }
    if (index >= 0 && suggest.rows[index]) {
      promptBox.setAttribute("aria-activedescendant", "suggest-row-" + String(index));
      suggest.rows[index].el.scrollIntoView({ block: "nearest" });
    } else {
      promptBox.removeAttribute("aria-activedescendant");
    }
  }

  /** Enter, arrows and Escape belong to the list while one is open. */
  function suggestKey(event) {
    if (!suggestOpen()) return false;
    if (event.key === "Escape") { closeSuggest(); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (suggest.rows.length === 0) return true;
      var step = event.key === "ArrowDown" ? 1 : -1;
      highlightSuggestion((suggest.active + step + suggest.rows.length) % suggest.rows.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (suggest.active < 0 || !suggest.rows[suggest.active]) return false;
      var value = suggest.rows[suggest.active].value;
      if (suggest.kind === "command") chooseCommand(value);
      else chooseCandidate(value);
      return true;
    }
    return false;
  }

  /* ---- the permission mode chip --------------------------------------- */

  function renderModeChip() {
    var mode = permissionView.status === "ready" ? permissionView.mode : undefined;
    modeLabel.textContent = modeChipLabel(mode);
    modeChip.classList.toggle("mode-yolo", mode === "yolo");
    modeChip.classList.toggle("mode-plan", mode === "plan");
    modeChip.classList.toggle("mode-unknown", mode === undefined);
    var summary = modeSummary(mode);
    modeChip.title = mode === undefined
      ? "This engine has not reported a permission mode."
      : "Permission mode: " + modeChipLabel(mode) + "\n" + summary;
  }

  function renderCapability() {
    var words = permissionView.status === "ready" ? capabilityLine(permissionView.tools) : "";
    capability.textContent = words;
    capability.classList.toggle("hidden", words === "");
  }

  var MODE_UNAVAILABLE =
    "This engine is too old to report or change permission modes — upgrade the Arcturn CLI.";

  function modePopoverOpen() { return !modePopover.classList.contains("hidden"); }

  function openModes() {
    if (modelPopoverOpen()) closeModels(false);
    closeSuggest();
    modePopover.classList.remove("hidden");
    modeChip.setAttribute("aria-expanded", "true");
    renderModeList();
    post({ type: "requestPermission" });
    // Focus lands on the mode in force, or on the least permissive one when
    // the engine has not said: the popover opens under the keyboard, and the
    // row a stray Enter would pick is never the one that gives most away.
    var landing = activeModeRow >= 0 ? activeModeRow : 0;
    if (modeRows[landing]) modeRows[landing].el.focus();
  }

  function closeModes(refocus) {
    modePopover.classList.add("hidden");
    modeChip.setAttribute("aria-expanded", "false");
    if (refocus) modeChip.focus();
  }

  var modeRows = [];

  function renderModeList() {
    clear(modeList);
    modeRows = [];
    var words = permissionView.status === "unavailable" ? MODE_UNAVAILABLE : permissionView.note;
    modeStatus.textContent = words;
    modeStatus.classList.toggle("hidden", !words);
    // Not a disabled list: an engine that cannot report a mode cannot change
    // one either, so the rows are simply not offered. A row that looked
    // pressable and did nothing would be the affordance RFC 0005 §3 refuses.
    if (permissionView.status === "unavailable") return;
    var current = permissionView.status === "ready" ? permissionView.mode : undefined;
    for (var i = 0; i < PERMISSION_MODES.length; i += 1) {
      var row = modeRow(PERMISSION_MODES[i], i, current);
      modeRows.push({ el: row, id: PERMISSION_MODES[i].id });
      modeList.appendChild(row);
      if (PERMISSION_MODES[i].id === current) activeModeRow = i;
    }
  }

  /*
   * A real button, reached with Tab, rather than a 'role="option"' the way the
   * model and session lists do it.
   *
   * Those two are driven from a search box that owns the arrow keys and points
   * 'aria-activedescendant' at a row; this popover has no search box — four
   * modes need no filtering — so there is nothing for a listbox pattern to
   * hang off. Four focusable buttons in a labelled group is the whole
   * behaviour, and it is completely keyboard-usable without a roving tabindex
   * to maintain. A 'role="option"' with no listbox driving it would be the
   * half-implemented version of this.
   */
  function modeRow(mode, index, current) {
    var row = button("mode-row" + (mode.id === current ? " mode-current" : ""));
    row.setAttribute("aria-pressed", mode.id === current ? "true" : "false");
    row.setAttribute("id", "mode-row-" + String(index));
    var top = el("div", "mode-top");
    var mark = el("span", "chip-icon");
    mark.appendChild(icon(mode.id === current ? "check" : "shield"));
    top.appendChild(mark);
    top.appendChild(el("span", "mode-name", mode.label));
    row.appendChild(top);
    row.appendChild(el("div", "mode-grants", mode.grants));
    row.title = mode.label + "\n" + mode.grants;
    row.addEventListener("click", function () { chooseMode(mode.id); });
    return row;
  }

  /**
   * Ask, and wait to be told.
   *
   * The chip is *not* moved here, unlike the model chip one section up, and
   * the difference is the whole of RFC 0005 §1.2. A model that fails to switch
   * costs a user a wrong label; a mode that fails to switch costs them the
   * belief that the agent will ask before it writes. So nothing on screen
   * changes until 'permissionState' comes back saying what the mode now is.
   */
  function chooseMode(mode) {
    post({ type: "setPermissionMode", mode: mode });
    closeModes(true);
  }

  /* ---- model popover -------------------------------------------------- */

  var GROUP_LABEL = {
    current: "In use",
    ready: "Ready to use",
    unknown: "Credentials unknown",
    absent: "No credentials on this server"
  };

  function modelPopoverOpen() { return !popover.classList.contains("hidden"); }

  function openModels() {
    popover.classList.remove("hidden");
    modelChip.setAttribute("aria-expanded", "true");
    modelSearch.value = "";
    activeModelRow = -1;
    renderModelList();
    modelSearch.focus();
    post({ type: "requestModels" });
  }

  function closeModels(refocus) {
    popover.classList.add("hidden");
    modelChip.setAttribute("aria-expanded", "false");
    if (refocus) modelChip.focus();
  }

  function chooseModel(modelId) {
    var id = String(modelId || "").trim();
    if (id === "") return;
    chipModel = id;
    renderChip();
    post({ type: "setModel", modelId: id });
    closeModels(true);
  }

  function modelRow(model, index) {
    var row = button("model-row");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", model.id === chipModel ? "true" : "false");
    row.setAttribute("id", "model-row-" + String(index));
    var top = el("div", "model-top");
    top.appendChild(el("span", "model-dot dot-" + model.credentials));
    top.appendChild(el("span", "model-name", model.displayName));
    if (model.id === chipModel) top.appendChild(el("span", "model-current", "Current"));
    row.appendChild(top);
    row.appendChild(el("div", "model-id", model.id));
    row.appendChild(el("div", "model-meta", modelMeta(model)));
    row.title = model.displayName + "\n" + model.id + "\n" + modelMeta(model);
    row.addEventListener("click", function () { chooseModel(model.id); });
    return row;
  }

  var visibleRows = [];

  function renderModelList() {
    clear(modelList);
    visibleRows = [];
    var query = modelSearch.value;
    var shown = orderModels(filterModels(models.list, query), chipModel);

    modelStatus.classList.toggle("hidden", models.status === "ready" && models.list.length > 0);
    if (models.status === "loading") modelStatus.textContent = "Loading the engine's model catalog…";
    else if (models.status === "unavailable") {
      modelStatus.textContent =
        "This engine does not answer listModels. Type a model id and press Enter to switch anyway.";
    } else if (models.list.length === 0) modelStatus.textContent = "The engine reported no models.";

    var group = "";
    for (var i = 0; i < shown.length; i += 1) {
      var band = modelGroup(shown[i], chipModel);
      if (band !== group) {
        group = band;
        modelList.appendChild(el("div", "group-head", GROUP_LABEL[band] || ""));
      }
      var row = modelRow(shown[i], visibleRows.length);
      visibleRows.push({ el: row, id: shown[i].id });
      modelList.appendChild(row);
    }

    var typed = query.trim();
    var exact = false;
    for (var k = 0; k < models.list.length; k += 1) if (models.list[k].id === typed) exact = true;
    // The free-text row is the escape hatch picker.ts has always offered — an
    // extension may register a model the catalog does not list. It is not,
    // though, worth showing under every partial word: only when the query
    // looks like an id, or when nothing matched it.
    if (typed !== "" && !exact && (typed.indexOf("/") !== -1 || shown.length === 0)) {
      var free = button("model-row");
      free.setAttribute("role", "option");
      var freeTop = el("div", "model-top");
      freeTop.appendChild(icon("plus"));
      freeTop.appendChild(el("span", "model-name", "Use “" + typed + "” as a model id"));
      free.appendChild(freeTop);
      free.appendChild(el("div", "model-meta", "The engine validates the id; the catalog may not list every registered model."));
      free.addEventListener("click", function () { chooseModel(typed); });
      modelList.appendChild(free);
      visibleRows.push({ el: free, id: typed });
    }
    if (shown.length === 0 && models.status === "ready") {
      modelList.appendChild(el("div", "popover-empty", "No model matches that search."));
    }
    highlightRow(visibleRows.length === 0 ? -1 : Math.min(Math.max(activeModelRow, 0), visibleRows.length - 1));
  }

  function highlightRow(index) {
    activeModelRow = index;
    for (var i = 0; i < visibleRows.length; i += 1) {
      visibleRows[i].el.classList.toggle("active", i === index);
    }
    if (index >= 0 && visibleRows[index]) {
      modelSearch.setAttribute("aria-activedescendant", "model-row-" + String(index));
      visibleRows[index].el.scrollIntoView({ block: "nearest" });
    } else {
      modelSearch.removeAttribute("aria-activedescendant");
    }
  }

  function renderChip() {
    modelLabel.textContent = modelChipLabel(models.list, chipModel);
    modelChip.title = chipModel ? "Model: " + chipModel : "Choose the model for this session";
  }

  /* ---- sessions: the history view ------------------------------------- */

  /*
   * A full-panel view rather than a popover, which is the one place this
   * surface deliberately parts company with the model list above it.
   *
   * Two reasons, both about what the list *is*. It is unbounded — a workspace
   * accumulates sessions forever, where a catalog is a fixed 135 rows — and a
   * 420px popover in a 300px-wide sidebar turns a long list into a peephole.
   * And picking a row *replaces the transcript*: there is nothing behind this
   * view worth keeping in sight, where the model popover deliberately leaves
   * the conversation visible because which model suits it is the question
   * being asked. Everything else is held in common with the popover on
   * purpose — the same search box, the same row shape, the same arrow/Enter/
   * Escape keys — so the two read as siblings rather than as two designs.
   */

  var SESSION_STATUS = {
    loading: "Loading this workspace’s sessions…",
    disconnected: "Arcturn is not connected, so it cannot list this workspace’s sessions. Reconnect above and they will appear here.",
    failed: "Arcturn could not list this workspace’s sessions. Run Arcturn: Show Log for the reason."
  };
  var NO_SESSIONS_YET =
    "No sessions in this workspace yet. Start one and it will be waiting here next time.";

  function sessionsOpen() { return !sessionsView.classList.contains("hidden"); }

  function openSessions() {
    // Two lists over one panel would be two things to dismiss.
    if (modelPopoverOpen()) closeModels(false);
    sessionsView.classList.remove("hidden");
    transcript.classList.add("hidden");
    dock.classList.add("hidden");
    jump.classList.add("hidden");
    sessionsButton.setAttribute("aria-expanded", "true");
    sessionsSearch.value = "";
    activeSessionRow = -1;
    renderSessionList();
    sessionsSearch.focus();
    post({ type: "requestSessions" });
  }

  function closeSessions(refocus) {
    sessionsView.classList.add("hidden");
    transcript.classList.remove("hidden");
    dock.classList.remove("hidden");
    jump.classList.toggle("hidden", stick);
    sessionsButton.setAttribute("aria-expanded", "false");
    if (refocus) sessionsButton.focus();
  }

  function chooseSession(sessionId) {
    var id = String(sessionId || "").trim();
    if (id === "") return;
    post({ type: "openSession", sessionId: id });
    closeSessions(true);
  }

  function startNewSession() {
    post({ type: "command", command: "newSession" });
    closeSessions(true);
  }

  /*
   * Ask the host to delete a session, and then nothing. The confirmation is a
   * native modal the host owns, and the refreshed list comes back over the
   * same 'sessions' message this view already renders — so the row stays put
   * until a list arrives without it. Removing it here would say a session was
   * gone while the user was still looking at the dialog asking whether to.
   */
  function deleteSession(sessionId) {
    var id = String(sessionId || "").trim();
    if (id === "") return;
    post({ type: "deleteSession", sessionId: id });
  }

  function sessionRow(session, index, now) {
    // A presentational wrapper: the row stays the listbox's option and the
    // target of aria-activedescendant, and delete is its sibling rather than
    // a button nested in a button, which a browser silently takes apart.
    var item = el("div", "session-item");
    item.setAttribute("role", "presentation");
    var row = button("session-row");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", session.sessionId === sessions.current ? "true" : "false");
    row.setAttribute("id", "session-row-" + String(index));
    var top = el("div", "session-top");
    // textContent, like everything else on this page: a session title is
    // model-influenceable, and $(check) is six characters here rather than
    // the glyph VS Code's own label renderer would make of it.
    top.appendChild(el("span", "session-name", sessionLabel(session)));
    if (session.sessionId === sessions.current) {
      top.appendChild(el("span", "session-current", "Current"));
    }
    row.appendChild(top);
    row.appendChild(el("div", "session-meta", sessionMeta(session, now)));
    row.title = sessionLabel(session) + "\n" + session.sessionId;
    row.addEventListener("click", function () { chooseSession(session.sessionId); });
    // Tab reaches the row, and Delete on it does the second thing a row can do.
    row.addEventListener("keydown", function (event) {
      if (event.key !== "Delete") return;
      event.preventDefault();
      deleteSession(session.sessionId);
    });
    item.appendChild(row);

    var remove = button("session-delete", "Delete session " + sessionLabel(session));
    remove.appendChild(icon("trash"));
    remove.addEventListener("click", function (event) {
      // Belt and braces: the button is a sibling, not a child, so nothing
      // bubbles to the row anyway — but a click that opened the session it
      // was asked to delete is the worst failure this control has.
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      deleteSession(session.sessionId);
    });
    item.appendChild(remove);
    return { item: item, row: row };
  }

  var visibleSessionRows = [];

  function renderSessionList() {
    clear(sessionsList);
    visibleSessionRows = [];
    var now = Date.now();
    var shown = orderSessions(filterSessions(sessions.list, sessionsSearch.value));

    // What the status line says is the whole difference between "you have no
    // history" and "this panel cannot see your history", which are not the
    // same news.
    var words = Object.prototype.hasOwnProperty.call(SESSION_STATUS, sessions.status)
      ? SESSION_STATUS[sessions.status]
      : "";
    if (words === "" && sessions.list.length === 0) words = NO_SESSIONS_YET;
    sessionsStatus.textContent = words;
    sessionsStatus.classList.toggle("hidden", words === "");

    for (var i = 0; i < shown.length; i += 1) {
      var built = sessionRow(shown[i], visibleSessionRows.length, now);
      visibleSessionRows.push({ el: built.row, id: shown[i].sessionId });
      sessionsList.appendChild(built.item);
    }
    if (shown.length === 0 && sessions.list.length > 0) {
      sessionsList.appendChild(el("div", "popover-empty", "No session matches that search."));
    }
    highlightSessionRow(
      visibleSessionRows.length === 0
        ? -1
        : Math.min(Math.max(activeSessionRow, 0), visibleSessionRows.length - 1)
    );
  }

  function highlightSessionRow(index) {
    activeSessionRow = index;
    for (var i = 0; i < visibleSessionRows.length; i += 1) {
      visibleSessionRows[i].el.classList.toggle("active", i === index);
    }
    if (index >= 0 && visibleSessionRows[index]) {
      sessionsSearch.setAttribute("aria-activedescendant", "session-row-" + String(index));
      visibleSessionRows[index].el.scrollIntoView({ block: "nearest" });
    } else {
      sessionsSearch.removeAttribute("aria-activedescendant");
    }
  }

  /**
   * The New session button, named with the folder it would start one in.
   *
   * Pinned above the list rather than sitting in it, and deliberately outside
   * the arrow-key ring: with the search box focused, Enter opens the
   * highlighted *session*, and a list whose default action was "throw this
   * away and start over" would be a trap. It is still one Tab from the search
   * box, and it is the only affordance left when the list is empty.
   */
  function renderSessionsCwd(cwd) {
    clear(sessionsNew);
    sessionsNew.appendChild(icon("plus"));
    sessionsNew.appendChild(el("span", "", "New session"));
    var folder = cwd === "" ? "" : (cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || cwd);
    if (folder !== "") sessionsNew.appendChild(el("span", "session-new-where", folder));
    sessionsNew.title = cwd === ""
      ? "Start a new Arcturn session"
      : "Start a new Arcturn session in " + cwd;
  }

  /* ---- rewind: the picker for the one control that deletes files ------ */

  /*
   * A full-panel view, on the sessions view's terms rather than the model
   * popover's: the list is unbounded, and choosing a row replaces both the
   * workspace and the transcript, so there is nothing behind it worth keeping
   * in sight.
   *
   * Everything about this surface is arranged so that nobody rewinds by
   * accident. There is no keyboard default action — the list is clicked, not
   * Entered, because a picker whose Enter key deletes files is a picker that
   * fires while somebody is still reading it. The cost is on the row before
   * the click, and the file NAMES are in a native modal after it. Neither
   * replaces the other: the row is what you choose from, the modal is what you
   * consent to.
   */

  var REWIND_STATUS = {
    loading: "Loading this session’s checkpoints…",
    off: "This engine keeps no file checkpoints, so there is nothing to rewind to.",
    unavailable:
      "This Arcturn engine is too old to rewind — upgrade the CLI and the turns will appear here."
  };
  var NO_CHECKPOINTS_YET =
    "No checkpoints in this session yet. Every prompt that edits a file records one.";

  function rewindOpen() { return !rewindView.classList.contains("hidden"); }

  function openRewind() {
    if (modelPopoverOpen()) closeModels(false);
    if (sessionsOpen()) closeSessions(false);
    closeSuggest();
    rewindView.classList.remove("hidden");
    transcript.classList.add("hidden");
    dock.classList.add("hidden");
    jump.classList.add("hidden");
    activeRewindRow = -1;
    renderRewindList();
    post({ type: "requestCheckpoints" });
  }

  function closeRewind() {
    rewindView.classList.add("hidden");
    transcript.classList.remove("hidden");
    dock.classList.remove("hidden");
    jump.classList.toggle("hidden", stick);
  }

  /*
   * Ask the host to rewind, and then nothing. The confirmation is a native
   * modal the host owns, and the refreshed list comes back over the same
   * 'rewind' message this view already renders — so the row stays put until an
   * answer arrives. Closing the view here would say the rewind happened while
   * the user was still looking at the dialog asking whether to.
   */
  function chooseCheckpoint(entry) {
    post({
      type: "rewindTo",
      checkpointId: String(entry.id || ""),
      // Verbatim. The page is a courier for this token, never an author of one.
      confirmation: String(entry.confirmation || "")
    });
  }

  /* A local time, which is what 'when was this' means to the person reading. */
  function rewindTime(timestamp) {
    var when = new Date(timestamp);
    return isNaN(when.getTime()) ? "" : when.toLocaleTimeString();
  }

  function rewindRow(entry, index) {
    var row = button("rewind-row");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.setAttribute("id", "rewind-row-" + String(index));
    var top = el("div", "rewind-top");
    top.appendChild(el("span", "rewind-time", rewindTime(entry.timestamp)));
    // textContent, like everything else on this page: a label is the head of a
    // prompt, and '$(check)' is six characters here rather than a glyph.
    top.appendChild(el("span", "rewind-label", String(entry.label || "")));
    row.appendChild(top);
    // The deletions colour the whole meta line, because they are the half that
    // loses work and the half a person needs to notice before clicking.
    var meta = el("div", "rewind-meta" + (entry.deleteCount > 0 ? " deletes" : ""),
      String(entry.detail || ""));
    row.appendChild(meta);
    row.title = String(entry.label || "") + "\n" + String(entry.detail || "");
    row.addEventListener("click", function () { chooseCheckpoint(entry); });
    row.addEventListener("mouseenter", function () { highlightRewindRow(index); });
    return row;
  }

  function renderRewindList() {
    clear(rewindList);
    var rows = rewind.status === "ready" ? rewind.checkpoints : [];

    // Four states and four sentences: the difference between "you have not
    // edited anything yet", "this engine keeps no checkpoints" and "this
    // engine cannot rewind at all" is the whole reason the status is carried.
    var words = Object.prototype.hasOwnProperty.call(REWIND_STATUS, rewind.status)
      ? REWIND_STATUS[rewind.status]
      : "";
    if (words === "" && rows.length === 0) words = NO_CHECKPOINTS_YET;
    if (rewind.note) words = words === "" ? rewind.note : rewind.note + " " + words;
    if (words === "" && rewind.truncated) {
      words = "Older turns are not shown — this session has more checkpoints than the engine lists at once.";
    }
    rewindStatusText.textContent = words;
    rewindStatusText.classList.toggle("hidden", words === "");

    for (var i = 0; i < rows.length; i += 1) rewindList.appendChild(rewindRow(rows[i], i));
    highlightRewindRow(rows.length === 0 ? -1 : Math.min(Math.max(activeRewindRow, 0), rows.length - 1));
  }

  function highlightRewindRow(index) {
    activeRewindRow = index;
    var children = rewindList.childNodes;
    for (var i = 0; i < children.length; i += 1) {
      if (children[i] && children[i].classList) {
        children[i].classList.toggle("active", i === index);
      }
    }
  }

  function renderRewind(view) {
    rewind = {
      status: typeof view.status === "string" ? view.status : "loading",
      checkpoints: Array.isArray(view.checkpoints) ? view.checkpoints : [],
      truncated: view.truncated === true,
      note: typeof view.note === "string" ? view.note : ""
    };
    if (rewindOpen()) renderRewindList();
  }

  /* ---- host messages -------------------------------------------------- */

  function renderState(state) {
    view = {
      blocks: Array.isArray(state.blocks) ? state.blocks : [],
      todos: Array.isArray(state.todos) ? state.todos : [],
      plan: typeof state.plan === "string" ? state.plan : "",
      running: state.running === true,
      pendingPermissions: typeof state.pendingPermissions === "number" ? state.pendingPermissions : 0,
      model: typeof state.model === "string" ? state.model : undefined
    };
    // Only an actual *change* of announced model moves the chip: a repaint
    // carrying the same old model must not undo a switch the user just made
    // and the engine has not announced yet.
    if (view.model && view.model !== "" && view.model !== announcedModel) {
      announcedModel = view.model;
      chipModel = view.model;
      renderChip();
    }
    renderTranscript(view.blocks);
    if (seenIdle && !wasRunning && view.running) runStartedAt = Date.now();
    if (!view.running) seenIdle = true;
    // Once, on the transition — a panel that has been sitting finished for
    // ten minutes must not flash every time the host repaints it.
    if (wasRunning && !view.running && lastAssistantTurn !== null) {
      lastAssistantTurn.el.classList.add("turn-settled");
      finishTurn(lastAssistantTurn, view.blocks);
    }
    wasRunning = view.running;
    renderPlan(view.plan, view.todos);
    syncComposer();
    if (stick) transcript.scrollTop = transcript.scrollHeight;
  }

  /** Everything the assistant said in the last turn, as plain text to copy. */
  function lastAnswerText(blocks) {
    var parts = [];
    for (var i = blocks.length - 1; i >= 0; i -= 1) {
      if (blocks[i].kind === "user") break;
      if (blocks[i].kind === "text") parts.unshift(blocks[i].text || "");
    }
    return parts.join("\n\n").trim();
  }

  /**
   * Close off a finished turn: how long it took, and a way to take it with you.
   *
   * Written once on the running-to-finished transition and then left alone, so
   * it is a record rather than a thing that repaints. The elapsed time is the
   * time this panel measured between those two edges — never a stored one and
   * never a guess, which is why a turn that arrived already finished gets the
   * word without a number.
   */
  function finishTurn(entry, blocks) {
    if (entry.foot !== undefined && entry.foot.parentNode === entry.el) {
      entry.el.removeChild(entry.foot);
    }
    var foot = el("div", "turn-foot");
    var elapsed = runStartedAt === 0 ? "" : formatElapsed(Date.now() - runStartedAt);
    foot.appendChild(el("span", "turn-time", elapsed === "" ? "Done" : "Done in " + elapsed));
    var answer = lastAnswerText(blocks);
    if (answer !== "") {
      var copy = button("turn-copy", "Copy response");
      copy.appendChild(icon("copy"));
      copy.appendChild(el("span", "", "Copy"));
      copy.addEventListener("click", function () {
        post({ type: "copy", text: answer });
      });
      foot.appendChild(copy);
    }
    entry.foot = foot;
    entry.el.appendChild(foot);
    runStartedAt = 0;
  }

  function renderEngineOutput(text) {
    engineOutput.textContent = text || "";
    engineOutput.classList.toggle("hidden", !text);
  }

  function renderActions(actions) {
    clear(bannerActions);
    bannerActions.classList.toggle("hidden", !actions || actions.length === 0);
    if (!actions) return;
    for (var i = 0; i < actions.length; i += 1) {
      var action = actions[i];
      if (!action || typeof action.id !== "string" || typeof action.label !== "string") continue;
      var node = el("button", i === actions.length - 1 ? "text-button" : "text-button secondary", action.label);
      node.type = "button";
      bannerActions.appendChild(node);
      (function (id) {
        node.addEventListener("click", function () { post({ type: "action", id: id }); });
      })(action.id);
    }
  }

  function renderConnection(status, detail, output, actions) {
    connection = status;
    if (status === "ready") {
      banner.classList.add("hidden");
      renderEngineOutput("");
      renderActions([]);
      if (models.status !== "ready") post({ type: "requestModels" });
      // The chip and the capability line are both about *this* engine, and a
      // connection that came back may be a different one. Asked for eagerly,
      // unlike the session list, because both are on screen the moment the
      // panel is: a mode chip that stayed blank until somebody clicked it
      // would be a chip that says nothing when it matters most.
      post({ type: "requestPermission" });
      // A connection that came back is a different session store; a list that
      // is on screen has to be told so, and nothing else has to be asked at all.
      if (sessionsOpen()) post({ type: "requestSessions" });
    } else if (status === "starting") {
      banner.classList.remove("hidden");
      bannerText.textContent = "Starting the Arcturn engine…";
      renderEngineOutput("");
      renderActions([]);
    } else if (status === "idle") {
      banner.classList.remove("hidden");
      bannerText.textContent = "Arcturn is not connected.";
      renderEngineOutput("");
      renderActions([{ id: "reconnect", label: "Connect" }]);
    } else {
      banner.classList.remove("hidden");
      bannerText.textContent = detail || "The Arcturn engine stopped.";
      renderEngineOutput(output);
      renderActions(actions && actions.length > 0 ? actions : [{ id: "reconnect", label: "Retry" }]);
    }
    syncComposer();
  }

  function renderModels(status, list, current) {
    models = { status: status, list: list, current: current };
    // The host is authoritative about the current model: it knows the last
    // setModel that actually succeeded, which the event stream does not
    // announce until the next run starts.
    if (current) chipModel = current;
    renderChip();
    if (modelPopoverOpen()) renderModelList();
  }

  function renderSessions(status, list, current, cwd) {
    sessions = { status: status, list: list, current: current, cwd: cwd };
    renderSessionsCwd(cwd);
    if (sessionsOpen()) renderSessionList();
  }

  function renderPermission(status, mode, tools, note) {
    permissionView = { status: status, mode: mode, tools: tools, note: note };
    renderModeChip();
    renderCapability();
    if (modePopoverOpen()) renderModeList();
  }

  function renderCommands(status, list) {
    commands = { status: status, list: list };
    if (suggest.kind === "command") renderCommandMenu();
  }

  /* ---- the permission card -------------------------------------------- */

  /*
   * The id of the request whose card is currently BUILT.
   *
   * The card is rebuilt only when the request changes, never on a repaint.
   * Two reasons, and both are about the person answering it: rebuilding would
   * drag focus back onto Deny every time a token streamed in, and it would
   * replace the buttons under a cursor that was already over one.
   */
  var renderedPermissionId = undefined;

  /*
   * One button. The label is the HOST's — it comes from 'permissionChoices' in
   * 'dialog.ts', which is the single place that decides which buttons a
   * request gets — and it is what goes back on the answer. The 'id' is used
   * here for nothing but styling and focus; the host does not trust it.
   */
  function permissionButton(choice) {
    var extra = choice.id === "allow" ? " permission-allow"
      : choice.id === "deny" ? " permission-deny" : "";
    var node = el("button", "permission-button" + extra, choice.label);
    node.type = "button";
    // 'Deny' on its own names no request. Pointing each button at the
    // description and the subject is what makes focusing one announce WHAT is
    // being allowed or denied — which matters more here than anywhere else on
    // this page, because focus lands on one of these the moment a card
    // appears.
    node.setAttribute("aria-describedby", "permission-desc permission-subject");
    node.addEventListener("click", function () { answerPermission(choice.label); });
    return node;
  }

  /* Write only on a change: these are live regions, and a write re-announces. */
  function setLine(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  /*
   * Press a button, once.
   *
   * The page sends the label and nothing else; whether that label means allow,
   * allow-for-this-session or deny is decided on the host by 'answerFromChoice',
   * which denies anything it does not recognise. So this function cannot grant
   * anything the host would not have granted from the same click on a modal.
   */
  function answerPermission(label) {
    var ask = permissionAsk;
    if (ask === undefined || permissionAnsweredId === ask.id) return;
    permissionAnsweredId = ask.id;
    post({ type: "permissionDecision", requestId: ask.id, choice: label });
    renderPermissionAsk();
  }

  /*
   * Paint the permission region.
   *
   * Two states share it, and only one is ever up:
   *
   * - A CARD, when the host posted a request for this panel to answer.
   * - The STRIP, when something is pending but no card is here — which is the
   *   native-modal path, taken when the panel could not be seen at the moment
   *   the engine asked. The line exists so a person who opens the panel
   *   afterwards is not looking at a transcript that appears to have stalled
   *   for no reason.
   *
   * The count behind 'N more waiting' is the ENGINE's, not a tally this page
   * keeps: 'pendingPermissions' is requests raised minus decisions seen, folded
   * in 'chat-state.ts' from the event stream. A page counting cards it had been
   * sent could disagree with the queue about how much is left.
   */
  function renderPermissionAsk() {
    var ask = permissionAsk;
    var asking = ask !== undefined;
    var waiting = view.pendingPermissions;
    permission.classList.toggle("hidden", !asking && waiting <= 0);
    permissionStrip.classList.toggle("hidden", asking || waiting <= 0);
    permissionAskCard.classList.toggle("hidden", !asking);
    if (!asking) {
      if (renderedPermissionId !== undefined) {
        renderedPermissionId = undefined;
        clear(permissionActions);
      }
      if (waiting > 0) {
        setLine(permissionText, waiting === 1
          ? "Arcturn is asking for permission — answer the dialog to continue."
          : String(waiting) + " permission requests are waiting on you.");
      }
      return;
    }
    if (renderedPermissionId !== ask.id) {
      renderedPermissionId = ask.id;
      // The dock is hidden while a full-panel view is up, so a card raised
      // behind one would be a blocked run with nothing on screen to unblock
      // it — the same failure the host's modal fallback exists to prevent,
      // one level down. A permission request outranks browsing history, so
      // the view is closed rather than the card being drawn where it cannot
      // be seen. Only when a card actually ARRIVES: a withdrawal must not
      // yank somebody out of a list they are reading.
      if (sessionsOpen()) closeSessions(false);
      if (rewindOpen()) closeRewind();
      setLine(permissionDesc, ask.description);
      permissionTool.textContent = ask.tool;
      permissionSubject.textContent = ask.subject;
      permissionArgs.textContent = ask.args;
      permissionArgs.classList.toggle("hidden", ask.args === "");
      permissionOrigin.textContent = ask.origin === "" ? "" : "Requested by " + ask.origin;
      permissionOrigin.classList.toggle("hidden", ask.origin === "");
      clear(permissionActions);
      var landing = undefined;
      for (var i = 0; i < ask.choices.length; i += 1) {
        var node = permissionButton(ask.choices[i]);
        permissionActions.appendChild(node);
        if (ask.choices[i].id === "deny") landing = node;
      }
      // Focus the SAFE answer. A card that arrives with Allow under the
      // keyboard grants on a reflex Enter, and the one failure mode a
      // permission surface may not have is granting without being read.
      if (landing === undefined) landing = permissionActions.firstChild;
      if (landing) landing.focus();
    }
    var behind = waiting - 1;
    setLine(permissionMore, behind <= 0 ? ""
      : String(behind) + (behind === 1 ? " more request is" : " more requests are") +
        " waiting behind this one.");
    permissionMore.classList.toggle("hidden", behind <= 0);
    // Disabled between the click and the host taking the card down: one answer
    // per request, from this page.
    var answered = permissionAnsweredId === ask.id;
    for (var b = 0; b < permissionActions.childNodes.length; b += 1) {
      permissionActions.childNodes[b].disabled = answered;
    }
  }


  /* ---- the dry-run review card ---------------------------------------- */

  /*
   * A file's name, shown tail-first.
   *
   * The row is right-to-left in CSS so the ellipsis falls at the START of the
   * path, which at 300px is the difference between reading
   * 'features/auth/session.ts' and reading 'src/features/aut…'. The Unicode
   * left-to-right mark keeps a leading '/' or a path with digits from being
   * reordered by the bidi algorithm — RTL direction is a layout trick here,
   * not a claim about the text.
   */
  function dryRunName(path) {
    return "\u200e" + String(path);
  }

  function dryRunFileRow(change) {
    var row = button("dryrun-file");
    row.appendChild(el("span", "dryrun-name", dryRunName(change.label)));
    var kind = el("span", "dryrun-kind" + (change.kind === "added" ? " dryrun-added" : ""),
      change.kind === "added" ? "new" : change.detail);
    row.appendChild(kind);
    row.title = change.label + "\n" + change.detail;
    row.addEventListener("click", function () { post({ type: "showDiff", path: change.path }); });
    return row;
  }

  /*
   * Paint the card.
   *
   * Four states, and only ONE of them shows a card at all:
   *
   * - 'ready' with changes — the indicator, the file list, the three actions.
   * - 'ready' with none — hidden. A dry-run session that has not written
   *   anything yet has nothing for a reviewer to do, and a permanent "0
   *   pending" strip is noise that teaches people to stop looking at it.
   * - 'off' — hidden. This engine is not holding anything back, so a review
   *   affordance would imply a safety net that is not there (RFC 0005 §3).
   * - 'unavailable' / 'loading' — hidden, for the same reason.
   */
  function renderDryRun() {
    var showing = dryRun.status === "ready" && dryRun.changes.length > 0;
    dryRunCard.classList.toggle("hidden", !showing);
    if (!showing) return;
    var count = dryRun.changes.length;
    var files = String(count) + " file" + (count === 1 ? "" : "s");
    dryRunText.textContent = dryRun.truncated
      ? files + " pending — more than the engine will list at once"
      : files + " pending review";
    clear(dryRunIcon);
    dryRunIcon.appendChild(icon("edit"));
    clear(dryRunFiles);
    for (var i = 0; i < dryRun.changes.length; i += 1) {
      dryRunFiles.appendChild(dryRunFileRow(dryRun.changes[i]));
    }
    dryRunNote.textContent = dryRun.note || "";
    dryRunNote.classList.toggle("hidden", !dryRun.note);
    // Disabled between a click and the host's answer: one apply per press.
    dryRunReview.disabled = dryRunBusy;
    dryRunApply.disabled = dryRunBusy;
    dryRunDiscard.disabled = dryRunBusy;
  }

  /*
   * Apply and discard both go to the HOST, which asks the engine.
   *
   * Discard raises a native modal there naming the files; this page shows no
   * confirmation of its own, because a webview button that says "are you sure"
   * is a button, not a confirmation (see 'dialog.ts'). Nothing is sent with a
   * selection: the card's actions are about the whole pending set, which is
   * what the card is showing.
   */
  function requestApply() {
    if (dryRunBusy) return;
    dryRunBusy = true;
    renderDryRun();
    post({ type: "applyChanges" });
  }

  function requestDiscard() {
    if (dryRunBusy) return;
    dryRunBusy = true;
    renderDryRun();
    post({ type: "discardChanges" });
  }

  /* ---- workflows ------------------------------------------------------ */

  /*
   * One catalog row: the pipeline's name, its ceiling, its shape, and a chip
   * per role carrying the lane THE ENGINE derived.
   *
   * The lane chips are the reason this row is two lines rather than one. A
   * pipeline's name says nothing about whether it can rewrite your checkout;
   * '@developer write' does, and that is the sentence a person needs before
   * they press Run rather than after.
   */
  function workflowRow(workflow) {
    var row = button("wf-row");
    var top = el("div", "wf-row-top");
    top.appendChild(el("span", "wf-name", workflow.label));
    top.appendChild(el("span", "wf-budget", workflowBudget(workflow.budgetUsd)));
    row.appendChild(top);
    var shape = String(workflow.stages) + " stage" + (workflow.stages === 1 ? "" : "s");
    var meta = workflow.description === "" ? shape : shape + " · " + workflow.description;
    row.appendChild(el("div", "wf-row-meta", meta));
    if (workflow.roles.length > 0) {
      var lanes = el("div", "wf-lanes");
      for (var i = 0; i < workflow.roles.length; i += 1) {
        var role = workflow.roles[i];
        lanes.appendChild(el("span", "wf-lane lane-" + role.lane, "@" + role.label + " " + role.lane));
      }
      row.appendChild(lanes);
    }
    row.title = workflow.label + "\n" + workflow.source;
    row.addEventListener("click", function () { startWorkflow(workflow); });
    return row;
  }

  function workflowBudget(budgetUsd) {
    return typeof budgetUsd === "number" ? "$" + budgetUsd.toFixed(2) : "unbounded";
  }

  /*
   * Run it — with whatever is in the composer as '{{input}}'.
   *
   * The composer is the input box on purpose rather than a second field: a
   * workflow's '{{input}}' is "the thing you were about to ask about", which is
   * exactly what a person has already typed when they reach for '/workflow'.
   *
   * The CONFIRMATION is the host's. This page shows none of its own, because a
   * webview button that says "are you sure" is a button, not a confirmation —
   * the same rule the discard control follows. The host's modal names the
   * ceiling and every role that can act.
   */
  function startWorkflow(workflow) {
    var input = promptBox.value.trim();
    closeWorkflows();
    post(input === ""
      ? { type: "runWorkflow", name: workflow.name }
      : { type: "runWorkflow", name: workflow.name, input: input });
  }

  function openWorkflows() {
    if (modelPopoverOpen()) closeModels(false);
    if (modePopoverOpen()) closeModes(false);
    closeSuggest();
    wfCatalogOpen = true;
    post({ type: "requestWorkflows" });
    renderWorkflows();
  }

  function closeWorkflows() {
    wfCatalogOpen = false;
    renderWorkflows();
  }

  /*
   * Paint the workflow section.
   *
   * The run card wins whenever there is a run: a person watching a pipeline
   * spend money should not have the catalog sitting on top of it. The catalog
   * shows only while '/workflow' has opened it AND the engine actually answered
   * — an engine with no 'listWorkflows' gets a one-line sentence saying so
   * rather than an empty list, because "this workspace defines no pipelines"
   * and "this engine cannot tell me" are not the same news.
   */
  function renderWorkflows() {
    var run = workflows.run;
    var showRun = !!run;
    var showCatalog = wfCatalogOpen && !showRun;
    wfSection.classList.toggle("hidden", !showRun && !showCatalog);
    wfCatalog.classList.toggle("hidden", !showCatalog);
    wfRun.classList.toggle("hidden", !showRun);
    var waiting = showRun && run.questions.length > 0;
    wfSection.classList.toggle("wf-waiting", waiting);

    if (showCatalog) {
      clear(wfCatalogIcon);
      wfCatalogIcon.appendChild(icon("tool"));
      clear(wfList);
      if (workflows.status === "unavailable") {
        wfCatalogText.textContent = "Workflows";
        wfList.appendChild(el("div", "wf-row-meta",
          "This engine is too old to list workflows — upgrade the Arcturn CLI."));
      } else if (workflows.status !== "ready") {
        wfCatalogText.textContent = "Workflows";
        wfList.appendChild(el("div", "wf-row-meta", "Loading…"));
      } else if (workflows.workflows.length === 0) {
        wfCatalogText.textContent = "Workflows";
        wfList.appendChild(el("div", "wf-row-meta",
          "No workflows here. Add one at .arcturn/workflows/<name>.md."));
      } else {
        var count = workflows.workflows.length;
        wfCatalogText.textContent = String(count) + " workflow" + (count === 1 ? "" : "s");
        for (var i = 0; i < workflows.workflows.length; i += 1) {
          wfList.appendChild(workflowRow(workflows.workflows[i]));
        }
      }
    }

    if (showRun) {
      clear(wfRunIcon);
      wfRunIcon.appendChild(icon(waiting ? "warn" : "tool"));
      wfRunText.textContent = "Workflow " + run.workflow;
      wfRunMeta.textContent = runLine(run);
      wfQuestions.classList.toggle("hidden", !waiting);
      if (waiting) {
        // Every question the stage raised, not just the first: a parallel stage
        // can pause on several at once, and a person shown one of three would
        // answer, watch the run pause again, and rightly wonder what happened.
        wfQuestionText.textContent = run.questions.length === 1
          ? run.questions[0].question
          : run.questions.map(function (q) { return q.stepId + ": " + q.question; }).join("\n");
        wfSendAnswer.disabled = wfBusy;
      }
    }

    wfNote.textContent = workflows.note || "";
    wfNote.classList.toggle("hidden", !workflows.note);
  }

  /*
   * The card's one line.
   *
   * Built from the JOURNAL's numbers, which is why it says the same thing the
   * terminal's '/workflow status' says about the same run. Counting the notices
   * scrolling past instead would have been easier and would have drifted the
   * first time a step was replayed from a resume rather than executed.
   */
  function runLine(run) {
    var where = typeof run.stage === "number"
      ? "stage " + run.stage + "/" + run.stageCount + " · " + run.stepsDone + "/" + run.stepsTotal + " steps"
      : run.stepsDone + "/" + run.stepsTotal + " steps";
    var spend = typeof run.spentUsd === "number" ? " · $" + run.spentUsd.toFixed(2) : "";
    var ceiling = typeof run.budgetUsd === "number" ? " of " + workflowBudget(run.budgetUsd) : "";
    return run.state + " · " + where + spend + ceiling;
  }

  /* The person's own words, forwarded verbatim. Never trimmed to a line. */
  function sendWorkflowAnswer() {
    var run = workflows.run;
    if (!run || wfBusy) return;
    var answer = wfAnswer.value.trim();
    if (answer === "") { wfAnswer.focus(); return; }
    wfBusy = true;
    renderWorkflows();
    post({ type: "resumeWorkflow", runId: run.runId, answer: wfAnswer.value });
    wfAnswer.value = "";
  }

  /* ---- wiring --------------------------------------------------------- */

  var STARTERS = [
    ["Explain this file", "Explain what the file I have open does, and how it fits into the project."],
    ["Find the bug in the selected code", "Find the bug in the code I have selected and explain why it is wrong."],
    ["Write tests for this", "Write tests for the file I have open, covering the cases that are not covered yet."],
    ["Review my recent changes", "Review my uncommitted changes and tell me what you would fix before I commit."]
  ];
  for (var s = 0; s < STARTERS.length; s += 1) {
    (function (entry) {
      var node = button("starter");
      node.appendChild(icon("sparkle"));
      node.appendChild(el("span", "", entry[0]));
      node.appendChild(icon("chevron", "chevron"));
      node.title = entry[1];
      node.addEventListener("click", function () {
        promptBox.value = entry[1];
        syncComposer();
        send();
      });
      starters.appendChild(node);
      starterButtons.push(node);
    })(STARTERS[s]);
  }

  planToggle.addEventListener("click", function () {
    planOpen = !planOpen;
    planBody.classList.toggle("hidden", !planOpen);
    planToggle.setAttribute("aria-expanded", planOpen ? "true" : "false");
    planCard.classList.toggle("open", planOpen);
  });

  // The button dispatches on the face it is currently wearing, so a click can
  // never mean something the user did not just read on it.
  sendButton.addEventListener("click", function () {
    if (sendButton.dataset.action === "stop") { post({ type: "abort" }); return; }
    send();
  });

  // Escape aborts from anywhere in the composer, so stopping never depends on
  // clearing the box first — the one thing merging the buttons could otherwise
  // have taken away. It only fires while a run is in flight and while no
  // popover owns the key, which handleSuggestKey claims first.
  promptBox.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !view.running) return;
    event.preventDefault();
    post({ type: "abort" });
  });

  // Review opens the diff for the whole set; the host picks when there is more
  // than one. Apply and Discard go to the host, which asks the engine — this
  // page writes nothing and confirms nothing.
  wfClose.addEventListener("click", closeWorkflows);
  wfSendAnswer.addEventListener("click", sendWorkflowAnswer);
  // Ctrl/Cmd+Enter sends the answer, matching the composer. Plain Enter inserts
  // a newline, because an ORG-ASK answer is prose and often more than one line.
  wfAnswer.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendWorkflowAnswer();
    }
  });
  dryRunReview.addEventListener("click", function () { post({ type: "showDiff" }); });
  dryRunApply.addEventListener("click", requestApply);
  dryRunDiscard.addEventListener("click", requestDiscard);
  // The same verb the history view's own button sends, so pressing either
  // leaves the panel showing the new session rather than the list it came from.
  $("new-session").addEventListener("click", startNewSession);
  // The header button and arcturn.showSessions are two doors to one surface,
  // so the button opens it the same way the palette does: through the command,
  // which reveals the panel and posts showSessions back. Clicking it while
  // the view is up closes it, which is what a toggle in a header should do.
  sessionsButton.addEventListener("click", function () {
    if (sessionsOpen()) closeSessions(true);
    else post({ type: "command", command: "sessions" });
  });
  $("rewind-back").addEventListener("click", function () { closeRewind(); });
  // Escape leaves the picker. Deliberately the ONLY key bound here: there is
  // no Enter and no arrow ring, because a list whose default action deletes
  // files is a list that fires while somebody is still reading it. Rows are
  // clicked, and the modal is what consent actually goes through.
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && rewindOpen()) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      closeRewind();
    }
  });
  $("sessions-back").addEventListener("click", function () { closeSessions(true); });
  sessionsNew.addEventListener("click", startNewSession);
  sessionsSearch.addEventListener("input", function () {
    activeSessionRow = -1;
    renderSessionList();
  });
  sessionsSearch.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); closeSessions(true); return; }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (visibleSessionRows.length > 0) {
        highlightSessionRow((activeSessionRow + 1) % visibleSessionRows.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleSessionRows.length > 0) {
        highlightSessionRow(
          (activeSessionRow - 1 + visibleSessionRows.length) % visibleSessionRows.length
        );
      }
      return;
    }
    if (event.key === "Delete" && (event.shiftKey || sessionsSearch.value === "")) {
      // Delete on the highlighted row, the way a list behaves — but not while
      // it is also the key editing the query the caret sits in. Shift+Delete
      // is the way through then, and the row's own button always works.
      event.preventDefault();
      if (activeSessionRow >= 0 && visibleSessionRows[activeSessionRow]) {
        deleteSession(visibleSessionRows[activeSessionRow].id);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // No free-text row here, unlike the model list: a session id is not
      // something a user knows by heart, and openSession on a typed guess has
      // no useful failure mode.
      if (activeSessionRow >= 0 && visibleSessionRows[activeSessionRow]) {
        chooseSession(visibleSessionRows[activeSessionRow].id);
      }
    }
  });
  sessionsView.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); closeSessions(true); }
  });

  promptBox.addEventListener("input", function () {
    syncComposer();
    syncSuggest();
  });
  // A click or an arrow key moves the caret without changing the value, and
  // the token under the caret is what decides whether a menu belongs open.
  promptBox.addEventListener("click", syncSuggest);
  promptBox.addEventListener("keyup", function (event) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" ||
        event.key === "Home" || event.key === "End") {
      syncSuggest();
    }
  });
  promptBox.addEventListener("blur", function () { closeSuggest(); });
  /*
   * Focus must not leave the textarea when a row is clicked.
   *
   * Without this the sequence is: mousedown blurs the composer, blur closes
   * the popover, the row is removed from the document, and the click that was
   * about to land on it never happens. Preventing the default on mousedown
   * stops the focus change while leaving the click itself intact — which is
   * also the behaviour the rest of this surface assumes, since the composer is
   * the search box and the arrow keys are bound to it.
   */
  suggestBox.addEventListener("mousedown", function (event) {
    if (typeof event.preventDefault === "function") event.preventDefault();
  });
  promptBox.addEventListener("keydown", function (event) {
    // The list gets first refusal on Enter, the arrows and Escape: while a
    // menu is up, Enter is "insert this", not "send the message". It hands
    // Enter back when no row is highlighted, so a menu showing nothing never
    // swallows a send.
    if (suggestKey(event)) { event.preventDefault(); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  /*
   * The '@' button types an '@' rather than opening the list directly, so the
   * button and the keystroke are one code path: whatever the picker does for
   * somebody who typed the character, it does for somebody who clicked.
   */
  contextButton.addEventListener("click", function () {
    if (!ready()) return;
    var at = caretAt();
    var value = promptBox.value;
    var needsSpace = at > 0 && !/\s$/.test(value.slice(0, at));
    var insert = (needsSpace ? " " : "") + "@";
    promptBox.value = value.slice(0, at) + insert + value.slice(at);
    var caret = at + insert.length;
    if (typeof promptBox.setSelectionRange === "function") {
      promptBox.setSelectionRange(caret, caret);
    }
    promptBox.focus();
    syncComposer();
    syncSuggest();
  });
  attachButton.addEventListener("click", function () {
    if (!ready()) return;
    post({ type: "browseForFiles" });
  });

  modeChip.addEventListener("click", function () {
    if (modePopoverOpen()) closeModes(true);
    else openModes();
  });
  $("mode-close").addEventListener("click", function () { closeModes(true); });
  modePopover.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); closeModes(true); }
  });

  /*
   * Drag and drop, and paste, land in the same place a picked file does: the
   * host's attachment set.
   *
   * A drop is read as 'text/uri-list', which is what VS Code's explorer and
   * the OS both put on a drag — and the URIs are forwarded *verbatim*. Turning
   * 'file:///…' into a path is arithmetic about somebody's filesystem, and it
   * belongs on the host, where 'vscode.Uri' already does it correctly on every
   * platform. A page that did its own would be wrong about Windows drive
   * letters and percent-encoding, quietly.
   */
  document.addEventListener("dragover", function (event) {
    if (!ready()) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (composerBox && composerBox.classList) composerBox.classList.add("dropping");
  });
  document.addEventListener("dragleave", function () {
    if (composerBox && composerBox.classList) composerBox.classList.remove("dropping");
  });
  document.addEventListener("drop", function (event) {
    if (composerBox && composerBox.classList) composerBox.classList.remove("dropping");
    if (!ready()) return;
    var transfer = event.dataTransfer;
    if (!transfer) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    var list = typeof transfer.getData === "function" ? transfer.getData("text/uri-list") : "";
    var uris = String(list || "").split(/[\r\n]+/).filter(function (line) {
      // '#' comments are part of the text/uri-list format.
      return line !== "" && line.charAt(0) !== "#";
    });
    if (uris.length > 0) { post({ type: "attach", paths: uris }); return; }
    readImages(transfer.items);
  });
  promptBox.addEventListener("paste", function (event) {
    if (!ready()) return;
    var data = event.clipboardData;
    if (!data || !data.items) return;
    readImages(data.items);
  });

  /*
   * A pasted or dropped image has no path — there is nothing on disk for the
   * engine to read — so it travels as bytes. RFC 0005 §1.1 accepts inline data
   * for images and only for images, which is why nothing else on this page
   * ever sends one.
   *
   * The data URL prefix is split off here rather than sent: the host's
   * boundary validates base64 and a mime type, not a URL, and forwarding the
   * scheme would put a parser between the clipboard and the wire.
   */
  function readImages(items) {
    if (!items || typeof window.FileReader !== "function") return;
    for (var i = 0; i < items.length; i += 1) {
      var entry = items[i];
      if (!entry || entry.kind !== "file") continue;
      if (typeof entry.type !== "string" || entry.type.indexOf("image/") !== 0) continue;
      var file = typeof entry.getAsFile === "function" ? entry.getAsFile() : undefined;
      if (!file) continue;
      (function (mimeType) {
        var reader = new window.FileReader();
        reader.onload = function () {
          var url = String(reader.result || "");
          var comma = url.indexOf(",");
          if (comma === -1 || url.indexOf(";base64,") === -1) return;
          post({ type: "attachImage", data: url.slice(comma + 1), mimeType: mimeType });
        };
        reader.readAsDataURL(file);
      })(entry.type);
    }
  }

  modelChip.addEventListener("click", function () {
    if (modelPopoverOpen()) closeModels(true);
    else openModels();
  });
  $("model-close").addEventListener("click", function () { closeModels(true); });
  modelSearch.addEventListener("input", function () { activeModelRow = -1; renderModelList(); });
  modelSearch.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); closeModels(true); return; }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (visibleRows.length > 0) highlightRow((activeModelRow + 1) % visibleRows.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleRows.length > 0) highlightRow((activeModelRow - 1 + visibleRows.length) % visibleRows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeModelRow >= 0 && visibleRows[activeModelRow]) chooseModel(visibleRows[activeModelRow].id);
      else if (modelSearch.value.trim() !== "") chooseModel(modelSearch.value);
    }
  });
  popover.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); closeModels(true); }
  });
  document.addEventListener("click", function (event) {
    if (modePopoverOpen() && !modePopover.contains(event.target) && !modeChip.contains(event.target)) {
      closeModes(false);
    }
    if (!modelPopoverOpen()) return;
    if (popover.contains(event.target) || modelChip.contains(event.target)) return;
    closeModels(false);
  });

  transcript.addEventListener("scroll", function () {
    stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
    jump.classList.toggle("hidden", stick);
  });
  jump.addEventListener("click", function () {
    stick = true;
    jump.classList.add("hidden");
    transcript.scrollTop = transcript.scrollHeight;
    promptBox.focus();
  });

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (!Object.prototype.hasOwnProperty.call(KNOWN_HOST_MESSAGES, message.type)) return;
    if (message.type === "state") {
      if (message.state && typeof message.state === "object") renderState(message.state);
      return;
    }
    if (message.type === "connection") {
      if (typeof message.status !== "string") return;
      renderConnection(
        message.status,
        typeof message.detail === "string" ? message.detail : "",
        typeof message.engineOutput === "string" ? message.engineOutput : "",
        Array.isArray(message.actions) ? message.actions : []
      );
      return;
    }
    if (message.type === "cost") {
      if (typeof message.label === "string") costLabel.textContent = message.label;
      return;
    }
    if (message.type === "models") {
      var status = message.status === "ready" || message.status === "unavailable" ? message.status : "loading";
      var list = [];
      var raw = Array.isArray(message.models) ? message.models : [];
      for (var i = 0; i < raw.length; i += 1) {
        var entry = raw[i];
        if (!entry || typeof entry.id !== "string" || entry.id === "") continue;
        // Rebuilt field by field, like every other boundary in this extension.
        list.push({
          id: entry.id,
          displayName: typeof entry.displayName === "string" && entry.displayName !== "" ? entry.displayName : entry.id,
          provider: typeof entry.provider === "string" ? entry.provider : "",
          contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 0,
          cost: entry.cost && typeof entry.cost.input === "number" && typeof entry.cost.output === "number"
            ? { input: entry.cost.input, output: entry.cost.output }
            : undefined,
          apiKeyEnv: typeof entry.apiKeyEnv === "string" ? entry.apiKeyEnv : undefined,
          credentials: entry.credentials === "present" || entry.credentials === "absent" ? entry.credentials : "unknown"
        });
      }
      renderModels(status, list, typeof message.current === "string" ? message.current : undefined);
      return;
    }
    if (message.type === "showSessions") {
      if (!sessionsOpen()) openSessions();
      return;
    }
    if (message.type === "sessions") {
      var listStatus = message.status === "ready" || message.status === "disconnected"
        || message.status === "failed" ? message.status : "loading";
      var rows = [];
      var sent = Array.isArray(message.sessions) ? message.sessions : [];
      for (var n = 0; n < sent.length; n += 1) {
        var header = sent[n];
        if (!header || typeof header.sessionId !== "string" || header.sessionId === "") continue;
        // Rebuilt field by field, like every other boundary in this extension.
        rows.push({
          sessionId: header.sessionId,
          title: typeof header.title === "string" ? header.title : "",
          createdAt: typeof header.createdAt === "number" && isFinite(header.createdAt)
            ? header.createdAt
            : 0
        });
      }
      renderSessions(
        listStatus,
        rows,
        typeof message.current === "string" ? message.current : undefined,
        typeof message.cwd === "string" ? message.cwd : ""
      );
      return;
    }
    if (message.type === "session") {
      renderSession(
        typeof message.sessionId === "string" ? message.sessionId : "",
        typeof message.title === "string" ? message.title : "",
        typeof message.cwd === "string" ? message.cwd : ""
      );
      return;
    }
    if (message.type === "context") {
      chips = contextItems(message.items);
      // One message carries both, so the row the user reads is always one
      // paint of one host-side truth — two messages could arrive in either
      // order and leave the chip row briefly disagreeing with itself.
      ambient = contextItems([message.active])[0];
      if (ambient) ambient.selection = lineRange(message.active);
      renderChips();
      return;
    }
    if (message.type === "contextCandidates") {
      if (typeof message.query !== "string") return;
      renderCandidates(
        message.query,
        contextItems(message.items),
        message.status === "unavailable" ? "unavailable" : "ready"
      );
      return;
    }
    if (message.type === "permission") {
      var permStatus = message.status === "ready" || message.status === "unavailable"
        ? message.status : "loading";
      var tools = [];
      var reported = Array.isArray(message.tools) ? message.tools : [];
      for (var t = 0; t < reported.length; t += 1) {
        if (typeof reported[t] === "string" && reported[t] !== "") tools.push(reported[t]);
      }
      renderPermission(
        permStatus,
        typeof message.mode === "string" && message.mode !== "" ? message.mode : undefined,
        tools,
        typeof message.note === "string" ? message.note : ""
      );
      return;
    }
    if (message.type === "permissionAsk") {
      /*
       * Rebuilt field by field like every other list on this boundary, and for
       * a sharper reason than most: this is the message that puts a control on
       * screen which can grant a tool. Nothing is forwarded, nothing is
       * defaulted to something more permissive, and a request with no id or no
       * buttons is DROPPED rather than rendered — a card nobody can answer
       * would announce a blocked run and offer no way to unblock it.
       */
      var raw = message.request && typeof message.request === "object" ? message.request : undefined;
      var card = undefined;
      if (raw !== undefined && typeof raw.id === "string" && raw.id !== "") {
        var choices = [];
        var offered = Array.isArray(raw.choices) ? raw.choices : [];
        for (var oc = 0; oc < offered.length; oc += 1) {
          var choice = offered[oc];
          if (!choice || typeof choice.label !== "string" || choice.label === "") continue;
          choices.push({
            id: typeof choice.id === "string" ? choice.id : "",
            label: choice.label
          });
        }
        if (choices.length > 0) {
          card = {
            id: raw.id,
            description: typeof raw.description === "string" ? raw.description : "",
            tool: typeof raw.tool === "string" ? raw.tool : "",
            subject: typeof raw.subject === "string" ? raw.subject : "",
            args: typeof raw.args === "string" ? raw.args : "",
            origin: typeof raw.origin === "string" ? raw.origin : "",
            choices: choices
          };
        }
      }
      permissionAsk = card;
      renderPermissionAsk();
      return;
    }
    if (message.type === "dryRun") {
      var view = message.view && typeof message.view === "object" ? message.view : {};
      var dryStatus = view.status === "ready" || view.status === "off" ||
        view.status === "unavailable" ? view.status : "loading";
      var changed = [];
      var reportedChanges = Array.isArray(view.changes) ? view.changes : [];
      for (var d = 0; d < reportedChanges.length; d += 1) {
        var entry = reportedChanges[d];
        if (!entry || typeof entry.path !== "string" || entry.path === "") continue;
        // Rebuilt field by field, like every other list on this boundary: the
        // host projects the engine's rows and this takes only what it renders.
        changed.push({
          path: entry.path,
          label: typeof entry.label === "string" ? entry.label : entry.path,
          kind: entry.kind === "added" ? "added" : "modified",
          detail: typeof entry.detail === "string" ? entry.detail : ""
        });
      }
      dryRun = {
        status: dryStatus,
        changes: changed,
        truncated: view.truncated === true,
        note: typeof view.note === "string" ? view.note : ""
      };
      // The host has answered, so whatever was in flight is over.
      dryRunBusy = false;
      renderDryRun();
      return;
    }
    if (message.type === "workflows") {
      var wv = message.view && typeof message.view === "object" ? message.view : {};
      var wfStatus = wv.status === "ready" || wv.status === "unavailable" ? wv.status : "loading";
      var listed = [];
      var reportedWorkflows = Array.isArray(wv.workflows) ? wv.workflows : [];
      for (var w = 0; w < reportedWorkflows.length; w += 1) {
        var wf = reportedWorkflows[w];
        if (!wf || typeof wf.name !== "string" || wf.name === "") continue;
        // Rebuilt field by field, like every other list on this boundary. The
        // lane is copied verbatim and never defaulted to something safer-
        // sounding: 'unknown' and 'undeclared' are the two values that mean
        // nobody can say what this role does, and rendering either as 'read'
        // would be the page inventing reassurance the engine did not give.
        var lanes = [];
        var reportedRoles = Array.isArray(wf.roles) ? wf.roles : [];
        for (var r = 0; r < reportedRoles.length; r += 1) {
          var role = reportedRoles[r];
          if (!role || typeof role.label !== "string") continue;
          lanes.push({
            label: role.label,
            lane: typeof role.lane === "string" ? role.lane : "unknown"
          });
        }
        listed.push({
          name: wf.name,
          label: typeof wf.label === "string" ? wf.label : wf.name,
          description: typeof wf.description === "string" ? wf.description : "",
          source: typeof wf.source === "string" ? wf.source : "",
          stages: typeof wf.stages === "number" ? wf.stages : 0,
          steps: typeof wf.steps === "number" ? wf.steps : 0,
          budgetUsd: typeof wf.budgetUsd === "number" ? wf.budgetUsd : undefined,
          roles: lanes
        });
      }
      var reportedRun = wv.run && typeof wv.run === "object" ? wv.run : undefined;
      var runRow;
      if (reportedRun && typeof reportedRun.runId === "string" && reportedRun.runId !== "") {
        var asked = [];
        var reportedQuestions = Array.isArray(reportedRun.questions) ? reportedRun.questions : [];
        for (var q = 0; q < reportedQuestions.length; q += 1) {
          var question = reportedQuestions[q];
          if (!question || typeof question.question !== "string") continue;
          asked.push({
            stepId: typeof question.stepId === "string" ? question.stepId : "",
            question: question.question
          });
        }
        runRow = {
          runId: reportedRun.runId,
          workflow: typeof reportedRun.workflow === "string" ? reportedRun.workflow : "",
          state: typeof reportedRun.state === "string" ? reportedRun.state : "unknown",
          stage: typeof reportedRun.stage === "number" ? reportedRun.stage : undefined,
          stageCount: typeof reportedRun.stageCount === "number" ? reportedRun.stageCount : 0,
          stepsDone: typeof reportedRun.stepsDone === "number" ? reportedRun.stepsDone : 0,
          stepsTotal: typeof reportedRun.stepsTotal === "number" ? reportedRun.stepsTotal : 0,
          spentUsd: typeof reportedRun.spentUsd === "number" ? reportedRun.spentUsd : undefined,
          budgetUsd: typeof reportedRun.budgetUsd === "number" ? reportedRun.budgetUsd : undefined,
          questions: asked
        };
      }
      workflows = {
        status: wfStatus,
        workflows: listed,
        run: runRow,
        note: typeof wv.note === "string" ? wv.note : ""
      };
      // The host has answered, so whatever was in flight is over.
      wfBusy = false;
      renderWorkflows();
      return;
    }
    if (message.type === "rewind") {
      var rv = message.view && typeof message.view === "object" ? message.view : {};
      var rewindStatus = rv.status === "ready" || rv.status === "off" ||
        rv.status === "unavailable" ? rv.status : "loading";
      var points = [];
      var reportedPoints = Array.isArray(rv.checkpoints) ? rv.checkpoints : [];
      for (var k = 0; k < reportedPoints.length; k += 1) {
        var point = reportedPoints[k];
        if (!point || typeof point.id !== "string" || point.id === "") continue;
        if (typeof point.confirmation !== "string" || point.confirmation === "") continue;
        // Rebuilt field by field, like every other list on this boundary. The
        // two identity fields are required rather than defaulted: a row
        // missing either is a row this page could not send, and rendering it
        // would put a button on screen that does nothing.
        points.push({
          id: point.id,
          confirmation: point.confirmation,
          label: typeof point.label === "string" ? point.label : "",
          timestamp: typeof point.timestamp === "number" ? point.timestamp : 0,
          fileCount: typeof point.fileCount === "number" ? point.fileCount : 0,
          deleteCount: typeof point.deleteCount === "number" ? point.deleteCount : 0,
          detail: typeof point.detail === "string" ? point.detail : ""
        });
      }
      renderRewind({
        status: rewindStatus,
        checkpoints: points,
        truncated: rv.truncated === true,
        note: typeof rv.note === "string" ? rv.note : ""
      });
      return;
    }
    if (message.type === "commands") {
      var commandStatus = message.status === "ready" || message.status === "unavailable"
        ? message.status : "loading";
      var rows = [];
      var listed = Array.isArray(message.commands) ? message.commands : [];
      for (var c = 0; c < listed.length; c += 1) {
        var entry = listed[c];
        if (!entry || typeof entry.name !== "string" || entry.name === "") continue;
        // Rebuilt field by field, like every other boundary in this extension.
        rows.push({
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
          kind: entry.kind === "builtin" ? "builtin" : "skill",
          source: typeof entry.source === "string" ? entry.source : undefined
        });
      }
      renderCommands(commandStatus, rows);
      return;
    }
  });

  /** Rebuild a context list field by field, like every other inbound list. */
  function contextItems(raw) {
    var out = [];
    var list = Array.isArray(raw) ? raw : [];
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      if (!entry || typeof entry.id !== "string" || entry.id === "") continue;
      out.push({
        id: entry.id,
        path: typeof entry.path === "string" ? entry.path : "",
        label: typeof entry.label === "string" && entry.label !== "" ? entry.label : entry.id,
        bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
        kind: typeof entry.kind === "string" ? entry.kind : "file",
        ok: entry.ok === true,
        reason: typeof entry.reason === "string" ? entry.reason : undefined
      });
    }
    return out;
  }

  /*
   * A selection, rebuilt field by field like everything else that crosses in.
   *
   * Two finite numbers or nothing: these end up in a rendered sentence about
   * what the next prompt will carry, and 'undefined-NaN' would be the chip
   * saying something nobody can act on.
   */
  function lineRange(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    var range = entry.selection;
    if (!range || typeof range !== "object") return undefined;
    var from = range.startLine;
    var to = range.endLine;
    if (typeof from !== "number" || typeof to !== "number") return undefined;
    if (!isFinite(from) || !isFinite(to)) return undefined;
    return { startLine: from, endLine: to };
  }

  renderChip();
  renderModeChip();
  renderCapability();
  renderChips();
  renderDryRun();
  renderSessionsCwd("");
  syncComposer();
  post({ type: "ready" });
  // Asked for once on load rather than only when something opens it: the whole
  // job of the review card is to be there without being looked for.
  post({ type: "requestDryRun" });
})();
`;

/**
 * The sidebar's script: the pure modules first, then the page.
 *
 * Concatenation rather than `import` because the page has no module loader —
 * see this file's header. The order matters only in that every function is
 * declared before the IIFE that closes over it runs.
 */
export const SIDEBAR_SCRIPT = [
  MARKDOWN_SOURCE,
  MODEL_LIST_SOURCE,
  SESSION_LIST_SOURCE,
  TRANSCRIPT_SOURCE,
  CONTEXT_SOURCE,
  COMMAND_MENU_SOURCE,
  PERMISSION_SOURCE,
  CLIENT_SOURCE,
].join("\n");
