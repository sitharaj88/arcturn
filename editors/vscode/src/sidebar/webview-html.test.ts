import { describe, expect, it } from "vitest";
import { SIDEBAR_SCRIPT, SIDEBAR_STYLE } from "./webview-client.js";
import { createNonce, renderSidebarHtml } from "./webview-html.js";

const nonce = "AbCd1234AbCd1234";

function html(): string {
  return renderSidebarHtml({ nonce, cspSource: "vscode-webview://abc" });
}

describe("renderSidebarHtml", () => {
  it("locks the page down to nothing by default", () => {
    expect(html()).toContain("default-src 'none'");
  });

  it("allows exactly one nonce'd script and no inline fallback", () => {
    const page = html();
    expect(page).toContain(`script-src 'nonce-${nonce}'`);
    expect(page).not.toContain("unsafe-inline");
    expect(page).not.toContain("unsafe-eval");
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).toContain(`<script nonce="${nonce}">`);
  });

  it("loads no remote content of any kind", () => {
    const page = html();
    expect(page).not.toMatch(/<script[^>]*\ssrc=/);
    expect(page).not.toMatch(/<link[^>]*\shref=/);
    // Nothing in the markup can start a request on its own.
    expect(page).not.toMatch(/<(?:img|iframe|frame|embed|object|audio|video|source|track)\b/i);
    // Nor can the stylesheet.
    expect(SIDEBAR_STYLE).not.toMatch(/@import/);
    expect(SIDEBAR_STYLE).not.toMatch(/url\(/);
    // Nor the script: the page has no network surface at all, which is what
    // makes the missing `connect-src` in the CSP a statement rather than an
    // oversight.
    for (const fetcher of [
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "importScripts",
      "sendBeacon",
      "import(",
    ]) {
      expect(SIDEBAR_SCRIPT).not.toContain(fetcher);
    }
  });

  it("names an absolute url only where a literal is required, never as a thing to load", () => {
    // This used to be `expect(page).not.toMatch(/https?:\/\//)`, which was a
    // fine proxy for "loads nothing remote" right up until the page learned to
    // render links and draw its own icons. Three literals are now unavoidable:
    // the SVG namespace, which `createElementNS` takes by name, and the two
    // schemes the markdown parser allowlists. They are enumerated rather than
    // banned, so a fourth one appearing is still a test failure — which a
    // loosened regex would not have been.
    const found = html().match(/https?:\/\/[^\s"')]*/g) ?? [];
    expect(new Set(found)).toEqual(new Set(["http://www.w3.org/2000/svg", "http://", "https://"]));
  });

  it("carries the client script and stylesheet inline", () => {
    const page = html();
    expect(page).toContain(SIDEBAR_SCRIPT);
    expect(page).toContain(SIDEBAR_STYLE);
  });

  it("refuses a nonce that could break out of the attribute", () => {
    for (const bad of ["", "short", 'a" onload="x', "abc-def-ghi-jkl-mno"]) {
      expect(() => renderSidebarHtml({ nonce: bad, cspSource: "x" })).toThrow(/nonce/i);
    }
  });

  it("escapes the csp source into the meta tag", () => {
    const page = renderSidebarHtml({ nonce, cspSource: 'x"y' });
    expect(page).not.toContain('x"y');
    expect(page).toContain("x&quot;y");
  });

  it("is keyboard reachable: the prompt box and every control are focusable elements", () => {
    const page = html();
    expect(page).toMatch(/<textarea[^>]*id="prompt"/);
    // One send button, which wears a stop face while a run is in flight — so
    // there is no second control here to be reachable or to fall out of sync.
    expect(page).toMatch(/<button[^>]*id="send"/);
    expect(page).not.toMatch(/id="abort"/);
    // The model selector is a button and a text input, not a div with a click
    // handler: the whole point of putting it in the panel is that it is
    // reachable, and a keyboard user has to be able to reach it too.
    expect(page).toMatch(/<button[^>]*id="model"/);
    expect(page).toMatch(/<input[^>]*id="model-search"/);
    expect(page).toMatch(/<button[^>]*id="new-session"/);
    expect(page).toMatch(/<button[^>]*id="sessions"/);
    // Same for history, which used to be a native quick-pick and is now a view
    // in the panel: a search box, a way back, and a way to start fresh.
    expect(page).toMatch(/<input[^>]*id="sessions-search"/);
    expect(page).toMatch(/<button[^>]*id="sessions-back"/);
    expect(page).toMatch(/<button[^>]*id="sessions-new"/);
  });

  it("puts every composer control in the tab order, not behind a hover", () => {
    const page = html();
    // RFC 0005 §2's composer is one control, and all of it is reachable: the
    // two things on the left, the two chips, and the two menus they open.
    expect(page).toMatch(/<button[^>]*id="attach"/);
    expect(page).toMatch(/<button[^>]*id="context"/);
    expect(page).toMatch(/<button[^>]*id="mode"/);
    expect(page).toMatch(/<button[^>]*id="mode-close"/);
  });

  it("announces the @ and / menus as a listbox the composer controls", () => {
    const page = html();
    // The composer *is* the search box for both menus — focus never leaves the
    // textarea — so the combobox relationship hangs off the textarea rather
    // than off a field of the popover's own.
    expect(page).toMatch(/id="prompt"[^>]*aria-haspopup="listbox"/s);
    expect(page).toMatch(/id="prompt"[^>]*aria-controls="suggest"/s);
    expect(page).toMatch(/id="suggest-list"[^>]*role="listbox"/s);
    // The mode popover deliberately is *not* a listbox: it has no search box
    // to own the arrow keys, so its four modes are focusable buttons in a
    // labelled group rather than options with nothing driving them.
    expect(page).toMatch(/id="mode-list"[^>]*role="group"/s);
    expect(page).toMatch(/id="mode"[^>]*aria-haspopup="listbox"/s);
    // A refused mode change is announced, not just tinted.
    expect(page).toMatch(/id="mode-status"[^>]*aria-live="polite"/s);
  });

  it("puts the @ / and menus above the composer rather than over it", () => {
    // Load-bearing placement: `.suggest` is anchored with `bottom: 100%`, so it
    // floats above whatever `#dock` holds. Moved out of `#dock` it would
    // position against `#root` and silently cover the message being written —
    // which is the one thing a list completing that message must not do.
    const page = html();
    const dock = page.indexOf('<div id="dock">');
    const suggest = page.indexOf('id="suggest"');
    const composer = page.indexOf('<div class="composer">');
    expect(dock).toBeGreaterThan(-1);
    expect(suggest).toBeGreaterThan(dock);
    expect(suggest).toBeLessThan(composer);
    expect(SIDEBAR_STYLE).toMatch(/#dock \{[^}]*position: relative/s);
    expect(SIDEBAR_STYLE).toMatch(/\.suggest \{[^}]*bottom: 100%/s);
  });

  it("reserves the permission region for the panel, outside the transcript", () => {
    // The security property behind moving permission prompts off native
    // modals (RFC 0005 §2, amended). `#turns` is where assistant prose, tool
    // arguments and tool results are appended; `#permission` is in `#dock`,
    // which nothing but the panel's own chrome writes into. A card can
    // therefore never appear where model text appears — and the script builds
    // every node with textContent, so a model cannot author a button anywhere.
    const page = html();
    const dock = page.indexOf('<div id="dock">');
    const transcriptEnd = page.indexOf("</main>");
    const region = page.indexOf('id="permission"');
    expect(region).toBeGreaterThan(transcriptEnd);
    expect(region).toBeGreaterThan(dock);
    expect(page.indexOf('id="permission-actions"')).toBeGreaterThan(region);
  });

  it("announces the permission card as the assertive thing on the page", () => {
    const page = html();
    // A request blocks a run, so it is the one live region on this page that
    // interrupts rather than waits its turn.
    expect(page).toMatch(/id="permission-ask"[^>]*aria-label="[^"]+"/s);
    // On the description, which changes per request — not on the heading,
    // which never does and would therefore never announce anything.
    expect(page).toMatch(/id="permission-desc"[^>]*aria-live="assertive"/s);
    // The strip that covers the native-modal path stays polite: it is a
    // status, not a question.
    expect(page).toMatch(/id="permission-strip"[^>]*aria-live="polite"/s);
  });

  it("ships the permission card with no buttons in the markup", () => {
    // Every button is built from the host's validated choice list, so a card
    // can never show an Allow the host did not offer — including the "allow
    // for this session" the engine attaches a rule for and only then.
    const page = html();
    const card = page.slice(
      page.indexOf('id="permission-ask"'),
      page.indexOf("</section>", page.indexOf('id="permission-ask"')),
    );
    expect(card).not.toMatch(/<button/);
  });

  it("gives the chip row a list role, so what is attached is enumerable", () => {
    expect(html()).toMatch(/id="chips"[^>]*role="list"/s);
  });

  it("gives the model list the roles a screen reader needs to announce it", () => {
    const page = html();
    expect(page).toMatch(/id="model"[^>]*aria-haspopup="listbox"/s);
    expect(page).toMatch(/id="model-list"[^>]*role="listbox"/s);
    expect(page).toMatch(/id="model-search"[^>]*role="combobox"/s);
  });

  it("gives the session list the same roles the model list has", () => {
    const page = html();
    expect(page).toMatch(/id="sessions-view"[^>]*role="dialog"/s);
    expect(page).toMatch(/id="sessions-list"[^>]*role="listbox"/s);
    expect(page).toMatch(/id="sessions-search"[^>]*role="combobox"/s);
    expect(page).toMatch(/id="sessions"[^>]*aria-controls="sessions-view"/s);
  });

  it("marks the transcript as a live region so streamed text is announced", () => {
    const page = html();
    expect(page).toMatch(/id="transcript"[^>]*role="log"/s);
    expect(page).toMatch(/id="transcript"[^>]*aria-live="polite"/s);
    // …and keeps the purely visual working indicator out of it. It is shown
    // and hidden several times across a run with tools in it, and each toggle
    // inside a live region is another "Working" announced over the answer.
    // The semantic version of the same state is already in the composer hint,
    // which the prompt box names in aria-describedby and which is written only
    // when its words actually change.
    expect(page).toMatch(/id="working"[^>]*aria-hidden="true"/s);
  });

  it("ships every element the client script reaches for", () => {
    // The script is a string: a renamed id is invisible to tsc and shows up as
    // a panel that renders nothing, with the TypeError inside a devtools
    // console nobody has open. This is the cheap version of that check.
    const page = html();
    const ids = SIDEBAR_SCRIPT.match(/\$\("([a-z-]+)"\)/g) ?? [];
    expect(ids.length).toBeGreaterThan(10);
    for (const reference of new Set(ids)) {
      const id = reference.slice(3, -2);
      expect(page, `the client script looks up #${id}, which the page does not contain`).toContain(
        `id="${id}"`,
      );
    }
  });
});

describe("createNonce", () => {
  it("produces an attribute-safe value of usable length", () => {
    const value = createNonce();
    expect(value).toMatch(/^[A-Za-z0-9]{16,}$/);
  });

  it("does not repeat", () => {
    expect(createNonce()).not.toBe(createNonce());
  });
});

describe("the client script", () => {
  it("never builds DOM from a string, so engine output cannot become markup", () => {
    expect(SIDEBAR_SCRIPT).not.toContain("innerHTML");
    expect(SIDEBAR_SCRIPT).not.toContain("innerText");
    expect(SIDEBAR_SCRIPT).not.toContain("outerHTML");
    expect(SIDEBAR_SCRIPT).not.toContain("insertAdjacentHTML");
    expect(SIDEBAR_SCRIPT).not.toContain("document.write");
    expect(SIDEBAR_SCRIPT).not.toMatch(/\beval\(/);
    expect(SIDEBAR_SCRIPT).not.toContain("new Function");
  });

  it("validates inbound host messages before acting on them", () => {
    expect(SIDEBAR_SCRIPT).toContain("KNOWN_HOST_MESSAGES");
  });

  it("sets no inline style attribute, so nothing depends on how a host reads style-src", () => {
    // The composer grows with the grid/attr() mirror in the stylesheet rather
    // than with a measured pixel height, which is what makes this assertable.
    expect(SIDEBAR_SCRIPT).not.toMatch(/\.style\s*[.[]/);
    expect(SIDEBAR_SCRIPT).not.toMatch(/setAttribute\(\s*"style"/);
    expect(SIDEBAR_SCRIPT).not.toContain("cssText");
  });

  it("keeps every literal colour inside the brand tokens, so every theme is covered", () => {
    // The rule this started as — no literal colour anywhere — was right about
    // the hazard and wrong about the exception, because the panel does have
    // one colour of its own. So the rule is now: a literal may exist only in a
    // `--arc-brand*` declaration, which is defined once, given a light-theme
    // value, and handed back to the theme under high contrast. A literal
    // anywhere else is still a theme this panel gets wrong, and still fails.
    // Shadows keep their old exemption: no --vscode-* token exists for one.
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
    const colours = SIDEBAR_STYLE.match(literal) ?? [];
    const inShadows =
      (SIDEBAR_STYLE.match(/box-shadow:[^;]*/g) ?? []).join(" ").match(literal) ?? [];
    const inFallbacks = SIDEBAR_STYLE.match(/--arc-border:[^;]*rgba?\(/g) ?? [];
    const inBrand =
      (SIDEBAR_STYLE.match(/--arc-brand[a-z-]*:[^;]*/g) ?? []).join(" ").match(literal) ?? [];
    expect(colours.length).toBe(inShadows.length + inFallbacks.length + inBrand.length);
  });

  it("gives the brand a light value and hands it back under high contrast", () => {
    // A single amber cannot be right on both a white and a black editor, and
    // in high contrast the user has already chosen their colours over ours.
    expect(SIDEBAR_STYLE).toMatch(/body\.vscode-light\s*\{[^}]*--arc-brand:/s);
    expect(SIDEBAR_STYLE).toMatch(
      /body\.vscode-high-contrast[^{]*\{[^}]*--arc-brand: var\(--vscode-focusBorder/s,
    );
    // And the send button stops painting itself when the OS forces colours.
    expect(SIDEBAR_STYLE).toMatch(/forced-colors: active\)\s*\{\s*\.send \{[^}]*ButtonFace/s);
  });

  it("turns every animation off under prefers-reduced-motion", () => {
    // The house rule, and the reason it is asserted structurally rather than
    // as a list of names: a per-animation opt-out is one new @keyframes away
    // from being wrong, and the panel that reads as polished to one user is
    // the one that makes another feel sick. The override is universal, so a
    // motion added tomorrow is covered the day it is written.
    const at = SIDEBAR_STYLE.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(-1);
    let depth = 0;
    let end = at;
    for (let i = SIDEBAR_STYLE.indexOf("{", at); i < SIDEBAR_STYLE.length; i += 1) {
      if (SIDEBAR_STYLE[i] === "{") depth += 1;
      if (SIDEBAR_STYLE[i] === "}") depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
    const block = SIDEBAR_STYLE.slice(at, end + 1);
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(block).toContain("animation-duration: 1ms !important");
    expect(block).toContain("animation-iteration-count: 1 !important");
    expect(block).toContain("transition-duration: 1ms !important");
    // Nothing is display:none'd or visibility-hidden'd to stop it moving: the
    // panel has to stay entirely usable, not become a quieter dead one.
    expect(block).not.toContain("display: none");
    expect(block).not.toContain("visibility: hidden");
    // And every keyframe animation the sheet defines is inside the sheet the
    // override applies to — no motion is smuggled in from anywhere else.
    expect((SIDEBAR_STYLE.match(/@keyframes/g) ?? []).length).toBeGreaterThan(2);
  });

  it("keeps the hint for a screen reader after taking it off the screen", () => {
    // The sentence competed with two chips and a send button for one narrow
    // row, and said what the button's own face already says. It is clipped
    // rather than removed because it is the textarea's aria-describedby: a
    // screen reader still needs to be told that Enter sends and Escape stops,
    // which is the half a sighted user reads off the button.
    expect(SIDEBAR_STYLE).toMatch(/\.sr-only \{[^}]*clip-path: inset\(50%\)/s);
    expect(SIDEBAR_STYLE).not.toMatch(/\.hint \{/);
    expect(html()).toMatch(/id="prompt"[^>]*aria-describedby="hint"/s);
    expect(html()).toMatch(/id="hint" class="sr-only"/);
  });

  it("truncates the model chip before the mode chip, which is the one that lies when cut", () => {
    // "Claude Sonne…" still names a model and the full id is one click away;
    // "Accept edi…" names nothing, and the mode is a four-way choice about what
    // the agent may do to somebody's files.
    expect(SIDEBAR_STYLE).toMatch(/#model \{[^}]*flex: 1 1 auto/s);
    expect(SIDEBAR_STYLE).toMatch(/#mode \{[^}]*flex-shrink: 0\.15/s);
    // And neither is ever removed at a narrow width.
    expect(SIDEBAR_STYLE).not.toMatch(/@media \(max-width: 380px\)[^}]*#(model|mode)/s);
  });

  it("wraps the chip row rather than scrolling it sideways", () => {
    // Horizontal overflow is the panel's one unrecoverable layout failure, and
    // a strip of chips is the newest thing that could cause it.
    expect(SIDEBAR_STYLE).toMatch(/\.chips \{[^}]*flex-wrap: wrap/s);
  });

  it("keeps long code inside its own box rather than widening a 300px panel", () => {
    // Horizontal overflow is the sidebar's one unrecoverable layout failure:
    // there is no gesture that scrolls the panel back. The transcript refuses
    // to scroll sideways at all, and the one element allowed to be wider than
    // the panel scrolls within itself.
    expect(SIDEBAR_STYLE).toMatch(/#transcript\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(SIDEBAR_STYLE).toMatch(/\.code-block pre\s*\{[^}]*overflow-x:\s*auto/s);
    expect(SIDEBAR_STYLE).toMatch(/body\s*\{[^}]*overflow:\s*hidden/s);
  });

  it("parses as JavaScript", () => {
    // The script ships as a string, so a syntax error in it is invisible to
    // tsc and to every other test in this file — and the failure it produces
    // is a sidebar that renders nothing, with the error inside a webview
    // devtools console nobody has open. Compiling it is the cheapest way to
    // know it is at least a program. It is never *run* here: it reaches for
    // `document` and `acquireVsCodeApi` the moment it does.
    expect(() => new Function(SIDEBAR_SCRIPT)).not.toThrow();
  });

  it("closes no script tag early, which would break out of the inline block", () => {
    expect(SIDEBAR_SCRIPT).not.toContain("</script");
    expect(SIDEBAR_STYLE).not.toContain("</style");
  });
});
