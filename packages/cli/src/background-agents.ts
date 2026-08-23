/**
 * Background agents: delegate a task to a child {@link Agent} that runs to
 * completion off the foreground thread, and get notified when it lands.
 *
 * `BackgroundAgentManager` mirrors the shape of
 * `@arcturn/tools`'s `BackgroundTaskManager` (start/poll/kill/list for a
 * background *bash command*) but for a background *agent*: a full child
 * conversation with its own session file, its own tool loop, and a durable
 * status record that survives a CLI restart.
 *
 * A manager is memoized per {@link ArcturnRuntime} (see {@link getBackgroundAgentManager})
 * so the `/bg` commands and the host application always observe the same
 * instance — see `INTEGRATION-background-agents.md` for how to wire the
 * finished-agent notification into a UI.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calculateCostUsd } from "@arcturn/ai";
import {
  Agent,
  addUsage,
  contentText,
  createSessionId,
  DEFAULT_READ_ONLY_TOOLS,
  emptyUsage,
  errorText,
  JsonlSessionStore,
  latestEntryId,
  materializeBranch,
  pathToLeaf,
} from "@arcturn/core";
import type { LLMClient, Message, ModelSpec, PermissionMode, Tool, Usage } from "@arcturn/types";
import type { CommandContext, CommandUi, SlashCommand } from "./commands.js";
import { formatCost, formatDuration, oneLine } from "./format.js";
import type { ArcturnRuntime } from "./runtime.js";

/**
 * Lifecycle of one background agent.
 *
 * `interrupted` is distinct from `failed`: it means the record was still
 * `running` when this manager loaded it from disk, which only happens when
 * the process that owned it exited without finishing — there is no error
 * message from the agent itself, just an unfinished run.
 */
export type BackgroundAgentStatusValue =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

/** A snapshot of one background agent's progress and outcome. */
export interface BackgroundAgentStatus {
  /** Short id, e.g. `bg-a1b2c3d4`. */
  readonly id: string;
  /** Session id of the child agent; resumable with any `JsonlSessionStore` over the same directory. */
  readonly sessionId: string;
  /** The task text the agent was given. */
  readonly task: string;
  /** Catalog id of the model the agent ran (or is running) with. */
  readonly modelId: string;
  readonly status: BackgroundAgentStatusValue;
  /** When `start()` was called. */
  readonly createdAt: number;
  /** When the agent actually began its first turn (after any queueing delay). */
  readonly startedAt?: number;
  /** When the agent reached a terminal status. */
  readonly endedAt?: number;
  /** Wall-clock time since `startedAt` (or `createdAt` while still queued), in ms. */
  readonly elapsedMs: number;
  /** Summed token usage across every turn. */
  readonly usage: Usage;
  /** Best-effort summed cost in USD. */
  readonly costUsd: number;
  /** The last assistant message's text, once the run has produced one. */
  readonly finalText?: string;
  /** Populated when `status` is `"failed"`. */
  readonly error?: string;
}

/** Options for {@link BackgroundAgentManager.start}. */
export interface StartBackgroundAgentOptions {
  /** The task handed to the child agent as its first (and only) prompt. */
  task: string;
  /** Model override; defaults to the manager's configured model. */
  model?: ModelSpec;
  /** Working directory override; defaults to the manager's configured cwd. */
  cwd?: string;
  /**
   * Tool set override. Bypasses the default read-only-safe filtering
   * entirely — an explicit override is treated as an informed choice.
   */
  tools?: readonly Tool[];
  /**
   * Permission mode override for this one agent. Defaults to the manager's
   * configured mode. Passing `"yolo"` here is the caller's explicit,
   * one-off choice; the manager itself never escalates to it silently.
   */
  permissionMode?: PermissionMode;
}

/** Construction options for {@link BackgroundAgentManager}. */
export interface BackgroundAgentManagerOptions {
  /**
   * Directory background agent records and session files persist under.
   * Created (with a `records/` and `sessions/` subdirectory) if missing.
   */
  dir: string;
  /** LLM client shared by every background agent this manager starts. */
  llm: LLMClient;
  /** Default model for `start()` calls that don't override it. */
  model: ModelSpec;
  /** Default tool set `start()` filters down from when not overridden. */
  tools: readonly Tool[];
  /** Default working directory for `start()` calls that don't override it. */
  cwd: string;
  /** System prompt for background agents. Defaults to {@link DEFAULT_SYSTEM_PROMPT}. */
  systemPrompt?: string;
  /**
   * Default permission mode. Defaults to `"default"` — never `"yolo"`.
   * See the module doc for the reasoning; pass this (or `start()`'s
   * per-call override) explicitly to run agents with broader tool access.
   */
  permissionMode?: PermissionMode;
  /** Max background agents running at once; the rest queue. Defaults to 3. */
  concurrency?: number;
  /** Turn ceiling per background agent. Defaults to core's `Agent` default. */
  maxTurns?: number;
  /** Clock override, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** The system prompt handed to a background agent when none is configured. */
export const DEFAULT_SYSTEM_PROMPT: string = [
  "You are a Arcturn background agent: a delegated task running without a user present.",
  "Finish the task and answer with a clear, self-contained result — it will be read later, " +
    "not interactively, so state your conclusion up front.",
  "You cannot ask questions or wait for approval. If a tool call is denied, work around it or " +
    "say so plainly in your final answer rather than retrying indefinitely.",
].join("\n");

/** Background agents running at once by default; further `start()` calls queue. */
export const DEFAULT_CONCURRENCY = 3;

/** Record persisted to `<dir>/records/<id>.json`. Superset of {@link BackgroundAgentStatus}. */
interface StoredRecord {
  id: string;
  sessionId: string;
  task: string;
  modelId: string;
  status: BackgroundAgentStatusValue;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  usage: Usage;
  costUsd: number;
  finalText?: string;
  error?: string;
}

/** A background agent actually in flight (constructed, mid-`prompt()`). */
interface ActiveRun {
  agent: Agent;
  controller: AbortController;
}

/**
 * Maps a run's outcome to the record's terminal status.
 *
 * A plain lookup rather than a chained ternary: `reason` is reassigned from
 * inside the `agent.subscribe` callback, and TypeScript cannot narrow a
 * closure-captured `let` through equality checks the way it can a
 * synchronously-assigned one — a lookup sidesteps that instead of fighting it.
 */
const RUN_OUTCOME_TO_STATUS: Readonly<
  Record<"completed" | "aborted" | "error", "done" | "cancelled" | "failed">
> = {
  completed: "done",
  aborted: "cancelled",
  error: "failed",
};

/**
 * The tool set offered to a background agent when the caller does not pass
 * an explicit `tools` override.
 *
 * Mirrors {@link ArcturnRuntime.createSubagent}'s non-`yolo` posture exactly:
 * read-only tools plus `fetch` (still permission-gated, so with no requester
 * attached it denies safely rather than running) when the effective mode is
 * not `"yolo"`; the full inherited set only when the caller explicitly opted
 * into `"yolo"` for this agent. `subagent` is always excluded, so a
 * background agent can never fan out into further delegation.
 */
function defaultToolsForMode(mode: PermissionMode, tools: readonly Tool[]): Tool[] {
  const names: Set<string> =
    mode === "yolo"
      ? new Set(tools.map((tool) => tool.definition.name))
      : new Set([...DEFAULT_READ_ONLY_TOOLS, "fetch"]);
  names.delete("subagent");
  return tools.filter((tool) => names.has(tool.definition.name));
}

/** Render a background agent's transcript so far as plain lines. */
function formatTranscript(messages: readonly Message[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const value = contentText(message.content);
      if (value.trim() !== "") lines.push(`> ${oneLine(value, 400)}`);
    } else if (message.role === "assistant") {
      const value = contentText(message.content);
      if (value.trim() !== "") lines.push(`[assistant] ${oneLine(value, 400)}`);
      for (const block of message.content) {
        if (block.type === "toolCall") {
          lines.push(`  → ${block.name}(${oneLine(JSON.stringify(block.arguments), 200)})`);
        }
      }
    } else {
      const value = contentText(message.content);
      const mark = message.isError ? "✗" : "✓";
      lines.push(`  ${mark} ${message.toolName}: ${oneLine(value, 400)}`);
    }
  }
  return lines;
}

/**
 * Spawns and tracks child agents that run a delegated task to completion
 * without blocking the foreground conversation.
 *
 * Durability: every record is written synchronously to `<dir>/records`
 * whenever its status changes, and re-read synchronously at construction —
 * `list()`/`get()` are synchronous, so loading happens on the same
 * schedule. A record still `"running"` when a fresh manager loads it is, by
 * construction, one this process has no live handle for (a truly live one
 * would have been reported by the manager that started it), so it is
 * corrected to `"interrupted"` on load rather than reported as running
 * forever.
 */
export class BackgroundAgentManager {
  readonly #recordsDir: string;
  readonly #store: JsonlSessionStore;
  readonly #concurrency: number;
  readonly #systemPrompt: string;
  readonly #maxTurns: number | undefined;
  readonly #now: () => number;

  #llm: LLMClient;
  #model: ModelSpec;
  #tools: Tool[];
  #cwd: string;
  #permissionMode: PermissionMode;

  readonly #records = new Map<string, StoredRecord>();
  readonly #order: string[] = [];
  readonly #queue: string[] = [];
  readonly #pending = new Map<string, StartBackgroundAgentOptions>();
  readonly #active = new Map<string, ActiveRun>();
  readonly #listeners = new Set<(status: BackgroundAgentStatus) => void>();

  constructor(options: BackgroundAgentManagerOptions) {
    this.#recordsDir = join(options.dir, "records");
    this.#store = new JsonlSessionStore({ dir: join(options.dir, "sessions") });
    this.#llm = options.llm;
    this.#model = options.model;
    this.#tools = [...options.tools];
    this.#cwd = options.cwd;
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#permissionMode = options.permissionMode ?? "default";
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
    this.#maxTurns = options.maxTurns;
    this.#now = options.now ?? Date.now;
    mkdirSync(this.#recordsDir, { recursive: true });
    this.#load();
  }

  /**
   * Refresh the model/tools/cwd/llm used for future `start()` calls that
   * don't override them.
   *
   * Cheap; a host holding onto one manager across a session (see
   * {@link getBackgroundAgentManager}) should call this whenever its own
   * defaults may have moved — a `/model` switch, an MCP server attaching
   * tools — so an agent started afterwards reflects them.
   */
  setDefaults(defaults: {
    llm?: LLMClient;
    model?: ModelSpec;
    tools?: readonly Tool[];
    cwd?: string;
  }): void {
    if (defaults.llm) this.#llm = defaults.llm;
    if (defaults.model) this.#model = defaults.model;
    if (defaults.tools) this.#tools = [...defaults.tools];
    if (defaults.cwd) this.#cwd = defaults.cwd;
  }

  /**
   * Start a background agent. Returns immediately — the child runs off the
   * foreground thread and may not even have started yet if the concurrency
   * cap is at capacity, in which case it queues (FIFO) and starts as soon
   * as a slot frees up.
   *
   * @throws When `task` is empty.
   */
  start(options: StartBackgroundAgentOptions): { id: string; sessionId: string } {
    const task = options.task.trim();
    if (task === "") throw new Error("task must be a non-empty string");

    const id = this.#newId();
    const sessionId = createSessionId();
    const model = options.model ?? this.#model;
    const record: StoredRecord = {
      id,
      sessionId,
      task,
      modelId: model.id,
      status: "running",
      createdAt: this.#now(),
      usage: emptyUsage(),
      costUsd: 0,
    };
    this.#records.set(id, record);
    this.#order.push(id);
    this.#persist(record);
    this.#pending.set(id, options);
    this.#queue.push(id);
    this.#emit(record);
    this.#pump();
    return { id, sessionId };
  }

  /** Every background agent this manager knows about, newest first. */
  list(): BackgroundAgentStatus[] {
    return this.#order
      .map((id) => this.#records.get(id))
      .filter((record): record is StoredRecord => record !== undefined)
      .map((record) => this.#toStatus(record))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** One background agent's current status, or `undefined` for an unknown id. */
  get(id: string): BackgroundAgentStatus | undefined {
    const record = this.#records.get(id);
    return record ? this.#toStatus(record) : undefined;
  }

  /**
   * Cancel a background agent: dequeues it if it hasn't started yet, or
   * aborts its child agent's signal if it has (which cascades through
   * `@arcturn/core`'s loop, appending synthetic tool results so no call is
   * left dangling — see `runLoop`).
   *
   * @returns `false` for an unknown id or one that already reached a
   *   terminal status; `true` once cancellation has been initiated (the
   *   status transition itself is asynchronous — await {@link result} to
   *   observe it).
   */
  cancel(id: string): boolean {
    const record = this.#records.get(id);
    if (record?.status !== "running") return false;

    const active = this.#active.get(id);
    if (active) {
      active.controller.abort();
      return true;
    }

    const queued = this.#queue.indexOf(id);
    if (queued === -1) return false;
    this.#queue.splice(queued, 1);
    this.#pending.delete(id);
    record.status = "cancelled";
    record.endedAt = this.#now();
    this.#persist(record);
    this.#emit(record);
    return true;
  }

  /**
   * Resolve once a background agent reaches a terminal status.
   *
   * @returns `undefined` for an unknown id; otherwise the final status
   *   (immediately, if it is already terminal).
   */
  async result(id: string): Promise<BackgroundAgentStatus | undefined> {
    const record = this.#records.get(id);
    if (!record) return undefined;
    if (record.status !== "running") return this.#toStatus(record);
    return new Promise((resolve) => {
      const unsubscribe = this.onUpdate((status) => {
        if (status.id !== id || status.status === "running") return;
        unsubscribe();
        resolve(status);
      });
    });
  }

  /**
   * The background agent's conversation so far, reconstructed from its
   * durable session file — works whether it is still running, finished, or
   * this is a fresh manager over the same directory after a restart.
   *
   * @returns `undefined` for an unknown id; an empty array when nothing has
   *   been appended yet (e.g. a queued agent that never started).
   */
  async transcript(id: string): Promise<Message[] | undefined> {
    const record = this.#records.get(id);
    if (!record) return undefined;
    try {
      const entries = await this.#store.entries(record.sessionId);
      const leafId = latestEntryId(entries);
      const branch = leafId === null ? [] : pathToLeaf(entries, leafId);
      return materializeBranch(branch).messages;
    } catch {
      return [];
    }
  }

  /**
   * Subscribe to status changes: fired once when a background agent starts
   * and once more when it reaches a terminal status.
   *
   * @returns An unsubscribe function.
   */
  onUpdate(listener: (status: BackgroundAgentStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // ------------------------------------------------------------------ internals

  #newId(): string {
    let id: string;
    do {
      id = `bg-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    } while (this.#records.has(id));
    return id;
  }

  #pump(): void {
    while (this.#queue.length > 0 && this.#active.size < this.#concurrency) {
      const id = this.#queue.shift();
      if (id === undefined) break;
      void this.#launch(id);
    }
  }

  async #launch(id: string): Promise<void> {
    const record = this.#records.get(id);
    const options = this.#pending.get(id);
    this.#pending.delete(id);
    if (!record || !options) return;

    const cwd = options.cwd ?? this.#cwd;
    const model = options.model ?? this.#model;
    const mode = options.permissionMode ?? this.#permissionMode;
    const tools = options.tools ? [...options.tools] : defaultToolsForMode(mode, this.#tools);

    record.startedAt = this.#now();
    this.#persist(record);

    const controller = new AbortController();
    // No `onPermissionAsk` here: a background agent has no user to prompt.
    // Combined with `mode` defaulting to `"default"` (never `"yolo"` unless
    // the caller explicitly asked), anything the tool filter didn't already
    // exclude that still needs asking is denied automatically, fail-closed.
    const agent = new Agent({
      llm: this.#llm,
      model,
      systemPrompt: this.#systemPrompt,
      tools,
      cwd,
      sessionStore: this.#store,
      sessionId: record.sessionId,
      title: `background: ${oneLine(record.task, 60)}`,
      permissions: { mode },
      signal: controller.signal,
      ...(this.#maxTurns === undefined ? {} : { maxTurns: this.#maxTurns }),
    });
    this.#active.set(id, { agent, controller });

    let reason: "completed" | "aborted" | "error" = "completed";
    let errorMessage: string | undefined;
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "turnEnd") {
        const cost = event.usage.costUsd ?? calculateCostUsd(model, event.usage) ?? 0;
        record.usage = addUsage(record.usage, event.usage);
        record.costUsd += cost;
      } else if (event.type === "runEnd") {
        reason = event.reason;
        errorMessage = event.errorMessage;
      }
    });

    try {
      await agent.prompt(record.task);
    } catch (error) {
      // Agent.prompt() documents runtime failures as a `runEnd` event, never
      // a rejection — this is a defensive fallback, not the primary path.
      reason = "error";
      errorMessage = errorText(error);
    } finally {
      unsubscribe();
      this.#active.delete(id);
    }

    record.finalText = agent.finalText() || undefined;
    record.endedAt = this.#now();
    record.status = RUN_OUTCOME_TO_STATUS[reason];
    if (record.status === "failed") record.error = errorMessage ?? "Background agent failed.";
    this.#persist(record);
    this.#emit(record);
    this.#pump();
  }

  #toStatus(record: StoredRecord): BackgroundAgentStatus {
    const start = record.startedAt ?? record.createdAt;
    const end = record.endedAt ?? (record.status === "running" ? this.#now() : start);
    return {
      id: record.id,
      sessionId: record.sessionId,
      task: record.task,
      modelId: record.modelId,
      status: record.status,
      createdAt: record.createdAt,
      elapsedMs: Math.max(0, end - start),
      usage: record.usage,
      costUsd: record.costUsd,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(record.finalText === undefined ? {} : { finalText: record.finalText }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }

  #emit(record: StoredRecord): void {
    const status = this.#toStatus(record);
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch {
        // A listener must never be able to break the manager.
      }
    }
  }

  #persist(record: StoredRecord): void {
    const file = join(this.#recordsDir, `${record.id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, file);
  }

  #load(): void {
    let files: string[];
    try {
      files = readdirSync(this.#recordsDir);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      let record: StoredRecord;
      try {
        record = JSON.parse(readFileSync(join(this.#recordsDir, file), "utf8")) as StoredRecord;
      } catch {
        continue; // Corrupt or partially written record file; skip it.
      }
      // A fresh manager has no live handle for anything it didn't itself
      // launch — a record still `"running"` here belongs to a process that
      // is gone.
      if (record.status === "running") {
        record.status = "interrupted";
        record.endedAt ??= this.#now();
        record.error ??= "The process running this background agent exited before it finished.";
        this.#persist(record);
      }
      this.#records.set(record.id, record);
      this.#order.push(record.id);
    }
  }
}

const managers = new WeakMap<ArcturnRuntime, BackgroundAgentManager>();

/**
 * Get (or lazily create) the {@link BackgroundAgentManager} bound to one
 * {@link ArcturnRuntime}, memoized by runtime identity.
 *
 * Both the `/bg` commands and a host application call this — always the
 * same function — so they observe the same manager instance. A host wires
 * the finished-agent notification by calling this once at startup and
 * subscribing to `onUpdate`; see `INTEGRATION-background-agents.md`.
 *
 * Also refreshes the manager's model/tools/cwd defaults from the runtime on
 * every call, so a `/model` switch or a newly attached MCP server is picked
 * up by the next background agent started without an explicit override.
 */
export function getBackgroundAgentManager(runtime: ArcturnRuntime): BackgroundAgentManager {
  let manager = managers.get(runtime);
  if (!manager) {
    manager = new BackgroundAgentManager({
      dir: join(runtime.paths.home, "background-agents"),
      llm: runtime.llm,
      model: runtime.model,
      tools: runtime.tools,
      cwd: runtime.cwd,
    });
    managers.set(runtime, manager);
  } else {
    manager.setDefaults({ model: runtime.model, tools: runtime.tools, cwd: runtime.cwd });
  }
  return manager;
}

function formatRow(status: BackgroundAgentStatus, idWidth: number, statusWidth: number): string {
  return (
    `  ${status.id.padEnd(idWidth)}  ${status.status.padEnd(statusWidth)}  ` +
    `${formatDuration(status.elapsedMs).padEnd(7)}  ${formatCost(status.costUsd).padEnd(9)}  ` +
    oneLine(status.task, 60)
  );
}

function describeUnknown(id: string): string {
  return `No background agent "${id}". Try /bg to list them.`;
}

/** `run()` for `/bg` with no arguments: list every known background agent. */
function listRun(manager: BackgroundAgentManager, ui: CommandUi): void {
  const rows = manager.list();
  if (rows.length === 0) {
    ui.notice("info", "No background agents yet. Try /bg <task>.");
    return;
  }
  const idWidth = rows.reduce((max, row) => Math.max(max, row.id.length), 2);
  const statusWidth = rows.reduce((max, row) => Math.max(max, row.status.length), 6);
  ui.print(["Background agents", ...rows.map((row) => formatRow(row, idWidth, statusWidth))]);
}

/** `run()` for `/bg logs <id>`. */
async function logsRun(manager: BackgroundAgentManager, ui: CommandUi, id: string): Promise<void> {
  const status = manager.get(id);
  if (!status) {
    ui.notice("error", describeUnknown(id));
    return;
  }
  const messages = await manager.transcript(id);
  const lines = messages ? formatTranscript(messages) : [];
  if (lines.length === 0) {
    ui.notice("info", `No transcript yet for ${id} (${status.status}).`);
    return;
  }
  ui.print([`Transcript for ${id} (${status.status})`, ...lines]);
}

/** `run()` for `/bg cancel <id>`. */
function cancelRun(manager: BackgroundAgentManager, ui: CommandUi, id: string): void {
  if (manager.cancel(id)) {
    ui.notice("info", `Cancelling background agent ${id}.`);
    return;
  }
  const status = manager.get(id);
  if (!status) {
    ui.notice("error", describeUnknown(id));
    return;
  }
  ui.notice("warn", `Background agent ${id} is already ${status.status}.`);
}

/** `run()` for `/bg adopt <id>`. */
async function adoptRun(
  manager: BackgroundAgentManager,
  ui: CommandUi,
  runtime: ArcturnRuntime,
  id: string,
): Promise<void> {
  const status = manager.get(id);
  if (!status) {
    ui.notice("error", describeUnknown(id));
    return;
  }
  if (status.status === "running") {
    ui.notice("warn", `Background agent ${id} is still running; see /bg logs ${id}.`);
    return;
  }
  const text = status.finalText?.trim();
  const body =
    text && text !== "" ? text : status.error ? `(no output; ${status.error})` : undefined;
  if (!body) {
    ui.notice("warn", `Background agent ${id} produced no output to adopt.`);
    return;
  }
  const suffix = status.status === "done" ? "" : ` (${status.status})`;
  const injected = `Background agent ${id} finished "${oneLine(status.task, 60)}"${suffix} with this result:\n\n${body}`;
  if (runtime.agent.isRunning) {
    runtime.agent.steer(injected);
    ui.notice("info", `Queued the result of ${id} for the current run.`);
    return;
  }
  ui.notice("info", `Adopting the result of ${id} into the conversation…`);
  await runtime.agent.prompt(injected);
}

/**
 * Build the `/bg` slash command.
 *
 * `/bg <task>` starts a background agent and returns at once; `/bg` alone
 * lists known background agents; `/bg logs|cancel|adopt <id>` act on one.
 * The manager itself is obtained through {@link getBackgroundAgentManager},
 * so it is shared with anything else wiring the same runtime.
 */
export function createBackgroundAgentCommands(): SlashCommand[] {
  const command: SlashCommand = {
    name: "bg",
    description: "Run a task in the background: /bg <task> · /bg · logs|cancel|adopt <id>",
    source: "built-in",
    async run(context: CommandContext): Promise<void> {
      const { ui, runtime } = context;
      const manager = getBackgroundAgentManager(runtime);
      const trimmed = context.args.trim();

      if (trimmed === "") {
        listRun(manager, ui);
        return;
      }

      const sub = /^(logs|cancel|adopt)(?:\s+(\S+))?\s*$/.exec(trimmed);
      if (sub) {
        const [, verb, id] = sub;
        if (!id) {
          ui.notice("error", `Usage: /bg ${verb} <id>`);
          return;
        }
        if (verb === "logs") {
          await logsRun(manager, ui, id);
        } else if (verb === "cancel") {
          cancelRun(manager, ui, id);
        } else {
          await adoptRun(manager, ui, runtime, id);
        }
        return;
      }

      try {
        const { id, sessionId } = manager.start({ task: trimmed });
        ui.notice("info", `Started background agent ${id} (session ${sessionId}).`);
      } catch (error) {
        ui.notice("error", error instanceof Error ? error.message : String(error));
      }
    },
  };
  return [command];
}
