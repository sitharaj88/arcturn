/**
 * Context editing: prune stale tool-result *content* before an LLM request,
 * keeping the message structure byte-for-byte intact.
 *
 * Compaction (see `./compaction.ts`) is the expensive, late intervention: it
 * calls the model to summarize the head of the conversation and rewrites
 * history. Context editing is the cheap, early one. It walks old
 * {@link ToolResultMessage}s and swaps their content for a one-line stub that
 * names the tool, how big the result was, and where the full output lives when
 * it was offloaded to disk. Nothing is added or removed from the array, so
 * every `toolCall`/`toolResult` pair stays matched and the model can simply
 * re-run the tool (or read the offloaded file) when it needs the data back.
 *
 * ## Prefix stability (the whole design constraint)
 *
 * The Anthropic provider marks `cache_control` on the last message it sends,
 * so the cached prefix is only reused when every earlier message is byte
 * identical to the previous request — and on the preserved-thinking models
 * (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) every replayed thinking block
 * is bound to that prefix too, so rewriting an already-sent message is a 400
 * on an enforced account, not just a cache miss.
 *
 * {@link editContext} alone does not deliver that, despite what this comment
 * used to claim. Its decisions are monotonic — once a position is elided it is
 * elided identically for ever after — but the `keepRecentTurns` boundary moves
 * forward every turn, so each request stubs out a result the previous request
 * had sent in full. Monotonic is not append-only.
 *
 * The agent therefore edits in **passes** ({@link planContextEditPass} plus a
 * {@link ContextEditLedger}). A pass is a deliberate, recorded prefix edit:
 * it elides everything then eligible, in one go, and — where thinking is bound
 * to the prefix — stops replaying the thinking of every assistant message
 * after the first result it touched, since those blocks were produced over
 * the unedited results. Between passes the outgoing history is append-only:
 * the ledger re-sends the same stubs, byte for byte, and lets new results
 * through untouched. A pass only fires once it would save `minCharsPerPass`,
 * so it is a rare event — one cache reset per batch — rather than a rewrite
 * per request. Each pass is written to the session as a `state` entry, so a
 * resume replays exactly the request the live agent sent.
 *
 * Where the provider can do it server-side (Anthropic
 * `clear_tool_uses_20250919`), `mode: "server"` sends the history unedited
 * and lets the provider clear old results — which is not a history edit at
 * all, because the provider checks the conversation as it was sent.
 *
 * The per-request rules below still decide *which* results a pass may touch.
 * They hold given the one caller-side rule that history is **append-only**
 * between calls (which is how the agent loop works — messages are only ever
 * pushed onto the end):
 *
 * 1. **The boundary only advances.** Eligibility is `index <
 *    findElisionBoundary(messages, keepRecentTurns)`, and the boundary is the
 *    index of the `keepRecentTurns`-th assistant message counted from the end.
 *    Appending a non-assistant message leaves every assistant index alone, so
 *    the boundary is unchanged; appending an assistant message pushes the
 *    Nth-from-last forward, so the boundary strictly increases. It can never
 *    move backwards, so a message inside the eligible region stays inside it.
 * 2. **The per-message decision is local.** Whether an eligible message is
 *    elided depends only on that message (its tool name, its own size, its
 *    error flag) — never on totals, rank, or a budget shared with other
 *    messages. Growth elsewhere in the history cannot flip it.
 * 3. **The trigger is monotone and computed on unedited input.** The
 *    `maxTotalToolResultChars` trigger is measured over the *raw* history,
 *    whose cumulative tool-result size only grows as turns are appended. Once
 *    it fires it keeps firing, so editing turns on exactly once and never
 *    toggles back off. This is why callers must always pass the raw
 *    conversation and use the returned array only for the outgoing request —
 *    feeding the edited output back in as history would make the trigger
 *    depend on the previous decision. ({@link editContext} is idempotent
 *    anyway: stubs it produced are marked and never re-elided.)
 *
 * The one event that legitimately breaks the prefix is compaction, which
 * rewrites history wholesale — the cache is already gone at that point.
 */

import type {
  ContextEditRecord,
  Message,
  ModelSpec,
  ToolResultContent,
  ToolResultMessage,
} from "@arcturn/types";
import { isAdaptiveAnthropic } from "./model-traits.js";
import { text, withoutThinking } from "./util/content.js";

/**
 * Where old tool results are cleared.
 *
 * - `"local"` — arcturn stubs them out of the outgoing request, in recorded
 *   passes (see the module comment).
 * - `"server"` — the provider clears them (Anthropic `clear_tool_uses_20250919`)
 *   and the request goes out unedited. Refused by providers that lack it.
 * - `"auto"` — `"server"` on a Claude model with adaptive thinking reached
 *   through the Anthropic Messages API, `"local"` everywhere else.
 */
export type ContextEditMode = "local" | "server" | "auto";

/** Every {@link ContextEditMode}, for validators. */
export const CONTEXT_EDIT_MODES: readonly ContextEditMode[] = ["local", "server", "auto"];

/** Characters a pass must save before it is worth one cache reset. */
export const DEFAULT_MIN_CHARS_PER_PASS = 50_000;

/** Trailing assistant turns whose tool results are always kept in full. */
export const DEFAULT_KEEP_RECENT_TURNS = 3;

/** Tool results smaller than this are never worth stubbing out. */
export const DEFAULT_MIN_CHARS_TO_ELIDE = 1_000;

/** Cumulative tool-result characters that must be exceeded before editing starts. */
export const DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS = 100_000;

/**
 * Tools whose results *are* the state the model reasons over rather than a
 * lookup it can repeat, so eliding them would lose information for good.
 */
export const DEFAULT_PROTECTED_TOOL_NAMES: readonly string[] = ["todo", "plan"];

/** Marker written onto {@link ToolResultMessage.details} for an elided result. */
export const ELIDED_DETAIL_KEY = "contextElided";

/** Everything the stub renderer knows about one elision. */
export interface ElisionInfo {
  /** Tool that produced the original result. */
  toolName: string;
  /** Size of the replaced content, in characters. */
  originalChars: number;
  /** Whether the original result was an error. */
  isError: boolean;
  /** Path the full output was offloaded to, when the offload feature saved it. */
  offloadPath?: string;
}

/** Tuning knobs for context editing. */
export interface ContextEditOptions {
  /** Set to `false` to disable context editing. Defaults to `true`. */
  enabled?: boolean;
  /** Trailing assistant turns kept verbatim. Defaults to 3. */
  keepRecentTurns?: number;
  /** Smallest result worth eliding, in characters. Defaults to 1000. */
  minCharsToElide?: number;
  /** Editing only starts once raw tool results exceed this. Defaults to 100000. */
  maxTotalToolResultChars?: number;
  /** Tools that are never elided. Defaults to `["todo", "plan"]`. */
  protectToolNames?: readonly string[];
  /** Replace the stub text entirely. */
  renderStub?: (info: ElisionInfo) => string;
  /**
   * Characters a local elision pass must save before it runs. Each pass is a
   * deliberate prefix edit — one cache reset, and on adaptive Claude the loss
   * of the thinking it invalidates — so passes are batched. Defaults to 50000.
   */
  minCharsPerPass?: number;
  /** Where results are cleared; see {@link ContextEditMode}. Defaults to `"local"`. */
  mode?: ContextEditMode;
}

/** Resolved context-editing settings. */
export interface ResolvedContextEditOptions {
  enabled: boolean;
  keepRecentTurns: number;
  minCharsToElide: number;
  maxTotalToolResultChars: number;
  protectToolNames: readonly string[];
  renderStub: (info: ElisionInfo) => string;
  minCharsPerPass: number;
  mode: ContextEditMode;
}

/**
 * Fill in context-editing defaults.
 *
 * The result is structurally a {@link ContextEditOptions}, so it can be passed
 * straight back to {@link shouldEditContext}.
 *
 * @param options - Partial user options.
 */
export function resolveContextEditOptions(
  options: ContextEditOptions = {},
): ResolvedContextEditOptions {
  return {
    enabled: options.enabled ?? true,
    keepRecentTurns: options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS,
    minCharsToElide: options.minCharsToElide ?? DEFAULT_MIN_CHARS_TO_ELIDE,
    maxTotalToolResultChars: options.maxTotalToolResultChars ?? DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS,
    protectToolNames: options.protectToolNames ?? DEFAULT_PROTECTED_TOOL_NAMES,
    renderStub: options.renderStub ?? renderElisionStub,
    minCharsPerPass: options.minCharsPerPass ?? DEFAULT_MIN_CHARS_PER_PASS,
    mode: options.mode ?? "local",
  };
}

/**
 * Where old tool results are cleared for `model`, and why — for `arcturn doctor`.
 *
 * @param options - Context-editing options; only `enabled` and `mode` matter.
 * @param model - The model the session talks to.
 */
export function explainContextEditMode(
  options: Pick<ContextEditOptions, "enabled" | "mode">,
  model: ModelSpec,
): { mode: "local" | "server" | "off"; reason: string } {
  if (options.enabled === false) return { mode: "off", reason: "contextEditing.enabled is false" };
  const mode = options.mode ?? "local";
  if (mode === "server") return { mode: "server", reason: "set by contextEditing.mode" };
  if (mode === "local") {
    return {
      mode: "local",
      reason: options.mode === undefined ? "default" : "set by contextEditing.mode",
    };
  }
  const firstParty = model.provider === "anthropic" || model.provider === "anthropic-compatible";
  if (firstParty && isAdaptiveAnthropic(model)) {
    return {
      mode: "server",
      reason: "contextEditing.mode auto: Claude with adaptive thinking on the Messages API",
    };
  }
  return {
    mode: "local",
    reason: "contextEditing.mode auto: this model has no server-side tool-result clearing",
  };
}

/**
 * Resolve {@link ContextEditMode} `"auto"` against a model.
 *
 * @param options - Context-editing options; only `mode` matters.
 * @param model - The model the next request goes to.
 */
export function resolveContextEditMode(
  options: Pick<ContextEditOptions, "mode">,
  model: ModelSpec,
): "local" | "server" {
  const explained = explainContextEditMode({ mode: options.mode ?? "local" }, model);
  return explained.mode === "server" ? "server" : "local";
}

/**
 * Measure the context cost of one tool result's content.
 *
 * Text counts its characters; an image counts the length of its base64 payload,
 * which is what actually travels to the provider.
 *
 * @param content - Tool result content blocks.
 */
export function toolResultChars(content: readonly ToolResultContent[]): number {
  let total = 0;
  for (const block of content) {
    total += block.type === "text" ? block.text.length : block.data.length;
  }
  return total;
}

/**
 * Sum the size of every tool result in a conversation.
 *
 * @param messages - Conversation history, oldest first.
 */
export function totalToolResultChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === "toolResult") total += toolResultChars(message.content);
  }
  return total;
}

/**
 * Whether a message is a tool result this module already elided.
 *
 * @param message - Message to inspect.
 */
export function isElided(message: Message): boolean {
  return message.role === "toolResult" && message.details?.[ELIDED_DETAIL_KEY] === true;
}

/**
 * Find the first index whose tool results must be kept in full.
 *
 * Counting the `keepRecentTurns`-th assistant message from the end makes the
 * boundary a pure function of turn distance, which is what makes elision
 * monotonic under append — see the module doc comment.
 *
 * @param messages - Conversation history, oldest first.
 * @param keepRecentTurns - Trailing assistant turns to protect.
 * @returns The index of the first protected message; `0` when the conversation
 *   is too short to protect that many turns, `messages.length` when
 *   `keepRecentTurns` is zero or negative.
 */
export function findElisionBoundary(
  messages: readonly Message[],
  keepRecentTurns: number = DEFAULT_KEEP_RECENT_TURNS,
): number {
  if (keepRecentTurns <= 0) return messages.length;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== "assistant") continue;
    seen++;
    if (seen >= keepRecentTurns) return i;
  }
  return 0;
}

/**
 * Decide whether the conversation is heavy enough with tool output to edit.
 *
 * Measured on the raw history, whose tool-result total only grows, so this
 * predicate never flips back to `false` for an append-only conversation.
 *
 * @param messages - Conversation history, oldest first.
 * @param options - Context-editing options; resolved options are accepted too.
 */
export function shouldEditContext(
  messages: readonly Message[],
  options: ContextEditOptions = {},
): boolean {
  if (options.enabled === false) return false;
  const limit = options.maxTotalToolResultChars ?? DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS;
  return totalToolResultChars(messages) > limit;
}

function offloadPathOf(message: ToolResultMessage): string | undefined {
  const details = message.details;
  if (details?.offloaded !== true) return undefined;
  const path = details.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Render the text that replaces an elided tool result.
 *
 * @param info - Tool name, original size, error flag and offload path.
 */
export function renderElisionStub(info: ElisionInfo): string {
  const what = info.isError ? "error result" : "result";
  const recovery = info.offloadPath
    ? `The full output was offloaded to ${info.offloadPath} — read that file if you need it.`
    : "Re-run the tool if you need this output again.";
  return (
    `[context-edited: the ${JSON.stringify(info.toolName)} ${what} ` +
    `(${info.originalChars} characters) was elided to save context. ${recovery}]`
  );
}

/** Outcome of one {@link editContext} pass. */
export interface ContextEditResult {
  /** The conversation to send, with old tool results stubbed out. */
  messages: Message[];
  /** How many tool results were replaced by a stub. */
  elidedCount: number;
  /** Characters removed from the outgoing request (stub text already deducted). */
  charsSaved: number;
}

function elide(
  message: ToolResultMessage,
  options: ResolvedContextEditOptions,
): { message: ToolResultMessage; saved: number } | undefined {
  const originalChars = toolResultChars(message.content);
  if (originalChars < options.minCharsToElide) return undefined;

  const offloadPath = offloadPathOf(message);
  const stub = options.renderStub({
    toolName: message.toolName,
    originalChars,
    isError: message.isError,
    ...(offloadPath === undefined ? {} : { offloadPath }),
  });
  const saved = originalChars - stub.length;
  if (saved <= 0) return undefined;

  return {
    message: {
      ...message,
      content: [text(stub)],
      details: {
        ...message.details,
        [ELIDED_DETAIL_KEY]: true,
        elidedChars: originalChars,
      },
    },
    saved,
  };
}

/**
 * Replace the content of stale tool results with a short elision stub.
 *
 * Pure: the input array and every message in it are left untouched; edited
 * messages are shallow copies. Always call this with the raw conversation and
 * use the result only for the outgoing request — see the module doc comment
 * for why that is what keeps the prompt cache stable.
 *
 * A result is elided when all of these hold: it sits before the
 * `keepRecentTurns` boundary, its tool is not in `protectToolNames`, it is not
 * already a stub, it is at least `minCharsToElide` characters, and the stub is
 * genuinely smaller than what it replaces. When the `maxTotalToolResultChars`
 * trigger has not fired, or `enabled` is `false`, the conversation is returned
 * as-is (a copy of the array) with zero counters.
 *
 * @param messages - Conversation history, oldest first.
 * @param options - Resolved options from {@link resolveContextEditOptions}.
 */
export function editContext(
  messages: readonly Message[],
  options: ResolvedContextEditOptions,
): ContextEditResult {
  if (!options.enabled || !shouldEditContext(messages, options)) {
    return { messages: [...messages], elidedCount: 0, charsSaved: 0 };
  }

  const boundary = findElisionBoundary(messages, options.keepRecentTurns);
  const protectedTools = new Set(options.protectToolNames);
  const out: Message[] = [];
  let elidedCount = 0;
  let charsSaved = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (i >= boundary || message.role !== "toolResult") {
      out.push(message);
      continue;
    }
    if (protectedTools.has(message.toolName) || isElided(message)) {
      out.push(message);
      continue;
    }
    const edited = elide(message, options);
    if (!edited) {
      out.push(message);
      continue;
    }
    out.push(edited.message);
    elidedCount++;
    charsSaved += edited.saved;
  }

  return { messages: out, elidedCount, charsSaved };
}

/**
 * What local context editing has done to the outgoing history so far: the
 * results it sends as stubs and the assistant messages whose thinking it no
 * longer replays. It only ever grows, and every request is rendered from it,
 * so between passes consecutive requests share their whole prefix.
 */
export class ContextEditLedger {
  readonly #elided = new Set<string>();
  readonly #withheld = new WeakSet<Message>();

  /** Tool-call ids whose results are sent as elision stubs. */
  get elided(): ReadonlySet<string> {
    return this.#elided;
  }

  /**
   * Whether `message`'s thinking is withheld from requests.
   *
   * @param message - A message from the conversation (identity, not equality).
   */
  isWithheld(message: Message): boolean {
    return this.#withheld.has(message);
  }

  /**
   * Fold one recorded pass in, against the history as it stood when the pass
   * was made (the live conversation, or a replay up to the pass's entry).
   *
   * @param record - The pass.
   * @param messages - History at the moment of the pass.
   */
  apply(record: ContextEditRecord, messages: readonly Message[]): void {
    const ids = new Set(record.elided);
    for (const id of ids) this.#elided.add(id);
    if (record.withholdThinking === undefined) return;
    let from = 0;
    if (record.withholdThinking === "afterFirstElided") {
      from = messages.findIndex(
        (message) => message.role === "toolResult" && ids.has(message.toolCallId),
      );
      if (from === -1) return;
    }
    for (let index = from; index < messages.length; index++) {
      const message = messages[index]!;
      if (message.role === "assistant") this.#withheld.add(message);
    }
  }

  /**
   * Stop replaying `message`'s thinking — for a resume, where the replay has
   * already worked out which messages a pass withheld.
   *
   * @param message - A message from the conversation.
   */
  withhold(message: Message): void {
    this.#withheld.add(message);
  }

  /**
   * The outgoing copy of `messages`: recorded stubs in place, withheld
   * thinking removed, everything else the very same object.
   *
   * @param messages - The raw conversation.
   * @param options - Resolved options (the stub renderer and size floor).
   */
  render(messages: readonly Message[], options: ResolvedContextEditOptions): Message[] {
    const out: Message[] = [];
    for (const message of messages) {
      if (message.role === "toolResult" && this.#elided.has(message.toolCallId)) {
        out.push(isElided(message) ? message : (elide(message, options)?.message ?? message));
      } else if (message.role === "assistant" && this.#withheld.has(message)) {
        const stripped = withoutThinking(message);
        if (stripped.content.length > 0) out.push(stripped);
      } else {
        out.push(message);
      }
    }
    return out;
  }
}

/** A pass {@link planContextEditPass} says is due. */
export interface ContextEditPassPlan {
  /** The record to apply and persist. */
  record: ContextEditRecord;
  /** Results this pass elides. */
  elidedCount: number;
  /** Characters it removes from the request (stub text already deducted). */
  charsSaved: number;
}

/**
 * Decide whether a local elision pass is due before the next request.
 *
 * Same eligibility as {@link editContext} — before the `keepRecentTurns`
 * boundary, not protected, not already elided, big enough, and smaller as a
 * stub — measured against what the ledger has not yet elided. A pass is due
 * once the raw-history trigger has fired **and** the eligible results would
 * save at least `minCharsPerPass`.
 *
 * @param messages - The raw conversation.
 * @param ledger - What earlier passes already did.
 * @param options - Resolved options.
 * @param withholdThinking - Also stop replaying the thinking produced over the
 *   results this pass rewrites (adaptive Claude, where it is bound to them).
 * @returns The pass, or `undefined` when none is due.
 */
export function planContextEditPass(
  messages: readonly Message[],
  ledger: ContextEditLedger,
  options: ResolvedContextEditOptions,
  withholdThinking: boolean,
): ContextEditPassPlan | undefined {
  if (!options.enabled || !shouldEditContext(messages, options)) return undefined;
  const boundary = findElisionBoundary(messages, options.keepRecentTurns);
  const protectedTools = new Set(options.protectToolNames);
  const elided: string[] = [];
  let charsSaved = 0;
  for (let i = 0; i < boundary; i++) {
    const message = messages[i]!;
    if (message.role !== "toolResult") continue;
    if (protectedTools.has(message.toolName) || isElided(message)) continue;
    if (ledger.elided.has(message.toolCallId)) continue;
    const edited = elide(message, options);
    if (!edited) continue;
    elided.push(message.toolCallId);
    charsSaved += edited.saved;
  }
  if (elided.length === 0 || charsSaved < options.minCharsPerPass) return undefined;
  return {
    record: { elided, ...(withholdThinking ? { withholdThinking: "afterFirstElided" } : {}) },
    elidedCount: elided.length,
    charsSaved,
  };
}
