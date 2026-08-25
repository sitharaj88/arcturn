import { mkdtemp, readdir } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, registerModel, unregisterModel } from "@arcturn/ai";
import { JsonlSessionStore } from "@arcturn/core";
import { createProtocolClient } from "@arcturn/protocol";
import { ArcturnServer } from "@arcturn/server";
import type { AgentEvent, ModelSpec, SessionHistory } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { formatModelCatalog } from "./runtime.js";
import {
  createServeHost,
  formatServeUrl,
  generateServeToken,
  isLoopbackHost,
  resolveServeToken,
  runServe,
  type ServableRuntime,
  ServeBindError,
} from "./serve.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";

const TEST_MODEL: ModelSpec = {
  id: "test/model",
  provider: "anthropic",
  model: "test-model",
  displayName: "Test Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
};

/** A `ServableRuntime` backed by a scripted LLM and a real, scratch-dir session store. */
async function fakeRuntime(overrides: Partial<ServableRuntime> = {}): Promise<ServableRuntime> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-serve-test-"));
  return {
    llm: fakeLLM([{ text: "hello over serve" }]),
    model: TEST_MODEL,
    cwd: dir,
    env: {},
    store: new JsonlSessionStore({ dir }),
    systemPrompt: "You are a test agent.",
    tools: [],
    config: { permissions: [], permissionMode: "yolo" },
    dispose: async () => {},
    ...overrides,
  };
}

const servers: ArcturnServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe("generateServeToken", () => {
  it("produces a 32-character hex string", () => {
    const token = generateServeToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a different value on each call", () => {
    expect(generateServeToken()).not.toBe(generateServeToken());
  });
});

describe("isLoopbackHost", () => {
  it("recognises 127.0.0.1, localhost and ::1", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("does not treat a wildcard or LAN address as loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
  });
});

describe("resolveServeToken", () => {
  it("auto-generates a token when none is given, on a loopback host", () => {
    const token = resolveServeToken("127.0.0.1");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("auto-generates a token when none is given, on a non-loopback host", () => {
    const token = resolveServeToken("0.0.0.0");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uses an explicitly supplied token as-is", () => {
    expect(resolveServeToken("127.0.0.1", "my-token")).toBe("my-token");
    expect(resolveServeToken("0.0.0.0", "my-token")).toBe("my-token");
  });

  it("honours an explicit empty-string opt-out on loopback", () => {
    expect(resolveServeToken("127.0.0.1", "")).toBeUndefined();
    expect(resolveServeToken("localhost", "")).toBeUndefined();
  });

  it("refuses an explicit empty-string opt-out on a non-loopback host", () => {
    expect(() => resolveServeToken("0.0.0.0", "")).toThrow(ServeBindError);
    expect(() => resolveServeToken("192.168.1.5", "")).toThrow(/without a token/);
  });
});

describe("formatServeUrl", () => {
  it("formats an IPv4 host plainly", () => {
    expect(formatServeUrl("127.0.0.1", 4321)).toBe("ws://127.0.0.1:4321");
  });

  it("brackets a literal IPv6 host", () => {
    expect(formatServeUrl("::1", 4321)).toBe("ws://[::1]:4321");
  });

  it("does not double-bracket an already-bracketed host", () => {
    expect(formatServeUrl("[::1]", 4321)).toBe("ws://[::1]:4321");
  });
});

describe("createServeHost", () => {
  it("wires a runtime's llm/model/store into a working SessionHost", async () => {
    const runtime = await fakeRuntime();
    const host = createServeHost(runtime);

    const header = await host.createSession({});
    expect(header.sessionId).toBeTruthy();

    const events: AgentEvent[] = [];
    const unsubscribe = host.observe(header.sessionId, (event) => events.push(event));

    await host.prompt(header.sessionId, "hi");
    unsubscribe();

    expect(events.some((event) => event.type === "runEnd")).toBe(true);
  });

  it("uses AgentFactoryOptions.cwd/sessionId for each session, not the runtime's own", async () => {
    const runtime = await fakeRuntime();
    const host = createServeHost(runtime);

    const first = await host.createSession({ cwd: runtime.cwd });
    const second = await host.createSession({ cwd: runtime.cwd });
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("maxCostUsd aborts a session once its own spend crosses the ceiling", async () => {
    // No `write`/`bash`/etc are registered on this ServableRuntime stub (see
    // `fakeRuntime`'s `tools: []`), so the tool call below fails as "unknown
    // tool" and the loop naturally asks the model a second time — exactly
    // the shape needed to observe an abort actually cutting a run short,
    // rather than firing harmlessly after the run was already about to end.
    const runtime = await fakeRuntime({
      llm: fakeLLM([
        { toolCalls: [{ id: "c1", name: "nonexistent", arguments: {} }], usage: { costUsd: 10 } },
        { text: "should not be reached" },
      ]),
    });
    const host = createServeHost(runtime, { maxCostUsd: 5 });
    const header = await host.createSession({});
    const events: AgentEvent[] = [];
    const unsubscribe = host.observe(header.sessionId, (event) => events.push(event));

    await host.prompt(header.sessionId, "go");
    unsubscribe();

    const runEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "runEnd" }> => event.type === "runEnd",
    );
    expect(runEnd?.reason).toBe("aborted");
    // The decisive check: the guard's own abort() reached THIS session's own
    // agent in time to stop a second model call, not just fired too late to
    // matter.
    const llm = runtime.llm as ReturnType<typeof fakeLLM>;
    expect(llm.requests).toHaveLength(1);
  });
});

describe("createServeHost: the model catalog", () => {
  it("serves the engine's real catalog over listModels", async () => {
    const runtime = await fakeRuntime();
    const host = createServeHost(runtime);

    const models = await host.listModels();
    expect(models.length).toBeGreaterThan(100);
    expect(models.map((model) => model.id)).toContain("anthropic/claude-sonnet-4-5");
    expect(models.find((model) => model.id === "anthropic/claude-sonnet-4-5")).toMatchObject({
      displayName: "Claude Sonnet 4.5",
      contextWindow: 200_000,
      cost: { input: 3, output: 15 },
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
  });

  it("puts no credential value on the catalog it serves", async () => {
    const runtime = await fakeRuntime({ env: { ANTHROPIC_API_KEY: "sk-live-secret" } });
    const host = createServeHost(runtime);

    const models = await host.listModels();
    expect(JSON.stringify(models)).not.toContain("sk-live-secret");
    expect(models.find((model) => model.id === "anthropic/claude-sonnet-4-5")?.credentials).toBe(
      "present",
    );
  });
});

describe("createServeHost + ArcturnServer", () => {
  it("starts on 127.0.0.1:0, accepts a connection, and stops cleanly", async () => {
    const runtime = await fakeRuntime();
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);

    const port = await server.start({ host: "127.0.0.1", port: 0 });
    expect(port).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });

    await server.stop();
    servers.pop();

    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      }),
    ).rejects.toThrow();
  });
});

describe("listModels end-to-end: real server, real client, real catalog", () => {
  it("hands a connected client the catalog --list-models would print", async () => {
    const runtime = await fakeRuntime({ env: { OPENAI_API_KEY: "sk-live-secret" } });
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = createProtocolClient(socket);
    try {
      const catalog = await client.listModels();
      expect(catalog).toBeDefined();
      const models = catalog?.models ?? [];
      expect(models.length).toBeGreaterThan(100);

      const sonnet = models.find((model) => model.id === "anthropic/claude-sonnet-4-5");
      expect(sonnet).toMatchObject({
        displayName: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        cost: { input: 3, output: 15 },
        apiKeyEnv: "ANTHROPIC_API_KEY",
        credentials: "absent",
      });
      // The key that *is* set is reported as present — by name, never by value.
      expect(models.find((model) => model.id === "openai/gpt-5.1")?.credentials).toBe("present");
      expect(JSON.stringify(models)).not.toContain("sk-live-secret");
      // Every id the CLI prints is on the wire, and vice versa.
      const printed = formatModelCatalog();
      for (const model of models) expect(printed).toContain(model.id);
    } finally {
      client.close();
    }
  });
});

/**
 * A connected client on a fresh socket, as a second panel (or a restarted one)
 * would be. Registered for teardown by the caller.
 */
function connect(port: number): ReturnType<typeof createProtocolClient> {
  return createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
}

/** Text of every `runStart` prompt in a replay, oldest first. */
function promptTexts(history: SessionHistory): string[] {
  return history.events
    .filter(
      (event): event is Extract<AgentEvent, { type: "runStart" }> => event.type === "runStart",
    )
    .map((event) =>
      event.prompt.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(""),
    );
}

/** Text of every completed assistant message in a replay, oldest first. */
function assistantTexts(history: SessionHistory): string[] {
  return history.events
    .filter(
      (event): event is Extract<AgentEvent, { type: "messageEnd" }> => event.type === "messageEnd",
    )
    .map((event) =>
      event.message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(""),
    );
}

describe("sessionHistory end-to-end: real server, real client, real session store", () => {
  it("replays a session's prior turns to a client that just attached", async () => {
    const runtime = await fakeRuntime({ llm: fakeLLM([{ text: "the first answer" }]) });
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    // Panel one: does the work.
    const first = connect(port);
    let sessionId: string;
    try {
      const header = await first.createSession({ cwd: runtime.cwd });
      sessionId = header.sessionId;
      await first.openSession(sessionId);
      await first.prompt(sessionId, "what did I ask about?");
    } finally {
      first.close();
    }

    // Panel two: a fresh connection that saw none of it, exactly like a VS Code
    // panel opening a session out of the history list. This is the bug: today
    // it gets a header, a live event subscription, and an empty chat.
    const second = connect(port);
    try {
      const header = await second.openSession(sessionId);
      expect(header.sessionId).toBe(sessionId);

      const history = await second.sessionHistory(sessionId);
      expect(history).toBeDefined();
      const replayed = history as SessionHistory;

      expect(replayed.sessionId).toBe(sessionId);
      expect(promptTexts(replayed)).toEqual(["what did I ask about?"]);
      expect(assistantTexts(replayed)).toEqual(["the first answer"]);
      expect(replayed.truncated).toBe(false);
      expect(replayed.droppedEvents).toBe(0);
      // The run is closed, so a client folding these lands on "not running"
      // rather than a transcript stuck mid-turn forever.
      expect(replayed.events.at(-1)).toMatchObject({ type: "runEnd", reason: "completed" });
    } finally {
      second.close();
    }
  });

  it("replays every turn of a multi-turn session, in order", async () => {
    const runtime = await fakeRuntime({
      llm: fakeLLM([{ text: "answer one" }, { text: "answer two" }]),
    });
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const client = connect(port);
    try {
      const header = await client.createSession({ cwd: runtime.cwd });
      await client.openSession(header.sessionId);
      await client.prompt(header.sessionId, "question one");
      await client.prompt(header.sessionId, "question two");

      const history = (await client.sessionHistory(header.sessionId)) as SessionHistory;
      expect(promptTexts(history)).toEqual(["question one", "question two"]);
      expect(assistantTexts(history)).toEqual(["answer one", "answer two"]);
    } finally {
      client.close();
    }
  });

  it("carries no credential value, and refuses an id it has never seen", async () => {
    const runtime = await fakeRuntime({ env: { ANTHROPIC_API_KEY: "sk-live-secret" } });
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const client = connect(port);
    try {
      const header = await client.createSession({ cwd: runtime.cwd });
      await client.openSession(header.sessionId);
      await client.prompt(header.sessionId, "hello");

      const history = (await client.sessionHistory(header.sessionId)) as SessionHistory;
      expect(JSON.stringify(history)).not.toContain("sk-live-secret");

      await expect(client.sessionHistory("sess_never_existed")).rejects.toMatchObject({
        code: "sessionNotFound",
      });
    } finally {
      client.close();
    }
  });
});

describe("deleteSession end-to-end: real server, real client, real files", () => {
  it("removes the session from listSessions and from disk", async () => {
    const runtime = await fakeRuntime();
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const client = connect(port);
    try {
      const doomed = await client.createSession({ cwd: runtime.cwd });
      const keeper = await client.createSession({ cwd: runtime.cwd });
      await client.openSession(doomed.sessionId);
      await client.prompt(doomed.sessionId, "write something to disk");

      const before = await readdir(runtime.cwd);
      expect(before).toContain(`${doomed.sessionId}.jsonl`);

      await client.deleteSession(doomed.sessionId);

      const listed = (await client.listSessions()).map((header) => header.sessionId);
      expect(listed).not.toContain(doomed.sessionId);
      expect(listed).toContain(keeper.sessionId);

      // The decisive check: the engine actually unlinked it. A session that is
      // merely forgotten in memory comes back on the next `arcturn serve`.
      const after = await readdir(runtime.cwd);
      expect(after).not.toContain(`${doomed.sessionId}.jsonl`);
      expect(after).toContain(`${keeper.sessionId}.jsonl`);

      // And it is gone for good: re-opening finds nothing, and so does history.
      await expect(client.openSession(doomed.sessionId)).rejects.toMatchObject({
        code: "sessionNotFound",
      });
      await expect(client.sessionHistory(doomed.sessionId)).rejects.toMatchObject({
        code: "sessionNotFound",
      });
    } finally {
      client.close();
    }
  });

  it("refuses to delete a session that is running a turn, and leaves it intact", async () => {
    const runtime = await fakeRuntime({
      llm: fakeLLM([{ text: "still thinking", delayMs: 250 }]),
    });
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const client = connect(port);
    try {
      const header = await client.createSession({ cwd: runtime.cwd });
      await client.openSession(header.sessionId);

      const started = new Promise<void>((resolve) => {
        client.onEvent((_sessionId, event) => {
          if (event.type === "runStart") resolve();
        });
      });
      const running = client.prompt(header.sessionId, "take your time");
      await started;

      await expect(client.deleteSession(header.sessionId)).rejects.toMatchObject({
        code: "sessionBusy",
      });
      // Not half-deleted: the file is still there while the run finishes.
      expect(await readdir(runtime.cwd)).toContain(`${header.sessionId}.jsonl`);

      await running;
      // Once idle, the same call succeeds.
      await client.deleteSession(header.sessionId);
      expect(await readdir(runtime.cwd)).not.toContain(`${header.sessionId}.jsonl`);
    } finally {
      client.close();
    }
  });

  it("tells an attached client its session was deleted, rather than going silent", async () => {
    const runtime = await fakeRuntime();
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const watcher = connect(port);
    const deleter = connect(port);
    try {
      const header = await watcher.createSession({ cwd: runtime.cwd });
      await watcher.openSession(header.sessionId);

      const notices: AgentEvent[] = [];
      const told = new Promise<void>((resolve) => {
        watcher.onEvent((sessionId, event) => {
          if (sessionId !== header.sessionId || event.type !== "notice") return;
          notices.push(event);
          resolve();
        });
      });

      await deleter.deleteSession(header.sessionId);
      await told;

      expect(notices.at(-1)).toMatchObject({
        type: "notice",
        level: "warn",
        text: expect.stringContaining(header.sessionId),
      });
    } finally {
      watcher.close();
      deleter.close();
    }
  });
});

describe("runServe", () => {
  it("refuses a non-loopback bind with authentication explicitly disabled, before building a runtime", async () => {
    await expect(runServe({ host: "0.0.0.0", token: "", port: 0 })).rejects.toThrow(ServeBindError);
  });
});

/**
 * A stand-in provider endpoint: an HTTP server that records every request it
 * receives and answers with one OpenAI-compatible SSE turn.
 *
 * The point of the recording is that a model id is just a label — the thing
 * that actually matters is which host the prompt and the credentials were
 * sent to. Two of these, two model specs pointed at them, and "which one got
 * the request" is a direct read of the routing.
 */
async function stubProvider(): Promise<{
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests.push(body);
      const chunk = {
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: 1,
        model: "stub",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      };
      const done = {
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: 1,
        model: "stub",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function stubSpec(id: string, baseUrl: string): ModelSpec {
  return {
    id,
    provider: "openai-compatible",
    model: "stub-model",
    displayName: id,
    contextWindow: 100_000,
    maxOutputTokens: 1_024,
    baseUrl,
    capabilities: { tools: true, vision: false, thinking: false, caching: false },
  };
}

describe("setModel end-to-end: real server, real client, real provider dispatch", () => {
  it("routes the next request to the provider the id names, not the default one", async () => {
    const home = await stubProvider();
    const elsewhere = await stubProvider();
    const homeSpec = stubSpec("stub-home/model", home.baseUrl);
    const elsewhereSpec = stubSpec("stub-elsewhere/model", elsewhere.baseUrl);
    registerModel(homeSpec);
    registerModel(elsewhereSpec);

    // A real dispatching client: it picks the adapter and the endpoint from
    // the ModelSpec it is handed, exactly as `arcturn serve` does.
    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: homeSpec,
    });
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = createProtocolClient(socket);
    try {
      const events: AgentEvent[] = [];
      client.onEvent((_sessionId, event) => events.push(event));

      const header = await client.createSession({ cwd: runtime.cwd });
      await client.openSession(header.sessionId);
      await client.setModel(header.sessionId, elsewhereSpec.id);
      await client.prompt(header.sessionId, "hi");

      // The decisive assertion: which host actually received the prompt. A
      // returned model id proves only that the label was carried; the id was
      // already right while the routing was wrong.
      expect(elsewhere.requests).toHaveLength(1);
      expect(home.requests).toHaveLength(0);
      const runEnd = events.find(
        (event): event is Extract<AgentEvent, { type: "runEnd" }> => event.type === "runEnd",
      );
      expect(runEnd?.reason).toBe("completed");
    } finally {
      client.close();
      unregisterModel(homeSpec.id);
      unregisterModel(elsewhereSpec.id);
      await home.close();
      await elsewhere.close();
    }
  });

  it("refuses an id it cannot resolve, and leaves the session on the model it had", async () => {
    const home = await stubProvider();
    const homeSpec = stubSpec("stub-home/model", home.baseUrl);
    registerModel(homeSpec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: homeSpec,
    });
    const sessionHost = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = createProtocolClient(socket);
    try {
      const header = await client.createSession({ cwd: runtime.cwd });
      await client.openSession(header.sessionId);

      await expect(client.setModel(header.sessionId, "no-such/model")).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("no-such/model"),
      });

      // Not half-switched: the next turn still goes where it went before.
      await client.prompt(header.sessionId, "hi");
      expect(home.requests).toHaveLength(1);
    } finally {
      client.close();
      unregisterModel(homeSpec.id);
      await home.close();
    }
  });
});
