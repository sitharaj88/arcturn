/**
 * OpenAI Chat Completions adapter.
 *
 * Also drives OpenAI-compatible endpoints (Groq, Mistral, Ollama, OpenRouter,
 * xAI, DeepSeek, ...) via `baseUrl`, including their non-standard reasoning
 * fields.
 */

import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  Message,
  ModelSpec,
  StopReason,
  StreamEvent,
  ThinkingLevel,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@arcturn/types";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { parseToolArguments } from "../internal/json.js";
import {
  assembleStream,
  completeFromStream,
  deferredEvents,
  type ProviderStreamEvent,
} from "../internal/stream.js";

/** Portable thinking level to OpenAI `reasoning_effort`. */
export const OPENAI_REASONING_EFFORT: Readonly<Record<ThinkingLevel, string | undefined>> = {
  off: undefined,
  low: "low",
  medium: "medium",
  high: "high",
};

/** Non-standard delta keys used by compatible providers to stream reasoning. */
const REASONING_KEYS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/** Loaded on first use: importing the SDK eagerly costs hundreds of ms of CLI startup. */
let sdkModule: Promise<typeof import("openai")> | undefined;
function loadSdk(): Promise<typeof import("openai")> {
  sdkModule ??= import("openai");
  return sdkModule;
}

/** Minimal structural view of the OpenAI SDK, so tests can inject fakes. */
export interface OpenAIClientLike {
  chat: {
    completions: {
      create(
        params: ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<ChatCompletionChunk>>;
    };
  };
}

/** Construction options for {@link createOpenAIProvider}. */
export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Send `stream_options.include_usage`; disable for gateways that reject it. */
  includeUsage?: boolean;
  /** Pre-built client; primarily an injection seam for tests. */
  client?: OpenAIClientLike;
}

function dataUri(data: string, mimeType: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

function userParts(message: UserMessage): string | ChatCompletionContentPart[] {
  const hasImage = message.content.some((part) => part.type === "image");
  if (!hasImage) {
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((text) => text !== "")
      .join("\n");
  }
  const parts: ChatCompletionContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text !== "") parts.push({ type: "text", text: part.text });
    } else {
      parts.push({ type: "image_url", image_url: { url: dataUri(part.data, part.mimeType) } });
    }
  }
  return parts;
}

function assistantParam(
  message: AssistantMessage,
): ChatCompletionAssistantMessageParam | undefined {
  const text = message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .filter((value) => value.trim() !== "")
    .join("\n");
  const toolCalls = message.content
    .filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall")
    .map((part) => ({
      id: part.id,
      type: "function" as const,
      function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
    }));

  if (text === "" && toolCalls.length === 0) return undefined;
  const param: ChatCompletionAssistantMessageParam = { role: "assistant", content: text || null };
  if (toolCalls.length > 0) param.tool_calls = toolCalls;
  return param;
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

/**
 * Convert Arcturn messages to Chat Completions messages.
 *
 * Thinking blocks are dropped (the API has no slot for them), and images
 * carried by a tool result are hoisted into a following user message because
 * `role: "tool"` accepts text only.
 */
export function toOpenAIMessages(
  messages: Message[],
  system?: string,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  if (system !== undefined && system !== "") out.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      const content = userParts(message);
      if (typeof content === "string" ? content !== "" : content.length > 0) {
        out.push({ role: "user", content });
      }
      continue;
    }
    if (message.role === "assistant") {
      const param = assistantParam(message);
      if (param) out.push(param);
      continue;
    }
    out.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: toolResultText(message),
    });
    const images = message.content.filter((part) => part.type === "image");
    if (images.length > 0) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          ...images.map(
            (part): ChatCompletionContentPart => ({
              type: "image_url",
              image_url: { url: dataUri(part.data, part.mimeType) },
            }),
          ),
        ],
      });
    }
  }
  return out;
}

/** OpenAI reasoning models reject an explicit temperature. */
export function supportsTemperature(spec: ModelSpec): boolean {
  if (spec.provider !== "openai") return true;
  return !/^(o\d|gpt-5)/.test(spec.model);
}

/** Build the wire payload for a streaming Chat Completions request. */
export function buildOpenAIRequest(
  request: LLMRequest,
  options: { includeUsage?: boolean } = {},
): ChatCompletionCreateParamsStreaming {
  const spec = request.model;
  const maxTokens = Math.min(request.maxOutputTokens ?? spec.maxOutputTokens, spec.maxOutputTokens);
  const params: ChatCompletionCreateParamsStreaming = {
    model: spec.model,
    messages: toOpenAIMessages(request.messages, request.system),
    stream: true,
  };

  if (options.includeUsage !== false) params.stream_options = { include_usage: true };

  // OpenAI proper requires max_completion_tokens; most compatible gateways
  // only understand the legacy max_tokens field.
  if (spec.provider === "openai") params.max_completion_tokens = maxTokens;
  else params.max_tokens = maxTokens;

  if (request.temperature !== undefined && supportsTemperature(spec)) {
    params.temperature = request.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    params.tools = request.tools.map(
      (tool): ChatCompletionFunctionTool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }),
    );
  }

  const effort = OPENAI_REASONING_EFFORT[request.thinking ?? "off"];
  if (effort && spec.capabilities.thinking) {
    params.reasoning_effort = effort as NonNullable<
      ChatCompletionCreateParamsStreaming["reasoning_effort"]
    >;
  }

  return Object.assign(params, request.providerOptions ?? {});
}

/** Map a Chat Completions `finish_reason` onto the portable {@link StopReason}. */
export function mapOpenAIFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "length":
      return "maxTokens";
    case "tool_calls":
    case "function_call":
      return "toolCalls";
    case "content_filter":
      return "error";
    default:
      return "endTurn";
  }
}

interface UsageLike {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null };
  prompt_cache_hit_tokens?: number | null;
  cached_tokens?: number | null;
}

/**
 * Normalise Chat Completions usage.
 *
 * `prompt_tokens` is cache-inclusive on this API, so cached tokens are
 * subtracted out to match the Arcturn convention where the fields are additive.
 */
export function parseOpenAIUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as UsageLike;
  const cacheRead =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.cached_tokens ??
    0;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  const prompt = usage.prompt_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cacheRead - cacheWrite),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function readReasoning(delta: Record<string, unknown>): string | undefined {
  for (const key of REASONING_KEYS) {
    const value = delta[key];
    // First non-empty field wins: some gateways send two copies.
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

interface OpenAIToolState {
  blockIndex: number;
  id: string;
  name: string;
  raw: string;
  started: boolean;
  pending: string;
}

/** Translate raw Chat Completions chunks into provider stream events. */
export async function* openaiEventStream(
  client: OpenAIClientLike,
  request: LLMRequest,
  options: { includeUsage?: boolean } = {},
): AsyncIterable<ProviderStreamEvent> {
  const params = buildOpenAIRequest(request, options);
  const requestOptions = request.signal ? { signal: request.signal } : undefined;
  const stream = await client.chat.completions.create(params, requestOptions);

  let nextBlock = 0;
  let textBlock: number | undefined;
  let thinkingBlock: number | undefined;
  const byStreamIndex = new Map<number, OpenAIToolState>();
  const byId = new Map<string, OpenAIToolState>();
  const toolOrder: OpenAIToolState[] = [];
  let usage: Usage | undefined;
  let stopReason: StopReason | undefined;
  let errorMessage: string | undefined;

  const events: ProviderStreamEvent[] = [];
  const closeText = (): void => {
    if (textBlock !== undefined) {
      events.push({ type: "blockEnd", blockIndex: textBlock });
      textBlock = undefined;
    }
  };
  const closeThinking = (): void => {
    if (thinkingBlock !== undefined) {
      events.push({ type: "blockEnd", blockIndex: thinkingBlock });
      thinkingBlock = undefined;
    }
  };
  const flush = function* (): Generator<ProviderStreamEvent> {
    while (events.length > 0) yield events.shift() as ProviderStreamEvent;
  };

  for await (const chunk of stream) {
    const chunkUsage = parseOpenAIUsage(chunk.usage);
    if (chunkUsage) usage = chunkUsage;

    const choice = chunk.choices[0];
    if (!choice) {
      yield* flush();
      if (chunkUsage) yield { type: "usage", usage: chunkUsage };
      continue;
    }

    const delta = (choice.delta ?? {}) as Record<string, unknown> &
      ChatCompletionChunk.Choice.Delta;

    const reasoning = readReasoning(delta);
    if (reasoning !== undefined) {
      closeText();
      if (thinkingBlock === undefined) {
        thinkingBlock = nextBlock++;
        events.push({ type: "thinkingStart", blockIndex: thinkingBlock });
      }
      events.push({ type: "thinkingDelta", blockIndex: thinkingBlock, delta: reasoning });
    }

    if (typeof delta.content === "string" && delta.content !== "") {
      closeThinking();
      if (textBlock === undefined) {
        textBlock = nextBlock++;
        events.push({ type: "textStart", blockIndex: textBlock });
      }
      events.push({ type: "textDelta", blockIndex: textBlock, delta: delta.content });
    }

    for (const call of delta.tool_calls ?? []) {
      const streamIndex = typeof call.index === "number" ? call.index : undefined;
      const id = typeof call.id === "string" && call.id !== "" ? call.id : undefined;
      let state =
        (streamIndex !== undefined ? byStreamIndex.get(streamIndex) : undefined) ??
        (id !== undefined ? byId.get(id) : undefined);

      if (!state) {
        state = {
          blockIndex: -1,
          id: id ?? `call_${toolOrder.length}`,
          name: "",
          raw: "",
          started: false,
          pending: "",
        };
        toolOrder.push(state);
        if (streamIndex !== undefined) byStreamIndex.set(streamIndex, state);
        if (id !== undefined) byId.set(id, state);
      } else {
        if (streamIndex !== undefined && !byStreamIndex.has(streamIndex)) {
          byStreamIndex.set(streamIndex, state);
        }
        if (id !== undefined && !byId.has(id)) {
          byId.set(id, state);
          state.id = id;
        }
      }

      const name = call.function?.name;
      if (!state.name && typeof name === "string" && name !== "") state.name = name;

      const argsDelta = call.function?.arguments;
      if (typeof argsDelta === "string" && argsDelta !== "") {
        state.raw += argsDelta;
        state.pending += argsDelta;
      }

      if (!state.started && state.name !== "") {
        closeText();
        closeThinking();
        state.blockIndex = nextBlock++;
        state.started = true;
        events.push({
          type: "toolCallStart",
          blockIndex: state.blockIndex,
          id: state.id,
          name: state.name,
        });
      }
      if (state.started && state.pending !== "") {
        events.push({
          type: "toolCallDelta",
          blockIndex: state.blockIndex,
          argumentsDelta: state.pending,
        });
        state.pending = "";
      }
    }

    if (choice.finish_reason) {
      stopReason = mapOpenAIFinishReason(choice.finish_reason);
      if (stopReason === "error") {
        errorMessage = `Provider finish_reason: ${choice.finish_reason}`;
      }
    }

    yield* flush();
  }

  closeText();
  closeThinking();
  yield* flush();

  for (const state of toolOrder) {
    if (!state.started) {
      // A tool call whose name never arrived; open it now so it is not lost.
      state.blockIndex = nextBlock++;
      state.started = true;
      yield {
        type: "toolCallStart",
        blockIndex: state.blockIndex,
        id: state.id,
        name: state.name || "unknown",
      };
      if (state.pending !== "") {
        yield {
          type: "toolCallDelta",
          blockIndex: state.blockIndex,
          argumentsDelta: state.pending,
        };
        state.pending = "";
      }
    }
    yield {
      type: "toolCallEnd",
      blockIndex: state.blockIndex,
      id: state.id,
      name: state.name || "unknown",
      arguments: parseToolArguments(state.raw),
    };
    yield { type: "blockEnd", blockIndex: state.blockIndex };
  }

  if (usage) yield { type: "usage", usage };

  const resolved = stopReason ?? (toolOrder.length > 0 ? "toolCalls" : "endTurn");
  yield errorMessage === undefined
    ? { type: "stop", stopReason: resolved }
    : { type: "stop", stopReason: resolved, errorMessage };
}

/** Create an {@link LLMClient} backed by the Chat Completions API. */
export function createOpenAIProvider(options: OpenAIProviderOptions = {}): LLMClient {
  let clientPromise: Promise<OpenAIClientLike> | undefined;
  const getClient = (): Promise<OpenAIClientLike> => {
    clientPromise ??= options.client
      ? Promise.resolve(options.client)
      : loadSdk().then(
          ({ default: OpenAISDK }) =>
            new OpenAISDK({
              apiKey: options.apiKey ?? "",
              ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
              ...(options.headers ? { defaultHeaders: options.headers } : {}),
              maxRetries: 0,
            }) as unknown as OpenAIClientLike,
        );
    return clientPromise;
  };

  const streamOptions =
    options.includeUsage === undefined ? {} : { includeUsage: options.includeUsage };

  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return assembleStream(request.model, request.signal, () =>
        deferredEvents(async () => openaiEventStream(await getClient(), request, streamOptions)),
      );
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };
}
