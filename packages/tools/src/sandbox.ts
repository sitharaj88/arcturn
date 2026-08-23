/**
 * Optional filesystem sandboxing for the `bash` tool's foreground commands.
 *
 * `"off"` (the default) changes nothing: the command runs exactly as before.
 * `"workspace-write"` wraps the command so writes outside a small set of
 * writable roots (the working directory, the OS temp dir, and `$HOME/.arcturn`
 * minus the org memory store, which is carved back out — see
 * {@link orgMemoryStore}) are denied by the OS itself, while everything else —
 * reads, network, process spawning — is left alone. Only the darwin (`sandbox-exec`) and
 * linux (`bwrap`) backends are implemented. On every other platform — win32
 * in particular, which has no equivalent OS-level filesystem confinement
 * primitive available to reach for here — and on darwin/linux when the
 * sandboxing binary itself is missing, the command runs unsandboxed and
 * {@link SandboxInvocation.unavailableNote} says so explicitly rather than
 * silently claiming a confinement that was never enforced (see
 * {@link SANDBOX_UNAVAILABLE_NOTE} and {@link noSandboxBackendNote}).
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveShell, type ShellSpawnOptions } from "./shell.js";

/** Requested sandbox strength for a `bash` foreground command. */
export type BashSandboxMode = "off" | "workspace-write";

/** Text prepended to the command's output when sandboxing was requested but could not be applied. */
export const SANDBOX_UNAVAILABLE_NOTE = "note: sandbox requested but unavailable on this platform";

/**
 * Explicit no-confinement note for platforms with no sandboxing backend at
 * all — everything except darwin (`sandbox-exec`) and linux (`bwrap`), i.e.
 * win32 in practice. Distinct from {@link SANDBOX_UNAVAILABLE_NOTE} (a
 * supported platform whose sandboxing binary just happens to be missing):
 * here there is no backend to fall back to, ever, so the note says so
 * plainly and names exactly what would have been confined. A user who asks
 * for `"workspace-write"` on Windows must not come away thinking their
 * command ran confined when nothing restricted its writes at all — see D3
 * in the cross-platform plan.
 */
export function noSandboxBackendNote(platform: NodeJS.Platform): string {
  return (
    `note: sandbox requested but Arcturn has no filesystem sandbox backend for "${platform}" ` +
    "(only macOS's sandbox-exec and Linux's bwrap are implemented) — the command below ran " +
    "WITHOUT confinement: nothing restricted its writes to the working directory, the OS temp " +
    "dir, or $HOME/.arcturn, and nothing stopped it writing anywhere else this user can."
  );
}

const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const BWRAP_BINARY = "bwrap";

/** The filesystem roots a `"workspace-write"` sandbox leaves writable. */
export interface SandboxWritableRoots {
  /** The command's working directory. */
  cwd: string;
  /** The OS temp directory (`os.tmpdir()`). */
  tmpDir: string;
  /** The user's home directory; `.arcturn` under it is the writable state dir. */
  homeDir: string;
}

/** Escape a path for embedding as a double-quoted string literal in a `sandbox-exec` profile. */
export function escapeSandboxProfilePath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The three roots a sandbox leaves writable, in a stable order: cwd, temp dir, `$HOME/.arcturn`. */
function writableRootList(roots: SandboxWritableRoots): string[] {
  return [roots.cwd, roots.tmpDir, join(roots.homeDir, ".arcturn")];
}

/**
 * The one path carved back out of `$HOME/.arcturn` — the org memory store.
 *
 * `.arcturn` is writable because a sandboxed step has legitimate state to
 * write there: checkpoints, session logs, the code index. The org memory store
 * is different in kind. Its entries are rendered into a later role's *system
 * prompt* under a header saying an operator approved them, so a step that can
 * write this file can plant standing instructions for every future run — the
 * one thing in that directory whose contents are read back as authority rather
 * than as data.
 *
 * Both backends express "narrow an earlier grant" by ordering, so the carve-out
 * must be emitted *after* the root that covers it: `sandbox-exec` takes the
 * last matching rule, and `bwrap` takes the last bind for a path.
 */
function orgMemoryStore(roots: SandboxWritableRoots): string {
  return join(roots.homeDir, ".arcturn", "org-memory");
}

/**
 * Build a macOS `sandbox-exec` profile that denies all file writes except
 * under `roots`. Network access is untouched by `(allow default)` plus the
 * narrower `(deny file-write*)` — nothing here restricts sockets.
 */
export function buildSandboxExecProfile(roots: SandboxWritableRoots): string {
  const allowLines = writableRootList(roots)
    .map((root) => `(allow file-write* (subpath "${escapeSandboxProfilePath(root)}"))`)
    .join("\n");
  const denyStore = `(deny file-write* (subpath "${escapeSandboxProfilePath(orgMemoryStore(roots))}"))`;
  return ["(version 1)", "(allow default)", "(deny file-write*)", allowLines, denyStore].join("\n");
}

/** Build the argv passed to the `sandbox-exec` binary (after its own name) to run `command` under `profile`. */
export function buildSandboxExecArgv(profile: string, command: string): string[] {
  return ["-p", profile, "/bin/sh", "-c", command];
}

/**
 * Build the argv passed to `bwrap` (after its own name) to run `command`
 * with `/` bound read-only and `roots` bound read-write, network shared.
 */
export function buildBwrapArgv(roots: SandboxWritableRoots, command: string): string[] {
  const args: string[] = ["--ro-bind", "/", "/"];
  for (const root of writableRootList(roots)) {
    args.push("--bind", root, root);
  }
  // `-try` because the store need not exist yet: a plain `--ro-bind` on a
  // missing source aborts the whole sandbox, which would make a fresh machine
  // fail to run any sandboxed command at all.
  const store = orgMemoryStore(roots);
  args.push("--ro-bind-try", store, store);
  args.push("--share-net", "/bin/sh", "-c", command);
  return args;
}

/** Whether `name` resolves to an existing file in any directory of `pathEnv` (a `PATH`-style string). */
export function commandExistsOnPath(
  name: string,
  pathEnv: string,
  existsFn: (path: string) => boolean = existsSync,
): boolean {
  return pathEnv
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .some((dir) => existsFn(join(dir, name)));
}

/**
 * Environment inputs consulted when resolving a sandbox request. Every field
 * defaults to the real environment via {@link defaultSandboxProbe}; tests
 * override individual fields to exercise platforms/binaries not present on
 * the machine actually running the suite.
 */
export interface SandboxProbe {
  platform: NodeJS.Platform;
  /** Checks whether a filesystem path exists, e.g. `/usr/bin/sandbox-exec`. */
  existsSync: (path: string) => boolean;
  /** A `PATH`-style, delimiter-joined string searched for `bwrap`. */
  path: string;
  homeDir: string;
  tmpDir: string;
  /**
   * Resolve symlinks in a writable root before it's embedded in a sandbox
   * profile. This matters in practice: `sandbox-exec` resolves `subpath`
   * against the canonicalized filesystem path, and macOS's `/var` (under
   * which `os.tmpdir()` and `mkdtemp` results live) is itself a symlink to
   * `/private/var` — embedding the literal `/var/...` path makes every
   * write inside it fail. May throw (e.g. `ENOENT`); callers fall back to
   * the original path on failure rather than requiring probes to do so.
   */
  realpathSync: (path: string) => string;
  /**
   * The environment the unsandboxed fallback resolves its shell from —
   * `%ComSpec%` on win32 (see {@link resolveShell}). Optional, and omitting
   * it means the real `process.env`, which is what production wants.
   *
   * It is here so that a test asking "what does win32 do when `%ComSpec%` is
   * unset" can answer with `env: {}` instead of deleting the variable out of
   * the live process. That mattered on Windows itself: the real Windows
   * environment block is case-insensitive, `ComSpec` and `COMSPEC` are one
   * variable there, and a `delete process.env.ComSpec` that only removes the
   * casing it was spelled with leaves the other one standing — so the test
   * that meant "unset" was running against a set variable. It is also plain
   * shared mutable state in a parallel test runner.
   */
  env?: NodeJS.ProcessEnv;
}

/** The real environment: `process.platform`, `node:fs`'s `existsSync`, `process.env.PATH`, etc. */
export function defaultSandboxProbe(): SandboxProbe {
  return {
    platform: process.platform,
    existsSync,
    path: process.env.PATH ?? "",
    homeDir: homedir(),
    tmpDir: tmpdir(),
    realpathSync,
    env: process.env,
  };
}

/** Resolve `path` via `probe.realpathSync`, falling back to `path` itself if resolution throws. */
function resolveRoot(path: string, probe: SandboxProbe): string {
  try {
    return probe.realpathSync(path);
  } catch {
    return path;
  }
}

/** How to spawn a `bash` foreground command once sandboxing has been resolved. */
export interface SandboxInvocation {
  /** The executable to spawn (a bare name is resolved against `PATH`). */
  executable: string;
  /** Arguments passed to `executable`. */
  args: string[];
  /**
   * Extra options that MUST be merged into the eventual `spawn()` call for
   * this invocation to run correctly — spread them, do not drop them:
   * `spawn(invocation.executable, invocation.args, { cwd, ...invocation.spawnOptions })`.
   * Only the unsandboxed fallback ever populates this (currently
   * `windowsVerbatimArguments` on win32, from {@link resolveShell}); the
   * `sandbox-exec`/`bwrap` branches are POSIX-only and need nothing extra.
   */
  spawnOptions: ShellSpawnOptions;
  /** Set when `"workspace-write"` was requested but could not be honored on this platform. */
  unavailableNote?: string;
}

/**
 * The unsandboxed fallback every `resolveSandboxInvocation` call ultimately
 * returns to when there's no sandbox wrapper to apply (`mode: "off"`, or a
 * requested sandbox that couldn't be honored on this platform). Delegates to
 * {@link resolveShell} under the `"posix-sh"` policy — always `/bin/sh` on
 * POSIX, ignoring `$SHELL`, since this runs commands Arcturn/the model wrote
 * rather than ones the user typed — so it hands back a shell that actually
 * exists on `platform` instead of a hardcoded `/bin/sh` that doesn't on
 * win32.
 *
 * @param env - Environment `resolveShell` reads `%ComSpec%` from;
 *   `undefined` means the real `process.env` (see {@link SandboxProbe.env}).
 */
function unsandboxed(
  command: string,
  platform: NodeJS.Platform,
  unavailableNote?: string,
  env?: NodeJS.ProcessEnv,
): SandboxInvocation {
  const shell = resolveShell(platform, env);
  return {
    executable: shell.executable,
    args: shell.args(command),
    spawnOptions: shell.spawnOptions,
    unavailableNote,
  };
}

/**
 * Decide how to invoke `command` given the requested sandbox `mode`.
 *
 * `"off"` always returns a plain unsandboxed invocation (`/bin/sh -c
 * command` on POSIX, `cmd.exe /d /s /c "command"` on win32 — see
 * {@link unsandboxed} and `resolveShell` in `./shell.js`). Any other mode
 * tries the platform-appropriate sandboxing binary (`sandbox-exec` on
 * darwin, `bwrap` on linux) and falls back to that same unsandboxed invocation with
 * {@link SandboxInvocation.unavailableNote} set when the binary is missing
 * ({@link SANDBOX_UNAVAILABLE_NOTE}) or the platform has no supported
 * backend at all ({@link noSandboxBackendNote}) — never silently claiming a
 * confinement that was not applied.
 */
export function resolveSandboxInvocation(
  command: string,
  cwd: string,
  mode: BashSandboxMode,
  probe: SandboxProbe = defaultSandboxProbe(),
): SandboxInvocation {
  if (mode === "off") return unsandboxed(command, probe.platform, undefined, probe.env);

  // Resolve symlinks in each root's *parent* before joining `.arcturn` on: the
  // child needn't exist yet, but its containing directory generally does.
  const roots: SandboxWritableRoots = {
    cwd: resolveRoot(cwd, probe),
    tmpDir: resolveRoot(probe.tmpDir, probe),
    homeDir: resolveRoot(probe.homeDir, probe),
  };

  if (probe.platform === "darwin") {
    if (!probe.existsSync(SANDBOX_EXEC_PATH)) {
      return unsandboxed(command, probe.platform, SANDBOX_UNAVAILABLE_NOTE, probe.env);
    }
    const profile = buildSandboxExecProfile(roots);
    return {
      executable: SANDBOX_EXEC_PATH,
      args: buildSandboxExecArgv(profile, command),
      spawnOptions: {},
    };
  }

  if (probe.platform === "linux") {
    if (!commandExistsOnPath(BWRAP_BINARY, probe.path, probe.existsSync)) {
      return unsandboxed(command, probe.platform, SANDBOX_UNAVAILABLE_NOTE, probe.env);
    }
    return { executable: BWRAP_BINARY, args: buildBwrapArgv(roots, command), spawnOptions: {} };
  }

  // No sandboxing backend exists for this platform at all (win32 today) —
  // say so explicitly rather than reusing the "binary missing" wording,
  // which would wrongly imply a backend exists here in principle.
  return unsandboxed(command, probe.platform, noSandboxBackendNote(probe.platform), probe.env);
}
