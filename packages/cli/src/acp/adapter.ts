/**
 * Maps arcturn's agent onto the Agent Client Protocol (ACP), the editor↔agent
 * standard implemented by Zed, JetBrains and Neovim.
 *
 * Every wire shape below is quoted from the published specification at
 * {@link https://agentclientprotocol.com}; the specific page is cited on each
 * type. Nothing here is invented — methods the spec defines but this adapter
 * does not yet implement are listed under "Unimplemented" in
 * `INTEGRATION-acp.md` and marked with `TODO(acp)` comments naming the method.
 *
 * This module deliberately does not import `ArcturnRuntime`. It takes a narrow
 * {@link AcpAgentDeps} seam so it can be unit-tested against a scripted event
 * stream, and so a future `arcturn acp` subcommand can supply the real runtime
 * without this file growing a dependency on it.
 */

import type {
  AgentEvent,
  AssistantMessage,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  StreamEvent,
  Usage,
} from "@arcturn/types";
import { type AcpConnection, AcpError, JSON_RPC_ERRORS } from "./protocol.js";

/**
 * The major protocol version this adapter implements.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/initialization} —
 * "protocolVersion: Single integer identifying the major protocol version".
 */
export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * One ACP content block.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/prompt-turn} — the
 * `session/prompt` example carries `{ "type": "text", ... }` and
 * `{ "type": "resource", "resource": { "uri", "mimeType", "text" } }` blocks.
 * ACP's content block model is borrowed from MCP, so `image`, `audio` and
 * `resource_link` also exist; this adapter emits only `text` and reads the
 * text-bearing variants.
 */
export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    };

/**
 * Name/title/version block identifying one side of the connection.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/initialization} —
 * `clientInfo` and `agentInfo`.
 */
export interface AcpImplementationInfo {
  name: string;
  title?: string;
  version?: string;
}

/**
 * What the *editor* offers the agent, as parsed from `initialize`'s
 * `clientCapabilities`.
 *
 * Source: the published `ClientCapabilities` struct
 * ({@link https://agentclientprotocol.com/protocol/initialization#client-capabilities}) —
 * `fs: { readTextFile, writeTextFile }` (both `bool`, defaulting to `false`),
 * `terminal: bool` ("Whether the Client support all `terminal/*` methods"),
 * plus the optional `session` and `elicitation` sub-capabilities. The
 * remaining fields on that struct (`plan`, `auth`, `nes`,
 * `positionEncodings`) are all marked **UNSTABLE** in the schema, so they are
 * deliberately not modelled here — {@link AcpClientCapabilities.raw} carries
 * them verbatim for anything that later wants to look.
 *
 * The optional sub-capabilities are *presence-signalled* in the schema
 * ("Supplying `{}` explicitly advertises support"), so they are normalised to
 * booleans here: an absent, `null` or non-object value all read as `false`.
 */
export interface AcpClientCapabilities {
  /** Whether the client serves `fs/read_text_file` / `fs/write_text_file`. */
  fs: { readTextFile: boolean; writeTextFile: boolean };
  /** Whether the client serves every `terminal/*` method. */
  terminal: boolean;
  /** Which elicitation modes the agent may use (`elicitation/create`). */
  elicitation: { form: boolean; url: boolean };
  /** Session-scoped client extensions (`session/set_config_option`). */
  session: { configOptions: { boolean: boolean } };
  /**
   * The exact object the client sent, unmodified — including capabilities
   * this adapter does not model. Empty when the client sent none.
   */
  raw: Readonly<Record<string, unknown>>;
}

/** A client that advertised nothing: every capability off. */
export const NO_CLIENT_CAPABILITIES: AcpClientCapabilities = Object.freeze({
  fs: Object.freeze({ readTextFile: false, writeTextFile: false }),
  terminal: false,
  elicitation: Object.freeze({ form: false, url: false }),
  session: Object.freeze({ configOptions: Object.freeze({ boolean: false }) }),
  raw: Object.freeze({}),
}) as AcpClientCapabilities;

/**
 * `initialize` request params.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/initialization}.
 */
export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
    session?: { configOptions?: { boolean?: Record<string, unknown> } };
    elicitation?: { form?: Record<string, unknown>; url?: Record<string, unknown> };
  };
  clientInfo?: AcpImplementationInfo;
}

/**
 * `initialize` response.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/initialization} —
 * `protocolVersion`, `agentCapabilities.loadSession`,
 * `agentCapabilities.promptCapabilities.{image,audio,embeddedContext}`,
 * `agentCapabilities.mcpCapabilities.{http,sse}`, `agentInfo` and
 * `authMethods`.
 */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: {
      image: boolean;
      audio: boolean;
      embeddedContext: boolean;
    };
    /**
     * Whether `session/new`'s `mcpServers` may include the `http`/`sse`
     * discriminated variants (as opposed to only the required `stdio` one).
     * Both `false` here means "stdio only" — see `ACP-STATUS.md`.
     */
    mcpCapabilities: {
      http: boolean;
      sse: boolean;
    };
  };
  agentInfo: AcpImplementationInfo;
  /** Empty means no authentication is required before `session/new`. */
  authMethods: Array<{ id: string; name: string; description?: string | null }>;
}

/**
 * One MCP server the client asks the agent to connect for this session.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/session-setup} —
 * `mcpServers: [{ name, command, args, env }]`.
 */
export interface AcpMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

/**
 * `session/new` request params.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/session-setup}.
 */
export interface AcpNewSessionParams {
  cwd: string;
  mcpServers?: AcpMcpServer[];
}

/**
 * One mode the agent can operate in, offered to the client for
 * `session/new`'s `modes` and `session/set_mode`.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/session-modes} —
 * "SessionMode Structure: `id` (SessionModeId, required), `name` (string,
 * required), `description` (string, optional)".
 */
export interface AcpSessionModeInfo {
  id: string;
  name: string;
  description?: string;
}

/**
 * `session/new`'s `modes` field, present only when the host supports mode
 * switching.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/session-modes} —
 * "SessionModeState: `currentModeId` (required), `availableModes` (required)".
 */
export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionModeInfo[];
}

/**
 * `session/new` response.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/session-setup} —
 * `{ "sessionId": "sess_..." }`, plus `modes` from
 * {@link https://agentclientprotocol.com/protocol/session-modes} when the
 * agent supports `session/set_mode`.
 */
export interface AcpNewSessionResult {
  sessionId: string;
  modes?: AcpSessionModeState;
}

/**
 * `session/prompt` request params.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/prompt-turn}.
 */
export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

/**
 * Why a prompt turn ended.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/prompt-turn} —
 * "StopReason values: `end_turn`, `max_tokens`, `max_turn_requests`,
 * `refusal`, `cancelled`".
 */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/** `session/prompt` response. */
export interface AcpPromptResult {
  stopReason: AcpStopReason;
}

/**
 * Execution state of a tool call.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/tool-calls} —
 * "`pending` – Not yet running; input streaming or awaiting approval;
 * `in_progress` – Currently executing; `completed` – Successfully finished;
 * `failed` – Encountered an error".
 */
export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * Category of a tool call, used by clients to pick an icon.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/tool-calls} —
 * "`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`,
 * `other`".
 */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

/**
 * Output attached to a tool call.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/tool-calls} —
 * "ToolCallContent Variants: Content Block, Diff (`path`, `oldText`,
 * `newText`), Terminal (`terminalId`)". Only the content-block variant is
 * emitted by this adapter.
 */
export type AcpToolCallContent =
  | { type: "content"; content: AcpContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

/**
 * A file a tool call touches, so the client can follow along.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/tool-calls} —
 * "ToolCallLocation Structure: `path` (required): Absolute file path;
 * `line` (optional)".
 */
export interface AcpToolCallLocation {
  path: string;
  line?: number;
}

/**
 * The `update` payload of a `session/update` notification.
 *
 * Sources: {@link https://agentclientprotocol.com/protocol/prompt-turn}
 * (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`),
 * {@link https://agentclientprotocol.com/protocol/session-modes}
 * (`current_mode_update`) and the published `SessionUpdate` enum, whose
 * `CurrentModeUpdate` carries `currentModeId` (**not** `modeId`) and whose
 * `UsageUpdate` is `{ used, size, cost? }`. `agent_thought_chunk` and
 * `user_message_chunk` are named by the protocol overview's update list; only
 * `agent_thought_chunk` is emitted here, and it mirrors the verified
 * `agent_message_chunk` shape.
 *
 * The spec's remaining variants — `available_commands_update`,
 * `config_option_update`, `session_info_update` — have no arcturn counterpart
 * to map and are deliberately absent; see `website/src/content/docs/acp.md`.
 */
export type AcpSessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock; messageId?: string }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock; messageId?: string }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: AcpToolKind;
      status: AcpToolCallStatus;
      content?: AcpToolCallContent[];
      locations?: AcpToolCallLocation[];
      rawInput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status?: AcpToolCallStatus;
      title?: string;
      content?: AcpToolCallContent[];
      locations?: AcpToolCallLocation[];
      rawOutput?: unknown;
    }
  | { sessionUpdate: "plan"; entries: AcpPlanEntry[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: AcpUsageCost };

/**
 * Cumulative session cost attached to a `usage_update`.
 *
 * Source: the published `Cost` struct — `amount` (f64, "Total cumulative cost
 * for session") and `currency` ("ISO 4217 currency code (e.g. \"USD\",
 * \"EUR\")"). arcturn prices everything in USD, so `currency` is always `"USD"`.
 */
export interface AcpUsageCost {
  amount: number;
  currency: string;
}

/**
 * What the host must be able to answer for a `usage_update` to be emitted at
 * all: how big this session's context window is, and what the turn just cost.
 *
 * The adapter cannot derive either — it never sees the model — so a host that
 * does not implement {@link AcpAgentDeps.sessionUsage} simply gets no
 * `usage_update` notifications rather than invented numbers.
 */
export interface AcpSessionUsage {
  /** Total context window size in tokens — the spec's `UsageUpdate.size`. */
  contextWindow: number;
  /** This turn's cost in USD, if the model's pricing is known. Summed across the session. */
  costUsd?: number;
}

/**
 * One entry of a `plan` update.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/prompt-turn} —
 * `entries: [{ "content", "priority": "high", "status": "pending" }]`.
 */
export interface AcpPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

/** Full `session/update` notification params. */
export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

/**
 * How a permission option should be presented and remembered.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/tool-calls} —
 * "PermissionOptionKind Values: `allow_once`, `allow_always`, `reject_once`,
 * `reject_always`".
 */
export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

/** One option offered in a permission request. */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

/**
 * `session/request_permission` request params (agent → client).
 *
 * Source: {@link https://agentclientprotocol.com/protocol/tool-calls} —
 * `{ sessionId, toolCall: { toolCallId }, options: [...] }`.
 */
export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: AcpToolKind; rawInput?: unknown };
  options: AcpPermissionOption[];
}

/**
 * `session/request_permission` response.
 *
 * Source: {@link https://agentclientprotocol.com/protocol/tool-calls} —
 * `{ "outcome": { "outcome": "selected", "optionId": "allow-once" } }` or
 * `{ "outcome": { "outcome": "cancelled" } }`.
 */
export interface AcpRequestPermissionResult {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

/** The four permission options this adapter offers for every request. */
const PERMISSION_OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
];

/**
 * arcturn's {@link PermissionMode}s, offered as ACP session modes. `id` is the
 * exact `PermissionMode` value, so `handleSetMode` can pass it straight
 * through to `deps.setPermissionMode` with no translation table to keep in
 * sync.
 */
const ACP_SESSION_MODES: readonly (AcpSessionModeInfo & { id: PermissionMode })[] = [
  { id: "plan", name: "Plan", description: "Read-only: no tool that could change state may run." },
  {
    id: "default",
    name: "Default",
    description: "Prompts before any tool that writes, executes, or fetches.",
  },
  {
    id: "acceptEdits",
    name: "Accept Edits",
    description: "Auto-approves file writes and edits; other gated tools still prompt.",
  },
  {
    id: "yolo",
    name: "Yolo",
    description: "Auto-approves every gated tool call without prompting.",
  },
];

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** One prompt turn requested by the editor. */
export interface AcpPromptRequest {
  /** The ACP session this turn belongs to. */
  sessionId: string;
  /** Working directory the session was created with (`session/new`'s `cwd`). */
  cwd: string;
  /** The prompt's text blocks, flattened and joined with blank lines. */
  text: string;
  /** The raw ACP content blocks, for a host that wants images or resources. */
  blocks: readonly AcpContentBlock[];
}

/**
 * The narrow seam this adapter needs from a host.
 *
 * A `arcturn acp` subcommand implements it over `ArcturnRuntime`; tests implement it
 * with a scripted event array. Keeping the surface this small is what lets
 * `adapter.ts` stay free of a runtime import.
 */
export interface AcpAgentDeps {
  /**
   * Run one prompt turn, emitting arcturn {@link AgentEvent}s as they happen.
   *
   * Resolves when the turn is over. Rejecting is reported to the editor as a
   * JSON-RPC error response to `session/prompt`, except after a cancel, where
   * the spec requires a `cancelled` stop reason instead.
   */
  prompt(request: AcpPromptRequest, onEvent: (event: AgentEvent) => void): Promise<void>;
  /** Abort the in-flight turn for `sessionId`. Must be safe to call when idle. */
  abort(sessionId: string): void;
  /** Called on `session/new`; a host may pre-warm a runtime here. */
  createSession?(params: AcpNewSessionParams, sessionId: string): Promise<void> | void;
  /**
   * Called on `session/load`. Providing it advertises
   * `agentCapabilities.loadSession: true` and registers the handler; omitting
   * it leaves `session/load` unimplemented, which is the honest default since
   * replaying history requires host-side transcript storage.
   */
  loadSession?(
    params: { sessionId: string; cwd: string; mcpServers?: AcpMcpServer[] },
    replay: (update: AcpSessionUpdate) => void,
  ): Promise<void>;
  /** Mints session ids. Defaults to a counter-based `sess_...` id. */
  createSessionId?(): string;
  /** Identifies this agent in the `initialize` response. */
  agentInfo?: AcpImplementationInfo;
  /**
   * Reads a session's current arcturn {@link PermissionMode}, for `session/new`'s
   * `modes.currentModeId` and as the fallback answer while `session/set_mode`
   * is in flight. Providing both this and {@link setPermissionMode}
   * advertises mode support (`modes` on `session/new`,
   * `session/set_mode` registered); omitting either leaves mode-switching
   * unimplemented, matching {@link loadSession}'s opt-in shape.
   */
  getPermissionMode?(sessionId: string): PermissionMode;
  /** Applies a mode switch requested via `session/set_mode`. See {@link getPermissionMode}. */
  setPermissionMode?(sessionId: string, mode: PermissionMode): void;
  /**
   * Sizes one turn's usage for the ACP `usage_update` notification.
   *
   * Called once per arcturn `turnEnd`, with that turn's {@link Usage}. Return
   * `undefined` (or omit the hook entirely) to suppress `usage_update` for
   * this session — the honest default, since the adapter has no way to know a
   * model's context window or pricing on its own.
   */
  sessionUsage?(sessionId: string, usage: Usage): AcpSessionUsage | undefined;
}

/** A read-only view of one session's adapter-side state. */
export interface AcpSessionInfo {
  /** The ACP session id. */
  id: string;
  /** Working directory the session was created with. */
  cwd: string;
  /** What the editor advertised at `initialize`, for host-side bridges to consult. */
  clientCapabilities: AcpClientCapabilities;
  /** The permission mode last reported to the client, when mode support is wired. */
  modeId: PermissionMode | undefined;
}

/** The object returned by {@link createAcpAgent}. */
export interface AcpAgent {
  /** Register every implemented ACP method on `connection`. Call once. */
  attach(connection: AcpConnection): void;
  /**
   * A arcturn `PermissionPrompt` bound to `sessionId`, to hand to the runtime so
   * approvals surface as ACP `session/request_permission` requests.
   *
   * The arcturn `permissionRequest` **event** cannot carry a decision back to the
   * engine, so this — not the event stream — is the real permission bridge.
   */
  permissionPrompt(sessionId: string): (request: PermissionRequest) => Promise<PermissionDecision>;
  /** Session ids currently known to the adapter. Exposed for tests and diagnostics. */
  readonly sessionIds: readonly string[];
  /**
   * What the editor advertised in `initialize`'s `clientCapabilities`.
   *
   * Connection-scoped, because `initialize` is: every session on this
   * connection shares it. {@link NO_CLIENT_CAPABILITIES} until `initialize`
   * arrives. Nothing in this adapter acts on it yet — it is captured so a
   * future `fs/*` or `terminal/*` bridge can check what the editor actually
   * serves before calling back into it.
   */
  readonly clientCapabilities: AcpClientCapabilities;
  /** One session's adapter-side state, or `undefined` if the id is unknown. */
  sessionInfo(sessionId: string): AcpSessionInfo | undefined;
}

// ---------------------------------------------------------------------------
// arcturn → ACP mapping helpers
// ---------------------------------------------------------------------------

/** Map a arcturn tool name onto the closest ACP {@link AcpToolKind}. */
export function toolKindFor(toolName: string): AcpToolKind {
  switch (toolName) {
    case "read":
    case "ls":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "grep":
    case "glob":
      return "search";
    case "bash":
      return "execute";
    case "fetch":
    case "websearch":
      return "fetch";
    case "task":
    case "agent":
    case "plan":
    case "todo":
      return "think";
    default:
      return "other";
  }
}

/** Pull an absolute-ish path out of a tool input, for `locations`. */
function locationsFor(input: Record<string, unknown>): AcpToolCallLocation[] | undefined {
  const candidate = input.path ?? input.file_path ?? input.filePath ?? input.file;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  const line = typeof input.line === "number" ? input.line : undefined;
  return [line === undefined ? { path: candidate } : { path: candidate, line }];
}

/** A one-line human-readable title for a tool call, as ACP requires. */
function titleFor(toolName: string, input: Record<string, unknown>): string {
  const subject =
    typeof input.command === "string"
      ? input.command
      : typeof input.pattern === "string"
        ? input.pattern
        : typeof input.path === "string"
          ? input.path
          : typeof input.file_path === "string"
            ? input.file_path
            : typeof input.url === "string"
              ? input.url
              : typeof input.query === "string"
                ? input.query
                : undefined;
  if (subject === undefined) return toolName;
  const trimmed = subject.length > 120 ? `${subject.slice(0, 117)}...` : subject;
  return `${toolName}: ${trimmed}`;
}

/** Convert arcturn tool-result content into ACP tool-call content blocks. */
function toolContentFor(
  content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>,
): AcpToolCallContent[] | undefined {
  const blocks: AcpToolCallContent[] = [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      blocks.push({ type: "content", content: { type: "text", text: item.text } });
    } else if (item.type === "image" && typeof item.data === "string") {
      blocks.push({
        type: "content",
        content: { type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" },
      });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

/** Flatten ACP prompt blocks into the plain text arcturn's runtime takes. */
export function promptBlocksToText(blocks: readonly AcpContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource" && typeof block.resource.text === "string") {
      // Embedded context: the editor inlined the file, so quote it with its uri.
      parts.push(`<file uri="${block.resource.uri}">\n${block.resource.text}\n</file>`);
    } else if (block.type === "resource_link") {
      parts.push(`@${block.uri}`);
    }
    // TODO(acp): image/audio prompt blocks are declined in promptCapabilities
    // until arcturn's runtime accepts multimodal user content on this seam.
  }
  return parts.join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse `initialize`'s `clientCapabilities` into {@link AcpClientCapabilities}.
 *
 * Every field the schema defaults (`fs.*`, `terminal`) is read as `false`
 * unless the client sent exactly `true`, and every presence-signalled
 * sub-capability is read as advertised only when its value is an object —
 * which matches the schema's own "omitted or `null` both mean the client does
 * not advertise support; supplying `{}` means it does".
 */
export function parseClientCapabilities(value: unknown): AcpClientCapabilities {
  if (!isRecord(value)) return NO_CLIENT_CAPABILITIES;
  const fs = isRecord(value.fs) ? value.fs : {};
  const elicitation = isRecord(value.elicitation) ? value.elicitation : {};
  const session = isRecord(value.session) ? value.session : {};
  const configOptions = isRecord(session.configOptions) ? session.configOptions : {};
  return {
    fs: { readTextFile: fs.readTextFile === true, writeTextFile: fs.writeTextFile === true },
    terminal: value.terminal === true,
    elicitation: { form: isRecord(elicitation.form), url: isRecord(elicitation.url) },
    session: { configOptions: { boolean: isRecord(configOptions.boolean) } },
    raw: value,
  };
}

/**
 * `@arcturn/core`'s loop reports hitting its turn ceiling as a `runEnd` with
 * reason `"error"` whose `errorMessage` it composes as
 * `Reached the maximum of <n> turns. …` (see `packages/core/src/loop.ts`).
 * That prose is the *only* signal the runtime emits for the distinction — the
 * `LoopResult` reason is a plain `"error"` — so matching it is what lets a
 * turn ceiling surface as ACP's `max_turn_requests` stop reason instead of a
 * JSON-RPC failure. A wording change in `loop.ts` degrades this to the old
 * behaviour (an error response), never to a wrong stop reason.
 */
const MAX_TURNS_RUN_END = /^Reached the maximum of \d+ turns\./;

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

interface SessionState {
  id: string;
  cwd: string;
  /** Set by `session/cancel`; forces a `cancelled` stop reason for the turn. */
  cancelled: boolean;
  /** Resolvers for permission requests in flight, so cancel can settle them. */
  pendingPermissions: Set<(decision: PermissionDecision) => void>;
  /**
   * What the editor advertised at `initialize`. Connection-scoped in truth
   * (see {@link AcpAgent.clientCapabilities}); mirrored here so a host bridge
   * holding one session never has to reach back up for it.
   */
  clientCapabilities: AcpClientCapabilities;
  /**
   * The permission mode the client has last been told about, so an
   * agent-initiated change can be spotted and announced with
   * `current_mode_update` — and so the client's *own* `session/set_mode` is
   * not echoed back at it. `undefined` when the host wires no mode support.
   */
  modeId: PermissionMode | undefined;
  /**
   * Cumulative USD cost of every turn the host priced for this session, for
   * `usage_update`'s `cost.amount` ("Total cumulative cost for session").
   * `undefined` until the first turn the host could price.
   */
  costUsd: number | undefined;
}

/**
 * Per-turn translation of arcturn's {@link AgentEvent} stream into ordered ACP
 * `session/update` notifications.
 */
class TurnMapper {
  #sawTextDelta = false;
  /** Maps a permission request id to the tool call it guards. */
  readonly #permissionToolCalls = new Map<string, string>();
  /** The `stopReason` of the most recent assistant message the turn produced. */
  #lastMessageStopReason: AssistantMessage["stopReason"] | undefined;
  /** Non-cancel terminal failure reported by `runEnd`. */
  error: string | undefined;
  /** Terminal reason reported by `runEnd`, if one arrived. */
  runEndReason: "completed" | "aborted" | "error" | undefined;
  /** Set when `runEnd`'s error is the loop's turn-ceiling message, not a real failure. */
  maxTurnsReached = false;

  constructor(
    private readonly sessionId: string,
    private readonly emit: (update: AcpSessionUpdate) => void,
    /** Called at each `turnEnd` with that turn's usage; see {@link AcpAgentDeps.sessionUsage}. */
    private readonly onTurnUsage: (usage: Usage) => void = () => {},
  ) {}

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "messageStream":
        this.#handleStream(event.event);
        return;

      case "messageEnd": {
        // Recorded before the early return below: this is the only place the
        // provider's own stop reason (`maxTokens` in particular) reaches the
        // adapter, and it matters whether or not deltas were streamed.
        this.#lastMessageStopReason = event.message.stopReason;
        // Hosts that do not re-emit raw stream deltas still get their text.
        if (this.#sawTextDelta) return;
        for (const block of event.message.content) {
          if (block.type === "text" && block.text.length > 0) {
            this.emit({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: block.text },
            });
          }
        }
        return;
      }

      case "toolStart": {
        const update: AcpSessionUpdate = {
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: titleFor(event.toolName, event.input),
          kind: toolKindFor(event.toolName),
          status: "pending",
          rawInput: event.input,
        };
        const locations = locationsFor(event.input);
        if (locations) update.locations = locations;
        this.emit(update);
        // ACP models "running" as a separate state; arcturn starts executing
        // immediately after toolStart unless a permission gate intervenes.
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: "in_progress",
        });
        return;
      }

      case "toolUpdate": {
        if (typeof event.update.text !== "string" || event.update.text.length === 0) return;
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: event.update.text } }],
        });
        return;
      }

      case "toolEnd": {
        const update: AcpSessionUpdate = {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.result.isError ? "failed" : "completed",
        };
        const content = toolContentFor(event.result.content);
        if (content) update.content = content;
        if (event.result.details) update.rawOutput = event.result.details;
        this.emit(update);
        return;
      }

      case "permissionRequest": {
        this.#permissionToolCalls.set(event.request.id, event.request.toolCallId);
        // Spec: `pending` covers "awaiting approval".
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: event.request.toolCallId,
          status: "pending",
        });
        return;
      }

      case "permissionDecision": {
        const toolCallId = this.#permissionToolCalls.get(event.decision.requestId);
        if (!toolCallId) return;
        this.#permissionToolCalls.delete(event.decision.requestId);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: event.decision.behavior === "allow" ? "in_progress" : "failed",
        });
        return;
      }

      case "todoUpdate": {
        this.emit({
          sessionUpdate: "plan",
          entries: event.todos.map((todo) => ({
            content: todo.text,
            priority: "medium" as const,
            status:
              todo.status === "done"
                ? ("completed" as const)
                : todo.status === "inProgress"
                  ? ("in_progress" as const)
                  : ("pending" as const),
          })),
        });
        return;
      }

      case "planUpdate": {
        // arcturn's `plan` tool records one free-text markdown plan, unlike the
        // structured checklist behind `todoUpdate` — ACP's `plan` update
        // wants `entries`, so a single-entry list is the closest honest fit.
        // A later `todoUpdate` (the model breaking the plan into steps)
        // naturally supersedes this with a richer entry list.
        this.emit({
          sessionUpdate: "plan",
          entries: [{ content: event.plan, priority: "medium", status: "in_progress" }],
        });
        return;
      }

      case "subagentStart": {
        this.emit({
          sessionUpdate: "tool_call",
          toolCallId: `subagent:${event.agentId}`,
          title: `Subagent: ${event.task}`,
          kind: "think",
          status: "in_progress",
        });
        return;
      }

      case "subagentEnd": {
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: `subagent:${event.agentId}`,
          status: event.isError ? "failed" : "completed",
          content: [{ type: "content", content: { type: "text", text: event.resultText } }],
        });
        return;
      }

      case "turnEnd": {
        this.onTurnUsage(event.usage);
        return;
      }

      case "runEnd": {
        this.runEndReason = event.reason;
        if (event.reason !== "error") return;
        const message = event.errorMessage ?? "The arcturn run failed.";
        // A turn ceiling is a pause, not a failure (the session is intact and
        // another prompt continues it), and ACP has a stop reason that says
        // exactly that — so it must not become a JSON-RPC error response.
        if (MAX_TURNS_RUN_END.test(message)) this.maxTurnsReached = true;
        else this.error = message;
        return;
      }

      default:
        // runStart / turnStart / subagentEvent / compaction* /
        // backgroundTask* / notice have no verified ACP counterpart. See
        // ACP-STATUS.md ("Unmapped arcturn events").
        // TODO(acp): backgroundTask* should map to the `terminal/*` client
        // methods once arcturn's runtime exposes a terminal id for them — as of
        // this writing no producer in `@arcturn/core` actually emits
        // `backgroundTask*` events yet, so there is nothing to verify a
        // mapping against.
        return;
    }
  }

  #handleStream(event: StreamEvent): void {
    if (event.type === "textDelta") {
      if (event.delta.length === 0) return;
      this.#sawTextDelta = true;
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.delta },
      });
      return;
    }
    if (event.type === "thinkingDelta") {
      if (event.delta.length === 0) return;
      this.emit({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.delta },
      });
    }
  }

  /**
   * The stop reason implied by the events seen, absent a cancel.
   *
   * The mapping is bounded by what arcturn's runtime can actually distinguish:
   *
   * | arcturn signal | ACP {@link AcpStopReason} |
   * |---|---|
   * | `runEnd` reason `aborted` (or `session/cancel`, handled by the caller) | `cancelled` |
   * | `runEnd` reason `error` matching {@link MAX_TURNS_RUN_END} | `max_turn_requests` |
   * | last `messageEnd`'s `stopReason` is `maxTokens`, run not aborted | `max_tokens` |
   * | everything else, including `runEnd` reason `completed` | `end_turn` |
   *
   * `refusal` is never returned: nothing in `@arcturn/core` or
   * `@arcturn/types` models a refusal — the assistant `StopReason` union is
   * `endTurn | toolCalls | maxTokens | aborted | error` — so claiming to
   * detect one would be an invention. A refusal surfaces as ordinary
   * `end_turn` text, which is what the runtime genuinely knows.
   *
   * Any other `runEnd` error is *not* a stop reason at all: it becomes a
   * JSON-RPC error response on `session/prompt` (see `handlePrompt`).
   */
  stopReason(): AcpStopReason {
    if (this.runEndReason === "aborted") return "cancelled";
    if (this.maxTurnsReached) return "max_turn_requests";
    if (this.#lastMessageStopReason === "maxTokens") return "max_tokens";
    return "end_turn";
  }

  /** The session this mapper belongs to; kept for symmetry with `emit`. */
  get session(): string {
    return this.sessionId;
  }
}

/**
 * Build an ACP agent over the injected {@link AcpAgentDeps}.
 *
 * Register it on a connection with {@link AcpAgent.attach}, then call
 * `connection.listen()`. The lifecycle it serves is
 * `initialize` → `session/new` → `session/prompt` → a stream of
 * `session/update` notifications → the `session/prompt` response, with
 * `session/cancel` able to cut a turn short at any point.
 */
export function createAcpAgent(deps: AcpAgentDeps): AcpAgent {
  const sessions = new Map<string, SessionState>();
  let connection: AcpConnection | undefined;
  let sessionCounter = 0;
  /** Connection-scoped, exactly like the `initialize` handshake that sets it. */
  let clientCapabilities: AcpClientCapabilities = NO_CLIENT_CAPABILITIES;

  function requireConnection(): AcpConnection {
    if (!connection) throw new Error("createAcpAgent: attach(connection) has not been called.");
    return connection;
  }

  function notify(sessionId: string, update: AcpSessionUpdate): void {
    const params: AcpSessionNotification = { sessionId, update };
    requireConnection().sendNotification("session/update", params);
  }

  function nextSessionId(): string {
    if (deps.createSessionId) return deps.createSessionId();
    sessionCounter += 1;
    return `sess_${Date.now().toString(36)}_${sessionCounter}`;
  }

  function sessionFrom(params: unknown): SessionState {
    if (!isRecord(params) || typeof params.sessionId !== "string") {
      throw AcpError.invalidParams("Expected params.sessionId to be a string.");
    }
    const session = sessions.get(params.sessionId);
    if (!session) throw AcpError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
    return session;
  }

  /** Open one session's adapter-side state, capturing the handshake's capabilities. */
  function openSession(sessionId: string, cwd: string): SessionState {
    const state: SessionState = {
      id: sessionId,
      cwd,
      cancelled: false,
      pendingPermissions: new Set(),
      clientCapabilities,
      // Left unset here on purpose: a host only knows a session's mode once
      // its agent exists, which is after `createSession`/`loadSession` runs.
      modeId: undefined,
      costUsd: undefined,
    };
    sessions.set(sessionId, state);
    return state;
  }

  /**
   * Announce a permission-mode change the *client* did not ask for.
   *
   * Spec: "The Agent can also change its own mode and let the Client know by
   * sending the `current_mode_update` session notification" — agent-initiated
   * only, so `session/set_mode` deliberately updates `session.modeId` without
   * routing through here and is never echoed back.
   *
   * arcturn does have such a trigger: approving a plan through the `plan` tool
   * takes the agent out of `plan` mode mid-turn
   * (`@arcturn/core`'s `state-tools.ts` calls `setPermissionMode`). No
   * `AgentEvent` reports it, so this reconciles against the host's own
   * `getPermissionMode` after every event of a turn instead — a property read,
   * and the only signal that exists.
   */
  function syncMode(session: SessionState): void {
    const read = deps.getPermissionMode;
    if (!read) return;
    const current = read(session.id);
    if (current === session.modeId) return;
    session.modeId = current;
    notify(session.id, { sessionUpdate: "current_mode_update", currentModeId: current });
  }

  // --- initialize ---------------------------------------------------------

  function handleInitialize(params: unknown): AcpInitializeResult {
    const requested =
      isRecord(params) && typeof params.protocolVersion === "number"
        ? params.protocolVersion
        : ACP_PROTOCOL_VERSION;
    // Spec: the agent responds with the version it will speak — the lower of
    // the two when the client asks for something newer than it supports.
    const protocolVersion = Math.min(requested, ACP_PROTOCOL_VERSION);
    // Captured, not acted on: no `fs/*` or `terminal/*` call is made today
    // (see `attach`), but a bridge that adds one must be able to check what
    // this editor actually serves rather than calling blind.
    clientCapabilities = parseClientCapabilities(
      isRecord(params) ? params.clientCapabilities : undefined,
    );
    return {
      protocolVersion,
      agentCapabilities: {
        loadSession: deps.loadSession !== undefined,
        promptCapabilities: {
          // Declined until the deps seam accepts multimodal user content.
          image: false,
          audio: false,
          // `resource` blocks with inlined text are flattened into the prompt.
          embeddedContext: true,
        },
        // arcturn's own MCP manager (@arcturn/mcp) can bridge http/sse-transport
        // servers too, but session-scoped wiring (host.ts's per-session
        // McpManager) only accepts the required `stdio` variant of
        // `session/new`'s `mcpServers` today — see ACP-STATUS.md gap 2.
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: deps.agentInfo ?? { name: "arcturn", title: "Arcturn", version: "0.1.0" },
      // Empty: arcturn authenticates out of band (env/config), so the client
      // should proceed straight to `session/new`.
      // TODO(acp): implement the `authenticate` method if arcturn ever gains an
      // interactive login the editor should drive.
      authMethods: [],
    };
  }

  // --- session/new --------------------------------------------------------

  async function handleNewSession(params: unknown): Promise<AcpNewSessionResult> {
    if (!isRecord(params) || typeof params.cwd !== "string") {
      throw AcpError.invalidParams("session/new requires a string `cwd`.");
    }
    const sessionId = nextSessionId();
    const parsed: AcpNewSessionParams = { cwd: params.cwd };
    if (Array.isArray(params.mcpServers)) parsed.mcpServers = params.mcpServers as AcpMcpServer[];
    const session = openSession(sessionId, params.cwd);
    await deps.createSession?.(parsed, sessionId);
    const result: AcpNewSessionResult = { sessionId };
    if (deps.getPermissionMode && deps.setPermissionMode) {
      // Read after `createSession`: a host that only knows the mode once its
      // agent exists (as `host.ts` does) answers `undefined` before that.
      const currentModeId = deps.getPermissionMode(sessionId);
      session.modeId = currentModeId;
      result.modes = {
        currentModeId,
        availableModes: ACP_SESSION_MODES.map((mode) => ({ ...mode })),
      };
    }
    return result;
  }

  // --- session/load -------------------------------------------------------

  async function handleLoadSession(params: unknown): Promise<null> {
    const load = deps.loadSession;
    if (!load) throw AcpError.methodNotFound("session/load");
    if (
      !isRecord(params) ||
      typeof params.sessionId !== "string" ||
      typeof params.cwd !== "string"
    ) {
      throw AcpError.invalidParams("session/load requires string `sessionId` and `cwd`.");
    }
    const sessionId = params.sessionId;
    const session = openSession(sessionId, params.cwd);
    // Spec: "The Agent replays conversation history via session/update
    // notifications before responding to session/load."
    await load(
      {
        sessionId,
        cwd: params.cwd,
        ...(Array.isArray(params.mcpServers)
          ? { mcpServers: params.mcpServers as AcpMcpServer[] }
          : {}),
      },
      (update) => notify(sessionId, update),
    );
    // The resumed session's mode is only knowable once its agent exists; seed
    // it silently so the first genuine change is the first notification.
    session.modeId = deps.getPermissionMode?.(sessionId);
    return null;
  }

  // --- session/prompt -----------------------------------------------------

  async function handlePrompt(params: unknown): Promise<AcpPromptResult> {
    const session = sessionFrom(params);
    const raw = params as { prompt?: unknown };
    if (!Array.isArray(raw.prompt)) {
      throw AcpError.invalidParams("session/prompt requires a `prompt` array of content blocks.");
    }
    const blocks = raw.prompt as AcpContentBlock[];
    session.cancelled = false;

    const mapper = new TurnMapper(
      session.id,
      (update) => notify(session.id, update),
      (usage) => emitUsage(session, usage),
    );

    try {
      await deps.prompt(
        { sessionId: session.id, cwd: session.cwd, text: promptBlocksToText(blocks), blocks },
        (event) => {
          mapper.handle(event);
          // After, not before: a mode change lands while a tool is executing,
          // so the event that follows it is the earliest point it is visible.
          syncMode(session);
        },
      );
    } catch (raw2) {
      // Spec: "agents must catch these errors and return the cancelled stop
      // reason rather than propagating error responses".
      if (session.cancelled) return { stopReason: "cancelled" };
      const message = raw2 instanceof Error ? raw2.message : String(raw2);
      throw new AcpError(JSON_RPC_ERRORS.internalError, message);
    }

    // A turn that ended without an event (an immediate abort, say) still
    // needs its final mode reconciled before the response goes out.
    syncMode(session);
    if (session.cancelled) return { stopReason: "cancelled" };
    if (mapper.error !== undefined) {
      throw new AcpError(JSON_RPC_ERRORS.internalError, mapper.error);
    }
    return { stopReason: mapper.stopReason() };
  }

  /**
   * Emit one `usage_update` for a finished turn, if the host can size it.
   *
   * `used` is "tokens currently in context": the turn's prompt (`inputTokens`
   * plus the cached halves the provider bills separately) and the completion
   * it produced, which together are what the *next* turn will carry. `cost` is
   * cumulative across the session, as the spec's `Cost` requires, which is why
   * it is accumulated on the session rather than reported per turn.
   */
  function emitUsage(session: SessionState, usage: Usage): void {
    const facts = deps.sessionUsage?.(session.id, usage);
    if (facts === undefined) return;
    if (facts.costUsd !== undefined) session.costUsd = (session.costUsd ?? 0) + facts.costUsd;
    const update: AcpSessionUpdate = {
      sessionUpdate: "usage_update",
      used: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens,
      size: facts.contextWindow,
    };
    if (session.costUsd !== undefined) update.cost = { amount: session.costUsd, currency: "USD" };
    notify(session.id, update);
  }

  // --- session/cancel -----------------------------------------------------

  function handleCancel(params: unknown): void {
    if (!isRecord(params) || typeof params.sessionId !== "string") return;
    const session = sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    // Spec: outstanding `session/request_permission` calls must be settled
    // with a cancelled outcome before the turn ends.
    for (const resolve of session.pendingPermissions) {
      resolve({ requestId: "", behavior: "deny", message: "Cancelled by the editor." });
    }
    session.pendingPermissions.clear();
    deps.abort(session.id);
  }

  // --- session/set_mode ----------------------------------------------------

  function handleSetMode(params: unknown): null {
    if (
      !isRecord(params) ||
      typeof params.sessionId !== "string" ||
      typeof params.modeId !== "string"
    ) {
      throw AcpError.invalidParams("session/set_mode requires string `sessionId` and `modeId`.");
    }
    const sessionId = params.sessionId;
    const modeId = params.modeId;
    // Reuses the same "known session?" check session/prompt relies on, so an
    // editor cannot set a mode on a session id it never opened.
    const session = sessionFrom(params);
    const mode = ACP_SESSION_MODES.find((candidate) => candidate.id === modeId);
    if (!mode) {
      throw AcpError.invalidParams(
        `Unknown modeId "${modeId}". Available: ${ACP_SESSION_MODES.map((m) => m.id).join(", ")}.`,
      );
    }
    // `setPermissionMode` is only reachable once handleInitialize has already
    // required both hooks to advertise `modes` in the first place (see
    // `attach`'s conditional registration), so this is never undefined here.
    deps.setPermissionMode?.(sessionId, mode.id);
    // Recorded, not announced: the client asked for this change, so echoing a
    // `current_mode_update` back at it would be noise. Only a change the
    // client did not make gets notified — see `syncMode`.
    session.modeId = deps.getPermissionMode?.(sessionId) ?? mode.id;
    return null;
  }

  // --- permission bridge --------------------------------------------------

  function permissionPrompt(
    sessionId: string,
  ): (request: PermissionRequest) => Promise<PermissionDecision> {
    return async (request) => {
      const session = sessions.get(sessionId);
      const deny = (message: string): PermissionDecision => ({
        requestId: request.id,
        behavior: "deny",
        message,
      });
      if (!session || session.cancelled) return deny("Cancelled by the editor.");

      let settle: ((decision: PermissionDecision) => void) | undefined;
      const cancelled = new Promise<PermissionDecision>((resolve) => {
        settle = (decision) => resolve({ ...decision, requestId: request.id });
        session.pendingPermissions.add(settle);
      });

      const payload: AcpRequestPermissionParams = {
        sessionId,
        toolCall: {
          toolCallId: request.toolCallId,
          title: request.description || titleFor(request.toolName, {}),
          kind: toolKindFor(request.toolName),
          rawInput: { subject: request.subject },
        },
        options: [...PERMISSION_OPTIONS],
      };

      const asked = requireConnection()
        .sendRequest("session/request_permission", payload)
        .then((result): PermissionDecision => {
          const outcome = isRecord(result) && isRecord(result.outcome) ? result.outcome : undefined;
          if (outcome?.outcome !== "selected") return deny("Cancelled by the editor.");
          const optionId = typeof outcome.optionId === "string" ? outcome.optionId : "reject-once";
          const allow = optionId.startsWith("allow");
          const persist = optionId.endsWith("always");
          const decision: PermissionDecision = {
            requestId: request.id,
            behavior: allow ? "allow" : "deny",
          };
          if (persist && request.suggestedRule) {
            decision.persistRule = {
              ...request.suggestedRule,
              action: allow ? "allow" : "deny",
              scope: "session",
            };
          }
          if (!allow) decision.message = "Denied by the editor.";
          return decision;
        })
        .catch(() => deny("The editor could not answer the permission request."));

      try {
        return await Promise.race([asked, cancelled]);
      } finally {
        if (settle) session.pendingPermissions.delete(settle);
      }
    };
  }

  // --- attach -------------------------------------------------------------

  function attach(target: AcpConnection): void {
    connection = target;
    target.onRequest("initialize", (params) => handleInitialize(params));
    target.onRequest("session/new", (params) => handleNewSession(params));
    target.onRequest("session/prompt", (params) => handlePrompt(params));
    if (deps.loadSession) target.onRequest("session/load", (params) => handleLoadSession(params));
    if (deps.getPermissionMode && deps.setPermissionMode) {
      target.onRequest("session/set_mode", (params) => handleSetMode(params));
    }
    target.onNotification("session/cancel", (params) => handleCancel(params));
    // Unimplemented on purpose (see ACP-STATUS.md):
    // TODO(acp): `authenticate` — no auth methods are advertised.
    // `fs/read_text_file`, `fs/write_text_file` and `terminal/*` are *client*
    // methods; arcturn uses its own sandboxed tools instead of calling them.
    // What the editor offers on those is now captured (see
    // `AcpAgent.clientCapabilities`) so a future bridge can check before it
    // calls; nothing acts on it yet.
  }

  return {
    attach,
    permissionPrompt,
    get sessionIds() {
      return [...sessions.keys()];
    },
    get clientCapabilities() {
      return clientCapabilities;
    },
    sessionInfo(sessionId: string): AcpSessionInfo | undefined {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      return {
        id: session.id,
        cwd: session.cwd,
        clientCapabilities: session.clientCapabilities,
        modeId: session.modeId,
      };
    },
  };
}
