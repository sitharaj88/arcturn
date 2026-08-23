import { oauth } from "@arcturn/ai";
import type { ProviderId } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import type { AuthCommand } from "./args.js";
import {
  CANCELLED_EXIT_CODE,
  collectAuthStatus,
  createAuthStore,
  formatAuthStatus,
  formatExpiry,
  type RunAuthCommandOptions,
  runAuthCommand,
  UNVERIFIED_ENDPOINTS_NOTE,
} from "./auth.js";
import { resolveArcturnPaths } from "./paths.js";
import { makeScratch } from "./test-helpers/scratch.js";

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

/** Token material that must never reach the rendered output. */
const SECRET_ACCESS = "sk-oauth-super-secret-access-token";
const SECRET_REFRESH = "rt-super-secret-refresh-token";

function tokens(overrides: Partial<oauth.OAuthTokens> = {}): oauth.OAuthTokens {
  return {
    accessToken: SECRET_ACCESS,
    refreshToken: SECRET_REFRESH,
    tokenType: "Bearer",
    ...overrides,
  };
}

/** Run a command against an in-memory store, capturing both streams. */
async function run(
  command: AuthCommand,
  overrides: Partial<RunAuthCommandOptions> = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAuthCommand({
    command,
    store: new oauth.MemoryOAuthTokenStore(),
    home: "/nowhere/arcturn",
    env: {},
    now: () => NOW,
    handleSigint: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("formatExpiry", () => {
  it("reports remaining time, expiry and absence", () => {
    expect(formatExpiry(NOW + 90_000, NOW)).toBe("expires in 1m30s");
    expect(formatExpiry(NOW - 5_000, NOW)).toContain("EXPIRED");
    expect(formatExpiry(undefined, NOW)).toBe("no expiry reported");
  });
});

describe("collectAuthStatus", () => {
  it("unions the registered providers with whatever the store holds", async () => {
    const store = new oauth.MemoryOAuthTokenStore({
      anthropic: tokens({ expiresAt: NOW + 3_600_000 }),
      "legacy-provider": tokens(),
    });
    const rows = await collectAuthStatus(store);
    const byId = new Map(rows.map((row) => [row.provider, row]));

    expect(byId.get("anthropic")).toMatchObject({ signedIn: true, flow: "pkce" });
    expect(byId.get("github-copilot")).toMatchObject({ signedIn: false, flow: "device" });
    expect(byId.get("legacy-provider")).toMatchObject({ signedIn: true, flow: "unknown" });
    // Sorted, so the listing is stable between runs.
    expect([...byId.keys()]).toEqual([...byId.keys()].sort());
  });
});

describe("arcturn auth status", () => {
  it("renders one valid and one expired credential without any token material", async () => {
    const store = new oauth.MemoryOAuthTokenStore({
      anthropic: tokens({ expiresAt: NOW + 3_600_000 }),
      "github-copilot": tokens({ expiresAt: NOW - 120_000 }),
    });
    const { code, out, err } = await run({ kind: "auth", action: "status" }, { store });

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("anthropic");
    expect(out).toContain("signed in");
    expect(out).toContain("expires in 1h00m");
    expect(out).toContain("EXPIRED");
    expect(out).toContain("openai-codex");
    expect(out).toContain("signed out");

    // Nothing secret, not even a prefix of it, may appear anywhere.
    expect(out).not.toContain(SECRET_ACCESS);
    expect(out).not.toContain(SECRET_REFRESH);
    expect(out).not.toContain("sk-");
    expect(out).not.toContain("rt-");
    expect(out).not.toMatch(/access.?token/i);
    expect(out).not.toMatch(/refresh/i);
  });

  it("prints the unverified-endpoints caveat exactly once", async () => {
    const { out } = await run({ kind: "auth", action: "status" });
    const firstLine = UNVERIFIED_ENDPOINTS_NOTE.split("\n")[0] as string;
    expect(out.split(firstLine)).toHaveLength(2);
  });

  it("names the directory credentials live in", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home });
    const { out } = await run(
      { kind: "auth", action: "status" },
      { store: createAuthStore(paths), paths },
    );
    expect(out).toContain(paths.auth);
  });
});

describe("formatAuthStatus", () => {
  it("copes with an empty registry", () => {
    expect(formatAuthStatus([], "/tmp/auth", NOW)).toContain("no OAuth providers are registered");
  });
});

describe("arcturn auth logout", () => {
  it("reports that nothing was stored", async () => {
    const { code, out } = await run({ kind: "auth", action: "logout", provider: "anthropic" });
    expect(code).toBe(0);
    expect(out).toContain("Nothing to do: no credentials were stored for anthropic");
    expect(out).toContain(UNVERIFIED_ENDPOINTS_NOTE.split("\n")[0] as string);
  });

  it("removes a stored credential and says so", async () => {
    const store = new oauth.MemoryOAuthTokenStore({ anthropic: tokens() });
    const { code, out } = await run(
      { kind: "auth", action: "logout", provider: "anthropic" },
      { store },
    );
    expect(code).toBe(0);
    expect(out).toContain("Signed out of anthropic");
    expect(await store.get("anthropic")).toBeUndefined();
    expect(out).not.toContain(SECRET_ACCESS);
  });
});

describe("arcturn auth login", () => {
  /** A PKCE session that never touches the network. */
  function fakePkceSession(
    store: oauth.OAuthTokenStore,
    provider: ProviderId,
  ): oauth.PkceLoginSession {
    return {
      flow: "pkce",
      provider,
      authorizationUrl: "https://example.invalid/authorize?client_id=fake",
      redirectUri: "http://127.0.0.1:53211/callback",
      state: "fake-state",
      async complete() {
        const granted = tokens({ expiresAt: NOW + 600_000 });
        await store.set(provider, granted);
        return granted;
      },
      cancel: () => Promise.resolve(),
    };
  }

  it("prints the authorization URL for a PKCE provider and stores the tokens", async () => {
    const store = new oauth.MemoryOAuthTokenStore();
    const { code, out, err } = await run(
      { kind: "auth", action: "login", provider: "anthropic" },
      { store, beginLogin: (provider) => Promise.resolve(fakePkceSession(store, provider)) },
    );

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Open this URL in your browser");
    expect(out).toContain("https://example.invalid/authorize?client_id=fake");
    expect(out).toContain("Signed in to anthropic");
    expect(out).toContain("expires in 10m00s");
    expect(await store.get("anthropic")).toMatchObject({ tokenType: "Bearer" });
    expect(out).not.toContain(SECRET_ACCESS);
  });

  it("prints the verification URI and user code for a device provider", async () => {
    const store = new oauth.MemoryOAuthTokenStore();
    const session: oauth.DeviceLoginSession = {
      flow: "device",
      provider: "github-copilot",
      verificationUri: "https://example.invalid/device",
      verificationUriComplete: "https://example.invalid/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
      expiresIn: 900,
      interval: 5,
      complete: () => Promise.resolve(tokens()),
      cancel: () => Promise.resolve(),
    };
    const { code, out } = await run(
      { kind: "auth", action: "login", provider: "github-copilot" },
      { store, beginLogin: () => Promise.resolve(session) },
    );

    expect(code).toBe(0);
    expect(out).toContain("https://example.invalid/device");
    expect(out).toContain("ABCD-1234");
    expect(out).toContain("Waiting for approval");
    expect(out).toContain("Signed in to github-copilot");
  });

  it("reports a cancelled login without storing anything", async () => {
    const store = new oauth.MemoryOAuthTokenStore();
    let cancelled = false;
    const session: oauth.PkceLoginSession = {
      ...fakePkceSession(store, "anthropic"),
      complete: () =>
        Promise.reject(new oauth.OAuthError("arcturn_cancelled", "The login was cancelled")),
      cancel: () => {
        cancelled = true;
        return Promise.resolve();
      },
    };
    const { code, err } = await run(
      { kind: "auth", action: "login", provider: "anthropic" },
      { store, beginLogin: () => Promise.resolve(session) },
    );

    expect(code).toBe(CANCELLED_EXIT_CODE);
    expect(err).toContain("cancelled; nothing was stored");
    expect(cancelled).toBe(true);
    expect(await store.get("anthropic")).toBeUndefined();
  });

  it("reports a timeout as an actionable failure", async () => {
    const store = new oauth.MemoryOAuthTokenStore();
    const session: oauth.PkceLoginSession = {
      ...fakePkceSession(store, "anthropic"),
      complete: () =>
        Promise.reject(new oauth.OAuthError("arcturn_timeout", "Timed out after 1ms waiting")),
    };
    const { code, err, out } = await run(
      { kind: "auth", action: "login", provider: "anthropic" },
      { store, beginLogin: () => Promise.resolve(session) },
    );

    expect(code).toBe(1);
    expect(err).toContain("timed out");
    // The caveat still prints: a stale endpoint is the likeliest cause.
    expect(out).toContain(UNVERIFIED_ENDPOINTS_NOTE.split("\n")[0] as string);
  });

  it("reports a failure to start the flow", async () => {
    const { code, err } = await run(
      { kind: "auth", action: "login", provider: "openai-codex" },
      {
        beginLogin: () =>
          Promise.reject(new oauth.OAuthError("arcturn_bad_response", "endpoint missing")),
      },
    );
    expect(code).toBe(1);
    expect(err).toContain("login to openai-codex failed: endpoint missing");
  });

  it("aborts when the caller's signal fires", async () => {
    const controller = new AbortController();
    const store = new oauth.MemoryOAuthTokenStore();
    const { code, err } = await run(
      { kind: "auth", action: "login", provider: "anthropic" },
      {
        store,
        signal: controller.signal,
        beginLogin: (provider, options) =>
          Promise.resolve({
            ...fakePkceSession(store, provider),
            complete: () =>
              new Promise<oauth.OAuthTokens>((_resolve, reject) => {
                options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
                controller.abort();
              }),
          }),
      },
    );

    expect(code).toBe(CANCELLED_EXIT_CODE);
    expect(err).toContain("cancelled");
  });
});
