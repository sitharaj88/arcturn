/**
 * Google Gemini adapter built on `@google/genai`.
 *
 * Gemini streams a flat list of `Part`s with no block framing, so this adapter
 * runs a small state machine to synthesise the start/delta/end events the rest
 * of the harness expects.
 */

import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  Message,
  StopReason,
  StreamEvent,
  ThinkingLevel,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@arcturn/types";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
  ThinkingConfig,
} from "@google/genai";
import {
  assembleStream,
  completeFromStream,
  deferredEvents,
  type ProviderStreamEvent,
} from "../internal/stream.js";

/** Loaded lazily so importing this module does not pay the SDK's startup cost. */
let genaiSdk: Promise<typeof import("@google/genai")> | undefined;
function loadGenai() {
  genaiSdk ??= import("@google/genai");
  return genaiSdk;
}

/** Prefix marking a tool-call id Arcturn invented because Gemini supplied none. */
export const SYNTHETIC_TOOL_ID_PREFIX = "arcturn-";

/** Thinking budgets in tokens, used by the Gemini 2.5 family. */
export const GOOGLE_THINKING_BUDGETS: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 4_096,
  medium: 16_384,
  high: 32_768,
};

/** Thinking levels, used by Gemini 3 and later. */
const GOOGLE_THINKING_LEVELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
};

/** Minimal structural view of the genai SDK, so tests can inject fakes. */
export interface GoogleClientLike {
  models: {
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncIterable<GenerateContentResponse>>;
  };
}

/** Construction options for {@link createGoogleProvider}. */
export interface GoogleProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Pre-built client; primarily an injection seam for tests. */
  client?: GoogleClientLike;
}

/** Gemini only accepts explicit function-call ids from version 3 onwards. */
export function supportsToolCallIds(model: string): boolean {
  const match = /gemini-(\d+)/.exec(model);
  if (match?.[1]) return Number(match[1]) >= 3;
  // Non-Gemini models proxied through the endpoint use ids.
  return !model.startsWith("gemini");
}

function isGemini3OrLater(model: string): boolean {
  const match = /gemini-(\d+)/.exec(model);
  return match?.[1] ? Number(match[1]) >= 3 : false;
}

function userParts(message: UserMessage): Part[] {
  const parts: Part[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text !== "") parts.push({ text: part.text });
    } else {
      parts.push({ inlineData: { mimeType: part.mimeType, data: part.data } });
    }
  }
  return parts;
}

function assistantParts(message: AssistantMessage, withIds: boolean): Part[] {
  const parts: Part[] = [];
  for (const block of message.content) {
    if (block.type === "thinking") {
      const part: Part = { text: block.thinking, thought: true };
      if (block.signature) part.thoughtSignature = block.signature;
      // An empty thought part still matters when it carries a signature.
      if (block.thinking !== "" || block.signature) parts.push(part);
    } else if (block.type === "text") {
      if (block.text !== "") parts.push({ text: block.text });
    } else {
      const call: NonNullable<Part["functionCall"]> = {
        name: block.name,
        args: block.arguments ?? {},
      };
      if (withIds && !block.id.startsWith(SYNTHETIC_TOOL_ID_PREFIX)) call.id = block.id;
      // Gemini 3 signs the call itself and refuses the next turn without the
      // signature back (`400` — "Function call is missing a thought_signature
      // in functionCall parts"), so this is the half that makes tool use work
      // at all, not a fidelity nicety. The signature sits on the *part*, beside
      // `functionCall`, exactly where it arrived.
      const callPart: Part = { functionCall: call };
      if (block.signature) callPart.thoughtSignature = block.signature;
      parts.push(callPart);
    }
  }
  return parts;
}

function toolResultPart(message: ToolResultMessage, withIds: boolean): Part {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const payload = message.isError
    ? { error: text || "Tool execution failed" }
    : { output: text || "(no tool output)" };
  const response: NonNullable<Part["functionResponse"]> = {
    name: message.toolName,
    response: payload,
  };
  if (withIds && !message.toolCallId.startsWith(SYNTHETIC_TOOL_ID_PREFIX)) {
    response.id = message.toolCallId;
  }
  return { functionResponse: response };
}

function lastFunctionResponseTurn(contents: Content[]): Content | undefined {
  const last = contents[contents.length - 1];
  if (last?.role !== "user") return undefined;
  return last.parts?.some((part) => part.functionResponse) ? last : undefined;
}

/**
 * Convert Arcturn messages to Gemini `Content`s.
 *
 * All function responses for one turn are coalesced into a single user turn,
 * as the API requires. Images inside a tool result are emitted as a separate
 * following user turn.
 */
export function toGoogleContents(messages: Message[], model: string): Content[] {
  const withIds = supportsToolCallIds(model);
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const parts = userParts(message);
      if (parts.length > 0) contents.push({ role: "user", parts });
      continue;
    }
    if (message.role === "assistant") {
      const parts = assistantParts(message, withIds);
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    const part = toolResultPart(message, withIds);
    const turn = lastFunctionResponseTurn(contents);
    if (turn?.parts) turn.parts.push(part);
    else contents.push({ role: "user", parts: [part] });

    const images = message.content.filter((entry) => entry.type === "image");
    if (images.length > 0) {
      contents.push({
        role: "user",
        parts: [
          { text: "Attached image(s) from tool result:" },
          ...images.map(
            (entry): Part => ({
              inlineData: { mimeType: entry.mimeType, data: entry.data },
            }),
          ),
        ],
      });
    }
  }
  return contents;
}

function thinkingConfigFor(request: LLMRequest): ThinkingConfig | undefined {
  const level = request.thinking ?? "off";
  if (!request.model.capabilities.thinking) return undefined;
  if (isGemini3OrLater(request.model.model)) {
    const config: ThinkingConfig = {
      thinkingLevel: GOOGLE_THINKING_LEVELS[level] as ThinkingConfig["thinkingLevel"],
    };
    if (level !== "off") config.includeThoughts = true;
    return config;
  }
  if (level === "off") return { thinkingBudget: 0 };
  return { includeThoughts: true, thinkingBudget: GOOGLE_THINKING_BUDGETS[level] };
}

/** Build the wire payload for a streaming `generateContent` request. */
export function buildGoogleRequest(request: LLMRequest): GenerateContentParameters {
  const spec = request.model;
  const maxTokens = Math.min(request.maxOutputTokens ?? spec.maxOutputTokens, spec.maxOutputTokens);
  const config: NonNullable<GenerateContentParameters["config"]> = {
    maxOutputTokens: maxTokens,
  };

  if (request.system !== undefined && request.system !== "") {
    config.systemInstruction = { role: "user", parts: [{ text: request.system }] };
  }
  if (request.temperature !== undefined) config.temperature = request.temperature;
  if (request.signal) config.abortSignal = request.signal;

  if (request.tools && request.tools.length > 0) {
    const declarations: FunctionDeclaration[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    }));
    config.tools = [{ functionDeclarations: declarations }];
  }

  const thinking = thinkingConfigFor(request);
  if (thinking) config.thinkingConfig = thinking;

  return {
    model: spec.model,
    contents: toGoogleContents(request.messages, spec.model),
    config: Object.assign(config, request.providerOptions ?? {}),
  };
}

/** Map a Gemini `finishReason` onto the portable {@link StopReason}. */
export function mapGoogleFinishReason(reason: string | undefined): StopReason | undefined {
  if (!reason) return undefined;
  if (reason === "STOP") return "endTurn";
  if (reason === "MAX_TOKENS") return "maxTokens";
  return "error";
}

interface GoogleUsageLike {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

/**
 * Normalise Gemini usage metadata.
 *
 * `promptTokenCount` is cache-inclusive while `candidatesTokenCount` excludes
 * thinking tokens, so both need adjusting to match the Arcturn convention.
 */
export function parseGoogleUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as GoogleUsageLike;
  const cacheRead = usage.cachedContentTokenCount ?? 0;
  const prompt = usage.promptTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
  };
}

/** Translate raw Gemini chunks into provider stream events. */
export async function* googleEventStream(
  client: GoogleClientLike,
  request: LLMRequest,
): AsyncIterable<ProviderStreamEvent> {
  const params = buildGoogleRequest(request);
  const stream = await client.models.generateContentStream(params);

  let nextBlock = 0;
  let open: { kind: "text" | "thinking"; index: number } | undefined;
  let usage: Usage | undefined;
  let stopReason: StopReason | undefined;
  let errorMessage: string | undefined;
  let toolCounter = 0;
  const seenIds = new Set<string>();

  const closeOpen = function* (): Generator<ProviderStreamEvent> {
    if (open) {
      yield { type: "blockEnd", blockIndex: open.index };
      open = undefined;
    }
  };

  for await (const chunk of stream) {
    const chunkUsage = parseGoogleUsage(chunk.usageMetadata);
    if (chunkUsage) usage = chunkUsage;

    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        yield* closeOpen();
        const call = part.functionCall;
        let id = call.id;
        if (!id || seenIds.has(id)) {
          id = `${SYNTHETIC_TOOL_ID_PREFIX}${call.name ?? "tool"}-${toolCounter}`;
        }
        toolCounter++;
        seenIds.add(id);
        const blockIndex = nextBlock++;
        const name = call.name ?? "unknown";
        const args = JSON.stringify(call.args ?? {});
        // Gemini delivers arguments whole; synthesise the delta for parity.
        yield { type: "toolCallStart", blockIndex, id, name };
        yield { type: "toolCallDelta", blockIndex, argumentsDelta: args };
        yield {
          type: "toolCallEnd",
          blockIndex,
          id,
          name,
          arguments: (call.args ?? {}) as Record<string, unknown>,
          // Read from the enclosing part, not from `call`: Gemini attaches the
          // signature alongside `functionCall`, and it is required on the way
          // back out. See `assistantParts`.
          ...(part.thoughtSignature === undefined ? {} : { signature: part.thoughtSignature }),
        };
        yield { type: "blockEnd", blockIndex };
        continue;
      }

      if (part.text === undefined) continue;
      const kind = part.thought === true ? "thinking" : "text";
      if (open && open.kind !== kind) yield* closeOpen();
      if (!open) {
        const index = nextBlock++;
        open = { kind, index };
        yield kind === "thinking"
          ? { type: "thinkingStart", blockIndex: index }
          : { type: "textStart", blockIndex: index };
      }
      if (part.text !== "") {
        yield kind === "thinking"
          ? { type: "thinkingDelta", blockIndex: open.index, delta: part.text }
          : { type: "textDelta", blockIndex: open.index, delta: part.text };
      }
      if (kind === "thinking" && part.thoughtSignature) {
        yield {
          type: "thinkingSignature",
          blockIndex: open.index,
          signature: part.thoughtSignature,
          replace: true,
        };
      }
    }

    const finish = mapGoogleFinishReason(candidate?.finishReason);
    if (finish) {
      stopReason = finish;
      if (finish === "error") errorMessage = `Provider stopped with: ${candidate?.finishReason}`;
    }
  }

  yield* closeOpen();
  if (usage) yield { type: "usage", usage };
  yield errorMessage === undefined
    ? { type: "stop", stopReason: stopReason ?? "endTurn" }
    : { type: "stop", stopReason: stopReason ?? "endTurn", errorMessage };
}

/** Create an {@link LLMClient} backed by the Gemini API. */
export function createGoogleProvider(options: GoogleProviderOptions = {}): LLMClient {
  // An injected double resolves without touching the SDK; the real client is
  // built lazily behind a cached promise so import stays cheap.
  let client: Promise<GoogleClientLike> | undefined;
  const getClient = (): Promise<GoogleClientLike> => {
    client ??= options.client
      ? Promise.resolve(options.client)
      : loadGenai().then(
          ({ GoogleGenAI }) =>
            new GoogleGenAI({
              apiKey: options.apiKey ?? "",
              ...(options.baseUrl || options.headers
                ? {
                    httpOptions: {
                      ...(options.baseUrl ? { baseUrl: options.baseUrl, apiVersion: "" } : {}),
                      ...(options.headers ? { headers: options.headers } : {}),
                    },
                  }
                : {}),
            }) as unknown as GoogleClientLike,
        );
    return client;
  };

  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return assembleStream(request.model, request.signal, () =>
        deferredEvents(async () => googleEventStream(await getClient(), request)),
      );
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };
}
