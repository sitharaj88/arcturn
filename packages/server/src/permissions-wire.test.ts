/**
 * RFC 0005 §1.2 / §1.3 / §1.4 — permission state, permission mode and command
 * discovery, exercised end to end: a real {@link ArcturnServer} bound to a real
 * port, a real {@link createProtocolClient} over a real `ws` socket, and a real
 * {@link PermissionEngine} inside a real {@link Agent}.
 *
 * The decisive test in this file is **"a deny rule beats `yolo` set over the
 * wire"**, and it deliberately asserts on whether the tool's `execute` ran —
 * not on the mode string that came back. A mode is a request; the engine is
 * the authority; the only proof of that is a tool that did not run.
 */

import { Agent, MemorySessionStore } from "@arcturn/core";
import {
  createProtocolClient,
  ProtocolClientError,
  type ProtocolRequestError,
} from "@arcturn/protocol";
import type { AgentEvent, LLMClient, PermissionRule, Tool } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  REMOTE_BUILT_IN_COMMAND_VERBS,
  REMOTE_REACHABLE_BUILT_IN_COMMANDS,
} from "./built-in-commands.js";
import { SessionHost, type SessionHostOptions } from "./session-host.js";
import {
  createGatedLLM,
  createScriptedLLM,
  TEST_MODEL,
  textTurn,
  toolCallTurn,
} from "./test-helpers/fake-llm.js";
import { ArcturnServer } from "./ws-server.js";

/** A tool that records whether it actually ran. The point of the whole file. */
function createSpyTool(name = "guarded"): Tool & { ran: () => number } {
  let runs = 0;
  return {
    ran: () => runs,
    definition: {
      name,
      description: "Test tool that always requires permission.",
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
    async execute() {
      runs++;
      return { content: [{ type: "text", text: `ran ${name}` }] };
    },
  };
}

/** Poll until `predicate` holds, or fail loudly rather than hang the suite. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function waitForFrame(frames: { id?: string }[], id: string): Promise<void> {
  return waitFor(() => frames.some((frame) => frame.id === id));
}

function isPermissionRequest(frame: unknown): boolean {
  const event = (frame as { event?: { type?: string } }).event;
  return event?.type === "permissionRequest";
}

function permissionRequestId(frames: unknown[]): string {
  for (const frame of frames) {
    const event = (frame as { event?: { type?: string; request?: { id: string } } }).event;
    if (event?.type === "permissionRequest" && event.request) return event.request.id;
  }
  throw new Error("No permissionRequest event was received");
}

const servers: ArcturnServer[] = [];
const clients: { close(): void }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
});

interface Harness {
  client: ReturnType<typeof createProtocolClient>;
  sessionId: string;
  events: AgentEvent[];
}

async function harness(
  llm: LLMClient,
  tools: Tool[],
  rules: PermissionRule[] = [],
  extra: Partial<SessionHostOptions> = {},
): Promise<Harness> {
  const host = buildHost(llm, tools, rules, extra);
  const server = new ArcturnServer({ sessionHost: host });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
  clients.push(client);
  const events: AgentEvent[] = [];
  client.onEvent((_sessionId, event) => events.push(event));
  const header = await client.createSession({ cwd: "/tmp/arcturn-perm-wire" });
  await client.openSession(header.sessionId);
  return { client, sessionId: header.sessionId, events };
}

function buildHost(
  llm: LLMClient,
  tools: Tool[],
  rules: PermissionRule[],
  extra: Partial<SessionHostOptions>,
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
        sessionStore: new MemorySessionStore(),
        permissions: { mode: "default", rules },
      }),
    defaultCwd: "/tmp/arcturn-perm-wire",
    permissionTimeoutMs: 60_000,
    ...extra,
  });
}

describe("RFC 0005 §1.2 — a mode is a request, the engine is the authority", () => {
  it("a deny rule still beats yolo set over the wire: the tool never runs", async () => {
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const { client, sessionId } = await harness(
      llm,
      [tool],
      [{ tool: "guarded", action: "deny", scope: "user" }],
    );

    // The mode really is yolo — so a tool that does not run cannot be blamed
    // on the mode never having been set.
    const state = await client.setPermissionMode(sessionId, "yolo");
    expect(state.mode).toBe("yolo");
    expect(await client.permissionState(sessionId)).toMatchObject({ mode: "yolo" });

    await client.prompt(sessionId, "call the guarded tool");

    // THE assertion: not a mode string, a tool that did not execute.
    expect(tool.ran()).toBe(0);
  });

  it("yolo set over the wire does allow a tool no rule denies (the control)", async () => {
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const { client, sessionId } = await harness(llm, [tool]);

    await client.setPermissionMode(sessionId, "yolo");
    await client.prompt(sessionId, "call the guarded tool");

    expect(tool.ran()).toBe(1);
  });

  it("plan mode set over the wire refuses a state-changing tool", async () => {
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const { client, sessionId } = await harness(llm, [tool]);

    await client.setPermissionMode(sessionId, "plan");
    await client.prompt(sessionId, "call the guarded tool");

    expect(tool.ran()).toBe(0);
  });

  it("refuses a mode change mid-run rather than half-applying it", async () => {
    const tool = createSpyTool();
    const llm = createGatedLLM(textTurn("done"));
    const { client, sessionId } = await harness(llm, [tool]);

    const run = client.prompt(sessionId, "hello");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(client.setPermissionMode(sessionId, "yolo")).rejects.toMatchObject({
      code: "sessionBusy",
    });
    llm.release();
    await run;

    // Still the mode it started on: nothing was half-applied.
    expect((await client.permissionState(sessionId))?.mode).toBe("default");
  });
});

describe("RFC 0005 §1.2 / §1.4 — permissionState", () => {
  it("reports the mode, the rules and the tool names available to the session", async () => {
    const rules: PermissionRule[] = [
      { tool: "bash", specifier: "rm *", action: "deny", scope: "user" },
    ];
    const { client, sessionId } = await harness(
      createScriptedLLM([textTurn("hi")]),
      [createSpyTool("fetch"), createSpyTool("read")],
      rules,
    );

    const state = await client.permissionState(sessionId);
    expect(state).toMatchObject({ sessionId, mode: "default" });
    expect(state?.rules).toEqual(rules);
    // §1.4: no new verb for web — the tool list is the whole mechanism.
    expect(state?.tools).toEqual(["fetch", "read"]);
  });

  it("never edits rules: setPermissionMode leaves them exactly as they were", async () => {
    const rules: PermissionRule[] = [{ tool: "guarded", action: "deny", scope: "user" }];
    const { client, sessionId } = await harness(createScriptedLLM([textTurn("hi")]), [], rules);

    await client.setPermissionMode(sessionId, "acceptEdits");
    expect((await client.permissionState(sessionId))?.rules).toEqual(rules);
  });
});

describe("RFC 0005 §1.2 — a session-scoped allow, and nothing wider", () => {
  it('"allow for this session" adds the engine\'s own rule, so the next call is not asked', async () => {
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      toolCallTurn("call-2", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const { client, sessionId, events } = await harness(llm, [tool]);

    client.onEvent((_id, event) => {
      if (event.type === "permissionRequest") {
        void client.respondToPermission(
          sessionId,
          { requestId: event.request.id, behavior: "allow" },
          { scope: "session" },
        );
      }
    });

    await client.prompt(sessionId, "call it twice");

    expect(tool.ran()).toBe(2);
    // Asked once, not twice: the session-scoped rule settled the second call.
    expect(events.filter((event) => event.type === "permissionRequest")).toHaveLength(1);
    const state = await client.permissionState(sessionId);
    expect(state?.rules).toContainEqual(expect.objectContaining({ scope: "session" }));
  });

  it("refuses a project-scoped allow from a remote client", async () => {
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const { client, sessionId } = await harness(llm, [tool]);

    const refusals: unknown[] = [];
    client.onEvent((_id, event) => {
      if (event.type !== "permissionRequest") return;
      void client
        .respondToPermission(
          sessionId,
          { requestId: event.request.id, behavior: "allow" },
          { scope: "project" },
        )
        .catch((error: unknown) => {
          refusals.push(error);
          // Answer honestly afterwards so the run terminates.
          void client.respondToPermission(sessionId, {
            requestId: event.request.id,
            behavior: "deny",
            message: "no",
          });
        });
    });

    await client.prompt(sessionId, "call it");
    expect(refusals).toHaveLength(1);
    // Refused by the client's own outbound validation — the frame never left.
    // A UI bug fails immediately with a message saying where such a rule does
    // belong, rather than costing a round trip to be told the same thing.
    expect(refusals[0]).toBeInstanceOf(ProtocolClientError);
    expect((refusals[0] as ProtocolClientError).code).toBe("invalidRequest");
    expect(String(refusals[0])).toContain("may not outlive the session");
    expect(tool.ran()).toBe(0);
  });

  it("refuses it at the server too, for a client that skips the client library", async () => {
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const host = buildHost(llm, [tool], [], {});
    const server = new ArcturnServer({ sessionHost: host });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    // A raw socket: no ProtocolClient, no outbound validation, exactly what a
    // hostile client holding the serve token would send.
    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    const frames: { kind?: string; id?: string; error?: { code: string; message: string } }[] = [];
    raw.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString("utf8"))));
    await new Promise((resolve) => raw.once("open", resolve));
    try {
      raw.send(
        JSON.stringify({
          id: "1",
          method: "createSession",
          params: { cwd: "/tmp/arcturn-perm-wire" },
        }),
      );
      await waitForFrame(frames, "1");
      const sessionId = (frames.find((f) => f.id === "1") as { result: { sessionId: string } })
        .result.sessionId;
      raw.send(JSON.stringify({ id: "2", method: "openSession", params: { sessionId } }));
      await waitForFrame(frames, "2");
      raw.send(JSON.stringify({ id: "3", method: "prompt", params: { sessionId, text: "go" } }));
      await waitFor(() => frames.some((f) => f.kind === "event" && isPermissionRequest(f)));
      const requestId = permissionRequestId(frames);

      raw.send(
        JSON.stringify({
          id: "4",
          method: "permissionDecision",
          params: { sessionId, decision: { requestId, behavior: "allow" }, scope: "user" },
        }),
      );
      await waitForFrame(frames, "4");
      const refusal = frames.find((f) => f.id === "4") as { error?: { code: string } };
      expect(refusal.error?.code).toBe("invalidRequest");

      // The ask is still pending, so an honest answer still lands and the run
      // terminates — a refused decision does not settle the tool call.
      raw.send(
        JSON.stringify({
          id: "5",
          method: "permissionDecision",
          params: { sessionId, decision: { requestId, behavior: "deny", message: "no" } },
        }),
      );
      await waitForFrame(frames, "3");
      expect(tool.ran()).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("SessionHost itself refuses a wider scope, whatever transport asks", async () => {
    // The wall is not the wire's: an SDK embedder wiring its own transport
    // gets the same refusal, because a rule this important may not depend on
    // which door a decision came through.
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const host = buildHost(llm, [tool], [], {});
    const header = await host.createSession({ cwd: "/tmp/arcturn-perm-wire" });
    let requestId = "";
    host.observe(header.sessionId, (event) => {
      if (event.type === "permissionRequest") requestId = event.request.id;
    });
    const run = host.prompt(header.sessionId, "go");
    await waitFor(() => requestId !== "");

    expect(() =>
      host.handlePermissionDecision(header.sessionId, { requestId, behavior: "allow" }, "project"),
    ).toThrow(/may not outlive the session/);
    expect(() =>
      host.handlePermissionDecision(header.sessionId, {
        requestId,
        behavior: "allow",
        persistRule: { tool: "guarded", action: "allow", scope: "user" },
      }),
    ).toThrow(/may not outlive the session/);

    host.handlePermissionDecision(header.sessionId, { requestId, behavior: "deny", message: "no" });
    await run;
    expect(tool.ran()).toBe(0);
  });

  it("refuses a session scope on an ask the engine offered no rule for", async () => {
    // A tool called with no recognisable subject gets no `suggestedRule`, so
    // there is nothing to allow for the session. Refusing beats downgrading to
    // an allow-once: a client told "yes" for a session it did not get would
    // keep offering the button and never find out.
    const tool = createSpyTool();
    const llm = createScriptedLLM([toolCallTurn("call-1", "guarded", {}), textTurn("done")]);
    const { client, sessionId } = await harness(llm, [tool]);

    const refusals: ProtocolRequestError[] = [];
    client.onEvent((_id, event) => {
      if (event.type !== "permissionRequest") return;
      expect(event.request.suggestedRule).toBeUndefined();
      void client
        .respondToPermission(
          sessionId,
          { requestId: event.request.id, behavior: "allow" },
          { scope: "session" },
        )
        .catch((error: unknown) => {
          refusals.push(error as ProtocolRequestError);
          // The ask is still pending; an allow-once still lands.
          void client.respondToPermission(sessionId, {
            requestId: event.request.id,
            behavior: "allow",
          });
        });
    });

    await client.prompt(sessionId, "call it");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("invalidRequest");
    expect(refusals[0]?.message).toMatch(/not repeatable/);
    expect(tool.ran()).toBe(1);
  });

  it("ignores a scope on a deny rather than wedging the one answer that must land", async () => {
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const { client, sessionId } = await harness(llm, [tool]);

    client.onEvent((_id, event) => {
      if (event.type !== "permissionRequest") return;
      void client.respondToPermission(
        sessionId,
        { requestId: event.request.id, behavior: "deny", message: "no" },
        { scope: "session" },
      );
    });

    await client.prompt(sessionId, "call it");
    expect(tool.ran()).toBe(0);
    // No rule was minted from a deny: the scope described an allow.
    const state = await client.permissionState(sessionId);
    expect(state?.rules).toEqual([]);
  });

  it("refuses a client-authored persistRule that outlives the session", async () => {
    const tool = createSpyTool();
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { command: "ls" }),
      textTurn("done"),
    ]);
    const { client, sessionId } = await harness(llm, [tool]);

    const refusals: unknown[] = [];
    client.onEvent((_id, event) => {
      if (event.type !== "permissionRequest") return;
      void client
        .respondToPermission(sessionId, {
          requestId: event.request.id,
          behavior: "allow",
          persistRule: { tool: "guarded", action: "allow", scope: "user" },
        })
        .catch((error: unknown) => {
          refusals.push(error);
          void client.respondToPermission(sessionId, {
            requestId: event.request.id,
            behavior: "deny",
            message: "no",
          });
        });
    });

    await client.prompt(sessionId, "call it");
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as ProtocolRequestError).code).toBe("invalidRequest");
    expect(tool.ran()).toBe(0);
  });
});

describe("RFC 0005 §1.3 — listCommands", () => {
  it("lists the workspace skills and only the built-ins a client can reach", async () => {
    const { client } = await harness(createScriptedLLM([textTurn("hi")]), [], [], {
      commands: () => [
        {
          name: "review",
          description: "Review the diff",
          kind: "skill",
          source: "/ws/.arcturn/skills/review.md",
        },
      ],
    });

    const list = await client.listCommands();
    expect(list?.commands.map((command) => command.name)).toContain("review");
    // A menu that offered /rewind to a client with no rewind verb would lie.
    expect(list?.commands.map((command) => command.name)).not.toContain("rewind");
  });

  it("answers an empty list rather than throwing when nothing was wired", async () => {
    const { client } = await harness(createScriptedLLM([textTurn("hi")]), []);
    expect(await client.listCommands()).toEqual({ commands: [] });
  });

  it("names the verbs behind every built-in it lists, and lists every built-in it names", () => {
    // Two exports, one fact. The list decides what a menu offers; the verb map
    // decides what the serve path's `/name` refusal tells a client to call
    // instead. A built-in in one and not the other is either a menu entry with
    // no advice behind it or advice for a command nobody is offered.
    expect(Object.keys(REMOTE_BUILT_IN_COMMAND_VERBS).sort()).toEqual(
      REMOTE_REACHABLE_BUILT_IN_COMMANDS.map((command) => command.name).sort(),
    );
    for (const verbs of Object.values(REMOTE_BUILT_IN_COMMAND_VERBS)) {
      expect(verbs.length).toBeGreaterThan(0);
    }
  });
});
