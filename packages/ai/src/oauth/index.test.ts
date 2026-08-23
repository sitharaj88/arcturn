import { afterEach, describe, expect, it } from "vitest";
import { AIErrorException } from "../errors.js";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  beginLogin,
  createAccessTokenResolver,
  type DeviceLoginSession,
  GITHUB_COPILOT_PROVIDER,
  logout,
  MemoryOAuthTokenStore,
  type OAuthProviderConfig,
  type PkceLoginSession,
  resetOAuthProviders,
} from "./index.js";
import type { FetchLike, HttpRequestInit, OAuthTokens } from "./types.js";

afterEach(() => {
  resetOAuthProviders();
});

type Route = (
  url: string,
  init?: HttpRequestInit,
) => { status?: number; body: unknown } | undefined;

/** A fetch stub that answers by URL and records every request. */
function routedFetch(routes: Route[]): {
  fetch: FetchLike;
  sent: Array<{ url: string; params: URLSearchParams; headers: Record<string, string> }>;
} {
  const sent: Array<{ url: string; params: URLSearchParams; headers: Record<string, string> }> = [];
  const fetch: FetchLike = (url, init) => {
    sent.push({
      url,
      params: new URLSearchParams(init?.body ?? ""),
      headers: init?.headers ?? {},
    });
    for (const route of routes) {
      const answer = route(url, init);
      if (!answer) continue;
      return Promise.resolve({
        ok: (answer.status ?? 200) < 400,
        status: answer.status ?? 200,
        text: () => Promise.resolve(JSON.stringify(answer.body)),
      });
    }
    return Promise.reject(new Error(`unrouted request to ${url}`));
  };
  return { fetch, sent };
}

/**
 * Play the browser's part in a PKCE login. This is the only real socket in the
 * suite: 127.0.0.1 on the ephemeral port the loopback listener just bound.
 */
function visitLoopback(url: string): Promise<Response> {
  return globalThis.fetch(url);
}

const testConfig: OAuthProviderConfig = {
  provider: ANTHROPIC_OAUTH_PROVIDER,
  displayName: "Test",
  flow: "pkce",
  clientId: "client-1",
  authorizationEndpoint: "https://auth.test/authorize",
  tokenEndpoint: "https://auth.test/token",
  scopes: ["user:inference"],
  apiHeaders: (token) => ({ authorization: `Bearer ${token}` }),
};

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return { accessToken: "access-1", refreshToken: "refresh-1", tokenType: "Bearer", ...overrides };
}

describe("createAccessTokenResolver", () => {
  it("has the shape CreateClientOptions.getAccessToken expects", async () => {
    const store = new MemoryOAuthTokenStore({ anthropic: tokens() });
    const resolve: (provider: string) => Promise<string> = createAccessTokenResolver(store);
    await expect(resolve(ANTHROPIC_OAUTH_PROVIDER)).resolves.toBe("access-1");
  });

  it("names the login command when the provider is not signed in", async () => {
    const resolve = createAccessTokenResolver(new MemoryOAuthTokenStore());
    const error = await resolve(ANTHROPIC_OAUTH_PROVIDER).catch((err: unknown) => err as Error);
    expect(error).toBeInstanceOf(AIErrorException);
    expect((error as AIErrorException).kind).toBe("auth");
    expect(error.message).toContain("Not signed in to anthropic");
    expect(error.message).toContain("arcturn auth login anthropic");
    // The API-key alternative is named too, so the user has two ways out.
    expect(error.message).toContain("ANTHROPIC_API_KEY");
  });

  it("accepts a custom login command for a differently named CLI", async () => {
    const resolve = createAccessTokenResolver(new MemoryOAuthTokenStore(), {
      loginCommand: (provider) => `arcturn login --provider ${provider}`,
    });
    await expect(resolve(GITHUB_COPILOT_PROVIDER)).rejects.toThrow(
      /arcturn login --provider github-copilot/,
    );
  });

  it("refreshes an expired token through the provider's token endpoint", async () => {
    const store = new MemoryOAuthTokenStore({ anthropic: tokens({ expiresAt: 0 }) });
    const { fetch, sent } = routedFetch([
      (url) =>
        url === testConfig.tokenEndpoint
          ? { body: { access_token: "access-2", expires_in: 3600 } }
          : undefined,
    ]);
    const resolve = createAccessTokenResolver(store, {
      fetch,
      now: () => 1_000_000,
      config: testConfig,
    });

    await expect(resolve(ANTHROPIC_OAUTH_PROVIDER)).resolves.toBe("access-2");
    expect(sent[0]?.params.get("grant_type")).toBe("refresh_token");
    expect(sent[0]?.params.get("refresh_token")).toBe("refresh-1");
    expect((await store.get(ANTHROPIC_OAUTH_PROVIDER))?.accessToken).toBe("access-2");
  });

  it("reports a rejected refresh as an auth error with the reason intact", async () => {
    const store = new MemoryOAuthTokenStore({ anthropic: tokens({ expiresAt: 0 }) });
    const { fetch } = routedFetch([
      () => ({ status: 400, body: { error: "invalid_grant", error_description: "revoked" } }),
    ]);
    const resolve = createAccessTokenResolver(store, {
      fetch,
      now: () => 1_000_000,
      config: testConfig,
    });
    const error = await resolve(ANTHROPIC_OAUTH_PROVIDER).catch((err: unknown) => err as Error);
    expect(error).toBeInstanceOf(AIErrorException);
    expect((error as AIErrorException).kind).toBe("auth");
    expect(error.message).toContain("invalid_grant");
    expect(error.message).toContain("revoked");
  });

  it("resolves the stage-2 token for a two-stage provider", async () => {
    const store = new MemoryOAuthTokenStore({ "github-copilot": tokens({ accessToken: "gh-1" }) });
    const { fetch, sent } = routedFetch([
      (url) =>
        url.includes("copilot_internal")
          ? { body: { token: "copilot-api-token", expires_at: 2_000 } }
          : undefined,
    ]);
    const resolve = createAccessTokenResolver(store, { fetch, now: () => 0 });

    await expect(resolve(GITHUB_COPILOT_PROVIDER)).resolves.toBe("copilot-api-token");
    expect(sent[0]?.headers.authorization).toBe("token gh-1");
    // Cached: a second resolution does not hit the exchange endpoint again.
    await expect(resolve(GITHUB_COPILOT_PROVIDER)).resolves.toBe("copilot-api-token");
    expect(sent).toHaveLength(1);
  });

  it("shares one refresh across concurrent resolutions", async () => {
    const store = new MemoryOAuthTokenStore({ anthropic: tokens({ expiresAt: 0 }) });
    let calls = 0;
    const fetch: FetchLike = () => {
      calls++;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "access-2", expires_in: 3600 })),
      });
    };
    const resolve = createAccessTokenResolver(store, {
      fetch,
      now: () => 1_000_000,
      config: testConfig,
    });
    const results = await Promise.all([
      resolve(ANTHROPIC_OAUTH_PROVIDER),
      resolve(ANTHROPIC_OAUTH_PROVIDER),
    ]);
    expect(results).toEqual(["access-2", "access-2"]);
    expect(calls).toBe(1);
  });
});

describe("beginLogin (PKCE)", () => {
  it("returns an authorization URL bound to the loopback redirect, then completes", async () => {
    const store = new MemoryOAuthTokenStore();
    const { fetch, sent } = routedFetch([
      (url) =>
        url === testConfig.tokenEndpoint
          ? { body: { access_token: "granted", refresh_token: "r", expires_in: 3600 } }
          : undefined,
    ]);

    const session = (await beginLogin(ANTHROPIC_OAUTH_PROVIDER, {
      store,
      config: testConfig,
      fetch,
      now: () => 0,
      timeoutMs: 5_000,
    })) as PkceLoginSession;

    expect(session.flow).toBe("pkce");
    const url = new URL(session.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.test/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(session.redirectUri);
    expect(url.searchParams.get("state")).toBe(session.state);
    expect(session.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const completing = session.complete();
    // Play the browser's part: hit the loopback redirect with a matching state.
    const page = await visitLoopback(
      `${session.redirectUri}?code=the-code&state=${encodeURIComponent(session.state)}`,
    );
    expect(page.status).toBe(200);

    const granted = await completing;
    expect(granted.accessToken).toBe("granted");
    expect(await store.get(ANTHROPIC_OAUTH_PROVIDER)).toMatchObject({ accessToken: "granted" });

    const tokenCall = sent.find((call) => call.url === testConfig.tokenEndpoint);
    expect(tokenCall?.params.get("grant_type")).toBe("authorization_code");
    expect(tokenCall?.params.get("code")).toBe("the-code");
    expect(tokenCall?.params.get("code_verifier")).toBeTruthy();
  });

  it("cancel() releases the loopback port", async () => {
    const session = (await beginLogin(ANTHROPIC_OAUTH_PROVIDER, {
      config: testConfig,
      timeoutMs: 5_000,
    })) as PkceLoginSession;
    const redirect = session.redirectUri;
    await session.cancel();
    await expect(visitLoopback(`${redirect}?code=x`)).rejects.toThrow();
  });

  it("refuses a PKCE provider with no authorization endpoint", async () => {
    const broken: OAuthProviderConfig = { ...testConfig };
    delete broken.authorizationEndpoint;
    await expect(beginLogin(ANTHROPIC_OAUTH_PROVIDER, { config: broken })).rejects.toMatchObject({
      code: "arcturn_bad_response",
    });
  });
});

describe("beginLogin (device)", () => {
  const deviceConfig: OAuthProviderConfig = {
    provider: GITHUB_COPILOT_PROVIDER,
    displayName: "Copilot",
    flow: "device",
    clientId: "client-1",
    deviceAuthorizationEndpoint: "https://gh.test/device/code",
    tokenEndpoint: "https://gh.test/token",
    scopes: ["read:user"],
    secondStage: {
      endpoint: "https://api.gh.test/copilot/token",
      authorization: (stage1) => `token ${stage1}`,
    },
    apiHeaders: (token) => ({ authorization: `Bearer ${token}` }),
  };

  it("shows the user code before polling, then persists both credential stages", async () => {
    const store = new MemoryOAuthTokenStore();
    let polls = 0;
    const { fetch } = routedFetch([
      (url) =>
        url === deviceConfig.deviceAuthorizationEndpoint
          ? {
              body: {
                device_code: "device-secret",
                user_code: "WDJB-MJHT",
                verification_uri: "https://gh.test/login/device",
                expires_in: 900,
                interval: 5,
              },
            }
          : undefined,
      (url) => {
        if (url !== deviceConfig.tokenEndpoint) return undefined;
        polls++;
        return polls < 2
          ? { body: { error: "authorization_pending" } }
          : { body: { access_token: "gh-token", token_type: "bearer" } };
      },
      (url) =>
        url === deviceConfig.secondStage?.endpoint
          ? { body: { token: "copilot-token", expires_in: 1_800 } }
          : undefined,
    ]);

    const observed: number[] = [];
    const session = (await beginLogin(GITHUB_COPILOT_PROVIDER, {
      store,
      config: deviceConfig,
      fetch,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onPoll: (info) => observed.push(info.attempt),
    })) as DeviceLoginSession;

    expect(session.flow).toBe("device");
    expect(session.userCode).toBe("WDJB-MJHT");
    expect(session.verificationUri).toBe("https://gh.test/login/device");
    expect(session.expiresIn).toBe(900);

    const granted = await session.complete();
    expect(observed).toEqual([1, 2]);
    expect(granted.accessToken).toBe("gh-token");
    expect(granted.derived?.accessToken).toBe("copilot-token");
    expect(granted.derived?.expiresAt).toBe(1_800_000);

    const stored = await store.get(GITHUB_COPILOT_PROVIDER);
    expect(stored?.derived?.accessToken).toBe("copilot-token");
  });

  it("keeps the stage-1 sign-in when the stage-2 exchange fails", async () => {
    const store = new MemoryOAuthTokenStore();
    const { fetch } = routedFetch([
      (url) =>
        url === deviceConfig.deviceAuthorizationEndpoint
          ? {
              body: {
                device_code: "d",
                user_code: "U",
                verification_uri: "https://gh.test/login/device",
                expires_in: 900,
                interval: 1,
              },
            }
          : undefined,
      (url) =>
        url === deviceConfig.tokenEndpoint
          ? { body: { access_token: "gh-token", token_type: "bearer" } }
          : undefined,
      (url) =>
        url === deviceConfig.secondStage?.endpoint
          ? { status: 403, body: { no: "seat" } }
          : undefined,
    ]);

    const session = await beginLogin(GITHUB_COPILOT_PROVIDER, {
      store,
      config: deviceConfig,
      fetch,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    await expect(session.complete()).rejects.toMatchObject({ code: "arcturn_exchange_failed" });
    expect((await store.get(GITHUB_COPILOT_PROVIDER))?.accessToken).toBe("gh-token");
  });

  it("refuses a device provider with no device endpoint", async () => {
    const broken: OAuthProviderConfig = { ...deviceConfig };
    delete broken.deviceAuthorizationEndpoint;
    await expect(beginLogin(GITHUB_COPILOT_PROVIDER, { config: broken })).rejects.toMatchObject({
      code: "arcturn_bad_response",
    });
  });
});

describe("logout", () => {
  it("removes the stored credentials and reports whether anything went", async () => {
    const store = new MemoryOAuthTokenStore({ anthropic: tokens() });
    expect(await logout(ANTHROPIC_OAUTH_PROVIDER, store)).toBe(true);
    expect(await store.get(ANTHROPIC_OAUTH_PROVIDER)).toBeUndefined();
    expect(await logout(ANTHROPIC_OAUTH_PROVIDER, store)).toBe(false);
  });
});
