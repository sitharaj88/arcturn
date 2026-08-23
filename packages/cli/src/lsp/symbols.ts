/**
 * The `symbols` tool: a structural map of code via the language servers Arcturn
 * already spawns for diagnostics — document symbols for one file (classes,
 * functions, methods, ...), or a workspace-wide symbol search by name.
 *
 * This sits *beside* {@link "./client.js" | client.ts} and
 * {@link "./manager.js" | manager.ts} rather than on top of their exported
 * surface, because neither exposes what symbol requests need:
 *
 * - `client.ts`'s `LspClient` only exposes `didOpen`/`didChange`/
 *   `waitForDiagnostics`/`dispose`. Internally it already has a generic
 *   `sendRequest(method, params, timeoutMs)` used for `initialize` and
 *   `shutdown`, but that is not part of the returned object.
 * - `manager.ts`'s `LspManager` only exposes `diagnosticsFor`/`dispose`; the
 *   per-command client cache (`clientFor`) is a private closure.
 *
 * Rather than edit those files, this module is written against two small
 * interfaces it defines itself — {@link SymbolCapableClient} and
 * {@link SymbolCapableManager} — which describe exactly the capability this
 * feature needs. That keeps this file fully unit-testable with fakes and
 * spawns nothing real. Wiring it up for real (so `LspManager` actually
 * satisfies `SymbolCapableManager`) needs a small, additive change to
 * `client.ts`/`manager.ts`; see `INTEGRATION-symbols.md` at the repo root
 * for the exact shape of that change.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePath } from "@arcturn/tools";
import type { Tool, ToolResult } from "@arcturn/types";

/** Default budget for one document- or workspace-symbol request. */
export const DEFAULT_SYMBOLS_TIMEOUT_MS = 3000;

/** Maximum symbol lines rendered before collapsing the rest into a count. */
const MAX_FORMATTED_SYMBOLS = 50;

/**
 * The slice of a live LSP connection this feature needs: the ability to
 * issue an arbitrary JSON-RPC request and await its result.
 *
 * `client.ts`'s `spawnLspClient` already builds a `sendRequest` closure with
 * exactly this shape internally (used for `initialize`/`shutdown`); it just
 * is not attached to the object it returns. See `INTEGRATION-symbols.md`.
 */
export interface SymbolCapableClient {
  /**
   * Send a JSON-RPC request and resolve with its `result`, or reject if the
   * server responds with an error, the connection closes, or (per the
   * concrete implementation) a timeout elapses.
   */
  request(method: string, params: unknown): Promise<unknown>;
}

/**
 * The slice of an `LspManager`-like object this feature needs: a way to
 * reach the {@link SymbolCapableClient} that handles one file, and a way to
 * reach every client currently active (spawned and initialized this
 * session) for a workspace-wide search.
 */
export interface SymbolCapableManager {
  /**
   * Resolve the client that handles `absPath`, spawning it if needed and
   * ensuring the document is open (or up to date, if already open) with
   * `contents` — mirroring what `LspManager.diagnosticsFor` does internally
   * before waiting on diagnostics. Resolves `null` when there is no server
   * for this extension or it failed to spawn/initialize.
   */
  clientFor(absPath: string, contents: string): Promise<SymbolCapableClient | null>;
  /**
   * Every client currently active for this manager (i.e. already spawned
   * because some file was opened this session). Used for `workspace/symbol`
   * searches, which are not tied to one file. May be empty.
   */
  activeClients(): Promise<SymbolCapableClient[]>;
}

/** One symbol in a structural map: a name, its kind, and where it lives. */
export interface SymbolInfo {
  name: string;
  /** Readable LSP `SymbolKind`, e.g. `"class"`, `"function"`, `"method"`. */
  kind: string;
  /** Absolute filesystem path the symbol was found in. */
  path: string;
  /** One-based line number. */
  line: number;
}

/** LSP `SymbolKind` (1-26) to a lowercase, readable name. */
const SYMBOL_KIND_NAMES: Readonly<Record<number, string>> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enummember",
  23: "struct",
  24: "event",
  25: "operator",
  26: "typeparameter",
};

/** Map a raw LSP `SymbolKind` number to a readable name, falling back to `"symbol"`. */
function symbolKindName(kind: unknown): string {
  return (typeof kind === "number" && SYMBOL_KIND_NAMES[kind]) || "symbol";
}

/** Best-effort `file://` URI to filesystem path, or `undefined` if unparsable. */
function filePathFromUri(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

interface RawPosition {
  line: number;
}

interface RawRange {
  start: RawPosition;
}

/** Shape of one entry in a hierarchical `textDocument/documentSymbol` response. */
interface RawDocumentSymbol {
  name: string;
  kind: number;
  range: RawRange;
  children?: RawDocumentSymbol[];
}

/** Shape of one entry in a flat `SymbolInformation[]` response (either request can return this). */
interface RawSymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: RawRange };
}

function isRawSymbolInformation(value: unknown): value is RawSymbolInformation {
  return (
    typeof value === "object" &&
    value !== null &&
    "location" in value &&
    typeof (value as { location: unknown }).location === "object"
  );
}

function isRawDocumentSymbol(value: unknown): value is RawDocumentSymbol {
  return (
    typeof value === "object" &&
    value !== null &&
    "range" in value &&
    typeof (value as { range: unknown }).range === "object"
  );
}

/** Recursively flatten a `DocumentSymbol` tree (with nested `children`) into a flat list. */
function flattenDocumentSymbols(items: readonly RawDocumentSymbol[], path: string): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  for (const item of items) {
    out.push({
      name: item.name,
      kind: symbolKindName(item.kind),
      path,
      line: item.range.start.line + 1,
    });
    if (item.children && item.children.length > 0) {
      out.push(...flattenDocumentSymbols(item.children, path));
    }
  }
  return out;
}

/**
 * Parse a `textDocument/documentSymbol` response, which per the LSP spec may
 * be either `DocumentSymbol[]` (hierarchical) or `SymbolInformation[]`
 * (flat) — server-dependent. Unrecognized shapes parse to an empty list
 * rather than throwing.
 */
function parseDocumentSymbolResult(result: unknown, fallbackPath: string): SymbolInfo[] {
  if (!Array.isArray(result) || result.length === 0) return [];
  const [first] = result;
  if (isRawSymbolInformation(first)) {
    return (result as RawSymbolInformation[]).flatMap((item) =>
      isRawSymbolInformation(item)
        ? [
            {
              name: item.name,
              kind: symbolKindName(item.kind),
              path: filePathFromUri(item.location.uri) ?? fallbackPath,
              line: item.location.range.start.line + 1,
            },
          ]
        : [],
    );
  }
  if (isRawDocumentSymbol(first)) {
    return flattenDocumentSymbols(result as RawDocumentSymbol[], fallbackPath);
  }
  return [];
}

/**
 * Parse a `workspace/symbol` response (`SymbolInformation[]`, or the newer
 * `WorkspaceSymbol[]` — both carry `name`, `kind`, and a `location` with a
 * `uri`). Entries missing a resolvable file path are dropped.
 */
function parseWorkspaceSymbolResult(result: unknown): SymbolInfo[] {
  if (!Array.isArray(result)) return [];
  const out: SymbolInfo[] = [];
  for (const raw of result) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as { name?: unknown; kind?: unknown; location?: unknown };
    if (typeof item.name !== "string") continue;
    const location = item.location as { uri?: unknown; range?: unknown } | undefined;
    const path = filePathFromUri(location?.uri);
    if (!path) continue;
    const range = location?.range as RawRange | undefined;
    const line = range && typeof range.start?.line === "number" ? range.start.line + 1 : 1;
    out.push({ name: item.name, kind: symbolKindName(item.kind), path, line });
  }
  return out;
}

const TIMED_OUT = Symbol("symbols-request-timed-out");

/** Race `promise` against a timeout; never rejects, resolving the {@link TIMED_OUT} sentinel instead. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

/**
 * Document symbols for `absPath`'s current `contents`, via whichever server
 * handles its extension.
 *
 * @returns `null` when there is no server for this extension, it failed to
 *   spawn, or the request did not complete within `timeoutMs` — never
 *   throws. An empty array means the server answered with no symbols.
 */
export async function documentSymbols(
  manager: SymbolCapableManager,
  absPath: string,
  contents: string,
  timeoutMs: number = DEFAULT_SYMBOLS_TIMEOUT_MS,
): Promise<SymbolInfo[] | null> {
  let client: SymbolCapableClient | null;
  try {
    client = await manager.clientFor(absPath, contents);
  } catch {
    client = null;
  }
  if (!client) return null;

  const uri = pathToFileURL(absPath).toString();
  const outcome = await withTimeout(
    client.request("textDocument/documentSymbol", { textDocument: { uri } }),
    timeoutMs,
  );
  if (outcome === TIMED_OUT) return null;
  return parseDocumentSymbolResult(outcome, absPath);
}

/**
 * Workspace-wide symbol search for `query`, fanned out to every currently
 * active language server client (i.e. ones already spawned this session by
 * touching a file of that language).
 *
 * @returns `null` when no server is active, or every active server timed
 *   out/errored — never throws. An empty array means at least one server
 *   answered but found no matches.
 */
export async function workspaceSymbols(
  manager: SymbolCapableManager,
  query: string,
  timeoutMs: number = DEFAULT_SYMBOLS_TIMEOUT_MS,
): Promise<SymbolInfo[] | null> {
  let clients: SymbolCapableClient[];
  try {
    clients = await manager.activeClients();
  } catch {
    clients = [];
  }
  if (clients.length === 0) return null;

  const outcomes = await Promise.all(
    clients.map((client) => withTimeout(client.request("workspace/symbol", { query }), timeoutMs)),
  );
  const successful = outcomes.filter((outcome) => outcome !== TIMED_OUT);
  if (successful.length === 0) return null;

  return successful.flatMap((outcome) => parseWorkspaceSymbolResult(outcome));
}

/**
 * Render symbols as compact `kind name  path:line` lines, capped at
 * {@link MAX_FORMATTED_SYMBOLS} with a trailing `"… N more"`.
 */
export function formatSymbols(symbols: readonly SymbolInfo[]): string {
  if (symbols.length === 0) return "No symbols found.";
  const shown = symbols
    .slice(0, MAX_FORMATTED_SYMBOLS)
    .map((symbol) => `${symbol.kind} ${symbol.name}  ${symbol.path}:${symbol.line}`);
  const remaining = symbols.length - shown.length;
  if (remaining > 0) shown.push(`… ${remaining} more`);
  return shown.join("\n");
}

// Local mirrors of `@arcturn/tools`'s result-utils.ts shapes: that
// module is not part of the `@arcturn/tools` package's public export
// surface (only reachable within the `tools` package itself), so this file
// builds the same `ToolResult` shapes directly instead of importing it.

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Create the `symbols` tool. Read-only (no permission required). */
export function createSymbolsTool(manager: SymbolCapableManager): Tool {
  return {
    definition: {
      name: "symbols",
      description:
        "Structural map of code via the language server: document symbols for one file (classes, " +
        "functions, methods, variables, ...), or a workspace-wide symbol search by name. Provide " +
        "exactly one of `file` or `query`. Read-only; returns null/empty gracefully if no language " +
        "server is available for the relevant language.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description:
              "Path (absolute, or relative to the working directory) to list document symbols for.",
          },
          query: {
            type: "string",
            description: "Name (or substring) to search for across the workspace's symbols.",
          },
        },
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted)
        return errorResult("Aborted: the operation was cancelled before it completed.");

      const file = typeof input.file === "string" && input.file.length > 0 ? input.file : undefined;
      const query =
        typeof input.query === "string" && input.query.length > 0 ? input.query : undefined;

      if (file && query) {
        return errorResult("Provide only one of `file` or `query`, not both.");
      }
      if (!file && !query) {
        return errorResult(
          "Provide either `file` (document symbols) or `query` (workspace search).",
        );
      }

      if (file) {
        let absPath: string;
        try {
          absPath = resolvePath(ctx.cwd, file);
        } catch (error) {
          return errorResult(`Invalid path "${file}": ${(error as Error).message}`);
        }

        let contents: string;
        try {
          contents = await readFile(absPath, "utf8");
        } catch (error) {
          return errorResult(`Could not read "${file}": ${(error as Error).message}`);
        }
        if (ctx.signal.aborted) {
          return errorResult("Aborted: the operation was cancelled before it completed.");
        }

        const symbols = await documentSymbols(manager, absPath, contents);
        if (symbols === null) {
          return textResult("No language server available (or it timed out) for this file.");
        }
        return textResult(formatSymbols(symbols), { symbolCount: symbols.length, mode: "file" });
      }

      // `query` is guaranteed defined here (exactly one of file/query is required above).
      const symbols = await workspaceSymbols(manager, query as string);
      if (symbols === null) {
        return textResult("No language server available (or it timed out) for a workspace search.");
      }
      return textResult(formatSymbols(symbols), { symbolCount: symbols.length, mode: "query" });
    },
  };
}
