/**
 * {@link SessionHost} — manages live {@link Agent} sessions decoupled from any
 * transport. `@arcturn/server`'s WebSocket layer (`ws-server.ts`) is the only
 * consumer in this package, but nothing here depends on `ws`.
 */

import { resolve, sep } from "node:path";
import { type Agent, createSessionId } from "@arcturn/core";
import type {
  AgentEvent,
  AgentEventListener,
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
   * protocol's `setModel` only carries a model id, not a `ModelSpec`. Defaults
   * to synthesizing a minimal, likely-inaccurate spec from the id alone.
   */
  resolveModel?: (modelId: string) => ModelSpec;
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
  readonly #resolveModel: (modelId: string) => ModelSpec;
  readonly #maxSessions: number;
  readonly #sessions = new Map<string, LiveSession>();

  constructor(options: SessionHostOptions) {
    this.#agentFactory = options.agentFactory;
    this.#sessionStore = options.sessionStore;
    this.#defaultCwd = options.defaultCwd;
    this.#cwdRoot = resolve(options.cwdRoot ?? options.defaultCwd);
    this.#permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.#resolveModel = options.resolveModel ?? defaultResolveModel;
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
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is not live.
   */
  setModel(sessionId: string, modelId: string): void {
    this.#require(sessionId).agent.setModel(this.#resolveModel(modelId));
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

/**
 * Fallback for {@link SessionHostOptions.resolveModel}: synthesizes a minimal
 * `ModelSpec` from a bare model id. Hosts that care about accurate context
 * windows, pricing or capabilities should inject a real catalog lookup
 * instead — see NOTES.md.
 */
function defaultResolveModel(modelId: string): ModelSpec {
  return {
    id: modelId,
    provider: "anthropic",
    model: modelId,
    displayName: modelId,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: { tools: true, vision: false, thinking: false, caching: false },
  };
}
