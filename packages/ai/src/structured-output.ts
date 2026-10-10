/**
 * What a model can be asked to guarantee about its output: a reply shaped by a
 * JSON schema (`LLMRequest.responseFormat`) and pacing against a task budget
 * (`LLMRequest.taskBudget`) — answered in one place so every adapter and every
 * host asks the question the same way. The schema grammar itself lives in
 * `strict-schema.ts`.
 */

import type { ModelSpec } from "@arcturn/types";
import { anthropicStructuredOutputModel, anthropicTaskBudgetModel } from "./providers/anthropic.js";
import { bedrockModelFamily } from "./providers/bedrock.js";
import { geminiVersion } from "./providers/google.js";
import { OPENAI_RESPONSES_PROVIDER } from "./providers/openai-responses.js";
import { vertexFamily } from "./providers/vertex.js";

/** The smallest `task_budget.total` the API accepts. */
export const TASK_BUDGET_MIN_TOKENS = 20_000;

/**
 * Whether `spec` can constrain its reply to a JSON schema.
 *
 * An explicit `capabilities.structuredOutput` always wins. Otherwise: Claude
 * 4.5 and later (and Opus 4.1) wherever Claude is served through the Messages
 * protocol — first-party, Bedrock's Claude path, Vertex; every OpenAI and Azure
 * model; Gemini 2.5 and later. A compatible endpoint (`openai-compatible`,
 * `anthropic-compatible`) and Bedrock Converse say no unless declared: many
 * such servers 400 on the field, and a contract step that loses its native
 * path still has the fenced one.
 */
export function supportsStructuredOutput(spec: ModelSpec): boolean {
  const declared = spec.capabilities.structuredOutput;
  if (declared !== undefined) return declared;
  switch (spec.provider) {
    case "anthropic":
      return anthropicStructuredOutputModel(spec.model);
    case "bedrock":
      return (
        bedrockModelFamily(spec.model) === "anthropic" && anthropicStructuredOutputModel(spec.model)
      );
    case "vertex":
      return vertexFamily(spec.model) === "anthropic"
        ? anthropicStructuredOutputModel(spec.model)
        : (geminiVersion(spec.model) ?? 0) >= 25;
    case "openai":
    case "azure":
    case OPENAI_RESPONSES_PROVIDER:
      return true;
    case "google":
      return (geminiVersion(spec.model) ?? 0) >= 25;
    default:
      return false;
  }
}

/**
 * Whether `spec` paces itself against `LLMRequest.taskBudget`.
 *
 * Task budgets are a first-party beta (Bedrock and Vertex do not document
 * them), on the models {@link anthropicTaskBudgetModel} names — not Sonnet 5.
 * An explicit `capabilities.taskBudget` wins.
 */
export function supportsTaskBudget(spec: ModelSpec): boolean {
  const declared = spec.capabilities.taskBudget;
  if (declared !== undefined) return declared;
  return spec.provider === "anthropic" && anthropicTaskBudgetModel(spec.model);
}
