/**
 * How the resolved `arcturn` binary is actually handed to `spawn`/`execFile`.
 *
 * `cli-resolve.ts` deliberately finds `arcturn.cmd` first on Windows, because
 * that is the file `npm install -g arcturn` writes that a shell can run. But
 * the extension does not go through a shell: it spawns the path directly, and
 * Node ≥ 20.12 refuses to spawn a `.cmd` or `.bat` without one — `spawn
 * EINVAL`, the CVE-2024-27980 fix. Every start of the sidebar's engine and
 * every `--version` probe failed that way on Windows. This module decides what
 * runs instead.
 *
 * Pure, like `cli-resolve.ts`: the platform, the environment and the "is this
 * a file" question are injected, and Windows paths are read with `win32` from
 * `node:path` rather than the host's, so a Windows decision is testable from a
 * POSIX machine.
 */

import { win32 } from "node:path";

/** How one CLI invocation is handed to `spawn` or `execFile`. */
export interface CliSpawnPlan {
  /** Executable to spawn. */
  executable: string;
  /** Argument vector for {@link CliSpawnPlan.executable}. */
  args: string[];
  /**
   * Options that MUST be merged into the `spawn`/`execFile` call. Dropping
   * `windowsVerbatimArguments` lets libuv re-escape the line, and `cmd.exe`
   * then receives a different command than the one built here.
   */
  spawnOptions: { windowsVerbatimArguments?: boolean };
}

/** Everything {@link resolveCliSpawn} needs from the outside world. */
export interface CliSpawnProbe {
  /** Host platform. Only `win32` ever gets anything but a direct spawn. */
  platform: NodeJS.Platform;
  /** Environment to read `%ComSpec%` from. */
  env: Record<string, string | undefined>;
  /** Returns true when the candidate exists and is a regular file. */
  isFile: (candidate: string) => boolean;
}

/** Windows scripts `CreateProcess` cannot execute, and Node will not try to. */
const WINDOWS_SCRIPT_EXTENSIONS: readonly string[] = [".cmd", ".bat"];

/**
 * Quote one argument inside a `cmd /d /s /c "<line>"` command line.
 *
 * `/s` strips exactly the outer quote pair and leaves inner quotes alone, so
 * an argument that carries its own quotes — `C:\Program Files\…\arcturn.cmd`,
 * a workspace with a space in it — survives verbatim. The same rule
 * `packages/cli/src/lsp/client.ts` applies to npm-installed language servers.
 */
function quoteForCmdLine(argument: string): string {
  return /[\s&|<>^]/.test(argument) ? `"${argument}"` : argument;
}

/**
 * Windows env names are case-insensitive, and a JS object is not. `ComSpec`
 * is how Windows spells it; `COMSPEC` and `comspec` both turn up in practice.
 */
function readComSpec(env: Record<string, string | undefined>): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "comspec" && value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * Decide how to run `command args…` on the probe's platform.
 *
 * Everything that is not a Windows batch script is spawned directly — no
 * shell, no quoting, no interpretation of the argv. A batch script gets one of
 * two treatments, in this order:
 *
 * 1. **The npm shim's own entry, under node.** The `arcturn.cmd` npm writes
 *    does exactly one thing: `"%_prog%" "%dp0%\node_modules\arcturn\dist\main.js" %*`,
 *    with `_prog` the `node.exe` beside the shim when there is one and `node`
 *    otherwise. When that layout is beside the `.cmd`, the extension runs the
 *    same thing itself. For `arcturn serve` this is not a nicety: the child
 *    the supervisor holds must be the server. Behind a `cmd.exe`, `kill()`
 *    ends the shell and not its child — Windows has no process-group signal
 *    to cascade — so every reconnect would orphan an engine still holding its
 *    port.
 * 2. **`%ComSpec% /d /s /c "<line>"`.** For a `.cmd` that is not the npm
 *    layout — a hand-rolled wrapper someone pointed `arcturn.cliPath` at. It
 *    runs, which is the point; it carries the orphan caveat above, which is
 *    why it is the fallback and not the rule.
 *
 * @param command - The resolved CLI path, from `cli-resolve.ts`.
 * @param args - Arguments for the CLI itself (`serve …`, `--version`).
 * @throws {Error} When the `cmd.exe` fallback would need an argument containing
 *   `"`, `%` or a newline, which quoting cannot protect.
 * @param probe - Platform, environment and file check. See {@link CliSpawnProbe}.
 */
export function resolveCliSpawn(
  command: string,
  args: readonly string[],
  probe: CliSpawnProbe,
): CliSpawnPlan {
  const direct: CliSpawnPlan = { executable: command, args: [...args], spawnOptions: {} };
  if (probe.platform !== "win32") return direct;
  if (!WINDOWS_SCRIPT_EXTENSIONS.includes(win32.extname(command).toLowerCase())) return direct;

  const dir = win32.dirname(command);
  const main = win32.join(dir, "node_modules", "arcturn", "dist", "main.js");
  if (probe.isFile(main)) {
    const bundledNode = win32.join(dir, "node.exe");
    return {
      executable: probe.isFile(bundledNode) ? bundledNode : "node",
      args: [main, ...args],
      spawnOptions: {},
    };
  }

  // Quoting cannot make these safe: `"` ends the quoted span (`x"&calc&"`
  // would run calc) and `%VAR%` expands even inside quotes. Windows paths
  // cannot contain `"`, so a hit is an argument like `--model` from a setting.
  for (const part of [command, ...args]) {
    if (/["%\r\n]/.test(part)) {
      throw new Error(
        `Refusing to pass ${JSON.stringify(part)} through cmd.exe: it contains a quote, a percent sign or a newline. Point arcturn.cliPath at npm's arcturn.cmd or an .exe.`,
      );
    }
  }
  const line = [command, ...args].map(quoteForCmdLine).join(" ");
  return {
    executable: readComSpec(probe.env) ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    spawnOptions: { windowsVerbatimArguments: true },
  };
}
