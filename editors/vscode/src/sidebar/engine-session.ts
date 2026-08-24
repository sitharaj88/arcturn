/**
 * The sidebar's lifecycle, from "nothing is running" to "a session is open",
 * and back again when the engine dies.
 *
 * RFC 0004 §3 requires that activation cost nothing: "no protocol connection,
 * no server spawn, until the user opens the sidebar or runs a command." So
 * this object is *constructed* eagerly and does nothing until
 * {@link EngineSession.start} is called — which the webview provider calls the
 * first time VS Code actually resolves the view.
 *
 * §1 requires the failure path to be a card, not a toast storm: every failure
 * here — no CLI on PATH, a child that dies before announcing, a socket that
 * closes mid-session — becomes one `disconnected` status with a redacted
 * detail. Nothing throws out of `start()`.
 *
 * `spawn`, `socketFactory` and `generateToken` are injected, so the entire
 * lifecycle runs in a test with no process, no port and no `vscode`.
 */

import { buildServeArgs, cliInvocation, type ResolvedCliLike } from "../serve/args.js";
import { connectToServe, type SocketFactory } from "../serve/connect.js";
import type {
  ModelCatalogEntry,
  ProtocolClient,
  SessionHeader,
  WebSocketLike,
} from "../serve/engine.js";
import { createRedactor } from "../serve/redact.js";
import { type ServeProcess, type SpawnLike, startServeProcess } from "../serve/supervisor.js";
import {
  type ControllerHost,
  createSessionController,
  type SessionController,
} from "./controller.js";
import type { ConnectionStatus } from "./webview-messages.js";

/** The controller host, plus the connection status the reconnect card renders. */
export interface EngineSessionHost extends ControllerHost {
  onConnection: (status: ConnectionStatus, detail?: string) => void;
}

/** Construction options for {@link createEngineSession}. */
export interface EngineSessionOptions {
  /** Workspace folder the engine serves. */
  cwd: string;
  /** Builder A's CLI resolution, called lazily on first start. */
  resolveCli: () => Promise<ResolvedCliLike | undefined>;
  /** Injected `child_process.spawn`. */
  spawn: SpawnLike;
  /** Injected socket constructor. */
  socketFactory: SocketFactory;
  /** Injected token generator. */
  generateToken: () => string;
  /** Where view updates, spend and permission dialogs go. */
  host: EngineSessionHost;
  /** `arcturn.serve.port`; `0`/omitted asks for an ephemeral port. */
  port?: number;
  /** `arcturn.defaultModel`, forwarded to `serve` and `createSession`. */
  model?: string;
  /** How long to wait for the address line. */
  startupTimeoutMs?: number;
  /** Redacted diagnostics sink. */
  log?: (line: string) => void;
}

/** A managed `arcturn serve` plus the session open against it. */
export interface EngineSession {
  readonly status: ConnectionStatus;
  /** The open session, or `undefined` while not connected. */
  readonly controller: SessionController | undefined;
  /** Start the engine and open a new session. Idempotent; never throws. */
  start(): Promise<void>;
  /** Tear down and start again — what the reconnect card calls. */
  restart(): Promise<void>;
  /** Every session the engine knows about. */
  listSessions(): Promise<SessionHeader[]>;
  /**
   * The engine's model catalog, or `undefined` when this engine is older than
   * the `listModels` verb (see `ProtocolClient.listModels`). Callers render
   * the fallback picker on `undefined` rather than showing an error.
   */
  listModels(): Promise<ModelCatalogEntry[] | undefined>;
  /** Attach to an existing session. */
  openSession(sessionId: string): Promise<void>;
  /** Create and attach to a fresh session. */
  newSession(): Promise<void>;
  /** Kill the child, close the client, dispose the controller. Idempotent. */
  dispose(): void;
}

/**
 * Build the sidebar's engine session. Nothing is spawned here.
 *
 * @param options - See {@link EngineSessionOptions}.
 */
export function createEngineSession(options: EngineSessionOptions): EngineSession {
  const redactor = createRedactor();
  let status: ConnectionStatus = "idle";
  let serve: ServeProcess | undefined;
  let client: ProtocolClient | undefined;
  let controller: SessionController | undefined;
  let starting: Promise<void> | undefined;
  let disposed = false;
  /**
   * Bumped by every teardown. A child exit or socket close that belongs to a
   * previous generation is a shutdown *we* asked for, not an outage, and must
   * not paint a reconnect card over the connection that replaced it. A boolean
   * "tearing down" flag cannot do this job: a real `ws` socket reports its
   * close asynchronously, long after the flag would have been cleared.
   */
  let generation = 0;

  const setStatus = (next: ConnectionStatus, detail?: string): void => {
    status = next;
    options.host.onConnection(next, detail === undefined ? undefined : redactor.redact(detail));
  };

  const log = (line: string): void => options.log?.(redactor.redact(line));

  /**
   * An outage: the child died, or the socket closed under us.
   *
   * @param gen - The generation the reporting handler was created in.
   * @param detail - Redacted explanation for the card.
   */
  const onOutage = (gen: number, detail: string): void => {
    if (disposed || gen !== generation || status === "disconnected") return;
    controller?.dispose();
    controller = undefined;
    setStatus("disconnected", detail);
  };

  const teardown = (): void => {
    generation += 1;
    controller?.dispose();
    controller = undefined;
    client?.close();
    client = undefined;
    serve?.dispose();
    serve = undefined;
  };

  /**
   * Create a session **and subscribe this connection to its events**.
   *
   * `ws-server.ts` attaches the event observer inside `openSession` only
   * (`#attachObserver` is not called on the `createSession` branch), so a
   * client that merely creates a session is never sent a single `AgentEvent`
   * for it. The follow-up `openSession` is what turns the stream on. Both
   * verbs are on RFC 0004 §1's frozen list, so this is the documented client
   * surface doing what it says — not a workaround around a missing one.
   *
   * @param connected - The client to create the session on.
   */
  const createAndSubscribe = async (connected: ProtocolClient): Promise<SessionHeader> => {
    const created = await connected.createSession({
      cwd: options.cwd,
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    return connected.openSession(created.sessionId);
  };

  /**
   * The host handed to a controller, with its diagnostics routed through this
   * session's redactor.
   *
   * `options.host.onDiagnostic` is the extension's raw sink; the controller
   * emits strings built from engine error messages, which this session — and
   * only this session — can filter by the token's actual value rather than by
   * shape alone. Wiring the raw sink straight through would be the one path
   * out of the process that no redactor had seen.
   */
  const controllerHost: ControllerHost = {
    ...options.host,
    onDiagnostic: (line) => options.host.onDiagnostic?.(redactor.redact(line)),
  };

  const attach = (header: SessionHeader): void => {
    if (client === undefined) return;
    controller?.dispose();
    controller = createSessionController({
      client,
      sessionId: header.sessionId,
      host: controllerHost,
      header,
    });
  };

  const boot = async (): Promise<void> => {
    // A retry from the reconnect card must not leave the previous child and
    // socket behind: `start()` is reachable from `disconnected`, not only from
    // `idle`.
    teardown();
    const gen = generation;
    setStatus("starting");
    const cli = cliInvocation(await options.resolveCli());
    if (cli === undefined) {
      setStatus(
        "disconnected",
        "The arcturn CLI could not be found. Set arcturn.cliPath, or install it with npm install -g arcturn.",
      );
      return;
    }

    const token = options.generateToken();
    redactor.add(token);
    const serveArgs = buildServeArgs({
      cwd: options.cwd,
      token,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });

    serve = await startServeProcess({
      command: cli.command,
      args: [...cli.args, ...serveArgs],
      cwd: options.cwd,
      token,
      spawn: options.spawn,
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      log,
      onExit: (info) => onOutage(gen, info.detail),
    });

    client = await connectToServe({
      connectUrl: serve.connectUrl,
      socketFactory: (url) => {
        const socket: WebSocketLike = options.socketFactory(url);
        socket.on("close", (code) =>
          onOutage(
            gen,
            `The connection to arcturn serve closed${code === undefined ? "" : ` (code ${String(code)})`}.`,
          ),
        );
        socket.on("error", (error) =>
          onOutage(
            gen,
            `The connection to arcturn serve failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return socket;
      },
      onDiagnostic: log,
    });
    await client.authenticate();

    attach(await createAndSubscribe(client));
    setStatus("ready");
  };

  const start = async (): Promise<void> => {
    if (disposed || status === "ready") return;
    starting ??= boot()
      .catch((error: unknown) => {
        teardown();
        setStatus("disconnected", `Could not start arcturn serve: ${redactor.message(error)}`);
      })
      .finally(() => {
        starting = undefined;
      });
    return starting;
  };

  const requireClient = (): ProtocolClient => {
    if (client === undefined) throw new Error("Arcturn is not connected");
    return client;
  };

  return {
    get status(): ConnectionStatus {
      return status;
    },
    get controller(): SessionController | undefined {
      return controller;
    },
    start,
    async restart(): Promise<void> {
      if (disposed) return;
      teardown();
      status = "idle";
      await start();
    },
    listSessions: () => requireClient().listSessions(),
    async listModels(): Promise<ModelCatalogEntry[] | undefined> {
      return (await requireClient().listModels())?.models;
    },
    async openSession(sessionId: string): Promise<void> {
      attach(await requireClient().openSession(sessionId));
    },
    async newSession(): Promise<void> {
      attach(await createAndSubscribe(requireClient()));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      teardown();
      // Deliberate shutdown: the card is for outages, not for closing the view.
      status = "idle";
    },
  };
}
