import { describe, expect, it, vi } from "vitest";
import { connectToServe } from "../serve/connect.js";
import type { AgentEvent, PermissionRequest, ProtocolClient } from "../serve/engine.js";
import { FakeSocket, flush } from "../serve/test-socket.js";
import type { ChatViewModel } from "./chat-state.js";
import { createSessionController, type SessionController } from "./controller.js";
import type { CostState } from "./cost.js";
import type { PermissionAnswer } from "./permission-queue.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SESSION = "session-1";

interface Harness {
  socket: FakeSocket;
  client: ProtocolClient;
  controller: SessionController;
  chats: ChatViewModel[];
  costs: CostState[];
  asked: PermissionRequest[];
  askedArgs: (Record<string, unknown> | undefined)[];
  diagnostics: string[];
}

async function harness(
  answer: (request: PermissionRequest) => Promise<PermissionAnswer> = async () => ({
    behavior: "allow",
  }),
): Promise<Harness> {
  const socket = new FakeSocket({ autoRespond: true });
  const chats: ChatViewModel[] = [];
  const costs: CostState[] = [];
  const asked: PermissionRequest[] = [];
  const askedArgs: (Record<string, unknown> | undefined)[] = [];
  const diagnostics: string[] = [];
  const client = await connectToServe({
    connectUrl: `ws://127.0.0.1:1#token=${TOKEN}`,
    socketFactory: () => socket,
    onDiagnostic: (line) => diagnostics.push(line),
  });
  await flush();
  const controller = createSessionController({
    client,
    sessionId: SESSION,
    host: {
      onChat: (view) => chats.push(view),
      onCost: (cost) => costs.push(cost),
      askPermission: (request, args) => {
        asked.push(request);
        askedArgs.push(args);
        return answer(request);
      },
      onDiagnostic: (line) => diagnostics.push(line),
    },
  });
  return { socket, client, controller, chats, costs, asked, askedArgs, diagnostics };
}

function emit(h: Harness, event: AgentEvent, sessionId = SESSION): void {
  h.socket.emitEvent(sessionId, event);
}

const permissionRequest: PermissionRequest = {
  id: "req-1",
  toolName: "bash",
  toolCallId: "call-1",
  subject: "rm -rf build",
  description: "Run a shell command",
};

describe("the protocol handshake", () => {
  it("sends authenticate as the very first frame, with the token from the fragment", async () => {
    const h = await harness();
    expect(h.socket.frame(0).method).toBe("authenticate");
    expect(h.socket.frame(0).params?.token).toBe(TOKEN);
  });
});

describe("event fan-out", () => {
  it("reduces this session's events into the chat view", async () => {
    const h = await harness();
    emit(h, {
      type: "runStart",
      sessionId: SESSION,
      prompt: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    });
    emit(h, { type: "messageStream", event: { type: "textStart", blockIndex: 0 } });
    emit(h, { type: "messageStream", event: { type: "textDelta", blockIndex: 0, delta: "hi" } });
    const view = h.chats.at(-1);
    expect(view?.running).toBe(true);
    expect(view?.blocks.map((block) => block.kind)).toEqual(["user", "text"]);
  });

  it("ignores events belonging to another session on the same connection", async () => {
    const h = await harness();
    emit(h, { type: "notice", level: "info", text: "not mine" }, "other-session");
    expect(h.chats).toHaveLength(0);
  });

  it("does not re-post the view for an event that changed nothing", async () => {
    const h = await harness();
    emit(h, { type: "turnStart", turnIndex: 0 });
    expect(h.chats).toHaveLength(0);
  });

  it("accumulates spend from turnEnd", async () => {
    const h = await harness();
    emit(h, {
      type: "turnEnd",
      turnIndex: 0,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.42,
      },
    });
    expect(h.costs.at(-1)?.costUsd).toBeCloseTo(0.42, 10);
  });

  it("remembers the models the engine announced, for the model picker", async () => {
    const h = await harness();
    emit(h, { type: "messageStream", event: { type: "start", model: "anthropic/x" } });
    emit(h, { type: "messageStream", event: { type: "start", model: "anthropic/x" } });
    emit(h, { type: "messageStream", event: { type: "start", model: "openai/y" } });
    expect(h.controller.observedModels).toEqual(["anthropic/x", "openai/y"]);
  });
});

describe("the permission round trip", () => {
  it("answers a permissionRequest event through respondToPermission", async () => {
    const h = await harness();
    emit(h, { type: "permissionRequest", request: permissionRequest });
    await h.controller.permissions.drain();
    const frame = h.socket.lastFrame("permissionDecision");
    expect(frame?.params).toEqual({
      sessionId: SESSION,
      decision: { requestId: "req-1", behavior: "allow" },
    });
    expect(h.asked[0]).toEqual(permissionRequest);
  });

  it("hands the dialog the arguments the engine sent on toolStart", async () => {
    const h = await harness();
    emit(h, {
      type: "toolStart",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "rm -rf build" },
    });
    emit(h, { type: "permissionRequest", request: permissionRequest });
    await h.controller.permissions.drain();
    expect(h.askedArgs[0]).toEqual({ command: "rm -rf build" });
  });

  it("sends a denial when the dialog denies", async () => {
    const h = await harness(async () => ({ behavior: "deny", message: "no" }));
    emit(h, { type: "permissionRequest", request: permissionRequest });
    await h.controller.permissions.drain();
    expect(h.socket.lastFrame("permissionDecision")?.params?.decision).toEqual({
      requestId: "req-1",
      behavior: "deny",
      message: "no",
    });
  });

  it("denies rather than hangs when the sidebar is disposed mid-dialog", async () => {
    const h = await harness(async () => new Promise<PermissionAnswer>(() => {}));
    emit(h, { type: "permissionRequest", request: permissionRequest });
    h.controller.dispose();
    await h.controller.permissions.drain();
    const decision = h.socket.lastFrame("permissionDecision")?.params?.decision as {
      behavior: string;
    };
    expect(decision.behavior).toBe("deny");
  });
});

describe("sending", () => {
  it("prompts when idle", async () => {
    const h = await harness();
    void h.controller.send("do the thing");
    await flush();
    expect(h.socket.lastFrame("prompt")?.params).toEqual({
      sessionId: SESSION,
      text: "do the thing",
    });
  });

  it("steers mid-run", async () => {
    const h = await harness();
    emit(h, {
      type: "runStart",
      sessionId: SESSION,
      prompt: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
    });
    void h.controller.send("actually, stop at the tests");
    await flush();
    expect(h.socket.lastFrame("steer")?.params).toEqual({
      sessionId: SESSION,
      text: "actually, stop at the tests",
    });
    expect(h.socket.lastFrame("prompt")).toBeUndefined();
  });

  it("does not make the caller wait for the whole run", async () => {
    // A server that answers nothing: `prompt()` would stay pending for the
    // length of the run, and the prompt box must not be stuck behind it.
    const socket = new FakeSocket();
    const client = await connectToServe({
      connectUrl: "ws://127.0.0.1:1",
      socketFactory: () => socket,
    });
    const controller = createSessionController({
      client,
      sessionId: SESSION,
      host: {
        onChat: () => {},
        onCost: () => {},
        askPermission: async () => ({ behavior: "deny" }),
      },
    });
    let settled = false;
    void controller.send("go").then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(true);
    expect(socket.lastFrame("prompt")?.params).toEqual({ sessionId: SESSION, text: "go" });
  });

  it("aborts", async () => {
    const h = await harness();
    void h.controller.abort();
    await flush();
    expect(h.socket.lastFrame("abort")?.params).toEqual({ sessionId: SESSION });
  });

  it("switches model", async () => {
    const h = await harness();
    void h.controller.setModel("anthropic/z");
    await flush();
    expect(h.socket.lastFrame("setModel")?.params).toEqual({
      sessionId: SESSION,
      model: "anthropic/z",
    });
  });
});

describe("disposal", () => {
  it("stops listening, so a late event cannot repaint a dead view", async () => {
    const h = await harness();
    h.controller.dispose();
    emit(h, { type: "notice", level: "info", text: "too late" });
    expect(h.chats).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const h = await harness();
    h.controller.dispose();
    expect(() => h.controller.dispose()).not.toThrow();
  });
});

describe("the token", () => {
  it("never reaches a diagnostic, however the engine misbehaves", async () => {
    const h = await harness();
    h.socket.emit("}{ not json");
    h.socket.emit({ kind: "response", id: `unknown-${TOKEN}` });
    h.socket.emit({ kind: "event", sessionId: SESSION, event: { type: "nonsense" } });
    await flush();
    expect(h.diagnostics.length).toBeGreaterThan(0);
    expect(h.diagnostics.join("\n")).not.toContain(TOKEN);
  });

  it("never reaches the chat view either", async () => {
    const h = await harness();
    emit(h, { type: "notice", level: "info", text: "connected" });
    expect(JSON.stringify(h.chats)).not.toContain(TOKEN);
  });

  it("is not in the diagnostic a failing send produces", async () => {
    const h = await harness();
    h.socket.emitClose(1006);
    await h.controller.send("hello");
    await flush();
    expect(h.diagnostics.length).toBeGreaterThan(0);
    expect(h.diagnostics.join("\n")).not.toContain(TOKEN);
  });
});

describe("a listener that throws", () => {
  it("is reported and does not break the socket", async () => {
    const socket = new FakeSocket();
    const client = await connectToServe({
      connectUrl: "ws://127.0.0.1:1",
      socketFactory: () => socket,
    });
    const onChat = vi.fn(() => {
      throw new Error("render failed");
    });
    createSessionController({
      client,
      sessionId: SESSION,
      host: {
        onChat,
        onCost: () => {},
        askPermission: async () => ({ behavior: "deny" }),
      },
    });
    socket.emitEvent(SESSION, { type: "notice", level: "info", text: "a" });
    socket.emitEvent(SESSION, { type: "notice", level: "info", text: "b" });
    expect(onChat).toHaveBeenCalledTimes(2);
  });
});
