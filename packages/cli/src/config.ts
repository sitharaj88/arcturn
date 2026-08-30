/**
 * Layered JSON configuration.
 *
 * Three layers are merged, later winning: built-in defaults, the user file
 * (`~/.arcturn/config.json`) and the project file (`<cwd>/.arcturn/config.json`).
 * Environment variables (`ARCTURN_MODEL`) override everything. Permission rules
 * accumulate across layers rather than being replaced, and each rule is tagged
 * with the scope of the file it came from so it can be written back to the
 * right place later.
 *
 * A malformed or unreadable config file is a warning, never a crash: Arcturn falls
 * back to the layers it could read and reports the problem to the caller.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  PermissionMode,
  PermissionRule,
  PermissionScope,
  ThinkingLevel,
} from "@arcturn/types";
import { EMPTY_HOOK_CONFIG, type HookConfig, parseHookConfig } from "./hooks.js";
import {
  type ArcturnPaths,
  type EnvMap,
  type ResolveArcturnPathsOptions,
  resolveArcturnPaths,
} from "./paths.js";
import type { RouteKind, RouterConfig } from "./router.js";
import type { VerifyConfig } from "./verify.js";

/** Lower rank wins when rules from different scopes disagree. */
const SCOPE_RANK: Record<PermissionScope, number> = { session: 0, project: 1, user: 2 };

/**
 * TUI theme name: `"dark"`, `"light"`, or the name of a custom theme file
 * under `~/.arcturn/themes` / `<cwd>/.arcturn/themes` (resolved at startup).
 */
export type ArcturnThemeName = string;

/** The resolved configuration the CLI runs with. */
export interface ArcturnConfig {
  /**
   * Catalog model id, e.g. `"anthropic/claude-sonnet-4-5"`. A list is a
   * failover chain: the first entry is primary, later ones are tried when a
   * provider is overloaded, rate-limited or unreachable.
   */
  model: string | string[];
  /** Starting permission mode. */
  permissionMode: PermissionMode;
  /** Persisted permission rules, in layer order (user first, then project). */
  permissions: PermissionRule[];
  /** Extended-thinking level handed to the model. */
  thinking: ThinkingLevel;
  /** TUI colour theme. */
  theme: ArcturnThemeName;
  /**
   * Interactive rendering mode (default `"screen"`).
   *
   * `"screen"` is the full-screen app: an alternate-screen UI that owns the
   * whole history — a scrollable, reflowing transcript, clean repaints on
   * resize, and exit restores the shell untouched. Selecting text hands the
   * mouse back per screenful (drag once, then select; the wheel keeps
   * working via alternate scroll), and `/copy` grabs any answer whole.
   * `"inline"` is the terminal-native shape: the transcript flows into the
   * terminal's own scrollback while the composer repaints at the bottom, so
   * selection, scrolling and copy are the terminal's own gestures. `/ui`
   * switches and persists either way.
   */
  ui: "screen" | "inline";
  /** Extra text appended verbatim to the system prompt. */
  systemPromptAppend?: string;
  /** Lifecycle hooks, accumulated across layers like permissions. */
  hooks: HookConfig;
  /** Language-server diagnostics after edits (default "off"). */
  lsp: "off" | "on";
  /** Write oversized tool outputs to a file instead of the context window (default "on"). */
  offload: "off" | "on";
  /** Tunables for offloading; any omitted key uses the core default. */
  offloadLimits?: { maxChars?: number; keepHead?: number; keepTail?: number; exclude?: string[] };
  /**
   * Elide old tool-result content from outgoing requests (history untouched).
   * Note: `protectToolNames` replaces the default `["todo", "plan"]` list.
   */
  contextEditing?: {
    enabled?: boolean;
    keepRecentTurns?: number;
    minCharsToElide?: number;
    maxTotalToolResultChars?: number;
    protectToolNames?: string[];
  };
  /**
   * Progressive tool disclosure: most tool schemas are withheld until the
   * model activates them via the built-in `tool_search` tool. Disclosure, not
   * a sandbox — activated tools still pass the full permission engine.
   */
  deferredTools?: {
    enabled?: boolean;
    alwaysActive?: string[];
    maxResults?: number;
    searchToolName?: string;
  };
  /** Skills features. `modelInvoked` exposes the skill library as a tool (default on). */
  skills?: { modelInvoked?: boolean };
  /** OS sandbox for foreground bash commands (default "off"). */
  sandbox: "off" | "workspace-write";
  /** How to treat a mutating call that echoes untrusted fetched content. */
  taint: "off" | "warn" | "confirm" | "deny";
  /** How to treat an outbound call carrying a planted canary token. */
  canary: "off" | "warn" | "deny";
  /**
   * Literal values that must never leave this machine — a real credential, a
   * customer id. An exact match in an outbound tool argument is proof of
   * exfiltration, not a heuristic.
   */
  canaries?: string[];
  /**
   * Cross-check turns against extra models and report disagreement. Costs one
   * extra call per listed model on every sampled turn.
   */
  consensus?: { models: string[]; sampleRate?: number; similarityThreshold?: number };
  /** Abort a run once it costs this many USD. `0`/absent disables the guard. */
  maxCostUsd?: number;
  /** Turn ceiling for a run. Absent uses the core default (200). */
  maxTurns?: number;
  /** Turn ceiling for one delegated sub-agent or scout (default 64). */
  subagentMaxTurns?: number;
  /**
   * Abort a streaming LLM request that emits no event for this many
   * milliseconds — a stalled/dead socket, not a slow one — and retry or fail it
   * over as a transient network error. Not a total-duration cap: a long,
   * actively streaming turn is never interrupted. Absent uses the AI default
   * (120000); `0` disables the guard.
   */
  requestStallTimeoutMs?: number;
  /** Record an append-only audit trail per session (default `false`). */
  audit: boolean;
  /**
   * Once a day, ask npm whether a newer `arcturn` exists and say so in one
   * line (default `true`). A notice, never an install: replacing a binary
   * out from under its own running process is not this tool's call. The
   * check is the CLI's only network request that is not the user's model.
   */
  updateCheck: boolean;
  /**
   * Ring the terminal's notification channel (OSC 9 plus BEL) when a run
   * finishes while the window is unfocused (default `true`). Long runs are
   * exactly when people tab away; the terminal decides what a notification
   * looks like.
   */
  notify: boolean;
  /** Record reasoning-level provenance so `arcturn blame` can explain a file. */
  provenance: boolean;
  /** Route file mutations to a shadow copy for review (default `false`). */
  dryRun: boolean;
  /** Keep editing speculatively while a permission prompt is open. */
  speculation: boolean;
  /**
   * Generate a session title with one small LLM call (on the `title` route)
   * after an interactive session's first completed run (default `true`;
   * `--print`/serve/acp never title — see
   * `ArcturnRuntime.sessionTitlesEligible`). `false` turns the call off
   * entirely — sessions then keep whatever title they already had, exactly
   * as before titling existed.
   *
   * Deliberately absent from {@link DEFAULT_CONFIG}, unlike the other
   * booleans: "unset" is meaningful here. A host may supply its own default
   * (`BuildRuntimeOptions.sessionTitles` — an embedder or test whose
   * scripted LLM must not receive a surprise call), and only an explicit
   * config value outranks that; a baked-in `true` would erase the
   * distinction between "the user chose on" and "nobody said".
   */
  sessionTitles?: boolean;
  /** Command run after edits, whose failures are fed back to the model. */
  verify?: VerifyConfig | undefined;
  /**
   * Per-role model overrides: cheap models for sub-agents, compaction,
   * titles, plus an open `tiers` map so a role's `model:` or a workflow
   * step's `[tag]` can name a symbolic tier (`tier:judgment`) instead of a
   * vendor-specific id. Like `verify`, a layer that sets `route` replaces it
   * wholesale — see {@link mergeConfig}.
   */
  route?: RouterConfig;
}

/** Result of {@link loadConfig}. */
export interface LoadedConfig {
  /** The merged configuration. */
  config: ArcturnConfig;
  /** Resolved filesystem layout the config was read from. */
  paths: ArcturnPaths;
  /** Config files that existed and parsed cleanly, in merge order. */
  sources: string[];
  /** Non-fatal problems (unreadable file, bad value, unknown key). */
  warnings: string[];
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions extends ResolveArcturnPathsOptions {
  /** Skip the project layer (used by `--cwd`-less programmatic callers). */
  skipProject?: boolean;
}

/** The model used when nothing else is configured. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

/** Configuration used when no file sets anything. */
export const DEFAULT_CONFIG: Readonly<ArcturnConfig> = Object.freeze({
  model: DEFAULT_MODEL,
  permissionMode: "default" as PermissionMode,
  permissions: [] as PermissionRule[],
  thinking: "off" as ThinkingLevel,
  theme: "dark" as ArcturnThemeName,
  ui: "screen" as const,
  hooks: EMPTY_HOOK_CONFIG,
  audit: false,
  updateCheck: true,
  notify: true,
  provenance: false,
  dryRun: false,
  speculation: false,
  lsp: "off" as const,
  offload: "on" as const,
  sandbox: "off" as const,
  taint: "warn" as const,
  canary: "off" as const,
});

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "yolo"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];
const KNOWN_KEYS = new Set([
  "model",
  "permissionMode",
  "permissions",
  "thinking",
  "theme",
  "ui",
  "systemPromptAppend",
  "hooks",
  "lsp",
  "offload",
  "offloadLimits",
  "contextEditing",
  "deferredTools",
  "skills",
  "sandbox",
  "maxCostUsd",
  "maxTurns",
  "subagentMaxTurns",
  "requestStallTimeoutMs",
  "verify",
  "audit",
  "updateCheck",
  "notify",
  "provenance",
  "dryRun",
  "speculation",
  "sessionTitles",
  "route",
  "taint",
  "canary",
  "canaries",
  "consensus",
]);

/** Narrow an arbitrary string to a {@link PermissionMode}. */
export function parsePermissionMode(value: string): PermissionMode | undefined {
  return PERMISSION_MODES.includes(value as PermissionMode) ? (value as PermissionMode) : undefined;
}

/** Every permission mode, for help text and pickers. */
export function permissionModes(): readonly PermissionMode[] {
  return PERMISSION_MODES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(
  raw: unknown,
  scope: PermissionScope,
  where: string,
  warnings: string[],
): PermissionRule | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${where}: permission rule must be an object`);
    return undefined;
  }
  const tool = raw.tool;
  const action = raw.action;
  if (typeof tool !== "string" || tool.length === 0) {
    warnings.push(`${where}: permission rule needs a non-empty "tool"`);
    return undefined;
  }
  if (action !== "allow" && action !== "deny" && action !== "ask") {
    warnings.push(`${where}: permission rule "action" must be allow, deny or ask`);
    return undefined;
  }
  // A file may label its rules with a *weaker* scope than its own, never a
  // stronger one: otherwise a checked-in project config could declare itself
  // "session" and outrank the user's own rules just by being cloned.
  const declared = raw.scope;
  const isScope = declared === "session" || declared === "project" || declared === "user";
  const ruleScope: PermissionScope =
    isScope && SCOPE_RANK[declared] >= SCOPE_RANK[scope] ? declared : scope;
  if (isScope && SCOPE_RANK[declared] < SCOPE_RANK[scope]) {
    warnings.push(
      `${where}: permission rule declares scope "${declared}", which outranks this file; ` +
        `treating it as "${scope}"`,
    );
  }
  const specifier = raw.specifier;
  return {
    tool,
    action,
    scope: ruleScope,
    ...(typeof specifier === "string" ? { specifier } : {}),
  };
}

/**
 * Validate one config file's contents into a partial config.
 *
 * Unknown keys and bad values are reported as warnings and dropped.
 *
 * @param raw - Parsed JSON value.
 * @param scope - Scope tagged onto rules that do not declare one.
 * @param where - Label used in warning messages (usually the file path).
 * @param warnings - Collector for non-fatal problems.
 */
export function parseConfigFile(
  raw: unknown,
  scope: PermissionScope,
  where: string,
  warnings: string[],
): Partial<ArcturnConfig> {
  if (!isRecord(raw)) {
    warnings.push(`${where}: expected a JSON object`);
    return {};
  }
  const out: Partial<ArcturnConfig> = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${where}: unknown config key "${key}" (ignored)`);
  }

  if (raw.model !== undefined) {
    if (typeof raw.model === "string" && raw.model.length > 0) out.model = raw.model;
    else if (
      Array.isArray(raw.model) &&
      raw.model.length > 0 &&
      raw.model.every((id) => typeof id === "string" && id.length > 0)
    ) {
      out.model = [...(raw.model as string[])];
    } else {
      warnings.push(`${where}: "model" must be a non-empty string or array of strings`);
    }
  }
  if (raw.maxCostUsd !== undefined) {
    if (
      typeof raw.maxCostUsd === "number" &&
      Number.isFinite(raw.maxCostUsd) &&
      raw.maxCostUsd >= 0
    ) {
      out.maxCostUsd = raw.maxCostUsd;
    } else {
      warnings.push(`${where}: "maxCostUsd" must be a non-negative number`);
    }
  }
  for (const key of ["maxTurns", "subagentMaxTurns"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) out[key] = value;
    else warnings.push(`${where}: "${key}" must be a positive integer`);
  }
  if (raw.requestStallTimeoutMs !== undefined) {
    const value = raw.requestStallTimeoutMs;
    // `0` is meaningful here (disables the guard), so this is >= 0, not > 0.
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      out.requestStallTimeoutMs = value;
    } else {
      warnings.push(`${where}: "requestStallTimeoutMs" must be a non-negative integer`);
    }
  }
  if (raw.verify !== undefined) {
    if (typeof raw.verify === "string" && raw.verify.trim() !== "") {
      out.verify = { command: raw.verify.trim() };
    } else if (
      isRecord(raw.verify) &&
      typeof raw.verify.command === "string" &&
      raw.verify.command.trim() !== ""
    ) {
      const globs = Array.isArray(raw.verify.globs)
        ? raw.verify.globs.filter((glob): glob is string => typeof glob === "string")
        : undefined;
      const timeoutMs =
        typeof raw.verify.timeoutMs === "number" && raw.verify.timeoutMs > 0
          ? raw.verify.timeoutMs
          : undefined;
      const runOn = raw.verify.runOn === "manual" ? ("manual" as const) : ("edit" as const);
      out.verify = {
        command: raw.verify.command.trim(),
        runOn,
        ...(globs === undefined ? {} : { globs }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    } else {
      warnings.push(
        `${where}: "verify" must be a command string or { command, globs?, timeoutMs?, runOn? }`,
      );
    }
  }
  if (raw.permissionMode !== undefined) {
    const mode =
      typeof raw.permissionMode === "string" ? parsePermissionMode(raw.permissionMode) : undefined;
    if (mode) out.permissionMode = mode;
    else warnings.push(`${where}: "permissionMode" must be one of ${PERMISSION_MODES.join(", ")}`);
  }
  if (raw.thinking !== undefined) {
    if (
      typeof raw.thinking === "string" &&
      THINKING_LEVELS.includes(raw.thinking as ThinkingLevel)
    ) {
      out.thinking = raw.thinking as ThinkingLevel;
    } else {
      warnings.push(`${where}: "thinking" must be one of ${THINKING_LEVELS.join(", ")}`);
    }
  }
  if (raw.theme !== undefined) {
    if (typeof raw.theme === "string" && raw.theme.trim() !== "") {
      out.theme = raw.theme.trim();
    } else {
      warnings.push(`${where}: "theme" must be a non-empty string`);
    }
  }
  if (raw.ui !== undefined) {
    if (raw.ui === "screen" || raw.ui === "inline") {
      out.ui = raw.ui;
    } else {
      warnings.push(`${where}: "ui" must be "screen" or "inline"`);
    }
  }
  if (raw.systemPromptAppend !== undefined) {
    if (typeof raw.systemPromptAppend === "string") out.systemPromptAppend = raw.systemPromptAppend;
    else warnings.push(`${where}: "systemPromptAppend" must be a string`);
  }
  if (raw.hooks !== undefined) {
    out.hooks = parseHookConfig(raw.hooks, where, warnings);
  }
  if (raw.route !== undefined) {
    if (isRecord(raw.route)) {
      const route: RouterConfig = {};
      for (const kind of ["main", "subagent", "compaction", "title"] as const) {
        const value = raw.route[kind];
        if (value === undefined) continue;
        if (typeof value === "string" && value.trim() !== "") route[kind] = value.trim();
        else warnings.push(`${where}: "route.${kind}" must be a non-empty string`);
      }
      if (raw.route.tiers !== undefined) {
        if (isRecord(raw.route.tiers)) {
          const tiers: Record<string, string> = {};
          for (const [name, value] of Object.entries(raw.route.tiers)) {
            if (typeof value === "string" && value.trim() !== "") {
              tiers[name] = value.trim();
            } else {
              warnings.push(`${where}: "route.tiers.${name}" must be a non-empty string`);
            }
          }
          route.tiers = tiers;
        } else {
          warnings.push(`${where}: "route.tiers" must be an object of model ids`);
        }
      }
      out.route = route;
    } else {
      warnings.push(`${where}: "route" must be an object of model ids`);
    }
  }
  if (raw.audit !== undefined) {
    if (typeof raw.audit === "boolean") out.audit = raw.audit;
    else warnings.push(`${where}: "audit" must be a boolean`);
  }
  if (raw.updateCheck !== undefined) {
    if (typeof raw.updateCheck === "boolean") out.updateCheck = raw.updateCheck;
    else warnings.push(`${where}: "updateCheck" must be a boolean`);
  }
  if (raw.notify !== undefined) {
    if (typeof raw.notify === "boolean") out.notify = raw.notify;
    else warnings.push(`${where}: "notify" must be a boolean`);
  }
  if (raw.provenance !== undefined) {
    if (typeof raw.provenance === "boolean") out.provenance = raw.provenance;
    else warnings.push(`${where}: "provenance" must be a boolean`);
  }
  if (raw.dryRun !== undefined) {
    if (typeof raw.dryRun === "boolean") out.dryRun = raw.dryRun;
    else warnings.push(`${where}: "dryRun" must be a boolean`);
  }
  if (raw.speculation !== undefined) {
    if (typeof raw.speculation === "boolean") out.speculation = raw.speculation;
    else warnings.push(`${where}: "speculation" must be a boolean`);
  }
  if (raw.sessionTitles !== undefined) {
    if (typeof raw.sessionTitles === "boolean") out.sessionTitles = raw.sessionTitles;
    else warnings.push(`${where}: "sessionTitles" must be a boolean`);
  }
  if (raw.lsp !== undefined) {
    if (raw.lsp === "off" || raw.lsp === "on") out.lsp = raw.lsp;
    else warnings.push(`${where}: "lsp" must be "off" or "on"`);
  }
  if (raw.offload !== undefined) {
    if (raw.offload === "off" || raw.offload === "on") out.offload = raw.offload;
    else warnings.push(`${where}: "offload" must be "off" or "on"`);
  }
  if (raw.offloadLimits !== undefined) {
    if (!isRecord(raw.offloadLimits)) {
      warnings.push(`${where}: "offloadLimits" must be an object`);
    } else {
      const limits = raw.offloadLimits;
      const parsed: NonNullable<ArcturnConfig["offloadLimits"]> = {};
      for (const key of ["maxChars", "keepHead", "keepTail"] as const) {
        const value = limits[key];
        if (value === undefined) continue;
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) parsed[key] = value;
        else warnings.push(`${where}: "offloadLimits.${key}" must be a non-negative number`);
      }
      if (limits.exclude !== undefined) {
        if (
          Array.isArray(limits.exclude) &&
          limits.exclude.every((tool) => typeof tool === "string")
        ) {
          parsed.exclude = [...(limits.exclude as string[])];
        } else {
          warnings.push(`${where}: "offloadLimits.exclude" must be an array of tool names`);
        }
      }
      out.offloadLimits = parsed;
    }
  }
  if (raw.contextEditing !== undefined) {
    if (!isRecord(raw.contextEditing)) {
      warnings.push(`${where}: "contextEditing" must be an object`);
    } else {
      const editing = raw.contextEditing;
      const parsed: NonNullable<ArcturnConfig["contextEditing"]> = {};
      if (editing.enabled !== undefined) {
        if (typeof editing.enabled === "boolean") parsed.enabled = editing.enabled;
        else warnings.push(`${where}: "contextEditing.enabled" must be a boolean`);
      }
      for (const key of [
        "keepRecentTurns",
        "minCharsToElide",
        "maxTotalToolResultChars",
      ] as const) {
        const value = editing[key];
        if (value === undefined) continue;
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) parsed[key] = value;
        else warnings.push(`${where}: "contextEditing.${key}" must be a non-negative number`);
      }
      if (editing.protectToolNames !== undefined) {
        if (
          Array.isArray(editing.protectToolNames) &&
          editing.protectToolNames.every((tool) => typeof tool === "string")
        ) {
          parsed.protectToolNames = [...(editing.protectToolNames as string[])];
        } else {
          warnings.push(
            `${where}: "contextEditing.protectToolNames" must be an array of tool names`,
          );
        }
      }
      out.contextEditing = parsed;
    }
  }
  if (raw.skills !== undefined) {
    if (!isRecord(raw.skills)) {
      warnings.push(`${where}: "skills" must be an object`);
    } else {
      const skills = raw.skills;
      const parsed: NonNullable<ArcturnConfig["skills"]> = {};
      if (skills.modelInvoked !== undefined) {
        if (typeof skills.modelInvoked === "boolean") parsed.modelInvoked = skills.modelInvoked;
        else warnings.push(`${where}: "skills.modelInvoked" must be a boolean`);
      }
      out.skills = parsed;
    }
  }
  if (raw.deferredTools !== undefined) {
    if (!isRecord(raw.deferredTools)) {
      warnings.push(`${where}: "deferredTools" must be an object`);
    } else {
      const deferred = raw.deferredTools;
      const parsed: NonNullable<ArcturnConfig["deferredTools"]> = {};
      if (deferred.enabled !== undefined) {
        if (typeof deferred.enabled === "boolean") parsed.enabled = deferred.enabled;
        else warnings.push(`${where}: "deferredTools.enabled" must be a boolean`);
      }
      if (deferred.alwaysActive !== undefined) {
        if (
          Array.isArray(deferred.alwaysActive) &&
          deferred.alwaysActive.every((tool) => typeof tool === "string")
        ) {
          parsed.alwaysActive = [...(deferred.alwaysActive as string[])];
        } else {
          warnings.push(`${where}: "deferredTools.alwaysActive" must be an array of tool names`);
        }
      }
      if (deferred.maxResults !== undefined) {
        if (
          typeof deferred.maxResults === "number" &&
          Number.isInteger(deferred.maxResults) &&
          deferred.maxResults > 0
        ) {
          parsed.maxResults = deferred.maxResults;
        } else {
          warnings.push(`${where}: "deferredTools.maxResults" must be a positive integer`);
        }
      }
      if (deferred.searchToolName !== undefined) {
        if (typeof deferred.searchToolName === "string" && deferred.searchToolName.length > 0) {
          parsed.searchToolName = deferred.searchToolName;
        } else {
          warnings.push(`${where}: "deferredTools.searchToolName" must be a non-empty string`);
        }
      }
      out.deferredTools = parsed;
    }
  }
  if (raw.taint !== undefined) {
    if (
      raw.taint === "off" ||
      raw.taint === "warn" ||
      raw.taint === "confirm" ||
      raw.taint === "deny"
    ) {
      out.taint = raw.taint;
    } else {
      warnings.push(`${where}: "taint" must be off, warn, confirm or deny`);
    }
  }
  if (raw.canary !== undefined) {
    if (raw.canary === "off" || raw.canary === "warn" || raw.canary === "deny") {
      out.canary = raw.canary;
    } else {
      warnings.push(`${where}: "canary" must be off, warn or deny`);
    }
  }
  if (raw.canaries !== undefined) {
    if (
      Array.isArray(raw.canaries) &&
      raw.canaries.every((token) => typeof token === "string" && token.length > 0)
    ) {
      out.canaries = [...(raw.canaries as string[])];
    } else {
      warnings.push(`${where}: "canaries" must be an array of non-empty strings`);
    }
  }
  if (raw.consensus !== undefined) {
    if (
      isRecord(raw.consensus) &&
      Array.isArray(raw.consensus.models) &&
      raw.consensus.models.every((id) => typeof id === "string" && id.length > 0)
    ) {
      const rate = raw.consensus.sampleRate;
      const threshold = raw.consensus.similarityThreshold;
      out.consensus = {
        models: [...(raw.consensus.models as string[])],
        ...(typeof rate === "number" && rate >= 0 && rate <= 1 ? { sampleRate: rate } : {}),
        ...(typeof threshold === "number" && threshold >= 0 && threshold <= 1
          ? { similarityThreshold: threshold }
          : {}),
      };
    } else {
      warnings.push(
        `${where}: "consensus" must be { models: string[], sampleRate?, similarityThreshold? }`,
      );
    }
  }
  if (raw.sandbox !== undefined) {
    if (raw.sandbox === "off" || raw.sandbox === "workspace-write") out.sandbox = raw.sandbox;
    else warnings.push(`${where}: "sandbox" must be "off" or "workspace-write"`);
  }
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) {
      warnings.push(`${where}: "permissions" must be an array`);
    } else {
      const rules: PermissionRule[] = [];
      for (const entry of raw.permissions) {
        const rule = parseRule(entry, scope, where, warnings);
        if (rule) rules.push(rule);
      }
      out.permissions = rules;
    }
  }
  return out;
}

/**
 * Merge a config layer over a base, concatenating permission rules.
 *
 * @param base - Lower-priority config.
 * @param layer - Higher-priority partial config.
 */
export function mergeConfig(base: ArcturnConfig, layer: Partial<ArcturnConfig>): ArcturnConfig {
  return {
    model: layer.model ?? base.model,
    permissionMode: layer.permissionMode ?? base.permissionMode,
    permissions: [...base.permissions, ...(layer.permissions ?? [])],
    thinking: layer.thinking ?? base.thinking,
    theme: layer.theme ?? base.theme,
    ui: layer.ui ?? base.ui,
    audit: layer.audit ?? base.audit,
    updateCheck: layer.updateCheck ?? base.updateCheck,
    notify: layer.notify ?? base.notify,
    provenance: layer.provenance ?? base.provenance,
    dryRun: layer.dryRun ?? base.dryRun,
    speculation: layer.speculation ?? base.speculation,
    ...((layer.sessionTitles ?? base.sessionTitles) === undefined
      ? {}
      : { sessionTitles: layer.sessionTitles ?? base.sessionTitles }),
    lsp: layer.lsp ?? base.lsp,
    offload: layer.offload ?? base.offload,
    ...((layer.offloadLimits ?? base.offloadLimits) === undefined
      ? {}
      : { offloadLimits: { ...base.offloadLimits, ...layer.offloadLimits } }),
    ...((layer.contextEditing ?? base.contextEditing) === undefined
      ? {}
      : { contextEditing: { ...base.contextEditing, ...layer.contextEditing } }),
    ...((layer.deferredTools ?? base.deferredTools) === undefined
      ? {}
      : { deferredTools: { ...base.deferredTools, ...layer.deferredTools } }),
    ...((layer.skills ?? base.skills) === undefined
      ? {}
      : { skills: { ...base.skills, ...layer.skills } }),
    sandbox: layer.sandbox ?? base.sandbox,
    taint: layer.taint ?? base.taint,
    canary: layer.canary ?? base.canary,
    ...((layer.canaries ?? base.canaries) === undefined
      ? {}
      : { canaries: [...(base.canaries ?? []), ...(layer.canaries ?? [])] }),
    ...((layer.consensus ?? base.consensus) === undefined
      ? {}
      : { consensus: layer.consensus ?? base.consensus }),
    ...((layer.maxCostUsd ?? base.maxCostUsd) === undefined
      ? {}
      : { maxCostUsd: layer.maxCostUsd ?? base.maxCostUsd }),
    ...((layer.maxTurns ?? base.maxTurns) === undefined
      ? {}
      : { maxTurns: layer.maxTurns ?? base.maxTurns }),
    ...((layer.subagentMaxTurns ?? base.subagentMaxTurns) === undefined
      ? {}
      : { subagentMaxTurns: layer.subagentMaxTurns ?? base.subagentMaxTurns }),
    // `?? ` is correct even though `0` is valid: 0 is not nullish, so a layer
    // that sets `0` (disable) still wins over the base.
    ...((layer.requestStallTimeoutMs ?? base.requestStallTimeoutMs) === undefined
      ? {}
      : { requestStallTimeoutMs: layer.requestStallTimeoutMs ?? base.requestStallTimeoutMs }),
    ...((layer.verify ?? base.verify) === undefined ? {} : { verify: layer.verify ?? base.verify }),
    // `route` overwrites wholesale per layer, same as `verify` above: a
    // project `.arcturn/config.json` that sets `route` fully replaces a
    // user-level `route` block rather than merging field-by-field (so a
    // project layer can, say, drop a user's `route.tiers` entirely just by
    // omitting it — an explicit choice, not a merge surprise).
    ...((layer.route ?? base.route) === undefined ? {} : { route: layer.route ?? base.route }),
    // Hooks accumulate across layers, like permissions: a user-level hook and
    // a project-level hook should both fire.
    hooks: {
      preToolUse: [...base.hooks.preToolUse, ...(layer.hooks?.preToolUse ?? [])],
      postToolUse: [...base.hooks.postToolUse, ...(layer.hooks?.postToolUse ?? [])],
      sessionStart: [...base.hooks.sessionStart, ...(layer.hooks?.sessionStart ?? [])],
      runEnd: [...base.hooks.runEnd, ...(layer.hooks?.runEnd ?? [])],
    },
    ...((layer.systemPromptAppend ?? base.systemPromptAppend)
      ? { systemPromptAppend: layer.systemPromptAppend ?? base.systemPromptAppend }
      : {}),
  };
}

async function readLayer(
  path: string,
  scope: PermissionScope,
  sources: string[],
  warnings: string[],
): Promise<Partial<ArcturnConfig>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(`${path}: could not be read (${String(code ?? error)})`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return {};
  }
  sources.push(path);
  return parseConfigFile(parsed, scope, path, warnings);
}

/** Apply environment overrides on top of a merged config. */
function applyEnv(config: ArcturnConfig, env: EnvMap): ArcturnConfig {
  const model = env.ARCTURN_MODEL;
  return model && model.length > 0 ? { ...config, model } : config;
}

/**
 * Load and merge the user and project config layers.
 *
 * @param options - Working directory, user root and environment overrides.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const paths = resolveArcturnPaths(options);
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const sources: string[] = [];

  let config: ArcturnConfig = {
    ...DEFAULT_CONFIG,
    permissions: [],
    hooks: { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] },
  };
  config = mergeConfig(config, await readLayer(paths.userConfig, "user", sources, warnings));
  // When arcturn runs from the user root itself (cwd is `~`), `<cwd>/.arcturn` *is*
  // `~/.arcturn` and the "project" file is the user file — reading it again would
  // load every rule twice, so the project layer is skipped.
  if (!options.skipProject && paths.project !== paths.home) {
    config = mergeConfig(
      config,
      await readLayer(paths.projectConfig, "project", sources, warnings),
    );
  }
  config = applyEnv(config, env);

  return { config, paths, sources, warnings };
}

/**
 * Persist a permission rule to the config file matching its scope.
 *
 * Session-scoped rules are intentionally not written: they live in the
 * {@link @arcturn/core#PermissionEngine} for the lifetime of the process only.
 *
 * @param rule - The rule to store.
 * @param paths - Resolved filesystem layout.
 * @returns The file written, or `undefined` for session-scoped rules.
 */
export async function persistPermissionRule(
  rule: PermissionRule,
  paths: ArcturnPaths,
): Promise<string | undefined> {
  if (rule.scope === "session") return undefined;
  // A "project" rule written while cwd is the user root would land in
  // `~/.arcturn/config.json` — which is read back as the *user* layer, where a
  // declared "project" scope is rejected with a warning on every launch. Store
  // the scope the rule will effectively have in the file it lands in.
  const scope: PermissionScope =
    rule.scope === "project" && paths.project === paths.home ? "user" : rule.scope;
  const effective: PermissionRule = { ...rule, scope };
  const file = scope === "project" ? paths.projectConfig : paths.userConfig;

  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (isRecord(parsed)) existing = parsed;
  } catch {
    // Missing or unreadable: start from an empty document rather than failing
    // the user's "allow always" click.
  }

  const rules = Array.isArray(existing.permissions) ? [...existing.permissions] : [];
  const duplicate = rules.some(
    (entry) =>
      isRecord(entry) &&
      entry.tool === effective.tool &&
      (entry.specifier ?? undefined) === effective.specifier &&
      entry.action === effective.action,
  );
  if (!duplicate) rules.push(effective);

  const next = { ...existing, permissions: rules };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Write a single top-level setting back to a config file.
 *
 * @param key - Setting to change.
 * @param value - New value.
 * @param scope - `"project"` writes `<cwd>/.arcturn/config.json`, otherwise `~/.arcturn/config.json`.
 * @param paths - Resolved filesystem layout.
 * @returns The file written.
 */
export async function persistSetting<K extends keyof ArcturnConfig>(
  key: K,
  value: ArcturnConfig[K],
  scope: "user" | "project",
  paths: ArcturnPaths,
): Promise<string> {
  const file = scope === "project" ? paths.projectConfig : paths.userConfig;
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (isRecord(parsed)) existing = parsed;
  } catch {
    // Treat an absent or broken file as empty.
  }
  const next = { ...existing, [key]: value };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Persist an interactive model pick as the user's default.
 *
 * Two keys govern which model actually runs: `model` (the session's primary,
 * and the router's fallback) and `route.main` (an explicit override that
 * wins over the session model wherever a route is resolved). A pick that
 * wrote only `model` would look saved and change nothing against a config
 * carrying `route.main` — so when the user layer has one, it moves with the
 * pick. The other route keys (`subagent`, `compaction`, `title`, `tiers`)
 * are deliberate policy, not the pick, and stay untouched here: the one
 * command allowed to machine-write them is `/model route` (via
 * {@link persistRoutePatch}), which is itself an explicit, user-typed
 * decision about routing. A project-layer config outranks the user layer on
 * purpose and is never written by either path.
 *
 * A `model` failover chain keeps its tail: the pick becomes the head and the
 * remaining entries stay behind it as fallbacks.
 *
 * @param id - Resolved catalog id of the picked model.
 * @param paths - Resolved filesystem layout.
 * @returns The file written (always the user config).
 */
export async function persistModelPick(id: string, paths: ArcturnPaths): Promise<string> {
  const file = paths.userConfig;
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (isRecord(parsed)) existing = parsed;
  } catch {
    // Treat an absent or broken file as empty.
  }
  const model = Array.isArray(existing.model)
    ? [id, ...existing.model.filter((entry) => entry !== id)]
    : id;
  const next: Record<string, unknown> = { ...existing, model };
  if (isRecord(existing.route) && typeof existing.route.main === "string") {
    next.route = { ...existing.route, main: id };
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Persist a per-kind route change from `/model route` as the user's default.
 *
 * Always the user file, never the project one: the command is a personal
 * routing decision, and writing the *merged* view back would quietly promote
 * project-layer values into the user's own config. For the same reason this
 * merges into the `route` object already in the file rather than replacing
 * it — `main`, `tiers` and every kind the patch does not name survive
 * exactly as written. This is the on-disk half of a route change;
 * `ModelRouter.setRoute` (see `router.ts`) is the live half.
 *
 * @param patch - Kinds to change. A `string` value sets that kind's model
 *   id; an explicit `undefined` deletes it (the kind falls back to `main`
 *   again on the next launch). Kinds absent from the patch are untouched.
 * @param paths - Resolved filesystem layout.
 * @returns The file written (always the user config).
 */
export async function persistRoutePatch(
  patch: Partial<Record<RouteKind, string | undefined>>,
  paths: ArcturnPaths,
): Promise<string> {
  const file = paths.userConfig;
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (isRecord(parsed)) existing = parsed;
  } catch {
    // Treat an absent or broken file as empty.
  }
  const route: Record<string, unknown> = isRecord(existing.route) ? { ...existing.route } : {};
  for (const [kind, id] of Object.entries(patch)) {
    if (id === undefined) delete route[kind];
    else route[kind] = id;
  }
  const next: Record<string, unknown> = { ...existing, route };
  // A patch that emptied the block removes the key outright — `route: {}` in
  // a config file reads as policy where none exists.
  if (Object.keys(route).length === 0) delete next.route;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}
