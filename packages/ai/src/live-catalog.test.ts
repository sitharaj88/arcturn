import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, resetCatalog } from "./catalog.js";
import {
  type CachedPresetEntry,
  discoverModels,
  LiveCatalogError,
  refreshCatalog,
} from "./live-catalog.js";
import { presetSpec } from "./presets.js";

/** Build a fake `typeof fetch` from a handler, so no real network call ever happens. */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arcturn-live-catalog-"));
});

afterEach(async () => {
  resetCatalog();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("discoverModels", () => {
  it("parses the openai { data: [{ id }] } shape and authenticates with a bearer key", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("https://api.groq.com/openai/v1/models");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      return jsonResponse({ data: [{ id: "llama-5" }, { id: "llama-5-mini" }] });
    });

    const models = await discoverModels("groq", {
      fetchFn,
      env: { GROQ_API_KEY: "test-key" },
    });

    expect(models).toEqual([{ id: "llama-5" }, { id: "llama-5-mini" }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("ignores list entries without a string id", async () => {
    const fetchFn = fakeFetch(() =>
      jsonResponse({ data: [{ id: "ok" }, { id: 5 }, { name: "no-id" }, null] }),
    );
    const models = await discoverModels("groq", { fetchFn, env: { GROQ_API_KEY: "k" } });
    expect(models).toEqual([{ id: "ok" }]);
  });

  it("returns [] without fetching when the API key is missing", async () => {
    const fetchFn = fakeFetch(() => {
      throw new Error("must not be called");
    });
    const models = await discoverModels("groq", { fetchFn, env: {} });
    expect(models).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns [] for an anthropic-protocol preset whose base URL path is ambiguous", async () => {
    const fetchFn = fakeFetch(() => {
      throw new Error("must not be called");
    });
    // fireworks' base URL ("https://api.fireworks.ai/inference") already carries
    // a path segment chosen for the Messages endpoint; appending /v1/models
    // would be a guess.
    const models = await discoverModels("fireworks", {
      fetchFn,
      env: { FIREWORKS_API_KEY: "k" },
    });
    expect(models).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches <baseUrl>/v1/models with x-api-key for an unambiguous anthropic-protocol preset", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("https://ai-gateway.vercel.sh/v1/models");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("gw-key");
      expect(headers["anthropic-version"]).toBeTruthy();
      return jsonResponse({ data: [{ id: "anthropic/claude-x" }] });
    });

    const models = await discoverModels("vercel-gateway", {
      fetchFn,
      env: { AI_GATEWAY_API_KEY: "gw-key" },
    });
    expect(models).toEqual([{ id: "anthropic/claude-x" }]);
  });

  it("throws a LiveCatalogError for an unknown preset", async () => {
    await expect(discoverModels("not-a-preset", { env: {} })).rejects.toThrow(LiveCatalogError);
  });

  it("throws a LiveCatalogError with status on a non-2xx response", async () => {
    const fetchFn = fakeFetch(() => jsonResponse({ error: "nope" }, 401));
    await expect(
      discoverModels("groq", { fetchFn, env: { GROQ_API_KEY: "k" } }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("throws a LiveCatalogError when the fetch itself fails", async () => {
    const fetchFn = fakeFetch(() => {
      throw new Error("boom");
    });
    await expect(discoverModels("groq", { fetchFn, env: { GROQ_API_KEY: "k" } })).rejects.toThrow(
      LiveCatalogError,
    );
  });
});

describe("refreshCatalog", () => {
  it("reuses a fresh cache entry without calling fetchFn", async () => {
    const cacheFile = join(tempDir, "cache.json");
    const fresh: CachedPresetEntry = {
      fetchedAt: Date.now(),
      models: [{ id: "cached-model" }],
    };
    await writeCacheFile(cacheFile, { groq: fresh });

    const fetchFn = fakeFetch(() => {
      throw new Error("must not be called");
    });

    const result = await refreshCatalog(["groq"], {
      cacheFile,
      fetchFn,
      env: { GROQ_API_KEY: "k" },
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
    expect(getModel("groq/cached-model")?.displayName).toBe("cached-model");
  });

  it("refetches when the cache entry is older than maxAgeMs", async () => {
    const cacheFile = join(tempDir, "cache.json");
    const stale: CachedPresetEntry = {
      fetchedAt: Date.now() - 1_000_000,
      models: [{ id: "old-model" }],
    };
    await writeCacheFile(cacheFile, { groq: stale });

    const fetchFn = fakeFetch(() => jsonResponse({ data: [{ id: "new-model" }] }));

    const result = await refreshCatalog(["groq"], {
      cacheFile,
      maxAgeMs: 1_000,
      fetchFn,
      env: { GROQ_API_KEY: "k" },
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual([]);
    expect(getModel("groq/new-model")).toBeDefined();
    expect(getModel("groq/old-model")).toBeUndefined();
  });

  it("falls back to a stale cache entry and records a warning when the refetch fails", async () => {
    const cacheFile = join(tempDir, "cache.json");
    const stale: CachedPresetEntry = {
      fetchedAt: Date.now() - 1_000_000,
      models: [{ id: "old-model" }],
    };
    await writeCacheFile(cacheFile, { groq: stale });

    const fetchFn = fakeFetch(() => jsonResponse({ error: "down" }, 503));

    const result = await refreshCatalog(["groq"], {
      cacheFile,
      maxAgeMs: 1_000,
      fetchFn,
      env: { GROQ_API_KEY: "k" },
    });

    expect(getModel("groq/old-model")).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("groq");
  });

  it("records a warning and contributes nothing when a preset with no cache fails to refetch", async () => {
    const cacheFile = join(tempDir, "cache.json");
    const fetchFn = fakeFetch(() => jsonResponse({ error: "down" }, 500));

    const result = await refreshCatalog(["groq"], {
      cacheFile,
      fetchFn,
      env: { GROQ_API_KEY: "k" },
    });

    expect(result.registered).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("no cached results");
  });

  it("does not overwrite a curated model already in the catalog", async () => {
    const curated = presetSpec("groq", "llama-3.3-70b-versatile", {
      displayName: "Llama 3.3 70B Versatile",
      contextWindow: 128_000,
      maxOutputTokens: 32_768,
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
      register: true,
    });

    const cacheFile = join(tempDir, "cache.json");
    const fetchFn = fakeFetch(() => jsonResponse({ data: [{ id: "llama-3.3-70b-versatile" }] }));

    const result = await refreshCatalog(["groq"], {
      cacheFile,
      fetchFn,
      env: { GROQ_API_KEY: "k" },
    });

    const stored = getModel("groq/llama-3.3-70b-versatile");
    expect(stored).toBe(curated);
    expect(stored?.maxOutputTokens).toBe(32_768);
    expect(stored?.displayName).toBe("Llama 3.3 70B Versatile");
    expect(result.registered).toContainEqual(curated);
  });

  it("registers an uncurated discovered model with conservative defaults", async () => {
    const cacheFile = join(tempDir, "cache.json");
    const fetchFn = fakeFetch(() => jsonResponse({ data: [{ id: "brand-new-model" }] }));

    await refreshCatalog(["groq"], { cacheFile, fetchFn, env: { GROQ_API_KEY: "k" } });

    const stored = getModel("groq/brand-new-model");
    expect(stored).toBeDefined();
    expect(stored?.displayName).toBe("brand-new-model");
    expect(stored?.contextWindow).toBe(128_000);
    expect(stored?.maxOutputTokens).toBe(8_192);
    expect(stored?.capabilities).toEqual({
      tools: true,
      vision: false,
      thinking: false,
      caching: false,
    });
  });

  it("writes the cache atomically as valid, well-shaped JSON", async () => {
    const cacheFile = join(tempDir, "nested", "dir", "cache.json");
    const fetchFn = fakeFetch(() => jsonResponse({ data: [{ id: "some-model" }] }));

    await refreshCatalog(["groq"], { cacheFile, fetchFn, env: { GROQ_API_KEY: "k" } });

    const raw = await readFile(cacheFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, CachedPresetEntry>;
    expect(parsed.groq?.models).toEqual([{ id: "some-model" }]);
    expect(typeof parsed.groq?.fetchedAt).toBe("number");
  });
});

async function writeCacheFile(
  cacheFile: string,
  cache: Record<string, CachedPresetEntry>,
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(cacheFile, JSON.stringify(cache), "utf8");
}
