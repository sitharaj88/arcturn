/**
 * One answer to "how do I hand a command *string* to a shell on this
 * platform", shared by every place in Arcturn that spawns one: the `bash`
 * tool, the verify loop, and lifecycle hooks.
 *
 * Before this existed each of those hardcoded `/bin/sh`, which is not a path
 * that exists on native Windows — so the whole write/exec lane failed there.
 *
 * ## Why `cmd.exe` on Windows and not PowerShell
 *
 * - It is always present. PowerShell's availability, version (5.1 vs 7+) and
 *   execution policy all vary per machine; `%ComSpec%` does not.
 * - Its argument handling is predictable *for this exact shape*:
 *   `cmd /d /s /c "<command>"` with verbatim arguments strips one outer quote
 *   pair and runs the rest untouched. PowerShell would re-parse the string
 *   under its own quoting and operator rules.
 * - It is what Node's own `{ shell: true }` uses, so behavior matches what
 *   every other Node tool on the machine does.
 *
 * The honest tradeoff: commands an agent writes are usually POSIX-flavored,
 * and `cmd.exe` will not run them. `ls -la`, `grep`, single-quoted strings,
 * `$(…)`, heredocs and `&&`-chained POSIX builtins fail there. We do not
 * shim a POSIX layer on top, because a shim that handles 80% of shell syntax
 * is a lie the model cannot see through — it would turn a clear "not
 * recognized as an internal or external command" into a silently wrong
 * result. Instead the `bash` tool tells the model, in its own description,
 * which shell will interpret the command (see {@link ResolvedShell.label}),
 * so it can write for the platform it is actually on.
 */

/** POSIX shell used when no user shell applies. */
export const POSIX_DEFAULT_SHELL = "/bin/sh";

/** Windows shell used when `%ComSpec%` is unset. */
export const WINDOWS_DEFAULT_SHELL = "cmd.exe";

/**
 * `cmd.exe` flags: `/d` skips AutoRun registry commands (so a machine-local
 * `HKCU\...\Command Processor\AutoRun` cannot inject itself into every
 * command we run), `/s` selects the "strip exactly one outer quote pair"
 * parsing rule, `/c` runs the command and exits.
 */
export const WINDOWS_SHELL_FLAGS: readonly string[] = ["/d", "/s", "/c"];

/**
 * Which shell to prefer on POSIX.
 *
 * - `"posix-sh"` — always `/bin/sh`. For commands *Arcturn or the model*
 *   wrote: they are POSIX-sh flavored, and running them under an
 *   interactive `$SHELL` would silently change their meaning (fish and csh
 *   are not sh-compatible at all; zsh errors on a glob that matches nothing
 *   where sh passes it through literally).
 * - `"user"` — `$SHELL`, falling back to `/bin/sh`. For commands *the user*
 *   wrote in their own config, where their aliases-free-but-familiar shell
 *   is the least surprising interpreter.
 *
 * On Windows both policies resolve identically; see {@link resolveShell}.
 */
export type ShellPolicy = "posix-sh" | "user";

/** Spawn options that must accompany a resolved shell invocation. */
export interface ShellSpawnOptions {
  /**
   * Windows only. `cmd.exe` does not use CRT argument parsing, so letting
   * libuv escape our argv would mangle any quote inside the command. We
   * build the command line ourselves ({@link ResolvedShell.args}) and pass
   * it through verbatim — the same thing Node does for `{ shell: true }`.
   */
  windowsVerbatimArguments?: boolean;
}

/** How to spawn a command string on one platform. */
export interface ResolvedShell {
  /** The shell executable to spawn. */
  executable: string;
  /** The full argument vector (after the executable) for `command`. */
  args: (command: string) => string[];
  /**
   * Options that MUST be merged into the `spawn` call for this invocation to
   * be correct — spread them, do not drop them:
   * `spawn(shell.executable, shell.args(cmd), { cwd, ...shell.spawnOptions })`.
   */
  spawnOptions: ShellSpawnOptions;
  /** Human/model-facing form of the invocation, e.g. `"/bin/sh -c"`. */
  label: string;
}

/**
 * Read `name` from `env` case-sensitively; `undefined` when unset or empty.
 * POSIX environments are case-sensitive, so `shell` is not `SHELL`.
 */
function readPosixEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read `name` from `env` case-insensitively; `undefined` when unset or empty.
 *
 * The Windows environment block is itself case-insensitive (`ComSpec`,
 * `COMSPEC` and `comspec` are one variable) and Node's real `process.env`
 * mirrors that — but a plain object built in a test, or an env inherited
 * through an MSYS/Cygwin layer, does not.
 */
function readWindowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = env[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Wrap `command` in the one outer quote pair that `cmd /s /c` strips back
 * off. Quotes *inside* the command are left exactly as the caller wrote them
 * — `/s` does not re-parse them — so `echo "a b"` survives intact.
 */
function quoteForCmd(command: string): string {
  return `"${command}"`;
}

/**
 * Resolve how to run a shell command string on `platform`.
 *
 * Pure: it reads nothing but its arguments, so every platform is testable
 * from every platform. Defaults come from the current process only when the
 * caller omits them.
 *
 * @param platform - Target platform; defaults to `process.platform`.
 * @param env - Environment to read `$SHELL`/`%ComSpec%` from; defaults to `process.env`.
 * @param policy - Which POSIX shell to prefer; defaults to `"posix-sh"` (see {@link ShellPolicy}).
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  policy: ShellPolicy = "posix-sh",
): ResolvedShell {
  if (platform === "win32") {
    // `$SHELL` is deliberately ignored here even under the "user" policy:
    // Git Bash and MSYS set it to a POSIX path like `/usr/bin/bash` that
    // Win32 `CreateProcess` cannot resolve, so honoring it would replace a
    // working shell with a guaranteed ENOENT.
    const executable = readWindowsEnv(env, "ComSpec") ?? WINDOWS_DEFAULT_SHELL;
    return {
      executable,
      args: (command) => [...WINDOWS_SHELL_FLAGS, quoteForCmd(command)],
      spawnOptions: { windowsVerbatimArguments: true },
      label: `${executable} ${WINDOWS_SHELL_FLAGS.join(" ")}`,
    };
  }

  const executable =
    policy === "user" ? (readPosixEnv(env, "SHELL") ?? POSIX_DEFAULT_SHELL) : POSIX_DEFAULT_SHELL;
  return {
    executable,
    args: (command) => ["-c", command],
    spawnOptions: {},
    label: `${executable} -c`,
  };
}

/**
 * The platform and environment a shell is resolved against. Defaults to the
 * real process; injected by tests to exercise a platform the test runner
 * isn't running on (mirrors `SandboxProbe` in `./sandbox.ts`).
 */
export interface ShellProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** The real environment: `process.platform` and `process.env`. */
export function defaultShellProbe(): ShellProbe {
  return { platform: process.platform, env: process.env };
}
