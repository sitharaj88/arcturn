/**
 * `arcturn serve` — expose this machine's Arcturn sessions over a WebSocket, so
 * another terminal (or another machine) can attach with `arcturn attach`.
 *
 * {@link runServe} wires a {@link ArcturnRuntime} (built by {@link buildRuntime}
 * in `runtime.ts`) into `@arcturn/server`'s {@link SessionHost} and
 * {@link ArcturnServer}: the runtime supplies the LLM client, resolved model,
 * system prompt, tool set and session store; `SessionHost` turns those into
 * one live {@link Agent} per connected session; `ArcturnServer` speaks the wire
 * protocol over `ws`.
 *
 * ## Threat model
 *
 * A connection that completes authentication (or, when no token is
 * configured, *any* connection) gets full tool execution as the user running
 * `arcturn serve` — the same `bash`, `write`, `edit` and network tools the local
 * CLI has, gated by the same permission rules. Holding the token is
 * equivalent to holding a shell as this user for anything the configured
 * permission mode allows. Treat the token like a credential: do not log it,
 * put it in shell history unquoted, or send it over an unencrypted channel
 * to an untrusted network — `arcturn serve` speaks plain `ws://`, not `wss://`,
 * so prefer binding loopback and tunnelling (SSH port-forward, Tailscale,
 * etc.) over exposing a non-loopback interface directly.
 *
 * With {@link RunServeOptions.web} a second, tiny HTTP listener also serves
 * the browser client (`web/page.ts`) — one self-contained page that speaks the
 * same wire protocol from a phone. It never serves the token: the page is
 * inert until someone supplies one, and the WebSocket handshake is what
 * authenticates. See `web/server.ts` and `docs/web-client.md`.
 *
 * A token is generated automatically whenever one is not supplied, on every
 * interface, including loopback: a same-machine login without a token would
 * otherwise let any other local user (or any process, browser tab, or
 * malware) connect and get full tool execution too — loopback narrows the
 * attack surface to "this machine" but does not make every process on it
 * trustworthy. Binding a non-loopback interface without a token at all is a
 * hard refusal: see {@link ServeBindError} and {@link resolveServeToken}.
 */

import { randomBytes } from "node:crypto";
import { calculateCostUsd } from "@arcturn/ai";
import { Agent, type AgentOptions } from "@arcturn/core";
import type { McpManager } from "@arcturn/mcp";
import type { AgentFactoryOptions, DryRunOverlay } from "@arcturn/server";
import { ArcturnServer, SessionHost } from "@arcturn/server";
import type {
  LLMClient,
  ModelSpec,
  PermissionMode,
  PermissionRule,
  SessionStore,
  Tool,
} from "@arcturn/types";
import type { AgentDef } from "./agents.js";
import { type BackgroundAgentHost, getBackgroundAgentManager } from "./background-agents.js";
import type { CheckpointStore } from "./checkpoints.js";
import { createContextResolver } from "./context.js";
import { createCostGuard } from "./cost-guard.js";
import { exportHtml, exportMarkdown, suggestExportFilename } from "./export.js";
import { createMcpAuthBroker } from "./mcp-auth.js";
import { type EnvMap, resolveArcturnPaths } from "./paths.js";
import {
  type ArcturnRuntime,
  buildRuntime,
  compactionOptionsFor,
  modelCatalogEntries,
  registerBundledCatalog,
  resolveModelSpec,
} from "./runtime.js";
import { ScoutRegistry } from "./scout-registry.js";
import { runScouts, type ScoutAgent } from "./scouts.js";
import { backgroundAgentRegistry } from "./serve-background.js";
import { serveCommandDescriptors } from "./serve-commands.js";

/**
 * How long a scout run started from a socket may take.
 *
 * The terminal's `/scout` uses three minutes, and this matches it. A client
 * cannot raise it: a deadline a caller chooses is a caller that can pin a
 * repository's worktrees open for as long as it likes.
 */
const SERVE_SCOUT_DEADLINE_MS = 180_000;

import {
  mcpPromptList,
  mcpPromptRender,
  mcpResourceList,
  mcpResourceRead,
  mcpServerSummaries,
} from "./serve-mcp.js";
import { serveOrgMemoryStore } from "./serve-org-memory.js";
import { createServeRewind, type ServeRewind } from "./serve-rewind.js";
import { createServeWorkflows, type ServableWorkflowRuntime } from "./serve-workflows.js";
import type { Skill } from "./skills.js";
import { startWebClientServer, type WebClientServer, webClientOrigins } from "./web/server.js";

/**
 * Raised by {@link resolveServeToken} (and, transitively, {@link runServe})
 * when a caller asks to bind a non-loopback interface with authentication
 * explicitly disabled. See the module TSDoc for why this is a hard refusal.
 */
export class ServeBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeBindError";
  }
}

/**
 * Hosts treated as "this machine only". Matches what {@link ArcturnServer.start}
 * and Node's `http`/`ws` servers accept as a loopback bind address; a
 * hostname that merely *resolves* to loopback (e.g. a `/etc/hosts` entry) is
 * deliberately not treated as loopback here — the check is on the literal
 * bind argument, not a DNS lookup.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

/** Whether `host` is one of the recognised loopback bind addresses. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** Generate a random 32-hex-character shared-secret token. */
export function generateServeToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Resolve the token {@link runServe} hands to {@link ArcturnServer}.
 *
 * - `token` omitted → a fresh {@link generateServeToken} value, on every host
 *   (including loopback — see the module TSDoc).
 * - `token` a non-empty string → used as-is, on every host.
 * - `token` the empty string → an explicit "run without authentication"
 *   request. Honoured on a loopback host; rejected everywhere else.
 *
 * @param host - The interface `runServe` is about to bind.
 * @param token - The caller-supplied `--token` value, if any.
 * @throws {ServeBindError} When `token` is `""` and `host` is not loopback.
 */
export function resolveServeToken(host: string, token?: string): string | undefined {
  if (token === "") {
    if (!isLoopbackHost(host)) {
      throw new ServeBindError(
        `Refusing to bind ${host} without a token: anyone who can reach this port would get ` +
          `full tool execution as this user. Omit --token to auto-generate one, or bind a ` +
          `loopback address (127.0.0.1) instead.`,
      );
    }
    return undefined;
  }
  return token ?? generateServeToken();
}

/** Render a `ws://` URL, bracketing a literal IPv6 host. */
export function formatServeUrl(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ws://${bracketed}:${port}`;
}

/**
 * The minimal slice of {@link ArcturnRuntime} {@link createServeHost} needs to
 * turn one `AgentFactoryOptions` into an {@link Agent}. `ArcturnRuntime` already
 * satisfies this structurally — nothing in `runtime.ts` had to change.
 *
 * ### Known limitation
 *
 * `tools` and `systemPrompt` are read once, from the runtime's state at the
 * moment {@link createServeHost} is called; every served session shares that
 * one snapshot. In particular `tools` here is `ArcturnRuntime.tools`, which is
 * `this.agent.tools` on the runtime's *own* singleton agent — checkpoint-
 * wrapped against that agent's checkpoint store, not a per-served-session
 * one. Practically: `write`/`edit` calls from served sessions still work,
 * but their checkpoints land in the runtime's own session's checkpoint
 * directory rather than each served session's, so `/rewind`-style recovery
 * does not cleanly isolate concurrently served sessions from each other or
 * from the runtime's own. Likewise `cwd` is accepted per session
 * (`AgentFactoryOptions.cwd`) and threaded into the constructed `Agent`, but
 * the *tools themselves* were built once against `runtime.cwd` (inside
 * `buildRuntime`'s `createDefaultTools` call), so a served session opened
 * with a different `cwd` gets tools that still operate against the
 * runtime's original working directory.
 *
 * Fixing both precisely — a checkpoint store and a tool set built fresh per
 * served session — needs a method on `ArcturnRuntime` that mirrors its private
 * `#createAgent`/`#agentOptions` but is parameterized by `sessionId`/`cwd`
 * instead of closing over the runtime's singleton `this.checkpoints`; e.g.:
 *
 * ```ts
 * buildSessionAgent(opts: { sessionId: string; cwd: string; model?: string }): Agent
 * ```
 *
 * That is exactly `#createAgent`/`#agentOptions` today, minus the implicit
 * dependence on `this.agent`/`this.checkpoints`. This module does not add it
 * (editing `runtime.ts` was out of scope here) — it is the one accessor a
 * fully-correct multi-session server needs.
 */
export interface ServableRuntime {
  readonly llm: LLMClient;
  readonly model: ModelSpec;
  readonly cwd: string;
  readonly env: EnvMap;
  readonly store: SessionStore;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly config: { permissions: PermissionRule[]; permissionMode: PermissionMode };
  /**
   * Markdown skills this runtime discovered, for the `listCommands` verb.
   *
   * Optional so a stub runtime (this module's tests, an embedder that has no
   * skill library) still satisfies the shape; absent, `listCommands` answers
   * with the built-ins alone, which is the truth for such a host.
   */
  readonly skills?: readonly Skill[];
  /**
   * The runtime's MCP manager, for the `mcpStatus` verb.
   *
   * Optional so a stub runtime (this module's tests, an embedder with no MCP
   * config, `--no-mcp`) still satisfies the shape; absent, `mcpStatus` answers
   * with an empty list, which is the truth for such a host.
   *
   * Typed as the manager rather than as a projection so the *projection* stays
   * in one place — `serve-mcp.ts`, next to the config the credentials live in.
   * See that module for what leaves and what does not.
   */
  readonly mcp?: McpManager;
  /**
   * The `--dry-run` shadow workspace, when this runtime has one.
   *
   * Optional so a stub runtime (this module's tests, an embedder that never
   * runs dry) still satisfies the shape; absent, the review verbs answer
   * `dryRun: false` and refuse to apply or discard, which is the truth for such
   * a host. A real `ArcturnRuntime` exposes exactly this field.
   */
  readonly overlay?: DryRunOverlay | undefined;
  /**
   * Where workflow files and run journals live, the markdown agents a `@role`
   * step resolves against, this engine's live permission mode, and the child
   * agent factory a read-lane step runs through — the four things
   * `createServeWorkflows` needs to drive the same `/workflow` engine the
   * terminal drives.
   *
   * All optional so a stub runtime (this module's tests, an embedder with no
   * agent catalog) still satisfies the shape; a real `ArcturnRuntime` satisfies
   * every one of them structurally, with nothing added to `runtime.ts`. Without
   * `paths` and `createSubagent` there is nowhere to discover a workflow and
   * nothing to run a step as, so no workflow engine is wired at all and the
   * verbs report that honestly — see `serve-workflows.ts`.
   */
  readonly paths?: { readonly home: string; readonly project: string };
  /** The runtime's model router, for `tier:` tags in workflows. Optional for stubs. */
  readonly router?: { specForTier(name: string): ModelSpec | undefined };
  readonly agents?: ReadonlyMap<string, AgentDef>;
  /**
   * Build a throwaway agent rooted at one scout's worktree, and fold a scout's
   * spend back into this session's accounting.
   *
   * Optional on the same terms as `createSubagent`: without both, no scout
   * registry is wired and the three verbs say so rather than pretending. They
   * come as a pair because a scout that ran without its cost being recorded
   * would make `--max-cost` and `/cost` silently under-report — scouts spend
   * outside the main agent's event stream.
   */
  scoutAgent?: (cwd: string) => ScoutAgent;
  recordExternalCost?: (costUsd: number | undefined) => void;
  readonly permissionMode?: PermissionMode;
  createSubagent?: ServableWorkflowRuntime["createSubagent"];
  /**
   * Optional: build a fully isolated agent for one served session. A real
   * `ArcturnRuntime` provides it; stubs may omit it and get the generic assembly.
   */
  buildSessionAgent?: (options: {
    sessionId: string;
    cwd?: string;
    model?: ModelSpec;
    checkpoints?: CheckpointStore;
  }) => Agent;
  /**
   * Optional: rebuild the agent for a session that already exists in the
   * store — the resuming twin of `buildSessionAgent`, and what `openSession`
   * needs. A real `ArcturnRuntime` provides it; a stub that omits it gets the
   * generic `Agent.resume` assembly below, which resumes the same conversation
   * with the generic tool set.
   *
   * Optional, but never *skipped*: a served session is always resumed, by one
   * route or the other. Falling back to a fresh `Agent` here is precisely the
   * bug — a reopened session that renders empty and, worse, whose model is
   * asked to continue a conversation it was never shown.
   */
  resumeSessionAgent?: (options: {
    sessionId: string;
    cwd?: string;
    model?: ModelSpec;
    checkpoints?: CheckpointStore;
    resolveModel?: (modelId: string) => ModelSpec | undefined;
  }) => Promise<Agent>;
  /**
   * Whether this engine was started with an explicit `--model`.
   *
   * Read by the resume path only: a flag the operator typed for THIS process
   * outranks the model id recorded in a session file, exactly as it does for
   * `--resume` in the terminal. Absent (a stub, an embedder) it reads as "not
   * pinned", which is what a runtime with no flag to pin is.
   */
  readonly modelPinned?: boolean;
  /**
   * Optional: fork one served session's conversation to an earlier entry, for
   * the `rewindTo` verb. A real `ArcturnRuntime` provides it; a stub that omits
   * it — like one that omits `buildSessionAgent` — simply offers no rewind,
   * which `listCheckpoints` reports as `available: false` rather than as an
   * empty picker.
   */
  forkSessionAgent?: (options: {
    sessionId: string;
    leafId: string | null;
    cwd?: string;
    checkpoints: CheckpointStore;
  }) => Promise<Agent>;
  dispose(): Promise<void>;
}

/**
 * Wire a per-session USD cost ceiling directly onto one served `Agent`.
 *
 * `ArcturnRuntime`'s own `--max-cost` guard (`runtime.ts`'s `costGuard`) only
 * ever watches `runtime.agent` — the TUI/`--print` "live" agent — never the
 * agents `buildServedAgent` mints, so `arcturn serve` needs its own guard, scoped
 * to each agent's own event stream and its own `abort()`. Mirrors
 * `acp/host.ts`'s `attachCostGuard`, which has the identical gap for the same
 * reason (see `ACP-STATUS.md`).
 */
function attachCostGuard(agent: Agent, limitUsd: number): void {
  let spentUsd = 0;
  const guard = createCostGuard({
    limitUsd,
    getCostUsd: () => spentUsd,
    abort: () => agent.abort(),
    notify: (message) => {
      process.stderr.write(`arcturn serve: ${message} (session ${agent.sessionId})\n`);
    },
  });
  agent.subscribe((event) => {
    if (event.type === "turnEnd") {
      spentUsd += event.usage.costUsd ?? calculateCostUsd(agent.model, event.usage) ?? 0;
    }
    guard.onEvent(event);
  });
}

/**
 * The one place a wire-level model id becomes a real {@link ModelSpec} for a
 * served session.
 *
 * A model id is a label; a `ModelSpec` is the provider, endpoint and
 * credential the next request actually uses. Both wire routes that carry a
 * bare id — `createSession({ model })` and `setModel` — go through this
 * single function, against the same catalog and the same environment
 * `--list-models` and the `listModels` verb read, so a client can never pick
 * an id off the catalog and have it resolve to something else (or to
 * nothing) on the way in.
 *
 * `registerBundledCatalog` runs on every call rather than once at startup:
 * it is idempotent, and an extension may register a model after the server is
 * already up — the same reason `createServeHost`'s `modelCatalog` re-reads.
 *
 * @throws {ModelResolutionError} For an unknown id, or one whose provider key
 *   is not set. Callers surface it; nothing falls back to a guess.
 */
function serveModelResolver(env: EnvMap): (modelId: string) => ModelSpec {
  return (modelId) => {
    registerBundledCatalog();
    return resolveModelSpec(modelId, env);
  };
}

/**
 * Whether this runtime knows where `~/.arcturn` is.
 *
 * A type predicate rather than an inline check so the *identity* of the runtime
 * survives the narrowing: `getBackgroundAgentManager` memoizes on the object it
 * is handed, so an engine that is both serving and running a TUI must hand it
 * the same object both times — passing a freshly-built `{ paths, llm, ... }`
 * literal would mint a second manager over the one records directory, which is
 * precisely the thing `serve-background.ts` exists to avoid.
 */
function hasHomePath(runtime: ServableRuntime): runtime is ServableRuntime & BackgroundAgentHost {
  return runtime.paths !== undefined;
}

/**
 * The agent options a runtime with no `buildSessionAgent` gets — the generic
 * assembly, shared by the fresh and the resumed route so a stub runtime cannot
 * end up with two different agent configurations depending on which one ran.
 */
function genericAgentOptions(
  runtime: ServableRuntime,
  opts: AgentFactoryOptions,
  model: ModelSpec,
): AgentOptions {
  return {
    llm: runtime.llm,
    model,
    systemPrompt: runtime.systemPrompt,
    tools: [...runtime.tools],
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    sessionStore: runtime.store,
    compaction: compactionOptionsFor(model),
    permissions: {
      mode: runtime.config.permissionMode,
      rules: [...runtime.config.permissions],
    },
  };
}

/**
 * Adapt {@link serveModelResolver} to what `Agent.resume` wants for the model
 * id it finds recorded in a session file.
 *
 * Same resolver, same catalog, same environment as `createSession` and
 * `setModel` — a session's *restored* model must resolve to the provider,
 * endpoint and credential a freshly picked one would, or a restart would be a
 * silent re-route. Only the failure mode differs: a pick a client just made is
 * refused loudly (`setModel` answers `invalidRequest` and the session stays
 * where it was), while an id recorded months ago that this build no longer
 * registers — or whose provider key is no longer set — must not make the
 * session unopenable. `undefined` leaves the session on the server's default,
 * which is what `Agent.resume` does with it and what `--resume` does in the
 * terminal.
 */
function storedModelResolver(
  resolveModel: (modelId: string) => ModelSpec,
): (modelId: string) => ModelSpec | undefined {
  return (modelId) => {
    try {
      return resolveModel(modelId);
    } catch {
      return undefined;
    }
  };
}

/**
 * Build — or, for a session that already exists in the store, **resume** — the
 * `Agent` backing one served session. See {@link ServableRuntime}.
 *
 * `opts.resume` is set by `SessionHost.openSession` and never by
 * `createSession`. Without the resume branch this function was the whole of
 * the reported bug: reopening a session from the history list built a fresh,
 * empty agent on the same session id, so the panel replayed nothing (the live
 * agent's `leafEntryId` was `null`, which `sessionHistory` correctly reads as
 * an empty branch) *and* the model was asked to continue a conversation it had
 * never been shown. One call fixes both, because both read the same branch.
 */
async function buildServedAgent(
  runtime: ServableRuntime,
  opts: AgentFactoryOptions,
  maxCostUsd: number | undefined,
  resolveModel: (modelId: string) => ModelSpec,
  rewind: ServeRewind | undefined,
): Promise<Agent> {
  // The model a client explicitly asked for, if any. Kept separate from the
  // fallback below because the resume path has to be able to tell "nobody
  // named a model" from "somebody named this one": only in the first case may
  // the model recorded in the session file win.
  const requested = opts.model === undefined ? undefined : resolveModel(opts.model);
  const model = requested ?? runtime.model;
  // A real ArcturnRuntime builds a properly isolated agent — its own checkpoint
  // store keyed by this session, so one served session's /rewind never
  // touches another's files. The structural fallback below keeps this
  // function testable with a minimal stub runtime.
  //
  // The store is handed IN rather than minted inside, when a rewind provider
  // exists: `buildSessionAgent` used to create one and drop the reference, so
  // the manifest was written and nothing could read it back — which is exactly
  // why `/rewind` was unreachable from here. Same store, one owner.
  const checkpoints = rewind?.storeFor(opts.sessionId, opts.cwd ?? runtime.cwd);
  const agent = await (opts.resume === true
    ? resumeServedAgent(runtime, opts, requested, resolveModel, checkpoints)
    : runtime.buildSessionAgent
      ? runtime.buildSessionAgent({
          sessionId: opts.sessionId,
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          model,
          ...(checkpoints === undefined ? {} : { checkpoints }),
        })
      : new Agent(genericAgentOptions(runtime, opts, model)));
  if (maxCostUsd !== undefined) attachCostGuard(agent, maxCostUsd);
  // Every turn this agent runs opens a checkpoint and records where in the
  // conversation it began — the half the terminal gets from `ArcturnRuntime`'s
  // own `#onEvent` and a served session had no equivalent of.
  rewind?.track(opts.sessionId, agent);
  return agent;
}

/**
 * The resume half of {@link buildServedAgent}: one stored session, rebuilt.
 *
 * @param requested - A model the client named on this call, or `undefined`.
 *   When it named one, that wins and the stored id is not consulted at all;
 *   so does a `--model` this process was started with (`runtime.modelPinned`),
 *   for the reason `--resume` gives it precedence in the terminal.
 */
function resumeServedAgent(
  runtime: ServableRuntime,
  opts: AgentFactoryOptions,
  requested: ModelSpec | undefined,
  resolveModel: (modelId: string) => ModelSpec,
  checkpoints: CheckpointStore | undefined,
): Promise<Agent> {
  const restore =
    requested !== undefined || runtime.modelPinned === true
      ? undefined
      : storedModelResolver(resolveModel);
  if (runtime.resumeSessionAgent) {
    return runtime.resumeSessionAgent({
      sessionId: opts.sessionId,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(requested === undefined ? {} : { model: requested }),
      ...(checkpoints === undefined ? {} : { checkpoints }),
      ...(restore === undefined ? {} : { resolveModel: restore }),
    });
  }
  // The generic fallback (a stub runtime, an embedder with no
  // `resumeSessionAgent`). It resumes the same conversation, but its
  // compaction budget is computed here for the model this server booted on
  // rather than for the one `Agent.resume` may restore from the file — a real
  // `ArcturnRuntime` reads the stored model *before* construction precisely to
  // avoid that, and a host that cares should provide `resumeSessionAgent`.
  return Agent.resume({
    ...genericAgentOptions(runtime, opts, requested ?? runtime.model),
    sessionStore: runtime.store,
    sessionId: opts.sessionId,
    ...(restore === undefined ? {} : { resolveModel: restore }),
  });
}

/**
 * Assemble a {@link SessionHost} around a runtime's LLM, model, tools and
 * session store.
 *
 * Exported (separately from {@link runServe}) so tests can exercise the
 * `SessionHost`/`ArcturnServer` wiring against a cheap, scripted runtime instead
 * of the full {@link buildRuntime} (config/extension/skill/MCP loading).
 *
 * @param runtime - Anything shaped like {@link ServableRuntime}; a real
 *   {@link ArcturnRuntime} satisfies this without modification.
 * @param options - `maxCostUsd` applies an independent `--max-cost`-style
 *   ceiling to each served session (see {@link buildServedAgent}'s
 *   `attachCostGuard`); `maxAttachmentBytes` overrides the total per-prompt
 *   attachment budget, injectable so a test can prove the cap cuts without
 *   writing a megabyte of scratch files first (see
 *   `ContextResolverOptions.maxAttachmentBytes`).
 */
export function createServeHost(
  runtime: ServableRuntime,
  options: { maxCostUsd?: number; maxAttachmentBytes?: number } = {},
): SessionHost {
  const resolveModel = serveModelResolver(runtime.env);
  // The `/bg` registry, over the runtime's own memoized manager. `undefined`
  // for a runtime with no `paths` (a stub, an embedder), which the verbs report
  // as "this server was built without a background-agent manager" rather than
  // as an empty list — those are different facts and only one of them means the
  // feature is absent. See `serve-background.ts` for what a remotely-started
  // agent is capped by, which is everything except its task.
  const backgroundAgents = hasHomePath(runtime)
    ? backgroundAgentRegistry(getBackgroundAgentManager(runtime))
    : undefined;
  // The org-memory store, over the same file `/org memory` reads. `undefined`
  // without a project path, because the store's filename is a hash of it.
  const orgMemory = runtime.paths === undefined ? undefined : serveOrgMemoryStore(runtime.paths);
  // ---- Rewind: one provider, the store side AND both verbs. ------------
  // Built here, before the host, because it has *three* consumers and two of
  // them are not verbs: `buildServedAgent` asks it for the checkpoint store a
  // session records into, `listCheckpoints` asks it what those recordings
  // would cost to undo, and `rewindTo` asks it to apply one. Those have to be
  // the same object — a store written by one and read by another would list
  // turns nobody recorded and restore blobs nobody wrote, and the symptom
  // would be a rewind that silently did nothing, which is the one outcome
  // this verb's contract forbids. See `serve-rewind.ts`.
  //
  // `undefined` for a runtime that cannot fork a conversation (a stub, an
  // embedder), which the verbs report as `available: false` rather than as an
  // empty picker.
  const rewind =
    runtime.forkSessionAgent && runtime.paths
      ? createServeRewind({
          paths: runtime.paths,
          cwd: runtime.cwd,
          forkSessionAgent: runtime.forkSessionAgent.bind(runtime),
        })
      : undefined;
  // One closure, two consumers: the `/` menu (`commands`, below) and the
  // expander that runs what the menu offered (`contextResolver`, below that).
  // They are the same feature seen from two sides — a listed command must be
  // one `prompt` can expand, and an expandable one must be listed — so they
  // read one array rather than each reaching for `runtime.skills` themselves.
  // This is the `resolveModel`/`modelCatalog` lesson applied before it bites:
  // that pair got separated once and drifted into a real routing bug.
  const skills = (): readonly Skill[] => runtime.skills ?? [];
  // Built once, next to the injection that uses it, so the four workflow verbs
  // can never be handed two different engines. See the `workflows:` line below.
  const workflows = createServeWorkflows(runtime, {
    // A "[tag]" is a catalog id or a preset name, resolved through the same
    // catalog `/model` and the terminal's `/workflow` use. An unknown id
    // resolves to `undefined`, which fails the run before any step spends a
    // token rather than silently running on the wrong model.
    resolveModelTag: (tag) => {
      // A tier tag is an intent the runtime's router maps onto this
      // deployment's config; a concrete id resolves through the catalog. The
      // same split `composeTagResolver` makes for the terminal — duplicated
      // here only because this closure predates it and already carries the
      // serve path's own catalog registration.
      if (tag.startsWith("tier:")) {
        const name = tag.slice("tier:".length).trim();
        return name === "" ? undefined : runtime.router?.specForTier(name);
      }
      try {
        registerBundledCatalog();
        return resolveModelSpec(tag, runtime.env);
      } catch {
        return undefined;
      }
    },
  });
  return new SessionHost({
    agentFactory: (opts) =>
      buildServedAgent(runtime, opts, options.maxCostUsd, resolveModel, rewind),
    // ---- Store injection: one store, four verbs, deliberately one line. ----
    // `listSessions`, `openSession`'s fallback, `sessionHistory` and
    // `deleteSession` are all answered from this one reference. Nothing else
    // needs wiring for the last two: history reads `store.entries` and
    // deletion calls `store.delete`, both on the store that was already here.
    // Which is the point of writing it down — the `resolveModel`/`modelCatalog`
    // pair below got separated once and the two halves drifted into a real
    // routing bug, so the rule this file now keeps is that anything one
    // injection serves stays at one injection, with its consumers named.
    //
    // A `SessionStore` that does not implement the optional `delete` makes
    // `SessionHost.deleteSession` refuse loudly rather than unlink anything
    // itself; `JsonlSessionStore` (what a real `ArcturnRuntime` supplies)
    // implements it.
    sessionStore: runtime.store,
    defaultCwd: runtime.cwd,
    // ---- Context injection: the fix for RFC 0005 §0's bug, in one line. ----
    // `expandMentions` ran in `print.ts` and the TUI and nowhere else, so a
    // prompt arriving over this server reached the model as text *about* a file
    // rather than the file. This is what closes that, and it is the same
    // function the TUI calls rather than a second one — see `context.ts`.
    //
    // It serves three consumers and stays at one injection, the rule the
    // `resolveModel`/`modelCatalog` pair below had to learn the hard way:
    // `prompt` expands mentions through it, `prompt` reads `attachments`
    // through it, and `resolveContext` answers a file picker from it. All
    // three share one workspace-confinement gate and one set of size caps
    // *because* they share one resolver; wiring a second would be how the
    // preview a picker shows and the file a prompt reads start disagreeing.
    //
    // It also expands a leading `/name` into the named skill's body — RFC 0005
    // §1.3's other half. Listing a command a `prompt` could not run would be
    // the lying menu §3 rules out, and the `skill` tool is not a substitute:
    // that is the model *noticing* text and choosing to act on it, which is
    // not the same thing as a command running.
    contextResolver: createContextResolver({
      skills,
      // The engine reads an MCP resource, never the client — the rule every
      // other attachment kind follows, and the reason the byte budget above
      // still applies to bytes that came off a remote server.
      readMcpResource: async (server: string, uri: string) => {
        const contents = await mcpResourceRead(runtime.mcp, server, uri);
        return contents.contents
          .map((block) => block.text ?? "(binary content, not included)")
          .join("\n\n");
      },
      ...(options.maxAttachmentBytes === undefined
        ? {}
        : { maxAttachmentBytes: options.maxAttachmentBytes }),
    }),
    // ---- Model injection: both halves, deliberately adjacent. ----
    // These are one feature, not two. `modelCatalog` is what a remote picker
    // is *offered*; `resolveModel` is what a pick actually *does* — which
    // provider, which endpoint, which credential. They read the same catalog
    // and the same environment, and they sit together because wiring only one
    // is not a partial feature but a wrong one: a `setModel` that reaches a
    // host with no resolver used to be answered by a synthesized spec, which
    // sent the session's next prompt to whichever provider the guess named.
    //
    // The `listModels` verb answers from the same catalog `--list-models`
    // prints — `registerBundledCatalog` first, so the presets are in it, and
    // it is idempotent. Re-read on every call rather than snapshotted: an
    // extension may register a model after the server is already up.
    modelCatalog: () => {
      registerBundledCatalog();
      return modelCatalogEntries(runtime.env);
    },
    resolveModel,
    // ---- Command injection: the same skills the terminal already loaded. ----
    // `buildRuntime` ran `loadSkills` once, registered a slash command per
    // skill and handed the same array to the model-invoked `skill` tool; this
    // reads that array rather than scanning the skills directory again. A
    // second scan is how a panel's `/` menu comes to list a skill the terminal
    // resolved differently under a name collision.
    //
    // Re-read on every call rather than snapshotted, matching `modelCatalog`
    // directly above: skills do not reload after startup today, but a future
    // watcher must not need this wiring changed to be picked up.
    //
    // The built-ins folded in alongside are chosen in `@arcturn/server` — the
    // package that knows which verbs exist, and therefore which commands this
    // wire can actually carry out. See `serve-commands.ts`.
    // Async because the MCP half is a round trip to every connected server.
    // A server that is slow or down costs the menu its prompts and nothing
    // else — `mcpPromptList` swallows the failure — because a `/` menu that
    // fails to open because a remote server is unreachable is a worse outcome
    // than one missing a row.
    commands: async () =>
      serveCommandDescriptors(skills(), (await mcpPromptList(runtime.mcp)).prompts),
    // ---- Export injection: one renderer, two front-ends. ----
    // `exportMarkdown`/`exportHtml` are what the terminal's `/export` already
    // calls; this hands the server the same two functions rather than a second
    // pair, so a transcript cannot look one way in a terminal and another over
    // a socket. The filename suggester travels with them for the reason the
    // model pair below travels together: a document and the name it is offered
    // under are one feature, and wiring half of it produces a `.md` file full
    // of HTML.
    //
    // Nothing here writes. The document goes back down the socket and the
    // *client* saves it — see `@arcturn/server`'s `session-export.ts`.
    transcriptExporter: {
      render: ({ messages, format, includeThinking, model, exportedAt }) =>
        format === "html"
          ? exportHtml(messages, { model, exportedAt }, { showThinking: includeThinking })
          : exportMarkdown(messages, { model, exportedAt }, { showThinking: includeThinking }),
      suggestFilename: ({ format, exportedAt }) =>
        suggestExportFilename({ exportedAt }, format === "html" ? "html" : "md"),
    },
    // ---- MCP injection: names and status, decided where the secrets are. ----
    // The manager holds a config with `env`, `args`, `headers` and a `url` in
    // it. `@arcturn/server` cannot see any of that, so the choice of what
    // leaves is made in `serve-mcp.ts` — next to the credential rather than
    // three packages away from it — and re-validated on the way out by
    // `validateMcpStatus`, which copies four fields by name.
    //
    // Re-read on every call rather than snapshotted, matching `modelCatalog`
    // and `commands` above: a server's state is the whole point of the verb,
    // and a snapshot taken at startup would report every server disconnected
    // forever.
    mcpStatus: () => mcpServerSummaries(runtime.mcp),
    // The other two thirds of MCP. A server publishes tools, *resources* and
    // *prompt templates*; Arcturn used only the first until now, so a Figma
    // server could be called but the frame it offers could not be attached,
    // and a Linear server's "triage this" template was invisible. The
    // projection — including sanitizing every description a remote server
    // wrote — is in `serve-mcp.ts`, next to the manager, for the reason the
    // status projection is: decide what leaves beside the thing that said it.
    mcpCatalog: {
      resources: (server?: string) => mcpResourceList(runtime.mcp, server),
      readResource: (server: string, uri: string) => mcpResourceRead(runtime.mcp, server, uri),
      prompts: (server?: string) => mcpPromptList(runtime.mcp, server),
      getPrompt: (server: string, name: string, args?: Record<string, string>) =>
        mcpPromptRender(runtime.mcp, server, name, args),
    },
    // ---- MCP authorization: the browser is the client's, the tokens are ours.
    // The engine's own loopback redirect is only correct when the browser can
    // reach `127.0.0.1` *here*, which an editor attached over SSH, in a
    // devcontainer or in a Codespace cannot. So the client brings a redirect it
    // can catch and hands back the code; discovery, registration, PKCE and the
    // credential file all stay in this process, where they already were.
    ...(runtime.paths === undefined
      ? {}
      : {
          // Re-resolved from `home` and `cwd` rather than assembled here, so
          // the layout of `mcp.json` and `auth/` stays known in exactly one
          // module. A runtime without `paths` is a stub or an embedder, and
          // gets no authorization verbs rather than a guessed home directory.
          mcpAuth: createMcpAuthBroker({
            paths: resolveArcturnPaths({ home: runtime.paths.home, cwd: runtime.cwd }),
          }),
        }),
    // ---- Scouts: a record, so a socket can watch one -----------------------
    // `/scout` was off the wire because a run left nothing behind to report on
    // or cancel. `ScoutRegistry` is that record. The worktrees are still torn
    // down in `runScouts`' own `finally`; what survives is each scout's diff,
    // captured into memory before the directory goes.
    ...(runtime.scoutAgent === undefined || runtime.recordExternalCost === undefined
      ? {}
      : {
          scouts: new ScoutRegistry({
            run: async ({ approaches, signal, onResult }) => {
              const report = await runScouts({
                approaches,
                spawn: (_approach, cwd) => scoutAgentOf(runtime)(cwd),
                deadlineMs: SERVE_SCOUT_DEADLINE_MS,
                repoRoot: runtime.cwd,
                signal,
                onResult,
              });
              // Folded back for the reason the terminal folds it back: a scout
              // spends outside the main agent's event stream, so `/cost` and
              // `--max-cost` would under-report without this.
              for (const result of report.results) {
                runtime.recordExternalCost?.(result.costUsd);
              }
              return report;
            },
          }),
        }),
    // ---- Workflow injection: one engine, four verbs, one line. -----------
    // `/workflow` is a markdown file the workspace holds, a numbered list that
    // is real control flow, roles with derived lanes, a spend ceiling and a
    // resumable journal. None of it was reachable from a socket, so a panel
    // attached to an engine full of pipelines could not see that they existed.
    //
    // `listWorkflows`, `runWorkflow`, `workflowStatus` and `resumeWorkflow` are
    // all answered from this one object, and it stays one object for the reason
    // the dry-run block below records: the `resolveModel`/`modelCatalog` pair
    // was split once and the halves drifted into a real routing bug. Here the
    // halves would be worse — a catalog built from one workflow root and a run
    // started against another would run a pipeline nobody was shown.
    //
    // It is the runtime's OWN workflow engine: the same `discoverWorkflows`,
    // the same lane classifier, the same `runWorkflow` loop, the same journal
    // directory the terminal's `/workflow status` reads. `@arcturn/server`
    // never parses a workflow itself; there is no second engine on this path.
    //
    // The model-tag resolver is the same one `createCommandRegistry` hands the
    // slash command, threaded rather than re-derived — a `[tag]` has to name
    // the same model in a panel that it names in a terminal.
    //
    // `undefined` for a runtime that cannot drive one (no `paths`, no
    // `createSubagent`), which the host reports as "this engine has no workflow
    // engine" rather than as an empty catalog.
    ...(workflows === undefined ? {} : { workflows }),
    // ---- Dry-run injection: one overlay, three verbs, one line. ----------
    // `--dry-run` reroutes every write/edit into a shadow copy of the
    // workspace so a person reviews the change before it lands. That loop was
    // reachable only from a terminal (`/diff`, `/apply`, `/discard`), which
    // meant a remote client attached to a dry-run engine watched an agent
    // appear to do nothing at all.
    //
    // `pendingChanges`, `applyChanges` and `discardChanges` are all answered
    // from this one reference, and it stays one reference for the reason the
    // block above records: the `resolveModel`/`modelCatalog` pair was split
    // once and the halves drifted into a real routing bug. Here the stakes are
    // higher — a list built from one overlay and an apply run against another
    // would land changes nobody reviewed.
    //
    // It is the runtime's OWN overlay, the same object the TUI's `/apply`
    // drives, so a remote apply gets the identical symlink resolution and
    // atomic write a local one does. `@arcturn/server` never writes a file
    // itself; there is no second applier anywhere on this path.
    //
    // `undefined` when the engine is not in dry-run mode, which the verbs
    // report as `dryRun: false` rather than as an empty list.
    ...(runtime.overlay === undefined ? {} : { dryRunOverlay: runtime.overlay }),
    // ---- Rewind injection: the same provider `agentFactory` records into. --
    // `listCheckpoints` reads its plans and `rewindTo` applies them, and both
    // walk the store the session's own `write`/`edit` calls snapshotted into —
    // because it is one object, built above. The restorer is the engine's own
    // `CheckpointStore`: the workspace confinement that refuses a manifest
    // record outside the session's cwd, the content-addressed blobs and the
    // atomic writes are the same code the TUI's `/rewind` runs.
    // `@arcturn/server` never touches a file on this path.
    ...(rewind === undefined ? {} : { checkpoints: rewind }),
    // ---- Background agents: one manager, four verbs, one line. ------------
    // `/bg` runs a whole child conversation off-thread with a durable record on
    // disk. None of it rides a session's event stream, so a remote client had
    // no way to see that an engine had four agents running, what they had cost,
    // or what they had said.
    //
    // `backgroundAgents`, `startBackgroundAgent`, `cancelBackgroundAgent` and
    // `adoptBackgroundAgent` are all answered from this one reference, and it
    // stays one reference for the reason the dry-run block above records. Here
    // the failure mode is sharper still: two registries over one records
    // directory would each run the other's crash recovery, and the second one
    // to load would mark the first one's live agents `interrupted`.
    //
    // It is the runtime's OWN manager — `getBackgroundAgentManager` is memoized
    // by runtime identity, so an engine that is both serving and running a TUI
    // hands both surfaces the same instance, the same queue and the same
    // concurrency cap.
    //
    // Resolved eagerly, here, rather than lazily on the first client request.
    // Constructing a manager adopts the records directory and runs its
    // crash-recovery pass, and that is a startup event of this process, not
    // something a read verb should cause halfway through somebody's session.
    ...(backgroundAgents === undefined ? {} : { backgroundAgents }),
    // ---- Org memory: one store, three verbs, and the fourth left out. -----
    // Read the per-role lessons, propose an inert one, take one back. There is
    // deliberately no injection point for approving one: an `active` entry is
    // standing instruction text in every later run of its role, and the gate on
    // it is a person at the machine. `serve-org-memory.ts` carries the
    // argument, and it is written where the store's own bounds are rather than
    // three packages away from them.
    ...(orgMemory === undefined ? {} : { orgMemory }),
  });
}

/** Options for {@link runServe}. */
export interface RunServeOptions {
  /** Working directory for the served runtime. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Interface to bind. Defaults to `"127.0.0.1"`. */
  host?: string;
  /** Port to bind, or omitted/`0` for an OS-assigned ephemeral port. */
  port?: number;
  /**
   * Shared-secret token clients must present. Omit to auto-generate one;
   * pass `""` to explicitly run without authentication (loopback only — see
   * {@link resolveServeToken}).
   */
  token?: string;
  /** Model id override, as accepted by `--model`. */
  model?: string;
  /**
   * USD cost ceiling applied independently to *each* served session (the
   * `--max-cost` equivalent for `arcturn serve`). Omit to disable. See
   * {@link createServeHost}.
   */
  maxCostUsd?: number;
  /**
   * Also serve the browser client (`web/page.ts`) over HTTP, so a phone or
   * another machine can drive a session without `arcturn attach`. Off by default:
   * it opens a second listener, and the same threat model applies — anyone who
   * can reach the WebSocket port *and* holds the token gets tool execution.
   */
  web?: boolean;
  /**
   * Port for the browser client's HTTP listener. Omitted (or `0`), the OS
   * picks one; the chosen port is reported as {@link RunServeResult.webUrl}.
   */
  webPort?: number;
  /**
   * Extra browser origins allowed to open the WebSocket, e.g.
   * `https://arcturn.my-tailnet.ts.net`. Loopback names, the bound address and
   * this machine's own LAN addresses are allowed automatically; a tunnel or
   * reverse-proxy hostname cannot be guessed and must be listed here. See
   * {@link webClientOrigins}.
   */
  webOrigins?: readonly string[];
  /**
   * `--no-providers`: parse and list every `providers` block, register nothing.
   * Forwarded to {@link buildRuntime}. A served runtime never gets a confirmer
   * — nobody is at a terminal — so a project-declared endpoint is inert here
   * either way; this switch is what also turns off a USER-declared one.
   */
  configProviders?: boolean;
  /**
   * `--trust-providers`: enable project-declared endpoints without asking, for
   * a pipeline that already trusts the repository it checked out.
   */
  trustProviders?: boolean;
}

/** What {@link runServe} hands back to its caller (`main.ts`). */
export interface RunServeResult {
  /** `ws://host:port` clients connect to. */
  url: string;
  /** The token clients must authenticate with, or `undefined` when disabled. */
  token: string | undefined;
  /**
   * `http://host:port` of the browser client, when {@link RunServeOptions.web}
   * asked for it. Deliberately token-free: append `#token=<token>` to hand
   * someone a one-tap link (a fragment is never sent to a server), or let the
   * page prompt for it.
   */
  webUrl?: string;
  /** Stop accepting connections, close every socket, and dispose the runtime. */
  stop: () => Promise<void>;
}

/**
 * Build a runtime and expose it over WebSocket.
 *
 * The token is resolved (and, for a non-loopback bind with no token,
 * refused) *before* the runtime is built, so a doomed invocation fails fast
 * without paying for config/extension/skill loading first.
 *
 * @throws {ServeBindError} See {@link resolveServeToken}.
 */
export async function runServe(options: RunServeOptions = {}): Promise<RunServeResult> {
  const host = options.host ?? "127.0.0.1";
  const token = resolveServeToken(host, options.token);

  const runtime: ArcturnRuntime = await buildRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.configProviders === undefined ? {} : { configProviders: options.configProviders }),
    ...(options.trustProviders === undefined ? {} : { trustProviders: options.trustProviders }),
  });

  const sessionHost = createServeHost(
    runtime,
    options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd },
  );

  // The page server binds *first*: a browser always stamps an `Origin` on the
  // WebSocket upgrade, and `ArcturnServer` refuses every origin it was not given
  // at construction — which means it has to know the page's port already. The
  // reverse dependency (the page needs the socket's port) is resolved lazily,
  // per request, through the `wsPort` callback.
  let wsPort = 0;
  let web: WebClientServer | undefined;
  if (options.web === true) {
    try {
      web = await startWebClientServer({
        host,
        ...(options.webPort === undefined ? {} : { port: options.webPort }),
        wsPort: () => wsPort,
      });
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  const server = new ArcturnServer({
    sessionHost,
    ...(token === undefined ? {} : { token }),
    ...(web === undefined
      ? {}
      : { allowedOrigins: webClientOrigins(host, web.port, options.webOrigins ?? []) }),
  });

  let port: number;
  try {
    port = await server.start({
      host,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  } catch (error) {
    if (web) await web.stop();
    await runtime.dispose();
    throw error;
  }
  wsPort = port;

  let stopped = false;
  return {
    url: formatServeUrl(host, port),
    token,
    ...(web === undefined ? {} : { webUrl: web.url }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop();
      if (web) await web.stop();
      await runtime.dispose();
    },
  };
}

/**
 * Narrow `runtime.scoutAgent` once, where the guard above already proved it.
 *
 * The guard is on the object and the call is inside a closure that runs later,
 * so TypeScript cannot carry the narrowing across on its own.
 */
function scoutAgentOf(runtime: ServableRuntime): (cwd: string) => ScoutAgent {
  const build = runtime.scoutAgent;
  if (build === undefined) throw new Error("this engine has no scout agent factory");
  return build;
}
