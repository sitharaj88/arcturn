/**
 * Live model discovery.
 *
 * {@link ../presets.ts | `presets.ts`} ships a curated, hand-maintained list of
 * notable models per provider preset. Curated lists go stale the moment a
 * provider ships a new generation — GLM alone has shipped four generations
 * since the catalog last noticed. This module complements the curated list
 * with a best-effort query of each preset's own "list models" endpoint,
 * a small on-disk cache (so every CLI invocation does not re-hit the network),
 * and a merge step that registers anything new into the same runtime catalog
 * {@link presetSpec} feeds, without ever overwriting a curated entry.
 *
 * Nothing in this module runs at import time: every network call and cache
 * read/write happens inside {@link discoverModels} or {@link refreshCatalog},
 * both of which the caller invokes explicitly.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ModelSpec } from "@arcturn/types";
import { getModel } from "./catalog.js";
import { PROVIDER_PRESETS, presetSpec } from "./presets.js";

/** How long a cached preset entry is trusted before it is considered stale. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How long a single discovery request may run before it is aborted. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Anthropic Messages API version header sent alongside every discovery request. */
const ANTHROPIC_VERSION = "2023-06-01";

/** Conservative defaults applied to a discovered model absent from the curated table. */
const UNCURATED_DEFAULTS = {
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
} as const;

/** One entry from a provider's "list models" response, reduced to what Arcturn uses. */
export interface DiscoveredModel {
  /** Wire model id exactly as the provider returned it. */
  readonly id: string;
}

/** A read-only environment map, defaulting to `process.env`. */
type LiveCatalogEnv = Record<string, string | undefined>;

function processEnv(): LiveCatalogEnv {
  const globalProcess = (globalThis as { process?: { env?: LiveCatalogEnv } }).process;
  return globalProcess?.env ?? {};
}

/** Options accepted by {@link discoverModels}. */
export interface DiscoverOptions {
  /** Fetch implementation to use; defaults to the global `fetch`. Tests inject a fake. */
  fetchFn?: typeof fetch;
  /** Environment consulted for the preset's API key. Defaults to `process.env`. */
  env?: LiveCatalogEnv;
  /** Abort the request after this many milliseconds. Defaults to 10s. */
  timeoutMs?: number;
}

/**
 * A discovery request that could not complete: an unknown preset, a network
 * failure, a non-2xx response, or an unparseable body. Callers that want to
 * treat discovery as best-effort should catch this specifically rather than
 * swallowing every exception.
 */
export class LiveCatalogError extends Error {
  /** The preset the failed request was for. */
  readonly presetId: string;
  /** HTTP status code, when the failure was a non-2xx response. */
  readonly status?: number;

  constructor(presetId: string, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LiveCatalogError";
    this.presetId = presetId;
    if (options?.status !== undefined) this.status = options.status;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `<baseUrl>/models`, matching how the openai-compatible adapter joins paths. */
function openaiModelsUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}/models`;
}

/**
 * `<baseUrl>/v1/models`, but only when `baseUrl` is a bare origin with no path
 * segment of its own.
 *
 * Anthropic-protocol presets shape their base URL wildly differently — some
 * already end in `/anthropic`, `/inference`, `/coding`, `/compat`, `/zen`
 * (see presets.ts) — and blindly appending `/v1/models` to those would be a
 * guess about a path segment that was chosen for the Messages endpoint, not
 * for model listing. Only a preset whose base URL is the service's plain
 * origin (e.g. `vercel-gateway`'s `https://ai-gateway.vercel.sh`) is
 * unambiguous enough to try.
 */
function anthropicModelsUrl(baseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") return undefined;
  if (parsed.search || parsed.hash) return undefined;
  return `${stripTrailingSlash(baseUrl)}/v1/models`;
}

/** Parse the common `{ data: [{ id, ... }, ...] }` shape both protocols use. */
function parseModelList(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) out.push({ id });
  }
  return out;
}

/**
 * Query one preset's own "list models" endpoint.
 *
 * - OpenAI-protocol presets: `GET <baseUrl>/models` with `Authorization: Bearer
 *   <key>`, parsing `{ data: [{ id, ... }] }`.
 * - Anthropic-protocol presets: `GET <baseUrl>/v1/models` with `x-api-key` and
 *   `anthropic-version`, same response shape — but only when the preset's
 *   base URL is unambiguous (see {@link anthropicModelsUrl}); otherwise `[]`.
 * - A missing API key is not an error: it returns `[]`, same as an endpoint
 *   whose shape cannot be safely guessed.
 *
 * @throws {@link LiveCatalogError} for an unknown preset id, a network
 *   failure, a non-2xx response, or a body that cannot be parsed as JSON.
 */
export async function discoverModels(
  presetId: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredModel[]> {
  const preset = PROVIDER_PRESETS[presetId];
  if (!preset) {
    const valid = Object.keys(PROVIDER_PRESETS).sort().join(", ");
    throw new LiveCatalogError(
      presetId,
      `Unknown provider preset: "${presetId}". Valid presets: ${valid}`,
    );
  }

  const env = options.env ?? processEnv();
  const apiKey = env[preset.apiKeyEnv];
  if (!apiKey) return [];

  let url: string;
  let headers: Record<string, string>;
  if (preset.protocol === "openai") {
    url = openaiModelsUrl(preset.baseUrl);
    headers = { Authorization: `Bearer ${apiKey}` };
  } else {
    const anthropicUrl = anthropicModelsUrl(preset.baseUrl);
    if (!anthropicUrl) return [];
    url = anthropicUrl;
    headers = { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
  }

  const doFetch = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(url, { headers, signal: controller.signal });
  } catch (error) {
    throw new LiveCatalogError(presetId, `Failed to reach ${url}: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new LiveCatalogError(
      presetId,
      `${preset.label} model list request failed: ${response.status} ${response.statusText}`,
      { status: response.status },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new LiveCatalogError(
      presetId,
      `${preset.label} returned a model list response that is not valid JSON`,
      { cause: error },
    );
  }

  return parseModelList(body);
}

/** One preset's cached discovery result. */
export interface CachedPresetEntry {
  /** `Date.now()` value at the time this entry was fetched. */
  fetchedAt: number;
  models: DiscoveredModel[];
}

/** On-disk cache shape: one {@link CachedPresetEntry} per preset id. */
type CacheFile = Record<string, CachedPresetEntry>;

async function readCache(cacheFile: string): Promise<CacheFile> {
  try {
    const raw = await readFile(cacheFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CacheFile;
    }
    return {};
  } catch {
    return {};
  }
}

/** Write `cache` to `cacheFile` atomically: write a temp file, then rename over it. */
async function writeCacheAtomic(cacheFile: string, cache: CacheFile): Promise<void> {
  const dir = dirname(cacheFile);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await rename(tmp, cacheFile);
}

/** Options accepted by {@link refreshCatalog}. */
export interface RefreshOptions {
  /** Path to the JSON cache file. Its directory is created on demand. */
  cacheFile: string;
  /** How long a cached entry stays fresh before it is refetched. Defaults to 24h. */
  maxAgeMs?: number;
  /** Fetch implementation forwarded to {@link discoverModels}. */
  fetchFn?: typeof fetch;
  /** Environment forwarded to {@link discoverModels}. */
  env?: LiveCatalogEnv;
}

/** Outcome of one {@link refreshCatalog} call. */
export interface RefreshResult {
  /**
   * Every {@link ModelSpec} known for the requested presets once the refresh
   * completed — curated specs kept as-is, newly discovered ones registered
   * with conservative defaults — in preset-then-model order.
   */
  readonly registered: ModelSpec[];
  /**
   * One human-readable entry per preset whose refetch failed and fell back to
   * a stale (or absent) cache.
   */
  readonly warnings: string[];
}

/** Register one discovered model, unless a curated spec already owns its id. */
function registerDiscovered(presetId: string, discovered: DiscoveredModel): ModelSpec | undefined {
  const id = `${presetId}/${discovered.id}`;
  const existing = getModel(id);
  if (existing) return existing;
  if (!PROVIDER_PRESETS[presetId]) return undefined;
  return presetSpec(presetId, discovered.id, {
    displayName: discovered.id,
    contextWindow: UNCURATED_DEFAULTS.contextWindow,
    maxOutputTokens: UNCURATED_DEFAULTS.maxOutputTokens,
    capabilities: UNCURATED_DEFAULTS.capabilities,
    register: true,
  });
}

/**
 * Refresh the live model catalog for `presetIds`.
 *
 * For each preset: a fresh cache entry (younger than `maxAgeMs`) is reused
 * without any network call; a missing or stale entry triggers
 * {@link discoverModels}. When that call fails, a still-present (even if
 * stale) cache entry is used instead and the failure is recorded in
 * {@link RefreshResult.warnings}; with no cache to fall back on, the preset
 * simply contributes nothing this round.
 *
 * Every discovered model is registered into the shared runtime catalog via
 * {@link presetSpec} — the same path `registerPresetModels` (presets.ts) uses
 * for the curated table — unless a curated spec already exists for that id,
 * which is left untouched.
 */
export async function refreshCatalog(
  presetIds: readonly string[],
  options: RefreshOptions,
): Promise<RefreshResult> {
  // Serialize per cache file: the write is atomic, but two overlapping calls
  // would each read the same snapshot and the last writer would drop the
  // other's presets. Chaining makes the read-modify-write a critical section.
  const key = resolve(options.cacheFile);
  const previous = refreshLocks.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => refreshCatalogUnlocked(presetIds, options),
    () => refreshCatalogUnlocked(presetIds, options),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  refreshLocks.set(key, tail);
  try {
    return await run;
  } finally {
    // Only the last waiter clears the lock, so the map cannot grow unbounded.
    if (refreshLocks.get(key) === tail) refreshLocks.delete(key);
  }
}

/** In-flight refresh chain per resolved cache-file path. */
const refreshLocks = new Map<string, Promise<void>>();

async function refreshCatalogUnlocked(
  presetIds: readonly string[],
  options: RefreshOptions,
): Promise<RefreshResult> {
  const { cacheFile, maxAgeMs = DEFAULT_MAX_AGE_MS, fetchFn, env } = options;
  const cache = await readCache(cacheFile);
  const now = Date.now();
  const registered: ModelSpec[] = [];
  const warnings: string[] = [];
  let cacheDirty = false;

  for (const presetId of presetIds) {
    const cached = cache[presetId];
    const isFresh = cached !== undefined && now - cached.fetchedAt < maxAgeMs;

    let models: DiscoveredModel[];
    if (isFresh) {
      models = cached.models;
    } else {
      try {
        models = await discoverModels(presetId, { fetchFn, env });
        cache[presetId] = { fetchedAt: now, models };
        cacheDirty = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (cached) {
          models = cached.models;
          warnings.push(
            `${presetId}: refresh failed (${message}); using cached results from ${new Date(cached.fetchedAt).toISOString()}`,
          );
        } else {
          models = [];
          warnings.push(`${presetId}: refresh failed (${message}); no cached results available`);
        }
      }
    }

    for (const discovered of models) {
      const spec = registerDiscovered(presetId, discovered);
      if (spec) registered.push(spec);
    }
  }

  if (cacheDirty) await writeCacheAtomic(cacheFile, cache);

  return { registered, warnings };
}
