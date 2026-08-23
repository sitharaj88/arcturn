import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  Message,
  ModelSpec,
  StreamEvent,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import {
  CassetteError,
  canonicalJson,
  createCassetteRecorder,
  loadCassette,
  recordingClient,
  replayingClient,
  replayTools,
  requestKey,
  toolKey,
  wrapToolsWithRecorder,
} from "./vcr.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "arcturn-cli-vcr-"));
}

function model(id = "anthropic/claude-sonnet-5"): ModelSpec {
  return {
    id,
    provider: "anthropic",
    model: id.split("/")[1] ?? id,
    displayName: id,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: { tools: true, vision: true, thinking: true, caching: true },
  };
}

function userMessage(text: string, timestamp = 1_000): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: model(),
    system: "You are arcturn.",
    messages: [userMessage("hello")],
    ...overrides,
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "anthropic/claude-sonnet-5",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "endTurn",
    timestamp: 2_000,
  };
}

/** A scripted client: yields a fixed event list, counting how often it ran. */
function scriptedClient(scripts: StreamEvent[][]): LLMClient & { calls: number } {
  let index = 0;
  const client = {
    calls: 0,
    async *stream(): AsyncIterable<StreamEvent> {
      client.calls++;
      const script = scripts[Math.min(index, scripts.length - 1)] ?? [];
      index++;
      for (const event of script) yield event;
    },
    async complete(): Promise<AssistantMessage> {
      throw new Error("not used");
    },
  };
  return client as LLMClient & { calls: number };
}

function turn(text: string): StreamEvent[] {
  return [
    { type: "start", model: "anthropic/claude-sonnet-5" },
    { type: "textStart", blockIndex: 0 },
    { type: "textDelta", blockIndex: 0, delta: text },
    { type: "blockEnd", blockIndex: 0 },
    { type: "end", message: assistant(text) },
  ];
}

function fakeCtx(): ToolExecutionContext {
  return {
    cwd: "/tmp",
    signal: new AbortController().signal,
    requestPermission: async () => ({ behavior: "allow" }),
    onUpdate: () => {},
    sessionId: "session-1",
    toolCallId: "call-1",
  };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** A tool whose `execute` is a spy, so "did it run?" is observable. */
function spyTool(name: string, result: ToolResult): Tool & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => result);
  return {
    definition: { name, description: `${name} tool`, parameters: { type: "object" } },
    execute,
  } as unknown as Tool & { execute: ReturnType<typeof vi.fn> };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/* -------------------------------------------------------------------------- */
/* canonical JSON                                                              */
/* -------------------------------------------------------------------------- */

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined properties like JSON.stringify does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

/* -------------------------------------------------------------------------- */
/* key derivation                                                              */
/* -------------------------------------------------------------------------- */

describe("requestKey", () => {
  it("is stable for the same request", () => {
    expect(requestKey(request())).toBe(requestKey(request()));
  });

  it("changes when the model changes", () => {
    expect(requestKey(request())).not.toBe(requestKey(request({ model: model("openai/gpt-5") })));
  });

  it("changes when the system prompt changes", () => {
    expect(requestKey(request())).not.toBe(requestKey(request({ system: "different" })));
  });

  it("changes when the messages change", () => {
    expect(requestKey(request())).not.toBe(
      requestKey(request({ messages: [userMessage("goodbye")] })),
    );
  });

  it("ignores volatile message timestamps", () => {
    expect(requestKey(request({ messages: [userMessage("hello", 1)] }))).toBe(
      requestKey(request({ messages: [userMessage("hello", 999_999)] })),
    );
  });

  it("ignores assistant token accounting", () => {
    const base = assistant("hi");
    const expensive: AssistantMessage = {
      ...base,
      usage: { inputTokens: 900, outputTokens: 900, cacheReadTokens: 9, cacheWriteTokens: 9 },
    };
    expect(requestKey(request({ messages: [userMessage("hello"), base] }))).toBe(
      requestKey(request({ messages: [userMessage("hello"), expensive] })),
    );
  });

  it("ignores sampling knobs and the abort signal", () => {
    const controller = new AbortController();
    expect(requestKey(request())).toBe(
      requestKey(request({ temperature: 0.9, maxOutputTokens: 32, signal: controller.signal })),
    );
  });

  it("distinguishes an absent system prompt from an empty one", () => {
    expect(requestKey(request({ system: undefined }))).not.toBe(
      requestKey(request({ system: "" })),
    );
  });
});

describe("toolKey", () => {
  it("is stable for the same call", () => {
    expect(toolKey("read", { path: "a.ts" })).toBe(toolKey("read", { path: "a.ts" }));
  });

  it("is identical for reordered input object keys", () => {
    expect(toolKey("read", { path: "a.ts", limit: 10 })).toBe(
      toolKey("read", { limit: 10, path: "a.ts" }),
    );
  });

  it("is identical for reordered nested object keys", () => {
    expect(toolKey("x", { opts: { a: 1, b: 2 } })).toBe(toolKey("x", { opts: { b: 2, a: 1 } }));
  });

  it("changes with the tool name and with the input", () => {
    expect(toolKey("read", { path: "a.ts" })).not.toBe(toolKey("write", { path: "a.ts" }));
    expect(toolKey("read", { path: "a.ts" })).not.toBe(toolKey("read", { path: "b.ts" }));
  });

  it("is domain-separated from requestKey", () => {
    // Nothing structural should ever let a tool call consume an LLM entry.
    expect(toolKey("read", { path: "a.ts" })).not.toBe(requestKey(request()));
  });
});

/* -------------------------------------------------------------------------- */
/* recorder + loader                                                           */
/* -------------------------------------------------------------------------- */

describe("createCassetteRecorder", () => {
  it("writes one JSONL line per interaction and creates the directory", async () => {
    const file = join(await scratch(), "nested", "run.jsonl");
    const recorder = createCassetteRecorder(file);
    await recorder.recordLlm("k1", turn("hi"));
    await recorder.recordTool("t1", textResult("ok"), "read");
    await recorder.close();

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: "llm", key: "k1", seq: 0 });
    expect(JSON.parse(lines[1] as string)).toMatchObject({
      kind: "tool",
      key: "t1",
      seq: 0,
      name: "read",
    });
  });

  it("numbers repeats of the same key monotonically", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    await recorder.recordTool("same", textResult("first"), "read");
    await recorder.recordTool("same", textResult("second"), "read");
    await recorder.recordTool("other", textResult("x"), "read");
    await recorder.close();

    const seqs = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { key: string; seq: number });
    expect(seqs.map((entry) => `${entry.key}#${entry.seq}`)).toEqual([
      "same#0",
      "same#1",
      "other#0",
    ]);
  });

  it("does not interleave concurrent recordings", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    // Fire 50 appends without awaiting: the internal queue must serialize them.
    const pending = Array.from({ length: 50 }, (_, index) =>
      recorder.recordTool(`key-${index}`, textResult(`payload-${index}`), "read"),
    );
    await Promise.all(pending);
    await recorder.close();

    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(50);
    // Every line must be independently parsable — a torn/interleaved write
    // would leave at least one that is not.
    const keys = lines.map((line) => (JSON.parse(line) as { key: string }).key);
    expect(new Set(keys).size).toBe(50);
  });

  it("refuses writes after close", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    await recorder.close();
    await expect(recorder.recordLlm("k", turn("hi"))).rejects.toMatchObject({
      name: "CassetteError",
      code: "closed",
    });
  });
});

describe("loadCassette", () => {
  it("serves repeats in seq order and then misses", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    await recorder.recordTool("same", textResult("first"), "read");
    await recorder.recordTool("same", textResult("second"), "read");
    await recorder.close();

    const cassette = await loadCassette(file);
    expect(cassette.takeTool("same")).toEqual(textResult("first"));
    expect(cassette.takeTool("same")).toEqual(textResult("second"));
    expect(cassette.takeTool("same")).toBeUndefined();
  });

  it("consumes in seq order even when lines are out of order on disk", async () => {
    const file = join(await scratch(), "run.jsonl");
    const later = { kind: "tool", v: 1, key: "k", seq: 1, name: "read", result: textResult("b") };
    const earlier = { kind: "tool", v: 1, key: "k", seq: 0, name: "read", result: textResult("a") };
    await writeFile(file, `${JSON.stringify(later)}\n${JSON.stringify(earlier)}\n`, "utf8");

    const cassette = await loadCassette(file);
    expect(cassette.takeTool("k")).toEqual(textResult("a"));
    expect(cassette.takeTool("k")).toEqual(textResult("b"));
  });

  it("reports stats including unused entries", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    await recorder.recordLlm("k1", turn("hi"));
    await recorder.recordTool("t1", textResult("ok"), "read");
    await recorder.recordTool("t2", textResult("unused"), "grep");
    await recorder.close();

    const cassette = await loadCassette(file);
    cassette.takeLlm("k1");
    cassette.takeTool("t1");
    cassette.takeTool("nope");

    const stats = cassette.stats();
    expect(stats).toMatchObject({
      llmTotal: 1,
      toolTotal: 2,
      llmConsumed: 1,
      toolConsumed: 1,
      misses: 1,
      skippedLines: 0,
    });
    expect(stats.unused).toEqual([{ kind: "tool", key: "t2", seq: 0, name: "grep" }]);
  });

  it("survives a torn final line", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    await recorder.recordTool("t1", textResult("ok"), "read");
    await recorder.close();
    // Simulate a crash mid-append: half a JSON object, no trailing newline.
    await appendFile(file, '{"kind":"tool","v":1,"key":"t2","seq":0,"resu', "utf8");

    const cassette = await loadCassette(file);
    expect(cassette.takeTool("t1")).toEqual(textResult("ok"));
    expect(cassette.stats().skippedLines).toBe(1);
    expect(cassette.stats().toolTotal).toBe(1);
  });

  it("rejects corruption that is not a torn tail", async () => {
    const file = join(await scratch(), "run.jsonl");
    await writeFile(
      file,
      'not json\n{"kind":"tool","v":1,"key":"t","seq":0,"result":{"content":[]}}\n',
      "utf8",
    );
    await expect(loadCassette(file)).rejects.toMatchObject({
      name: "CassetteError",
      code: "corrupt",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* record -> replay round trip                                                 */
/* -------------------------------------------------------------------------- */

describe("record/replay round trip", () => {
  it("replays a byte-identical StreamEvent sequence with no inner client", async () => {
    const file = join(await scratch(), "run.jsonl");
    const inner = scriptedClient([turn("first"), turn("second")]);
    const recorder = createCassetteRecorder(file);
    const client = recordingClient(inner, recorder);

    const req1 = request();
    const req2 = request({ messages: [userMessage("hello"), assistant("first")] });
    const recorded1 = await collect(client.stream(req1));
    const recorded2 = await collect(client.stream(req2));
    await recorder.close();
    expect(inner.calls).toBe(2);

    const cassette = await loadCassette(file);
    const replay = replayingClient(cassette);
    const replayed1 = await collect(replay.stream(req1));
    const replayed2 = await collect(replay.stream(req2));

    // Byte-identical, not merely deep-equal.
    expect(JSON.stringify(replayed1)).toBe(JSON.stringify(recorded1));
    expect(JSON.stringify(replayed2)).toBe(JSON.stringify(recorded2));
    // The scripted client never ran again: replay touched no provider.
    expect(inner.calls).toBe(2);
    expect(cassette.stats()).toMatchObject({ llmConsumed: 2, misses: 0 });
  });

  it("matches by content, not position, and consumes repeats in order", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    await recorder.recordLlm(requestKey(request()), turn("first"));
    await recorder.recordLlm(requestKey(request()), turn("second"));
    await recorder.close();

    const replay = replayingClient(await loadCassette(file));
    const a = await collect(replay.stream(request()));
    const b = await collect(replay.stream(request()));
    expect((a.at(2) as { delta: string }).delta).toBe("first");
    expect((b.at(2) as { delta: string }).delta).toBe("second");
  });

  it("complete() returns the recorded terminal message", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    await recorder.recordLlm(requestKey(request()), turn("answer"));
    await recorder.close();

    const replay = replayingClient(await loadCassette(file));
    const message = await replay.complete(request());
    expect(message.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("records nothing when the consumer abandons the stream early", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    const client = recordingClient(scriptedClient([turn("partial")]), recorder);

    for await (const event of client.stream(request())) {
      if (event.type === "textDelta") break;
    }
    await recorder.close();

    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("replayingClient misses", () => {
  it("throws a typed error naming the key", async () => {
    const file = join(await scratch(), "empty.jsonl");
    await writeFile(file, "", "utf8");
    const replay = replayingClient(await loadCassette(file));

    const key = requestKey(request());
    const error = await collect(replay.stream(request())).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CassetteError);
    expect(error).toMatchObject({ code: "miss", key, entryKind: "llm" });
    expect((error as CassetteError).message).toContain(key);
  });

  it("yields a terminal error event under onMiss: error-event", async () => {
    const file = join(await scratch(), "empty.jsonl");
    await writeFile(file, "", "utf8");
    const replay = replayingClient(await loadCassette(file), { onMiss: "error-event" });

    const events = await collect(replay.stream(request()));
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.type).toBe("error");
    // Deterministic: no wall clock in the replayed transcript, ever.
    expect((event as Extract<StreamEvent, { type: "error" }>).message.timestamp).toBe(0);
    expect((event as Extract<StreamEvent, { type: "error" }>).error.message).toContain(
      requestKey(request()),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* tools                                                                       */
/* -------------------------------------------------------------------------- */

describe("wrapToolsWithRecorder / replayTools", () => {
  it("records real results and replays them without executing the tool", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    const read = spyTool("read", textResult("file contents"));
    const [recording] = wrapToolsWithRecorder([read], recorder);

    const live = await recording?.execute({ path: "a.ts" }, fakeCtx());
    expect(live).toEqual(textResult("file contents"));
    expect(read.execute).toHaveBeenCalledTimes(1);
    await recorder.close();

    const cassette = await loadCassette(file);
    const replayTool = spyTool("read", textResult("SHOULD NOT BE USED"));
    const [replayed] = replayTools([replayTool], cassette);

    // Reordered input keys must still hit the recording.
    const result = await replayed?.execute({ path: "a.ts" }, fakeCtx());
    expect(result).toEqual(textResult("file contents"));
    // The proof that replay has no filesystem effects: the real tool never ran.
    expect(replayTool.execute).not.toHaveBeenCalled();
  });

  it("preserves the tool definition and extra surface", async () => {
    const file = join(await scratch(), "run.jsonl");
    await writeFile(file, "", "utf8");
    const bindAgent = () => {};
    const tool = { ...spyTool("todo", textResult("ok")), bindAgent };
    const [wrapped] = replayTools([tool as unknown as Tool], await loadCassette(file));
    expect(wrapped?.definition.name).toBe("todo");
    expect((wrapped as unknown as { bindAgent: unknown }).bindAgent).toBe(bindAgent);
  });

  it("serves repeats of the same call in seq order", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    const key = toolKey("read", { path: "a.ts" });
    await recorder.recordTool(key, textResult("v1"), "read");
    await recorder.recordTool(key, textResult("v2"), "read");
    await recorder.close();

    const [replayed] = replayTools([spyTool("read", textResult("live"))], await loadCassette(file));
    expect(await replayed?.execute({ path: "a.ts" }, fakeCtx())).toEqual(textResult("v1"));
    expect(await replayed?.execute({ path: "a.ts" }, fakeCtx())).toEqual(textResult("v2"));
  });

  it("returns a clear isError result on a miss, still without running the tool", async () => {
    const file = join(await scratch(), "empty.jsonl");
    await writeFile(file, "", "utf8");
    const tool = spyTool("bash", textResult("rm -rf /"));
    const [replayed] = replayTools([tool], await loadCassette(file));

    const result = await replayed?.execute({ command: "rm -rf /" }, fakeCtx());
    expect(result?.isError).toBe(true);
    const text = result?.content.map((item) => (item.type === "text" ? item.text : "")).join("");
    expect(text).toContain("VCR replay miss");
    expect(text).toContain('tool "bash"');
    expect(text).toContain(toolKey("bash", { command: "rm -rf /" }));
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("records isError results too", async () => {
    const file = join(await scratch(), "run.jsonl");
    const recorder = createCassetteRecorder(file);
    const failing: ToolResult = { content: [{ type: "text", text: "boom" }], isError: true };
    const [recording] = wrapToolsWithRecorder([spyTool("bash", failing)], recorder);
    await recording?.execute({ command: "false" }, fakeCtx());
    await recorder.close();

    const cassette = await loadCassette(file);
    expect(cassette.takeTool(toolKey("bash", { command: "false" }))).toEqual(failing);
  });
});
