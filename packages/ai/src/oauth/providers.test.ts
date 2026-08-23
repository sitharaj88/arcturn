import { afterEach, describe, expect, it } from "vitest";
import { oauthAuthHeaders } from "./headers.js";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  applyOAuthEnvOverrides,
  configureOAuthProvider,
  exchangeSecondStageCredential,
  GITHUB_COPILOT_PROVIDER,
  getOAuthProviderConfig,
  listOAuthProviders,
  OAUTH_CONSTANTS,
  OPENAI_CODEX_PROVIDER,
  registerOAuthProvider,
  requireOAuthProviderConfig,
  resetOAuthProviders,
} from "./providers.js";
import type { FetchLike, HttpRequestInit } from "./types.js";

afterEach(() => {
  resetOAuthProviders();
});

describe("the built-in registry", () => {
  it("covers the three subscription providers", () => {
    expect(listOAuthProviders()).toEqual([
      ANTHROPIC_OAUTH_PROVIDER,
      GITHUB_COPILOT_PROVIDER,
      OPENAI_CODEX_PROVIDER,
    ]);
  });

  it("gives every provider the endpoints its flow needs", () => {
    for (const provider of listOAuthProviders()) {
      const config = requireOAuthProviderConfig(provider);
      expect(config.clientId).not.toBe("");
      expect(config.tokenEndpoint).toMatch(/^https:\/\//);
      expect(config.scopes.length).toBeGreaterThan(0);
      if (config.flow === "pkce") {
        expect(config.authorizationEndpoint).toMatch(/^https:\/\//);
      } else {
        expect(config.deviceAuthorizationEndpoint).toMatch(/^https:\/\//);
      }
    }
  });

  it("models Copilot as a two-stage credential and the others as one-stage", () => {
    expect(requireOAuthProviderConfig(GITHUB_COPILOT_PROVIDER).flow).toBe("device");
    expect(requireOAuthProviderConfig(GITHUB_COPILOT_PROVIDER).secondStage).toBeDefined();
    expect(requireOAuthProviderConfig(ANTHROPIC_OAUTH_PROVIDER).secondStage).toBeUndefined();
    expect(requireOAuthProviderConfig(OPENAI_CODEX_PROVIDER).secondStage).toBeUndefined();
  });

  it("names the providers that do support OAuth when asked for one that does not", () => {
    expect(getOAuthProviderConfig("google")).toBeUndefined();
    expect(() => requireOAuthProviderConfig("google")).toThrow(/does not support OAuth/);
  });

  it("keeps every external constant in the one documented block", () => {
    const anthropic = requireOAuthProviderConfig(ANTHROPIC_OAUTH_PROVIDER);
    expect(anthropic.clientId).toBe(OAUTH_CONSTANTS.anthropic.clientId);
    expect(anthropic.tokenEndpoint).toBe(OAUTH_CONSTANTS.anthropic.tokenEndpoint);
    const codex = requireOAuthProviderConfig(OPENAI_CODEX_PROVIDER);
    expect(codex.redirectPort).toBe(OAUTH_CONSTANTS.openaiCodex.redirectPort);
  });
});

describe("runtime overrides", () => {
  it("patches a single field without disturbing the rest", () => {
    const patched = configureOAuthProvider(ANTHROPIC_OAUTH_PROVIDER, {
      tokenEndpoint: "https://proxy.test/token",
    });
    expect(patched.tokenEndpoint).toBe("https://proxy.test/token");
    expect(patched.clientId).toBe(OAUTH_CONSTANTS.anthropic.clientId);
    expect(requireOAuthProviderConfig(ANTHROPIC_OAUTH_PROVIDER).tokenEndpoint).toBe(
      "https://proxy.test/token",
    );

    resetOAuthProviders();
    expect(requireOAuthProviderConfig(ANTHROPIC_OAUTH_PROVIDER).tokenEndpoint).toBe(
      OAUTH_CONSTANTS.anthropic.tokenEndpoint,
    );
  });

  it("applies ARCTURN_OAUTH_* environment overrides", () => {
    const changed = applyOAuthEnvOverrides({
      ARCTURN_OAUTH_GITHUB_COPILOT_CLIENT_ID: "Iv1.override",
      ARCTURN_OAUTH_GITHUB_COPILOT_DEVICE_ENDPOINT: "https://ghe.test/login/device/code",
      ARCTURN_OAUTH_ANTHROPIC_SCOPES: "user:inference, user:profile",
      ARCTURN_OAUTH_OPENAI_CODEX_UNRELATED: "ignored",
    });
    expect(changed.sort()).toEqual([ANTHROPIC_OAUTH_PROVIDER, GITHUB_COPILOT_PROVIDER]);

    const copilot = requireOAuthProviderConfig(GITHUB_COPILOT_PROVIDER);
    expect(copilot.clientId).toBe("Iv1.override");
    expect(copilot.deviceAuthorizationEndpoint).toBe("https://ghe.test/login/device/code");
    expect(requireOAuthProviderConfig(ANTHROPIC_OAUTH_PROVIDER).scopes).toEqual([
      "user:inference",
      "user:profile",
    ]);
  });

  it("accepts a wholly new provider", () => {
    registerOAuthProvider({
      provider: "acme",
      displayName: "Acme",
      flow: "pkce",
      clientId: "acme-client",
      authorizationEndpoint: "https://acme.test/authorize",
      tokenEndpoint: "https://acme.test/token",
      scopes: ["all"],
      apiHeaders: (token) => ({ authorization: `Bearer ${token}` }),
    });
    expect(listOAuthProviders()).toContain("acme");
  });
});

describe("oauthAuthHeaders", () => {
  it("gives Anthropic a bearer token plus its beta and version headers", () => {
    const headers = oauthAuthHeaders(ANTHROPIC_OAUTH_PROVIDER, "token-1");
    expect(headers.authorization).toBe("Bearer token-1");
    expect(headers["anthropic-beta"]).toBe(OAUTH_CONSTANTS.anthropic.betaHeader);
    expect(headers["anthropic-version"]).toBe(OAUTH_CONSTANTS.anthropic.apiVersion);
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("gives Copilot its integration headers", () => {
    const headers = oauthAuthHeaders(GITHUB_COPILOT_PROVIDER, "copilot-token");
    expect(headers.authorization).toBe("Bearer copilot-token");
    expect(headers["copilot-integration-id"]).toBe(OAUTH_CONSTANTS.githubCopilot.integrationId);
    expect(headers["editor-version"]).toBe(OAUTH_CONSTANTS.githubCopilot.editorVersion);
  });

  it("falls back to a plain bearer for a provider with no OAuth config", () => {
    expect(oauthAuthHeaders("google", "t")).toEqual({ authorization: "Bearer t" });
  });

  it("lets the caller override or add headers", () => {
    const headers = oauthAuthHeaders(OPENAI_CODEX_PROVIDER, "t", {
      extra: { "chatgpt-account-id": "acct-1" },
    });
    expect(headers).toEqual({ authorization: "Bearer t", "chatgpt-account-id": "acct-1" });
  });
});

describe("exchangeSecondStageCredential", () => {
  const stage2 = {
    endpoint: "https://api.test/copilot_internal/v2/token",
    method: "GET" as const,
    authorization: (stage1: string) => `token ${stage1}`,
    tokenField: "token",
    expiryField: "expires_at",
  };

  function stub(
    status: number,
    body: string,
  ): {
    fetch: FetchLike;
    sent: Array<{ url: string; init?: HttpRequestInit }>;
  } {
    const sent: Array<{ url: string; init?: HttpRequestInit }> = [];
    return {
      sent,
      fetch: (url, init) => {
        sent.push({ url, ...(init ? { init } : {}) });
        return Promise.resolve({
          ok: status < 400,
          status,
          text: () => Promise.resolve(body),
        });
      },
    };
  }

  it("trades the stage-1 token for a short-lived API token", async () => {
    const { fetch, sent } = stub(
      200,
      JSON.stringify({
        token: "tid=abc;exp=1700000000",
        expires_at: 1_700_000_000,
        endpoints: { api: "https://api.test/copilot", telemetry: "https://t.test" },
      }),
    );
    const credential = await exchangeSecondStageCredential(stage2, "gho_stage1", { fetch });

    expect(sent[0]?.init?.method).toBe("GET");
    expect(sent[0]?.init?.headers?.authorization).toBe("token gho_stage1");
    expect(credential.accessToken).toBe("tid=abc;exp=1700000000");
    expect(credential.expiresAt).toBe(1_700_000_000_000);
    expect(credential.metadata).toEqual({
      "endpoint.api": "https://api.test/copilot",
      "endpoint.telemetry": "https://t.test",
    });
  });

  it("falls back to expires_in against the injected clock", async () => {
    const { fetch } = stub(200, JSON.stringify({ token: "t", expires_in: 1_800 }));
    const credential = await exchangeSecondStageCredential(stage2, "gho_stage1", {
      fetch,
      now: () => 5_000,
    });
    expect(credential.expiresAt).toBe(5_000 + 1_800_000);
  });

  it("fails when the seat is gone, without echoing the stage-1 token", async () => {
    const { fetch } = stub(403, "no copilot seat for gho_stage1abcdefghijklmnop");
    const error = await exchangeSecondStageCredential(stage2, "gho_stage1abcdefghijklmnop", {
      fetch,
    }).catch((err: unknown) => err as Error);
    expect(error.message).toContain("HTTP 403");
    expect(error.message).not.toContain("gho_stage1abcdefghijklmnop");
  });

  it("fails when the response carries no token field", async () => {
    const { fetch } = stub(200, JSON.stringify({ nope: true }));
    await expect(
      exchangeSecondStageCredential(stage2, "gho_stage1", { fetch }),
    ).rejects.toMatchObject({ code: "arcturn_exchange_failed" });
  });

  it("reports a transport failure as an exchange failure", async () => {
    const fetch: FetchLike = () => Promise.reject(new Error("ENOTFOUND"));
    await expect(
      exchangeSecondStageCredential(stage2, "gho_stage1", { fetch }),
    ).rejects.toMatchObject({ code: "arcturn_exchange_failed" });
  });
});
