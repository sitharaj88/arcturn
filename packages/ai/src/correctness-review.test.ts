/**
 * Adversarial correctness review: targeted regression tests for suspected
 * stateful bugs in `live-catalog.ts`. Confirmed defects are written with
 * `it.fails` (the assertion encodes the *correct* behavior, so it currently
 * fails against the real bug and the suite stays green); ruled-out
 * suspicions are documented inline rather than given a test.
 *
 * See the top-level `correctness-review` note for the full write-up.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCatalog } from "./catalog.js";
import { refreshCatalog } from "./live-catalog.js";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
}

let tempDir: string;
let cacheFile: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arcturn-correctness-"));
  cacheFile = join(tempDir, "live-catalog.json");
});

afterEach(async () => {
  resetCatalog();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("refreshCatalog: concurrent refreshes keep every preset (fixed)", () => {
  // refreshCatalog() does: read the whole cache file -> mutate an in-memory
  // copy for the presets it was asked about -> write the whole file back
  // (atomically, via temp file + rename). The rename makes each *individual*
  // write crash-safe, but it does nothing about two overlapping calls each
  // starting from the same on-disk snapshot: whichever call's write lands
  // last simply clobbers the other call's preset entry. Two slash-command
  // invocations of `/models refresh <preset>` for different presets running
  // back-to-back (the second dispatched before the first's write settles)
  // hits this directly.
  it("does not lose one preset's cache entry when another preset refreshes concurrently", async () => {
    // Both fetches resolve after a tick, so both calls' readCache() happens
    // before either call's writeCacheAtomic() — the interleaving a real
    // "two refreshes in flight at once" scenario produces.
    const groqFetch = fakeFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ data: [{ id: "llama-groq-1" }] });
    });
    const deepseekFetch = fakeFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return jsonResponse({ data: [{ id: "deepseek-chat-1" }] });
    });

    const env = { GROQ_API_KEY: "g-key", DEEPSEEK_API_KEY: "d-key" };

    await Promise.all([
      refreshCatalog(["groq"], { cacheFile, fetchFn: groqFetch, env }),
      refreshCatalog(["deepseek"], { cacheFile, fetchFn: deepseekFetch, env }),
    ]);

    const onDisk = JSON.parse(await readFile(cacheFile, "utf8")) as Record<string, unknown>;
    // Correct behavior: both concurrent refreshes' results are durable.
    expect(onDisk.groq).toBeDefined();
    expect(onDisk.deepseek).toBeDefined();
  });
});
