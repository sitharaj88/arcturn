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
  CommandDescriptor,
  McpServerSummary,
  ModelCatalogEntry,
  ProtocolClient,
  SessionHeader,
  SessionHistory,
  WebSocketLike,
} from "../serve/engine.js";
import { createRedactor } from "../serve/redact.js";
import {
  type ServeProcess,
  ServeStartError,
  type SpawnLike,
  startServeProcess,
} from "../serve/supervisor.js";
import {
  type ConnectionReport,
  missingCliReport,
  outageReport,
  reportText,
  startFailureReport,
} from "./connection-card.js";
import {
  type ControllerHost,
  createSessionController,
  type SessionController,
} from "./controller.js";
import type { ConnectionStatus } from "./webview-messages.js";

/** The controller host, plus the connection status the reconnect card renders. */
export interface EngineSessionHost extends ControllerHost {
  /**
   * @param status - Where the connection stands.
   * @param detail - The whole thing as text, redacted: what the Output channel
   *   records and what a notification shows.
   * @param report - The same failure as a card — headline, the engine's own
   *   words, and the buttons to offer. Absent for a status that is not a
   *   failure.
   */
  onConnection: (status: ConnectionStatus, detail?: string, report?: ConnectionReport) => void;
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
  /**
   * The environment `arcturn serve` is spawned with.
   *
   * Called on the first start and on every restart, never at construction —
   * resolving it means running the user's login shell (see `shell-env.ts`),
   * which RFC 0004 §3 forbids spending activation on. Omitted, the child
   * inherits the extension host's own environment, which on a GUI-launched
   * macOS editor is the environment that has no API keys in it.
   */
  resolveEnv?: () => Promise<Record<string, string | undefined>>;
}

/** A managed `arcturn serve` plus the session open against it. */
export interface EngineSession {
  readonly status: ConnectionStatus;
  /**
   * Why the engine is not connected, or `undefined` while it is.
   *
   * The sidebar has a card for this; a command invoked from the palette has
   * nothing, and used to fail silently. This is what lets that path say the
   * same thing the card says.
   */
  readonly failure: ConnectionReport | undefined;
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
  /**
   * The MCP servers this engine is configured with, or `undefined` when the
   * engine is older than the `mcpStatus` verb.
   *
   * Server-scoped, beside `listModels` and for the same reason: MCP servers
   * are a property of the engine process, not of a conversation.
   */
  mcpServers(): Promise<McpServerSummary[] | undefined>;
  /**
   * Begin authorizing an OAuth-protected MCP server, with the editor catching
   * the redirect. `undefined` when the engine is too old to broker one.
   *
   * See `mcp-auth.ts` for why the editor has to catch it: the engine's own
   * loopback redirect is unreachable from the user's browser whenever the two
   * are on different machines, which over Remote-SSH or in a devcontainer is
   * the normal case rather than the exotic one.
   */
  mcpAuthBegin(
    server: string,
    redirectUri: string,
  ): Promise<{ authorized: boolean; handle?: string; authorizationUrl?: string } | undefined>;
  /** Hand back the code and state the redirect carried. */
  mcpAuthComplete(handle: string, code: string, state: string): Promise<void>;
  /** Abandon a begun authorization. */
  mcpAuthCancel(handle: string): Promise<boolean>;
  /**
   * What a `/` could invoke on this engine — the workspace's markdown skills
   * plus the built-ins this wire can carry out — or `undefined` when this
   * engine is older than the `listCommands` verb.
   *
   * Server-scoped rather than session-scoped, which is why it sits here beside
   * `listModels` rather than on the controller: skills are files on disk and
   * the built-in list is a property of the protocol, neither of which changes
   * because a different session is attached.
   *
   * Callers show no `/` menu on `undefined` rather than an empty one — "this
   * workspace has no skills" and "this engine cannot tell me" are not the same
   * news, and the panel has been careful about that distinction since the
   * session list.
   */
  listCommands(): Promise<CommandDescriptor[] | undefined>;
  /** Attach to an existing session, replaying its stored conversation. */
  openSession(sessionId: string): Promise<void>;
  /** Create and attach to a fresh session. */
  newSession(): Promise<void>;
  /**
   * Delete a session on the engine. Irreversible, and **not** confirmed here —
   * the caller owns the modal (see `index.ts`), because this object has no
   * `vscode` import and a confirmation the user cannot see is not one.
   *
   * The engine performs the deletion; this extension never touches a session
   * file. A refusal (the session is running, the engine is too old) rejects
   * and leaves everything exactly as it was, panel included.
   *
   * When the deleted session is the one currently attached, its controller is
   * disposed *after* the engine confirms — so the panel stops rendering a
   * conversation that no longer exists, and the caller is left to decide what
   * the panel shows instead.
   */
  deleteSession(sessionId: string): Promise<void>;
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
  let failure: ConnectionReport | undefined;
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

  /**
   * Publish a status.
   *
   * The report is redacted here rather than at the call sites: it is built
   * from the child's stderr, and this session is the only object that knows
   * the token by value. `supervisor.ts` has already redacted the same text by
   * value; doing it again costs nothing and means a report assembled from any
   * other source cannot skip the step.
   */
  const setStatus = (next: ConnectionStatus, report?: ConnectionReport): void => {
    status = next;
    if (report === undefined) {
      failure = undefined;
      options.host.onConnection(next);
      return;
    }
    const redacted: ConnectionReport = {
      headline: redactor.redact(report.headline),
      engineOutput: redactor.redact(report.engineOutput),
      actions: report.actions,
    };
    failure = next === "disconnected" ? redacted : undefined;
    options.host.onConnection(next, reportText(redacted), redacted);
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
    setStatus("disconnected", outageReport(detail));
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

  /**
   * The session's stored conversation, or `undefined` when there is none to be
   * had.
   *
   * Never allowed to break an attach. `sessionHistory` is an optional verb —
   * an engine older than it resolves `undefined` and the panel shows the empty
   * transcript it always used to — and a genuine failure is a diagnostic, not
   * a reason to refuse to open a session the user asked for.
   *
   * @param connected - The client to ask.
   * @param sessionId - The session being attached.
   */
  const fetchHistory = async (
    connected: ProtocolClient,
    sessionId: string,
  ): Promise<SessionHistory | undefined> => {
    try {
      const history = await connected.sessionHistory(sessionId);
      if (history === undefined) {
        log(`sidebar: this arcturn engine cannot replay session history (${sessionId})`);
      }
      return history;
    } catch (error) {
      log(
        `sidebar: could not replay session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  };

  /**
   * Point the panel at one session, with whatever of it the engine can replay.
   *
   * The history is fetched *before* the previous controller is disposed, so
   * the panel keeps showing the conversation the user is leaving until the one
   * they are arriving at is ready, rather than blanking for a round trip.
   */
  const attach = async (header: SessionHeader): Promise<void> => {
    if (client === undefined) return;
    const connected = client;
    const history = await fetchHistory(connected, header.sessionId);
    // Re-checked after the await: a teardown may have replaced the connection
    // while the history was in flight, and attaching a controller to a client
    // this session no longer owns would leak a subscription past `dispose()`.
    if (client !== connected) return;
    controller?.dispose();
    controller = createSessionController({
      client: connected,
      sessionId: header.sessionId,
      host: controllerHost,
      header,
      ...(history === undefined ? {} : { history }),
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
        missingCliReport(
          "The arcturn CLI could not be found. Set arcturn.cliPath, or install it with npm install -g arcturn.",
        ),
      );
      return;
    }

    // Resolved here — after the CLI lookup, before the spawn — because this is
    // the first moment the extension actually needs it, and running a login
    // shell is not something to do on a path the user has not asked for.
    const env = await options.resolveEnv?.();

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
      ...(env === undefined ? {} : { env }),
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

    await attach(await createAndSubscribe(client));
    setStatus("ready");
  };

  const start = async (): Promise<void> => {
    if (disposed || status === "ready") return;
    starting ??= boot()
      .catch((error: unknown) => {
        teardown();
        setStatus(
          "disconnected",
          error instanceof ServeStartError
            ? startFailureReport(error.failure)
            : // Everything else that can throw out of `boot()` — the socket
              // refusing the address, `authenticate` failing, `createSession`
              // erroring — happened *after* serve came up, so it is the
              // extension's own account rather than the engine's.
              outageReport(`Could not start arcturn serve: ${redactor.message(error)}`),
        );
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
    get failure(): ConnectionReport | undefined {
      return failure;
    },
    get controller(): SessionController | undefined {
      return controller;
    },
    start,
    async restart(): Promise<void> {
      if (disposed) return;
      teardown();
      status = "idle";
      failure = undefined;
      await start();
    },
    listSessions: () => requireClient().listSessions(),
    async listModels(): Promise<ModelCatalogEntry[] | undefined> {
      return (await requireClient().listModels())?.models;
    },
    async mcpServers(): Promise<McpServerSummary[] | undefined> {
      return (await requireClient().mcpStatus())?.servers;
    },
    async mcpAuthBegin(server: string, redirectUri: string) {
      return requireClient().mcpAuthBegin(server, redirectUri);
    },
    async mcpAuthComplete(handle: string, code: string, state: string): Promise<void> {
      await requireClient().mcpAuthComplete(handle, code, state);
    },
    async mcpAuthCancel(handle: string): Promise<boolean> {
      return requireClient().mcpAuthCancel(handle);
    },
    async listCommands(): Promise<CommandDescriptor[] | undefined> {
      return (await requireClient().listCommands())?.commands;
    },
    async openSession(sessionId: string): Promise<void> {
      await attach(await requireClient().openSession(sessionId));
    },
    async newSession(): Promise<void> {
      await attach(await createAndSubscribe(requireClient()));
    },
    async deleteSession(sessionId: string): Promise<void> {
      // The engine goes first. Disposing the controller before the delete was
      // confirmed would tear the panel down for a deletion that then failed —
      // a session still running its turn is refused, and the user must be left
      // looking at it.
      await requireClient().deleteSession(sessionId);
      if (controller?.sessionId !== sessionId) return;
      controller.dispose();
      controller = undefined;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      teardown();
      // Deliberate shutdown: the card is for outages, not for closing the view.
      status = "idle";
      failure = undefined;
    },
  };
}
