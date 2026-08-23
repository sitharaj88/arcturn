import { describe, expect, it } from "vitest";
import { redactSecrets, summarizeBody } from "./errors.js";
import {
  exchangeAuthorizationCode,
  oauthErrorFrom,
  parseOAuthBody,
  postOAuthRequest,
  refreshAccessToken,
  toEpochMs,
  toOAuthTokens,
} from "./token.js";
import type { FetchLike, HttpRequestInit } from "./types.js";

function stubFetch(
  responder: (url: string, init?: HttpRequestInit) => { status?: number; body: string },
): { fetch: FetchLike; sent: Array<{ url: string; init?: HttpRequestInit }> } {
  const sent: Array<{ url: string; init?: HttpRequestInit }> = [];
  const fetch: FetchLike = (url, init) => {
    sent.push({ url, ...(init ? { init } : {}) });
    const { status = 200, body } = responder(url, init);
    return Promise.resolve({
      ok: status < 400,
      status,
      text: () => Promise.resolve(body),
    });
  };
  return { fetch, sent };
}

describe("parseOAuthBody", () => {
  it("reads JSON, form encoding and empty bodies", () => {
    expect(parseOAuthBody('{"access_token":"a"}')).toEqual({ access_token: "a" });
    expect(parseOAuthBody("access_token=a&token_type=bearer")).toEqual({
      access_token: "a",
      token_type: "bearer",
    });
    expect(parseOAuthBody("   ")).toEqual({});
    expect(parseOAuthBody("<html>nope</html>")).toEqual({});
    expect(parseOAuthBody("{not json")).toEqual({});
  });
});

describe("toOAuthTokens", () => {
  it("resolves expires_in against the injected clock", () => {
    const tokens = toOAuthTokens(
      { access_token: "a", token_type: "bearer", expires_in: 60, scope: "x y" },
      { now: () => 1_000 },
    );
    expect(tokens).toEqual({
      accessToken: "a",
      tokenType: "bearer",
      expiresAt: 61_000,
      scopes: ["x", "y"],
    });
  });

  it("accepts an absolute expires_at in seconds or milliseconds", () => {
    expect(toOAuthTokens({ access_token: "a", expires_at: 1_700_000_000 }).expiresAt).toBe(
      1_700_000_000_000,
    );
    expect(toOAuthTokens({ access_token: "a", expires_at: 1_700_000_000_000 }).expiresAt).toBe(
      1_700_000_000_000,
    );
    expect(toEpochMs(10)).toBe(10_000);
  });

  it("keeps the previous refresh token and scopes when the response omits them", () => {
    const tokens = toOAuthTokens(
      { access_token: "a2" },
      { previous: { accessToken: "a1", tokenType: "Bearer", refreshToken: "r1", scopes: ["s"] } },
    );
    expect(tokens.refreshToken).toBe("r1");
    expect(tokens.scopes).toEqual(["s"]);
    expect(tokens.tokenType).toBe("Bearer");
  });

  it("rejects a response with no access token", () => {
    expect(() => toOAuthTokens({ token_type: "bearer" })).toThrow(/no access_token/);
  });
});

describe("oauthErrorFrom", () => {
  it("returns undefined for a success body and an OAuthError otherwise", () => {
    expect(oauthErrorFrom({ access_token: "a" }, {})).toBeUndefined();
    const error = oauthErrorFrom(
      { error: "invalid_grant", error_description: "expired" },
      { status: 400, provider: "anthropic" },
    );
    expect(error?.code).toBe("invalid_grant");
    expect(error?.status).toBe(400);
    expect(error?.provider).toBe("anthropic");
    expect(error?.message).toBe("invalid_grant: expired");
  });
});

describe("postOAuthRequest", () => {
  it("form-encodes by default and JSON-encodes on request", async () => {
    const form = stubFetch(() => ({ body: "{}" }));
    await postOAuthRequest({ url: "https://x.test/t", params: { a: "1", b: "2" } }, form);
    expect(form.sent[0]?.init?.body).toBe("a=1&b=2");
    expect(form.sent[0]?.init?.headers?.["content-type"]).toContain("x-www-form-urlencoded");

    const json = stubFetch(() => ({ body: "{}" }));
    await postOAuthRequest({ url: "https://x.test/t", params: { a: "1" }, format: "json" }, json);
    expect(json.sent[0]?.init?.body).toBe('{"a":"1"}');
    expect(json.sent[0]?.init?.headers?.["content-type"]).toBe("application/json");
  });

  it("returns an error body rather than throwing, so the device flow can inspect it", async () => {
    const { fetch } = stubFetch(() => ({ status: 400, body: '{"error":"slow_down"}' }));
    const result = await postOAuthRequest({ url: "https://x.test/t", params: {} }, { fetch });
    expect(result.ok).toBe(false);
    expect(result.body).toEqual({ error: "slow_down" });
  });

  it("throws on an unparsable failure body, with the body redacted and truncated", async () => {
    const { fetch } = stubFetch(() => ({
      status: 502,
      body: `<html>gateway down access_token="sk-ant-oat01-abcdefghijklmnopqrst"</html>`,
    }));
    const error = await postOAuthRequest({ url: "https://x.test/t", params: {} }, { fetch }).catch(
      (err: unknown) => err as Error,
    );
    expect(error.message).toContain("HTTP 502");
    expect(error.message).not.toContain("sk-ant-oat01");
  });

  it("wraps a transport failure without leaking the secrets it was sent", async () => {
    const fetch: FetchLike = () =>
      Promise.reject(new Error("connect ECONNREFUSED verifier-123456"));
    const error = await postOAuthRequest(
      { url: "https://x.test/t", params: {}, secrets: ["verifier-123456"] },
      { fetch },
    ).catch((err: unknown) => err as Error);
    expect(error.message).toContain("Request to https://x.test/t failed");
    expect(error.message).not.toContain("verifier-123456");
  });
});

describe("exchangeAuthorizationCode", () => {
  it("sends the PKCE verifier and returns tokens", async () => {
    const { fetch, sent } = stubFetch(() => ({
      body: JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 10 }),
    }));
    const tokens = await exchangeAuthorizationCode(
      {
        tokenEndpoint: "https://x.test/token",
        clientId: "c",
        code: "code-1",
        codeVerifier: "verifier-1",
        redirectUri: "http://127.0.0.1:1/callback",
        state: "state-1",
      },
      { fetch, now: () => 0 },
    );
    const params = new URLSearchParams(sent[0]?.init?.body ?? "");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code_verifier")).toBe("verifier-1");
    expect(params.get("state")).toBe("state-1");
    expect(tokens).toEqual({
      accessToken: "a",
      refreshToken: "r",
      tokenType: "Bearer",
      expiresAt: 10_000,
    });
  });

  it("surfaces the provider's rejection", async () => {
    const { fetch } = stubFetch(() => ({
      status: 400,
      body: '{"error":"invalid_grant","error_description":"code already used"}',
    }));
    await expect(
      exchangeAuthorizationCode(
        {
          tokenEndpoint: "https://x.test/token",
          clientId: "c",
          code: "code-1",
          codeVerifier: "v",
          redirectUri: "http://127.0.0.1:1/callback",
        },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("refreshAccessToken", () => {
  it("refuses without a stored refresh token", async () => {
    await expect(
      refreshAccessToken({
        tokenEndpoint: "https://x.test/token",
        clientId: "c",
        previous: { accessToken: "a", tokenType: "Bearer" },
        provider: "anthropic",
      }),
    ).rejects.toMatchObject({ code: "arcturn_refresh_failed" });
  });

  it("sends the refresh grant and merges the response", async () => {
    const { fetch, sent } = stubFetch(() => ({
      body: JSON.stringify({ access_token: "a2", expires_in: 30 }),
    }));
    const tokens = await refreshAccessToken(
      {
        tokenEndpoint: "https://x.test/token",
        clientId: "c",
        previous: { accessToken: "a1", tokenType: "Bearer", refreshToken: "r1" },
      },
      { fetch, now: () => 1_000 },
    );
    const params = new URLSearchParams(sent[0]?.init?.body ?? "");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("r1");
    expect(tokens).toEqual({
      accessToken: "a2",
      refreshToken: "r1",
      tokenType: "Bearer",
      expiresAt: 31_000,
    });
  });

  it("surfaces a revoked refresh token", async () => {
    const { fetch } = stubFetch(() => ({ status: 400, body: '{"error":"invalid_grant"}' }));
    await expect(
      refreshAccessToken(
        {
          tokenEndpoint: "https://x.test/token",
          clientId: "c",
          previous: { accessToken: "a", tokenType: "Bearer", refreshToken: "r" },
        },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("redaction", () => {
  it("scrubs credential fields, known token shapes and supplied literals", () => {
    expect(redactSecrets('{"access_token":"abc123","x":1}')).toBe(
      '{"access_token":"[redacted]","x":1}',
    );
    expect(redactSecrets("refresh_token=zzz&state=ok")).toBe("refresh_token=[redacted]&state=ok");
    expect(redactSecrets("bearer ghu_abcdefghijklmnopqrstuvwxyz")).toContain("[redacted]");
    expect(redactSecrets("value is hunter2-secret-value", ["hunter2-secret-value"])).toBe(
      "value is [redacted]",
    );
    // Short strings are never treated as secrets: redacting them would eat the message.
    expect(redactSecrets("no such user", ["user"])).toBe("no such user");
  });

  it("truncates long bodies", () => {
    expect(summarizeBody("x".repeat(500), { limit: 20 })).toHaveLength(21);
  });
});
