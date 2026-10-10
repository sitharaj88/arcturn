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
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  AssistantMessage,
  CompactionContent,
  InputTransformation,
  LLMClient,
  LLMRequest,
  Message,
  ModelSpec,
  ServerToolContent,
  StopDetails,
  StopReason,
  StreamEvent,
  SystemMessage,
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
 * What the API does with a replayed thinking block whose conversation prefix
 * changed since it was produced (`thinking.block_binding.prefix_mismatch_behavior`).
 * `"error"` rejects the request with a 400; `"drop_block"` drops that block and
 * every later one for this request only, and reports each drop in
 * `input_transformations`.
 */
export type AnthropicThinkingBinding = "error" | "drop_block";

/** The `block_binding` object that rides inside `thinking` under the controls beta. */
export interface AnthropicBlockBinding {
  prefix_mismatch_behavior: AnthropicThinkingBinding;
}

/**
 * A `thinking` value as sent on the wire.
 *
 * `between_tools` — Sonnet 5.5's "thinking off" — and `block_binding` postdate
 * the pinned SDK's `ThinkingConfigParam` (see NOTES.md), so they are spelled
 * out here. `between_tools` takes no other field, `block_binding` included.
 */
export type AnthropicThinkingParam =
  | (ThinkingConfigParam & { block_binding?: AnthropicBlockBinding })
  | { type: "between_tools" };

/** One server-side context-management edit (beta). */
export type AnthropicContextEdit =
  | { type: "clear_tool_uses_20250919"; exclude_tools?: string[] }
  | { type: "compact_20260112" };

/** The streaming Messages payload, with {@link AnthropicThinkingParam} in place. */
export type AnthropicRequestParams = Omit<MessageCreateParamsStreaming, "thinking"> & {
  thinking?: AnthropicThinkingParam;
  /** Server-side compaction / tool-result clearing; beta surface only. */
  context_management?: { edits: AnthropicContextEdit[] };
};

/** The beta header that gates `fallbacks: "default"`. */
export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The beta header that gates `thinking.block_binding` and `input_transformations`. */
export const ANTHROPIC_THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** The beta header that gates server-side compaction (`compact_20260112`). */
export const ANTHROPIC_COMPACTION_BETA = "compact-2026-01-12";

/** The beta header that gates server-side tool-result clearing (`clear_tool_uses_20250919`). */
export const ANTHROPIC_CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

/** The server-side tool search tool sent beside `defer_loading` tools. */
export const ANTHROPIC_TOOL_SEARCH_TOOL = {
  type: "tool_search_tool_bm25_20251119",
  name: "tool_search_tool_bm25",
} as const;

/**
 * The text a {@link SystemMessage} becomes when it cannot be sent as
 * `role: "system"` — on a model without mid-conversation system messages, or
 * at a position the API forbids one. The model reads it as harness text inside
 * the user turn; it loses only the operator authority.
 */
export function foldedSystemText(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

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

/**
 * Model ids a 400 has proven cannot take a mid-conversation `role: "system"`
 * message, for the rest of the process. Keyed by provider and wire model, so
 * a gateway that rejects it does not demote the first-party model.
 */
const SYSTEM_MESSAGES_REFUSED = new Set<string>();

function systemMessagesKey(spec: ModelSpec): string {
  return `${spec.provider}\u0000${spec.baseUrl ?? ""}\u0000${spec.model}`;
}

/**
 * Whether `spec` takes an appended `role: "system"` message.
 *
 * A model a 400 has refused is `false` from then on, whatever it declares.
 * Otherwise an explicit `capabilities.systemMessages` wins, and the family and
 * generation in the model id decide: Opus 4.8 and later, Fable and Mythos 5
 * and later, Sonnet 5.5 and later. Sonnet 5 is out — sources conflict on it,
 * so it folds rather than risks the 400 — and so is every id this does not
 * recognise.
 */
export function anthropicSystemMessages(spec: ModelSpec): boolean {
  if (SYSTEM_MESSAGES_REFUSED.has(systemMessagesKey(spec))) return false;
  const declared = spec.capabilities.systemMessages;
  if (declared !== undefined) return declared;
  const generation = claudeGeneration(spec.model);
  if (generation === undefined) return false;
  switch (claudeFamily(spec.model)) {
    case "opus":
      return generation >= 408;
    case "fable":
    case "mythos":
      return generation >= 500;
    case "sonnet":
      return generation >= 505;
    default:
      return false;
  }
}

/**
 * Record that `spec` rejected a mid-conversation system message, so every
 * later request folds it into the user turn instead. Exported for tests and
 * for hosts that learn it some other way.
 */
export function markSystemMessagesUnsupported(spec: ModelSpec): void {
  SYSTEM_MESSAGES_REFUSED.add(systemMessagesKey(spec));
}

/** Forget every {@link markSystemMessagesUnsupported} verdict. Tests only. */
export function resetSystemMessageSupport(): void {
  SYSTEM_MESSAGES_REFUSED.clear();
}

/**
 * True for the 400 a model without mid-conversation system messages answers
 * with: `role 'system' is not supported on this model`. The API types it as a
 * plain `invalid_request_error`, so the wording is the only discriminator.
 */
export function isSystemRoleUnsupportedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (status !== 400) return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" && /role\s*['"`]?system['"`]?\s*is not supported/i.test(message)
  );
}

/**
 * True for the 400 an enforced account answers when a replayed thinking block
 * no longer matches the conversation before it: "Invalid `signature` in
 * `thinking` block. The block is bound to a different conversation."
 */
export function isThinkingBindingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { status?: unknown }).status !== 400) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /bound to a different conversation/i.test(message);
}

/**
 * Clients that have answered {@link isThinkingBindingError} once. Arcturn keeps
 * its history append-only, so a mismatch means a bug (or a head that differs
 * from the one a resumed session's thinking was produced under); a session that
 * cannot send its next request is worse than one that loses some reasoning and
 * says so, so requests on such a client ask the provider to drop instead.
 */
const BINDING_RECOVERY = new WeakSet<object>();

/** The messages without any thinking block, for an endpoint with no binding controls. */
function withoutThinkingBlocks(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }
    const content = message.content.filter((block) => block.type !== "thinking");
    if (content.length > 0) out.push({ ...message, content });
  }
  return out;
}

/**
 * Whether a model can take the first-party server-side tool search
 * (`tool_search_tool_bm25_20251119` beside `defer_loading` tools): Claude 4.5
 * and later. Unknown ids say no.
 */
export function anthropicToolSearch(spec: ModelSpec): boolean {
  const generation = claudeGeneration(spec.model);
  return generation !== undefined && generation >= 405;
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
   * The beta Messages surface, used whenever a request needs a beta: opted-in
   * refusal fallbacks, thinking-binding controls, server-side compaction or
   * tool-result clearing. Its stream is a superset of the GA one (`fallback`
   * and `compaction` blocks, `usage.iterations`, `input_transformations`),
   * read defensively. Bedrock and Vertex clients omit it.
   */
  beta?: {
    messages: {
      create(
        params: AnthropicRequestParams & { betas: string[]; fallbacks?: "default" },
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
  /**
   * Opt in to the thinking-binding controls (beta
   * `thinking-binding-controls-2026-08-01`). Every request whose thinking is
   * on carries `thinking.block_binding.prefix_mismatch_behavior` set to this,
   * and the response's `input_transformations` lands on the message — core
   * turns each entry into a `notice`. `"error"` makes any history edit fail
   * the request (what CI wants); `"drop_block"` degrades instead. Setting it
   * also opts an older account into enforcement. Off by default; Claude API
   * only here (the Bedrock and Vertex clients have no beta surface).
   */
  thinkingBinding?: AnthropicThinkingBinding;
}

/** Per-stream options for {@link anthropicEventStream}. */
export interface AnthropicStreamOptions {
  /** See {@link AnthropicProviderOptions.fallbacks}. */
  fallbacks?: "default";
  /** See {@link AnthropicProviderOptions.thinkingBinding}. */
  thinkingBinding?: AnthropicThinkingBinding;
}

/** Options for {@link buildAnthropicRequest} beyond the portable request. */
export interface AnthropicBuildOptions {
  /** See {@link AnthropicProviderOptions.thinkingBinding}. */
  thinkingBinding?: AnthropicThinkingBinding;
  /**
   * Send `SystemMessage`s as `role: "system"`. Defaults to
   * {@link anthropicSystemMessages} for the spec; `false` folds every one into
   * the user turn (the retry after a 400).
   */
  systemMessages?: boolean;
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

function assistantBlocks(message: AssistantMessage, serverTools: boolean): ContentBlockParam[] {
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
    } else if (part.type === "toolCall") {
      blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments });
    } else if (part.type === "compaction") {
      // Replayed verbatim: the server swaps everything before it for its own
      // summary, and the thinking-binding check restarts here.
      blocks.push(compactionBlockParam(part));
    } else if (part.provider === "anthropic" && serverTools) {
      // A server tool's own block (native tool search): the model produced it
      // in this turn, so the turn goes back exactly as it came.
      blocks.push(part.block as unknown as ContentBlockParam);
    }
    // Another provider's server-tool block means nothing here and is dropped —
    // and so is this provider's own when the request does not carry the tool
    // that made it (the conversation moved to a model or endpoint without the
    // server's search): a server tool's history means nothing without its tool.
  }
  return blocks;
}

/** The wire form of a stored {@link CompactionContent}, byte for byte. */
function compactionBlockParam(part: CompactionContent): ContentBlockParam {
  return {
    type: "compaction",
    content: part.summary,
    encrypted_content: part.encryptedContent,
  } as unknown as ContentBlockParam;
}

/** True when any assistant message replays a server compaction block. */
function carriesCompaction(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" && message.content.some((part) => part.type === "compaction"),
  );
}

function systemBlocks(message: SystemMessage): TextBlockParam[] {
  const blocks: TextBlockParam[] = [];
  for (const part of message.content) {
    if (part.text.trim() !== "") blocks.push({ type: "text", text: part.text });
  }
  return blocks;
}

/** A system message's text, folded into a user turn. */
function foldedSystemBlocks(blocks: readonly TextBlockParam[]): TextBlockParam[] {
  return blocks.map((block) => ({ type: "text", text: foldedSystemText(block.text) }));
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
  role: "user" | "assistant" | "system",
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

/** Options for {@link toAnthropicMessages}. */
export interface AnthropicMessageOptions {
  /**
   * Send `SystemMessage`s as `role: "system"` where the API allows one.
   * `false` (the default) folds every one into the user turn.
   */
  systemMessages?: boolean;
  /**
   * Replay the server tools' own blocks (native tool search) stored in
   * assistant turns. Defaults to `true`; a request that does not carry the
   * server tool sets it `false`, and they are dropped.
   */
  serverTools?: boolean;
}

/**
 * Convert Arcturn messages to Anthropic `MessageParam`s.
 *
 * Consecutive same-role turns are merged, tool results are coalesced into a
 * single user turn, and blocks the API rejects (empty text, unsigned thinking,
 * unsupported image types) are dropped.
 *
 * A {@link SystemMessage} becomes an appended `role: "system"` message when
 * `options.systemMessages` is on **and** the API's placement rules allow it
 * there: it must follow a user turn, must be the last message or be followed
 * by an assistant turn, and can never be `messages[0]`. Anywhere else — and on
 * a model without the feature — it is folded into the neighbouring user turn
 * as a `<system-reminder>` text block (merging with that turn, or standing as
 * a user turn of its own when it has no user neighbour). The fold is decided
 * from the converted sequence alone, so the same history always renders the
 * same bytes: a system message sent last as `role: "system"` is followed by
 * the model's own reply on the next request and stays a system message. The
 * one move this cannot make stable is an aborted turn that left nothing behind
 * it, after which a user prompt follows it directly — that request folds it,
 * which costs a cache miss but no thinking, since nothing was produced over it.
 */
export function toAnthropicMessages(
  messages: Message[],
  options: AnthropicMessageOptions = {},
): MessageParam[] {
  const staged: MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      appendBlocks(staged, "user", userBlocks(message));
    } else if (message.role === "assistant") {
      // A declined turn's partial output is discarded, not replayed: it is an
      // abandoned attempt, and its thinking belongs to a request that was
      // refused. The loop never leaves tool calls in one, so nothing dangles.
      if (message.stopReason === "refusal") continue;
      appendBlocks(staged, "assistant", assistantBlocks(message, options.serverTools ?? true));
    } else if (message.role === "system") {
      appendBlocks(staged, "system", systemBlocks(message));
    } else {
      appendBlocks(staged, "user", [toolResultBlock(message)], true);
    }
  }

  const out: MessageParam[] = [];
  for (let index = 0; index < staged.length; index++) {
    const entry = staged[index]!;
    if (entry.role !== "system") {
      const blocks = entry.content as ContentBlockParam[];
      // A folded reminder may already sit in this user turn; tool results
      // must still lead it.
      appendBlocks(
        out,
        entry.role,
        blocks.filter((block) => block.type === "tool_result"),
        true,
      );
      appendBlocks(
        out,
        entry.role,
        blocks.filter((block) => block.type !== "tool_result"),
      );
      continue;
    }
    const blocks = entry.content as TextBlockParam[];
    const before = staged[index - 1];
    const after = staged[index + 1];
    const placeable =
      options.systemMessages === true &&
      before?.role === "user" &&
      (after === undefined || after.role === "assistant");
    if (placeable) out.push({ role: "system", content: blocks });
    else appendBlocks(out, "user", foldedSystemBlocks(blocks));
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

/**
 * Attach `block_binding` to the thinking a request already carries.
 *
 * Only `adaptive` and `enabled` take it. Where "off" was spelled by leaving
 * `thinking` out on a model that cannot stop thinking (`lowEffort`), the
 * explicit `{type: "adaptive"}` it then runs anyway is sent so the binding has
 * somewhere to ride; `disabled` and `between_tools` (which takes no other
 * field) carry nothing to bind.
 */
function withBlockBinding(
  spec: ModelSpec,
  level: ThinkingLevel,
  thinking: AnthropicThinkingParam | undefined,
  binding: AnthropicThinkingBinding,
): AnthropicThinkingParam | undefined {
  const block_binding: AnthropicBlockBinding = { prefix_mismatch_behavior: binding };
  if (thinking === undefined) {
    if (level === "off" && anthropicThinkingOff(spec) === "lowEffort") {
      return { type: "adaptive", block_binding };
    }
    return undefined;
  }
  if (thinking.type === "adaptive" || thinking.type === "enabled") {
    return { ...thinking, block_binding };
  }
  return thinking;
}

/**
 * The `tools` array for a request.
 *
 * With native tool search ({@link ToolDefinition.deferLoading} on any tool),
 * every tool is sent from the first request — the deferred ones with
 * `defer_loading: true` — plus the server's BM25 search tool, so activating a
 * tool never changes the set. The API refuses a request whose every tool is
 * deferred, so when nothing else is loaded the first tool is.
 */
function anthropicTools(request: LLMRequest, caching: boolean): ToolUnion[] | undefined {
  const definitions = request.tools ?? [];
  if (definitions.length === 0) return undefined;
  const native = definitions.some((tool) => tool.deferLoading === true);
  const keepLoaded = native && definitions.every((tool) => tool.deferLoading === true) ? 0 : -1;
  const tools: ToolUnion[] = definitions.map((tool, index) => {
    const wire: AnthropicTool = {
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.parameters, type: "object" } as AnthropicTool["input_schema"],
      // Fine-grained tool streaming: deliver each argument as it is generated
      // instead of buffering the whole JSON server-side. A per-tool field on
      // every model, with no beta header; the accumulated string may be
      // partial or invalid JSON, which parseToolArguments already tolerates.
      // https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
      eager_input_streaming: true,
    };
    if (tool.deferLoading === true && index !== keepLoaded) wire.defer_loading = true;
    return wire;
  });
  if (native) tools.push({ ...ANTHROPIC_TOOL_SEARCH_TOOL });
  const last = tools[tools.length - 1];
  // A breakpoint on the final tool caches the whole tool prefix.
  if (caching && last)
    (last as { cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" };
  return tools;
}

/** Build the wire payload for a streaming Messages request. */
export function buildAnthropicRequest(
  request: LLMRequest,
  options: AnthropicBuildOptions = {},
): AnthropicRequestParams {
  const spec = request.model;
  const caching = spec.capabilities.caching;
  const maxTokens = Math.min(request.maxOutputTokens ?? spec.maxOutputTokens, spec.maxOutputTokens);
  const messages = toAnthropicMessages(request.messages, {
    systemMessages: options.systemMessages ?? anthropicSystemMessages(spec),
    // The server's search blocks only mean something beside its search tool,
    // which goes out exactly when a tool is deferred.
    serverTools: (request.tools ?? []).some((tool) => tool.deferLoading === true),
  });
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

  const tools = anthropicTools(request, caching);
  if (tools) params.tools = tools;

  const level = request.thinking ?? "off";
  const thinking = anthropicThinkingParams(spec, level, maxTokens);
  const thinkingParam =
    options.thinkingBinding === undefined || !spec.capabilities.thinking
      ? thinking?.thinking
      : withBlockBinding(spec, level, thinking?.thinking, options.thinkingBinding);
  if (thinkingParam) params.thinking = thinkingParam;
  if (thinking?.effort) params.output_config = { effort: thinking.effort };

  const edits: AnthropicContextEdit[] = [];
  if (request.contextManagement?.clearToolUses) {
    const protect = request.contextManagement.protectTools ?? [];
    edits.push({
      type: "clear_tool_uses_20250919",
      ...(protect.length === 0 ? {} : { exclude_tools: [...protect] }),
    });
  }
  if (request.contextManagement?.compact) edits.push({ type: "compact_20260112" });
  if (edits.length > 0) params.context_management = { edits };
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
    case "pause_turn":
      return "pauseTurn";
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

/** A block arcturn carries rather than interprets, while it streams. */
type RawBlockState =
  | { kind: "compaction"; summary: string | null; encryptedContent: string | null }
  | { kind: "serverTool"; block: Record<string, unknown>; json: string };

function finishRawBlock(state: RawBlockState): CompactionContent | ServerToolContent {
  if (state.kind === "compaction") {
    return { type: "compaction", summary: state.summary, encryptedContent: state.encryptedContent };
  }
  const block = { ...state.block };
  // A server_tool_use streams its input like a tool_use does; the start event
  // carries an empty object.
  if (state.json !== "") block.input = parseToolArguments(state.json);
  return { type: "serverTool", provider: "anthropic", block };
}

/**
 * The portable form of a response's `input_transformations`, or `undefined`
 * when the field is absent or carries nothing. Entries without a string
 * `type` are skipped; unknown types and reasons are kept, for consumers to
 * ignore.
 */
export function toInputTransformations(raw: unknown): InputTransformation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: InputTransformation[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type, path, reason } = entry as { type?: unknown; path?: unknown; reason?: unknown };
    if (typeof type !== "string") continue;
    out.push({
      type,
      path: typeof path === "string" ? path : "",
      reason: typeof reason === "string" ? reason : "",
    });
  }
  return out.length > 0 ? out : undefined;
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
  const requestOptions = request.signal ? { signal: request.signal } : undefined;
  const fallbacks =
    options.fallbacks === "default" && request.model.capabilities.refusalFallback === true;
  // The binding controls ride the beta surface; a client without one (Bedrock,
  // Vertex) simply does not get them.
  const recovering = BINDING_RECOVERY.has(client);
  const thinkingBinding =
    client.beta === undefined
      ? undefined
      : (options.thinkingBinding ?? (recovering ? "drop_block" : undefined));
  const buildParams = (
    systemMessages?: boolean,
    req: LLMRequest = request,
  ): AnthropicRequestParams =>
    buildAnthropicRequest(req, {
      ...(thinkingBinding === undefined ? {} : { thinkingBinding }),
      ...(systemMessages === undefined ? {} : { systemMessages }),
    });
  const betas: string[] = [];
  if (fallbacks) betas.push(ANTHROPIC_FALLBACK_BETA);
  if (thinkingBinding !== undefined) betas.push(ANTHROPIC_THINKING_BINDING_BETA);
  if (request.contextManagement?.compact || carriesCompaction(request.messages)) {
    betas.push(ANTHROPIC_COMPACTION_BETA);
  }
  if (request.contextManagement?.clearToolUses) betas.push(ANTHROPIC_CONTEXT_MANAGEMENT_BETA);
  const needsServer =
    request.contextManagement?.compact || request.contextManagement?.clearToolUses;
  if (needsServer && client.beta === undefined) {
    throw new AIErrorException({
      kind: "invalidRequest",
      message:
        `Server-side context management is not available for ${request.model.id}: this ` +
        "endpoint has no beta Messages surface. Set compaction.shape and contextEditing.mode " +
        'to a local value ("simple", "keep-tail", "local") for this model.',
    });
  }
  const beta = betas.length > 0 ? client.beta : undefined;
  const send = (params: AnthropicRequestParams, extraBetas: readonly string[] = []) => {
    const all = [...betas, ...extraBetas.filter((b) => !betas.includes(b))];
    const surface = all.length > 0 ? client.beta : undefined;
    return surface
      ? surface.messages.create(
          { ...params, betas: all, ...(fallbacks ? { fallbacks: "default" as const } : {}) },
          requestOptions,
        )
      : client.messages.create(params, requestOptions);
  };

  const nativeSystem = anthropicSystemMessages(request.model);
  let stream: AsyncIterable<RawMessageStreamEvent>;
  try {
    stream = await send(buildParams());
  } catch (error) {
    if (
      nativeSystem &&
      request.messages.some((m) => m.role === "system") &&
      isSystemRoleUnsupportedError(error)
    ) {
      // A model that turns out not to take `role: "system"` answers 400 before
      // any output. Believe it for the rest of the process and send this one
      // again with every system message folded into its user turn — once.
      markSystemMessagesUnsupported(request.model);
      stream = await send(buildParams(false));
    } else if (
      options.thinkingBinding === undefined &&
      !recovering &&
      isThinkingBindingError(error)
    ) {
      // An enforced account refused a replayed thinking block. Retry once with
      // the provider dropping the blocks it cannot honour, which also reports
      // exactly which (`input_transformations`, surfaced as a notice naming a
      // bug in arcturn); without the controls, send the history minus its
      // thinking — the documented one-time recovery.
      BINDING_RECOVERY.add(client);
      if (client.beta === undefined) {
        stream = await send(
          buildParams(undefined, {
            ...request,
            messages: withoutThinkingBlocks(request.messages),
          }),
        );
      } else {
        const withBinding = buildAnthropicRequest(request, {
          thinkingBinding: "drop_block",
          systemMessages: nativeSystem,
        });
        stream = await send(withBinding, [ANTHROPIC_THINKING_BINDING_BETA]);
      }
    } else {
      throw error;
    }
  }

  const tools = new Map<number, ToolState>();
  // Server-tool and compaction blocks, assembled whole and handed over at
  // their `content_block_stop` so the message carries them verbatim.
  const raw = new Map<number, RawBlockState>();
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
        const transformations = toInputTransformations(
          (event.message as { input_transformations?: unknown }).input_transformations,
        );
        if (transformations !== undefined) yield { type: "inputTransformations", transformations };
        break;
      }
      case "content_block_start": {
        const index = event.index;
        const block = event.content_block;
        const kind = (block as { type: string }).type;
        if (kind === "compaction") {
          const start = block as unknown as {
            content?: string | null;
            encrypted_content?: string | null;
          };
          raw.set(index, {
            kind: "compaction",
            summary: start.content ?? null,
            encryptedContent: start.encrypted_content ?? null,
          });
          break;
        }
        if (kind === "server_tool_use" || kind.endsWith("_tool_result")) {
          raw.set(index, {
            kind: "serverTool",
            block: { ...(block as unknown as Record<string, unknown>) },
            json: "",
          });
          break;
        }
        if (kind === "fallback") {
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
        const pending = raw.get(index);
        if (pending !== undefined) {
          const loose = delta as unknown as {
            type: string;
            partial_json?: string;
            content?: string | null;
            encrypted_content?: string | null;
          };
          if (pending.kind === "serverTool" && loose.type === "input_json_delta") {
            pending.json += loose.partial_json ?? "";
          } else if (pending.kind === "compaction" && loose.type === "compaction_delta") {
            // Accumulated the way the SDK's own stream helper does: summary
            // text appends, the opaque state is the latest one sent.
            if (typeof loose.content === "string") {
              pending.summary = (pending.summary ?? "") + loose.content;
            }
            if (loose.encrypted_content !== undefined) {
              pending.encryptedContent = loose.encrypted_content;
            }
          }
          break;
        }
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
        const pending = raw.get(index);
        if (pending !== undefined) {
          raw.delete(index);
          yield { type: "rawBlock", blockIndex: index, content: finishRawBlock(pending) };
          break;
        }
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
        // Sent again here after a mid-stream server-side fallback; read from
        // the event and its delta alike, since only the message_start home of
        // the field is documented.
        const transformations = toInputTransformations(
          (event as { input_transformations?: unknown }).input_transformations ??
            (event.delta as { input_transformations?: unknown }).input_transformations,
        );
        if (transformations !== undefined) yield { type: "inputTransformations", transformations };
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
          anthropicEventStream(await getClient(), request, {
            ...(options.fallbacks === undefined ? {} : { fallbacks: options.fallbacks }),
            ...(options.thinkingBinding === undefined
              ? {}
              : { thinkingBinding: options.thinkingBinding }),
          }),
        ),
      );
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };
}
