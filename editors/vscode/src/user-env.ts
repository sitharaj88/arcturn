/**
 * The adapter half of `shell-env.ts`: the real shell, the real `execFile`, and
 * exactly one probe per window.
 *
 * Everything with a decision in it lives in `shell-env.ts`, which has no
 * `vscode` import and no process spawn. What is here is the part that needs
 * both: reading `vscode.env.shell`, running the child under a deadline, and
 * caching the answer.
 *
 * Three properties this module is responsible for.
 *
 * 1. **Never at activation.** RFC 0004 §3 gives activation no budget for a
 *    process spawn, and the integration suite asserts nothing is spawned by
 *    activating. Nothing here runs until {@link resolveUserEnvironment} is
 *    called, and its only callers are `cli.ts`'s lazy resolution and the
 *    sidebar's first engine start.
 * 2. **Once per window, unless it failed.** The promise is memoised, so a
 *    second workspace command and the version probe share one shell
 *    invocation. Two different cases hide under "the answer is stale", and
 *    they are not treated alike:
 *
 *    - *The profile changed.* A successful read stays cached. Re-running a
 *      whole login shell on every reconnect would turn a Retry button into a
 *      multi-second stall for an answer that was already correct, and a user
 *      who edits their profile reloads the window — which is what they already
 *      have to do for VS Code to notice anything else in it.
 *    - *The probe failed.* A `nvm`/`asdf` init that overran the deadline once,
 *      a machine that came back from sleep mid-spawn. That is not an answer at
 *      all, it is the absence of one, and caching it for the life of the window
 *      pins every later spawn to an environment with no API keys in it — with
 *      the reconnect card's own *Retry* button unable to do anything about it.
 *      So {@link forgetFailedUserEnvironment} drops exactly that, and the
 *      sidebar calls it on the restart path. Pressing Retry re-probes; pressing
 *      Retry after a success does not.
 * 3. **Bounded.** A profile that blocks on a network call, an `nvm` that
 *    rebuilds, a shell that waits for input: all of them end at
 *    `DEFAULT_SHELL_TIMEOUT_MS`, and the caller gets `process.env` plus a
 *    diagnostic saying so. Nothing here can hang a command.
 */

import { execFile } from "node:child_process";
import * as vscode from "vscode";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  readUserEnvironment,
  type ShellProbe,
  type UserEnvironment,
} from "./shell-env.js";

export type { UserEnvironment } from "./shell-env.js";

/**
 * Ceiling on what the shell may print.
 *
 * `env` output is a few kilobytes; anything past this is a profile writing to
 * stdout in a loop, and truncating it into a parse failure (with a fallback
 * and a diagnostic) is better than growing the extension host's heap.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Run the probe with `execFile`, resolving only what it wrote to stdout. */
function runProbe(probe: ShellProbe, timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      probe.command,
      probe.args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        // The login shell starts from what this process has, and adds to it.
        // Handing it a stripped environment would change what the profile
        // itself decides — a `.zshrc` that keys off `TERM` or `HOME` would
        // take a different branch than it does in the user's own terminal.
        env: process.env,
        encoding: "utf8",
      },
      (error, stdout) => {
        // The rejection is deliberately passed through *unwrapped*:
        // `shell-env.ts` reads only its `killed`/`signal`/`code` fields and
        // never its message, because the message embeds the shell's stderr —
        // which is the user's own profile talking, and may carry a secret.
        if (error) reject(error);
        else resolve({ stdout });
      },
    );
  });
}

/** Injection points for tests; production leaves all of them alone. */
export interface UserEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly shell?: string | undefined;
  readonly baseEnv?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly run?: (probe: ShellProbe, timeoutMs: number) => Promise<{ stdout: string }>;
}

let cached: Promise<UserEnvironment> | undefined;
/** The settled value of {@link cached}, once it has one. */
let settled: UserEnvironment | undefined;

/**
 * The environment this extension spawns children with, resolved once per
 * window.
 *
 * @param options - Test injections. Passing any of them still shares the cache,
 *   so tests that want an isolated read must call {@link resetUserEnvironment}
 *   first.
 * @returns The merged environment, never rejecting — see
 *   {@link readUserEnvironment}.
 */
export function resolveUserEnvironment(
  options: UserEnvironmentOptions = {},
): Promise<UserEnvironment> {
  cached ??= readUserEnvironment({
    platform: options.platform ?? process.platform,
    // `vscode.env.shell` is VS Code's own detection of the user's default
    // shell — the same value the integrated terminal opens — so it honours
    // `terminal.integrated.defaultProfile.*` and `chsh` alike, and there is no
    // reason for this extension to re-derive it from `SHELL` or `/etc/passwd`.
    shell: options.shell ?? vscode.env.shell,
    baseEnv: options.baseEnv ?? process.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
    run: options.run ?? runProbe,
  }).then((resolved) => {
    settled = resolved;
    return resolved;
  });
  return cached;
}

/**
 * Drop the memoised environment **only if the probe failed**.
 *
 * Called from the sidebar's restart path, so the reconnect card's *Retry* is a
 * retry of the whole start — including the login shell — rather than a retry
 * of everything except the step that broke. A successful read is left alone;
 * see this module's doc for why the two cases differ.
 *
 * @returns `true` when a cached failure was dropped, so the caller knows to
 *   log the next diagnostic rather than treating it as a repeat.
 */
export function forgetFailedUserEnvironment(): boolean {
  // A probe still in flight has no settled value, so it is never discarded —
  // discarding it would leave the in-flight shell running with nobody waiting.
  if (settled === undefined || !settled.retryable) return false;
  cached = undefined;
  settled = undefined;
  return true;
}

/** Drop the memoised environment unconditionally. Tests only. */
export function resetUserEnvironment(): void {
  cached = undefined;
  settled = undefined;
}
