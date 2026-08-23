/**
 * A minimal, hand-rolled JSON-RPC client for the Language Server Protocol.
 *
 * Only what the LSP diagnostics feature needs is implemented: the
 * `initialize`/`initialized` handshake, `textDocument/didOpen` and
 * `textDocument/didChange` notifications, collecting `publishDiagnostics`,
 * and a `shutdown`/`exit` teardown. There is no LSP SDK dependency — message
 * framing (`Content-Length: <n>\r\n\r\n<body>`) is parsed and written by hand.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { basename, win32 } from "node:path";
import { resolveShell } from "@arcturn/tools";
import { packageInfo } from "../meta.js";

/** One LSP `Range` position (zero-based, matching the protocol). */
export interface Position {
  line: number;
  character: number;
}

/** One LSP `Range`. */
export interface Range {
  start: Position;
  end: Position;
}

/** One LSP `Diagnostic`, trimmed to the fields this feature reads. */
export interface Diagnostic {
  range: Range;
  /** `1` = error, `2` = warning, `3` = information, `4` = hint. */
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

/**
 * Incrementally decode a byte stream of `Content-Length` framed JSON-RPC
 * messages.
 *
 * Feed it raw chunks as they arrive from a child process's stdout via
 * {@link LspFrameDecoder.push}; it buffers partial frames and returns every
 * message a chunk completes, so it copes equally with a single frame split
 * across many small chunks and many frames coalesced into one chunk.
 */
export class LspFrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Feed a chunk of raw bytes; returns every JSON-RPC message it completed. */
  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerText = this.#buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // Malformed header block: drop it and keep scanning rather than
        // getting stuck forever on bytes we cannot interpret.
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.#buffer.length < bodyEnd) break; // Body not fully arrived yet.

      const bodyText = this.#buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyEnd);
      try {
        messages.push(JSON.parse(bodyText));
      } catch {
        // Unparsable body: drop it, keep the decoder usable for the rest of the stream.
      }
    }

    return messages;
  }
}

/** Encode one JSON-RPC message as a `Content-Length` framed buffer. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  return (
    typeof message === "object" && message !== null && "id" in message && !("method" in message)
  );
}

function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  return (
    typeof message === "object" && message !== null && "method" in message && !("id" in message)
  );
}

/** Options for {@link spawnLspClient}. */
export interface SpawnLspClientOptions {
  /** Working directory the server process is spawned in. */
  cwd: string;
  /** Workspace root handed to the server during `initialize`. */
  rootUri: string;
  /** Milliseconds to wait for the `initialize` response before giving up. Default 5000. */
  initializeTimeoutMs?: number;
}

/** A live connection to one spawned language server. */
export interface LspClient {
  /** Notify the server that a document was opened, with its full text. */
  didOpen(uri: string, languageId: string, text: string): void;
  /** Notify the server of a full-document content replacement. */
  didChange(uri: string, text: string): void;
  /**
   * Wait for the diagnostics published for `uri` since the last
   * `didOpen`/`didChange` call on it. Resolves with `null` (never rejects) if
   * none arrive within `timeoutMs`.
   */
  waitForDiagnostics(uri: string, timeoutMs?: number): Promise<Diagnostic[] | null>;
  /**
   * Issue an arbitrary LSP request and resolve its result.
   *
   * Used by capabilities layered on top of diagnostics (symbol queries, for
   * one). Rejects on a server error response or timeout.
   */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /**
   * Shut the server down gracefully, then kill the process. Safe to call more
   * than once. Resolves only once the process has actually exited (bounded),
   * so the workspace it was spawned in is free to be deleted or reused.
   */
  dispose(): Promise<void>;
  /** Lines captured from the server's stderr, most recent last (capped). */
  readonly stderr: readonly string[];
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_TIMEOUT_MS = 3000;
const MAX_STDERR_LINES = 200;
/** Grace period after `exit` for the server to close on its own before a hard kill. */
const EXIT_GRACE_MS = 300;
/**
 * How long `dispose` waits for a *killed* server to actually be gone before
 * escalating, and again before giving up. Bounded so teardown can never hang.
 */
const KILL_GRACE_MS = 1000;

/**
 * Windows script extensions `CreateProcess` cannot execute: spawning one
 * without a shell fails outright (Node refuses `.bat`/`.cmd` without
 * `shell`/`ComSpec` since the CVE-2024-27980 fix). This is not an edge case
 * for language servers — an npm-installed `typescript-language-server` or
 * `pyright-langserver` *is* a `.cmd` shim on Windows, so without this the
 * whole LSP feature is silently unavailable there.
 */
const WINDOWS_SCRIPT_EXTENSIONS: readonly string[] = [".cmd", ".bat"];

/** How one language server command is actually handed to `spawn`. */
export interface LspSpawnPlan {
  /** Executable to spawn. */
  executable: string;
  /** Argument vector for {@link LspSpawnPlan.executable}. */
  args: string[];
  /**
   * Options that MUST be merged into the `spawn` call — dropping them mangles
   * the command line `cmd.exe` receives. See `ShellSpawnOptions`.
   */
  spawnOptions: { windowsVerbatimArguments?: boolean };
}

/**
 * Quote one argument inside a `cmd /d /s /c "<line>"` command line.
 *
 * `/s` strips exactly the outer quote pair and leaves inner quotes alone, so
 * an argument that carries its own quotes survives verbatim — which is what a
 * server path like `C:\Program Files\nodejs\x.cmd` needs.
 */
function quoteForCmdLine(argument: string): string {
  return /[\s&|<>^]/.test(argument) ? `"${argument}"` : argument;
}

/**
 * Decide how to invoke a language server command on `platform`.
 *
 * Pure: it reads nothing but its arguments, so a Windows invocation is
 * testable from a POSIX machine (the same shape `resolveShell` uses in
 * `@arcturn/tools`). Everything except a Windows batch shim is spawned
 * directly — no shell, no quoting, no interpretation of the argv.
 *
 * @param platform - Target platform; defaults to `process.platform`.
 * @param env - Environment to read `%ComSpec%` from; defaults to `process.env`.
 */
export function resolveLspSpawn(
  command: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): LspSpawnPlan {
  const [bin, ...args] = command;
  if (!bin) throw new Error("resolveLspSpawn: command must have at least one element");
  const direct: LspSpawnPlan = { executable: bin, args: [...args], spawnOptions: {} };
  if (platform !== "win32") return direct;
  // `win32.extname`, not the host's: this must read a Windows path the same
  // way when the decision is simulated from POSIX in a test.
  if (!WINDOWS_SCRIPT_EXTENSIONS.includes(win32.extname(bin).toLowerCase())) return direct;

  const shell = resolveShell(platform, env);
  const line = [bin, ...args].map(quoteForCmdLine).join(" ");
  return { executable: shell.executable, args: shell.args(line), spawnOptions: shell.spawnOptions };
}

/**
 * Spawn a language server and complete the `initialize`/`initialized`
 * handshake.
 *
 * The server's stderr is captured (not inherited), so a chatty server never
 * pollutes the host process's output. Rejects if the process fails to spawn
 * or the handshake does not complete in time; once connected, none of the
 * returned client's methods reject.
 */
export async function spawnLspClient(
  command: readonly string[],
  options: SpawnLspClientOptions,
): Promise<LspClient> {
  if (command.length === 0) {
    throw new Error("spawnLspClient: command must have at least one element");
  }

  const plan = resolveLspSpawn(command);
  const proc: ChildProcessWithoutNullStreams = spawn(plan.executable, plan.args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // A language server is a background process the user never interacts
    // with; without this Windows flashes a console window for every spawn.
    windowsHide: true,
    ...plan.spawnOptions,
  });

  const stderrLines: string[] = [];
  let stderrPartial = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrPartial += chunk.toString("utf8");
    const lines = stderrPartial.split("\n");
    stderrPartial = lines.pop() ?? "";
    for (const line of lines) {
      stderrLines.push(line);
      if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
    }
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const decoder = new LspFrameDecoder();

  // Logical clock: bumped on every didOpen/didChange (records the "mark" a
  // waiter must see diagnostics past) and on every publishDiagnostics
  // received (records how fresh the cached diagnostics for a uri are). Using
  // a counter instead of wall-clock time sidesteps any timing race between a
  // notification landing and waitForDiagnostics being called.
  let clock = 0;
  const lastEditMark = new Map<string, number>();
  const diagnosticsCache = new Map<string, { diagnostics: Diagnostic[]; mark: number }>();
  const waiters = new Map<
    string,
    Array<{
      mark: number;
      resolve: (diagnostics: Diagnostic[] | null) => void;
      timer: NodeJS.Timeout;
    }>
  >();

  let disposed = false;
  let spawnError: Error | undefined;

  proc.on("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
    for (const { reject } of pending.values()) reject(spawnError);
    pending.clear();
  });

  proc.on("close", () => {
    const closeError = new Error("The language server process exited.");
    for (const { reject } of pending.values()) reject(closeError);
    pending.clear();
    for (const list of waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    waiters.clear();
  });

  proc.stdout.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      handleMessage(message);
    }
  });

  function handleMessage(message: unknown): void {
    if (typeof message === "object" && message !== null && "id" in message && "method" in message) {
      // A server-to-client request. Only a few of these are actually
      // implemented; everything else falls back to a `null` result so a
      // well-behaved server never blocks on a reply that never comes.
      const request = message as { id: number; method: string; params?: unknown };
      if (request.method === "workspace/configuration") {
        // Per the 3.17 spec the result MUST be an array the same length as
        // `params.items` (one settings value per requested item) — some
        // servers (gopls, rust-analyzer) index into it positionally and can
        // throw server-side on a bare `null`. This client tracks no
        // configuration, so it answers every item with `null`.
        const params = request.params as { items?: unknown } | undefined;
        const length = Array.isArray(params?.items) ? params.items.length : 0;
        write({ jsonrpc: "2.0", id: request.id, result: Array.from({ length }, () => null) });
        return;
      }
      if (request.method === "window/showMessageRequest") {
        // `MessageActionItem | null` — `null` means the user dismissed the
        // request without choosing an action, which is exactly right here:
        // this client has no UI to show the message in.
        write({ jsonrpc: "2.0", id: request.id, result: null });
        return;
      }
      // `client/registerCapability`, `client/unregisterCapability`, and
      // `window/workDoneProgress/create` are all void-returning requests per
      // the spec, so `null` is the correct (not just a fallback) answer; any
      // other unimplemented request also gets `null` as a best-effort reply.
      write({ jsonrpc: "2.0", id: request.id, result: null });
      return;
    }
    if (isJsonRpcResponse(message)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (isJsonRpcNotification(message) && message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: unknown; diagnostics?: unknown } | undefined;
      const uri = typeof params?.uri === "string" ? params.uri : undefined;
      if (!uri) return;
      const diagnostics = Array.isArray(params?.diagnostics)
        ? (params.diagnostics as Diagnostic[])
        : [];
      clock += 1;
      const mark = clock;
      diagnosticsCache.set(uri, { diagnostics, mark });
      const list = waiters.get(uri);
      if (!list) return;
      const remaining = list.filter((waiter) => {
        if (mark <= waiter.mark) return true;
        clearTimeout(waiter.timer);
        waiter.resolve(diagnostics);
        return false;
      });
      if (remaining.length === 0) waiters.delete(uri);
      else waiters.set(uri, remaining);
    }
  }

  function write(message: unknown): void {
    if (proc.stdin.writable) proc.stdin.write(encodeFrame(message));
  }

  function sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Tell the server to stop working on a request nothing is waiting
        // for any more. This is a notification (fire-and-forget) per spec;
        // the server may or may not honor it, but the client must still
        // drop the pending entry either way.
        sendNotification("$/cancelRequest", { id });
        reject(new Error(`Timed out waiting for response to "${method}"`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      write(request);
    });
  }

  function sendNotification(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    write(notification);
  }

  const initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  const { version: clientVersion } = packageInfo();
  const workspaceFolders = [
    { uri: options.rootUri, name: basename(options.cwd) || options.rootUri },
  ];
  try {
    await sendRequest(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "arcturn", version: clientVersion },
        // `rootUri` is kept for legacy servers that predate workspace
        // folders; `workspaceFolders` is what current servers prefer, and
        // requires the matching `workspace.workspaceFolders` capability
        // below to be advertised as supported.
        rootUri: options.rootUri,
        workspaceFolders,
        capabilities: {
          general: {
            positionEncodings: ["utf-16"],
          },
          workspace: {
            workspaceFolders: true,
            symbol: {},
          },
          textDocument: {
            publishDiagnostics: { relatedInformation: false },
            synchronization: { didSave: false, willSave: false },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
      },
      initializeTimeoutMs,
    );
  } catch (error) {
    // Same discipline as `dispose`: leave nothing running behind a rejected
    // handshake, and let the process go before the caller reacts to it.
    proc.kill();
    await waitForExit(KILL_GRACE_MS);
    throw spawnError ?? error;
  }
  sendNotification("initialized", {});

  function didOpen(uri: string, languageId: string, text: string): void {
    clock += 1;
    lastEditMark.set(uri, clock);
    sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  function didChange(uri: string, text: string): void {
    clock += 1;
    lastEditMark.set(uri, clock);
    sendNotification("textDocument/didChange", {
      textDocument: { uri, version: clock },
      contentChanges: [{ text }],
    });
  }

  function waitForDiagnostics(
    uri: string,
    timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<Diagnostic[] | null> {
    const mark = lastEditMark.get(uri) ?? 0;
    const cached = diagnosticsCache.get(uri);
    if (cached && cached.mark > mark) return Promise.resolve(cached.diagnostics);
    if (disposed) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = waiters.get(uri);
        if (list) {
          const remaining = list.filter((waiter) => waiter.resolve !== resolveWaiter);
          if (remaining.length === 0) waiters.delete(uri);
          else waiters.set(uri, remaining);
        }
        resolve(null);
      }, timeoutMs);
      const resolveWaiter = (diagnostics: Diagnostic[] | null): void => {
        clearTimeout(timer);
        resolve(diagnostics);
      };
      const list = waiters.get(uri) ?? [];
      list.push({ mark, resolve: resolveWaiter, timer });
      waiters.set(uri, list);
    });
  }

  /**
   * Whether the process is really gone.
   *
   * `proc.killed` is deliberately not consulted: it only records that a
   * signal was *delivered*, and flips to `true` the instant `kill()` returns
   * — long before the process is reaped. Treating it as "exited" is what let
   * `dispose()` resolve while the server was still alive, which on Windows
   * leaves the spawn `cwd` locked (a live process's working directory cannot
   * be removed) and fails the very next cleanup with `EBUSY`.
   */
  function hasExited(): boolean {
    return proc.exitCode !== null || proc.signalCode !== null;
  }

  /**
   * Wait for the process to exit on its own, up to `timeoutMs`. Resolves
   * (does not reject) either way — the caller decides what to do if it's
   * still alive when this returns.
   */
  function waitForExit(timeoutMs: number): Promise<void> {
    if (hasExited()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const list of waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    waiters.clear();
    if (!hasExited()) {
      try {
        await sendRequest("shutdown", null, 1000);
        sendNotification("exit");
        // Give the server a moment to actually exit on its own after `exit`
        // before force-killing it — a well-behaved server that exits
        // promptly should never receive a SIGKILL.
        await waitForExit(EXIT_GRACE_MS);
      } catch {
        // The server did not answer shutdown in time; fall through to kill it.
      }
    }
    if (hasExited()) return;

    // Force it down — and do not resolve until it is actually gone. Callers
    // reuse or delete the workspace the moment `dispose()` returns, and a
    // process that has been signalled is not yet a process that has exited.
    proc.kill();
    await waitForExit(KILL_GRACE_MS);
    if (hasExited()) return;
    // Still there: it either ignores SIGTERM or is wedged in uninterruptible
    // work. SIGKILL cannot be caught (and maps to the same unconditional
    // termination on Windows). Bounded again so teardown still finishes.
    proc.kill("SIGKILL");
    await waitForExit(KILL_GRACE_MS);
  }

  return {
    didOpen,
    didChange,
    waitForDiagnostics,
    request: (method, params, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) =>
      sendRequest(method, params, timeoutMs),
    dispose,
    get stderr() {
      return stderrLines;
    },
  };
}
