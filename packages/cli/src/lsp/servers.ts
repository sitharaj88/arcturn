/**
 * Registry mapping a source file's extension to the language server command
 * that speaks LSP for it.
 *
 * A server only gets used when its binary is actually resolvable on `PATH` —
 * there is no bundled server, so a missing binary means diagnostics are
 * silently unavailable for that language rather than a hard failure.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, extname, join } from "node:path";

/** One extension-to-command mapping. */
export interface LspServerEntry {
  /** Lower-case extensions (with leading dot) this entry covers. */
  extensions: readonly string[];
  /** `argv` to spawn the server, e.g. `["typescript-language-server", "--stdio"]`. */
  command: readonly string[];
}

/** Built-in extension → language server command registry. */
export const LSP_SERVER_REGISTRY: readonly LspServerEntry[] = [
  {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    command: ["typescript-language-server", "--stdio"],
  },
  { extensions: [".py"], command: ["pyright-langserver", "--stdio"] },
  { extensions: [".go"], command: ["gopls"] },
  { extensions: [".rs"], command: ["rust-analyzer"] },
];

const resolvedBinaryCache = new Map<string, string | undefined>();

/** Directories to try candidate names in, from `PATH`. */
function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
}

/** Candidate filenames for `name` on this platform (handles Windows `PATHEXT`). */
function candidateNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter((ext) => ext.length > 0);
  return [name, ...exts.map((ext) => `${name}${ext}`)];
}

/**
 * The file `name` resolves to on `PATH`, or `undefined`. Cached.
 *
 * The resolved *path* is what callers get, not a yes/no: on Windows the
 * winning candidate may be `<name>.cmd` (npm installs every JS language
 * server as a `.cmd` shim), and how a command is spawned depends on which
 * one it turned out to be — see `resolveLspSpawn` in `./client.ts`.
 */
function resolveBinary(name: string): string | undefined {
  if (resolvedBinaryCache.has(name)) return resolvedBinaryCache.get(name);

  let found: string | undefined;
  for (const dir of pathDirs()) {
    for (const candidate of candidateNames(name)) {
      const full = join(dir, candidate);
      try {
        accessSync(full, constants.X_OK);
        found = full;
        break;
      } catch {
        // Not here; keep looking.
      }
    }
    if (found) break;
  }
  resolvedBinaryCache.set(name, found);
  return found;
}

/**
 * Resolve the language server command for `path`, by extension.
 *
 * @param path - Any path (absolute or relative); only its extension is used.
 * @returns The `argv` to spawn with `argv[0]` resolved to the file that was
 *   actually found on `PATH`, or `undefined` when the extension is unknown or
 *   its server's binary is not on `PATH`.
 */
export function serverFor(path: string): readonly string[] | undefined {
  const ext = extname(path).toLowerCase();
  for (const entry of LSP_SERVER_REGISTRY) {
    if (!entry.extensions.includes(ext)) continue;
    const resolved = resolveBinary(entry.command[0] as string);
    if (resolved) return [resolved, ...entry.command.slice(1)];
  }
  return undefined;
}

/** Clear the cached `PATH` lookups. Exposed for tests that manipulate `PATH`. */
export function clearServerExistsCache(): void {
  resolvedBinaryCache.clear();
}
