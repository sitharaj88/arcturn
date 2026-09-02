/**
 * {@link createProtocolClient} — the client half of the Arcturn wire protocol.
 *
 * `@arcturn/server`'s {@link https://developer.mozilla.org/docs/Web/API/WebSocket | WebSocket}
 * transport (`ws-server.ts`) exposes a `SessionHost` over **one JSON text
 * frame per message**; this module speaks the other end of that conversation
 * so `arcturn attach` can drive a remote session as if it held a local
 * `SessionHost`.
 *
 * Two deliberate transport decisions, both mirroring `ws-server.ts`:
 *
 * 1. **No `FrameDecoder`.** `framing.ts` implements NDJSON reassembly for
 *    *stream* transports, where a frame's bytes may be split or coalesced
 *    arbitrarily. A WebSocket already preserves message boundaries, and the
 *    server sends `ws.send(JSON.stringify(message))` with no trailing
 *    newline — feeding that to `FrameDecoder` would buffer forever waiting
 *    for a `"\n"` that never arrives. Each inbound WebSocket message is
 *    therefore parsed as exactly one JSON document, and each outbound
 *    request is sent as `JSON.stringify(request)` (no `encodeFrame`), which
 *    is what the server's `JSON.parse(rawDataToUtf8(data))` expects.
 * 2. **Never trust inbound shapes.** Every inbound message goes through
 *    {@link validateServerMessage} before it is routed, and every response
 *    payload this client hands back to a caller is re-validated (session
 *    headers via {@link validateSessionHeader}). A message that fails
 *    validation is reported through {@link ProtocolClientOptions.onProtocolError}
 *    and dropped — it never throws into the socket's event handler.
 *
 * Reconnection is out of scope: this client drives one socket for its
 * lifetime, and a closed socket is terminal (see `INTEGRATION-protocol-client.md`).
 */

import type {
  AdoptBackgroundAgentResult,
  AgentEvent,
  ApplyChangesResult,
  BackgroundAgentList,
  CancelBackgroundAgentResult,
  CheckpointList,
  CommandList,
  CompactionSummary,
  ContextResolution,
  DiscardChangesResult,
  LineRange,
  McpAuthBegun,
  McpPromptList,
  McpPromptRendering,
  McpResourceContents,
  McpResourceEntry,
  McpResourceList,
  McpStatus,
  ModelCatalog,
  OrgMemoryList,
  OrgMemoryProposal,
  PendingChanges,
  PermissionDecision,
  PermissionMode,
  PermissionScope,
  PermissionState,
  PromptAttachment,
  RewindResult,
  ScoutRun,
  ScoutStarted,
  ServerCapabilities,
  SessionExport,
  SessionHeader,
  SessionHistory,
  StartedBackgroundAgent,
  TranscriptFormat,
  WorkflowCatalog,
  WorkflowRunHandle,
  WorkflowRuns,
} from "@arcturn/types";
import { PROTOCOL_VERSION } from "@arcturn/types";
import { ErrorCode } from "./messages.js";
import { RequestIdGenerator } from "./request-id.js";
import {
  validateAdoptBackgroundAgentResult,
  validateApplyChangesResult,
  validateBackgroundAgentList,
  validateCancelBackgroundAgentResult,
  validateCheckpointList,
  validateClientRequest,
  validateCommandList,
  validateCompactionSummary,
  validateContextResolution,
  validateDiscardChangesResult,
  validateMcpStatus,
  validateModelCatalog,
  validateOrgMemoryList,
  validateOrgMemoryProposal,
  validatePendingChanges,
  validatePermissionState,
  validateRewindResult,
  validateServerCapabilities,
  validateServerMessage,
  validateSessionExport,
  validateSessionHeader,
  validateSessionHistory,
  validateStartedBackgroundAgent,
  validateWorkflowCatalog,
  validateWorkflowRunHandle,
  validateWorkflowRuns,
} from "./validate.js";

/** Default per-request deadline, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** `WebSocket.OPEN` — the numeric `readyState` meaning "ready to send". */
const READY_STATE_OPEN = 1;

/**
 * The minimal socket surface {@link createProtocolClient} needs.
 *
 * This is the **Node `EventEmitter` shape** (`on("message" | "open" |
 * "close" | "error", listener)`) rather than the browser-style
 * `onmessage`/`onclose` properties, because it is the shape of the `ws`
 * package that `@arcturn/server` already depends on and uses throughout
 * `ws-server.ts` (`ws.on("message", ...)`, `ws.on("close", ...)`). A real
 * `ws` `WebSocket` satisfies this interface structurally with no adapter.
 *
 * `ws` is deliberately **not** a dependency of `@arcturn/protocol` — this
 * package stays dependency-free apart from `@arcturn/types`, so the socket
 * is injected: the CLI constructs a real `ws` `WebSocket` and hands it in
 * (see `INTEGRATION-protocol-client.md`). A browser-style socket (including
 * Node's global `WebSocket`) needs a ~10-line adapter, also documented there.
 *
 * Listener parameters are typed loosely (`unknown`) on purpose: `ws` delivers
 * message payloads as `Buffer | ArrayBuffer | Buffer[]`, and this client
 * normalizes all of those to text itself.
 */
export interface WebSocketLike {
  /**
   * Current connection state, using the standard `WebSocket` constants
   * (`0` CONNECTING, `1` OPEN, `2` CLOSING, `3` CLOSED). Optional: a socket
   * that does not report one is assumed to be open already, which is what
   * makes plain in-memory fakes usable without simulating a handshake.
   */
  readonly readyState?: number;
  /** Send one text frame. */
  send(data: string): void;
  /** Begin closing the connection. */
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/**
 * Client-side failure codes, used where no server {@link ErrorCode} applies.
 * Server-originated rejections carry the server's own code string instead.
 */
export const ClientErrorCode = {
  /** The request deadline elapsed before a response arrived. */
  timeout: "timeout",
  /** The socket closed (or errored) while the request was in flight. */
  closed: "closed",
  /** A response arrived but its payload was not the documented shape. */
  invalidResponse: "invalidResponse",
  /** The peer speaks a wire revision this client cannot interpret. */
  versionMismatch: "versionMismatch",
} as const;

/** A value of {@link ClientErrorCode}. */
export type ClientErrorCode = (typeof ClientErrorCode)[keyof typeof ClientErrorCode];

/**
 * Base class for every rejection produced by a {@link ProtocolClient}.
 *
 * `code` is either a server {@link ErrorCode} (for errors the server
 * reported) or a {@link ClientErrorCode} (for locally detected failures), so
 * a caller can branch on `error.code` without caring which side failed.
 */
export class ProtocolClientError extends Error {
  /** Machine-readable failure code. */
  readonly code: string;
  /** The request id this failure belongs to, when it is request-scoped. */
  readonly requestId: string | undefined;
  /** The wire method that failed, when it is request-scoped. */
  readonly method: string | undefined;

  constructor(
    code: string,
    message: string,
    details: { requestId?: string; method?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ProtocolClientError";
    this.code = code;
    this.requestId = details.requestId;
    this.method = details.method;
  }
}

/**
 * The server answered with a `response` frame carrying an `error`. `code` is
 * the server's code — normally one of {@link ErrorCode}'s values.
 */
export class ProtocolRequestError extends ProtocolClientError {
  constructor(code: string, message: string, details: { requestId: string; method: string }) {
    super(code, message, details);
    this.name = "ProtocolRequestError";
  }
}

/** The request deadline elapsed with no response. */
export class ProtocolTimeoutError extends ProtocolClientError {
  /** The deadline that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, details: { requestId: string; method: string }) {
    super(
      ClientErrorCode.timeout,
      `Request "${details.method}" (${details.requestId}) timed out after ${timeoutMs}ms`,
      details,
    );
    this.name = "ProtocolTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The socket closed or errored; every in-flight request fails with this. */
export class ProtocolClosedError extends ProtocolClientError {
  /** WebSocket close code, when the peer supplied one. */
  readonly closeCode: number | undefined;

  constructor(
    message: string,
    details: { requestId?: string; method?: string; closeCode?: number; cause?: unknown } = {},
  ) {
    super(ClientErrorCode.closed, message, details);
    this.name = "ProtocolClosedError";
    this.closeCode = details.closeCode;
  }
}

/**
 * The peer advertised a wire revision this client does not implement.
 *
 * Detected in two places, since the wire has no explicit version handshake
 * today (see `INTEGRATION-protocol-client.md`):
 * - the `authenticate` response's `protocolVersion`, when the server sends
 *   one (the current server omits it, which is read as "compatible");
 * - a {@link SessionHeader}'s `version`, which is stamped `1` — the same
 *   revision as {@link PROTOCOL_VERSION}. A header stamped with anything
 *   else cannot be safely interpreted, and saying so beats a vague
 *   "SessionHeader.version must be 1" validation failure.
 */
export class ProtocolVersionMismatchError extends ProtocolClientError {
  /** The version this client implements. */
  readonly expected: number;
  /** The version the peer advertised. */
  readonly received: number;

  constructor(expected: number, received: number, context: string) {
    super(
      ClientErrorCode.versionMismatch,
      `Protocol version mismatch (${context}): this client speaks version ${expected}, the server speaks version ${received}`,
    );
    this.name = "ProtocolVersionMismatchError";
    this.expected = expected;
    this.received = received;
  }
}

/** Construction options for {@link createProtocolClient}. */
export interface ProtocolClientOptions {
  /**
   * Shared secret for a server started with a `token`. When set, an
   * `authenticate` frame is sent as the **first** frame on the socket (the
   * server closes any connection whose first frame is anything else), and
   * every other request waits for that handshake to succeed.
   */
  token?: string;
  /**
   * Per-request deadline. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS};
   * `0` (or any non-positive value) disables deadlines entirely.
   *
   * Note that `prompt` resolves when the *run* ends, not when the server
   * accepts it (`SessionHost.prompt` awaits the agent), so an interactive
   * caller wants a generous deadline — or none — and should treat the
   * `runStart` event as the acknowledgement.
   */
  requestTimeoutMs?: number;
  /**
   * Called for inbound traffic that could not be routed: malformed JSON,
   * frames that fail {@link validateServerMessage}, responses for unknown
   * request ids (a late answer to an already-timed-out request), and
   * exceptions thrown by an {@link ProtocolClient.onEvent} listener. Such
   * traffic is always dropped rather than thrown — the socket stays usable.
   */
  onProtocolError?: (error: ProtocolClientError) => void;
}

/** Listener registered via {@link ProtocolClient.onEvent}. */
export type ProtocolEventListener = (sessionId: string, event: AgentEvent) => void;

/**
 * A connected Arcturn protocol client. The method surface mirrors the server's
 * `SessionHost` so remote code reads like local code; each call resolves when
 * the matching `response` frame arrives, and rejects with a
 * {@link ProtocolClientError} subclass on server error, timeout, socket
 * close, or an unusable payload.
 */
export interface ProtocolClient {
  /**
   * Complete the shared-token handshake. A no-op resolving immediately when
   * no `token` was configured. Idempotent: repeated calls return the same
   * in-flight (or settled) handshake, and the handshake is started eagerly at
   * construction so the `authenticate` frame is always the first frame sent.
   */
  authenticate(): Promise<void>;
  /**
   * Optional behaviour this server advertised on the `authenticate`
   * handshake — e.g. `{ ceilingRaise: true }` for `arcturn serve
   * --allow-ceiling-raise`.
   *
   * `{}` in three cases a caller does not need to tell apart: the handshake
   * has not settled yet, this client was built with no `token` (so no
   * `authenticate` frame is ever sent — see {@link ProtocolClient.authenticate}),
   * or the server predates this field. Every property is therefore
   * optional-on-read; test one explicitly (`=== true`) rather than assuming
   * absence means "no". Call {@link ProtocolClient.authenticate} first (or any
   * other verb, which awaits the same handshake) if the caller cares about a
   * fresh answer rather than whatever raced the socket open.
   */
  capabilities(): ServerCapabilities;
  /** List every session the server knows about. */
  listSessions(): Promise<SessionHeader[]>;
  /** Create a new session and return its header. */
  createSession(params: { cwd: string; model?: string }): Promise<SessionHeader>;
  /**
   * Attach to an existing session. Also subscribes this connection to that
   * session's events server-side, so {@link ProtocolClient.onEvent} listeners
   * start receiving its {@link AgentEvent}s.
   */
  openSession(sessionId: string): Promise<SessionHeader>;
  /**
   * Start a run from a user prompt. Resolves when the server accepts it.
   *
   * `text` is sent **unexpanded**: `@path` mentions are resolved by the engine,
   * against the session's `cwd` and under its workspace confinement. A client
   * must not read a file to build this string — RFC 0005 §3, and the reason is
   * that a file read by a client is a file the permission engine never saw.
   *
   * ### Attachments do not degrade, and this method enforces that
   *
   * `attachments` is a new *parameter* on an old verb, which makes its
   * old-server behaviour worse than a new verb's: an engine that predates
   * RFC 0005 recognises `prompt`, validates it, drops the field it does not
   * know, and answers `ok`. The turn is spent, the model never sees the file,
   * and the client is told everything went fine — the same lie
   * {@link ProtocolClient.deleteSession} refuses to tell about a deletion that
   * did not happen.
   *
   * So when `attachments` is non-empty this client checks first, once per
   * session, by probing {@link ProtocolClient.resolveContext} — the verb that
   * shipped alongside the field, and whose absence is the honest signal that
   * the field will be ignored. An engine without it **rejects** here, locally,
   * before anything is sent. A prompt with no attachments never pays for the
   * probe and behaves exactly as it always did.
   *
   * A `file` attachment's `range` is the same argument one level down, and it
   * degrades *worse*: an engine that has `resolveContext` but predates ranges
   * validates the attachment, drops the field it does not know, and sends the
   * model the **whole file** while answering `ok` — a client asking about
   * lines 12–40 of an 800-line file would be billed for all 800 and told
   * nothing. The one probe answers both questions: it carries a range, and an
   * engine that understands ranges echoes it back on
   * {@link ContextResolution.range}. A ranged attachment to an engine that
   * does not is rejected locally, with nothing sent.
   *
   * A `fileReference` is the third of these, and it degrades in the *opposite*
   * direction — which is why it is spelled as a kind and not as a flag on
   * `file`. An engine that predates the kind refuses the frame itself
   * (`PromptAttachment.kind must be one of …`), so the failure mode is a
   * refused prompt rather than the whole file arriving at the user's expense.
   * The same probe reads {@link ContextResolution.attachmentKinds} and refuses
   * locally anyway, for the message and for the round trip — not because the
   * wire needs saving from itself here.
   *
   * @param sessionId - Session to run in.
   * @param text - The prompt as typed, mentions left in place.
   * @param attachments - Optional context, named by path (or, for a pasted
   *   image, carried inline). See {@link PromptAttachment}.
   * @throws {ProtocolRequestError} `invalidRequest` when the engine cannot
   *   honour attachments at all (or their line ranges), or refuses these ones
   *   (outside the workspace, over the byte budget, an image for a model with
   *   no vision, a range starting past the end of the file).
   */
  prompt(sessionId: string, text: string, attachments?: readonly PromptAttachment[]): Promise<void>;
  /**
   * Queue a mid-run steering message.
   *
   * The engine expands `@`-mentions and a leading `/name` in `text` exactly as
   * {@link ProtocolClient.prompt} does, so a command inserted while a run is in
   * flight means what it means when the session is idle. An engine that
   * predates that expands neither and queues the text as written; there is no
   * probe for it, because a steer that is only prose is unaffected either way.
   *
   * @param sessionId - Session to steer.
   * @param text - The message as typed, mentions and `/name` left in place.
   * @throws {ProtocolRequestError} `invalidRequest` when `text` names a command
   *   the engine cannot expand — nothing is queued.
   */
  steer(sessionId: string, text: string): Promise<void>;
  /** Abort the session's current run. */
  abort(sessionId: string): Promise<void>;
  /** Switch the session's model. */
  setModel(sessionId: string, modelId: string): Promise<void>;
  /**
   * Answer a pending permission request.
   *
   * `options.scope` says how long an allow lasts, and is the difference
   * between the two buttons a permission modal actually wants to offer:
   *
   * - **omitted** — allow once.
   * - **`"session"`** — allow for the rest of this session. The *engine* mints
   *   the rule from the {@link PermissionRequest.suggestedRule} it put on the
   *   ask; this client never authors one. Offer this button only when the
   *   request carries a `suggestedRule` — that field is how the engine reports
   *   the request is repeatable — because asking for `"session"` on a
   *   non-repeatable request is refused, not quietly downgraded.
   * - **`"project"` / `"user"`** — rejected locally, before the frame is sent.
   *   Nothing persists to disk from a remote client; a rule that outlives a
   *   session is written by a person in their own config.
   *
   * A server that predates `scope` drops the field and the allow lands as an
   * allow-once, so the user is asked again next time. That degradation
   * narrows and never widens, which is the only direction this may move
   * silently.
   *
   * @param sessionId - Session that raised the request.
   * @param decision - The decision, quoting the request's `requestId`.
   * @param options - `scope`, when the allow should outlast this one call.
   */
  respondToPermission(
    sessionId: string,
    decision: PermissionDecision,
    options?: { scope?: PermissionScope },
  ): Promise<void>;
  /**
   * Fetch the server's model catalog, for rendering a picker.
   *
   * `listModels` is an **optional** verb: it was added after the first
   * servers shipped, and a server that predates it rejects the request with
   * `invalidRequest` ("Unknown method") rather than closing the connection.
   * That rejection is not an error a caller should have to handle, so it is
   * translated here into `undefined` — "this server has no catalog verb" —
   * leaving the caller to degrade to whatever it did before. Every other
   * failure (a real server-side fault, a timeout, a closed socket, an
   * unusable payload) still rejects, so a broken catalog is never silently
   * indistinguishable from an old server.
   *
   * @returns The catalog, or `undefined` when the server does not implement
   *   the verb.
   */
  listModels(): Promise<ModelCatalog | undefined>;
  /**
   * Fetch a session's stored conversation, so a freshly attached client can
   * render what was already said.
   *
   * `openSession` subscribes to *future* events and replays nothing; this is
   * the verb that answers "what happened before I got here". The result
   * carries the same {@link AgentEvent}s the live stream does, so a caller
   * folds them through whatever reducer it already runs on
   * {@link ProtocolClient.onEvent} — see {@link SessionHistory}.
   *
   * The payload is **bounded** by the server and reports its own truncation:
   * a caller that sees `truncated` must tell the user earlier messages are
   * not shown rather than silently starting mid-conversation.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}: a server
   * that predates the verb rejects it with `invalidRequest` and that one
   * rejection is translated here into `undefined` — "this server cannot
   * replay history" — leaving the caller to show the empty transcript it
   * showed before. Every other failure still rejects. Safe to translate
   * because the verb only *reads*: `undefined` costs the caller a transcript,
   * not a guarantee.
   *
   * @param sessionId - Session whose history to fetch.
   * @returns The history, or `undefined` when the server does not implement
   *   the verb.
   */
  sessionHistory(sessionId: string): Promise<SessionHistory | undefined>;
  /**
   * Delete a session permanently. Irreversible.
   *
   * Deliberately **not** given `listModels`' "old server → `undefined`"
   * treatment. That translation is safe for a read: the caller loses a list.
   * For a destructive verb it would be a lie — nothing was deleted, and a
   * caller told "fine" would refresh its list, still see the session, and have
   * no idea why. So an older server's `invalidRequest` rejects like any other
   * failure; a caller that wants to say "this engine is too old" rather than
   * quoting `Unknown method` can test the error with
   * {@link isUnsupportedMethodError}.
   *
   * @param sessionId - Session to remove.
   * @throws {ProtocolRequestError} `sessionBusy` when the session is running a
   *   turn (abort it first), `sessionNotFound` when it does not exist,
   *   `invalidRequest` from a server that does not implement the verb.
   */
  deleteSession(sessionId: string): Promise<void>;
  /**
   * Ask what a mention would resolve to, without sending anything.
   *
   * This is what lets a file picker be honest rather than hopeful: the answer
   * carries the resolved path, the byte count, whether the file exists, and
   * whether it lands inside the session's workspace — the last being the one
   * that decides whether the engine would read it at all.
   *
   * Read-only. Nothing is attached, no turn starts, and a query that fails
   * confinement is answered without the engine touching the filesystem.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}: an engine
   * that predates the verb rejects it with `invalidRequest` and that single
   * rejection becomes `undefined`. Safe to translate for the reason
   * `sessionHistory` is — the verb only reads, so `undefined` costs a caller a
   * preview, never a guarantee. It is also the signal
   * {@link ProtocolClient.prompt} reads before sending attachments.
   *
   * @param sessionId - Session whose `cwd` the query resolves against.
   * @param query - The mention text, as typed, without its `@`.
   * @param range - A selection to ask about. The answer echoes it back on
   *   {@link ContextResolution.range}, and an engine that does not understand
   *   ranges answers without it — which is how {@link ProtocolClient.prompt}
   *   knows not to send one. The engine does **not** read the file to check
   *   the range here; whether it fits is answered at prompt time.
   * @returns The resolution, or `undefined` when the engine has no such verb.
   */
  resolveContext(
    sessionId: string,
    query: string,
    range?: LineRange,
  ): Promise<ContextResolution | undefined>;
  /**
   * Read the permission regime this session runs under: its mode, its rules,
   * and the names of the tools it holds.
   *
   * The tool names are the answer to "can this engine reach the web" — RFC
   * 0005 §1.4 adds no verb for that, because the question is really "is
   * `fetch` in the tool set", and a UI that renders a browse affordance
   * without checking is implying a capability it has not confirmed.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}: read-only,
   * so an engine that predates the verb rejects with `invalidRequest` and that
   * one rejection becomes `undefined`. A caller that gets `undefined` shows no
   * mode chip and no tools line, which is exactly what it knows.
   *
   * @param sessionId - Session to inspect.
   * @returns Its permission state, or `undefined` when the engine has no such verb.
   */
  permissionState(sessionId: string): Promise<PermissionState | undefined>;
  /**
   * Ask the session to run under a different permission mode.
   *
   * A mode is a **request**, not a grant: a stored `deny` rule still outranks
   * `yolo`, exactly as it does for the person at the terminal, and this call
   * never edits a rule. What comes back is the engine's own answer to "what am
   * I now" — read the returned state rather than assuming the mode you asked
   * for is the mode you got.
   *
   * Deliberately **not** given `listModels`' "old engine → `undefined`"
   * treatment, and this is the verb where that translation would do the most
   * damage. Told "fine" by an engine that ignored it, a panel would show a
   * `plan` chip over a session still in `yolo`: the user believes they have
   * restricted the agent, and the next write executes. So an older engine's
   * `invalidRequest` rejects like any other failure; a caller that wants to
   * say "this engine is too old to change modes" tests the rejection with
   * {@link isUnsupportedMethodError} rather than showing `Unknown method`.
   *
   * @param sessionId - Session to change.
   * @param mode - The mode to run under from the next turn.
   * @returns The resulting permission state, as the engine reports it.
   * @throws {ProtocolRequestError} `sessionBusy` while a run is in flight (a
   *   mode may not change halfway through a turn — abort, or wait for
   *   `runEnd`), `sessionNotFound` when the session is not live,
   *   `invalidRequest` from an engine that does not implement the verb.
   */
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<PermissionState>;
  /**
   * List what a `/` could invoke on this engine: the workspace's markdown
   * skills, plus the built-ins this wire can actually carry out.
   *
   * Nothing is listed that a client cannot run — a menu offering `/rewind` to
   * a client with no rewind verb is a menu that lies. Execution stays
   * {@link ProtocolClient.prompt}: a skill is prompt text, and there is no
   * second execution path to keep in sync with the first.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}: read-only,
   * so an older engine's `invalidRequest` becomes `undefined` and a caller
   * simply shows no `/` menu.
   *
   * @returns The command list, or `undefined` when the engine has no such verb.
   */
  listCommands(): Promise<CommandList | undefined>;
  /**
   * Summarise the head of this session's conversation to free up context —
   * the terminal's `/compact`, over the wire.
   *
   * There is one compactor and this is a door onto it: the engine runs
   * `Agent.compact()`, the same call the terminal makes and the same one the
   * run loop makes automatically. What comes back is a report rather than an
   * acknowledgement — the token estimate before and after — because a client
   * that cannot say how much context it freed cannot tell a compaction that
   * worked from one that found nothing old enough to fold. Read
   * {@link CompactionSummary.compacted} first: `false` is a *successful*
   * answer with `reason` explaining it, not a failure.
   *
   * Deliberately **not** given `listModels`' "old engine → `undefined`"
   * treatment, on the {@link ProtocolClient.deleteSession} counter-precedent.
   * A caller told "fine" by an engine that ignored this would report freed
   * context that was never freed, keep filling the window, and hit the wall it
   * had just asked to have moved. A caller that wants to say "this engine is
   * too old to compact" tests the rejection with
   * {@link isUnsupportedMethodError}.
   *
   * @param sessionId - Session to compact.
   * @returns What the conversation cost before and after.
   * @throws {ProtocolRequestError} `sessionBusy` while a run is in flight
   *   (compaction rewrites the message array the loop is iterating — abort, or
   *   wait for `runEnd`), `sessionNotFound` when the session is not live,
   *   `invalidRequest` from an engine that does not implement the verb.
   */
  compact(sessionId: string): Promise<CompactionSummary>;
  /**
   * Render this session's conversation as a document — and save it yourself.
   *
   * The engine writes **nothing**. `/export` in a terminal drops a file next
   * to the person who ran it; over a socket that same behaviour would put a
   * file on the engine's disk, which is the wrong machine and an
   * arbitrary-write primitive besides. So the content comes back with a
   * suggested `filename`, and where it lands is the caller's decision.
   *
   * The payload is **bounded** at 1 MiB and reports its own truncation: a
   * caller that sees {@link SessionExport.truncated} must say that earlier
   * messages are missing rather than presenting a partial transcript as the
   * conversation — the same obligation {@link ProtocolClient.sessionHistory}
   * carries.
   *
   * Requires an **open** session: this renders what the agent is holding, and
   * an engine that has not materialised the session is holding nothing.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}: it only
   * reads, so an older engine's `invalidRequest` becomes `undefined` and a
   * caller offers no export.
   *
   * @param sessionId - Session to render.
   * @param options - `format` (default `"markdown"`) and `includeThinking`
   *   (default `false`) — the terminal's `/export` defaults.
   * @returns The document, or `undefined` when the engine has no such verb.
   */
  exportSession(
    sessionId: string,
    options?: { format?: TranscriptFormat; includeThinking?: boolean },
  ): Promise<SessionExport | undefined>;
  /**
   * List this engine's MCP servers: name, transport, connection state, tool
   * count.
   *
   * **Names and status only.** No `url`, no `command`, no `args`, no `env`, no
   * headers, no OAuth token, and no server-supplied error prose — see
   * {@link McpServerSummary}, whose omissions are the point. A caller that
   * wants to know why a server failed reads the engine's log.
   *
   * Not session-scoped: MCP servers belong to the engine, so this is shaped
   * like {@link ProtocolClient.listModels}.
   *
   * Optional, on the same terms: read-only, so an older engine's
   * `invalidRequest` becomes `undefined` and a caller shows no listing rather
   * than an empty one — "this engine has no MCP servers" and "this engine
   * cannot tell me" are not the same news.
   *
   * @returns The listing, or `undefined` when the engine has no such verb.
   */
  mcpStatus(): Promise<McpStatus | undefined>;
  /**
   * Begin authorizing an OAuth-protected MCP server, catching the redirect
   * yourself.
   *
   * Pass a `redirectUri` this client can actually receive on. An editor passes
   * one of its own URIs, which is the point: the engine's loopback redirect is
   * unreachable whenever the browser is on another machine, and an editor
   * attached over SSH or to a devcontainer is exactly that case.
   *
   * Resolves to `{ authorized: true }` when stored credentials were refreshed
   * and no browser is needed. Otherwise open `authorizationUrl`, catch the
   * redirect, and pass its `code` and `state` to
   * {@link ProtocolClient.mcpAuthComplete}.
   *
   * **Degrades to `undefined`** on the `listModels` precedent: an engine
   * without the verb costs the caller this route to authorization, not the
   * connection, and the fallback is to tell the user to run `arcturn mcp auth`.
   */
  mcpAuthBegin(server: string, redirectUri: string): Promise<McpAuthBegun | undefined>;
  /**
   * Finish an authorization with the code and state the redirect carried.
   *
   * Deliberately **not** given `listModels`' "old engine → `undefined`"
   * degradation: this is only ever called after a `mcpAuthBegin` that
   * succeeded, so the verb is known to exist, and swallowing a rejection here
   * would turn a failed exchange into a silent no-op the user reads as success.
   *
   * @throws {ProtocolRequestError} When the handle is unknown or spent, when
   *   `state` does not match, or when the token exchange fails.
   */
  mcpAuthComplete(handle: string, code: string, state: string): Promise<void>;
  /**
   * Abandon an authorization begun by {@link ProtocolClient.mcpAuthBegin}.
   *
   * Resolves `false` when the handle was already gone — a client cancelling
   * after the engine's own timeout, which is a race rather than a fault.
   */
  mcpAuthCancel(handle: string): Promise<boolean>;
  /**
   * Start a scout run: two or more approaches, each in its own throwaway git
   * worktree, raced against the engine's deadline.
   *
   * Returns a run id, not a report. Poll {@link ProtocolClient.scoutRun} for
   * progress — results appear there as each approach settles.
   *
   * **Degrades to `undefined`** on the `listModels` precedent: an engine
   * without the verb costs the caller this route, not the connection.
   */
  startScout(
    approaches: readonly { name: string; task: string }[],
  ): Promise<ScoutStarted | undefined>;
  /**
   * How a scout run is going, and what has settled so far.
   *
   * Deliberately **not** given the `undefined` degradation: it is only ever
   * called after a `startScout` that succeeded, so the verb is known to exist.
   */
  scoutRun(runId: string): Promise<ScoutRun>;
  /** Stop a scout run. `false` when it was unknown or had already settled. */
  cancelScout(runId: string): Promise<boolean>;
  /**
   * What the configured MCP servers publish as *resources* — context a server
   * offers rather than an action it performs.
   *
   * Attach one by naming it in a `{ kind: "mcpResource" }` attachment; the
   * engine does the reading, inside the same byte budget a file gets.
   *
   * **Degrades to `undefined`** on the `listModels` precedent.
   */
  mcpResources(server?: string): Promise<McpResourceList | undefined>;
  /**
   * Read one resource, for preview.
   *
   * What comes back is untrusted text a remote server wrote. Render it as
   * text, never as markup.
   */
  mcpReadResource(server: string, uri: string): Promise<McpResourceContents>;
  /**
   * What the configured MCP servers publish as prompt *templates*.
   *
   * These also arrive in `listCommands` as `kind: "mcpPrompt"`, named
   * `server:name`. This verb exists for the argument metadata, which a command
   * descriptor has no room for.
   *
   * **Degrades to `undefined`** on the `listModels` precedent.
   */
  mcpPrompts(server?: string): Promise<McpPromptList | undefined>;
  /** Render one prompt template with the arguments it declares. */
  mcpGetPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<McpPromptRendering>;
  /**
   * Ask what a `--dry-run` session is holding back for review.
   *
   * Read {@link PendingChanges.dryRun} before the list: an engine that is not
   * running under `--dry-run` answers `dryRun: false` with no changes, and
   * that is not the same news as a dry-run session with nothing pending yet.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}: it only
   * reads, so an older engine's `invalidRequest` becomes `undefined` and a
   * caller shows no review surface at all — which is honest, since that engine
   * could not have applied anything either.
   *
   * @param sessionId - Session to ask about.
   * @param path - One pending change's `path`, to fetch its content. Omit for
   *   the metadata-only list; see the verb's own doc for the payload argument.
   * @returns The pending set, or `undefined` when the engine has no such verb.
   */
  pendingChanges(sessionId: string, path?: string): Promise<PendingChanges | undefined>;
  /**
   * Write pending dry-run changes back over the real workspace files.
   *
   * Deliberately **not** given the `undefined` treatment
   * {@link ProtocolClient.pendingChanges} gets, and this is the sharpest case
   * in this interface for the asymmetry: an older engine rejects, and a client
   * that translated the rejection into a resolve would tell a reviewer their
   * change had landed. It has not, and the reviewer's next move is to discard
   * the shadow tree that held the only copy of it.
   *
   * @param sessionId - Session whose changes to land.
   * @param paths - A subset, spelled exactly as `PendingChange.path` reported
   *   it. Omit to apply everything. A path that is not pending refuses the
   *   whole call rather than applying the rest.
   * @returns What landed, what did not and why, and how much is still pending.
   * @throws {ProtocolRequestError} `sessionBusy` while any session on this
   *   engine is running a turn (one engine, one shadow tree), `invalidRequest`
   *   when the session is not in dry-run mode, when a named path is not
   *   pending, or from an engine that does not implement the verb.
   */
  applyChanges(sessionId: string, paths?: readonly string[]): Promise<ApplyChangesResult>;
  /**
   * Throw pending dry-run changes away. **Irreversible** — confirm with the
   * user before calling this, the way a session delete is confirmed.
   *
   * Not degradable, for the reason {@link ProtocolClient.applyChanges} is not,
   * pointed the other way: a discard that resolved against an engine which did
   * nothing would leave a user certain their pending edits were gone while
   * they sat waiting for the next apply.
   *
   * @param sessionId - Session whose changes to throw away.
   * @param paths - A subset, on the same terms as `applyChanges`. Omit for all.
   * @returns What was thrown away, and how much is still pending.
   * @throws {ProtocolRequestError} On the same terms as `applyChanges`.
   */
  discardChanges(sessionId: string, paths?: readonly string[]): Promise<DiscardChangesResult>;
  /**
   * List the background agents this engine knows about, or fetch one with its
   * transcript.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}: it only
   * reads, so an older engine's `invalidRequest` becomes `undefined` and a
   * caller shows no background-agent surface at all. That is the right
   * degradation here rather than an empty list, because "this engine has none"
   * and "this engine cannot tell you" are different things and only one of
   * them means the button should be hidden.
   *
   * @param id - Narrow to one agent and include its rendered transcript. Omit
   *   for the whole listing, newest first, without transcripts.
   * @returns The agents, or `undefined` when the engine has no such verb.
   */
  backgroundAgents(id?: string): Promise<BackgroundAgentList | undefined>;
  /**
   * Start one background agent on `task`.
   *
   * **This spends money.** The engine caps what it can spend it on — the
   * task is the only thing this call carries, and the agent's tools,
   * permission mode, working directory and model all come from the engine's
   * own defaults — but it does not cap *how much*, any more than a `/bg` typed
   * at a terminal does. Treat it the way a client treats `prompt`.
   *
   * Deliberately not given the `undefined` treatment
   * {@link ProtocolClient.backgroundAgents} gets: an older engine's
   * `invalidRequest` rejects, because a caller told "fine" by an engine that
   * ignored this would poll forever for an agent that was never started.
   *
   * @param task - What the agent should do. Its sole prompt.
   * @returns The id to ask about, and the child's session id.
   * @throws {ProtocolRequestError} `invalidRequest` for an empty task, or from
   *   an engine with no background-agent manager wired.
   */
  startBackgroundAgent(task: string): Promise<StartedBackgroundAgent>;
  /**
   * Abort one background agent.
   *
   * `accepted: false` is not an error: it means there was nothing to cancel.
   * The agent row that comes back usually still says `running`, because the
   * abort cascades through the child's run loop and settles afterwards — poll
   * {@link ProtocolClient.backgroundAgents} to watch it land.
   *
   * Not degradable, for the reason {@link ProtocolClient.discardChanges} is
   * not: a cancel that resolved against an engine which did nothing would
   * leave a user certain they had stopped spending money they are still
   * spending.
   *
   * @param id - The agent's id.
   * @returns Whether the cancellation was taken, and the agent as it stands.
   * @throws {ProtocolRequestError} `invalidRequest` for an unknown id, or from
   *   an engine that has no such verb.
   */
  cancelBackgroundAgent(id: string): Promise<CancelBackgroundAgentResult>;
  /**
   * Deliver a finished background agent's result into a live session.
   *
   * The engine composes the message and chooses `steer` or `prompt` depending
   * on whether the session is mid-run; the result says which happened. The
   * text is delivered **unexpanded** — a background agent's answer is written
   * by a model, and mentions in it are not mentions a person typed.
   *
   * Not degradable: an adopt that resolved against an engine which did nothing
   * would show a caller a turn that never started.
   *
   * @param sessionId - The live session to deliver into. `openSession` first.
   * @param id - The background agent whose result to adopt.
   * @returns Which delivery path the engine used.
   * @throws {ProtocolRequestError} `sessionNotFound` when the session is not
   *   live; `invalidRequest` when the agent is still running, produced no
   *   output, or does not exist.
   */
  adoptBackgroundAgent(sessionId: string, id: string): Promise<AdoptBackgroundAgentResult>;
  /**
   * Read the org-memory store — the per-role lessons appended to a role's
   * prompt on later runs.
   *
   * Read `warnings` as well as `entries`: an empty store and a store the
   * engine refused to read are different, and only the warnings tell them
   * apart.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}.
   *
   * @returns Every entry, proposed and active, or `undefined` when the engine
   *   has no such verb.
   */
  orgMemory(): Promise<OrgMemoryList | undefined>;
  /**
   * File a **proposed** org-memory entry. It reaches no prompt.
   *
   * There is no counterpart that approves one, and there will not be: an
   * active entry is standing instruction text in every later run of its role,
   * and the gate on it is a person at the machine typing `/org memory
   * approve`. A client's job is to make proposing easy and to show what is
   * waiting — not to grant it.
   *
   * Not degradable: a proposal that resolved against an engine which did
   * nothing would show a queue of suggestions that do not exist.
   *
   * @param role - The role the lesson is for.
   * @param text - One line, at most 160 characters. Over-long text is refused
   *   rather than clipped, because clipping can invert a lesson.
   * @returns The entry as filed — always `proposed` — and the store.
   * @throws {ProtocolRequestError} `invalidRequest` when the store's bounds
   *   refuse the text, or from an engine with no org-memory store wired.
   */
  proposeOrgMemory(role: string, text: string): Promise<OrgMemoryProposal>;
  /**
   * Take an org-memory entry back: demote it to `proposed`, or delete it.
   *
   * Allowed over the wire where approving is not, because this can only ever
   * *reduce* what later runs are told.
   *
   * Not degradable, for the reason {@link ProtocolClient.discardChanges} is
   * not: a revoke that resolved against an engine which did nothing leaves a
   * person believing a lesson has stopped reaching their roles' prompts.
   *
   * @param id - The entry's id.
   * @param remove - `true` deletes it outright (**irreversible** — confirm
   *   with the user first). Omitted, it is demoted and stays visible.
   * @returns The store as it now stands.
   * @throws {ProtocolRequestError} `invalidRequest` for an unknown id, or from
   *   an engine that has no such verb.
   */
  revokeOrgMemory(id: string, remove?: boolean): Promise<OrgMemoryList>;
  /**
   * Ask which earlier turns this session could be rewound to, and what each
   * would cost.
   *
   * Read the rows before offering any of them: each carries `fileCount`,
   * `deleteCount` and the paths themselves, which is what makes a picker
   * honest about a choice that deletes files. Read `available` too — `false`
   * means this engine keeps no checkpoints at all, which is a different story
   * from an empty list on an engine that does.
   *
   * Optional, on the same terms as {@link ProtocolClient.listModels}: it only
   * reads, so an older engine's `invalidRequest` becomes `undefined` and a
   * caller offers no rewind.
   *
   * @param sessionId - Session to ask about.
   * @returns The rewindable turns, newest first, or `undefined` when the
   *   engine has no such verb.
   */
  listCheckpoints(sessionId: string): Promise<CheckpointList | undefined>;
  /**
   * Restore a session's files to a checkpoint and fork its conversation back
   * to the same point. **Destructive and irreversible** — it writes files and
   * it deletes files.
   *
   * Confirm with the user first, the way a discard is confirmed, and confirm
   * against what {@link ProtocolClient.listCheckpoints} reported for *this*
   * row: `confirmation` is that row's own token, and an engine whose plan has
   * moved since the list was taken refuses rather than rewinding to something
   * the user never saw.
   *
   * Deliberately **not** given the `undefined` treatment `listCheckpoints`
   * gets, and this is the sharpest asymmetry in this interface: an apply that
   * silently did not happen tells a reviewer their change landed, and a rewind
   * that silently did not happen tells a user their files went back to a state
   * they never returned to — so they carry on building on code they believe
   * they discarded. An older engine's `invalidRequest` rejects.
   *
   * @param sessionId - Session to rewind.
   * @param checkpointId - The row's `id`.
   * @param confirmation - That same row's `confirmation`.
   * @returns What was rewritten, what was deleted, what was refused, and
   *   whether the transcript forked too.
   * @throws {ProtocolRequestError} `sessionBusy` while the session is running
   *   a turn, `sessionNotFound`, or `invalidRequest` for an unknown
   *   checkpoint, a stale confirmation, an engine with no checkpoint store, or
   *   an engine that does not implement the verb.
   */
  rewindTo(sessionId: string, checkpointId: string, confirmation: string): Promise<RewindResult>;
  /**
   * The workflow catalog: every markdown pipeline this engine discovered, with
   * the ceilings it declares and the lane the engine **derives** for each role
   * it dispatches to.
   *
   * **Degrades to `undefined`** on the `listModels` precedent — it reads, so an
   * engine that predates the verb costs a client its workflow menu and nothing
   * else. A client that gets `undefined` offers no workflow surface rather than
   * guessing at one.
   *
   * @returns The catalog, or `undefined` from an engine too old to have it.
   */
  listWorkflows(): Promise<WorkflowCatalog | undefined>;
  /**
   * Start a workflow run, and follow it on the session's event stream.
   *
   * **Spends real money, and a write-lane role's patch lands in the user's
   * checkout when its step succeeds.** Resolves as soon as the run is
   * *accepted* — not when it finishes; see {@link WorkflowRunHandle}.
   *
   * `budgetUsd` may only ever **lower** the workflow file's own `budgetUsd:`.
   * A larger value is refused (`invalidRequest`, naming both figures) rather
   * than clamped, so a client never renders a ceiling the engine is not
   * enforcing. Read the file's own from {@link ProtocolClient.listWorkflows}
   * first and the refusal never has to happen.
   *
   * **Does not degrade.** An engine that predates this verb rejects with
   * `invalidRequest` like any other failure, because a client told "started"
   * by an engine that did nothing would report a verdict nobody produced.
   *
   * @param sessionId - Session whose event stream carries the run.
   * @param name - Workflow name, as `listWorkflows` reported it.
   * @param options - `input` splices into `{{input}}`; `budgetUsd` lowers the
   *   run's ceiling.
   * @returns The accepted run: its id, its shape, and the limits in force.
   * @throws {ProtocolRequestError} `sessionNotFound`, `sessionBusy`, or
   *   `invalidRequest` for an unknown workflow, a budget above the file's own,
   *   an engine with no workflow support, or one that does not implement the
   *   verb.
   */
  runWorkflow(
    sessionId: string,
    name: string,
    options?: { input?: string; budgetUsd?: number },
  ): Promise<WorkflowRunHandle>;
  /**
   * What a run reached — live or finished, started here or in a terminal.
   *
   * Read from the run journal the engine already keeps, so a run interrupted
   * by a crash reports the same thing here that `/workflow status` prints.
   *
   * **Degrades to `undefined`** on the `listModels` precedent. A `runId` this
   * engine has no journal for answers **zero rows** rather than an error, so
   * "no such run" stays distinguishable from "this engine is too old" — see
   * `ClientRequest`'s `workflowStatus`.
   *
   * @param runId - One run, with its per-step breakdown. Omit for the listing.
   * @returns The runs, or `undefined` from an engine too old to have the verb.
   */
  workflowStatus(runId?: string): Promise<WorkflowRuns | undefined>;
  /**
   * Re-enter an interrupted run, optionally answering its `ORG-ASK:`.
   *
   * Completed steps are replayed from the journal rather than executed again,
   * and an applied patch is not applied twice — that is the engine's promise,
   * reached through this verb rather than re-implemented behind it.
   *
   * Resolves on acceptance, exactly as {@link ProtocolClient.runWorkflow} does,
   * and **does not degrade** for the same reason plus one of its own: an answer
   * that silently went nowhere leaves a run paused forever.
   *
   * @param sessionId - Session whose event stream carries the resumed run.
   * @param runId - The run to re-enter.
   * @param answer - The human's reply to the paused stage. Omit to re-surface
   *   the question instead.
   * @returns The accepted run, with `resumed: true`.
   * @throws {ProtocolRequestError} `sessionNotFound`, `sessionBusy`, or
   *   `invalidRequest` for an unknown run, a run that already finished, a
   *   workflow file that is no longer discoverable, an engine with no workflow
   *   support, or one that does not implement the verb.
   */
  resumeWorkflow(sessionId: string, runId: string, answer?: string): Promise<WorkflowRunHandle>;
  /**
   * Subscribe to server-pushed session events.
   *
   * @returns An unsubscribe function; calling it more than once is harmless.
   */
  onEvent(listener: ProtocolEventListener): () => void;
  /**
   * Close the socket and reject every in-flight request with a
   * {@link ProtocolClosedError}. Idempotent.
   */
  close(): void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ProtocolClientError) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Create a protocol client over an already-constructed socket.
 *
 * The socket is adopted, not created: the caller owns connecting it (and, for
 * a real `ws` socket, may hand it over while it is still CONNECTING —
 * outbound frames are queued until its `"open"` event fires). See
 * {@link WebSocketLike} for why the socket is injected.
 *
 * @param socket - The transport, typically a `ws` `WebSocket`.
 * @param options - Auth token, request deadline, and diagnostics hook.
 */
export function createProtocolClient(
  socket: WebSocketLike,
  options: ProtocolClientOptions = {},
): ProtocolClient {
  return new ProtocolClientImpl(socket, options);
}

/**
 * What one `resolveContext` probe establishes about an engine's age.
 *
 * Three booleans rather than a version number, because each was added at a
 * different time and a client that refuses on "too old" refuses prompts an
 * engine could have run. Each is read only where a silent drop would cost the
 * user something: see {@link ProtocolClient.prompt}.
 */
interface ContextSupport {
  /** `attachments` is honoured at all — the engine has `resolveContext`. */
  attachments: boolean;
  /** A `file` attachment's `range` is honoured, rather than dropped for the whole file. */
  ranges: boolean;
  /** `kind: "fileReference"` is honoured, rather than rejected as an unknown kind. */
  references: boolean;
}

class ProtocolClientImpl implements ProtocolClient {
  readonly #socket: WebSocketLike;
  readonly #token: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #onProtocolError: ((error: ProtocolClientError) => void) | undefined;
  readonly #ids = new RequestIdGenerator();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<ProtocolEventListener>();
  /** Frames buffered while the socket is still CONNECTING. */
  readonly #outbox: string[] = [];
  #open: boolean;
  #closed = false;
  #closeCalled = false;
  #handshake: Promise<void> | undefined;
  /** See {@link ProtocolClient.capabilities}. Set once, by `#performHandshake`. */
  #capabilities: ServerCapabilities = {};
  /** Memoized answer to "does this engine know RFC 0005's context verbs?". */
  #contextSupport: Promise<ContextSupport> | undefined;

  constructor(socket: WebSocketLike, options: ProtocolClientOptions) {
    this.#socket = socket;
    this.#token = options.token;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#onProtocolError = options.onProtocolError;

    // A socket that does not report `readyState` is assumed ready (in-memory
    // fakes, adapters); a real `ws` socket reports 0 until its "open" event.
    const readyState = socket.readyState;
    this.#open = readyState === undefined || readyState === READY_STATE_OPEN;
    if (readyState !== undefined && readyState > READY_STATE_OPEN) {
      this.#closed = true;
    }

    socket.on("open", () => this.#handleOpen());
    socket.on("message", (data) => this.#handleMessage(data));
    socket.on("close", (code) => this.#handleClose(code));
    socket.on("error", (error) => this.#handleError(error));

    if (this.#token !== undefined) {
      // Start the handshake eagerly so the `authenticate` frame is queued
      // ahead of anything a caller sends; the server drops connections whose
      // first frame is not `authenticate`. The no-op catch keeps a handshake
      // nobody awaited from surfacing as an unhandled rejection — awaiters
      // still observe the rejection through their own `.then`.
      this.#handshake = this.#performHandshake(this.#token);
      this.#handshake.catch(() => {});
    }
  }

  authenticate(): Promise<void> {
    if (this.#token === undefined) return Promise.resolve();
    this.#handshake ??= this.#performHandshake(this.#token);
    return this.#handshake;
  }

  capabilities(): ServerCapabilities {
    return this.#capabilities;
  }

  async listSessions(): Promise<SessionHeader[]> {
    const result = await this.#call("listSessions");
    return parseSessionList(result);
  }

  async createSession(params: { cwd: string; model?: string }): Promise<SessionHeader> {
    const wireParams =
      params.model === undefined ? { cwd: params.cwd } : { cwd: params.cwd, model: params.model };
    return parseSessionHeader(await this.#call("createSession", wireParams));
  }

  async openSession(sessionId: string): Promise<SessionHeader> {
    return parseSessionHeader(await this.#call("openSession", { sessionId }));
  }

  async prompt(
    sessionId: string,
    text: string,
    attachments?: readonly PromptAttachment[],
  ): Promise<void> {
    if (attachments !== undefined && attachments.length > 0) {
      // See the interface doc: an old engine would drop the field and answer
      // `ok`, spending the turn. Refusing locally is the `deleteSession`
      // judgement — never resolve on a request that did not do what it said.
      const support = await this.#supportsContext(sessionId);
      if (!support.attachments) {
        // ProtocolClientError, not ProtocolRequestError: no request was made,
        // so there is no server rejection and no request id to name. The code
        // is still the server's `invalidRequest`, because a caller branching on
        // `error.code` wants "this prompt was refused" either way.
        throw new ProtocolClientError(
          ErrorCode.invalidRequest,
          "This arcturn engine is older than prompt attachments (it has no resolveContext " +
            "verb), and would run the turn without them. Nothing was sent.",
          { method: "prompt" },
        );
      }
      // The same judgement one field down. An engine that drops `range` sends
      // the model the whole file — which is not a smaller version of what was
      // asked for, it is a different prompt, at a cost the user did not choose.
      if (!support.ranges && attachments.some((item) => "range" in item && item.range)) {
        throw new ProtocolClientError(
          ErrorCode.invalidRequest,
          "This arcturn engine is older than attachment line ranges, and would send the " +
            "model the whole file instead of the selection. Nothing was sent.",
          { method: "prompt" },
        );
      }
      // And once more for `fileReference`. Unlike the two above, this refusal
      // is not what stands between the user and a surprise bill — the kind is
      // spelled as a kind precisely so an engine that does not know it rejects
      // the frame itself rather than falling back to the whole file. What this
      // buys is the *message*: a person told "your engine is older than open-
      // file references" can act, where `PromptAttachment.kind must be one of
      // …` reads like a client bug. It also saves the round trip.
      if (!support.references && attachments.some((item) => item.kind === "fileReference")) {
        throw new ProtocolClientError(
          ErrorCode.invalidRequest,
          "This arcturn engine is older than file references, so it cannot be told which file " +
            "is open without being sent the whole thing. Nothing was sent. Upgrade the engine, " +
            "or turn off the client's open-file context.",
          { method: "prompt" },
        );
      }
      await this.#call("prompt", { sessionId, text, attachments: [...attachments] });
      return;
    }
    await this.#call("prompt", { sessionId, text });
  }

  /**
   * Whether this engine implements RFC 0005's context verbs — its line ranges,
   * and its file references — cached per client.
   *
   * The probe is a real `resolveContext` for `"."` — the session's own working
   * directory, which every session has and which nothing can be attached from
   * (a directory is not a file). Cached on the client rather than per call
   * because the engine behind one socket does not change mid-connection, and a
   * probe per prompt would double the round trips of every attachment send.
   *
   * **One probe answers all three questions.** It carries a `range`, which an
   * engine that understands ranges echoes back and one that does not silently
   * drops — so `ranges` costs no extra round trip, and the range on a
   * *directory* is harmless because the echo is a statement about the
   * parameter, not about the path. `references` reads
   * {@link ContextResolution.attachmentKinds} off the same answer, which is a
   * statement about the engine and so is equally indifferent to the path.
   *
   * A probe that fails for any reason *other* than an unknown method resolves
   * to full support: the verb is evidently there, and a transient fault on the
   * probe must not be reported to the caller as "your engine is too old".
   */
  #supportsContext(sessionId: string): Promise<ContextSupport> {
    this.#contextSupport ??= this.resolveContext(sessionId, ".", { start: 1, end: 1 })
      .then((resolution) => ({
        attachments: resolution !== undefined,
        ranges: resolution?.range !== undefined,
        // Absent `attachmentKinds` is an engine that predates the field, which
        // is an engine that predates the kind — never "this engine supports no
        // kinds at all". See `ContextResolution.attachmentKinds`.
        references: resolution?.attachmentKinds?.includes("fileReference") ?? false,
      }))
      .catch(() => ({ attachments: true, ranges: true, references: true }));
    return this.#contextSupport;
  }

  async steer(sessionId: string, text: string): Promise<void> {
    await this.#call("steer", { sessionId, text });
  }

  async abort(sessionId: string): Promise<void> {
    await this.#call("abort", { sessionId });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.#call("setModel", { sessionId, model: modelId });
  }

  async respondToPermission(
    sessionId: string,
    decision: PermissionDecision,
    options: { scope?: PermissionScope } = {},
  ): Promise<void> {
    // `#call` validates the outbound frame against the same contract the
    // server enforces, so a `scope` of "project" or "user" — or a
    // client-authored `persistRule` that would outlive the session — fails
    // here, with the message that says where such a rule does belong, instead
    // of costing a round trip to be told the same thing.
    await this.#call("permissionDecision", {
      sessionId,
      decision,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    });
  }

  async listModels(): Promise<ModelCatalog | undefined> {
    let result: unknown;
    try {
      result = await this.#call("listModels");
    } catch (error) {
      // Only a *server-reported* rejection can mean "I do not know this verb"
      // — a local validation failure raises a plain ProtocolClientError and
      // must still surface as the bug it is. `listModels` carries no params,
      // so on a server that implements it there is nothing left for
      // `invalidRequest` to describe; a server that answers it that way is
      // one whose `validateClientRequest` did not recognise the method.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseModelCatalog(result);
  }

  async sessionHistory(sessionId: string): Promise<SessionHistory | undefined> {
    let result: unknown;
    try {
      result = await this.#call("sessionHistory", { sessionId });
    } catch (error) {
      // Same reasoning as `listModels`: only a *server-reported* rejection can
      // mean "I do not know this verb". A local validation failure raises a
      // plain ProtocolClientError and must still surface as the bug it is.
      // `sessionNotFound` is deliberately not swallowed — an id the server has
      // never heard of is the caller's problem, not the server's age.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseSessionHistory(result);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // No unsupported-method translation: see the interface doc. A delete that
    // did not happen must not resolve.
    await this.#call("deleteSession", { sessionId });
  }

  async resolveContext(
    sessionId: string,
    query: string,
    range?: LineRange,
  ): Promise<ContextResolution | undefined> {
    let result: unknown;
    try {
      result = await this.#call("resolveContext", {
        sessionId,
        query,
        ...(range === undefined ? {} : { range }),
      });
    } catch (error) {
      // Same reasoning as `listModels` and `sessionHistory`: only a
      // *server-reported* rejection can mean "I do not know this verb", and a
      // `sessionNotFound` is the caller's problem rather than the engine's age.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseContextResolution(result);
  }

  async permissionState(sessionId: string): Promise<PermissionState | undefined> {
    let result: unknown;
    try {
      result = await this.#call("permissionState", { sessionId });
    } catch (error) {
      // Same reasoning as `listModels`: only a *server-reported* rejection can
      // mean "I do not know this verb". `sessionNotFound` is deliberately not
      // swallowed — an id this engine never heard of is the caller's problem,
      // not the engine's age.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parsePermissionState(result);
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<PermissionState> {
    // No unsupported-method translation, deliberately: see the interface doc.
    // A mode that was not set must not resolve as though it had been.
    return parsePermissionState(await this.#call("setPermissionMode", { sessionId, mode }));
  }

  async listCommands(): Promise<CommandList | undefined> {
    let result: unknown;
    try {
      result = await this.#call("listCommands");
    } catch (error) {
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseCommandList(result);
  }

  async compact(sessionId: string): Promise<CompactionSummary> {
    // No unsupported-method translation, deliberately: see the interface doc.
    // A compaction that did not happen must not resolve as though it had.
    return parseCompactionSummary(await this.#call("compact", { sessionId }));
  }

  async exportSession(
    sessionId: string,
    options: { format?: TranscriptFormat; includeThinking?: boolean } = {},
  ): Promise<SessionExport | undefined> {
    let result: unknown;
    try {
      result = await this.#call("exportSession", {
        sessionId,
        ...(options.format === undefined ? {} : { format: options.format }),
        ...(options.includeThinking === undefined
          ? {}
          : { includeThinking: options.includeThinking }),
      });
    } catch (error) {
      // Same reasoning as `listModels`: only a *server-reported* rejection can
      // mean "I do not know this verb", and `sessionNotFound` is the caller's
      // problem rather than the engine's age.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseSessionExport(result);
  }

  async mcpStatus(): Promise<McpStatus | undefined> {
    let result: unknown;
    try {
      result = await this.#call("mcpStatus");
    } catch (error) {
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseMcpStatus(result);
  }

  async mcpAuthBegin(server: string, redirectUri: string): Promise<McpAuthBegun | undefined> {
    let result: unknown;
    try {
      result = await this.#call("mcpAuthBegin", { server, redirectUri });
    } catch (error) {
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseMcpAuthBegun(result);
  }

  async mcpAuthComplete(handle: string, code: string, state: string): Promise<void> {
    await this.#call("mcpAuthComplete", { handle, code, state });
  }

  async mcpAuthCancel(handle: string): Promise<boolean> {
    const result = await this.#call("mcpAuthCancel", { handle });
    return isRecord(result) && result.cancelled === true;
  }

  async startScout(
    approaches: readonly { name: string; task: string }[],
  ): Promise<ScoutStarted | undefined> {
    let result: unknown;
    try {
      result = await this.#call("startScout", { approaches: [...approaches] });
    } catch (error) {
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    if (!isRecord(result) || typeof result.runId !== "string" || result.runId === "") {
      throw new ProtocolClientError(
        ClientErrorCode.invalidResponse,
        'Invalid startScout result: expected a non-empty "runId"',
      );
    }
    return { runId: result.runId };
  }

  async scoutRun(runId: string): Promise<ScoutRun> {
    return parseScoutRun(await this.#call("scoutRun", { runId }));
  }

  async cancelScout(runId: string): Promise<boolean> {
    const result = await this.#call("cancelScout", { runId });
    return isRecord(result) && result.cancelled === true;
  }

  async mcpResources(server?: string): Promise<McpResourceList | undefined> {
    let result: unknown;
    try {
      result = await this.#call("mcpResources", server === undefined ? undefined : { server });
    } catch (error) {
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    if (!isRecord(result)) return { resources: [], templates: [] };
    return {
      resources: asArray(result.resources).filter(isRecord).map(readResourceEntry),
      templates: asArray(result.templates)
        .filter(isRecord)
        .map((entry) => ({
          server: String(entry.server ?? ""),
          uriTemplate: String(entry.uriTemplate ?? ""),
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
          ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
        })),
    };
  }

  async mcpReadResource(server: string, uri: string): Promise<McpResourceContents> {
    const result = await this.#call("mcpReadResource", { server, uri });
    if (!isRecord(result) || !Array.isArray(result.contents)) {
      throw new ProtocolClientError(
        ClientErrorCode.invalidResponse,
        'Invalid mcpReadResource result: expected a "contents" array',
      );
    }
    return {
      contents: result.contents.filter(isRecord).map((block) => ({
        uri: String(block.uri ?? ""),
        ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
        ...(typeof block.text === "string" ? { text: block.text } : {}),
        ...(typeof block.blob === "string" ? { blob: block.blob } : {}),
      })),
    };
  }

  async mcpPrompts(server?: string): Promise<McpPromptList | undefined> {
    let result: unknown;
    try {
      result = await this.#call("mcpPrompts", server === undefined ? undefined : { server });
    } catch (error) {
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    if (!isRecord(result)) return { prompts: [] };
    return {
      prompts: asArray(result.prompts)
        .filter(isRecord)
        .map((entry) => ({
          server: String(entry.server ?? ""),
          name: String(entry.name ?? ""),
          ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          ...(Array.isArray(entry.arguments)
            ? {
                arguments: entry.arguments.filter(isRecord).map((argument) => ({
                  name: String(argument.name ?? ""),
                  ...(typeof argument.description === "string"
                    ? { description: argument.description }
                    : {}),
                  ...(typeof argument.required === "boolean"
                    ? { required: argument.required }
                    : {}),
                })),
              }
            : {}),
        })),
    };
  }

  async mcpGetPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<McpPromptRendering> {
    const result = await this.#call("mcpGetPrompt", {
      server,
      name,
      ...(args === undefined ? {} : { arguments: args }),
    });
    if (!isRecord(result) || !Array.isArray(result.messages)) {
      throw new ProtocolClientError(
        ClientErrorCode.invalidResponse,
        'Invalid mcpGetPrompt result: expected a "messages" array',
      );
    }
    return {
      messages: result.messages.filter(isRecord).map((message) => ({
        role: String(message.role ?? "user"),
        text: String(message.text ?? ""),
      })),
    };
  }

  async pendingChanges(sessionId: string, path?: string): Promise<PendingChanges | undefined> {
    let result: unknown;
    try {
      result = await this.#call("pendingChanges", {
        sessionId,
        ...(path === undefined ? {} : { path }),
      });
    } catch (error) {
      // Same reasoning as `listModels`: only a *server-reported* rejection can
      // mean "I do not know this verb", and `sessionNotFound` is the caller's
      // problem rather than the engine's age. A refusal that names dry-run
      // mode is not translated either — but it cannot reach here, because the
      // engine answers `dryRun: false` rather than erroring on a read.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parsePendingChanges(result);
  }

  async applyChanges(sessionId: string, paths?: readonly string[]): Promise<ApplyChangesResult> {
    // No unsupported-method translation: see the interface doc. An apply that
    // did not happen must not resolve.
    return parseApplyChangesResult(
      await this.#call("applyChanges", {
        sessionId,
        ...(paths === undefined ? {} : { paths: [...paths] }),
      }),
    );
  }

  async discardChanges(
    sessionId: string,
    paths?: readonly string[],
  ): Promise<DiscardChangesResult> {
    // No unsupported-method translation either, for the sharper reason: a
    // discard reported as done that was not done loses the user's certainty
    // about what is on their disk.
    return parseDiscardChangesResult(
      await this.#call("discardChanges", {
        sessionId,
        ...(paths === undefined ? {} : { paths: [...paths] }),
      }),
    );
  }

  async backgroundAgents(id?: string): Promise<BackgroundAgentList | undefined> {
    let result: unknown;
    try {
      // The params object is omitted entirely rather than sent as `{}` when
      // there is no id: the listing form of this verb genuinely takes nothing,
      // and an empty object would be a shape the validator has to tolerate
      // forever for no reason.
      result = await this.#call("backgroundAgents", ...(id === undefined ? [] : [{ id }]));
    } catch (error) {
      // Same reasoning as `listModels`: only a *server-reported* rejection can
      // mean "I do not know this verb". An unknown agent id is the caller's
      // problem rather than the engine's age, and it arrives as an
      // `invalidRequest` naming the id — which `isUnsupportedMethodError` does
      // not match, so it still throws.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseBackgroundAgentList(result);
  }

  async startBackgroundAgent(task: string): Promise<StartedBackgroundAgent> {
    // No unsupported-method translation: see the interface doc. An agent that
    // was never started must not resolve.
    return parseStartedBackgroundAgent(await this.#call("startBackgroundAgent", { task }));
  }

  async cancelBackgroundAgent(id: string): Promise<CancelBackgroundAgentResult> {
    return parseCancelBackgroundAgentResult(await this.#call("cancelBackgroundAgent", { id }));
  }

  async adoptBackgroundAgent(sessionId: string, id: string): Promise<AdoptBackgroundAgentResult> {
    return parseAdoptBackgroundAgentResult(
      await this.#call("adoptBackgroundAgent", { sessionId, id }),
    );
  }

  async orgMemory(): Promise<OrgMemoryList | undefined> {
    let result: unknown;
    try {
      result = await this.#call("orgMemory");
    } catch (error) {
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseOrgMemoryList(result);
  }

  async proposeOrgMemory(role: string, text: string): Promise<OrgMemoryProposal> {
    // No unsupported-method translation, and the `parseOrgMemoryProposal`
    // below is the second half of the same discipline: it refuses a response
    // whose entry is not `proposed`, so an engine that somehow filed one
    // active cannot have a client render it as merely "suggested".
    return parseOrgMemoryProposal(await this.#call("proposeOrgMemory", { role, text }));
  }

  async revokeOrgMemory(id: string, remove?: boolean): Promise<OrgMemoryList> {
    return parseOrgMemoryList(
      await this.#call("revokeOrgMemory", {
        id,
        ...(remove === undefined ? {} : { remove }),
      }),
    );
  }

  async listCheckpoints(sessionId: string): Promise<CheckpointList | undefined> {
    let result: unknown;
    try {
      result = await this.#call("listCheckpoints", { sessionId });
    } catch (error) {
      // Same reasoning as `listModels`: only a *server-reported* rejection can
      // mean "I do not know this verb". A `sessionNotFound` is the caller's
      // problem, not the engine's age; an engine with no checkpoint store
      // answers `available: false` rather than erroring, so that case cannot
      // reach here either.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseCheckpointList(result);
  }

  async rewindTo(
    sessionId: string,
    checkpointId: string,
    confirmation: string,
  ): Promise<RewindResult> {
    // No unsupported-method translation: see the interface doc. A rewind that
    // did not happen must not resolve — the user would keep working on files
    // they believe are gone.
    return parseRewindResult(
      await this.#call("rewindTo", { sessionId, checkpointId, confirmation }),
    );
  }

  async listWorkflows(): Promise<WorkflowCatalog | undefined> {
    let result: unknown;
    try {
      result = await this.#call("listWorkflows");
    } catch (error) {
      // Same reasoning as `listModels`: only a *server-reported* rejection can
      // mean "I do not know this verb", and this one reads, so a client that
      // gets nothing offers no workflow menu — which is exactly true.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseWorkflowCatalog(result);
  }

  async runWorkflow(
    sessionId: string,
    name: string,
    options: { input?: string; budgetUsd?: number } = {},
  ): Promise<WorkflowRunHandle> {
    // No unsupported-method translation: see the interface doc. A pipeline that
    // did not start must not resolve as though it had — the caller would read a
    // verdict nobody produced.
    return parseWorkflowRunHandle(
      await this.#call("runWorkflow", {
        sessionId,
        name,
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }),
      }),
    );
  }

  async workflowStatus(runId?: string): Promise<WorkflowRuns | undefined> {
    let result: unknown;
    try {
      result = await this.#call("workflowStatus", runId === undefined ? {} : { runId });
    } catch (error) {
      // Same reasoning as `listModels`. It is also why the engine answers an
      // unknown run id with zero rows rather than an `invalidRequest`: this
      // branch cannot tell an in-band refusal from an engine that predates the
      // verb, so a read verb must never produce one — see `pendingChanges`.
      if (error instanceof ProtocolRequestError && isUnsupportedMethodError(error)) {
        return undefined;
      }
      throw error;
    }
    return parseWorkflowRuns(result);
  }

  async resumeWorkflow(
    sessionId: string,
    runId: string,
    answer?: string,
  ): Promise<WorkflowRunHandle> {
    // No unsupported-method translation either, and for the sharper half of
    // `runWorkflow`'s reason: an `ORG-ASK` answer that resolved against an
    // engine which never received it leaves a run paused forever while the
    // person who answered believes it is moving again.
    return parseWorkflowRunHandle(
      await this.#call("resumeWorkflow", {
        sessionId,
        runId,
        ...(answer === undefined ? {} : { answer }),
      }),
    );
  }

  onEvent(listener: ProtocolEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    // Guarded on its own flag, not `#closed`: a socket that already errored
    // is marked closed but may still need an explicit `close()` call.
    if (this.#closeCalled) return;
    this.#closeCalled = true;
    this.#closed = true;
    this.#rejectAllPending(
      () => new ProtocolClosedError("Protocol client was closed by the caller"),
    );
    this.#socket.close();
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /** Send one `ClientRequest`, after the handshake and shape validation. */
  async #call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.authenticate();

    const id = this.#ids.next();
    const request = params === undefined ? { id, method } : { id, method, params };

    // Validate outbound frames against the same contract the server enforces,
    // so a bad call fails here with a precise message instead of costing a
    // round trip (and, when unauthenticated, a dropped connection).
    const validation = validateClientRequest(request);
    if (!validation.ok) {
      throw new ProtocolClientError(ErrorCode.invalidRequest, validation.error, {
        requestId: id,
        method,
      });
    }
    return this.#dispatch(validation.request, method);
  }

  /** Register a pending entry, arm its deadline, and put the frame on the wire. */
  #dispatch(frame: unknown, method: string): Promise<unknown> {
    const id = (frame as { id: string }).id;
    return new Promise<unknown>((resolve, reject) => {
      if (this.#closed) {
        reject(
          new ProtocolClosedError(`Cannot send "${method}": the connection is closed`, {
            requestId: id,
            method,
          }),
        );
        return;
      }

      const timer =
        this.#requestTimeoutMs > 0
          ? setTimeout(() => {
              // Settle *and* drop the entry: a late response must not find a
              // pending record, and the map must not grow on timeouts.
              this.#pending.delete(id);
              reject(new ProtocolTimeoutError(this.#requestTimeoutMs, { requestId: id, method }));
            }, this.#requestTimeoutMs)
          : undefined;
      // Do not hold a CLI process open purely for an in-flight deadline.
      (timer as { unref?: () => void } | undefined)?.unref?.();

      this.#pending.set(id, { method, resolve, reject, timer });
      this.#send(JSON.stringify(frame));
    });
  }

  /** Perform the shared-token handshake as the first frame on the socket. */
  async #performHandshake(token: string): Promise<void> {
    const id = this.#ids.next();
    // `authenticate` is not part of the frozen `ClientRequest` union (see the
    // server's `auth.ts`), so it bypasses `validateClientRequest`. The extra
    // `protocolVersion` field is ignored by today's `isAuthenticateFrame` and
    // gives a future server something to negotiate against.
    const result = await this.#dispatch(
      { id, method: "authenticate", params: { token, protocolVersion: PROTOCOL_VERSION } },
      "authenticate",
    );
    assertCompatibleVersion(
      isRecord(result) ? result.protocolVersion : undefined,
      "authenticate response",
    );
    // Validated rather than trusted verbatim, on `validateServerCapabilities`'s
    // own terms: a malformed `capabilities` degrades to `{}` — "predates the
    // field" — rather than failing a handshake over one advertisement neither
    // side is required to agree on.
    this.#capabilities = validateServerCapabilities(
      isRecord(result) ? result.capabilities : undefined,
    );
  }

  #send(text: string): void {
    if (!this.#open) {
      this.#outbox.push(text);
      return;
    }
    this.#socket.send(text);
  }

  #handleOpen(): void {
    if (this.#open) return;
    this.#open = true;
    // Preserves enqueue order, so `authenticate` still goes out first.
    for (const text of this.#outbox.splice(0)) this.#socket.send(text);
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  #handleMessage(data: unknown): void {
    const text = decodeMessageData(data);
    if (text === undefined) {
      this.#report(
        new ProtocolClientError(
          ClientErrorCode.invalidResponse,
          `Received a message payload of an unsupported type: ${describe(data)}`,
        ),
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      this.#report(
        new ProtocolClientError(
          ClientErrorCode.invalidResponse,
          `Malformed JSON message: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
      return;
    }

    const validation = validateServerMessage(parsed);
    if (!validation.ok) {
      this.#report(
        new ProtocolClientError(
          ClientErrorCode.invalidResponse,
          `Invalid server message: ${validation.error}`,
        ),
      );
      return;
    }

    const message = validation.message;
    switch (message.kind) {
      case "response": {
        this.#settle(message);
        return;
      }
      case "event": {
        this.#emit(message.sessionId, message.event);
        return;
      }
      case "sessions": {
        // The current server only answers `listSessions` with a `response`;
        // an unsolicited `sessions` push has no subscriber to route it to, so
        // it is dropped (it is well-formed, not an error).
        return;
      }
    }
  }

  #settle(message: {
    id: string;
    result?: unknown;
    error?: { code: string; message: string };
  }): void {
    const pending = this.#pending.get(message.id);
    if (!pending) {
      this.#report(
        new ProtocolClientError(
          ClientErrorCode.invalidResponse,
          `Received a response for unknown request id "${message.id}" (timed out, or already settled)`,
          { requestId: message.id },
        ),
      );
      return;
    }
    this.#pending.delete(message.id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);

    const error = message.error;
    if (error !== undefined) {
      pending.reject(
        new ProtocolRequestError(error.code, error.message, {
          requestId: message.id,
          method: pending.method,
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #emit(sessionId: string, event: AgentEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(sessionId, event);
      } catch (cause) {
        // One misbehaving listener must not starve the others, nor throw
        // into the socket's message handler.
        this.#report(
          new ProtocolClientError(
            ClientErrorCode.invalidResponse,
            `An onEvent listener threw while handling a "${event.type}" event: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
          ),
        );
      }
    }
  }

  #handleClose(code?: number): void {
    this.#closed = true;
    this.#open = false;
    this.#outbox.length = 0;
    this.#rejectAllPending(
      (method, id) =>
        new ProtocolClosedError(
          `Connection closed${code === undefined ? "" : ` (code ${code})`} while "${method}" was in flight`,
          { requestId: id, method, ...(code === undefined ? {} : { closeCode: code }) },
        ),
    );
  }

  #handleError(error: unknown): void {
    // `ws` always follows an 'error' with a 'close'; rejecting here surfaces
    // the underlying cause, and the subsequent 'close' finds nothing pending.
    this.#closed = true;
    this.#open = false;
    this.#outbox.length = 0;
    const reason = error instanceof Error ? error.message : String(error);
    this.#rejectAllPending(
      (method, id) =>
        new ProtocolClosedError(`Socket error while "${method}" was in flight: ${reason}`, {
          requestId: id,
          method,
          cause: error,
        }),
    );
  }

  #rejectAllPending(makeError: (method: string, requestId: string) => ProtocolClientError): void {
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [id, pending] of entries) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(makeError(pending.method, id));
    }
  }

  #report(error: ProtocolClientError): void {
    this.#onProtocolError?.(error);
  }
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `listSessions` result. The server answers `{ sessions: [...] }`; a
 * bare array is also accepted so a leaner server variant stays compatible.
 */
function parseSessionList(result: unknown): SessionHeader[] {
  const raw = Array.isArray(result) ? result : isRecord(result) ? result.sessions : undefined;
  if (!Array.isArray(raw)) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      'listSessions result must be an array of session headers or an object with a "sessions" array',
    );
  }
  return raw.map((entry, index) => parseSessionHeader(entry, `sessions[${index}]`));
}

/**
 * Whether a rejection is an older server saying "I do not know that method".
 *
 * `@arcturn/protocol`'s own `validateClientRequest` fails an unrecognised
 * method with `invalidRequest` and the message `Unknown method: "..."`, and
 * `ws-server.ts` forwards that verbatim; `unknownMethod` is the code
 * {@link ErrorCode} reserves for the same condition, so both are read as
 * "this peer is older than the verb".
 *
 * Exported because the two optional verbs answer it differently and both
 * answers need the same definition of "older". {@link ProtocolClient.listModels}
 * and {@link ProtocolClient.sessionHistory} translate it into `undefined`
 * internally; {@link ProtocolClient.deleteSession} refuses to, because a
 * destructive call that did not happen must not resolve — so its caller tests
 * the rejection with this instead, to say "upgrade the engine" rather than
 * showing a user the words `Unknown method`.
 *
 * Only a {@link ProtocolRequestError} — a rejection the *server* sent — can
 * ever be one. A locally-raised {@link ProtocolClientError} carrying the same
 * code is this client's own validation failing, which is a bug to surface,
 * not a peer to work around.
 *
 * @param error - Anything a `ProtocolClient` call rejected with.
 */
export function isUnsupportedMethodError(error: unknown): boolean {
  if (!(error instanceof ProtocolRequestError)) return false;
  return error.code === ErrorCode.invalidRequest || error.code === ErrorCode.unknownMethod;
}

/** Parse a `sessionHistory` result, rejecting anything off-contract. */
function parseSessionHistory(result: unknown): SessionHistory {
  const validation = validateSessionHistory(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid sessionHistory result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `resolveContext` result, rejecting anything off-contract. */
function parseContextResolution(result: unknown): ContextResolution {
  const validation = validateContextResolution(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid resolveContext result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `listModels` result, rejecting anything off-contract. */
function parseModelCatalog(result: unknown): ModelCatalog {
  const validation = validateModelCatalog(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid listModels result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `permissionState` / `setPermissionMode` result, rejecting anything off-contract. */
function parsePermissionState(result: unknown): PermissionState {
  const validation = validatePermissionState(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid permission state in response: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `listCommands` result, rejecting anything off-contract. */
function parseCommandList(result: unknown): CommandList {
  const validation = validateCommandList(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid listCommands result: ${validation.error}`,
    );
  }
  return validation.value;
}

function parseCompactionSummary(result: unknown): CompactionSummary {
  const validation = validateCompactionSummary(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid compact result: ${validation.error}`,
    );
  }
  return validation.value;
}

function parseSessionExport(result: unknown): SessionExport {
  const validation = validateSessionExport(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid exportSession result: ${validation.error}`,
    );
  }
  return validation.value;
}

/**
 * Validate an `mcpAuthBegin` result.
 *
 * Two legal shapes and nothing between them: `authorized`, or a handle plus a
 * URL. A response carrying neither is a bug in the engine rather than a state
 * a caller should try to render, so it fails loudly here instead of returning
 * a half-begun authorization the UI would park on forever.
 */
/**
 * Validate a `scoutRun` result.
 *
 * Strict about the fields a comparison is built from — id, state, results —
 * and forgiving about the rest, because a run whose `warnings` came back
 * malformed is still a run worth showing. A missing `diff` is normal: a scout
 * that changed nothing has none.
 */
/** An array, or an empty one — a listing that came back malformed is not fatal. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** One resource row, copied field by field. */
function readResourceEntry(entry: Record<string, unknown>): McpResourceEntry {
  return {
    server: String(entry.server ?? ""),
    uri: String(entry.uri ?? ""),
    ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
  };
}

function parseScoutRun(result: unknown): ScoutRun {
  const invalid = (why: string): never => {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid scoutRun result: ${why}`,
    );
  };
  if (!isRecord(result)) return invalid("expected an object");
  if (typeof result.id !== "string" || result.id === "") return invalid('needs a non-empty "id"');
  if (typeof result.state !== "string") return invalid('needs a "state"');
  if (!Array.isArray(result.results)) return invalid('needs a "results" array');

  const approaches = Array.isArray(result.approaches) ? result.approaches : [];
  return {
    id: result.id,
    state: result.state,
    approaches: approaches.filter(isRecord).map((entry) => ({
      name: String(entry.name ?? ""),
      task: String(entry.task ?? ""),
    })),
    results: result.results.filter(isRecord).map((entry) => ({
      name: String(entry.name ?? ""),
      task: String(entry.task ?? ""),
      status: String(entry.status ?? "error"),
      finalText: String(entry.finalText ?? ""),
      toolCalls: Array.isArray(entry.toolCalls) ? entry.toolCalls.map(String) : [],
      ...(typeof entry.costUsd === "number" ? { costUsd: entry.costUsd } : {}),
      ...(typeof entry.diff === "string" ? { diff: entry.diff } : {}),
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      durationMs: typeof entry.durationMs === "number" ? entry.durationMs : 0,
    })),
    timedOut: result.timedOut === true,
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
    ...(typeof result.error === "string" ? { error: result.error } : {}),
  };
}

function parseMcpAuthBegun(result: unknown): McpAuthBegun {
  const invalid = (why: string): never => {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid mcpAuthBegin result: ${why}`,
    );
  };
  if (!isRecord(result)) return invalid("expected an object");
  if (result.authorized === true) return { authorized: true };
  if (result.authorized !== false) return invalid('"authorized" must be a boolean');
  const handle = result.handle;
  const authorizationUrl = result.authorizationUrl;
  if (typeof handle !== "string" || handle === "") {
    return invalid('an unauthorized result needs a non-empty "handle"');
  }
  if (typeof authorizationUrl !== "string" || authorizationUrl === "") {
    return invalid('an unauthorized result needs a non-empty "authorizationUrl"');
  }
  return { authorized: false, handle, authorizationUrl };
}

function parseMcpStatus(result: unknown): McpStatus {
  const validation = validateMcpStatus(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid mcpStatus result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `pendingChanges` result, rejecting anything off-contract. */
function parsePendingChanges(result: unknown): PendingChanges {
  const validation = validatePendingChanges(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid pendingChanges result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse an `applyChanges` result, rejecting anything off-contract. */
function parseApplyChangesResult(result: unknown): ApplyChangesResult {
  const validation = validateApplyChangesResult(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid applyChanges result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `discardChanges` result, rejecting anything off-contract. */
function parseDiscardChangesResult(result: unknown): DiscardChangesResult {
  const validation = validateDiscardChangesResult(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid discardChanges result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `backgroundAgents` result, rejecting anything off-contract. */
function parseBackgroundAgentList(result: unknown): BackgroundAgentList {
  const validation = validateBackgroundAgentList(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid backgroundAgents result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `startBackgroundAgent` result, rejecting anything off-contract. */
function parseStartedBackgroundAgent(result: unknown): StartedBackgroundAgent {
  const validation = validateStartedBackgroundAgent(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid startBackgroundAgent result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `cancelBackgroundAgent` result, rejecting anything off-contract. */
function parseCancelBackgroundAgentResult(result: unknown): CancelBackgroundAgentResult {
  const validation = validateCancelBackgroundAgentResult(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid cancelBackgroundAgent result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse an `adoptBackgroundAgent` result, rejecting anything off-contract. */
function parseAdoptBackgroundAgentResult(result: unknown): AdoptBackgroundAgentResult {
  const validation = validateAdoptBackgroundAgentResult(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid adoptBackgroundAgent result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse an `orgMemory`/`revokeOrgMemory` result, rejecting anything off-contract. */
function parseOrgMemoryList(result: unknown): OrgMemoryList {
  const validation = validateOrgMemoryList(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid org memory result: ${validation.error}`,
    );
  }
  return validation.value;
}

/**
 * Parse a `proposeOrgMemory` result, rejecting anything off-contract —
 * including, specifically, an entry that came back `active`.
 *
 * That check lives in `validateOrgMemoryProposal` and is the client-side half
 * of the gate: a client is the surface a person reads "proposed — waiting for
 * your approval" on, and it must not be able to print that over an entry that
 * is already in force.
 */
function parseOrgMemoryProposal(result: unknown): OrgMemoryProposal {
  const validation = validateOrgMemoryProposal(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid proposeOrgMemory result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `listCheckpoints` result, rejecting anything off-contract. */
function parseCheckpointList(result: unknown): CheckpointList {
  const validation = validateCheckpointList(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid listCheckpoints result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `listWorkflows` result, rejecting anything off-contract. */
function parseWorkflowCatalog(result: unknown): WorkflowCatalog {
  const validation = validateWorkflowCatalog(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid listWorkflows result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `runWorkflow` / `resumeWorkflow` result. */
function parseWorkflowRunHandle(result: unknown): WorkflowRunHandle {
  const validation = validateWorkflowRunHandle(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid workflow run handle: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `workflowStatus` result. */
function parseWorkflowRuns(result: unknown): WorkflowRuns {
  const validation = validateWorkflowRuns(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid workflowStatus result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse a `rewindTo` result, rejecting anything off-contract. */
function parseRewindResult(result: unknown): RewindResult {
  const validation = validateRewindResult(result);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid rewindTo result: ${validation.error}`,
    );
  }
  return validation.value;
}

/** Parse and validate one {@link SessionHeader} from a response payload. */
function parseSessionHeader(value: unknown, context = "session header"): SessionHeader {
  if (isRecord(value)) assertCompatibleVersion(value.version, context);
  const validation = validateSessionHeader(value);
  if (!validation.ok) {
    throw new ProtocolClientError(
      ClientErrorCode.invalidResponse,
      `Invalid ${context} in response: ${validation.error}`,
    );
  }
  return validation.value;
}

/**
 * Throw a {@link ProtocolVersionMismatchError} when `version` is a number
 * other than {@link PROTOCOL_VERSION}. `undefined` means "not advertised",
 * which is treated as compatible — today's server sends no explicit version.
 */
function assertCompatibleVersion(version: unknown, context: string): void {
  if (typeof version !== "number") return;
  if (version === PROTOCOL_VERSION) return;
  throw new ProtocolVersionMismatchError(PROTOCOL_VERSION, version, context);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder("utf-8");

/**
 * Normalize a WebSocket message payload to text. Mirrors the server's
 * `rawDataToUtf8`, covering `ws`'s `Buffer | ArrayBuffer | Buffer[]` plus the
 * plain `string` a browser-style socket or an in-memory fake delivers.
 *
 * @returns The decoded text, or `undefined` if the payload is not a type this
 *   client can decode.
 */
function decodeMessageData(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  // Buffer is a Uint8Array, so this covers `ws`'s default payload type.
  if (data instanceof Uint8Array) return textDecoder.decode(data);
  if (data instanceof ArrayBuffer) return textDecoder.decode(new Uint8Array(data));
  if (Array.isArray(data)) {
    const parts: string[] = [];
    for (const part of data) {
      const decoded = decodeMessageData(part);
      if (decoded === undefined) return undefined;
      parts.push(decoded);
    }
    return parts.join("");
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
