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
import {
  DEFAULT_API_KEY_ENV,
  FALLBACK_API_KEY_ENV,
  listProviderIds,
  PROVIDER_PRESETS,
} from "@arcturn/ai";
import type {
  ModelCapabilities,
  ModelCost,
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
 * How much each permission mode lets through. Higher is MORE permissive.
 *
 * A total order written down once, the way {@link SCOPE_RANK} is, rather than
 * a hardcoded pair of names — a mode that arrives later gets ranked here or it
 * does not typecheck, instead of comparing as `undefined` and slipping through
 * {@link clampProjectPermissionMode} unnoticed.
 *
 * The order is read straight off `@arcturn/core`'s `PermissionEngine#resolve`:
 *
 * - `plan` refuses every non-read-only tool BEFORE the rules are consulted, so
 *   it is strictly the narrowest — it can only take things away.
 * - `default` settles nothing on its own: whatever the rules do not answer is
 *   put to the user.
 * - `acceptEdits` auto-approves the edit tools that `default` would have asked
 *   about, and nothing else. Strictly a superset of `default`.
 * - `yolo` auto-approves everything `default` would have asked about, edits
 *   included. Strictly a superset of `acceptEdits`.
 *
 * A stored `deny` still outranks all four (see that module's step 3), which is
 * why this is a clamp on the MODE and not a claim about the whole engine.
 */
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  yolo: 3,
};

/**
 * How permissive a mode is, as a number. Higher lets more through.
 *
 * Exported so a caller comparing two modes — and the regression test that pins
 * the ordering — uses the one ranking rather than restating it.
 *
 * @param mode - The mode to rank.
 */
export function permissionModeRank(mode: PermissionMode): number {
  return PERMISSION_MODE_RANK[mode];
}

/**
 * Wire protocol a {@link ConfiguredProvider}'s endpoint speaks. Deliberately
 * the same two words `@arcturn/ai`'s `PresetProtocol` uses, because a
 * configured provider *is* a preset the user wrote down themselves.
 */
export type ProviderProtocol = "openai" | "anthropic";

/** Facts about one model under a {@link ConfiguredProvider}. */
export interface ConfiguredProviderModel {
  /** Wire model name, passed through to the endpoint verbatim. */
  readonly model: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly capabilities?: Partial<ModelCapabilities>;
  /** Absent means "price unknown", never free — see `formatModelCatalog`. */
  readonly cost?: ModelCost;
}

/**
 * A provider endpoint declared in a config file rather than in code.
 *
 * The record mirrors `@arcturn/ai`'s `ProviderPreset` on purpose: `providerSpec`
 * already knows how to turn exactly this shape into a `ModelSpec`, including
 * the protocol→provider mapping, so a declared endpoint reaches the wire down
 * the same path the 35 built-in presets do. Ids are namespaced the same way
 * too — `<name>/<model>`.
 *
 * {@link scope} and {@link source} are not user-writable: they record WHICH
 * FILE asked, which is what the consent gate in `providers.ts` is keyed on. A
 * `user` declaration is the user's own file and is trusted; a `project` one
 * is inert until consented, because a cloned repository is not consent.
 */
export interface ConfiguredProvider {
  /** Short name; becomes the `<name>/<model>` id prefix. */
  readonly name: string;
  /** Human-readable name for listings; defaults to {@link name}. */
  readonly label: string;
  /**
   * Endpoint root handed straight to the SDK's `baseURL`.
   *
   * Always the NORMALIZED form (`new URL(...).href`), never the string as
   * written: this value is printed in the consent prompt, in
   * `--list-providers`, in `arcturn doctor` and in the model-resolution hint.
   */
  readonly baseUrl: string;
  /**
   * Environment variable holding this endpoint's API key, and the ONLY
   * credential it may ever be sent — specs built from this record set
   * `apiKeyEnvExclusive`, so there is no fallback to a first-party key.
   *
   * Required for a remote endpoint. Absent only for a loopback one, which is
   * then contacted with no credential at all — the keyless local runtime
   * (Ollama, LM Studio, vLLM) this exemption exists for. See
   * {@link parseConfigFile}'s provider block.
   */
  readonly apiKeyEnv?: string;
  readonly protocol: ProviderProtocol;
  /** Curated models. Absent means ids pass through verbatim. */
  readonly models?: readonly ConfiguredProviderModel[];
  /** Scope of the file that declared this entry. */
  readonly scope: PermissionScope;
  /** Absolute path of the file that declared this entry. */
  readonly source: string;
}

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
  /**
   * Starting permission mode.
   *
   * A project layer may only NARROW this, never widen it — see
   * {@link clampProjectPermissionMode}. `--permission-mode` is the user
   * speaking and overrides the merged value in either direction.
   */
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
  /**
   * Extra provider endpoints — an enterprise gateway, a vLLM cluster, Ollama
   * on a non-default host — keyed by short name, reachable as
   * `<name>/<model>`.
   *
   * Merged key-wise across layers with the USER layer winning, unlike
   * `route`: a project file may ADD a name the user never declared, but may
   * never repoint one the user did. See {@link mergeConfig}.
   *
   * Declaring is not enabling. A project-layer entry is parsed, validated and
   * listed but never registered and never contacted until the user consents;
   * `registerConfiguredProviders` in `providers.ts` owns that gate.
   */
  providers?: Record<string, ConfiguredProvider>;
  /**
   * Directories whose own `.arcturn` code — hooks, `verify`, extensions, stdio
   * MCP servers — runs without a consent prompt. An entry is either an exact
   * directory or one ending in `/*`, which covers everything beneath it.
   *
   * **Honoured only from `~/.arcturn/config.json`.** A project file setting it
   * would be granting itself the very trust the gate withholds, so the key is
   * warned about and dropped from a project layer, and `project-trust.ts` reads
   * it out of the user file directly rather than from the merged config.
   *
   * Deliberately the WEAKER opt-in: unlike a recorded approval it is not
   * content-addressed, so it approves a path and whatever that path later
   * comes to contain. Prefer answering the prompt once.
   */
  trustedProjects?: string[];
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
  "providers",
  "taint",
  "canary",
  "canaries",
  "consensus",
  "trustedProjects",
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
 * Whether a base URL points at this machine.
 *
 * The one place the loopback exemption is written down, shared by the
 * `providers` cleartext rule below and by `arcturn doctor` (local runtimes —
 * Ollama, LM Studio, vLLM — need no key, and probing one during the default
 * scan would report "network" for a server that was simply never started).
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Environment variables a PROJECT file may not name as a provider's key.
 *
 * Derived from the catalog's own tables so it cannot drift, and the derivation
 * is the whole point: the set is every provider default (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `AZURE_OPENAI_API_KEY`, …), every
 * per-provider fallback (`ANTHROPIC_AUTH_TOKEN`, `GEMINI_API_KEY`,
 * `GOOGLE_GENAI_API_KEY`), **and every `PROVIDER_PRESETS` entry's
 * `apiKeyEnv`** — the last of which was the hole: `DEFAULT_API_KEY_ENV` and
 * `FALLBACK_API_KEY_ENV` are keyed by `ProviderId`, so not one of the presets'
 * variables (`ZAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`,
 * …) was in it and a project file could name any of them. Add a preset and its
 * variable joins this set with no edit here.
 *
 * Names are compared UPPERCASED. `process.env` is case-insensitive on Windows,
 * where an exact-case `Set.has` would have let `"openai_api_key"` through to
 * resolve the real key. Anything beginning `AWS_` is refused by prefix, since
 * the AWS credential chain reads a family of names rather than one.
 *
 * The rule is scoped to the project layer on purpose. A user-layer file
 * proxying Anthropic through LiteLLM is a real, legitimate setup and stays
 * allowed; no cloned repository has a reason to ask that a key YOU hold for
 * somebody else be sent to ITS gateway.
 */
const FIRST_PARTY_KEY_ENV: ReadonlySet<string> = new Set(
  [
    ...Object.values(DEFAULT_API_KEY_ENV),
    ...Object.values(FALLBACK_API_KEY_ENV).flat(),
    ...Object.values(PROVIDER_PRESETS).map((preset) => preset.apiKeyEnv),
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    // Not a model credential, but a repository asking for it is asking for a
    // token you hold for somebody else, which is the same rule.
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ].map((name) => name.toUpperCase()),
);

/** Whether a project file naming this variable would be borrowing a credential of yours. */
function isFirstPartyKeyEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return FIRST_PARTY_KEY_ENV.has(upper) || upper.startsWith("AWS_");
}

/**
 * Whether `value` holds a character a `baseUrl` may never contain: a C0
 * control, DEL, or a C1 control.
 *
 * `new URL` is not a filter here. It strips tab, LF and CR before parsing and
 * percent-encodes ESC and BEL into the path, so a URL that validates can still
 * carry an escape sequence back out through the string the config stores. That
 * string is printed into the terminal prompt asking whether to trust the
 * endpoint, where a cursor-movement or erase-line sequence repaints the prompt
 * — a fully spoofed dialog naming a trusted host, and claiming a prior
 * approval, was demonstrated with newlines alone. Refusing the characters at
 * parse time is cheaper than teaching four separate printers to sanitise, and
 * no real endpoint URL contains one.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Names that already mean something to `--model`, and so may never be shadowed. */
function isReservedProviderName(name: string): boolean {
  if (PROVIDER_PRESETS[name] !== undefined) return true;
  return (listProviderIds() as string[]).includes(name);
}

/**
 * Validate one declared model's `cost`.
 *
 * Both rates must be finite and non-negative. A negative rate is not a typo
 * with a harmless outcome: `--max-cost` sums these, so a model priced at
 * `-1000` per million tokens *earns* budget on every turn and the ceiling
 * never trips, and the same figure lands in the session stats and the cost
 * readout. Absent (or refused) means "price unknown", which those surfaces
 * already print honestly.
 */
function parseModelCost(raw: unknown): ModelCost | undefined {
  if (!isRecord(raw)) return undefined;
  const rate = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = rate(raw.input);
  const output = rate(raw.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = rate(raw.cacheRead);
  const cacheWrite = rate(raw.cacheWrite);
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** Boolean capability flags, and the one enumerated field. */
const CAPABILITY_FLAGS = ["tools", "vision", "thinking", "caching"] as const;
const THINKING_STYLES = ["budget", "adaptive"] as const;

/**
 * Validate a declared model's `capabilities` field by field.
 *
 * It used to be an unchecked cast, so `{ thinkingStyle: "bogus", extra: "x" }`
 * reached the adapters as a `ModelCapabilities`: an invented `thinkingStyle`
 * decides the shape of the thinking parameter an adapter sends, and an unknown
 * key rides along into every consumer that spreads the record. Each field is
 * dropped on its own, with a warning naming it — a bad `vision` flag must not
 * cost the entry its correct `tools` flag.
 */
function parseModelCapabilities(
  raw: Record<string, unknown>,
  where: string,
  name: string,
  warnings: string[],
): Partial<ModelCapabilities> {
  const out: Partial<ModelCapabilities> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((CAPABILITY_FLAGS as readonly string[]).includes(key)) {
      if (typeof value === "boolean") out[key as (typeof CAPABILITY_FLAGS)[number]] = value;
      else {
        warnings.push(
          `${where}: "providers.${name}.models[].capabilities.${key}" must be true or false (ignored)`,
        );
      }
      continue;
    }
    if (key === "thinkingStyle") {
      if ((THINKING_STYLES as readonly string[]).includes(value as string)) {
        out.thinkingStyle = value as ModelCapabilities["thinkingStyle"];
      } else {
        warnings.push(
          `${where}: "providers.${name}.models[].capabilities.thinkingStyle" must be ` +
            `"budget" or "adaptive" (ignored)`,
        );
      }
      continue;
    }
    warnings.push(
      `${where}: unknown "providers.${name}.models[].capabilities" key "${key}" (ignored)`,
    );
  }
  return out;
}

function parseProviderModels(
  raw: unknown,
  where: string,
  name: string,
  warnings: string[],
): ConfiguredProviderModel[] | undefined {
  if (!Array.isArray(raw)) {
    warnings.push(`${where}: "providers.${name}.models" must be an array`);
    return undefined;
  }
  const models: ConfiguredProviderModel[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.model !== "string" || entry.model.trim() === "") {
      warnings.push(`${where}: "providers.${name}.models" entries need a non-empty "model"`);
      continue;
    }
    const model: ConfiguredProviderModel = { model: entry.model.trim() };
    const numbers: Partial<Record<"contextWindow" | "maxOutputTokens", number>> = {};
    for (const key of ["contextWindow", "maxOutputTokens"] as const) {
      const value = entry[key];
      if (value === undefined) continue;
      if (typeof value === "number" && Number.isInteger(value) && value > 0) numbers[key] = value;
      else
        warnings.push(`${where}: "providers.${name}.models[].${key}" must be a positive integer`);
    }
    const cost = parseModelCost(entry.cost);
    if (entry.cost !== undefined && cost === undefined) {
      warnings.push(
        `${where}: "providers.${name}.models[].cost" must be { input, output } with ` +
          "non-negative rates in USD per million tokens",
      );
    }
    models.push({
      ...model,
      ...numbers,
      ...(typeof entry.displayName === "string" && entry.displayName.trim() !== ""
        ? { displayName: entry.displayName.trim() }
        : {}),
      ...(isRecord(entry.capabilities)
        ? { capabilities: parseModelCapabilities(entry.capabilities, where, name, warnings) }
        : {}),
      ...(cost === undefined ? {} : { cost }),
    });
  }
  return models;
}

/**
 * Validate the `providers` block of one config file.
 *
 * Every rule below is `warnings.push` + drop that one entry — never a throw,
 * never a whole-file rejection, exactly like the rest of this module. In
 * order:
 *
 * 1. The name must be usable as an id prefix and must not already mean
 *    something: a collision with a `PROVIDER_PRESETS` name or a registered
 *    provider id is dropped rather than allowed to shadow it.
 * 2. `baseUrl` must parse, must not still carry a `{placeholder}`, must carry
 *    no control character (see {@link hasControlCharacter}), and must be
 *    `https:` — `http:` only for a loopback host. A cleartext remote endpoint
 *    is a credential on the wire. What is STORED is `parsedUrl.href`, the
 *    normalized form, never the string as typed: four surfaces print this
 *    value (the consent dialog, `--list-providers`, `arcturn doctor` and the
 *    model-resolution hint) and normalizing once here fixes all four.
 * 3. `apiKeyEnv` is REQUIRED for a remote endpoint, and this is the subtlest
 *    rule here. A spec built from configuration is registered with
 *    `apiKeyEnvExclusive`, so the variable it names is the ONLY credential it
 *    can ever receive — but a spec naming NO variable would be a keyless
 *    endpoint, which is a real thing only for a local runtime. So: a loopback
 *    `baseUrl` may omit it and is then contacted with no credential at all
 *    (the Ollama/LM Studio/vLLM case); anything remote must name one, which
 *    also makes the credential choice visible in the file and reviewable in a
 *    diff.
 * 4. From the PROJECT layer only, `apiKeyEnv` may not name a variable holding
 *    a credential you keep for someone else — see {@link FIRST_PARTY_KEY_ENV}.
 */
function parseProviders(
  raw: unknown,
  scope: PermissionScope,
  where: string,
  warnings: string[],
): Record<string, ConfiguredProvider> | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${where}: "providers" must be an object keyed by provider name`);
    return undefined;
  }
  const providers: Record<string, ConfiguredProvider> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const at = `"providers.${name}"`;
    if (name.trim() === "" || /[^A-Za-z0-9._-]/.test(name)) {
      warnings.push(
        `${where}: ${at} name must be letters, digits, dot, dash or underscore ` +
          "(it becomes the <name>/<model> id prefix)",
      );
      continue;
    }
    if (isReservedProviderName(name)) {
      warnings.push(
        `${where}: ${at} collides with a built-in provider or preset of the same name — ` +
          "dropped rather than allowed to shadow it; pick another name",
      );
      continue;
    }
    if (!isRecord(entry)) {
      warnings.push(`${where}: ${at} must be an object`);
      continue;
    }
    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
    if (baseUrl === "") {
      warnings.push(`${where}: ${at} needs a non-empty "baseUrl"`);
      continue;
    }
    if (baseUrl.includes("{")) {
      warnings.push(
        `${where}: ${at} baseUrl still contains a placeholder (${baseUrl}) — ` +
          "fill in your ids before it can be used",
      );
      continue;
    }
    // Before `new URL`, which is not a filter: it strips tab/LF/CR and encodes
    // ESC and BEL rather than refusing them, so a "valid" URL could still carry
    // an escape sequence into the consent dialog it is printed in.
    if (hasControlCharacter(baseUrl)) {
      warnings.push(
        `${where}: ${at} baseUrl contains a control character — refused, because this ` +
          "URL is printed in the prompt that asks whether to trust the endpoint, and " +
          "an escape sequence there can repaint that prompt to say anything",
      );
      continue;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      warnings.push(`${where}: ${at} baseUrl is not a valid URL (${baseUrl})`);
      continue;
    }
    if (parsedUrl.protocol !== "https:") {
      if (parsedUrl.protocol !== "http:" || !isLocalEndpoint(baseUrl)) {
        warnings.push(
          `${where}: ${at} baseUrl must be https: (${baseUrl}) — ` +
            "plain http is accepted only for a loopback host, because an API key " +
            "sent in the clear to a remote host is a leaked credential",
        );
        continue;
      }
    }
    // The normalized form, so every printer shows the URL that will actually be
    // dialled rather than the characters the file happened to contain.
    const normalizedUrl = parsedUrl.href;
    const apiKeyEnv = typeof entry.apiKeyEnv === "string" ? entry.apiKeyEnv.trim() : "";
    if (apiKeyEnv === "" && !isLocalEndpoint(normalizedUrl)) {
      warnings.push(
        `${where}: ${at} needs "apiKeyEnv" naming the environment variable holding its key — ` +
          "only a loopback endpoint may omit it (a local runtime that needs no credential). " +
          "A declared endpoint is sent the variable it names and nothing else: it never falls " +
          "back to OPENAI_API_KEY or ANTHROPIC_API_KEY, so an entry that omits it has no way " +
          "to authenticate at all",
      );
      continue;
    }
    if (scope === "project" && apiKeyEnv !== "" && isFirstPartyKeyEnv(apiKeyEnv)) {
      warnings.push(
        `${where}: ${at} names the credential "${apiKeyEnv}", which you hold for another ` +
          "service — a project file may not point one of your vendor keys at its own " +
          "endpoint; declare it in ~/.arcturn/config.json if this is really what you want",
      );
      continue;
    }
    const rawProtocol = entry.protocol ?? "openai";
    if (rawProtocol !== "openai" && rawProtocol !== "anthropic") {
      warnings.push(`${where}: ${at} "protocol" must be "openai" or "anthropic"`);
      continue;
    }
    const label =
      typeof entry.label === "string" && entry.label.trim() !== "" ? entry.label.trim() : name;
    const models =
      entry.models === undefined
        ? undefined
        : parseProviderModels(entry.models, where, name, warnings);
    providers[name] = {
      name,
      label,
      baseUrl: normalizedUrl,
      ...(apiKeyEnv === "" ? {} : { apiKeyEnv }),
      protocol: rawProtocol,
      ...(models === undefined ? {} : { models }),
      scope,
      source: where,
    };
  }
  return providers;
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
      out.verify = { command: raw.verify.trim(), scope };
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
        scope,
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
  if (raw.trustedProjects !== undefined) {
    // A project file naming itself here would be self-granted consent, so the
    // key is refused outright from any layer but the user's — and said out
    // loud, because a repository trying it is worth seeing. `project-trust.ts`
    // re-reads the user file directly regardless; this branch exists so the
    // merged config never carries a project's entry and the attempt is visible.
    if (scope !== "user") {
      warnings.push(
        `${where}: "trustedProjects" is ignored outside ~/.arcturn/config.json — a project ` +
          "cannot grant itself permission to run its own code",
      );
    } else if (!Array.isArray(raw.trustedProjects)) {
      warnings.push(`${where}: "trustedProjects" must be an array of directory paths`);
    } else {
      const entries = raw.trustedProjects.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      );
      if (entries.length !== raw.trustedProjects.length) {
        warnings.push(`${where}: "trustedProjects" entries must be non-empty strings`);
      }
      if (entries.length > 0) out.trustedProjects = entries;
    }
  }
  if (raw.hooks !== undefined) {
    // The scope goes with them: a `sessionStart` hook runs `$SHELL -c` inside
    // `buildRuntime` before the user types anything, so `project-trust.ts` has
    // to be able to tell a cloned repository's hook from the user's own.
    out.hooks = parseHookConfig(raw.hooks, where, warnings, scope);
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
  if (raw.providers !== undefined) {
    const providers = parseProviders(raw.providers, scope, where, warnings);
    if (providers !== undefined) out.providers = providers;
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
 * Key-wise union of two `providers` blocks with the BASE winning collisions.
 *
 * Note the direction, which is the opposite of every other key here and is
 * the whole point. {@link mergeConfig} is called with the USER layer as
 * `base` and the PROJECT layer as `layer`, so "base wins" means "the user's
 * declaration of a name is the one that stands". A project file may ADD a
 * name the user never declared — subject to the consent gate in
 * `providers.ts` — but it may never REPOINT one the user did. That is
 * `matchRules`' "a project allow cannot cancel a user deny" written for a
 * keyed map.
 *
 * The two alternatives were both attacks. Wholesale replacement (what `route`
 * does) would let a project file DELETE the user's endpoints; a naive
 * `{...base, ...layer}` would let it SHADOW a user name — point `mycorp` at
 * its own host and inherit whatever trust the name had.
 *
 * A dropped project entry is warned about by name, with both files quoted:
 * silence here is what made the `route` layering confusing enough to need a
 * paragraph of `/model route` output explaining it.
 */
function mergeProviders(
  base: ArcturnConfig["providers"],
  layer: Partial<ArcturnConfig>["providers"],
  warnings: string[],
): Record<string, ConfiguredProvider> | undefined {
  if (base === undefined && layer === undefined) return undefined;
  for (const [name, entry] of Object.entries(layer ?? {})) {
    const existing = base?.[name];
    if (existing === undefined) continue;
    warnings.push(
      `${entry.source}: provider "${name}" is already declared in ${existing.source} ` +
        `(pointing at ${existing.baseUrl}) — the user-level declaration wins and this one ` +
        "is ignored; rename it to add a second endpoint",
    );
  }
  return { ...layer, ...base };
}

/**
 * Drop a project layer's `permissionMode` when it is MORE permissive than the
 * mode already in force.
 *
 * A project layer may NARROW the permission mode, never widen it. `plan` from
 * a repository that wants read-only exploration is a safety wish and is
 * honoured; `yolo` or `acceptEdits` from a repository whose user is at
 * `default` is a privilege escalation shipped as data and is ignored.
 *
 * This is the exact inverse of a rule the config layer already enforces for
 * permission RULES — {@link parseRule}'s scope clamp ("a file may label its
 * rules with a weaker scope than its own, never a stronger one") and
 * `@arcturn/core`'s `matchRules` ("a project allow cannot cancel a user deny …
 * a checked-in config could escalate its own privileges just by being
 * cloned"). The MODE simply never got the same treatment: a cloned repository
 * containing `{"permissionMode": "yolo"}` outranked the user's own setting and
 * auto-approved everything they had not written an explicit `deny` for.
 *
 * Deliberately here and not at `buildRuntime`'s `options.permissionMode ??
 * config.permissionMode`: the clamp belongs to the layering, so every consumer
 * of a merged config — the runtime, `serve`, `acp`, `mcp-serve`, background
 * agents, `/permissions` — inherits it without remembering to ask. A
 * `--permission-mode` flag is the USER speaking and still overrides the result
 * in both directions, because it is applied after this, on top.
 *
 * @param base - The config the project layer is being merged onto (the user's).
 * @param layer - The parsed project layer.
 * @param file - The project config file, for the warning.
 * @param userConfigFile - The user's own config file, for the opt-in advice.
 * @param warnings - Collector; a silent clamp would be its own bug.
 * @returns The layer, with `permissionMode` removed if it widened.
 */
function clampProjectPermissionMode(
  base: ArcturnConfig,
  layer: Partial<ArcturnConfig>,
  file: string,
  userConfigFile: string,
  warnings: string[],
): Partial<ArcturnConfig> {
  const wanted = layer.permissionMode;
  if (wanted === undefined) return layer;
  const inForce = base.permissionMode;
  if (permissionModeRank(wanted) <= permissionModeRank(inForce)) return layer;
  warnings.push(
    `${file}: "permissionMode": "${wanted}" is more permissive than "${inForce}", which is ` +
      "in force here — a project config may narrow the permission mode, never widen it, so a " +
      `repository cannot switch off your prompts just by being cloned. Staying in "${inForce}". ` +
      `To use "${wanted}" here deliberately, set it in ${userConfigFile} or pass ` +
      `--permission-mode ${wanted}.`,
  );
  const { permissionMode: _widened, ...rest } = layer;
  return rest;
}

/**
 * Merge a config layer over a base, concatenating permission rules.
 *
 * @param base - Lower-priority config.
 * @param layer - Higher-priority partial config.
 * @param warnings - Collector for merge-time drops (currently `providers`
 *   collisions). Optional: a caller that only wants the merged value can omit
 *   it, and `loadConfig` passes its own so the drop reaches the user.
 */
export function mergeConfig(
  base: ArcturnConfig,
  layer: Partial<ArcturnConfig>,
  warnings: string[] = [],
): ArcturnConfig {
  const providers = mergeProviders(base.providers, layer.providers, warnings);
  return {
    ...(providers === undefined ? {} : { providers }),
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
    // Only a user layer can ever contribute one (see `parseConfigFile`), so
    // this concatenation can never pick up a project's entry.
    ...((layer.trustedProjects ?? base.trustedProjects) === undefined
      ? {}
      : { trustedProjects: [...(base.trustedProjects ?? []), ...(layer.trustedProjects ?? [])] }),
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
  config = mergeConfig(
    config,
    await readLayer(paths.userConfig, "user", sources, warnings),
    warnings,
  );
  // When arcturn runs from the user root itself (cwd is `~`), `<cwd>/.arcturn` *is*
  // `~/.arcturn` and the "project" file is the user file — reading it again would
  // load every rule twice, so the project layer is skipped.
  if (!options.skipProject && paths.project !== paths.home) {
    const projectLayer = await readLayer(paths.projectConfig, "project", sources, warnings);
    config = mergeConfig(
      config,
      // A project layer may narrow the permission mode, never widen it. See
      // {@link clampProjectPermissionMode}: this is the mode's half of the
      // rule `parseRule` already applies to a rule's declared scope.
      clampProjectPermissionMode(
        config,
        projectLayer,
        paths.projectConfig,
        paths.userConfig,
        warnings,
      ),
      warnings,
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
