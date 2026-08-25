/**
 * {@link ArcturnServer} — the WebSocket transport exposing a {@link SessionHost}
 * over JSON text frames (see NOTES.md for why text frames rather than
 * `@arcturn/protocol`'s NDJSON `FrameDecoder`, which targets stream
 * transports, not one-frame-per-message WebSocket text messages).
 *
 * ## DoS limits
 *
 * A handful of bounds keep one misbehaving or malicious client from
 * degrading the server for everyone else:
 *
 * - **`maxPayloadBytes`** (default 4 MiB, `ws`'s own `maxPayload`): the
 *   largest legitimate wire frame is a `messageStream`/`toolEnd` event
 *   carrying a chunk of agent output or a tool result — never a raw file
 *   blob (tools stream file contents in bounded chunks upstream, they don't
 *   inline whole files into one event). 4 MiB is generous headroom over that
 *   and far under `ws`'s 100 MiB default. An oversized frame makes `ws` close
 *   the connection with code 1009 automatically.
 * - **`maxConnections`** (default 32): once reached, a new connection is
 *   accepted at the TCP/HTTP level (verifyClient already ran) but closed
 *   immediately with 1013 ("try again later") before it can authenticate or
 *   consume a `SessionHost` slot.
 * - **Heartbeat** (`heartbeatIntervalMs`, default 30s): every connection is
 *   pinged on this interval; one that hasn't ponged since the previous tick
 *   is presumed dead and terminated, which also cleans up its `SessionHost`
 *   observer subscriptions and `#connections` entry via the normal `close`
 *   path.
 * - **Backpressure** (`backpressureThresholdBytes`, default 1 MiB;
 *   `backpressureSustainedMs`, default 15s): once a socket's
 *   `bufferedAmount` exceeds the threshold, further *event* pushes (session
 *   fan-out — not responses to that client's own requests) are dropped
 *   rather than queued, so one slow reader can't grow unbounded memory or
 *   starve `#send` for everyone else. A response to the client's own request
 *   is not itself subject to this drop — those are what the client is
 *   waiting on — but a socket that stays above the threshold for the whole
 *   sustained window is presumed stuck and terminated outright.
 */

import {
  ErrorCode,
  errorResponse,
  eventMessage,
  okResponse,
  validateClientRequest,
} from "@arcturn/protocol";
import type { ClientRequest, ServerMessage } from "@arcturn/types";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { type AuthenticateFrame, isAuthenticateFrame, tokensMatch } from "./auth.js";
import { type SessionHost, SessionHostError } from "./session-host.js";

/** Construction options for {@link ArcturnServer}. */
export interface ArcturnServerOptions {
  /** The session manager this server exposes over WebSocket. */
  sessionHost: SessionHost;
  /**
   * Origins permitted to open a connection. A browser always sends `Origin`;
   * the CLI and editors do not, and are always allowed. Defaults to none, so
   * no web page can reach the server even on loopback.
   */
  allowedOrigins?: readonly string[];
  /**
   * Shared-token auth. When set, every connection's first frame must be a
   * `{ id, method: "authenticate", params: { token } }` frame carrying this
   * value; anything else closes the connection with an error. Omit to accept
   * connections unauthenticated.
   */
  token?: string;
  /**
   * Maximum concurrent connections. Past this cap, a new connection is
   * closed with code 1013 ("try again later") before authentication.
   * Defaults to {@link DEFAULT_MAX_CONNECTIONS}.
   */
  maxConnections?: number;
  /**
   * Largest WebSocket frame `ws` will accept before closing the connection
   * with code 1009. Defaults to {@link DEFAULT_MAX_PAYLOAD_BYTES}. See the
   * module doc's "DoS limits" section for why.
   */
  maxPayloadBytes?: number;
  /**
   * Heartbeat ping interval, in ms. Defaults to
   * {@link DEFAULT_HEARTBEAT_INTERVAL_MS}. Injectable so tests can run the
   * dead-peer sweep on a short tick instead of waiting 30 real seconds.
   */
  heartbeatIntervalMs?: number;
  /**
   * `ws.bufferedAmount` (bytes) above which non-essential event sends are
   * dropped for that connection. Defaults to
   * {@link DEFAULT_BACKPRESSURE_THRESHOLD_BYTES}.
   */
  backpressureThresholdBytes?: number;
  /**
   * How long, in ms, a connection may stay above
   * `backpressureThresholdBytes` before it is terminated as stuck. Defaults
   * to {@link DEFAULT_BACKPRESSURE_SUSTAINED_MS}.
   */
  backpressureSustainedMs?: number;
}

/** Options for {@link ArcturnServer.start}. */
export interface ArcturnServerStartOptions {
  /** Interface to bind. Defaults to `"127.0.0.1"`. */
  host?: string;
  /** Port to bind, or `0` (the default) for an OS-assigned ephemeral port. */
  port?: number;
}

/** See the module doc's "DoS limits" section. */
export const DEFAULT_MAX_CONNECTIONS = 32;
/** See the module doc's "DoS limits" section. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** See the module doc's "DoS limits" section. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** See the module doc's "DoS limits" section. */
export const DEFAULT_BACKPRESSURE_THRESHOLD_BYTES = 1024 * 1024;
/** See the module doc's "DoS limits" section. */
export const DEFAULT_BACKPRESSURE_SUSTAINED_MS = 15_000;

interface ConnectionState {
  authenticated: boolean;
  /** Sessions this connection observes, keyed by sessionId, to unsubscribe. */
  observedSessions: Map<string, () => void>;
  /** Cleared on every pong; a connection still `false` at the next heartbeat tick is dead. */
  alive: boolean;
  /** `Date.now()` of when `bufferedAmount` first exceeded the backpressure threshold, if it currently is. */
  backpressureSince: number | undefined;
}

/** WebSocket server exposing {@link SessionHost} sessions to remote clients. */
export class ArcturnServer {
  readonly #sessionHost: SessionHost;
  readonly #token: string | undefined;
  readonly #allowedOrigins: readonly string[];
  readonly #maxConnections: number;
  readonly #maxPayloadBytes: number;
  readonly #heartbeatIntervalMs: number;
  readonly #backpressureThresholdBytes: number;
  readonly #backpressureSustainedMs: number;
  readonly #connections = new Map<WebSocket, ConnectionState>();
  #wss: WebSocketServer | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ArcturnServerOptions) {
    this.#sessionHost = options.sessionHost;
    this.#token = options.token;
    this.#allowedOrigins = options.allowedOrigins ?? [];
    this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#backpressureThresholdBytes =
      options.backpressureThresholdBytes ?? DEFAULT_BACKPRESSURE_THRESHOLD_BYTES;
    this.#backpressureSustainedMs =
      options.backpressureSustainedMs ?? DEFAULT_BACKPRESSURE_SUSTAINED_MS;
  }

  /**
   * Bind and start accepting connections.
   *
   * @param options - Host/port to bind; port `0` picks an ephemeral port.
   * @returns The actual bound port (useful when `port` was `0` or omitted).
   */
  async start(options: ArcturnServerStartOptions = {}): Promise<number> {
    if (this.#wss) throw new Error("ArcturnServer is already started");
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;

    // WebSocket upgrades are exempt from CORS, so without this any web page
    // the user visits could open ws://127.0.0.1:<port> and drive the server
    // with full tool execution. Real clients (the arcturn CLI, editors) send no
    // Origin header; browsers always do. Anything with an Origin is refused
    // unless the caller explicitly allowed it.
    const allowedOrigins = this.#allowedOrigins;
    const wss = new WebSocketServer({
      host,
      port,
      maxPayload: this.#maxPayloadBytes,
      verifyClient: ({ origin }: { origin?: string }) => {
        if (origin === undefined || origin === "") return true;
        return allowedOrigins.includes(origin);
      },
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        wss.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        wss.off("error", onError);
        resolve();
      };
      wss.once("error", onError);
      wss.once("listening", onListening);
    });
    this.#wss = wss;
    wss.on("connection", (ws) => this.#handleConnection(ws));
    this.#heartbeatTimer = setInterval(() => this.#heartbeatTick(), this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();

    const address = wss.address();
    if (typeof address === "string" || address === null) {
      throw new Error("Expected a network address after binding ArcturnServer");
    }
    return address.port;
  }

  /** Close every connection and stop accepting new ones. */
  async stop(): Promise<void> {
    const wss = this.#wss;
    if (!wss) return;
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#sessionHost.dispose();
    for (const ws of [...this.#connections.keys()]) {
      ws.close(1001, "Server is shutting down");
    }
    this.#connections.clear();
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
    this.#wss = undefined;
  }

  /**
   * Ping every connection, terminating any that didn't pong since the
   * previous tick. `ws.terminate()` fires `close`, which runs the normal
   * cleanup path (`observedSessions` unsubscribe, `#connections.delete`).
   */
  #heartbeatTick(): void {
    for (const [ws, state] of this.#connections) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }

  #handleConnection(ws: WebSocket): void {
    if (this.#connections.size >= this.#maxConnections) {
      ws.close(1013, "Try again later: this server is at its connection limit");
      return;
    }

    const state: ConnectionState = {
      authenticated: this.#token === undefined,
      observedSessions: new Map(),
      alive: true,
      backpressureSince: undefined,
    };
    this.#connections.set(ws, state);

    ws.on("pong", () => {
      state.alive = true;
    });
    ws.on("message", (data) => {
      void this.#handleMessage(ws, state, data);
    });
    ws.on("close", () => {
      for (const unsubscribe of state.observedSessions.values()) unsubscribe();
      state.observedSessions.clear();
      this.#connections.delete(ws);
    });
    ws.on("error", () => {
      // A socket-level error is followed by a 'close' event, which does the
      // actual cleanup; swallow here only to avoid an unhandled 'error' crash.
    });
  }

  async #handleMessage(ws: WebSocket, state: ConnectionState, data: RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToUtf8(data));
    } catch {
      if (!state.authenticated) {
        this.#send(ws, errorResponse("", ErrorCode.invalidRequest, "Malformed JSON"));
        ws.close(4401, "Authentication required");
        return;
      }
      this.#send(ws, errorResponse("", ErrorCode.invalidRequest, "Malformed JSON"));
      return;
    }

    if (!state.authenticated) {
      this.#handleAuthFrame(ws, state, parsed);
      return;
    }

    const validation = validateClientRequest(parsed);
    if (!validation.ok) {
      this.#send(ws, errorResponse(requestId(parsed), ErrorCode.invalidRequest, validation.error));
      return;
    }

    const request = validation.request;
    try {
      const result = await this.#dispatch(ws, state, request);
      this.#send(ws, okResponse(request.id, result));
    } catch (error) {
      const { code, message } = mapError(error);
      this.#send(ws, errorResponse(request.id, code, message));
    }
  }

  /**
   * Handle the one pre-protocol frame accepted before authentication. See
   * `auth.ts` and NOTES.md for why this is not part of `ClientRequest`.
   */
  #handleAuthFrame(ws: WebSocket, state: ConnectionState, parsed: unknown): void {
    const expected = this.#token;
    if (expected === undefined) {
      // No auth configured; nothing should reach this branch, but resolve
      // safely rather than getting stuck unauthenticated.
      state.authenticated = true;
      return;
    }
    if (!isAuthenticateFrame(parsed)) {
      this.#send(
        ws,
        errorResponse(requestId(parsed), ErrorCode.invalidRequest, "Invalid or missing token"),
      );
      ws.close(4401, "Authentication failed");
      return;
    }
    const frame: AuthenticateFrame = parsed;
    if (!tokensMatch(expected, frame.params.token)) {
      this.#send(ws, errorResponse(frame.id, ErrorCode.invalidRequest, "Invalid or missing token"));
      ws.close(4401, "Authentication failed");
      return;
    }
    state.authenticated = true;
    this.#send(ws, okResponse(frame.id, { authenticated: true }));
  }

  async #dispatch(ws: WebSocket, state: ConnectionState, request: ClientRequest): Promise<unknown> {
    switch (request.method) {
      case "listSessions":
        return { sessions: await this.#sessionHost.listSessions() };
      case "createSession":
        return this.#sessionHost.createSession(request.params);
      case "openSession": {
        const header = await this.#sessionHost.openSession(request.params.sessionId);
        this.#attachObserver(ws, state, header.sessionId);
        return header;
      }
      case "prompt":
        // Attachments are threaded through rather than defaulted here: the
        // host is where every refusal (confinement, byte budget, a model with
        // no vision) is settled, because it is the only layer that knows the
        // session's cwd and its current model.
        await this.#sessionHost.prompt(
          request.params.sessionId,
          request.params.text,
          request.params.attachments ?? [],
        );
        return { ok: true };
      case "steer":
        this.#sessionHost.steer(request.params.sessionId, request.params.text);
        return { ok: true };
      case "abort":
        this.#sessionHost.abort(request.params.sessionId);
        return { ok: true };
      case "permissionDecision":
        this.#sessionHost.handlePermissionDecision(
          request.params.sessionId,
          request.params.decision,
          request.params.scope,
        );
        return { ok: true };
      case "setModel":
        this.#sessionHost.setModel(request.params.sessionId, request.params.model);
        return { ok: true };
      case "listModels":
        return { models: await this.#sessionHost.listModels() };
      case "sessionHistory":
        // Answered whether or not this connection has the session open: a
        // client may want to render a session before attaching to it, and
        // reading stored entries needs no agent and no subscription.
        return this.#sessionHost.sessionHistory(request.params.sessionId);
      case "deleteSession": {
        await this.#sessionHost.deleteSession(request.params.sessionId);
        this.#detachEveryone(request.params.sessionId);
        return { ok: true };
      }
      case "resolveContext":
        // Read-only: nothing is attached and no turn is started, so unlike
        // `openSession` this attaches no observer and touches no session state.
        return this.#sessionHost.resolveContext(request.params.sessionId, request.params.query);
      case "permissionState":
        return this.#sessionHost.permissionState(request.params.sessionId);
      case "setPermissionMode":
        // Answers with the resulting state rather than `{ ok: true }`: the
        // engine is the authority on what mode is now in force, and a client
        // that had to ask again to find out would render the mode it *asked*
        // for in the gap.
        return this.#sessionHost.setPermissionMode(request.params.sessionId, request.params.mode);
      case "listCommands":
        return { commands: await this.#sessionHost.listCommands() };
      default:
        return exhaustiveCheck(request);
    }
  }

  /**
   * Forget one session on every connection that was observing it.
   *
   * `SessionHost.deleteSession` has already sent each observer its final
   * `notice` and dropped the subscription host-side; what is left here is this
   * server's own per-connection bookkeeping. Left behind, an
   * `observedSessions` entry would keep a dead unsubscribe closure alive for
   * the life of the socket and would make `#attachObserver` treat the id as
   * already attached — a stale record for a session that no longer exists.
   *
   * Every connection, not just the one that asked: a session is deleted for
   * all of them at once.
   */
  #detachEveryone(sessionId: string): void {
    for (const state of this.#connections.values()) {
      const unsubscribe = state.observedSessions.get(sessionId);
      if (unsubscribe === undefined) continue;
      state.observedSessions.delete(sessionId);
      unsubscribe();
    }
  }

  #attachObserver(ws: WebSocket, state: ConnectionState, sessionId: string): void {
    if (state.observedSessions.has(sessionId)) return;
    const unsubscribe = this.#sessionHost.observe(sessionId, (event) => {
      // Session fan-out is non-essential: a slow reader may miss events
      // rather than grow this server's memory unboundedly. See #send.
      this.#send(ws, eventMessage(sessionId, event), { essential: false });
    });
    state.observedSessions.set(sessionId, unsubscribe);
  }

  /**
   * Send one message, applying the backpressure policy described in the
   * module doc: once `ws.bufferedAmount` exceeds
   * `backpressureThresholdBytes`, non-essential sends (`essential: false` —
   * currently just session event fan-out) are dropped rather than queued.
   * Essential sends (responses to the client's own requests) still go out,
   * but a connection that stays over the threshold for
   * `backpressureSustainedMs` is presumed stuck and terminated outright,
   * essential or not — queuing indefinitely for a dead reader is worse than
   * dropping it.
   */
  #send(ws: WebSocket, message: ServerMessage, options: { essential?: boolean } = {}): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const state = this.#connections.get(ws);
    if (state) {
      if (ws.bufferedAmount > this.#backpressureThresholdBytes) {
        const since = state.backpressureSince ?? Date.now();
        state.backpressureSince = since;
        if (Date.now() - since > this.#backpressureSustainedMs) {
          ws.terminate();
          return;
        }
        if (options.essential === false) return;
      } else {
        state.backpressureSince = undefined;
      }
    }
    ws.send(JSON.stringify(message));
  }
}

/** Normalize a `ws` message payload (Buffer, ArrayBuffer, or Buffer[]) to text. */
function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function requestId(parsed: unknown): string {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const id = (parsed as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return "";
}

function mapError(error: unknown): { code: string; message: string } {
  if (error instanceof SessionHostError) {
    const code =
      error.code === "sessionBusy"
        ? ErrorCode.sessionBusy
        : error.code === "invalidRequest"
          ? ErrorCode.invalidRequest
          : ErrorCode.sessionNotFound;
    return { code, message: error.message };
  }
  if (error instanceof Error) return { code: ErrorCode.internal, message: error.message };
  return { code: ErrorCode.internal, message: "Unknown internal error" };
}

function exhaustiveCheck(value: never): never {
  throw new Error(`Unhandled request method: ${JSON.stringify(value)}`);
}
