/**
 * The user's *real* environment, read from their login shell.
 *
 * ## Why this file exists
 *
 * On macOS an application launched from the Dock, Spotlight or Finder is
 * started by `launchd`, and inherits `launchd`'s environment — not the one a
 * terminal would have. Nothing exported from `~/.zshrc`, `~/.zprofile`,
 * `~/.bash_profile` or `~/.config/fish/config.fish` exists in that process. A
 * GUI-launched VS Code on a normal Mac therefore has:
 *
 * ```
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin        (no /opt/homebrew/bin)
 * ANTHROPIC_API_KEY                          absent
 * ```
 *
 * Which is exactly the two failures a user reports as one: "the extension
 * can't find arcturn" and "it says no API key found". The same is true of a
 * Linux desktop launcher; it is *not* true on Windows, where a GUI process
 * inherits the user's environment block from the shell that spawned Explorer
 * and there is no login-shell concept to replicate — see
 * {@link shellProbeCommand}, which declines there.
 *
 * The fix is what `fix-path` and friends do: run the user's own shell as an
 * interactive login shell, ask it to print its environment, and use that. It
 * is implemented here rather than taken as a dependency because the risky
 * parts — which flags a given shell accepts, what may be imported into a
 * child, and what may be written to a log — are decisions this extension has
 * to own.
 *
 * ## Rules this module keeps
 *
 * 1. **It never returns text for a log.** {@link UserEnvironment.diagnostic}
 *    is built from a shell path, a count and a duration. No variable name and
 *    no variable value ever reaches it, including on the failure path — a
 *    profile that prints a secret to stderr must not have that quoted back
 *    into the Output channel. {@link secretEnvValues} exists so the caller can
 *    register the values it *did* read with a `Redactor`, as a second line of
 *    defence for anything that reaches a log by another route.
 * 2. **It never trusts the shell's stdout.** Only the text between two
 *    markers is parsed, so a chatty profile ("Welcome back!") cannot be read
 *    as a variable, and a profile that prints nothing at all is a failure
 *    rather than an empty environment.
 * 3. **It never wins an argument with VS Code.** See
 *    {@link mergeUserEnvironment} for the precedence, which is deliberately
 *    "the host is right, the shell fills gaps".
 *
 * Pure and `vscode`-free: the shell path, the platform, the base environment
 * and the runner are all parameters, so nothing here depends on the developer's
 * own shell. `user-env.ts` is the adapter that supplies the real ones.
 */

/** Marks the start of the environment dump inside the shell's stdout. */
export const ENV_BEGIN = "__ARCTURN_ENV_BEGIN__";
/** Marks the end of it. */
export const ENV_END = "__ARCTURN_ENV_END__";

/**
 * The script every POSIX-ish shell is asked to run.
 *
 * `env -0` and `printf '%s\0'`, not their newline forms, and that is the whole
 * safety argument of this module — see {@link parseEnvOutput}. NUL is the one
 * byte that cannot appear in an environment variable's name or value (the
 * kernel's `environ` is an array of C strings, so a NUL *is* the terminator);
 * framing on it means a record boundary is something no value can forge.
 *
 * Absolute paths, because a login shell that has not finished setting `PATH`
 * (or a `nu` that has no `printf` builtin at all) still has to be able to run
 * it. Single quotes are literal in every shell handled here — sh, bash, zsh,
 * fish, nu and tcsh alike — so `%s\0` reaches `printf`, which is what expands
 * the escape, rather than being expanded by the shell.
 *
 * `-0` is supported by GNU coreutils `env` (`--null`) and by BSD `env`, which
 * is what macOS ships. An `env` that does not accept it — BusyBox's, on some
 * minimal images — writes a usage error to *stderr* and no records at all, so
 * the body between the markers comes back empty; {@link parseEnvOutput}
 * refuses that rather than reporting an empty environment as a success, and
 * the caller falls back to the extension host's own environment with a
 * diagnostic. Refusing is the point: falling back to newline framing would be
 * falling back to the ambiguity this exists to remove.
 */
const POSIX_SCRIPT = `/usr/bin/printf '%s\\0' '${ENV_BEGIN}'; /usr/bin/env -0; /usr/bin/printf '%s\\0' '${ENV_END}'`;

/** The same, in PowerShell: `&` is its call operator for an external command. */
const POWERSHELL_SCRIPT = `& /usr/bin/printf '%s\\0' '${ENV_BEGIN}'; & /usr/bin/env -0; & /usr/bin/printf '%s\\0' '${ENV_END}'`;

/** Shell families that need different flags to reach a user's profile. */
export type ShellFamily = "posix" | "posix-plain" | "fish" | "nushell" | "csh" | "powershell";

/** An executable and its argument vector. */
export interface ShellProbe {
  readonly command: string;
  readonly args: string[];
}

/** Base name of a shell path, without a Windows extension. */
function shellName(shellPath: string): string {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * Which family a shell belongs to.
 *
 * Anything unrecognised is treated as `posix`, on the reasoning that almost
 * every shell someone sets as their login shell accepts `-l -i -c` and the
 * ones that do not simply exit non-zero — which {@link readUserEnvironment}
 * already handles as "fall back and say so". Guessing wrong costs one bounded
 * failed probe; refusing to guess costs every user of an unusual shell.
 *
 * @param shellPath - `vscode.env.shell`, or any absolute shell path.
 */
export function shellFamily(shellPath: string): ShellFamily {
  const name = shellName(shellPath);
  if (name === "fish") return "fish";
  if (name === "nu" || name === "nushell") return "nushell";
  if (name === "csh" || name === "tcsh") return "csh";
  if (name === "pwsh" || name === "powershell" || name === "powershell_ise") return "powershell";
  // `dash` is `/bin/sh` on Debian and Ubuntu, and it rejects `-l` outright;
  // `ash` and BusyBox `sh` are the same shape. A plain `-c` still sources
  // `$ENV`, which is where a `sh` user's exports live.
  if (name === "sh" || name === "dash" || name === "ash") return "posix-plain";
  return "posix";
}

/**
 * Build the command that makes a shell print its environment, or `undefined`
 * when there is nothing worth running.
 *
 * Per family, and why:
 *
 * - `posix` (bash, zsh, ksh, anything unknown) — `-l -i -c`. `-l` sources the
 *   login files (`.zprofile`, `.bash_profile`), `-i` the interactive ones
 *   (`.zshrc`, `.bashrc`). People put exports in both, so both are needed.
 * - `posix-plain` (sh, dash, ash) — `-c` only. `dash` has no `-l` and errors
 *   on it, which would turn a working probe into a fallback.
 * - `fish` — `-l -i -c`; fish spells its own flags the same way.
 * - `nushell` — `-l -c`, **never** `-i`: nushell reads `--interactive` as
 *   "open the REPL", which would sit there until the timeout killed it. `-l`
 *   is enough to load `env.nu` and `config.nu`.
 * - `csh`/`tcsh` — `-i -c`. tcsh's `-l` has to be the *only* flag on the line,
 *   so asking for a login shell here would mean giving up `-c` and getting no
 *   answer at all. `-i` still sources `.cshrc`/`.tcshrc`.
 * - `powershell` (pwsh on macOS/Linux) — `-Login -Command`, and a PowerShell
 *   spelling of the script.
 *
 * @param shellPath - `vscode.env.shell`, or `undefined` when it is unknown.
 * @param platform - `process.platform`.
 * @returns The probe, or `undefined` on Windows or with no usable shell.
 */
export function shellProbeCommand(
  shellPath: string | undefined,
  platform: NodeJS.Platform,
): ShellProbe | undefined {
  // Windows has no login shell to replicate: a GUI process there inherits the
  // user's environment block directly, so there is nothing this would fix and
  // a `cmd.exe` or `pwsh.exe` spawn per window would be pure cost.
  if (platform === "win32") return undefined;
  if (shellPath === undefined || shellPath.trim() === "") return undefined;
  const command = shellPath.trim();
  switch (shellFamily(command)) {
    case "posix-plain":
      return { command, args: ["-c", POSIX_SCRIPT] };
    case "nushell":
      return { command, args: ["-l", "-c", POSIX_SCRIPT] };
    case "csh":
      return { command, args: ["-i", "-c", POSIX_SCRIPT] };
    case "powershell":
      return { command, args: ["-Login", "-Command", POWERSHELL_SCRIPT] };
    default:
      return { command, args: ["-l", "-i", "-c", POSIX_SCRIPT] };
  }
}

/** `KEY` in `KEY=value`, as `env(1)` writes it. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Read the `NAME=value` records the shell printed between the two markers.
 *
 * ## Unambiguous by construction, not by heuristic
 *
 * The input is NUL-separated (`env -0`, see {@link POSIX_SCRIPT}), and every
 * record is split on that byte and read whole. Nothing is reassembled, nothing
 * is continued, and no line *inside* a record is ever re-examined.
 *
 * That matters because a variable's **value** is attacker-influenced in a way
 * its name is not — it can arrive from a generated dotfile, a dependency's
 * `.env`, or anything else that got exported along the way — and a value may
 * contain newlines. A parser that walked lines could be handed
 *
 * ```text
 * EVIL=x
 * ANTHROPIC_API_KEY=attacker-supplied
 * ```
 *
 * as one *value* and read its second line as a new assignment: a way to set
 * any variable at all, including the credential this whole feature exists to
 * find, and including `PATH`, which decides which `arcturn` binary the
 * extension executes. Splitting on NUL removes that ambiguity rather than
 * defending against it, because a value cannot contain a NUL in the first
 * place.
 *
 * The markers are unforgeable for the same structural reason: a record is
 * always `NAME=VALUE` and therefore always contains `=`, while a marker
 * contains none, so no environment variable can produce a record *equal* to
 * one — an end marker inside a value can no longer truncate the body. The
 * begin marker is matched as a suffix rather than as a whole record, because
 * anything a profile printed to stdout before it (a banner, a version nag)
 * lands in the same NUL-free run; taking the **first** such record means a
 * value that merely *ends* with the marker text — which can only appear
 * later — cannot shift the window and drop the records before it.
 *
 * @param stdout - Everything the shell wrote to stdout.
 * @returns The variables, or `undefined` when the framing is not there or the
 *   body is empty. Both mean "this shell did not answer the question asked" —
 *   it errored, it was killed, or its `env` rejected `-0` — which is not the
 *   same thing as "the user has no environment".
 */
export function parseEnvOutput(stdout: string): Record<string, string> | undefined {
  const records = stdout.split("\0");
  const begin = records.findIndex((record) => record.endsWith(ENV_BEGIN));
  if (begin === -1) return undefined;
  const end = records.indexOf(ENV_END, begin + 1);
  if (end === -1) return undefined;

  const env: Record<string, string> = {};
  let count = 0;
  for (const record of records.slice(begin + 1, end)) {
    const match = ASSIGNMENT.exec(record);
    // `env -0` emits nothing but assignments, so a record that is not one came
    // from somewhere else. It is dropped, never merged into the record before
    // it — merging is the exact step that let a value become a variable.
    if (match?.[1] === undefined) continue;
    env[match[1]] = match[2] ?? "";
    count += 1;
  }
  // An `env` that rejected `-0` wrote its usage to stderr and no records at
  // all, leaving two markers with nothing between them. No real environment is
  // empty, so this is a failure; reporting it as a success would hand the
  // caller a merge that changes nothing while claiming the shell answered.
  return count === 0 ? undefined : env;
}

/**
 * Variables that must never be imported from a login shell, even when the
 * extension host does not define them.
 *
 * These are the ones that change how a *child Node process* behaves rather
 * than what it can find: `ELECTRON_RUN_AS_NODE` and the `VSCODE_`/`ELECTRON_`
 * block are the editor's own private wiring, and `NODE_OPTIONS` from a user's
 * profile (`--inspect`, a loader) would be silently applied to `arcturn serve`
 * and to nothing else they run.
 */
const BLOCKED_EXACT: ReadonlySet<string> = new Set([
  "_",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
]);

/** Prefixes of the same. */
const BLOCKED_PREFIXES = ["VSCODE_", "ELECTRON_", "CHROME_"] as const;

function isBlocked(name: string): boolean {
  return BLOCKED_EXACT.has(name) || BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Merge the shell's environment into the extension host's.
 *
 * **Precedence, deliberately: the host wins, the shell fills gaps.**
 *
 * - A variable the extension host already defines is kept as-is. VS Code sets
 *   a number of them on purpose (`VSCODE_*`, `ELECTRON_*`, `TERM_PROGRAM`,
 *   whatever a remote/dev-container host injected, and anything the user put
 *   in `terminal.integrated.env.*`'s process-level equivalents), and a login
 *   shell that happened to export the same name must not quietly replace it —
 *   the shell is being consulted for what the host is *missing*, which is the
 *   whole failure being fixed.
 * - A variable the host does not define is taken from the shell, unless it is
 *   on the blocklist above.
 * - `PATH` is the one merge rather than a choice: the shell's entries come
 *   first — so `arcturn` resolves to the same binary the user's terminal would
 *   run, which is the point — and the host's entries follow, deduplicated, so
 *   nothing the editor could previously find becomes unfindable.
 *
 * @param base - The extension host's own environment (`process.env`).
 * @param shell - What the login shell printed.
 * @param platform - `process.platform`; reserved for path-separator rules.
 */
export function mergeUserEnvironment(
  base: Record<string, string | undefined>,
  shell: Record<string, string>,
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...base };
  for (const [name, value] of Object.entries(shell)) {
    if (isBlocked(name)) continue;
    if (base[name] !== undefined) continue;
    merged[name] = value;
  }
  const separator = platform === "win32" ? ";" : ":";
  const shellPath = shell.PATH;
  if (shellPath !== undefined && shellPath !== "") {
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const entry of [...shellPath.split(separator), ...(base.PATH ?? "").split(separator)]) {
      if (entry === "" || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
    merged.PATH = entries.join(separator);
  }
  return merged;
}

/** Names that mean the value is a credential rather than a setting. */
const SECRET_NAME = /(?:API_?KEY|^KEY$|_KEY$|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)/i;

/**
 * The values worth handing to a {@link import("./serve/redact.js").Redactor}.
 *
 * Nothing in this extension logs the environment, so this is defence in depth:
 * if a value ever reaches a diagnostic by some other route — a spawn error
 * that echoes an argument vector, a future caller that is less careful — the
 * redactor will already know it by value.
 *
 * A value with whitespace in it, or one that looks like a filesystem path, is
 * not treated as a secret: `KEY_DESCRIPTION="the key for the thing"` and
 * `SSH_KEY_PATH=/Users/me/.ssh/id_ed25519` are settings, and blanking them out
 * of a diagnostic would make the diagnostic useless while protecting nothing.
 * Values shorter than eight characters are skipped for the same reason the
 * redactor ignores them.
 *
 * @param env - Any environment map.
 * @returns Distinct credential-shaped values, in no particular order.
 */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (!SECRET_NAME.test(name)) continue;
    if (/\s/.test(value)) continue;
    if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) continue;
    values.add(value);
  }
  return [...values];
}

/** The environment the extension will actually spawn children with. */
export interface UserEnvironment {
  /** The merged environment. */
  readonly env: Record<string, string | undefined>;
  /** `"shell"` when the login shell answered, `"process"` when it did not. */
  readonly source: "shell" | "process";
  /** The shell that was consulted, when one was. */
  readonly shell?: string;
  /**
   * One line for the Output channel.
   *
   * Contains a shell path, a count, a duration and — on failure — a category.
   * It never contains a variable name or value, on either path.
   */
  readonly diagnostic: string;
  /** Credential-shaped values, from {@link secretEnvValues}. */
  readonly secrets: readonly string[];
  /**
   * Whether asking again could plausibly give a different answer.
   *
   * `true` for a probe that *failed* — a profile that overran the deadline
   * once, a default shell that had not been chosen yet, an `env` whose output
   * could not be framed — because those are the *absence* of an answer rather
   * than an answer, and running the shell again may well produce one. `false`
   * for a successful read (already correct) and for Windows (there was never a
   * probe to retry). `user-env.ts`'s `forgetFailedUserEnvironment` is what
   * acts on it.
   */
  readonly retryable: boolean;
}

/** What {@link readUserEnvironment} needs from the outside world. */
export interface ReadUserEnvironmentOptions {
  readonly platform: NodeJS.Platform;
  /** `vscode.env.shell`. */
  readonly shell: string | undefined;
  /** The extension host's own environment. */
  readonly baseEnv: Record<string, string | undefined>;
  /** Deadline for the shell. Default 5000ms. */
  readonly timeoutMs?: number;
  /** Runs the probe. Injected so no test depends on the developer's shell. */
  readonly run: (probe: ShellProbe, timeoutMs: number) => Promise<{ stdout: string }>;
}

/** Default deadline: long enough for a slow `nvm`, short enough to notice. */
export const DEFAULT_SHELL_TIMEOUT_MS = 5000;

/**
 * Categorise a probe failure without quoting anything the shell printed.
 *
 * A login shell's stderr is the user's own profile talking, and a profile can
 * print anything — including a secret. `execFile`'s rejection embeds that
 * stderr, so the message is deliberately *not* used; only the shape of the
 * failure is reported.
 */
function failureReason(error: unknown, timeoutMs: number): string {
  const detail = error as { killed?: boolean; signal?: string; code?: unknown } | undefined;
  if (detail?.killed === true || detail?.signal === "SIGTERM") {
    return `the shell timed out after ${String(timeoutMs)}ms`;
  }
  if (typeof detail?.code === "number") {
    return `the shell exited with code ${String(detail.code)}`;
  }
  if (typeof detail?.code === "string") return `the shell could not be run (${detail.code})`;
  return "the shell could not be run";
}

/**
 * Read the user's login-shell environment, falling back to the host's own.
 *
 * Never rejects. Every failure — Windows, no shell, a timeout, a non-zero
 * exit, a profile that swallowed the markers — resolves with
 * `source: "process"` and a {@link UserEnvironment.diagnostic} that says the
 * fallback happened and what the user loses by it.
 *
 * @param options - See {@link ReadUserEnvironmentOptions}.
 */
export async function readUserEnvironment(
  options: ReadUserEnvironmentOptions,
): Promise<UserEnvironment> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const fallback = (diagnostic: string, retryable: boolean): UserEnvironment => ({
    env: options.baseEnv,
    source: "process",
    diagnostic,
    secrets: [],
    retryable,
  });

  if (options.platform === "win32") {
    return fallback(
      "environment: not reading a login shell on Windows — a GUI process there already inherits " +
        "the user environment, so there is nothing to recover.",
      false,
    );
  }

  const probe = shellProbeCommand(options.shell, options.platform);
  if (probe === undefined) {
    return fallback(
      "environment: VS Code reported no default shell, so the extension host's own environment is " +
        "all there is. Variables exported from a shell profile (API keys, PATH entries such as " +
        "/opt/homebrew/bin) will not be visible to arcturn.",
      // Which shell is the default is a setting; it can be chosen after this
      // window opened, so this one is worth asking again.
      true,
    );
  }

  const startedAt = Date.now();
  let stdout: string;
  try {
    ({ stdout } = await options.run(probe, timeoutMs));
  } catch (error) {
    return fallback(
      `environment: could not read the login shell environment from ${probe.command} ` +
        `(${failureReason(error, timeoutMs)}); using the extension host's own environment. ` +
        "Variables exported from your shell profile (API keys, PATH entries such as " +
        "/opt/homebrew/bin) will not be visible to arcturn. Reconnecting tries again.",
      true,
    );
  }

  const parsed = parseEnvOutput(stdout);
  if (parsed === undefined) {
    return fallback(
      `environment: could not read the login shell environment from ${probe.command} ` +
        "(it answered without usable NUL-framed output); using the extension host's own " +
        "environment. Variables exported from your shell profile (API keys, PATH entries such as " +
        "/opt/homebrew/bin) will not be visible to arcturn. Reconnecting tries again.",
      true,
    );
  }

  const durationMs = Date.now() - startedAt;
  return {
    env: mergeUserEnvironment(options.baseEnv, parsed, options.platform),
    source: "shell",
    shell: probe.command,
    diagnostic:
      `environment: read ${String(Object.keys(parsed).length)} variables from ` +
      `${probe.command} in ${String(durationMs)}ms`,
    secrets: secretEnvValues(parsed),
    retryable: false,
  };
}
