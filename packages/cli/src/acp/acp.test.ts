import { PassThrough } from "node:stream";
import type {
  AgentEvent,
  AssistantMessage,
  PermissionMode,
  PermissionRequest,
  Usage,
} from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import {
  ACP_PROTOCOL_VERSION,
  type AcpAgentDeps,
  type AcpClientCapabilities,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  createAcpAgent,
  NO_CLIENT_CAPABILITIES,
  parseClientCapabilities,
  promptBlocksToText,
  toolKindFor,
} from "./adapter.js";
import {
  AcpConnection,
  ContentLengthFrameDecoder,
  encodeContentLength,
  encodeNdjson,
  JSON_RPC_ERRORS,
  NdjsonFrameDecoder,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

describe("NdjsonFrameDecoder", () => {
  it("round-trips a message through encode and decode", () => {
    const decoder = new NdjsonFrameDecoder();
    const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } };
    expect(decoder.push(encodeNdjson(message))).toEqual([message]);
  });

  it("reassembles one message split across many chunks", () => {
    const decoder = new NdjsonFrameDecoder();
    const frame = encodeNdjson({ jsonrpc: "2.0", method: "session/cancel", params: { a: 1 } });
    const collected: unknown[] = [];
    for (let i = 0; i < frame.length; i += 1) {
      collected.push(...decoder.push(frame.subarray(i, i + 1)));
    }
    expect(collected).toEqual([{ jsonrpc: "2.0", method: "session/cancel", params: { a: 1 } }]);
  });

  it("drains many messages coalesced into one chunk", () => {
    const decoder = new NdjsonFrameDecoder();
    const chunk = Buffer.concat([
      encodeNdjson({ id: 1 }),
      encodeNdjson({ id: 2 }),
      encodeNdjson({ id: 3 }),
    ]);
    expect(decoder.push(chunk)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("holds back a trailing partial line until its newline arrives", () => {
    const decoder = new NdjsonFrameDecoder();
    expect(decoder.push('{"id":1}\n{"id":')).toEqual([{ id: 1 }]);
    expect(decoder.push("2}\n")).toEqual([{ id: 2 }]);
  });

  it("skips blank lines, CRLF endings and unparsable lines without wedging", () => {
    const decoder = new NdjsonFrameDecoder();
    const messages = decoder.push('\n{"ok":1}\r\nnot json at all\n\n{"ok":2}\n');
    expect(messages).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it("never emits a frame containing an embedded newline", () => {
    const frame = encodeNdjson({ text: "line one\nline two" }).toString("utf8");
    expect(frame.indexOf("\n")).toBe(frame.length - 1);
  });
});

describe("ContentLengthFrameDecoder", () => {
  it("round-trips and tolerates split chunks", () => {
    const decoder = new ContentLengthFrameDecoder();
    const frame = encodeContentLength({ id: 7, method: "ping" });
    expect(decoder.push(frame.subarray(0, 10))).toEqual([]);
    expect(decoder.push(frame.subarray(10))).toEqual([{ id: 7, method: "ping" }]);
  });

  it("drops a header block with no Content-Length and keeps scanning", () => {
    const decoder = new ContentLengthFrameDecoder();
    const chunk = Buffer.concat([
      Buffer.from("Bogus-Header: 1\r\n\r\n", "utf8"),
      encodeContentLength({ id: 2 }),
    ]);
    expect(decoder.push(chunk)).toEqual([{ id: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// Test harness: two connections wired over in-memory duplex streams
// ---------------------------------------------------------------------------

interface Peers {
  agent: AcpConnection;
  client: AcpConnection;
  /** Every `session/update` the agent sent, in order. */
  updates: AcpSessionUpdate[];
  /** Raw bytes the agent wrote, for framing assertions. */
  rawAgentOutput: () => string;
  clientToAgent: PassThrough;
}

function createPeers(options: { onError?: (e: Error) => void } = {}): Peers {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();

  let raw = "";
  agentToClient.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });

  const agent = new AcpConnection({
    input: clientToAgent,
    output: agentToClient,
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const client = new AcpConnection({ input: agentToClient, output: clientToAgent });

  const updates: AcpSessionUpdate[] = [];
  client.onNotification("session/update", (params) => {
    updates.push((params as AcpSessionNotification).update);
  });

  agent.listen();
  client.listen();
  return { agent, client, updates, rawAgentOutput: () => raw, clientToAgent };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function stubDeps(overrides: Partial<AcpAgentDeps> = {}): AcpAgentDeps {
  return {
    prompt: async () => {},
    abort: () => {},
    createSessionId: (() => {
      let n = 0;
      return () => `sess_test_${++n}`;
    })(),
    ...overrides,
  };
}

async function handshake(
  client: AcpConnection,
): Promise<{ init: AcpInitializeResult; sessionId: string }> {
  const init = (await client.sendRequest("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "zed", version: "1.0.0" },
  })) as AcpInitializeResult;
  const session = (await client.sendRequest("session/new", {
    cwd: "/repo",
    mcpServers: [],
  })) as AcpNewSessionResult;
  return { init, sessionId: session.sessionId };
}

// ---------------------------------------------------------------------------
// Connection behaviour
// ---------------------------------------------------------------------------

describe("AcpConnection", () => {
  it("dispatches an inbound request to its handler and answers it", async () => {
    const { agent, client } = createPeers();
    agent.onRequest("echo", (params) => ({ got: params }));
    await expect(client.sendRequest("echo", { a: 1 })).resolves.toEqual({ got: { a: 1 } });
  });

  it("answers an unregistered method with -32601", async () => {
    const { client } = createPeers();
    await expect(client.sendRequest("session/set_mode", {})).rejects.toMatchObject({
      code: JSON_RPC_ERRORS.methodNotFound,
    });
  });

  it("turns a throwing handler into an error response instead of crashing", async () => {
    const { agent, client } = createPeers();
    agent.onRequest("boom", () => {
      throw new Error("handler exploded");
    });
    await expect(client.sendRequest("boom", {})).rejects.toMatchObject({
      code: JSON_RPC_ERRORS.internalError,
      message: "handler exploded",
    });
  });

  it("delivers notifications and never answers them", async () => {
    const { agent, client, rawAgentOutput } = createPeers();
    const seen = deferred<unknown>();
    agent.onNotification("session/cancel", (params) => seen.resolve(params));
    client.sendNotification("session/cancel", { sessionId: "s1" });
    await expect(seen.promise).resolves.toEqual({ sessionId: "s1" });
    expect(rawAgentOutput()).toBe("");
  });

  it("ignores unknown notifications", async () => {
    const { agent, client, rawAgentOutput } = createPeers();
    agent.onRequest("ping", () => "pong");
    client.sendNotification("some/unknown", {});
    await expect(client.sendRequest("ping", {})).resolves.toBe("pong");
    expect(rawAgentOutput()).toContain("pong");
  });

  it("survives malformed frames and still serves the next valid request", async () => {
    const errors: Error[] = [];
    const { agent, client, clientToAgent } = createPeers({ onError: (e) => errors.push(e) });
    agent.onRequest("ping", () => "pong");

    clientToAgent.write("this is not json\n");
    clientToAgent.write("{ broken\n");
    clientToAgent.write(`${JSON.stringify([1, 2, 3])}\n`); // valid JSON, not an object
    clientToAgent.write(`${JSON.stringify({ jsonrpc: "2.0" })}\n`); // no method, no id
    clientToAgent.write(`${JSON.stringify({ jsonrpc: "2.0", id: 999, result: null })}\n`); // orphan

    await expect(client.sendRequest("ping", {})).resolves.toBe("pong");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects in-flight requests when disposed", async () => {
    // No peer is reading this output, so the request stays in flight.
    const conn = new AcpConnection({ input: new PassThrough(), output: new PassThrough() });
    const pending = conn.sendRequest("never/answered", {});
    conn.dispose(new Error("stream closed"));
    await expect(pending).rejects.toThrow("stream closed");
    await expect(conn.sendRequest("anything")).rejects.toThrow("closed");
  });

  it("writes NDJSON by default and Content-Length when asked", () => {
    const out = new PassThrough();
    let bytes = "";
    out.on("data", (c: Buffer) => {
      bytes += c.toString("utf8");
    });
    const conn = new AcpConnection({
      input: new PassThrough(),
      output: out,
      framing: "content-length",
    });
    conn.sendNotification("hello", { a: 1 });
    expect(bytes.startsWith("Content-Length: ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: initialize → session/new → session/prompt
// ---------------------------------------------------------------------------

describe("createAcpAgent lifecycle", () => {
  it("answers initialize with the spec's capability shape", async () => {
    const { agent, client } = createPeers();
    createAcpAgent(
      stubDeps({ agentInfo: { name: "arcturn", title: "Arcturn", version: "0.1.0" } }),
    ).attach(agent);

    const { init } = await handshake(client);
    expect(init).toEqual({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: "arcturn", title: "Arcturn", version: "0.1.0" },
      authMethods: [],
    });
  });

  it("negotiates down to the client's protocol version", async () => {
    const { agent, client } = createPeers();
    createAcpAgent(stubDeps()).attach(agent);
    const init = (await client.sendRequest("initialize", {
      protocolVersion: 0,
    })) as AcpInitializeResult;
    expect(init.protocolVersion).toBe(0);
  });

  it("advertises and serves session/load only when the host supplies it", async () => {
    const withoutLoad = createPeers();
    createAcpAgent(stubDeps()).attach(withoutLoad.agent);
    await expect(
      withoutLoad.client.sendRequest("session/load", { sessionId: "s", cwd: "/repo" }),
    ).rejects.toMatchObject({ code: JSON_RPC_ERRORS.methodNotFound });

    const withLoad = createPeers();
    createAcpAgent(
      stubDeps({
        loadSession: async (_params, replay) => {
          replay({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } });
        },
      }),
    ).attach(withLoad.agent);
    const init = (await withLoad.client.sendRequest("initialize", {
      protocolVersion: 1,
    })) as AcpInitializeResult;
    expect(init.agentCapabilities.loadSession).toBe(true);
    await expect(
      withLoad.client.sendRequest("session/load", { sessionId: "sess_prior", cwd: "/repo" }),
    ).resolves.toBeNull();
    expect(withLoad.updates).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
    ]);
  });

  it("advertises and serves session/set_mode only when the host supplies both mode hooks", async () => {
    const withoutModes = createPeers();
    createAcpAgent(stubDeps()).attach(withoutModes.agent);
    const { sessionId: plainSessionId } = await handshake(withoutModes.client);
    await expect(
      withoutModes.client.sendRequest("session/set_mode", {
        sessionId: plainSessionId,
        modeId: "yolo",
      }),
    ).rejects.toMatchObject({ code: JSON_RPC_ERRORS.methodNotFound });

    const withModes = createPeers();
    const setPermissionMode = vi.fn();
    createAcpAgent(
      stubDeps({
        getPermissionMode: () => "default",
        setPermissionMode,
      }),
    ).attach(withModes.agent);
    await withModes.client.sendRequest("initialize", { protocolVersion: 1 });
    const session = (await withModes.client.sendRequest("session/new", {
      cwd: "/repo",
    })) as AcpNewSessionResult;
    expect(session.modes).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "plan", name: "Plan", description: expect.any(String) },
        { id: "default", name: "Default", description: expect.any(String) },
        { id: "acceptEdits", name: "Accept Edits", description: expect.any(String) },
        { id: "yolo", name: "Yolo", description: expect.any(String) },
      ],
    });

    await expect(
      withModes.client.sendRequest("session/set_mode", {
        sessionId: session.sessionId,
        modeId: "yolo",
      }),
    ).resolves.toBeNull();
    expect(setPermissionMode).toHaveBeenCalledWith(session.sessionId, "yolo");

    await expect(
      withModes.client.sendRequest("session/set_mode", {
        sessionId: session.sessionId,
        modeId: "not-a-real-mode",
      }),
    ).rejects.toMatchObject({ code: JSON_RPC_ERRORS.invalidParams });

    await expect(
      withModes.client.sendRequest("session/set_mode", { sessionId: "ghost", modeId: "yolo" }),
    ).rejects.toMatchObject({ code: JSON_RPC_ERRORS.invalidParams });
  });

  it("mints a session id and hands cwd + mcpServers to the host", async () => {
    const createSession = vi.fn();
    const { agent, client } = createPeers();
    const acp = createAcpAgent(stubDeps({ createSession }));
    acp.attach(agent);
    const { sessionId } = await handshake(client);
    expect(sessionId).toBe("sess_test_1");
    expect(acp.sessionIds).toEqual(["sess_test_1"]);
    expect(createSession).toHaveBeenCalledWith({ cwd: "/repo", mcpServers: [] }, "sess_test_1");
  });

  it("rejects session/prompt for an unknown session with -32602", async () => {
    const { agent, client } = createPeers();
    createAcpAgent(stubDeps()).attach(agent);
    await expect(
      client.sendRequest("session/prompt", { sessionId: "nope", prompt: [] }),
    ).rejects.toMatchObject({ code: JSON_RPC_ERRORS.invalidParams });
  });

  it("flattens text and embedded-resource prompt blocks into arcturn's prompt text", async () => {
    const seen = deferred<string>();
    const { agent, client } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (request) => {
          seen.resolve(request.text);
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "Explain this" },
        { type: "resource", resource: { uri: "file:///a.ts", text: "const a = 1;" } },
      ],
    });
    await expect(seen.promise).resolves.toBe(
      'Explain this\n\n<file uri="file:///a.ts">\nconst a = 1;\n</file>',
    );
  });
});

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

const SCRIPT: AgentEvent[] = [
  { type: "runStart", sessionId: "s", prompt: { role: "user", content: [], timestamp: 0 } },
  { type: "turnStart", turnIndex: 0 },
  { type: "messageStream", event: { type: "textStart", blockIndex: 0 } },
  { type: "messageStream", event: { type: "textDelta", blockIndex: 0, delta: "Hello " } },
  { type: "messageStream", event: { type: "thinkingDelta", blockIndex: 1, delta: "hmm" } },
  { type: "messageStream", event: { type: "textDelta", blockIndex: 0, delta: "world" } },
  { type: "toolStart", toolCallId: "t1", toolName: "read", input: { path: "/repo/a.ts", line: 3 } },
  { type: "toolUpdate", toolCallId: "t1", update: { text: "scanning..." } },
  {
    type: "toolEnd",
    toolCallId: "t1",
    result: {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "const a = 1;" }],
      isError: false,
      details: { bytes: 12 },
      timestamp: 0,
    },
  },
  {
    type: "todoUpdate",
    todos: [
      { id: "1", text: "Read the file", status: "done" },
      { id: "2", text: "Fix the bug", status: "inProgress" },
    ],
  },
  { type: "runEnd", reason: "completed" },
];

describe("arcturn AgentEvent → ACP session/update mapping", () => {
  it("produces the expected ordered notifications and an end_turn stop reason", async () => {
    const { agent, client, updates } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_request, onEvent) => {
          for (const event of SCRIPT) onEvent(event);
        },
      }),
    ).attach(agent);

    const { sessionId } = await handshake(client);
    const result = (await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    })) as AcpPromptResult;

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read: /repo/a.ts",
        kind: "read",
        status: "pending",
        rawInput: { path: "/repo/a.ts", line: 3 },
        locations: [{ path: "/repo/a.ts", line: 3 }],
      },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "scanning..." } }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "const a = 1;" } }],
        rawOutput: { bytes: 12 },
      },
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the file", priority: "medium", status: "completed" },
          { content: "Fix the bug", priority: "medium", status: "in_progress" },
        ],
      },
    ]);
  });

  it("marks a failed tool call as failed", async () => {
    const { agent, client, updates } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent({
            type: "toolStart",
            toolCallId: "t9",
            toolName: "bash",
            input: { command: "ls" },
          });
          onEvent({
            type: "toolEnd",
            toolCallId: "t9",
            result: {
              role: "toolResult",
              toolCallId: "t9",
              toolName: "bash",
              content: [{ type: "text", text: "no such file" }],
              isError: true,
              timestamp: 0,
            },
          });
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });

    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "execute",
      title: "bash: ls",
    });
    expect(updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  });

  it("falls back to messageEnd content when no text deltas were streamed", async () => {
    const { agent, client, updates } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent({
            type: "messageEnd",
            message: {
              role: "assistant",
              model: "test-model",
              content: [{ type: "text", text: "whole answer" }],
              stopReason: "endTurn",
              usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
              timestamp: 0,
            },
          });
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "whole answer" } },
    ]);
  });

  it("reports a runEnd error as a JSON-RPC error response, not a stop reason", async () => {
    const { agent, client } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent({ type: "runEnd", reason: "error", errorMessage: "provider is down" });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await expect(
      client.sendRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }),
    ).rejects.toMatchObject({ code: JSON_RPC_ERRORS.internalError, message: "provider is down" });
  });

  it("maps tool names onto ACP tool kinds", () => {
    expect(toolKindFor("read")).toBe("read");
    expect(toolKindFor("edit")).toBe("edit");
    expect(toolKindFor("grep")).toBe("search");
    expect(toolKindFor("bash")).toBe("execute");
    expect(toolKindFor("websearch")).toBe("fetch");
    expect(toolKindFor("plan")).toBe("think");
    expect(toolKindFor("todo")).toBe("think");
    expect(toolKindFor("mystery")).toBe("other");
  });

  it("maps planUpdate onto a single-entry plan update", async () => {
    const { agent, client, updates } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent({ type: "planUpdate", plan: "1. Read the file\n2. Fix the bug" });
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await client.sendRequest("session/prompt", { sessionId, prompt: [] });
    expect(updates).toEqual([
      {
        sessionUpdate: "plan",
        entries: [
          {
            content: "1. Read the file\n2. Fix the bug",
            priority: "medium",
            status: "in_progress",
          },
        ],
      },
    ]);
  });

  it("renders resource_link prompt blocks as mentions", () => {
    expect(promptBlocksToText([{ type: "resource_link", uri: "file:///b.ts" }])).toBe(
      "@file:///b.ts",
    );
  });
});

// ---------------------------------------------------------------------------
// initialize: clientCapabilities
// ---------------------------------------------------------------------------

describe("initialize clientCapabilities", () => {
  it("captures what the editor advertised and mirrors it onto every session", async () => {
    const { agent, client } = createPeers();
    const acp = createAcpAgent(stubDeps());
    acp.attach(agent);

    // Before the handshake nothing is known — and nothing is assumed.
    expect(acp.clientCapabilities).toEqual(NO_CLIENT_CAPABILITIES);

    const capabilities = {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: true,
      elicitation: { form: {} },
      session: { configOptions: { boolean: {} } },
      // Modelled by the schema but not by this adapter: kept verbatim in `raw`.
      nes: { suggestionKinds: ["edit"] },
    };
    await client.sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: capabilities,
    });
    const { sessionId } = (await client.sendRequest("session/new", {
      cwd: "/repo",
    })) as AcpNewSessionResult;

    const expected: AcpClientCapabilities = {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: true,
      elicitation: { form: true, url: false },
      session: { configOptions: { boolean: true } },
      raw: capabilities,
    };
    expect(acp.clientCapabilities).toEqual(expected);
    expect(acp.sessionInfo(sessionId)?.clientCapabilities).toEqual(expected);
    expect(acp.sessionInfo("ghost")).toBeUndefined();
  });

  it("reads a missing, null or non-object capability as not advertised", async () => {
    const { agent, client } = createPeers();
    const acp = createAcpAgent(stubDeps());
    acp.attach(agent);

    await client.sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: null, terminal: "yes", elicitation: { url: null } },
    });
    expect(acp.clientCapabilities).toMatchObject({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      elicitation: { form: false, url: false },
      session: { configOptions: { boolean: false } },
    });
  });

  it("parses capabilities the same way outside a connection", () => {
    expect(parseClientCapabilities(undefined)).toEqual(NO_CLIENT_CAPABILITIES);
    expect(parseClientCapabilities({ terminal: true }).terminal).toBe(true);
    expect(parseClientCapabilities({ elicitation: { url: {} } }).elicitation).toEqual({
      form: false,
      url: true,
    });
  });
});

// ---------------------------------------------------------------------------
// usage_update
// ---------------------------------------------------------------------------

/** One arcturn `Usage`, with every field the adapter reads set explicitly. */
function usage(partial: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    ...partial,
  };
}

describe("usage_update", () => {
  it("emits one spec-shaped usage_update per turn, with cumulative session cost", async () => {
    const { agent, client, updates } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent({ type: "turnEnd", turnIndex: 0, usage: usage() });
          onEvent({
            type: "turnEnd",
            turnIndex: 1,
            usage: usage({ inputTokens: 900, outputTokens: 40 }),
          });
          onEvent({ type: "runEnd", reason: "completed" });
        },
        sessionUsage: (_sessionId, turnUsage) => ({
          contextWindow: 200_000,
          costUsd: turnUsage.inputTokens === 900 ? 0.02 : 0.01,
        }),
      }),
    ).attach(agent);

    const { sessionId } = await handshake(client);
    await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });

    expect(updates).toEqual([
      // used = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens.
      {
        sessionUpdate: "usage_update",
        used: 128,
        size: 200_000,
        cost: { amount: 0.01, currency: "USD" },
      },
      {
        sessionUpdate: "usage_update",
        used: 948,
        size: 200_000,
        // Cumulative for the session, per the spec's `Cost` ("Total cumulative
        // cost for session"), not this turn's 0.02 alone.
        cost: { amount: 0.03, currency: "USD" },
      },
    ]);
  });

  it("omits cost when the host cannot price the turn, and the update entirely when it cannot size it", async () => {
    const unpriced = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent({ type: "turnEnd", turnIndex: 0, usage: usage() });
          onEvent({ type: "runEnd", reason: "completed" });
        },
        sessionUsage: () => ({ contextWindow: 1_000 }),
      }),
    ).attach(unpriced.agent);
    const first = await handshake(unpriced.client);
    await unpriced.client.sendRequest("session/prompt", {
      sessionId: first.sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(unpriced.updates).toEqual([{ sessionUpdate: "usage_update", used: 128, size: 1_000 }]);

    // No `sessionUsage` hook at all: silence, never an invented context size.
    const unsized = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent({ type: "turnEnd", turnIndex: 0, usage: usage() });
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(unsized.agent);
    const second = await handshake(unsized.client);
    await unsized.client.sendRequest("session/prompt", {
      sessionId: second.sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(unsized.updates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// current_mode_update
// ---------------------------------------------------------------------------

describe("current_mode_update", () => {
  it("announces a mode change the agent made itself, with the spec's currentModeId field", async () => {
    const { agent, client, updates } = createPeers();
    // Stands in for `@arcturn/core`'s plan-approval path, which takes the
    // agent out of `plan` mode while a tool call is executing.
    let mode: PermissionMode = "plan";
    createAcpAgent(
      stubDeps({
        getPermissionMode: () => mode,
        setPermissionMode: (_sessionId, next) => {
          mode = next;
        },
        prompt: async (_r, onEvent) => {
          onEvent({ type: "toolStart", toolCallId: "t1", toolName: "plan", input: {} });
          mode = "acceptEdits";
          onEvent({
            type: "toolEnd",
            toolCallId: "t1",
            result: {
              role: "toolResult",
              toolCallId: "t1",
              toolName: "plan",
              content: [{ type: "text", text: "approved" }],
              isError: false,
              timestamp: 0,
            },
          });
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(agent);

    await client.sendRequest("initialize", { protocolVersion: 1 });
    const session = (await client.sendRequest("session/new", {
      cwd: "/repo",
    })) as AcpNewSessionResult;
    expect(session.modes?.currentModeId).toBe("plan");

    await client.sendRequest("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "x" }],
    });

    const modeUpdates = updates.filter((update) => update.sessionUpdate === "current_mode_update");
    expect(modeUpdates).toEqual([
      { sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" },
    ]);
  });

  it("never echoes the client's own session/set_mode back at it", async () => {
    const { agent, client, updates } = createPeers();
    let mode: PermissionMode = "default";
    createAcpAgent(
      stubDeps({
        getPermissionMode: () => mode,
        setPermissionMode: (_sessionId, next) => {
          mode = next;
        },
        prompt: async (_r, onEvent) => {
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(agent);

    await client.sendRequest("initialize", { protocolVersion: 1 });
    const session = (await client.sendRequest("session/new", {
      cwd: "/repo",
    })) as AcpNewSessionResult;
    await client.sendRequest("session/set_mode", {
      sessionId: session.sessionId,
      modeId: "yolo",
    });
    // A whole turn later, the client-requested change is still not announced.
    await client.sendRequest("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "x" }],
    });

    expect(updates.filter((u) => u.sessionUpdate === "current_mode_update")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

/** A `messageEnd` event whose assistant message carries `stopReason`. */
function messageEnd(stopReason: AssistantMessage["stopReason"]): AgentEvent {
  return {
    type: "messageEnd",
    message: {
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "partial" }],
      stopReason,
      usage: usage(),
      timestamp: 0,
    },
  };
}

describe("stop reason fidelity", () => {
  it("maps the loop's turn-ceiling runEnd onto max_turn_requests, not a JSON-RPC error", async () => {
    const { agent, client } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          // Verbatim from `@arcturn/core`'s `runLoop`, which is the only place
          // the turn ceiling is reported and reports it as an *error*.
          onEvent({
            type: "runEnd",
            reason: "error",
            errorMessage:
              "Reached the maximum of 12 turns. Send another message to continue from here, " +
              "or raise the ceiling with --max-turns.",
          });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await expect(
      client.sendRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }),
    ).resolves.toEqual({ stopReason: "max_turn_requests" });
  });

  it("maps a final message that hit the output limit onto max_tokens", async () => {
    const { agent, client } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent(messageEnd("toolCalls"));
          onEvent(messageEnd("maxTokens"));
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await expect(
      client.sendRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }),
    ).resolves.toEqual({ stopReason: "max_tokens" });
  });

  it("keeps end_turn when the last message ended normally", async () => {
    const { agent, client } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          // An earlier turn hit the output limit; the run recovered and the
          // final message ended cleanly, so the turn did not stop on tokens.
          onEvent(messageEnd("maxTokens"));
          onEvent(messageEnd("endTurn"));
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await expect(
      client.sendRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }),
    ).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("still reports cancelled for an aborted run, whatever the last message said", async () => {
    const { agent, client } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent(messageEnd("maxTokens"));
          onEvent({ type: "runEnd", reason: "aborted" });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await expect(
      client.sendRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }),
    ).resolves.toEqual({ stopReason: "cancelled" });
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("session/cancel", () => {
  it("aborts the host and answers session/prompt with the cancelled stop reason", async () => {
    const { agent, client } = createPeers();
    const entered = deferred<void>();
    const turn = deferred<void>();
    const abort = vi.fn(() => turn.resolve());

    createAcpAgent(
      stubDeps({
        abort,
        prompt: async (_r, onEvent) => {
          entered.resolve();
          await turn.promise;
          onEvent({ type: "runEnd", reason: "aborted" });
        },
      }),
    ).attach(agent);

    const { sessionId } = await handshake(client);
    const pending = client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "long job" }],
    });
    await entered.promise;
    client.sendNotification("session/cancel", { sessionId });

    await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
    expect(abort).toHaveBeenCalledWith(sessionId);
  });

  it("returns cancelled rather than an error when the host rejects after a cancel", async () => {
    const { agent, client } = createPeers();
    const entered = deferred<void>();
    const turn = deferred<void>();

    createAcpAgent(
      stubDeps({
        abort: () => turn.resolve(),
        prompt: async () => {
          entered.resolve();
          await turn.promise;
          throw new Error("AbortError");
        },
      }),
    ).attach(agent);

    const { sessionId } = await handshake(client);
    const pending = client.sendRequest("session/prompt", { sessionId, prompt: [] });
    await entered.promise;
    client.sendNotification("session/cancel", { sessionId });
    await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("ignores a cancel for an unknown session", async () => {
    const { agent, client } = createPeers();
    const abort = vi.fn();
    createAcpAgent(stubDeps({ abort })).attach(agent);
    await handshake(client);
    client.sendNotification("session/cancel", { sessionId: "ghost" });
    await expect(client.sendRequest("initialize", { protocolVersion: 1 })).resolves.toBeTruthy();
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts an in-flight runEnd-less turn and still reports cancelled", async () => {
    const { agent, client } = createPeers();
    const entered = deferred<void>();
    const turn = deferred<void>();
    createAcpAgent(
      stubDeps({
        abort: () => turn.resolve(),
        prompt: async () => {
          entered.resolve();
          await turn.promise;
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    const pending = client.sendRequest("session/prompt", { sessionId, prompt: [] });
    await entered.promise;
    client.sendNotification("session/cancel", { sessionId });
    await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const PERMISSION_REQUEST: PermissionRequest = {
  id: "perm-1",
  toolName: "bash",
  toolCallId: "t42",
  subject: "rm -rf build",
  description: "Run `rm -rf build`",
  suggestedRule: { tool: "bash", specifier: "rm *", action: "ask" },
};

describe("session/request_permission", () => {
  it("asks the editor and maps allow_always onto a persisted rule", async () => {
    const { agent, client } = createPeers();
    const acp = createAcpAgent(stubDeps());
    acp.attach(agent);

    let seen: AcpRequestPermissionParams | undefined;
    client.onRequest("session/request_permission", (params) => {
      seen = params as AcpRequestPermissionParams;
      return { outcome: { outcome: "selected", optionId: "allow-always" } };
    });

    const { sessionId } = await handshake(client);
    const decision = await acp.permissionPrompt(sessionId)(PERMISSION_REQUEST);

    expect(seen).toEqual({
      sessionId,
      toolCall: {
        toolCallId: "t42",
        title: "Run `rm -rf build`",
        kind: "execute",
        rawInput: { subject: "rm -rf build" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
      ],
    });
    expect(decision).toEqual({
      requestId: "perm-1",
      behavior: "allow",
      persistRule: { tool: "bash", specifier: "rm *", action: "allow", scope: "session" },
    });
  });

  it("maps a cancelled outcome onto a deny", async () => {
    const { agent, client } = createPeers();
    const acp = createAcpAgent(stubDeps());
    acp.attach(agent);
    client.onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
    const { sessionId } = await handshake(client);
    await expect(acp.permissionPrompt(sessionId)(PERMISSION_REQUEST)).resolves.toMatchObject({
      requestId: "perm-1",
      behavior: "deny",
    });
  });

  it("settles an outstanding permission request when the session is cancelled", async () => {
    const { agent, client } = createPeers();
    const acp = createAcpAgent(stubDeps());
    acp.attach(agent);

    const asked = deferred<void>();
    client.onRequest("session/request_permission", async () => {
      asked.resolve();
      await new Promise(() => {}); // The editor never answers.
    });

    const { sessionId } = await handshake(client);
    const pending = acp.permissionPrompt(sessionId)(PERMISSION_REQUEST);
    await asked.promise;
    client.sendNotification("session/cancel", { sessionId });

    await expect(pending).resolves.toEqual({
      requestId: "perm-1",
      behavior: "deny",
      message: "Cancelled by the editor.",
    });
  });

  it("denies when the editor errors out", async () => {
    const { agent, client } = createPeers();
    const acp = createAcpAgent(stubDeps());
    acp.attach(agent);
    client.onRequest("session/request_permission", () => {
      throw new Error("no UI available");
    });
    const { sessionId } = await handshake(client);
    await expect(acp.permissionPrompt(sessionId)(PERMISSION_REQUEST)).resolves.toMatchObject({
      behavior: "deny",
    });
  });

  it("mirrors permissionRequest/permissionDecision events as tool-call status changes", async () => {
    const { agent, client, updates } = createPeers();
    createAcpAgent(
      stubDeps({
        prompt: async (_r, onEvent) => {
          onEvent({ type: "permissionRequest", request: PERMISSION_REQUEST });
          onEvent({
            type: "permissionDecision",
            decision: { requestId: "perm-1", behavior: "deny" },
          });
          onEvent({ type: "runEnd", reason: "completed" });
        },
      }),
    ).attach(agent);
    const { sessionId } = await handshake(client);
    await client.sendRequest("session/prompt", { sessionId, prompt: [] });
    expect(updates).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "t42", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "t42", status: "failed" },
    ]);
  });
});
