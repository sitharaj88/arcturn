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
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/<script[^>]*\ssrc=/);
    expect(page).not.toMatch(/<link[^>]*\shref=/);
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
    expect(SIDEBAR_SCRIPT).not.toContain("outerHTML");
    expect(SIDEBAR_SCRIPT).not.toContain("insertAdjacentHTML");
    expect(SIDEBAR_SCRIPT).not.toContain("document.write");
    expect(SIDEBAR_SCRIPT).not.toMatch(/\beval\(/);
    expect(SIDEBAR_SCRIPT).not.toContain("new Function");
  });

  it("validates inbound host messages before acting on them", () => {
    expect(SIDEBAR_SCRIPT).toContain("KNOWN_HOST_MESSAGES");
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
