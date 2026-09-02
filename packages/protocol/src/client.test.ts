import { describe, expect, it, vi } from "vitest";
import {
  ClientErrorCode,
  createProtocolClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isUnsupportedMethodError,
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

describe("createProtocolClient: capabilities", () => {
  it("reads capabilities off the authenticate response", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { token: "t" });

    expect(client.capabilities()).toEqual({});
    const authenticated = client.authenticate();
    socket.respondOk(0, { authenticated: true, capabilities: { ceilingRaise: true } });
    await authenticated;

    expect(client.capabilities()).toEqual({ ceilingRaise: true });
  });

  it("is {} before the handshake settles, and stays {} for a server that predates the field", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { token: "t" });
    expect(client.capabilities()).toEqual({});

    const authenticated = client.authenticate();
    // An older server's response — no `capabilities` field at all.
    socket.respondOk(0, { authenticated: true });
    await authenticated;

    expect(client.capabilities()).toEqual({});
  });

  it("is {} with no token configured — no authenticate frame is ever sent", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);
    await client.authenticate();
    expect(client.capabilities()).toEqual({});
  });

  it("drops a malformed capabilities field rather than throwing or trusting it", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket, { token: "t" });
    const authenticated = client.authenticate();
    socket.respondOk(0, { authenticated: true, capabilities: { ceilingRaise: "yes" } });
    await authenticated;
    expect(client.capabilities()).toEqual({});
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

describe("createProtocolClient: sessionHistory", () => {
  const HISTORY = {
    sessionId: "s1",
    events: [
      {
        type: "runStart",
        sessionId: "s1",
        prompt: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      },
      { type: "runEnd", reason: "completed" },
    ],
    truncated: false,
    droppedEvents: 0,
  };

  it("returns the server's replay", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.sessionHistory("s1");
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "sessionHistory",
      params: { sessionId: "s1" },
    });
    socket.respondOk(0, HISTORY);

    expect(await promise).toEqual(HISTORY);
  });

  it("degrades to undefined against an old server that does not know the verb", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.sessionHistory("s1");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "sessionHistory"');

    // A read that cannot happen costs the caller a transcript, not a guarantee.
    await expect(promise).resolves.toBeUndefined();
  });

  it("still rejects an id the server does not have", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.sessionHistory("s1");
    await flush();
    socket.respondError(0, ErrorCode.sessionNotFound, "Session s1 does not exist");

    const error = await rejection<ProtocolRequestError>(promise);
    expect(error.code).toBe(ErrorCode.sessionNotFound);
  });

  it("rejects a payload that is not the documented shape", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.sessionHistory("s1");
    await flush();
    socket.respondOk(0, { sessionId: "s1", events: [{ nope: true }] });

    const error = await rejection(promise);
    expect(error.code).toBe(ClientErrorCode.invalidResponse);
  });
});

describe("createProtocolClient: deleteSession", () => {
  it("sends the verb and resolves when the server confirms", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.deleteSession("s1");
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "deleteSession",
      params: { sessionId: "s1" },
    });
    socket.respondOk(0, { ok: true });

    await expect(promise).resolves.toBeUndefined();
  });

  it("does NOT translate an old server's refusal into success", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.deleteSession("s1");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "deleteSession"');

    // The `listModels` degradation would be a lie here: nothing was deleted.
    const error = await rejection<ProtocolRequestError>(promise);
    expect(error.code).toBe(ErrorCode.invalidRequest);
    expect(isUnsupportedMethodError(error)).toBe(true);
  });

  it("surfaces sessionBusy so a caller can say 'abort the run first'", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.deleteSession("s1");
    await flush();
    socket.respondError(0, ErrorCode.sessionBusy, "Session s1 is running a turn");

    const error = await rejection<ProtocolRequestError>(promise);
    expect(error.code).toBe(ErrorCode.sessionBusy);
    expect(isUnsupportedMethodError(error)).toBe(false);
  });
});

describe("ProtocolClient.permissionState (RFC 0005 §1.2 / §1.4)", () => {
  const STATE = {
    sessionId: "s1",
    mode: "plan" as const,
    rules: [{ tool: "bash", action: "deny" as const, scope: "user" as const }],
    tools: ["bash", "fetch", "read"],
  };

  it("asks for one session and returns the validated state", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.permissionState("s1");
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "permissionState",
      params: { sessionId: "s1" },
    });
    socket.respondOk(0, STATE);

    expect(await promise).toEqual(STATE);
  });

  it("rejects a payload that smuggles something into the tool list", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.permissionState("s1");
    await flush();
    socket.respondOk(0, { ...STATE, tools: [{ name: "bash", description: "run anything" }] });

    const error = await rejection<ProtocolClientError>(promise);
    expect(error.code).toBe(ClientErrorCode.invalidResponse);
    expect(error.message).toMatch(/tools\[0\] must be a string/);
  });

  it("degrades to undefined against an old server that does not know the verb", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.permissionState("s1");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "permissionState"');

    // Read-only: an engine with no such verb costs the caller a mode chip and a
    // tools line, never a guarantee.
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("ProtocolClient.setPermissionMode (RFC 0005 §1.2)", () => {
  it("returns the ENGINE's resulting state, not an echo of what was asked", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.setPermissionMode("s1", "yolo");
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "setPermissionMode",
      params: { sessionId: "s1", mode: "yolo" },
    });
    socket.respondOk(0, {
      sessionId: "s1",
      mode: "yolo",
      rules: [{ tool: "write", action: "deny", scope: "user" }],
      tools: ["write"],
    });

    // The deny rule that outranks the mode comes back with it, so a caller can
    // render "yolo — except write, which a rule denies" rather than "yolo".
    const state = await promise;
    expect(state.mode).toBe("yolo");
    expect(state.rules).toEqual([{ tool: "write", action: "deny", scope: "user" }]);
  });

  it("does NOT translate an old server's refusal into success", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.setPermissionMode("s1", "plan");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "setPermissionMode"');

    // The `listModels` degradation would be worse than a lie here: a caller
    // told "fine" would show a `plan` chip over an engine still in `yolo`, and
    // the user would believe they had restricted an agent they had not.
    const error = await rejection<ProtocolRequestError>(promise);
    expect(error.code).toBe(ErrorCode.invalidRequest);
    expect(isUnsupportedMethodError(error)).toBe(true);
  });

  it("surfaces sessionBusy so a caller can say 'abort the run first'", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.setPermissionMode("s1", "plan");
    await flush();
    socket.respondError(0, ErrorCode.sessionBusy, "Session s1 is running a turn");

    const error = await rejection<ProtocolRequestError>(promise);
    expect(error.code).toBe(ErrorCode.sessionBusy);
    expect(isUnsupportedMethodError(error)).toBe(false);
  });
});

describe("ProtocolClient.respondToPermission scope (RFC 0005 §1.2)", () => {
  it("sends a session scope beside the decision, and no rule of its own", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    void client.respondToPermission(
      "s1",
      { requestId: "r1", behavior: "allow" },
      {
        scope: "session",
      },
    );
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "permissionDecision",
      params: {
        sessionId: "s1",
        decision: { requestId: "r1", behavior: "allow" },
        scope: "session",
      },
    });
  });

  it("omits the field entirely for an allow-once", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    void client.respondToPermission("s1", { requestId: "r1", behavior: "allow" });
    await flush();
    expect(socket.frames()[0]).not.toHaveProperty("params.scope");
  });

  it("refuses a scope that would outlive the session before the frame is sent", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.respondToPermission(
      "s1",
      { requestId: "r1", behavior: "allow" },
      { scope: "user" },
    );
    const error = await rejection<ProtocolClientError>(promise);
    expect(error.code).toBe(ErrorCode.invalidRequest);
    expect(error.message).toMatch(/may not outlive the session/);
    // Nothing went out: a UI bug costs no round trip and no server state.
    expect(socket.frames()).toHaveLength(0);
  });

  it("refuses a client-authored persistRule that would outlive the session", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.respondToPermission("s1", {
      requestId: "r1",
      behavior: "allow",
      persistRule: { tool: "bash", action: "allow", scope: "project" },
    });
    const error = await rejection<ProtocolClientError>(promise);
    expect(error.message).toMatch(/may not outlive the session/);
    expect(socket.frames()).toHaveLength(0);
  });
});

describe("ProtocolClient.listCommands (RFC 0005 §1.3)", () => {
  const LIST = {
    commands: [
      { name: "review", description: "Review the diff", kind: "skill" as const, source: "/w/r.md" },
      { name: "model", description: "Switch the model", kind: "builtin" as const },
    ],
  };

  it("takes no params and returns the validated list", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listCommands();
    await flush();
    expect(socket.frames()[0]).toMatchObject({ method: "listCommands" });
    expect(socket.frames()[0]).not.toHaveProperty("params");
    socket.respondOk(0, LIST);

    expect(await promise).toEqual(LIST);
  });

  it("accepts a bare array, like listModels does", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listCommands();
    await flush();
    socket.respondOk(0, LIST.commands);

    expect((await promise)?.commands).toHaveLength(2);
  });

  it("degrades to undefined against an old server that does not know the verb", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listCommands();
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "listCommands"');

    await expect(promise).resolves.toBeUndefined();
  });
});

describe("ProtocolClient.compact, exportSession, mcpStatus (terminal parity)", () => {
  const SUMMARY = {
    sessionId: "s1",
    compacted: true,
    tokensBefore: 42_000,
    tokensAfter: 9_000,
  };
  const EXPORT = {
    sessionId: "s1",
    format: "markdown" as const,
    filename: "arcturn-session-2026-08-25-1200.md",
    content: "# Arcturn Session\n",
    messageCount: 4,
    truncated: false,
    droppedMessages: 0,
  };
  const MCP = {
    servers: [
      { name: "files", transport: "stdio" as const, state: "connected" as const, toolCount: 3 },
    ],
  };

  it("compact sends the session and returns the validated summary", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.compact("s1");
    await flush();
    expect(socket.frames()[0]).toMatchObject({ method: "compact", params: { sessionId: "s1" } });
    socket.respondOk(0, SUMMARY);

    expect(await promise).toEqual(SUMMARY);
  });

  it("compact REJECTS against an old server rather than resolving", async () => {
    // The `deleteSession` counter-precedent. A caller told "fine" by an engine
    // that ignored this would report freed context that was never freed.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.compact("s1");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "compact"');

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolRequestError);
    expect(isUnsupportedMethodError(error)).toBe(true);
  });

  it("exportSession omits the optional params it was not given", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.exportSession("s1");
    await flush();
    expect(socket.frames()[0]?.params).toEqual({ sessionId: "s1" });
    socket.respondOk(0, EXPORT);

    expect(await promise).toEqual(EXPORT);
  });

  it("exportSession forwards format and includeThinking when asked", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.exportSession("s1", { format: "html", includeThinking: true });
    await flush();
    expect(socket.frames()[0]?.params).toEqual({
      sessionId: "s1",
      format: "html",
      includeThinking: true,
    });
    socket.respondOk(0, { ...EXPORT, format: "html", filename: "a.html" });

    expect((await promise)?.format).toBe("html");
  });

  it("exportSession degrades to undefined against an old server", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.exportSession("s1");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "exportSession"');

    await expect(promise).resolves.toBeUndefined();
  });

  it("mcpStatus takes no params and degrades to undefined against an old server", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const ready = client.mcpStatus();
    await flush();
    expect(socket.frames()[0]).not.toHaveProperty("params");
    socket.respondOk(0, MCP);
    expect(await ready).toEqual(MCP);

    const old = client.mcpStatus();
    await flush();
    socket.respondError(1, ErrorCode.invalidRequest, 'Unknown method: "mcpStatus"');
    await expect(old).resolves.toBeUndefined();
  });

  it("rejects an mcpStatus payload carrying anything but the four fields", async () => {
    // The validator copies by name, so an extra field is dropped rather than
    // forwarded; a field with the *wrong* shape is a rejection.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.mcpStatus();
    await flush();
    socket.respondOk(0, {
      servers: [
        {
          name: "files",
          transport: "stdio",
          state: "connected",
          toolCount: 3,
          url: "https://mcp.example.com/?token=sk-live-planted",
          env: { MCP_API_KEY: "sk-live-planted" },
        },
      ],
    });

    const status = await promise;
    expect(status?.servers[0]).toEqual({
      name: "files",
      transport: "stdio",
      state: "connected",
      toolCount: 3,
    });
    expect(JSON.stringify(status)).not.toContain("sk-live-planted");
  });
});

describe("ProtocolClient.listCheckpoints / rewindTo (the rewind pair)", () => {
  const LIST = {
    sessionId: "s1",
    available: true,
    truncated: false,
    droppedCheckpoints: 0,
    checkpoints: [
      {
        id: "turn-1",
        label: "add rate limiting",
        timestamp: 1_700_000_000_000,
        fileCount: 2,
        deleteCount: 1,
        files: ["src/auth.ts", "src/limiter.ts"],
        truncatedFiles: false,
        forksConversation: true,
        confirmation: "deadbeefdeadbeefdeadbeefdeadbeef",
      },
    ],
  };

  it("listCheckpoints returns the validated list", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listCheckpoints("s1");
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "listCheckpoints",
      params: { sessionId: "s1" },
    });
    socket.respondOk(0, LIST);
    expect(await promise).toEqual(LIST);
  });

  it("listCheckpoints degrades to undefined against an old engine", async () => {
    // Read-only, so a shrug costs a caller its picker and no guarantee — the
    // `listModels` precedent.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.listCheckpoints("s1");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "listCheckpoints"');
    await expect(promise).resolves.toBeUndefined();
  });

  it("rewindTo echoes the confirmation it was given", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.rewindTo("s1", "turn-1", "deadbeefdeadbeefdeadbeefdeadbeef");
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "rewindTo",
      params: {
        sessionId: "s1",
        checkpointId: "turn-1",
        confirmation: "deadbeefdeadbeefdeadbeefdeadbeef",
      },
    });
    socket.respondOk(0, {
      sessionId: "s1",
      checkpointId: "turn-1",
      restored: ["src/auth.ts"],
      deleted: ["src/limiter.ts"],
      failed: [],
      conversationForked: true,
    });
    const result = await promise;
    expect(result.restored).toEqual(["src/auth.ts"]);
    expect(result.conversationForked).toBe(true);
  });

  it("rewindTo REJECTS against an old engine rather than resolving", async () => {
    // The sharpest case for the `deleteSession` counter-precedent: a caller
    // told "fine" would believe their files went back to a state they never
    // returned to, and would carry on against code they think they discarded.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.rewindTo("s1", "turn-1", "deadbeefdeadbeefdeadbeefdeadbeef");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "rewindTo"');

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolRequestError);
    expect(isUnsupportedMethodError(error)).toBe(true);
  });

  it("rejects a rewindTo payload that omits conversationForked", async () => {
    // Not defaultable: a caller that guessed would tell somebody their
    // transcript matched their files when only one of the two had moved.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.rewindTo("s1", "turn-1", "deadbeefdeadbeefdeadbeefdeadbeef");
    await flush();
    socket.respondOk(0, {
      sessionId: "s1",
      checkpointId: "turn-1",
      restored: [],
      deleted: [],
      failed: [],
    });
    await expect(promise).rejects.toThrow(/conversationForked/);
  });
});

describe("isUnsupportedMethodError", () => {
  it("is true only for a server-reported unknown-method rejection", () => {
    expect(
      isUnsupportedMethodError(
        new ProtocolRequestError(ErrorCode.invalidRequest, 'Unknown method: "x"', {
          requestId: "1",
          method: "x",
        }),
      ),
    ).toBe(true);
    expect(
      isUnsupportedMethodError(
        new ProtocolRequestError(ErrorCode.unknownMethod, "nope", { requestId: "1", method: "x" }),
      ),
    ).toBe(true);
    expect(
      isUnsupportedMethodError(
        new ProtocolRequestError(ErrorCode.sessionNotFound, "nope", {
          requestId: "1",
          method: "x",
        }),
      ),
    ).toBe(false);
    // A locally-raised failure carrying the same code is this client's own
    // validation failing — a bug to surface, not a peer to work around.
    expect(isUnsupportedMethodError(new ProtocolClosedError("closed"))).toBe(false);
    expect(isUnsupportedMethodError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delegation: background agents and org memory
// ---------------------------------------------------------------------------

const BG_ROW = {
  id: "bg-a1b2c3d4",
  sessionId: "sess_child",
  task: "fix the flaky retry test",
  modelId: "anthropic/claude-sonnet-4-5",
  status: "running",
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_100,
  elapsedMs: 1200,
  costUsd: 0.42,
} as const;

describe("ProtocolClient — background agents", () => {
  it("sends no params at all for the listing form", async () => {
    // The listing genuinely takes nothing, and an empty `params: {}` would be
    // a shape the validator has to tolerate forever for no reason.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.backgroundAgents();
    await flush();
    expect(socket.frame(0)).toEqual({
      id: expect.any(String) as string,
      method: "backgroundAgents",
    });
    socket.respondOk(0, { agents: [BG_ROW], truncated: false, droppedAgents: 0 });
    const result = await promise;
    expect(result?.agents[0]?.id).toBe("bg-a1b2c3d4");
    expect(result?.agents[0]?.transcript).toBeUndefined();
  });

  it("narrows to one agent and carries its transcript", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.backgroundAgents("bg-a1b2c3d4");
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "backgroundAgents",
      params: { id: "bg-a1b2c3d4" },
    });
    socket.respondOk(0, {
      agents: [
        {
          ...BG_ROW,
          transcript: {
            lines: ["> fix it", "[assistant] done"],
            truncated: false,
            droppedLines: 0,
          },
        },
      ],
      truncated: false,
      droppedAgents: 0,
    });
    const result = await promise;
    expect(result?.agents[0]?.transcript?.lines).toEqual(["> fix it", "[assistant] done"]);
  });

  it("backgroundAgents degrades to undefined against an old engine", async () => {
    // Read-only, so a shrug costs a caller its listing and no guarantee — the
    // `listModels` precedent. `undefined` rather than an empty list, because
    // "this engine has none" and "this engine cannot tell you" are different
    // and only one of them means hide the surface.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.backgroundAgents();
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "backgroundAgents"');
    await expect(promise).resolves.toBeUndefined();
  });

  it("reads an unknown id as an empty list, which is why the engine must not error", async () => {
    // The reason `SessionHost.backgroundAgents` answers `{ agents: [] }` for an
    // id nothing matches rather than refusing: `isUnsupportedMethodError` reads
    // every server-sent `invalidRequest` as "this peer is older than the verb",
    // because that is the only thing it can be told. An engine that refused a
    // typo would therefore make this client hide its whole background-agent
    // surface. Asserted here, on the client, so the constraint is written down
    // where the translation happens.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const empty = client.backgroundAgents("bg-nope");
    await flush();
    socket.respondOk(0, { agents: [], truncated: false, droppedAgents: 0 });
    expect((await empty)?.agents).toEqual([]);

    const refused = client.backgroundAgents("bg-nope");
    await flush();
    socket.respondError(1, ErrorCode.invalidRequest, 'No background agent "bg-nope".');
    // Indistinguishable from an old engine, which is exactly the failure the
    // engine-side empty list avoids.
    await expect(refused).resolves.toBeUndefined();
  });

  it("rejects a listing that does not say whether it stopped short", async () => {
    // A list that silently stops reads as the whole list.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.backgroundAgents();
    await flush();
    socket.respondOk(0, { agents: [BG_ROW] });
    const error = await promise.catch((e: unknown) => e as ProtocolClientError);
    expect((error as ProtocolClientError).code).toBe(ClientErrorCode.invalidResponse);
  });

  it("reports how many old rows a bounded listing dropped", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.backgroundAgents();
    await flush();
    socket.respondOk(0, { agents: [BG_ROW], truncated: true, droppedAgents: 41 });
    const result = await promise;
    expect(result?.truncated).toBe(true);
    expect(result?.droppedAgents).toBe(41);
  });

  it("startBackgroundAgent carries the task and nothing else", async () => {
    // The containment, asserted on the frame: there is no tools, no
    // permissionMode, no cwd and no model for a caller to widen.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.startBackgroundAgent("fix the flaky retry test");
    await flush();
    expect(socket.frame(0).params).toEqual({ task: "fix the flaky retry test" });
    socket.respondOk(0, { id: "bg-a1b2c3d4", sessionId: "sess_child" });
    expect(await promise).toEqual({ id: "bg-a1b2c3d4", sessionId: "sess_child" });
  });

  it("startBackgroundAgent REJECTS against an old engine rather than resolving", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.startBackgroundAgent("do a thing");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "startBackgroundAgent"');
    const error = await promise.catch((e: unknown) => e);
    expect(isUnsupportedMethodError(error)).toBe(true);
  });

  it("cancelBackgroundAgent reports acceptance separately from the row", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.cancelBackgroundAgent("bg-a1b2c3d4");
    await flush();
    socket.respondOk(0, { accepted: true, agent: BG_ROW });
    const result = await promise;
    // Accepted, and still running — the transition lands after the abort
    // cascades. A client that read only the row would report nothing happened.
    expect(result.accepted).toBe(true);
    expect(result.agent.status).toBe("running");
  });

  it("cancelBackgroundAgent REJECTS against an old engine", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.cancelBackgroundAgent("bg-a1b2c3d4");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "cancelBackgroundAgent"');
    expect(isUnsupportedMethodError(await promise.catch((e: unknown) => e))).toBe(true);
  });

  it("adoptBackgroundAgent reports which delivery path the engine used", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.adoptBackgroundAgent("s1", "bg-a1b2c3d4");
    await flush();
    expect(socket.frames()[0]).toMatchObject({
      method: "adoptBackgroundAgent",
      params: { sessionId: "s1", id: "bg-a1b2c3d4" },
    });
    socket.respondOk(0, { agentId: "bg-a1b2c3d4", delivered: "steer" });
    expect((await promise).delivered).toBe("steer");
  });

  it("rejects an adopt payload with a delivery nobody can name", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.adoptBackgroundAgent("s1", "bg-a1b2c3d4");
    await flush();
    socket.respondOk(0, { agentId: "bg-a1b2c3d4", delivered: "telepathy" });
    const error = await promise.catch((e: unknown) => e as ProtocolClientError);
    expect((error as ProtocolClientError).code).toBe(ClientErrorCode.invalidResponse);
  });
});

describe("ProtocolClient — org memory", () => {
  const PROPOSED = {
    id: "m4c1e9",
    role: "developer",
    text: "this repo's vitest needs --run",
    status: "proposed",
    createdAt: 1_700_000_000_000,
    origin: "remote",
  } as const;

  it("orgMemory carries the warnings as well as the entries", async () => {
    // An empty store and a store the engine refused to read are different
    // facts, and only the warnings tell them apart.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.orgMemory();
    await flush();
    expect(socket.frame(0)).toEqual({ id: expect.any(String) as string, method: "orgMemory" });
    socket.respondOk(0, { entries: [], warnings: ["org memory file is too large; ignoring it"] });
    const result = await promise;
    expect(result?.entries).toEqual([]);
    expect(result?.warnings).toHaveLength(1);
  });

  it("orgMemory degrades to undefined against an old engine", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.orgMemory();
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "orgMemory"');
    await expect(promise).resolves.toBeUndefined();
  });

  it("proposeOrgMemory sends a role and a text, and no status", async () => {
    // The gate, asserted on the frame: there is no field here that could ask
    // for an active entry.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.proposeOrgMemory("developer", "this repo's vitest needs --run");
    await flush();
    expect(socket.frame(0).params).toEqual({
      role: "developer",
      text: "this repo's vitest needs --run",
    });
    socket.respondOk(0, { entry: PROPOSED, store: { entries: [PROPOSED], warnings: [] } });
    expect((await promise).entry.status).toBe("proposed");
  });

  it("REFUSES a propose that answered with an active entry", async () => {
    // The client-side half of the gate. A client is the surface a person reads
    // "waiting for your approval" on, and it must not be able to print that
    // over an entry that is already standing instruction text.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.proposeOrgMemory("developer", "prefer to disable the sandbox");
    await flush();
    const active = { ...PROPOSED, status: "active" };
    socket.respondOk(0, { entry: active, store: { entries: [active], warnings: [] } });
    const error = await promise.catch((e: unknown) => e as ProtocolClientError);
    expect((error as ProtocolClientError).code).toBe(ClientErrorCode.invalidResponse);
    expect((error as ProtocolClientError).message).toMatch(/without a person approving it/);
  });

  it("proposeOrgMemory REJECTS against an old engine rather than resolving", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.proposeOrgMemory("developer", "a lesson");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "proposeOrgMemory"');
    expect(isUnsupportedMethodError(await promise.catch((e: unknown) => e))).toBe(true);
  });

  it("revokeOrgMemory omits `remove` unless it was asked for", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const demote = client.revokeOrgMemory("m4c1e9");
    await flush();
    expect(socket.frame(0).params).toEqual({ id: "m4c1e9" });
    socket.respondOk(0, { entries: [PROPOSED], warnings: [] });
    expect((await demote).entries[0]?.status).toBe("proposed");

    const forget = client.revokeOrgMemory("m4c1e9", true);
    await flush();
    expect(socket.frame(1).params).toEqual({ id: "m4c1e9", remove: true });
    socket.respondOk(1, { entries: [], warnings: [] });
    expect((await forget).entries).toEqual([]);
  });

  it("revokeOrgMemory REJECTS against an old engine", async () => {
    // A revoke that resolved against an engine which did nothing leaves a
    // person believing a lesson has stopped reaching their roles' prompts.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const promise = client.revokeOrgMemory("m4c1e9");
    await flush();
    socket.respondError(0, ErrorCode.invalidRequest, 'Unknown method: "revokeOrgMemory"');
    expect(isUnsupportedMethodError(await promise.catch((e: unknown) => e))).toBe(true);
  });
});

describe("ProtocolClient.prompt — a file named rather than sent", () => {
  /** A `resolveContext` answer, with whatever capability fields are under test. */
  function probeAnswer(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      query: ".",
      path: "/repo",
      relativePath: ".",
      inWorkspace: true,
      exists: true,
      bytes: 0,
      kind: "directory",
      reason: "a directory cannot be attached; name a file inside it",
      ...extra,
    };
  }

  it("sends a fileReference to an engine that advertises the kind", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const sent = client.prompt("s1", "explain this function", [
      { kind: "fileReference", path: "src/auth.ts" },
    ]);
    await flush();
    // Frame 0 is the probe, not the prompt: an old engine must never be handed
    // the attachment at all.
    expect(socket.frame(0).method).toBe("resolveContext");
    socket.respondOk(
      0,
      probeAnswer({
        range: { start: 1, end: 1 },
        attachmentKinds: ["file", "fileReference", "image"],
      }),
    );
    await flush();
    expect(socket.frame(1).params).toEqual({
      sessionId: "s1",
      text: "explain this function",
      attachments: [{ kind: "fileReference", path: "src/auth.ts" }],
    });
    socket.respondOk(1, {});
    await expect(sent).resolves.toBeUndefined();
  });

  it("REFUSES locally against an engine whose attachmentKinds omit the kind", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const sent = client.prompt("s1", "explain this function", [
      { kind: "fileReference", path: "src/auth.ts" },
    ]);
    await flush();
    socket.respondOk(0, probeAnswer({ range: { start: 1, end: 1 }, attachmentKinds: ["file"] }));

    const error = await rejection(sent);
    expect(error.code).toBe(ErrorCode.invalidRequest);
    expect(error.message).toMatch(/older than file references/);
    expect(error.message).toMatch(/Nothing was sent/);
    // The assertion that matters: the prompt frame never existed. The whole
    // point of the kind is that an engine which cannot honour it never gets
    // the chance to fall back to the file's contents.
    expect(socket.frames().filter((frame) => frame.method === "prompt")).toEqual([]);
  });

  it("REFUSES locally against an engine that predates the field entirely", async () => {
    // Absent `attachmentKinds` is an engine older than the field, which is an
    // engine older than the kind. Read as "no kinds at all" it would also
    // block plain `file` attachments; read as "the two that shipped" it blocks
    // exactly this one.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const sent = client.prompt("s1", "hi", [{ kind: "fileReference", path: "src/auth.ts" }]);
    await flush();
    socket.respondOk(0, probeAnswer({ range: { start: 1, end: 1 } }));
    expect((await rejection(sent)).message).toMatch(/older than file references/);
    expect(socket.frames().filter((frame) => frame.method === "prompt")).toEqual([]);
  });

  it("keeps sending plain file attachments to that same engine", async () => {
    // The refusal is per-kind, not per-engine: an engine that predates
    // references still honours everything it always did.
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);

    const sent = client.prompt("s1", "summarise", [{ kind: "file", path: "notes.md" }]);
    await flush();
    socket.respondOk(0, probeAnswer({ range: { start: 1, end: 1 } }));
    await flush();
    expect(socket.frame(1).method).toBe("prompt");
    socket.respondOk(1, {});
    await expect(sent).resolves.toBeUndefined();
  });
});
