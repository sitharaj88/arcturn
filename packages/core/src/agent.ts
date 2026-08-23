/**
 * The {@link Agent}: a single conversational agent bound to one session.
 *
 * It owns the conversation, the permission engine, todo/plan state, session
 * persistence and compaction, and exposes everything a UI needs through the
 * {@link AgentEvent} stream.
 */

import type {
  AgentEvent,
  AgentEventListener,
  LLMClient,
  Message,
  ModelSpec,
  PermissionMode,
  PermissionPrompt,
  PermissionRule,
  SessionEntry,
  SessionStore,
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
  findCutPoint,
  type ResolvedCompactionOptions,
  resolveCompactionOptions,
  shouldCompact,
} from "./compaction.js";
import {
  type ContextEditOptions,
  editContext,
  type ResolvedContextEditOptions,
  resolveContextEditOptions,
} from "./context-edit.js";
import type { AgentHooks } from "./hooks.js";
import { type LoopResult, type LoopRuntime, runLoop } from "./loop.js";
import { PermissionEngine, type PermissionEngineOptions } from "./permissions.js";
import { JsonlSessionStore, SessionStoreError } from "./session/jsonl-store.js";
import { latestEntryId, materializeBranch, pathToLeaf } from "./session/tree.js";
import { type AgentStateController, isBindableTool, type PlanApproval } from "./state.js";
import { errorText, lastAssistantText, userMessage } from "./util/content.js";
import { createId, createSessionId } from "./util/ids.js";

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
   * Overrides {@link AgentOptions.tools} per turn, e.g. a
   * {@link DeferredToolset.activeTools} bound method for progressive tool
   * disclosure. Tools returned here must already be bound (pass the full set
   * through `tools` as well).
   */
  getTools?: () => Tool[];
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
  readonly #externalSignal: AbortSignal | undefined;
  readonly #systemPrompt: string | (() => string);
  readonly #permissions: PermissionEngine;
  readonly #compaction: ResolvedCompactionOptions;
  readonly #compactionOptions: CompactionOptions;
  readonly #contextEdit: ResolvedContextEditOptions;
  readonly #listeners = new Set<AgentEventListener>();
  #getTools: (() => Tool[]) | undefined;
  readonly #messages: Message[];
  readonly #entryIds = new WeakMap<Message, string>();
  readonly #steering: UserMessage[] = [];

  #tools: Tool[];
  #model: ModelSpec;
  #thinking: ThinkingLevel;
  #todos: TodoItem[];
  /** Set when a run ended with a todo still `inProgress`; consumed next turn. */
  #staleTodoReminder: string | undefined;
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
    this.#getTools = options.getTools;
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

    const agent = new Agent({
      ...options,
      messages: state.messages,
      todos: state.todos,
      ...(state.plan === undefined ? {} : { plan: state.plan }),
      parentEntryId: state.leafId,
    });
    agent.#sessionReady = Promise.resolve();

    // Re-link messages to the entries they came from so a later compaction can
    // record an accurate `upToId`.
    let index = 0;
    for (const entry of branch) {
      const message = state.messages[index];
      if (!message) break;
      if (entry.kind === "message" || entry.kind === "compaction") {
        agent.#entryIds.set(message, entry.id);
        index++;
      }
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

  // ------------------------------------------------------------------ mutators

  /**
   * Switch models mid-session; recorded as a `state` session entry.
   *
   * @param model - The model to use from the next turn onwards.
   */
  setModel(model: ModelSpec): void {
    this.#model = model;
    void this.#appendEntry({ kind: "state", model: model.id }).catch(() => undefined);
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
        await this.#appendMessage(
          userMessage(
            `Reminder: ${reminder} was left in progress when the previous run ended. ` +
              "Update the todo list to reflect what actually finished before continuing.",
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
    this.#staleTodoReminder = names;
  }

  /**
   * Queue a steering message, injected after the current tool batch finishes.
   *
   * When the agent is idle the message is queued for the next run instead.
   *
   * @param input - Steering text or content blocks.
   */
  steer(input: string | UserContent[]): void {
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
      getTools: () => this.#getTools?.() ?? this.#tools,
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
      takeSteering: () => this.#steering.splice(0, this.#steering.length),
      beforeTurn: async () => {
        if (!this.#compaction.enabled) return;
        const tokens = estimateTokens(this.#messages);
        if (!shouldCompact(tokens, this.#model.contextWindow, this.#compactionOptions)) return;
        await this.#compact(signal);
      },
      prepareMessages: (messages) => {
        const result = editContext(messages, this.#contextEdit);
        if (result.elidedCount > 0) {
          this.#emit({
            type: "contextEdit",
            elidedCount: result.elidedCount,
            charsSaved: result.charsSaved,
          });
        }
        return result.messages;
      },
    };
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
    const id = await this.#appendEntry({ kind: "message", message });
    this.#entryIds.set(message, id);
  }

  async #appendEntry(
    partial:
      | { kind: "message"; message: Message }
      | { kind: "state"; todos?: TodoItem[]; plan?: string; model?: string }
      | { kind: "label"; label: string }
      | {
          kind: "compaction";
          summary: string;
          upToId: string;
          tokensBefore: number;
          tokensAfter: number;
        },
  ): Promise<string> {
    const id = createId("e");
    const entry = {
      ...partial,
      id,
      parentId: this.#lastEntryId,
      timestamp: Date.now(),
    } as SessionEntry;
    this.#lastEntryId = id;
    const store = this.#store;
    if (store) {
      await this.#ensureSession();
      await store.append(this.#sessionId, entry);
    }
    return id;
  }

  async #compact(signal: AbortSignal | undefined): Promise<boolean> {
    const messages = this.#messages;
    const cutIndex = findCutPoint(messages, this.#compaction.keepRecentTokens);
    if (cutIndex <= 0) {
      this.#emit({
        type: "notice",
        level: "info",
        text: "Nothing to compact: no turn boundary old enough to summarize.",
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
      });
      const summaryMessage = result.messages[0];
      if (summaryMessage) this.#entryIds.set(summaryMessage, entryId);
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
