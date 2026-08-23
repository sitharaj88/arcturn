/**
 * The verify loop: after the model edits a file, run a configured check
 * command (tests/typecheck/lint/...) and, if it fails, feed the failure back
 * to the model as part of the tool result — the same way {@link
 * ../lsp/wrap.js#wrapToolsWithLsp} appends diagnostics — so the model sees
 * its own breakage in the very next turn and can self-correct.
 *
 * This never turns a successful `write`/`edit` into a failure: a verify
 * command that fails only *appends* a notice to the already-successful
 * result. A passing verify appends nothing at all (quiet on green), and a
 * command that doesn't apply to the edited path (`globs` didn't match, or
 * `runOn: "manual"`) simply never runs.
 */

import { spawn } from "node:child_process";
import { sep } from "node:path";
import {
  defaultKillEnvironment,
  type KillEnvironment,
  resolvePath,
  resolveShell,
  terminateProcessTree,
} from "@arcturn/tools";
import type { Tool, ToolResult } from "@arcturn/types";

/** Tool names whose successful result triggers a verify run. */
const WRAPPED_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);

/** Default timeout for a verify command, in milliseconds. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;

/** Output appended to the model is capped to roughly this many trailing lines. */
export const DEFAULT_VERIFY_TAIL_LINES = 40;

/**
 * One configured verify check.
 *
 * A bare string in config (`"pnpm test"`) is sugar for `{ command }` with no
 * `globs` — it runs after every successful `write`/`edit`.
 */
export interface VerifyConfig {
  /**
   * Shell command, run in the runtime's `cwd` through the platform's shell:
   * `/bin/sh -c <command>` on POSIX, `%ComSpec% /d /s /c "<command>"` on
   * Windows (see `resolveShell` in `@arcturn/tools`). A verify command that
   * has to run on both therefore needs to be written for both — `pnpm test`
   * is fine, `FOO=1 pnpm test` is not.
   */
  command: string;
  /**
   * Restricts which edited paths trigger this command. Matching is a simple
   * suffix/segment check, not full glob syntax:
   *
   * - A pattern starting with `*` (e.g. `"*.ts"`) matches when the edited
   *   path ends with the rest of the pattern (`".ts"`).
   * - Any other pattern matches when it equals the whole path, is a
   *   trailing path suffix (`"src/foo.ts"` matches `.../src/foo.ts`), or
   *   names one of the path's segments exactly (`"src"` matches
   *   `.../src/foo.ts`).
   *
   * There is no `**` and no mid-pattern `*`. Omitted (or empty) matches
   * every edited path.
   */
  globs?: string[];
  /** Timeout before the command (and its whole process tree) is killed. Defaults to {@link DEFAULT_VERIFY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * `"edit"` (the default) runs the command automatically after every
   * matching `write`/`edit`. `"manual"` never runs it automatically —
   * {@link Verifier.maybeRun} always resolves `null` — it only runs via
   * {@link Verifier.runNow}, e.g. from a `/verify` slash command.
   */
  runOn?: "edit" | "manual";
}

/** Outcome of running a verify command once. */
export interface VerifyResult {
  /** `true` when the command exited 0. */
  ok: boolean;
  /** The command's exit code, or `null` if it was killed (e.g. on timeout). */
  exitCode: number | null;
  /** Merged stdout+stderr, tail-capped to {@link DEFAULT_VERIFY_TAIL_LINES} lines. */
  output: string;
}

/** Options for {@link createVerifier}. */
export interface CreateVerifierOptions {
  /** Working directory the verify command is spawned in. */
  cwd: string;
  /** Environment for the spawned process. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Platform whose shell the command is run through, and whose process-tree
   * kill a timeout uses. Defaults to `process.platform`; only meant for tests
   * exercising a platform the test runner isn't running on.
   */
  platform?: NodeJS.Platform;
  /**
   * Overrides the OS kill calls used to terminate a timed-out command's
   * process tree. Defaults to {@link defaultKillEnvironment} (the real
   * platform, real `process.kill`/`taskkill`). {@link platform} still wins
   * when set, so one knob decides both which shell runs the command and how
   * its tree is killed; only meant for tests.
   */
  killEnvironment?: KillEnvironment;
}

/** Runs one configured verify command, on demand or after matching edits. */
export interface Verifier {
  /**
   * Run the command if `editedPath` matches `globs` and `runOn` is not
   * `"manual"`; resolve `null` without running it otherwise.
   *
   * Concurrent calls while a run is already in flight resolve to that same
   * run's result instead of starting a second process — N edits landing in
   * one turn coalesce into a single command invocation.
   *
   * @param editedPath - The file the triggering `write`/`edit` touched.
   */
  maybeRun(editedPath: string): Promise<VerifyResult | null>;
  /**
   * Run the command unconditionally, ignoring `globs` and `runOn`. Meant
   * for an explicit trigger (e.g. a `/verify` slash command) rather than
   * the automatic post-edit path. Still coalesces with a concurrent
   * in-flight run, same as {@link maybeRun}.
   */
  runNow(): Promise<VerifyResult>;
}

/** Keep only the last `maxLines` lines of `text`. */
function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}

/**
 * The platform and OS kill calls this verify run terminates its process tree
 * with. `opts.platform` is the single "pretend to be this platform" knob, so
 * it wins over the injected environment's own platform: a test can never end
 * up running a Windows shell and a POSIX kill.
 */
function resolveKillEnvironment(opts: CreateVerifierOptions): KillEnvironment {
  const base = opts.killEnvironment ?? defaultKillEnvironment();
  return opts.platform === undefined ? base : { ...base, platform: opts.platform };
}

/** Spawn `command` in `opts.cwd`, capture merged stdout+stderr, and resolve a {@link VerifyResult}. */
function runVerifyCommand(
  command: string,
  timeoutMs: number,
  opts: CreateVerifierOptions,
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const childEnv = opts.env ?? process.env;
    // One platform decides both how the command is run and how it is killed,
    // so a test can never pair a Windows shell with a POSIX kill.
    const killEnv = resolveKillEnvironment(opts);
    // A verify command comes from the user's config but is run unattended by
    // the harness, so it takes the "posix-sh" policy rather than following an
    // interactive `$SHELL`: `pnpm test` must mean the same thing for every
    // user of the same repo.
    const shell = resolveShell(killEnv.platform, childEnv, "posix-sh");
    // POSIX: `detached: true` makes the child its own process-group leader, so
    // the timeout below can reach every descendant it spawned, not just this
    // immediate child. win32 has no process groups, so nothing is detached
    // there and the child keeps sharing this process's console; `taskkill /T`
    // walks the real parent-child tree instead (mirrors tools/bash.ts).
    const child = spawn(shell.executable, shell.args(command), {
      cwd: opts.cwd,
      env: childEnv,
      detached: killEnv.platform !== "win32",
      ...shell.spawnOptions,
    });

    let output = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the command's whole tree, not just the shell: on POSIX that is
      // `process.kill(-pid, signal)` against the process group the spawn above
      // created, and on win32 — where there are no process groups and that
      // call throws — it is `taskkill /pid <pid> /T /F`. Which one is decided
      // by the one shared helper, `terminateProcessTree` in `@arcturn/tools`,
      // rather than by a second copy of the branch here.
      terminateProcessTree(child, "SIGKILL", killEnv);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = timedOut
        ? `${output}\n[verify command timed out after ${timeoutMs}ms and was killed]`
        : output;
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode: timedOut ? null : exitCode,
        output: tailLines(text.trim(), DEFAULT_VERIFY_TAIL_LINES),
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (error) => {
      output += `\n[spawn error: ${error instanceof Error ? error.message : String(error)}]`;
      finish(null);
    });
  });
}

/** Match `path` against one {@link VerifyConfig.globs} entry; see its docs for the rules. */
export function matchesGlob(path: string, glob: string): boolean {
  const normalized = path.split(sep).join("/");
  if (glob.startsWith("*")) {
    return normalized.endsWith(glob.slice(1));
  }
  return (
    normalized === glob || normalized.endsWith(`/${glob}`) || normalized.split("/").includes(glob)
  );
}

/**
 * Build a {@link Verifier} for one {@link VerifyConfig}.
 *
 * @param config - The command to run, and when it applies.
 * @param opts - Working directory (and optional environment) to run it in.
 */
export function createVerifier(config: VerifyConfig, opts: CreateVerifierOptions): Verifier {
  const timeoutMs =
    config.timeoutMs !== undefined && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_VERIFY_TIMEOUT_MS;
  const globs = config.globs ?? [];

  // Concurrent calls dedupe onto this single in-flight run; cleared once it
  // settles so the *next* (non-overlapping) call spawns a fresh process.
  let inFlight: Promise<VerifyResult> | undefined;

  function run(): Promise<VerifyResult> {
    if (inFlight) return inFlight;
    const started = runVerifyCommand(config.command, timeoutMs, opts);
    inFlight = started;
    void started.finally(() => {
      if (inFlight === started) inFlight = undefined;
    });
    return started;
  }

  return {
    async maybeRun(editedPath) {
      if (config.runOn === "manual") return null;
      if (globs.length > 0 && !globs.some((glob) => matchesGlob(editedPath, glob))) return null;
      return run();
    },
    runNow() {
      return run();
    },
  };
}

/** Append a verify-failure notice onto a `ToolResult`'s last text block. */
function withVerifyFailureAppended(result: ToolResult, verify: VerifyResult): ToolResult {
  const suffix = `\n\nverify failed (exit ${verify.exitCode ?? "null"}):\n${verify.output}`;
  const lastTextIndex = result.content.reduce(
    (found, item, index) => (item.type === "text" ? index : found),
    -1,
  );
  if (lastTextIndex === -1) {
    return { ...result, content: [...result.content, { type: "text", text: suffix.trimStart() }] };
  }
  const content = result.content.map((item, index) =>
    index === lastTextIndex && item.type === "text"
      ? { ...item, text: `${item.text}${suffix}` }
      : item,
  );
  return { ...result, content };
}

/**
 * Wrap `write`/`edit` in `tools` so each successful call is followed by
 * {@link Verifier.maybeRun} on the file it changed. Every other tool passes
 * through unchanged (same object, not a copy).
 *
 * A failing verify never turns the original success into an error — it only
 * appends a `verify failed (exit N): <tail>` notice to the result text, so
 * the model sees it on the next turn and can self-correct. A passing verify,
 * or one that didn't apply (glob mismatch, `runOn: "manual"`), appends
 * nothing.
 *
 * @param tools - The tool set to wrap (e.g. `createDefaultTools().tools`).
 * @param verifier - Verifier to consult after each successful call; see {@link createVerifier}.
 */
export function wrapToolsWithVerify(tools: readonly Tool[], verifier: Verifier): Tool[] {
  return tools.map((tool) => {
    if (!WRAPPED_TOOL_NAMES.has(tool.definition.name)) return tool;

    // Spread first so extra tool surface (e.g. bindAgent) survives the wrap.
    return {
      ...tool,
      async execute(input, ctx) {
        const result = await tool.execute(input, ctx);
        if (result.isError) return result;

        const rawPath = input.path;
        if (typeof rawPath !== "string" || rawPath.length === 0) return result;

        let absolutePath: string;
        try {
          absolutePath = resolvePath(ctx.cwd, rawPath);
        } catch {
          return result;
        }

        let verify: VerifyResult | null;
        try {
          verify = await verifier.maybeRun(absolutePath);
        } catch {
          verify = null;
        }
        if (!verify || verify.ok) return result;

        return withVerifyFailureAppended(result, verify);
      },
    } satisfies Tool;
  });
}
