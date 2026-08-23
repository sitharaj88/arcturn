/**
 * Adversarial correctness review: targeted regression tests for suspected
 * stateful bugs in checkpoints/`/rewind`, `@`-mention expansion, and
 * transcript export. Confirmed defects are written with `it.fails` — the
 * assertion encodes the *correct* behavior, so it currently fails against
 * the real bug and the suite stays green. Suspicions that did not
 * reproduce are documented inline instead of given a test; see the
 * accompanying write-up for the full list.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ColorLevel, setColorLevel, stripAnsi, TestTerminal } from "@arcturn/tui";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@arcturn/types";
import { beforeAll, describe, expect, it } from "vitest";
import { type CommandUi, createCommandRegistry, type SelectOption } from "./commands.js";
import { exportMarkdown } from "./export.js";
import { InteractiveApp } from "./interactive/app.js";
import type { FakeLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, writeFileAt } from "./test-helpers/scratch.js";

beforeAll(() => {
  setColorLevel(ColorLevel.None);
});

/** Yield to the event loop so queued microtasks and timers run. */
async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, or throw once `timeout` elapses. */
async function waitFor(
  predicate: () => boolean,
  { timeout = 10_000, label = "condition" }: { timeout?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(5);
  }
  throw new Error(`${label} was never met within ${timeout}ms`);
}

/* -------------------------------------------------------------------------- */
/* 1. /rewind does not guard against an in-flight run                        */
/* -------------------------------------------------------------------------- */

interface FakeUi extends CommandUi {
  notices: { level: string; text: string }[];
}

function fakeUi(answer: unknown = undefined): FakeUi {
  const notices: { level: string; text: string }[] = [];
  return {
    notices,
    print() {},
    notice(level, text) {
      notices.push({ level, text: Array.isArray(text) ? text.join("\n") : String(text) });
    },
    async select<T>(_title: string, _options: readonly SelectOption<T>[]) {
      return answer as T | undefined;
    },
    setInput() {},
    clear() {},
    exit() {},
  };
}

describe("/rewind: refuses while a run is in flight (fixed)", () => {
  // /clear, /compact and /sessions all refuse while `runtime.agent.isRunning`.
  // /rewind is at least as unsafe mid-run — it restores files on disk and
  // swaps in a new Agent without aborting the old one, so an orphaned run's
  // pending write could resurrect a file the user just watched disappear.
  // The guard makes it refuse instead, leaving disk and transcript untouched.
  it("refuses to rewind mid-run, leaving the in-flight run's files alone", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "c1", name: "write", arguments: { path: "foo.txt", content: "v1" } }] },
        { text: "done1" },
        {
          toolCalls: [{ id: "c2", name: "write", arguments: { path: "foo.txt", content: "v2" } }],
          delayMs: 40,
        },
        { text: "done2" },
      ],
      { permissionMode: "yolo" },
    );

    const foo = join(scratch.cwd, "foo.txt");

    // Turn A: create foo.txt = "v1" — the checkpoint a rewind would target.
    await runtime.agent.prompt("make v1");
    expect(await readFile(foo, "utf8")).toBe("v1");

    const turnsBefore = await runtime.checkpoints.listTurns();
    expect(turnsBefore).toHaveLength(1);
    const turnA = turnsBefore[0]!.id;

    // Turn B is deliberately still in flight when /rewind is dispatched.
    const secondRun = runtime.agent.prompt("make v2");
    await waitFor(() => runtime.agent.isRunning, { label: "second run to start" });

    const registry = createCommandRegistry();
    const ui = fakeUi(turnA);
    await registry.dispatch("/rewind", { runtime, ui });

    // Refused, with a notice telling the user how to proceed...
    expect(ui.notices.map((notice) => notice.text).join("\n")).toMatch(/run is in progress/i);
    // ...and nothing was restored or deleted behind the running turn's back.
    expect(await readFile(foo, "utf8")).toBe("v1");

    await secondRun;
    expect(await readFile(foo, "utf8")).toBe("v2");

    // Once idle, the same rewind is allowed and does restore.
    await registry.dispatch("/rewind", { runtime, ui: fakeUi(turnA) });
    await expect(readFile(foo, "utf8")).rejects.toThrow();
    await runtime.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Steering skips @-mention / image expansion entirely                    */
/* -------------------------------------------------------------------------- */

describe("mentions: steering an in-flight run expands mentions (fixed)", () => {
  // app.ts#onSubmit: when `runtime.agent.isRunning`, the submitted line is
  // handed straight to `runtime.agent.steer(trimmed)` — a raw string — and
  // returns immediately, never calling `expandMentions`. The non-steering
  // branch just below it always awaits `expandMentions` first. So a
  // steered "@notes.txt what does this say?" reaches the model as that
  // literal text, with the file's content never injected and (per
  // ExpandedMentions) any mentioned image never turned into an
  // ImageContent block either — steering silently degrades mentions
  // instead of expanding or rejecting them.
  it("expands an @-mentioned file's content into a steered message the same way it does for a fresh prompt", async () => {
    const scratch = await makeScratch();
    await writeFileAt(join(scratch.cwd, "notes.txt"), "ARCTURN_SECRET_MARKER_42");

    const runtime = await buildTestRuntime(scratch, [
      { text: "ok", delayMs: 300 },
      { text: "steered response" },
    ]);
    const terminal = new TestTerminal({ columns: 80, rows: 24 });
    const app = new InteractiveApp({ runtime, terminal, streamThrottleMs: 5 });
    const exit = app.run();
    await tick();

    try {
      terminal.injectInput("go\r");
      await waitFor(() => runtime.agent.isRunning, { label: "run to start" });

      // Steer with a mention while the first turn is still in flight.
      terminal.injectInput("@notes.txt summarize this\r");
      await waitFor(() => stripAnsi(terminal.output).includes("steering the run"), {
        label: "steering hint",
      });

      await waitFor(() => !runtime.agent.isRunning, {
        timeout: 12_000,
        label: "run to finish",
      });

      const requests = (runtime.llm as FakeLLM).requests;
      const everySentText = requests
        .flatMap((request) => request.messages)
        .filter((message): message is UserMessage => message.role === "user")
        .flatMap((message) => message.content)
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      // Correct behavior: the mentioned file's content reached the model,
      // exactly as it would have for a non-steered prompt.
      expect(everySentText).toContain("ARCTURN_SECRET_MARKER_42");
    } finally {
      await waitFor(() => !runtime.agent.isRunning, { timeout: 12_000 }).catch(() => undefined);
      terminal.injectInput("");
      terminal.injectInput("");
      await exit;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Export mis-pairs tool calls/results when toolCallIds collide           */
/* -------------------------------------------------------------------------- */

function assistantToolCall(id: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "toolCall", id, name: "bash", arguments: { command: `echo ${id}-${timestamp}` } },
    ],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "toolCalls",
    timestamp,
  };
}

function toolResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

describe("export: tool results pair per call, even with a reused id (fixed)", () => {
  // `indexToolResults` builds one Map<toolCallId, ToolResultMessage> up
  // front from the *entire* message list, then every `toolCall` block
  // looks itself up by id. Nothing scopes the lookup to "the result that
  // immediately follows this specific call" — so if the same id is ever
  // reused later in the conversation (a provider/session bug, a replay, a
  // collision after some future de-dup or merge step), the earlier call
  // silently renders the *later* call's result instead of its own, with no
  // error or fallback to "no result recorded". `ToolCallContent.id`'s
  // TSDoc calls the id "unique within the conversation", but nothing in
  // export.ts enforces or even checks that invariant before trusting it.
  it("pairs each tool call with the result that actually answered it, even if a later call reuses the same id", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "run two things" }], timestamp: 1 } as const,
      assistantToolCall("dup", 2),
      toolResult("dup", "RESULT-FROM-FIRST-CALL", 3),
      assistantToolCall("dup", 4),
      toolResult("dup", "RESULT-FROM-SECOND-CALL", 5),
    ];

    const md = exportMarkdown(messages);
    const firstCallSection = md.slice(0, md.indexOf("RESULT-FROM-SECOND-CALL"));

    // Correct behavior: the first toolCall block shows the result that
    // was actually recorded right after it, not a later call's result.
    expect(firstCallSection).toContain("RESULT-FROM-FIRST-CALL");
  });
});
