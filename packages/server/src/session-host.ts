/**
 * {@link SessionHost} — manages live {@link Agent} sessions decoupled from any
 * transport. `@arcturn/server`'s WebSocket layer (`ws-server.ts`) is the only
 * consumer in this package, but nothing here depends on `ws`.
 */

import { resolve, sep } from "node:path";
import { type Agent, createSessionId } from "@arcturn/core";
import { validateModelCatalog, validateSessionHistory } from "@arcturn/protocol";
import type {
  AgentEvent,
  AgentEventListener,
  ModelCatalogEntry,
  ModelSpec,
  PermissionDecision,
  PermissionPrompt,
  SessionHeader,
  SessionHistory,
  SessionStore,
} from "@arcturn/types";
import { buildSessionHistory, type SessionHistoryLimits } from "./session-history.js";

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
   * Bounds on the payload {@link SessionHost.sessionHistory} returns. Both
   * halves default; see `session-history.ts`. Injectable so a test can prove
   * the cap actually cuts without writing a megabyte of conversation first.
   */
  sessionHistoryLimits?: SessionHistoryLimits;
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

/**
 * Whether a store rejected because the id names no session it has.
 *
 * `@arcturn/core`'s stores raise `SessionStoreError` with `notFound` (no such
 * session) or `invalidId` (an id no session could ever have — a traversal
 * attempt, say); both mean "not a session here" and neither is a server fault.
 * Duck-typed rather than `instanceof`, because a third-party `SessionStore`
 * (the SDK docs invite one) is not obliged to use that class, and misreading
 * its "not found" as an internal fault would be the worse mistake.
 *
 * Everything else — a corrupt session file, a permissions error — is
 * deliberately *not* folded in here. Reporting "this session does not exist"
 * for a file the server could not read is a lie a user cannot act on.
 */
function isMissingSession(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "notFound" || code === "invalidId";
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
  readonly #sessionHistoryLimits: SessionHistoryLimits;
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
    this.#sessionHistoryLimits = options.sessionHistoryLimits ?? {};
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
   * One session's stored conversation, replayed as events.
   *
   * Deliberately **not** session-liveness-scoped: a client may want to render
   * a session it has not attached to, and reading entries needs no agent. It
   * is also deliberately not part of `openSession` — see `ClientRequest`'s
   * `sessionHistory` doc for why the replay is a separate, skippable call.
   *
   * The payload is bounded (see `session-history.ts`) and normalized against
   * the wire contract on the way out — the same discipline
   * {@link SessionHost.listModels} applies to the catalog, for the same
   * reason: whatever this host hands over, only what the contract defines can
   * reach a client.
   *
   * @param sessionId - Session to replay.
   * @returns Its history, oldest event first, truncation reported explicitly.
   * @throws {SessionHostError} `sessionNotFound` when neither the store nor
   *   this process knows the session.
   * @throws When the projection is not a valid wire payload — a bug in this
   *   package, and one worth reporting rather than serving a mangled
   *   transcript a user would read as their actual conversation.
   */
  async sessionHistory(sessionId: string): Promise<SessionHistory> {
    const store = this.#sessionStore;
    if (!store) {
      // No store means nothing was ever persisted, so a live session's history
      // is genuinely empty — but an id this process has never seen is still
      // not a session, and saying "no history" for it would be a different
      // (and false) answer.
      if (!this.#sessions.has(sessionId)) {
        throw new SessionHostError("sessionNotFound", `Session ${sessionId} does not exist`);
      }
      return { sessionId, events: [], truncated: false, droppedEvents: 0 };
    }

    let entries: Awaited<ReturnType<SessionStore["entries"]>>;
    try {
      entries = await store.entries(sessionId);
    } catch (error) {
      if (isMissingSession(error)) {
        throw new SessionHostError("sessionNotFound", `Session ${sessionId} does not exist`);
      }
      // A session the store has but could not read — a torn file, a
      // permissions problem — is a real fault, and reporting it as "no such
      // session" would send a user looking for a session they can see listed.
      throw error;
    }

    const history = buildSessionHistory(sessionId, entries, this.#sessionHistoryLimits);
    const validation = validateSessionHistory(history);
    if (!validation.ok) {
      throw new Error(`Session history is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * Delete a session permanently — from the store, and from this process.
   *
   * The engine owns this rather than a client, because a client unlinking the
   * file would be a second implementation of session storage living outside
   * the process that owns it: it could not see a session still live in this
   * host's memory, and it could not know whether a run was in flight.
   *
   * Order matters and is deliberate. The busy check runs first; the **store**
   * delete runs next; the live session is evicted last. Evicting first would
   * mean telling every attached client "this was deleted" and then discovering
   * the store could not delete it — a lie that leaves the session on disk.
   * Done this way, a store failure surfaces as an error with the session
   * intact and still re-openable.
   *
   * Eviction is not `dispose()`'s graceful wind-down: there is nothing left to
   * wind down to. Pending permission asks are denied, any run that started in
   * the gap after the busy check is aborted, every observer is sent a final
   * `notice` saying the session was deleted — so an attached client is *told*
   * rather than left watching a session that no longer exists — and the
   * subscription is then dropped.
   *
   * @param sessionId - Session to remove.
   * @throws {SessionHostError} `sessionBusy` when the session is running a
   *   turn (abort it first — deleting the file out from under an agent still
   *   appending to it is not a thing to do quietly), or `sessionNotFound`
   *   when neither the store nor this process knows it.
   * @throws {Error} When a `sessionStore` is configured but does not implement
   *   the optional {@link SessionStore.delete}. The same refusal
   *   {@link SessionHostOptions.resolveModel} makes, for the same reason: the
   *   store is the only thing that knows where its sessions live, and this
   *   host guessing at a path would be guessing at which files to unlink.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const live = this.#sessions.get(sessionId);
    if (live?.agent.isRunning === true) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} is running a turn; abort it before deleting it`,
      );
    }

    const store = this.#sessionStore;
    if (store) {
      if (typeof store.delete !== "function") {
        throw new Error(
          `Cannot delete session ${JSON.stringify(sessionId)}: this server's SessionStore does ` +
            "not implement the optional delete(sessionId) method, and this host will not " +
            "guess at which files back it. Refusing rather than reaching around the store.",
        );
      }
      try {
        await store.delete(sessionId);
      } catch (error) {
        if (!isMissingSession(error)) throw error;
        // The store says it is already gone. If this process is still holding
        // it live, finish the job — the caller asked for it to not exist, and
        // it does not. Otherwise there was nothing to delete.
        if (live === undefined) {
          throw new SessionHostError("sessionNotFound", `Session ${sessionId} does not exist`);
        }
      }
    } else if (live === undefined) {
      throw new SessionHostError("sessionNotFound", `Session ${sessionId} does not exist`);
    }

    if (live !== undefined) this.#evict(sessionId, live);
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

  /**
   * Tear one live session out of this host, telling its watchers why.
   *
   * The notice goes out *before* the observers are dropped and uses the
   * ordinary `notice` event rather than a new wire shape, so a client renders
   * it with whatever it already does for engine diagnostics.
   */
  #evict(sessionId: string, session: LiveSession): void {
    for (const [requestId, pending] of session.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({
        requestId,
        behavior: "deny",
        message: "This session was deleted.",
      });
    }
    session.pendingPermissions.clear();
    // Belt and braces: `deleteSession` checked `isRunning` before touching the
    // store, but another connection could have started a run in the gap, and
    // an agent appending to a session file that no longer exists is worse than
    // an aborted run.
    session.agent.abort();

    const deleted: AgentEvent = {
      type: "notice",
      level: "warn",
      text: `Session ${sessionId} was deleted.`,
    };
    for (const listener of [...session.observers]) {
      try {
        listener(deleted);
      } catch {
        // An observer must never be able to break fan-out to the others.
      }
    }

    session.unsubscribe();
    session.observers.clear();
    this.#sessions.delete(sessionId);
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
