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
 * catalog itself; the caller injects a `resolve` function. See
 * `INTEGRATION-router.md` at the repo root for the exact call sites this is
 * meant to wire into (`resolveModelSpec` in `runtime.ts`'s `createSubagent`
 * and `compactionOptionsFor`, and a config key in `config.ts`), none of
 * which this file touches.
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
   * outvoting it on routed calls. Per-kind overrides and `tiers` survive.
   *
   * @param fallback - The new main model.
   */
  rebind(fallback: ModelSpec): void;
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

    const spec =
      kind === "main"
        ? mainOverride === undefined
          ? active
          : resolveConfigured(mainOverride, kind)
        : config[kind] === undefined
          ? specFor("main")
          : resolveConfigured(config[kind], kind);

    cache.set(kind, spec);
    return spec;
  }

  function specForTier(name: string): ModelSpec {
    const cached = tierCache.get(name);
    if (cached) return cached;

    const configuredId = config.tiers?.[name];
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
  };
}

/**
 * Heuristic pick of a cheaper stand-in for `main`, for a `/model route
 * --auto` sketch (not applied automatically — see `INTEGRATION-router.md`).
 *
 * Restricted to candidates that:
 * - share `main`'s provider (a cross-provider swap needs a new API key and a
 *   human decision, not a heuristic);
 * - report `capabilities.tools` (a sub-agent or compaction call that cannot
 *   call tools is not a candidate, since sub-agents run the full tool loop
 *   and compaction/title calls are plain completions but routing a
 *   tools-incapable model into the sub-agent slot would silently break it);
 * - are not `main` itself;
 * - carry known `cost.input` — a model with no cost data is never guessed
 *   at, it is simply excluded.
 *
 * Ties (equal `cost.input`) keep whichever candidate was seen first.
 *
 * @param candidates - Pool to pick from, typically `listModels()`.
 * @param main - The model being routed away from.
 * @returns The cheapest eligible candidate by `cost.input`, or `undefined`
 *   when none qualify.
 */
export function suggestCheapModel(candidates: ModelSpec[], main: ModelSpec): ModelSpec | undefined {
  let best: ModelSpec | undefined;
  for (const candidate of candidates) {
    if (candidate.id === main.id) continue;
    if (candidate.provider !== main.provider) continue;
    if (!candidate.capabilities.tools) continue;
    if (candidate.cost === undefined) continue;
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
