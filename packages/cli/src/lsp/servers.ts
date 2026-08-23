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

const binaryExistsCache = new Map<string, boolean>();

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

/** Whether `name` resolves to an executable file somewhere on `PATH`. Cached. */
function binaryExists(name: string): boolean {
  const cached = binaryExistsCache.get(name);
  if (cached !== undefined) return cached;

  let found = false;
  for (const dir of pathDirs()) {
    for (const candidate of candidateNames(name)) {
      try {
        accessSync(join(dir, candidate), constants.X_OK);
        found = true;
        break;
      } catch {
        // Not here; keep looking.
      }
    }
    if (found) break;
  }
  binaryExistsCache.set(name, found);
  return found;
}

/**
 * Resolve the language server command for `path`, by extension.
 *
 * @param path - Any path (absolute or relative); only its extension is used.
 * @returns The `argv` to spawn, or `undefined` when the extension is unknown
 *   or its server's binary is not on `PATH`.
 */
export function serverFor(path: string): readonly string[] | undefined {
  const ext = extname(path).toLowerCase();
  for (const entry of LSP_SERVER_REGISTRY) {
    if (entry.extensions.includes(ext) && binaryExists(entry.command[0] as string)) {
      return entry.command;
    }
  }
  return undefined;
}

/** Clear the cached `PATH` lookups. Exposed for tests that manipulate `PATH`. */
export function clearServerExistsCache(): void {
  binaryExistsCache.clear();
}
