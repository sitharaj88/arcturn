import { mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@arcturn/core";
import { ArcturnServer } from "@arcturn/server";
import type { AgentEvent, ModelSpec } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
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

describe("runServe", () => {
  it("refuses a non-loopback bind with authentication explicitly disabled, before building a runtime", async () => {
    await expect(runServe({ host: "0.0.0.0", token: "", port: 0 })).rejects.toThrow(ServeBindError);
  });
});
