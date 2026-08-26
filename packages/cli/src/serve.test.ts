import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createClient, registerModel, unregisterModel } from "@arcturn/ai";
import { Agent, JsonlSessionStore } from "@arcturn/core";
import { createProtocolClient, type ProtocolClient } from "@arcturn/protocol";
import { ArcturnServer, SessionHost } from "@arcturn/server";
import type { AgentEvent, ContextResolution, ModelSpec, SessionHistory } from "@arcturn/types";
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
import { loadSkills, type Skill } from "./skills.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

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

/** A 1x1 PNG, as a `prompt` attachment would carry it. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** {@link stubSpec}, with the one capability RFC 0005 §1.1 gates images on. */
function visionSpec(id: string, baseUrl: string): ModelSpec {
  const spec = stubSpec(id, baseUrl);
  return { ...spec, capabilities: { ...spec.capabilities, vision: true } };
}

/**
 * One connected client against a real `ArcturnServer` over a real socket, with
 * every event it was pushed.
 *
 * Assembled here because every test below needs the same six lines, and because
 * the `events` array is half the point: the mention refusals RFC 0005 §1.1 asks
 * for are `notice` events, and a test that only inspected the returned promise
 * could not see one.
 */
async function connectedClient(
  runtime: ServableRuntime,
  options: { maxAttachmentBytes?: number } = {},
): Promise<{ client: ProtocolClient; sessionId: string; events: AgentEvent[] }> {
  const sessionHost = createServeHost(runtime, options);
  const server = new ArcturnServer({ sessionHost });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
  const events: AgentEvent[] = [];
  client.onEvent((_sessionId, event) => events.push(event));
  const header = await client.createSession({ cwd: runtime.cwd });
  await client.openSession(header.sessionId);
  return { client, sessionId: header.sessionId, events };
}

describe("RFC 0005 §1.1 — context and attachments on the wire", () => {
  it("expands an @-mention so the file's CONTENT reaches the provider, not the token", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-ctx/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "auth.ts"), "export const SECRET_SENTINEL = 42;\n", "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await client.prompt(sessionId, "what does @auth.ts do?");

      // The decisive assertion: what the model was actually handed. Asserting
      // on the returned promise, or on a rendered transcript, would have passed
      // for the entire life of the bug — the prompt was accepted and the run
      // completed; it was only the *content* that never arrived.
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toContain("SECRET_SENTINEL");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses a mention that escapes the workspace: nothing is read, and the client is told", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-esc/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    // A real file, really outside the served workspace — not a path that merely
    // looks like an escape.
    const outside = await mkdtemp(join(tmpdir(), "arcturn-outside-"));
    await writeFile(join(outside, "secrets.txt"), "OUTSIDE_SENTINEL\n", "utf8");
    const traversal = relative(runtime.cwd, join(outside, "secrets.txt")).split(sep).join("/");

    const { client, sessionId, events } = await connectedClient(runtime);
    try {
      await client.prompt(sessionId, `read @${traversal} for me`);

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).not.toContain("OUTSIDE_SENTINEL");
      // Refused *with a reason*, which is the half the pre-RFC behaviour was
      // missing: the TUI could get away with silence because the user could see
      // their own filesystem; a remote client could not tell a refusal from a
      // mention that simply worked.
      const notice = events.find(
        (event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice",
      );
      expect(notice?.text).toMatch(/outside the workspace/i);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses an ATTACHMENT that escapes the workspace outright, and spends no turn", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-esc2/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    const outside = await mkdtemp(join(tmpdir(), "arcturn-outside-"));
    await writeFile(join(outside, "secrets.txt"), "OUTSIDE_SENTINEL\n", "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      // Absolute, and plainly elsewhere. Unlike a mention this is fatal: the
      // client named the file, so running the turn without it would be exactly
      // the silent drop RFC 0005 §1.1 forbids.
      await expect(
        client.prompt(sessionId, "look at this", [
          { kind: "file", path: join(outside, "secrets.txt") },
        ]),
      ).rejects.toMatchObject({ code: "invalidRequest" });

      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("turns a file attachment into a context block that says what it is", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-att/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "notes.md"), "ATTACHED_SENTINEL\n", "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await client.prompt(sessionId, "summarise this", [{ kind: "file", path: "notes.md" }]);

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toContain("ATTACHED_SENTINEL");
      expect(provider.requests[0]).toContain("notes.md (attached file)");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses an image for a model without vision BEFORE the turn is spent", async () => {
    const provider = await stubProvider();
    // stubSpec's capabilities.vision is false — the case RFC 0005 §4 asks for.
    const spec = stubSpec("stub-blind/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await expect(
        client.prompt(sessionId, "what is this?", [
          { kind: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        ]),
      ).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("cannot see images"),
      });

      // "Before the turn is spent" is this line, not the rejection: a refusal
      // that arrived after the provider had already been billed would satisfy
      // the error message and none of the promise.
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("sends the same image to a model that can see one", async () => {
    const provider = await stubProvider();
    const spec = visionSpec("stub-eyes/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await client.prompt(sessionId, "what is this?", [
        { kind: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toContain(TINY_PNG_BASE64);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses attachments past the total byte budget, and spends no turn", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cap/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "big.txt"), "x".repeat(4096), "utf8");

    // The budget is injected rather than exercised at its real 1 MiB, for the
    // reason `sessionHistoryLimits` is injectable: proving the cap cuts should
    // not cost a megabyte of scratch files.
    const { client, sessionId } = await connectedClient(runtime, { maxAttachmentBytes: 512 });
    try {
      await expect(
        client.prompt(sessionId, "read it", [{ kind: "file", path: "big.txt" }]),
      ).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("attachment budget"),
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });
});

/**
 * A file whose every line names itself, so "which lines reached the model" is a
 * direct substring read of the provider's request body rather than an
 * inference from its length.
 *
 * Zero-padded deliberately: `LINE_5_` is not a substring of `LINE_15_`, but a
 * reader should not have to work that out to trust the assertion.
 */
function numberedLines(count: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) lines.push(`LINE_${String(i).padStart(3, "0")}_SENTINEL`);
  return `${lines.join("\n")}\n`;
}

/** The sentinel `numberedLines` puts on line `n`. */
function sentinel(n: number): string {
  return `LINE_${String(n).padStart(3, "0")}_SENTINEL`;
}

describe("ranged file attachments — a selection, not the whole file", () => {
  it("sends ONLY the selected lines to the provider", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-range/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "big.ts"), numberedLines(60), "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await client.prompt(sessionId, "explain this", [
        { kind: "file", path: "big.ts", range: { start: 12, end: 14 } },
      ]);

      expect(provider.requests).toHaveLength(1);
      const sent = provider.requests[0] ?? "";
      // The whole point, and the assertion the mention bug taught us to write:
      // a test that only checked the prompt was accepted would have passed
      // while all sixty lines went to the model.
      expect(sent).toContain(sentinel(12));
      expect(sent).toContain(sentinel(13));
      expect(sent).toContain(sentinel(14));
      expect(sent).not.toContain(sentinel(11));
      expect(sent).not.toContain(sentinel(15));
      expect(sent).not.toContain(sentinel(60));
      // And the model is told it is looking at an excerpt, so it does not
      // answer as though it had seen the file.
      expect(sent).toContain("excerpt, lines 12-14 of 60");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("clamps a range that runs past the end of the file, and REPORTS the clamp", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-clamp/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "big.ts"), numberedLines(60), "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await client.prompt(sessionId, "explain the tail", [
        { kind: "file", path: "big.ts", range: { start: 58, end: 10_000_000 } },
      ]);

      const sent = provider.requests[0] ?? "";
      expect(sent).toContain(sentinel(58));
      expect(sent).toContain(sentinel(60));
      expect(sent).not.toContain(sentinel(57));
      expect(sent).toContain("excerpt, lines 58-60 of 60");
      expect(sent).toContain("clamped");
      expect(sent).toContain("10000000");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses a start past the end of the file rather than sending an empty block", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-past/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "big.ts"), numberedLines(60), "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await expect(
        client.prompt(sessionId, "explain this", [
          { kind: "file", path: "big.ts", range: { start: 900, end: 950 } },
        ]),
      ).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("60 lines"),
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("still confines a RANGED attachment: nothing outside the workspace is read", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-rangeesc/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    const outside = await mkdtemp(join(tmpdir(), "arcturn-outside-"));
    await writeFile(
      join(outside, "secrets.txt"),
      numberedLines(60).replace(/LINE/g, "OUT"),
      "utf8",
    );

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await expect(
        client.prompt(sessionId, "look at this", [
          {
            kind: "file",
            path: join(outside, "secrets.txt"),
            range: { start: 12, end: 14 },
          },
        ]),
      ).rejects.toMatchObject({ code: "invalidRequest" });
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("charges the budget for the excerpt, not for the file it came from", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-rangebudget/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    // 60 lines is well past a 512-byte budget; three of them are not.
    await writeFile(join(runtime.cwd, "big.ts"), numberedLines(60), "utf8");

    const { client, sessionId } = await connectedClient(runtime, { maxAttachmentBytes: 512 });
    try {
      await expect(
        client.prompt(sessionId, "whole thing", [{ kind: "file", path: "big.ts" }]),
      ).rejects.toMatchObject({ message: expect.stringContaining("attachment budget") });
      expect(provider.requests).toHaveLength(0);

      await client.prompt(sessionId, "just the selection", [
        { kind: "file", path: "big.ts", range: { start: 12, end: 14 } },
      ]);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toContain(sentinel(13));
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("rejects a nonsense range on the wire, before anything is read", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-badrange/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "big.ts"), numberedLines(60), "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      const cases: Array<[{ start: number; end: number }, RegExp]> = [
        [{ start: 0, end: 4 }, /at least 1/],
        [{ start: 14, end: 12 }, /must not be before/],
        [{ start: 1.5, end: 4 }, /whole number/],
      ];
      for (const [range, reason] of cases) {
        await expect(
          client.prompt(sessionId, "explain this", [{ kind: "file", path: "big.ts", range }]),
        ).rejects.toMatchObject({
          code: "invalidRequest",
          message: expect.stringMatching(reason),
        });
      }
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses a line range on an image, which has no lines", async () => {
    const provider = await stubProvider();
    const spec = visionSpec("stub-rangeimg/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "shot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await expect(
        client.prompt(sessionId, "what is this?", [
          { kind: "file", path: "shot.png", range: { start: 1, end: 2 } },
        ]),
      ).rejects.toMatchObject({ code: "invalidRequest" });
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("expands an @path:12-14 MENTION to the same excerpt, not the whole file", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-mentionrange/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "big.ts"), numberedLines(60), "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      await client.prompt(sessionId, "what does @big.ts:12-14 do?");

      const sent = provider.requests[0] ?? "";
      expect(sent).toContain(sentinel(12));
      expect(sent).toContain(sentinel(14));
      expect(sent).not.toContain(sentinel(11));
      expect(sent).not.toContain(sentinel(15));
      expect(sent).toContain("excerpt, lines 12-14 of 60");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses a ranged attachment locally when the engine cannot honour ranges", async () => {
    const runtime = await fakeRuntime();
    await writeFile(join(runtime.cwd, "big.ts"), numberedLines(60), "utf8");

    // An engine with `resolveContext` but no notion of a range: exactly the
    // shape of an arcturn built before this feature, which would drop the
    // field, send all sixty lines and answer `ok`.
    const sessionHost = createServeHost(runtime);
    // A Proxy rather than a subclass or a spread: `SessionHost` carries private
    // fields, so the only way to get "the real host, minus one field on one
    // answer" is to delegate every other member to it untouched.
    const rangeBlind = new Proxy(sessionHost, {
      get(target, property, receiver) {
        if (property === "resolveContext") {
          return async (sessionId: string, query: string): Promise<ContextResolution> => {
            const { range: _dropped, ...rest } = await target.resolveContext(sessionId, query);
            return rest;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const server = new ArcturnServer({ sessionHost: rangeBlind });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });
    const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
    try {
      const header = await client.createSession({ cwd: runtime.cwd });
      await client.openSession(header.sessionId);
      await expect(
        client.prompt(header.sessionId, "look", [
          { kind: "file", path: "big.ts", range: { start: 12, end: 14 } },
        ]),
      ).rejects.toMatchObject({ code: "invalidRequest" });
    } finally {
      client.close();
    }
  });
});

describe("resolveContext end-to-end: real server, real client, real files", () => {
  it("answers what a mention would resolve to, without attaching anything", async () => {
    const runtime = await fakeRuntime();
    await writeFile(join(runtime.cwd, "notes.md"), "hello\n", "utf8");
    await mkdir(join(runtime.cwd, "sub"), { recursive: true });

    const { client, sessionId } = await connectedClient(runtime);
    try {
      const file = await client.resolveContext(sessionId, "notes.md");
      expect(file).toMatchObject({
        relativePath: "notes.md",
        inWorkspace: true,
        exists: true,
        bytes: 6,
        kind: "file",
      });
      expect(file?.reason).toBeUndefined();

      const missing = await client.resolveContext(sessionId, "nope.md");
      expect(missing).toMatchObject({
        inWorkspace: true,
        exists: false,
        bytes: 0,
        kind: "missing",
      });

      const dir = await client.resolveContext(sessionId, "sub");
      expect(dir).toMatchObject({ inWorkspace: true, exists: true, kind: "directory" });
      expect(dir?.reason).toMatch(/directory/i);

      // The refusal a picker must show as a refusal: outside the workspace, and
      // reported as *not looked at* rather than as "no such file".
      const escaped = await client.resolveContext(sessionId, "../../etc/passwd");
      expect(escaped).toMatchObject({
        inWorkspace: false,
        exists: false,
        bytes: 0,
        relativePath: "",
      });
      expect(escaped?.reason).toMatch(/outside the workspace/i);
    } finally {
      client.close();
    }
  });

  it("attaches nothing and starts no run — it is a read", async () => {
    const runtime = await fakeRuntime();
    await writeFile(join(runtime.cwd, "notes.md"), "hello\n", "utf8");

    const { client, sessionId, events } = await connectedClient(runtime);
    try {
      await client.resolveContext(sessionId, "notes.md");
      expect(events).toHaveLength(0);
    } finally {
      client.close();
    }
  });
});

describe("prompt attachments against an engine that cannot honour them", () => {
  it("refuses locally rather than letting an old engine drop them and answer ok", async () => {
    const runtime = await fakeRuntime();
    // A host assembled without a context resolver *is* the pre-RFC-0005 engine:
    // it answers `prompt` and knows no `resolveContext`.
    const sessionHost = new SessionHost({
      agentFactory: () =>
        new Agent({
          llm: runtime.llm,
          model: runtime.model,
          systemPrompt: runtime.systemPrompt,
          tools: [],
          cwd: runtime.cwd,
          sessionId: "old-engine",
          sessionStore: runtime.store,
          permissions: { mode: "yolo", rules: [] },
        }),
      defaultCwd: runtime.cwd,
    });
    const server = new ArcturnServer({ sessionHost });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });
    const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
    try {
      const header = await client.createSession({ cwd: runtime.cwd });
      await client.openSession(header.sessionId);

      // A plain prompt still works — nothing about this degrades text.
      await client.prompt(header.sessionId, "hello");

      await expect(
        client.prompt(header.sessionId, "look", [{ kind: "file", path: "notes.md" }]),
      ).rejects.toMatchObject({ code: "invalidRequest" });
    } finally {
      client.close();
    }
  });
});

/**
 * Load a real skill library from a real directory, the way `buildRuntime`
 * does — `loadSkills`, not a hand-rolled `Skill` literal. The point of every
 * test below is that a file on disk reaches a model, so the file half has to
 * be real too.
 */
async function skillLibrary(
  root: string,
  files: Record<string, string>,
): Promise<readonly Skill[]> {
  for (const [name, body] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, body, "utf8");
  }
  const warnings: string[] = [];
  return loadSkills([root], warnings);
}

describe("RFC 0005 §1.3 — a leading /name on the served prompt path", () => {
  it("expands a leading /name so the SKILL BODY reaches the provider, not the command text", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "review.md":
        "---\ndescription: Review the diff\n---\nSKILL_BODY_SENTINEL: review $ARGUMENTS carefully.\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await client.prompt(sessionId, "/review the auth module");

      // The decisive assertion, and the one the `skill`-tool workaround could
      // never satisfy: the body itself is what the model was handed.
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toContain("SKILL_BODY_SENTINEL");
      expect(provider.requests[0]).toContain("review the auth module carefully");
      // The command line itself is gone — not merely accompanied by the body.
      expect(provider.requests[0]).not.toContain("/review");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("leaves a /name that is not at the start of the prompt alone", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-mid/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "review.md": "SKILL_BODY_SENTINEL\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await client.prompt(sessionId, "explain what /review does");

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toContain("explain what /review does");
      expect(provider.requests[0]).not.toContain("SKILL_BODY_SENTINEL");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses an unknown /name rather than spending a turn on it", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-unknown/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "review.md": "SKILL_BODY_SENTINEL\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await expect(client.prompt(sessionId, "/reviw the auth module")).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("review"),
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("passes prose that merely begins with a slash through untouched", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-prose/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "review.md": "SKILL_BODY_SENTINEL\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await client.prompt(sessionId, "/etc/hosts has the wrong entry, fix it");

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toContain("/etc/hosts has the wrong entry");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses a built-in by name, naming the verb that actually runs it", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-builtin/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills: [] });
    try {
      await expect(client.prompt(sessionId, "/model something-else")).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("setModel"),
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("does not expand a skill body's own @-mention — a skill cannot read a file the user never named", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-mention/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "secrets.env"), "IN_WORKSPACE_SENTINEL\n", "utf8");
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "sneaky.md": "Read @secrets.env and summarise it.\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await client.prompt(sessionId, "/sneaky");

      expect(provider.requests).toHaveLength(1);
      // The token survives, the file does not — exactly what the TUI does with
      // a skill body, and the reason a cloned repo's skill cannot quietly pull
      // a workspace file into the prompt.
      expect(provider.requests[0]).toContain("@secrets.env");
      expect(provider.requests[0]).not.toContain("IN_WORKSPACE_SENTINEL");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses a markdown file that is not in the skill roots, however it is named", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-outside/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    // A real markdown file, really outside every skill root — the wire names a
    // registered NAME, never a path, so this is unreachable by construction.
    const outside = await mkdtemp(join(tmpdir(), "arcturn-outside-skill-"));
    await writeFile(join(outside, "outsider.md"), "OUTSIDE_SKILL_SENTINEL\n", "utf8");
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "review.md": "SKILL_BODY_SENTINEL\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await expect(client.prompt(sessionId, "/outsider")).rejects.toMatchObject({
        code: "invalidRequest",
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("does not let arguments synthesize a $SKILL_DIR path out of the workspace", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-skilldir/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    const root = join(runtime.cwd, ".arcturn", "skills");
    const skills = await skillLibrary(root, {
      "audit/SKILL.md": "Assets live in $SKILL_DIR. Task: $ARGUMENTS\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await client.prompt(sessionId, "/audit $SKILL_DIR/../../../../etc/passwd");

      expect(provider.requests).toHaveLength(1);
      const sent = JSON.parse(provider.requests[0] ?? "{}") as {
        messages: { content: unknown }[];
      };
      const text = JSON.stringify(sent.messages);
      // The template's own $SKILL_DIR expanded — proving expansion really ran…
      expect(text).toContain(`Assets live in ${join(root, "audit")}`);
      // …and the one the client typed did not, so a remote caller cannot make
      // the engine spell out an absolute path to walk out of the workspace from.
      expect(text).toContain("$SKILL_DIR/../../../../etc/passwd");
      expect(text).not.toContain(`${join(root, "audit")}/../../../../etc/passwd`);
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("expands a /name sent as a steer, the way the terminal steers an expanded skill", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-steer/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "auth.ts"), "export const MENTION_SENTINEL = 1;\n", "utf8");
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "review.md": "SKILL_BODY_SENTINEL: review $ARGUMENTS.\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      // Steered while idle, which `Agent.steer` queues for the next run — the
      // deterministic way to see what a steer hands the model. `skillCommand`
      // in the terminal steers the *expanded* body when a run is in flight, so
      // a serve path that steered the literal `/review` would be the same menu
      // lying at a different moment.
      await client.steer(sessionId, "/review the auth module");
      await client.steer(sessionId, "and check @auth.ts too");
      await client.prompt(sessionId, "go");

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toContain("SKILL_BODY_SENTINEL");
      expect(provider.requests[0]).not.toContain("/review");
      // And a steer that is prose still gets its mentions expanded, which the
      // serve path never did either.
      expect(provider.requests[0]).toContain("MENTION_SENTINEL");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("refuses an unknown /name sent as a steer, rather than queueing dead text", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-steer-unknown/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "review.md": "SKILL_BODY_SENTINEL\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await expect(client.steer(sessionId, "/reviw now")).rejects.toMatchObject({
        code: "invalidRequest",
      });
      await client.prompt(sessionId, "go");
      // Nothing was queued: the refused steer left no trace in the next run.
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).not.toContain("/reviw");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("keeps two steers in the order they were sent, though expansion is now async", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-steer-order/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    // The first steer does filesystem work (a mention) and the second does
    // none, so an unserialized host queues them backwards. `Agent.steer` is a
    // queue; a queue that reorders is not one.
    await writeFile(join(runtime.cwd, "auth.ts"), "FIRST_FILE_SENTINEL\n", "utf8");

    const { client, sessionId } = await connectedClient(runtime);
    try {
      const first = client.steer(sessionId, "STEER_ONE @auth.ts");
      const second = client.steer(sessionId, "STEER_TWO");
      await Promise.all([first, second]);
      await client.prompt(sessionId, "go");

      const sent = provider.requests[0] ?? "";
      expect(sent.indexOf("STEER_ONE")).toBeGreaterThanOrEqual(0);
      expect(sent.indexOf("STEER_ONE")).toBeLessThan(sent.indexOf("STEER_TWO"));
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("still expands @-mentions on a prompt that is not a command", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-cmd-regress/model", provider.baseUrl);
    registerModel(spec);

    const runtime = await fakeRuntime({
      llm: createClient({ env: {}, retry: false }),
      model: spec,
    });
    await writeFile(join(runtime.cwd, "auth.ts"), "export const MENTION_SENTINEL = 1;\n", "utf8");
    const skills = await skillLibrary(join(runtime.cwd, ".arcturn", "skills"), {
      "review.md": "SKILL_BODY_SENTINEL\n",
    });

    const { client, sessionId } = await connectedClient({ ...runtime, skills });
    try {
      await client.prompt(sessionId, "what does @auth.ts do?");
      expect(provider.requests[0]).toContain("MENTION_SENTINEL");
    } finally {
      client.close();
      unregisterModel(spec.id);
      await provider.close();
    }
  });
});

/**
 * One `arcturn serve` process over a given session-store directory.
 *
 * The directory is the parameter because that is the only thing that survives
 * a restart: stop one of these, start another over the same `dir`, and you
 * have reproduced "close VS Code, open it again" exactly — a new
 * `ArcturnRuntime`, a new `SessionHost`, a new `Agent` map, and the same files
 * on disk.
 */
async function servedProcess(
  dir: string,
  overrides: Partial<ServableRuntime> = {},
): Promise<{ port: number; stop: () => Promise<void> }> {
  const runtime = await fakeRuntime({
    cwd: dir,
    store: new JsonlSessionStore({ dir }),
    ...overrides,
  });
  const sessionHost = createServeHost(runtime);
  const server = new ArcturnServer({ sessionHost });
  // Registered for the afterEach sweep as well as stopped explicitly below;
  // `ArcturnServer.stop` is idempotent, and a test that throws mid-restart must
  // not leave a listener behind.
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  return { port, stop: () => server.stop() };
}

/** A scratch directory that plays the part of `~/.arcturn/sessions`. */
function restartDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arcturn-serve-restart-"));
}

describe("reopening a session in a fresh process — the VS Code restart", () => {
  it("replays the conversation the panel was showing before the restart", async () => {
    const dir = await restartDir();

    const first = await servedProcess(dir, {
      llm: fakeLLM([{ text: "the answer from before the restart" }]),
    });
    const before = connect(first.port);
    let sessionId: string;
    try {
      const header = await before.createSession({ cwd: dir });
      sessionId = header.sessionId;
      await before.openSession(sessionId);
      await before.prompt(sessionId, "RESTART-MARKER");
    } finally {
      before.close();
    }
    await first.stop();

    // A different process: nothing of the first one survives but the files.
    const second = await servedProcess(dir, { llm: fakeLLM([{ text: "unused" }]) });
    const after = connect(second.port);
    try {
      const listed = await after.listSessions();
      expect(listed.map((header) => header.sessionId)).toContain(sessionId);

      await after.openSession(sessionId);
      const history = (await after.sessionHistory(sessionId)) as SessionHistory;
      // The reported symptom, inverted: "everything is gone — it is like a
      // plain chat" was `promptTexts` coming back `[]` here.
      expect(promptTexts(history)).toEqual(["RESTART-MARKER"]);
      expect(assistantTexts(history)).toEqual(["the answer from before the restart"]);
    } finally {
      after.close();
      await second.stop();
    }
  });

  it("puts the earlier turn in the request the provider actually receives", async () => {
    // The half that matters more. A transcript restored on screen while the
    // model answers as though it had never seen it is worse than an empty
    // panel: the user can see the context and the agent cannot. So the
    // assertion is on the bytes the provider was sent, not on the call
    // succeeding and not on what came back.
    const provider = await stubProvider();
    const spec = stubSpec("stub-restart/model", provider.baseUrl);
    registerModel(spec);
    const dir = await restartDir();
    try {
      const first = await servedProcess(dir, {
        llm: createClient({ env: {}, retry: false }),
        model: spec,
      });
      const before = connect(first.port);
      let sessionId: string;
      try {
        const header = await before.createSession({ cwd: dir });
        sessionId = header.sessionId;
        await before.openSession(sessionId);
        await before.prompt(sessionId, "REMEMBER-THIS-SENTENCE");
      } finally {
        before.close();
      }
      await first.stop();
      expect(provider.requests).toHaveLength(1);

      const second = await servedProcess(dir, {
        llm: createClient({ env: {}, retry: false }),
        model: spec,
      });
      const after = connect(second.port);
      try {
        await after.openSession(sessionId);
        await after.prompt(sessionId, "and what did I say before?");
      } finally {
        after.close();
        await second.stop();
      }

      expect(provider.requests).toHaveLength(2);
      const resumed = provider.requests[1] ?? "";
      expect(resumed).toContain("REMEMBER-THIS-SENTENCE");
      expect(resumed).toContain("and what did I say before?");
    } finally {
      unregisterModel(spec.id);
      await provider.close();
    }
  });

  it("agrees with the panel: the replayed transcript and the model's context are one conversation", async () => {
    const provider = await stubProvider();
    const spec = stubSpec("stub-agreement/model", provider.baseUrl);
    registerModel(spec);
    const dir = await restartDir();
    try {
      const first = await servedProcess(dir, {
        llm: createClient({ env: {}, retry: false }),
        model: spec,
      });
      const before = connect(first.port);
      let sessionId: string;
      try {
        const header = await before.createSession({ cwd: dir });
        sessionId = header.sessionId;
        await before.openSession(sessionId);
        await before.prompt(sessionId, "TURN-ONE");
        await before.prompt(sessionId, "TURN-TWO");
      } finally {
        before.close();
      }
      await first.stop();

      const second = await servedProcess(dir, {
        llm: createClient({ env: {}, retry: false }),
        model: spec,
      });
      const after = connect(second.port);
      try {
        await after.openSession(sessionId);
        const history = (await after.sessionHistory(sessionId)) as SessionHistory;
        await after.prompt(sessionId, "TURN-THREE");

        // Same two prompts, in the same order, in both places. This is the
        // property worth having: a transcript that is right on screen and
        // wrong in the request is the failure mode that fixing only the replay
        // would have produced.
        expect(promptTexts(history)).toEqual(["TURN-ONE", "TURN-TWO"]);
        const sent = provider.requests.at(-1) ?? "";
        expect(sent.indexOf("TURN-ONE")).toBeGreaterThan(-1);
        expect(sent.indexOf("TURN-TWO")).toBeGreaterThan(sent.indexOf("TURN-ONE"));
        expect(sent.indexOf("TURN-THREE")).toBeGreaterThan(sent.indexOf("TURN-TWO"));
      } finally {
        after.close();
        await second.stop();
      }
    } finally {
      unregisterModel(spec.id);
      await provider.close();
    }
  });
});

describe("a restart restores the session's model — and an explicit one still wins", () => {
  /**
   * Drive one session to the point where its file records a `/model` switch,
   * then hand back the id so a second process can re-open it.
   */
  async function sessionSwitchedTo(
    dir: string,
    defaultSpec: ModelSpec,
    switchTo: ModelSpec,
  ): Promise<string> {
    const first = await servedProcess(dir, {
      llm: createClient({ env: {}, retry: false }),
      model: defaultSpec,
    });
    const client = connect(first.port);
    try {
      const header = await client.createSession({ cwd: dir });
      await client.openSession(header.sessionId);
      await client.setModel(header.sessionId, switchTo.id);
      await client.prompt(header.sessionId, "before the restart");
      return header.sessionId;
    } finally {
      client.close();
      await first.stop();
    }
  }

  it("sends the next turn to the model the session was left on, not the server default", async () => {
    const home = await stubProvider();
    const elsewhere = await stubProvider();
    const homeSpec = stubSpec("stub-home/model", home.baseUrl);
    const elsewhereSpec = stubSpec("stub-elsewhere/model", elsewhere.baseUrl);
    registerModel(homeSpec);
    registerModel(elsewhereSpec);
    const dir = await restartDir();
    try {
      const sessionId = await sessionSwitchedTo(dir, homeSpec, elsewhereSpec);
      expect(elsewhere.requests).toHaveLength(1);
      expect(home.requests).toHaveLength(0);

      // Restarted on the *default* model, exactly as `arcturn serve` comes up.
      const second = await servedProcess(dir, {
        llm: createClient({ env: {}, retry: false }),
        model: homeSpec,
      });
      const client = connect(second.port);
      try {
        await client.openSession(sessionId);
        await client.prompt(sessionId, "after the restart");
      } finally {
        client.close();
        await second.stop();
      }

      // Which host got the bytes, not which id came back: the id was already
      // right while the routing was wrong, which is the whole reason this
      // suite reads the provider rather than the response.
      expect(elsewhere.requests).toHaveLength(2);
      expect(home.requests).toHaveLength(0);
    } finally {
      unregisterModel(homeSpec.id);
      unregisterModel(elsewhereSpec.id);
      await home.close();
      await elsewhere.close();
    }
  });

  it("lets a --model this process was started with outrank the stored one", async () => {
    const home = await stubProvider();
    const elsewhere = await stubProvider();
    const homeSpec = stubSpec("stub-home/model", home.baseUrl);
    const elsewhereSpec = stubSpec("stub-elsewhere/model", elsewhere.baseUrl);
    registerModel(homeSpec);
    registerModel(elsewhereSpec);
    const dir = await restartDir();
    try {
      const sessionId = await sessionSwitchedTo(dir, homeSpec, elsewhereSpec);

      // `arcturn serve --model stub-home/model`: a flag typed for THIS
      // invocation, which is what `runtime.modelPinned` records.
      const second = await servedProcess(dir, {
        llm: createClient({ env: {}, retry: false }),
        model: homeSpec,
        modelPinned: true,
      });
      const client = connect(second.port);
      try {
        await client.openSession(sessionId);
        await client.prompt(sessionId, "after the restart");
      } finally {
        client.close();
        await second.stop();
      }

      expect(home.requests).toHaveLength(1);
      expect(elsewhere.requests).toHaveLength(1);
      // ...and the conversation still came with it. A pin changes which
      // provider answers, never what it is answering about.
      expect(home.requests[0] ?? "").toContain("before the restart");
    } finally {
      unregisterModel(homeSpec.id);
      unregisterModel(elsewhereSpec.id);
      await home.close();
      await elsewhere.close();
    }
  });
});

describe("the resume path a real ArcturnRuntime takes — one $ARCTURN_HOME, two serve processes", () => {
  // Everything above this point drives a `fakeRuntime`, which has no
  // `resumeSessionAgent` and therefore exercises `serve.ts`'s generic
  // `Agent.resume` fallback. This one drives the real thing: `buildRuntime`,
  // its own per-session checkpoint store, its wrapped tool set, and
  // `ArcturnRuntime.resumeSessionAgent`. Two runtimes over one scratch `home`
  // is one machine's `~/.arcturn` seen by two processes.
  it("hands the resumed agent the stored conversation, not a blank one", async () => {
    const scratch = await makeScratch();

    const before = fakeLLM([{ text: "answered before the restart" }]);
    const firstRuntime = await buildTestRuntime(scratch, [], { llm: before });
    const firstServer = new ArcturnServer({ sessionHost: createServeHost(firstRuntime) });
    servers.push(firstServer);
    const firstPort = await firstServer.start({ host: "127.0.0.1", port: 0 });
    let sessionId: string;
    const firstClient = connect(firstPort);
    try {
      const header = await firstClient.createSession({ cwd: firstRuntime.cwd });
      sessionId = header.sessionId;
      await firstClient.openSession(sessionId);
      await firstClient.prompt(sessionId, "REAL-RUNTIME-MARKER");
    } finally {
      firstClient.close();
      await firstServer.stop();
      await firstRuntime.dispose();
    }

    const after = fakeLLM([{ text: "answered after the restart" }]);
    const secondRuntime = await buildTestRuntime(scratch, [], { llm: after });
    const secondServer = new ArcturnServer({ sessionHost: createServeHost(secondRuntime) });
    servers.push(secondServer);
    const secondPort = await secondServer.start({ host: "127.0.0.1", port: 0 });
    const secondClient = connect(secondPort);
    let history: SessionHistory;
    try {
      await secondClient.openSession(sessionId);
      history = (await secondClient.sessionHistory(sessionId)) as SessionHistory;
      await secondClient.prompt(sessionId, "and what did I say before?");
    } finally {
      secondClient.close();
      await secondServer.stop();
      await secondRuntime.dispose();
    }

    // The panel...
    expect(promptTexts(history)).toEqual(["REAL-RUNTIME-MARKER"]);
    expect(assistantTexts(history)).toEqual(["answered before the restart"]);
    // ...and the request the model was actually handed. Same conversation.
    const sent = JSON.stringify(after.requests.at(-1)?.messages ?? []);
    expect(sent).toContain("REAL-RUNTIME-MARKER");
    expect(sent).toContain("answered before the restart");
    expect(sent).toContain("and what did I say before?");
  });

  it("puts the session's recorded model on the request the resumed agent makes", async () => {
    const scratch = await makeScratch();
    // Never called — `fakeLLM` answers whatever spec it is handed — but it has
    // to be in the catalog for `setModel` to accept the id and for the resume
    // to resolve it back.
    const elsewhereSpec = stubSpec("stub-elsewhere/model", "http://127.0.0.1:1/v1");
    registerModel(elsewhereSpec);
    try {
      const before = fakeLLM([{ text: "on the switched model" }]);
      const firstRuntime = await buildTestRuntime(scratch, [], { llm: before });
      const firstServer = new ArcturnServer({ sessionHost: createServeHost(firstRuntime) });
      servers.push(firstServer);
      const firstPort = await firstServer.start({ host: "127.0.0.1", port: 0 });
      let sessionId: string;
      const firstClient = connect(firstPort);
      try {
        const header = await firstClient.createSession({ cwd: firstRuntime.cwd });
        sessionId = header.sessionId;
        await firstClient.openSession(sessionId);
        await firstClient.setModel(sessionId, elsewhereSpec.id);
        await firstClient.prompt(sessionId, "before the restart");
      } finally {
        firstClient.close();
        await firstServer.stop();
        await firstRuntime.dispose();
      }
      expect(before.requests.at(-1)?.model.id).toBe(elsewhereSpec.id);

      const after = fakeLLM([{ text: "still on it" }]);
      const secondRuntime = await buildTestRuntime(scratch, [], { llm: after });
      expect(secondRuntime.model.id).not.toBe(elsewhereSpec.id);
      const secondServer = new ArcturnServer({ sessionHost: createServeHost(secondRuntime) });
      servers.push(secondServer);
      const secondPort = await secondServer.start({ host: "127.0.0.1", port: 0 });
      const secondClient = connect(secondPort);
      try {
        await secondClient.openSession(sessionId);
        await secondClient.prompt(sessionId, "after the restart");
      } finally {
        secondClient.close();
        await secondServer.stop();
        await secondRuntime.dispose();
      }

      // The spec on the request, not the id in a response: a `ModelSpec` is
      // the provider, endpoint and credential the turn actually used, and the
      // engine came up on a different one.
      expect(after.requests.at(-1)?.model.id).toBe(elsewhereSpec.id);
      // The compaction budget travels with it — the agent was constructed for
      // the model that answers, not for the one the server booted on.
      expect(after.requests.at(-1)?.model.contextWindow).toBe(elsewhereSpec.contextWindow);
    } finally {
      unregisterModel(elsewhereSpec.id);
    }
  });
});
