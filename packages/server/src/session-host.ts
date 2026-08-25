/**
 * {@link SessionHost} — manages live {@link Agent} sessions decoupled from any
 * transport. `@arcturn/server`'s WebSocket layer (`ws-server.ts`) is the only
 * consumer in this package, but nothing here depends on `ws`.
 */

import { resolve, sep } from "node:path";
import { type Agent, createSessionId } from "@arcturn/core";
import {
  validateBackgroundAgentList,
  validateCheckpointList,
  validateCommandList,
  validateCompactionSummary,
  validateContextResolution,
  validateMcpStatus,
  validateModelCatalog,
  validateOrgMemoryList,
  validateOrgMemoryProposal,
  validatePermissionState,
  validateRewindResult,
  validateSessionExport,
  validateSessionHistory,
  validateWorkflowCatalog,
  validateWorkflowRunHandle,
  validateWorkflowRuns,
} from "@arcturn/protocol";
import type {
  AdoptBackgroundAgentResult,
  AgentEvent,
  AgentEventListener,
  ApplyChangesResult,
  BackgroundAgentList,
  BackgroundAgentTranscript,
  CancelBackgroundAgentResult,
  CheckpointList,
  CommandDescriptor,
  CompactionSummary,
  ContextResolution,
  DiscardChangesResult,
  McpServerSummary,
  ModelCatalogEntry,
  ModelSpec,
  OrgMemoryList,
  OrgMemoryProposal,
  PendingChanges,
  PermissionDecision,
  PermissionMode,
  PermissionPrompt,
  PermissionRequest,
  PermissionScope,
  PermissionState,
  PromptAttachment,
  RewindFailure,
  RewindResult,
  SessionExport,
  SessionHeader,
  SessionHistory,
  SessionStore,
  StartedBackgroundAgent,
  TranscriptFormat,
  UserContent,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowSummary,
} from "@arcturn/types";
import type { BackgroundAgentRegistry } from "./background-agents.js";
import {
  BACKGROUND_TRANSCRIPT_MAX_BYTES,
  capTranscript,
  projectBackgroundAgent,
  projectBackgroundAgents,
} from "./background-agents.js";
import {
  createDryRunReview,
  type DryRunOverlay,
  type DryRunResult,
  type DryRunReview,
  type PendingChangesLimits,
} from "./dry-run.js";
import type { OrgMemoryStoreAccess } from "./org-memory.js";
import { projectOrgMemory, projectOrgMemoryEntry } from "./org-memory.js";
import {
  ContextRefusedError,
  type ContextResolver,
  type ResolvedPrompt,
  visionRefusalMessage,
} from "./prompt-context.js";
import {
  buildCheckpointList,
  type CheckpointListLimits,
  checkpointConfirmation,
  type SessionCheckpoints,
  workspaceRelative,
} from "./rewind.js";
import {
  buildSessionExport,
  type SessionExportLimits,
  type TranscriptExporter,
} from "./session-export.js";
import { buildSessionHistory, type SessionHistoryLimits } from "./session-history.js";
import type { AcceptedWorkflowRun, WorkflowResult, WorkflowService } from "./workflows.js";

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
   * Turns a client's `@`-mentions and attachments into content a model reads.
   *
   * Injected for exactly the reason {@link SessionHostOptions.resolveModel} and
   * {@link SessionHostOptions.modelCatalog} are: the knowledge lives in
   * `@arcturn/cli` (`expandMentions`, which the TUI and `--print` already call),
   * this package cannot depend on it, and RFC 0005 §1.1 requires the served
   * path to expand mentions *exactly* as the TUI does rather than approximately.
   *
   * Omitted, this host is the pre-RFC-0005 engine: `prompt` text is passed to
   * the agent verbatim — which is the bug RFC 0005 §0 names, kept only so a
   * host assembled without one still runs — and a prompt carrying
   * `attachments` is **refused** rather than run without them. Refusing is the
   * whole point: an attachment quietly dropped is the failure this verb exists
   * to prevent, and it is not made better by happening in the wiring.
   */
  contextResolver?: ContextResolver;
  /**
   * Source of the command list {@link SessionHost.listCommands} answers with.
   *
   * Injected for the reason {@link SessionHostOptions.modelCatalog} is: skill
   * discovery lives in `@arcturn/cli` (`loadSkills`), this package does not
   * depend on it, and the CLI — which already loaded the skills for its own
   * slash commands — supplies the same collection here (see `createServeHost`).
   * One discovery, two front-ends; nothing re-reads the skills directory with
   * slightly different rules.
   *
   * The host that wires this is also the host that decides which **built-ins**
   * belong in it, and the rule is not "every command the CLI has" but "every
   * command the verbs on this wire can carry out". A `/rewind` in this list
   * would be a menu entry a remote client cannot execute.
   *
   * Omitted, {@link SessionHost.listCommands} answers `[]` — no commands here,
   * which is a different and honest answer from "this engine has no such verb"
   * (that one is the `invalidRequest` an older server sends).
   *
   * Whatever this returns is re-validated against the wire contract before it
   * leaves the host, so an entry can never carry a field the contract does not
   * define.
   */
  commands?: () => CommandDescriptor[] | Promise<CommandDescriptor[]>;
  /**
   * The renderer pair {@link SessionHost.exportSession} produces documents
   * with, and the name it offers them under.
   *
   * Injected for the reason {@link SessionHostOptions.commands} is: the
   * renderers are `@arcturn/cli`'s `exportMarkdown`/`exportHtml`, which is
   * what the terminal's `/export` already calls, and this package does not
   * depend on that one. One renderer, two front-ends — a transcript cannot
   * look one way in a terminal and another over a socket.
   *
   * Both halves in one object on purpose; see {@link TranscriptExporter}.
   *
   * Omitted, {@link SessionHost.exportSession} **refuses** rather than
   * inventing a document. There is no safe guess: an export assembled here
   * would be a second, worse renderer that a user would read as their
   * conversation.
   *
   * That refusal is an `invalidRequest`, which `ProtocolClient.exportSession`
   * collapses into `undefined` alongside an older server's unknown-method
   * rejection — the same collapse {@link SessionHostOptions.contextResolver}'s
   * absence already gets, and coherent for the same reason: to a client, "this
   * engine has no exporter" and "this engine predates the verb" are one piece
   * of news, and the answer to both is to offer no export. The sentence still
   * reaches whoever assembled the host, which is who can act on it.
   */
  transcriptExporter?: TranscriptExporter;
  /**
   * Bound on the payload {@link SessionHost.exportSession} returns. Defaults;
   * see `session-export.ts`. Injectable so a test can prove the cap actually
   * cuts without writing a megabyte of conversation first — the same reason
   * {@link SessionHostOptions.sessionHistoryLimits} is.
   */
  sessionExportLimits?: SessionExportLimits;
  /**
   * Source of the MCP listing {@link SessionHost.mcpStatus} answers with.
   *
   * Injected for the reason {@link SessionHostOptions.modelCatalog} is: the
   * MCP manager lives in `@arcturn/mcp` and is owned by `@arcturn/cli`'s
   * runtime, and this package depends on neither. The projection that turns a
   * manager into these four fields lives there too (`serve-mcp.ts`), because
   * that is where the config with the credentials in it is, and the safest
   * place to decide what leaves a secret behind is next to the secret.
   *
   * Whatever this returns is re-validated against the wire contract before it
   * leaves the host — the same discipline `listModels` applies, and the reason
   * it matters most here: the validator copies four fields out by name, so a
   * projection that grew careless still cannot put a `url`, an `env` or an
   * `Authorization` header on the wire.
   *
   * Omitted, the host reports an empty list rather than inventing servers it
   * has no way to know about.
   */
  mcpStatus?: () => McpServerSummary[] | Promise<McpServerSummary[]>;
  /**
   * The served runtime's `--dry-run` shadow workspace, for the review verbs.
   *
   * One injection, three verbs, and deliberately one injection — the rule
   * `createServeHost` keeps after the `resolveModel`/`modelCatalog` pair
   * drifted apart once and became a real routing bug. `pendingChanges` lists
   * what this overlay is holding, `applyChanges` calls its `apply`, and
   * `discardChanges` calls its `discard`. Splitting them would mean a client
   * could be shown a change set by one object and land a different one through
   * another.
   *
   * Injected for the reason {@link SessionHostOptions.contextResolver} is: the
   * overlay lives in `@arcturn/cli` (`createOverlay`, wired by `buildRuntime`),
   * this package cannot depend on it, and the applier a remote client reaches
   * has to be *the same object* the TUI's `/apply` drives — symlink guard,
   * temp-file-plus-rename and all. See `dry-run.ts`.
   *
   * Omitted, this host is an engine that is not running under `--dry-run`:
   * `pendingChanges` answers `dryRun: false` (which is a fact a client needs,
   * not an error), and `applyChanges`/`discardChanges` refuse with a sentence
   * saying so. That is different again from an engine that has no such verb at
   * all, which a client learns from the `invalidRequest` an older server sends.
   */
  dryRunOverlay?: DryRunOverlay;
  /**
   * Bounds on the payload {@link SessionHost.pendingChanges} returns. Both
   * halves default; see `dry-run.ts`. Injectable so a test can prove the cap
   * actually cuts without writing a megabyte of scratch files first — the same
   * reason {@link SessionHostOptions.sessionHistoryLimits} is injectable.
   */
  pendingChangesLimits?: PendingChangesLimits;
  /**
   * The engine's workflow surface, for the four `/workflow` verbs.
   *
   * One injection, four verbs, and deliberately one injection — the rule
   * `createServeHost` keeps after the `resolveModel`/`modelCatalog` pair
   * drifted apart once and became a real routing bug. `listWorkflows` shows a
   * catalog, `runWorkflow` runs something out of it, `workflowStatus` reads
   * the journal that run wrote and `resumeWorkflow` re-enters it; two of those
   * reading different roots would mean running a pipeline nobody was shown, or
   * resuming work nobody asked about.
   *
   * Injected for the reason {@link SessionHostOptions.dryRunOverlay} is: the
   * workflow engine is `@arcturn/cli`'s, this package cannot depend on it, and
   * the thing a remote caller reaches has to be *the same engine* the
   * terminal's `/workflow` drives — same parser, same lane classifier, same run
   * journal. See `workflows.ts` and `@arcturn/cli`'s `serve-workflows.ts`.
   *
   * Omitted, this host is an engine with no workflow support: the two reads
   * answer empty and the two runs **refuse**, saying so. That split is the one
   * this file draws everywhere — a read that finds nothing is honest, a run
   * that quietly did not start is the failure the verb exists to prevent.
   */
  workflows?: WorkflowService;
  /**
   * The served runtime's per-session checkpoint machinery, for the rewind
   * verbs.
   *
   * One injection, two verbs, and deliberately one injection — the rule
   * `createServeHost` keeps after the `resolveModel`/`modelCatalog` pair
   * drifted apart once and became a real routing bug. `listCheckpoints` reads
   * this provider's plans and `rewindTo` applies them, so a client can never
   * be shown a cost by one object and have a different one charged by another.
   * Here the stakes are the highest on this wire: the two halves disagreeing
   * would mean deleting files nobody was shown.
   *
   * Injected for the reason {@link SessionHostOptions.dryRunOverlay} is: the
   * checkpoint store lives in `@arcturn/cli` (`createCheckpointStore`, wired
   * per session by `buildSessionAgent`), this package cannot depend on it, and
   * the restorer a remote client reaches has to be *the same object* the TUI's
   * `/rewind` drives — workspace confinement, content-addressed blobs, atomic
   * writes and all. See `rewind.ts`.
   *
   * Omitted, this host keeps no checkpoints: `listCheckpoints` answers
   * `available: false` (a fact a client needs, not an error) and `rewindTo`
   * refuses with a sentence saying so. That is different again from an engine
   * that has no such verb at all, which a client learns from the
   * `invalidRequest` an older server sends.
   */
  checkpoints?: SessionCheckpoints;
  /**
   * Bounds on the payload {@link SessionHost.listCheckpoints} returns. All
   * default; see `rewind.ts`. Injectable so a test can prove the cap actually
   * cuts without recording two hundred turns first — the same reason
   * {@link SessionHostOptions.sessionHistoryLimits} is injectable.
   */
  checkpointListLimits?: CheckpointListLimits;
  /**
   * The engine's background-agent manager, for the `/bg` verbs.
   *
   * One injection, four verbs, and deliberately one injection — the rule
   * `createServeHost` keeps after the `resolveModel`/`modelCatalog` pair
   * drifted apart once and became a real routing bug.
   * {@link SessionHost.backgroundAgents} lists and renders,
   * {@link SessionHost.startBackgroundAgent} starts,
   * {@link SessionHost.cancelBackgroundAgent} stops and
   * {@link SessionHost.adoptBackgroundAgent} delivers a result. Splitting them
   * would mean a client could be shown a listing by one registry and cancel an
   * agent in another.
   *
   * Injected for the reason {@link SessionHostOptions.dryRunOverlay} is: the
   * manager lives in `@arcturn/cli`, this package cannot depend on it, and the
   * registry a remote client reaches has to be *the same object* the terminal's
   * `/bg` drives — same records directory, same concurrency cap, same default
   * tool set. See `background-agents.ts`.
   *
   * Note what the interface does **not** carry: {@link
   * BackgroundAgentRegistry.start} takes a task and nothing else, where the
   * manager's own `start` takes tools, a permission mode, a cwd and a model.
   * That narrowing is the containment for the one verb here that spends money,
   * and it is enforced by the type rather than remembered by a caller.
   *
   * Omitted, the four verbs refuse with a sentence saying this engine has no
   * background-agent manager — which is different again from an engine that has
   * no such verb at all, which a client learns from the `invalidRequest` an
   * older server sends.
   */
  backgroundAgents?: BackgroundAgentRegistry;
  /**
   * Byte budget for the transcript {@link SessionHost.backgroundAgents}
   * returns for one agent. Defaults to
   * {@link BACKGROUND_TRANSCRIPT_MAX_BYTES}. Injectable so a test can prove the
   * cap actually cuts without writing a megabyte of conversation first — the
   * same reason {@link SessionHostOptions.sessionHistoryLimits} is injectable.
   */
  backgroundTranscriptMaxBytes?: number;
  /**
   * The engine's org-memory store, for the `/org memory` verbs.
   *
   * One injection, three verbs, same rule as above:
   * {@link SessionHost.orgMemory} reads,
   * {@link SessionHost.proposeOrgMemory} files an inert entry, and
   * {@link SessionHost.revokeOrgMemory} takes one back.
   *
   * There is deliberately **no fourth verb that approves one**, and the
   * interface is shaped so that there could not be: `propose` has no status
   * parameter. An `active` entry is standing instruction text in every later
   * run of its role, and the gate on it is a person at the machine. See
   * `org-memory.ts` for the argument.
   *
   * Injected for the reason the overlay is: the store's path, its bounds, its
   * sanitizer and its writer all live in `@arcturn/cli`, and the store a remote
   * client reaches has to be the same file `/org memory` reads.
   *
   * Omitted, the three verbs refuse rather than reporting an empty store — an
   * empty store and an engine that cannot find one are different answers, and
   * only one of them means "nothing has been proposed yet".
   */
  orgMemory?: OrgMemoryStoreAccess;
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

/**
 * The one refusal for every way a wire decision can ask for a rule that
 * outlives its session.
 *
 * Says where such a rule *does* live, because the reader is a client author
 * who believed this was allowed and "invalid scope" would not tell them what
 * to do instead.
 *
 * @param field - Offending field, for the message.
 * @param scope - The scope that was asked for.
 */
function widerScopeRefusal(field: string, scope: PermissionScope): string {
  return (
    `A permission decision made over the wire may not outlive the session: ${field} was ` +
    `"${scope}", and that scope is written to a permission config file a person owns. Use ` +
    '"session", or have the user add the rule to their own config.'
  );
}

/**
 * Whether a session may not take a new prompt (or be deleted) right now.
 *
 * Two conditions, not one: the agent is mid-run, **or** a prompt has been
 * accepted and is still resolving its context. See {@link LiveSession.starting}.
 */
function isBusy(session: LiveSession): boolean {
  return session.agent.isRunning || session.starting;
}

/**
 * Turn a `dry-run.ts` refusal into the wire's `invalidRequest`.
 *
 * That module returns a union rather than throwing so it can be tested by
 * reading a value; this is the one place the union becomes an error, which is
 * also the only place the error code for these three verbs is decided.
 */
function unwrapDryRun<T>(result: DryRunResult<T>): T {
  if (!result.ok) throw new SessionHostError("invalidRequest", result.error);
  return result.value;
}

/**
 * The one refusal for an id no background agent answers to.
 *
 * Written once and shared by every verb that takes an id, so a client that
 * mistypes one gets the same sentence — and the same next step — whichever verb
 * it sent. Names the listing verb rather than the terminal's `/bg`, because the
 * reader is a wire client.
 */
function unknownBackgroundAgent(id: string): string {
  return (
    `No background agent "${id}". Ask backgroundAgents (with no id) for the ones this engine ` +
    "knows about."
  );
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** See {@link SessionHostOptions.maxSessions}. */
export const DEFAULT_MAX_SESSIONS = 16;

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * The ask this is waiting on, kept so a `"session"`-scoped allow can be
   * built from the engine's OWN {@link PermissionRequest.suggestedRule}.
   *
   * This is what makes "allow for this session" un-forgeable: a client says
   * *how long*, never *what*, so the widest rule a remote decision can produce
   * is the one the engine already offered for the tool call it already made.
   */
  request: PermissionRequest;
}

interface LiveSession {
  header: SessionHeader;
  agent: Agent;
  observers: Set<AgentEventListener>;
  /** Awaiting client decisions, keyed by the request id the client is shown. */
  pendingPermissions: Map<string, PendingPermission>;
  /**
   * Whether a prompt has been *accepted* for this session, from the moment it
   * is taken until its run settles.
   *
   * `Agent.isRunning` alone is not enough any more, and the gap is one this
   * host opened: expanding mentions and reading attachments is filesystem I/O,
   * so `prompt()` now awaits before it reaches `agent.prompt()` — and in that
   * window the agent is still idle. Without this flag a second `prompt`
   * arriving in the window would sail past the busy check and fail deep inside
   * `Agent` with a raw error, and a `deleteSession` arriving in it would delete
   * a session that is about to start writing to its own file.
   */
  starting: boolean;
  /**
   * Tail of this session's steer chain, so steers queue in the order they were
   * sent rather than the order their filesystem reads happened to finish.
   *
   * The same hazard {@link LiveSession.starting} guards for `prompt`, arriving
   * from the same cause: `steer` expands mentions and `/name` now, which is I/O,
   * and `ws-server.ts` dispatches a connection's frames concurrently. Two
   * steers sent back to back — one naming a file, one plain — would otherwise
   * reach `Agent.steer` backwards, and a queue that reorders is not a queue.
   * `prompt` cannot use this: it *rejects* a second caller as `sessionBusy`
   * rather than making it wait, which is the right answer for a turn and the
   * wrong one for a steer.
   */
  steerTail: Promise<void>;
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
  readonly #contextResolver: ContextResolver | undefined;
  readonly #commands: (() => CommandDescriptor[] | Promise<CommandDescriptor[]>) | undefined;
  readonly #transcriptExporter: TranscriptExporter | undefined;
  readonly #sessionExportLimits: SessionExportLimits;
  readonly #mcpStatus: (() => McpServerSummary[] | Promise<McpServerSummary[]>) | undefined;
  readonly #maxSessions: number;
  readonly #dryRun: DryRunReview;
  readonly #backgroundAgents: BackgroundAgentRegistry | undefined;
  readonly #backgroundTranscriptMaxBytes: number;
  readonly #orgMemory: OrgMemoryStoreAccess | undefined;
  readonly #checkpoints: SessionCheckpoints | undefined;
  readonly #checkpointListLimits: CheckpointListLimits;
  readonly #workflows: WorkflowService | undefined;
  /**
   * Workflow runs in flight, by the session whose stream carries them.
   *
   * Kept on the host rather than on {@link LiveSession} on purpose: a run
   * outlives nothing else about a session but it *is* scoped to one, and this
   * map is the only place two questions are answered — "may this session start
   * another pipeline right now" and "what does `abort` on this session have to
   * cancel besides the agent's turn".
   *
   * A run removes its own controller when it settles, so an idle session holds
   * an empty set at most and the map is swept on eviction.
   */
  readonly #workflowRuns = new Map<string, Set<AbortController>>();
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
    this.#contextResolver = options.contextResolver;
    this.#commands = options.commands;
    this.#transcriptExporter = options.transcriptExporter;
    this.#sessionExportLimits = options.sessionExportLimits ?? {};
    this.#mcpStatus = options.mcpStatus;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#dryRun = createDryRunReview(options.dryRunOverlay, options.pendingChangesLimits ?? {});
    this.#backgroundAgents = options.backgroundAgents;
    this.#backgroundTranscriptMaxBytes =
      options.backgroundTranscriptMaxBytes ?? BACKGROUND_TRANSCRIPT_MAX_BYTES;
    this.#orgMemory = options.orgMemory;
    this.#checkpoints = options.checkpoints;
    this.#checkpointListLimits = options.checkpointListLimits ?? {};
    this.#workflows = options.workflows;
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

    // A live session's history is the branch its agent is actually holding.
    // That only differs from "the newest entry in the file" in one situation,
    // and it is the one `rewindTo` creates: a fork resumes at an older entry
    // and appends nothing, so until the next turn the newest entry is the tip
    // of the branch the fork walked away from. Replaying that would hand a
    // client the pre-rewind conversation and call it the transcript.
    const live = this.#sessions.get(sessionId);
    const history = buildSessionHistory(
      sessionId,
      entries,
      this.#sessionHistoryLimits,
      live === undefined ? undefined : live.agent.leafEntryId,
    );
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
    if (live !== undefined && isBusy(live)) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} is running a turn; abort it before deleting it`,
      );
    }
    // A workflow is not a turn — `isBusy` cannot see one — but it is work in
    // flight, and one of its steps may be applying a patch to the user's
    // checkout at this moment. Deleting the session out from under it would
    // silence the only stream reporting that.
    if ((this.#workflowRuns.get(sessionId)?.size ?? 0) > 0) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} is running a workflow; abort it before deleting the session`,
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
   * ### What happens before the agent sees anything
   *
   * `text` is not passed through. It goes to the injected
   * {@link SessionHostOptions.contextResolver} first, which expands `@`-mentions
   * against **this session's** `cwd` under the same workspace confinement the
   * TUI applies, and reads whatever `attachments` name. That is RFC 0005 §1.1,
   * and it is the fix for the bug that shipped: `expandMentions` ran in
   * `print.ts` and the TUI, so a prompt arriving over the wire reached the
   * model as six words about a file rather than the file.
   *
   * Every refusal is settled here, **before** a turn is spent — because after
   * `agent.prompt` there is no refusing anything, only apologising for it:
   *
   * - An **attachment** that fails confinement, is missing, or blows the byte
   *   budget refuses the whole request (`invalidRequest`).
   * - An **image attachment** sent to a model with no vision refuses the whole
   *   request, quoting the model. Checked server-side rather than trusted to
   *   the client, because the client cannot be trusted to check: a hostile one
   *   holding the serve token would not, and an honest older one does not know
   *   it should.
   * - A **mention** that fails confinement, or an image mention on a text-only
   *   model, degrades exactly as the TUI degrades it — the token stays in the
   *   text, the file is not read — with a `notice` event naming what happened,
   *   so a remote user is told rather than left wondering.
   *
   * @param sessionId - Session to run in.
   * @param text - The prompt as typed, mentions unexpanded.
   * @param attachments - Optional context the client named explicitly.
   * @throws {SessionHostError} with code `sessionBusy` when a run is already
   *   active, `sessionNotFound` when the session is not live, or
   *   `invalidRequest` for any attachment this host will not honour.
   */
  async prompt(
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[] = [],
  ): Promise<void> {
    const session = this.#require(sessionId);
    if (isBusy(session)) {
      throw new SessionHostError("sessionBusy", `Session ${sessionId} is already running a turn`);
    }
    // Claimed *synchronously*, before the first `await`. Everything after this
    // point runs on a later microtask, and the whole reason this flag exists is
    // that another wire request can arrive in between. See `LiveSession.starting`.
    session.starting = true;
    try {
      const content = await this.#buildPromptContent(session, text, attachments);
      await session.agent.prompt(content);
    } finally {
      session.starting = false;
    }
  }

  /**
   * What one mention would resolve to, without resolving it into anything.
   *
   * Read-only by construction: a query that lands outside the workspace is
   * answered from string arithmetic over what the caller itself supplied, with
   * no filesystem call at all, so this verb cannot be turned into an oracle for
   * paths the engine would refuse to read.
   *
   * Requires a **live** session rather than merely a known one — unlike
   * {@link SessionHost.sessionHistory}, which deliberately does not. The
   * difference is what each verb is for: history renders a conversation that
   * already happened, while this previews what a `prompt` *to this session*
   * would do, and a session that cannot be prompted has nothing to preview.
   *
   * @param sessionId - Session whose `cwd` the query resolves against.
   * @param query - The mention text, as typed, without its `@`.
   * @throws {SessionHostError} `sessionNotFound` when the session is not live,
   *   or `invalidRequest` when no {@link SessionHostOptions.contextResolver}
   *   was wired — this host has no idea what a mention means, and an answer
   *   invented here would be one a client renders as fact.
   */
  async resolveContext(sessionId: string, query: string): Promise<ContextResolution> {
    const session = this.#require(sessionId);
    const resolver = this.#contextResolver;
    if (!resolver) {
      throw new SessionHostError(
        "invalidRequest",
        "This server was built without a context resolver, so it cannot say what a mention " +
          "would resolve to. Refusing rather than answering with a guess.",
      );
    }
    const resolution = await resolver.resolve({ cwd: session.header.cwd, query });
    // Normalized against the wire contract on the way out — the same discipline
    // `listModels` and `sessionHistory` apply, for the same reason: the resolver
    // is injected, so whatever it hands over, only what the contract defines can
    // reach a client. It also catches the two cross-field lies a resolver could
    // tell (an out-of-workspace path reported as existing, a size for something
    // that does not) here rather than in a client that renders them as fact.
    const validation = validateContextResolution(resolution);
    if (!validation.ok) {
      throw new Error(`Context resolution is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * Expand one prompt and settle every refusal, before the agent is touched.
   *
   * @returns The content to hand `Agent.prompt` — a plain string when there is
   *   nothing but text, so a session with no attachments produces byte-identical
   *   history to one from before this existed.
   */
  async #buildPromptContent(
    session: LiveSession,
    text: string,
    attachments: readonly PromptAttachment[],
  ): Promise<string | UserContent[]> {
    const resolver = this.#contextResolver;
    if (!resolver) {
      if (attachments.length > 0) {
        throw new SessionHostError(
          "invalidRequest",
          "This server was built without a context resolver, so it cannot read attachments. " +
            "Refusing rather than running the turn without them.",
        );
      }
      return text;
    }

    let resolved: ResolvedPrompt;
    try {
      resolved = await resolver.buildPrompt({ cwd: session.header.cwd, text, attachments });
    } catch (error) {
      if (error instanceof ContextRefusedError) {
        throw new SessionHostError("invalidRequest", error.message);
      }
      throw error;
    }

    const model = session.agent.model;
    const notices = resolved.refusals.map((refusal) => `${refusal.what}: ${refusal.reason}`);
    let images = resolved.images;

    if (images.length > 0 && !model.capabilities.vision) {
      // Attachments first, and fatally: the client named these, so running the
      // turn without them is the silent drop RFC 0005 §1.1 forbids. The throw
      // happens before any notice is emitted, so a refused prompt leaves no
      // trace of a turn that never started.
      const attached = images.filter((image) => image.source === "attachment");
      if (attached.length > 0) {
        throw new SessionHostError(
          "invalidRequest",
          visionRefusalMessage(
            model,
            attached.map((image) => image.label),
          ),
        );
      }
      // Mentions second, and not fatally: this is what the TUI does with an
      // `@screenshot.png` on a text-only model — say so, and carry on with the
      // mention still sitting in the text the model reads.
      notices.push(
        visionRefusalMessage(
          model,
          images.map((image) => image.label),
        ),
      );
      images = [];
    }

    for (const line of notices) {
      this.#fanOut(session, { type: "notice", level: "warn", text: line });
    }

    if (images.length === 0) return resolved.text;
    return [
      { type: "text", text: resolved.text },
      ...images.map((image) => image.content),
    ] satisfies UserContent[];
  }

  /**
   * Queue a mid-run steering message (or, if idle, the next prompt).
   *
   * Goes through {@link SessionHostOptions.contextResolver} exactly as
   * {@link SessionHost.prompt} does, and for the same reason: a steer is text a
   * person typed into the same box, and the engine cannot have `@auth.ts` mean
   * the file when the session is idle and six words about a file when it is
   * running. RFC 0005 §1.3 makes that concrete for commands — the terminal's
   * `skillCommand` steers the *expanded* skill body when a run is in flight, so
   * a serve path that steered the literal `/review` would be the lying menu §3
   * forbids, merely lying at a different moment.
   *
   * Asynchronous for that reason, where it used to be a synchronous hand-off.
   * The wire has always awaited it (`steer` is a request/response verb like any
   * other), so nothing about the protocol changes.
   *
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is not live, or `invalidRequest` when the text names a command this host
   *   cannot expand — refused rather than queued, because a steer that queued
   *   `/reviw` would spend the rest of the run on text nobody meant to send.
   */
  async steer(sessionId: string, text: string): Promise<void> {
    const session = this.#require(sessionId);
    const queued = session.steerTail.then(async () => {
      session.agent.steer(await this.#buildPromptContent(session, text, []));
    });
    // The tail swallows failures so one refused steer does not poison every
    // later one; the caller still gets the rejection, from `queued` itself.
    session.steerTail = queued.catch(() => undefined);
    return queued;
  }

  /**
   * Abort the session's current run **and any workflow running on it**. A
   * no-op when both are idle.
   *
   * The workflow half is not an extra: a client's Stop button is one control,
   * and a pipeline that kept spending after it was pressed — because the button
   * only ever reached the session's own agent — would be the worst kind of
   * unresponsive. The signal is the same `AbortSignal` `runWorkflow` was
   * started with, so in-flight steps are marked `cancelled` and nothing not yet
   * started begins, exactly as `Ctrl+C` does in the terminal.
   *
   * @throws {SessionHostError} with code `sessionNotFound` when the session
   *   is not live.
   */
  abort(sessionId: string): void {
    const session = this.#require(sessionId);
    for (const controller of this.#workflowRuns.get(sessionId) ?? []) controller.abort();
    session.agent.abort();
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
   * The permission regime one session runs under: its mode, its rules, and
   * the names of the tools it holds.
   *
   * Session-scoped, unlike {@link SessionHost.listModels}: a mode and a rule
   * set belong to one agent. Normalized against the wire contract on the way
   * out — the same discipline `listModels` and `sessionHistory` apply, and for
   * a sharper reason here: `tools` must carry names and only names, and a
   * validator that copies fields one at a time is what keeps a tool
   * description (untrusted text, from an extension or an MCP server) from ever
   * riding along into a client's UI.
   *
   * @param sessionId - Session to inspect.
   * @throws {SessionHostError} `sessionNotFound` when the session is not live.
   */
  permissionState(sessionId: string): PermissionState {
    return this.#permissionState(this.#require(sessionId), sessionId);
  }

  /**
   * Ask a session to run under a different permission mode.
   *
   * **A mode is a request, not a grant.** All this does is call
   * `Agent.setPermissionMode`, which is the same call the TUI's `/permissions`
   * picker makes — so a remote client lands in exactly the engine a local user
   * would, with the engine's own resolution order intact: a stored `deny` rule
   * is step 3 and every mode is step 5, which is why `yolo` set from here
   * still cannot run a tool a rule denies.
   *
   * **It never edits rules.** There is no wire path that writes one; see
   * {@link SessionHost.handlePermissionDecision}.
   *
   * **Refused mid-run.** A mode that changed halfway through a turn would
   * split that turn across two policies: a tool call already blocked on a
   * client's answer would settle under the old rules while the next call in
   * the same turn settled under the new, and nothing in the transcript would
   * say which was which. Refusing with `sessionBusy` is what makes RFC 0005
   * §2's "takes effect on the next turn" literally true, and it hands the
   * client something to do (abort, or wait for `runEnd`) rather than a change
   * deferred to a moment it cannot observe. It is the same refusal
   * {@link SessionHost.deleteSession} makes, for the same reason: some
   * operations have no correct meaning while a turn is in flight.
   *
   * @param sessionId - Session to change.
   * @param mode - Mode to run under from the next turn.
   * @returns The resulting state — what the engine says it is, not an echo.
   * @throws {SessionHostError} `sessionNotFound` when the session is not live,
   *   or `sessionBusy` while a run is in flight.
   */
  setPermissionMode(sessionId: string, mode: PermissionMode): PermissionState {
    const session = this.#require(sessionId);
    if (session.agent.isRunning) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} is running a turn; a permission mode may not change halfway ` +
          "through one. Abort the run or wait for it to end, then set the mode.",
      );
    }
    session.agent.setPermissionMode(mode);
    return this.#permissionState(session, sessionId);
  }

  /**
   * Everything a `/` could invoke on this server.
   *
   * Sourced from {@link SessionHostOptions.commands} and normalized against
   * the wire contract on the way out, for the reason
   * {@link SessionHost.listModels} is: whatever the host process hands over,
   * only what the contract defines can reach a client.
   *
   * Not session-scoped — skills are discovered from the served workspace and
   * the user's home, both properties of the server.
   *
   * @returns The commands, or `[]` when no source was wired. An empty list is
   *   the honest answer for a host with no command library; it is not the same
   *   answer as an engine that has no such verb, which a client learns from
   *   the `invalidRequest` refusal instead.
   * @throws When the wired source returns entries that are not a valid wire
   *   payload — a wiring bug in the host process, worth reporting rather than
   *   quietly serving a menu a user would read as complete.
   */
  async listCommands(): Promise<CommandDescriptor[]> {
    if (!this.#commands) return [];
    const commands = await this.#commands();
    const validation = validateCommandList({ commands });
    if (!validation.ok) {
      throw new Error(`Command list is not a valid wire payload: ${validation.error}`);
    }
    return validation.value.commands;
  }

  /**
   * Summarise the head of one session's conversation — the terminal's
   * `/compact`, over the wire.
   *
   * **There is one compactor and this is not it.** All this does is call
   * `Agent.compact()`, the same method `@arcturn/cli`'s `/compact` command
   * calls and the same one the run loop calls when it crosses the automatic
   * threshold. A second implementation here would summarise with different
   * options, cut at a different turn boundary and write a different
   * `compaction` entry into the same session file.
   *
   * **Refused mid-run**, with `sessionBusy`, and via {@link isBusy} rather
   * than `agent.isRunning` alone: a prompt that has been accepted but is still
   * resolving its context has not started the agent yet, and a compaction
   * landing in that window would rewrite the message array the run is about to
   * iterate. `setPermissionMode` checks the narrower condition because a mode
   * only takes effect at the next turn; this rewrites history, so it takes the
   * same wider check `deleteSession` takes.
   *
   * The alternative — queueing — was rejected. `Agent.compact()` itself throws
   * while running, so queueing would only move that hazard behind a promise;
   * it would race the loop's own automatic compaction, which can fire in the
   * same window with different bounds; and it would settle at a moment the
   * client cannot observe, so the numbers returned would describe a
   * conversation that had since moved on. `sessionBusy` hands the client
   * something to do instead: abort, or wait for `runEnd`.
   *
   * ### The numbers are the engine's own, quoted rather than re-derived
   *
   * A compaction already publishes `compactionEnd { tokensBefore, tokensAfter }`
   * on the event stream, and every attached client already sees it. This verb
   * therefore **quotes that event** rather than measuring anything itself: two
   * sources for one pair of numbers is exactly the drift
   * `built-in-commands.ts` refuses for `/cost`, and it would be worse here,
   * because the two would be read side by side — the notification and the
   * response to the request that caused it.
   *
   * Nor could this measure it honestly on its own. `Agent.estimatedTokens`
   * anchors on the last assistant message's *reported* usage, which is what
   * the provider charged for the pre-compaction prompt; that anchor survives
   * the rewrite, so reading it before and after mostly returns the same number
   * for a compaction that genuinely halved the conversation. The engine knows
   * this, which is why `compactMessages` pairs the metered "before" with an
   * estimated "after" — nobody has metered the new prompt yet. Those are the
   * two numbers on the event, and they are the two numbers here.
   *
   * When no compaction was attempted at all (no turn boundary old enough),
   * there is no event to quote and nothing changed, so both sides report
   * `Agent.estimatedTokens` — equal, which is the truth.
   *
   * ### Why the reason is captured from the event stream too
   *
   * `Agent.compact()` answers `false` for two quite different outcomes — no
   * turn boundary old enough to fold, and a summarizer that failed — and says
   * which one only by emitting a `notice`. Rather than re-deriving the
   * distinction here (which would mean a second copy of the cut-point rule),
   * this listens for that notice for the duration of the call and quotes it.
   * The window is narrow by construction — the session is idle, because this
   * method refused to proceed if it were not — and the capture is scoped to
   * the `compacted === false` branch, so the worst a notice from a *concurrent*
   * connection could do is supply the wrong sentence for an outcome that is
   * already reported as "nothing was folded".
   *
   * @param sessionId - Session to compact.
   * @returns The token estimate on both sides, and whether anything moved.
   * @throws {SessionHostError} `sessionNotFound` when the session is not live,
   *   or `sessionBusy` while a run is in flight.
   */
  async compact(sessionId: string): Promise<CompactionSummary> {
    const session = this.#require(sessionId);
    if (isBusy(session)) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} is running a turn; a conversation may not be rewritten halfway ` +
          "through one. Abort the run or wait for it to end, then compact.",
      );
    }

    let notice: string | undefined;
    let measured: { tokensBefore: number; tokensAfter: number } | undefined;
    const listener: AgentEventListener = (event) => {
      if (event.type === "notice") notice = event.text;
      if (event.type === "compactionEnd") {
        measured = { tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter };
      }
    };
    session.observers.add(listener);
    let compacted: boolean;
    try {
      compacted = await session.agent.compact();
    } finally {
      session.observers.delete(listener);
    }

    const unchanged = session.agent.estimatedTokens;
    const tokens = measured ?? { tokensBefore: unchanged, tokensAfter: unchanged };
    const summary: CompactionSummary = {
      sessionId,
      compacted,
      tokensBefore: tokens.tokensBefore,
      tokensAfter: tokens.tokensAfter,
      ...(compacted || notice === undefined ? {} : { reason: notice }),
    };
    // Normalized against the wire contract on the way out, like every other
    // result this host builds.
    const validation = validateCompactionSummary(summary);
    if (!validation.ok) {
      throw new Error(`Compaction summary is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * Render one session's conversation as a document for the **client** to
   * save.
   *
   * The engine writes nothing. See `session-export.ts` for why that is the
   * whole design rather than an implementation detail, and for where the byte
   * budget comes from.
   *
   * Requires a **live** session, like {@link SessionHost.resolveContext} and
   * unlike {@link SessionHost.sessionHistory}: this renders the conversation
   * the agent is holding in memory, and a session nobody has opened is holding
   * none. A client that wants a transcript of a session it has not attached to
   * opens it first, or asks `sessionHistory` and renders its own.
   *
   * Deliberately **not** refused mid-run. It only reads, and it reads exactly
   * what the terminal's `/export` reads — which does not check either. An
   * export taken mid-turn is a snapshot of a conversation still in progress,
   * which is a true thing to have; refusing it would be a restriction the
   * local user does not have.
   *
   * @param sessionId - Session to render.
   * @param options - Format (default markdown) and thinking (default off) —
   *   the terminal's `/export` defaults.
   * @throws {SessionHostError} `sessionNotFound` when the session is not live,
   *   or `invalidRequest` when no {@link SessionHostOptions.transcriptExporter}
   *   was wired — this host has no renderer, and a document assembled here
   *   would be a second, worse one a user would read as their conversation.
   */
  exportSession(
    sessionId: string,
    options: { format?: TranscriptFormat; includeThinking?: boolean } = {},
  ): SessionExport {
    const session = this.#require(sessionId);
    const exporter = this.#transcriptExporter;
    if (!exporter) {
      throw new SessionHostError(
        "invalidRequest",
        "This server was built without a transcript exporter, so it cannot render this " +
          "conversation. Refusing rather than assembling a second, worse one. Ask " +
          "sessionHistory for the events and render your own.",
      );
    }
    const result = buildSessionExport(
      sessionId,
      session.agent.messages,
      exporter,
      {
        format: options.format ?? "markdown",
        includeThinking: options.includeThinking ?? false,
        model: session.agent.model.displayName,
        // Read once, here, and threaded through every re-render the byte
        // budget forces — see `TranscriptRenderRequest.exportedAt`.
        exportedAt: new Date().toISOString(),
      },
      this.#sessionExportLimits,
    );
    const validation = validateSessionExport(result);
    if (!validation.ok) {
      throw new Error(`Session export is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * The MCP servers this engine is configured with: name, transport, state,
   * tool count.
   *
   * Not session-scoped — MCP servers belong to the server process, so this is
   * shaped like {@link SessionHost.listModels}.
   *
   * Sourced from {@link SessionHostOptions.mcpStatus} and normalized against
   * the wire contract on the way out. That last step is load-bearing here in a
   * way it is not for the catalog: `validateMcpStatus` copies four fields out
   * by name, so a `url`, a `command`, an `env` map or an `Authorization`
   * header cannot reach a client even if the injected projection grew
   * careless. It is the same mechanism `PermissionState.tools` relies on to
   * carry names and only names.
   *
   * @returns The listing, sorted by name, or `[]` when no source was wired.
   * @throws When the wired source returns entries that are not a valid wire
   *   payload — a wiring bug in the host process, and one worth reporting
   *   rather than quietly serving a listing a user would read as complete.
   */
  async mcpStatus(): Promise<McpServerSummary[]> {
    if (!this.#mcpStatus) return [];
    const servers = await this.#mcpStatus();
    const validation = validateMcpStatus({ servers });
    if (!validation.ok) {
      throw new Error(`MCP status is not a valid wire payload: ${validation.error}`);
    }
    return validation.value.servers;
  }

  /**
   * What a `--dry-run` session is holding back for review.
   *
   * A **read**, and answered even for an engine that is not in dry-run mode at
   * all — with `dryRun: false` and an empty list. That distinction is the
   * reason this verb does not simply refuse: "nothing is pending" and "nothing
   * is ever held back here, your edits already landed" are opposite pieces of
   * news, and a client shown an empty list with no flag would render the
   * reassuring one.
   *
   * Not refused mid-run either. `/diff` in the terminal has no busy check, a
   * change set that grows while you watch it is useful rather than dangerous,
   * and nothing here writes.
   *
   * @param sessionId - Session to ask about.
   * @param path - One row's path, to fetch the content an apply would write.
   *   Omit for the metadata-only list; see `dry-run.ts` for the payload budget
   *   this split exists to respect.
   * @throws {SessionHostError} `sessionNotFound` when the session is not live,
   *   or `invalidRequest` when `path` names nothing pending.
   */
  async pendingChanges(sessionId: string, path?: string): Promise<PendingChanges> {
    this.#require(sessionId);
    return unwrapDryRun(await this.#dryRun.pendingChanges(sessionId, path));
  }

  /**
   * Write pending dry-run changes back over the real workspace files.
   *
   * This is the verb that touches somebody's working directory, and it holds
   * three lines that the rest of this class draws elsewhere:
   *
   * **The applier is the engine's, not a client's.** All this does is call the
   * overlay the served runtime built — the same object the TUI's `/apply`
   * drives — so the per-file symlink resolution that refuses a destination
   * outside the workspace, and the temp-file-plus-rename that keeps an
   * interrupted apply from leaving half a file, are the same code a local user
   * gets. There is no second applier on this path and there must not be one.
   *
   * **A selection can only narrow the engine's own list.** `paths` is matched
   * against what `pendingChanges` just reported, and the overlay is then handed
   * the absolute paths *this host* produced. A client string never becomes a
   * destination, so a `..`, an absolute path or a drive letter arriving on the
   * wire selects nothing rather than escaping something.
   *
   * **Refused while any session on this engine is running.** Not just the one
   * named: `--dry-run` is a flag on the served process, so one overlay and one
   * shadow tree are shared by every session this host holds, and applying while
   * *any* of them is still writing into that tree is the same race with the
   * user's files on one side. It is the refusal {@link SessionHost.deleteSession}
   * and {@link SessionHost.setPermissionMode} make, widened to match what is
   * actually shared.
   *
   * @param sessionId - Session asking. Used for the refusals and echoed back.
   * @param paths - A subset, spelled as `PendingChange.path` reported it. Omit
   *   to land everything.
   * @returns What landed, what did not and why, and what is still pending.
   * @throws {SessionHostError} `sessionNotFound`, `sessionBusy` while any live
   *   session is running a turn, or `invalidRequest` when this engine is not in
   *   dry-run mode or a named path is not pending.
   */
  async applyChanges(sessionId: string, paths?: readonly string[]): Promise<ApplyChangesResult> {
    this.#require(sessionId);
    this.#requireIdleWorkspace(sessionId, "applied");
    return unwrapDryRun(await this.#dryRun.applyChanges(sessionId, paths));
  }

  /**
   * Throw pending dry-run changes away. **Irreversible** — the shadow tree is
   * the only record of that work.
   *
   * No wire-level confirmation, and that is {@link SessionHost.deleteSession}'s
   * discipline rather than an omission: the confirmation belongs where a person
   * can read what they are about to lose, which is a native modal in the
   * client. What the engine owns is the refusal a client cannot make for
   * itself — the same busy check `applyChanges` makes, across every live
   * session, for the same reason.
   *
   * @param sessionId - Session asking.
   * @param paths - A subset, on `applyChanges`' terms. Omit to discard all.
   * @throws {SessionHostError} On exactly `applyChanges`' terms.
   */
  async discardChanges(
    sessionId: string,
    paths?: readonly string[],
  ): Promise<DiscardChangesResult> {
    this.#require(sessionId);
    this.#requireIdleWorkspace(sessionId, "discarded");
    return unwrapDryRun(await this.#dryRun.discardChanges(sessionId, paths));
  }

  /**
   * The `/bg` listing, or one agent with its transcript.
   *
   * Not session-scoped: background agents belong to the engine. A client may
   * ask for this before it has opened any session at all.
   *
   * Normalized against the wire contract on the way out — the discipline
   * `listModels` applies, and it matters here for the reason it matters for
   * `mcpStatus`: the registry is injected, so whatever the adapter hands over,
   * only what the contract defines can reach a client. A field the manager's
   * record grows tomorrow cannot ride along.
   *
   * An `id` that names no agent answers with an **empty list**. See the code
   * for why that is a contract requirement and not a shrug.
   *
   * @param id - Narrow to one agent and include its rendered transcript.
   * @throws {SessionHostError} `invalidRequest` when no registry was wired —
   *   which a client reads as "no background-agent surface here", the same
   *   single piece of news an older engine's unknown-method refusal is.
   */
  async backgroundAgents(id?: string): Promise<BackgroundAgentList> {
    const registry = this.#requireBackgroundAgents();
    let payload: BackgroundAgentList;
    if (id === undefined) {
      payload = projectBackgroundAgents(registry.list());
    } else {
      const record = registry.get(id);
      // An id nothing matches answers with an **empty list**, not an error, and
      // that is a contract requirement rather than a convenience. This verb
      // degrades: `ProtocolClient.backgroundAgents` turns a server-sent
      // `invalidRequest` into `undefined` because that is the only thing an
      // older engine's unknown-method refusal can look like, and it cannot tell
      // the two apart. An `invalidRequest` here would therefore reach a client
      // as "this engine is too old" and hide the whole surface, over a typo.
      // `pendingChanges` keeps the same discipline for the same reason, which
      // is why it answers `dryRun: false` rather than erroring on a read.
      if (!record) return { agents: [], truncated: false, droppedAgents: 0 };
      const lines = (await registry.transcript(id)) ?? [];
      const transcripts = new Map<string, BackgroundAgentTranscript>([
        [record.id, capTranscript(lines, this.#backgroundTranscriptMaxBytes)],
      ]);
      payload = projectBackgroundAgents([record], transcripts);
    }
    const validation = validateBackgroundAgentList(payload);
    if (!validation.ok) {
      throw new Error(`Background agent listing is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * Start one background agent on `task`.
   *
   * **The whole of the containment is that this method takes one string.**
   * Tools, permission mode, working directory and model are the engine's own
   * defaults — the same ones a `/bg` typed at a terminal gets — and there is no
   * parameter here, on the wire, or in {@link BackgroundAgentRegistry} to widen
   * any of them. See `background-agents.ts`.
   *
   * Not refused mid-run, unlike `compact` or `applyChanges`: a background agent
   * is by definition off-thread work, and refusing to start one while the
   * foreground session happens to be mid-turn would refuse it at exactly the
   * moment somebody wanted to delegate.
   *
   * @throws {SessionHostError} `invalidRequest` when no registry was wired, or
   *   when the registry rejects the task (an empty one).
   */
  startBackgroundAgent(task: string): StartedBackgroundAgent {
    const registry = this.#requireBackgroundAgents();
    let started: { id: string; sessionId: string };
    try {
      started = registry.start(task);
    } catch (error) {
      throw new SessionHostError(
        "invalidRequest",
        error instanceof Error ? error.message : String(error),
      );
    }
    return { id: started.id, sessionId: started.sessionId };
  }

  /**
   * Abort one background agent.
   *
   * Answers with `accepted` **and** the agent's row, because the two say
   * different things: aborting a running child cascades through its run loop
   * and the status transition lands afterwards, so the row a cancel answers
   * with usually still reads `running`. A client that reported only the row
   * would tell a person nothing happened.
   *
   * @throws {SessionHostError} `invalidRequest` when no registry was wired, or
   *   when `id` names no agent.
   */
  cancelBackgroundAgent(id: string): CancelBackgroundAgentResult {
    const registry = this.#requireBackgroundAgents();
    // Looked up first so an unknown id refuses rather than answering
    // `accepted: false`, which is the answer for an agent that exists and has
    // already settled. Those are different facts and a client acts on them
    // differently.
    if (!registry.get(id)) throw new SessionHostError("invalidRequest", unknownBackgroundAgent(id));
    const accepted = registry.cancel(id);
    const after = registry.get(id);
    if (!after) throw new SessionHostError("invalidRequest", unknownBackgroundAgent(id));
    return { accepted, agent: projectBackgroundAgent(after) };
  }

  /**
   * Deliver a finished background agent's result into a live session.
   *
   * ### The text is delivered unexpanded, and that is the point
   *
   * A background agent's final text is written by a model. It reaches the
   * session exactly as the registry composed it — **not** through
   * {@link SessionHost#buildPromptContent}, so no `@`-mention in it is
   * resolved and no leading `/name` is expanded. That mirrors the terminal,
   * whose `/bg adopt` calls `agent.prompt`/`agent.steer` directly, and the
   * mirroring is load-bearing rather than incidental: expanding mentions here
   * would let a child agent that wrote `@.env` into its answer make the parent
   * read that file on the strength of somebody clicking "adopt". `prompt`
   * expands the mentions a *person* typed. This is not that.
   *
   * ### Steer or prompt
   *
   * A session mid-run is steered — the message lands after the current tool
   * call — and an idle one is prompted, which starts a turn and resolves when
   * that turn ends, exactly as {@link SessionHost.prompt} does. The choice is
   * made here rather than by a client because a client cannot observe
   * "running" without racing it.
   *
   * @throws {SessionHostError} `sessionNotFound` when the session is not live;
   *   `invalidRequest` when no registry was wired, when `id` names no agent,
   *   or when the agent is still running or produced nothing to adopt.
   */
  async adoptBackgroundAgent(sessionId: string, id: string): Promise<AdoptBackgroundAgentResult> {
    const registry = this.#requireBackgroundAgents();
    const session = this.#require(sessionId);
    const adoption = registry.adoption(id);
    if (adoption === undefined) {
      throw new SessionHostError("invalidRequest", unknownBackgroundAgent(id));
    }
    if ("refusal" in adoption) {
      throw new SessionHostError("invalidRequest", adoption.refusal);
    }
    if (isBusy(session)) {
      session.agent.steer(adoption.text);
      return { agentId: id, delivered: "steer" };
    }
    // Claimed synchronously before the first await, for the reason
    // `LiveSession.starting` exists: another wire request can arrive in the
    // window, and a `prompt` that sailed past the busy check would fail deep
    // inside `Agent` with a raw error.
    session.starting = true;
    try {
      await session.agent.prompt(adoption.text);
    } finally {
      session.starting = false;
    }
    return { agentId: id, delivered: "prompt" };
  }

  /**
   * Read the org-memory store.
   *
   * Not session-scoped: the store is keyed by project and lives under the
   * user's home, so it is a property of the engine.
   *
   * Carries `warnings` as well as `entries` because the store re-applies its
   * bounds on *read* and drops what fails them — an empty `entries` from a
   * store that was refused for being over its byte ceiling is a different fact
   * from an empty store, and only the warnings tell them apart.
   *
   * @throws {SessionHostError} `invalidRequest` when no store was wired.
   */
  async orgMemory(): Promise<OrgMemoryList> {
    const store = this.#requireOrgMemory();
    return this.#validOrgMemory(projectOrgMemory(await store.read()));
  }

  /**
   * File a **proposed** org-memory entry.
   *
   * It reaches no prompt. There is no method on this host that makes an entry
   * active, and {@link OrgMemoryStoreAccess.propose} has no status parameter to
   * pass one through — see `org-memory.ts` for why that gate is a person rather
   * than a field.
   *
   * The refusal for an over-long or marker-carrying lesson comes from the store
   * itself and is passed through verbatim, because it names the bound that was
   * broken and a caller needs to read that rather than "invalid request".
   *
   * @throws {SessionHostError} `invalidRequest` when no store was wired, or
   *   when the store refuses the entry.
   */
  async proposeOrgMemory(role: string, text: string): Promise<OrgMemoryProposal> {
    const store = this.#requireOrgMemory();
    const result = await store.propose(role, text);
    if ("error" in result) throw new SessionHostError("invalidRequest", result.error);
    // Belt and braces, and the braces are the point: this host cannot file an
    // active entry, but it is the last place that could *notice* one, and an
    // entry that reached a client marked "proposed" while sitting active in the
    // file would be the exact failure the whole gate exists to prevent.
    if (result.value.status !== "proposed") {
      throw new Error(
        "Refusing to answer a propose with a non-proposed entry: an org-memory entry that " +
          "reaches a role's prompt must be approved by a person.",
      );
    }
    const proposal: OrgMemoryProposal = {
      entry: projectOrgMemoryEntry(result.value),
      store: projectOrgMemory(await store.read()),
    };
    const validation = validateOrgMemoryProposal(proposal);
    if (!validation.ok) {
      throw new Error(`Org memory proposal is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * Take an org-memory entry back: demote it to `proposed`, or delete it.
   *
   * Allowed over this wire where approving is not, because both directions only
   * ever *reduce* the standing instruction text later runs are given.
   *
   * Answers with the resulting store — the engine's answer to "what is in there
   * now", not an echo of the request, so a client never has to make a second
   * round trip to find out what it did.
   *
   * @throws {SessionHostError} `invalidRequest` when no store was wired, or
   *   when `id` names no entry.
   */
  async revokeOrgMemory(id: string, remove = false): Promise<OrgMemoryList> {
    const store = this.#requireOrgMemory();
    const result = await store.revoke(id, remove);
    if ("error" in result) throw new SessionHostError("invalidRequest", result.error);
    return this.#validOrgMemory(projectOrgMemory(result.value));
  }

  /** The registry, or the refusal for an engine assembled without one. */
  #requireBackgroundAgents(): BackgroundAgentRegistry {
    const registry = this.#backgroundAgents;
    if (!registry) {
      throw new SessionHostError(
        "invalidRequest",
        "This server was built without a background-agent manager, so it cannot run or report " +
          "background agents. That is different from having none: an engine with a manager and " +
          "no agents answers with an empty list.",
      );
    }
    return registry;
  }

  /** The store, or the refusal for an engine assembled without one. */
  #requireOrgMemory(): OrgMemoryStoreAccess {
    const store = this.#orgMemory;
    if (!store) {
      throw new SessionHostError(
        "invalidRequest",
        "This server was built without an org-memory store, so it cannot read or file per-role " +
          "lessons. That is different from an empty store, which answers with no entries.",
      );
    }
    return store;
  }

  /** Normalize an org-memory payload against the wire contract on the way out. */
  #validOrgMemory(payload: OrgMemoryList): OrgMemoryList {
    const validation = validateOrgMemoryList(payload);
    if (!validation.ok) {
      throw new Error(`Org memory listing is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * Every workflow this engine discovered, with the ceilings it declares and
   * the lane derived for each role it dispatches to.
   *
   * Not session-scoped: a workflow is a file the served workspace (or the
   * user's home) holds, so this is shaped like {@link SessionHost.listModels}.
   *
   * Normalized against the wire contract on the way out — the discipline
   * `listModels` applies, and the reason it matters here is the same reason it
   * matters for `permissionState.tools`: `roles[].lane` is a closed
   * enumeration, and it is the sentence a person reads before deciding whether
   * a pipeline is safe to run.
   *
   * @returns The catalog, or `[]` when no workflow engine was wired.
   */
  async listWorkflows(): Promise<WorkflowSummary[]> {
    if (!this.#workflows) return [];
    const workflows = await this.#workflows.list();
    const validation = validateWorkflowCatalog({ workflows });
    if (!validation.ok) {
      throw new Error(`Workflow catalog is not a valid wire payload: ${validation.error}`);
    }
    return validation.value.workflows;
  }

  /**
   * What a run reached, from the durable run journal.
   *
   * Not session-scoped, deliberately: runs live under the served home, and a
   * run started in a terminal is exactly as legible here as one started over
   * the wire. Making this session-scoped would have meant a panel could not see
   * the run it is about to resume unless the same session had started it.
   *
   * A `runId` with no journal answers zero rows rather than erroring, because
   * on this wire an error from a *read* means "this engine does not know the
   * verb" — `isUnsupportedMethodError` cannot tell the two apart. It is the
   * rule `pendingChanges` keeps by reporting `dryRun: false`. The refusal path
   * below is kept for a genuinely broken read, not for an absent run.
   *
   * @param runId - One run, with per-step rows; omit for the listing.
   * @throws {SessionHostError} `invalidRequest` when the engine cannot read its
   *   own run store at all.
   */
  async workflowStatus(runId?: string): Promise<WorkflowRunStatus[]> {
    if (!this.#workflows) return [];
    const result = await this.#workflows.status(runId);
    if (!result.ok) throw new SessionHostError("invalidRequest", result.error);
    const validation = validateWorkflowRuns({ runs: result.value });
    if (!validation.ok) {
      throw new Error(`Workflow status is not a valid wire payload: ${validation.error}`);
    }
    return validation.value.runs;
  }

  /**
   * Start a workflow run on one session's event stream.
   *
   * ### What this method owns, and what it deliberately does not
   *
   * It owns the two refusals a client cannot make for itself — the session has
   * to exist, and it has to be free — and the wiring that makes the run
   * followable and cancellable. Everything else belongs to the engine behind
   * {@link SessionHostOptions.workflows}: which workflows exist, whether the
   * requested budget is legal, what a role's lane is, what a step may touch.
   * Re-deciding any of that here would be the second workflow engine this
   * package exists not to be.
   *
   * ### Refused while the session is busy
   *
   * `sessionBusy` when the session is mid-turn **or** already running a
   * pipeline. Not because the two would corrupt each other — a workflow's steps
   * are their own agents — but because this session's event stream is the only
   * place either one is visible, and two pipelines narrating into one
   * transcript is a transcript nobody can read. It hands the client something
   * to do (wait, or open a second session) rather than producing a mess it
   * cannot untangle afterwards.
   *
   * ### It answers on acceptance
   *
   * See `ClientRequest`'s `runWorkflow`: a pipeline outlives every sane request
   * deadline, so the response is the accepted run and the run itself rides the
   * session stream. The client is already subscribed; nothing new is opened.
   *
   * @param sessionId - Session whose stream carries the run.
   * @param params - Workflow name, `{{input}}`, and a budget that may only
   *   lower the file's own ceiling.
   * @returns The accepted run: its id, its shape, and the limits in force.
   * @throws {SessionHostError} `sessionNotFound`, `sessionBusy`, or
   *   `invalidRequest` for an unknown workflow, an illegal budget, or a host
   *   assembled with no workflow engine at all.
   */
  async runWorkflow(
    sessionId: string,
    params: { name: string; input?: string; budgetUsd?: number },
  ): Promise<WorkflowRunHandle> {
    const session = this.#requireIdleForWorkflow(sessionId, "start a workflow");
    const workflows = this.#requireWorkflows("run a workflow");
    const controller = this.#armWorkflowRun(sessionId);
    try {
      return this.#unwrapWorkflow(
        await workflows.run({
          sessionId,
          name: params.name,
          ...(params.input === undefined ? {} : { input: params.input }),
          ...(params.budgetUsd === undefined ? {} : { budgetUsd: params.budgetUsd }),
          permissionMode: session.agent.permissionMode,
          emit: (event) => this.#fanOut(session, event),
          signal: controller.signal,
        }),
        controller,
        sessionId,
      );
    } catch (error) {
      this.#disarmWorkflowRun(sessionId, controller);
      throw error;
    }
  }

  /**
   * Re-enter an interrupted run, optionally with the answer to its `ORG-ASK:`.
   *
   * Exactly {@link SessionHost.runWorkflow}'s shape and exactly its refusals.
   * That the resumed run does not redo finished work, and does not apply an
   * already-applied patch a second time, is the engine's promise behind the
   * injection — this method is the door to it and re-implements none of it.
   *
   * @param sessionId - Session whose stream carries the resumed run.
   * @param params - The run to re-enter and, optionally, the human's answer.
   * @throws {SessionHostError} On exactly `runWorkflow`'s terms, plus
   *   `invalidRequest` for a run that already finished or whose workflow file
   *   is no longer discoverable.
   */
  async resumeWorkflow(
    sessionId: string,
    params: { runId: string; answer?: string },
  ): Promise<WorkflowRunHandle> {
    const session = this.#requireIdleForWorkflow(sessionId, "resume a workflow");
    const workflows = this.#requireWorkflows("resume a workflow");
    const controller = this.#armWorkflowRun(sessionId);
    try {
      return this.#unwrapWorkflow(
        await workflows.resume({
          sessionId,
          runId: params.runId,
          ...(params.answer === undefined ? {} : { answer: params.answer }),
          permissionMode: session.agent.permissionMode,
          emit: (event) => this.#fanOut(session, event),
          signal: controller.signal,
        }),
        controller,
        sessionId,
      );
    } catch (error) {
      this.#disarmWorkflowRun(sessionId, controller);
      throw error;
    }
  }

  /**
   * The workflow engine, or the refusal for a host assembled without one.
   *
   * `invalidRequest` rather than an empty answer, which is
   * {@link SessionHostOptions.transcriptExporter}'s treatment and for the same
   * reason: this verb *starts* something, and a start that quietly did not
   * happen is the failure it exists to prevent. The reads above answer `[]`
   * instead, because "there are no workflows here" is a true sentence.
   */
  #requireWorkflows(verb: string): WorkflowService {
    const workflows = this.#workflows;
    if (!workflows) {
      throw new SessionHostError(
        "invalidRequest",
        `This engine was assembled without a workflow engine, so it cannot ${verb}. ` +
          "Refusing rather than reporting a run that never started.",
      );
    }
    return workflows;
  }

  /** The live session, or the refusal when it is mid-turn or mid-pipeline. */
  #requireIdleForWorkflow(sessionId: string, verb: string): LiveSession {
    const session = this.#require(sessionId);
    if (isBusy(session)) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} is running a turn; a workflow narrates into this session's ` +
          `event stream and would interleave with it. Abort the run or wait for it to end, ` +
          `then ${verb}.`,
      );
    }
    if ((this.#workflowRuns.get(sessionId)?.size ?? 0) > 0) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} is already running a workflow. One session carries one ` +
          "pipeline: abort it, or open a second session to run another alongside it.",
      );
    }
    return session;
  }

  /** Register a controller for a run about to start, so `abort` can reach it. */
  #armWorkflowRun(sessionId: string): AbortController {
    const controller = new AbortController();
    const runs = this.#workflowRuns.get(sessionId) ?? new Set<AbortController>();
    runs.add(controller);
    this.#workflowRuns.set(sessionId, runs);
    return controller;
  }

  /** Forget a controller once its run has settled (or never started). */
  #disarmWorkflowRun(sessionId: string, controller: AbortController): void {
    const runs = this.#workflowRuns.get(sessionId);
    if (!runs) return;
    runs.delete(controller);
    if (runs.size === 0) this.#workflowRuns.delete(sessionId);
  }

  /**
   * Turn an accepted run into a handle, or a refusal into an `invalidRequest`.
   *
   * A refusal disarms the controller here rather than at each call site: the
   * run never started, so leaving its controller in the map would make the next
   * `runWorkflow` on that session answer `sessionBusy` for a pipeline that does
   * not exist — a session wedged by a typo'd workflow name.
   */
  #unwrapWorkflow(
    result: WorkflowResult<AcceptedWorkflowRun>,
    controller: AbortController,
    sessionId: string,
  ): WorkflowRunHandle {
    if (!result.ok) {
      this.#disarmWorkflowRun(sessionId, controller);
      throw new SessionHostError("invalidRequest", result.error);
    }
    const validation = validateWorkflowRunHandle(result.value.handle);
    if (!validation.ok) {
      this.#disarmWorkflowRun(sessionId, controller);
      throw new Error(`Workflow run handle is not a valid wire payload: ${validation.error}`);
    }
    // The one thing `settled` is for. Without it a finished run would leave its
    // controller in the map and the session would answer `sessionBusy` to every
    // later `runWorkflow` — a session wedged by a pipeline that ended an hour
    // ago. `settled` never rejects (see its doc), and the `catch` is belt and
    // braces against an implementation that breaks that promise: a broken
    // promise must not wedge the session either.
    void result.value.settled
      .catch(() => undefined)
      .then(() => this.#disarmWorkflowRun(sessionId, controller));
    return validation.value;
  }

  /**
   * Which earlier turns this session could be rewound to, and what each would
   * cost.
   *
   * **Read-only.** Nothing is restored, nothing is deleted, nothing is forked.
   * The plans come from the engine's own checkpoint store — the same object
   * `rewindTo` then applies — so the price a client shows and the price a
   * rewind charges are one computation. See `rewind.ts`.
   *
   * Requires a **live** session, unlike {@link SessionHost.sessionHistory}:
   * a rewind acts on the session's working directory and forks the agent
   * holding its conversation, and a session nobody has opened has neither.
   *
   * @param sessionId - Session to list.
   * @returns The rewindable turns, newest first, bounded, with truncation
   *   reported. `available: false` when no checkpoint store is wired — which
   *   is the honest answer for such a host, and not the same answer as an
   *   engine with no such verb.
   * @throws {SessionHostError} `sessionNotFound` when the session is not live.
   * @throws When the projection is not a valid wire payload — a bug in this
   *   package, worth reporting rather than serving a picker a person would
   *   act on.
   */
  async listCheckpoints(sessionId: string): Promise<CheckpointList> {
    const session = this.#require(sessionId);
    if (!this.#checkpoints) {
      return {
        sessionId,
        checkpoints: [],
        available: false,
        truncated: false,
        droppedCheckpoints: 0,
      };
    }
    const previews = await this.#checkpoints.list(sessionId);
    const list = buildCheckpointList(
      sessionId,
      previews,
      session.header.cwd,
      this.#checkpointListLimits,
    );
    const validation = validateCheckpointList(list);
    if (!validation.ok) {
      throw new Error(`Checkpoint list is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * Restore this session's files to a checkpoint and fork its conversation to
   * match. **The most destructive operation on this wire.**
   *
   * **The restorer is the engine's, not a client's.** All this does is drive
   * the checkpoint store the served runtime built — the same object the TUI's
   * `/rewind` drives — so the workspace confinement that refuses a manifest
   * record outside the session's working directory, and the temp-file-plus-
   * rename that keeps an interrupted restore from leaving half a file, are the
   * same code a local user gets. There is no second restorer on this path and
   * there must not be one. `@arcturn/server` writes nothing.
   *
   * **The confirmation has to match.** `confirmation` is
   * {@link CheckpointEntry.confirmation} from the row the client rendered, and
   * this recomputes the plan and compares before anything happens. That is not
   * the two-phase handshake {@link SessionHost.deleteSession} refused — there
   * is no state here, no expiry and nothing to evict; it is a digest of the
   * plan itself. It exists because `rewindTo`'s parameters, unlike every other
   * destructive verb's, do **not** name what it destroys: a client that showed
   * "deletes 2 files", let a run append three more, and then sent the id would
   * rewind something nobody saw. See `checkpointConfirmation`.
   *
   * **Refused mid-run**, with `sessionBusy`, and via {@link isBusy} rather
   * than `agent.isRunning` alone — the check {@link SessionHost.deleteSession}
   * and {@link SessionHost.compact} make, for a reason that applies twice over
   * here. A prompt accepted but still resolving its context has not started
   * the agent yet, and a restore landing in that window would rewrite files
   * the run is about to read *and* fork the conversation it is about to append
   * to. The TUI already refuses this ("A run is in progress; press Esc to
   * interrupt it before rewinding") and this is the same refusal.
   *
   * Not widened to every live session the way {@link SessionHost.applyChanges}
   * is, and the difference is real rather than an oversight: one `--dry-run`
   * shadow tree is shared by every session on the process, so no single
   * session's `isRunning` could answer "is it safe to write this tree back",
   * whereas a checkpoint store belongs to one session and is rooted at that
   * session's own working directory. What two served sessions genuinely share
   * is the workspace — and they already write it concurrently through ordinary
   * tool calls, which is a property of running two agents in one directory
   * rather than something this verb introduces.
   *
   * **The fork is the host's to install.** The provider hands back the agent
   * holding the forked conversation; this is what unsubscribes the old one,
   * re-subscribes the observers and re-installs the permission requester, and
   * then tells every watcher — including other connections — that the session
   * moved, so nobody is left rendering a transcript that no longer describes
   * the files on disk.
   *
   * @param sessionId - Session to rewind.
   * @param checkpointId - The turn, as `listCheckpoints` reported its `id`.
   * @param confirmation - That same row's `confirmation`.
   * @returns What was rewritten, what was deleted, what was refused, and
   *   whether the transcript forked too.
   * @throws {SessionHostError} `sessionNotFound`, `sessionBusy` while this
   *   session is running a turn, or `invalidRequest` when this engine keeps no
   *   checkpoints, the id names no recorded turn, or the confirmation is stale.
   */
  async rewindTo(
    sessionId: string,
    checkpointId: string,
    confirmation: string,
  ): Promise<RewindResult> {
    const session = this.#require(sessionId);
    const checkpoints = this.#checkpoints;
    if (!checkpoints) {
      throw new SessionHostError(
        "invalidRequest",
        "This engine keeps no file checkpoints, so there is nothing to rewind to. " +
          "listCheckpoints reports available:false for the same reason.",
      );
    }
    if (isBusy(session)) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} is running a turn; files may not be restored and the ` +
          "conversation may not be forked halfway through one. Abort the run or wait for it " +
          "to end, then rewind.",
      );
    }

    const root = resolve(session.header.cwd);
    const previews = await checkpoints.list(sessionId);
    const preview = previews.find((candidate) => candidate.id === checkpointId);
    if (preview === undefined) {
      throw new SessionHostError(
        "invalidRequest",
        `No checkpoint ${JSON.stringify(checkpointId)} in session ${sessionId}. ` +
          "Ask listCheckpoints for the current set.",
      );
    }
    const expected = checkpointConfirmation(preview, root);
    if (expected !== confirmation) {
      throw new SessionHostError(
        "invalidRequest",
        "This checkpoint no longer costs what it did when it was listed — the files a " +
          "rewind would restore or delete have changed since. Nothing was touched. " +
          "Call listCheckpoints again and confirm against the current row.",
      );
    }

    // Re-checked immediately before the restore. The plan above is a
    // filesystem read, and a `prompt` arriving during it would claim the
    // session on a later microtask — the same window `LiveSession.starting`
    // exists for. This narrows it to the restore itself, which `#swapAgent`'s
    // abort covers on the same belt-and-braces terms `#evict` does.
    if (isBusy(session)) {
      throw new SessionHostError(
        "sessionBusy",
        `Session ${sessionId} started a turn while its checkpoints were being read; nothing ` +
          "was restored. Abort the run or wait for it to end, then rewind.",
      );
    }

    const outcome = await checkpoints.rewind(sessionId, checkpointId);
    if (outcome.agent !== undefined) this.#swapAgent(sessionId, session, outcome.agent);

    const result: RewindResult = {
      sessionId,
      checkpointId,
      restored: outcome.restored.map((path) => workspaceRelative(root, path)),
      deleted: outcome.deleted.map((path) => workspaceRelative(root, path)),
      failed: outcome.failed.map(
        (failure): RewindFailure => ({
          path: workspaceRelative(root, failure.path),
          message: failure.message,
        }),
      ),
      conversationForked: outcome.agent !== undefined,
    };
    // Normalized against the wire contract on the way out, like every other
    // result this host builds.
    const validation = validateRewindResult(result);
    if (!validation.ok) {
      throw new Error(`Rewind result is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
  }

  /**
   * Put a forked agent in place of the one a live session was holding.
   *
   * Everything a session's identity is made of has to move with it: the event
   * subscription that fans out to observers, and the permission requester that
   * turns a tool call into a `permissionRequest` frame. Leaving either on the
   * old agent would give a session that still renders — and a permission ask
   * nobody is listening for.
   *
   * The **observers themselves are kept**. A rewind is not a delete: the same
   * connections are still attached to the same session id, and dropping their
   * subscriptions would silently stop the transcript they are watching. What
   * they are told instead is a `notice`, before any new event can arrive, so a
   * client that was not the one asking learns the conversation moved and can
   * replay it — through `sessionHistory`, which is the one transcript path.
   *
   * @param sessionId - Session being forked, for the notice.
   * @param session - Its live record, mutated in place.
   * @param next - The agent holding the forked conversation.
   */
  #swapAgent(sessionId: string, session: LiveSession, next: Agent): void {
    for (const [requestId, pending] of session.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({
        requestId,
        behavior: "deny",
        message: "This session was rewound to an earlier turn.",
      });
    }
    session.pendingPermissions.clear();
    session.unsubscribe();
    // Belt and braces, the way `#evict` aborts: the busy check ran before the
    // restore, but a run could have started in the gap, and an agent still
    // appending to a conversation this host no longer serves is worse than an
    // aborted one.
    session.agent.abort();

    session.unsubscribe = next.subscribe((event: AgentEvent) => {
      for (const listener of [...session.observers]) {
        try {
          listener(event);
        } catch {
          // An observer must never be able to break fan-out to the others.
        }
      }
    });
    next.permissions.setRequester(this.#permissionRequester(session.pendingPermissions));
    session.agent = next;

    this.#fanOut(session, {
      type: "notice",
      level: "info",
      text: `Session ${sessionId} was rewound to an earlier turn; its conversation was forked. Replay it with sessionHistory.`,
    });
  }

  /**
   * Refuse when **any** live session is mid-run.
   *
   * Wider than {@link SessionHost.setPermissionMode}'s check on purpose, and
   * the width is the honest part: a permission mode belongs to one agent, but
   * the dry-run shadow tree belongs to the process. Two served sessions write
   * into the same tree, so "is it safe to write this tree back to disk" is not
   * a question one session's `isRunning` can answer.
   *
   * @param sessionId - The session that asked, named first in the message when
   *   it is the busy one so the common case reads naturally.
   * @param verb - `"applied"` / `"discarded"`, for the sentence.
   */
  #requireIdleWorkspace(sessionId: string, verb: string): void {
    const asking = this.#sessions.get(sessionId);
    const busy =
      asking !== undefined && isBusy(asking)
        ? sessionId
        : [...this.#sessions].find(([, session]) => isBusy(session))?.[0];
    if (busy === undefined) return;
    throw new SessionHostError(
      "sessionBusy",
      busy === sessionId
        ? `Session ${sessionId} is running a turn; pending changes may not be ${verb} while the ` +
            "agent is still writing into the shadow tree. Abort the run or wait for it to end."
        : `Session ${busy} is running a turn on this engine, and every session here shares one ` +
            `--dry-run shadow tree, so pending changes may not be ${verb} yet. Abort that run ` +
            "or wait for it to end.",
    );
  }

  /**
   * Resolve a pending permission ask raised by the session's agent.
   *
   * Unknown, already-resolved or timed-out request ids are ignored rather
   * than raising an error — a decision arriving late is not a protocol
   * violation, just a no-op.
   *
   * ### The one thing a remote decision may not do
   *
   * `scope` says how long an allow lasts, and the only value this host accepts
   * is `"session"`. `"project"` and `"user"` are the scopes `@arcturn/cli`'s
   * `persistPermissionRule` writes into a config file a **person** owns, and
   * RFC 0005 §3 refuses "remote write to a user's permission config". A
   * session-scoped rule reaches the engine's in-memory rule list and dies with
   * the process; nothing touches disk.
   *
   * The same wall applies to a client-supplied
   * {@link PermissionDecision.persistRule}: its scope must be `"session"` too.
   *
   * Enforced **here**, not only in `@arcturn/protocol`'s frame validation.
   * `SessionHost` is a public API an SDK embedder wires to its own transport,
   * and a rule this important may not depend on which door a decision came
   * through.
   *
   * When `scope` is `"session"`, the rule is built from the request's own
   * {@link PermissionRequest.suggestedRule} rather than from anything the
   * client sent — a client says *how long*, never *what*. A request with no
   * `suggestedRule` is not repeatable (the engine offers one only for a call
   * with a real subject), and asking for `"session"` on one is refused rather
   * than silently downgraded to an allow-once, because a client told "yes" for
   * a session it did not get would stop offering the choice and never find
   * out.
   *
   * A refusal leaves the ask **pending**: the tool call is not settled by a
   * decision this host would not honour, so the client can re-send a legal one
   * and the turn continues. (The ask's own timeout still applies.)
   *
   * `scope` describes an **allow**. A `deny` is answered as sent and the scope
   * is ignored: a client that meant "deny for the rest of the session" is asked
   * again next time, which is the fail-safe direction, and wedging the one
   * answer a permission system most needs to accept on a contract technicality
   * is not a trade worth making.
   *
   * @param sessionId - Session that raised the ask.
   * @param decision - The client's decision.
   * @param scope - How long an allow lasts. Omitted means once.
   * @throws {SessionHostError} `sessionNotFound` when the session is not live,
   *   or `invalidRequest` for a scope this host will not grant.
   */
  handlePermissionDecision(
    sessionId: string,
    decision: PermissionDecision,
    scope?: PermissionScope,
  ): void {
    const session = this.#require(sessionId);
    if (decision.persistRule !== undefined && decision.persistRule.scope !== "session") {
      throw new SessionHostError(
        "invalidRequest",
        widerScopeRefusal("decision.persistRule.scope", decision.persistRule.scope),
      );
    }
    if (scope !== undefined && scope !== "session") {
      throw new SessionHostError("invalidRequest", widerScopeRefusal("scope", scope));
    }

    const pending = session.pendingPermissions.get(decision.requestId);
    if (!pending) return;

    let resolved = decision;
    if (scope === "session" && decision.behavior === "allow") {
      const suggested = pending.request.suggestedRule;
      if (suggested === undefined) {
        throw new SessionHostError(
          "invalidRequest",
          `Permission request ${decision.requestId} is not repeatable: the engine offered no ` +
            "rule for it, so there is nothing to allow for the session. Re-send the decision " +
            "without a scope to allow it once.",
        );
      }
      // The engine's own suggestion, at session scope. The client chose the
      // duration; it did not get to choose the rule.
      resolved = { ...decision, persistRule: { ...suggested, scope: "session" } };
    }

    clearTimeout(pending.timer);
    session.pendingPermissions.delete(decision.requestId);
    pending.resolve(resolved);
  }

  /**
   * Build one session's {@link PermissionState}, validated on the way out.
   *
   * `agent.tools` is the full set the session was built with, not the subset
   * progressive disclosure is showing the model this turn: the question a
   * client asks is "what can this engine do", and an answer that changed from
   * turn to turn would make a capabilities line flicker for reasons no user
   * could explain. Names are sorted so two reads of an unchanged session
   * compare equal.
   */
  #permissionState(session: LiveSession, sessionId: string): PermissionState {
    const state: PermissionState = {
      sessionId,
      mode: session.agent.permissionMode,
      rules: [...session.agent.permissions.rules],
      tools: session.agent.tools.map((tool) => tool.definition.name).sort(),
    };
    const validation = validatePermissionState(state);
    if (!validation.ok) {
      throw new Error(`Permission state is not a valid wire payload: ${validation.error}`);
    }
    return validation.value;
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
    // Workflow runs first: a pipeline outlives the turn that started it, so a
    // shutdown that only aborted agents would leave steps still spending after
    // the socket is gone.
    for (const runs of this.#workflowRuns.values()) {
      for (const controller of runs) controller.abort();
    }
    this.#workflowRuns.clear();
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
    // A deleted session's pipeline goes with it: its steps narrate into a
    // stream that is about to stop existing, and it was journalling against a
    // session nobody can reach any more.
    for (const controller of this.#workflowRuns.get(sessionId) ?? []) controller.abort();
    this.#workflowRuns.delete(sessionId);

    this.#fanOut(session, {
      type: "notice",
      level: "warn",
      text: `Session ${sessionId} was deleted.`,
    });

    session.unsubscribe();
    session.observers.clear();
    this.#sessions.delete(sessionId);
  }

  /**
   * Push one event this host synthesized to a session's observers.
   *
   * The agent's own events reach observers through the subscription set up in
   * {@link SessionHost.#register}; this is the other door, for the few events
   * the *host* has to say itself — a session was deleted, a mention was
   * refused. Deliberately the ordinary `notice` shape rather than a new wire
   * type, so a client renders it with whatever it already does for engine
   * diagnostics and needs no new branch.
   */
  #fanOut(session: LiveSession, event: AgentEvent): void {
    for (const listener of [...session.observers]) {
      try {
        listener(event);
      } catch {
        // An observer must never be able to break fan-out to the others.
      }
    }
  }

  #require(sessionId: string): LiveSession {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new SessionHostError("sessionNotFound", `Session ${sessionId} does not exist`);
    }
    return session;
  }

  /**
   * The permission bridge for one session's agent.
   *
   * The prompt receives the request id the client will quote back, so
   * decisions are matched by identity. Inferring the pairing by arrival order
   * would desync the moment the engine settled a request from its rules
   * without ever prompting.
   *
   * Factored out of {@link SessionHost.#register} because a session can get a
   * *second* agent — {@link SessionHost.#swapAgent}, when a rewind forks the
   * conversation — and a requester built twice is a requester that can be
   * built two ways. Both doors install this one.
   *
   * @param pendingPermissions - The live session's own map, which the returned
   *   requester writes into and the client's decisions resolve out of.
   */
  #permissionRequester(pendingPermissions: Map<string, PendingPermission>): PermissionPrompt {
    return (request) => {
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
        pendingPermissions.set(requestId, { resolve, timer, request });
      });
    };
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

    agent.permissions.setRequester(this.#permissionRequester(pendingPermissions));

    const session: LiveSession = {
      header,
      agent,
      observers,
      pendingPermissions,
      starting: false,
      steerTail: Promise.resolve(),
      unsubscribe,
    };
    this.#sessions.set(header.sessionId, session);
    return session;
  }
}
