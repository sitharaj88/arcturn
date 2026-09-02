/**
 * The chat transcript, as a pure reduction over the engine's {@link AgentEvent}
 * stream.
 *
 * RFC 0004 §1 Stage 2 asks the chat view for "streamed assistant text, tool
 * calls as collapsible rows with live arguments, thinking collapsed by
 * default, todos rendered". All four are decisions about *state*, not about
 * VS Code, so they live here: no `vscode` import, no DOM, no I/O — just
 * `(state, event) => state`. That is what makes every one of them testable
 * directly, which the RFC §3 checklist requires and the `vscode` module (which
 * does not exist under vitest) would otherwise prevent.
 *
 * Two invariants worth stating:
 *
 * - **Nothing is re-derived.** Every string rendered comes from the event that
 *   carried it. The reducer never reformats a tool's arguments, never
 *   paraphrases a notice, never invents a status the engine did not report.
 * - **Growth is bounded.** A long session must not grow the extension host's
 *   heap or the message it posts to the webview without limit, so the block
 *   list, each tool's progress buffer and each tool's result are capped.
 */

import type { AgentEvent, AssistantMessage, Message, TodoItem } from "../serve/engine.js";

/** How many transcript blocks are kept. Older blocks fall off the front. */
export const MAX_BLOCKS = 400;
/** Cap on a tool's streamed progress buffer, in characters. */
const MAX_PROGRESS_CHARS = 8_000;
/** Cap on a rendered tool result, in characters. */
const MAX_RESULT_CHARS = 8_000;
/** Cap on streamed tool arguments, in characters. */
const MAX_ARGS_CHARS = 8_000;

/** Lifecycle of one tool call, as the engine reported it. */
export type ToolStatus = "pending" | "running" | "awaitingPermission" | "denied" | "ok" | "error";

/** The user's prompt, echoed back into the transcript. */
export interface UserBlock {
  kind: "user";
  id: string;
  text: string;
}

/** Streamed assistant prose. */
export interface TextBlock {
  kind: "text";
  id: string;
  text: string;
}

/** Extended thinking. Collapsed by default, per RFC 0004 §1. */
export interface ThinkingBlock {
  kind: "thinking";
  id: string;
  text: string;
  collapsed: boolean;
}

/** One tool call: a collapsible row with live arguments. */
export interface ToolBlock {
  kind: "tool";
  id: string;
  toolCallId: string;
  name: string;
  /** Arguments as the engine streamed them — partial JSON until complete. */
  argsText: string;
  /** `true` once the full argument object arrived (`toolCallEnd`/`toolStart`). */
  argsComplete: boolean;
  status: ToolStatus;
  /** Accumulated `toolUpdate` text (e.g. streamed bash output). */
  progress: string;
  /** Rendered `toolEnd` result. */
  result: string;
  collapsed: boolean;
}

/** A non-fatal diagnostic, rendered verbatim. */
export interface NoticeBlock {
  kind: "notice";
  id: string;
  level: "info" | "warn" | "error";
  text: string;
}

/** One entry in the transcript. */
export type ChatBlock = UserBlock | TextBlock | ThinkingBlock | ToolBlock | NoticeBlock;

/** Everything the chat view renders, plus the reducer's own bookkeeping. */
export interface ChatState {
  readonly blocks: readonly ChatBlock[];
  readonly todos: readonly TodoItem[];
  readonly plan: string | undefined;
  readonly running: boolean;
  /** Permission requests the engine is still waiting on. */
  readonly pendingPermissions: number;
  /** Model id, as announced by the stream. */
  readonly model: string | undefined;
  /** `runEnd`'s error message, when the last run failed. */
  readonly lastError: string | undefined;
  /** Monotonic id source. Part of the state so the reducer stays pure. */
  readonly seq: number;
  /** Stream `blockIndex` → block id, for routing deltas. */
  readonly openBlocks: Readonly<Record<string, string>>;
  /** Permission request id → tool call id, for clearing the row on a decision. */
  readonly permissionTargets: Readonly<Record<string, string>>;
  /** Whether the message currently in flight arrived as a stream. */
  readonly streamed: boolean;
}

/** A session with nothing in it yet. */
export const initialChatState: ChatState = {
  blocks: [],
  todos: [],
  plan: undefined,
  running: false,
  pendingPermissions: 0,
  model: undefined,
  lastError: undefined,
  seq: 0,
  openBlocks: {},
  permissionTargets: {},
  streamed: false,
};

/** The subset of {@link ChatState} the webview is given. */
export interface ChatViewModel {
  blocks: readonly ChatBlock[];
  todos: readonly TodoItem[];
  plan: string | undefined;
  running: boolean;
  pendingPermissions: number;
  model: string | undefined;
  lastError: string | undefined;
}

/**
 * Project render state out of {@link ChatState}.
 *
 * The reducer's bookkeeping (`seq`, `openBlocks`, `permissionTargets`,
 * `streamed`) is deliberately withheld: it is meaningless to the view and
 * every extra field is another byte across the webview boundary.
 *
 * @param state - Reducer state.
 */
export function toViewModel(state: ChatState): ChatViewModel {
  return {
    blocks: state.blocks,
    todos: state.todos,
    plan: state.plan,
    running: state.running,
    pendingPermissions: state.pendingPermissions,
    model: state.model,
    lastError: state.lastError,
  };
}

/** Trim from the front once the transcript is over its cap. */
function capped(blocks: ChatBlock[]): ChatBlock[] {
  return blocks.length <= MAX_BLOCKS ? blocks : blocks.slice(blocks.length - MAX_BLOCKS);
}

/** Keep the most recent `max` characters of a growing buffer. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

/** Keep the first `max` characters, saying so when anything was dropped. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… truncated (${String(text.length - max)} more characters)`;
}

function append(state: ChatState, block: ChatBlock): ChatState {
  return { ...state, blocks: capped([...state.blocks, block]) };
}

function replaceBlock(
  state: ChatState,
  id: string,
  update: (block: ChatBlock) => ChatBlock,
): ChatState {
  const index = state.blocks.findIndex((block) => block.id === id);
  if (index === -1) return state;
  const blocks = [...state.blocks];
  const existing = blocks[index];
  if (existing === undefined) return state;
  blocks[index] = update(existing);
  return { ...state, blocks };
}

function findTool(state: ChatState, toolCallId: string): ToolBlock | undefined {
  return state.blocks.find(
    (block): block is ToolBlock => block.kind === "tool" && block.toolCallId === toolCallId,
  );
}

function updateTool(
  state: ChatState,
  toolCallId: string,
  update: (block: ToolBlock) => ToolBlock,
): ChatState {
  const existing = findTool(state, toolCallId);
  if (existing === undefined) return state;
  return replaceBlock(state, existing.id, (block) =>
    block.kind === "tool" ? update(block) : block,
  );
}

/** Text content of a message, joined. Non-text content is not invented into words. */
function messageText(message: Message): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Append the blocks of a message that never streamed. */
function appendMessage(state: ChatState, message: AssistantMessage): ChatState {
  let next = state;
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text === "") continue;
      next = append(next, { kind: "text", id: `text:${String(next.seq)}`, text: part.text });
      next = { ...next, seq: next.seq + 1 };
    } else if (part.type === "thinking") {
      next = append(next, {
        kind: "thinking",
        id: `thinking:${String(next.seq)}`,
        text: part.thinking,
        collapsed: true,
      });
      next = { ...next, seq: next.seq + 1 };
    } else {
      next = ensureTool(next, part.id, part.name, JSON.stringify(part.arguments), true);
    }
  }
  return next;
}

/** Create the tool row for `toolCallId` if it does not exist yet, else update it. */
function ensureTool(
  state: ChatState,
  toolCallId: string,
  name: string,
  argsText: string | undefined,
  argsComplete: boolean,
  status?: ToolStatus,
): ChatState {
  const existing = findTool(state, toolCallId);
  if (existing !== undefined) {
    return updateTool(state, toolCallId, (block) => ({
      ...block,
      name: name === "" ? block.name : name,
      argsText: argsText === undefined ? block.argsText : head(argsText, MAX_ARGS_CHARS),
      argsComplete: argsComplete || block.argsComplete,
      status: status ?? block.status,
    }));
  }
  return append(
    { ...state, seq: state.seq + 1 },
    {
      kind: "tool",
      id: `tool:${toolCallId}`,
      toolCallId,
      name,
      argsText: head(argsText ?? "", MAX_ARGS_CHARS),
      argsComplete,
      status: status ?? "pending",
      progress: "",
      result: "",
      collapsed: true,
    },
  );
}

/** Reduce one stream event into the transcript. */
function reduceStream(state: ChatState, event: AgentEvent & { type: "messageStream" }): ChatState {
  const inner = event.event;
  const marked: ChatState = { ...state, streamed: true };
  switch (inner.type) {
    case "start":
      return { ...marked, model: inner.model };
    case "textStart": {
      const id = `text:${String(marked.seq)}`;
      return append(
        {
          ...marked,
          seq: marked.seq + 1,
          openBlocks: { ...marked.openBlocks, [String(inner.blockIndex)]: id },
        },
        { kind: "text", id, text: "" },
      );
    }
    case "thinkingStart": {
      const id = `thinking:${String(marked.seq)}`;
      return append(
        {
          ...marked,
          seq: marked.seq + 1,
          openBlocks: { ...marked.openBlocks, [String(inner.blockIndex)]: id },
        },
        { kind: "thinking", id, text: "", collapsed: true },
      );
    }
    case "textDelta":
    case "thinkingDelta": {
      const id = marked.openBlocks[String(inner.blockIndex)];
      if (id === undefined) return marked;
      const delta = inner.delta;
      return replaceBlock(marked, id, (block) => {
        if (block.kind === "text") return { ...block, text: block.text + delta };
        if (block.kind === "thinking") return { ...block, text: block.text + delta };
        return block;
      });
    }
    case "toolCallStart":
      return ensureTool(
        {
          ...marked,
          openBlocks: { ...marked.openBlocks, [String(inner.blockIndex)]: `tool:${inner.id}` },
        },
        inner.id,
        inner.name,
        "",
        false,
      );
    case "toolCallDelta": {
      const id = marked.openBlocks[String(inner.blockIndex)];
      if (id === undefined) return marked;
      const delta = inner.argumentsDelta;
      return replaceBlock(marked, id, (block) =>
        block.kind === "tool"
          ? { ...block, argsText: head(block.argsText + delta, MAX_ARGS_CHARS) }
          : block,
      );
    }
    case "toolCallEnd":
      return ensureTool(marked, inner.id, inner.name, JSON.stringify(inner.arguments), true);
    case "blockEnd": {
      const openBlocks = { ...marked.openBlocks };
      delete openBlocks[String(inner.blockIndex)];
      return { ...marked, openBlocks };
    }
    // `usage` is accounted in `cost.ts` against `turnEnd`, which is the total
    // the engine's own metrics use; `end`/`error` are followed by `messageEnd`.
    case "usage":
    case "end":
    case "error":
      return marked;
  }
}

/**
 * Fold one engine event into the transcript.
 *
 * Returns the *same* state object when an event changes nothing, so a caller
 * can skip a webview post with an identity check.
 *
 * @param state - Current state.
 * @param event - The event, exactly as `@arcturn/types` defines it.
 */
export function reduceChat(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case "runStart": {
      const text = messageText(event.prompt);
      const started: ChatState = {
        ...state,
        running: true,
        lastError: undefined,
        openBlocks: {},
        streamed: false,
      };
      if (text === "") return started;
      return append(
        { ...started, seq: started.seq + 1 },
        { kind: "user", id: `user:${String(started.seq)}`, text },
      );
    }
    case "turnStart":
      return state;
    case "messageStream":
      return reduceStream(state, event);
    case "messageEnd": {
      // A streamed message is already in the transcript; re-appending its
      // content would show every answer twice.
      const next = state.streamed ? state : appendMessage(state, event.message);
      return { ...next, streamed: false, openBlocks: {} };
    }
    case "toolStart":
      return ensureTool(
        state,
        event.toolCallId,
        event.toolName,
        JSON.stringify(event.input),
        true,
        "running",
      );
    case "toolUpdate": {
      const text = event.update.text;
      if (text === undefined || text === "") return state;
      return updateTool(state, event.toolCallId, (block) => ({
        ...block,
        progress: tail(block.progress + text, MAX_PROGRESS_CHARS),
      }));
    }
    case "toolEnd": {
      const result = event.result;
      const text = result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return updateTool(state, event.toolCallId, (block) => ({
        ...block,
        status: result.isError ? "error" : "ok",
        result: head(text, MAX_RESULT_CHARS),
      }));
    }
    case "permissionRequest": {
      const request = event.request;
      const marked = updateTool(state, request.toolCallId, (block) => ({
        ...block,
        status: "awaitingPermission",
        collapsed: false,
      }));
      return {
        ...marked,
        pendingPermissions: marked.pendingPermissions + 1,
        permissionTargets: { ...marked.permissionTargets, [request.id]: request.toolCallId },
      };
    }
    case "permissionDecision": {
      const decision = event.decision;
      const toolCallId = state.permissionTargets[decision.requestId];
      const permissionTargets = { ...state.permissionTargets };
      delete permissionTargets[decision.requestId];
      const marked =
        toolCallId === undefined
          ? state
          : updateTool(state, toolCallId, (block) =>
              block.status === "awaitingPermission"
                ? { ...block, status: decision.behavior === "allow" ? "running" : "denied" }
                : block,
            );
      return {
        ...marked,
        pendingPermissions: Math.max(0, marked.pendingPermissions - 1),
        permissionTargets,
      };
    }
    case "todoUpdate":
      return { ...state, todos: event.todos };
    case "planUpdate":
      return { ...state, plan: event.plan };
    case "subagentStart":
      return notice(state, "info", `Sub-agent ${event.agentId} started: ${event.task}`);
    case "subagentEnd":
      return notice(
        state,
        event.isError ? "error" : "info",
        `Sub-agent ${event.agentId} finished: ${head(event.resultText, 500)}`,
      );
    // A sub-agent's own stream is namespaced by `agentId` and would interleave
    // unreadably with the parent transcript; only its start and end are shown.
    case "subagentEvent":
      return state;
    case "backgroundTaskStart":
      return notice(state, "info", `Background task ${event.taskId}: ${event.command}`);
    // Background output can be megabytes; the task's start and end are enough
    // for a sidebar, and the terminal front-end already renders the stream.
    case "backgroundTaskOutput":
      return state;
    case "backgroundTaskEnd":
      return notice(
        state,
        event.exitCode === 0 || event.exitCode === null ? "info" : "warn",
        `Background task ${event.taskId} exited with code ${String(event.exitCode)}`,
      );
    case "compactionStart":
      return state;
    case "compactionEnd":
      return notice(
        state,
        "info",
        `Compacted history: ${String(event.tokensBefore)} → ${String(event.tokensAfter)} tokens`,
      );
    case "contextEdit":
      return state;
    // Accounted in `cost.ts`, which owns the session's spend.
    case "turnEnd":
      return state;
    case "runEnd": {
      const stopped: ChatState = {
        ...state,
        running: false,
        openBlocks: {},
        streamed: false,
        lastError: event.reason === "error" ? (event.errorMessage ?? "The run failed") : undefined,
      };
      if (event.reason === "completed") return stopped;
      if (event.reason === "aborted") return notice(stopped, "warn", "Run aborted");
      return notice(stopped, "error", event.errorMessage ?? "The run failed");
    }
    case "notice":
      return notice(state, event.level, event.text);
    // Both are structured twins of a notice the engine emits alongside them —
    // the silent-turn nudge and the write-lane progress check each arrive as
    // a `notice` too — so the transcript already shows the words. These
    // exist for counting (the insights ledger), not for rendering.
    case "silentTurn":
    case "progressWarning":
      return state;
  }
}

function notice(state: ChatState, level: NoticeBlock["level"], text: string): ChatState {
  return append(
    { ...state, seq: state.seq + 1 },
    { kind: "notice", id: `notice:${String(state.seq)}`, level, text },
  );
}

/**
 * Expand or collapse one block.
 *
 * @param state - Current state.
 * @param blockId - The block's `id`.
 * @returns The same state object when `blockId` names nothing collapsible.
 */
export function toggleBlock(state: ChatState, blockId: string): ChatState {
  const block = state.blocks.find((candidate) => candidate.id === blockId);
  if (block === undefined) return state;
  if (block.kind !== "thinking" && block.kind !== "tool") return state;
  return replaceBlock(state, blockId, (existing) =>
    existing.kind === "thinking" || existing.kind === "tool"
      ? { ...existing, collapsed: !existing.collapsed }
      : existing,
  );
}
