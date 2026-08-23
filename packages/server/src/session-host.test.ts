import { join } from "node:path";
import { Agent, MemorySessionStore } from "@arcturn/core";
import type { AgentEvent, Tool } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { SessionHost, SessionHostError } from "./session-host.js";
import {
  createGatedLLM,
  createScriptedLLM,
  TEST_MODEL,
  textTurn,
  toolCallTurn,
} from "./test-helpers/fake-llm.js";
import { createGuardedTool } from "./test-helpers/tools.js";

interface HostFixture {
  host: SessionHost;
}

function buildHost(
  llm: ReturnType<typeof createScriptedLLM> | ReturnType<typeof createGatedLLM>,
  tools: Tool[] = [],
): HostFixture {
  const host = new SessionHost({
    agentFactory: (opts) =>
      new Agent({
        llm,
        model: TEST_MODEL,
        systemPrompt: "You are a test agent.",
        tools,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      }),
    defaultCwd: "/tmp/arcturn-test",
    permissionTimeoutMs: 200,
  });
  return { host };
}

describe("SessionHost", () => {
  it("creates a session with a generated id and the default cwd", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const header = await host.createSession({});
    expect(header.sessionId).toBeTruthy();
    expect(header.cwd).toBe("/tmp/arcturn-test");
    expect(header.version).toBe(1);
  });

  it("honours an explicit cwd inside the served workspace", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const header = await host.createSession({ cwd: "sub/dir" });
    expect(header.cwd).toBe(join("/tmp/arcturn-test", "sub/dir"));
  });

  it("refuses a cwd outside the served workspace", async () => {
    // A remote client picks this value and every tool resolves paths against
    // it, so an unconfined cwd would hand a token holder the whole disk.
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    await expect(host.createSession({ cwd: "/elsewhere" })).rejects.toThrow(/outside/);
    await expect(host.createSession({ cwd: "../.." })).rejects.toThrow(/outside/);
  });

  it("lists sessions created during the process lifetime when no store is configured", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const a = await host.createSession({});
    const b = await host.createSession({});
    const listed = await host.listSessions();
    expect(listed.map((h) => h.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
  });

  it("openSession returns the live header for an already-created session", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const created = await host.createSession({});
    const opened = await host.openSession(created.sessionId);
    expect(opened).toEqual(created);
  });

  it("openSession rejects an unknown session with sessionNotFound", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    await expect(host.openSession("no-such-session")).rejects.toMatchObject({
      code: "sessionNotFound",
    });
  });

  it("refuses to create a session past maxSessions", async () => {
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-test",
      maxSessions: 2,
    });
    await host.createSession({});
    await host.createSession({});
    await expect(host.createSession({})).rejects.toMatchObject({
      code: "invalidRequest",
      message: expect.stringMatching(/limit/i),
    });
  });

  it("maxSessions does not block re-attaching to an already-live session", async () => {
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-test",
      maxSessions: 1,
    });
    const header = await host.createSession({});
    await expect(host.openSession(header.sessionId)).resolves.toEqual(header);
  });

  it("openSession refuses to mint a new session past maxSessions", async () => {
    const store = new MemorySessionStore();
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
      maxSessions: 1,
    });
    await host.createSession({});
    const other = await store.create({ sessionId: "other-session", cwd: "/tmp/arcturn-test" });
    await expect(host.openSession(other.sessionId)).rejects.toMatchObject({
      code: "invalidRequest",
      message: expect.stringMatching(/limit/i),
    });
  });

  it("resumes a session backed by a shared session store", async () => {
    const store = new MemorySessionStore();
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
    });
    const created = await host.createSession({});
    // Simulate the process losing the live agent (e.g. a restart) — the
    // in-memory `#sessions` map inside SessionHost still has it, so build a
    // second host sharing the same store to exercise the resume path.
    const host2 = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
    });
    const reopened = await host2.openSession(created.sessionId);
    expect(reopened.sessionId).toBe(created.sessionId);
    expect(reopened.cwd).toBe(created.cwd);
  });

  it("drives a prompt end to end and fans out events to observers", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hello there")]));
    const header = await host.createSession({});
    const events: AgentEvent[] = [];
    const unsubscribe = host.observe(header.sessionId, (event) => events.push(event));

    await host.prompt(header.sessionId, "hi");

    unsubscribe();
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("runStart");
    expect(types).toContain("messageStream");
    expect(types[types.length - 1]).toBe("runEnd");
    const runEnd = events.find((e) => e.type === "runEnd");
    expect(runEnd).toMatchObject({ type: "runEnd", reason: "completed" });
  });

  it("rejects a concurrent prompt with sessionBusy while a run is active", async () => {
    const llm = createGatedLLM(textTurn("done"));
    const { host } = buildHost(llm);
    const header = await host.createSession({});

    const first = host.prompt(header.sessionId, "hi");
    await expect(host.prompt(header.sessionId, "hi again")).rejects.toMatchObject({
      code: "sessionBusy",
    });

    llm.release();
    await first;
  });

  it("prompt/steer/abort/setModel reject sessionNotFound for an unknown session", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    await expect(host.prompt("nope", "hi")).rejects.toBeInstanceOf(SessionHostError);
    expect(() => host.steer("nope", "hi")).toThrow(SessionHostError);
    expect(() => host.abort("nope")).toThrow(SessionHostError);
    expect(() => host.setModel("nope", "some/model")).toThrow(SessionHostError);
    expect(() => host.observe("nope", () => undefined)).toThrow(SessionHostError);
  });

  it("routes a permission ask to observers and resolves on handlePermissionDecision", async () => {
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { note: "please" }),
      textTurn("all done"),
    ]);
    const { host } = buildHost(llm, [createGuardedTool("guarded")]);
    const header = await host.createSession({});

    const events: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => {
      events.push(event);
      if (event.type === "permissionRequest") {
        // Real clients answer over the network, i.e. never in the same tick
        // as the request; defer so the host has finished wiring up the
        // pending-decision slot for this request id before we resolve it.
        setTimeout(() => {
          host.handlePermissionDecision(header.sessionId, {
            requestId: event.request.id,
            behavior: "allow",
          });
        }, 0);
      }
    });

    await host.prompt(header.sessionId, "please run the guarded tool");

    const toolEnd = events.find((e) => e.type === "toolEnd");
    expect(toolEnd).toBeDefined();
    expect(toolEnd).toMatchObject({ type: "toolEnd", result: { isError: false } });
    const runEnd = events.find((e) => e.type === "runEnd");
    expect(runEnd).toMatchObject({ reason: "completed" });
  });

  it("auto-denies a permission ask after the configured timeout", async () => {
    const llm = createScriptedLLM([toolCallTurn("call-1", "guarded", {}), textTurn("done anyway")]);
    const { host } = buildHost(llm, [createGuardedTool("guarded")]);
    const header = await host.createSession({});

    const events: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => events.push(event));

    await host.prompt(header.sessionId, "run it");

    const toolEnd = events.find((e) => e.type === "toolEnd");
    expect(toolEnd).toMatchObject({ type: "toolEnd", result: { isError: true } });
  }, 10_000);

  it("dispose aborts running agents and denies pending permission asks", async () => {
    const llm = createScriptedLLM([toolCallTurn("call-1", "guarded", {}), textTurn("done")]);
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm,
          model: TEST_MODEL,
          systemPrompt: "test",
          tools: [createGuardedTool("guarded")],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-test",
      // Long enough that the timeout can't race the explicit dispose() below.
      permissionTimeoutMs: 60_000,
    });
    const header = await host.createSession({});

    const events: AgentEvent[] = [];
    let promptSettled = false;
    host.observe(header.sessionId, (event) => events.push(event));
    const promptPromise = host.prompt(header.sessionId, "run it").finally(() => {
      promptSettled = true;
    });

    // Give the permission ask a tick to be raised before disposing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(promptSettled).toBe(false);

    host.dispose();
    await promptPromise;

    const runEnd = events.find((e) => e.type === "runEnd");
    expect(runEnd).toBeDefined();
  });
});
