/**
 * The slash-command registry.
 *
 * Commands are plain objects so the TUI, the tests and extensions all drive
 * them the same way. Everything a command may do to the screen goes through
 * {@link CommandUi}, which keeps the registry headless-testable: no command
 * touches the terminal directly.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listModels, listPresets, refreshCatalog } from "@arcturn/ai";
import { getTheme, setTheme } from "@arcturn/tui";
import type { PermissionMode, PermissionRule } from "@arcturn/types";
import { createBackgroundAgentCommands } from "./background-agents.js";
import { permissionModes, persistPermissionRule, persistSetting } from "./config.js";
import { estimateCost, formatEstimate } from "./cost-preview.js";
import { exportHtml, exportMarkdown, suggestExportFilename } from "./export.js";
import type { ExtensionCommand } from "./extensions.js";
import { formatCost, formatTokens, oneLine, TODO_MARKS, totalTokens } from "./format.js";
import { createGitCommands } from "./git.js";
import { createOrgMemoryCommands } from "./org-memory.js";
import { formatSuggestion } from "./policy-learn.js";
import { createRegistryCommands } from "./registry.js";
import { bestMatch, explainMatch, searchTurns } from "./rewind-search.js";
import { type ArcturnRuntime, resolveModelSpec } from "./runtime.js";
import { formatScoutReport, runScouts } from "./scouts.js";
import { createStatsCommands } from "./stats.js";
import { createTeamCommands } from "./team.js";
import { resolveTheme } from "./themes.js";
import {
  createRuntimeWriteLane,
  createWorkflowCommands,
  type WorkflowEvent,
  type WriteLaneHost,
} from "./workflow.js";

/** One row offered by {@link CommandUi.select}. */
export interface SelectOption<T> {
  /** Stable value used for filtering. */
  value: string;
  /** Text shown to the user; defaults to `value`. */
  label?: string;
  /** Secondary text. */
  description?: string;
  /** Payload returned when the row is chosen. */
  data: T;
}

/** Everything a command may do to the user interface. */
export interface CommandUi {
  /** Append lines to the transcript. */
  print(content: string | readonly string[]): void;
  /** Append a styled notice to the transcript. */
  notice(level: "info" | "warn" | "error", text: string): void;
  /**
   * Show a modal picker.
   *
   * @returns The chosen row's payload, or `undefined` when cancelled.
   */
  select<T>(
    title: string,
    options: readonly SelectOption<T>[],
    settings?: { filterable?: boolean; initialValue?: string },
  ): Promise<T | undefined>;
  /** Replace the editor buffer (used to pre-fill a follow-up prompt). */
  setInput(text: string): void;
  /** Drop the visible transcript, e.g. after `/clear`. */
  clear(): void;
  /** Ask the app to shut down. */
  exit(): void;
  /**
   * Feed the ephemeral live run block: a workflow's structured progress events,
   * kept apart from the durable {@link notice} transcript. A headless host (or
   * a test) omits it, and the run behaves exactly as before. Optional, because
   * only the interactive app has a live region to update.
   */
  workflowLive?(event: WorkflowEvent): void;
}

/** Handed to every command implementation. */
export interface CommandContext {
  /** The live runtime. */
  runtime: ArcturnRuntime;
  /** The user interface. */
  ui: CommandUi;
  /** Text typed after the command name, trimmed. */
  args: string;
  /** The registry, so `/help` can enumerate itself. */
  commands: CommandRegistry;
}

/** A slash command. */
export interface SlashCommand {
  /** Name without the leading slash. */
  name: string;
  /** One-line help text. */
  description: string;
  /** Where the command came from (`"built-in"` or an extension path). */
  source?: string;
  /** Implementation. */
  run(context: CommandContext): void | Promise<void>;
}

/** Outcome of {@link CommandRegistry.dispatch}. */
export type DispatchResult =
  | { handled: false }
  | { handled: true; command: string }
  | { handled: true; command: string; unknown: true };

/** An ordered, name-indexed set of slash commands. */
export class CommandRegistry {
  readonly #commands = new Map<string, SlashCommand>();

  /**
   * Add (or replace) a command.
   *
   * @param command - The command to register.
   */
  register(command: SlashCommand): void {
    this.#commands.set(command.name, command);
  }

  /**
   * Add several commands at once.
   *
   * @param commands - Commands to register, in order.
   */
  registerAll(commands: Iterable<SlashCommand>): void {
    for (const command of commands) this.register(command);
  }

  /** Every command, in registration order. */
  list(): SlashCommand[] {
    return [...this.#commands.values()];
  }

  /**
   * Look a command up by name.
   *
   * @param name - Name with or without the leading slash.
   */
  get(name: string): SlashCommand | undefined {
    return this.#commands.get(name.startsWith("/") ? name.slice(1) : name);
  }

  /**
   * Commands whose name starts with a prefix, for editor autocompletion.
   *
   * @param prefix - Typed text, with or without the leading slash.
   */
  complete(prefix: string): SlashCommand[] {
    const needle = (prefix.startsWith("/") ? prefix.slice(1) : prefix).toLowerCase();
    return this.list().filter((command) => command.name.toLowerCase().startsWith(needle));
  }

  /**
   * Run the command named by an input line.
   *
   * @param input - Raw editor text; anything not starting with `/` is ignored.
   * @param context - Runtime and UI, minus the parts the registry fills in.
   * @returns Whether the input was consumed as a command.
   */
  async dispatch(
    input: string,
    context: Omit<CommandContext, "args" | "commands">,
  ): Promise<DispatchResult> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return { handled: false };

    const space = trimmed.search(/\s/);
    const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
    const args = space === -1 ? "" : trimmed.slice(space + 1).trim();
    const command = this.#commands.get(name);
    if (!command) {
      context.ui.notice("warn", `Unknown command "/${name}". Try /help.`);
      return { handled: true, command: name, unknown: true };
    }
    try {
      await command.run({ ...context, args, commands: this });
    } catch (error) {
      context.ui.notice(
        "error",
        `/${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { handled: true, command: name };
  }
}

/**
 * Restore files to a checkpoint turn and fork the conversation to match.
 *
 * Shared by the `/rewind` picker and the `/rewind <query>` fast path so both
 * routes behave identically — including the honest warning when the
 * conversation link predates this process.
 *
 * @param runtime - The live runtime.
 * @param ui - Where notices go.
 * @param turnId - Checkpoint turn to restore to.
 */
async function rewindTo(runtime: ArcturnRuntime, ui: CommandUi, turnId: string): Promise<void> {
  const result = await runtime.checkpoints.restore(turnId);
  for (const failure of result.errors) {
    ui.notice("error", `${failure.path}: ${failure.message}`);
  }
  ui.notice(
    "info",
    `Restored ${result.restored.length} file${result.restored.length === 1 ? "" : "s"}, deleted ${result.deleted.length}.`,
  );
  const link = runtime.turnLink(turnId);
  if (link) {
    await runtime.rewindConversationTo(link.sessionId, link.leafId);
    ui.notice("info", "Conversation forked back to that turn.");
  } else {
    ui.notice(
      "warn",
      "Files restored. The conversation link for this turn predates this process, so the transcript was left in place.",
    );
  }
}

/** Wall-clock budget for one `/scout` run. */
const SCOUT_DEADLINE_MS = 180_000;

function describeRule(rule: PermissionRule): string {
  const specifier = rule.specifier ? ` ${rule.specifier}` : "";
  return `${rule.action.padEnd(5)} ${rule.tool}${specifier}  (${rule.scope})`;
}

/** The commands Arcturn ships with. */
export function createBuiltInCommands(): SlashCommand[] {
  return [
    {
      name: "help",
      description: "List the available commands",
      source: "built-in",
      run({ ui, commands }) {
        const all = commands.list();
        const width = all.reduce((max, command) => Math.max(max, command.name.length), 0);
        ui.print([
          "Commands",
          ...all.map((command) => `  /${command.name.padEnd(width)}  ${command.description}`),
          "",
          "Enter submits · Shift+Enter newline · Esc aborts · Ctrl+C twice or Ctrl+D exits",
        ]);
      },
    },
    {
      name: "model",
      description: "Switch the model",
      source: "built-in",
      async run({ ui, runtime, args }) {
        const current = runtime.model.id;
        if (args.trim() === "refresh") {
          // Only presets whose API key is present: discovery without a key
          // returns nothing anyway, so skip the request entirely.
          const presetIds = listPresets(runtime.env)
            .filter((preset) => preset.keyPresent)
            .map((preset) => preset.name);
          if (presetIds.length === 0) {
            ui.notice("warn", "No provider API keys found; nothing to refresh.");
            return;
          }
          const result = await refreshCatalog(presetIds, {
            cacheFile: runtime.paths.liveModelsCache,
          });
          for (const warning of result.warnings) ui.notice("warn", warning);
          ui.notice(
            "info",
            `Live catalog refreshed: ${result.registered.length} models across ${presetIds.length} presets.`,
          );
          return;
        }
        if (args !== "") {
          try {
            const spec = runtime.setModel(args);
            ui.notice("info", `Model set to ${spec.displayName} (${spec.id}).`);
          } catch (error) {
            ui.notice("error", error instanceof Error ? error.message : String(error));
          }
          return;
        }
        const choice = await ui.select(
          "Select a model",
          listModels().map((model) => ({
            value: model.id,
            label: model.id === current ? `${model.id}  (current)` : model.id,
            description: `${model.displayName} · ${Math.round(model.contextWindow / 1000)}k`,
            data: model.id,
          })),
          { filterable: true },
        );
        if (!choice) return;
        try {
          const spec = runtime.setModel(choice);
          ui.notice("info", `Model set to ${spec.displayName} (${spec.id}).`);
        } catch (error) {
          ui.notice("error", error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "clear",
      description: "Start a fresh session",
      source: "built-in",
      run({ ui, runtime }) {
        if (runtime.agent.isRunning) {
          ui.notice("warn", "A run is in flight; press Esc to interrupt it first.");
          return;
        }
        const agent = runtime.startNewSession();
        ui.clear();
        ui.notice("info", `New session ${agent.sessionId}.`);
      },
    },
    {
      name: "compact",
      description: "Summarise the conversation to free up context",
      source: "built-in",
      async run({ ui, runtime }) {
        if (runtime.agent.isRunning) {
          ui.notice("warn", "Cannot compact while the agent is running.");
          return;
        }
        const before = runtime.agent.estimatedTokens;
        const compacted = await runtime.agent.compact();
        if (!compacted) return;
        ui.notice(
          "info",
          `Compacted ${formatTokens(before)} → ${formatTokens(runtime.agent.estimatedTokens)} tokens.`,
        );
      },
    },
    {
      name: "sessions",
      description: "Resume an earlier session in this directory",
      source: "built-in",
      async run({ ui, runtime }) {
        if (runtime.agent.isRunning) {
          ui.notice("warn", "Finish or interrupt the current run first.");
          return;
        }
        const headers = await runtime.listSessions();
        if (headers.length === 0) {
          ui.notice("info", "No stored sessions for this directory yet.");
          return;
        }
        const choice = await ui.select(
          "Resume a session",
          headers.slice(0, 50).map((header) => ({
            value: header.sessionId,
            label: `${new Date(header.createdAt).toISOString().slice(0, 16).replace("T", " ")}  ${header.sessionId}`,
            ...(header.title ? { description: oneLine(header.title, 60) } : {}),
            data: header.sessionId,
          })),
          { filterable: true },
        );
        if (!choice) return;
        await runtime.resumeSession(choice);
        ui.clear();
        ui.notice("info", `Resumed session ${choice}.`);
      },
    },
    {
      name: "scout",
      description: "Explore approaches in parallel worktrees: /scout plan A | plan B",
      source: "built-in",
      async run({ ui, runtime, args }) {
        if (runtime.agent.isRunning) {
          ui.notice("warn", "A run is in progress; press Esc to interrupt it before scouting.");
          return;
        }
        const approaches = args
          .split("|")
          .map((part) => part.trim())
          .filter((part) => part !== "")
          .map((part, index) => {
            const named = /^([\w-]{1,24}):\s*(.+)$/.exec(part);
            return named
              ? { name: named[1] as string, task: named[2] as string }
              : { name: `approach-${index + 1}`, task: part };
          });
        if (approaches.length < 2) {
          ui.notice("info", "Give at least two approaches: /scout use zustand | use redux");
          return;
        }
        ui.notice("info", `Scouting ${approaches.length} approaches in throwaway worktrees…`);
        try {
          // Ctrl+C during a scout run must still tear the worktrees down.
          const controller = new AbortController();
          const onInterrupt = (): void => controller.abort();
          process.once("SIGINT", onInterrupt);
          let report: Awaited<ReturnType<typeof runScouts>>;
          try {
            report = await runScouts({
              approaches,
              spawn: (_approach, cwd) => runtime.scoutAgent(cwd),
              deadlineMs: SCOUT_DEADLINE_MS,
              repoRoot: runtime.cwd,
              signal: controller.signal,
            });
          } finally {
            process.removeListener("SIGINT", onInterrupt);
          }
          // Scouts spend real money outside the main agent's event stream, so
          // fold it back or `--max-cost` and `/cost` silently under-report.
          for (const result of report.results) runtime.recordExternalCost(result.costUsd ?? 0);
          ui.print(formatScoutReport(report).split("\n"));
        } catch (error) {
          ui.notice("error", error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "diff",
      description: "Show pending dry-run changes",
      source: "built-in",
      async run({ ui, runtime }) {
        if (!runtime.overlay) {
          ui.notice("info", "Dry-run mode is off; edits go straight to the workspace.");
          return;
        }
        const diff = await runtime.overlay.diff();
        if (diff.trim() === "") {
          ui.notice("info", "No pending changes.");
          return;
        }
        ui.print(diff.split("\n"));
      },
    },
    {
      name: "apply",
      description: "Apply pending dry-run changes to the workspace",
      source: "built-in",
      async run({ ui, runtime }) {
        if (!runtime.overlay) {
          ui.notice("info", "Dry-run mode is off; there is nothing to apply.");
          return;
        }
        if (runtime.agent.isRunning) {
          ui.notice("warn", "A run is in progress; press Esc to interrupt it before applying.");
          return;
        }
        const changes = await runtime.overlay.changes();
        if (changes.length === 0) {
          ui.notice("info", "No pending changes.");
          return;
        }
        const confirmed = await ui.select(
          `Apply ${changes.length} file${changes.length === 1 ? "" : "s"} to the workspace?`,
          [
            { value: "apply", label: "Apply the changes", data: true },
            { value: "cancel", label: "Keep them pending", data: false },
          ],
        );
        if (confirmed !== true) return;
        const result = await runtime.overlay.apply();
        for (const failure of result.errors) {
          ui.notice("error", `${failure.path}: ${failure.message}`);
        }
        if (result.errors.length === 0) {
          await runtime.overlay.discard();
          ui.notice("info", `Applied ${result.applied.length} file(s).`);
        } else {
          ui.notice(
            "warn",
            `Applied ${result.applied.length}, failed ${result.errors.length}. Pending changes kept.`,
          );
        }
      },
    },
    {
      name: "discard",
      description: "Throw away pending dry-run changes",
      source: "built-in",
      async run({ ui, runtime }) {
        if (!runtime.overlay) {
          ui.notice("info", "Dry-run mode is off; there is nothing to discard.");
          return;
        }
        const changes = await runtime.overlay.changes();
        if (changes.length === 0) {
          ui.notice("info", "No pending changes.");
          return;
        }
        const confirmed = await ui.select(
          `Discard ${changes.length} pending file change${changes.length === 1 ? "" : "s"}?`,
          [
            { value: "discard", label: "Discard them", data: true },
            { value: "keep", label: "Keep them", data: false },
          ],
        );
        if (confirmed !== true) return;
        await runtime.overlay.discard();
        ui.notice("info", "Pending changes discarded.");
      },
    },
    {
      name: "export",
      description: "Export the conversation to markdown or HTML",
      source: "built-in",
      async run({ ui, runtime, args }) {
        const parts = args.split(/\s+/).filter((part) => part !== "");
        const showThinking = parts.includes("--thinking");
        const format = parts.includes("html") ? ("html" as const) : ("md" as const);
        const messages = runtime.agent.messages;
        if (messages.length === 0) {
          ui.notice("info", "Nothing to export yet.");
          return;
        }
        const meta = {
          model: runtime.model.displayName,
          exportedAt: new Date().toISOString(),
        };
        const content =
          format === "html"
            ? exportHtml(messages, meta, { showThinking })
            : exportMarkdown(messages, meta, { showThinking });
        const file = join(runtime.cwd, suggestExportFilename(meta, format));
        await writeFile(file, content, "utf8");
        ui.notice("info", `Exported ${messages.length} messages to ${file}.`);
      },
    },
    {
      name: "theme",
      description: "Switch the colour theme",
      source: "built-in",
      async run({ ui, runtime, args }) {
        const names = ["dark", "light", ...runtime.themes.keys()];
        // The ACTIVE theme by identity — `runtime.config.theme` only records
        // the startup value, which goes stale after the first switch.
        const current =
          names.find((name) => resolveTheme(name, runtime.themes) === getTheme()) ??
          runtime.config.theme;
        const apply = async (name: string): Promise<void> => {
          const theme = resolveTheme(name, runtime.themes);
          if (!theme) {
            ui.notice("error", `Unknown theme "${name}". Available: ${names.join(", ")}.`);
            return;
          }
          setTheme(theme);
          // Keep the in-memory config honest so "(current)" and the picker's
          // starting row track the switch, not just the next process.
          runtime.config.theme = name;
          const file = await persistSetting("theme", name, "user", runtime.paths);
          ui.notice("info", `Theme set to ${name} (saved to ${file}).`);
        };
        if (args !== "") {
          await apply(args.trim());
          return;
        }
        const choice = await ui.select(
          "Select a theme",
          names.map((name) => ({
            value: name,
            label: name === current ? `${name}  (current)` : name,
            data: name,
          })),
          { initialValue: current },
        );
        if (choice) await apply(choice);
      },
    },
    {
      name: "rewind",
      description: "Restore to an earlier turn; /rewind <query> jumps by intent",
      source: "built-in",
      async run({ ui, runtime, args }) {
        if (runtime.agent.isRunning) {
          ui.notice("warn", "A run is in progress; press Esc to interrupt it before rewinding.");
          return;
        }
        const turns = await runtime.checkpoints.listTurns();
        if (turns.length === 0) {
          ui.notice("info", "No checkpoints recorded in this session yet.");
          return;
        }

        // `/rewind <query>` jumps by intent — but only when the match is
        // confident AND clearly better than the runner-up. Anything less
        // falls back to the picker: rewinding deletes files, so guessing
        // wrong is expensive.
        const query = args.trim();
        let ordered = [...turns].reverse();
        if (query !== "") {
          const match = bestMatch(turns, query);
          if (match) {
            const confirmed = await ui.select(`Rewind to "${oneLine(match.turn.label, 48)}"?`, [
              {
                value: "yes",
                label: "Yes, rewind here",
                description: `${explainMatch(match)} — restores and deletes files; cannot be undone`,
                data: match.turn.id,
              },
              { value: "no", label: "Show all turns instead", data: undefined },
            ]);
            if (confirmed) {
              await rewindTo(runtime, ui, confirmed);
              return;
            }
          } else {
            ui.notice("info", `No confident match for "${query}"; showing turns by relevance.`);
            const ranked = searchTurns(turns, query);
            if (ranked.length > 0) ordered = ranked.map((entry) => entry.turn);
          }
        }

        const choice = await ui.select(
          "Rewind to the start of…",
          ordered.map((turn) => ({
            value: turn.id,
            label: `${new Date(turn.timestamp).toLocaleTimeString()}  ${oneLine(turn.label, 44)}`,
            description: `${turn.fileCount} file${turn.fileCount === 1 ? "" : "s"} changed after this point`,
            data: turn.id,
          })),
        );
        if (!choice) return;
        await rewindTo(runtime, ui, choice);
      },
    },
    {
      name: "permissions",
      description: "Show rules and mode; also: suggest",
      source: "built-in",
      async run({ ui, runtime, args }) {
        if (args.trim() === "suggest") {
          const suggestions = runtime.policy.suggestions();
          if (suggestions.length === 0) {
            ui.notice("info", "No repeated permission decisions yet — nothing worth codifying.");
            return;
          }
          const choice = await ui.select("Save a rule from your repeated decisions?", [
            ...suggestions.map((suggestion) => ({
              value: `${suggestion.rule.tool}:${suggestion.rule.specifier ?? ""}`,
              label: formatSuggestion(suggestion),
              data: suggestion,
            })),
            { value: "none", label: "Not now", data: undefined },
          ]);
          if (!choice) return;
          const file = await persistPermissionRule(
            { ...choice.rule, scope: "project" },
            runtime.paths,
          );
          ui.notice("info", `Saved to ${file}.`);
          return;
        }
        const rules = runtime.agent.permissions.rules;
        ui.print([
          `Permission mode: ${runtime.permissionMode}`,
          rules.length === 0
            ? "No rules configured (read-only tools are always allowed)."
            : "Rules (most specific wins; session > project > user):",
          ...rules.map((rule) => `  ${describeRule(rule)}`),
        ]);
        const choice = await ui.select<PermissionMode>(
          "Permission mode",
          permissionModes().map((mode) => ({
            value: mode,
            label: mode === runtime.permissionMode ? `${mode}  (current)` : mode,
            description: PERMISSION_MODE_HELP[mode],
            data: mode,
          })),
        );
        if (!choice || choice === runtime.permissionMode) return;
        runtime.setPermissionMode(choice);
        ui.notice("info", `Permission mode set to ${choice}.`);
      },
    },
    {
      name: "mcp",
      description: "Show MCP server status",
      source: "built-in",
      async run({ ui, runtime }) {
        const manager = runtime.mcp;
        if (!manager) {
          ui.print([
            "No MCP servers configured.",
            `Add them to ${runtime.paths.projectMcp} or ${runtime.paths.userMcp}:`,
            '  { "servers": { "fs": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }',
          ]);
          return;
        }
        const status = manager.status();
        const names = Object.keys(status);
        if (names.length === 0) {
          ui.print("No MCP servers configured.");
          return;
        }
        // Cached connect-time status can go stale (a server can die without
        // announcing it); ping connected servers for live reachability, with
        // a short bounded timeout so one dead server can't hang the command.
        const liveByName = new Map(
          await Promise.all(
            names
              .filter((name) => status[name]?.state === "connected")
              .map(
                async (name): Promise<[string, boolean]> => [name, await manager.ping(name, 1500)],
              ),
          ),
        );
        ui.print([
          "MCP servers",
          ...names.map((name) => {
            const entry = status[name];
            const detail =
              entry?.state === "connected"
                ? `${entry.toolCount ?? 0} tools`
                : (entry?.error ?? entry?.state ?? "unknown");
            const live = liveByName.get(name);
            const liveDetail = live === undefined ? "" : live ? "  (live)" : "  (unreachable)";
            return `  ${name.padEnd(16)} ${entry?.state ?? "unknown"}  ${detail}${liveDetail}`;
          }),
        ]);
      },
    },
    {
      name: "todos",
      description: "Show the current todo list",
      source: "built-in",
      run({ ui, runtime }) {
        const todos = runtime.agent.todos;
        if (todos.length === 0) {
          ui.print("No todos yet.");
          return;
        }
        ui.print(["Todos", ...todos.map((todo) => `  ${TODO_MARKS[todo.status]} ${todo.text}`)]);
      },
    },
    {
      name: "cost",
      description: "Show usage and cost; also: limit <usd>, preview [steps]",
      source: "built-in",
      run({ ui, runtime, args }) {
        const previewArg = /^preview(?:\s+(\d+))?$/.exec(args.trim());
        if (previewArg) {
          const steps = previewArg[1] ? Number(previewArg[1]) : runtime.agent.todos.length;
          if (steps <= 0) {
            ui.notice("info", "No plan steps to estimate. Try /cost preview <steps>.");
            return;
          }
          const estimate = estimateCost({
            history: runtime.recentTurns,
            plan: { steps },
            model: runtime.model,
          });
          ui.notice("info", formatEstimate(estimate, runtime.model));
          return;
        }
        const limitArg = /^limit\s+(.+)$/.exec(args.trim());
        if (limitArg) {
          const usd = Number(limitArg[1]);
          if (!Number.isFinite(usd) || usd < 0) {
            ui.notice("error", "Usage: /cost limit <usd>, e.g. /cost limit 5");
            return;
          }
          runtime.costLimitUsd = usd;
          ui.notice(
            "info",
            usd === 0
              ? "Cost limit removed for this session."
              : `Cost limit set to ${formatCost(usd)} for this session.`,
          );
          return;
        }
        const { usage, costUsd, turns } = runtime.metrics;
        ui.print([
          `Session ${runtime.agent.sessionId}`,
          `  model      ${runtime.model.displayName} (${runtime.model.id})`,
          `  turns      ${turns}`,
          `  input      ${formatTokens(usage.inputTokens)}`,
          `  output     ${formatTokens(usage.outputTokens)}`,
          `  cache      ${formatTokens(usage.cacheReadTokens)} read · ${formatTokens(usage.cacheWriteTokens)} write`,
          `  total      ${formatTokens(totalTokens(usage))}`,
          `  cost       ${formatCost(costUsd)}${runtime.costLimitUsd > 0 ? ` / ${formatCost(runtime.costLimitUsd)} limit` : ""}`,
          `  context    ${formatTokens(runtime.agent.estimatedTokens)} / ${formatTokens(runtime.model.contextWindow)}`,
        ]);
      },
    },
    {
      name: "exit",
      description: "Quit arcturn",
      source: "built-in",
      run({ ui }) {
        ui.exit();
      },
    },
  ];
}

/** One-line explanations of each permission mode, used by `/permissions`. */
export const PERMISSION_MODE_HELP: Readonly<Record<PermissionMode, string>> = {
  default: "ask before anything that changes state",
  acceptEdits: "auto-approve file edits, still ask for commands",
  plan: "read-only until a plan is approved",
  yolo: "approve everything (dangerous)",
};

/**
 * Build the registry: built-ins first, then extension commands.
 *
 * Extension commands cannot shadow a built-in.
 *
 * @param extensionCommands - Commands contributed by extensions.
 * @param warn - Called when a registration is rejected.
 */
export function createCommandRegistry(
  extensionCommands: readonly ExtensionCommand[] = [],
  warn?: (message: string) => void,
): CommandRegistry {
  const registry = new CommandRegistry();
  registry.registerAll(createBuiltInCommands());
  registry.registerAll(createGitCommands());
  registry.registerAll(createBackgroundAgentCommands());
  registry.registerAll(createStatsCommands());
  registry.registerAll(createRegistryCommands());
  registry.registerAll(createTeamCommands());
  // Org memory is the only writable half of the workflow-role surface, so it
  // gets its own command rather than a `/workflow` subverb: an operator who
  // wants to audit what their roles have been told should not have to know
  // which pipeline taught them.
  registry.registerAll(createOrgMemoryCommands());
  registry.registerAll(
    createWorkflowCommands({
      // A "[tag]" is just a catalog id or preset name. Unknown ids resolve to
      // `undefined`, which fails the run before any step spends a token.
      resolveModelTag: (tag) => {
        try {
          return resolveModelSpec(tag);
        } catch {
          return undefined;
        }
      },
      // A step's "@role" is one of the markdown agents the runtime already
      // loaded from .arcturn/agents — the same catalog the `subagent` tool
      // offers, so a role is reviewable as a file in a PR.
      agents: (runtime) => runtime.agents ?? new Map(),
      // …and a role that declares a shell or a write tool runs in its own
      // seeded git worktree instead of through `createSubagent`: `bash` alone
      // buys the isolation (exec lane — its diff is discarded unread), while
      // `write`/`edit`/`multiedit` also buys the replay (write lane — its
      // diff is captured to a patch, audited, and applied to this checkout
      // with a plain `git apply`). One lane object serves both, built once per
      // run so a run's worktrees and patches share a directory (RFC 0001 §7.1).
      //
      // The runtime is passed whole rather than as a hand-built shape so the
      // lane also reaches `runtime.backgroundTasks` — the same manager this
      // session's `bash` tool starts tasks in, and the only way a step can kill
      // the processes its role left running before its worktree is deleted.
      writeLane: (runtime, runId) =>
        createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId),
    }),
  );
  for (const command of extensionCommands) {
    if (registry.get(command.name)) {
      warn?.(`extension ${command.source}: /${command.name} is already defined (ignored)`);
      continue;
    }
    registry.register({
      name: command.name,
      description: command.description,
      source: command.source,
      run: (context) => command.handler(context),
    });
  }
  return registry;
}
