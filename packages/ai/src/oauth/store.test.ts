import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuthError } from "./errors.js";
import {
  AUTH_DIR_MODE,
  AUTH_FILE_MODE,
  defaultAuthDirectory,
  FileOAuthTokenStore,
  isExpiring,
  MemoryOAuthTokenStore,
  mergeRefreshedTokens,
  providerFileName,
} from "./store.js";
import type { OAuthTokens } from "./types.js";

const isPosix = process.platform !== "win32";

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    tokenType: "Bearer",
    scopes: ["user:inference"],
    ...overrides,
  };
}

describe("isExpiring", () => {
  it("treats an absent expiry as never expiring", () => {
    expect(isExpiring(undefined, 1_000_000, 60_000)).toBe(false);
  });

  it("expires inside the skew window but not before it", () => {
    const now = 1_000_000;
    expect(isExpiring(now + 61_000, now, 60_000)).toBe(false);
    expect(isExpiring(now + 60_000, now, 60_000)).toBe(true);
    expect(isExpiring(now + 30_000, now, 60_000)).toBe(true);
    expect(isExpiring(now - 1, now, 60_000)).toBe(true);
  });
});

describe("mergeRefreshedTokens", () => {
  it("carries the refresh token and scopes forward when the response omits them", () => {
    const merged = mergeRefreshedTokens(tokens({ metadata: { account: "acct" } }), {
      accessToken: "access-2",
      tokenType: "Bearer",
      expiresAt: 42,
    });
    expect(merged.accessToken).toBe("access-2");
    expect(merged.refreshToken).toBe("refresh-1");
    expect(merged.scopes).toEqual(["user:inference"]);
    expect(merged.metadata).toEqual({ account: "acct" });
    expect(merged.expiresAt).toBe(42);
  });

  it("drops the stage-2 credential, which was minted from the replaced token", () => {
    const previous = tokens({ derived: { accessToken: "copilot-1", expiresAt: 999 } });
    const merged = mergeRefreshedTokens(previous, { accessToken: "a2", tokenType: "Bearer" });
    expect(merged.derived).toBeUndefined();
  });
});

describe("providerFileName", () => {
  it("escapes anything that could escape the auth directory", () => {
    expect(providerFileName("anthropic")).toBe("anthropic.json");
    expect(providerFileName("github-copilot")).toBe("github-copilot.json");
    expect(providerFileName("../../etc/passwd")).not.toContain("/");
    expect(providerFileName("..")).toBe("...json");
    expect(providerFileName("a\0b")).not.toContain("\0");
  });
});

describe("defaultAuthDirectory", () => {
  it("prefers ARCTURN_AUTH_DIR and otherwise lands under ~/.arcturn/auth", () => {
    expect(defaultAuthDirectory({ ARCTURN_AUTH_DIR: "/custom/auth" })).toBe("/custom/auth");
    expect(defaultAuthDirectory({ ARCTURN_HOME: "/home/x" })).toBe(
      join("/home/x", ".arcturn", "auth"),
    );
    expect(defaultAuthDirectory({})).toMatch(/\.arcturn[/\\]auth$/);
  });
});

describe("MemoryOAuthTokenStore", () => {
  it("round-trips, lists and deletes", async () => {
    const store = new MemoryOAuthTokenStore();
    expect(await store.get("anthropic")).toBeUndefined();
    expect(await store.delete("anthropic")).toBe(false);

    await store.set("anthropic", tokens());
    await store.set("github-copilot", tokens({ accessToken: "gh" }));
    expect(await store.list()).toEqual(["anthropic", "github-copilot"]);
    expect((await store.get("anthropic"))?.accessToken).toBe("access-1");

    expect(await store.delete("anthropic")).toBe(true);
    expect(await store.list()).toEqual(["github-copilot"]);
  });

  it("copies records so a caller cannot mutate the store in place", async () => {
    const store = new MemoryOAuthTokenStore();
    const original = tokens();
    await store.set("anthropic", original);
    original.accessToken = "mutated";
    const loaded = await store.get("anthropic");
    expect(loaded?.accessToken).toBe("access-1");
  });
});

describe("FileOAuthTokenStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "arcturn-oauth-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips a record through disk", async () => {
    const store = new FileOAuthTokenStore({ directory: join(directory, "auth") });
    await store.set("anthropic", tokens({ expiresAt: 1_700_000_000_000 }));

    const loaded = await store.get("anthropic");
    expect(loaded).toEqual(tokens({ expiresAt: 1_700_000_000_000 }));
    expect(await store.list()).toEqual(["anthropic"]);
    expect(await store.delete("anthropic")).toBe(true);
    expect(await store.get("anthropic")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it.runIf(isPosix)("writes credentials 0600 inside a 0700 directory", async () => {
    const authDir = join(directory, "auth");
    const store = new FileOAuthTokenStore({ directory: authDir });
    await store.set("anthropic", tokens());

    const dirStat = await stat(authDir);
    expect(dirStat.mode & 0o777).toBe(AUTH_DIR_MODE);

    const fileStat = await stat(store.pathFor("anthropic"));
    expect(fileStat.mode & 0o777).toBe(AUTH_FILE_MODE);
  });

  it.runIf(isPosix)("tightens a pre-existing loose file and leaves no temp files", async () => {
    const authDir = join(directory, "auth");
    const store = new FileOAuthTokenStore({ directory: authDir });
    await store.set("anthropic", tokens());
    await writeFile(store.pathFor("anthropic"), "{}", { mode: 0o644 });

    await store.set("anthropic", tokens({ accessToken: "access-2" }));
    expect((await stat(store.pathFor("anthropic"))).mode & 0o777).toBe(AUTH_FILE_MODE);
    expect((await store.get("anthropic"))?.accessToken).toBe("access-2");
    expect(await store.list()).toEqual(["anthropic"]);
  });

  it("reports no credentials for a missing directory or a corrupt file", async () => {
    const store = new FileOAuthTokenStore({ directory: join(directory, "missing") });
    expect(await store.get("anthropic")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(await store.delete("anthropic")).toBe(false);

    await store.set("anthropic", tokens());
    await writeFile(store.pathFor("anthropic"), "not json at all");
    expect(await store.get("anthropic")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("reads what another process wrote rather than a cached copy", async () => {
    const authDir = join(directory, "auth");
    const a = new FileOAuthTokenStore({ directory: authDir });
    const b = new FileOAuthTokenStore({ directory: authDir });
    await a.set("anthropic", tokens());
    await b.set("anthropic", tokens({ accessToken: "written-by-b" }));
    expect((await a.get("anthropic"))?.accessToken).toBe("written-by-b");
  });
});

describe("getValidAccessToken", () => {
  const now = () => 1_000_000;

  it("returns the stored token when it is not near expiry", async () => {
    const store = new MemoryOAuthTokenStore({
      anthropic: tokens({ expiresAt: 1_000_000 + 120_000 }),
    });
    let refreshes = 0;
    const token = await store.getValidAccessToken("anthropic", {
      now,
      refresh: () => {
        refreshes++;
        return tokens({ accessToken: "unused" });
      },
    });
    expect(token).toBe("access-1");
    expect(refreshes).toBe(0);
  });

  it("refreshes inside the 60s skew window and persists the result", async () => {
    const store = new MemoryOAuthTokenStore({
      anthropic: tokens({ expiresAt: 1_000_000 + 30_000 }),
    });
    const token = await store.getValidAccessToken("anthropic", {
      now,
      refresh: () => ({ accessToken: "access-2", tokenType: "Bearer", expiresAt: 9_000_000 }),
    });
    expect(token).toBe("access-2");
    const stored = await store.get("anthropic");
    expect(stored?.accessToken).toBe("access-2");
    expect(stored?.refreshToken).toBe("refresh-1");
  });

  it("honours forceRefresh even for a fresh token", async () => {
    const store = new MemoryOAuthTokenStore({
      anthropic: tokens({ expiresAt: 9_000_000 }),
    });
    const token = await store.getValidAccessToken("anthropic", {
      now,
      forceRefresh: true,
      refresh: () => ({ accessToken: "forced", tokenType: "Bearer" }),
    });
    expect(token).toBe("forced");
  });

  it("de-duplicates concurrent refreshes for one provider", async () => {
    const store = new MemoryOAuthTokenStore({
      anthropic: tokens({ expiresAt: 0 }),
      "github-copilot": tokens({ accessToken: "gh-1", expiresAt: 0 }),
    });
    let refreshes = 0;
    const refresh = async (): Promise<OAuthTokens> => {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { accessToken: `access-${refreshes + 1}`, tokenType: "Bearer", expiresAt: 9_000_000 };
    };

    const results = await Promise.all([
      store.getValidAccessToken("anthropic", { now, refresh }),
      store.getValidAccessToken("anthropic", { now, refresh }),
      store.getValidAccessToken("anthropic", { now, refresh }),
    ]);
    expect(results).toEqual(["access-2", "access-2", "access-2"]);
    expect(refreshes).toBe(1);

    // A different provider is a different lock, and a later call refreshes again.
    await store.getValidAccessToken("github-copilot", { now, refresh });
    expect(refreshes).toBe(2);
  });

  it("surfaces a refresh failure and leaves the stored record untouched", async () => {
    const store = new MemoryOAuthTokenStore({ anthropic: tokens({ expiresAt: 0 }) });
    const failure = new OAuthError("invalid_grant", "invalid_grant: refresh token revoked");

    await expect(
      store.getValidAccessToken("anthropic", { now, refresh: () => Promise.reject(failure) }),
    ).rejects.toBe(failure);
    expect((await store.get("anthropic"))?.accessToken).toBe("access-1");

    // The in-flight entry is released, so the next call retries rather than
    // resolving from a poisoned cache.
    let attempts = 0;
    const token = await store.getValidAccessToken("anthropic", {
      now,
      refresh: () => {
        attempts++;
        return { accessToken: "recovered", tokenType: "Bearer", expiresAt: 9_000_000 };
      },
    });
    expect(token).toBe("recovered");
    expect(attempts).toBe(1);
  });

  it("fails clearly when nothing is stored", async () => {
    const store = new MemoryOAuthTokenStore();
    await expect(store.getValidAccessToken("anthropic")).rejects.toMatchObject({
      code: "arcturn_no_credentials",
    });
  });

  it("fails when the token is expired and no refresher was supplied", async () => {
    const store = new MemoryOAuthTokenStore({ anthropic: tokens({ expiresAt: 0 }) });
    await expect(store.getValidAccessToken("anthropic", { now })).rejects.toMatchObject({
      code: "arcturn_token_expired",
    });
  });

  describe("two-stage credentials", () => {
    it("mints, caches and re-mints the stage-2 token", async () => {
      const store = new MemoryOAuthTokenStore({ "github-copilot": tokens({ accessToken: "gh" }) });
      let mints = 0;
      const exchange = () => {
        mints++;
        return { accessToken: `copilot-${mints}`, expiresAt: 1_000_000 + 120_000 };
      };

      expect(await store.getValidAccessToken("github-copilot", { now, exchange })).toBe(
        "copilot-1",
      );
      expect(await store.getValidAccessToken("github-copilot", { now, exchange })).toBe(
        "copilot-1",
      );
      expect(mints).toBe(1);
      expect((await store.get("github-copilot"))?.derived?.accessToken).toBe("copilot-1");

      // The cached stage-2 token is now inside the skew window.
      const later = () => 1_000_000 + 100_000;
      expect(await store.getValidAccessToken("github-copilot", { now: later, exchange })).toBe(
        "copilot-2",
      );
      expect(mints).toBe(2);
    });

    it("refreshes stage 1 first, then mints stage 2 from the new token", async () => {
      const store = new MemoryOAuthTokenStore({
        "github-copilot": tokens({ accessToken: "gh-old", expiresAt: 0 }),
      });
      const seen: string[] = [];
      const token = await store.getValidAccessToken("github-copilot", {
        now,
        refresh: () => ({ accessToken: "gh-new", tokenType: "Bearer", expiresAt: 9_000_000 }),
        exchange: (_provider, current) => {
          seen.push(current.accessToken);
          return { accessToken: "copilot-new" };
        },
      });
      expect(token).toBe("copilot-new");
      expect(seen).toEqual(["gh-new"]);
    });

    it("surfaces a stage-2 failure", async () => {
      const store = new MemoryOAuthTokenStore({ "github-copilot": tokens() });
      await expect(
        store.getValidAccessToken("github-copilot", {
          now,
          exchange: () => Promise.reject(new OAuthError("arcturn_exchange_failed", "seat expired")),
        }),
      ).rejects.toMatchObject({ code: "arcturn_exchange_failed" });
    });
  });
});
