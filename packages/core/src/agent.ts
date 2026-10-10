/**
 * The {@link Agent}: a single conversational agent bound to one session.
 *
 * It owns the conversation, the permission engine, todo/plan state, session
 * persistence and compaction, and exposes everything a UI needs through the
 * {@link AgentEvent} stream.
 */

import { createHash } from "node:crypto";
import type {
  AgentEvent,
  AgentEventListener,
  ContextEditRecord,
  ContextManagementRequest,
  LLMClient,
  Message,
  ModelSpec,
  PermissionMode,
  PermissionPrompt,
  PermissionRule,
  SessionEntry,
  SessionStore,
  SystemMessage,
  ThinkingLevel,
  TodoItem,
  Tool,
  UserContent,
  UserMessage,
} from "@arcturn/types";
import {
  type CompactionOptions,
  compactMessages,
  estimateTokens,
  findCompactionCut,
  hasPendingToolRound,
  type ResolvedCompactionOptions,
  resolveCompactionOptions,
  resolveCompactionShape,
  shouldCompact,
} from "./compaction.js";
import {
  ContextEditLedger,
  type ContextEditOptions,
  planContextEditPass,
  type ResolvedContextEditOptions,
  resolveContextEditMode,
  resolveContextEditOptions,
} from "./context-edit.js";
import type { DeferredToolset } from "./deferred-tools.js";
import type { AgentHooks } from "./hooks.js";
import { type LoopResult, type LoopRuntime, runLoop, type TurnProgress } from "./loop.js";
import { isAdaptiveAnthropic } from "./model-traits.js";
import { PermissionEngine, type PermissionEngineOptions } from "./permissions.js";
import { JsonlSessionStore, SessionStoreError } from "./session/jsonl-store.js";
import { latestEntryId, materializeBranch, pathToLeaf } from "./session/tree.js";
import { type AgentStateController, isBindableTool, type PlanApproval } from "./state.js";
import { errorText, lastAssistantText, operatorMessage, userMessage } from "./util/content.js";
import { createId, createSessionId } from "./util/ids.js";

/**
 * Who a steering message is from — see {@link Agent.steer}.
 *
 * `"user"` (the default) is the person: what they typed while the run was in
 * flight, an @-mention, an image, a skill they invoked. `"operator"` is the
 * host itself — a reminder, a status change, a policy nudge it authored — and
 * travels on the operator channel (`SystemMessage`), which a prompt injection
 * cannot forge. Never mark text from a tool, a file or another agent as
 * operator: that would hand it operator authority.
 */
export interface SteerOptions {
  from?: "user" | "operator";
}

/** One local context-editing pass the agent made; see `planContextEditPass`. */
export interface ContextEditPass {
  /** Zero-based index of the request (since construction) the pass went out with. */
  requestIndex: number;
  /** Tool-call ids whose results it elided. */
  elided: string[];
  /** Characters it removed from the request. */
  charsSaved: number;
}

/** A `state` session entry before its id, parent and time are fixed. */
interface StateEntryDraft {
  kind: "state";
  todos?: TodoItem[];
  plan?: string;
  model?: string;
  contextEdit?: ContextEditRecord;
  head?: string;
}

/** Construction options for {@link Agent}. */
export interface AgentOptions {
  /** Streaming LLM client. Injected so core never depends on a provider. */
  llm: LLMClient;
  /** Model used for turns (and, unless overridden, for compaction). */
  model: ModelSpec;
  /** System prompt; a function is re-evaluated before every turn. */
  systemPrompt: string | (() => string);
  /** Tools offered to the model. Bindable tools are wired automatically. */
  tools?: Tool[];
  /**
   * Overrides {@link AgentOptions.tools} per turn, given the model the turn
   * goes to — e.g. `(model) => toolset.toolsFor(model)` for progressive tool
   * disclosure, which takes the provider's native tool search where the model
   * has it. Tools returned here must already be bound (pass the full set
   * through `tools` as well).
   */
  getTools?: (model: ModelSpec) => Tool[];
  /**
   * Progressive tool disclosure, wired end to end: unless `getTools` says
   * otherwise, each turn's tools are `toolset.toolsFor(model)` (native tool
   * search where the model has it); every assistant message is
   * {@link DeferredToolset.observe | observed} so the provider's own search
   * results land on the toolset's record; and {@link Agent.resume} replays the
   * transcript into it, so a resumed session sends the tool set it ended with.
   * A function form is re-read every time, for a host that swaps the toolset
   * (an MCP reconnect rebuilds it).
   */
  deferredTools?: DeferredToolset | (() => DeferredToolset);
  /** Permission rules, mode and allow lists. */
  permissions?: PermissionEngineOptions;
  /** Where to persist the session tree. Omit for an unpersisted agent. */
  sessionStore?: SessionStore;
  /** Session id; a random one is generated when omitted. */
  sessionId?: string;
  /** Title stored on the session header when it is created. */
  title?: string;
  /** Working directory handed to every tool. */
  cwd: string;
  /** Safety valve on loop iterations. Defaults to 64. */
  maxTurns?: number;
  /** Extended thinking level. Defaults to `"off"`. */
  thinking?: ThinkingLevel;
  /** Prompts the user when rules do not settle a permission check. */
  onPermissionAsk?: PermissionPrompt;
  /** Automatic-compaction tuning. */
  compaction?: CompactionOptions;
  /** Tool-result context editing applied to each outgoing request. */
  contextEditing?: ContextEditOptions;
  /** Interceptors around tool calls. */
  hooks?: AgentHooks;
  /** Run a turn's tool calls concurrently. Defaults to sequential. */
  parallelTools?: boolean;
  /**
   * Judge how the run is going, at the top of every turn after the first.
   *
   * A returned non-empty string is sent to the model once as a user message —
   * riding the next request without spending a turn — and surfaced as a `warn`
   * notice and a `progressWarning` event. The same wording is never sent
   * twice in one run, so the check may return it unconditionally once its
   * condition holds. Omitted means no check and no behaviour change.
   *
   * Exists because a turn ceiling is a lagging indicator: a builder that spent
   * all 80 turns reading and wrote nothing fails identically to one that ran
   * out of room mid-write, and only the host knows which one it asked for.
   */
  progressCheck?: (progress: TurnProgress) => string | undefined;
  /** External abort signal; aborting it aborts the current run. */
  signal?: AbortSignal;
  /** Seed conversation, e.g. when resuming a branch. */
  messages?: Message[];
  /** Seed todo list. */
  todos?: TodoItem[];
  /** Seed plan. */
  plan?: string;
  /** Session entry that new entries should hang off (branch tip). */
  parentEntryId?: string | null;
}

/** Options for {@link Agent.resume}. */
export interface AgentResumeOptions extends AgentOptions {
  sessionStore: SessionStore;
  sessionId: string;
  /**
   * Branch tip to resume from. Defaults to the newest entry; pointing at an
   * older entry starts a new branch from there.
   */
  leafId?: string;
  /**
   * Turn the model id stored on the branch back into a spec, so a session
   * resumes on the model it was last switched to.
   *
   * `setModel` writes the id into a `state` entry and `materializeBranch`
   * reads it back, but core has no model catalog to resolve it against — so
   * without this the value round-trips to nowhere and a resume silently
   * reverts to whatever model the caller happened to construct with.
   *
   * Optional and inert when omitted: `options.model` is used exactly as
   * before. Returning `undefined` (an id this build no longer registers)
   * falls back to `options.model` too.
   */
  resolveModel?: (modelId: string) => ModelSpec | undefined;
}

/**
 * Turn ceiling for one run.
 *
 * This is a runaway-loop backstop, not a budget: a cost ceiling
 * (`maxCostUsd`) bounds the thing anyone actually cares about, so this sits
 * high enough that a genuinely long task finishes rather than being cut off
 * mid-way. Lower it per run with `maxTurns` when you want a tight leash.
 */
const DEFAULT_MAX_TURNS = 200;

/** A conversational agent: the runtime heart of Arcturn. */
export class Agent {
  readonly #llm: LLMClient;
  readonly #cwd: string;
  readonly #sessionId: string;
  readonly #title: string | undefined;
  readonly #store: SessionStore | undefined;
  readonly #hooks: AgentHooks | undefined;
  readonly #maxTurns: number;
  readonly #parallelTools: boolean;
  readonly #progressCheck: ((progress: TurnProgress) => string | undefined) | undefined;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #systemPrompt: string | (() => string);
  readonly #permissions: PermissionEngine;
  readonly #compaction: ResolvedCompactionOptions;
  readonly #compactionOptions: CompactionOptions;
  readonly #contextEdit: ResolvedContextEditOptions;
  readonly #listeners = new Set<AgentEventListener>();
  #getTools: ((model: ModelSpec) => Tool[]) | undefined;
  readonly #deferred: (() => DeferredToolset) | undefined;
  readonly #messages: Message[];
  readonly #entryIds = new WeakMap<Message, string>();
  readonly #steering: Array<UserMessage | SystemMessage> = [];
  /** What local context editing has done to the outgoing history. */
  readonly #ledger = new ContextEditLedger();
  readonly #passes: ContextEditPass[] = [];
  #requestCount = 0;
  /** Fingerprint of `system` + `tools` of the last request, to notice when they change. */
  #lastHead: string | undefined;
  /** The deferred tools (name -> definition) the last request carried. */
  #lastDeferred: ReadonlyMap<string, string> = new Map();
  /** The fingerprint last written to the session, so only a change is persisted. */
  #persistedHead: string | undefined;
  /** State-entry writes not yet settled; the next awaited append waits for them. */
  #stateWrites: Array<Promise<unknown>> = [];
  #warnedOfHeadChange = false;

  #tools: Tool[];
  #model: ModelSpec;
  #thinking: ThinkingLevel;
  #todos: TodoItem[];
  /** Set when a run ended with a todo still `inProgress`; consumed next turn. */
  #staleTodoReminder: number | undefined;
  #plan: string | undefined;
  #running = false;
  #abort: AbortController | undefined;
  #lastEntryId: string | null;
  #sessionReady: Promise<void> | undefined;

  constructor(options: AgentOptions) {
    this.#llm = options.llm;
    this.#model = options.model;
    this.#systemPrompt = options.systemPrompt;
    this.#cwd = options.cwd;
    this.#sessionId = options.sessionId ?? createSessionId();
    this.#title = options.title;
    this.#store = options.sessionStore;
    this.#hooks = options.hooks;
    this.#maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.#thinking = options.thinking ?? "off";
    this.#parallelTools = options.parallelTools ?? false;
    this.#progressCheck = options.progressCheck;
    this.#externalSignal = options.signal;
    this.#messages = [...(options.messages ?? [])];
    this.#todos = [...(options.todos ?? [])];
    this.#plan = options.plan;
    this.#lastEntryId = options.parentEntryId ?? null;
    this.#compactionOptions = options.compaction ?? {};
    this.#compaction = resolveCompactionOptions(options.compaction);
    this.#contextEdit = resolveContextEditOptions(options.contextEditing);

    this.#permissions = new PermissionEngine({
      ...options.permissions,
      ...(options.onPermissionAsk ? { requester: options.onPermissionAsk } : {}),
      onEvent: (event) => this.#emit(event),
    });

    this.#tools = [];
    this.setTools(options.tools ?? []);
    const deferred = options.deferredTools;
    this.#deferred = typeof deferred === "function" ? deferred : deferred && (() => deferred);
    const fromToolset = this.#deferred;
    this.#getTools =
      options.getTools ??
      (fromToolset === undefined ? undefined : (model) => fromToolset().toolsFor(model));
  }

  /**
   * Rebuild an agent from a stored session branch.
   *
   * @param options - Standard agent options plus the store, session id and an
   *   optional branch tip. Resuming from an older entry starts a new branch.
   */
  static async resume(options: AgentResumeOptions): Promise<Agent> {
    const entries = await options.sessionStore.entries(options.sessionId);
    const leafId = options.leafId ?? latestEntryId(entries);
    const branch = leafId === null ? [] : pathToLeaf(entries, leafId);
    const state = materializeBranch(branch);

    const storedModel = state.model === undefined ? undefined : options.resolveModel?.(state.model);
    const agent = new Agent({
      ...options,
      ...(storedModel === undefined ? {} : { model: storedModel }),
      messages: state.messages,
      todos: state.todos,
      ...(state.plan === undefined ? {} : { plan: state.plan }),
      parentEntryId: state.leafId,
    });
    agent.#sessionReady = Promise.resolve();

    // Re-link messages to the entries they came from so a later compaction can
    // record an accurate `upToId`. The mapping comes from the replay itself
    // rather than from walking the branch in lockstep with the messages: a
    // compaction makes those two sequences different lengths AND different
    // orders, so the lockstep walk mis-linked every message on a branch that
    // had ever been compacted. The next compaction then wrote an `upToId`
    // naming a folded-away entry, and the resume after that replayed the
    // summary alone — the whole conversation since the first compaction gone
    // from the file's reading of itself while the live agent still held it.
    for (const [index, message] of state.messages.entries()) {
      const entryId = state.messageEntryIds[index];
      if (entryId !== undefined) agent.#entryIds.set(message, entryId);
    }
    // The constructor copies the array but not the messages, so the indices
    // the replay computed still name these objects.
    agent.#deferred?.().replay(state.messages);
    // What the earlier thinking was produced under; the first request after
    // this resume compares its own head against it.
    agent.#lastHead = state.head;
    agent.#persistedHead = state.head;
    agent.#ledger.apply({ elided: state.contextEdit.elided }, state.messages);
    for (const index of state.contextEdit.withheldThinking) {
      const message = agent.#messages[index];
      if (message !== undefined) agent.#ledger.withhold(message);
    }
    return agent;
  }

  // ---------------------------------------------------------------- accessors

  /** Session id this agent reads and writes. */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** Working directory handed to tools. */
  get cwd(): string {
    return this.#cwd;
  }

  /** A snapshot of the conversation. */
  get messages(): readonly Message[] {
    return [...this.#messages];
  }

  /** Whether a run is in flight. */
  get isRunning(): boolean {
    return this.#running;
  }

  /** A snapshot of the todo list. */
  get todos(): readonly TodoItem[] {
    return [...this.#todos];
  }

  /** The most recently presented plan, if any. */
  get plan(): string | undefined {
    return this.#plan;
  }

  /** The model used for turns. */
  get model(): ModelSpec {
    return this.#model;
  }

  /** The current extended-thinking level. */
  get thinking(): ThinkingLevel {
    return this.#thinking;
  }

  /** The permission engine, for hosts that manage rules at runtime. */
  get permissions(): PermissionEngine {
    return this.#permissions;
  }

  /** The active permission mode. */
  get permissionMode(): PermissionMode {
    return this.#permissions.mode;
  }

  /** Tools currently offered to the model. */
  get tools(): readonly Tool[] {
    return [...this.#tools];
  }

  /** Id of the last appended session entry, i.e. the current branch tip. */
  get leafEntryId(): string | null {
    return this.#lastEntryId;
  }

  /** Estimated context usage of the current conversation, in tokens. */
  get estimatedTokens(): number {
    return estimateTokens(this.#messages);
  }

  /**
   * The local context-editing passes this agent made since construction, in
   * order. Between two passes every request it sent extended the previous one;
   * each pass is the one deliberate rewrite of already-sent history.
   */
  get contextEditPasses(): readonly ContextEditPass[] {
    return this.#passes.map((pass) => ({ ...pass, elided: [...pass.elided] }));
  }

  // ------------------------------------------------------------------ mutators

  /**
   * Switch models mid-session; recorded as a `state` session entry.
   *
   * @param model - The model to use from the next turn onwards.
   */
  setModel(model: ModelSpec): void {
    this.#model = model;
    this.#recordState({ kind: "state", model: model.id });
  }

  /**
   * Change the extended-thinking level.
   *
   * @param thinking - New thinking level.
   */
  setThinking(thinking: ThinkingLevel): void {
    this.#thinking = thinking;
  }

  /**
   * Change the permission mode (e.g. entering or leaving plan mode).
   *
   * @param mode - New permission mode.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.#permissions.setMode(mode);
  }

  /**
   * Add a permission rule for the rest of the session.
   *
   * @param rule - Rule to append.
   */
  addPermissionRule(rule: PermissionRule): void {
    this.#permissions.addRule(rule);
  }

  /**
   * Replace the tool set, binding any {@link BindableTool}s to this agent.
   *
   * Bindable tools hold a reference to the agent that bound them last, so do
   * not share a single instance between agents.
   *
   * @param tools - The new tool list.
   */
  setTools(tools: Tool[]): void {
    this.#tools = [...tools];
    const controller = this.#controller();
    for (const tool of this.#tools) {
      if (isBindableTool(tool)) tool.bindAgent(controller);
    }
  }

  // -------------------------------------------------------------------- events

  /**
   * Subscribe to the agent's event stream.
   *
   * Listener exceptions are swallowed so one bad consumer cannot break a run.
   *
   * @param listener - Called for every emitted event.
   * @returns An unsubscribe function.
   */
  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Subscribe to a single event type, with the payload narrowed for you.
   *
   * The discriminated union already makes `subscribe` + `switch` fully
   * type-safe; this is the ergonomic form for workflow code that cares about
   * one event: `agent.on("toolEnd", (e) => log(e.result))`.
   *
   * @param type - An {@link AgentEvent} type name (compiler-checked).
   * @param listener - Called with the event, narrowed to that type.
   * @returns An unsubscribe function.
   */
  on<T extends AgentEvent["type"]>(
    type: T,
    listener: (event: Extract<AgentEvent, { type: T }>) => void,
  ): () => void {
    return this.subscribe((event) => {
      if (event.type === type) listener(event as Extract<AgentEvent, { type: T }>);
    });
  }

  // ----------------------------------------------------------------- execution

  /**
   * Run one prompt to completion.
   *
   * Resolves when the model stops calling tools, the run is aborted, or an
   * error is recorded. Runtime failures surface as a `runEnd` event with
   * reason `"error"`, never as a rejected promise.
   *
   * @param input - Prompt text or ready-made user content.
   * @throws When a run is already in flight; use {@link Agent.steer} instead.
   */
  async prompt(input: string | UserContent[]): Promise<void> {
    if (this.#running) {
      throw new Error("Agent is already running; use steer() to add to the current run.");
    }
    this.#running = true;
    // Messages steered while idle are kept: steer() promises they are queued
    // for the next run, and a client racing steer() against prompt() would
    // otherwise lose one silently.
    const queuedWhileIdle = this.#steering.splice(0, this.#steering.length);

    const controller = new AbortController();
    this.#abort = controller;
    const onExternalAbort = () => controller.abort();
    this.#externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (this.#externalSignal?.aborted) controller.abort();

    const prompt = userMessage(input);
    this.#emit({ type: "runStart", sessionId: this.#sessionId, prompt });

    let result: LoopResult;
    try {
      await this.#ensureSession();
      await this.#appendMessage(prompt);
      for (const message of queuedWhileIdle) await this.#appendMessage(message);
      // Appended after the prompt so the model reads the user's actual request
      // first and the bookkeeping second.
      const reminder = this.#staleTodoReminder;
      this.#staleTodoReminder = undefined;
      if (reminder !== undefined) {
        // The harness speaking, not the user: the operator channel. Only the
        // harness's own words go on it — the todo text is the model's, and may
        // have been planted by a tool result or a web page the model read, so
        // it is counted here, never quoted (the user's notice names the items).
        await this.#appendMessage(
          operatorMessage(
            `Reminder: ${reminder === 1 ? "a todo item was" : `${String(reminder)} todo items were`} ` +
              "left in progress when the previous run ended. Update the todo list to " +
              "reflect what actually finished before continuing.",
          ),
        );
      }
      result = await runLoop(this.#runtime(controller.signal));
    } catch (error) {
      result = { reason: "error", errorMessage: errorText(error) };
    } finally {
      this.#externalSignal?.removeEventListener("abort", onExternalAbort);
      this.#abort = undefined;
      this.#running = false;
    }

    if (result.reason === "completed") this.#flagStaleTodos();

    this.#emit({
      type: "runEnd",
      reason: result.reason,
      ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
    });
  }

  /**
   * Notice a todo left `inProgress` by a run that has finished.
   *
   * A completed run means the agent stopped working, so nothing can still be
   * in progress: the item is stale because the model forgot to mark it, and
   * the list the user is watching now misreports finished work as stalled.
   * The tool description already asks for an update, so the harness cannot
   * rely on asking again — instead the user is told the list may be stale, and
   * the model is reminded on its next turn so it can correct itself.
   */
  #flagStaleTodos(): void {
    const stale = this.#todos.filter((todo) => todo.status === "inProgress");
    if (stale.length === 0) return;

    const names = stale.map((todo) => `"${todo.text}"`).join(", ");
    this.#emit({
      type: "notice",
      level: "warn",
      text:
        stale.length === 1
          ? `${names} is still marked in progress. Mark it done if the work finished.`
          : `${names} are still marked in progress. Update them if the work finished.`,
    });
    this.#staleTodoReminder = stale.length;
  }

  /**
   * Queue a steering message, injected after the current tool batch finishes.
   *
   * When the agent is idle the message is queued for the next run instead.
   *
   * By default the message is the user's — what they typed into the run, with
   * any images or @-mentions — and is sent as a user message, exactly as it
   * always was. A host that is itself speaking (a reminder or status it
   * authored) passes `{ from: "operator" }` with plain text, and the message
   * rides the operator channel: an appended `role: "system"` message where the
   * model takes one, a reminder folded into the user turn elsewhere. See
   * {@link SteerOptions} for what must never be sent that way.
   *
   * @param input - Steering text or content blocks (user steering only).
   * @param options - Who is speaking; defaults to the user.
   * @throws TypeError for operator steering given anything but a string.
   */
  steer(input: string | UserContent[], options: SteerOptions = {}): void {
    if (options.from === "operator") {
      if (typeof input !== "string") {
        throw new TypeError("Operator steering is text only; pass a string.");
      }
      this.#steering.push(operatorMessage(input));
      return;
    }
    this.#steering.push(userMessage(input));
  }

  /** Abort the current run. Has no effect when the agent is idle. */
  abort(): void {
    this.#abort?.abort();
  }

  /**
   * Compact the conversation now, regardless of the automatic threshold.
   *
   * @returns `true` when history was folded into a summary.
   * @throws When a run is in flight.
   */
  async compact(): Promise<boolean> {
    if (this.#running) throw new Error("Cannot compact while the agent is running.");
    const signal = this.#abort?.signal;
    return this.#compact(signal);
  }

  /** The text of the last assistant message, or an empty string. */
  finalText(): string {
    return lastAssistantText(this.#messages);
  }

  // ------------------------------------------------------------------ internals

  #runtime(signal: AbortSignal): LoopRuntime {
    return {
      llm: this.#llm,
      messages: this.#messages,
      getModel: () => this.#model,
      getSystemPrompt: () =>
        typeof this.#systemPrompt === "function" ? this.#systemPrompt() : this.#systemPrompt,
      getTools: () => this.#currentTools(),
      getThinking: () => this.#thinking,
      appendMessage: (message) => this.#appendMessage(message),
      emit: (event) => this.#emit(event),
      permissions: this.#permissions,
      hooks: this.#hooks,
      cwd: this.#cwd,
      sessionId: this.#sessionId,
      signal,
      maxTurns: this.#maxTurns,
      parallelTools: this.#parallelTools,
      ...(this.#progressCheck ? { progressCheck: this.#progressCheck } : {}),
      takeSteering: () => this.#steering.splice(0, this.#steering.length),
      beforeTurn: async () => {
        if (!this.#compaction.enabled) return;
        // The provider compacts a "server" session itself.
        if (resolveCompactionShape(this.#compaction, this.#model) === "server") return;
        const tokens = estimateTokens(this.#messages);
        if (!shouldCompact(tokens, this.#model.contextWindow, this.#compactionOptions)) return;
        await this.#compact(signal);
      },
      prepareMessages: (messages) => this.#prepareMessages(messages),
      contextManagement: () => this.#contextManagement(),
    };
  }

  #currentTools(): Tool[] {
    return this.#getTools?.(this.#model) ?? this.#tools;
  }

  /** Server-side context management the next request asks for. */
  #contextManagement(): ContextManagementRequest | undefined {
    const compact =
      this.#compaction.enabled &&
      resolveCompactionShape(this.#compaction, this.#model) === "server";
    const clearToolUses =
      this.#contextEdit.enabled &&
      resolveContextEditMode(this.#contextEdit, this.#model) === "server";
    if (!compact && !clearToolUses) return undefined;
    return {
      ...(compact ? { compact: true } : {}),
      ...(clearToolUses
        ? { clearToolUses: true, protectTools: [...this.#contextEdit.protectToolNames] }
        : {}),
    };
  }

  /**
   * Shape the outgoing history: notice a changed `system`/`tools` head, run a
   * local context-editing pass when one is due, and render the ledger. Never
   * touches the stored conversation.
   */
  #prepareMessages(messages: readonly Message[]): Message[] {
    const requestIndex = this.#requestCount++;
    const bound = isAdaptiveAnthropic(this.#model);
    this.#noticeHeadChange(messages, bound);
    if (resolveContextEditMode(this.#contextEdit, this.#model) === "local") {
      const pass = planContextEditPass(messages, this.#ledger, this.#contextEdit, bound);
      if (pass !== undefined) {
        this.#recordEdit(pass.record, messages);
        this.#passes.push({
          requestIndex,
          elided: [...pass.record.elided],
          charsSaved: pass.charsSaved,
        });
        this.#emit({
          type: "contextEdit",
          elidedCount: pass.elidedCount,
          charsSaved: pass.charsSaved,
        });
      }
    }
    return this.#ledger.render(messages, this.#contextEdit);
  }

  /** Apply a context-edit record live and persist it, so a resume replays it. */
  #recordEdit(record: ContextEditRecord, messages: readonly Message[]): void {
    this.#ledger.apply(record, messages);
    this.#recordState({ kind: "state", contextEdit: record });
  }

  /**
   * Write a state entry from the synchronous request-shaping path. Its id and
   * parent are fixed now, so it stays ordered with the message entries, and the
   * next awaited append settles it first: a failed write then fails that
   * append instead of leaving later entries parented on an entry that never
   * reached the file (which a resume would read as a branch starting there).
   */
  #recordState(draft: StateEntryDraft): void {
    const entry = this.#stamp(draft);
    const write = this.#write(entry, [...this.#stateWrites]);
    this.#stateWrites.push(write);
    // Settled by the next awaited append; this only keeps a rejection from
    // being reported as unhandled in the meantime.
    write.catch(() => undefined);
  }

  /**
   * Notice when this request's `system` prompt or tool set differs from the
   * previous request's — a deferred tool activated on arcturn's own path, an
   * MCP server attached, a system prompt that changed.
   *
   * Either is a prefix edit at the very top of the conversation: the prompt
   * cache starts over, and on adaptive Claude every earlier thinking block was
   * produced under the old head, so none of it is replayed again (withholding
   * them all is a removal from the front, which the API accepts). Said once
   * per agent, on adaptive Claude, where it costs the most.
   *
   * A resume compares against the head the session last recorded, so the same
   * holds across processes.
   */
  #noticeHeadChange(messages: readonly Message[], bound: boolean): void {
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    const definitions = this.#currentTools()
      .map((tool) => tool.definition)
      .sort(byName);
    // A deferred (`defer_loading`) tool sits outside the cached prefix and the
    // thinking binding until something references it, so one that is merely
    // added — an MCP server that connected after the first request — is no
    // edit. One that was already there and is gone or changed is.
    const loaded = definitions.filter((definition) => definition.deferLoading !== true);
    const deferred = new Map(
      definitions
        .filter((definition) => definition.deferLoading === true)
        .map((definition) => [definition.name, JSON.stringify(definition)] as const),
    );
    const system =
      typeof this.#systemPrompt === "function" ? this.#systemPrompt() : this.#systemPrompt;
    const head = createHash("sha256")
      .update(JSON.stringify({ system, tools: loaded }))
      .digest("hex");
    const previous = this.#lastHead;
    const previousDeferred = this.#lastDeferred;
    this.#lastHead = head;
    this.#lastDeferred = deferred;
    const deferredChanged = [...previousDeferred].some(
      ([name, json]) => deferred.get(name) !== json,
    );
    // Recorded with the session, so a resume can tell that the head it comes
    // back with differs from the one the stored thinking was produced under —
    // an MCP server that failed to start, a skill that no longer loads.
    // Only where thinking is bound to the head: elsewhere nothing would read it.
    if (bound && head !== this.#persistedHead) {
      this.#persistedHead = head;
      this.#recordState({ kind: "state", head });
    }
    if (previous === undefined || (previous === head && !deferredChanged) || !bound) return;
    if (messages.some((message) => message.role === "assistant")) {
      this.#recordEdit({ elided: [], withholdThinking: "all" }, messages);
    }
    if (this.#warnedOfHeadChange) return;
    this.#warnedOfHeadChange = true;
    this.#emit({
      type: "notice",
      level: "info",
      text:
        `The system prompt or tool set changed between requests on ${this.#model.displayName}, ` +
        "so the prompt cache restarts from the top of the conversation and earlier thinking " +
        "is no longer replayed. On first-party Anthropic, deferred tools avoid this through " +
        "native tool search.",
    });
  }

  #controller(): AgentStateController {
    return {
      sessionId: this.#sessionId,
      cwd: this.#cwd,
      emit: (event) => this.#emit(event),
      getTodos: () => [...this.#todos],
      setTodos: async (todos) => {
        this.#todos = [...todos];
        this.#emit({ type: "todoUpdate", todos: [...this.#todos] });
        await this.#appendEntry({ kind: "state", todos: this.#todos });
      },
      getPlan: () => this.#plan,
      setPlan: async (plan) => {
        this.#plan = plan;
        this.#emit({ type: "planUpdate", plan });
        await this.#appendEntry({ kind: "state", plan });
      },
      getPermissionMode: () => this.#permissions.mode,
      setPermissionMode: (mode) => this.#permissions.setMode(mode),
      requestPlanApproval: (plan, toolCallId) => this.#requestPlanApproval(plan, toolCallId),
    };
  }

  async #requestPlanApproval(plan: string, toolCallId: string): Promise<PlanApproval> {
    const decision = await this.#permissions.ask({
      toolName: "plan",
      toolCallId,
      subject: "exitPlanMode",
      description: `Approve this plan and leave plan mode?\n\n${plan}`,
    });
    return {
      approved: decision.behavior === "allow",
      ...(decision.message === undefined ? {} : { message: decision.message }),
    };
  }

  #emit(event: AgentEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A listener must never be able to break a run.
      }
    }
  }

  async #ensureSession(): Promise<void> {
    const store = this.#store;
    if (!store) return;
    this.#sessionReady ??= (async () => {
      try {
        await store.open(this.#sessionId);
      } catch (error) {
        if (error instanceof SessionStoreError && error.code !== "notFound") throw error;
        await store.create({
          sessionId: this.#sessionId,
          cwd: this.#cwd,
          ...(this.#title === undefined ? {} : { title: this.#title }),
        });
      }
    })();
    await this.#sessionReady;
  }

  async #appendMessage(message: Message): Promise<void> {
    this.#messages.push(message);
    if (message.role === "assistant") this.#deferred?.().observe(message);
    const id = await this.#appendEntry({ kind: "message", message });
    this.#entryIds.set(message, id);
  }

  async #appendEntry(
    partial:
      | { kind: "message"; message: Message }
      | StateEntryDraft
      | { kind: "label"; label: string }
      | {
          kind: "compaction";
          summary: string;
          upToId: string;
          tokensBefore: number;
          tokensAfter: number;
          stripTailThinking?: boolean;
        },
  ): Promise<string> {
    const entry = this.#stamp(partial);
    await this.#write(entry, this.#stateWrites);
    return entry.id;
  }

  /** Fix an entry's id, parent and time now, so entries stay ordered however their writes finish. */
  #stamp(partial: object): SessionEntry {
    const id = createId("e");
    const entry = {
      ...partial,
      id,
      parentId: this.#lastEntryId,
      timestamp: Date.now(),
    } as SessionEntry;
    this.#lastEntryId = id;
    return entry;
  }

  /**
   * Persist a stamped entry after the state writes it must follow. A failed
   * one stays in {@link Agent.#stateWrites}, so every later append fails with
   * it rather than writing entries parented on one that never reached the file.
   */
  async #write(entry: SessionEntry, after: readonly Promise<unknown>[]): Promise<void> {
    const store = this.#store;
    if (!store) return;
    await this.#ensureSession();
    if (after.length > 0) {
      const waited = [...after];
      await Promise.all(waited);
      this.#stateWrites = this.#stateWrites.filter((write) => !waited.includes(write));
    }
    await store.append(this.#sessionId, entry);
  }

  async #compact(signal: AbortSignal | undefined): Promise<boolean> {
    const messages = this.#messages;
    const shape = resolveCompactionShape(this.#compaction, this.#model);
    if (shape === "server") {
      this.#emit({
        type: "notice",
        level: "info",
        text:
          'compaction.shape is "server": the provider compacts this conversation itself ' +
          "when it grows past its trigger, so there is nothing to summarize locally.",
      });
      return false;
    }
    const cutIndex = findCompactionCut(messages, shape, this.#compaction.keepRecentTokens);
    if (cutIndex <= 0) {
      this.#emit({
        type: "notice",
        level: "info",
        text: hasPendingToolRound(messages)
          ? "Not compacting now: a tool call is still waiting on its result."
          : "Nothing to compact: no turn boundary old enough to summarize.",
      });
      return false;
    }
    const lastFolded = messages[cutIndex - 1];
    const upToId = (lastFolded && this.#entryIds.get(lastFolded)) ?? this.#lastEntryId ?? "";
    const tokensBefore = estimateTokens(messages);

    this.#emit({ type: "compactionStart" });
    try {
      const result = await compactMessages({
        llm: this.#llm,
        model: this.#model,
        messages,
        options: this.#compactionOptions,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!result) {
        this.#emit({ type: "compactionEnd", summary: "", tokensBefore, tokensAfter: tokensBefore });
        return false;
      }
      const entryId = await this.#appendEntry({
        kind: "compaction",
        summary: result.summary,
        upToId,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        ...(result.stripTailThinking ? { stripTailThinking: true } : {}),
      });
      const summaryMessage = result.messages[0];
      if (summaryMessage) this.#entryIds.set(summaryMessage, entryId);
      // A kept message stripped of its thinking is a new object; it still came
      // from the same entry, which a later compaction's `upToId` must name.
      for (const [offset, kept] of result.keptIndices.entries()) {
        const original = messages[kept];
        const replacement = result.messages[offset + 1];
        const id = original === undefined ? undefined : this.#entryIds.get(original);
        if (replacement !== undefined && id !== undefined) this.#entryIds.set(replacement, id);
      }
      messages.splice(0, messages.length, ...result.messages);
      this.#emit({
        type: "compactionEnd",
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      });
      return true;
    } catch (error) {
      this.#emit({
        type: "notice",
        level: "error",
        text: `Compaction failed: ${errorText(error)}`,
      });
      this.#emit({ type: "compactionEnd", summary: "", tokensBefore, tokensAfter: tokensBefore });
      return false;
    }
  }
}

/**
 * Convenience factory for an agent backed by a JSONL session directory.
 *
 * @param options - Agent options plus the directory that holds session files.
 */
export function createAgent(options: AgentOptions & { sessionDir?: string }): Agent {
  const { sessionDir, ...rest } = options;
  if (sessionDir === undefined) return new Agent(rest);
  return new Agent({ ...rest, sessionStore: new JsonlSessionStore({ dir: sessionDir }) });
}
