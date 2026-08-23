/**
 * Agent assembly: turns configuration into a live {@link Agent} with tools,
 * permissions, session persistence, MCP servers and extensions wired together.
 *
 * The {@link ArcturnRuntime} owns the agent rather than exposing a bare one,
 * because slash commands can replace it (`/clear`, `/sessions`) while the UI
 * keeps a single stable event subscription.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type ConsensusVerdict,
  calculateCostUsd,
  createClient,
  createConsensusClient,
  createFailoverClient,
  DEFAULT_API_KEY_ENV,
  getModel,
  listModels,
  listPresets,
  listProviderIds,
  oauth,
  registerAnthropicOAuthProvider,
  registerOAuthProviderFactories,
  registerPresetModels,
  resolveApiKey,
} from "@arcturn/ai";
import {
  Agent,
  type AgentOptions,
  addUsage,
  type CompactionOptions,
  createDeferredToolset,
  createId,
  createPlanTool,
  createSessionId,
  createSubagentTool,
  createTodoTool,
  DEFAULT_ALWAYS_ACTIVE_TOOLS,
  DEFAULT_ALWAYS_ALLOW_TOOLS,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_READ_ONLY_TOOLS,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_SEARCH_TOOL_NAME,
  type DeferredToolset,
  emptyUsage,
  JsonlSessionStore,
  wrapToolsWithOffload,
} from "@arcturn/core";
import { createSearchCodeTool } from "@arcturn/index";
import type { McpManager } from "@arcturn/mcp";
import { type BackgroundTaskManager, createDefaultTools } from "@arcturn/tools";
import type { Theme as TuiTheme } from "@arcturn/tui";
import type {
  AgentEvent,
  AgentEventListener,
  LLMClient,
  ModelSpec,
  PermissionDecision,
  PermissionMode,
  PermissionPrompt,
  PermissionRequest,
  PermissionRule,
  SessionHeader,
  ThinkingLevel,
  Tool,
  Usage,
} from "@arcturn/types";
import { type AgentDef, loadAgentDefs } from "./agents.js";
import {
  type AuditLog,
  auditedHookRunner,
  auditFilePath,
  auditObserver,
  createAuditLog,
} from "./audit.js";
import { createAuthStore } from "./auth.js";
import {
  type CanaryGuard,
  createCanaryGuard,
  generateCanary,
  wrapToolsWithCanary,
} from "./canary.js";
import {
  type CheckpointStore,
  createCheckpointStore,
  wrapToolsWithCheckpoints,
} from "./checkpoints.js";
import { type ArcturnConfig, loadConfig, persistPermissionRule } from "./config.js";
import { createCostGuard } from "./cost-guard.js";
import { type ExtensionCommand, ExtensionHost, loadExtensions } from "./extensions.js";
import { createHookRunner, type HookRunner, wrapToolsWithHooks } from "./hooks.js";
import { createLspManager, type LspManager } from "./lsp/manager.js";
import { createSymbolsTool } from "./lsp/symbols.js";
import { wrapToolsWithLsp } from "./lsp/wrap.js";
import { createMemoryTool, formatMemoriesForPrompt, loadMemories } from "./memory.js";
import { version } from "./meta.js";
import { createOverlay, type Overlay, wrapToolsWithOverlay } from "./overlay.js";
import { type ArcturnPaths, cwdHash, type EnvMap, resolveArcturnPaths } from "./paths.js";
import { createPolicyLearner, type PolicyLearner } from "./policy-learn.js";
import { createProvenanceStore, type ProvenanceStore, provenanceObserver } from "./provenance.js";
import { createModelRouter, type ModelRouter } from "./router.js";
import { createSkillTool } from "./skill-tool.js";
import { loadSkills, type Skill } from "./skills.js";
import {
  createSpeculation,
  formatSpeculationOutcome,
  type SpeculationController,
  wrapToolsWithSpeculation,
} from "./speculation.js";
import { buildSystemPrompt, collectSystemPromptContext } from "./system-prompt.js";
import {
  createTaintTracker,
  type TaintTracker,
  type TaintVerdict,
  wrapToolsWithTaint,
} from "./taint.js";
import { loadCustomThemes } from "./themes.js";
import { createVerifier, type Verifier, wrapToolsWithVerify } from "./verify.js";

/** Raised when a model id cannot be turned into a usable {@link ModelSpec}. */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

/** Running totals for the current session. */
export interface SessionMetrics {
  /** Completed model turns. */
  turns: number;
  /** Summed token usage. */
  usage: Usage;
  /** Summed cost in USD, best effort. */
  costUsd: number;
}

/** Tool names Arcturn ships with; extensions may not shadow them. */
export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "ls",
  "fetch",
  "websearch",
  "symbols",
  "search_code",
  "memory",
  "todo",
  "plan",
  "subagent",
  "skill",
  "tool_search",
];

/**
 * Default turn budget for one delegated sub-agent or scout.
 *
 * Deliberately below the main loop's ceiling — a delegated task is meant to
 * be self-contained — but high enough that real work fits. Override with
 * `subagentMaxTurns` in config.
 */
const SUBAGENT_MAX_TURNS = 64;

/** How many recent turns are kept for cost forecasting. */
const RECENT_TURN_SAMPLES = 30;

let catalogRegistered = false;

/**
 * Register everything `@arcturn/ai` ships but does not install by default.
 *
 * Two things happen here, both idempotent and both required *before* a model id
 * is resolved or a catalog is printed:
 *
 * 1. {@link registerPresetModels} adds the curated third-party models, so
 *    `--model groq/llama-3.3-70b-versatile` resolves and the preset entries show
 *    up in `--list-models`.
 * 2. The OAuth-only provider adapters (`github-copilot`, `openai-codex`,
 *    `anthropic-oauth`) are registered, so a stored subscription credential is
 *    dispatchable at all.
 *
 * @returns `true` the first time it did the work, `false` on later calls.
 */
export function registerBundledCatalog(): boolean {
  if (catalogRegistered) return false;
  catalogRegistered = true;
  registerPresetModels();
  registerOAuthProviderFactories();
  registerAnthropicOAuthProvider();
  return true;
}

/**
 * Whether a provider authenticates *only* by OAuth, so a missing API key is
 * not a reason to refuse the model.
 *
 * Providers that accept either credential (`anthropic`) keep the API-key check:
 * for them a missing key with no stored token is still worth reporting up front.
 */
function isOAuthOnlyProvider(provider: string): boolean {
  if (provider === oauth.ANTHROPIC_OAUTH_PROVIDER_ID) return true;
  return (
    oauth.getOAuthProviderConfig(provider) !== undefined &&
    DEFAULT_API_KEY_ENV[provider] === undefined
  );
}

/**
 * Resolve a model id against the catalog and verify its API key is present.
 *
 * @param id - Catalog id (`anthropic/claude-sonnet-4-5`) or bare wire name.
 * @param env - Environment consulted for the API key.
 * @throws {ModelResolutionError} When the id is unknown or no key is set.
 */
export function resolveModelSpec(id: string, env: EnvMap = process.env): ModelSpec {
  const spec = getModel(id);
  if (!spec) {
    throw new ModelResolutionError(
      `Unknown model "${id}".\n\n${formatModelCatalog()}\n\n` +
        "Register extra models from an extension with registerModel() from @arcturn/ai.",
    );
  }
  if (
    spec.provider !== "openai-compatible" &&
    !isOAuthOnlyProvider(spec.provider) &&
    !resolveApiKey(spec, { env })
  ) {
    const envVar = spec.apiKeyEnv ?? "the provider API key environment variable";
    throw new ModelResolutionError(
      `No API key found for ${spec.displayName} (${spec.id}).\n` +
        `Set ${envVar} in your environment, or pick another model with --model.`,
    );
  }
  return spec;
}

/** Render the model catalog for `--list-models` and error messages. */
export function formatModelCatalog(): string {
  const models = listModels();
  const width = models.reduce((max, model) => Math.max(max, model.id.length), 0);
  const lines = ["Available models:"];
  for (const model of models) {
    const cost = model.cost
      ? `$${model.cost.input}/$${model.cost.output} per Mtok`
      : "pricing unknown";
    lines.push(
      `  ${model.id.padEnd(width)}  ${model.displayName} · ` +
        `${Math.round(model.contextWindow / 1000)}k ctx · ${cost}`,
    );
  }
  return lines.join("\n");
}

/** Mark used for "this environment variable is set". */
const KEY_PRESENT = "✓";
/** Mark used for "this environment variable is not set". */
const KEY_ABSENT = "✗";

/**
 * Render everything `--model` can reach: registered adapters, named presets and
 * the providers that support subscription sign-in.
 *
 * The preset table is the discovery surface — for each entry it names the
 * protocol spoken, the environment variable holding the key, and whether that
 * variable is set right now, so a user can tell "not configured" from
 * "misconfigured" without reading any docs.
 *
 * @param env - Environment consulted for key presence. Defaults to `process.env`.
 */
export function formatProviderCatalog(env: EnvMap = process.env): string {
  const lines: string[] = ["Registered providers (model spec `provider` field):", ""];
  for (const id of listProviderIds()) lines.push(`  ${id}`);

  const presets = listPresets(env);
  const nameWidth = presets.reduce((max, preset) => Math.max(max, preset.name.length), 0);
  const labelWidth = presets.reduce((max, preset) => Math.max(max, preset.label.length), 0);
  const envWidth = presets.reduce((max, preset) => Math.max(max, preset.apiKeyEnv.length), 0);

  lines.push("", "Provider presets (use --model <preset>/<model>):", "");
  for (const preset of presets) {
    lines.push(
      `  ${preset.name.padEnd(nameWidth)}  ${preset.label.padEnd(labelWidth)}  ` +
        `${preset.protocol.padEnd(9)}  ${preset.apiKeyEnv.padEnd(envWidth)}  ` +
        `${preset.keyPresent ? KEY_PRESENT : KEY_ABSENT}`,
    );
  }
  const configured = presets.filter((preset) => preset.keyPresent).length;
  lines.push(
    "",
    `${KEY_PRESENT} = the API key variable is set in this environment ` +
      `(${configured} of ${presets.length}).`,
  );

  const oauthProviders = oauth.listOAuthProviders().map((id) => String(id));
  lines.push(
    "",
    "Subscription (OAuth) sign-in:",
    "",
    ...oauthProviders.map((id) => `  ${id}`),
    "",
    "  Sign in with `arcturn auth login <provider>`; see `arcturn auth status`.",
    "  These endpoints are UNVERIFIED against live provider docs — see `arcturn auth status`.",
    "",
    "Models registered right now are listed by --list-models.",
  );
  return lines.join("\n");
}

/**
 * Scale the compaction thresholds to the model's context window.
 *
 * `@arcturn/core` defaults to reserving 16k tokens and keeping 20k of recent
 * history, which is right for a 200k window but larger than the whole window of
 * a small model — and `shouldCompact` then returns `true` on every turn, so the
 * agent tries (and fails) to compact an empty conversation. Capping both to a
 * fraction of the window keeps the behaviour sane at any size.
 *
 * @param model - The model whose context window sets the budget.
 */
export function compactionOptionsFor(model: ModelSpec): CompactionOptions {
  const window = Math.max(1, model.contextWindow);
  return {
    reserveTokens: Math.max(1_024, Math.min(DEFAULT_RESERVE_TOKENS, Math.floor(window * 0.15))),
    keepRecentTokens: Math.max(
      2_048,
      Math.min(DEFAULT_KEEP_RECENT_TOKENS, Math.floor(window * 0.4)),
    ),
  };
}

/** The system prompt handed to sub-agents. */
export function subagentSystemPrompt(cwd: string, canMutate: boolean): string {
  return [
    "You are a Arcturn sub-agent: a focused child agent handling one delegated task.",
    `Working directory: ${cwd}`,
    canMutate
      ? "You have the full tool set. Make the changes the task asks for."
      : "You have read-only tools (read, grep, glob, ls, fetch). Investigate and report; " +
        "you cannot modify anything.",
    "You cannot ask the user questions. Finish the task and answer with exactly the result " +
      "the parent agent needs — concrete file paths, line numbers and findings, no preamble.",
  ].join("\n");
}

/**
 * Identity of a permission rule, for de-duplicating merged rule lists.
 *
 * All four fields matter: the same tool and specifier with a different
 * `action` or `scope` is a genuinely different rule, and collapsing those
 * would silently drop a `deny` or relabel a grant's scope. An absent
 * specifier keys as `"*"` because `matchSpecifier` already treats the two
 * identically — they are one rule, not two.
 *
 * @param rule - The rule to key.
 */
function ruleKey(rule: PermissionRule): string {
  return `${rule.scope}\u0000${rule.tool}\u0000${rule.specifier ?? "*"}\u0000${rule.action}`;
}

/**
 * Stamp a delegating agent's label onto one permission request.
 *
 * The label travels on the request itself rather than through a side channel
 * so it survives every hop between the tool that asked and the dialog that
 * renders it, and so a host that does not know about attribution simply
 * ignores an extra field. It is read by the prompt and by nothing else: the
 * permission engine has already run by the time this is applied, so no
 * decision can turn on it.
 *
 * An unlabelled request is returned **as-is**, not copied with the key set to
 * `undefined` — the main agent's prompt has to be indistinguishable from what
 * it was before attribution existed, down to the shape of the object a host
 * receives.
 *
 * @param request - The request on its way to the host.
 * @param origin - The delegating agent's label, or `undefined` when the call
 *   was not delegated.
 */
function attributeRequest(request: PermissionRequest, origin?: string): PermissionRequest {
  return origin === undefined || origin === "" ? request : { ...request, origin };
}

/** Construction data for {@link ArcturnRuntime}. @internal */
export interface ArcturnRuntimeInit {
  config: ArcturnConfig;
  paths: ArcturnPaths;
  env: EnvMap;
  model: ModelSpec;
  llm: LLMClient;
  store: JsonlSessionStore;
  backgroundTasks: BackgroundTaskManager;
  extensions: ExtensionHost;
  warnings: string[];
  baseTools: Tool[];
  /** Outermost tool wrapper (VCR record/replay). */
  wrapAgentTools?: (tools: Tool[]) => Tool[];
  /** The same tools *before* hook wrapping. */
  preHookTools: Tool[];
  /** Session id for the first agent; minted by `buildRuntime`. */
  sessionId?: string;
  hookRunner: HookRunner;
  lsp: LspManager | undefined;
  verifier: Verifier | undefined;
  overlay: Overlay | undefined;
  speculation: SpeculationController | undefined;
  taint: TaintTracker;
  canary: CanaryGuard;
  router: ModelRouter;
  agents: Map<string, AgentDef>;
  themes: Map<string, TuiTheme>;
  systemPrompt: string;
  permissionMode: PermissionMode;
  maxTurns?: number;
  onPermissionAsk?: PermissionPrompt;
}

/** The assembled agent plus everything the UI and commands need. */
export class ArcturnRuntime {
  /** The live agent. Replaced by {@link ArcturnRuntime.startNewSession} and friends. */
  agent: Agent;
  /** The model currently in use. */
  model: ModelSpec;
  /** Connected MCP servers, populated by {@link connectMcp}. */
  mcp: McpManager | undefined;
  /** Active cost ceiling in USD, `0` when disabled. */
  costLimitUsd = 0;
  /** Running token/cost totals for the live session. */
  metrics: SessionMetrics = { turns: 0, usage: emptyUsage(), costUsd: 0 };

  /** The LLM client shared by the agent and its sub-agents. */
  readonly llm: LLMClient;
  /** The merged configuration. */
  readonly config: ArcturnConfig;
  /** Resolved filesystem layout. */
  readonly paths: ArcturnPaths;
  /** Absolute working directory. */
  readonly cwd: string;
  /** Environment this runtime resolves credentials against. */
  readonly env: EnvMap;
  /** Session store backing this working directory. */
  readonly store: JsonlSessionStore;
  /** Background bash task manager. */
  readonly backgroundTasks: BackgroundTaskManager;
  /** Loaded extensions. */
  readonly extensions: ExtensionHost;
  /** Checkpoint store for the current session; replaced on session swaps. */
  checkpoints!: CheckpointStore;
  /** Language-server manager when `lsp: "on"`, else undefined. */
  readonly lsp: LspManager | undefined;
  /** Append-only audit trail for the CURRENT session when `audit: true`. */
  audit: AuditLog | undefined;
  /** Reasoning-level provenance for the CURRENT session when `provenance: true`. */
  provenance: ProvenanceStore | undefined;
  #openProvenance: ((sessionId: string) => ProvenanceStore) | undefined;
  #detachProvenance: (() => void) | undefined;
  /** How to open an audit log for a session id; set when auditing is on. */
  #openAudit: ((sessionId: string) => AuditLog) | undefined;
  /** Detaches the audit observer when the session is swapped. */
  #detachAudit: (() => void) | undefined;
  /** Post-edit verify runner when a `verify` command is configured. */
  readonly verifier: Verifier | undefined;
  /** Shadow workspace when `dryRun` is on, else undefined. */
  readonly overlay: Overlay | undefined;
  /** Speculative-edit controller when `speculation` is on. */
  readonly speculation: SpeculationController | undefined;
  /** Tracks text that entered the conversation from untrusted sources. */
  readonly taint: TaintTracker;
  /** Guards registered canary tokens from leaving via an egress tool. */
  readonly canary: CanaryGuard;
  /** Learns permission rules from repeated decisions; suggests, never applies. */
  readonly policy: PolicyLearner = createPolicyLearner();
  /** Recent per-turn usage, for cost forecasting. Capped ring buffer. */
  readonly recentTurns: { inputTokens: number; outputTokens: number; costUsd: number }[] = [];
  /** Most recent consensus verdicts, newest last. */
  readonly consensusVerdicts: { agreement: string; details: string[] }[] = [];
  /** Per-role model routing. */
  readonly router: ModelRouter;
  /** Markdown sub-agent definitions, keyed by name. */
  readonly agents: Map<string, AgentDef>;
  /** Custom themes loaded from ~/.arcturn/themes and <cwd>/.arcturn/themes. */
  readonly themes: Map<string, TuiTheme>;
  /** Non-fatal problems collected during assembly. */
  readonly warnings: string[];

  readonly #env: EnvMap;
  readonly #maxTurns: number | undefined;
  readonly #baseTools: Tool[];
  /** Base tools before the hook wrap, so checkpoints can sit inside the veto. */
  readonly #preHookTools: Tool[];
  readonly #wrapAgentTools: (tools: Tool[]) => Tool[];
  readonly #hookRunner: HookRunner;
  /** Cost of the consensus secondaries that ran for the current turn. */
  #pendingPanelCostUsd = 0;
  /** Model that answered the current turn; may differ from the chain head. */
  #answeringModel: ModelSpec | undefined;
  /** turnId → conversation position, recorded at each runStart. */
  readonly #turnLinks = new Map<string, { sessionId: string; leafId: string | null }>();
  readonly #systemPrompt: string;
  readonly #initialMode: PermissionMode;
  readonly #listeners = new Set<AgentEventListener>();
  #requester: PermissionPrompt | undefined;
  /**
   * Permission rules granted DURING this run — every `persistRule` a live
   * prompt came back with, in the order the user approved them, whatever their
   * scope. Only a human answering a prompt can put a rule here: the model has
   * no path to {@link @arcturn/types#PermissionDecision.persistRule}, and a
   * session with no requester (`--print`) denies instead of granting.
   *
   * Kept on the RUNTIME, not on {@link ArcturnRuntime.agent}, because the agent
   * that asked is often not the agent that needs the answer: a `/workflow`
   * role runs as a sub-agent or as its own session agent, so a grant recorded
   * only on the asking engine dies with it. See
   * {@link ArcturnRuntime.livePermissionRules} for the blast radius this buys.
   */
  readonly #sessionRules: PermissionRule[] = [];
  #detach: (() => void) | undefined;
  /** MCP tools before hook wrapping, for the per-agent chain. */
  #mcpToolsRaw: Tool[] = [];
  /** Shared per-session offload directory, so MCP re-wraps land beside base-tool offloads. */
  readonly #offloadDir: string;
  /**
   * The runtime's OWN live agent's deferred-disclosure holder — a stable box
   * whose `.toolset` attachMcpTools mutates in place on an MCP reconnect so
   * the live agent's already-captured getTools closure sees the new tools.
   * Foreign session agents keep their own holder in their own closure and are
   * never reachable through this field.
   */
  #liveDeferred: { toolset: DeferredToolset } | undefined;
  #started = false;

  /** @internal Use {@link buildRuntime}. */
  constructor(init: ArcturnRuntimeInit) {
    this.config = init.config;
    this.paths = init.paths;
    this.cwd = init.paths.cwd;
    this.#env = init.env;
    this.env = init.env;
    this.model = init.model;
    this.llm = init.llm;
    this.store = init.store;
    this.backgroundTasks = init.backgroundTasks;
    this.extensions = init.extensions;
    this.warnings = init.warnings;
    this.#baseTools = init.baseTools;
    this.#preHookTools = init.preHookTools;
    this.#wrapAgentTools = init.wrapAgentTools ?? ((tools) => tools);
    this.#hookRunner = init.hookRunner;
    this.lsp = init.lsp;
    this.verifier = init.verifier;
    this.overlay = init.overlay;
    this.speculation = init.speculation;
    this.taint = init.taint;
    this.canary = init.canary;
    this.router = init.router;
    this.agents = init.agents;
    this.themes = init.themes;
    this.#systemPrompt = init.systemPrompt;
    this.#initialMode = init.permissionMode;
    this.#maxTurns = init.maxTurns;
    this.#requester = init.onPermissionAsk;
    this.#offloadDir = join(init.paths.home, "offload", init.sessionId ?? createSessionId());
    this.agent = this.#createAgent(
      init.sessionId === undefined ? {} : { sessionId: init.sessionId },
    );
    this.#started = true;
    this.#attach(this.agent);
  }

  /** The permission mode currently in force. */
  get permissionMode(): PermissionMode {
    return this.agent.permissionMode;
  }

  /** The full system prompt handed to the model. */
  get systemPrompt(): string {
    return this.#systemPrompt;
  }

  /** Tools currently offered to the model. */
  get tools(): readonly Tool[] {
    return this.agent.tools;
  }

  /**
   * Subscribe to the agent event stream. The subscription survives session
   * changes, unlike `agent.subscribe`.
   *
   * @param listener - Called for every event of the live agent.
   * @returns An unsubscribe function.
   */
  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Replace the permission requester (the UI dialog, or an auto-deny in
   * `--print` mode) for {@link ArcturnRuntime.agent} — the runtime's own single
   * "live" agent (TUI / `--print` / `--resume`).
   *
   * This slot is deliberately *not* consulted by an agent built through
   * {@link ArcturnRuntime.buildSessionAgent} with its own `onPermissionAsk`: a
   * host running several concurrent sessions off one runtime (`arcturn acp`,
   * `arcturn serve`) must give each session agent its own requester at
   * construction time instead of ever calling this method, or two sessions'
   * permission checks could race for the same shared slot. See
   * `acp/host.ts`'s module doc.
   *
   * @param requester - New requester, or `undefined` to deny unmatched checks.
   */
  setPermissionRequester(requester: PermissionPrompt | undefined): void {
    this.#requester = requester;
  }

  /**
   * Switch models mid-session.
   *
   * @param id - Catalog id or bare wire name.
   * @throws {ModelResolutionError} When the model is unknown or unusable.
   */
  setModel(id: string): ModelSpec {
    const spec = resolveModelSpec(id, this.#env);
    this.model = spec;
    this.agent.setModel(spec);
    // Routes that default to "the main model" must follow the switch, or a
    // sub-agent created afterwards silently keeps billing the old one.
    this.router.rebind(spec);
    return spec;
  }

  /**
   * Change the permission mode for the rest of the session.
   *
   * @param mode - New mode.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.agent.setPermissionMode(mode);
  }

  /**
   * Change the extended-thinking level.
   *
   * @param level - New level.
   */
  setThinking(level: ThinkingLevel): void {
    this.agent.setThinking(level);
  }

  /**
   * The permission rules every agent this runtime builds starts life with:
   * the config-file rules, plus the live agent's own current rule set, plus
   * every rule granted mid-run through a prompt ({@link ArcturnRuntime.agent}'s
   * or any child's). Duplicates are collapsed; config rules keep their order
   * and stay first, so nothing that was already decided changes rank.
   *
   * WHY children inherit session-scoped grants. "Always allow (session)" is one
   * human decision about one tool on one machine for the length of this run.
   * A `/workflow` pipeline farms the same run out to seven role agents, and
   * seeding those from `config.permissions` alone made the user re-answer the
   * identical prompt once per role, forever — the decision they had already
   * made was invisible to everything except the engine that happened to ask.
   * So a session grant belongs to the RUN, not to the engine instance.
   *
   * Blast radius, stated plainly: a rule granted here reaches every agent this
   * runtime builds afterwards — the live agent (including the one `/clear`
   * mints), sub-agents from {@link ArcturnRuntime.createSubagent}, and session
   * agents from {@link ArcturnRuntime.buildSessionAgent}, which for `arcturn
   * serve` / `arcturn acp` means the OTHER conversations of that same local
   * user. It reaches nothing else: the boundary is this process and this
   * runtime object. A session-scoped rule is still never written to disk
   * (`persistPermissionRule` ignores that scope), never widens to project or
   * user scope, and dies when the process does.
   *
   * This can only ever ADD, never subtract: every configured rule is still in
   * the list a child receives, denies included, in its original order. The
   * resulting invariant is "a child resolves a call exactly as the agent that
   * spawned it would" — the added rules are precisely the ones already in
   * force upstream, ranked by the same `matchRules` precedence, so a child
   * can neither lose a deny the parent honours nor gain an allow the parent
   * does not have.
   *
   * An inherited `allow` also still buys nothing beyond the child's own
   * ceiling: a narrowed permission mode is checked BEFORE rules (a plan-mode
   * child is denied every mutating tool whatever the rules say), and a child
   * only ever sees the tools {@link ArcturnRuntime.createSubagent} handed it —
   * an allow for a tool it does not have is inert.
   *
   * @returns A fresh array; mutating it does not affect the runtime.
   */
  livePermissionRules(): PermissionRule[] {
    const merged: PermissionRule[] = [];
    const seen = new Set<string>();
    const add = (rule: PermissionRule): void => {
      const key = ruleKey(rule);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(rule);
    };
    for (const rule of this.config.permissions) add(rule);
    // `#started` guards the constructor's own first `#agentOptions` call, where
    // `this.agent` is still being constructed and cannot be read.
    // Reading the live engine as well as `#sessionRules` also picks up rules a
    // host or extension added straight through `Agent.addPermissionRule`.
    if (this.#started) for (const rule of this.agent.permissions.rules) add(rule);
    for (const rule of this.#sessionRules) add(rule);
    return merged;
  }

  /**
   * Record a rule the user just approved at a prompt, and store it durably
   * when its scope says it should outlive the run.
   *
   * Every agent this runtime builds routes `onPersistRule` here — the live
   * agent, sub-agents and session agents alike — so a grant answered inside
   * stage 1 of a pipeline is already in place when stage 2 is built.
   *
   * @param rule - The rule carried by the decision.
   */
  #persistRule(rule: PermissionRule): void {
    if (!this.#sessionRules.some((existing) => ruleKey(existing) === ruleKey(rule))) {
      this.#sessionRules.push(rule);
    }
    // Session-scoped rules are dropped by `persistPermissionRule`; project and
    // user ones land in the matching config file, exactly as before.
    void persistPermissionRule(rule, this.paths).catch(() => undefined);
  }

  /** Session headers for this working directory, newest first. */
  async listSessions(): Promise<SessionHeader[]> {
    try {
      return await this.store.list();
    } catch {
      return [];
    }
  }

  /** Start a brand-new empty session, discarding the current conversation. */
  startNewSession(): Agent {
    const next = this.#createAgent({});
    this.#swap(next);
    return next;
  }

  /**
   * Resume a stored session in place.
   *
   * @param sessionId - Session to resume.
   */
  async resumeSession(sessionId: string): Promise<Agent> {
    const next = await Agent.resume({
      ...this.#agentOptions({ sessionId }),
      sessionStore: this.store,
      sessionId,
      // Speculation only has anything to shelter if a second tool call can
      // run while the first one's permission prompt is open — with strictly
      // sequential tools the whole feature is inert.
      ...(this.speculation === undefined ? {} : { parallelTools: true }),
    });
    this.#swap(next);
    return next;
  }

  /**
   * Replace the MCP tool set offered to the model.
   *
   * @param tools - Bridged MCP tools.
   */
  attachMcpTools(tools: Tool[]): void {
    // MCP tools arrive after construction, so they need their own wrap — the
    // base tools were wrapped in buildRuntime. Without this, a hook matcher
    // like "mcp_*" would silently never fire.
    // MCP tools must traverse the SAME chain as base tools. Missing the
    // speculation wrap in particular let an MCP call — the most opaque egress
    // surface there is — execute for real while a permission prompt was open.
    // Offload innermost here too: MCP tools are the biggest producers of
    // megabyte JSON in the whole tool set.
    const offloaded =
      this.config.offload === "off"
        ? [...tools]
        : wrapToolsWithOffload([...tools], {
            dir: this.#offloadDir,
            ...this.config.offloadLimits,
          });
    const speculated = this.speculation
      ? wrapToolsWithSpeculation(offloaded, this.speculation)
      : offloaded;
    const tainted = wrapToolsWithTaint(speculated, this.taint, {
      policy: this.config.taint,
      confirm: (verdict, toolName, input) => this.confirmTainted(verdict, toolName, input),
    });
    this.#mcpToolsRaw =
      this.config.canary === "off"
        ? tainted
        : wrapToolsWithCanary(tainted, this.canary, { policy: this.config.canary });
    const wrapped = this.#wrapAgentTools(
      wrapToolsWithHooks(
        wrapToolsWithCheckpoints([...this.#preHookTools, ...this.#mcpToolsRaw], this.checkpoints),
        this.#hookRunner,
      ),
    );
    if (this.config.deferredTools?.enabled === true && this.#liveDeferred) {
      // Rebuild the LIVE agent's toolset over the new (MCP-inclusive) list and
      // carry its activations forward, mutating the SAME holder the live
      // agent's getTools closure already reads — so the reconnect is picked up
      // without repointing any other agent.
      const snapshot = this.#liveDeferred.toolset.snapshot();
      const rebuilt = this.#buildDeferredToolset(wrapped);
      rebuilt.restore(snapshot);
      this.#liveDeferred.toolset = rebuilt;
      this.agent.setTools([...rebuilt.allTools(), rebuilt.searchTool()]);
    } else {
      this.agent.setTools(wrapped);
    }
  }

  /**
   * Build a sub-agent for one delegated task.
   *
   * @param task - What the child is being asked to do.
   * @param def - The named role the child runs as, when there is one.
   * @param options - Optional attribution.
   * @param options.origin - Who this child answers for, stamped onto every
   *   permission request it raises so the prompt can say WHO is asking
   *   (`/workflow` passes `"@qa-functional · step 3"`). Attribution only: it
   *   is read by the host's dialog and by nothing else, so it can neither
   *   widen nor narrow what the child is allowed to do. Omit it and the
   *   child's prompts are byte-for-byte what they were before this existed.
   */
  createSubagent(task: string, def?: AgentDef, options?: { origin?: string }): Agent {
    const yolo = this.permissionMode === "yolo";
    // A child's permission mode may only NARROW the parent's, never widen it.
    // A plan-mode parent (read-only, no prompts) must not produce a
    // default-mode child (ask-the-user) — `/workflow` reaches this path in
    // plan mode, unlike the `subagent` tool the engine denies there.
    const planMode = this.permissionMode === "plan";
    const childMode: PermissionMode = yolo ? "yolo" : planMode ? "plan" : "default";
    // A non-yolo child investigates but does not mutate. `fetch` is normally
    // included even though it is not read-only — network egress stays gated,
    // so it prompts through the parent — but under a plan-mode parent it is
    // dropped entirely: plan mode promises no egress and no prompts.
    const investigative = new Set([...DEFAULT_READ_ONLY_TOOLS, ...(planMode ? [] : ["fetch"])]);
    // A named agent's `tools:` list may only NARROW what the permission mode
    // already allows — never widen it — so delegating can't be used to slip
    // past a non-yolo parent's read-only restriction.
    const allowedByMode = (name: string): boolean =>
      name !== "subagent" && (yolo || investigative.has(name));
    const requested = def?.tools ? new Set(def.tools) : undefined;
    // Checkpoint-wrap like every other tool path: a sub-agent's write/edit
    // must be as recoverable via /rewind as the parent's.
    // Same layering as the parent: checkpoints INSIDE the hook veto (so a
    // denied write is never snapshotted) and `wrapAgentTools` outermost (so
    // VCR replay bypasses every side-effecting layer here too).
    const tools = this.#wrapAgentTools(
      wrapToolsWithHooks(
        wrapToolsWithCheckpoints(
          this.#preHookTools.filter(
            (tool) =>
              allowedByMode(tool.definition.name) &&
              (requested === undefined || requested.has(tool.definition.name)),
          ),
          this.checkpoints,
        ),
        this.#hookRunner,
      ),
    );
    // Precedence: the agent's own `model:` wins, then the subagent route,
    // then the main model.
    const model =
      def?.model === undefined
        ? this.router.specFor("subagent")
        : resolveModelSpec(def.model, this.#env);
    const child = new Agent({
      llm: this.llm,
      model,
      systemPrompt: def?.systemPrompt ?? subagentSystemPrompt(this.cwd, yolo),
      tools,
      cwd: this.cwd,
      // A named role's own `maxTurns:` (RFC 0001 §3.2 budget fields) may only
      // NARROW the session's own subagent ceiling, never raise it — RFC 0001
      // §8.4 "Roles narrow; nothing widens." A checked-in role file (a cloned
      // repo controls `.arcturn/agents/**`) must not be able to grant itself a
      // longer leash than the session's own `subagentMaxTurns` (or the
      // built-in floor when that is unset) allows.
      maxTurns: Math.min(
        def?.maxTurns ?? Number.POSITIVE_INFINITY,
        this.config.subagentMaxTurns ?? SUBAGENT_MAX_TURNS,
      ),
      sessionStore: this.store,
      title: `subagent: ${task.slice(0, 60)}`,
      // The child inherits the parent's rules: a deny the user configured must
      // not be sidesteppable by delegating the same work to a sub-agent — and,
      // from `livePermissionRules`, the grants the user has made during this
      // run too, so a pipeline does not re-ask per role what was answered once.
      permissions: {
        mode: childMode,
        rules: this.livePermissionRules(),
        onPersistRule: (rule: PermissionRule) => this.#persistRule(rule),
      },
      compaction: compactionOptionsFor(model),
      ...(this.config.contextEditing === undefined
        ? {}
        : { contextEditing: this.config.contextEditing }),
      onPermissionAsk: (request) => this.#ask(attributeRequest(request, options?.origin)),
    });
    // Delegated work belongs in the trail: a sub-agent's own stream is
    // subscribed directly, which covers children built outside a tool call
    // too. `subscribe` only ever sees this runtime's current agent.
    if (this.audit) child.subscribe(auditObserver(this.audit));
    // Delegated spend counts against the session: a child's turns never
    // surface as a top-level `turnEnd`, so without this `/cost` and
    // `--max-cost` treat sub-agent work as free.
    const childModel = model;
    child.subscribe((event) => {
      if (event.type !== "turnEnd") return;
      const cost = event.usage.costUsd ?? calculateCostUsd(childModel, event.usage) ?? 0;
      this.metrics = {
        ...this.metrics,
        usage: addUsage(this.metrics.usage, event.usage),
        costUsd: this.metrics.costUsd + cost,
      };
    });
    return child;
  }

  /**
   * Ask the user to confirm a tool call that echoes untrusted fetched text.
   *
   * Routed through the same permission prompt as any other gated call, so the
   * TUI dialog, `--print` refusal and headless fail-closed behaviour are all
   * inherited rather than reinvented.
   *
   * @param verdict - What matched, for the dialog's subject line.
   * @param toolName - Tool being called.
   * @param input - The call's arguments.
   * @returns `true` when the user allows it.
   */
  async confirmTainted(
    verdict: TaintVerdict,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    void input;
    const decision = await this.#ask({
      id: createId("taint"),
      toolCallId: createId("taint"),
      toolName,
      subject: verdict.matches[0] ?? toolName,
      description:
        `This ${toolName} call repeats text that came from an untrusted source ` +
        `(${verdict.reason ?? "content fetched during this session"}). ` +
        "Approve it only if you recognise it as your own intent.",
    });
    return decision.behavior === "allow";
  }

  /**
   * Record a consensus verdict and surface a divergence to the user.
   *
   * @param verdict - What the panel concluded.
   */
  recordConsensus(verdict: {
    agreement: string;
    details: string[];
    models?: string[];
    usageByModel?: Record<string, Usage>;
  }): void {
    // Price each secondary at ITS OWN rate from the verdict's per-member
    // usage: a haiku cross-check on a sonnet primary must not be billed at
    // sonnet's price, and a turn `sampleRate` skipped produces no verdict at
    // all and so stays billed at 1x.
    const usageByModel = verdict.usageByModel ?? {};
    let extra = 0;
    for (const [modelId, usage] of Object.entries(usageByModel)) {
      if (modelId === this.model.id) continue;
      const spec = getModel(modelId);
      extra += (spec ? calculateCostUsd(spec, usage) : undefined) ?? 0;
    }
    this.#pendingPanelCostUsd = extra;
    this.consensusVerdicts.push(verdict);
    if (this.consensusVerdicts.length > RECENT_TURN_SAMPLES) this.consensusVerdicts.shift();
    if (verdict.agreement === "divergent") {
      this.notify(
        "warn",
        `Models disagreed on this turn — worth a look. ${verdict.details.join(" ")}`,
      );
    }
  }

  /** The conversation position recorded when a checkpoint turn began. */
  turnLink(turnId: string): { sessionId: string; leafId: string | null } | undefined {
    return this.#turnLinks.get(turnId);
  }

  /**
   * Fork the conversation back to an earlier point (non-destructive: later
   * entries stay on their branch in the session file).
   *
   * @param sessionId - Session holding the entry.
   * @param leafId - Entry to branch from, or `null` for "before the first
   *   message" (a fresh agent on the same session id).
   */
  async rewindConversationTo(sessionId: string, leafId: string | null): Promise<Agent> {
    const next =
      leafId === null
        ? this.#createAgent({ sessionId })
        : await Agent.resume({
            ...this.#agentOptions({ sessionId }),
            sessionStore: this.store,
            sessionId,
            leafId,
          });
    this.#swap(next);
    return next;
  }

  /**
   * Build the agent for one scout, rooted at its throwaway worktree.
   *
   * Uses the sub-agent route (a cheap model by default) and gets its own
   * checkpoint store, so a scout can never disturb the real workspace.
   *
   * @param cwd - The scout's isolated worktree.
   */
  scoutAgent(cwd: string): Agent {
    return this.buildSessionAgent({
      sessionId: createSessionId(),
      cwd,
      model: this.router.specFor("subagent"),
    });
  }

  /**
   * Fold spend that happened outside the main agent (scouts) into the
   * session's running total, so `--max-cost` and `/cost` stay honest.
   *
   * @param costUsd - Dollars spent elsewhere.
   */
  recordExternalCost(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    this.metrics = { ...this.metrics, costUsd: this.metrics.costUsd + costUsd };
  }

  /** Tear down MCP connections and detach listeners. Safe to call twice. */
  async dispose(): Promise<void> {
    // Fail closed: anything speculated but unanswered is discarded, never left
    // on disk and never applied.
    await this.speculation?.abandonAll();
    await this.#hookRunner.run("runEnd", { cwd: this.cwd });
    await this.lsp?.dispose();
    this.#detach?.();
    this.#detach = undefined;
    const manager = this.mcp;
    this.mcp = undefined;
    await manager?.close();
  }

  /**
   * Build an agent for a session other than this runtime's own — used by
   * `arcturn serve` and `arcturn acp`, where several sessions are live at once.
   *
   * Unlike {@link ArcturnRuntime.startNewSession} this does not swap the
   * runtime's current agent, and the returned agent gets its *own*
   * checkpoint store, so one session's `/rewind` never restores another's
   * files.
   *
   * @param options - Session id, optional working directory / model, and an
   *   optional per-agent permission requester.
   * @param options.onPermissionAsk - When supplied, this agent's permission
   *   checks are routed to it directly instead of {@link ArcturnRuntime}'s single
   *   shared slot (the one {@link ArcturnRuntime.setPermissionRequester} sets).
   *   Hosts juggling several concurrent sessions off one runtime should
   *   always supply this — two sessions built without it would otherwise
   *   both fall back to the *same* shared requester, and whichever one last
   *   called `setPermissionRequester` would win a permission check raised by
   *   the *other* session's turn. See `acp/host.ts`'s module doc for the
   *   concrete race this closes.
   * @param options.maxTurns - A requested turn budget for this session agent
   *   (e.g. a workflow role's own `maxTurns:`, RFC 0001 §3.2), clamped the
   *   same way {@link ArcturnRuntime.createSubagent} clamps a delegated
   *   agent's: down to `config.subagentMaxTurns` (or the built-in floor when
   *   that is unset), never above it — RFC 0001 §8.4 "Roles narrow; nothing
   *   widens." Passing the key at all — even as `maxTurns: someDef.maxTurns`
   *   where that is `undefined` — opts a session into this ceiling (an
   *   undeclared per-role budget still falls back to the ceiling itself, not
   *   to this session's own top-level turn budget); leaving the key out of
   *   the call entirely is what keeps this session's turn budget exactly as
   *   it was before this option existed. That is deliberate: a caller
   *   building a role's session agent (the write lane, `workflow.ts`) may not
   *   itself hold `config.subagentMaxTurns` to pre-clamp with — only this
   *   method does — so it must be able to say "clamp me to the subagent
   *   ceiling" even when it has no per-role number of its own to offer.
   * @param options.origin - Who this session answers for, stamped onto every
   *   permission request it raises, exactly as
   *   {@link ArcturnRuntime.createSubagent}'s does. The `/workflow` write and
   *   exec lanes pass a role's `"@developer · step 3"` here, so a worktree
   *   role's prompt is as attributable as a read-lane one's. Attribution
   *   only — it reaches the host's dialog and nothing else, and omitting it
   *   leaves the prompt exactly as it was.
   * @param options.fixedToolset - Declares that this agent's tool list is
   *   decided by its caller and by nothing else, so it must never be handed a
   *   deferred (progressively disclosed) toolset. Deferral works by giving the
   *   agent a `getTools` closure that the loop consults *instead of* the
   *   agent's own `tools` every turn (`Agent` resolves `getTools() ?? tools`),
   *   so a caller that builds an agent and then replaces its tools with
   *   `setTools` loses that replacement entirely the moment
   *   `config.deferredTools.enabled` is switched on — silently, because the
   *   agent still reports the narrowed list from `.tools`. The `/workflow`
   *   worktree lanes do exactly that, three times over (the role's declared
   *   `tools:` narrowing, the worktree confinement guard around `bash`, and
   *   the step's background-task tracking), and all three are safety
   *   properties rather than conveniences. Progressive disclosure is also
   *   pointless for such an agent: a role's tool set is fixed by its role
   *   file, so there is nothing left for the model to discover. Pass `true`
   *   and this agent's tools are exactly what its caller installed, whatever
   *   the disclosure config says.
   */
  buildSessionAgent(options: {
    sessionId: string;
    cwd?: string;
    model?: ModelSpec;
    onPermissionAsk?: PermissionPrompt;
    maxTurns?: number;
    origin?: string;
    fixedToolset?: boolean;
  }): Agent {
    const checkpoints = createCheckpointStore(
      join(this.paths.home, "checkpoints", options.sessionId),
      { restoreRoot: options.cwd ?? this.cwd },
    );
    const base = this.#agentOptions(
      {
        sessionId: options.sessionId,
        onPermissionAsk: options.onPermissionAsk,
        origin: options.origin,
        fixedToolset: options.fixedToolset === true,
      },
      checkpoints,
    );
    const agent = new Agent({
      ...base,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.model === undefined
        ? {}
        : { model: options.model, compaction: compactionOptionsFor(options.model) }),
      ...("maxTurns" in options
        ? {
            maxTurns: Math.min(
              options.maxTurns ?? Number.POSITIVE_INFINITY,
              this.config.subagentMaxTurns ?? SUBAGENT_MAX_TURNS,
            ),
          }
        : {}),
    });
    // Served sessions are driven by a remote client, so their tool calls are
    // exactly the ones an operator most needs in the trail. `subscribe` only
    // sees this runtime's own agent, so the observer is attached directly.
    if (this.#openAudit) {
      const log = this.#openAudit(options.sessionId);
      agent.subscribe(auditObserver(log));
    }
    return agent;
  }

  #agentOptions(
    overrides: {
      sessionId?: string;
      onPermissionAsk?: PermissionPrompt;
      origin?: string;
      /** See {@link ArcturnRuntime.buildSessionAgent}'s `fixedToolset`. */
      fixedToolset?: boolean;
    },
    store?: CheckpointStore,
    // The runtime's own live agent tracks its toolset in #liveDeferred so
    // attachMcpTools can rebuild it; a foreign session agent (its own store)
    // must NOT, or it would hijack the live agent's tool list. Passing a
    // caller-supplied `store` is exactly the foreign-agent signal.
    track = store === undefined,
  ): AgentOptions {
    // Config rules PLUS what the user has granted during this run: a session
    // agent (the `/workflow` write lane, a served session) must not re-ask for
    // a tool the user already approved. See `livePermissionRules`.
    const rules: PermissionRule[] = this.livePermissionRules();
    // The session id is pre-generated so the checkpoint store (keyed by
    // session) exists before the Agent does; every write/edit then snapshots
    // into ~/.arcturn/checkpoints/<sessionId> ahead of mutating a file. A caller
    // may pass its own store (see buildSessionAgent) to avoid rebinding the
    // runtime's current one.
    const sessionId = overrides.sessionId ?? createSessionId();
    const checkpoints =
      store ??
      createCheckpointStore(join(this.paths.home, "checkpoints", sessionId), {
        restoreRoot: this.cwd,
      });
    if (!store) this.checkpoints = checkpoints;
    return {
      llm: this.llm,
      model: this.model,
      systemPrompt: this.#systemPrompt,
      // Hooks outermost: a `preToolUse` deny must stop the call before the
      // checkpoint layer reads and copies the file it was denied.
      ...this.#toolOptions(
        this.#wrapAgentTools(
          wrapToolsWithHooks(
            wrapToolsWithCheckpoints([...this.#preHookTools, ...this.#mcpToolsRaw], checkpoints),
            this.#hookRunner,
          ),
        ),
        track,
        overrides.fixedToolset === true,
      ),
      cwd: this.cwd,
      thinking: this.config.thinking,
      sessionStore: this.store,
      compaction: compactionOptionsFor(this.model),
      ...(this.config.contextEditing === undefined
        ? {}
        : { contextEditing: this.config.contextEditing }),
      sessionId,
      ...(this.#maxTurns === undefined ? {} : { maxTurns: this.#maxTurns }),
      permissions: {
        mode: this.#started ? this.agent.permissionMode : this.#initialMode,
        rules,
        // The search tool is auto-approved only when the runtime itself owns
        // it — never trusted by bare name in core — so an extension/MCP tool
        // that merely claims the name gets no silent pass. An agent that was
        // never offered the search tool (`fixedToolset`) is not given the
        // grant either: a name nobody holds is a name someone else can claim.
        ...(this.#defersTools(overrides.fixedToolset === true)
          ? { alwaysAllowTools: [...DEFAULT_ALWAYS_ALLOW_TOOLS, this.#searchToolName()] }
          : {}),
        onPersistRule: (rule: PermissionRule) => this.#persistRule(rule),
      },
      onPermissionAsk: (request) =>
        this.#ask(attributeRequest(request, overrides.origin), overrides.onPermissionAsk),
    };
  }

  #createAgent(overrides: { sessionId?: string }): Agent {
    return new Agent(this.#agentOptions(overrides));
  }

  /**
   * The `tools`/`getTools` pair for a new agent. With deferral off this is
   * just `{ tools }`. With it on, a fresh {@link DeferredToolset} is built
   * over the fully wrapped list (previous activations survive via snapshot,
   * so an MCP re-wrap or session swap never "forgets" what the model found),
   * the full list still reaches the agent for bindable-tool wiring, and the
   * loop reads `activeTools()` each turn. Disclosure only — every activated
   * tool still passes the permission engine per call.
   */
  /** The name of the deferred-disclosure search tool for this config. */
  #searchToolName(): string {
    return this.config.deferredTools?.searchToolName ?? DEFAULT_SEARCH_TOOL_NAME;
  }

  /**
   * Whether one agent gets progressive tool disclosure.
   *
   * Two conditions, and the second is per-agent: the config asks for it, and
   * this agent's tool list is not its caller's to own. Both the toolset and
   * the search tool's standing permission grant read this, so an agent opted
   * out is opted out of the whole feature rather than half of it.
   *
   * @param fixedToolset - The agent's `fixedToolset` flag.
   */
  #defersTools(fixedToolset: boolean): boolean {
    return this.config.deferredTools?.enabled === true && !fixedToolset;
  }

  /** Build a fresh {@link DeferredToolset} over `tools` using this config. */
  #buildDeferredToolset(tools: Tool[]): DeferredToolset {
    const deferredConfig = this.config.deferredTools;
    return createDeferredToolset({
      tools,
      // `skill`'s description IS the index a deferred system would otherwise
      // reconstruct, so deferring it makes skills a two-round-trip discovery.
      // Keep it (and the other everyday tools) active unless the user has
      // named their own alwaysActive set.
      alwaysActive: deferredConfig?.alwaysActive ?? [...DEFAULT_ALWAYS_ACTIVE_TOOLS, "skill"],
      ...(deferredConfig?.maxResults === undefined
        ? {}
        : { maxResults: deferredConfig.maxResults }),
      searchToolName: this.#searchToolName(),
    });
  }

  /**
   * The `tools`/`getTools` pair for a new agent.
   *
   * CRITICAL: each agent gets its OWN toolset captured in its OWN closure
   * (via a stable per-agent `holder`), never a runtime-wide field — otherwise
   * building a second agent (a served/ACP session, a scout) would repoint the
   * first, still-running agent's per-turn tool list at the second agent's
   * toolset, so the first agent's writes would checkpoint into the second's
   * store and one session's `tool_search` activations would leak into
   * another's requests. Only the runtime's own live agent (`track: true`) is
   * tracked in `#liveDeferred`, so `attachMcpTools` can rebuild that one
   * agent's toolset in place on an MCP reconnect.
   *
   * @param tools - The fully wrapped tool list this agent starts life with.
   * @param track - Whether this is the runtime's own live agent.
   * @param fixedToolset - This agent's tools are its caller's to decide, so no
   *   `getTools` override may be installed over them at all. See
   *   {@link ArcturnRuntime.buildSessionAgent}'s `fixedToolset`.
   */
  #toolOptions(
    tools: Tool[],
    track: boolean,
    fixedToolset = false,
  ): { tools: Tool[]; getTools?: () => Tool[] } {
    if (!this.#defersTools(fixedToolset)) {
      if (track) this.#liveDeferred = undefined;
      return { tools };
    }
    // Fresh activations per agent: a new agent means a new session, so it must
    // not inherit a prior agent's disclosure state. (MCP reconnect preserves
    // activations by mutating the live holder in attachMcpTools, not here.)
    const holder = { toolset: this.#buildDeferredToolset(tools) };
    if (track) this.#liveDeferred = holder;
    return {
      tools: [...holder.toolset.allTools(), holder.toolset.searchTool()],
      getTools: () => holder.toolset.activeTools(),
    };
  }

  /**
   * Resolve one permission check.
   *
   * @param request - The check to resolve.
   * @param requesterOverride - When given (by {@link ArcturnRuntime.buildSessionAgent}),
   *   this exact agent's own requester — bypassing {@link ArcturnRuntime.setPermissionRequester}'s
   *   shared `#requester` slot entirely, so this agent's checks can never be
   *   answered by whatever the slot happens to hold for a *different* agent
   *   at the moment this fires. Omitted for the runtime's own `this.agent`
   *   (the TUI/`--print` singleton), which has always used the shared slot
   *   and still does.
   */
  async #ask(
    request: PermissionRequest,
    requesterOverride?: PermissionPrompt,
  ): Promise<PermissionDecision> {
    const requester = requesterOverride ?? this.#requester;
    if (!requester) {
      return {
        requestId: request.id,
        behavior: "deny",
        message: `Permission required for "${request.toolName}" but this session cannot prompt.`,
      };
    }
    const speculation = this.speculation;
    if (speculation) speculation.begin(request.id);
    let decision: PermissionDecision;
    try {
      decision = await requester(request);
    } catch (error) {
      // Fail closed: an ask that blew up must discard speculative work.
      if (speculation) await speculation.settle(request.id, false);
      throw error;
    }
    if (speculation) {
      const outcome = await speculation.settle(request.id, decision.behavior === "allow");
      const summary = formatSpeculationOutcome(outcome, this.cwd);
      if (summary !== "") this.notify("info", summary);
    }
    // Repeated identical answers become a suggested rule (never auto-applied).
    this.policy.observe(request, decision);
    return decision;
  }

  #swap(next: Agent): void {
    this.taint.reset();
    // The audit trail is keyed by session: re-open it for the incoming one,
    // or entries land under the id of a session whose transcript never
    // contained them (and `arcturn audit <newId>` finds nothing).
    if (this.#openAudit) {
      this.#detachAudit?.();
      this.audit = this.#openAudit(next.sessionId);
      this.#detachAudit = this.subscribe(auditObserver(this.audit));
    }
    // `next.sessionId`, not `this.agent.sessionId` — the swap happens below,
    // so reading the current agent here would file the new session's trail
    // under the outgoing session's id.
    if (this.#openProvenance) this.setProvenanceOpener(this.#openProvenance, next.sessionId);
    this.#detach?.();
    this.agent = next;
    this.metrics = { turns: 0, usage: emptyUsage(), costUsd: 0 };
    this.#attach(next);
  }

  #attach(agent: Agent): void {
    this.#detach = agent.subscribe((event) => this.#onEvent(event));
  }

  /**
   * Install the audit-log factory and start recording the current session.
   *
   * @param open - Opens (or creates) the log for one session id.
   */
  setProvenanceOpener(
    open: (sessionId: string) => ProvenanceStore,
    sessionId: string = this.agent.sessionId,
  ): void {
    this.#openProvenance = open;
    this.#detachProvenance?.();
    this.provenance = open(sessionId);
    this.#detachProvenance = this.subscribe(
      provenanceObserver(this.provenance, async (file) => {
        try {
          return await readFile(file, "utf8");
        } catch {
          return null;
        }
      }),
    );
  }

  setAuditOpener(open: (sessionId: string) => AuditLog): void {
    this.#openAudit = open;
    this.#detachAudit?.();
    this.audit = open(this.agent.sessionId);
    this.#detachAudit = this.subscribe(auditObserver(this.audit));
  }

  /**
   * Fan a notice out to whatever UI is currently subscribed.
   *
   * `warnings` is only drained at startup, so anything discovered mid-session
   * (a cost ceiling tripping, a provider failover) has to travel this way to
   * be seen at all.
   *
   * @param level - Severity.
   * @param text - Message to show.
   */
  notify(level: "info" | "warn" | "error", text: string): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener({ type: "notice", level, text });
      } catch {
        // A UI bug must never break a run.
      }
    }
  }

  #onEvent(event: AgentEvent): void {
    if (event.type === "runStart") {
      // leafEntryId must be read synchronously: runStart is emitted before the
      // user message is appended, so it still names the pre-turn branch tip —
      // exactly where /rewind forks the conversation back to.
      const leafId = this.agent.leafEntryId;
      const store = this.checkpoints;
      const label =
        event.prompt.role === "user"
          ? event.prompt.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(" ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 60)
          : "";
      void store
        .beginTurn(label === "" ? "(empty prompt)" : label)
        .then((turnId) => {
          this.#turnLinks.set(turnId, { sessionId: event.sessionId, leafId });
        })
        .catch(() => undefined);
    }
    if (event.type === "messageStream" && event.event.type === "start") {
      // With a failover chain the answering model is not necessarily the
      // chain head, and `turnEnd` carries only usage — so the model id is
      // captured here, where the stream names it.
      this.#answeringModel = getModel(event.event.model) ?? undefined;
    }
    if (event.type === "turnEnd") {
      const priced = this.#answeringModel ?? this.model;
      const cost = event.usage.costUsd ?? calculateCostUsd(priced, event.usage) ?? 0;
      // A consensus panel spends once per member, but only the primary's
      // usage reaches this event. Scaling by the CONFIGURED panel size
      // over-charges every turn `sampleRate` skipped, so the multiplier comes
      // from the verdict — i.e. from the members that actually ran — and is
      // consumed once. Members are still priced at the primary's rate, which
      // is an approximation the verdict cannot improve on.
      const panelExtra = this.#pendingPanelCostUsd;
      this.#pendingPanelCostUsd = 0;
      const spent = cost + panelExtra;
      this.metrics = {
        turns: this.metrics.turns + 1,
        usage: addUsage(this.metrics.usage, event.usage),
        costUsd: this.metrics.costUsd + spent,
      };
      this.recentTurns.push({
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        costUsd: spent,
      });
      if (this.recentTurns.length > RECENT_TURN_SAMPLES) this.recentTurns.shift();
    }
    this.extensions.dispatch(event);
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A UI bug must never break a run.
      }
    }
  }
}

/** Options for {@link buildRuntime}. */
export interface BuildRuntimeOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** User directory root. Defaults to `$ARCTURN_HOME` or `~/.arcturn`. */
  home?: string;
  /** Environment used for API keys and `ARCTURN_*` overrides. */
  env?: EnvMap;
  /** Pre-loaded configuration; loaded from disk when omitted. */
  config?: ArcturnConfig;
  /** Model id override (`--model`); a list is a failover chain. */
  model?: string | string[];
  /** Abort the run once this many USD have been spent (`--max-cost`). */
  maxCostUsd?: number;
  /** Route file mutations to a shadow tree (`--dry-run`). */
  dryRun?: boolean;
  /**
   * Build a runtime for REPLAY: no lifecycle hooks, no language servers, no
   * verify command, no audit/provenance writes. Tool neutralisation is
   * `wrapAgentTools`'s job; this covers everything else a runtime does that
   * has real side effects.
   */
  replay?: boolean;
  /**
   * Last-chance hook over the tool list handed to every agent, applied
   * OUTSIDE every other wrapper. VCR uses it so a replayed run bypasses the
   * layers that have real side effects.
   */
  wrapAgentTools?: (tools: Tool[]) => Tool[];
  /** Permission mode override (`--permission-mode`). */
  permissionMode?: PermissionMode;
  /** Maximum model turns per run (`--max-turns`). */
  maxTurns?: number;
  /** Inject an LLM client; when omitted one is built from `@arcturn/ai`. */
  llm?: LLMClient;
  /** Prompts the user for permission. Without one, unmatched checks are denied. */
  onPermissionAsk?: PermissionPrompt;
  /** Resume this session id. */
  resume?: string;
  /** Resume the newest session for this working directory. */
  continueSession?: boolean;
  /** Pre-loaded extensions, or `false` to skip extension loading entirely. */
  extensions?: ExtensionHost | false;
  /** Skip the git and `ARCTURN.md` lookups when building the system prompt. */
  skipRepoLookup?: boolean;
}

/**
 * Build the full runtime: client, model, tools, MCP-ready session store,
 * extensions and the agent itself.
 *
 * MCP servers are *not* started here — call {@link connectMcp} afterwards so a
 * caller that passed `--no-mcp` (or does not want the latency) can skip it.
 *
 * @param options - Overrides from the command line and the host application.
 */
export async function buildRuntime(options: BuildRuntimeOptions = {}): Promise<ArcturnRuntime> {
  const env = options.env ?? process.env;
  // Presets and the OAuth adapters must exist before any model id is resolved,
  // otherwise `--model groq/…` fails against a catalog that has not been filled.
  registerBundledCatalog();
  const warnings: string[] = [];
  const pathOptions = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    env,
  };

  let config = options.config;
  let paths: ArcturnPaths;
  if (config) {
    paths = resolveArcturnPaths(pathOptions);
  } else {
    const loaded = await loadConfig(pathOptions);
    config = loaded.config;
    paths = loaded.paths;
    warnings.push(...loaded.warnings);
  }

  // Extensions load before the model is resolved so an extension can call
  // registerModel() and have that model be selectable straight away.
  const extensions =
    options.extensions === false
      ? new ExtensionHost()
      : (options.extensions ??
        (await loadExtensions({
          directories: [...new Set([paths.userExtensions, paths.projectExtensions])],
          config,
          cwd: paths.cwd,
          version: version(),
          reservedToolNames: BUILT_IN_TOOL_NAMES,
        })));
  warnings.push(...extensions.warnings);

  // Markdown skills register through the same command pipeline as extension
  // commands: user root first, project root second (later wins collisions,
  // matching config layering). Built-in names stay protected by the registry.
  const skills = await loadSkills(
    [...new Set([join(paths.home, "skills"), join(paths.project, "skills")])],
    warnings,
  );
  extensions.commands.push(...skills.map(skillCommand));

  const agentDefs = await loadAgentDefs(
    [...new Set([join(paths.home, "agents"), join(paths.project, "agents")])],
    warnings,
    [...BUILT_IN_TOOL_NAMES, ...extensions.tools.map((tool) => tool.definition.name)],
  );
  const agents = new Map(agentDefs.map((def) => [def.name, def]));

  // A model list is a failover chain: the head is primary (it drives
  // compaction budget and the cost readout), the rest are tried when a
  // provider is overloaded, rate-limited or unreachable.
  const requested = options.model ?? config.model;
  const modelIds = Array.isArray(requested) ? requested : [requested];
  const modelSpecs = modelIds.map((id) => resolveModelSpec(id, env));
  const model = modelSpecs[0]!;
  // Per-role models: a cheap one for sub-agents/compaction keeps a long
  // session affordable without downgrading the main loop.
  const router = createModelRouter(config.route ?? {}, (id) => resolveModelSpec(id, env), model);
  // Credentials written by `arcturn auth login` are resolved (and refreshed) per
  // request, so an OAuth-backed model works with no API key in the environment.
  oauth.applyOAuthEnvOverrides(env);
  const authStore = createAuthStore(paths);
  const baseClient =
    options.llm ??
    createClient({
      env,
      getAccessToken: oauth.createAccessTokenResolver(authStore),
      // Bound a stalled/dead LLM socket so a run never hangs on a silent stream;
      // the watchdog surfaces a transient network error that retry/failover handles.
      ...(config.requestStallTimeoutMs === undefined
        ? {}
        : { requestStallTimeoutMs: config.requestStallTimeoutMs }),
    });
  // One shared client, one link per model: dispatch already routes on the
  // request's model, so the chain only has to override that per attempt.
  const llm =
    modelSpecs.length > 1
      ? createFailoverClient(
          modelSpecs.map((spec) => ({ client: baseClient, model: spec })),
          {
            onFailover: (from, to) => {
              const message = `${modelSpecs[from]?.displayName} was unavailable; switched to ${modelSpecs[to]?.displayName}.`;
              // Before the runtime exists this is startup; after, it must go
              // to the live notice channel or nobody ever sees it.
              if (runtimeRef) runtimeRef.notify("warn", message);
              else warnings.push(message);
            },
          },
        )
      : baseClient;
  // Consensus wraps the chain (not the reverse): each panel member may itself
  // be a failover chain, and wrapping the other way would restart the whole
  // panel whenever one member hit a transient error.
  const consensusModels = config.consensus?.models ?? [];
  const llmWithConsensus =
    consensusModels.length === 0
      ? llm
      : createConsensusClient(
          [
            { client: llm, model },
            ...consensusModels.map((id) => ({
              client: baseClient,
              model: resolveModelSpec(id, env),
            })),
          ],
          {
            ...(config.consensus?.sampleRate === undefined
              ? {}
              : { sampleRate: config.consensus.sampleRate }),
            ...(config.consensus?.similarityThreshold === undefined
              ? {}
              : { similarityThreshold: config.consensus.similarityThreshold }),
            onVerdict: (verdict: ConsensusVerdict) => {
              runtimeRef?.recordConsensus(verdict);
            },
          },
        );
  const permissionMode = options.permissionMode ?? config.permissionMode;

  await mkdir(paths.sessions, { recursive: true });
  const store = new JsonlSessionStore({ dir: paths.sessions });

  // The sub-agent factory needs the runtime, which needs the tools: close over
  // a slot filled in once construction finishes.
  let runtimeRef: ArcturnRuntime | undefined;
  const defaults = createDefaultTools({ cwd: paths.cwd, sandbox: config.sandbox });
  // The first session's id is minted here so the audit trail (keyed by
  // session) can exist before the Agent does. Later sessions from
  // /clear or /sessions mint their own ids; the trail follows them.
  const initialSessionId = createSessionId();
  const dryRun = options.dryRun ?? config.dryRun;
  const overlayDir = join(paths.home, "overlays", initialSessionId);
  // Under dry-run, memory notes are file writes like any other: they land in
  // the shadow tree so /diff shows them and /discard throws them away.
  const memoryDir = dryRun
    ? join(overlayDir, relative(paths.cwd, join(paths.project, "memory")))
    : join(paths.project, "memory");

  const baseTools: Tool[] = [
    ...defaults.tools,
    // Complements grep rather than replacing it: grep for an exact string,
    // search_code for "where is X handled" and for symbol lookup. Returns
    // addresses, not bodies, so a wide search costs tens of tokens.
    createSearchCodeTool(),
    createTodoTool(),
    createPlanTool(),
    // Resolved per call from the CALLING agent's cwd: a scout in a throwaway
    // worktree (or a served session elsewhere) must not write notes into the
    // user's real repository.
    createMemoryTool({
      dir: (ctx) => (ctx.cwd === paths.cwd ? memoryDir : join(ctx.cwd, ".arcturn", "memory")),
    }),
    createSubagentTool({
      agentNames: [...agents.keys()],
      factory: (task, agentName) => {
        if (!runtimeRef) throw new Error("The runtime is not ready yet.");
        const def = agentName === undefined ? undefined : agents.get(agentName);
        if (agentName !== undefined && !def) {
          const known = [...agents.keys()];
          throw new Error(
            known.length === 0
              ? `No named agents are configured, so the "agent" parameter cannot be used. ` +
                  `Retry without it. (Define agents as markdown files in .arcturn/agents/.)`
              : `Unknown agent "${agentName}". Retry with one of: ${known.join(", ")}, ` +
                  "or omit the parameter for the default agent.",
          );
        }
        return runtimeRef.createSubagent(task, def);
      },
    }),
    // Model-invoked skills: the same discovered collection the slash commands
    // use, exposed as one tool whose description indexes the library. A
    // project-root skill (a cloned repo controls <cwd>/.arcturn/skills) is
    // untrusted: listed by name only, its description text never embedded.
    ...(config.skills?.modelInvoked === false
      ? []
      : [
          createSkillTool({
            registry: () => skills,
            isTrusted: (skill) => !skill.source.startsWith(join(paths.project, "skills")),
          }),
        ]),
    ...extensions.tools,
  ];

  // Lifecycle hooks wrap every tool exactly once here; sub-agents inherit the
  // wrapped list, and MCP tools are wrapped separately in attachMcpTools.
  const themes = await loadCustomThemes(
    [...new Set([join(paths.home, "themes"), join(paths.project, "themes")])],
    warnings,
  );

  // A replay must not act on the world: the user's hooks, language servers,
  // verify command and trail writes are all real side effects that have
  // nothing to do with reproducing a recorded conversation.
  const replayMode = options.replay === true;
  if (replayMode) {
    config = {
      ...config,
      hooks: { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] },
      lsp: "off",
      audit: false,
      provenance: false,
      dryRun: false,
      speculation: false,
      verify: undefined,
    };
  }
  const audit = config.audit ? createAuditLog(auditFilePath(paths, initialSessionId)) : undefined;
  const rawHookRunner = createHookRunner(config.hooks, { cwd: paths.cwd, env });
  // Wrapping the runner (rather than editing hooks.ts) captures every verdict:
  // tool wrapping and the sessionStart/runEnd calls all go through `.run()`.
  const hookRunner = audit ? auditedHookRunner(rawHookRunner, audit) : rawHookRunner;
  // LSP wraps innermost (append diagnostics to successful edits), hooks wrap
  // outside it (a preToolUse deny skips everything), checkpoints wrap
  // per-agent on top in #agentOptions.
  const lsp = config.lsp === "on" ? createLspManager({ cwd: paths.cwd }) : undefined;
  // The `symbols` tool rides the same language servers as diagnostics, so it
  // only exists when LSP is on. It is appended before wrapping so it picks up
  // hooks/checkpoints like every other tool.
  const toolsWithSymbols = lsp ? [...baseTools, createSymbolsTool(lsp)] : baseTools;
  // Offload wraps innermost — inside LSP/verify/taint/hooks — so everything
  // the outer layers APPEND to a result (diagnostics, verify failures, taint
  // warnings) stays inline where the model reads it, and only the wrapper
  // ever holds a full oversized output in memory. Tradeoff documented in
  // docs/integration-notes/INTEGRATION-offload.md §4: taint/canary observe
  // the stub, not the omitted middle.
  const offloadDir = join(paths.home, "offload", initialSessionId);
  const offloadedTools =
    config.offload === "off"
      ? toolsWithSymbols
      : wrapToolsWithOffload(toolsWithSymbols, { dir: offloadDir, ...config.offloadLimits });
  const lspTools = lsp ? wrapToolsWithLsp(offloadedTools, lsp) : offloadedTools;
  // Dry run: mutations land in a shadow tree the user reviews before applying.
  // Verify is meaningless then — it would check an untouched workspace and
  // report a pass on code the model never actually wrote.
  const overlay: Overlay | undefined = dryRun
    ? createOverlay({ cwd: paths.cwd, dir: overlayDir })
    : undefined;
  if (overlay && config.verify) {
    warnings.push("Dry-run mode is on, so the verify command is disabled for this session.");
  }
  const verifier =
    config.verify && !overlay ? createVerifier(config.verify, { cwd: paths.cwd, env }) : undefined;
  const verifiedTools = verifier ? wrapToolsWithVerify(lspTools, verifier) : lspTools;
  const overlayTools = overlay ? wrapToolsWithOverlay(verifiedTools, overlay) : verifiedTools;
  // Taint sits inside hooks: a user's preToolUse deny stays final and raises
  // no dialog for an already-dead call, while a taint refusal is still
  // visible to postToolUse hooks and the audit trail.
  // A per-session canary: if this exact token ever appears in an outbound
  // tool argument, that is proof of exfiltration rather than a heuristic.
  // A generated token nobody has ever seen cannot appear in a tool argument,
  // so the guard is only meaningful over values that really exist in this
  // workspace: the user lists them (a real API key, a customer id) and arcturn
  // refuses to let them leave. The generated session token is kept only so a
  // caller can plant it deliberately.
  const canaryGuard = createCanaryGuard({
    canaries: [...(config.canaries ?? []), generateCanary({ label: "session" })],
  });
  if (config.canary !== "off" && (config.canaries ?? []).length === 0) {
    warnings.push(
      'Canary guard is on but no "canaries" are configured, so it has nothing real to watch for.',
    );
  }
  // Speculation and dry-run both own the shadow tree; stacked, the
  // speculative overlay would sit OUTSIDE cwd and an approval would write
  // straight to the real workspace — exactly what dry-run promises never
  // happens. So dry-run wins and speculation stands down.
  const speculationOn = config.speculation && !dryRun;
  if (config.speculation && dryRun) {
    warnings.push("Dry-run mode is on, so speculative approval is disabled for this session.");
  }
  const speculation: SpeculationController | undefined = speculationOn
    ? createSpeculation({
        overlayFor: (id) =>
          createOverlay({
            cwd: paths.cwd,
            dir: join(paths.home, "speculations", initialSessionId, id),
          }),
      })
    : undefined;
  const taintTracker = createTaintTracker();
  const speculativeTools = speculation
    ? wrapToolsWithSpeculation(overlayTools, speculation)
    : overlayTools;
  const taintedTools = wrapToolsWithTaint(speculativeTools, taintTracker, {
    policy: config.taint,
    confirm: (verdict, toolName, input) => {
      if (!runtimeRef) return Promise.resolve(false);
      return runtimeRef.confirmTainted(verdict, toolName, input);
    },
  });
  const canariedTools =
    config.canary === "off"
      ? taintedTools
      : wrapToolsWithCanary(taintedTools, canaryGuard, { policy: config.canary });
  const hookedTools = wrapToolsWithHooks(canariedTools, hookRunner);
  const sessionStart = await hookRunner.run("sessionStart", { cwd: paths.cwd });
  warnings.push(...sessionStart.warnings);

  const memoryWarnings: string[] = [];
  const memories = await loadMemories(join(paths.project, "memory"), memoryWarnings);
  warnings.push(...memoryWarnings);
  const memoryText = formatMemoriesForPrompt(memories);

  const promptContext = await collectSystemPromptContext({
    cwd: paths.cwd,
    ...(config.systemPromptAppend === undefined ? {} : { append: config.systemPromptAppend }),
    toolNames: baseTools.map((tool) => tool.definition.name),
    ...(memoryText === "" ? {} : { memories: memoryText }),
    ...(agentDefs.length === 0
      ? {}
      : {
          agents: agentDefs.map((def) => ({ name: def.name, description: def.description })),
        }),
    ...(options.skipRepoLookup ? { skipRepoLookup: true } : {}),
  });

  const runtime = new ArcturnRuntime({
    config,
    paths,
    env,
    model,
    llm: llmWithConsensus,
    store,
    backgroundTasks: defaults.backgroundTasks,
    extensions,
    warnings,
    baseTools: hookedTools,
    ...(options.wrapAgentTools === undefined ? {} : { wrapAgentTools: options.wrapAgentTools }),
    preHookTools: canariedTools,
    sessionId: initialSessionId,
    hookRunner,
    lsp,
    verifier,
    overlay,
    speculation,
    taint: taintTracker,
    canary: canaryGuard,
    router,
    agents,
    themes,
    systemPrompt: buildSystemPrompt(promptContext),
    permissionMode,
    // `--max-turns` wins over the config key, which wins over core's default.
    ...((options.maxTurns ?? config.maxTurns) === undefined
      ? {}
      : { maxTurns: options.maxTurns ?? config.maxTurns }),
    ...(options.onPermissionAsk === undefined ? {} : { onPermissionAsk: options.onPermissionAsk }),
  });
  runtimeRef = runtime;

  if (audit) {
    runtime.setAuditOpener((sessionId) => createAuditLog(auditFilePath(paths, sessionId)));
  }
  if (config.provenance) {
    runtime.setProvenanceOpener((sessionId) =>
      createProvenanceStore(join(paths.home, "provenance", cwdHash(paths.cwd), sessionId)),
    );
  }
  warnings.push(...router.warnings());

  // Cost ceiling: abort the run once the session's spend crosses the limit.
  // Read through a getter so `/cost limit` can change it mid-session.
  // Always subscribed, even with no ceiling configured: `/cost limit` can arm
  // one mid-session, and a guard that only existed when a limit was set at
  // startup would silently ignore it.
  runtime.costLimitUsd = options.maxCostUsd ?? config.maxCostUsd ?? 0;
  const costGuard = createCostGuard({
    // A live getter, so raising or lowering the ceiling takes effect at once.
    get limitUsd() {
      return runtime.costLimitUsd;
    },
    getCostUsd: () => runtime.metrics.costUsd,
    abort: () => runtime.agent.abort(),
    // `warnings` is drained once at startup, so it cannot carry a mid-session
    // message; a notice reaches whatever UI is listening right now.
    notify: (message) => runtime.notify("warn", message),
  });
  runtime.subscribe((event) => costGuard.onEvent(event));

  let sessionId = options.resume;
  if (!sessionId && options.continueSession) {
    const headers = await runtime.listSessions();
    sessionId = headers[0]?.sessionId;
    if (!sessionId) {
      warnings.push("No previous session found in this directory; starting a new one.");
    }
  }
  if (sessionId) {
    try {
      await runtime.resumeSession(sessionId);
    } catch (error) {
      warnings.push(
        `Could not resume session ${sessionId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return runtime;
}

/**
 * Connect the configured MCP servers and hand their tools to the runtime.
 *
 * Missing config files are not an error; a server that fails to start is
 * reported through {@link McpManager.status} and the rest still work.
 *
 * @param runtime - The runtime to attach tools to.
 * @returns The connected manager, or `undefined` when nothing is configured.
 */
/**
 * Adapt a markdown skill to the extension-command shape: expanding the
 * template and submitting it exactly as if the user had typed the result —
 * steering an in-flight run, prompting otherwise.
 */
function skillCommand(skill: Skill): ExtensionCommand {
  return {
    name: skill.name,
    description: skill.description === "" ? `Skill from ${skill.source}` : skill.description,
    source: skill.source,
    handler: async ({ runtime, ui, args }) => {
      const prompt = skill.buildPrompt(args, runtime.cwd);
      if (runtime.agent.isRunning) {
        runtime.agent.steer(prompt);
        return;
      }
      try {
        await runtime.agent.prompt(prompt);
      } catch (error) {
        ui.notice("error", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Options for {@link connectMcp}. */
export interface ConnectMcpOptions {
  /**
   * Whether a human is at the terminal. Only an interactive session may open a
   * browser to authorize an OAuth MCP server mid-startup; `--print` gets the
   * "run arcturn mcp auth <name>" status instead of a blocked process.
   */
  readonly interactive?: boolean;
}

/**
 * Start every configured MCP server and attach their tools to the runtime.
 *
 * Per-server failures are isolated by the manager and reported as warnings.
 *
 * @param runtime - The runtime to attach the manager and its tools to.
 * @param options - Whether interactive OAuth is permitted.
 */
export async function connectMcp(
  runtime: ArcturnRuntime,
  options: ConnectMcpOptions = {},
): Promise<McpManager | undefined> {
  const files = [...new Set([runtime.paths.userMcp, runtime.paths.projectMcp])].filter((file) =>
    existsSync(file),
  );
  if (files.length === 0) return undefined;

  let manager: McpManager;
  try {
    // Loaded on demand: the MCP SDK is a heavy import that most sessions
    // without configured servers should never pay for.
    const { loadMcpConfig, McpManager: Manager } = await import("@arcturn/mcp");
    const config = await loadMcpConfig(files);
    if (Object.keys(config.servers).length === 0) return undefined;
    const usesOAuth = Object.values(config.servers).some(
      (server) => server.type === "http" && server.auth === "oauth",
    );
    const { createMcpAuthProviderFactory, createMcpAuthorizationHandler } = usesOAuth
      ? await import("./mcp-auth.js")
      : { createMcpAuthProviderFactory: undefined, createMcpAuthorizationHandler: undefined };
    // The provider is always non-interactive: it loads and refreshes stored
    // credentials. A grant the user has never approved surfaces as
    // "run arcturn mcp auth <name>" in /mcp status, and only an interactive
    // host is allowed to turn that into a browser flow.
    const authProviderFactory = createMcpAuthProviderFactory
      ? await createMcpAuthProviderFactory({ paths: runtime.paths })
      : undefined;
    manager = new Manager(config, {
      clientInfo: { name: "arcturn", version: version() },
      ...(authProviderFactory === undefined ? {} : { authProviderFactory }),
      ...(options.interactive && createMcpAuthorizationHandler
        ? { onAuthorizationRequired: createMcpAuthorizationHandler({ paths: runtime.paths }) }
        : {}),
    });
  } catch (error) {
    runtime.warnings.push(
      `MCP config error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  await manager.connect();
  runtime.mcp = manager;
  runtime.attachMcpTools(manager.tools());
  for (const [name, status] of Object.entries(manager.status())) {
    if (status.state === "failed") {
      runtime.warnings.push(`MCP server "${name}" failed: ${status.error ?? "unknown error"}`);
    }
  }
  manager.onToolsChanged(() => runtime.attachMcpTools(manager.tools()));
  // The runtime doesn't keep a resource/prompt cache today (resources.ts's
  // listResources/listPrompts are called live, on demand), so there's
  // nothing to invalidate here. These hooks exist so a future consumer (a
  // `/resources` or `/prompts` command, `@`-mention completion, etc.) can
  // react to server-pushed changes without further manager changes.
  manager.onResourcesChanged(() => {});
  manager.onPromptsChanged(() => {});
  return manager;
}
