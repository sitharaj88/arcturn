/**
 * What core needs to know about a model to keep its outgoing history
 * append-only — read off the spec, never off a provider SDK (core depends on
 * `@arcturn/types` alone).
 *
 * The rules mirror the Anthropic adapter's, which reads the same model ids:
 * a declared capability always wins, and the generation in a Claude id is
 * the fallback for an ad-hoc spec that declares nothing.
 */

import type { ModelSpec } from "@arcturn/types";

/** Providers that speak Claude's Messages protocol, first-party or not. */
const ANTHROPIC_FAMILY = new Set(["anthropic", "anthropic-compatible", "bedrock", "vertex"]);

/** `claude-<family>-<major>[-<minor>]`, as the adapter reads it. */
const CLAUDE_VERSION_RE = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/i;

/** A Claude generation scaled by 100 (4.6 → 406), or `undefined`. */
function claudeGeneration(model: string): number | undefined {
  const match = CLAUDE_VERSION_RE.exec(model);
  if (!match) return undefined;
  return Number(match[2]) * 100 + Number(match[3] ?? 0);
}

/**
 * A Claude model on adaptive thinking (Claude 4.6 and later) reached through a
 * Messages-protocol provider.
 *
 * This is the class whose replayed thinking a history edit can invalidate —
 * on Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 a thinking block's
 * signature records the exact prefix that produced it — so it is where core
 * defaults to the append-only shapes: simple compaction, thinking stripped
 * from a kept tail, and thinking withheld after a deliberate prefix edit.
 * Older adaptive models gain nothing from those but lose little: dropping
 * thinking once, at a boundary, barely moves a run.
 */
export function isAdaptiveAnthropic(spec: ModelSpec): boolean {
  if (!ANTHROPIC_FAMILY.has(spec.provider)) return false;
  if (!spec.capabilities.thinking) return false;
  const declared = spec.capabilities.thinkingStyle;
  if (declared !== undefined) return declared === "adaptive";
  const generation = claudeGeneration(spec.model);
  return generation !== undefined && generation >= 406;
}

/**
 * The model has first-party Anthropic tool search: every tool can go out from
 * the first request with `defer_loading`, and the server's own search tool
 * finds them, so activation never changes the request's tool set. Claude 4.5
 * and later on the `anthropic` provider only — a gateway or a cloud endpoint
 * is not assumed to run the server tool.
 */
export function hasNativeToolSearch(spec: ModelSpec): boolean {
  if (spec.provider !== "anthropic") return false;
  const generation = claudeGeneration(spec.model);
  return generation !== undefined && generation >= 405;
}
