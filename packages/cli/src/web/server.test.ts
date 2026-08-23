/**
 * The one-page HTTP server: what it serves, what it refuses, the headers that
 * keep the page locked down, and the origin list `arcturn serve` has to hand
 * `ArcturnServer` so a browser's WebSocket upgrade is not rejected.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  formatWebUrl,
  startWebClientServer,
  type WebClientServer,
  webClientOrigins,
} from "./server.js";

const running: WebClientServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
});

async function start(wsPort = 7717): Promise<WebClientServer> {
  const server = await startWebClientServer({ host: "127.0.0.1", port: 0, wsPort: () => wsPort });
  running.push(server);
  return server;
}

describe("the browser-client server", () => {
  it("serves the page on / and on /index.html", async () => {
    const server = await start();
    for (const path of ["/", "/index.html", "/?token=ignored"]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await response.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain('window.__ARCTURN__ = {"wsPort":7717}');
    }
  });

  it("reads the WebSocket port at request time, not at bind time", async () => {
    let port = 0;
    const server = await startWebClientServer({ host: "127.0.0.1", port: 0, wsPort: () => port });
    running.push(server);
    port = 4242;
    const body = await (await fetch(server.url)).text();
    expect(body).toContain('{"wsPort":4242}');
  });

  it("answers HEAD without a body", async () => {
    const server = await start();
    const response = await fetch(server.url, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(1000);
  });

  it("refuses anything that is not a GET or HEAD", async () => {
    const server = await start();
    const response = await fetch(server.url, { method: "POST", body: "x" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("has exactly one path and 404s the rest", async () => {
    const server = await start();
    for (const path of ["/other", "/../etc/passwd", "/index.html/extra"]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it("locks the page down with a nonce-pinned CSP and hardening headers", async () => {
    const server = await start(9000);
    const response = await fetch(server.url);
    const body = await response.text();
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // Without this, a scripting failure would submit the token form for real
    // and put the token in a URL.
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    // Only the host the page came from, and only over a WebSocket.
    expect(policy).toContain("connect-src ws://127.0.0.1:* wss://127.0.0.1:*");

    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).toContain(`<style nonce="${nonce}">`);

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("uses a fresh nonce for every response", async () => {
    const server = await start();
    const first = (await fetch(server.url)).headers.get("content-security-policy");
    const second = (await fetch(server.url)).headers.get("content-security-policy");
    expect(first).not.toBe(second);
  });

  it("follows the Host header so a LAN or tunnel name can still connect", () => {
    expect(contentSecurityPolicy("n", "phone.local")).toContain(
      "connect-src ws://phone.local:* wss://phone.local:*",
    );
  });

  it("never serves a token", async () => {
    const server = await start();
    const body = await (await fetch(server.url)).text();
    expect(body).not.toMatch(/token["']?\s*[:=]\s*["'][^"']+["']/);
  });

  it("stops cleanly and stops answering", async () => {
    const server = await start();
    await server.stop();
    running.pop();
    await expect(fetch(server.url)).rejects.toThrow();
    // A second stop is a no-op, not a crash.
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

describe("webClientOrigins", () => {
  it("always allows the loopback spellings of the page's own port", () => {
    const origins = webClientOrigins("127.0.0.1", 8788);
    expect(origins).toContain("http://127.0.0.1:8788");
    expect(origins).toContain("http://localhost:8788");
    expect(origins).toContain("http://[::1]:8788");
  });

  it("allows the bound address when it is a concrete one", () => {
    expect(webClientOrigins("192.168.1.5", 8788)).toContain("http://192.168.1.5:8788");
  });

  it("enumerates this machine's LAN addresses for a wildcard bind", () => {
    const origins = webClientOrigins("0.0.0.0", 8788);
    // Whatever the interfaces are, none may be a wildcard the browser cannot
    // send, and loopback must still be there.
    expect(origins).toContain("http://127.0.0.1:8788");
    expect(origins).not.toContain("http://0.0.0.0:8788");
    for (const origin of origins) expect(origin.startsWith("http")).toBe(true);
  });

  it("accepts extra origins for tunnels, and never duplicates one", () => {
    const origins = webClientOrigins("127.0.0.1", 8788, [
      "https://arcturn.example.ts.net",
      "http://localhost:8788",
      "  ",
    ]);
    expect(origins).toContain("https://arcturn.example.ts.net");
    expect(origins.filter((origin) => origin === "http://localhost:8788")).toHaveLength(1);
    expect(origins).not.toContain("");
  });

  it("brackets a literal IPv6 host in a URL", () => {
    expect(formatWebUrl("::1", 80)).toBe("http://[::1]:80");
    expect(formatWebUrl("[::1]", 80)).toBe("http://[::1]:80");
    expect(formatWebUrl("127.0.0.1", 80)).toBe("http://127.0.0.1:80");
  });
});
