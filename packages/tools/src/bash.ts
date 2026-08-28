/** The `bash` built-in tool: run shell commands in the foreground or background. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Tool, ToolResult } from "@arcturn/types";
import { resolvePath } from "./path-utils.js";
import { abortedResult, errorResult, textResult } from "./result-utils.js";
import { type BashSandboxMode, resolveSandboxInvocation, type SandboxProbe } from "./sandbox.js";
import {
  defaultShellProbe,
  resolveShell,
  type ShellProbe,
  type ShellSpawnOptions,
} from "./shell.js";

/** Default foreground/background command timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard ceiling on the requested timeout, in milliseconds. */
export const MAX_TIMEOUT_MS = 600_000;
/** Output is truncated to roughly this many trailing bytes. */
export const MAX_OUTPUT_BYTES = 50 * 1024;
/** Grace period between SIGTERM and SIGKILL when killing a background task's process group. */
export const BACKGROUND_KILL_GRACE_MS = 2_000;
/**
 * How long a killed foreground command is given to flush what it already
 * printed before {@link runForeground} stops waiting on its pipes.
 *
 * `close` fires only once every writer of the child's stdout/stderr is gone,
 * and a descendant that outlived the kill (one that called `setsid` on POSIX,
 * or that `taskkill /T` could not walk on Windows) is such a writer. Waiting
 * on `close` unconditionally would hand *that* process the decision of when
 * the tool call returns — a 300ms timeout would come back whenever the
 * survivor happened to exit, which for `npm run dev` is never. So the kill
 * starts a bounded drain instead: long enough for output the command already
 * produced to arrive, short enough that the timeout still bounds the call.
 */
export const FOREGROUND_KILL_DRAIN_MS = 250;
/**
 * How many times the same command may time out before the tool refuses to run
 * it again. Counted per tool instance, i.e. per agent session.
 */
export const REPEAT_TIMEOUT_LIMIT = 2;

/**
 * Key a command by its shape rather than its formatting: trim, then collapse
 * every run of whitespace to a single space. Re-running a hanging command with
 * the spacing nudged is the same command, and must not reset the breaker.
 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function timesPhrase(count: number): string {
  return count === 2 ? "twice" : `${count} times`;
}

/** The one remedy sentence shared by the timeout message and the repeat refusal. */
const BOUNDING_REMEDY =
  "Bound it so it exits by itself — a runner flag (`node --test --test-force-exit`, " +
  "`vitest run`, `jest --watchAll=false`) or a wrapper (`timeout 30 <command>`) — or close " +
  "the handle the command leaves open.";

/** Timeout text that names the likely cause and the fix, not just the limit. */
function timeoutMessage(timeoutMs: number, timeoutCount: number): string {
  const lines = [
    `Command timed out after ${timeoutMs}ms and was killed.`,
    "It produced output but never exited on its own, which usually means it left a handle " +
      "open: a server, a watcher, an interval. Re-running it unchanged will time out again.",
    BOUNDING_REMEDY,
  ];
  if (timeoutCount >= REPEAT_TIMEOUT_LIMIT) {
    lines.push(
      `This command has now timed out ${timesPhrase(timeoutCount)}; the next attempt will be ` +
        "refused until the command changes.",
    );
  }
  return lines.join("\n");
}

/** Text returned when the circuit breaker refuses a repeatedly-timing-out command. */
function repeatTimeoutRefusal(command: string, timeoutCount: number): string {
  return [
    `Not running this command: it has already timed out ${timesPhrase(timeoutCount)} in this ` +
      "session, and running it a third time unchanged will just time out again.",
    `  ${command}`,
    `Change it first. ${BOUNDING_REMEDY}`,
    "A command that differs only in whitespace counts as the same command.",
  ].join("\n");
}

/** Keep only the last `maxBytes` (utf8) of `text`. */
function truncateTail(
  text: string,
  maxBytes = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const kept = buf.subarray(buf.length - maxBytes).toString("utf8");
  return { text: kept, truncated: true };
}

/**
 * Give the command a single output stream, so what comes back is in the order
 * the command actually printed it.
 *
 * `stdout` and `stderr` are two independent pipes, and Node drains them on
 * independent event-loop turns. Merging their chunks into one buffer — which
 * this tool has always done — merges them by *content*, not by *time*: a
 * command that finishes in one tick hands back every stdout line followed by
 * every stderr line. `echo A; echo B 1>&2; echo C; echo D 1>&2` came back as
 * `A C B D`. Compiler diagnostics, test-runner progress and the errors between
 * them have exactly that shape, and a model reading the reordered transcript
 * attributes each failure to the wrong step.
 *
 * `exec 2>&1` is a prologue, not a wrapper: it points the shell's own fd 2 at
 * fd 1 for the rest of the script, the kernel then interleaves both streams
 * into one pipe in write order, and the command text that follows is not
 * touched at all — so a trailing backslash, an unbalanced brace or a trailing
 * `#` comment cannot turn into a syntax error the way a `{ … } 2>&1` wrapper
 * would. A command's own redirection still wins (`cmd 2>/dev/null` discards
 * its stderr exactly as before), and the exit status is unaffected.
 *
 * win32 is returned unchanged: `cmd.exe` has no `exec` builtin, and its only
 * equivalent is appending `2>&1` inside the quoted command, which binds to the
 * last command of a `&`-chain rather than the whole thing and breaks outright
 * on an unbalanced `)`. Windows keeps the pre-existing behavior — merged by
 * content, ordered by pipe — and this is the one platform-specific difference
 * in the bash tool's output.
 */
export function mergeStderrIntoStdout(command: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? command : `exec 2>&1\n${command}`;
}

function firstWord(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/\S+/);
  return match ? match[0] : trimmed;
}

/**
 * Build the argv passed to `taskkill` (after its own name) to force-terminate
 * `pid`'s whole process tree: `/t` walks child processes, `/f` forces the
 * kill rather than asking each one to close gracefully.
 */
export function buildTaskkillArgv(pid: number): string[] {
  return ["/pid", String(pid), "/T", "/F"];
}

/**
 * Platform + OS call surface consulted when terminating a background task's
 * process tree. Defaults to the real platform and real kill syscalls (see
 * {@link defaultKillEnvironment}); a test overrides individual fields to
 * exercise the win32 branch on a POSIX test runner (or vice versa) without
 * spawning `taskkill`/signaling a real process group.
 */
export interface KillEnvironment {
  platform: NodeJS.Platform;
  /** POSIX: signal `pid`'s whole process group (`process.kill(-pid, signal)`). */
  posixKill: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * win32: force-terminate `pid`'s whole process tree. There is no
   * process-group-via-negative-pid on Windows, and no real SIGTERM/SIGKILL
   * distinction either (Node maps every signal to an unconditional
   * terminate) — `taskkill /pid <pid> /T /F` is the actual equivalent of
   * "kill this detached child and everything it spawned".
   */
  windowsKill: (pid: number) => void;
}

function defaultPosixKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

/**
 * Best-effort, synchronous `taskkill` invocation. Swallows every failure —
 * `taskkill` missing, the pid already gone — the same way the POSIX path
 * swallows `ESRCH`: killing an already-dead task is a no-op, not an error.
 */
function defaultWindowsKill(pid: number): void {
  try {
    spawnSync("taskkill", buildTaskkillArgv(pid), { stdio: "ignore" });
  } catch {
    // taskkill missing, or the process already gone; nothing to do.
  }
}

/** The real environment: `process.platform`, real `process.kill`/`taskkill` calls. */
export function defaultKillEnvironment(): KillEnvironment {
  return {
    platform: process.platform,
    posixKill: defaultPosixKill,
    windowsKill: defaultWindowsKill,
  };
}

/**
 * Send `signal` to `proc`'s whole process tree, so a command's own children
 * die with it instead of being orphaned.
 *
 * This is the single process-tree kill in Arcturn: the `bash` tool (both the
 * background task manager and the foreground path below), the CLI's verify
 * loop and its hook runner all route through it, so there is one place where
 * "how do I kill a tree on this platform" is answered.
 *
 * POSIX (`env.platform !== "win32"`): signals the process group via
 * `env.posixKill(pid, signal)`, i.e. `process.kill(-pid, signal)` — this
 * works because every caller spawns the process `detached: true` on POSIX,
 * making the child its own process group leader. Falls back to signaling just
 * `proc` if that throws (e.g. already exited, or somehow not a group
 * leader); `process.kill` on an unknown/exited pid throws `ESRCH`, swallowed
 * either way. Byte-identical to the pre-D2 behavior.
 *
 * win32: routes to `env.windowsKill(pid)` (`taskkill /pid <pid> /T /F`)
 * instead — `signal` is accepted but unused, since Windows has no SIGTERM
 * vs SIGKILL distinction to honor; both the grace-period call and the
 * follow-up resolve to the same force-kill of the whole tree.
 */
export function terminateProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  env: KillEnvironment = defaultKillEnvironment(),
): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  if (env.platform === "win32") {
    env.windowsKill(pid);
    return;
  }
  try {
    env.posixKill(pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // Already dead; nothing to do.
    }
  }
}

export interface BackgroundTaskStatus {
  taskId: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  startedAt: number;
  endedAt?: number;
}

interface BackgroundTask {
  proc: ChildProcess;
  command: string;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
}

export interface BackgroundTaskManagerOptions {
  /**
   * Overrides the platform + OS kill calls consulted when `kill()`
   * terminates a running task. Defaults to {@link defaultKillEnvironment}
   * (the real platform and real `process.kill`/`taskkill` calls); only
   * meant for tests exercising a platform this test runner isn't actually
   * running on.
   */
  killEnvironment?: KillEnvironment;
}

/**
 * Tracks bash commands started in the background: buffers their merged
 * stdout/stderr and exposes poll/kill/list operations for the runtime to
 * surface to the model or a UI.
 */
export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly killEnvironment: KillEnvironment;

  constructor(options: BackgroundTaskManagerOptions = {}) {
    this.killEnvironment = options.killEnvironment ?? defaultKillEnvironment();
  }

  /** Spawn `command` in `cwd` and return its task id immediately. */
  start(command: string, cwd: string): { taskId: string } {
    const taskId = randomUUID();
    // `detached: true` makes the child its own process group leader (its pgid
    // equals its pid), so `kill()` below can signal -pid to reach every
    // descendant the command spawns, not just this immediate child.
    //
    // The shell comes from the real platform (see `./shell.js`): background
    // tasks run whatever the OS actually offers, `/bin/sh` on POSIX and
    // `%ComSpec%` on Windows. `killEnvironment` injects the *kill* calls for
    // tests; the spawn itself is not injectable, since a fake shell would
    // make the process-tree assertions meaningless.
    const shell = resolveShell();
    // The buffered `output` below merges both pipes, so it has the same
    // ordering problem a foreground command had — see `mergeStderrIntoStdout`.
    // `task.command` keeps the command as it was asked for: the wrapping is a
    // spawn detail, and `poll()` reports it back to a UI and to the model.
    const proc = spawn(
      shell.executable,
      shell.args(mergeStderrIntoStdout(command, process.platform)),
      {
        cwd,
        detached: true,
        ...shell.spawnOptions,
      },
    );
    const task: BackgroundTask = {
      proc,
      command,
      output: "",
      outputTruncated: false,
      running: true,
      exitCode: null,
      startedAt: Date.now(),
    };
    this.tasks.set(taskId, task);

    const onData = (chunk: Buffer) => {
      const { text, truncated } = truncateTail(task.output + chunk.toString("utf8"));
      task.output = text;
      task.outputTruncated = task.outputTruncated || truncated;
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("close", (code) => {
      task.running = false;
      task.exitCode = code;
      task.endedAt = Date.now();
    });
    proc.on("error", (error) => {
      const { text, truncated } = truncateTail(`${task.output}\n[spawn error: ${error.message}]`);
      task.output = text;
      task.outputTruncated = task.outputTruncated || truncated;
      task.running = false;
      task.endedAt = Date.now();
    });

    return { taskId };
  }

  /** Snapshot of a task's buffered output and status, or undefined if unknown. */
  poll(taskId: string): BackgroundTaskStatus | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return {
      taskId,
      command: task.command,
      running: task.running,
      exitCode: task.exitCode,
      output: task.output,
      outputTruncated: task.outputTruncated,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
    };
  }

  /**
   * Kill a running background task's whole process group: SIGTERM first,
   * then SIGKILL after a {@link BACKGROUND_KILL_GRACE_MS} grace period if it
   * hasn't exited by then. Returns false if the task id is unknown.
   */
  kill(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.running) {
      terminateProcessTree(task.proc, "SIGTERM", this.killEnvironment);
      const graceTimer = setTimeout(() => {
        if (task.running) terminateProcessTree(task.proc, "SIGKILL", this.killEnvironment);
      }, BACKGROUND_KILL_GRACE_MS);
      graceTimer.unref();
    }
    return true;
  }

  /** List all known tasks (running and finished), most recently started first. */
  list(): BackgroundTaskStatus[] {
    return [...this.tasks.keys()]
      .map((taskId) => this.poll(taskId))
      .filter((status): status is BackgroundTaskStatus => status !== undefined)
      .sort((a, b) => b.startedAt - a.startedAt);
  }
}

function runForeground(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  ctx: { signal: AbortSignal; onUpdate: (update: { text?: string }) => void },
  spawnOptions: ShellSpawnOptions = {},
  killEnv: KillEnvironment = defaultKillEnvironment(),
): Promise<{
  output: string;
  outputTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}> {
  return new Promise((resolvePromise) => {
    if (ctx.signal.aborted) {
      resolvePromise({
        output: "",
        outputTruncated: false,
        exitCode: null,
        timedOut: false,
        aborted: true,
      });
      return;
    }

    // POSIX: `detached: true` makes the child its own process-group leader, so
    // a timeout or an abort can signal `-pid` and reach every descendant the
    // command forked — the same reason background tasks are spawned detached.
    // Without it the kill lands on the shell alone, and the work it forked
    // keeps running (still holding the pipes this call reads from).
    //
    // win32 has no process groups, so nothing is detached there: the kill goes
    // through `taskkill /T`, which walks the real parent-child tree, and the
    // child keeps sharing this process's console exactly as it did before.
    const child = spawn(executable, args, {
      cwd,
      detached: killEnv.platform !== "win32",
      ...spawnOptions,
    });
    let output = "";
    let outputTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const merged = truncateTail(output + text);
      output = merged.text;
      outputTruncated = outputTruncated || merged.truncated;
      ctx.onUpdate({ text });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolvePromise({ output, outputTruncated, exitCode, timedOut, aborted });
    };

    /**
     * Kill the command's whole tree, then bound how long the wait for `close`
     * may last. The happy path still resolves on `close` (every byte flushed,
     * exactly as before); the drain only decides the case where something
     * survived the kill and is holding the pipes open — see
     * {@link FOREGROUND_KILL_DRAIN_MS}.
     */
    const killTree = () => {
      terminateProcessTree(child, "SIGKILL", killEnv);
      if (drainTimer !== undefined) return;
      drainTimer = setTimeout(() => {
        // Second tap, on purpose. A SIGKILL to a process group enumerates its
        // members at delivery, and a fork in flight on another CPU slips the
        // enumeration — the child is born a moment after its group was killed
        // and survives. On a loaded machine that window stretches; a mac CI
        // runner caught it in the act, with a backgrounded orphan outliving
        // the group kill to do its work. Killing the group once more after
        // the drain delay catches anything born in the gap: for the shapes
        // this tool runs, a forker that survived tap one has long finished
        // forking by tap two.
        terminateProcessTree(child, "SIGKILL", killEnv);
        // Stop reading pipes a survivor still owns, hand back what the command
        // printed before it was killed, and let this process exit without it.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref();
        finish(null);
      }, FOREGROUND_KILL_DRAIN_MS);
    };

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => finish(code));
    child.on("error", (error) => {
      const merged = truncateTail(`${output}\n[spawn error: ${error.message}]`);
      output = merged.text;
      outputTruncated = outputTruncated || merged.truncated;
      finish(null);
    });
  });
}

export interface BashToolDetails {
  command: string;
  exitCode?: number | null;
  outputTruncated?: boolean;
  taskId?: string;
  /** How many times this command has timed out in this session (only present on timeouts/refusals). */
  timeoutCount?: number;
  /** The sandbox mode that was requested (only present when not `"off"`). */
  sandbox?: BashSandboxMode;
  /** `true` when `sandbox` was requested but this platform/environment couldn't honor it. */
  sandboxUnavailable?: boolean;
}

export interface CreateBashToolOptions {
  /**
   * Filesystem sandbox applied to foreground (non-`background`) commands.
   * `"off"` (the default) is a no-op: the command runs exactly as it did
   * before this option existed. `"workspace-write"` denies writes outside
   * the working directory, the OS temp dir, and `$HOME/.arcturn` — see
   * {@link resolveSandboxInvocation}.
   */
  sandbox?: BashSandboxMode;
  /**
   * Overrides the environment probed when resolving a sandbox request
   * (platform, binary lookups, home/temp dirs). Defaults to the real
   * environment; only meant for tests exercising a platform/binary the test
   * runner itself doesn't have.
   */
  sandboxProbe?: SandboxProbe;
  /**
   * Overrides the platform + environment the command's shell is resolved
   * against (see {@link resolveShell}). Defaults to the real process; only
   * meant for tests exercising a platform the test runner isn't running on.
   */
  shellProbe?: ShellProbe;
  /**
   * Overrides the platform + OS kill calls used to terminate a foreground
   * command's process tree on timeout/abort (and to decide whether it is
   * spawned into its own process group). Defaults to
   * {@link defaultKillEnvironment}; only meant for tests exercising a
   * platform this test runner isn't running on.
   */
  killEnvironment?: KillEnvironment;
}

/** Create the `bash` tool. Always requests permission before running a command. */
export function createBashTool(
  backgroundTasks: BackgroundTaskManager,
  options: CreateBashToolOptions = {},
): Tool {
  const sandboxMode: BashSandboxMode = options.sandbox ?? "off";
  // Resolved once, so the shell named in the description is exactly the one
  // the tool will spawn. Commands here are model-authored and POSIX-sh
  // flavored, so POSIX hosts stay on `/bin/sh` rather than following an
  // interactive `$SHELL` — see `ShellPolicy` in `./shell.js`.
  const shellProbe = options.shellProbe ?? defaultShellProbe();
  // Resolved once too: it decides both how a foreground command is spawned
  // (its own process group on POSIX) and how its tree is killed.
  const killEnvironment = options.killEnvironment ?? defaultKillEnvironment();
  const shell = resolveShell(shellProbe.platform, shellProbe.env, "posix-sh");
  // On Windows the command is interpreted by cmd.exe, which shares almost no
  // syntax with sh. Saying so in the description is the difference between a
  // model writing `dir` and a model writing `ls -la` and getting a confusing
  // "not recognized as an internal or external command".
  const shellNote =
    shellProbe.platform === "win32"
      ? " That is cmd.exe, not a POSIX shell: POSIX-only syntax (single-quoted strings, " +
        "heredocs, `$(...)`, and unix utilities that aren't installed) will fail, so write " +
        "commands for cmd.exe."
      : "";
  /**
   * Timeouts seen per normalized command, for this tool instance only — so the
   * breaker is scoped to one agent/session and a freshly created tool (a later
   * workflow step, a new role) starts clean.
   */
  const timeoutCounts = new Map<string, number>();
  return {
    definition: {
      name: "bash",
      description:
        `Run a shell command via \`${shell.label}\`.${shellNote} Stdout and stderr are merged; output is truncated to ` +
        `roughly the last ${MAX_OUTPUT_BYTES / 1024}KB. Defaults to a ${DEFAULT_TIMEOUT_MS / 1000}s ` +
        `timeout (max ${MAX_TIMEOUT_MS / 1000}s). Set background: true to start a long-running command ` +
        "and get back a taskId immediately instead of waiting for it to finish. A command that times " +
        `out ${REPEAT_TIMEOUT_LIMIT} times is refused until it changes, so bound it rather than retrying it unchanged.`,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
          timeoutMs: {
            type: "number",
            description: `Foreground timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). Ignored when background is true.`,
          },
          background: {
            type: "boolean",
            description:
              "Run the command in the background and return a taskId immediately. " +
              "Refused when a filesystem sandbox is configured (background tasks are not sandboxed).",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const command = input.command;
      if (typeof command !== "string" || command.length === 0) {
        return errorResult("`command` is required and must be a non-empty string.");
      }
      const background = input.background === true;
      let timeoutMs = DEFAULT_TIMEOUT_MS;
      if (
        typeof input.timeoutMs === "number" &&
        Number.isFinite(input.timeoutMs) &&
        input.timeoutMs > 0
      ) {
        timeoutMs = Math.min(Math.floor(input.timeoutMs), MAX_TIMEOUT_MS);
      }

      const cwd = resolvePath(ctx.cwd, ".");

      // Repeat-timeout circuit breaker. A command that has already timed out
      // REPEAT_TIMEOUT_LIMIT times will time out again if it is re-run
      // unchanged, burning another full timeout for nothing — so decline it
      // and say what has to change. This is the tool refusing to repeat a
      // known failure, not a permission decision, so it is checked before the
      // prompt: there is no point asking to approve a command we will not run.
      // Background commands return immediately and never time out, so the
      // breaker leaves that path alone.
      const commandKey = normalizeCommand(command);
      const priorTimeouts = timeoutCounts.get(commandKey) ?? 0;
      if (!background && priorTimeouts >= REPEAT_TIMEOUT_LIMIT) {
        const refusalDetails: BashToolDetails = { command, timeoutCount: priorTimeouts };
        return errorResult(
          repeatTimeoutRefusal(command, priorTimeouts),
          refusalDetails as unknown as Record<string, unknown>,
        );
      }

      const decision = await ctx.requestPermission({
        toolName: "bash",
        toolCallId: ctx.toolCallId,
        subject: command,
        description: `Run command: ${command}`,
        suggestedRule: { tool: "bash", specifier: `${firstWord(command)} *`, action: "allow" },
      });
      if (decision.behavior !== "allow") {
        return errorResult(decision.message ?? `Permission denied to run: ${command}`);
      }
      if (ctx.signal.aborted) return abortedResult();

      if (background) {
        // Background tasks are spawned by the task manager without a sandbox
        // wrapper; letting them run under `sandbox: "workspace-write"` would
        // be a silent bypass, so refuse instead of degrading.
        if (sandboxMode !== "off") {
          return errorResult(
            "Background commands are not sandboxed. Run the command in the " +
              'foreground, or set sandbox: "off" if the background task is intended.',
          );
        }
        const { taskId } = backgroundTasks.start(command, cwd);
        const details: BashToolDetails = { command, taskId };
        return textResult(
          `Started background task ${taskId}: ${command}`,
          details as unknown as Record<string, unknown>,
        );
      }

      // Both spawn targets below run the command through a shell, so the
      // stderr merge is applied once, here, to whichever one is chosen. The
      // sandbox backends are POSIX-only by construction, so the win32 branch
      // of `mergeStderrIntoStdout` only ever affects the unwrapped path.
      const spawnCommand = mergeStderrIntoStdout(command, shellProbe.platform);
      const invocation = resolveSandboxInvocation(
        spawnCommand,
        cwd,
        sandboxMode,
        options.sandboxProbe,
      );
      const notePrefix = invocation.unavailableNote ? `${invocation.unavailableNote}\n\n` : "";

      // A sandbox backend owns its own argv (`sandbox-exec -p … /bin/sh -c`,
      // `bwrap … /bin/sh -c`) and both backends are POSIX-only by
      // construction, so those invocations are used verbatim. Every other
      // case — no sandbox asked for, or one asked for that this platform
      // can't honor — is an unwrapped command, and *that* shell is this
      // tool's to resolve: `resolveSandboxInvocation` also falls back to
      // `resolveShell`, but only against the real process, while the tool
      // resolves against `shellProbe` (same helper, this tool's inputs).
      const unwrapped = sandboxMode === "off" || invocation.unavailableNote !== undefined;
      const spawnTarget = unwrapped
        ? {
            executable: shell.executable,
            args: shell.args(spawnCommand),
            spawnOptions: shell.spawnOptions,
          }
        : {
            executable: invocation.executable,
            args: invocation.args,
            spawnOptions: invocation.spawnOptions,
          };

      const result = await runForeground(
        spawnTarget.executable,
        spawnTarget.args,
        cwd,
        timeoutMs,
        ctx,
        spawnTarget.spawnOptions,
        killEnvironment,
      );
      const details: BashToolDetails = {
        command,
        exitCode: result.exitCode,
        outputTruncated: result.outputTruncated,
        ...(sandboxMode !== "off"
          ? { sandbox: sandboxMode, sandboxUnavailable: invocation.unavailableNote !== undefined }
          : {}),
      };

      if (result.aborted) {
        return errorResult(
          `${notePrefix}Command aborted.\n\n${result.output}`.trim(),
          details as unknown as Record<string, unknown>,
        );
      }
      if (result.timedOut) {
        const timeoutCount = priorTimeouts + 1;
        timeoutCounts.set(commandKey, timeoutCount);
        details.timeoutCount = timeoutCount;
        return errorResult(
          `${notePrefix}${timeoutMessage(timeoutMs, timeoutCount)}\n\n${result.output}`.trim(),
          details as unknown as Record<string, unknown>,
        );
      }

      // The command exited on its own — whatever its status — so whatever was
      // holding it open before is gone. Clear its timeout history.
      timeoutCounts.delete(commandKey);

      const suffix = result.outputTruncated
        ? `\n\n[Output truncated to last ${MAX_OUTPUT_BYTES / 1024}KB]`
        : "";
      const text = `${notePrefix}${result.output || "(no output)"}${suffix}\n\n[Exit code: ${result.exitCode}]`;
      const isError = result.exitCode !== 0;
      return isError
        ? errorResult(text, details as unknown as Record<string, unknown>)
        : textResult(text, details as unknown as Record<string, unknown>);
    },
  };
}
