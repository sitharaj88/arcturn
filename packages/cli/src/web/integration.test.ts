/**
 * End-to-end tests: the *page's own* client code, loaded from the script it
 * ships, driving a real {@link ArcturnServer} over a real WebSocket on
 * `127.0.0.1:0`, backed by a scripted LLM.
 *
 * No browser, no network, no API key — but every layer between the page's
 * `createClient` and the agent is the production one, which is what makes the
 * `permissionRequest` → `permissionDecision` round trip worth asserting here
 * rather than against a mock.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@arcturn/core";
import { ArcturnServer } from "@arcturn/server";
import type { AgentEvent, ModelSpec, SessionHeader, Tool } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createServeHost, type ServableRuntime } from "../serve.js";
import { fakeLLM } from "../test-helpers/fake-llm.js";
import { webClientOrigins } from "./server.js";
import {
  type ClientSocket,
  FakeDocument,
  FakeElement,
  loadWebClient,
  textOf,
  type ViewState,
} from "./test-helpers/load.js";

const { model, app } = loadWebClient();

const TEST_MODEL: ModelSpec = {
  id: "test/model",
  provider: "anthropic",
  model: "test-model",
  displayName: "Test Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
};

/** A tool that is not read-only, so the default permission mode must ask. */
const dangerTool: Tool = {
  definition: {
    name: "danger",
    description: "Does something that needs approval.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  execute: async (input) => ({
    content: [{ type: "text", text: `ran ${String(input.command)}` }],
  }),
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Started {
  url: string;
  port: number;
}

/** Boot a real server with a scripted LLM and register its teardown. */
async function startServer(options: {
  turns: Parameters<typeof fakeLLM>[0];
  token?: string;
  tools?: Tool[];
  permissionMode?: "default" | "yolo";
}): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-web-test-"));
  const runtime: ServableRuntime = {
    llm: fakeLLM(options.turns),
    model: TEST_MODEL,
    cwd: dir,
    env: {},
    store: new JsonlSessionStore({ dir }),
    systemPrompt: "You are a test agent.",
    tools: options.tools ?? [],
    config: { permissions: [], permissionMode: options.permissionMode ?? "yolo" },
    dispose: async () => {},
  };
  const server = new ArcturnServer({
    sessionHost: createServeHost(runtime),
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { url: `ws://127.0.0.1:${port}`, port };
}

interface Session {
  client: ReturnType<typeof app.createClient>;
  state: ViewState;
  statuses: string[];
  sockets: WebSocket[];
  waitFor(predicate: () => boolean, label: string): Promise<void>;
}

/** Connect the page's client to a running server and drive it like the page. */
function connect(server: Started, token?: string): Session {
  const state = model.createState();
  const statuses: string[] = [];
  const sockets: WebSocket[] = [];
  const client = app.createClient({
    url: server.url,
    ...(token === undefined ? {} : { token }),
    socketFactory: (url) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      return socket as unknown as ClientSocket;
    },
    probeIntervalMs: 0,
    onStatus: (status) => statuses.push(status),
    onEvent: (_sessionId, event: AgentEvent) => {
      model.applyEvent(state, event);
    },
  });
  cleanups.push(async () => {
    client.close();
    for (const socket of sockets) socket.terminate();
  });
  return {
    client,
    get state() {
      return state;
    },
    statuses,
    sockets,
    waitFor: (predicate, label) => waitFor(predicate, label),
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Open the newest session, creating one when the server has none. */
async function attach(session: Session, cwdHint = "."): Promise<SessionHeader> {
  const listed = (await session.client.request("listSessions")) as { sessions: SessionHeader[] };
  const newest = listed.sessions.sort((a, b) => b.createdAt - a.createdAt)[0];
  const target =
    newest ?? ((await session.client.request("createSession", { cwd: cwdHint })) as SessionHeader);
  return (await session.client.request("openSession", {
    sessionId: target.sessionId,
  })) as SessionHeader;
}

describe("browser client against a real arcturn serve", () => {
  it("authenticates with the shared token and lists sessions", async () => {
    const server = await startServer({ turns: [{ text: "hi" }], token: "correct-horse" });
    const session = connect(server, "correct-horse");
    session.client.connect();

    await session.waitFor(() => session.client.getStatus() === "online", "the handshake");
    const listed = (await session.client.request("listSessions")) as { sessions: SessionHeader[] };
    expect(Array.isArray(listed.sessions)).toBe(true);
    expect(session.statuses).toEqual(["connecting", "authenticating", "online"]);
  });

  it("reports a rejected token clearly and gives up instead of hammering the server", async () => {
    const server = await startServer({ turns: [{ text: "hi" }], token: "correct-horse" });
    const session = connect(server, "wrong-token");
    session.client.connect();

    await session.waitFor(
      () => session.client.getStatus() === "unauthorized",
      "the rejection to land",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(session.sockets).toHaveLength(1);
  });

  it("is rejected when it presents no token at all", async () => {
    const server = await startServer({ turns: [{ text: "hi" }], token: "correct-horse" });
    const session = connect(server);
    session.client.connect();
    await session.waitFor(() => session.client.getStatus() === "online", "the socket to open");
    await expect(session.client.request("listSessions")).rejects.toMatchObject({
      code: "invalidRequest",
    });
    await session.waitFor(
      () => session.client.getStatus() === "unauthorized",
      "the server to close the connection",
    );
  });

  it("connects without a handshake when the server has no token", async () => {
    const server = await startServer({ turns: [{ text: "hi" }] });
    const session = connect(server);
    session.client.connect();
    await session.waitFor(() => session.client.getStatus() === "online", "the socket to open");
    await expect(session.client.request("listSessions")).resolves.toBeTruthy();
  });

  it("streams a whole run into the transcript the page renders", async () => {
    const server = await startServer({ turns: [{ text: "hello from the agent" }] });
    const session = connect(server);
    session.client.connect();
    await session.waitFor(() => session.client.getStatus() === "online", "the socket to open");
    const header = await attach(session);

    await session.client.request(
      "prompt",
      { sessionId: header.sessionId, text: "say hello" },
      { timeoutMs: 0 },
    );
    await session.waitFor(() => session.state.running === false, "the run to end");

    const doc = new FakeDocument();
    const container = new FakeElement("main");
    app.mount(doc, container, model.transcriptNodes(session.state));
    const text = textOf(container);
    expect(text).toContain("say hello");
    expect(text).toContain("hello from the agent");
  });

  it("completes the permissionRequest → permissionDecision round trip", async () => {
    const server = await startServer({
      turns: [
        { toolCalls: [{ id: "t1", name: "danger", arguments: { command: "rm -rf /tmp/nope" } }] },
        { text: "done" },
      ],
      tools: [dangerTool],
      permissionMode: "default",
    });
    const session = connect(server);
    session.client.connect();
    await session.waitFor(() => session.client.getStatus() === "online", "the socket to open");
    const header = await attach(session);

    const run = session.client.request(
      "prompt",
      { sessionId: header.sessionId, text: "do the thing" },
      { timeoutMs: 0 },
    );

    await session.waitFor(() => session.state.permissions.length === 1, "the permission ask");
    const request = session.state.permissions[0];
    expect(request?.toolName).toBe("danger");
    // The user must be able to read exactly what they are approving.
    expect(request?.subject).toBe("rm -rf /tmp/nope");
    const sheet = new FakeElement("div");
    app.mount(new FakeDocument(), sheet, model.permissionNodes(request));
    expect(textOf(sheet)).toContain("rm -rf /tmp/nope");

    await session.client.request("permissionDecision", {
      sessionId: header.sessionId,
      decision: { requestId: request?.id, behavior: "allow" },
    });

    await run;
    expect(session.state.permissions).toHaveLength(0);
    const doc = new FakeDocument();
    const container = new FakeElement("main");
    app.mount(doc, container, model.transcriptNodes(session.state));
    expect(textOf(container)).toContain("ran rm -rf /tmp/nope");
  });

  it("denies a permission request and lets the run finish", async () => {
    const server = await startServer({
      turns: [
        { toolCalls: [{ id: "t1", name: "danger", arguments: { command: "sudo rm -rf /" } }] },
        { text: "understood" },
      ],
      tools: [dangerTool],
      permissionMode: "default",
    });
    const session = connect(server);
    session.client.connect();
    await session.waitFor(() => session.client.getStatus() === "online", "the socket to open");
    const header = await attach(session);
    const run = session.client.request(
      "prompt",
      { sessionId: header.sessionId, text: "go" },
      { timeoutMs: 0 },
    );

    await session.waitFor(() => session.state.permissions.length === 1, "the permission ask");
    await session.client.request("permissionDecision", {
      sessionId: header.sessionId,
      decision: {
        requestId: session.state.permissions[0]?.id,
        behavior: "deny",
        message: "The user denied this action.",
      },
    });

    await run;
    const doc = new FakeDocument();
    const container = new FakeElement("main");
    app.mount(doc, container, model.transcriptNodes(session.state));
    expect(textOf(container)).toContain("denied");
  });

  it("aborts a run in flight", async () => {
    const server = await startServer({
      turns: [{ text: "slow answer", delayMs: 400 }],
    });
    const session = connect(server);
    session.client.connect();
    await session.waitFor(() => session.client.getStatus() === "online", "the socket to open");
    const header = await attach(session);
    const run = session.client.request(
      "prompt",
      { sessionId: header.sessionId, text: "start" },
      { timeoutMs: 0 },
    );
    await session.waitFor(() => session.state.running === true, "the run to start");
    await session.client.request("abort", { sessionId: header.sessionId });
    await run;
    expect(session.state.running).toBe(false);
  });

  it("reconnects after the socket drops and resubscribes to the same session", async () => {
    const server = await startServer({ turns: [{ text: "second answer" }] });
    let ready = 0;
    const state = model.createState();
    const sockets: WebSocket[] = [];
    let header: SessionHeader | undefined;
    const client = app.createClient({
      url: server.url,
      socketFactory: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as unknown as ClientSocket;
      },
      probeIntervalMs: 0,
      backoff: { baseMs: 10, maxMs: 40 },
      onEvent: (_sessionId, event: AgentEvent) => {
        model.applyEvent(state, event);
      },
      onReady: () => {
        ready += 1;
        // This is exactly what the page does on every (re)connect: re-open the
        // session, which re-attaches the server-side observer.
        void (async () => {
          if (!header) {
            header = (await client.request("createSession", { cwd: "." })) as SessionHeader;
          }
          await client.request("openSession", { sessionId: header.sessionId });
        })();
      },
    });
    cleanups.push(async () => {
      client.close();
      for (const socket of sockets) socket.terminate();
    });

    client.connect();
    await waitFor(() => ready === 1 && header !== undefined, "the first attach");
    await waitFor(() => sockets.length === 1, "one socket");

    // A phone losing its network: the socket dies without a clean close.
    sockets[0]?.terminate();
    await waitFor(() => ready === 2, "the reconnect and resubscribe");
    await waitFor(() => client.getStatus() === "online", "the client to be online again");

    // The resubscribed connection really does receive this session's events.
    await client.request(
      "prompt",
      { sessionId: (header as SessionHeader).sessionId, text: "again" },
      { timeoutMs: 0 },
    );
    await waitFor(() => state.blocks.length > 0, "events after the reconnect");
    const doc = new FakeDocument();
    const container = new FakeElement("main");
    app.mount(doc, container, model.transcriptNodes(state));
    expect(textOf(container)).toContain("second answer");
  });
});

describe("origin gating (the wiring runServe performs)", () => {
  /** Open a raw socket with an Origin header, as a browser always does. */
  function upgrade(url: string, origin: string): Promise<"open" | "refused"> {
    return new Promise((resolve) => {
      const socket = new WebSocket(url, { headers: { origin } });
      cleanups.push(async () => socket.terminate());
      socket.on("open", () => resolve("open"));
      socket.on("error", () => resolve("refused"));
    });
  }

  it("accepts the page's own origin and refuses any other site", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcturn-web-origin-"));
    const runtime: ServableRuntime = {
      llm: fakeLLM([{ text: "hi" }]),
      model: TEST_MODEL,
      cwd: dir,
      env: {},
      store: new JsonlSessionStore({ dir }),
      systemPrompt: "You are a test agent.",
      tools: [],
      config: { permissions: [], permissionMode: "yolo" },
      dispose: async () => {},
    };
    const webPort = 8788;
    const server = new ArcturnServer({
      sessionHost: createServeHost(runtime),
      allowedOrigins: webClientOrigins("127.0.0.1", webPort),
    });
    const port = await server.start({ host: "127.0.0.1", port: 0 });
    cleanups.push(async () => {
      await server.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });
    const url = `ws://127.0.0.1:${port}`;

    expect(await upgrade(url, `http://127.0.0.1:${webPort}`)).toBe("open");
    expect(await upgrade(url, `http://localhost:${webPort}`)).toBe("open");
    // A page on any other origin cannot drive this server, even on loopback.
    expect(await upgrade(url, "http://evil.example")).toBe("refused");
    expect(await upgrade(url, `http://127.0.0.1:${webPort + 1}`)).toBe("refused");
  });
});
