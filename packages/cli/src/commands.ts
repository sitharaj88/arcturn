/**
 * The slash-command registry.
 *
 * Commands are plain objects so the TUI, the tests and extensions all drive
 * them the same way. Everything a command may do to the screen goes through
 * {@link CommandUi}, which keeps the registry headless-testable: no command
 * touches the terminal directly.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listModels, listPresets, refreshCatalog, subscriptionPlanFor } from "@arcturn/ai";
import { getTheme, setTheme } from "@arcturn/tui";
import type { PermissionMode, PermissionRule } from "@arcturn/types";
import { createBackgroundAgentCommands } from "./background-agents.js";
import { createBrainCommands } from "./brain.js";
import { copyToClipboard } from "./clipboard.js";
import { permissionModes, persistModelPick, persistRoutePatch, persistSetting } from "./config.js";
import { estimateCost, formatEstimate } from "./cost-preview.js";
import { exportHtml, exportMarkdown, suggestExportFilename } from "./export.js";
import type { ExtensionCommand } from "./extensions.js";
import {
  formatCost,
  formatCostTotal,
  formatTokens,
  oneLine,
  TODO_MARKS,
  totalTokens,
} from "./format.js";
import { createGitCommands } from "./git.js";
import { createInsightsCommands } from "./insights.js";
import { createOrgMemoryCommands } from "./org-memory.js";
import { formatSuggestion } from "./policy-learn.js";
import { createRegistryCommands } from "./registry.js";
import { createRetroCommands } from "./retro.js";
import { bestMatch, explainMatch, searchTurns } from "./rewind-search.js";
import {
  describeRoutes,
  SETTABLE_ROUTE_KINDS,
  type SettableRouteKind,
  suggestCheapModel,
} from "./router.js";
import { type ArcturnRuntime, resolveModelSpec } from "./runtime.js";
import { formatScoutReport, runScouts } from "./scouts.js";
import { createSkillCommands } from "./skill-synthesis.js";
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
   * Write a raw escape sequence to the controlling terminal, bypassing the
   * transcript — the channel OSC 52 clipboard writes ride. Optional because
   * only a host that actually owns a terminal can offer it; a headless host
   * omits it and the features that need it degrade honestly.
   */
  writeRaw?(sequence: string): void;
  /**
   * Feed the ephemeral live run block: a workflow's structured progress events,
   * kept apart from the durable {@link notice} transcript. A headless host (or
   * a test) omits it, and the run behaves exactly as before. Optional, because
   * only the interactive app has a live region to update.
   */
  workflowLive?(event: WorkflowEvent): void;
  /**
   * Signal that this command cannot proceed without a person — a picker it
   * needs is unavailable, or an `--apply`-style step is refusing to act
   * without an explicit `--yes`. A headless host uses this to set exit code
   * `3` (see `print.ts`'s `PRINT_EXIT.needsHuman`) instead of grepping
   * notice text for workflow-specific pause/park wording. Optional, because
   * the interactive app has no exit code to steer.
   */
  needsHuman?(): void;
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

/** A slash line split into the name that was typed and the rest of it. */
export interface ParsedCommandLine {
  /** The command name, lowercased, without its leading slash. */
  name: string;
  /** Everything after the first whitespace run, trimmed. Empty when there was none. */
  args: string;
  /**
   * Whether `name` has the shape of a command name — `[A-Za-z0-9-]+`, the
   * charset `skills.ts` normalizes a skill name into — rather than merely
   * being whatever preceded the first space.
   *
   * The terminal ignores this and treats every leading slash as a command
   * attempt, because a person typing there has a completion menu open and can
   * see the mistake. `serve-commands.ts` uses it: a chat composer is where
   * `/etc/hosts is wrong, fix it` gets typed, and refusing that as an unknown
   * command would be worse than the typo it is guarding against. Read the
   * divergence in that file — it is deliberate, and written down there.
   */
  wellFormed: boolean;
}

/**
 * Split a submitted line into a command name and its arguments.
 *
 * The single parser for `/name args`, shared by {@link CommandRegistry.dispatch}
 * (the terminal) and the serve path's command expansion, so the two cannot
 * come to disagree about where a name ends — which is exactly how one skill
 * would end up with two behaviours.
 *
 * @param input - Raw submitted text.
 * @returns The split, or `undefined` when the trimmed input does not start
 *   with `/` and is therefore not a command line at all.
 */
export function parseCommandLine(input: string): ParsedCommandLine | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const space = trimmed.search(/\s/);
  const raw = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
  return {
    name: raw.toLowerCase(),
    args: space === -1 ? "" : trimmed.slice(space + 1).trim(),
    wellFormed: /^[A-Za-z0-9-]+$/.test(raw),
  };
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
    const parsed = parseCommandLine(input);
    if (!parsed) return { handled: false };

    // `wellFormed` is deliberately not consulted here: in the terminal every
    // leading slash is a command attempt, and always has been. See
    // {@link ParsedCommandLine.wellFormed}.
    const { name, args } = parsed;
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

function isSettableRouteKind(value: string): value is SettableRouteKind {
  return (SETTABLE_ROUTE_KINDS as readonly string[]).includes(value);
}

/**
 * Apply a route patch live and persist it, in that order. The live half
 * (`setRoute`) cannot fail; a failed save downgrades to a warning exactly
 * like a failed `/model` pick — the session keeps the change either way.
 *
 * @returns The " Saved…" suffix for the caller's notice, or `""` when the
 *   save failed (the warning has already been shown).
 */
async function applyRoutePatch(
  runtime: ArcturnRuntime,
  ui: CommandUi,
  patch: Partial<Record<SettableRouteKind, string | undefined>>,
): Promise<string> {
  for (const kind of Object.keys(patch) as SettableRouteKind[]) {
    runtime.router.setRoute(kind, patch[kind]);
  }
  try {
    const file = await persistRoutePatch(patch, runtime.paths);
    return ` Saved as your default (${file}).`;
  } catch (error) {
    ui.notice(
      "warn",
      `Applied for this session, but could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

/**
 * Whether the project-layer config carries its own `route` block. `route`
 * replaces wholesale per layer, so a project block will outrank whatever
 * `/model route` just wrote to the user file on the next launch here —
 * worth saying out loud at the moment of writing, not discovering later.
 */
async function projectRouteOutranks(runtime: ArcturnRuntime): Promise<boolean> {
  if (runtime.paths.project === runtime.paths.home) return false;
  try {
    const parsed: unknown = JSON.parse(await readFile(runtime.paths.projectConfig, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).route !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * The `/model route` family: inspect the effective routes, apply the cheap
 * heuristic (`--auto`), or set/clear one route by hand. Every mutation goes
 * through {@link applyRoutePatch}: live first, then persisted to the USER
 * config only.
 */
async function runModelRoute(args: string, runtime: ArcturnRuntime, ui: CommandUi): Promise<void> {
  const words = args.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) {
    ui.print(["Model routes", ...describeRoutes(runtime.router).map((line) => `  ${line}`)]);
    for (const warning of runtime.router.warnings()) ui.notice("warn", warning);
    return;
  }
  if (words.length === 1 && words[0] === "--auto") {
    const main = runtime.model;
    const suggestion = suggestCheapModel(listModels(), main);
    // The heuristic enforces every requirement itself (same vendor namespace,
    // tools, published pricing, strictly cheaper than a priced main), so an
    // empty answer collapses to one honest warning naming them all.
    if (!suggestion) {
      ui.notice(
        "warn",
        `No cheap stand-in for ${main.id}: a candidate must come from the same ` +
          "provider namespace, support tools, publish pricing, and cost less than " +
          "a priced main model. Nothing changed.",
      );
      return;
    }
    const saved = await applyRoutePatch(runtime, ui, {
      subagent: suggestion.id,
      compaction: suggestion.id,
    });
    // Honest caveat: with an unpriced main model, "cheaper" is a claim about
    // the catalog, not a comparison anyone actually made.
    const caveat =
      main.cost === undefined
        ? ` ${main.displayName} publishes no pricing, so "cheaper" could not be checked against it.`
        : "";
    ui.notice(
      "info",
      `Routed subagent and compaction to ${suggestion.displayName} ` +
        `(${suggestion.id}, $${suggestion.cost!.input}/Mtok in).${saved}${caveat}`,
    );
    if (await projectRouteOutranks(runtime)) {
      ui.notice(
        "warn",
        'This project\'s .arcturn/config.json sets its own "route", which replaces ' +
          "the saved user-level routes wholesale the next time Arcturn starts here.",
      );
    }
    return;
  }
  if (words[0] === "clear" && words.length <= 2) {
    const target = words[1];
    if (target !== undefined && !isSettableRouteKind(target)) {
      ui.notice(
        "error",
        `Unknown route "${target}". Clearable routes: ${SETTABLE_ROUTE_KINDS.join(", ")}.`,
      );
      return;
    }
    const kinds = target === undefined ? SETTABLE_ROUTE_KINDS : [target];
    const patch = Object.fromEntries(kinds.map((kind) => [kind, undefined])) as Partial<
      Record<SettableRouteKind, string | undefined>
    >;
    const saved = await applyRoutePatch(runtime, ui, patch);
    ui.notice(
      "info",
      `Cleared the ${kinds.join(", ")} route${kinds.length === 1 ? "" : "s"}; ` +
        `falling back to the main route.${saved}`,
    );
    return;
  }
  const [kindWord, idWord] = words;
  if (words.length === 2 && kindWord !== undefined && idWord !== undefined) {
    if (kindWord === "main") {
      ui.notice("error", "The main route follows your model pick — use /model <id> instead.");
      return;
    }
    if (!isSettableRouteKind(kindWord)) {
      ui.notice(
        "error",
        `Unknown route "${kindWord}". Settable routes: ${SETTABLE_ROUTE_KINDS.join(", ")}.`,
      );
      return;
    }
    // Resolve eagerly: the router itself tolerates a bad id (falls back and
    // warns), but a user typing one deserves the catalog error now, not a
    // quietly ineffective route discovered later.
    let spec: ReturnType<typeof resolveModelSpec>;
    try {
      spec = resolveModelSpec(idWord, runtime.env);
    } catch (error) {
      ui.notice("error", error instanceof Error ? error.message : String(error));
      return;
    }
    const saved = await applyRoutePatch(runtime, ui, { [kindWord]: spec.id });
    ui.notice("info", `Routed ${kindWord} to ${spec.displayName} (${spec.id}).${saved}`);
    return;
  }
  ui.notice(
    "error",
    "Usage: /model route [--auto | <subagent|compaction|title> <model-id> | clear [route]]",
  );
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
          "Enter submits · Shift+Enter newline · Shift+Tab cycles permission mode · Esc aborts · Ctrl+C twice or Ctrl+D exits",
          // Selection is app-owned in the full-screen app: the drag is the
          // selection and the release is the copy, straight to the system
          // clipboard. Shift-drag still reaches the terminal's own selection
          // for anyone who prefers it.
          "Copy text: drag over the transcript — it lands on the clipboard when you release · /copy grabs the whole last answer · /export saves the conversation",
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
        // `route` is its own family, not a model id: inspect the effective
        // per-role routes, or change the cheap ones (see `runModelRoute`).
        if (args.trim() === "route" || args.trim().startsWith("route ")) {
          await runModelRoute(args.trim().slice("route".length).trim(), runtime, ui);
          return;
        }
        // The pick is a default, not a whim: it outlives the session, like
        // the extension's picker has since 0.2.0. Persistence failing must
        // not un-switch the live session, so it downgrades to a warning.
        const applyPick = async (id: string) => {
          let spec: ReturnType<typeof runtime.setModel>;
          try {
            spec = runtime.setModel(id);
          } catch (error) {
            ui.notice("error", error instanceof Error ? error.message : String(error));
            return;
          }
          let saved = "";
          try {
            const file = await persistModelPick(spec.id, runtime.paths);
            saved = ` Saved as your default (${file}).`;
          } catch (error) {
            ui.notice(
              "warn",
              `Switched for this session, but the pick could not be saved: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          ui.notice(
            "info",
            `Model set to ${spec.displayName} (${spec.id}).${runtime.agent.isRunning ? " Applies from the next request." : ""}${saved}`,
          );
        };
        if (args !== "") {
          await applyPick(args);
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
        await applyPick(choice);
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
          headers.slice(0, 50).map((header) => {
            const stamp = new Date(header.createdAt).toISOString().slice(0, 16).replace("T", " ");
            // A generated title is what a person recognises, so it is the
            // row; the id drops to the description. Untitled sessions (from
            // before titling, or with it switched off) keep the id row they
            // always had.
            return header.title
              ? {
                  value: header.sessionId,
                  label: `${stamp}  ${oneLine(header.title, 60)}`,
                  description: header.sessionId,
                  data: header.sessionId,
                }
              : {
                  value: header.sessionId,
                  label: `${stamp}  ${header.sessionId}`,
                  data: header.sessionId,
                };
          }),
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
          // No `?? 0`: a scout that ran on an unpriced model has an unknown
          // cost, and the runtime records that as unknown rather than as free.
          for (const result of report.results) runtime.recordExternalCost(result.costUsd);
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
      name: "ui",
      description:
        "Switch the renderer: screen (full-screen app, default) or inline (terminal-native)",
      source: "built-in",
      async run({ ui, runtime, args }) {
        const current = runtime.config.ui;
        const apply = async (choice: "inline" | "screen") => {
          if (choice === current) {
            ui.notice("info", `Already using the ${choice} renderer.`);
            return;
          }
          // The renderer is chosen at launch — it decides alt screen, mouse
          // and scrollback ownership before the first frame — so this
          // persists the choice and says so rather than pretending to
          // switch a running screen live.
          runtime.config.ui = choice;
          const file = await persistSetting("ui", choice, "user", runtime.paths);
          ui.notice("info", `UI set to ${choice} (saved to ${file}). Takes effect next launch.`);
        };
        const wanted = args.trim();
        if (wanted === "inline" || wanted === "screen") {
          await apply(wanted);
          return;
        }
        if (wanted !== "") {
          ui.notice("error", `Unknown UI "${wanted}". Use "inline" or "screen".`);
          return;
        }
        const choice = await ui.select("Select a renderer", [
          {
            value: "inline",
            label: current === "inline" ? "inline  (current)" : "inline",
            description: "Terminal-native: select, scroll and copy with the terminal itself",
            data: "inline" as const,
          },
          {
            value: "screen",
            label: current === "screen" ? "screen  (current)" : "screen",
            description: "Full-screen app: alternate screen, clean resizes, pinned composer",
            data: "screen" as const,
          },
        ]);
        if (choice !== undefined) await apply(choice);
      },
    },
    {
      name: "copy",
      description: "Copy the last answer to the clipboard ('/copy all' for the conversation)",
      source: "built-in",
      async run({ ui, runtime, args }) {
        // The alternate screen caps mouse selection at one visible frame, so
        // an answer longer than the screen cannot be selected at all — this
        // is the copy that needs no selection.
        const wantAll = args.trim() === "all";
        const text = wantAll
          ? exportMarkdown(
              runtime.agent.messages,
              { model: runtime.model.displayName, exportedAt: new Date().toISOString() },
              { showThinking: false },
            )
          : runtime.agent.finalText();
        if (text === "" || (wantAll && runtime.agent.messages.length === 0)) {
          ui.notice("info", wantAll ? "Nothing to copy yet." : "No answer to copy yet.");
          return;
        }
        const result = await copyToClipboard(
          text,
          ui.writeRaw ? { writeToTerminal: ui.writeRaw.bind(ui) } : {},
        );
        if (result.ok) {
          const what = wantAll
            ? `the conversation (${runtime.agent.messages.length} messages)`
            : `the last answer (${text.length} chars)`;
          ui.notice("info", `Copied ${what} to the clipboard via ${result.via}.`);
          return;
        }
        ui.notice("warn", `${result.why} /export writes the conversation to a file instead.`);
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
          // Saving alone was a lie: nothing re-reads a config file mid-run, so
          // the live agent went on prompting for exactly what was just
          // approved, and `/permissions` did not list it either. The rule goes
          // into force first and onto disk second.
          const file = await runtime.applyPermissionRule({ ...choice.rule, scope: "project" });
          ui.notice(
            "info",
            file === undefined
              ? "Rule applied for the rest of this session; it could not be saved to your config."
              : `Rule applied now, and saved to ${file}.`,
          );
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
      name: "trust",
      description:
        "Show or change whether this project's own code may run; also: allow, deny, revoke",
      source: "built-in",
      async run({ ui, runtime, args }) {
        const {
          describeProjectCodeCounts,
          renderProjectCodeInventory,
          revokeProjectTrust,
          writeProjectTrustDecision,
        } = await import("./project-trust.js");
        const { surface, allowed, reason } = runtime.projectTrust;
        const verb = args.trim().toLowerCase();

        if (verb === "" || verb === "status" || verb === "list") {
          const state = allowed
            ? reason === "flag"
              ? "running (--trust-project / ARCTURN_TRUST_PROJECT for this run only)"
              : reason === "config-trusted-projects"
                ? "running (matched trustedProjects in your user config)"
                : reason === "nothing-declared" || reason === "no-project-layer"
                  ? "nothing to run"
                  : "running (approved for these exact contents)"
            : reason === "disabled"
              ? "not running (--no-project-code)"
              : "NOT running";
          ui.print([
            `Project:  ${runtime.paths.cwd}`,
            `Declares: ${describeProjectCodeCounts(surface.counts)}`,
            `Status:   ${state}`,
            ...(surface.empty ? [] : ["", ...renderProjectCodeInventory(surface)]),
          ]);
          return;
        }

        if (surface.empty) {
          ui.notice(
            "info",
            "This project declares no hooks, verify command, extensions or MCP servers.",
          );
          return;
        }

        if (verb === "revoke") {
          const removed = await revokeProjectTrust(runtime.paths.trust, runtime.paths.cwd);
          ui.notice(
            "info",
            removed
              ? "Forgot this project's recorded decision. It takes effect the NEXT time " +
                  "arcturn starts here — nothing is unloaded from this session."
              : "No decision was recorded for this project; nothing to forget.",
          );
          return;
        }

        if (verb !== "allow" && verb !== "deny") {
          ui.notice("warn", "Usage: /trust [status|list|allow|deny|revoke]");
          return;
        }

        try {
          await writeProjectTrustDecision(runtime.paths.trust, runtime.paths.cwd, {
            digest: surface.digest,
            decision: verb,
            decidedAt: new Date().toISOString(),
            counts: surface.counts,
          });
        } catch (error) {
          ui.notice(
            "warn",
            `Could not write ${runtime.paths.trust}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        // "Saved" alone is the `/permissions suggest` mistake: nothing re-reads
        // trust.json mid-session and no extension is imported into a process
        // already running, so the change and when it lands are said together.
        ui.notice(
          "info",
          verb === "allow"
            ? `Approved, and saved to ${runtime.paths.trust}. This project's code starts running ` +
                "the NEXT time arcturn launches here — not in this session. Changing a hook, the " +
                "verify command, any extensions file or an MCP server asks again."
            : `Refused, and saved to ${runtime.paths.trust}. It takes effect the NEXT time ` +
                "arcturn launches here; use /trust revoke to forget the decision.",
        );
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
        const { usage, costUsd, turns, unpricedTurns } = runtime.metrics;
        const limit =
          runtime.costLimitUsd > 0 ? ` / ${formatCost(runtime.costLimitUsd)} limit` : "";
        // Spend arcturn could not see is worth a sentence, not a silent zero:
        // say why it is missing, and do not let the ceiling look like it is
        // guarding money it never sees.
        const unpricedNotes: string[] = [];
        if (unpricedTurns > 0) {
          const count = `${unpricedTurns} turn${unpricedTurns === 1 ? "" : "s"}`;
          const plan = subscriptionPlanFor(runtime.model.id);
          // Name the session model only when it is the one without a price. A
          // priced session can still collect unpriced turns from a routed
          // sub-agent or a scout, and blaming the wrong model is its own wrong
          // answer.
          const why =
            plan !== undefined
              ? `billed by your ${plan} subscription, not per token`
              : runtime.model.cost === undefined
                ? `${runtime.model.displayName} publishes no per-token pricing`
                : "ran on a model with no published pricing";
          unpricedNotes.push(`  unpriced   ${count} — ${why}`);
          if (runtime.costLimitUsd > 0) {
            unpricedNotes.push(
              "             the limit only counts priced turns; it cannot see this spend",
            );
          }
        }
        ui.print([
          `Session ${runtime.agent.sessionId}`,
          `  model      ${runtime.model.displayName} (${runtime.model.id})`,
          `  turns      ${turns}`,
          `  input      ${formatTokens(usage.inputTokens)}`,
          `  output     ${formatTokens(usage.outputTokens)}`,
          `  cache      ${formatTokens(usage.cacheReadTokens)} read · ${formatTokens(usage.cacheWriteTokens)} write`,
          `  total      ${formatTokens(totalTokens(usage))}`,
          `  cost       ${formatCostTotal(costUsd, unpricedTurns === 0)}${limit}`,
          ...unpricedNotes,
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
  // `/stats` answers "what did this cost"; `/insights` answers "what keeps
  // going wrong" — parks, silent turns, step failures — off the local ledger.
  registry.registerAll(createInsightsCommands());
  // `/retro` answers "what should change" — a patch proposal for one run's
  // kit prompts/stages, built from the same journal and insights `/insights`
  // reads across many runs.
  registry.registerAll(createRetroCommands());
  // `/skills synthesize` drafts a reusable skill from a finished workflow
  // run's journal. Registered here (a built-in) so a user or project skill
  // literally named "skills" can never shadow it — see the collision guard
  // below, which checks `registry.get` before registering an extension
  // command and skips it (with a warning) when a built-in already owns the
  // name.
  registry.registerAll(createSkillCommands());
  // `/insights` says what keeps going wrong; `/brain` is the repository map
  // that stops a step re-discovering the tree on every run.
  registry.registerAll(createBrainCommands());
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
