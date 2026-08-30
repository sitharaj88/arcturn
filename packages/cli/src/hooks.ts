/**
 * Config-driven lifecycle hooks with veto power, in the spirit of Claude
 * Code's hooks.
 *
 * Users declare shell commands under a `hooks` key in `.arcturn/config.json`
 * that run at lifecycle points (`preToolUse`, `postToolUse`, `sessionStart`,
 * `runEnd`). Each hook receives a JSON payload on stdin describing the
 * event and can veto a `preToolUse` call before the tool ever runs.
 *
 * A malformed hook config is a warning, never a crash — see
 * {@link parseHookConfig} — and a hook that fails to spawn, times out, or
 * exits with an unrecognised code fails *open* (the call proceeds) with a
 * warning rather than wedging the agent because of a broken script.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  defaultKillEnvironment,
  type KillEnvironment,
  resolveShell,
  terminateProcessTree,
} from "@arcturn/tools";
import type { PermissionScope, Tool, ToolResult, ToolResultContent } from "@arcturn/types";

/** Lifecycle points a hook can run at. */
export type HookEvent = "preToolUse" | "postToolUse" | "sessionStart" | "runEnd";

/** One configured hook: a shell command, optionally scoped to matching tools. */
export interface HookDefinition {
  /**
   * Shell command. On POSIX it runs via the user's `$SHELL -c <command>`,
   * falling back to `/bin/sh` — a hook is the user's own script, so their
   * shell is the least surprising interpreter for it.
   *
   * On Windows it runs via `%ComSpec% /d /s /c "<command>"` and `$SHELL` is
   * deliberately ignored: Git Bash/MSYS set it to a POSIX path
   * (`/usr/bin/bash`) that Win32 cannot spawn, so honoring it would turn
   * every hook into a spawn failure. A hook meant to run on both platforms
   * has to be written for both.
   */
  command: string;
  /**
   * Restricts which tool names this hook fires for. A trailing `*` is a
   * prefix glob (e.g. `"mcp_*"` matches `"mcp_search"`); anything else must
   * match the tool name exactly. Omitted (or on non-tool events) matches
   * everything.
   */
  matcher?: string;
  /** Timeout before the hook process (and its whole process tree) is killed. */
  timeoutMs?: number;
  /**
   * Which config layer declared this hook, when one did.
   *
   * Only {@link parseHookConfig} sets it, and `parseConfigFile` is the only
   * caller that passes `"project"` — so a hook a cloned repository wrote is
   * distinguishable from the user's own, which is what `project-trust.ts`
   * gates on. Deliberately OPTIONAL, and an absent value reads as trusted: a
   * hook built in code by an embedder or a test came from code that already
   * had to be trusted to call `buildRuntime` at all. See `project-trust.ts`'s
   * module doc, where that fail-open is argued rather than discovered.
   */
  scope?: PermissionScope;
}

/** Parsed `hooks` config: the commands to run at each lifecycle point. */
export interface HookConfig {
  preToolUse: HookDefinition[];
  postToolUse: HookDefinition[];
  sessionStart: HookDefinition[];
  runEnd: HookDefinition[];
}

/** An empty {@link HookConfig}, i.e. no hooks configured at all. */
export const EMPTY_HOOK_CONFIG: Readonly<HookConfig> = Object.freeze({
  preToolUse: [] as HookDefinition[],
  postToolUse: [] as HookDefinition[],
  sessionStart: [] as HookDefinition[],
  runEnd: [] as HookDefinition[],
});

/** Default timeout for a hook process, in milliseconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

const HOOK_EVENTS: readonly HookEvent[] = ["preToolUse", "postToolUse", "sessionStart", "runEnd"];

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHookDefinition(
  raw: unknown,
  event: HookEvent,
  where: string,
  warnings: string[],
  scope: PermissionScope | undefined,
): HookDefinition | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${where}: hooks.${event} entry must be an object`);
    return undefined;
  }
  const command = raw.command;
  if (typeof command !== "string" || command.length === 0) {
    warnings.push(`${where}: hooks.${event} entry needs a non-empty "command"`);
    return undefined;
  }
  const def: HookDefinition = { command, ...(scope === undefined ? {} : { scope }) };

  if (raw.matcher !== undefined) {
    if (typeof raw.matcher === "string" && raw.matcher.length > 0) {
      def.matcher = raw.matcher;
    } else {
      warnings.push(`${where}: hooks.${event} "matcher" must be a non-empty string`);
    }
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
      def.timeoutMs = Math.floor(raw.timeoutMs);
    } else {
      warnings.push(`${where}: hooks.${event} "timeoutMs" must be a positive number`);
    }
  }

  const knownKeys = new Set(["command", "matcher", "timeoutMs"]);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      warnings.push(`${where}: unknown key "${key}" on hooks.${event} entry (ignored)`);
    }
  }

  return def;
}

/**
 * Validate an arbitrary value into a {@link HookConfig}.
 *
 * Unknown keys, non-array event lists, and malformed entries are reported as
 * warnings and dropped rather than thrown — mirroring the style of
 * {@link @arcturn/cli#parseConfigFile}. `undefined` (no `hooks` key at all)
 * is treated as "no hooks configured", not an error.
 *
 * @param raw - The value of the config file's `hooks` key.
 * @param where - Label used in warning messages (usually the file path).
 * @param warnings - Collector for non-fatal problems.
 * @param scope - Layer that owns this file, stamped onto every hook it
 *   declares. A file may NOT label its own hooks: `scope` is not a known key
 *   on an entry, so writing one there is an ignored-key warning. That is the
 *   whole point — a project file that could tag its hook `"user"` would be
 *   granting itself the trust `project-trust.ts` exists to withhold, the same
 *   trick `providers.ts` reads the user config directly to avoid. Omitted
 *   leaves hooks untagged, i.e. trusted.
 */
export function parseHookConfig(
  raw: unknown,
  where: string,
  warnings: string[],
  scope?: PermissionScope,
): HookConfig {
  const out: HookConfig = {
    preToolUse: [],
    postToolUse: [],
    sessionStart: [],
    runEnd: [],
  };
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    warnings.push(`${where}: "hooks" must be an object`);
    return out;
  }

  for (const key of Object.keys(raw)) {
    if (!isHookEvent(key)) {
      warnings.push(`${where}: unknown hook event "${key}" (ignored)`);
    }
  }

  for (const event of HOOK_EVENTS) {
    const list = raw[event];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      warnings.push(`${where}: "hooks.${event}" must be an array`);
      continue;
    }
    for (const entry of list) {
      const def = parseHookDefinition(entry, event, where, warnings, scope);
      if (def) out[event].push(def);
    }
  }

  return out;
}

/**
 * The JSON payload sent to a hook process on stdin, alongside the standard
 * `event` and `cwd` fields.
 */
export interface HookPayload {
  /** Present for `preToolUse`/`postToolUse`. */
  toolName?: string;
  /** Present for `preToolUse`/`postToolUse`: the tool call's raw input. */
  input?: unknown;
  /** Present for `postToolUse`: the tool result's text content, concatenated. */
  resultText?: string;
  /** Present for `postToolUse`: whether the tool result was an error. */
  isError?: boolean;
  /** Any other event-specific fields (e.g. sessionId, stopReason). */
  [key: string]: unknown;
}

/** Payload shape for a `preToolUse` hook run. */
export interface PreToolUsePayload {
  toolName: string;
  input: unknown;
}

/** Payload shape for a `postToolUse` hook run. */
export interface PostToolUsePayload {
  toolName: string;
  input: unknown;
  resultText: string;
  isError: boolean;
}

/** Payload shape for a `sessionStart` hook run: whatever context makes sense. */
export type SessionStartPayload = Record<string, unknown>;

/** Payload shape for a `runEnd` hook run: whatever context makes sense. */
export type RunEndPayload = Record<string, unknown>;

/** Outcome of running a lifecycle event through {@link HookRunner.run}. */
export interface HookRunResult {
  /** `"deny"` only ever comes from a `preToolUse` hook; other events cannot veto. */
  decision: "allow" | "deny";
  /** Human-readable reason for a `"deny"` decision. */
  reason?: string;
  /** Non-fatal problems collected while running hooks (fail-open, timeouts, etc). */
  warnings: string[];
}

/** Options for {@link createHookRunner}. */
export interface CreateHookRunnerOptions {
  /** Working directory hook processes are spawned in, and sent as `cwd` in the payload. */
  cwd: string;
  /** Environment for hook processes; also where `$SHELL`/`%ComSpec%` is read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Platform whose shell hooks are run through, and whose process-tree kill a
   * hook timeout uses. Defaults to `process.platform`; only meant for tests
   * exercising a platform the test runner isn't running on.
   */
  platform?: NodeJS.Platform;
  /**
   * Overrides the OS kill calls used to terminate a timed-out hook's process
   * tree. Defaults to {@link defaultKillEnvironment} (the real platform, real
   * `process.kill`/`taskkill`). {@link platform} still wins when set, so one
   * knob decides both which shell runs the hook and how its tree is killed;
   * only meant for tests.
   */
  killEnvironment?: KillEnvironment;
}

/** Runs configured hooks for a lifecycle event. */
export interface HookRunner {
  /**
   * Run every hook configured for `event` whose matcher matches, in order.
   *
   * Hooks run sequentially; the first `"deny"` short-circuits the rest.
   * Never rejects — a hook that fails to spawn, times out, or exits
   * unrecognised is fail-open (`"allow"`) with a warning.
   */
  run(event: HookEvent, payload?: HookPayload): Promise<HookRunResult>;
}

/** Match a tool name against a hook's optional matcher glob. */
function matchesTool(matcher: string | undefined, toolName: string | undefined): boolean {
  if (toolName === undefined) return true;
  if (!matcher) return true;
  if (matcher.endsWith("*")) return toolName.startsWith(matcher.slice(0, -1));
  return matcher === toolName;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best-effort JSON parse; `undefined` on any failure rather than throwing. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The platform and OS kill calls a hook's process tree is terminated with.
 * `opts.platform` is the single "pretend to be this platform" knob, so it wins
 * over the injected environment's own platform.
 */
function resolveKillEnvironment(opts: CreateHookRunnerOptions): KillEnvironment {
  const base = opts.killEnvironment ?? defaultKillEnvironment();
  return opts.platform === undefined ? base : { ...base, platform: opts.platform };
}

interface HookExecResult {
  decision: "allow" | "deny";
  reason?: string;
  warning?: string;
}

/**
 * Spawn one hook process, feed it the JSON payload on stdin, and resolve
 * with its verdict. Never rejects.
 */
function runHookProcess(
  def: HookDefinition,
  event: HookEvent,
  payload: HookPayload,
  opts: CreateHookRunnerOptions,
): Promise<HookExecResult> {
  return new Promise((resolve) => {
    const env = opts.env ?? process.env;
    // One platform decides both how the hook is run and how it is killed, so a
    // test can never pair a Windows shell with a POSIX kill.
    const killEnv = resolveKillEnvironment(opts);
    // "user" policy: hooks are user-authored, so POSIX keeps preferring
    // `$SHELL` over `/bin/sh` exactly as before. Windows resolves to
    // `%ComSpec%` instead — see `HookDefinition.command`.
    const shell = resolveShell(killEnv.platform, env, "user");
    const timeoutMs =
      def.timeoutMs !== undefined && def.timeoutMs > 0 ? def.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;

    let child: ChildProcess;
    try {
      child = spawn(shell.executable, shell.args(def.command), {
        cwd: opts.cwd,
        env,
        // POSIX: own process-group leader, so the timeout below can reach the
        // hook's whole tree. win32 has no process groups, so nothing is
        // detached there — `taskkill /T` walks the real parent-child tree.
        detached: killEnv.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        ...shell.spawnOptions,
      });
    } catch (error) {
      resolve({
        decision: "allow",
        warning: `hook "${def.command}" failed to start: ${errorMessage(error)} (allowing)`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the hook's whole tree, not just the shell: on POSIX that is
      // `process.kill(-pid, signal)` against the process group the spawn above
      // created (descendants inherit it unless they call setsid), and on win32
      // — where there are no process groups and that call throws — it is
      // `taskkill /pid <pid> /T /F`. Which one is decided by the one shared
      // helper, `terminateProcessTree` in `@arcturn/tools`, rather than by a
      // second copy of the branch here; it already falls back to killing just
      // the direct child if the group signal fails.
      terminateProcessTree(child, "SIGKILL", killEnv);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // The hook may exit without reading stdin; writing to a closed pipe would
    // otherwise raise an uncaught EPIPE.
    child.stdin?.on("error", () => {});

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        decision: "allow",
        warning: `hook "${def.command}" failed to run: ${errorMessage(error)} (allowing)`,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          decision: "allow",
          warning: `hook "${def.command}" timed out after ${timeoutMs}ms and was killed (allowing)`,
        });
        return;
      }
      if (code === 2) {
        const reason = stderr.trim();
        resolve({
          decision: "deny",
          reason: reason.length > 0 ? reason : `hook "${def.command}" denied (exit 2)`,
        });
        return;
      }
      if (code === 0) {
        const parsed = tryParseJson(stdout);
        if (isRecord(parsed) && parsed.decision === "deny") {
          const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
          resolve({ decision: "deny", reason: reason ?? `denied by hook "${def.command}"` });
          return;
        }
        resolve({ decision: "allow" });
        return;
      }
      resolve({
        decision: "allow",
        warning: `hook "${def.command}" exited with code ${code ?? "null"} (allowing)`,
      });
    });

    try {
      child.stdin?.write(JSON.stringify({ event, ...payload, cwd: opts.cwd }));
    } catch {
      // Handled by the stdin "error" listener above.
    }
    child.stdin?.end();
  });
}

/**
 * Build a runner that executes the hooks in `config` for each lifecycle
 * event, spawned in `opts.cwd`.
 *
 * @param config - Parsed hook configuration, typically from {@link parseHookConfig}.
 * @param opts - Working directory and environment for spawned hook processes.
 */
export function createHookRunner(
  config: HookConfig | undefined,
  opts: CreateHookRunnerOptions,
): HookRunner {
  return {
    async run(event, payload = {}): Promise<HookRunResult> {
      // Defensive: callers may hand-build a config (tests, embedders) without
      // every event key; missing means "no hooks for this event", never a throw.
      const defs = config?.[event] ?? [];
      const warnings: string[] = [];

      for (const def of defs) {
        if (!matchesTool(def.matcher, payload.toolName)) continue;

        // Not run concurrently with siblings: each call has its own local
        // `stdout`/`stderr` buffers (nothing module-level is shared), so
        // overlapping `run()` calls for different tool calls never interleave
        // each other's output — but hooks *within* one run are awaited one
        // at a time so the first "deny" can short-circuit the rest.
        const result = await runHookProcess(def, event, payload, opts);
        if (result.warning) warnings.push(result.warning);
        if (result.decision === "deny") {
          return { decision: "deny", reason: result.reason, warnings };
        }
      }

      return { decision: "allow", warnings };
    },
  };
}

function textOf(content: ToolResultContent[]): string {
  return content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

/** Build the `ToolResult` returned when a `preToolUse` hook denies a call. */
function deniedResult(reason: string | undefined): ToolResult {
  return {
    content: [{ type: "text", text: `Blocked by preToolUse hook: ${reason ?? "denied"}` }],
    isError: true,
  };
}

/**
 * Wrap each tool so its `execute()` runs `preToolUse`/`postToolUse` hooks
 * around the real call.
 *
 * A `preToolUse` deny short-circuits before the wrapped tool ever executes,
 * returning an `isError` result instead. `postToolUse` hooks run after the
 * real (or denied) result and cannot veto — their outcome is not surfaced
 * beyond the warnings collected internally by the runner, since by then the
 * tool has already produced its result. Errors thrown by the wrapped tool's
 * `execute()` (a programming error, per the `Tool` contract) propagate
 * unchanged; they are not swallowed here.
 *
 * @param tools - Tools to wrap.
 * @param runner - Hook runner to consult before/after each call.
 */
export function wrapToolsWithHooks(tools: Tool[], runner: HookRunner): Tool[] {
  return tools.map((tool) => wrapTool(tool, runner));
}

function wrapTool(tool: Tool, runner: HookRunner): Tool {
  // Spread first: tools may carry extra surface beyond the Tool contract
  // (e.g. core's bindable todo/plan tools expose bindAgent) that must survive.
  return {
    ...tool,
    async execute(input, ctx): Promise<ToolResult> {
      const pre = await runner.run("preToolUse", {
        toolName: tool.definition.name,
        input,
      } satisfies PreToolUsePayload);
      if (pre.decision === "deny") {
        return deniedResult(pre.reason);
      }

      const result = await tool.execute(input, ctx);

      await runner.run("postToolUse", {
        toolName: tool.definition.name,
        input,
        resultText: textOf(result.content),
        isError: result.isError === true,
      } satisfies PostToolUsePayload);

      return result;
    },
  };
}
