/**
 * The browser client's stylesheet, inlined into the page by
 * {@link import("./page.js").renderWebClientPage}.
 *
 * Kept as one string constant (rather than a `.css` file) so the whole client
 * ships in `dist/` as plain JavaScript with no bundler, no copy step and no
 * external request — see `page.ts` for why the page must be self-contained.
 *
 * The palette is `@arcturn/tui`'s `darkTheme` translated to CSS custom
 * properties, plus the brand gradient from `logo.ts`, so a session looks the
 * same in a phone browser as it does in the terminal. A light override is
 * supplied for `prefers-color-scheme: light` using the TUI's `lightTheme`
 * values.
 *
 * @packageDocumentation
 */

/** The complete stylesheet for the browser client. */
export const WEB_CLIENT_CSS = `
*, *::before, *::after { box-sizing: border-box; }

:root {
  color-scheme: dark;
  --bg: #0a0a14;
  --bg-raised: #12121f;
  --bg-card: #161626;
  --bg-input: #0d0d1a;
  --border: #24243a;
  --border-strong: #3b4261;
  --text: #c0caf5;
  --muted: #8b949e;
  --faint: #565f89;
  --accent: #7aa2f7;
  --violet: #a78bfa;
  --cyan: #22d3ee;
  --error: #f7768e;
  --success: #9ece6a;
  --warning: #e0af68;
  --info: #7dcfff;
  --add-fg: #9ece6a;
  --add-bg: #1d2a1f;
  --del-fg: #f7768e;
  --del-bg: #2d2029;
  --shadow: 0 -8px 24px rgba(0, 0, 0, 0.55);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial,
    "Noto Sans", sans-serif;
  --safe-b: env(safe-area-inset-bottom, 0px);
  --safe-t: env(safe-area-inset-top, 0px);
  --tap: 44px;
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #fbfbfe;
    --bg-raised: #ffffff;
    --bg-card: #ffffff;
    --bg-input: #ffffff;
    --border: #d0d7de;
    --border-strong: #8c959f;
    --text: #1f2328;
    --muted: #57606a;
    --faint: #6e7781;
    --accent: #0550ae;
    --violet: #8250df;
    --cyan: #0969da;
    --error: #cf222e;
    --success: #116329;
    --warning: #9a6700;
    --info: #0969da;
    --add-fg: #116329;
    --add-bg: #dafbe1;
    --del-fg: #cf222e;
    --del-bg: #ffebe9;
    --shadow: 0 -8px 24px rgba(31, 35, 40, 0.12);
  }
}

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  height: var(--app-h, 100dvh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 var(--sans);
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  overscroll-behavior: none;
}

:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 2px;
  border-radius: 4px;
}

.skip {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 20;
  padding: 10px 14px;
  background: var(--bg-card);
  color: var(--text);
}
.skip:focus { left: 8px; top: calc(8px + var(--safe-t)); }

/* ------------------------------------------------------------------ header */

.top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: calc(6px + var(--safe-t)) 10px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
}

.brand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--tap);
  min-height: var(--tap);
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--text);
  font: 600 17px/1 var(--mono);
  cursor: pointer;
}
.brand .mark {
  background: linear-gradient(160deg, var(--violet), var(--cyan));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-size: 20px;
  margin-right: 6px;
}

.top-meta { flex: 1 1 auto; min-width: 0; }
.top-title {
  font: 600 13px/1.2 var(--sans);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.top-sub {
  font: 400 11px/1.3 var(--mono);
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.conn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font: 600 11px/1 var(--sans);
  letter-spacing: 0.02em;
  color: var(--muted);
  background: var(--bg-card);
  text-transform: lowercase;
}
.conn::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.conn[data-state="online"] { color: var(--success); }
.conn[data-state="connecting"], .conn[data-state="authenticating"] { color: var(--warning); }
.conn[data-state="offline"] { color: var(--error); }
.conn[data-state="unauthorized"] { color: var(--error); }

/* -------------------------------------------------------------- transcript */

.transcript {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  padding: 12px 12px 4px;
  overscroll-behavior: contain;
}

.block { margin: 0 0 14px; }

.user {
  border-left: 3px solid var(--accent);
  padding: 2px 0 2px 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.md { overflow-wrap: anywhere; }
.md p { margin: 0 0 8px; }
.md h3, .md h4, .md h5 { margin: 12px 0 6px; line-height: 1.3; }
.md h3 { color: var(--accent); font-size: 1.1em; }
.md h4 { color: var(--info); font-size: 1.03em; }
.md h5 { color: var(--violet); font-size: 1em; }
.md ul, .md ol { margin: 0 0 8px; padding-left: 22px; }
.md li { margin: 2px 0; }
.md blockquote {
  margin: 0 0 8px;
  padding-left: 10px;
  border-left: 2px solid var(--faint);
  color: var(--muted);
  font-style: italic;
}
.md hr { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
.md code {
  font: 0.92em/1.4 var(--mono);
  color: var(--warning);
  background: var(--bg-card);
  border-radius: 4px;
  padding: 1px 4px;
}
.md pre {
  margin: 0 0 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card);
  overflow-x: auto;
  font: 12.5px/1.5 var(--mono);
  color: var(--text);
  white-space: pre;
}
.md .url { color: var(--faint); font: 0.85em var(--mono); }

/* -------------------------------------------------------------- tool calls */

.tool { font-size: 14px; }
.tool-head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  overflow: hidden;
}
.tool-dot { color: var(--accent); flex: none; }
.tool-dot[data-status="ok"] { color: var(--success); }
.tool-dot[data-status="error"] { color: var(--error); }
.tool-dot[data-status="asking"] { color: var(--warning); }
.tool-glyph { color: var(--accent); flex: none; font-family: var(--mono); }
.tool-name { font-weight: 600; color: var(--text); flex: none; }
.tool-subject {
  color: var(--muted);
  font: 12.5px/1.4 var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.tool-elapsed { color: var(--faint); font-size: 11.5px; flex: none; }

.result {
  margin: 4px 0 0 6px;
  padding-left: 10px;
  border-left: 1px solid var(--border);
  font: 12.5px/1.5 var(--mono);
  color: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.result.error { color: var(--error); }
.result.ok { color: var(--success); }
.result .line { display: block; }
.result .more { color: var(--faint); font-style: italic; }

.diff {
  margin: 4px 0 0 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow-x: auto;
  background: var(--bg-card);
}
.diff-head {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font: 600 12.5px/1.4 var(--mono);
  position: sticky;
  left: 0;
}
.diff-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-add { color: var(--add-fg); }
.diff-del { color: var(--del-fg); }
.diff-row {
  display: flex;
  font: 12px/1.45 var(--mono);
  white-space: pre;
}
.diff-row.add { background: var(--add-bg); color: var(--add-fg); }
.diff-row.del { background: var(--del-bg); color: var(--del-fg); }
.diff-row.ctx { color: var(--muted); }
.diff-row.sep { color: var(--faint); }
.diff-no {
  flex: none;
  min-width: 3.5em;
  padding: 0 8px 0 6px;
  text-align: right;
  color: var(--faint);
  background: var(--bg-raised);
  position: sticky;
  left: 0;
}
.diff-text { padding-right: 10px; }

/* ------------------------------------------------------------------ notices */

.notice { font-size: 13.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.notice.info { color: var(--info); }
.notice.warn { color: var(--warning); }
.notice.error { color: var(--error); }
.notice.muted { color: var(--faint); }
.notice.done { color: var(--success); }
.notice .mark { font-family: var(--mono); margin-right: 6px; }

.subagent {
  border-left: 2px solid var(--violet);
  padding-left: 10px;
  font-size: 13.5px;
}
.subagent .task { color: var(--violet); font-weight: 600; }
.subagent .step {
  display: block;
  color: var(--faint);
  font: 12px/1.5 var(--mono);
  overflow-wrap: anywhere;
}

/* ------------------------------------------------------------------- live */

.live {
  flex: none;
  max-height: 34vh;
  overflow-y: auto;
  padding: 0 12px;
  border-top: 1px solid transparent;
}
.live:empty { display: none; }

.todos {
  flex: none;
  max-height: 26vh;
  overflow-y: auto;
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-raised);
  list-style: none;
  font-size: 13.5px;
}
.todos:empty { display: none; }
.todos li { display: flex; gap: 8px; padding: 2px 0; overflow-wrap: anywhere; }
.todos .mark { font-family: var(--mono); flex: none; }
.todos li[data-status="done"] { color: var(--faint); text-decoration: line-through; }
.todos li[data-status="inProgress"] { color: var(--accent); font-weight: 600; }

.activity {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  color: var(--muted);
  font-size: 12.5px;
  border-top: 1px solid var(--border);
}
.activity[hidden] { display: none; }
.spin {
  display: inline-block;
  width: 1em;
  color: var(--info);
  font-family: var(--mono);
}

/* --------------------------------------------------------------- composer */

.composer {
  flex: none;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 8px 10px calc(8px + var(--safe-b));
  border-top: 1px solid var(--border);
  background: var(--bg-raised);
}

.composer textarea {
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--tap);
  max-height: 30vh;
  resize: none;
  padding: 11px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--bg-input);
  color: var(--text);
  font: 16px/1.4 var(--sans);
}
.composer textarea::placeholder { color: var(--faint); }

button {
  font: 600 14px/1 var(--sans);
  border-radius: 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-card);
  color: var(--text);
  min-height: var(--tap);
  min-width: var(--tap);
  padding: 0 14px;
  cursor: pointer;
  touch-action: manipulation;
}
button[hidden] { display: none; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary {
  border-color: transparent;
  background: linear-gradient(120deg, var(--violet), var(--cyan));
  color: #0a0a14;
}
button.danger { border-color: var(--error); color: var(--error); }
button.ghost { background: transparent; }

/* ----------------------------------------------------------------- sheets */

.scrim {
  position: fixed;
  inset: 0;
  background: rgba(5, 5, 10, 0.62);
  z-index: 10;
}
.scrim[hidden] { display: none; }

.sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 11;
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  padding: 14px 14px calc(14px + var(--safe-b));
  border-top: 1px solid var(--border-strong);
  border-radius: 16px 16px 0 0;
  background: var(--bg-raised);
  box-shadow: var(--shadow);
}
.sheet[hidden] { display: none; }
@media (min-width: 700px) {
  .sheet {
    left: 50%;
    right: auto;
    bottom: 24px;
    width: min(680px, calc(100vw - 48px));
    transform: translateX(-50%);
    border-radius: 16px;
    border: 1px solid var(--border-strong);
  }
}

.sheet h2 {
  margin: 0 0 4px;
  font: 700 15px/1.3 var(--sans);
  display: flex;
  align-items: center;
  gap: 8px;
}
.sheet h2 .mark { color: var(--warning); font-family: var(--mono); }
.sheet .hint { margin: 0 0 10px; color: var(--muted); font-size: 13px; }

.subject {
  flex: 0 1 auto;
  overflow: auto;
  max-height: 42dvh;
  margin: 0 0 10px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-input);
  font: 13px/1.5 var(--mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text);
}
.subject .label {
  display: block;
  color: var(--faint);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.gate {
  margin: -4px 0 10px;
  color: var(--warning);
  font-size: 12.5px;
}
.gate[hidden] { display: none; }

.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.actions button { flex: 1 1 auto; }

.sessions { list-style: none; margin: 0 0 10px; padding: 0; overflow-y: auto; }
.sessions li { margin: 0 0 6px; }
.sessions button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  font-weight: 500;
}
.sessions .id { font: 600 13px/1.3 var(--mono); }
.sessions .meta { display: block; color: var(--faint); font: 11.5px/1.4 var(--mono); }
.sessions li[data-current="true"] button { border-color: var(--accent); }

.token-form { display: flex; flex-direction: column; gap: 10px; }
.token-form input {
  min-height: var(--tap);
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--bg-input);
  color: var(--text);
  font: 16px/1.3 var(--mono);
}
.token-error { color: var(--error); font-size: 13px; }
.token-error[hidden] { display: none; }

.empty { color: var(--faint); font-size: 13.5px; padding: 8px 0; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`;
