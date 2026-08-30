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
 * - **Shutdown grace** (`shutdownGraceMs`, default 2s): {@link
 *   ArcturnServer.stop} closes connections politely and then, past this
 *   window, destroys whatever is left. Without it a peer decides when the
 *   server may exit: `ws` waits thirty seconds for an answer to a close
 *   frame, and `http.Server.close()` waits forever on a connection that
 *   never sends a byte, so a single silent socket could keep `arcturn serve`
 *   alive after Ctrl+C. See {@link ArcturnServer.stop}.
 */

import {
  createServer as createHttpServer,
  type Server as HttpServer,
  STATUS_CODES,
} from "node:http";
import type { Socket } from "node:net";
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
  /**
   * How long, in ms, {@link ArcturnServer.stop} lets a peer wind its
   * connection down before the socket is destroyed outright. Defaults to
   * {@link DEFAULT_SHUTDOWN_GRACE_MS}. Injectable so a test can prove the
   * escalation happens without waiting the real grace period out.
   */
  shutdownGraceMs?: number;
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
/**
 * How long {@link ArcturnServer.stop} lets connections wind down gracefully
 * before it destroys whatever is left. See that method for why shutting down
 * cannot be something a peer gets a veto over.
 *
 * Two seconds is long enough for a healthy peer on any real link to answer a
 * close frame, and short enough to sit well inside the grace period a
 * supervisor allows between SIGTERM and SIGKILL (Docker's default is ten
 * seconds).
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

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
  readonly #shutdownGraceMs: number;
  readonly #connections = new Map<WebSocket, ConnectionState>();
  /**
   * Every accepted TCP socket, upgraded or not.
   *
   * `#connections` only ever hears about a connection that became a
   * WebSocket, and `stop()` has to be able to reach the ones that did not —
   * see that method. Tracked from the HTTP server's own `connection` event,
   * which is the only place a socket that never sends a byte is visible.
   */
  readonly #sockets = new Set<Socket>();
  #httpServer: HttpServer | undefined;
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
    this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
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
    // The HTTP server is created here rather than left to `ws` (which makes an
    // identical one when handed a host/port) for one reason: `stop()` needs to
    // be able to reach a socket that never became a WebSocket, and `ws` keeps
    // its internal server private. The 426 answer to a plain HTTP request is
    // the one `ws` would have given, kept so nothing about this port's
    // behaviour changes.
    const httpServer = createHttpServer((_request, response) => {
      const body = STATUS_CODES[426] ?? "Upgrade Required";
      response.writeHead(426, {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "text/plain",
      });
      response.end(body);
    });
    httpServer.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: this.#maxPayloadBytes,
      verifyClient: ({ origin }: { origin?: string }) => {
        if (origin === undefined || origin === "") return true;
        return allowedOrigins.includes(origin);
      },
    });
    // Watched on the `WebSocketServer` rather than on the HTTP server it wraps,
    // even though the HTTP server is the one that raises them: `ws` re-emits
    // both events as its own, so a bind failure reaches an `error` listener
    // here either way — but only this side has one. Listening on the HTTP
    // server alone would leave `ws`'s re-emitted copy unhandled, and an
    // unhandled `error` event is a thrown exception, which is how `arcturn
    // serve` on a taken port turned "exit 2, EADDRINUSE" into a crash.
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
      httpServer.listen(port, host);
    });
    this.#httpServer = httpServer;
    this.#wss = wss;
    wss.on("connection", (ws) => this.#handleConnection(ws));
    this.#heartbeatTimer = setInterval(() => this.#heartbeatTick(), this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();

    const address = httpServer.address();
    if (typeof address === "string" || address === null) {
      throw new Error("Expected a network address after binding ArcturnServer");
    }
    return address.port;
  }

  /**
   * Close every connection and stop accepting new ones, in bounded time.
   *
   * The listening socket goes first and synchronously: from the moment
   * `close()` is called nothing new is accepted and the port is free, whatever
   * else this method is still waiting on.
   *
   * What it waits on is the connections that are already up, and the wait has
   * a ceiling — `shutdownGraceMs` — because neither half of a graceful close
   * is something this process controls. `ws.close()` sends a close frame and
   * waits for the peer to answer, which `ws` will do for thirty seconds; and
   * `http.Server.close()` resolves only once every accepted socket has ended,
   * which a socket that never sends a byte never does. A wedged editor panel,
   * a suspended laptop, or a bare TCP connection from a port scanner could
   * therefore hold `arcturn serve` open indefinitely after Ctrl+C — a peer with
   * a veto over the server's own shutdown. Past the grace period every
   * surviving socket is destroyed outright, upgraded or not.
   *
   * Idempotent: the handles are dropped before the first `await`, so a second
   * call (the common "stopped explicitly and swept by a teardown" pattern) is
   * a no-op rather than a second `close()` on an already-closed server.
   */
  async stop(): Promise<void> {
    const wss = this.#wss;
    const httpServer = this.#httpServer;
    if (!wss || !httpServer) return;
    this.#wss = undefined;
    this.#httpServer = undefined;
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#sessionHost.dispose();
    for (const ws of [...this.#connections.keys()]) {
      ws.close(1001, "Server is shutting down");
    }
    this.#connections.clear();
    // Detaches `ws`'s upgrade handling; the listener itself belongs to the
    // HTTP server this class owns, and is closed below.
    wss.close();
    const drained = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    const sockets = [...this.#sockets];
    const escalate = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, this.#shutdownGraceMs);
    escalate.unref?.();
    try {
      await drained;
    } finally {
      clearTimeout(escalate);
      this.#sockets.clear();
    }
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
        // Awaited, unlike the fire-and-forget it once was: `steer` now expands
        // mentions and a leading `/name` through the same resolver `prompt`
        // uses, so a refusal has to reach the client as this request's error
        // rather than vanishing into an unhandled rejection.
        await this.#sessionHost.steer(request.params.sessionId, request.params.text);
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
        return this.#sessionHost.resolveContext(
          request.params.sessionId,
          request.params.query,
          request.params.range,
        );
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
      case "compact":
        // Answers with the summary rather than `{ ok: true }`, for the reason
        // `setPermissionMode` does: the engine is the authority on what just
        // happened to the conversation, and a client that had to ask again
        // would be rendering its own guess in the gap.
        return this.#sessionHost.compact(request.params.sessionId);
      case "exportSession":
        // Nothing is written. The document comes back and the *client* saves
        // it — see `session-export.ts`.
        return this.#sessionHost.exportSession(request.params.sessionId, {
          ...(request.params.format === undefined ? {} : { format: request.params.format }),
          ...(request.params.includeThinking === undefined
            ? {}
            : { includeThinking: request.params.includeThinking }),
        });
      case "mcpStatus":
        return { servers: await this.#sessionHost.mcpStatus() };
      case "mcpAuthBegin":
        // Not session-scoped, like `mcpStatus`: an authorization belongs to
        // the engine's credential store, not to a conversation. The redirect
        // URI is the client's; see the verb's doc for why the engine's own
        // loopback is the wrong answer whenever the browser is elsewhere.
        return this.#sessionHost.mcpAuthBegin(request.params.server, request.params.redirectUri);
      case "mcpAuthComplete":
        // Returns nothing on success. The absence of an error is the answer,
        // and anything more would be a token or a code on a wire that has no
        // reason to carry either.
        await this.#sessionHost.mcpAuthComplete(
          request.params.handle,
          request.params.code,
          request.params.state,
        );
        return {};
      case "mcpAuthCancel":
        return this.#sessionHost.mcpAuthCancel(request.params.handle);
      case "startScout":
        // Not session-scoped: a scout run branches from the repository the
        // engine was started in, not from a conversation. Returns an id, never
        // a report — see the verb's doc for why a blocking call was refused.
        return this.#sessionHost.startScout(request.params.approaches);
      case "scoutRun":
        return this.#sessionHost.scoutRun(request.params.runId);
      case "cancelScout":
        return this.#sessionHost.cancelScout(request.params.runId);
      case "mcpResources":
        // Read-only and not session-scoped, like `mcpStatus`: what a server
        // publishes is a property of the engine's MCP config, not of a
        // conversation.
        return this.#sessionHost.mcpResources(request.params?.server);
      case "mcpReadResource":
        return this.#sessionHost.mcpReadResource(request.params.server, request.params.uri);
      case "mcpPrompts":
        return this.#sessionHost.mcpPrompts(request.params?.server);
      case "mcpGetPrompt":
        return this.#sessionHost.mcpGetPrompt(
          request.params.server,
          request.params.name,
          request.params.arguments,
        );
      case "pendingChanges":
        // Read-only, so no observer is attached and no session state is
        // touched — the same shape `resolveContext` has.
        return this.#sessionHost.pendingChanges(request.params.sessionId, request.params.path);
      case "applyChanges":
        // The one verb on this wire that writes a user's files. Every guard is
        // the host's: see `SessionHost.applyChanges`.
        return this.#sessionHost.applyChanges(request.params.sessionId, request.params.paths);
      case "discardChanges":
        return this.#sessionHost.discardChanges(request.params.sessionId, request.params.paths);
      case "backgroundAgents":
        // Read-only, and not session-scoped: background agents belong to the
        // engine, so no observer is attached and no session is required. A
        // client may ask before it has opened anything.
        return this.#sessionHost.backgroundAgents(request.params?.id);
      case "startBackgroundAgent":
        // The one verb on this wire that starts a whole second conversation.
        // Every cap it runs under — tools, permission mode, cwd, model — is
        // decided by the engine's own defaults, because the request carries
        // nothing but the task. See `SessionHost.startBackgroundAgent`.
        return this.#sessionHost.startBackgroundAgent(request.params.task);
      case "cancelBackgroundAgent":
        return this.#sessionHost.cancelBackgroundAgent(request.params.id);
      case "adoptBackgroundAgent":
        // Session-scoped, unlike the other three: this delivers into a live
        // conversation. The text is the registry's, delivered unexpanded — see
        // `SessionHost.adoptBackgroundAgent` for why that matters.
        return this.#sessionHost.adoptBackgroundAgent(request.params.sessionId, request.params.id);
      case "orgMemory":
        // Read-only, shaped like `mcpStatus`: the store is a property of the
        // server process, not of a conversation.
        return this.#sessionHost.orgMemory();
      case "proposeOrgMemory":
        // Files an entry that reaches no prompt. There is deliberately no
        // sibling case that makes one active — see `org-memory.ts`.
        return this.#sessionHost.proposeOrgMemory(request.params.role, request.params.text);
      case "revokeOrgMemory":
        // Answers with the resulting store rather than `{ ok: true }`, for the
        // reason `setPermissionMode` does: the engine is the authority on what
        // is in the store now.
        return this.#sessionHost.revokeOrgMemory(request.params.id, request.params.remove);
      case "listCheckpoints":
        // Read-only, so no observer is attached and no session state is
        // touched — the same shape `pendingChanges` has.
        return this.#sessionHost.listCheckpoints(request.params.sessionId);
      case "rewindTo":
        // The other verb on this wire that writes a user's files, and the only
        // one that deletes them. Every guard is the host's — the busy refusal,
        // the echoed confirmation, and the workspace confinement the engine's
        // own checkpoint store applies. See `SessionHost.rewindTo`.
        return this.#sessionHost.rewindTo(
          request.params.sessionId,
          request.params.checkpointId,
          request.params.confirmation,
        );
      case "listWorkflows":
        return { workflows: await this.#sessionHost.listWorkflows() };
      case "runWorkflow":
        // Answers with the accepted run rather than `{ ok: true }`, and
        // deliberately *before* the pipeline finishes: a run outlives every
        // sane request deadline, so the response is the handle and the run
        // itself rides the session's event stream this connection already
        // subscribed to with `openSession`. No observer is attached here —
        // the client is already on the stream, and attaching a second time
        // would double every notice. See `SessionHost.runWorkflow`.
        return this.#sessionHost.runWorkflow(request.params.sessionId, {
          name: request.params.name,
          ...(request.params.input === undefined ? {} : { input: request.params.input }),
          ...(request.params.budgetUsd === undefined
            ? {}
            : { budgetUsd: request.params.budgetUsd }),
        });
      case "workflowStatus":
        // Read-only, and not session-scoped: runs live under the served home,
        // so a run started in a terminal is as legible here as one started
        // over this socket.
        return { runs: await this.#sessionHost.workflowStatus(request.params.runId) };
      case "resumeWorkflow":
        return this.#sessionHost.resumeWorkflow(request.params.sessionId, {
          runId: request.params.runId,
          ...(request.params.answer === undefined ? {} : { answer: request.params.answer }),
        });
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
