/**
 * {@link SessionHost} — manages live {@link Agent} sessions decoupled from any
 * transport. `@arcturn/server`'s WebSocket layer (`ws-server.ts`) is the only
 * consumer in this package, but nothing here depends on `ws`.
 */

import { resolve, sep } from "node:path";
import { type Agent, createSessionId } from "@arcturn/core";
import { validateModelCatalog } from "@arcturn/protocol";
import type {
  AgentEvent,
  AgentEventListener,
  ModelCatalogEntry,
  ModelSpec,
  PermissionDecision,
  PermissionPrompt,
  SessionHeader,
  SessionStore,
} from "@arcturn/types";

/** Machine-readable failure kinds surfaced by {@link SessionHost}. */
export type SessionHostErrorCode = "sessionNotFound" | "sessionBusy" | "invalidRequest";

/** Thrown by {@link SessionHost} methods on a known, expected failure. */
export class SessionHostError extends Error {
  constructor(
    readonly code: SessionHostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionHostError";
  }
}

/** Arguments passed to {@link SessionHostOptions.agentFactory}. */
export interface AgentFactoryOptions {
  sessionId: string;
  cwd: string;
  model?: string;
}

/** Construction options for {@link SessionHost}. */
export interface SessionHostOptions {
  /**
   * Builds (or resumes) the {@link Agent} backing one session. Called once per
   * session, for both new sessions ({@link SessionHost.createSession}) and
   * sessions re-attached via {@link SessionHost.openSession}. When a
   * `sessionStore` is shared between the factory and this host, resuming a
   * previously-created session is the factory's responsibility (e.g. via
   * `Agent.resume`) — `SessionHost` only tracks liveness and fans out events.
   */
  agentFactory: (opts: AgentFactoryOptions) => Agent;
  /**
   * Backing store used to persist and list session headers. Optional: without
   * one, `SessionHost` only knows about sessions created or opened during the
   * current process lifetime.
   */
  sessionStore?: SessionStore;
  /**
   * Confines a client-supplied `cwd` to this directory tree. Without it a
   * client could root a session anywhere on disk — `createSession({cwd:"/"})`
   * — and every tool would resolve paths against that root. Defaults to
   * `defaultCwd`, i.e. the served workspace.
   */
  cwdRoot?: string;
  /** Working directory used when `createSession` is called without a `cwd`. */
  defaultCwd: string;
  /**
   * How long a permission ask waits for {@link SessionHost.handlePermissionDecision}
   * before it is auto-denied. Defaults to 5 minutes.
   */
  permissionTimeoutMs?: number;
  /**
   * Resolves a wire-level model id (a plain string) to the full
   * {@link ModelSpec} required by `Agent.setModel`. See NOTES.md — the wire
   * protocol's `setModel` only carries a model id, not a `ModelSpec`, and a
   * `ModelSpec` is what decides which provider, endpoint and credential the
   * session's next request uses.
   *
   * Injected for the same reason as {@link SessionHostOptions.modelCatalog},
   * and it should be wired from the same catalog: the pair is what a client
   * sees (`listModels`) and what actually happens when it picks one
   * (`setModel`). Wiring one without the other is how those two drift.
   *
   * Omitted, {@link SessionHost.setModel} **refuses** every request rather
   * than inventing a spec. There is no safe guess: an id names a provider
   * only by convention, so a synthesized spec routes the session's next
   * prompt — and the credential that goes with it — to whichever provider the
   * guess happened to name. Refusing is loud and fixable; guessing is silent
   * and is not.
   *
   * @throws Anything, for an id it cannot resolve (unknown model, no
   *   credentials). {@link SessionHost.setModel} turns that into an
   *   `invalidRequest` {@link SessionHostError} and leaves the session on the
   *   model it was already using.
   */
  resolveModel?: (modelId: string) => ModelSpec;
  /**
   * Source of the model catalog {@link SessionHost.listModels} answers with.
   *
   * Injected for the same reason as {@link SessionHostOptions.resolveModel}:
   * the catalog lives in `@arcturn/ai`, and this package does not depend on
   * it — the CLI, which owns model registration, supplies the real one (see
   * `createServeHost` and `modelCatalogEntries` in `@arcturn/cli`). Omitted,
   * the host reports an empty catalog rather than inventing entries it has no
   * way to know about.
   *
   * Whatever this returns is re-validated against the wire contract before it
   * leaves the host, so an entry can never carry a field the contract does
   * not define — a credential *value* being the one that matters.
   */
  modelCatalog?: () => ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>;
  /**
   * Maximum number of concurrently *live* sessions this host will hold (each
   * one is a full agent: LLM connection, tool set, in-memory history).
   * Without a cap, a client could `createSession` in a loop and exhaust
   * server memory. Past the cap, {@link SessionHost.createSession} and
   * {@link SessionHost.openSession} (for a session not already live) throw
   * `SessionHostError` with code `invalidRequest` — the same code used for
   * every other client-caused capacity/validation refusal here, so callers
   * don't need a new error code to handle this. Defaults to
   * {@link DEFAULT_MAX_SESSIONS}. A session that ends (its agent is never
   * explicitly "closed" today — see NOTES.md) still counts against the cap
   * for the process's lifetime, matching `#sessions`' existing behavior.
   */
  maxSessions?: number;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** See {@link SessionHostOptions.maxSessions}. */
export const DEFAULT_MAX_SESSIONS = 16;

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveSession {
  header: SessionHeader;
  agent: Agent;
  observers: Set<AgentEventListener>;
  /** Awaiting client decisions, keyed by the request id the client is shown. */
  pendingPermissions: Map<string, PendingPermission>;
  unsubscribe: () => void;
}

/** Manages live agent sessions and fans out their events to observers. */
export class SessionHost {
  readonly #agentFactory: (opts: AgentFactoryOptions) => Agent;
  readonly #sessionStore: SessionStore | undefined;
  readonly #defaultCwd: string;
  readonly #cwdRoot: string;
  readonly #permissionTimeoutMs: number;
  readonly #resolveModel: ((modelId: string) => ModelSpec) | undefined;
  readonly #modelCatalog: (() => ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>) | undefined;
  readonly #maxSessions: number;
  readonly #sessions = new Map<string, LiveSession>();

  constructor(options: SessionHostOptions) {
    this.#agentFactory = options.agentFactory;
    this.#sessionStore = options.sessionStore;
    // Both are stored resolved, and for the same reason: the confinement
    // check below is a string comparison against `#cwdRoot`, so a default cwd
    // that is spelled differently (relative, or — on Windows — drive-relative
    // like `\tmp\ws`, which resolves against whatever drive the process
    // happens to be on) would hand sessions a working directory that no
    // longer matches the wall guarding it. Every session header then reports
    // one canonical, absolute path whichever way it was created.
    this.#defaultCwd = resolve(options.defaultCwd);
    this.#cwdRoot = resolve(options.cwdRoot ?? options.defaultCwd);
    this.#permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.#resolveModel = options.resolveModel;
    this.#modelCatalog = options.modelCatalog;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /**
   * @throws {SessionHostError} `invalidRequest` when the host is already at
   *   `maxSessions` live sessions. Called just before minting a new live
   *   session (a `#sessions` entry that doesn't exist yet) — re-attaching to
   *   an already-live session never hits this.
   */
  #checkSessionCapacity(): void {
    if (this.#sessions.size >= this.#maxSessions) {
      throw new SessionHostError(
        "invalidRequest",
        `Session limit reached (${this.#maxSessions}); close an existing session before opening another`,
      );
    }
  }

  /**
   * Confine a client-supplied working directory to the served tree.
   *
   * A remote client picks this value, and every tool resolves its paths
   * against it — so an unchecked `cwd` would let a token holder operate on
   * any directory on the machine (and slip past a `--dry-run` overlay scoped
   * to the real workspace).
   *
   * @param requested - The `cwd` from the wire, if any.
   * @returns The directory to run the session in.
   * @throws {SessionHostError} `invalidRequest` when it escapes the root.
   */
  #resolveSessionCwd(requested: string | undefined): string {
    if (requested === undefined) return this.#defaultCwd;
    const candidate = resolve(this.#cwdRoot, requested);
    if (candidate !== this.#cwdRoot && !candidate.startsWith(this.#cwdRoot + sep)) {
      throw new SessionHostError(
        "invalidRequest",
        `cwd ${JSON.stringify(requested)} is outside the served workspace`,
      );
    }
    return candidate;
  }

  /**
   * List known session headers.
   *
   * Backed by `sessionStore` when one is configured; otherwise falls back to
   * sessions created or opened during this process's lifetime.
   */
  async listSessions(): Promise<SessionHeader[]> {
    if (this.#sessionStore) return this.#sessionStore.list();
    return [...this.#sessions.values()]
      .map((session) => session.header)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Every model a client may pass to {@link SessionHost.setModel}.
   *
   * Not session-scoped: the catalog is a property of the server. Sourced from
   * {@link SessionHostOptions.modelCatalog} and normalized against the wire
   * contract on the way out — unknown fields are dropped, so a host that
   * hands over more than the contract defines cannot leak it to a client.
   *
   * @returns The catalog, or `[]` when no source was wired.
   * @throws When the wired source returns entries that are not valid
   *   {@link ModelCatalogEntry} values. That is a wiring bug in the host
   *   process, and reporting it beats quietly serving a truncated catalog a
   *   user would read as "these are all the models there are".
   */
  async listModels(): Promise<ModelCatalogEntry[]> {
    if (!this.#modelCatalog) return [];
    const entries = await this.#modelCatalog();
    const validation = validateModelCatalog({ models: entries });
    if (!validation.ok) {
      throw new Error(`Model catalog is not a valid wire payload: ${validation.error}`);
    }
    return validation.value.models;
  }

  /**
   * Create a new session and its backing agent.
   *
   * @param params - Working directory (defaults to `defaultCwd`) and model id.
   */
  async createSession(params: { cwd?: string; model?: string }): Promise<SessionHeader> {
    this.#checkSessionCapacity();
    const cwd = this.#resolveSessionCwd(params.cwd);
    const sessionId = createSessionId();
    const agent = this.#agentFactory({
      sessionId,
      cwd,
      ...(params.model === undefined ? {} : { model: params.model }),
    });

    const header: SessionHeader = this.#sessionStore
      ? await this.#sessionStore.create({ sessionId, cwd })
      : { version: 1, sessionId, cwd, createdAt: Date.now() };

    this.#register(header, agent);
    return header;
  }

  /**
   * Re-attach to an existing session, creating its live agent via
   * `agentFactory` if it is not already running in this process.
   *
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is neither live nor known to `sessionStore`.
   */
  async openSession(sessionId: string): Promise<SessionHeader> {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing.header;
    this.#checkSessionCapacity();

    if (!this.#sessionStore) {
      throw new SessionHostError("sessionNotFound", `Session ${sessionId} does not exist`);
    }
    let header: SessionHeader;
    try {
      header = await this.#sessionStore.open(sessionId);
    } catch {
      throw new SessionHostError("sessionNotFound", `Session ${sessionId} does not exist`);
    }

    const agent = this.#agentFactory({ sessionId, cwd: header.cwd });
    this.#register(header, agent);
    return header;
  }

  /**
   * Subscribe to one session's event stream.
   *
   * @returns An unsubscribe function.
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is not live (call {@link SessionHost.openSession} first).
   */
  observe(sessionId: string, listener: AgentEventListener): () => void {
    const session = this.#require(sessionId);
    session.observers.add(listener);
    return () => {
      session.observers.delete(listener);
    };
  }

  /**
   * Run one prompt to completion.
   *
   * Resolves once the agent's run ends (completed, aborted, or errored) —
   * callers that only want an ack should treat the `runStart` event as one.
   *
   * @throws {SessionHostError} with code `sessionBusy` when a run is already
   *   active, or `sessionNotFound` when the session is not live.
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    const session = this.#require(sessionId);
    if (session.agent.isRunning) {
      throw new SessionHostError("sessionBusy", `Session ${sessionId} is already running a turn`);
    }
    await session.agent.prompt(text);
  }

  /**
   * Queue a mid-run steering message (or, if idle, the next prompt).
   *
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is not live.
   */
  steer(sessionId: string, text: string): void {
    this.#require(sessionId).agent.steer(text);
  }

  /**
   * Abort the session's current run. A no-op when idle.
   *
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is not live.
   */
  abort(sessionId: string): void {
    this.#require(sessionId).agent.abort();
  }

  /**
   * Switch the model used for the session's next turn.
   *
   * The id is resolved *before* anything on the session is touched, so a
   * refusal leaves the session on the model it was already running — there is
   * no half-switched state to recover from.
   *
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is not live, or `invalidRequest` when
   *   {@link SessionHostOptions.resolveModel} rejects the id (unknown model,
   *   missing credentials).
   * @throws {Error} When no `resolveModel` was wired into this host. See
   *   {@link SessionHostOptions.resolveModel}: this host has no way to know
   *   which provider `modelId` names, and guessing would send the session's
   *   next prompt and credential to a provider the client never asked for.
   */
  setModel(sessionId: string, modelId: string): void {
    const session = this.#require(sessionId);
    // Not `resolve`: that name is `node:path`'s in this module.
    const resolveModel = this.#resolveModel;
    if (!resolveModel) {
      throw new Error(
        `Cannot switch to model ${JSON.stringify(modelId)}: this server was built without ` +
          "SessionHostOptions.resolveModel, so it cannot tell which provider that id names. " +
          "Refusing rather than guessing one.",
      );
    }
    let spec: ModelSpec;
    try {
      spec = resolveModel(modelId);
    } catch (error) {
      throw new SessionHostError(
        "invalidRequest",
        `Cannot switch to model ${JSON.stringify(modelId)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    session.agent.setModel(spec);
  }

  /**
   * Resolve a pending permission ask raised by the session's agent.
   *
   * Unknown, already-resolved or timed-out request ids are ignored rather
   * than raising an error — a decision arriving late is not a protocol
   * violation, just a no-op.
   *
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is not live.
   */
  handlePermissionDecision(sessionId: string, decision: PermissionDecision): void {
    const session = this.#require(sessionId);
    const pending = session.pendingPermissions.get(decision.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pendingPermissions.delete(decision.requestId);
    pending.resolve(decision);
  }

  /**
   * Deny every pending permission ask, then abort every live run.
   *
   * Deliberately does *not* unsubscribe from agent events or clear
   * `observers`: aborting still lets an in-flight run wind down (denied tool
   * results, a final `runEnd`), and callers watching a session should still
   * see that tail. Intended for a graceful server shutdown; sessions are not
   * removed from `sessionStore`, and observers are left for callers (e.g.
   * `ArcturnServer`) to detach as they tear down their own transport state.
   */
  dispose(): void {
    for (const session of this.#sessions.values()) {
      for (const [requestId, pending] of session.pendingPermissions) {
        clearTimeout(pending.timer);
        pending.resolve({
          requestId,
          behavior: "deny",
          message: "Server is shutting down.",
        });
      }
      session.pendingPermissions.clear();
      session.agent.abort();
    }
  }

  #require(sessionId: string): LiveSession {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new SessionHostError("sessionNotFound", `Session ${sessionId} does not exist`);
    }
    return session;
  }

  #register(header: SessionHeader, agent: Agent): LiveSession {
    const observers = new Set<AgentEventListener>();
    const pendingPermissions = new Map<string, PendingPermission>();

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      for (const listener of [...observers]) {
        try {
          listener(event);
        } catch {
          // An observer must never be able to break fan-out to the others.
        }
      }
    });

    // The prompt receives the request id the client will quote back, so
    // decisions are matched by identity. Inferring the pairing by arrival
    // order would desync the moment the engine settled a request from its
    // rules without ever prompting.
    const requester: PermissionPrompt = (request) => {
      const requestId = request.id;
      return new Promise<PermissionDecision>((resolve) => {
        const timer = setTimeout(() => {
          pendingPermissions.delete(requestId);
          resolve({
            requestId,
            behavior: "deny",
            message: "Permission request timed out.",
          });
        }, this.#permissionTimeoutMs);
        timer.unref?.();
        pendingPermissions.set(requestId, { resolve, timer });
      });
    };
    agent.permissions.setRequester(requester);

    const session: LiveSession = {
      header,
      agent,
      observers,
      pendingPermissions,
      unsubscribe,
    };
    this.#sessions.set(header.sessionId, session);
    return session;
  }
}
