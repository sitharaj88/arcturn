/**
 * Anthropic Messages API adapter.
 *
 * Covers streaming, tool use, extended thinking (with signature round-trip),
 * prompt caching breakpoints and base64 image content.
 */

import type {
  Tool as AnthropicTool,
  ContentBlockParam,
  ImageBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  OutputConfig,
  RawMessageStreamEvent,
  TextBlockParam,
  ThinkingConfigParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  Message,
  ModelSpec,
  StopDetails,
  StopReason,
  StreamEvent,
  ThinkingLevel,
  ThinkingOffStyle,
  ThinkingStyle,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@arcturn/types";
import { getModel } from "../catalog.js";
import { AIErrorException } from "../errors.js";
import { parseToolArguments } from "../internal/json.js";
import {
  assembleStream,
  completeFromStream,
  deferredEvents,
  type ProviderStreamEvent,
} from "../internal/stream.js";

/** Prefix used to smuggle `redacted_thinking` payloads through `ThinkingContent`. */
export const REDACTED_THINKING_PREFIX = "redacted:";

/**
 * Thinking budgets in tokens for each portable thinking level, on the budget
 * generation (Claude 4.5 and earlier). Always clamped to leave room for an
 * answer, so `xhigh`/`max` simply ask for as much as the output cap allows.
 */
export const ANTHROPIC_THINKING_BUDGETS: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 4_096,
  medium: 16_384,
  high: 32_768,
  xhigh: 49_152,
  max: 65_536,
};

/** An `output_config.effort` value. */
export type AnthropicEffort = NonNullable<OutputConfig["effort"]>;

/** A thinking level above `"off"`. */
type OnLevel = Exclude<ThinkingLevel, "off">;

/**
 * `output_config.effort` level for each portable thinking level.
 *
 * Effort replaces `budget_tokens` as the depth control under adaptive
 * thinking, and the portable levels are the API's levels one for one. A model
 * that lacks one gets it clamped first — see {@link anthropicEffort}.
 *
 * https://platform.claude.com/docs/en/build-with-claude/effort
 */
export const ANTHROPIC_THINKING_EFFORT: Readonly<Record<OnLevel, AnthropicEffort>> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Every level above "off", lowest first: the order clamping walks. */
const ON_LEVELS: readonly OnLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** The 4.6 generation's effort set: `xhigh` arrived with Opus 4.7. */
const LEVELS_WITHOUT_XHIGH: readonly OnLevel[] = ["low", "medium", "high", "max"];

/**
 * A `thinking` value as sent on the wire.
 *
 * `between_tools` — Sonnet 5.5's "thinking off" — postdates the pinned SDK's
 * `ThinkingConfigParam` (see NOTES.md), so it is spelled out here.
 */
export type AnthropicThinkingParam = ThinkingConfigParam | { type: "between_tools" };

/** The streaming Messages payload, with {@link AnthropicThinkingParam} in place. */
export type AnthropicRequestParams = Omit<MessageCreateParamsStreaming, "thinking"> & {
  thinking?: AnthropicThinkingParam;
};

/** The beta header that gates `fallbacks: "default"`. */
export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Version at or above which Claude uses adaptive thinking, scaled by 100 so
 * comparisons stay integral (4.6 -> 406).
 *
 * Extended thinking (`type: "enabled"` with `budget_tokens`) is deprecated on
 * the 4.6 generation and *rejected with a 400* on 4.7 and later, which
 * includes Opus 5, Sonnet 5 and Fable 5. Below 4.6, adaptive is the shape that
 * 400s, so the branch has to go both ways.
 *
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#rejected-configurations
 */
const ADAPTIVE_THINKING_FROM = 406;

/**
 * Version at or above which the sampling parameters were removed.
 *
 * "Setting `temperature`, `top_p`, or `top_k` to any non-default value on
 * Claude Opus 4.7 or later models, including Claude Opus 5, returns a 400
 * error."
 *
 * https://platform.claude.com/docs/en/about-claude/models/migration-guide
 */
const SAMPLING_REMOVED_FROM = 407;

/**
 * Version at or above which adaptive thinking streams empty text unless the
 * request asks for `display: "summarized"`. The field is new on Opus 4.7; on
 * 4.6 summarized was the default and the field is not sent.
 *
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 */
const THINKING_DISPLAY_FROM = 407;

/**
 * Claude family versions are written `claude-<family>-<major>[-<minor>]`, with
 * an optional dated snapshot, profile prefix or Vertex `@` suffix around it —
 * `claude-opus-5`, `claude-sonnet-4-6`,
 * `us.anthropic.claude-opus-4-5-20251101-v1:0`, `claude-opus-4-5@20251101`.
 *
 * The minor group is a single digit that must not be followed by another, so a
 * dated id like `claude-sonnet-4-20250514` reads as 4.0 rather than 4.20.
 * Pre-4 ids use the older `claude-<major>-<minor>-<family>` layout, which this
 * deliberately does not match: everything there predates adaptive thinking.
 */
const CLAUDE_VERSION_RE = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/i;

/**
 * Extract a Claude generation from a model id, scaled by 100 (4.6 -> 406).
 *
 * Returns `undefined` for ids that name no Claude generation — non-Claude
 * models on Bedrock, pre-4 Claude ids, custom gateway names — which callers
 * read as "assume the legacy shape".
 */
export function claudeGeneration(model: string): number | undefined {
  const match = CLAUDE_VERSION_RE.exec(model);
  if (!match) return undefined;
  const major = Number(match[2]);
  if (!Number.isFinite(major)) return undefined;
  return major * 100 + Number(match[3] ?? 0);
}

/** The Claude family named in a model id, lower-cased, or `undefined`. */
function claudeFamily(model: string): string | undefined {
  return CLAUDE_VERSION_RE.exec(model)?.[1]?.toLowerCase();
}

/**
 * Decide which thinking request shape a spec accepts.
 *
 * An explicit `capabilities.thinkingStyle` always wins, so a host can pin the
 * shape for a proxy or a model this does not recognise; otherwise the
 * generation in the model id decides. Unknown ids fall back to `"budget"`,
 * which is what every model predating adaptive thinking accepts.
 */
export function anthropicThinkingStyle(spec: ModelSpec): ThinkingStyle {
  const declared = spec.capabilities.thinkingStyle;
  if (declared) return declared;
  const generation = claudeGeneration(spec.model);
  return generation !== undefined && generation >= ADAPTIVE_THINKING_FROM ? "adaptive" : "budget";
}

/**
 * Decide how thinking level `"off"` is spelled for a spec.
 *
 * An explicit `capabilities.thinkingOff` wins; otherwise the family and
 * generation in the model id decide, so a Bedrock or proxy id behaves like the
 * catalog entry it names. Unknown ids get `"omit"`, the pre-5 behaviour.
 */
export function anthropicThinkingOff(spec: ModelSpec): ThinkingOffStyle {
  const declared = spec.capabilities.thinkingOff;
  if (declared) return declared;
  const generation = claudeGeneration(spec.model);
  if (generation === undefined || generation < 500) return "omit";
  switch (claudeFamily(spec.model)) {
    case "fable":
    case "mythos":
    case "opus":
      // Fable and Opus 5.5 reject `disabled` outright; Opus 5 accepts it only
      // at effort high or below and then can write tool calls into its text.
      return "lowEffort";
    case "sonnet":
      return generation >= 505 ? "betweenTools" : "disabled";
    default:
      return "disabled";
  }
}

/** The effort levels an adaptive spec accepts, lowest first. */
function effortLevels(spec: ModelSpec): readonly OnLevel[] {
  const declared = spec.capabilities.thinkingLevels;
  if (declared && declared.length > 0) return declared;
  const generation = claudeGeneration(spec.model);
  return generation !== undefined && generation < THINKING_DISPLAY_FROM
    ? LEVELS_WITHOUT_XHIGH
    : ON_LEVELS;
}

/**
 * The effort to send for `level` on `spec`: the level itself when the model
 * has it, else the nearest level below it, else the lowest it has.
 */
export function anthropicEffort(spec: ModelSpec, level: OnLevel): AnthropicEffort {
  const accepted = effortLevels(spec);
  const wanted = ON_LEVELS.indexOf(level);
  for (let index = wanted; index >= 0; index--) {
    const candidate = ON_LEVELS[index];
    if (candidate !== undefined && accepted.includes(candidate)) {
      return ANTHROPIC_THINKING_EFFORT[candidate];
    }
  }
  return ANTHROPIC_THINKING_EFFORT[accepted[0] ?? "low"];
}

/** True when an adaptive request must ask for summarized thinking to see any. */
function wantsSummarizedDisplay(spec: ModelSpec): boolean {
  const generation = claudeGeneration(spec.model);
  return generation !== undefined && generation >= THINKING_DISPLAY_FROM;
}

/** True when the model rejects `temperature` / `top_p` / `top_k` outright. */
function rejectsSampling(spec: ModelSpec): boolean {
  const generation = claudeGeneration(spec.model);
  if (generation !== undefined) return generation >= SAMPLING_REMOVED_FROM;
  // No recognisable generation: only an explicitly adaptive spec is new enough
  // for the removal to apply.
  return spec.capabilities.thinkingStyle === "adaptive";
}

/** Loaded on first use: importing the SDK eagerly costs hundreds of ms of CLI startup. */
let sdkModule: Promise<typeof import("@anthropic-ai/sdk")> | undefined;
function loadSdk(): Promise<typeof import("@anthropic-ai/sdk")> {
  sdkModule ??= import("@anthropic-ai/sdk");
  return sdkModule;
}

const MIN_THINKING_BUDGET = 1_024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Minimal structural view of the Anthropic SDK, so tests can inject fakes. */
export interface AnthropicClientLike {
  messages: {
    create(
      params: AnthropicRequestParams,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RawMessageStreamEvent>>;
  };
  /**
   * The beta Messages surface, used only for opted-in refusal fallbacks. Its
   * stream is a superset of the GA one (`fallback` content blocks,
   * `usage.iterations`), read defensively. Bedrock and Vertex clients omit it.
   */
  beta?: {
    messages: {
      create(
        params: AnthropicRequestParams & { betas: string[]; fallbacks: "default" },
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<RawMessageStreamEvent>>;
    };
  };
}

/** Construction options for {@link createAnthropicProvider}. */
export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Pre-built client; primarily an injection seam for tests. */
  client?: AnthropicClientLike;
  /**
   * Opt in to server-side refusal fallbacks. With `"default"`, a request to a
   * model that offers them (`capabilities.refusalFallback`) goes through the
   * beta Messages surface with `fallbacks: "default"`: when a safety
   * classifier declines, the API re-runs the request on the model Anthropic
   * recommends for that refusal category, in the same call. The turn is then
   * stamped with, and billed at, the model that answered. Claude API only —
   * Bedrock and Vertex have no server-side fallback. Off by default.
   */
  fallbacks?: "default";
}

/** Per-stream options for {@link anthropicEventStream}. */
export interface AnthropicStreamOptions {
  /** See {@link AnthropicProviderOptions.fallbacks}. */
  fallbacks?: "default";
}

function normalizeMediaType(mimeType: string): string | undefined {
  const lower = mimeType.toLowerCase().trim();
  const canonical = lower === "image/jpg" ? "image/jpeg" : lower;
  return SUPPORTED_IMAGE_TYPES.has(canonical) ? canonical : undefined;
}

function imageBlock(data: string, mimeType: string): ImageBlockParam | undefined {
  const mediaType = normalizeMediaType(mimeType);
  if (!mediaType) return undefined;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data,
    },
  };
}

function userBlocks(message: UserMessage): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.trim() !== "") blocks.push({ type: "text", text: part.text });
    } else {
      const image = imageBlock(part.data, part.mimeType);
      if (image) blocks.push(image);
    }
  }
  return blocks;
}

function assistantBlocks(message: AssistantMessage): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === "thinking") {
      const signature = part.signature ?? "";
      if (signature.startsWith(REDACTED_THINKING_PREFIX)) {
        blocks.push({
          type: "redacted_thinking",
          data: signature.slice(REDACTED_THINKING_PREFIX.length),
        });
      } else if (signature !== "") {
        blocks.push({ type: "thinking", thinking: part.thinking, signature });
      }
      // Unsigned thinking is dropped: the API rejects it (see NOTES.md).
    } else if (part.type === "text") {
      if (part.text.trim() !== "") blocks.push({ type: "text", text: part.text });
    } else {
      blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments });
    }
  }
  return blocks;
}

function toolResultBlock(message: ToolResultMessage): ToolResultBlockParam {
  const content: Array<TextBlockParam | ImageBlockParam> = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text !== "") content.push({ type: "text", text: part.text });
    } else {
      const image = imageBlock(part.data, part.mimeType);
      if (image) content.push(image);
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "(no tool output)" });
  return {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    content,
    is_error: message.isError,
  };
}

function appendBlocks(
  target: MessageParam[],
  role: "user" | "assistant",
  blocks: ContentBlockParam[],
  toolResultsFirst = false,
): void {
  if (blocks.length === 0) return;
  const last = target[target.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    const existing = last.content as ContentBlockParam[];
    if (toolResultsFirst) {
      // Anthropic requires every tool_result block to precede other content.
      let insertAt = 0;
      while (insertAt < existing.length && existing[insertAt]?.type === "tool_result") insertAt++;
      existing.splice(insertAt, 0, ...blocks);
    } else {
      existing.push(...blocks);
    }
    return;
  }
  target.push({ role, content: blocks });
}

/**
 * Convert Arcturn messages to Anthropic `MessageParam`s.
 *
 * Consecutive same-role turns are merged, tool results are coalesced into a
 * single user turn, and blocks the API rejects (empty text, unsigned thinking,
 * unsupported image types) are dropped.
 */
export function toAnthropicMessages(messages: Message[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      appendBlocks(out, "user", userBlocks(message));
    } else if (message.role === "assistant") {
      // A declined turn's partial output is discarded, not replayed: it is an
      // abandoned attempt, and its thinking belongs to a request that was
      // refused. The loop never leaves tool calls in one, so nothing dangles.
      if (message.stopReason === "refusal") continue;
      appendBlocks(out, "assistant", assistantBlocks(message));
    } else {
      appendBlocks(out, "user", [toolResultBlock(message)], true);
    }
  }
  return out;
}

/** Attach an ephemeral cache breakpoint to the final block of the last user turn. */
function applyConversationCacheBreakpoint(messages: MessageParam[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const blocks = message.content as ContentBlockParam[];
    const last = blocks[blocks.length - 1];
    if (!last) return;
    if (last.type === "text" || last.type === "image" || last.type === "tool_result") {
      (last as { cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" };
    }
    return;
  }
}

/** The `thinking` value and the effort that ride on one request. Either may be absent. */
export interface AnthropicThinkingParams {
  thinking?: AnthropicThinkingParam;
  effort?: AnthropicEffort;
}

/**
 * Build the thinking configuration for a request — the one place the
 * per-model rules live, shared by the Messages path and Bedrock's Converse.
 *
 * Two mutually exclusive "on" shapes, chosen by {@link anthropicThinkingStyle}:
 *
 * - **adaptive** (Claude 4.6+) — `thinking: {type: "adaptive"}` with depth
 *   steered by `output_config: {effort}`, the effort clamped to the levels the
 *   model has. From Opus 4.7 on, thinking text streams empty by default, so
 *   the request asks for `display: "summarized"` — Arcturn renders it.
 * - **budget** (Claude 4.5 and earlier) — `thinking: {type: "enabled",
 *   budget_tokens: N}`, clamped to leave room for an answer. `adaptive` 400s
 *   on these models.
 *
 * `off` follows {@link anthropicThinkingOff}: omitted on 4.x, `disabled` where
 * omitting would think, `between_tools` on Sonnet 5.5, and — where thinking
 * cannot be turned off at all (Fable 5/5.1, Opus 5.5) — no `thinking` key and
 * the lowest effort. Opus 5.5 therefore always carries an explicit effort,
 * which matters because its default is `medium`, not `high`.
 *
 * @returns `undefined` when nothing needs sending.
 *
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking#migrating-to-adaptive-thinking
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#rejected-configurations
 */
export function anthropicThinkingParams(
  spec: ModelSpec,
  level: ThinkingLevel,
  maxTokens: number,
): AnthropicThinkingParams | undefined {
  if (!spec.capabilities.thinking) return undefined;

  if (level === "off") {
    switch (anthropicThinkingOff(spec)) {
      case "omit":
        return undefined;
      case "disabled":
        return { thinking: { type: "disabled" } };
      case "betweenTools":
        // Takes no other field, and only at effort high or below — so no
        // effort rides along and the model's default (high) applies.
        return { thinking: { type: "between_tools" } };
      case "lowEffort":
        return { effort: anthropicEffort(spec, "low") };
    }
  }

  if (anthropicThinkingStyle(spec) === "adaptive") {
    return {
      thinking: wantsSummarizedDisplay(spec)
        ? { type: "adaptive", display: "summarized" }
        : { type: "adaptive" },
      effort: anthropicEffort(spec, level),
    };
  }

  const requested = ANTHROPIC_THINKING_BUDGETS[level];
  const budget = Math.min(requested, maxTokens - MIN_THINKING_BUDGET);
  if (budget < MIN_THINKING_BUDGET) return undefined;
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

/** Build the wire payload for a streaming Messages request. */
export function buildAnthropicRequest(request: LLMRequest): AnthropicRequestParams {
  const spec = request.model;
  const caching = spec.capabilities.caching;
  const maxTokens = Math.min(request.maxOutputTokens ?? spec.maxOutputTokens, spec.maxOutputTokens);
  const messages = toAnthropicMessages(request.messages);
  if (caching) applyConversationCacheBreakpoint(messages);

  const params: AnthropicRequestParams = {
    model: spec.model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };

  if (request.system !== undefined && request.system !== "") {
    const block: TextBlockParam = { type: "text", text: request.system };
    if (caching) block.cache_control = { type: "ephemeral" };
    params.system = [block];
  }

  if (request.tools && request.tools.length > 0) {
    const tools: AnthropicTool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.parameters, type: "object" } as AnthropicTool["input_schema"],
      // Fine-grained tool streaming: deliver each argument as it is generated
      // instead of buffering the whole JSON server-side. A per-tool field on
      // every model, with no beta header; the accumulated string may be
      // partial or invalid JSON, which parseToolArguments already tolerates.
      // https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
      eager_input_streaming: true,
    }));
    const last = tools[tools.length - 1];
    // A breakpoint on the final tool caches the whole tool prefix.
    if (caching && last) last.cache_control = { type: "ephemeral" };
    params.tools = tools;
  }

  const thinking = anthropicThinkingParams(spec, request.thinking ?? "off", maxTokens);
  if (thinking?.thinking) params.thinking = thinking.thinking;
  if (thinking?.effort) params.output_config = { effort: thinking.effort };
  if (
    thinking?.thinking === undefined &&
    request.temperature !== undefined &&
    !rejectsSampling(spec)
  ) {
    // Thinking forbids an explicit temperature, and Claude 4.7+ rejects the
    // sampling parameters outright whether or not thinking is on.
    params.temperature = request.temperature;
  }

  return Object.assign(params, request.providerOptions ?? {});
}

/** Map an Anthropic `stop_reason` onto the portable {@link StopReason}. */
export function mapAnthropicStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "maxTokens";
    case "tool_use":
      return "toolCalls";
    case "refusal":
      return "refusal";
    default:
      return "endTurn";
  }
}

interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /**
   * Read-only decomposition of `output_tokens`. When streaming, the breakdown
   * only arrives on the final `message_delta`.
   *
   * https://platform.claude.com/docs/en/build-with-claude/extended-thinking#budget-rules-and-tuning
   */
  output_tokens_details?: { thinking_tokens?: number | null } | null;
  /**
   * Per-attempt breakdown (beta). With refusal fallbacks, the entry of type
   * `fallback_message` names the model that served the response — the only
   * signal on a sticky-routed turn, which carries no `fallback` block.
   */
  iterations?: ReadonlyArray<{ type?: string; model?: string }> | null;
}

/** The `fallback` content block the beta surface emits at each switch point. */
interface FallbackBlockLike {
  type: "fallback";
  to?: { model?: string };
}

/** The `stop_details` object a refusal carries. */
interface StopDetailsLike {
  type?: string;
  category?: string | null;
  explanation?: string | null;
}

/** Portable {@link StopDetails} from the wire object, or `undefined`. */
function toStopDetails(raw: StopDetailsLike | null | undefined): StopDetails | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const details: StopDetails = {
    category: typeof raw.category === "string" ? raw.category : null,
  };
  if (typeof raw.explanation === "string" && raw.explanation !== "") {
    details.explanation = raw.explanation;
  }
  return details;
}

/** The model a fallback iteration says served the response, if any. */
function servedByIteration(usage: AnthropicUsageLike | undefined): string | undefined {
  const entries = usage?.iterations;
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "fallback_message" && typeof entry.model === "string") return entry.model;
  }
  return undefined;
}

/**
 * The spec to stamp on, and price, a message the API says `model` answered.
 *
 * Looked up under the requested spec's own provider first, so a proxy's
 * registrations win, then by bare wire name. A model the catalog has never
 * heard of keeps the requested spec's shape but loses its price: unknown cost
 * reads as unknown, never as a borrowed rate or $0.
 */
function answeringSpec(requested: ModelSpec, model: string): ModelSpec {
  if (model === requested.model) return requested;
  const known = getModel(`${requested.provider}/${model}`) ?? getModel(model);
  if (known) return known;
  const { cost: _unpriced, ...rest } = requested;
  return { ...rest, id: `${requested.provider}/${model}`, model, displayName: model };
}

function mergeUsage(current: Usage, incoming: AnthropicUsageLike | undefined): Usage {
  if (!incoming) return current;
  // Only overwrite fields the provider actually reported; proxies omit some of
  // them in message_delta and would otherwise zero out message_start values.
  const merged: Usage = {
    inputTokens: incoming.input_tokens ?? current.inputTokens,
    outputTokens: incoming.output_tokens ?? current.outputTokens,
    cacheReadTokens: incoming.cache_read_input_tokens ?? current.cacheReadTokens,
    cacheWriteTokens: incoming.cache_creation_input_tokens ?? current.cacheWriteTokens,
  };
  // Stays absent until the provider reports it, so consumers can tell "no
  // thinking" apart from "no breakdown". A subset of outputTokens, never added
  // to the billed total.
  const thinkingTokens = incoming.output_tokens_details?.thinking_tokens ?? current.thinkingTokens;
  if (thinkingTokens !== undefined && thinkingTokens !== null) {
    merged.thinkingTokens = thinkingTokens;
  }
  return merged;
}

interface ToolState {
  id: string;
  name: string;
  raw: string;
}

/**
 * Translate raw Anthropic SSE events into provider stream events.
 *
 * @param options - `fallbacks: "default"` sends the request through the beta
 *   surface with server-side refusal fallbacks, when the client has one and
 *   the model offers them.
 */
export async function* anthropicEventStream(
  client: AnthropicClientLike,
  request: LLMRequest,
  options: AnthropicStreamOptions = {},
): AsyncIterable<ProviderStreamEvent> {
  const params = buildAnthropicRequest(request);
  const requestOptions = request.signal ? { signal: request.signal } : undefined;
  const beta =
    options.fallbacks === "default" && request.model.capabilities.refusalFallback === true
      ? client.beta
      : undefined;
  const stream = beta
    ? await beta.messages.create(
        { ...params, betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: "default" },
        requestOptions,
      )
    : await client.messages.create(params, requestOptions);

  const tools = new Map<number, ToolState>();
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let stopReason: StopReason = "endTurn";
  let errorMessage: string | undefined;
  let stopDetails: StopDetails | undefined;
  let sawStop = false;
  // The model that produced the content, once a fallback has switched it.
  let servedBy: string | undefined;
  function* serve(model: string | undefined): Generator<ProviderStreamEvent> {
    if (beta === undefined || model === undefined || model === servedBy) return;
    servedBy = model;
    yield { type: "servedBy", spec: answeringSpec(request.model, model) };
  }

  for await (const event of stream) {
    switch (event.type) {
      case "message_start": {
        usage = mergeUsage(usage, event.message.usage as AnthropicUsageLike);
        yield { type: "usage", usage };
        break;
      }
      case "content_block_start": {
        const index = event.index;
        const block = event.content_block;
        if ((block as { type: string }).type === "fallback") {
          // A switch point: the model before it declined, the one after it
          // answers. Its reasoning and unfinished calls are not part of this
          // message, and the price is the new model's.
          yield { type: "fallbackBoundary" };
          yield* serve((block as unknown as FallbackBlockLike).to?.model);
          break;
        }
        if (block.type === "text") {
          yield { type: "textStart", blockIndex: index };
          if (block.text) yield { type: "textDelta", blockIndex: index, delta: block.text };
        } else if (block.type === "thinking") {
          yield { type: "thinkingStart", blockIndex: index };
          if (block.thinking) {
            yield { type: "thinkingDelta", blockIndex: index, delta: block.thinking };
          }
          if (block.signature) {
            yield { type: "thinkingSignature", blockIndex: index, signature: block.signature };
          }
        } else if (block.type === "redacted_thinking") {
          yield { type: "thinkingStart", blockIndex: index };
          yield {
            type: "thinkingSignature",
            blockIndex: index,
            signature: `${REDACTED_THINKING_PREFIX}${block.data}`,
            replace: true,
          };
        } else if (block.type === "tool_use") {
          tools.set(index, { id: block.id, name: block.name, raw: "" });
          yield { type: "toolCallStart", blockIndex: index, id: block.id, name: block.name };
        }
        break;
      }
      case "content_block_delta": {
        const index = event.index;
        const delta = event.delta;
        if (delta.type === "text_delta") {
          yield { type: "textDelta", blockIndex: index, delta: delta.text };
        } else if (delta.type === "thinking_delta") {
          yield { type: "thinkingDelta", blockIndex: index, delta: delta.thinking };
        } else if (delta.type === "signature_delta") {
          yield { type: "thinkingSignature", blockIndex: index, signature: delta.signature };
        } else if (delta.type === "input_json_delta") {
          const state = tools.get(index);
          if (state) state.raw += delta.partial_json;
          yield { type: "toolCallDelta", blockIndex: index, argumentsDelta: delta.partial_json };
        }
        break;
      }
      case "content_block_stop": {
        const index = event.index;
        const state = tools.get(index);
        if (state) {
          yield {
            type: "toolCallEnd",
            blockIndex: index,
            id: state.id,
            name: state.name,
            arguments: parseToolArguments(state.raw),
          };
          tools.delete(index);
        }
        yield { type: "blockEnd", blockIndex: index };
        break;
      }
      case "message_delta": {
        yield* serve(servedByIteration(event.usage as AnthropicUsageLike));
        usage = mergeUsage(usage, event.usage as AnthropicUsageLike);
        stopReason = mapAnthropicStopReason(event.delta.stop_reason);
        if (stopReason === "refusal") {
          stopDetails = toStopDetails(event.delta.stop_details as StopDetailsLike | null);
        }
        yield { type: "usage", usage };
        break;
      }
      case "message_stop":
        sawStop = true;
        break;
    }
  }

  if (!sawStop) {
    // A truncated SSE stream is a transport failure, so mark it retryable.
    throw new AIErrorException({
      kind: "network",
      message: "Anthropic stream ended before message_stop",
    });
  }
  yield {
    type: "stop",
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(stopDetails === undefined ? {} : { stopDetails }),
  };
}

/** Create an {@link LLMClient} backed by the Anthropic Messages API. */
export function createAnthropicProvider(options: AnthropicProviderOptions = {}): LLMClient {
  let clientPromise: Promise<AnthropicClientLike> | undefined;
  const getClient = (): Promise<AnthropicClientLike> => {
    clientPromise ??= options.client
      ? Promise.resolve(options.client)
      : loadSdk().then(
          ({ default: AnthropicSDK }) =>
            new AnthropicSDK({
              apiKey: options.apiKey ?? null,
              ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
              ...(options.headers ? { defaultHeaders: options.headers } : {}),
              // Retries are handled by streamWithRetry, which honours AbortSignal.
              maxRetries: 0,
            }) as unknown as AnthropicClientLike,
        );
    return clientPromise;
  };

  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return assembleStream(request.model, request.signal, () =>
        deferredEvents(async () =>
          anthropicEventStream(
            await getClient(),
            request,
            options.fallbacks === undefined ? {} : { fallbacks: options.fallbacks },
          ),
        ),
      );
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };
}
