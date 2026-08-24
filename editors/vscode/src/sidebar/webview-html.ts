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
  <div id="banner" class="hidden" role="status" aria-live="polite">
    <span id="banner-text" class="banner-text"></span>
    <pre id="engine-output" class="engine-output hidden"></pre>
    <div id="banner-actions" class="row"></div>
  </div>
  <div id="side">
    <div id="plan" class="hidden"></div>
    <ul id="todos" class="hidden" aria-label="Todos"></ul>
  </div>
  <div id="transcript" role="log" aria-live="polite" aria-label="Conversation" tabindex="0"></div>
  <div id="composer">
    <textarea id="prompt" rows="3" aria-label="Message Arcturn"
      placeholder="Ask Arcturn — Enter to send, Shift+Enter for a new line"></textarea>
    <div class="row">
      <button id="send" type="button">Send</button>
      <button id="abort" type="button" class="secondary" disabled>Stop</button>
      <button id="sessions" type="button" class="secondary">Sessions</button>
      <button id="model" type="button" class="secondary">Model</button>
      <span id="cost" aria-label="Session cost"></span>
      <span id="hint"></span>
    </div>
  </div>
</div>
<script nonce="${nonce}">${SIDEBAR_SCRIPT}</script>
</body>
</html>`;
}
