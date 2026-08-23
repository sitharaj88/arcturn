/**
 * OpenAI Responses API adapter.
 *
 * The Responses API is OpenAI's current surface: it models a turn as a list of
 * typed *items* (messages, `function_call`, `function_call_output`,
 * `reasoning`) rather than the Chat Completions message array, and it streams
 * server-sent events instead of choice deltas. Registering under its own
 * provider id (`"openai-responses"`) keeps the Chat Completions adapter in
 * `openai.ts` untouched, so a host can move model by model.
 *
 * Everything that is genuinely shared with Chat Completions is imported rather
 * than re-implemented: {@link OPENAI_REASONING_EFFORT} for the thinking-level
 * mapping, `supportsTemperature` for the reasoning-model temperature rule,
 * `parseToolArguments` for malformed tool JSON, and `assembleStream` for the
 * public streaming contract.
 */

import type {
  AIError,
  AssistantMessage,
  LLMClient,
  LLMRequest,
  Message,
  ModelCapabilities,
  ModelSpec,
  StopReason,
  StreamEvent,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@arcturn/types";
import type {
  FunctionTool,
  Response as OpenAIResponse,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputMessageContentList,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { Reasoning } from "openai/resources/shared";
import { AIErrorException, createAIError, toAIError } from "../errors.js";
import { parseToolArguments } from "../internal/json.js";
import {
  assembleStream,
  completeFromStream,
  deferredEvents,
  type ProviderStreamEvent,
} from "../internal/stream.js";
import { OPENAI_REASONING_EFFORT, supportsTemperature } from "./openai.js";
import {
  type ProviderFactoryContext,
  type ProviderPrecheckFailure,
  registerProviderFactory,
} from "./registry.js";

/** Cached SDK module promise; see {@link loadOpenAISdk}. */
let openaiSdk: Promise<typeof import("openai")> | undefined;

/** Loads the SDK on first use so importing this module stays cheap at CLI startup. */
function loadOpenAISdk(): Promise<typeof import("openai")> {
  openaiSdk ??= import("openai");
  return openaiSdk;
}

/** Provider id this adapter registers under. */
export const OPENAI_RESPONSES_PROVIDER = "openai-responses";

/** Environment variable consulted for the API key. */
export const OPENAI_RESPONSES_API_KEY_ENV = "OPENAI_API_KEY";

/** Minimal structural view of the SDK's `responses` resource, for test fakes. */
export interface OpenAIResponsesClientLike {
  responses: {
    create(
      params: ResponseCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<ResponseStreamEvent>>;
  };
}

/** Knobs that shape the wire payload. */
export interface OpenAIResponsesRequestOptions {
  /**
   * Persist the response server-side. Defaults to `false`: Arcturn replays the
   * whole conversation every turn, so server-side state buys nothing and
   * costs retention.
   */
  store?: boolean;
  /**
   * Reasoning summary verbosity. Defaults to `"auto"`; pass `null` to omit the
   * field for deployments whose org is not verified for summaries.
   */
  reasoningSummary?: "auto" | "concise" | "detailed" | null;
}

/** Construction options for {@link createOpenAIResponsesProvider}. */
export interface OpenAIResponsesProviderOptions extends OpenAIResponsesRequestOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Pre-built client; primarily an injection seam for tests. */
  client?: OpenAIResponsesClientLike;
}

/* -------------------------------------------------------------------------- */
/* Reasoning continuity                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How reasoning items round-trip through `ThinkingContent.signature`.
 *
 * A reasoning model returns `reasoning` items carrying an id (`rs_...`) and,
 * when `include: ["reasoning.encrypted_content"]` was requested, an opaque
 * `encrypted_content` blob. Echoing those items back on the next turn is what
 * preserves the model's chain of thought across tool calls. Arcturn's frozen
 * `ThinkingContent` has exactly one free-form slot for provider state —
 * `signature` — so both fields are packed into it as compact JSON:
 *
 * ```json
 * {"id":"rs_abc","enc":"gAAAAA..."}
 * ```
 *
 * Rules of the round-trip:
 * - The signature is emitted once per reasoning item, at
 *   `response.output_item.done` (the `added` event's `encrypted_content` may be
 *   truncated), with `replace: true` so it overwrites rather than appends.
 * - A reasoning item with no streamed summary text still produces a thinking
 *   block with empty text and a signature; `MessageAssembler` keeps such a
 *   block precisely because the signature is non-empty, which is what makes
 *   continuity work for models that stream no summary at all.
 * - On the way back in, each signed thinking block becomes a `reasoning` input
 *   item `{type:"reasoning", id, summary: [], encrypted_content?}`. Summary
 *   text is deliberately **not** replayed: the API only needs the item
 *   identity, and re-sending text as `summary_text` risks a mismatch with the
 *   stored item.
 * - Reasoning items are only replayed when the assistant turn also contains a
 *   text or tool-call block after them. The API rejects a reasoning item that
 *   is not followed by the item it produced, and it rejects reasoning items
 *   entirely for non-reasoning models, so replay is additionally gated on
 *   `spec.capabilities.thinking`.
 * - Unsigned thinking blocks (from another provider, or replayed transcripts)
 *   are dropped, and a signature that is not valid JSON is treated as a bare
 *   item id, so hand-written transcripts still work.
 */
export interface ReasoningSignature {
  /** The `rs_...` id of the reasoning item. */
  id: string;
  /** Opaque `encrypted_content`, when the API returned one. */
  encryptedContent?: string;
}

/** Pack a reasoning item's identity into a `ThinkingContent.signature`. */
export function encodeReasoningSignature(signature: ReasoningSignature): string {
  if (signature.id === "" && !signature.encryptedContent) return "";
  return JSON.stringify(
    signature.encryptedContent
      ? { id: signature.id, enc: signature.encryptedContent }
      : { id: signature.id },
  );
}

/**
 * Unpack a `ThinkingContent.signature` written by
 * {@link encodeReasoningSignature}.
 *
 * @returns The reasoning item identity, or undefined when the signature is
 *   empty or belongs to another provider.
 */
export function decodeReasoningSignature(
  signature: string | undefined,
): ReasoningSignature | undefined {
  const raw = signature?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; enc?: unknown };
      if (typeof parsed.id !== "string" || parsed.id === "") return undefined;
      return typeof parsed.enc === "string" && parsed.enc !== ""
        ? { id: parsed.id, encryptedContent: parsed.enc }
        : { id: parsed.id };
    } catch {
      return undefined;
    }
  }
  // A bare id, e.g. from a hand-written transcript.
  return { id: raw };
}

/* -------------------------------------------------------------------------- */
/* Request mapping                                                            */
/* -------------------------------------------------------------------------- */

/** Mirrors the Chat Completions adapter's data-URI handling. */
function dataUri(data: string, mimeType: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

function userContent(message: UserMessage): string | ResponseInputMessageContentList {
  const hasImage = message.content.some((part) => part.type === "image");
  if (!hasImage) {
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((text) => text !== "")
      .join("\n");
  }
  const parts: ResponseInputMessageContentList = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text !== "") parts.push({ type: "input_text", text: part.text });
    } else {
      parts.push({
        type: "input_image",
        detail: "auto",
        image_url: dataUri(part.data, part.mimeType),
      });
    }
  }
  return parts;
}

function toolResultText(message: ToolResultMessage): string {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (text !== "") return text;
  return message.content.some((part) => part.type === "image")
    ? "(see attached image)"
    : "(no tool output)";
}

function assistantItems(message: AssistantMessage, includeReasoning: boolean): ResponseInput {
  const out: ResponseInput = [];
  // A reasoning item must be followed by the item it produced, so it is only
  // replayed when this turn actually carries visible output.
  const hasFollowingOutput = message.content.some(
    (part) => part.type === "toolCall" || (part.type === "text" && part.text.trim() !== ""),
  );

  for (const part of message.content) {
    if (part.type === "thinking") {
      if (!includeReasoning || !hasFollowingOutput) continue;
      const decoded = decodeReasoningSignature(part.signature);
      if (!decoded) continue;
      out.push({
        type: "reasoning",
        id: decoded.id,
        summary: [],
        ...(decoded.encryptedContent ? { encrypted_content: decoded.encryptedContent } : {}),
      });
      continue;
    }
    if (part.type === "text") {
      if (part.text.trim() !== "") out.push({ role: "assistant", content: part.text });
      continue;
    }
    out.push({
      type: "function_call",
      call_id: part.id,
      name: part.name,
      arguments: JSON.stringify(part.arguments ?? {}),
    });
  }
  return out;
}

/** Options for {@link toResponsesInput}. */
export interface ResponsesInputOptions {
  /**
   * Replay `reasoning` items recovered from thinking signatures. Off for
   * models that do not advertise thinking, whose API rejects them.
   */
  includeReasoning?: boolean;
}

/**
 * Convert Arcturn messages into the Responses API `input` item list.
 *
 * The shape is item-oriented, not the Chat Completions message array: tool
 * calls become standalone `function_call` items, tool results become
 * `function_call_output` items keyed by `call_id`, and reasoning replays as
 * `reasoning` items. Images attached to a tool result are hoisted into a
 * following user message, as in the Chat Completions adapter, because
 * `function_call_output` support for image payloads is model-dependent.
 *
 * The system prompt is not part of the input list; it maps to `instructions`
 * (see {@link buildOpenAIResponsesRequest}).
 */
export function toResponsesInput(
  messages: Message[],
  options: ResponsesInputOptions = {},
): ResponseInput {
  const includeReasoning = options.includeReasoning !== false;
  const out: ResponseInput = [];

  for (const message of messages) {
    if (message.role === "user") {
      const content = userContent(message);
      if (typeof content === "string" ? content !== "" : content.length > 0) {
        out.push({ role: "user", content });
      }
      continue;
    }
    if (message.role === "assistant") {
      out.push(...assistantItems(message, includeReasoning));
      continue;
    }
    out.push({
      type: "function_call_output",
      call_id: message.toolCallId,
      output: toolResultText(message),
    });
    const images = message.content.filter((part) => part.type === "image");
    if (images.length > 0) {
      out.push({
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          ...images.map((part): ResponseInputMessageContentList[number] => ({
            type: "input_image",
            detail: "auto",
            image_url: dataUri(part.data, part.mimeType),
          })),
        ],
      });
    }
  }
  return out;
}

/**
 * Reasoning models reject an explicit temperature here exactly as they do on
 * Chat Completions, so the rule is borrowed rather than duplicated.
 */
export function supportsResponsesTemperature(spec: ModelSpec): boolean {
  return supportsTemperature({ ...spec, provider: "openai" });
}

/** Build the wire payload for a streaming Responses request. */
export function buildOpenAIResponsesRequest(
  request: LLMRequest,
  options: OpenAIResponsesRequestOptions = {},
): ResponseCreateParamsStreaming {
  const spec = request.model;
  const maxTokens = Math.min(request.maxOutputTokens ?? spec.maxOutputTokens, spec.maxOutputTokens);
  const params: ResponseCreateParamsStreaming = {
    model: spec.model,
    input: toResponsesInput(request.messages, { includeReasoning: spec.capabilities.thinking }),
    stream: true,
    max_output_tokens: maxTokens,
    store: options.store ?? false,
  };

  if (request.system !== undefined && request.system !== "") {
    params.instructions = request.system;
  }

  if (request.temperature !== undefined && supportsResponsesTemperature(spec)) {
    params.temperature = request.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    params.tools = request.tools.map(
      (tool): FunctionTool => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // Arcturn tool schemas are hand-written and not guaranteed to satisfy
        // OpenAI's structured-output subset.
        strict: false,
      }),
    );
  }

  if (spec.capabilities.thinking) {
    const effort = OPENAI_REASONING_EFFORT[request.thinking ?? "off"];
    if (effort !== undefined) {
      const reasoning: Reasoning = { effort: effort as Reasoning["effort"] };
      const summary = options.reasoningSummary === undefined ? "auto" : options.reasoningSummary;
      if (summary !== null) reasoning.summary = summary;
      params.reasoning = reasoning;
    }
    // Without server-side storage the encrypted blob is the only way to hand
    // reasoning items back on the next turn.
    if (params.store !== true) params.include = ["reasoning.encrypted_content"];
  }

  return Object.assign(params, request.providerOptions ?? {});
}

/* -------------------------------------------------------------------------- */
/* Response mapping                                                           */
/* -------------------------------------------------------------------------- */

interface ResponsesUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null };
  output_tokens_details?: { reasoning_tokens?: number | null };
}

/**
 * Normalise Responses API usage onto {@link Usage}.
 *
 * `input_tokens` is cache-inclusive, so cached and cache-written tokens are
 * subtracted out to keep Arcturn's fields additive (same convention as the Chat
 * Completions adapter). Arcturn's `Usage` has no reasoning bucket, and the API
 * already counts `output_tokens_details.reasoning_tokens` inside
 * `output_tokens`; reasoning tokens are therefore folded into `outputTokens`
 * and billed at the output rate rather than being reported separately.
 */
export function parseResponsesUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as ResponsesUsageLike;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    // Defensive: a gateway that reports reasoning outside output_tokens would
    // otherwise under-report the turn.
    outputTokens: Math.max(output, reasoning),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

/** Terminal state derived from a `Response` payload. */
export interface ResponsesStop {
  stopReason: StopReason;
  errorMessage?: string;
}

/**
 * Map a terminal `Response` onto a Arcturn stop reason.
 *
 * `incomplete` splits by reason: a token ceiling is the ordinary `maxTokens`
 * outcome, while a content filter is reported as a stopped-in-error turn, in
 * line with how the Chat Completions adapter treats `finish_reason:
 * "content_filter"`.
 */
export function mapResponsesStop(
  response: Pick<OpenAIResponse, "status"> & {
    incomplete_details?: OpenAIResponse["incomplete_details"];
  },
): ResponsesStop {
  switch (response.status) {
    case "incomplete": {
      const reason = response.incomplete_details?.reason;
      if (reason === "content_filter") {
        return { stopReason: "error", errorMessage: "Response incomplete: content_filter" };
      }
      return { stopReason: "maxTokens" };
    }
    case "cancelled":
      return { stopReason: "aborted" };
    case "failed":
      return { stopReason: "error", errorMessage: "Response failed" };
    default:
      return { stopReason: "endTurn" };
  }
}

/** Response-level error codes that are not simply bad requests. */
const RESPONSE_ERROR_KINDS: Readonly<Record<string, AIError["kind"]>> = {
  rate_limit_exceeded: "rateLimit",
  server_error: "overloaded",
  vector_store_timeout: "overloaded",
};

/**
 * Classify a `response.failed` / `error` payload.
 *
 * Known codes map directly; anything else falls through to the shared
 * {@link toAIError} heuristics so the classification stays consistent with the
 * HTTP-level errors thrown by the SDK.
 */
export function responsesErrorToAIError(code: string | null | undefined, message: string): AIError {
  const mapped = code ? RESPONSE_ERROR_KINDS[code] : undefined;
  if (mapped) return createAIError(mapped, message);
  return toAIError({ message, ...(code ? { code } : {}) });
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

type ItemKind = "message" | "reasoning" | "functionCall";

interface ItemState {
  kind: ItemKind;
  /** -1 until the block is opened. */
  blockIndex: number;
  itemId: string;
  callId: string;
  name: string;
  /** Accumulated raw tool-call arguments, parsed at `toolCallEnd`. */
  raw: string;
  opened: boolean;
  closed: boolean;
  ended: boolean;
  /** True once any delta arrived, so `done` knows whether to backfill. */
  received: boolean;
}

/**
 * Structural view of the SSE payloads this adapter reads.
 *
 * The SDK's `ResponseStreamEvent` union covers dozens of built-in-tool events
 * that Arcturn ignores, and OpenAI adds new ones between SDK releases; reading the
 * handful of fields structurally keeps unknown events harmless.
 */
interface StreamEventView {
  type: string;
  item_id?: string;
  output_index?: number;
  delta?: string;
  text?: string;
  arguments?: string;
  item?: ResponseOutputItem;
  response?: OpenAIResponse;
  code?: string | null;
  message?: string;
}

function outputItemText(item: ResponseOutputItem): string {
  if (item.type !== "message") return "";
  return item.content
    .map((part) => (part.type === "output_text" ? part.text : ""))
    .filter((text) => text !== "")
    .join("");
}

function reasoningItemText(item: ResponseOutputItem): string {
  if (item.type !== "reasoning") return "";
  const summary = item.summary.map((part) => part.text).join("");
  if (summary !== "") return summary;
  return (item.content ?? []).map((part) => part.text).join("");
}

/**
 * Translate Responses SSE events into provider stream events.
 *
 * Output items are tracked by `output_index` (with `item_id` as a fallback key)
 * and each becomes exactly one Arcturn block. Tool-call arguments accumulate as raw
 * text and are parsed once at `toolCallEnd` through {@link parseToolArguments},
 * so malformed or truncated JSON degrades to empty arguments instead of
 * throwing — identical to the Chat Completions adapter.
 *
 * Terminal handling:
 * - `response.completed` / `response.incomplete` end the turn normally (the
 *   latter as `maxTokens`, or a stopped-in-error turn for a content filter);
 * - `response.failed` and a top-level `error` event throw an
 *   {@link AIErrorException}, which `assembleStream` converts into the single
 *   `error` event carrying the partial message;
 * - an aborted signal surfaces as the SDK's abort error and is normalised to
 *   stop reason `"aborted"` by `assembleStream`.
 */
export async function* openaiResponsesEventStream(
  client: OpenAIResponsesClientLike,
  request: LLMRequest,
  options: OpenAIResponsesRequestOptions = {},
): AsyncIterable<ProviderStreamEvent> {
  const params = buildOpenAIResponsesRequest(request, options);
  const requestOptions = request.signal ? { signal: request.signal } : undefined;
  const stream = await client.responses.create(params, requestOptions);

  let nextBlock = 0;
  const byIndex = new Map<number, ItemState>();
  const byItemId = new Map<string, ItemState>();
  const order: ItemState[] = [];
  let usage: Usage | undefined;
  let stop: ResponsesStop | undefined;
  let failure: AIError | undefined;

  const locate = (view: StreamEventView): ItemState | undefined => {
    if (typeof view.output_index === "number") {
      const found = byIndex.get(view.output_index);
      if (found) return found;
    }
    return view.item_id ? byItemId.get(view.item_id) : undefined;
  };

  const ensure = (view: StreamEventView, kind: ItemKind): ItemState => {
    const existing = locate(view);
    if (existing) {
      if (view.item_id && !byItemId.has(view.item_id)) byItemId.set(view.item_id, existing);
      return existing;
    }
    const state: ItemState = {
      kind,
      blockIndex: -1,
      itemId: view.item_id ?? "",
      callId: "",
      name: "",
      raw: "",
      opened: false,
      closed: false,
      ended: false,
      received: false,
    };
    order.push(state);
    if (typeof view.output_index === "number") byIndex.set(view.output_index, state);
    if (view.item_id) byItemId.set(view.item_id, state);
    return state;
  };

  function* open(state: ItemState): Generator<ProviderStreamEvent> {
    if (state.opened) return;
    state.opened = true;
    state.blockIndex = nextBlock++;
    if (state.kind === "reasoning") {
      yield { type: "thinkingStart", blockIndex: state.blockIndex };
    } else if (state.kind === "functionCall") {
      yield {
        type: "toolCallStart",
        blockIndex: state.blockIndex,
        id: state.callId || state.itemId,
        name: state.name || "unknown",
      };
    } else {
      yield { type: "textStart", blockIndex: state.blockIndex };
    }
  }

  function* close(state: ItemState): Generator<ProviderStreamEvent> {
    if (!state.opened || state.closed) return;
    state.closed = true;
    if (state.kind === "functionCall" && !state.ended) {
      state.ended = true;
      yield {
        type: "toolCallEnd",
        blockIndex: state.blockIndex,
        id: state.callId || state.itemId,
        name: state.name || "unknown",
        arguments: parseToolArguments(state.raw),
      };
    }
    yield { type: "blockEnd", blockIndex: state.blockIndex };
  }

  for await (const raw of stream) {
    const view = raw as unknown as StreamEventView;

    switch (view.type) {
      case "response.output_item.added": {
        const item = view.item;
        if (!item) break;
        if (item.type === "reasoning") {
          const state = ensure(view, "reasoning");
          if (state.itemId === "") state.itemId = item.id;
          yield* open(state);
        } else if (item.type === "function_call") {
          const state = ensure(view, "functionCall");
          state.callId = item.call_id;
          state.name = item.name;
          if (state.itemId === "") state.itemId = item.id ?? "";
          yield* open(state);
        } else if (item.type === "message") {
          // Opened lazily, so a message item that never emits text leaves no
          // empty block behind.
          ensure(view, "message");
        }
        break;
      }

      case "response.output_text.delta": {
        const delta = view.delta ?? "";
        if (delta === "") break;
        const state = ensure(view, "message");
        state.received = true;
        yield* open(state);
        yield { type: "textDelta", blockIndex: state.blockIndex, delta };
        break;
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = view.delta ?? "";
        if (delta === "") break;
        const state = ensure(view, "reasoning");
        state.received = true;
        yield* open(state);
        yield { type: "thinkingDelta", blockIndex: state.blockIndex, delta };
        break;
      }

      case "response.function_call_arguments.delta": {
        const delta = view.delta ?? "";
        if (delta === "") break;
        const state = ensure(view, "functionCall");
        state.received = true;
        yield* open(state);
        state.raw += delta;
        yield { type: "toolCallDelta", blockIndex: state.blockIndex, argumentsDelta: delta };
        break;
      }

      case "response.output_item.done": {
        const item = view.item;
        if (!item) break;
        if (item.type === "reasoning") {
          const state = ensure(view, "reasoning");
          if (state.itemId === "") state.itemId = item.id;
          yield* open(state);
          if (!state.received) {
            const text = reasoningItemText(item);
            if (text !== "") {
              state.received = true;
              yield { type: "thinkingDelta", blockIndex: state.blockIndex, delta: text };
            }
          }
          const signature = encodeReasoningSignature({
            id: item.id,
            ...(item.encrypted_content ? { encryptedContent: item.encrypted_content } : {}),
          });
          if (signature !== "") {
            yield {
              type: "thinkingSignature",
              blockIndex: state.blockIndex,
              signature,
              replace: true,
            };
          }
          yield* close(state);
        } else if (item.type === "function_call") {
          const state = ensure(view, "functionCall");
          if (state.callId === "") state.callId = item.call_id;
          if (state.name === "") state.name = item.name;
          if (state.itemId === "") state.itemId = item.id ?? "";
          yield* open(state);
          if (!state.received && item.arguments !== "") {
            state.received = true;
            state.raw = item.arguments;
            yield {
              type: "toolCallDelta",
              blockIndex: state.blockIndex,
              argumentsDelta: item.arguments,
            };
          }
          yield* close(state);
        } else if (item.type === "message") {
          const state = ensure(view, "message");
          if (!state.received) {
            const text = outputItemText(item);
            if (text !== "") {
              state.received = true;
              yield* open(state);
              yield { type: "textDelta", blockIndex: state.blockIndex, delta: text };
            }
          }
          yield* close(state);
        }
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        const response = view.response;
        if (!response) break;
        const parsed = parseResponsesUsage(response.usage);
        if (parsed) usage = parsed;
        stop = mapResponsesStop(response);
        break;
      }

      case "response.failed": {
        const response = view.response;
        const parsed = parseResponsesUsage(response?.usage);
        if (parsed) usage = parsed;
        failure = responsesErrorToAIError(
          response?.error?.code,
          response?.error?.message ?? "The response failed",
        );
        break;
      }

      case "error": {
        failure = responsesErrorToAIError(view.code, view.message ?? "Response stream error");
        break;
      }

      default:
        break;
    }
  }

  for (const state of order) yield* close(state);
  if (usage) yield { type: "usage", usage };

  // Thrown after the partial content has been emitted, so `assembleStream`
  // reports the single terminal `error` with everything received so far.
  if (failure) throw new AIErrorException(failure);

  const resolved =
    stop ??
    (order.some((state) => state.kind === "functionCall")
      ? { stopReason: "toolCalls" as StopReason }
      : { stopReason: "endTurn" as StopReason });
  yield resolved.errorMessage === undefined
    ? { type: "stop", stopReason: resolved.stopReason }
    : { type: "stop", stopReason: resolved.stopReason, errorMessage: resolved.errorMessage };
}

/** Create an {@link LLMClient} backed by the OpenAI Responses API. */
export function createOpenAIResponsesProvider(
  options: OpenAIResponsesProviderOptions = {},
): LLMClient {
  // An injected test double resolves directly, so the SDK is never imported.
  let clientPromise: Promise<OpenAIResponsesClientLike> | undefined;
  const getClient = (): Promise<OpenAIResponsesClientLike> =>
    (clientPromise ??= options.client
      ? Promise.resolve(options.client)
      : loadOpenAISdk().then(
          ({ default: OpenAISDK }) =>
            new OpenAISDK({
              apiKey: options.apiKey ?? "",
              ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
              ...(options.headers ? { defaultHeaders: options.headers } : {}),
              maxRetries: 0,
            }) as unknown as OpenAIResponsesClientLike,
        ));

  const streamOptions: OpenAIResponsesRequestOptions = {
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.reasoningSummary === undefined
      ? {}
      : { reasoningSummary: options.reasoningSummary }),
  };

  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return assembleStream(request.model, request.signal, () =>
        deferredEvents(async () =>
          openaiResponsesEventStream(await getClient(), request, streamOptions),
        ),
      );
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Catalog + registration                                                     */
/* -------------------------------------------------------------------------- */

/** Options for {@link openaiResponsesModel}. */
export interface OpenAIResponsesModelOptions {
  /** Catalog id; defaults to `openai-responses/<model>`. */
  id?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  cost?: ModelSpec["cost"];
  capabilities?: Partial<ModelCapabilities>;
  /** Override the API root, e.g. an Azure or gateway deployment. */
  baseUrl?: string;
  /** Environment variable holding the API key. */
  apiKeyEnv?: string;
}

/**
 * Build a {@link ModelSpec} routed through the Responses adapter.
 *
 * Hosts that want the spec in the shared catalog can pass the result to
 * `registerModel`; this helper deliberately does not touch the catalog itself.
 *
 * @param model - Wire model name, e.g. `"gpt-5.1"`.
 */
export function openaiResponsesModel(
  model: string,
  options: OpenAIResponsesModelOptions = {},
): ModelSpec {
  const spec: ModelSpec = {
    id: options.id ?? `${OPENAI_RESPONSES_PROVIDER}/${model}`,
    provider: OPENAI_RESPONSES_PROVIDER,
    model,
    displayName: options.displayName ?? model,
    contextWindow: options.contextWindow ?? 400_000,
    maxOutputTokens: options.maxOutputTokens ?? 128_000,
    capabilities: {
      tools: true,
      vision: true,
      thinking: true,
      caching: true,
      ...options.capabilities,
    },
    apiKeyEnv: options.apiKeyEnv ?? OPENAI_RESPONSES_API_KEY_ENV,
  };
  if (options.cost) spec.cost = options.cost;
  if (options.baseUrl) spec.baseUrl = options.baseUrl;
  return spec;
}

function requireApiKey(ctx: ProviderFactoryContext): ProviderPrecheckFailure | undefined {
  if (ctx.apiKey) return undefined;
  const envVar = ctx.spec.apiKeyEnv ?? OPENAI_RESPONSES_API_KEY_ENV;
  return {
    kind: "auth",
    message: `No API key for ${OPENAI_RESPONSES_PROVIDER}; set ${envVar}`,
  };
}

/**
 * Register the Responses adapter under `"openai-responses"`.
 *
 * Kept as an explicit call rather than an import side effect so the host
 * decides when the provider becomes available. Idempotent: the registry
 * replaces any previous registration for the id.
 */
export function registerOpenAIResponsesProvider(options: OpenAIResponsesRequestOptions = {}): void {
  registerProviderFactory({
    id: OPENAI_RESPONSES_PROVIDER,
    factory: (ctx) =>
      createOpenAIResponsesProvider({
        ...(ctx.apiKey !== undefined ? { apiKey: ctx.apiKey } : {}),
        ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
        ...(ctx.headers ? { headers: ctx.headers } : {}),
        ...options,
      }),
    checkCredentials: requireApiKey,
  });
}
