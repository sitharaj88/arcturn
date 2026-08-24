import { Agent } from "@arcturn/core";
import type {
  AgentEvent,
  AssistantMessage,
  ModelCatalogEntry,
  ServerMessage,
  StreamEvent,
  Tool,
} from "@arcturn/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SessionHost } from "./session-host.js";
import {
  createGatedLLM,
  createScriptedLLM,
  TEST_MODEL,
  textTurn,
  toolCallTurn,
} from "./test-helpers/fake-llm.js";
import { createGuardedTool } from "./test-helpers/tools.js";
import { ArcturnServer } from "./ws-server.js";

type AnyLLM = ReturnType<typeof createScriptedLLM> | ReturnType<typeof createGatedLLM>;

function buildSessionHost(
  llm: AnyLLM,
  tools: Tool[] = [],
  permissionTimeoutMs = 60_000,
): SessionHost {
  return new SessionHost({
    agentFactory: (opts) =>
      new Agent({
        llm,
        model: TEST_MODEL,
        systemPrompt: "You are a test agent.",
        tools,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      }),
    defaultCwd: "/tmp/arcturn-ws-test",
    permissionTimeoutMs,
  });
}

const servers: ArcturnServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  for (const server of servers.splice(0)) {
    await server.stop();
  }
});

async function startServer(
  host: SessionHost,
  token?: string,
  extra: Partial<ConstructorParameters<typeof ArcturnServer>[0]> = {},
): Promise<{ server: ArcturnServer; url: string }> {
  const server = new ArcturnServer({
    sessionHost: host,
    ...(token === undefined ? {} : { token }),
    ...extra,
  });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  return { server, url: `ws://127.0.0.1:${port}` };
}

function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Collect every parsed `ServerMessage` frame received on `ws`. */
function collectMessages(ws: WebSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString("utf8")));
  });
  return messages;
}

function send(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

/** Wait until `predicate(messages)` is true, or time out. */
async function waitFor(
  messages: ServerMessage[],
  predicate: (messages: ServerMessage[]) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate(messages)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for condition. Messages so far: ${JSON.stringify(messages)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function responseFor(messages: ServerMessage[], id: string): ServerMessage | undefined {
  return messages.find((m) => m.kind === "response" && m.id === id);
}

function eventsFor(messages: ServerMessage[], sessionId: string): AgentEvent[] {
  return messages
    .filter(
      (m): m is Extract<ServerMessage, { kind: "event" }> =>
        m.kind === "event" && m.sessionId === sessionId,
    )
    .map((m) => m.event);
}

describe("ArcturnServer end-to-end", () => {
  it("creates a session, prompts it, and streams runStart/messageStream/runEnd events", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hello over the wire")]));
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "createSession", params: { cwd: "/tmp/arcturn-ws-test" } });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);
    const createResp = responseFor(messages, "1");
    expect(createResp).toMatchObject({ kind: "response", id: "1" });
    const sessionId = (createResp as { result: { sessionId: string } }).result.sessionId;
    expect(sessionId).toBeTruthy();

    send(ws, { id: "2", method: "openSession", params: { sessionId } });
    await waitFor(messages, (m) => responseFor(m, "2") !== undefined);

    send(ws, { id: "3", method: "prompt", params: { sessionId, text: "hi" } });
    await waitFor(messages, (m) => eventsFor(m, sessionId).some((e) => e.type === "runEnd"));

    const events = eventsFor(messages, sessionId);
    expect(events[0]?.type).toBe("runStart");
    expect(events.some((e) => e.type === "messageStream")).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: "runEnd", reason: "completed" });

    await waitFor(messages, (m) => responseFor(m, "3") !== undefined);
    expect(responseFor(messages, "3")).toMatchObject({
      kind: "response",
      id: "3",
      result: { ok: true },
    });
  });

  it("responds with an error, and keeps the connection open, for malformed JSON and invalid requests", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    ws.send("{ not json");
    await waitFor(messages, (m) => m.length >= 1);
    expect(messages[0]).toMatchObject({ kind: "response", error: { code: "invalidRequest" } });

    send(ws, { id: "x", method: "notARealMethod" });
    await waitFor(messages, (m) => m.length >= 2);
    expect(messages[1]).toMatchObject({
      kind: "response",
      id: "x",
      error: { code: "invalidRequest" },
    });

    // The connection must still be usable afterwards.
    send(ws, { id: "y", method: "listSessions" });
    await waitFor(messages, (m) => responseFor(m, "y") !== undefined);
    expect(responseFor(messages, "y")).toMatchObject({ kind: "response", id: "y" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("returns sessionNotFound for requests against an unknown session", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "prompt", params: { sessionId: "no-such-session", text: "hi" } });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);
    expect(responseFor(messages, "1")).toMatchObject({
      kind: "response",
      id: "1",
      error: { code: "sessionNotFound" },
    });
  });

  it("rejects a concurrent prompt on the same session with sessionBusy", async () => {
    const llm = createGatedLLM(textTurn("done"));
    const host = buildSessionHost(llm);
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "createSession", params: { cwd: "/tmp/arcturn-ws-test" } });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);
    const sessionId = (responseFor(messages, "1") as { result: { sessionId: string } }).result
      .sessionId;
    send(ws, { id: "2", method: "openSession", params: { sessionId } });
    await waitFor(messages, (m) => responseFor(m, "2") !== undefined);

    send(ws, { id: "3", method: "prompt", params: { sessionId, text: "first" } });
    await waitFor(messages, (m) => eventsFor(m, sessionId).some((e) => e.type === "runStart"));

    send(ws, { id: "4", method: "prompt", params: { sessionId, text: "second" } });
    await waitFor(messages, (m) => responseFor(m, "4") !== undefined);
    expect(responseFor(messages, "4")).toMatchObject({
      kind: "response",
      id: "4",
      error: { code: "sessionBusy" },
    });

    llm.release();
    await waitFor(messages, (m) => responseFor(m, "3") !== undefined);
    expect(responseFor(messages, "3")).toMatchObject({
      kind: "response",
      id: "3",
      result: { ok: true },
    });
  });

  it("round-trips a permission request over the wire: toolCall stream -> permissionRequest -> permissionDecision -> tool proceeds", async () => {
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { note: "please" }),
      textTurn("all done"),
    ]);
    const host = buildSessionHost(llm, [createGuardedTool("guarded")]);
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "createSession", params: { cwd: "/tmp/arcturn-ws-test" } });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);
    const sessionId = (responseFor(messages, "1") as { result: { sessionId: string } }).result
      .sessionId;
    send(ws, { id: "2", method: "openSession", params: { sessionId } });
    await waitFor(messages, (m) => responseFor(m, "2") !== undefined);

    send(ws, { id: "3", method: "prompt", params: { sessionId, text: "run the guarded tool" } });

    await waitFor(messages, (m) =>
      eventsFor(m, sessionId).some((e) => e.type === "permissionRequest"),
    );
    const permissionRequest = eventsFor(messages, sessionId).find(
      (e): e is Extract<AgentEvent, { type: "permissionRequest" }> =>
        e.type === "permissionRequest",
    );
    expect(permissionRequest?.request.toolName).toBe("guarded");

    send(ws, {
      id: "4",
      method: "permissionDecision",
      params: {
        sessionId,
        decision: { requestId: permissionRequest?.request.id, behavior: "allow" },
      },
    });
    await waitFor(messages, (m) => responseFor(m, "4") !== undefined);

    await waitFor(messages, (m) => eventsFor(m, sessionId).some((e) => e.type === "runEnd"));
    const events = eventsFor(messages, sessionId);
    const toolEnd = events.find((e) => e.type === "toolEnd");
    expect(toolEnd).toMatchObject({ type: "toolEnd", result: { isError: false } });
    expect(events[events.length - 1]).toMatchObject({ type: "runEnd", reason: "completed" });
  });

  it("denies a permission request when the client sends behavior: deny", async () => {
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", {}),
      textTurn("ok, skipping"),
    ]);
    const host = buildSessionHost(llm, [createGuardedTool("guarded")]);
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "createSession", params: { cwd: "/tmp/arcturn-ws-test" } });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);
    const sessionId = (responseFor(messages, "1") as { result: { sessionId: string } }).result
      .sessionId;
    send(ws, { id: "2", method: "openSession", params: { sessionId } });
    await waitFor(messages, (m) => responseFor(m, "2") !== undefined);
    send(ws, { id: "3", method: "prompt", params: { sessionId, text: "run it" } });

    await waitFor(messages, (m) =>
      eventsFor(m, sessionId).some((e) => e.type === "permissionRequest"),
    );
    const permissionRequest = eventsFor(messages, sessionId).find(
      (e): e is Extract<AgentEvent, { type: "permissionRequest" }> =>
        e.type === "permissionRequest",
    );

    send(ws, {
      id: "4",
      method: "permissionDecision",
      params: {
        sessionId,
        decision: { requestId: permissionRequest?.request.id, behavior: "deny" },
      },
    });

    await waitFor(messages, (m) => eventsFor(m, sessionId).some((e) => e.type === "runEnd"));
    const toolEnd = eventsFor(messages, sessionId).find((e) => e.type === "toolEnd");
    expect(toolEnd).toMatchObject({ type: "toolEnd", result: { isError: true } });
  });

  it("accepts a connection with the correct auth token and rejects a wrong one", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const { url } = await startServer(host, "s3cr3t");

    const good = await connect(url);
    const goodMessages = collectMessages(good);
    send(good, { id: "auth", method: "authenticate", params: { token: "s3cr3t" } });
    await waitFor(goodMessages, (m) => responseFor(m, "auth") !== undefined);
    expect(responseFor(goodMessages, "auth")).toMatchObject({ kind: "response", id: "auth" });
    send(good, { id: "ls", method: "listSessions" });
    await waitFor(goodMessages, (m) => responseFor(m, "ls") !== undefined);
    expect(responseFor(goodMessages, "ls")).toMatchObject({ kind: "response", id: "ls" });

    const bad = await connect(url);
    const badMessages = collectMessages(bad);
    const closed = new Promise<number>((resolve) => bad.once("close", (code) => resolve(code)));
    send(bad, { id: "auth", method: "authenticate", params: { token: "wrong" } });
    const code = await closed;
    expect(code).toBe(4401);
    expect(responseFor(badMessages, "auth")).toMatchObject({
      kind: "response",
      id: "auth",
      error: { code: "invalidRequest" },
    });
  });

  it("closes a connection that sends a non-auth frame before authenticating", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const { url } = await startServer(host, "s3cr3t");
    const ws = await connect(url);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    send(ws, { id: "1", method: "listSessions" });
    expect(await closed).toBe(4401);
  });

  it("fans out one session's events to multiple observing connections", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("broadcast me")]));
    const { url } = await startServer(host);

    const wsA = await connect(url);
    const messagesA = collectMessages(wsA);
    send(wsA, { id: "1", method: "createSession", params: { cwd: "/tmp/arcturn-ws-test" } });
    await waitFor(messagesA, (m) => responseFor(m, "1") !== undefined);
    const sessionId = (responseFor(messagesA, "1") as { result: { sessionId: string } }).result
      .sessionId;
    send(wsA, { id: "2", method: "openSession", params: { sessionId } });
    await waitFor(messagesA, (m) => responseFor(m, "2") !== undefined);

    const wsB = await connect(url);
    const messagesB = collectMessages(wsB);
    send(wsB, { id: "1", method: "openSession", params: { sessionId } });
    await waitFor(messagesB, (m) => responseFor(m, "1") !== undefined);

    send(wsA, { id: "3", method: "prompt", params: { sessionId, text: "hi" } });

    await waitFor(messagesA, (m) => eventsFor(m, sessionId).some((e) => e.type === "runEnd"));
    await waitFor(messagesB, (m) => eventsFor(m, sessionId).some((e) => e.type === "runEnd"));

    expect(eventsFor(messagesA, sessionId).some((e) => e.type === "runStart")).toBe(true);
    expect(eventsFor(messagesB, sessionId).some((e) => e.type === "runStart")).toBe(true);
  });

  it("stops gracefully: closes connections and releases the port", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const { server, url } = await startServer(host);
    const ws = await connect(url);
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));

    await server.stop();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);

    // The port is free again; a fresh server can bind an ephemeral port.
    const other = new ArcturnServer({
      sessionHost: buildSessionHost(createScriptedLLM([textTurn("hi")])),
    });
    servers.push(other);
    const port = await other.start({ host: "127.0.0.1", port: 0 });
    expect(port).toBeGreaterThan(0);
  });
});

/** A turn that streams `count` separate text deltas, one `messageStream` event each. */
function burstTurn(count: number, chunkSize: number): StreamEvent[] {
  const turnUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const chunk = "x".repeat(chunkSize);
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: chunk.repeat(count) }],
    model: TEST_MODEL.model,
    usage: turnUsage,
    stopReason: "endTurn",
    timestamp: Date.now(),
  };
  const events: StreamEvent[] = [
    { type: "start", model: TEST_MODEL.model },
    { type: "textStart", blockIndex: 0 },
  ];
  for (let i = 0; i < count; i++) events.push({ type: "textDelta", blockIndex: 0, delta: chunk });
  events.push(
    { type: "blockEnd", blockIndex: 0 },
    { type: "usage", usage: turnUsage },
    { type: "end", message },
  );
  return events;
}

describe("ArcturnServer DoS limits", () => {
  it("closes with 1009 when a frame exceeds maxPayloadBytes", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const { url } = await startServer(host, undefined, { maxPayloadBytes: 1024 });
    const ws = await connect(url);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

    ws.send(JSON.stringify({ id: "1", method: "listSessions", params: { pad: "x".repeat(5000) } }));

    expect(await closed).toBe(1009);
  });

  it("terminates a connection that misses heartbeat pongs, and cleans up its observer", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const observeSpy: Array<ReturnType<typeof vi.fn>> = [];
    const originalObserve = host.observe.bind(host);
    host.observe = ((sessionId: string, listener: (event: AgentEvent) => void) => {
      const unsubscribe = originalObserve(sessionId, listener);
      const spy = vi.fn(unsubscribe);
      observeSpy.push(spy);
      return spy;
    }) as typeof host.observe;

    const { url } = await startServer(host, undefined, { heartbeatIntervalMs: 30 });
    // `autoPong: false` (ws >= 8.18) makes the client ignore server pings, so
    // it never answers a pong — simulating a dead peer that TCP alone
    // wouldn't notice for a long time.
    const ws = new WebSocket(url, { autoPong: false });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "createSession", params: { cwd: "/tmp/arcturn-ws-test" } });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);
    const sessionId = (responseFor(messages, "1") as { result: { sessionId: string } }).result
      .sessionId;
    send(ws, { id: "2", method: "openSession", params: { sessionId } });
    await waitFor(messages, (m) => responseFor(m, "2") !== undefined);
    expect(observeSpy).toHaveLength(1);

    // The server's own cleanup (which calls `unsubscribe`) and the client's
    // view of the socket closing are two independent async paths — the
    // client can observe `close` before the server has finished its own
    // teardown. Poll the spy directly instead of racing the client's event.
    const start = Date.now();
    while (observeSpy[0]?.mock.calls.length !== 1) {
      if (Date.now() - start > 5000) {
        throw new Error("Timed out waiting for the dead connection's observer to be unsubscribed");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(observeSpy[0]).toHaveBeenCalledTimes(1);
  });

  it("rejects a connection past maxConnections with close code 1013", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const { url } = await startServer(host, undefined, { maxConnections: 1 });

    const first = await connect(url);
    expect(first.readyState).toBe(WebSocket.OPEN);

    const second = new WebSocket(url);
    sockets.push(second);
    const closed = new Promise<number>((resolve) => second.once("close", (code) => resolve(code)));
    second.on("error", () => {
      // A close before the handshake finished can surface as an error too;
      // 'close' is what we assert on.
    });
    expect(await closed).toBe(1013);
  });

  it("drops non-essential event pushes for a backpressured connection but keeps its own responses flowing", async () => {
    // `bufferedAmount` is a getter derived from the real underlying socket;
    // reliably forcing it high without a real slow reader (flaky, OS-buffer-
    // dependent) means stubbing the getter directly — the "test double" the
    // task brief calls out for this case. `ws-server.ts` and this test both
    // reach the same `WebSocket` class via the `ws` package, so patching the
    // prototype affects the server-side connection object too.
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      WebSocket.prototype,
      "bufferedAmount",
    );
    Object.defineProperty(WebSocket.prototype, "bufferedAmount", {
      configurable: true,
      get: () => 10_000_000,
    });
    try {
      const host = buildSessionHost(createScriptedLLM([burstTurn(5, 300)]));
      const { url } = await startServer(host, undefined, {
        backpressureThresholdBytes: 100,
        backpressureSustainedMs: 60_000, // long enough that this test never trips termination
      });
      const ws = await connect(url);
      const messages = collectMessages(ws);

      send(ws, { id: "1", method: "createSession", params: { cwd: "/tmp/arcturn-ws-test" } });
      await waitFor(messages, (m) => responseFor(m, "1") !== undefined);
      const sessionId = (responseFor(messages, "1") as { result: { sessionId: string } }).result
        .sessionId;
      send(ws, { id: "2", method: "openSession", params: { sessionId } });
      await waitFor(messages, (m) => responseFor(m, "2") !== undefined);

      send(ws, { id: "3", method: "prompt", params: { sessionId, text: "go" } });
      await waitFor(messages, (m) => responseFor(m, "3") !== undefined);

      // Every chunk's `messageStream` event was non-essential and the
      // connection looked backpressured for every one of them: none made it.
      const streamed = eventsFor(messages, sessionId).filter((e) => e.type === "messageStream");
      expect(streamed).toHaveLength(0);
      // The prompt's own response — essential — was not dropped.
      expect(responseFor(messages, "3")).toMatchObject({ kind: "response", id: "3" });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(WebSocket.prototype, "bufferedAmount", originalDescriptor);
      }
    }
  });
});

describe("ArcturnServer: forward compatibility of new verbs", () => {
  // The contract every *optional* verb depends on, `listModels` first among
  // them: a server that does not know a method answers `invalidRequest` and
  // keeps talking, so a newer client can ask, be told no, and carry on. If
  // this ever changed to a connection close, every new-client/old-server pair
  // would break instead of degrading.
  it("refuses a method it does not know with invalidRequest, and stays usable", async () => {
    const host = buildSessionHost(createScriptedLLM([textTurn("hi")]));
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "aVerbFromTheFuture" });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);
    expect(responseFor(messages, "1")).toMatchObject({
      kind: "response",
      id: "1",
      error: { code: "invalidRequest", message: 'Unknown method: "aVerbFromTheFuture"' },
    });

    send(ws, { id: "2", method: "listSessions" });
    await waitFor(messages, (m) => responseFor(m, "2") !== undefined);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("ArcturnServer: listModels", () => {
  it("answers with the host's model catalog", async () => {
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "You are a test agent.",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-ws-test",
      modelCatalog: () => [
        {
          id: "anthropic/claude-sonnet-5",
          provider: "anthropic",
          displayName: "Claude Sonnet 5",
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          cost: { input: 2, output: 10 },
          apiKeyEnv: "ANTHROPIC_API_KEY",
          credentials: "present" as const,
        },
      ],
    });
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "listModels" });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);

    expect(responseFor(messages, "1")).toMatchObject({
      kind: "response",
      id: "1",
      result: {
        models: [
          {
            id: "anthropic/claude-sonnet-5",
            displayName: "Claude Sonnet 5",
            contextWindow: 1_000_000,
            cost: { input: 2, output: 10 },
            apiKeyEnv: "ANTHROPIC_API_KEY",
            credentials: "present",
          },
        ],
      },
    });
  });

  it("never puts a credential value on the wire, only the variable's name", async () => {
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "You are a test agent.",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-ws-test",
      modelCatalog: () => [
        {
          id: "anthropic/claude-sonnet-5",
          provider: "anthropic",
          displayName: "Claude Sonnet 5",
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          apiKeyEnv: "ANTHROPIC_API_KEY",
          credentials: "present" as const,
          // A host that wrongly hands over a secret must not have it forwarded.
          apiKey: "sk-live-should-never-ship",
        } as ModelCatalogEntry,
      ],
    });
    const { url } = await startServer(host);
    const ws = await connect(url);
    const messages = collectMessages(ws);

    send(ws, { id: "1", method: "listModels" });
    await waitFor(messages, (m) => responseFor(m, "1") !== undefined);

    expect(responseFor(messages, "1")).toMatchObject({
      result: { models: [{ id: "anthropic/claude-sonnet-5", apiKeyEnv: "ANTHROPIC_API_KEY" }] },
    });
    expect(JSON.stringify(responseFor(messages, "1"))).not.toContain("sk-live-should-never-ship");
  });
});
