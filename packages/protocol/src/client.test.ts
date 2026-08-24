import { describe, expect, it, vi } from "vitest";
import {
  ClientErrorCode,
  createProtocolClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type ProtocolClientError,
  ProtocolClosedError,
  ProtocolRequestError,
  ProtocolTimeoutError,
  ProtocolVersionMismatchError,
  type WebSocketLike,
} from "./client.js";
import { ErrorCode } from "./messages.js";

// ---------------------------------------------------------------------------
// In-memory fake socket (no real network anywhere in this file)
// ---------------------------------------------------------------------------

type AnyListener = (...args: unknown[]) => void;

interface Frame {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

class FakeSocket implements WebSocketLike {
  /** Raw text frames handed to `send`, in order. */
  readonly sent: string[] = [];
  closeCalls = 0;
  readyState: number | undefined;
  readonly #handlers = new Map<string, AnyListener[]>();

  constructor(readyState?: number) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  // Overloads mirror `WebSocketLike` exactly, so `implements WebSocketLike`
  // proves the fake is a faithful stand-in rather than a looser shape.
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "open", listener: () => void): void;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: string, listener: unknown): void {
    const handler = listener as AnyListener;
    const existing = this.#handlers.get(event);
    if (existing) existing.push(handler);
    else this.#handlers.set(event, [handler]);
  }

  // --- test-side drivers ---------------------------------------------------

  /** Deliver an inbound message; objects are JSON-encoded, strings sent raw. */
  emit(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.#fire("message", data);
  }

  /** Deliver an inbound message as a raw payload type (Buffer, ArrayBuffer, …). */
  emitRaw(data: unknown): void {
    this.#fire("message", data);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.#fire("open");
  }

  emitClose(code?: number): void {
    this.readyState = 3;
    this.#fire("close", code);
  }

  emitError(error: unknown): void {
    this.#fire("error", error);
  }

  /** Every frame sent so far, parsed. */
  frames(): Frame[] {
    return this.sent.map((text) => JSON.parse(text) as Frame);
  }

  frame(index: number): Frame {
    const frame = this.frames()[index];
    if (!frame) throw new Error(`No frame at index ${index} (sent ${this.sent.length})`);
    return frame;
  }

  /** Answer the frame at `index` with a success response. */
  respondOk(index: number, result: unknown): void {
    this.emit({ kind: "response", id: this.frame(index).id, result });
  }

  /** Answer the frame at `index` with an error response. */
  respondError(index: number, code: string, message: string): void {
    this.emit({ kind: "response", id: this.frame(index).id, error: { code, message } });
  }

  #fire(event: string, ...args: unknown[]): void {
    for (const listener of this.#handlers.get(event) ?? []) listener(...args);
  }
}

/** Let queued microtasks (and 0ms timers) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Await a promise expected to reject, returning its typed rejection reason. */
async function rejection<T extends ProtocolClientError>(promise: Promise<unknown>): Promise<T> {
  try {
    await promise;
  } catch (error) {
    return error as T;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

const HEADER = { version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1_700_000_000_000 } as const;

function collectErrors(): {
  errors: ProtocolClientError[];
  onProtocolError: (error: ProtocolClientError) => void;
} {
  const errors: ProtocolClientError[] = [];
  return {
    errors,
    onProtocolError: (error: ProtocolClientError) => {
      errors.push(error);
    },
  };
}

// ---------------------------------------------------------------------------

describe("createProtocolClient: request framing", () => {
  it("sends one compact JSON frame per request, with no NDJSON newline", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.prompt("s1", "hello");
    await flush();

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]?.endsWith("\n")).toBe(false);
    expect(socket.frame(0)).toEqual({
      id: expect.any(String),
      method: "prompt",
      params: { sessionId: "s1", text: "hello" },
    });

    socket.respondOk(0, { ok: true });
    await expect(promise).resolves.toBeUndefined();
  });

  it("builds the documented frame for every method", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    void client.listSessions();
    void client.createSession({ cwd: "/repo" });
    void client.createSession({ cwd: "/repo", model: "opus" });
    void client.openSession("s1");
    void client.steer("s1", "wait");
    void client.abort("s1");
    void client.setModel("s1", "haiku");
    void client.respondToPermission("s1", { requestId: "r1", behavior: "allow" });
    void client.listModels();
    await flush();

    expect(
      socket.frames().map((frame) => ({ method: frame.method, params: frame.params })),
    ).toEqual([
      { method: "listSessions", params: undefined },
      { method: "createSession", params: { cwd: "/repo" } },
      { method: "createSession", params: { cwd: "/repo", model: "opus" } },
      { method: "openSession", params: { sessionId: "s1" } },
      { method: "steer", params: { sessionId: "s1", text: "wait" } },
      { method: "abort", params: { sessionId: "s1" } },
      { method: "setModel", params: { sessionId: "s1", model: "haiku" } },
      {
        method: "permissionDecision",
        params: { sessionId: "s1", decision: { requestId: "r1", behavior: "allow" } },
      },
      { method: "listModels", params: undefined },
    ]);
    // Ids are unique per request.
    const ids = socket.frames().map((frame) => frame.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects an outbound request that fails wire validation without sending it", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    // A caller reaching past the types (or a bad value from an untyped edge).
    const promise = client.createSession({ cwd: 5 as unknown as string });

    await expect(promise).rejects.toMatchObject({ code: ErrorCode.invalidRequest });
    expect(socket.sent).toEqual([]);
  });
});

describe("createProtocolClient: response correlation", () => {
  it("correlates responses that arrive out of order", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const first = client.openSession("s1");
    const second = client.openSession("s2");
    const third = client.listSessions();
    await flush();
    expect(socket.sent).toHaveLength(3);

    // Answer 3rd, then 1st, then 2nd.
    socket.respondOk(2, { sessions: [HEADER] });
    socket.respondOk(0, HEADER);
    socket.respondOk(1, { ...HEADER, sessionId: "s2" });

    await expect(first).resolves.toEqual(HEADER);
    await expect(second).resolves.toEqual({ ...HEADER, sessionId: "s2" });
    await expect(third).resolves.toEqual([HEADER]);
  });

  it("rejects with a ProtocolRequestError carrying the server ErrorCode", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.openSession("nope");
    await flush();
    socket.respondError(0, ErrorCode.sessionNotFound, "Session nope does not exist");

    await expect(promise).rejects.toBeInstanceOf(ProtocolRequestError);
    const error = await rejection<ProtocolRequestError>(promise);
    expect(error.code).toBe(ErrorCode.sessionNotFound);
    expect(error.method).toBe("openSession");
    expect(error.requestId).toBe(socket.frame(0).id);
    expect(error.message).toBe("Session nope does not exist");
  });

  it("keeps other requests in flight when one fails", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const failing = client.prompt("s1", "a");
    const succeeding = client.prompt("s2", "b");
    await flush();

    socket.respondError(0, ErrorCode.sessionBusy, "busy");
    await expect(failing).rejects.toMatchObject({ code: ErrorCode.sessionBusy });

    socket.respondOk(1, { ok: true });
    await expect(succeeding).resolves.toBeUndefined();
  });

  it("reports (and drops) a response for an unknown request id", async () => {
    const { errors, onProtocolError } = collectErrors();
    const socket = new FakeSocket();
    createProtocolClient(socket, { onProtocolError });

    expect(() => socket.emit({ kind: "response", id: "ghost", result: 1 })).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe(ClientErrorCode.invalidResponse);
    expect(errors[0]?.message).toMatch(/unknown request id "ghost"/);
  });
});

describe("createProtocolClient: timeouts", () => {
  it("rejects with ProtocolTimeoutError and leaks no pending entry", async () => {
    const { errors, onProtocolError } = collectErrors();
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { requestTimeoutMs: 20, onProtocolError });

    const promise = client.prompt("s1", "hi");
    await expect(promise).rejects.toBeInstanceOf(ProtocolTimeoutError);
    const error = await rejection<ProtocolTimeoutError>(promise);
    expect(error.code).toBe(ClientErrorCode.timeout);
    expect(error.timeoutMs).toBe(20);
    expect(error.method).toBe("prompt");

    // The pending entry is gone: a late response is unroutable, not a double-settle.
    socket.respondOk(0, { ok: true });
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/unknown request id/) as unknown as string,
    ]);
  });

  it("does not time out a request that answers in time", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { requestTimeoutMs: 50 });

    const promise = client.abort("s1");
    await flush();
    socket.respondOk(0, { ok: true });
    await expect(promise).resolves.toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 60));
    // Still settled exactly once; nothing threw asynchronously.
    await expect(promise).resolves.toBeUndefined();
  });

  it("defaults to a 30s deadline", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe("createProtocolClient: socket teardown", () => {
  it("rejects every pending request when the socket closes", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const first = client.prompt("s1", "a");
    const second = client.listSessions();
    await flush();

    socket.emitClose(1006);

    await expect(first).rejects.toBeInstanceOf(ProtocolClosedError);
    await expect(second).rejects.toBeInstanceOf(ProtocolClosedError);
    const error = await rejection<ProtocolClosedError>(first);
    expect(error.code).toBe(ClientErrorCode.closed);
    expect(error.closeCode).toBe(1006);
    expect(error.message).toMatch(/code 1006/);
  });

  it("rejects every pending request on a socket error, carrying the cause", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.prompt("s1", "a");
    await flush();

    const cause = new Error("ECONNRESET");
    socket.emitError(cause);

    const error = await rejection<ProtocolClosedError>(promise);
    expect(error).toBeInstanceOf(ProtocolClosedError);
    expect(error.message).toMatch(/ECONNRESET/);
    expect(error.cause).toBe(cause);
  });

  it("rejects new requests once the connection is gone", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);
    socket.emitClose(1001);

    await expect(client.prompt("s1", "a")).rejects.toBeInstanceOf(ProtocolClosedError);
    expect(socket.sent).toEqual([]);
  });

  it("close() closes the socket, rejects pending requests, and is idempotent", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.prompt("s1", "a");
    await flush();

    client.close();
    client.close();

    await expect(promise).rejects.toBeInstanceOf(ProtocolClosedError);
    expect(socket.closeCalls).toBe(1);
  });

  it("treats a socket handed over already-closed as closed", async () => {
    const socket = new FakeSocket(3);
    const client = createProtocolClient(socket);
    await expect(client.listSessions()).rejects.toBeInstanceOf(ProtocolClosedError);
  });
});

describe("createProtocolClient: authentication", () => {
  it("sends the authenticate frame first and gates other requests on it", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { token: "s3cret" });

    // Sent eagerly, before any caller-initiated request.
    expect(socket.frames()).toHaveLength(1);
    expect(socket.frame(0)).toEqual({
      id: expect.any(String),
      method: "authenticate",
      params: { token: "s3cret", protocolVersion: 1 },
    });

    const listing = client.listSessions();
    await flush();
    // Still only the auth frame: the server drops connections whose first
    // frame is not `authenticate`, so nothing may overtake it.
    expect(socket.sent).toHaveLength(1);

    socket.respondOk(0, { authenticated: true });
    await flush();

    expect(socket.frame(1).method).toBe("listSessions");
    socket.respondOk(1, { sessions: [HEADER] });
    await expect(listing).resolves.toEqual([HEADER]);
  });

  it("authenticate() resolves once and is idempotent", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { token: "t" });

    const a = client.authenticate();
    const b = client.authenticate();
    socket.respondOk(0, { authenticated: true });

    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    expect(socket.frames().filter((f) => f.method === "authenticate")).toHaveLength(1);
  });

  it("propagates an auth failure to the gated requests", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { token: "wrong" });

    const listing = client.listSessions();
    socket.respondError(0, ErrorCode.invalidRequest, "Invalid or missing token");

    await expect(client.authenticate()).rejects.toMatchObject({
      code: ErrorCode.invalidRequest,
    });
    await expect(listing).rejects.toMatchObject({ code: ErrorCode.invalidRequest });
    expect(socket.frames().map((f) => f.method)).toEqual(["authenticate"]);
  });

  it("sends no authenticate frame when no token is configured", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    await expect(client.authenticate()).resolves.toBeUndefined();
    expect(socket.sent).toEqual([]);

    void client.listSessions();
    await flush();
    expect(socket.frame(0).method).toBe("listSessions");
  });
});

describe("createProtocolClient: events", () => {
  it("fans out events to every listener and honours unsubscribe", () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const first: Array<[string, string]> = [];
    const second: Array<[string, string]> = [];
    const unsubscribe = client.onEvent((sessionId, event) => first.push([sessionId, event.type]));
    client.onEvent((sessionId, event) => second.push([sessionId, event.type]));

    socket.emit({ kind: "event", sessionId: "s1", event: { type: "turnStart", turnIndex: 0 } });
    unsubscribe();
    unsubscribe(); // idempotent
    socket.emit({ kind: "event", sessionId: "s1", event: { type: "compactionStart" } });

    expect(first).toEqual([["s1", "turnStart"]]);
    expect(second).toEqual([
      ["s1", "turnStart"],
      ["s1", "compactionStart"],
    ]);
  });

  it("delivers the event payload untouched", () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);
    const seen: unknown[] = [];
    client.onEvent((_sessionId, event) => seen.push(event));

    const event = { type: "notice", level: "warn", text: "heads up" };
    socket.emit({ kind: "event", sessionId: "s9", event });

    expect(seen).toEqual([event]);
  });

  it("reports a throwing listener without starving the others", () => {
    const { errors, onProtocolError } = collectErrors();
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { onProtocolError });

    client.onEvent(() => {
      throw new Error("listener blew up");
    });
    const seen: string[] = [];
    client.onEvent((_sessionId, event) => seen.push(event.type));

    expect(() =>
      socket.emit({ kind: "event", sessionId: "s1", event: { type: "compactionStart" } }),
    ).not.toThrow();

    expect(seen).toEqual(["compactionStart"]);
    expect(errors[0]?.message).toMatch(/listener blew up/);
  });
});

describe("createProtocolClient: malformed inbound traffic", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["non-JSON text", "{not json", /Malformed JSON/],
    ["a JSON value that is not an object", 42, /Invalid server message/],
    ["an unknown kind", { kind: "surprise" }, /Unknown kind/],
    ["a response with neither result nor error", { kind: "response", id: "x" }, /result.*error/],
    ["an event without a typed payload", { kind: "event", sessionId: "s1", event: {} }, /event/],
  ];

  it.each(cases)("reports %s instead of throwing", (_name, payload, pattern) => {
    const { errors, onProtocolError } = collectErrors();
    const socket = new FakeSocket();
    createProtocolClient(socket, { onProtocolError });

    expect(() => socket.emit(payload)).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe(ClientErrorCode.invalidResponse);
    expect(errors[0]?.message).toMatch(pattern);
  });

  it("survives a malformed frame and keeps serving later requests", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.prompt("s1", "hi");
    await flush();
    socket.emit("}}}not json{{{");
    socket.emit({ kind: "nope" });
    socket.respondOk(0, { ok: true });

    await expect(promise).resolves.toBeUndefined();
  });

  it("drops malformed frames silently when no onProtocolError is given", () => {
    const socket = new FakeSocket();
    createProtocolClient(socket);
    expect(() => socket.emit("nonsense")).not.toThrow();
  });

  it("reports a payload type it cannot decode", () => {
    const { errors, onProtocolError } = collectErrors();
    const socket = new FakeSocket();
    createProtocolClient(socket, { onProtocolError });

    socket.emitRaw(12345);

    expect(errors[0]?.message).toMatch(/unsupported type: number/);
  });

  it("ignores a well-formed but unsolicited sessions push", () => {
    const { errors, onProtocolError } = collectErrors();
    const socket = new FakeSocket();
    createProtocolClient(socket, { onProtocolError });

    socket.emit({ kind: "sessions", sessions: [HEADER] });

    expect(errors).toEqual([]);
  });
});

describe("createProtocolClient: payload decoding", () => {
  it("decodes Buffer, Buffer[], and ArrayBuffer payloads (what `ws` delivers)", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

    for (const wrap of [
      (value: unknown) => encode(value),
      (value: unknown) => [encode(value)],
      (value: unknown) => {
        const buffer = encode(value);
        return buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer;
      },
    ]) {
      const socket = new FakeSocket();
      const client = createProtocolClient(socket);
      const promise = client.prompt("s1", "hi");
      await flush();
      socket.emitRaw(wrap({ kind: "response", id: socket.frame(0).id, result: { ok: true } }));
      await expect(promise).resolves.toBeUndefined();
    }
  });

  it("reassembles multi-byte UTF-8 split across a Buffer[] payload", () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);
    const seen: string[] = [];
    client.onEvent((_sessionId, event) => {
      if (event.type === "notice") seen.push(event.text);
    });

    const text = JSON.stringify({
      kind: "event",
      sessionId: "s1",
      event: { type: "notice", level: "info", text: "✦ — más" },
    });
    const full = Buffer.from(text, "utf8");
    // Split mid-way through a multi-byte sequence if that is where it lands.
    const cut = Math.floor(full.length / 2);
    socket.emitRaw([full.subarray(0, cut), full.subarray(cut)]);

    expect(seen).toEqual(["✦ — más"]);
  });
});

describe("createProtocolClient: connecting sockets", () => {
  it("queues frames while CONNECTING and flushes them in order on open", async () => {
    const socket = new FakeSocket(0);
    const client = createProtocolClient(socket, { token: "t" });

    void client.listSessions();
    await flush();
    expect(socket.sent).toEqual([]);

    socket.emitOpen();
    expect(socket.frames().map((f) => f.method)).toEqual(["authenticate"]);

    socket.respondOk(0, { authenticated: true });
    await flush();
    expect(socket.frames().map((f) => f.method)).toEqual(["authenticate", "listSessions"]);
  });

  it("sends immediately when the socket reports OPEN", async () => {
    const socket = new FakeSocket(1);
    const client = createProtocolClient(socket);
    void client.abort("s1");
    await flush();
    expect(socket.frames().map((f) => f.method)).toEqual(["abort"]);
  });
});

describe("createProtocolClient: result validation", () => {
  it("validates session headers coming back from the server", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.openSession("s1");
    await flush();
    socket.respondOk(0, { version: 1, sessionId: "s1", cwd: "/repo" }); // no createdAt

    await expect(promise).rejects.toMatchObject({ code: ClientErrorCode.invalidResponse });
  });

  it("rejects a listSessions result that is not a session list", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listSessions();
    await flush();
    socket.respondOk(0, { sessions: "all of them" });

    await expect(promise).rejects.toMatchObject({ code: ClientErrorCode.invalidResponse });
  });

  it("accepts a bare array from listSessions as well as { sessions }", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listSessions();
    await flush();
    socket.respondOk(0, [HEADER]);

    await expect(promise).resolves.toEqual([HEADER]);
  });

  it("strips unknown fields from a session header", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.createSession({ cwd: "/repo" });
    await flush();
    socket.respondOk(0, { ...HEADER, title: "work", futureField: "ignored" });

    await expect(promise).resolves.toEqual({ ...HEADER, title: "work" });
  });
});

describe("createProtocolClient: protocol version", () => {
  it("surfaces a mismatch advertised in the authenticate response", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { token: "t" });

    socket.respondOk(0, { authenticated: true, protocolVersion: 7 });

    const error = await rejection<ProtocolVersionMismatchError>(client.authenticate());
    expect(error).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(error.code).toBe(ClientErrorCode.versionMismatch);
    expect(error.expected).toBe(1);
    expect(error.received).toBe(7);
    expect(error.message).toMatch(/version 1.*version 7/);
  });

  it("treats an authenticate response without a version as compatible", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { token: "t" });
    socket.respondOk(0, { authenticated: true });
    await expect(client.authenticate()).resolves.toBeUndefined();
  });

  it("surfaces a session header stamped with an unknown version", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.openSession("s1");
    await flush();
    socket.respondOk(0, { ...HEADER, version: 2 });

    const error = await rejection<ProtocolVersionMismatchError>(promise);
    expect(error).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(error.received).toBe(2);
    expect(error.message).toMatch(/session header/);
  });
});

describe("WebSocketLike", () => {
  it("is satisfied structurally by the `ws` WebSocket shape", () => {
    // Mirrors @types/ws's WebSocket declaration (server dependency; not a
    // dependency of this package, hence the local restatement).
    interface WsWebSocket {
      readonly readyState: 0 | 1 | 2 | 3;
      send(data: string | Buffer, cb?: (err?: Error) => void): void;
      close(code?: number, data?: string | Buffer): void;
      on(event: "close", listener: (this: WsWebSocket, code: number, reason: Buffer) => void): this;
      on(event: "error", listener: (this: WsWebSocket, error: Error) => void): this;
      on(
        event: "message",
        listener: (
          this: WsWebSocket,
          data: Buffer | ArrayBuffer | Buffer[],
          isBinary: boolean,
        ) => void,
      ): this;
      on(event: "open", listener: (this: WsWebSocket) => void): this;
      on(event: string | symbol, listener: (this: WsWebSocket, ...args: unknown[]) => void): this;
    }

    const accept = (socket: WebSocketLike): WebSocketLike => socket;
    // The assertion that matters is the assignment type-checking at all.
    const ws = { close: vi.fn(), send: vi.fn(), on: vi.fn() } as unknown as WsWebSocket;
    expect(accept(ws)).toBe(ws);
  });
});

describe("createProtocolClient: listModels", () => {
  const ENTRY = {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 2, output: 10 },
    apiKeyEnv: "ANTHROPIC_API_KEY",
    credentials: "present",
  } as const;

  it("returns the server's catalog", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listModels();
    await flush();
    socket.respondOk(0, { models: [ENTRY] });

    const catalog = await promise;
    expect(catalog?.models).toEqual([ENTRY]);
  });

  it("accepts a bare array, like listSessions does", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listModels();
    await flush();
    socket.respondOk(0, [ENTRY]);

    expect((await promise)?.models).toHaveLength(1);
  });

  it("degrades to undefined against an old server that does not know the verb", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listModels();
    await flush();
    // Exactly what packages/server/src/ws-server.ts answers today for a method
    // its `validateClientRequest` does not recognise.
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "listModels"');

    await expect(promise).resolves.toBeUndefined();
  });

  it("still rejects when the server fails the call for a real reason", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listModels();
    await flush();
    socket.respondError(0, ErrorCode.internal, "catalog blew up");

    const error = await rejection<ProtocolRequestError>(promise);
    expect(error.code).toBe(ErrorCode.internal);
  });

  it("rejects a catalog payload that is not the documented shape", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listModels();
    await flush();
    socket.respondOk(0, { models: [{ id: "a/b" }] });

    const error = await rejection(promise);
    expect(error.code).toBe(ClientErrorCode.invalidResponse);
  });
});
