import { describe, expect, it } from "vitest";
import { OAuthError } from "./errors.js";
import {
  base64UrlEncode,
  buildAuthorizationUrl,
  computeS256Challenge,
  createCodeVerifier,
  createPkcePair,
  createStateToken,
  LOOPBACK_HOST,
  splitCodeAndState,
  startLoopbackServer,
  statesMatch,
} from "./pkce.js";

/**
 * Hitting the loopback listener the same way a browser would. This is the one
 * place a socket is opened, it is bound to 127.0.0.1 on an ephemeral port, and
 * nothing leaves the machine.
 */
async function visit(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

describe("PKCE primitives", () => {
  it("matches the RFC 7636 appendix B S256 vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(computeS256Challenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("encodes base64url without padding", () => {
    expect(base64UrlEncode(new Uint8Array([116, 101, 115, 116]))).toBe("dGVzdA");
    expect(base64UrlEncode(new Uint8Array([251, 255, 190]))).toBe("-_--");
  });

  it("generates verifiers inside the RFC's length bounds", () => {
    const verifier = createCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(createCodeVerifier(96).length).toBeLessThanOrEqual(128);
    expect(() => createCodeVerifier(8)).toThrow(RangeError);
  });

  it("pairs a verifier with its own challenge, and never repeats", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.method).toBe("S256");
    expect(a.challenge).toBe(computeS256Challenge(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
    expect(createStateToken()).not.toBe(createStateToken());
  });

  it("compares state values without leaking on length", () => {
    const state = createStateToken();
    expect(statesMatch(state, state)).toBe(true);
    expect(statesMatch(state, undefined)).toBe(false);
    expect(statesMatch(state, "")).toBe(false);
    expect(statesMatch(state, `${state}x`)).toBe(false);
    expect(statesMatch(state, `${state.slice(0, -1)}!`)).toBe(false);
  });

  it("splits the code#state callback form some providers use", () => {
    expect(splitCodeAndState("abc")).toEqual({ code: "abc" });
    expect(splitCodeAndState("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
    expect(splitCodeAndState("abc#")).toEqual({ code: "abc" });
  });
});

describe("buildAuthorizationUrl", () => {
  it("carries the S256 challenge, state and scopes", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://example.test/authorize",
        clientId: "client-1",
        redirectUri: "http://127.0.0.1:1234/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
        scopes: ["a", "b"],
        extraParams: { prompt: "consent" },
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1234/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("a b");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("preserves query already present on the endpoint", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://example.test/authorize?tenant=acme",
        clientId: "c",
        redirectUri: "http://127.0.0.1:1/callback",
        state: "s",
        codeChallenge: "cc",
      }),
    );
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("scope")).toBeNull();
  });
});

describe("startLoopbackServer", () => {
  it("binds 127.0.0.1 on an ephemeral port and resolves a matching callback", async () => {
    const server = await startLoopbackServer({ state: "state-1", timeoutMs: 5_000 });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.redirectUri).toBe(`http://${LOOPBACK_HOST}:${server.port}/callback`);

      const page = await visit(`${server.redirectUri}?code=code-1&state=state-1`);
      expect(page.status).toBe(200);
      expect(page.body).toContain("Signed in");

      await expect(server.waitForCallback()).resolves.toEqual({
        code: "code-1",
        state: "state-1",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects a state mismatch without exchanging the code", async () => {
    const server = await startLoopbackServer({ state: "expected", timeoutMs: 5_000 });
    const waiting = server.waitForCallback();
    try {
      const page = await visit(`${server.redirectUri}?code=code-1&state=forged`);
      expect(page.status).toBe(400);
      await expect(waiting).rejects.toMatchObject({ code: "arcturn_state_mismatch" });
    } finally {
      await server.close();
    }
  });

  it("accepts the state smuggled in the code#state form", async () => {
    const server = await startLoopbackServer({ state: "state-9", timeoutMs: 5_000 });
    try {
      await visit(`${server.redirectUri}?code=${encodeURIComponent("code-9#state-9")}`);
      await expect(server.waitForCallback()).resolves.toEqual({
        code: "code-9",
        state: "state-9",
      });
    } finally {
      await server.close();
    }
  });

  it("propagates a provider error from the redirect", async () => {
    const server = await startLoopbackServer({ state: "s", timeoutMs: 5_000 });
    const waiting = server.waitForCallback();
    try {
      await visit(`${server.redirectUri}?error=access_denied&error_description=User%20said%20no`);
      const error = await waiting.catch((err: unknown) => err);
      expect(error).toBeInstanceOf(OAuthError);
      expect((error as OAuthError).code).toBe("access_denied");
      expect((error as OAuthError).message).toContain("User said no");
    } finally {
      await server.close();
    }
  });

  it("rejects a callback with no code", async () => {
    const server = await startLoopbackServer({ state: "s", timeoutMs: 5_000 });
    const waiting = server.waitForCallback();
    try {
      await visit(`${server.redirectUri}?state=s`);
      await expect(waiting).rejects.toMatchObject({ code: "arcturn_bad_response" });
    } finally {
      await server.close();
    }
  });

  it("ignores unrelated paths such as /favicon.ico", async () => {
    const server = await startLoopbackServer({ state: "s", timeoutMs: 5_000 });
    try {
      const page = await visit(`http://${LOOPBACK_HOST}:${server.port}/favicon.ico`);
      expect(page.status).toBe(404);

      await visit(`${server.redirectUri}?code=late&state=s`);
      await expect(server.waitForCallback()).resolves.toMatchObject({ code: "late" });
    } finally {
      await server.close();
    }
  });

  it("times out and stops listening", async () => {
    const server = await startLoopbackServer({ state: "s", timeoutMs: 20 });
    await expect(server.waitForCallback()).rejects.toMatchObject({ code: "arcturn_timeout" });
    // The listener is released on settle, so the port no longer answers.
    await expect(visit(`${server.redirectUri}?code=x&state=s`)).rejects.toThrow();
  });

  it("cancels on an abort signal", async () => {
    const controller = new AbortController();
    const server = await startLoopbackServer({
      state: "s",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const waiting = server.waitForCallback();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "arcturn_cancelled" });
  });

  it("honours a fixed port and path when the provider registered one", async () => {
    const first = await startLoopbackServer({
      state: "s",
      timeoutMs: 5_000,
      path: "/auth/callback",
    });
    try {
      expect(first.redirectUri.endsWith("/auth/callback")).toBe(true);
      await visit(`${first.redirectUri}?code=c&state=s`);
      await expect(first.waitForCallback()).resolves.toMatchObject({ code: "c" });
    } finally {
      await first.close();
    }
  });
});
