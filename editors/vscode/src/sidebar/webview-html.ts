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
 *
 * One placement here is load-bearing rather than incidental: `#suggest` — the
 * `@` picker and the `/` menu — lives **inside** `#dock` rather than beside
 * `#model-popover`, because the stylesheet anchors it to the top of the dock
 * (`bottom: 100%`) so it floats above the composer instead of over it. A list
 * that completes what you are typing must not cover what you are typing.
 * Moving that element out of `#dock` would leave it positioned against
 * `#root` and silently put it back on top of the composer.
 *
 * `#permission` is load-bearing for a different reason, and it is a security
 * one. It is the region a permission request is rendered into, and it is a
 * sibling of the composer inside `#dock` — *not* a child of `#transcript`. The
 * transcript is where assistant prose, tool arguments and tool results are
 * appended; the dock is written only by the panel's own chrome. Keeping the
 * two apart is what makes an in-panel permission card safe to offer at all:
 * the worst a model can do is write a sentence that says "click Allow below",
 * and it lands in a region that has no buttons in it. See RFC 0005 §2.
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
      <p id="capability" class="empty-line capability hidden"></p>
      <div id="starters" class="starters"></div>
    </div>
    <div id="turns"></div>
    <div id="working" class="working hidden" aria-hidden="true">
      <span id="working-mark" class="working-mark"></span>
      <span>Working</span>
      <span class="working-dots"><span class="working-dot"></span><span
        class="working-dot"></span><span class="working-dot"></span></span>
    </div>
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

  <section id="rewind-view" class="fullview hidden" role="dialog" aria-modal="false"
    aria-label="Rewind to an earlier turn">
    <div class="fullview-head">
      <button id="rewind-back" class="icon-button" type="button"></button>
      <h2 class="fullview-title">Rewind</h2>
    </div>
    <p id="rewind-warning" class="rewind-warning">Rewinding restores files to how they were
      before a turn &mdash; and deletes files created since. It cannot be undone.</p>
    <div id="rewind-status" class="popover-status"></div>
    <div id="rewind-list" class="popover-list fullview-list" role="listbox"
      aria-label="Rewindable turns"></div>
  </section>

  <div id="dock">
    <div id="suggest" class="popover suggest hidden" role="dialog" aria-modal="false"
      aria-label="Insert into the message">
      <div id="suggest-status" class="popover-status hidden"></div>
      <div id="suggest-list" class="popover-list" role="listbox" aria-label="Suggestions"></div>
    </div>

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

    <!--
      The permission surface. One region, two states, and it is inside #dock
      rather than in #turns on purpose (RFC 0005 section 2): the transcript is
      where model output lands, and a control that grants a tool must never
      share a container with text a model wrote. Nothing in this page ever
      appends to #permission except the permission renderer.

      The STRIP is what is left of the modal-only world - the one line that
      says a request is outstanding on the path that still raises a native
      dialog. The CARD is the request itself, and every field in it is filled
      by textContent from the host's validated payload.
    -->
    <section id="permission" class="permission hidden" aria-label="Permission request">
      <div id="permission-strip" class="permission-strip hidden" role="status" aria-live="polite">
        <span id="permission-icon"></span>
        <span id="permission-text"></span>
      </div>
      <div id="permission-ask" class="permission-ask hidden" role="group"
        aria-label="Arcturn is asking for permission">
        <div class="permission-head">
          <span id="permission-ask-icon"></span>
          <span class="permission-title">Arcturn is asking for permission</span>
        </div>
        <!--
          The live region is the DESCRIPTION, not the heading. The heading never
          changes, so a live region on it would never fire; the description is
          what carries the new request, and it is written while the card is
          already un-hidden. Assertive because a run is blocked on it.
        -->
        <p id="permission-desc" class="permission-desc" aria-live="assertive"></p>
        <div class="permission-facts">
          <span class="permission-key">Tool</span>
          <span id="permission-tool" class="permission-value"></span>
          <span class="permission-key">On</span>
          <span id="permission-subject" class="permission-value"></span>
        </div>
        <pre id="permission-args" class="permission-args hidden"></pre>
        <p id="permission-origin" class="permission-origin hidden"></p>
        <p id="permission-more" class="permission-more hidden" role="status" aria-live="polite"></p>
        <div id="permission-actions" class="permission-actions"></div>
      </div>
    </section>

    <section id="dryrun" class="dryrun hidden" aria-label="Pending dry-run changes">
      <div class="dryrun-head" role="status" aria-live="polite">
        <span id="dryrun-icon"></span>
        <span id="dryrun-text" class="dryrun-text"></span>
      </div>
      <div id="dryrun-files" class="dryrun-files" role="list"></div>
      <p id="dryrun-note" class="dryrun-note hidden" role="status" aria-live="polite"></p>
      <div class="dryrun-actions">
        <button id="dryrun-review" class="dryrun-button" type="button">Review</button>
        <button id="dryrun-apply" class="dryrun-button dryrun-primary" type="button">Apply</button>
        <button id="dryrun-discard" class="dryrun-button dryrun-danger" type="button">Discard</button>
      </div>
    </section>

    <!--
      The workflow surface. Two panes, one section, and only one of them is
      ever up: the CATALOG a '/workflow' opens (what this workspace defines,
      with each pipeline's ceiling and each role's derived lane), and the RUN
      card that replaces it once one is started. The card is where an ORG-ASK
      question surfaces, with a box for the person's own words — the panel
      never answers one and never summarises one.
    -->
    <section id="wf" class="wf hidden" aria-label="Workflows">
      <div id="wf-catalog" class="wf-catalog hidden">
        <div class="wf-head">
          <span id="wf-catalog-icon"></span>
          <span id="wf-catalog-text" class="wf-text"></span>
          <button id="wf-close" class="wf-close" type="button" aria-label="Close workflows">&times;</button>
        </div>
        <div id="wf-list" class="wf-list" role="list"></div>
      </div>
      <div id="wf-run" class="wf-run hidden">
        <div class="wf-head" role="status" aria-live="polite">
          <span id="wf-run-icon"></span>
          <span id="wf-run-text" class="wf-text"></span>
        </div>
        <p id="wf-run-meta" class="wf-meta"></p>
        <div id="wf-questions" class="wf-questions hidden">
          <p id="wf-question-text" class="wf-question"></p>
          <label class="wf-answer-label" for="wf-answer">Your answer</label>
          <textarea id="wf-answer" class="wf-answer" rows="2"
            aria-label="Answer the workflow's question"></textarea>
          <div class="wf-actions">
            <button id="wf-send-answer" class="wf-button wf-primary" type="button">Answer &amp; resume</button>
          </div>
        </div>
        <p id="wf-note" class="wf-note hidden" role="status" aria-live="polite"></p>
      </div>
    </section>

    <div class="composer">
      <div id="chips" class="chips hidden" role="list" aria-label="Attached context"></div>
      <div id="grow" class="grow" data-value="">
        <textarea id="prompt" rows="1" aria-label="Message Arcturn" aria-describedby="hint"
          aria-haspopup="listbox" aria-expanded="false" aria-controls="suggest"
          placeholder="Ask Arcturn to do something&hellip;"></textarea>
      </div>
      <div class="composer-bar">
        <button id="attach" class="tool-button" type="button"></button>
        <button id="context" class="tool-button" type="button"></button>
        <button id="model" class="chip" type="button" aria-haspopup="listbox"
          aria-expanded="false" aria-controls="model-popover">
          <span id="model-icon"></span>
          <span id="model-label" class="chip-label">Select model</span>
          <span id="model-caret"></span>
        </button>
        <button id="mode" class="chip" type="button" aria-haspopup="listbox"
          aria-expanded="false" aria-controls="mode-popover">
          <span id="mode-icon"></span>
          <span id="mode-label" class="chip-label">Permissions</span>
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

  <div id="mode-popover" class="popover hidden" role="dialog" aria-modal="false"
    aria-label="Permission mode">
    <div class="popover-head">
      <h2 class="popover-title">What Arcturn may do</h2>
      <button id="mode-close" class="icon-button" type="button"></button>
    </div>
    <div id="mode-status" class="popover-status hidden" role="status" aria-live="polite"></div>
    <div id="mode-list" class="popover-list" role="group" aria-label="Permission modes"></div>
  </div>
</div>
<script nonce="${nonce}">${SIDEBAR_SCRIPT}</script>
</body>
</html>`;
}
