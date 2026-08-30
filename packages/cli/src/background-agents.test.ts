import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  ModelSpec,
  StreamEvent,
  Tool,
  ToolResult,
  Usage,
} from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  BackgroundAgentManager,
  createBackgroundAgentCommands,
  formatBackgroundTranscript,
  getBackgroundAgentManager,
} from "./background-agents.js";
import { CommandRegistry, type CommandUi, type SelectOption } from "./commands.js";
import type { ArcturnRuntime } from "./runtime.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, writeFileAt } from "./test-helpers/scratch.js";

const TEST_MODEL: ModelSpec = {
  id: "test/model",
  provider: "anthropic",
  model: "test-model",
  displayName: "Test Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  cost: { input: 1000, output: 2000 },
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
};

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Poll until `check()` is true, or throw after `timeoutMs`. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arcturn-bg-agents-"));
}

/**
 * A pid guaranteed not to name a live process: a real child, started and
 * reaped. Asserted rather than assumed, since a fixture that quietly named a
 * live process would make the "dead owner" test prove the opposite of itself.
 */
async function deadPid(): Promise<number> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn a child to reap");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

/** A scripted client whose turns don't finish until the test calls `release(index)`. */
interface ManualLLM extends LLMClient {
  requests: LLMRequest[];
  release(index: number): void;
}

function manualLLM(): ManualLLM {
  const requests: LLMRequest[] = [];
  const deferreds = new Map<number, { promise: Promise<void>; resolve: () => void }>();

  function deferredFor(index: number): { promise: Promise<void>; resolve: () => void } {
    let entry = deferreds.get(index);
    if (!entry) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      entry = { promise, resolve };
      deferreds.set(index, entry);
    }
    return entry;
  }

  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const index = requests.length;
    requests.push(request);
    yield { type: "start", model: request.model.model };

    const aborted = new Promise<boolean>((resolve) => {
      if (request.signal?.aborted) {
        resolve(true);
        return;
      }
      request.signal?.addEventListener("abort", () => resolve(true), { once: true });
    });
    const released = deferredFor(index).promise.then(() => false);
    const wasAborted = await Promise.race([aborted, released]);

    if (wasAborted) {
      yield {
        type: "error",
        error: { kind: "aborted", message: "Aborted" },
        message: {
          role: "assistant",
          content: [],
          model: request.model.model,
          usage: ZERO_USAGE,
          stopReason: "aborted",
          timestamp: Date.now(),
        },
      };
      return;
    }

    const usage: Usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    yield { type: "textStart", blockIndex: 0 };
    yield { type: "textDelta", blockIndex: 0, delta: "done" };
    yield { type: "blockEnd", blockIndex: 0 };
    yield { type: "usage", usage };
    yield {
      type: "end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: request.model.model,
        usage,
        stopReason: "endTurn",
        timestamp: Date.now(),
      },
    };
  }

  return {
    requests,
    stream,
    async complete(request: LLMRequest): Promise<AssistantMessage> {
      let final: AssistantMessage | undefined;
      for await (const event of stream(request)) {
        if (event.type === "end" || event.type === "error") final = event.message;
      }
      if (!final) throw new Error("manual client produced no terminal message");
      return final;
    },
    release(index: number): void {
      deferredFor(index).resolve();
    },
  };
}

describe("BackgroundAgentManager lifecycle", () => {
  it("runs a background agent to completion and records id, usage, cost and text", async () => {
    const dir = await scratchDir();
    const manager = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([{ text: "the answer is 42" }]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });

    const { id, sessionId } = manager.start({ task: "find the answer" });
    expect(id).toMatch(/^bg-[0-9a-f]{8}$/);
    expect(manager.get(id)?.status).toBe("running");

    const status = await manager.result(id);
    expect(status?.status).toBe("done");
    expect(status?.sessionId).toBe(sessionId);
    expect(status?.finalText).toBe("the answer is 42");
    expect(status?.usage.inputTokens).toBeGreaterThan(0);
    expect(status?.costUsd).toBeGreaterThan(0);
    expect(status?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(status?.error).toBeUndefined();
    expect(manager.list().map((row) => row.id)).toContain(id);
  });

  it("captures a failed run's error message", async () => {
    const dir = await scratchDir();
    const manager = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([{ error: "boom: rate limited" }]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });

    const { id } = manager.start({ task: "do something risky" });
    const status = await manager.result(id);
    expect(status?.status).toBe("failed");
    expect(status?.error).toContain("boom: rate limited");
  });

  it("rejects an empty task", () => {
    const manager = new BackgroundAgentManager({
      dir: "/tmp/unused-bg-agents-dir",
      llm: fakeLLM([]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });
    expect(() => manager.start({ task: "   " })).toThrow(/non-empty/);
  });

  it("caps concurrent runs and drains the queue in FIFO order", async () => {
    const dir = await scratchDir();
    const manual = manualLLM();
    const manager = new BackgroundAgentManager({
      dir,
      llm: manual,
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
      concurrency: 2,
    });

    const a = manager.start({ task: "task-a" });
    const b = manager.start({ task: "task-b" });
    const c = manager.start({ task: "task-c" });

    // A and B are launched back-to-back by `#pump()`, but which of their two
    // independent, real (temp-dir-backed) session-I/O chains actually reaches
    // the LLM first is a genuine async race, not a fixed order — so look
    // requests up by their task text instead of assuming a position.
    const indexOfTask = (task: string): number =>
      manual.requests.findIndex((request) => JSON.stringify(request.messages).includes(task));

    await waitFor(() => manual.requests.length === 2);
    expect(manager.get(c.id)?.status).toBe("running");
    expect(manager.get(c.id)?.startedAt).toBeUndefined(); // still queued, never launched
    expect(indexOfTask("task-a")).toBeGreaterThanOrEqual(0);
    expect(indexOfTask("task-b")).toBeGreaterThanOrEqual(0);

    manual.release(indexOfTask("task-a"));
    const first = await manager.result(a.id);
    expect(first?.status).toBe("done");

    // Releasing a's slot lets the third, queued task launch next — this one
    // *is* positionally deterministic, since only one new request can appear
    // between the two-requests and three-requests checkpoints.
    await waitFor(() => manual.requests.length === 3);
    expect(indexOfTask("task-c")).toBe(2);
    expect(manager.get(c.id)?.startedAt).toBeDefined();

    manual.release(indexOfTask("task-b"));
    manual.release(indexOfTask("task-c"));
    const [second, third] = await Promise.all([manager.result(b.id), manager.result(c.id)]);
    expect(second?.status).toBe("done");
    expect(third?.status).toBe("done");
  });

  it("cancels a running agent, cascading the abort with no dangling call", async () => {
    const dir = await scratchDir();
    const manual = manualLLM();
    const manager = new BackgroundAgentManager({
      dir,
      llm: manual,
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });

    const { id } = manager.start({ task: "a slow task" });
    await waitFor(() => manual.requests.length === 1);

    expect(manager.cancel(id)).toBe(true);
    const status = await manager.result(id);
    expect(status?.status).toBe("cancelled");
    // Cancelling again, or an unknown id, is a no-op.
    expect(manager.cancel(id)).toBe(false);
    expect(manager.cancel("bg-doesnotexist")).toBe(false);
  });

  it("cancels a still-queued agent without ever launching it", async () => {
    const dir = await scratchDir();
    const manual = manualLLM();
    const manager = new BackgroundAgentManager({
      dir,
      llm: manual,
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
      concurrency: 1,
    });

    const a = manager.start({ task: "task-a" });
    const b = manager.start({ task: "task-b" });
    await waitFor(() => manual.requests.length === 1);

    expect(manager.cancel(b.id)).toBe(true);
    expect(manager.get(b.id)?.status).toBe("cancelled");

    manual.release(0);
    await manager.result(a.id);
    // The cancelled, queued task must never have reached the LLM.
    expect(manual.requests.length).toBe(1);
  });

  it("persists records durably across a fresh manager over the same directory", async () => {
    const dir = await scratchDir();
    const manager1 = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([{ text: "done deal" }]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });
    const { id: doneId } = manager1.start({ task: "finish quickly" });
    await manager1.result(doneId);

    const manager2 = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });
    expect(manager2.get(doneId)?.status).toBe("done");
    expect(manager2.get(doneId)?.finalText).toBe("done deal");
    expect(manager2.list().map((row) => row.id)).toContain(doneId);
  });

  it("reports a record left running by a dead process as interrupted on load", async () => {
    const dir = await scratchDir();
    const manual = manualLLM();
    // The previous shape of this test built `manager1` in THIS process, left
    // its turn hanging, and called that "the process dying" — but the owning
    // process was very much alive, so what it actually pinned down was the bug
    // below (a second manager stealing a live record). The dead process is
    // modelled honestly now: a record on disk stamped with a pid that has been
    // reaped, which is what a restarted CLI really finds.
    const manager1 = new BackgroundAgentManager({
      dir,
      llm: manual,
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
      ownerPid: await deadPid(),
    });
    const { id } = manager1.start({ task: "never finishes" });
    await waitFor(() => manual.requests.length === 1);

    const manager2 = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });
    const status = manager2.get(id);
    expect(status?.status).toBe("interrupted");
    expect(status?.error).toBeTruthy();
    expect(manager2.list().map((row) => row.id)).toContain(id);
  });

  it("reports a record left running by a process with no owner pid as interrupted", async () => {
    // Back-compat: records written before owner pids existed have none, and a
    // missing owner still reads as "gone" — the case this correction is for.
    const dir = await scratchDir();
    await mkdir(join(dir, "records"), { recursive: true });
    await writeFile(
      join(dir, "records", "bg-old.json"),
      JSON.stringify({
        id: "bg-old",
        sessionId: "sess-old",
        task: "started by a build that never stamped pids",
        modelId: TEST_MODEL.id,
        status: "running",
        createdAt: Date.now() - 60_000,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
      }),
      "utf8",
    );
    const manager = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });
    expect(manager.get("bg-old")?.status).toBe("interrupted");
  });

  it("recovers a record whose owner pid was reused, which liveness alone cannot", async () => {
    // The hole `ownerPid` left open. An operating system reuses pid numbers,
    // so a manager that died can have its number taken by something unrelated
    // — and then "is that pid alive?" answers yes forever and the record stays
    // `running` for good, with no way for anyone to clear it.
    //
    // The lease closes it: the owner has to keep renewing a heartbeat, and a
    // stamp older than the stale window means the owner is gone whatever the
    // pid says. Modelled here as a record naming *this* very much alive
    // process with an ancient heartbeat, which is exactly what a reused pid
    // looks like from the outside.
    const dir = await scratchDir();
    await mkdir(join(dir, "records"), { recursive: true });
    await writeFile(
      join(dir, "records", "bg-reused.json"),
      JSON.stringify({
        id: "bg-reused",
        sessionId: "sess-reused",
        task: "owned by a pid somebody else now has",
        modelId: TEST_MODEL.id,
        status: "running",
        createdAt: Date.now() - 600_000,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ownerPid: process.pid,
        ownerHeartbeatAt: Date.now() - 600_000,
      }),
      "utf8",
    );

    const manager = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });
    manager.dispose();

    expect(manager.get("bg-reused")?.status).toBe("interrupted");
  });

  it("leaves a record alone while its owner is still renewing the lease", async () => {
    // The other half, and the one that matters more: a *fresh* heartbeat from
    // a live pid must be left running. Getting this wrong turns the fix into
    // the bug it was meant to prevent.
    const dir = await scratchDir();
    await mkdir(join(dir, "records"), { recursive: true });
    await writeFile(
      join(dir, "records", "bg-live.json"),
      JSON.stringify({
        id: "bg-live",
        sessionId: "sess-live",
        task: "genuinely still going",
        modelId: TEST_MODEL.id,
        status: "running",
        createdAt: Date.now() - 30_000,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ownerPid: process.pid,
        ownerHeartbeatAt: Date.now(),
      }),
      "utf8",
    );

    const manager = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });
    manager.dispose();

    expect(manager.get("bg-live")?.status).toBe("running");
  });

  it("renews the lease on disk while an agent is actually running", async () => {
    // A lease nobody renews is a lease that expires under a live agent, which
    // would make the stale check *cause* the failure it exists to detect. The
    // claim is therefore about the file on disk, not about a method existing:
    // a running record's stamp has to move forward on its own.
    const dir = await scratchDir();
    const manual = manualLLM();
    const manager = new BackgroundAgentManager({
      dir,
      llm: manual,
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
      heartbeatIntervalMs: 10,
    });
    const { id } = manager.start({ task: "long one" });
    await waitFor(() => manual.requests.length === 1);

    const stampOf = async (): Promise<number | undefined> => {
      // The read races the 10ms heartbeat's rename. On Windows that collision
      // is an EPERM on one side or the other; either way "try again on the
      // next poll" is the honest reading, not a failure.
      try {
        const raw = await readFile(join(dir, "records", `${id}.json`), "utf8");
        return (JSON.parse(raw) as { ownerHeartbeatAt?: number }).ownerHeartbeatAt;
      } catch {
        return undefined;
      }
    };

    const first = await stampOf();
    let renewed: number | undefined;
    await waitFor(async () => {
      renewed = await stampOf();
      return renewed !== undefined && (first === undefined || renewed > first);
    });

    expect(renewed).toBeDefined();
    expect(renewed ?? 0).toBeGreaterThan(first ?? 0);
    manager.dispose();
  });

  it("leaves an agent owned by a LIVE process running, and never tells a caller it failed", async () => {
    // `arcturn serve` beside a terminal: one `~/.arcturn`, two processes. The
    // serve process building its own manager must not rewrite the terminal's
    // live record — a user asking `/bg` there was told a running job had been
    // interrupted, and `result()` resolved immediately with that lie.
    const dir = await scratchDir();
    const manual = manualLLM();
    const owner = new BackgroundAgentManager({
      dir,
      llm: manual,
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });
    const { id } = owner.start({ task: "a long job the terminal owns" });
    await waitFor(() => manual.requests.length === 1);

    const beside = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([]),
      model: TEST_MODEL,
      tools: [],
      cwd: "/work",
    });

    expect(beside.get(id)?.status).toBe("running");
    expect(beside.get(id)?.error).toBeUndefined();
    // …and the record on disk was not rewritten under the owning process.
    const onDisk = JSON.parse(await readFile(join(dir, "records", `${id}.json`), "utf8")) as {
      status: string;
      ownerPid?: number;
      error?: string;
    };
    expect(onDisk.status).toBe("running");
    expect(onDisk.ownerPid).toBe(process.pid);
    expect(onDisk.error).toBeUndefined();

    // `result()` must keep waiting rather than resolve with a fabricated end.
    let settled: string | undefined;
    void beside.result(id).then((status) => {
      settled = status?.status;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeUndefined();

    // The owner finishes; the truth is what lands.
    manual.release(0);
    expect((await owner.result(id))?.status).toBe("done");
  });

  it("filters to read-only-safe tools by default and never escalates to yolo silently", async () => {
    const dir = await scratchDir();
    const readTool: Tool = {
      definition: { name: "read", description: "read", parameters: { type: "object" } },
      async execute(): Promise<ToolResult> {
        return { content: [{ type: "text", text: "file contents" }] };
      },
    };
    const bashTool: Tool = {
      definition: { name: "bash", description: "bash", parameters: { type: "object" } },
      async execute(): Promise<ToolResult> {
        return { content: [{ type: "text", text: "should never run" }] };
      },
    };
    const manager = new BackgroundAgentManager({
      dir,
      llm: fakeLLM([
        { toolCalls: [{ id: "c1", name: "bash", arguments: { command: "rm -rf /" } }] },
        { text: "gave up" },
      ]),
      model: TEST_MODEL,
      tools: [readTool, bashTool],
      cwd: "/work",
    });
    const { id } = manager.start({ task: "try to run a shell command" });
    const status = await manager.result(id);
    expect(status?.status).toBe("done");
    const messages = await manager.transcript(id);
    const toolResult = messages?.find((m) => m.role === "toolResult");
    if (toolResult?.role !== "toolResult") throw new Error("missing tool result");
    // `bash` was filtered out of the tool list entirely, so the model's call
    // to it is rejected before ever reaching bashTool.execute().
    expect(toolResult.isError).toBe(true);
  });
});

describe("background agents honour the session's permission rules", () => {
  /** A tool that is neither read-only nor always-allowed: it must be gated. */
  const peekTool: Tool = {
    definition: { name: "peek", description: "peek", parameters: { type: "object" } },
    async execute(): Promise<ToolResult> {
      return { content: [{ type: "text", text: "PEEKED-OUTPUT" }] };
    },
  };

  async function transcriptOf(
    manager: BackgroundAgentManager,
    id: string,
  ): Promise<{ text: string; toolError: boolean }> {
    const messages = (await manager.transcript(id)) ?? [];
    const result = messages.find((message) => message.role === "toolResult");
    return {
      text: formatBackgroundTranscript(messages).join("\n"),
      toolError: result?.role === "toolResult" && result.isError === true,
    };
  }

  it("binds a config `deny` rule to a /bg agent", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({
        permissions: [{ tool: "read", specifier: "**/secret.txt", action: "deny" }],
      }),
    );
    await writeFileAt(join(scratch.cwd, "secret.txt"), "TOP-SECRET-VALUE\n");
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c1", name: "read", arguments: { path: "secret.txt" } }] },
      { text: "all done" },
    ]);
    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "read the secret" });
    await manager.result(id);

    // `read` is a read-only tool, so the *only* thing between a background
    // agent and this file is the user's own deny rule.
    const { text, toolError } = await transcriptOf(manager, id);
    expect(text).not.toContain("TOP-SECRET-VALUE");
    expect(toolError).toBe(true);
    manager.dispose();
    await runtime.dispose();
  });

  it("applies a config `allow` rule to a /bg agent", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ permissions: [{ tool: "peek", action: "allow" }] }),
    );
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c1", name: "peek", arguments: {} }] },
      { text: "all done" },
    ]);
    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "have a peek", tools: [peekTool] });
    await manager.result(id);

    const { text, toolError } = await transcriptOf(manager, id);
    expect(toolError).toBe(false);
    expect(text).toContain("PEEKED-OUTPUT");
    manager.dispose();
    await runtime.dispose();
  });

  it("applies a rule granted in-session to a /bg agent started afterwards", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c1", name: "peek", arguments: {} }] },
      { text: "all done" },
    ]);
    // What "Allow always" leaves behind, mid-session.
    await runtime.applyPermissionRule({ tool: "peek", action: "allow", scope: "session" });

    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "have a peek", tools: [peekTool] });
    await manager.result(id);

    const { text, toolError } = await transcriptOf(manager, id);
    expect(toolError).toBe(false);
    expect(text).toContain("PEEKED-OUTPUT");
    manager.dispose();
    await runtime.dispose();
  });

  it("still fails closed for a tool no rule covers", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ permissions: [{ tool: "fetch", action: "allow" }] }),
    );
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c1", name: "peek", arguments: {} }] },
      { text: "all done" },
    ]);
    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "have a peek", tools: [peekTool] });
    await manager.result(id);

    // No requester, no covering rule: denied, exactly as before this change.
    const { text, toolError } = await transcriptOf(manager, id);
    expect(toolError).toBe(true);
    expect(text).not.toContain("PEEKED-OUTPUT");
    manager.dispose();
    await runtime.dispose();
  });
});

describe("createBackgroundAgentCommands", () => {
  interface FakeUi extends CommandUi {
    lines: string[];
    notices: { level: string; text: string }[];
    input: string;
  }

  function fakeUi(): FakeUi {
    const ui: FakeUi = {
      lines: [],
      notices: [],
      input: "",
      print(content) {
        ui.lines.push(...(typeof content === "string" ? content.split("\n") : content));
      },
      notice(level, text) {
        ui.notices.push({ level, text });
      },
      async select<T>(_title: string, _options: readonly SelectOption<T>[]) {
        return undefined;
      },
      setInput(text) {
        ui.input = text;
      },
      clear() {},
      exit() {},
    };
    return ui;
  }

  interface FakeAgent {
    isRunning: boolean;
    steered: string[];
    prompted: string[];
    steer(input: string): void;
    prompt(input: string): Promise<void>;
  }

  function fakeAgent(isRunning = false): FakeAgent {
    return {
      isRunning,
      steered: [],
      prompted: [],
      steer(input: string) {
        this.steered.push(input);
      },
      async prompt(input: string) {
        this.prompted.push(input);
      },
    };
  }

  function fakeRuntime(options: {
    llm: LLMClient;
    home: string;
    agent?: FakeAgent;
    tools?: Tool[];
  }): ArcturnRuntime {
    return {
      llm: options.llm,
      model: TEST_MODEL,
      tools: options.tools ?? [],
      cwd: "/work",
      paths: { home: options.home },
      agent: options.agent ?? fakeAgent(),
    } as unknown as ArcturnRuntime;
  }

  it("prints a usage summary for /bg with no arguments and nothing running", async () => {
    const dir = await scratchDir();
    const runtime = fakeRuntime({ llm: fakeLLM([]), home: dir });
    const ui = fakeUi();
    const [command] = createBackgroundAgentCommands();
    await command?.run({ runtime, ui, args: "", commands: new CommandRegistry() });
    expect(ui.notices.some((n) => n.text.includes("No background agents yet"))).toBe(true);
  });

  it("starts a background agent and returns control immediately", async () => {
    const dir = await scratchDir();
    const runtime = fakeRuntime({ llm: fakeLLM([{ text: "42" }]), home: dir });
    const ui = fakeUi();
    const [command] = createBackgroundAgentCommands();

    await command?.run({
      runtime,
      ui,
      args: "figure out the answer",
      commands: new CommandRegistry(),
    });

    expect(ui.notices).toHaveLength(1);
    expect(ui.notices[0]?.text).toMatch(
      /^Started background agent bg-[0-9a-f]{8} \(session .+\)\.$/,
    );
    const manager = getBackgroundAgentManager(runtime);
    const [status] = manager.list();
    expect(status?.task).toBe("figure out the answer");
  });

  it("lists background agents with status, elapsed, cost and task columns", async () => {
    const dir = await scratchDir();
    const runtime = fakeRuntime({ llm: fakeLLM([{ text: "42" }]), home: dir });
    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "a task worth listing" });
    await manager.result(id);

    const ui = fakeUi();
    const [command] = createBackgroundAgentCommands();
    await command?.run({ runtime, ui, args: "", commands: new CommandRegistry() });

    expect(ui.lines[0]).toBe("Background agents");
    const row = ui.lines.find((line) => line.includes(id));
    expect(row).toBeDefined();
    expect(row).toContain("done");
    expect(row).toContain("a task worth listing");
  });

  it("shows a transcript for /bg logs <id>, including a tool call and its result", async () => {
    const dir = await scratchDir();
    const peekTool: Tool = {
      definition: { name: "peek", description: "peek", parameters: { type: "object" } },
      async execute(): Promise<ToolResult> {
        return { content: [{ type: "text", text: "peeked" }] };
      },
    };
    const runtime = fakeRuntime({
      llm: fakeLLM([
        { toolCalls: [{ id: "c1", name: "peek", arguments: {} }] },
        { text: "all done" },
      ]),
      home: dir,
    });
    const manager = getBackgroundAgentManager(runtime);
    // A `tools` override bypasses the default read-only-safe *filtering* but
    // not the permission *mode* — `peek` isn't a read-only tool name, so it
    // still needs an explicit `permissionMode: "yolo"` to actually run rather
    // than being denied for lack of a requester.
    const { id } = manager.start({
      task: "look around",
      tools: [peekTool],
      permissionMode: "yolo",
    });
    await manager.result(id);

    const ui = fakeUi();
    const [command] = createBackgroundAgentCommands();
    await command?.run({ runtime, ui, args: `logs ${id}`, commands: new CommandRegistry() });

    const text = ui.lines.join("\n");
    expect(text).toContain("look around");
    expect(text).toContain("peek(");
    expect(text).toContain("peeked");
    expect(text).toContain("all done");
  });

  it("reports an unknown id for logs, cancel and adopt", async () => {
    const dir = await scratchDir();
    const runtime = fakeRuntime({ llm: fakeLLM([]), home: dir });
    const [command] = createBackgroundAgentCommands();

    for (const args of ["logs missing-id", "cancel missing-id", "adopt missing-id"]) {
      const ui = fakeUi();
      await command?.run({ runtime, ui, args, commands: new CommandRegistry() });
      expect(ui.notices[0]).toMatchObject({ level: "error" });
      expect(ui.notices[0]?.text).toContain('No background agent "missing-id"');
    }
  });

  it("reports usage for logs/cancel/adopt with no id given", async () => {
    const dir = await scratchDir();
    const runtime = fakeRuntime({ llm: fakeLLM([]), home: dir });
    const [command] = createBackgroundAgentCommands();

    const ui = fakeUi();
    await command?.run({ runtime, ui, args: "cancel", commands: new CommandRegistry() });
    expect(ui.notices[0]?.text).toBe("Usage: /bg cancel <id>");
  });

  it("cancels a running agent via /bg cancel <id>, and reports a finished one as already done", async () => {
    const dir = await scratchDir();
    const manual = manualLLM();
    const runtime = fakeRuntime({ llm: manual, home: dir });
    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "long running" });
    await waitFor(() => manual.requests.length === 1);

    const ui = fakeUi();
    const [command] = createBackgroundAgentCommands();
    await command?.run({ runtime, ui, args: `cancel ${id}`, commands: new CommandRegistry() });
    expect(ui.notices[0]).toMatchObject({ level: "info" });
    await manager.result(id);

    const ui2 = fakeUi();
    await command?.run({ runtime, ui: ui2, args: `cancel ${id}`, commands: new CommandRegistry() });
    expect(ui2.notices[0]).toMatchObject({ level: "warn" });
    expect(ui2.notices[0]?.text).toContain("already cancelled");
  });

  it("adopts a finished agent's result by steering into a running foreground agent", async () => {
    const dir = await scratchDir();
    const runtime = fakeRuntime({
      llm: fakeLLM([{ text: "the delegated result" }]),
      home: dir,
      agent: fakeAgent(true),
    });
    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "delegate this" });
    await manager.result(id);

    const ui = fakeUi();
    const [command] = createBackgroundAgentCommands();
    await command?.run({ runtime, ui, args: `adopt ${id}`, commands: new CommandRegistry() });

    const agent = runtime.agent as unknown as FakeAgent;
    expect(agent.steered).toHaveLength(1);
    expect(agent.steered[0]).toContain("the delegated result");
    expect(agent.prompted).toHaveLength(0);
  });

  it("adopts a finished agent's result by prompting an idle foreground agent", async () => {
    const dir = await scratchDir();
    const runtime = fakeRuntime({
      llm: fakeLLM([{ text: "the delegated result" }]),
      home: dir,
      agent: fakeAgent(false),
    });
    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "delegate this" });
    await manager.result(id);

    const ui = fakeUi();
    const [command] = createBackgroundAgentCommands();
    await command?.run({ runtime, ui, args: `adopt ${id}`, commands: new CommandRegistry() });

    const agent = runtime.agent as unknown as FakeAgent;
    expect(agent.prompted).toHaveLength(1);
    expect(agent.prompted[0]).toContain("the delegated result");
    expect(agent.steered).toHaveLength(0);
  });

  it("warns instead of adopting a background agent that is still running", async () => {
    const dir = await scratchDir();
    const manual = manualLLM();
    const runtime = fakeRuntime({ llm: manual, home: dir, agent: fakeAgent(false) });
    const manager = getBackgroundAgentManager(runtime);
    const { id } = manager.start({ task: "still going" });
    await waitFor(() => manual.requests.length === 1);

    const ui = fakeUi();
    const [command] = createBackgroundAgentCommands();
    await command?.run({ runtime, ui, args: `adopt ${id}`, commands: new CommandRegistry() });
    expect(ui.notices[0]).toMatchObject({ level: "warn" });
    expect(ui.notices[0]?.text).toContain("still running");

    const agent = runtime.agent as unknown as FakeAgent;
    expect(agent.prompted).toHaveLength(0);
    expect(agent.steered).toHaveLength(0);
    manual.release(0);
    await manager.result(id);
  });

  it("parses sub-verbs through the real command registry, matching /cost's house style", async () => {
    const dir = await scratchDir();
    const runtime = fakeRuntime({ llm: fakeLLM([{ text: "42" }]), home: dir });
    const registry = new CommandRegistry();
    registry.registerAll(createBackgroundAgentCommands());

    const ui = fakeUi();
    await registry.dispatch("/bg  a delegated task  ", { runtime, ui });
    expect(ui.notices[0]?.text).toMatch(/^Started background agent bg-/);

    const manager = getBackgroundAgentManager(runtime);
    const [status] = manager.list();
    expect(status?.task).toBe("a delegated task");
    if (status) await manager.result(status.id);

    const ui2 = fakeUi();
    await registry.dispatch("/bg", { runtime, ui: ui2 });
    expect(ui2.lines[0]).toBe("Background agents");
  });
});
