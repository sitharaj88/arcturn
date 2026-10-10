import type { ModelSpec } from "@arcturn/types";

/**
 * Whether a spec's provider can run server-side compaction and tool-result
 * clearing (`LLMRequest.contextManagement`): the Anthropic Messages API and
 * endpoints that speak it. Bedrock and Vertex are excluded — their clients
 * have no beta surface here — and so is every other provider. A request that
 * asks anyway is refused before it is sent.
 */
export function supportsServerContextManagement(spec: ModelSpec): boolean {
  return spec.provider === "anthropic" || spec.provider === "anthropic-compatible";
}
