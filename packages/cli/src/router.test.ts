import type { ModelSpec } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import {
  createModelRouter,
  describeRoutes,
  ROUTE_KINDS,
  type RouteKind,
  resolveModelTag,
  suggestCheapModel,
  TIER_TAG_PREFIX,
} from "./router.js";

function spec(overrides: Partial<ModelSpec> & { id: string }): ModelSpec {
  return {
    provider: "anthropic",
    model: overrides.id,
    displayName: overrides.id,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: { tools: true, vision: false, thinking: false, caching: true },
    ...overrides,
  };
}

const FLAGSHIP = spec({ id: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" });
const HAIKU = spec({
  id: "anthropic/claude-haiku-5",
  displayName: "Claude Haiku 5",
  cost: { input: 0.8, output: 4 },
});
const OPUS = spec({
  id: "anthropic/claude-opus-5",
  displayName: "Claude Opus 5",
  cost: { input: 15, output: 75 },
});
const GPT = spec({
  id: "openai/gpt-5",
  provider: "openai",
  displayName: "GPT-5",
  cost: { input: 5, output: 15 },
});
const NO_TOOLS = spec({
  id: "anthropic/claude-embed",
  displayName: "Claude Embed",
  cost: { input: 0.1, output: 0.1 },
  capabilities: { tools: false, vision: false, thinking: false, caching: false },
});
const NO_COST = spec({ id: "anthropic/claude-mystery", displayName: "Claude Mystery" });

/** A registry-backed resolver, standing in for `resolveModelSpec`. */
function catalogResolver(models: ModelSpec[]): (id: string) => ModelSpec {
  const byId = new Map(models.map((model) => [model.id, model]));
  return (id: string) => {
    const found = byId.get(id);
    if (!found) throw new Error(`Unknown model "${id}"`);
    return found;
  };
}

describe("createModelRouter", () => {
  it("resolves each configured kind to its own model", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU, OPUS]);
    const router = createModelRouter(
      { main: FLAGSHIP.id, subagent: HAIKU.id, compaction: HAIKU.id, title: OPUS.id },
      resolve,
      FLAGSHIP,
    );
    expect(router.specFor("main")).toBe(FLAGSHIP);
    expect(router.specFor("subagent")).toBe(HAIKU);
    expect(router.specFor("compaction")).toBe(HAIKU);
    expect(router.specFor("title")).toBe(OPUS);
    expect(router.warnings()).toEqual([]);
  });

  it("falls back an absent kind to the main route", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU]);
    const router = createModelRouter({ main: FLAGSHIP.id, subagent: HAIKU.id }, resolve, FLAGSHIP);
    // compaction and title were not configured: both fall back to main.
    expect(router.specFor("compaction")).toBe(FLAGSHIP);
    expect(router.specFor("title")).toBe(FLAGSHIP);
    expect(router.specFor("subagent")).toBe(HAIKU);
  });

  it("uses the fallback model as main when config.main is absent", () => {
    const resolve = catalogResolver([HAIKU]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    expect(router.specFor("main")).toBe(FLAGSHIP);
    expect(router.specFor("subagent")).toBe(FLAGSHIP);
  });

  it("falls back to `fallback` and records a warning when an id is unresolvable, never throws", () => {
    const resolve = catalogResolver([FLAGSHIP]);
    const router = createModelRouter(
      { main: FLAGSHIP.id, subagent: "anthropic/does-not-exist" },
      resolve,
      FLAGSHIP,
    );
    expect(() => router.specFor("subagent")).not.toThrow();
    expect(router.specFor("subagent")).toBe(FLAGSHIP);
    const warnings = router.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("subagent");
    expect(warnings[0]).toContain("anthropic/does-not-exist");
  });

  it("names the post-rebind fallback in the warning, not the model rebind replaced", () => {
    const OLD_MAIN = spec({ id: "old/main", displayName: "OldMain" });
    const NEW_MAIN = spec({ id: "new/main", displayName: "NewMain" });
    const resolve = catalogResolver([]);
    const router = createModelRouter({ subagent: "deregistered/model" }, resolve, OLD_MAIN);
    router.rebind(NEW_MAIN);

    // Resolution is correct on its own: the rebound fallback wins.
    expect(router.specFor("subagent")).toBe(NEW_MAIN);
    // The warning must track the model actually in use post-rebind, not the
    // pre-rebind fallback captured in the closure at construction time.
    const text = router.warnings().join("\n");
    expect(text).toContain("NewMain");
    expect(text).not.toContain("OldMain");
  });

  it("never throws at construction time even with a config full of bad ids", () => {
    expect(() =>
      createModelRouter(
        { main: "nope", subagent: "nope", compaction: "nope", title: "nope" },
        catalogResolver([]),
        FLAGSHIP,
      ),
    ).not.toThrow();
  });

  it("caches: the resolver is called at most once per kind", () => {
    const resolveSpy = vi.fn(catalogResolver([FLAGSHIP, HAIKU]));
    const router = createModelRouter(
      { main: FLAGSHIP.id, subagent: HAIKU.id },
      resolveSpy,
      FLAGSHIP,
    );

    router.specFor("subagent");
    router.specFor("subagent");
    router.specFor("subagent");
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    router.specFor("main");
    router.specFor("main");
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it("caches the fallback-to-main resolution too: main is resolved once even via multiple absent kinds", () => {
    const resolveSpy = vi.fn(catalogResolver([FLAGSHIP]));
    const router = createModelRouter({ main: FLAGSHIP.id }, resolveSpy, FLAGSHIP);

    router.specFor("compaction");
    router.specFor("title");
    router.specFor("subagent");
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("does not resolve anything at construction time (lazy)", () => {
    const resolveSpy = vi.fn(catalogResolver([FLAGSHIP]));
    createModelRouter({ main: FLAGSHIP.id }, resolveSpy, FLAGSHIP);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

describe("suggestCheapModel", () => {
  it("picks the cheapest same-provider, tool-capable candidate", () => {
    expect(suggestCheapModel([HAIKU, OPUS, GPT], FLAGSHIP)).toBe(HAIKU);
  });

  it("ignores candidates from other providers", () => {
    expect(suggestCheapModel([GPT], FLAGSHIP)).toBeUndefined();
  });

  it("ignores candidates without tool support", () => {
    expect(suggestCheapModel([NO_TOOLS], FLAGSHIP)).toBeUndefined();
  });

  it("never guesses when no candidate has cost data", () => {
    expect(suggestCheapModel([NO_COST], FLAGSHIP)).toBeUndefined();
  });

  it("returns undefined for an empty candidate pool", () => {
    expect(suggestCheapModel([], FLAGSHIP)).toBeUndefined();
  });

  it("excludes main itself even if present in the pool", () => {
    expect(suggestCheapModel([FLAGSHIP, HAIKU], FLAGSHIP)).toBe(HAIKU);
  });

  it("refuses a cross-vendor candidate even when both carry the same protocol provider id", () => {
    // Every openai-protocol preset model is stamped provider
    // "openai-compatible" (presetSpec in @arcturn/ai), so the provider field
    // alone cannot tell deepseek/* from zai-api/* — the id namespace can.
    const deepseekMain = spec({
      id: "deepseek/deepseek-chat",
      provider: "openai-compatible",
      cost: { input: 0.28, output: 0.42 },
    });
    const zaiFlash = spec({
      id: "zai-api/glm-4.7-flash",
      provider: "openai-compatible",
      cost: { input: 0, output: 0 },
    });
    expect(suggestCheapModel([zaiFlash], deepseekMain)).toBeUndefined();
  });

  it("returns undefined when the best same-namespace candidate is not cheaper than a priced main", () => {
    const cheapMain = spec({
      id: "duo/cheap-main",
      provider: "duo",
      cost: { input: 0.1, output: 0.2 },
    });
    const pricy = spec({
      id: "duo/pricy-sibling",
      provider: "duo",
      cost: { input: 5, output: 10 },
    });
    const equal = spec({
      id: "duo/equal-sibling",
      provider: "duo",
      cost: { input: 0.1, output: 0.2 },
    });
    expect(suggestCheapModel([pricy, equal], cheapMain)).toBeUndefined();
  });

  it("still suggests a same-namespace priced candidate when main publishes no pricing", () => {
    // FLAGSHIP has no cost data: there is nothing to compare against, so a
    // priced sibling is eligible — the command's caveat covers the honesty.
    expect(suggestCheapModel([HAIKU], FLAGSHIP)).toBe(HAIKU);
  });

  it("falls back to the provider comparison for ids without a vendor namespace", () => {
    const bareMain = spec({ id: "bare-main", provider: "custom" });
    const bareCheap = spec({
      id: "bare-cheap",
      provider: "custom",
      cost: { input: 0.1, output: 0.2 },
    });
    const bareOther = spec({
      id: "other-bare",
      provider: "elsewhere",
      cost: { input: 0.05, output: 0.1 },
    });
    expect(suggestCheapModel([bareCheap, bareOther], bareMain)).toBe(bareCheap);
  });
});

describe("describeRoutes", () => {
  it("renders one readable line per kind", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU]);
    const router = createModelRouter({ main: FLAGSHIP.id, subagent: HAIKU.id }, resolve, FLAGSHIP);
    const lines = describeRoutes(router, ["main", "subagent"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("main");
    expect(lines[0]).toContain(FLAGSHIP.id);
    expect(lines[0]).toContain(FLAGSHIP.displayName);
    expect(lines[1]).toContain("subagent");
    expect(lines[1]).toContain(HAIKU.id);
    expect(lines[1]).toContain(HAIKU.displayName);
  });

  it("defaults to every route kind in a stable order", () => {
    const resolve = catalogResolver([FLAGSHIP]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    const lines = describeRoutes(router);
    expect(lines).toHaveLength(ROUTE_KINDS.length);
    ROUTE_KINDS.forEach((kind: RouteKind, index) => {
      expect(lines[index]).toContain(kind);
    });
  });
});

describe("ModelRouter.specForTier", () => {
  it("resolves a configured tier through config.tiers", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU, OPUS]);
    const router = createModelRouter(
      { tiers: { judgment: OPUS.id, build: HAIKU.id } },
      resolve,
      FLAGSHIP,
    );
    expect(router.specForTier("judgment")).toBe(OPUS);
    expect(router.specForTier("build")).toBe(HAIKU);
    expect(router.warnings()).toEqual([]);
  });

  it("falls back to the subagent route with a warning when a tier is unset, and never throws", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU]);
    // `subagent` itself is configured, so the fallback is provably "the
    // subagent route", not just "whatever the constructor's fallback was".
    const router = createModelRouter({ subagent: HAIKU.id }, resolve, FLAGSHIP);
    expect(() => router.specForTier("judgment")).not.toThrow();
    expect(router.specForTier("judgment")).toBe(HAIKU);
    const warnings = router.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("judgment");
  });

  it("falls back to the subagent route (which itself falls back to main) when tiers is entirely absent", () => {
    const resolve = catalogResolver([FLAGSHIP]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    expect(router.specForTier("cheap")).toBe(FLAGSHIP);
    expect(router.warnings()).toHaveLength(1);
  });

  it("falls back to the fallback model with a warning when a configured tier id cannot be resolved, never throws", () => {
    const resolve = catalogResolver([FLAGSHIP]);
    const router = createModelRouter(
      { tiers: { judgment: "zai/does-not-exist" } },
      resolve,
      FLAGSHIP,
    );
    expect(() => router.specForTier("judgment")).not.toThrow();
    expect(router.specForTier("judgment")).toBe(FLAGSHIP);
    const warnings = router.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tier:judgment");
    expect(warnings[0]).toContain("zai/does-not-exist");
  });

  it("caches: the resolver is called at most once per tier name", () => {
    const resolveSpy = vi.fn(catalogResolver([FLAGSHIP, OPUS]));
    const router = createModelRouter({ tiers: { judgment: OPUS.id } }, resolveSpy, FLAGSHIP);
    router.specForTier("judgment");
    router.specForTier("judgment");
    router.specForTier("judgment");
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("rebind clears the tier cache too, so a live model switch re-derives unset tiers", () => {
    const resolve = catalogResolver([FLAGSHIP, OPUS]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    expect(router.specForTier("cheap")).toBe(FLAGSHIP);
    router.rebind(OPUS);
    expect(router.specForTier("cheap")).toBe(OPUS);
  });

  it("rebind clears a configured route.main, so the switch governs routed calls", () => {
    const resolve = catalogResolver([FLAGSHIP, OPUS, HAIKU]);
    const router = createModelRouter({ main: FLAGSHIP.id }, resolve, FLAGSHIP);
    expect(router.specFor("main")).toBe(FLAGSHIP);
    router.rebind(OPUS);
    // Without the clear, config.main keeps outvoting the explicit switch on
    // every routed call — the chat speaks the new model while sub-agents,
    // tiers and workflow stages quietly keep billing the old one.
    expect(router.specFor("main")).toBe(OPUS);
    expect(router.specFor("subagent")).toBe(OPUS);
    expect(router.specForTier("anything")).toBe(OPUS);
  });

  it("rebind leaves the per-kind overrides and tiers standing — only main is the pick", () => {
    const resolve = catalogResolver([FLAGSHIP, OPUS, HAIKU]);
    const router = createModelRouter(
      { main: FLAGSHIP.id, subagent: HAIKU.id, tiers: { judgment: HAIKU.id } },
      resolve,
      FLAGSHIP,
    );
    router.rebind(OPUS);
    expect(router.specFor("main")).toBe(OPUS);
    expect(router.specFor("subagent")).toBe(HAIKU);
    expect(router.specForTier("judgment")).toBe(HAIKU);
  });
});

describe("ModelRouter.setRoute", () => {
  it("applies live: the next specFor sees the new route, and describeRoutes reflects it", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    expect(router.specFor("subagent")).toBe(FLAGSHIP);

    router.setRoute("subagent", HAIKU.id);
    expect(router.specFor("subagent")).toBe(HAIKU);
    const lines = describeRoutes(router);
    expect(lines.find((line) => line.startsWith("subagent"))).toContain(HAIKU.id);
  });

  it("clears the caches like rebind — every kind re-derives, and none serves a stale spec", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU, OPUS]);
    const router = createModelRouter({ main: FLAGSHIP.id, compaction: OPUS.id }, resolve, FLAGSHIP);
    // Warm every kind first, so the change below has stale entries to beat.
    router.specFor("main");
    router.specFor("subagent");
    router.specFor("compaction");

    router.setRoute("subagent", HAIKU.id);
    // The changed kind reflects the new route, and the untouched kinds still
    // resolve to exactly what their config says — lazily re-derived rather
    // than answered from a cache whose fallback knowledge could go stale.
    expect(router.specFor("subagent")).toBe(HAIKU);
    expect(router.specFor("main")).toBe(FLAGSHIP);
    expect(router.specFor("compaction")).toBe(OPUS);
  });

  it("clears an override with undefined, falling back to the main route again", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU]);
    const router = createModelRouter({ subagent: HAIKU.id }, resolve, FLAGSHIP);
    expect(router.specFor("subagent")).toBe(HAIKU);
    router.setRoute("subagent", undefined);
    expect(router.specFor("subagent")).toBe(FLAGSHIP);
  });

  it("leaves the main override and tiers standing", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU, OPUS]);
    const router = createModelRouter(
      { main: OPUS.id, tiers: { judgment: OPUS.id } },
      resolve,
      FLAGSHIP,
    );
    router.setRoute("subagent", HAIKU.id);
    router.setRoute("compaction", HAIKU.id);
    // The configured main override still governs the main route…
    expect(router.specFor("main")).toBe(OPUS);
    // …and configured tiers are their own policy, untouched.
    expect(router.specForTier("judgment")).toBe(OPUS);
  });

  it("re-derives unset tiers (which memoise the subagent route) after a subagent change", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU, OPUS]);
    const router = createModelRouter({ tiers: { judgment: OPUS.id } }, resolve, FLAGSHIP);
    expect(router.specForTier("untuned")).toBe(FLAGSHIP);
    router.setRoute("subagent", HAIKU.id);
    // The unset tier follows the new subagent route; the configured one does not.
    expect(router.specForTier("untuned")).toBe(HAIKU);
    expect(router.specForTier("judgment")).toBe(OPUS);
  });

  it("survives a rebind: setRoute overrides are policy, like configured kinds", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU, OPUS]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    router.setRoute("subagent", HAIKU.id);
    router.rebind(OPUS);
    expect(router.specFor("main")).toBe(OPUS);
    expect(router.specFor("subagent")).toBe(HAIKU);
    expect(router.specFor("compaction")).toBe(OPUS);
  });

  it("tolerates an unresolvable id exactly like a configured one: falls back and warns", () => {
    const resolve = catalogResolver([FLAGSHIP]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    router.setRoute("subagent", "nope/nope");
    expect(() => router.specFor("subagent")).not.toThrow();
    expect(router.specFor("subagent")).toBe(FLAGSHIP);
    expect(router.warnings().join("\n")).toContain("nope/nope");
  });
});

describe("ModelRouter.isRouted", () => {
  it("is false for every kind on an empty config", () => {
    const router = createModelRouter({}, catalogResolver([FLAGSHIP]), FLAGSHIP);
    for (const kind of ROUTE_KINDS) expect(router.isRouted(kind)).toBe(false);
  });

  it("is true for a configured kind, and for main only while its own override stands", () => {
    const resolve = catalogResolver([FLAGSHIP, HAIKU, OPUS]);
    const configured = createModelRouter({ compaction: HAIKU.id }, resolve, FLAGSHIP);
    expect(configured.isRouted("compaction")).toBe(true);
    expect(configured.isRouted("subagent")).toBe(false);

    const pinned = createModelRouter({ main: OPUS.id }, resolve, FLAGSHIP);
    expect(pinned.isRouted("main")).toBe(true);
    // rebind (an explicit model switch) withdraws the main override.
    pinned.rebind(HAIKU);
    expect(pinned.isRouted("main")).toBe(false);
  });

  it("tracks setRoute in both directions", () => {
    const router = createModelRouter({}, catalogResolver([FLAGSHIP, HAIKU]), FLAGSHIP);
    router.setRoute("subagent", HAIKU.id);
    expect(router.isRouted("subagent")).toBe(true);
    router.setRoute("subagent", undefined);
    expect(router.isRouted("subagent")).toBe(false);
  });

  it("never reports a cheap kind as routed on the strength of route.main alone", () => {
    // route.main governs what the compaction ROUTE resolves to, but it is not
    // per-kind policy: an agent whose kind is unrouted must keep using its own
    // seat model (routedCompactionOptions defers on this exact answer), or a
    // sub-agent on the cheap route silently compacts on the flagship again.
    const pinned = createModelRouter(
      { main: OPUS.id },
      catalogResolver([FLAGSHIP, HAIKU, OPUS]),
      FLAGSHIP,
    );
    expect(pinned.isRouted("main")).toBe(true);
    expect(pinned.isRouted("compaction")).toBe(false);
    expect(pinned.isRouted("subagent")).toBe(false);
    expect(pinned.isRouted("title")).toBe(false);
  });
});

describe("resolveModelTag", () => {
  it("resolves a tier: prefixed tag through the router's tier config", () => {
    const resolve = catalogResolver([FLAGSHIP, OPUS]);
    const router = createModelRouter({ tiers: { judgment: OPUS.id } }, resolve, FLAGSHIP);
    expect(resolveModelTag(`${TIER_TAG_PREFIX}judgment`, router, resolve)).toBe(OPUS);
  });

  it("falls back cleanly (with a warning, never a crash) when the tag names an unset tier", () => {
    const resolve = catalogResolver([FLAGSHIP]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    expect(() => resolveModelTag("tier:judgment", router, resolve)).not.toThrow();
    expect(resolveModelTag("tier:judgment", router, resolve)).toBe(FLAGSHIP);
    expect(router.warnings().length).toBeGreaterThan(0);
  });

  it("treats a tag with no tier: prefix as a concrete catalog id, exactly as before tiers existed", () => {
    const resolve = catalogResolver([FLAGSHIP, OPUS]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    expect(resolveModelTag(OPUS.id, router, resolve)).toBe(OPUS);
    // The concrete-id path never touches the router: no warning recorded.
    expect(router.warnings()).toEqual([]);
  });

  it("returns undefined for an unresolvable concrete id, unchanged from before tiers existed", () => {
    const resolve = catalogResolver([FLAGSHIP]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    expect(resolveModelTag("anthropic/does-not-exist", router, resolve)).toBeUndefined();
    expect(router.warnings()).toEqual([]);
  });

  it("returns undefined for a tier: tag with an empty name", () => {
    const resolve = catalogResolver([FLAGSHIP]);
    const router = createModelRouter({}, resolve, FLAGSHIP);
    expect(resolveModelTag("tier:", router, resolve)).toBeUndefined();
  });
});
