/**
 * The Agent Client Protocol (ACP) wire layer: a hand-rolled JSON-RPC 2.0
 * peer that speaks over an injected pair of byte streams.
 *
 * ACP is the editor↔agent protocol used by Zed, JetBrains and Neovim — the
 * "LSP moment" for coding agents. This module implements only the transport
 * and dispatch; the arcturn-specific semantics live in `./adapter.ts`.
 *
 * ## Framing
 *
 * Per the ACP transport specification
 * ({@link https://agentclientprotocol.com/protocol/transports}), the stdio
 * transport is **newline-delimited JSON (NDJSON)**, not the `Content-Length`
 * header framing that LSP uses:
 *
 * > "Messages are delimited by newlines (`\n`), and **MUST NOT** contain
 * > embedded newlines."
 *
 * > "The agent **MUST NOT** write anything to its `stdout` that is not a
 * > valid ACP message." … "The agent **MAY** write UTF-8 strings to its
 * > standard error (`stderr`) for logging purposes."
 *
 * This is a deliberate divergence from `../lsp/client.ts`. The incremental
 * buffering discipline of {@link NdjsonFrameDecoder} is copied from that
 * module's proven `LspFrameDecoder` (buffer partial input, drain every
 * complete frame a chunk finishes, never get stuck on undecodable bytes), but
 * the delimiter differs because the protocols differ. A
 * {@link ContentLengthFrameDecoder} is also provided for hosts that insist on
 * LSP-style framing over a custom transport; NDJSON is the default and the
 * only framing the ACP spec defines for stdio.
 */

/** A JSON-RPC 2.0 message id. ACP ids are integers in practice; strings are accepted. */
export type JsonRpcId = string | number;

/** A JSON-RPC 2.0 request: has both `id` and `method`, and expects a response. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A JSON-RPC 2.0 notification: has `method` but no `id`, and expects no response. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** A JSON-RPC 2.0 error object. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC 2.0 response: has `id` and exactly one of `result` / `error`. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

/** Any message that can cross the wire. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Standard JSON-RPC 2.0 error codes, as referenced by the ACP schema. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/**
 * An error carrying an explicit JSON-RPC code, so a handler can choose the
 * code the peer sees instead of always collapsing to `internalError`.
 */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }

  /** A `-32601 Method not found` error for an unregistered method. */
  static methodNotFound(method: string): AcpError {
    return new AcpError(JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  }

  /** A `-32602 Invalid params` error. */
  static invalidParams(message: string): AcpError {
    return new AcpError(JSON_RPC_ERRORS.invalidParams, message);
  }
}

/**
 * Incrementally decode a byte stream of newline-delimited JSON messages.
 *
 * Feed it raw chunks via {@link NdjsonFrameDecoder.push}; it buffers partial
 * lines and returns every message a chunk completes, so it copes equally with
 * one message split across many small chunks and many messages coalesced into
 * one chunk. Blank lines are skipped and unparsable lines are dropped, so a
 * malformed frame never wedges the rest of the stream.
 */
export class NdjsonFrameDecoder {
  #buffer = "";

  /** Feed a chunk of raw bytes; returns every JSON-RPC message it completed. */
  push(chunk: Buffer | string): unknown[] {
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const messages: unknown[] = [];

    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;

      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;

      try {
        messages.push(JSON.parse(line));
      } catch {
        // Unparsable line: drop it and keep decoding the rest of the stream.
      }
    }

    return messages;
  }
}

/**
 * Incrementally decode `Content-Length: <n>\r\n\r\n<body>` framed messages.
 *
 * Mirrors `LspFrameDecoder` from `../lsp/client.ts`. ACP's stdio transport does
 * **not** use this framing; it exists for hosts bridging ACP over a custom
 * LSP-style transport, selectable via {@link AcpConnectionOptions.framing}.
 */
export class ContentLengthFrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Feed a chunk of raw bytes; returns every JSON-RPC message it completed. */
  push(chunk: Buffer | string): unknown[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);
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
        // Unparsable body: drop it, keep the decoder usable for the rest.
      }
    }

    return messages;
  }
}

/** How messages are delimited on the wire. `ndjson` is ACP's stdio framing. */
export type AcpFraming = "ndjson" | "content-length";

/**
 * Encode one JSON-RPC message as NDJSON.
 *
 * `JSON.stringify` escapes literal newlines inside strings, so the single
 * trailing `\n` is always the only newline in the frame — which is exactly
 * what the spec's "MUST NOT contain embedded newlines" requires.
 */
export function encodeNdjson(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

/** Encode one JSON-RPC message as a `Content-Length` framed buffer. */
export function encodeContentLength(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

/** Handles one inbound request method and resolves the value sent back as `result`. */
export type AcpRequestHandler = (params: unknown, id: JsonRpcId) => Promise<unknown> | unknown;

/** Handles one inbound notification method. Any thrown error is reported, not sent. */
export type AcpNotificationHandler = (params: unknown) => Promise<void> | void;

/** Options for {@link AcpConnection}. */
export interface AcpConnectionOptions {
  /** Stream inbound messages are read from (an agent passes `process.stdin`). */
  input: NodeJS.ReadableStream;
  /** Stream outbound messages are written to (an agent passes `process.stdout`). */
  output: NodeJS.WritableStream;
  /** Wire framing. Defaults to `ndjson`, the framing ACP specifies for stdio. */
  framing?: AcpFraming;
  /**
   * Reports errors that have nowhere else to go — a notification handler that
   * threw, or an unmatched response. Defaults to a no-op; an agent should
   * point this at `stderr`, never `stdout`, which is reserved for protocol
   * messages.
   */
  onError?: (error: Error) => void;
}

/** A pending outbound request awaiting its response. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * A bidirectional JSON-RPC 2.0 peer over injected streams.
 *
 * Inbound requests are dispatched to handlers registered with
 * {@link AcpConnection.onRequest} and answered automatically (including error
 * responses when a handler throws or no handler exists). Inbound notifications
 * go to {@link AcpConnection.onNotification} handlers. Outbound traffic uses
 * {@link AcpConnection.sendRequest} and {@link AcpConnection.sendNotification}.
 *
 * Nothing here knows about ACP semantics, which keeps it testable over a pair
 * of in-memory duplex streams.
 */
export class AcpConnection {
  readonly #output: NodeJS.WritableStream;
  readonly #input: NodeJS.ReadableStream;
  readonly #framing: AcpFraming;
  readonly #onError: (error: Error) => void;
  readonly #decoder: NdjsonFrameDecoder | ContentLengthFrameDecoder;
  readonly #requestHandlers = new Map<string, AcpRequestHandler>();
  readonly #notificationHandlers = new Map<string, AcpNotificationHandler>();
  readonly #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #listening = false;
  #disposed = false;

  constructor(options: AcpConnectionOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#framing = options.framing ?? "ndjson";
    this.#onError = options.onError ?? (() => {});
    this.#decoder =
      this.#framing === "content-length"
        ? new ContentLengthFrameDecoder()
        : new NdjsonFrameDecoder();
  }

  /** Register the handler for one inbound request method. Replaces any prior handler. */
  onRequest(method: string, handler: AcpRequestHandler): void {
    this.#requestHandlers.set(method, handler);
  }

  /** Register the handler for one inbound notification method. Replaces any prior handler. */
  onNotification(method: string, handler: AcpNotificationHandler): void {
    this.#notificationHandlers.set(method, handler);
  }

  /** Whether a request handler is registered for `method`. */
  handles(method: string): boolean {
    return this.#requestHandlers.has(method) || this.#notificationHandlers.has(method);
  }

  /** Begin reading the input stream. Safe to call more than once. */
  listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    this.#input.on("data", (chunk: Buffer | string) => {
      for (const message of this.#decoder.push(chunk)) this.#dispatch(message);
    });
    this.#input.on("end", () => this.dispose(new Error("The ACP input stream ended.")));
  }

  /** Send a notification. Never waits for anything. */
  sendNotification(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.#write(notification);
  }

  /**
   * Send a request and resolve its `result`.
   *
   * Rejects with the peer's error message on an error response, or if the
   * connection is disposed while the request is still in flight. There is no
   * built-in timeout: ACP requests such as `session/request_permission` block
   * on a human and may legitimately take minutes.
   */
  sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new Error("The ACP connection is closed."));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(String(id), { resolve, reject });
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.#write(request);
    });
  }

  /** Reject every in-flight outbound request and stop accepting new ones. */
  dispose(reason?: Error): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = reason ?? new Error("The ACP connection was closed.");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #write(message: JsonRpcMessage): void {
    if (this.#disposed) return;
    const frame =
      this.#framing === "content-length" ? encodeContentLength(message) : encodeNdjson(message);
    this.#output.write(frame);
  }

  #dispatch(message: unknown): void {
    if (!isRecord(message)) {
      this.#onError(new Error("Received a non-object JSON-RPC message."));
      return;
    }

    const hasId = "id" in message && message.id !== null && message.id !== undefined;
    const method = typeof message.method === "string" ? message.method : undefined;

    if (method !== undefined && hasId) {
      void this.#handleRequest(message.id as JsonRpcId, method, message.params);
      return;
    }
    if (method !== undefined) {
      void this.#handleNotification(method, message.params);
      return;
    }
    if (hasId) {
      this.#handleResponse(message as unknown as JsonRpcResponse);
      return;
    }
    this.#onError(new Error("Received a JSON-RPC message with neither method nor id."));
  }

  async #handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#requestHandlers.get(method);
    if (!handler) {
      this.#respondError(id, AcpError.methodNotFound(method));
      return;
    }
    try {
      const result = await handler(params, id);
      this.#write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (raw) {
      this.#respondError(id, toError(raw));
    }
  }

  async #handleNotification(method: string, params: unknown): Promise<void> {
    const handler = this.#notificationHandlers.get(method);
    // Unknown notifications are ignored by design: JSON-RPC forbids replying
    // to them, and ACP peers may send updates a given version does not know.
    if (!handler) return;
    try {
      await handler(params);
    } catch (raw) {
      this.#onError(toError(raw));
    }
  }

  #handleResponse(message: JsonRpcResponse): void {
    const pending = this.#pending.get(String(message.id));
    if (!pending) {
      this.#onError(new Error(`Received a response for unknown request id ${String(message.id)}.`));
      return;
    }
    this.#pending.delete(String(message.id));
    if (message.error) {
      pending.reject(new AcpError(message.error.code, message.error.message, message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  #respondError(id: JsonRpcId, error: Error): void {
    const code = error instanceof AcpError ? error.code : JSON_RPC_ERRORS.internalError;
    const payload: JsonRpcError = { code, message: error.message };
    if (error instanceof AcpError && error.data !== undefined) payload.data = error.data;
    this.#write({ jsonrpc: "2.0", id, error: payload });
  }
}
