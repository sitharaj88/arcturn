/**
 * Tier tags, which are what keep a kit portable across providers.
 *
 * The failure this closes was live: every hub kit pinned a concrete provider
 * model in its roles and workflow steps, so every workflow in the catalog
 * returned 401 to anyone whose key for *that* provider was missing or dead —
 * while the model they actually configured sat unused. Kits carry
 * `tier:judgment` / `tier:build` / `tier:fast` now, and this file pins the
 * resolver that makes those mean something.
 */

import type { ModelSpec } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { composeTagResolver } from "./workflow.js";

const GLM: ModelSpec = { id: "zai-api/glm-5.2" } as ModelSpec;
const OPUS: ModelSpec = { id: "anthropic/claude-opus-5" } as ModelSpec;

describe("composeTagResolver", () => {
  it("routes a tier through the runtime's router", () => {
    const resolve = composeTagResolver(
      { router: { specForTier: (name) => (name === "judgment" ? GLM : undefined) } },
      () => OPUS,
    );
    expect(resolve?.("tier:judgment")).toBe(GLM);
  });

  it("leaves a concrete id to the caller's resolver, untouched", () => {
    // The base resolver is the catalog; tiers must not shadow it.
    const seen: string[] = [];
    const resolve = composeTagResolver({ router: { specForTier: () => GLM } }, (tag) => {
      seen.push(tag);
      return OPUS;
    });
    expect(resolve?.("anthropic/claude-opus-5")).toBe(OPUS);
    expect(seen).toEqual(["anthropic/claude-opus-5"]);
  });

  it("follows the router's own fallback for a tier the config never named", () => {
    // `specForTier` falls back to the subagent route internally — which lands
    // on the user's main model. That fallback is the whole point: a kit
    // authored with tiers runs on whatever the user configured, out of the
    // box, with no `route.tiers` block required.
    const resolve = composeTagResolver({ router: { specForTier: () => GLM } }, undefined);
    expect(resolve?.("tier:never-configured")).toBe(GLM);
  });

  it("refuses an empty tier name rather than resolving something", () => {
    const resolve = composeTagResolver({ router: { specForTier: () => GLM } }, undefined);
    expect(resolve?.("tier:")).toBeUndefined();
    expect(resolve?.("tier:   ")).toBeUndefined();
  });

  it("resolves a tier to nothing on a runtime with no router", () => {
    // A stub runtime in tests has no router. Refusing the step with the tag
    // named — dispatch's existing behaviour for an unresolvable model — beats
    // silently running it on whatever the stub happened to hold.
    const resolve = composeTagResolver({}, () => OPUS);
    expect(resolve?.("tier:judgment")).toBeUndefined();
    expect(resolve?.("anthropic/claude-opus-5")).toBe(OPUS);
  });

  it("is absent when there is neither a router nor a base resolver", () => {
    // `undefined` keeps dispatch's "no resolver was supplied" message, which
    // names the real problem better than a resolver that answers nothing.
    expect(composeTagResolver({}, undefined)).toBeUndefined();
  });
});
