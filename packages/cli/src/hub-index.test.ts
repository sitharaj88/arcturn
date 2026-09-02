/**
 * The hub index is a file on a static site, and this module is the only
 * thing in the CLI that reads it. What is at risk is not the parsing but the
 * trust boundary: an index is *data* fetched over the network, and the
 * invariants below are what stop it becoming instructions — a source that
 * is not a GitHub shorthand never gets through, a URL that is not https never
 * gets fetched, and nothing in an entry is ever followed from here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HUB_URL,
  fetchHubIndex,
  HUB_NAME,
  type HubIndex,
  HubIndexError,
  isBareHubName,
  resolveHubName,
  searchHub,
  suggestHubNames,
} from "./hub-index.js";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ENTRIES = [
  {
    name: "enterprise-org",
    kinds: ["org-kit", "agents", "workflows"],
    source: "sitharaj88/arcturn/kits/enterprise-org",
    description: "Eleven roles and the pipelines that run them.",
    maintainer: { name: "x", url: "https://example.com" },
    disclosure: { executable: false },
  },
  {
    name: "starter-skills",
    kinds: ["skills"],
    source: "sitharaj88/arcturn/kits/starter-skills",
    description: "Three worked skills: commit message, PR description, release notes.",
  },
  {
    name: "cloud-posture-review",
    kinds: ["org-kit", "agents", "workflows"],
    source: "sitharaj88/arcturn/kits/cloud-posture-review",
    ref: "v1.2.0",
    description: "Reviews an IaC tree for posture drift.",
  },
];

function indexBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    generatedAt: "2026-09-02T00:00:00.000Z",
    entries: ENTRIES,
    ...overrides,
  });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that records its calls and answers with one canned response. */
function fakeFetch(body: string, status = 200): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const previousEnv = process.env.ARCTURN_HUB_URL;
afterEach(() => {
  if (previousEnv === undefined) delete process.env.ARCTURN_HUB_URL;
  else process.env.ARCTURN_HUB_URL = previousEnv;
});

/* ------------------------------------------------------------------ *
 * fetchHubIndex
 * ------------------------------------------------------------------ */

describe("fetchHubIndex", () => {
  it("fetches the default URL with exactly one GET, two headers and no body", async () => {
    const { fetchFn, calls } = fakeFetch(indexBody());
    const index = await fetchHubIndex({ fetchFn, version: "1.2.3" });

    expect(index.v).toBe(1);
    expect(index.entries.map((entry) => entry.name)).toEqual([
      "enterprise-org",
      "starter-skills",
      "cloud-posture-review",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DEFAULT_HUB_URL);
    expect(DEFAULT_HUB_URL).toBe("https://arcturn.dev/hub/index.json");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toEqual({
      "User-Agent": "arcturn/1.2.3",
      Accept: "application/json",
    });
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it("keeps an entry's optional ref and drops nothing it did not validate", async () => {
    const { fetchFn } = fakeFetch(indexBody());
    const index = await fetchHubIndex({ fetchFn, version: "0" });
    const pinned = index.entries.find((entry) => entry.name === "cloud-posture-review");
    expect(pinned?.ref).toBe("v1.2.0");
    const unpinned = index.entries.find((entry) => entry.name === "starter-skills");
    expect("ref" in unpinned!).toBe(false);
    // Fields the CLI does not validate still ride along for `search --json`.
    const full = index.entries.find((entry) => entry.name === "enterprise-org");
    expect(full?.disclosure).toEqual({ executable: false });
  });

  it("honours an explicit url over the environment, and the environment over the default", async () => {
    const { fetchFn, calls } = fakeFetch(indexBody());
    process.env.ARCTURN_HUB_URL = "https://hub.example.test/index.json";
    await fetchHubIndex({ fetchFn, version: "0" });
    await fetchHubIndex({ fetchFn, version: "0", url: "https://other.example.test/i.json" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://hub.example.test/index.json",
      "https://other.example.test/i.json",
    ]);
  });

  it("refuses a plain-http URL", async () => {
    const { fetchFn, calls } = fakeFetch(indexBody());
    await expect(
      fetchHubIndex({ fetchFn, version: "0", url: "http://arcturn.dev/hub/index.json" }),
    ).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it("allows plain http on localhost and 127.0.0.1 for a local site build", async () => {
    const { fetchFn, calls } = fakeFetch(indexBody());
    await fetchHubIndex({ fetchFn, version: "0", url: "http://localhost:4600/hub/index.json" });
    await fetchHubIndex({ fetchFn, version: "0", url: "http://127.0.0.1:4600/hub/index.json" });
    expect(calls).toHaveLength(2);
  });

  it("refuses a URL that is not a URL, and any non-http scheme", async () => {
    const { fetchFn, calls } = fakeFetch(indexBody());
    await expect(fetchHubIndex({ fetchFn, version: "0", url: "not a url" })).rejects.toThrow(
      HubIndexError,
    );
    await expect(
      fetchHubIndex({ fetchFn, version: "0", url: "file:///etc/passwd" }),
    ).rejects.toThrow(HubIndexError);
    expect(calls).toHaveLength(0);
  });

  it("names the status when the hub answers anything but 2xx", async () => {
    const { fetchFn } = fakeFetch("not found", 404);
    await expect(fetchHubIndex({ fetchFn, version: "0" })).rejects.toThrow(/404/);
  });

  it("reports a malformed body as one error, whatever is wrong with it", async () => {
    const bodies: [string, string][] = [
      ["not json", "{"],
      ["wrong version", indexBody({ v: 2 })],
      ["entries not an array", indexBody({ entries: {} })],
      ["top level not an object", "[]"],
      [
        "name outside the charset",
        JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], name: "Bad_Name" }] }),
      ],
      ["name missing", JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], name: undefined }] })],
      [
        "kinds not an array",
        JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], kinds: "skills" }] }),
      ],
      ["source missing", JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], source: 7 }] })],
      [
        "description missing",
        JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], description: null }] }),
      ],
      ["ref with a slash", JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], ref: "a/b" }] })],
      ["ref with whitespace", JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], ref: "v 1" }] })],
      [
        "ref with a leading dash",
        JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], ref: "-x" }] }),
      ],
      ["ref that is not a string", JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], ref: 1 }] })],
      ["entry not an object", JSON.stringify({ v: 1, entries: ["starter-skills"] })],
    ];
    for (const [label, body] of bodies) {
      const { fetchFn } = fakeFetch(body);
      await expect(fetchHubIndex({ fetchFn, version: "0" }), label).rejects.toThrow(
        "malformed hub index",
      );
    }
  });

  it("refuses a source that is not a GitHub shorthand — a bare name can never reach a local path or an arbitrary URL", async () => {
    // The invariant: `arcturn add <name>` may only ever land on the same
    // `owner/repo[/subdir][@ref]` shape a hub listing is allowed to carry.
    // Even though the resolver *would* accept these, a poisoned index must
    // not be able to point a bare name at the reader's own disk or at a git
    // host of its choosing.
    const sources = [
      "/etc",
      "../../.arcturn",
      "~/secrets",
      ".",
      "file:///tmp/pkg",
      "https://evil.example/pkg.git",
      "git@evil.example:owner/pkg.git",
      "owner/repo/../escape",
      "",
    ];
    for (const source of sources) {
      const { fetchFn } = fakeFetch(JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], source }] }));
      await expect(fetchHubIndex({ fetchFn, version: "0" }), source).rejects.toThrow(
        "malformed hub index",
      );
    }
  });

  it("accepts a source that carries its own @ref, the way the hub's own validator does", async () => {
    const { fetchFn } = fakeFetch(
      JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], source: "o/r/sub@v1" }] }),
    );
    const index = await fetchHubIndex({ fetchFn, version: "0" });
    expect(resolveHubName(index, "starter-skills")).toEqual({ source: "o/r/sub@v1" });
  });

  it("refuses an entry pinned twice — a ref field and an @ref in the source", async () => {
    const { fetchFn } = fakeFetch(
      JSON.stringify({ v: 1, entries: [{ ...ENTRIES[1], source: "o/r@v1", ref: "v2" }] }),
    );
    await expect(fetchHubIndex({ fetchFn, version: "0" })).rejects.toThrow("malformed hub index");
  });

  it("restates the resolver's GITHUB_SHORTHAND exactly, so the two cannot drift", () => {
    // Same discipline as web/scripts/hub.test.ts: the literal regex out of
    // registry.ts, compared against the one this module carries.
    const src = readFileSync(fileURLToPath(new URL("./registry.ts", import.meta.url)), "utf8");
    const match = /const GITHUB_SHORTHAND =\s*(\/\^.*?\$\/);/s.exec(src);
    expect(match, "GITHUB_SHORTHAND not found in registry.ts").toBeTruthy();
    const own = readFileSync(fileURLToPath(new URL("./hub-index.ts", import.meta.url)), "utf8");
    const ours = /const GITHUB_SHORTHAND =\s*(\/\^.*?\$\/);/s.exec(own);
    expect(ours, "GITHUB_SHORTHAND not found in hub-index.ts").toBeTruthy();
    expect(ours![1]).toBe(match![1]);
  });

  it("times out, and says so, when the hub hangs", async () => {
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof fetch;
    await expect(fetchHubIndex({ fetchFn, version: "0", timeoutMs: 20 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("wraps a network failure in a HubIndexError that names the cause", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed: ENOTFOUND arcturn.dev");
    }) as unknown as typeof fetch;
    const error = await fetchHubIndex({ fetchFn, version: "0" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubIndexError);
    expect((error as Error).message).toContain("ENOTFOUND");
  });
});

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

function index(): HubIndex {
  return JSON.parse(indexBody()) as HubIndex;
}

describe("searchHub", () => {
  it("returns everything, sorted by name, with no query", () => {
    expect(searchHub(index()).map((entry) => entry.name)).toEqual([
      "cloud-posture-review",
      "enterprise-org",
      "starter-skills",
    ]);
    expect(searchHub(index(), "   ").map((entry) => entry.name)).toHaveLength(3);
  });

  it("matches case-insensitively over name, description and kinds", () => {
    expect(searchHub(index(), "ENTERPRISE").map((entry) => entry.name)).toEqual(["enterprise-org"]);
    expect(searchHub(index(), "release notes").map((entry) => entry.name)).toEqual([
      "starter-skills",
    ]);
    expect(searchHub(index(), "org-kit").map((entry) => entry.name)).toEqual([
      "cloud-posture-review",
      "enterprise-org",
    ]);
  });

  it("ranks a name hit above a kind hit above a description hit", () => {
    const ranked = searchHub(
      {
        v: 1,
        generatedAt: "",
        entries: [
          { name: "zz", kinds: ["skills"], source: "o/r", description: "mentions review here" },
          { name: "review", kinds: ["skills"], source: "o/r", description: "a" },
          { name: "aa", kinds: ["review"], source: "o/r", description: "b" },
          { name: "code-review", kinds: ["skills"], source: "o/r", description: "c" },
        ],
      },
      "review",
    );
    expect(ranked.map((entry) => entry.name)).toEqual(["review", "code-review", "aa", "zz"]);
  });

  it("returns nothing for a query nothing carries", () => {
    expect(searchHub(index(), "quantum")).toEqual([]);
  });
});

describe("resolveHubName", () => {
  it("returns the source, and the ref when the listing pins one", () => {
    expect(resolveHubName(index(), "starter-skills")).toEqual({
      source: "sitharaj88/arcturn/kits/starter-skills",
    });
    expect(resolveHubName(index(), "cloud-posture-review")).toEqual({
      source: "sitharaj88/arcturn/kits/cloud-posture-review",
      ref: "v1.2.0",
    });
  });

  it("is exact: no prefix, no case folding, no substring", () => {
    expect(resolveHubName(index(), "starter")).toBeUndefined();
    expect(resolveHubName(index(), "Starter-Skills")).toBeUndefined();
    expect(resolveHubName(index(), "nope")).toBeUndefined();
  });
});

describe("suggestHubNames", () => {
  it("offers prefix matches first, then substring matches, capped at five", () => {
    const many: HubIndex = {
      v: 1,
      generatedAt: "",
      entries: [
        "review-a",
        "review-b",
        "code-review",
        "design-review-org",
        "preview",
        "review-c",
        "review-d",
        "other",
      ].map((name) => ({ name, kinds: ["skills"], source: "o/r", description: "" })),
    };
    expect(suggestHubNames(many, "review")).toEqual([
      "review-a",
      "review-b",
      "review-c",
      "review-d",
      "code-review",
    ]);
  });

  it("matches the other way round too, for a name typed with extra on the end", () => {
    expect(suggestHubNames(index(), "starter-skills-extra")).toEqual(["starter-skills"]);
  });

  it("points at a name that agrees on a long enough prefix, closest agreement first", () => {
    expect(suggestHubNames(index(), "starter-skillz")).toEqual(["starter-skills"]);
    expect(suggestHubNames(index(), "enterprize")).toEqual(["enterprise-org"]);
    // Three characters of agreement is coincidence, not a typo.
    expect(suggestHubNames(index(), "stax")).toEqual([]);
  });

  it("offers nothing for a name that resembles nothing", () => {
    expect(suggestHubNames(index(), "zzz")).toEqual([]);
    expect(suggestHubNames(index(), "")).toEqual([]);
  });
});

describe("isBareHubName", () => {
  it("accepts exactly the hub name charset", () => {
    for (const name of ["a", "starter-skills", "a1", "x".repeat(64)]) {
      expect(isBareHubName(name), name).toBe(true);
      expect(HUB_NAME.test(name), name).toBe(true);
    }
  });

  it("rejects every shape the resolver already owns, so no existing source changes meaning", () => {
    const notBare = [
      "owner/repo",
      "owner/repo/subdir@v1",
      "https://github.com/o/r.git",
      "git@github.com:o/r.git",
      "file:///tmp/pkg",
      "./pkg",
      "../pkg",
      "/abs/pkg",
      "~/pkg",
      ".",
      "..",
      "C:\\pkgs\\pkg",
      "\\\\server\\share",
      "name@v1",
      "Name",
      "-leading",
      "under_score",
      "has space",
      "",
      "x".repeat(65),
    ];
    for (const text of notBare) expect(isBareHubName(text), JSON.stringify(text)).toBe(false);
  });
});
