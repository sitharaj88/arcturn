/**
 * The sidebar page, and the CSP that makes it safe to put model output in.
 *
 * RFC 0004 §3: "Webview hardened: strict CSP, no remote content,
 * `retainContextWhenHidden` off unless measured necessary, all messages
 * validated at the boundary."
 *
 * The policy here is `default-src 'none'` with exactly two grants: the single
 * nonce'd `<script>` and the single nonce'd `<style>`. No `unsafe-inline`, no
 * `unsafe-eval`, no `img-src` beyond the webview's own resource origin, no
 * `connect-src` at all — the page never talks to anything; the extension host
 * does, and posts it messages.
 *
 * The skeleton below is the panel's *structure* only: every element it names
 * is empty, and `webview-client.ts` fills it. Nothing here interpolates a
 * value except the nonce and `cspSource`, both of which are validated or
 * escaped, so the markup in this file is a constant and there is no path by
 * which engine output becomes part of it.
 *
 * Pure: the nonce and the webview's `cspSource` are parameters, so the whole
 * page is assertable in a test with no `vscode` and no DOM.
 */

import { randomBytes } from "node:crypto";
import { SIDEBAR_SCRIPT, SIDEBAR_STYLE } from "./webview-client.js";

/** A nonce must be attribute-safe; anything else could break out of the tag. */
const SAFE_NONCE = /^[A-Za-z0-9]{16,}$/;

/**
 * Generate a nonce for one page load.
 *
 * A nonce is only sound if it is unpredictable and used once, so it comes from
 * `crypto.randomBytes` rather than `Math.random`, and the caller mints a fresh
 * one every time the page is rendered.
 */
export function createNonce(): string {
  return randomBytes(16)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "");
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inputs for {@link renderSidebarHtml}. */
export interface SidebarHtmlOptions {
  /** Per-load nonce, from {@link createNonce}. */
  nonce: string;
  /** `webview.cspSource` — the origin local resources are served from. */
  cspSource: string;
}

/**
 * Render the sidebar page.
 *
 * @param options - See {@link SidebarHtmlOptions}.
 * @throws {TypeError} When the nonce is not attribute-safe.
 */
export function renderSidebarHtml(options: SidebarHtmlOptions): string {
  if (!SAFE_NONCE.test(options.nonce)) {
    throw new TypeError("Webview nonce must be at least 16 alphanumeric characters");
  }
  const nonce = options.nonce;
  const source = escapeAttribute(options.cspSource);
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${source} data:`,
    `font-src ${source}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Arcturn</title>
<style nonce="${nonce}">${SIDEBAR_STYLE}</style>
</head>
<body>
<div id="root">
  <header id="header">
    <span id="brand" class="brand"></span>
    <span class="session">
      <span id="session-title" class="session-title">Arcturn</span>
      <span id="session-sub" class="session-sub"></span>
    </span>
    <span id="cost" class="cost" aria-label="Session cost"></span>
    <button id="new-session" class="icon-button" type="button"></button>
    <button id="sessions" class="icon-button" type="button" aria-expanded="false"
      aria-controls="sessions-view"></button>
  </header>

  <div id="banner" class="hidden" role="status" aria-live="polite">
    <span id="banner-text" class="banner-text"></span>
    <pre id="engine-output" class="engine-output hidden"></pre>
    <div id="banner-actions" class="row"></div>
  </div>

  <main id="transcript" role="log" aria-live="polite" aria-relevant="additions text"
    aria-label="Conversation" tabindex="0">
    <div id="empty" class="empty">
      <span id="empty-mark" class="empty-mark"></span>
      <h1 class="empty-title">Arcturn</h1>
      <p class="empty-line">The agent behind the CLI, working in this workspace &mdash; it reads
        your files, runs commands, and asks before anything it cannot undo.</p>
      <div id="starters" class="starters"></div>
    </div>
    <div id="turns"></div>
  </main>

  <div class="jump-wrap">
    <button id="jump" class="jump hidden" type="button">Jump to latest</button>
  </div>

  <section id="sessions-view" class="fullview hidden" role="dialog" aria-modal="false"
    aria-label="Session history">
    <div class="fullview-head">
      <button id="sessions-back" class="icon-button" type="button"></button>
      <h2 class="fullview-title">Sessions</h2>
    </div>
    <div class="popover-head">
      <input id="sessions-search" class="popover-search" type="text" autocomplete="off"
        spellcheck="false" role="combobox" aria-expanded="true" aria-controls="sessions-list"
        aria-autocomplete="list" aria-label="Search sessions"
        placeholder="Search sessions&hellip;">
    </div>
    <button id="sessions-new" class="session-new" type="button"></button>
    <div id="sessions-status" class="popover-status"></div>
    <div id="sessions-list" class="popover-list fullview-list" role="listbox"
      aria-label="Sessions"></div>
  </section>

  <div id="dock">
    <section id="plan-card" class="plan-card hidden open" aria-label="Plan">
      <button id="plan-toggle" class="disclosure" type="button" aria-expanded="true"
        aria-controls="plan-body">
        <span id="plan-chevron"></span>
        <span>Plan</span>
        <span id="plan-count" class="tool-badge"></span>
      </button>
      <div id="plan-body" class="plan-body">
        <p id="plan-text" class="plan-text hidden"></p>
        <ul id="todos" class="todos"></ul>
      </div>
    </section>

    <div id="permission" class="permission hidden" role="status" aria-live="polite">
      <span id="permission-icon"></span>
      <span id="permission-text"></span>
    </div>

    <div class="composer">
      <div id="grow" class="grow" data-value="">
        <textarea id="prompt" rows="1" aria-label="Message Arcturn" aria-describedby="hint"
          placeholder="Ask Arcturn to do something&hellip;"></textarea>
      </div>
      <div class="composer-bar">
        <button id="model" class="chip" type="button" aria-haspopup="listbox"
          aria-expanded="false" aria-controls="model-popover">
          <span id="model-icon"></span>
          <span id="model-label" class="chip-label">Select model</span>
          <span id="model-caret"></span>
        </button>
        <span id="hint" class="hint"></span>
        <button id="abort" class="send stop hidden" type="button" aria-label="Stop"></button>
        <button id="send" class="send" type="button" aria-label="Send" disabled></button>
      </div>
    </div>
  </div>

  <div id="model-popover" class="popover hidden" role="dialog" aria-modal="false"
    aria-label="Choose a model">
    <div class="popover-head">
      <input id="model-search" class="popover-search" type="text" autocomplete="off"
        spellcheck="false" role="combobox" aria-expanded="true" aria-controls="model-list"
        aria-autocomplete="list" aria-label="Search models" placeholder="Search models&hellip;">
      <button id="model-close" class="icon-button" type="button"></button>
    </div>
    <div id="model-status" class="popover-status"></div>
    <div id="model-list" class="popover-list" role="listbox" aria-label="Models"></div>
  </div>
</div>
<script nonce="${nonce}">${SIDEBAR_SCRIPT}</script>
</body>
</html>`;
}
