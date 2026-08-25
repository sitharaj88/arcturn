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

import { MARKDOWN_SOURCE } from "./webview-markdown.js";
import { MODEL_LIST_SOURCE } from "./webview-models.js";
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
.brand { display: flex; color: var(--vscode-textLink-foreground); }
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
.turn { position: relative; padding: 8px 12px; }
.turn + .turn { border-top: 1px solid var(--arc-border); }
.turn + .turn { border-top-color: color-mix(in srgb, var(--arc-border) 60%, transparent); }
.turn-user { background: var(--arc-surface); }
.turn-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 0.8em;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--arc-muted);
}
.turn-user .turn-head { color: var(--vscode-foreground); }
.turn-assistant .avatar { color: var(--vscode-textLink-foreground); }
.turn-body > * + * { margin-top: 6px; }
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
  border: 1px solid color-mix(in srgb, var(--arc-border) 60%, transparent);
  border-radius: 3px;
  background: var(--arc-code-bg);
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

.permission {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid var(--arc-warn);
  border-radius: var(--arc-radius);
  font-size: 0.9em;
  color: var(--arc-warn);
  background: var(--vscode-inputValidation-warningBackground, transparent);
}

.composer {
  border: 1px solid var(--vscode-input-border, var(--arc-border));
  border-radius: var(--arc-radius);
  background: var(--vscode-input-background);
}
.composer:focus-within { border-color: var(--vscode-focusBorder); }
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
  gap: 6px;
  padding: 4px 6px 6px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 60%;
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
.hint {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.8em;
  color: var(--arc-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}
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
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  cursor: pointer;
}
.send:hover { background: var(--vscode-button-hoverBackground); }
.send:disabled { opacity: 0.4; cursor: default; }
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
.model-row, .session-row {
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
.model-row:hover, .model-row.active, .session-row:hover, .session-row.active {
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
}
.model-top, .session-top { display: flex; align-items: center; gap: 6px; }
.model-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.dot-present { color: var(--arc-ok); }
.dot-unknown { color: var(--arc-muted); }
.dot-absent { color: var(--arc-err); opacity: 0.75; }
.model-name, .session-name { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
    state: 1, connection: 1, cost: 1, models: 1, session: 1, sessions: 1, showSessions: 1
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
  var stopButton = $("abort");
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

  $("brand").appendChild(icon("sparkle"));
  $("empty-mark").appendChild(icon("sparkle"));
  $("new-session").appendChild(icon("plus"));
  $("new-session").setAttribute("aria-label", "New session");
  $("new-session").title = "New session";
  sessionsButton.appendChild(icon("history"));
  sessionsButton.setAttribute("aria-label", "Sessions");
  sessionsButton.title = "Sessions";
  $("sessions-back").appendChild(icon("arrowLeft"));
  $("sessions-back").setAttribute("aria-label", "Back to the conversation");
  $("sessions-back").title = "Back to the conversation";
  $("model-close").appendChild(icon("close"));
  $("model-close").setAttribute("aria-label", "Close");
  $("model-icon").appendChild(icon("sparkle"));
  $("model-caret").appendChild(icon("chevronDown"));
  $("plan-chevron").appendChild(icon("chevron", "chevron"));
  $("permission-icon").appendChild(icon("warning"));
  $("working-mark").appendChild(icon("sparkle"));
  sendButton.appendChild(icon("send"));
  stopButton.appendChild(icon("stop"));

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
   * Motion bookkeeping. hydrated is false for the first paint of a transcript
   * and for the first after a session switch, so a restored conversation does
   * not animate its whole history in at once. wasRunning makes the end-of-turn
   * mark fire on the transition out of a run, not on every idle repaint.
   */
  var hydrated = false;
  var wasRunning = false;
  var lastAssistantTurn = null;

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
    var sub = [];
    if (sessionId) sub.push(sessionId.length > 12 ? sessionId.slice(0, 8) : sessionId);
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
      entry.badge.appendChild(
        el("span", settled ? "tool-status arc-pop" : "tool-status", toolStatusLabel(block.status))
      );
      entry.head.title = block.name + (entry.summary.textContent ? " — " + entry.summary.textContent : "");
      entry.body.className = "tool-body" + (opening(prev, block) ? " arc-reveal" : "");
      entry.body.classList.toggle("hidden", block.collapsed);
      if (!block.collapsed) {
        clear(entry.body);
        labelledPre(entry.body, "Arguments", block.argsText);
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
  var TURN_ICON = { user: "", assistant: "sparkle", notice: "" };

  function createTurn(role, entering) {
    var wrap = el("section", "turn turn-" + role + (entering ? " arc-enter" : ""));
    var body = el("div", "turn-body");
    if (TURN_LABEL[role]) {
      var head = el("div", "turn-head");
      if (TURN_ICON[role]) head.appendChild(icon(TURN_ICON[role], "avatar"));
      head.appendChild(el("span", "", TURN_LABEL[role]));
      wrap.appendChild(head);
    }
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
    sendButton.disabled = !ready() || !typed;
    sendButton.setAttribute("aria-label", running ? "Steer this run" : "Send");
    sendButton.title = running ? "Steer this run" : "Send";
    stopButton.classList.toggle("hidden", !running);
    stopButton.disabled = !running;
    modelChip.disabled = !ready();
    starterButtons.forEach(function (node) { node.disabled = !ready(); });

    var words = [];
    if (!ready()) words.push("Not connected");
    else if (running && typed) words.push("Enter steers this run");
    else if (running) words.push("Running…");
    else words.push("Enter to send, Shift+Enter for a new line");
    // Written only when it changed: this element is the textarea's
    // aria-describedby, and replacing its text node on every keystroke makes a
    // screen reader re-announce the same sentence as the user types.
    var hintText = words.join(" · ");
    if (hint.textContent !== hintText) hint.textContent = hintText;
    permission.classList.toggle("hidden", view.pendingPermissions <= 0);
    if (view.pendingPermissions > 0) {
      permissionText.textContent = view.pendingPermissions === 1
        ? "Arcturn is asking for permission — answer the dialog to continue."
        : String(view.pendingPermissions) + " permission requests are waiting on you.";
    }
  }

  function send() {
    var text = promptBox.value;
    if (!ready() || text.trim() === "") return;
    post({ type: "send", text: text });
    promptBox.value = "";
    syncComposer();
    promptBox.focus();
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
    // Once, on the transition — a panel that has been sitting finished for
    // ten minutes must not flash every time the host repaints it.
    if (wasRunning && !view.running && lastAssistantTurn !== null) {
      lastAssistantTurn.el.classList.add("turn-settled");
    }
    wasRunning = view.running;
    renderPlan(view.plan, view.todos);
    syncComposer();
    if (stick) transcript.scrollTop = transcript.scrollHeight;
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

  sendButton.addEventListener("click", send);
  stopButton.addEventListener("click", function () { post({ type: "abort" }); });
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

  promptBox.addEventListener("input", syncComposer);
  promptBox.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

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
  });

  renderChip();
  renderSessionsCwd("");
  syncComposer();
  post({ type: "ready" });
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
  CLIENT_SOURCE,
].join("\n");
