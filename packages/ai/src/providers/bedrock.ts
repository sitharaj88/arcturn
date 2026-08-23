/**
 * Amazon Bedrock adapter.
 *
 * Bedrock hosts two very different wire protocols, so this adapter dispatches
 * on the model id:
 *
 * - **Claude on Bedrock** (`anthropic.*`, optionally behind a `global.`/`us.`/
 *   `eu.`/`apac.` inference profile) goes through `@anthropic-ai/bedrock-sdk`,
 *   which speaks the native Messages API. The message conversion, tool schema,
 *   thinking configuration (including the budget/adaptive split) and SSE
 *   handling are reused verbatim from {@link ./anthropic.js}, so Claude
 *   behaves identically on both backends.
 * - **Everything else** (Nova, Llama, Mistral, Titan, DeepSeek, ...) goes
 *   through `ConverseStream`, Bedrock's model-agnostic streaming API.
 *
 * Credentials come from the standard AWS provider chain (env vars, shared
 * config profiles, SSO, container and IMDS roles), so nothing needs to be
 * configured explicitly. Only the region must be resolvable.
 */

import type {
  AIError,
  AssistantMessage,
  LLMClient,
  LLMRequest,
  Message,
  ModelSpec,
  StopReason,
  StreamEvent,
  ToolDefinition,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@arcturn/types";
import type {
  ContentBlock,
  Message as ConverseMessage,
  ConverseStreamCommand,
  ConverseStreamCommandInput,
  ConverseStreamCommandOutput,
  ConverseStreamOutput,
  Tool as ConverseTool,
  ImageFormat,
  SystemContentBlock,
  TokenUsage,
  ToolConfiguration,
  ToolInputSchema,
  ToolResultContentBlock,
  ToolSpecification,
} from "@aws-sdk/client-bedrock-runtime";
import { AIErrorException, createAIError, parseRetryAfterMs, toAIError } from "../errors.js";
import { parseToolArguments } from "../internal/json.js";
import {
  assembleStream,
  completeFromStream,
  deferredEvents,
  type ProviderStreamEvent,
} from "../internal/stream.js";
import type { AnthropicClientLike } from "./anthropic.js";
import {
  ANTHROPIC_THINKING_BUDGETS,
  ANTHROPIC_THINKING_EFFORT,
  anthropicEventStream,
  anthropicThinkingStyle,
  REDACTED_THINKING_PREFIX,
} from "./anthropic.js";
import {
  BEDROCK_INFERENCE_PROFILE_PREFIXES,
  BEDROCK_PROVIDER_ID,
  type BedrockModelSpec,
} from "./bedrock-models.js";
import type { ProviderFactoryContext, ProviderPrecheckFailure } from "./registry.js";

// --------------------------------------------------------------------------
// Lazy SDK loading
// --------------------------------------------------------------------------

/** Deferred so importing this module never pays the AWS SDK's startup cost. */
let anthropicBedrockSdk: Promise<typeof import("@anthropic-ai/bedrock-sdk")> | undefined;
function loadAnthropicBedrockSdk(): Promise<typeof import("@anthropic-ai/bedrock-sdk")> {
  anthropicBedrockSdk ??= import("@anthropic-ai/bedrock-sdk");
  return anthropicBedrockSdk;
}

/** Deferred so importing this module never pays the AWS SDK's startup cost. */
let bedrockRuntimeSdk: Promise<typeof import("@aws-sdk/client-bedrock-runtime")> | undefined;
function loadBedrockRuntimeSdk(): Promise<typeof import("@aws-sdk/client-bedrock-runtime")> {
  bedrockRuntimeSdk ??= import("@aws-sdk/client-bedrock-runtime");
  return bedrockRuntimeSdk;
}

/** Deferred so importing this module never pays the AWS SDK's startup cost. */
let credentialProvidersSdk: Promise<typeof import("@aws-sdk/credential-providers")> | undefined;
function loadCredentialProvidersSdk(): Promise<typeof import("@aws-sdk/credential-providers")> {
  credentialProvidersSdk ??= import("@aws-sdk/credential-providers");
  return credentialProvidersSdk;
}

/** Environment variables consulted, in order, when no region is configured. */
export const BEDROCK_REGION_ENV_VARS: readonly string[] = ["AWS_REGION", "AWS_DEFAULT_REGION"];

/** A read-only environment map, defaulting to `process.env`. */
export type BedrockEnv = Record<string, string | undefined>;

/** Which wire protocol a Bedrock model id is served over. */
export type BedrockModelFamily = "anthropic" | "converse";

/**
 * `providerOptions` keys this adapter consumes itself. They are stripped
 * before the remainder is merged into the provider payload, so naming a region
 * never leaks an unknown field onto the wire.
 */
export const BEDROCK_RESERVED_OPTION_KEYS: readonly string[] = ["region", "family"];

const MIN_REASONING_BUDGET = 1_024;

/** Smithy's recursive JSON document type, as used by tool schemas and inputs. */
type BedrockDocument = ToolInputSchema.JsonMember["json"];

const PROFILE_PREFIXES: ReadonlySet<string> = new Set(BEDROCK_INFERENCE_PROFILE_PREFIXES);

const IMAGE_FORMATS: Readonly<Record<string, ImageFormat>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Minimal structural view of `BedrockRuntimeClient`, so tests can inject fakes. */
export interface BedrockRuntimeClientLike {
  send(
    command: ConverseStreamCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseStreamCommandOutput>;
}

/** Construction options for {@link createBedrockProvider}. */
export interface BedrockProviderOptions {
  /** Explicit AWS region; wins over the spec and the environment. */
  region?: string;
  /** Model spec whose `providerOptions.region` may pin a region. */
  spec?: ModelSpec;
  /** Environment used for region resolution. Defaults to `process.env`. */
  env?: BedrockEnv;
  /**
   * Bedrock bearer token (`AWS_BEARER_TOKEN_BEDROCK`). Optional: ambient AWS
   * credentials are the normal case. Only the Claude path uses it; the Converse
   * path always signs with SigV4.
   */
  apiKey?: string;
  /** Override the Bedrock endpoint (VPC endpoints, gateways, local mocks). */
  baseUrl?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Force a model family instead of inferring it from the model id. */
  family?: BedrockModelFamily;
  /** Pre-built Converse client; primarily an injection seam for tests. */
  converseClient?: BedrockRuntimeClientLike;
  /** Pre-built Claude-on-Bedrock client; primarily an injection seam for tests. */
  anthropicClient?: AnthropicClientLike;
}

// --------------------------------------------------------------------------
// Region and model-id resolution
// --------------------------------------------------------------------------

function processEnv(): BedrockEnv {
  const globalProcess = (globalThis as { process?: { env?: BedrockEnv } }).process;
  return globalProcess?.env ?? {};
}

function specRegion(spec: ModelSpec | undefined): string | undefined {
  const options = (spec as BedrockModelSpec | undefined)?.providerOptions;
  const region = options?.region;
  return typeof region === "string" && region !== "" ? region : undefined;
}

/** Where {@link resolveBedrockRegion} looks for a region. */
export interface BedrockRegionSource {
  region?: string;
  spec?: ModelSpec;
  env?: BedrockEnv;
}

/**
 * Resolve the AWS region for a Bedrock call.
 *
 * Precedence: an explicit region, `spec.providerOptions.region`, then
 * `AWS_REGION` and `AWS_DEFAULT_REGION`. Returns `undefined` when none apply —
 * Bedrock has no meaningful global endpoint, so guessing one would silently
 * bill the wrong account region.
 */
export function resolveBedrockRegion(source: BedrockRegionSource = {}): string | undefined {
  if (source.region) return source.region;
  const pinned = specRegion(source.spec);
  if (pinned) return pinned;
  const env = source.env ?? processEnv();
  for (const name of BEDROCK_REGION_ENV_VARS) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function missingRegionMessage(spec: ModelSpec | undefined): string {
  const model = spec ? ` for ${spec.id}` : "";
  return (
    `No AWS region for Bedrock${model}; set ${BEDROCK_REGION_ENV_VARS.join(" or ")}, ` +
    "or pin one with providerOptions.region on the model spec"
  );
}

/**
 * Reject a Bedrock model whose region cannot be determined.
 *
 * Deliberately does *not* require an API key or static access keys: profiles,
 * SSO sessions and IAM roles are the normal way to reach Bedrock, and none of
 * them are visible here.
 */
export function checkBedrockCredentials(
  ctx: ProviderFactoryContext,
  env?: BedrockEnv,
): ProviderPrecheckFailure | undefined {
  const source: BedrockRegionSource = { spec: ctx.spec };
  if (env) source.env = env;
  if (resolveBedrockRegion(source)) return undefined;
  return { kind: "invalidRequest", message: missingRegionMessage(ctx.spec) };
}

/**
 * Reduce a Bedrock model id to its bare form by dropping a provisioned or
 * inference-profile ARN wrapper and any geography prefix.
 *
 * `"arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"`
 * and `"us.anthropic.claude-sonnet-4-5-20250929-v1:0"` both reduce to
 * `"anthropic.claude-sonnet-4-5-20250929-v1:0"`.
 */
export function normalizeBedrockModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  const bare = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  const dot = bare.indexOf(".");
  if (dot > 0 && PROFILE_PREFIXES.has(bare.slice(0, dot))) return bare.slice(dot + 1);
  return bare;
}

/** Decide which wire protocol serves a Bedrock model id. */
export function bedrockModelFamily(modelId: string): BedrockModelFamily {
  return normalizeBedrockModelId(modelId).startsWith("anthropic.") ? "anthropic" : "converse";
}

/**
 * Extra cache-key material for the provider registry.
 *
 * Two regions must never share a client: the endpoint, the signing scope and
 * the set of available models all differ.
 */
export function bedrockCacheKey(spec: ModelSpec): string {
  return `${resolveBedrockRegion({ spec }) ?? ""}|${bedrockModelFamily(spec.model)}`;
}

function splitProviderOptions(options: Record<string, unknown> | undefined): {
  reserved: Record<string, unknown>;
  passthrough: Record<string, unknown>;
} {
  const reserved: Record<string, unknown> = {};
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (BEDROCK_RESERVED_OPTION_KEYS.includes(key)) reserved[key] = value;
    else passthrough[key] = value;
  }
  return { reserved, passthrough };
}

/** Drop adapter-only `providerOptions` so they never reach the wire payload. */
function withoutReservedOptions(request: LLMRequest): LLMRequest {
  if (!request.providerOptions) return request;
  const { passthrough } = splitProviderOptions(request.providerOptions);
  if (Object.keys(passthrough).length === 0) {
    const { providerOptions: _dropped, ...rest } = request;
    return rest;
  }
  return { ...request, providerOptions: passthrough };
}

// --------------------------------------------------------------------------
// Converse: Arcturn messages -> Converse payload
// --------------------------------------------------------------------------

function base64ToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function imageBlock(data: string, mimeType: string): ContentBlock | undefined {
  const format = IMAGE_FORMATS[mimeType.toLowerCase().trim()];
  if (!format) return undefined;
  return { image: { format, source: { bytes: base64ToBytes(data) } } };
}

function userContentBlocks(message: UserMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.trim() !== "") blocks.push({ text: part.text });
    } else {
      const image = imageBlock(part.data, part.mimeType);
      if (image) blocks.push(image);
    }
  }
  return blocks;
}

function assistantContentBlocks(message: AssistantMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of message.content) {
    if (part.type === "thinking") {
      const signature = part.signature ?? "";
      if (signature.startsWith(REDACTED_THINKING_PREFIX)) {
        blocks.push({
          reasoningContent: {
            redactedContent: base64ToBytes(signature.slice(REDACTED_THINKING_PREFIX.length)),
          },
        });
      } else if (signature !== "") {
        blocks.push({ reasoningContent: { reasoningText: { text: part.thinking, signature } } });
      }
      // Unsigned reasoning is dropped: Bedrock rejects a replayed block whose
      // signature it cannot verify.
    } else if (part.type === "text") {
      if (part.text.trim() !== "") blocks.push({ text: part.text });
    } else {
      blocks.push({
        toolUse: {
          toolUseId: part.id,
          name: part.name,
          input: part.arguments as BedrockDocument,
        },
      });
    }
  }
  return blocks;
}

function toolResultContent(message: ToolResultMessage): ToolResultContentBlock[] {
  const content: ToolResultContentBlock[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text !== "") content.push({ text: part.text });
    } else {
      const format = IMAGE_FORMATS[part.mimeType.toLowerCase().trim()];
      if (format) content.push({ image: { format, source: { bytes: base64ToBytes(part.data) } } });
    }
  }
  if (content.length === 0) content.push({ text: "(no tool output)" });
  return content;
}

function appendBlocks(
  target: ConverseMessage[],
  role: "user" | "assistant",
  blocks: ContentBlock[],
  toolResultsFirst = false,
): void {
  if (blocks.length === 0) return;
  const last = target[target.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    const existing = last.content;
    if (toolResultsFirst) {
      // Bedrock requires every toolResult block to precede other content.
      let insertAt = 0;
      while (insertAt < existing.length && existing[insertAt]?.toolResult !== undefined) insertAt++;
      existing.splice(insertAt, 0, ...blocks);
    } else {
      existing.push(...blocks);
    }
    return;
  }
  target.push({ role, content: blocks });
}

/**
 * Convert Arcturn messages to Converse `Message`s.
 *
 * Consecutive same-role turns are merged (Converse requires strict user /
 * assistant alternation), tool results are coalesced into a single user turn,
 * and blocks the API rejects (empty text, unsigned reasoning, unsupported image
 * types) are dropped.
 */
export function toConverseMessages(messages: Message[]): ConverseMessage[] {
  const out: ConverseMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      appendBlocks(out, "user", userContentBlocks(message));
    } else if (message.role === "assistant") {
      appendBlocks(out, "assistant", assistantContentBlocks(message));
    } else {
      appendBlocks(
        out,
        "user",
        [
          {
            toolResult: {
              toolUseId: message.toolCallId,
              content: toolResultContent(message),
              status: message.isError ? "error" : "success",
            },
          },
        ],
        true,
      );
    }
  }
  return out;
}

/** Convert a system prompt to Converse's `system` blocks. */
export function toConverseSystem(system: string | undefined): SystemContentBlock[] | undefined {
  if (system === undefined || system === "") return undefined;
  return [{ text: system }];
}

/** Convert tool definitions to Converse's `toolConfig`. */
export function toConverseToolConfig(
  tools: ToolDefinition[] | undefined,
): ToolConfiguration | undefined {
  if (!tools || tools.length === 0) return undefined;
  const converted: ConverseTool[] = tools.map((tool) => {
    const spec: ToolSpecification = {
      name: tool.name,
      inputSchema: { json: { ...tool.parameters, type: "object" } as BedrockDocument },
    };
    if (tool.description !== "") spec.description = tool.description;
    return { toolSpec: spec };
  });
  return { tools: converted };
}

/**
 * Build the Converse reasoning configuration.
 *
 * Claude on Bedrock normally never reaches here — it is served by the native
 * Messages API through {@link buildAnthropicRequest}, which owns the adaptive
 * branch — but a spec can be forced onto Converse with
 * `providerOptions.family`, so the same generation split applies.
 *
 * For adaptive-generation Claude, Bedrock's normalised `reasoning_config` has
 * no adaptive form, so the model-native fields go through
 * `additionalModelRequestFields`, which exists to pass model-specific request
 * parameters straight to the model. Every other reasoning model on Converse
 * (Nova, DeepSeek) keeps `reasoning_config` with a token budget.
 */
function reasoningConfig(
  request: LLMRequest,
  maxTokens: number,
): ConverseStreamCommandInput["additionalModelRequestFields"] | undefined {
  const level = request.thinking ?? "off";
  if (!request.model.capabilities.thinking || level === "off") return undefined;

  if (anthropicThinkingStyle(request.model) === "adaptive") {
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: ANTHROPIC_THINKING_EFFORT[level] },
    } as ConverseStreamCommandInput["additionalModelRequestFields"];
  }

  const budget = Math.min(ANTHROPIC_THINKING_BUDGETS[level], maxTokens - MIN_REASONING_BUDGET);
  if (budget < MIN_REASONING_BUDGET) return undefined;
  return {
    reasoning_config: { type: "enabled", budget_tokens: budget },
  } as ConverseStreamCommandInput["additionalModelRequestFields"];
}

/** Build the wire payload for a `ConverseStream` request. */
export function buildConverseRequest(request: LLMRequest): ConverseStreamCommandInput {
  const spec = request.model;
  const maxTokens = Math.min(request.maxOutputTokens ?? spec.maxOutputTokens, spec.maxOutputTokens);
  const { passthrough } = splitProviderOptions(request.providerOptions);

  const input: ConverseStreamCommandInput = {
    modelId: spec.model,
    messages: toConverseMessages(request.messages),
    inferenceConfig: { maxTokens },
  };

  const system = toConverseSystem(request.system);
  if (system) input.system = system;

  const toolConfig = toConverseToolConfig(request.tools);
  if (toolConfig) input.toolConfig = toolConfig;

  const reasoning = reasoningConfig(request, maxTokens);
  if (reasoning) {
    input.additionalModelRequestFields = reasoning;
  } else if (request.temperature !== undefined) {
    // Reasoning-enabled models reject an explicit temperature.
    input.inferenceConfig = { maxTokens, temperature: request.temperature };
  }

  return Object.assign(input, passthrough);
}

// --------------------------------------------------------------------------
// Converse: response stream -> provider events
// --------------------------------------------------------------------------

/** Map a Converse `stopReason` onto the portable {@link StopReason}. */
export function mapConverseStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "maxTokens";
    case "tool_use":
      return "toolCalls";
    case "content_filtered":
    case "guardrail_intervened":
    case "malformed_model_output":
    case "malformed_tool_use":
      return "error";
    default:
      return "endTurn";
  }
}

/** Convert Converse token accounting to the portable {@link Usage}. */
export function parseConverseUsage(usage: TokenUsage | undefined): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadInputTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteInputTokens ?? 0,
  };
}

/** In-band failures Converse reports as stream members rather than throwing. */
function streamMemberError(event: ConverseStreamOutput): AIError | undefined {
  if (event.throttlingException) {
    return createAIError("rateLimit", event.throttlingException.message ?? "Bedrock throttled");
  }
  if (event.validationException) {
    return createAIError(
      "invalidRequest",
      event.validationException.message ?? "Bedrock rejected the request",
    );
  }
  if (event.serviceUnavailableException) {
    return createAIError(
      "overloaded",
      event.serviceUnavailableException.message ?? "Bedrock is unavailable",
    );
  }
  if (event.internalServerException) {
    return createAIError(
      "overloaded",
      event.internalServerException.message ?? "Bedrock internal error",
    );
  }
  if (event.modelStreamErrorException) {
    return createAIError(
      "network",
      event.modelStreamErrorException.message ?? "Bedrock stream error",
    );
  }
  return undefined;
}

interface BlockState {
  kind: "text" | "thinking" | "toolCall";
  id: string;
  name: string;
  raw: string;
}

/** Translate a `ConverseStream` response into provider stream events. */
export async function* converseEventStream(
  client: BedrockRuntimeClientLike,
  request: LLMRequest,
): AsyncIterable<ProviderStreamEvent> {
  const blocks = new Map<number, BlockState>();
  let stopReason: StopReason = "endTurn";
  let errorMessage: string | undefined;
  let sawStop = false;

  try {
    const runtime = await loadBedrockRuntimeSdk();
    const command = new runtime.ConverseStreamCommand(buildConverseRequest(request));
    const response = await client.send(
      command,
      request.signal ? { abortSignal: request.signal } : undefined,
    );
    const stream = response.stream;
    if (!stream) {
      throw new AIErrorException({
        kind: "network",
        message: "Bedrock returned no ConverseStream body",
      });
    }

    for await (const event of stream) {
      const failure = streamMemberError(event);
      if (failure) throw new AIErrorException(failure);

      if (event.contentBlockStart) {
        const index = event.contentBlockStart.contentBlockIndex ?? 0;
        const toolUse = event.contentBlockStart.start?.toolUse;
        if (toolUse) {
          const id = toolUse.toolUseId ?? "";
          const name = toolUse.name ?? "";
          blocks.set(index, { kind: "toolCall", id, name, raw: "" });
          yield { type: "toolCallStart", blockIndex: index, id, name };
        }
        continue;
      }

      if (event.contentBlockDelta) {
        const index = event.contentBlockDelta.contentBlockIndex ?? 0;
        const delta = event.contentBlockDelta.delta;
        if (!delta) continue;

        if (delta.text !== undefined) {
          if (!blocks.has(index)) {
            blocks.set(index, { kind: "text", id: "", name: "", raw: "" });
            yield { type: "textStart", blockIndex: index };
          }
          yield { type: "textDelta", blockIndex: index, delta: delta.text };
          continue;
        }

        if (delta.reasoningContent) {
          if (!blocks.has(index)) {
            blocks.set(index, { kind: "thinking", id: "", name: "", raw: "" });
            yield { type: "thinkingStart", blockIndex: index };
          }
          const reasoning = delta.reasoningContent;
          if (reasoning.text !== undefined) {
            yield { type: "thinkingDelta", blockIndex: index, delta: reasoning.text };
          } else if (reasoning.signature !== undefined) {
            yield { type: "thinkingSignature", blockIndex: index, signature: reasoning.signature };
          } else if (reasoning.redactedContent) {
            yield {
              type: "thinkingSignature",
              blockIndex: index,
              signature: `${REDACTED_THINKING_PREFIX}${bytesToBase64(reasoning.redactedContent)}`,
              replace: true,
            };
          }
          continue;
        }

        if (delta.toolUse) {
          const fragment = delta.toolUse.input ?? "";
          const state = blocks.get(index);
          if (state?.kind === "toolCall") state.raw += fragment;
          yield { type: "toolCallDelta", blockIndex: index, argumentsDelta: fragment };
        }
        continue;
      }

      if (event.contentBlockStop) {
        const index = event.contentBlockStop.contentBlockIndex ?? 0;
        const state = blocks.get(index);
        if (state?.kind === "toolCall") {
          yield {
            type: "toolCallEnd",
            blockIndex: index,
            id: state.id,
            name: state.name,
            arguments: parseToolArguments(state.raw),
          };
        }
        blocks.delete(index);
        yield { type: "blockEnd", blockIndex: index };
        continue;
      }

      if (event.messageStop) {
        sawStop = true;
        const reason = event.messageStop.stopReason;
        stopReason = mapConverseStopReason(reason);
        if (stopReason === "error") errorMessage = `Provider stopped with: ${reason}`;
        continue;
      }

      if (event.metadata) {
        yield { type: "usage", usage: parseConverseUsage(event.metadata.usage) };
      }
    }
  } catch (err) {
    throw new AIErrorException(toBedrockError(err, request.signal), { cause: err });
  }

  if (!sawStop) {
    // A truncated event stream is a transport failure, so mark it retryable.
    throw new AIErrorException({
      kind: "network",
      message: "Bedrock stream ended before messageStop",
    });
  }
  yield errorMessage === undefined
    ? { type: "stop", stopReason }
    : { type: "stop", stopReason, errorMessage };
}

// --------------------------------------------------------------------------
// Error classification
// --------------------------------------------------------------------------

/**
 * AWS exception names mapped onto {@link AIError} kinds. Keys are lower-cased
 * because the SDK reports the name on `error.name` while the event stream
 * reports it on the member key.
 */
const BEDROCK_ERROR_KINDS: Readonly<Record<string, AIError["kind"]>> = {
  throttlingexception: "rateLimit",
  toomanyrequestsexception: "rateLimit",
  servicequotaexceededexception: "rateLimit",
  provisionedthroughputexceededexception: "rateLimit",
  accessdeniedexception: "auth",
  unrecognizedclientexception: "auth",
  expiredtokenexception: "auth",
  invalidsignatureexception: "auth",
  incompletesignatureexception: "auth",
  missingauthenticationtokenexception: "auth",
  credentialsprovidererror: "auth",
  validationexception: "invalidRequest",
  serializationexception: "invalidRequest",
  resourcenotfoundexception: "invalidRequest",
  internalserverexception: "overloaded",
  serviceunavailableexception: "overloaded",
  modelnotreadyexception: "overloaded",
  modelerrorexception: "overloaded",
  modelstreamerrorexception: "network",
  modeltimeoutexception: "network",
  timeouterror: "network",
  requesttimeout: "network",
  networkingerror: "network",
  aborterror: "aborted",
  requestabortederror: "aborted",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Normalise anything thrown by the AWS SDKs into an {@link AIError}.
 *
 * AWS reports the failure kind on `error.name` and the HTTP status under
 * `$metadata.httpStatusCode`, neither of which the shared classifier knows
 * about; anything unrecognised falls back to {@link toAIError}.
 *
 * @param err - The thrown value.
 * @param signal - Request signal; when aborted the error is reported as such.
 */
export function toBedrockError(err: unknown, signal?: AbortSignal): AIError {
  if (err instanceof AIErrorException) return err.toAIError();

  const source = asRecord(err);
  const name = typeof source?.name === "string" ? source.name.toLowerCase() : "";
  const mapped = BEDROCK_ERROR_KINDS[name];
  if (signal?.aborted || mapped === "aborted") {
    return createAIError("aborted", "The request was aborted");
  }

  const message =
    (typeof source?.message === "string" && source.message) ||
    (typeof err === "string" ? err : "") ||
    "Unknown Bedrock error";

  const metadata = asRecord(source?.$metadata);
  const rawStatus = metadata?.httpStatusCode;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const headers = asRecord(source?.$response)?.headers;
  const retryAfterMs = parseRetryAfterMs(headers);

  if (mapped) return createAIError(mapped, message, { status, retryAfterMs });

  // Reuse the shared status/header table for anything the name table misses.
  if (status !== undefined) return toAIError({ message, status, headers }, signal);
  // Smithy tags every service exception as a client or server fault.
  if (source?.$fault === "server") return createAIError("overloaded", message, { retryAfterMs });
  return toAIError(err, signal);
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

/**
 * Claude on Bedrock: the native Messages protocol, reused wholesale from the
 * Anthropic adapter so Claude behaves identically on both backends. Only the
 * error classification differs — Bedrock reports AWS exception names.
 */
export async function* bedrockAnthropicEventStream(
  client: AnthropicClientLike,
  request: LLMRequest,
): AsyncIterable<ProviderStreamEvent> {
  try {
    yield* anthropicEventStream(client, withoutReservedOptions(request));
  } catch (err) {
    throw new AIErrorException(toBedrockError(err, request.signal), { cause: err });
  }
}

/**
 * Create an {@link LLMClient} backed by Amazon Bedrock.
 *
 * Both underlying clients are built lazily so a missing region surfaces as a
 * terminal `error` event rather than a constructor throw, so an injected
 * fake never touches the AWS SDK, and so the SDKs themselves are only
 * imported on first use.
 *
 * @param options - Region, credentials and client injection seams.
 */
export function createBedrockProvider(options: BedrockProviderOptions = {}): LLMClient {
  let converse: Promise<BedrockRuntimeClientLike> | undefined = options.converseClient
    ? Promise.resolve(options.converseClient)
    : undefined;
  let claude: Promise<AnthropicClientLike> | undefined = options.anthropicClient
    ? Promise.resolve(options.anthropicClient)
    : undefined;

  const requireRegion = (): string => {
    const source: BedrockRegionSource = {};
    if (options.region !== undefined) source.region = options.region;
    if (options.spec !== undefined) source.spec = options.spec;
    if (options.env !== undefined) source.env = options.env;
    const region = resolveBedrockRegion(source);
    if (!region) {
      throw new AIErrorException({
        kind: "invalidRequest",
        message: missingRegionMessage(options.spec),
      });
    }
    return region;
  };

  const converseClient = (): Promise<BedrockRuntimeClientLike> => {
    if (converse) return converse;
    const region = requireRegion();
    converse = (async () => {
      const [runtime, credentials] = await Promise.all([
        loadBedrockRuntimeSdk(),
        loadCredentialProvidersSdk(),
      ]);
      return new runtime.BedrockRuntimeClient({
        region,
        credentials: credentials.fromNodeProviderChain(),
        ...(options.baseUrl ? { endpoint: options.baseUrl } : {}),
        // Retries are handled by streamWithRetry, which honours AbortSignal.
        maxAttempts: 1,
      }) as unknown as BedrockRuntimeClientLike;
    })();
    return converse;
  };

  const claudeClient = (): Promise<AnthropicClientLike> => {
    if (claude) return claude;
    const region = requireRegion();
    claude = (async () => {
      const [{ AnthropicBedrock }, { fromNodeProviderChain }] = await Promise.all([
        loadAnthropicBedrockSdk(),
        loadCredentialProvidersSdk(),
      ]);
      return new AnthropicBedrock({
        awsRegion: region,
        providerChainResolver: async () => fromNodeProviderChain(),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        ...(options.headers ? { defaultHeaders: options.headers } : {}),
        maxRetries: 0,
      }) as unknown as AnthropicClientLike;
    })();
    return claude;
  };

  const familyOf = (request: LLMRequest): BedrockModelFamily => {
    const { reserved } = splitProviderOptions(request.providerOptions);
    const requested = reserved.family;
    if (requested === "anthropic" || requested === "converse") return requested;
    if (options.family) return options.family;
    return bedrockModelFamily(request.model.model);
  };

  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return assembleStream(request.model, request.signal, () =>
        deferredEvents(async () =>
          familyOf(request) === "anthropic"
            ? bedrockAnthropicEventStream(await claudeClient(), request)
            : converseEventStream(await converseClient(), request),
        ),
      );
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };
}

export { BEDROCK_PROVIDER_ID };
