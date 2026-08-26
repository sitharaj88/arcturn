/**
 * End-to-end round trips for the LOCAL (terminal) persistence commands:
 * `/rewind` and `/sessions`, driven through the real command registry and a
 * real runtime, asserting on the workspace's bytes and on what the session
 * store replays afterwards.
 *
 * The wire equivalents live in `serve-rewind.test.ts` and
 * `packages/server/src/rewind-wire.test.ts`. This file exists because the two
 * routes are separate code (`rewindConversationTo` vs `forkSessionAgent`) and
 * only one of them had effect-asserting coverage.
 */

import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { registerModel, unregisterModel } from "@arcturn/ai";
import { materializeBranch } from "@arcturn/core";
import type { Message } from "@arcturn/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CommandUi, createCommandRegistry, type SelectOption } from "./commands.js";
import type { ArcturnRuntime } from "./runtime.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

interface RecordingUi extends CommandUi {
  notices: { level: string; text: string }[];
  /** Rows offered by the last picker, so a test can choose by content. */
  lastOptions: readonly SelectOption<unknown>[];
  /** Picks a row from what the picker offered. */
  choose: (options: readonly SelectOption<unknown>[]) => unknown;
}

function recordingUi(choose: RecordingUi["choose"] = () => undefined): RecordingUi {
  const ui: RecordingUi = {
    notices: [],
    lastOptions: [],
    choose,
    print() {},
    notice(level, text) {
      ui.notices.push({ level, text });
    },
    async select<T>(_title: string, options: readonly SelectOption<T>[]) {
      ui.lastOptions = options as readonly SelectOption<unknown>[];
      return ui.choose(ui.lastOptions) as T | undefined;
    },
    setInput() {},
    clear() {},
    exit() {},
  };
  return ui;
}

async function dispatch(runtime: ArcturnRuntime, input: string, ui: RecordingUi) {
  return createCommandRegistry().dispatch(input, { runtime, ui });
}

function transcript(messages: readonly Message[]): string {
  return JSON.stringify(messages);
}

/** What the session FILE replays for the branch this agent is now on. */
async function replayed(runtime: ArcturnRuntime): Promise<Message[]> {
  const leafId = runtime.agent.leafEntryId;
  if (leafId === null) return [];
  return materializeBranch(await runtime.store.branch(runtime.agent.sessionId, leafId)).messages;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("/rewind on the local path", () => {
  it("puts the files back and leaves the agent on the forked branch", async () => {
    const scratch = await makeScratch();
    const kept = join(scratch.cwd, "kept.txt");
    const created = join(scratch.cwd, "created.txt");
    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [{ id: "c1", name: "write", arguments: { path: "kept.txt", content: "v1" } }],
        },
        { text: "wrote kept.txt" },
        {
          toolCalls: [
            { id: "c2", name: "write", arguments: { path: "kept.txt", content: "v2" } },
            { id: "c3", name: "write", arguments: { path: "created.txt", content: "new" } },
          ],
        },
        { text: "the regrettable turn" },
      ],
      { permissionMode: "yolo" },
    );

    await runtime.agent.prompt("first: make kept.txt");
    expect(await readFile(kept, "utf8")).toBe("v1");
    await runtime.agent.prompt("second: the turn I want undone");
    expect(await readFile(kept, "utf8")).toBe("v2");
    expect(await exists(created)).toBe(true);

    const turns = await runtime.checkpoints.listTurns();
    expect(turns).toHaveLength(2);
    const target = turns[1]!;

    const ui = recordingUi((options) => options.find((o) => o.value === target.id)?.data);
    await dispatch(runtime, "/rewind", ui);

    // The workspace is back.
    expect(await readFile(kept, "utf8")).toBe("v1");
    expect(await exists(created)).toBe(false);

    // ...and so is the conversation, in the FILE, not only in memory.
    const text = transcript(await replayed(runtime));
    expect(text).toContain("first: make kept.txt");
    expect(text).not.toContain("the turn I want undone");
    expect(text).not.toContain("the regrettable turn");
    expect(ui.notices.map((n) => n.text)).toContain("Conversation forked back to that turn.");
  });

  it("keeps the abandoned branch out of the next turn's history", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "c1", name: "write", arguments: { path: "a.txt", content: "v1" } }] },
        { text: "first answer" },
        { toolCalls: [{ id: "c2", name: "write", arguments: { path: "a.txt", content: "v2" } }] },
        { text: "abandoned answer" },
        { text: "replacement answer" },
      ],
      { permissionMode: "yolo" },
    );

    await runtime.agent.prompt("keep me");
    await runtime.agent.prompt("abandon me");
    const turns = await runtime.checkpoints.listTurns();
    const ui = recordingUi((options) => options.find((o) => o.value === turns[1]!.id)?.data);
    await dispatch(runtime, "/rewind", ui);

    // The next real turn continues the fork.
    await runtime.agent.prompt("the replacement");
    const text = transcript(await replayed(runtime));
    expect(text).toContain("keep me");
    expect(text).toContain("the replacement");
    expect(text).toContain("replacement answer");
    expect(text).not.toContain("abandon me");
    expect(text).not.toContain("abandoned answer");

    // Every message the model is now sent agrees with the file.
    expect(transcript(runtime.agent.messages)).not.toContain("abandoned answer");
  });

  it("restores files but says so plainly when the conversation link is not this process's", async () => {
    const scratch = await makeScratch();
    const path = join(scratch.cwd, "a.txt");
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "c1", name: "write", arguments: { path: "a.txt", content: "v1" } }] },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );
    await runtime.agent.prompt("make it");
    const before = transcript(runtime.agent.messages);

    // A turn recorded by an earlier process: on the manifest, absent from the
    // in-memory link table.
    const orphan = await runtime.checkpoints.beginTurn("from a previous run");
    await runtime.checkpoints.snapshot(path);
    await rm(path);

    const ui = recordingUi((options) => options.find((o) => o.value === orphan)?.data);
    await dispatch(runtime, "/rewind", ui);

    expect(await readFile(path, "utf8")).toBe("v1");
    expect(transcript(runtime.agent.messages)).toBe(before);
    expect(ui.notices.some((n) => n.level === "warn" && n.text.includes("predates"))).toBe(true);
  });
});

describe("/sessions on the local path", () => {
  it("resumes the conversation the picked session actually holds", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [{ text: "answer in the first session" }, { text: "answer in the second session" }],
      { permissionMode: "yolo" },
    );
    await runtime.agent.prompt("the first session's question");
    const firstId = runtime.agent.sessionId;

    runtime.startNewSession();
    await runtime.agent.prompt("the second session's question");
    expect(runtime.agent.sessionId).not.toBe(firstId);

    const ui = recordingUi((options) => options.find((o) => o.value === firstId)?.data);
    await dispatch(runtime, "/sessions", ui);

    expect(runtime.agent.sessionId).toBe(firstId);
    const text = transcript(runtime.agent.messages);
    expect(text).toContain("the first session's question");
    expect(text).toContain("answer in the first session");
    expect(text).not.toContain("the second session's question");
    // The agent's leaf is the file's leaf: the next append continues this
    // branch instead of starting an orphan one.
    expect(transcript(await replayed(runtime))).toContain("answer in the first session");
  });
});

describe("the model a session was last switched to, on the local path", () => {
  const OTHER = {
    id: "test/round-trip-other",
    provider: "openai-compatible" as const,
    model: "other-1",
    displayName: "Other Round-Trip Model",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: { tools: true, vision: false, thinking: false, caching: false },
  };

  beforeAll(() => registerModel(OTHER));
  afterAll(() => unregisterModel(OTHER.id));

  it("is what /sessions resumes onto, not the startup default", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }], {
      permissionMode: "yolo",
    });
    const startup = runtime.model.id;
    expect(startup).not.toBe(OTHER.id);

    await runtime.agent.prompt("first question");
    const sessionId = runtime.agent.sessionId;
    runtime.setModel(OTHER.id);
    await runtime.agent.prompt("second question");
    expect(runtime.agent.model.id).toBe(OTHER.id);

    // Walk away to a fresh session, then come back through the real picker.
    runtime.startNewSession();
    runtime.setModel(startup);
    await runtime.agent.prompt("a different session");

    const ui = recordingUi((options) => options.find((o) => o.value === sessionId)?.data);
    await dispatch(runtime, "/sessions", ui);

    expect(runtime.agent.sessionId).toBe(sessionId);
    expect(runtime.agent.model.id).toBe(OTHER.id);
    // The runtime's own view agrees, so /cost and the footer price the right model.
    expect(runtime.model.id).toBe(OTHER.id);
  });

  it("loses to a --model flag the user typed for this invocation", async () => {
    const scratch = await makeScratch();
    const first = await buildTestRuntime(scratch, [{ text: "ok" }], { permissionMode: "yolo" });
    await first.agent.prompt("hello");
    const sessionId = first.agent.sessionId;
    first.setModel(OTHER.id);
    await first.agent.prompt("again");

    const pinned = await buildTestRuntime(scratch, [{ text: "ok" }], {
      permissionMode: "yolo",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(pinned.modelPinned).toBe(true);
    await pinned.resumeSession(sessionId);
    expect(pinned.agent.model.id).toBe("anthropic/claude-sonnet-4-5");
  });
});
