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
    expect(page).toMatch(/<button[^>]*id="send"/);
    expect(page).toMatch(/<button[^>]*id="abort"/);
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

  it("uses only vs code theme tokens for colour, so every theme is covered", () => {
    // Any literal colour is a theme this panel gets wrong. Shadows are the one
    // exception: there is no --vscode-* token for one, and a translucent black
    // reads correctly over both a light and a dark widget background.
    const colours = SIDEBAR_STYLE.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    const shadows = SIDEBAR_STYLE.match(/box-shadow:[^;]*/g) ?? [];
    const inShadows = shadows.join(" ").match(/\brgba?\(/g) ?? [];
    const inFallbacks = SIDEBAR_STYLE.match(/--arc-border:[^;]*rgba?\(/g) ?? [];
    expect(colours.length).toBe(inShadows.length + inFallbacks.length);
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
