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

import type { AgentEvent, PermissionDecision, SessionHeader } from "@arcturn/types";
import { PROTOCOL_VERSION } from "@arcturn/types";
import { ErrorCode } from "./messages.js";
import { RequestIdGenerator } from "./request-id.js";
import { validateClientRequest, validateServerMessage, validateSessionHeader } from "./validate.js";

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
  /** Start a run from a user prompt. Resolves when the server accepts it. */
  prompt(sessionId: string, text: string): Promise<void>;
  /** Queue a mid-run steering message. */
  steer(sessionId: string, text: string): Promise<void>;
  /** Abort the session's current run. */
  abort(sessionId: string): Promise<void>;
  /** Switch the session's model. */
  setModel(sessionId: string, modelId: string): Promise<void>;
  /** Answer a pending permission request. */
  respondToPermission(sessionId: string, decision: PermissionDecision): Promise<void>;
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

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.#call("prompt", { sessionId, text });
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

  async respondToPermission(sessionId: string, decision: PermissionDecision): Promise<void> {
    await this.#call("permissionDecision", { sessionId, decision });
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
