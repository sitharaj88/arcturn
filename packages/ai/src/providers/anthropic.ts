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
  StopReason,
  StreamEvent,
  ThinkingLevel,
  ThinkingStyle,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@arcturn/types";
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

/** Thinking budgets in tokens for each portable thinking level. */
export const ANTHROPIC_THINKING_BUDGETS: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 4_096,
  medium: 16_384,
  high: 32_768,
};

/**
 * `output_config.effort` level for each portable thinking level.
 *
 * Effort replaces `budget_tokens` as the depth control under adaptive
 * thinking. The API's own default is `high`, and the level set is
 * `low | medium | high | xhigh | max`; the portable levels map onto the first
 * three, leaving `xhigh`/`max` reachable through `providerOptions`.
 *
 * https://platform.claude.com/docs/en/build-with-claude/effort
 */
export const ANTHROPIC_THINKING_EFFORT: Readonly<
  Record<Exclude<ThinkingLevel, "off">, NonNullable<OutputConfig["effort"]>>
> = {
  low: "low",
  medium: "medium",
  high: "high",
};

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
const CLAUDE_VERSION_RE = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/i;

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
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return undefined;
  return major * 100 + Number(match[2] ?? 0);
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
      params: MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RawMessageStreamEvent>>;
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

/** The `thinking` block plus, under adaptive thinking, its effort control. */
interface ThinkingParams {
  thinking: ThinkingConfigParam;
  outputConfig?: OutputConfig;
}

/**
 * Build the thinking configuration for a request.
 *
 * Two mutually exclusive shapes, chosen by {@link anthropicThinkingStyle}:
 *
 * - **adaptive** (Claude 4.6+, incl. Opus 5 / Sonnet 5 / Fable 5) —
 *   `thinking: {type: "adaptive"}` with depth steered by
 *   `output_config: {effort}`. `budget_tokens` is deprecated on 4.6 and 400s
 *   on 4.7+.
 * - **budget** (Claude 4.5 and earlier) — `thinking: {type: "enabled",
 *   budget_tokens: N}`, clamped to leave room for an answer. `adaptive` 400s
 *   on these models.
 *
 * `off` returns `undefined` in both cases: omitting `thinking` is accepted
 * everywhere, whereas `{type: "disabled"}` is rejected on Fable 5 and (above
 * effort `high`) on Opus 5.
 *
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking#migrating-to-adaptive-thinking
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#rejected-configurations
 */
function thinkingConfig(request: LLMRequest, maxTokens: number): ThinkingParams | undefined {
  const level = request.thinking ?? "off";
  if (!request.model.capabilities.thinking || level === "off") return undefined;

  if (anthropicThinkingStyle(request.model) === "adaptive") {
    return {
      thinking: { type: "adaptive" },
      outputConfig: { effort: ANTHROPIC_THINKING_EFFORT[level] },
    };
  }

  const requested = ANTHROPIC_THINKING_BUDGETS[level];
  const budget = Math.min(requested, maxTokens - MIN_THINKING_BUDGET);
  if (budget < MIN_THINKING_BUDGET) return undefined;
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

/** Build the wire payload for a streaming Messages request. */
export function buildAnthropicRequest(request: LLMRequest): MessageCreateParamsStreaming {
  const spec = request.model;
  const caching = spec.capabilities.caching;
  const maxTokens = Math.min(request.maxOutputTokens ?? spec.maxOutputTokens, spec.maxOutputTokens);
  const messages = toAnthropicMessages(request.messages);
  if (caching) applyConversationCacheBreakpoint(messages);

  const params: MessageCreateParamsStreaming = {
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

  const thinking = thinkingConfig(request, maxTokens);
  if (thinking) {
    params.thinking = thinking.thinking;
    if (thinking.outputConfig) params.output_config = thinking.outputConfig;
  } else if (request.temperature !== undefined && !rejectsSampling(spec)) {
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
      return "error";
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

/** Translate raw Anthropic SSE events into provider stream events. */
export async function* anthropicEventStream(
  client: AnthropicClientLike,
  request: LLMRequest,
): AsyncIterable<ProviderStreamEvent> {
  const params = buildAnthropicRequest(request);
  const options = request.signal ? { signal: request.signal } : undefined;
  const stream = await client.messages.create(params, options);

  const tools = new Map<number, ToolState>();
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let stopReason: StopReason = "endTurn";
  let errorMessage: string | undefined;
  let sawStop = false;

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
        usage = mergeUsage(usage, event.usage as AnthropicUsageLike);
        const reason = event.delta.stop_reason;
        stopReason = mapAnthropicStopReason(reason);
        if (stopReason === "error") {
          errorMessage =
            event.delta.stop_details?.type === "refusal"
              ? "The model refused to respond"
              : `Provider stopped with: ${reason}`;
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
  yield errorMessage === undefined
    ? { type: "stop", stopReason }
    : { type: "stop", stopReason, errorMessage };
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
        deferredEvents(async () => anthropicEventStream(await getClient(), request)),
      );
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };
}
