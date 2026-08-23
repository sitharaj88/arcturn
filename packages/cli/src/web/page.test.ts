/**
 * The page must be one self-contained file: no build step, no bundler, and —
 * because `arcturn serve` may well be running on a machine with no internet
 * access, behind a strict CSP, or on a phone on a plane — no external request
 * of any kind.
 */

import { describe, expect, it } from "vitest";
import { renderWebClientPage, WEB_CLIENT_TITLE } from "./page.js";
import { APP_SCRIPT } from "./script/app.js";
import { MODEL_SCRIPT } from "./script/model.js";
import { WEB_CLIENT_CSS } from "./styles.js";

const html = renderWebClientPage({ wsPort: 7717 });

/**
 * The only absolute URL the document may contain: the SVG XML namespace inside
 * the inline favicon. It is an identifier, not a fetch — no browser resolves
 * it — so it is stripped before the "no external URLs" assertion.
 */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

describe("the served page is self-contained", () => {
  it("references no external origin", () => {
    const withoutNamespace = html.split(SVG_NAMESPACE).join("");
    expect(withoutNamespace).not.toContain("http://");
    expect(withoutNamespace).not.toContain("https://");
    expect(withoutNamespace).not.toContain("//cdn");
    expect(withoutNamespace).not.toContain("//fonts");
  });

  it("loads no external script, stylesheet, font or image", () => {
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link[^>]*rel=["']?stylesheet/i);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/@font-face/);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    for (const match of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
      const value = match[1] ?? "";
      expect(value.startsWith("data:") || value.startsWith("#")).toBe(true);
    }
  });

  it("fetches nothing at runtime either", () => {
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest/);
    expect(html).not.toMatch(/importScripts/);
    expect(html).not.toMatch(/EventSource/);
    expect(html).not.toMatch(/import\s*\(/);
  });

  it("inlines both halves of the client verbatim", () => {
    expect(html).toContain(MODEL_SCRIPT);
    expect(html).toContain(APP_SCRIPT);
    expect(html).toContain("<style");
  });

  it("never lets an inlined script close its own element early", () => {
    // A single "</script" anywhere in the source would end the element and
    // spill the rest of the client into the document as text.
    expect(MODEL_SCRIPT.toLowerCase()).not.toContain("</script");
    expect(APP_SCRIPT.toLowerCase()).not.toContain("</script");
    expect(WEB_CLIENT_CSS.toLowerCase()).not.toContain("</style");
    expect((html.match(/<script/g) ?? []).length).toBe(3);
    expect((html.match(/<\/script>/g) ?? []).length).toBe(3);
  });

  it("tells the page which WebSocket port to dial", () => {
    expect(html).toContain('window.__ARCTURN__ = {"wsPort":7717}');
    const withUrl = renderWebClientPage({ wsPort: 1, wsUrl: "ws://box:9000" });
    expect(withUrl).toContain('"wsUrl":"ws://box:9000"');
  });

  it("escapes < inside the embedded config so nothing can close the script early", () => {
    const page = renderWebClientPage({ wsPort: 1, wsUrl: "</script><script>alert(1)" });
    expect(page).not.toContain("</script><script>alert(1)");
    expect(page).toContain("\\u003c/script>");
  });
});

describe("the page is mobile-first and accessible", () => {
  it("declares a responsive, notch-aware viewport", () => {
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width");
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("interactive-widget=resizes-content");
  });

  it("respects the safe area and the on-screen keyboard", () => {
    expect(html).toContain("env(safe-area-inset-bottom");
    expect(html).toContain("env(safe-area-inset-top");
    expect(html).toContain("--app-h");
    expect(html).toContain("visualViewport");
  });

  it("gives touch targets a real minimum size", () => {
    expect(html).toContain("--tap: 44px");
    expect(html).toContain("min-height: var(--tap)");
  });

  it("honours prefers-reduced-motion and both colour schemes", () => {
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("prefers-color-scheme: light");
    expect(html).toContain('name="color-scheme"');
  });

  it("uses semantic landmarks, labels and a visible focus ring", () => {
    expect(html).toContain("<header");
    expect(html).toContain("<main");
    expect(html).toContain("<form");
    expect(html).toContain('role="log"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Message the session"');
    expect(html).toContain(":focus-visible");
    expect(html).toContain('class="skip"');
  });

  it("wears the same brand marks as the CLI", () => {
    expect(html).toContain(`<title>${WEB_CLIENT_TITLE}`);
    expect(html).toContain("✦");
    // The TUI's dark palette, verbatim.
    expect(html).toContain("#7aa2f7");
    expect(html).toContain("#9ece6a");
    expect(html).toContain("#f7768e");
    // The brand gradient from logo.ts.
    expect(html).toContain("#a78bfa");
    expect(html).toContain("#22d3ee");
  });

  it("never asks the browser to remember the token", () => {
    expect(html).toContain('id="token-input"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="off"');
    // The token is never rendered into the document by the server.
    expect(html).not.toContain("#token=");
  });
});

describe("the page's nonce plumbing", () => {
  it("stamps the nonce on every inline style and script", () => {
    const page = renderWebClientPage({ wsPort: 1, nonce: "abc123==" });
    expect(page).toContain('<style nonce="abc123==">');
    expect((page.match(/<script nonce="abc123==">/g) ?? []).length).toBe(3);
  });

  it("omits the attribute entirely when no nonce is supplied", () => {
    expect(html).toContain("<style>");
    expect(html).not.toContain("nonce=");
  });
});
