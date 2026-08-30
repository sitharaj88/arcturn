/**
 * MODEL ROUTER — pick a cheaper model for the work that does not need the
 * flagship, without ever letting a stale config value stop Arcturn from starting.
 *
 * Arcturn juggles several kinds of model call that have very different quality
 * requirements: the main loop (needs the flagship), a delegated sub-agent
 * (often a focused, mechanical task), a compaction summary (lossy by design
 * already), and a session-title suggestion (a few words). Because Arcturn ships
 * nine provider adapters and a live catalog (`@arcturn/ai`'s `getModel` /
 * `listModels`), it can name a specific cheap model per route instead of
 * hard-coding one provider's small model.
 *
 * This module is intentionally standalone — it has no dependency on
 * `runtime.ts` or `config.ts` and does not resolve ids against the real
 * catalog itself; the caller injects a `resolve` function. `buildRuntime`
 * constructs one router per runtime over `config.route`, `createSubagent`
 * and the compaction call sites consume it, and `/model route` reads it
 * (via {@link describeRoutes}) and mutates it (via
 * {@link ModelRouter.setRoute}) — see
 * `docs/integration-notes/INTEGRATION-router.md` for how that wiring landed.
 *
 * Design choice worth calling out: resolution is lazy and per-kind cached,
 * and a bad id never throws. A stale cheap-model id left over in a user's
 * config (the model got deprecated, a typo, whatever) must not prevent Arcturn
 * from starting or from running the main loop — it should just fall back to
 * the main model and surface a warning the caller can print once.
 *
 * ## Tiers: portable model choices for role files and workflow steps
 *
 * A markdown agent's `model:` frontmatter and a workflow step's `[tag]` both
 * take a raw string today, and until now that string had to be a concrete
 * catalog id (`anthropic/claude-opus-5`) — which means a role file authored
 * against one provider is dead on arrival for anyone on another. `tiers` in
 * {@link RouterConfig} fixes that: a config maps a handful of symbolic names
 * (`judgment`, `build`, `cheap` — the config is an open string map, so any
 * names a fleet of role files wants to standardize on work) to whatever
 * concrete id that deployment actually wants, and a role/step names the tier
 * instead of the vendor:
 *
 * ```json
 * { "route": { "tiers": { "judgment": "zai/glm-5.3", "build": "zai/glm-4.7" } } }
 * ```
 *
 * ```md
 * model: tier:judgment
 * ```
 *
 * {@link resolveModelTag} is the composed entry point a caller (typically
 * whatever builds the `ModelTagResolver` handed to workflow dispatch) uses to
 * turn either shape of string into a {@link ModelSpec}: a `tier:<name>` tag
 * resolves through {@link ModelRouter.specForTier}, anything else resolves as
 * a concrete id exactly as before — this is purely additive, no existing
 * `[tag]` or `model:` value changes behavior. An unset tier (named, but
 * absent from `tiers`) never throws either — it falls back to the
 * `subagent` route and records a warning, the same "never the reason Arcturn
 * fails to start" guarantee the rest of this module makes for route kinds.
 */

import type { ModelSpec } from "@arcturn/types";

/** The different call sites a model choice can be routed for. */
export type RouteKind = "main" | "subagent" | "compaction" | "title";

/** Every {@link RouteKind}, in the order routes are usually displayed. */
export const ROUTE_KINDS: readonly RouteKind[] = ["main", "subagent", "compaction", "title"];

/**
 * A route kind {@link ModelRouter.setRoute} (and `/model route`) may change —
 * every kind but `main`, which is governed by the pick/rebind lifecycle.
 */
export type SettableRouteKind = Exclude<RouteKind, "main">;

/**
 * Every {@link SettableRouteKind}, derived from {@link ROUTE_KINDS} so a new
 * kind can never exist in one list and not the other.
 */
export const SETTABLE_ROUTE_KINDS: readonly SettableRouteKind[] = ROUTE_KINDS.filter(
  (kind): kind is SettableRouteKind => kind !== "main",
);

/**
 * Prefix that marks a `[tag]` or `model:` string as a symbolic tier name
 * (`"tier:judgment"`) rather than a concrete catalog id. See
 * {@link resolveModelTag}.
 */
export const TIER_TAG_PREFIX = "tier:";

/**
 * Per-kind model overrides. A key that is absent (or `undefined`) means
 * "use whatever `main` resolves to" — including `main` itself being absent,
 * which means "use the router's fallback model" (typically the model the
 * user picked with `--model`).
 */
export interface RouterConfig {
  /** Model id for the main loop. Absent means "use the fallback model". */
  main?: string;
  /** Model id for delegated sub-agents. Absent means "use `main`'s route". */
  subagent?: string;
  /** Model id for compaction summaries. Absent means "use `main`'s route". */
  compaction?: string;
  /** Model id for session-title generation. Absent means "use `main`'s route". */
  title?: string;
  /**
   * Symbolic model tiers, e.g. `{ judgment: "zai/glm-5.3", build: "zai/glm-4.7" }`.
   * A role's `model:` or a workflow step's `[tag]` may name a tier as
   * `tier:<name>` instead of a concrete catalog id — see
   * {@link resolveModelTag} and {@link ModelRouter.specForTier}. Absent or
   * missing a given name means every reference to that tier falls back to
   * the `subagent` route (with a recorded warning), never a crash.
   */
  tiers?: Record<string, string>;
}

/** Resolves a catalog id to a {@link ModelSpec}; may throw on an unknown id. */
export type ModelResolver = (id: string) => ModelSpec;

/** A resolved-and-cached mapping from {@link RouteKind} to {@link ModelSpec}. */
export interface ModelRouter {
  /**
   * The model to use for one kind of call. Resolves lazily on first access
   * and caches the result — repeated calls for the same kind never re-invoke
   * the resolver.
   *
   * @param kind - Which call site is asking.
   */
  specFor(kind: RouteKind): ModelSpec;
  /**
   * The model for a symbolic tier name (the part after `tier:` in a `[tag]`
   * or `model:` string — pass `"judgment"`, not `"tier:judgment"`). Resolves
   * lazily and caches per name, same as {@link ModelRouter.specFor}.
   *
   * - Configured (`config.tiers[name]` set): resolved through the injected
   *   resolver, same never-throws/warn-and-fall-back-to-`fallback` behavior
   *   as any other route.
   * - Unconfigured (`name` absent from `tiers`, including when `tiers`
   *   itself is absent): falls back to {@link ModelRouter.specFor}`("subagent")`
   *   and records a warning — a tier left untuned in a deployment's config
   *   must not stop a portable role file from running.
   *
   * @param name - Tier name with no `tier:` prefix.
   */
  specForTier(name: string): ModelSpec;
  /**
   * Non-fatal problems recorded while resolving routes so far — one entry per
   * kind whose configured id could not be resolved. Empty until a failing
   * kind has actually been looked up via {@link ModelRouter.specFor}.
   */
  warnings(): readonly string[];
  /**
   * Drop cached resolutions and adopt a new fallback — call after the
   * session's main model changes, or routes that defaulted to the old one
   * keep resolving to it. Also clears a configured `route.main`: the switch
   * is an explicit choice of main model, and a config default must not keep
   * outvoting it on routed calls. Per-kind overrides and `tiers` survive —
   * including ones installed by {@link ModelRouter.setRoute}.
   *
   * @param fallback - The new main model.
   */
  rebind(fallback: ModelSpec): void;
  /**
   * Change one cheap route in the LIVE router — the in-session half of a
   * persisted route change (`persistRoutePatch` in `config.ts` is the
   * on-disk half; `/model route --auto` calls both). Clears the resolution
   * caches, exactly as {@link ModelRouter.rebind} does, so the next
   * {@link ModelRouter.specFor} (and {@link describeRoutes}) reflects the
   * change immediately; the `main` override is left standing.
   *
   * `main` is deliberately not settable here: the main route is governed by
   * the pick/rebind lifecycle (`/model <id>` → {@link ModelRouter.rebind}),
   * and letting a route mutation reach it would hand the heuristic in
   * `/model route --auto` the power to silently swap the conversation's own
   * model.
   *
   * @param kind - Which cheap route to change.
   * @param id - New model id, or `undefined` to clear the override (the kind
   *   then falls back to the `main` route again).
   */
  setRoute(kind: SettableRouteKind, id: string | undefined): void;
  /**
   * Whether `kind` is EXPLICITLY routed — set in config or installed via
   * {@link ModelRouter.setRoute} (for `main`: a standing `route.main`
   * override). Never true merely because a fallback (`route.main`, or the
   * live main model) would answer `specFor(kind)`. Callers that would
   * otherwise use "the model already in the seat" (e.g. an agent compacting
   * with its own model) use this to defer to the seat when no per-kind policy
   * exists — a standing `route.main` must not silently upgrade a sub-agent's
   * compaction to the flagship. `specFor` alone cannot tell the two apart,
   * because its fallback chain always produces *some* model.
   *
   * @param kind - The route kind to ask about.
   */
  isRouted(kind: RouteKind): boolean;
}

/**
 * Build a {@link ModelRouter} over a config, a catalog resolver, and a
 * fallback model.
 *
 * Nothing is resolved here — construction is pure bookkeeping. Each kind is
 * resolved (and cached) the first time {@link ModelRouter.specFor} asks for
 * it:
 *
 * - `main`: `config.main` resolved through `resolve`, or `fallback` if absent.
 * - `subagent` / `compaction` / `title`: their own configured id resolved
 *   through `resolve`, or the (cached) `main` route if absent.
 *
 * If `resolve` throws for a configured id — unknown model, deregistered
 * preset, whatever — that is caught, the kind falls back to `fallback`, and
 * a warning is recorded. A router is never the reason Arcturn fails to start.
 *
 * @param config - Per-kind model id overrides, e.g. from `arcturn.config.json`.
 * @param resolve - Turns a catalog id into a {@link ModelSpec}; may throw.
 * @param fallback - Used for the `main` route when unconfigured, and for any
 *   route whose configured id fails to resolve.
 */
export function createModelRouter(
  config: RouterConfig,
  resolve: ModelResolver,
  fallback: ModelSpec,
): ModelRouter {
  const cache = new Map<RouteKind, ModelSpec>();
  const tierCache = new Map<string, ModelSpec>();
  // The router's own view of the config, shallow-copied so `setRoute` can
  // mutate it without reaching back into the caller's (merged, shared)
  // config object — a live route change is the router's state, not a rewrite
  // of what the config files said.
  const view: RouterConfig = { ...config };
  let active = fallback;
  // `route.main` is a startup default, not a standing veto: an explicit
  // in-session switch (`rebind`) clears it, or the pick would govern the
  // chat while every routed call — sub-agents, tiers, workflow stages —
  // quietly kept the config file's model. The per-kind overrides
  // (`subagent`, `compaction`, `title`) and `tiers` are deliberate policy
  // and survive a switch.
  let mainOverride = config.main;
  const collectedWarnings: string[] = [];

  // `label` is a `RouteKind` for the four fixed routes and `tier:<name>` for
  // a tier — either way it is only ever used to name the failing route in a
  // warning, so a plain `string` is all this needs.
  function resolveConfigured(id: string, label: string): ModelSpec {
    try {
      return resolve(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      collectedWarnings.push(
        `route "${label}": model "${id}" could not be resolved (${reason}); ` +
          // Read `active` here, not the closure-captured `fallback` param —
          // after a `rebind`, `active` is the current fallback and the two
          // diverge. This is also what gets returned below, so the warning
          // always names the model actually in use.
          `falling back to ${active.displayName}.`,
      );
      return active;
    }
  }

  function specFor(kind: RouteKind): ModelSpec {
    const cached = cache.get(kind);
    if (cached) return cached;

    const configured = kind === "main" ? undefined : view[kind];
    const spec =
      kind === "main"
        ? mainOverride === undefined
          ? active
          : resolveConfigured(mainOverride, kind)
        : configured === undefined
          ? specFor("main")
          : resolveConfigured(configured, kind);

    cache.set(kind, spec);
    return spec;
  }

  function specForTier(name: string): ModelSpec {
    const cached = tierCache.get(name);
    if (cached) return cached;

    const configuredId = view.tiers?.[name];
    let spec: ModelSpec;
    if (configuredId === undefined) {
      // Compute the fallback first so the warning can name what it actually
      // resolved to, not just that it fell back to "something".
      spec = specFor("subagent");
      collectedWarnings.push(
        `tier "${name}" is not configured; falling back to the subagent route ` +
          `(${spec.displayName}).`,
      );
    } else {
      spec = resolveConfigured(configuredId, `tier:${name}`);
    }

    tierCache.set(name, spec);
    return spec;
  }

  return {
    specFor,
    specForTier,
    warnings: () => [...collectedWarnings],
    rebind(next: ModelSpec): void {
      active = next;
      mainOverride = undefined;
      cache.clear();
      tierCache.clear();
    },
    setRoute(kind: SettableRouteKind, id: string | undefined): void {
      if (id === undefined) delete view[kind];
      else view[kind] = id;
      // The same eviction `rebind` performs: both caches, wholesale. A kind
      // that fell back to `main` cached main's spec under its own key, and an
      // unset tier memoises the *subagent* route under its own name — rather
      // than duplicate that fallback knowledge here (and serve stale specs
      // the day it changes), drop everything and let the lazy resolution
      // re-derive it. `mainOverride` is untouched: a cheap-route change is
      // not a model pick.
      cache.clear();
      tierCache.clear();
    },
    isRouted(kind: RouteKind): boolean {
      // Explicit per-kind policy only. A standing `route.main` makes the
      // fallback CHAIN resolve differently, but it is not a decision about
      // this kind — reporting it as routed is what let an unrouted agent's
      // compaction get silently upgraded to route.main's flagship.
      if (kind === "main") return mainOverride !== undefined;
      return view[kind] !== undefined;
    },
  };
}

/**
 * The catalog vendor namespace of a spec: the segment before the first `/`
 * in its id (`"zai-api"` for `zai-api/glm-4.7-flash`), or `undefined` for an
 * id with no namespace. All catalog ids are `vendor/model`-shaped, including
 * every preset model (`presetSpec` builds `<preset>/<model>` ids).
 */
function vendorNamespace(spec: ModelSpec): string | undefined {
  const slash = spec.id.indexOf("/");
  return slash > 0 ? spec.id.slice(0, slash) : undefined;
}

/**
 * Heuristic pick of a cheaper stand-in for `main` — the engine behind
 * `/model route --auto`, which applies the pick to the `subagent` and
 * `compaction` routes (live via {@link ModelRouter.setRoute}, persisted via
 * `persistRoutePatch`). Still never applied without that explicit command:
 * a heuristic must not silently change what a sub-agent run costs.
 *
 * Restricted to candidates that:
 * - share `main`'s catalog vendor namespace (the segment before the `/` in
 *   the id). The `provider` field is NOT enough: every openai-protocol
 *   preset model is stamped `provider: "openai-compatible"`, so provider
 *   equality would happily route a `deepseek/*` main onto another vendor's
 *   endpoint — a different API key, or the same key on a differently billed
 *   endpoint (`zai/*` vs `zai-api/*`). A cross-vendor swap needs a human
 *   decision, not a heuristic. Ids without a namespace fall back to the
 *   provider comparison;
 * - report `capabilities.tools` (a sub-agent or compaction call that cannot
 *   call tools is not a candidate, since sub-agents run the full tool loop
 *   and compaction/title calls are plain completions but routing a
 *   tools-incapable model into the sub-agent slot would silently break it);
 * - are not `main` itself;
 * - carry known `cost.input` — a model with no cost data is never guessed
 *   at, it is simply excluded;
 * - when `main` publishes `cost`, are strictly cheaper than it
 *   (`cost.input < main.cost.input`) — "optimising" the bill upward is not a
 *   suggestion. An unpriced `main` accepts any priced same-namespace
 *   candidate; the caller owes the user an honest caveat that no comparison
 *   was possible.
 *
 * Ties (equal `cost.input`) keep whichever candidate was seen first.
 *
 * @param candidates - Pool to pick from, typically `listModels()`.
 * @param main - The model being routed away from.
 * @returns The cheapest eligible candidate by `cost.input`, or `undefined`
 *   when none qualify.
 */
export function suggestCheapModel(candidates: ModelSpec[], main: ModelSpec): ModelSpec | undefined {
  const mainVendor = vendorNamespace(main);
  let best: ModelSpec | undefined;
  for (const candidate of candidates) {
    if (candidate.id === main.id) continue;
    const candidateVendor = vendorNamespace(candidate);
    if (mainVendor !== undefined && candidateVendor !== undefined) {
      if (candidateVendor !== mainVendor) continue;
    } else if (candidate.provider !== main.provider) {
      continue;
    }
    if (!candidate.capabilities.tools) continue;
    if (candidate.cost === undefined) continue;
    if (main.cost !== undefined && candidate.cost.input >= main.cost.input) continue;
    if (best === undefined || candidate.cost.input < best.cost!.input) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Resolve a `[tag]` (workflow step) or `model:` (role frontmatter) string to
 * a {@link ModelSpec} — the one place that decides whether such a string
 * names a symbolic {@link RouterConfig.tiers | tier} or a concrete catalog
 * id, so a caller wiring up a `ModelTagResolver` (see `workflow.ts`) does not
 * have to duplicate that decision itself.
 *
 * - `tier:<name>` — resolved through `router.specForTier(name)`. Per that
 *   method's contract this never fails outright: an unset or unresolvable
 *   tier falls back to the `subagent` route and records a warning on
 *   `router`, so the returned spec is always defined.
 * - Anything else — treated as a concrete catalog id and resolved directly
 *   through `resolve`, exactly the behavior every `[tag]`/`model:` had
 *   before tiers existed: `undefined` on an unknown id, and nothing is
 *   recorded on `router.warnings()` (the router is not consulted at all for
 *   this branch).
 *
 * @param tag - The raw tag/model string, e.g. `"tier:judgment"` or
 *   `"anthropic/claude-opus-5"`.
 * @param router - Supplies tier configuration and the `subagent` fallback.
 * @param resolve - Resolves a concrete catalog id; may throw on an unknown
 *   one (caught and turned into `undefined`, same as before tiers existed).
 * @returns The resolved spec, or `undefined` only for an unresolvable
 *   concrete id or a `tier:` tag with an empty name.
 */
export function resolveModelTag(
  tag: string,
  router: ModelRouter,
  resolve: ModelResolver,
): ModelSpec | undefined {
  if (tag.startsWith(TIER_TAG_PREFIX)) {
    const name = tag.slice(TIER_TAG_PREFIX.length).trim();
    if (name.length === 0) return undefined;
    return router.specForTier(name);
  }
  try {
    return resolve(tag);
  } catch {
    return undefined;
  }
}

/**
 * Render a router's current routes as human-readable lines, for a `/model
 * route` display.
 *
 * Resolving each kind through {@link ModelRouter.specFor} means this also
 * populates the router's cache and warnings as a side effect — calling it
 * once up front is the intended use, e.g. right before printing.
 *
 * @param router - Router to describe.
 * @param kinds - Which kinds to show, and in what order. Defaults to
 *   {@link ROUTE_KINDS}.
 */
export function describeRoutes(
  router: ModelRouter,
  kinds: readonly RouteKind[] = ROUTE_KINDS,
): string[] {
  const width = kinds.reduce((max, kind) => Math.max(max, kind.length), 0);
  return kinds.map((kind) => {
    const spec = router.specFor(kind);
    return `${kind.padEnd(width)}  ${spec.id.padEnd(28)}  ${spec.displayName}`;
  });
}
