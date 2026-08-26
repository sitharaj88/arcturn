import { describe, expect, it, vi } from "vitest";
import { connectToServe } from "../serve/connect.js";
import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequest,
  ProtocolClient,
  SessionHistory,
} from "../serve/engine.js";
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
  /** Every decision the queue committed, in order, as the host was told. */
  decided: PermissionDecision[];
  diagnostics: string[];
}

async function harness(
  answer: (request: PermissionRequest) => Promise<PermissionAnswer> = async () => ({
    behavior: "allow",
  }),
  autoRespond: boolean | ((frame: { method: string }) => unknown) = true,
): Promise<Harness> {
  const socket = new FakeSocket({ autoRespond });
  const chats: ChatViewModel[] = [];
  const costs: CostState[] = [];
  const asked: PermissionRequest[] = [];
  const askedArgs: (Record<string, unknown> | undefined)[] = [];
  const decided: PermissionDecision[] = [];
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
      onPermissionDecision: (decision) => decided.push(decision),
      onDiagnostic: (line) => diagnostics.push(line),
    },
  });
  return { socket, client, controller, chats, costs, asked, askedArgs, decided, diagnostics };
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

  it("denies rather than hangs when the sidebar is disposed mid-prompt", async () => {
    const h = await harness(async () => new Promise<PermissionAnswer>(() => {}));
    emit(h, { type: "permissionRequest", request: permissionRequest });
    h.controller.dispose();
    await h.controller.permissions.drain();
    const decision = h.socket.lastFrame("permissionDecision")?.params?.decision as {
      behavior: string;
    };
    expect(decision.behavior).toBe("deny");
  });

  it("tells the host about every decision, so an on-screen card can come down", async () => {
    const h = await harness();
    emit(h, { type: "permissionRequest", request: permissionRequest });
    await h.controller.permissions.drain();
    expect(h.decided).toEqual([{ requestId: "req-1", behavior: "allow" }]);
  });

  it("tells the host about the denials a disposal sends, which never pass through the prompt", async () => {
    // The path a card would otherwise be stranded on: the sidebar closes, the
    // session is switched, or the connection drops — the queue answers the
    // engine and `askPermission` never resolves at all.
    const h = await harness(async () => new Promise<PermissionAnswer>(() => {}));
    emit(h, { type: "permissionRequest", request: permissionRequest });
    emit(h, {
      type: "permissionRequest",
      request: { ...permissionRequest, id: "req-2", toolCallId: "call-2" },
    });
    h.controller.dispose();
    await h.controller.permissions.drain();
    expect(h.decided.map((decision) => [decision.requestId, decision.behavior])).toEqual([
      ["req-1", "deny"],
      ["req-2", "deny"],
    ]);
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

describe("createSessionController: replayed history", () => {
  const REPLAY: SessionHistory = {
    sessionId: SESSION,
    events: [
      {
        type: "runStart",
        sessionId: SESSION,
        prompt: {
          role: "user",
          content: [{ type: "text", text: "the old question" }],
          timestamp: 1,
        },
      },
      {
        type: "messageEnd",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the old answer" }],
          model: "test/model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "endTurn",
          timestamp: 2,
        },
      },
      { type: "runEnd", reason: "completed" },
    ],
    truncated: false,
    droppedEvents: 0,
  };

  async function seeded(history: SessionHistory): Promise<Harness> {
    const h = await harness();
    h.controller.dispose();
    const controller = createSessionController({
      client: h.client,
      sessionId: SESSION,
      host: {
        onChat: (view) => h.chats.push(view),
        onCost: (cost) => h.costs.push(cost),
        askPermission: async () => ({ behavior: "allow" }),
        onDiagnostic: (line) => h.diagnostics.push(line),
      },
      history,
    });
    return { ...h, controller };
  }

  it("builds the transcript through the same reducer live events use", async () => {
    const h = await seeded(REPLAY);
    expect(h.controller.state.blocks.map((block) => block.kind)).toEqual(["user", "text"]);
    expect(h.controller.state.blocks.map((block) => ("text" in block ? block.text : ""))).toEqual([
      "the old question",
      "the old answer",
    ]);
    // Stored history is never in flight, whatever the replay's last event was.
    expect(h.controller.state.running).toBe(false);
  });

  it("keeps folding live events on top of the replay", async () => {
    const h = await seeded(REPLAY);
    emit(h, { type: "notice", level: "info", text: "something new" });
    expect(h.controller.state.blocks.at(-1)).toMatchObject({
      kind: "notice",
      text: "something new",
    });
    expect(h.controller.state.blocks).toHaveLength(3);
  });

  it("says earlier messages are not shown when the engine truncated the replay", async () => {
    const h = await seeded({ ...REPLAY, truncated: true, droppedEvents: 128 });
    const first = h.controller.state.blocks[0];
    expect(first).toMatchObject({ kind: "notice", level: "info" });
    expect("text" in (first ?? {}) ? (first as { text: string }).text : "").toContain(
      "Earlier messages are not shown",
    );
    expect("text" in (first ?? {}) ? (first as { text: string }).text : "").toContain("128");
  });

  it("never claims a run is in progress just because history ended mid-turn", async () => {
    const h = await seeded({ ...REPLAY, events: [REPLAY.events[0] as AgentEvent] });
    expect(h.controller.state.running).toBe(false);
  });

  it("starts empty when there is no history to replay", async () => {
    const h = await harness();
    expect(h.controller.state.blocks).toEqual([]);
  });

  it("rebuilds a stored tool call as a finished tool row, with no new client logic", async () => {
    // The engine replays `messageEnd` (carrying the tool call) then `toolEnd`
    // (carrying its result), which is the same pair the live stream sends —
    // so `reduceChat` pairs them the same way and this file needed no branch.
    const h = await seeded({
      sessionId: SESSION,
      truncated: false,
      droppedEvents: 0,
      events: [
        {
          type: "messageEnd",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
            model: "test/model",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "toolCalls",
            timestamp: 1,
          },
        },
        {
          type: "toolEnd",
          toolCallId: "tc1",
          result: {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "bash",
            content: [{ type: "text", text: "README.md" }],
            isError: false,
            timestamp: 2,
          },
        },
        { type: "runEnd", reason: "completed" },
      ],
    });

    expect(h.controller.state.blocks).toMatchObject([
      { kind: "tool", toolCallId: "tc1", name: "bash", status: "ok", result: "README.md" },
    ]);
  });
});

/**
 * A harness that leaves one method unanswered, so a test can hand the client
 * the exact response — or the exact rejection — it is about. `FakeSocket`'s
 * `autoRespond` answers everything with `{}`, which is what the suites above
 * want and precisely what a test about a *parsed* result cannot use.
 */
function unanswered(method: string): Parameters<typeof harness>[1] {
  return (frame) => (frame.method === method ? undefined : {});
}

/** Reject the last frame the way `ws-server.ts` does. */
function rejectLast(h: Harness, code: string, message: string): void {
  const frames = h.socket.frames();
  const last = frames[frames.length - 1];
  h.socket.emit({ kind: "response", id: last?.id, error: { code, message } });
}

describe("the permission verbs RFC 0005 §1.2 added", () => {
  const state = {
    sessionId: SESSION,
    mode: "plan",
    rules: [],
    tools: ["read", "fetch"],
  };

  it("reads the session's mode and tool set through permissionState", async () => {
    const h = await harness(undefined, unanswered("permissionState"));
    const promise = h.controller.permissionState();
    await flush();
    expect(h.socket.lastFrame("permissionState")?.params).toEqual({ sessionId: SESSION });
    h.socket.respondOk(h.socket.frames().length - 1, state);
    expect(await promise).toMatchObject({ mode: "plan", tools: ["read", "fetch"] });
  });

  it("reports an engine too old for the verb as nothing known, never as default", async () => {
    const h = await harness(undefined, unanswered("permissionState"));
    const promise = h.controller.permissionState();
    await flush();
    rejectLast(h, "invalidRequest", 'Unknown method: "permissionState"');
    expect(await promise).toBeUndefined();
  });

  it("asks the engine to change mode and returns what the engine says it now is", async () => {
    const h = await harness(undefined, unanswered("setPermissionMode"));
    const promise = h.controller.setPermissionMode("yolo");
    await flush();
    expect(h.socket.lastFrame("setPermissionMode")?.params).toEqual({
      sessionId: SESSION,
      mode: "yolo",
    });
    h.socket.respondOk(h.socket.frames().length - 1, { ...state, mode: "yolo" });
    expect((await promise).mode).toBe("yolo");
  });

  it("rejects rather than degrading when the engine is too old to change modes", async () => {
    const h = await harness(undefined, unanswered("setPermissionMode"));
    const promise = h.controller.setPermissionMode("plan");
    await flush();
    rejectLast(h, "invalidRequest", 'Unknown method: "setPermissionMode"');
    // A chip showing `plan` over a session still in `yolo` is the failure this
    // refusal exists to prevent, so the caller is told, not reassured.
    await expect(promise).rejects.toThrow(/setPermissionMode/);
  });

  it("passes a mid-run refusal through rather than swallowing it", async () => {
    const h = await harness(undefined, unanswered("setPermissionMode"));
    const promise = h.controller.setPermissionMode("plan");
    await flush();
    rejectLast(h, "sessionBusy", "A run is in flight");
    await expect(promise).rejects.toThrow(/run is in flight/);
  });
});

describe("allow for this session", () => {
  it("sends the engine's own suggested rule, session-scoped, with the scope named", async () => {
    const h = await harness(async () => ({
      behavior: "allow",
      persistRule: { tool: "bash", specifier: "git *", action: "allow", scope: "session" },
    }));
    emit(h, {
      type: "permissionRequest",
      request: {
        ...permissionRequest,
        suggestedRule: { tool: "bash", specifier: "git *", action: "allow" },
      },
    });
    await h.controller.permissions.drain();
    expect(h.socket.lastFrame("permissionDecision")?.params).toEqual({
      sessionId: SESSION,
      decision: {
        requestId: "req-1",
        behavior: "allow",
        persistRule: { tool: "bash", specifier: "git *", action: "allow", scope: "session" },
      },
      scope: "session",
    });
  });

  it("names no scope for a plain one-off allow", async () => {
    const h = await harness();
    emit(h, { type: "permissionRequest", request: permissionRequest });
    await h.controller.permissions.drain();
    expect(h.socket.lastFrame("permissionDecision")?.params).not.toHaveProperty("scope");
  });
});
