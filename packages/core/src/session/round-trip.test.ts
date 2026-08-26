/**
 * Round-trip tests for session persistence: everything here writes through the
 * real writer and reads back through the real reader, then asserts on the
 * *content* that came back — never on what a call returned.
 *
 * The bugs these were written against were all invisible to return-value
 * assertions: a compaction that reported `true` while the file it wrote could
 * no longer be replayed, an append that resolved while the entry it wrote was
 * unreadable.
 */

import { mkdtemp, readFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, SessionEntry, StreamEvent } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { createScriptedLLM, TEST_MODEL, textTurn } from "../test-helpers/fake-llm.js";
import { contentText, userMessage } from "../util/content.js";
import { JsonlSessionStore } from "./jsonl-store.js";
import { materializeBranch } from "./tree.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcturn-session-round-trip-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function agentOptions(script: StreamEvent[][]) {
  return {
    llm: createScriptedLLM(script),
    model: TEST_MODEL,
    systemPrompt: "You are Arcturn.",
    cwd: "/work",
    permissions: { mode: "yolo" as const },
    // Small enough that every manual compact() finds a cut point.
    compaction: { keepRecentTokens: 1 },
  };
}

/** All message text on an agent's conversation, joined, for content assertions. */
function transcript(messages: readonly Message[]): string {
  return messages.map((message) => contentText(message.content)).join("\n");
}

describe("compaction survives a resume", () => {
  it("keeps the exchange that followed the first compaction when a second one is replayed", async () => {
    const store = new JsonlSessionStore({ dir });
    const options = agentOptions([
      textTurn("reply one"),
      textTurn("reply two"),
      textTurn("reply three"),
      textTurn("## Goal\nfirst summary"),
    ]);
    const first = new Agent({ ...options, sessionStore: store, sessionId: "s" });
    await first.prompt("one");
    await first.prompt("two");
    await first.prompt("three");
    expect(await first.compact()).toBe(true);

    // Resume, carry on, and compact a second time — the ordinary shape of a
    // long-running session that outlives one process.
    const second = await Agent.resume({
      ...agentOptions([textTurn("reply four"), textTurn("## Goal\nsecond summary")]),
      sessionStore: store,
      sessionId: "s",
    });
    expect(transcript(second.messages)).toContain("reply three");
    await second.prompt("four");
    expect(await second.compact()).toBe(true);
    const live = transcript(second.messages);
    expect(live).toContain("second summary");
    expect(live).toContain("four");
    expect(live).toContain("reply four");

    // The round trip: what the file replays must be what the agent held.
    const replayed = await Agent.resume({
      ...agentOptions([]),
      sessionStore: store,
      sessionId: "s",
    });
    const text = transcript(replayed.messages);
    expect(text).toContain("second summary");
    expect(text).toContain("four");
    expect(text).toContain("reply four");
    expect(replayed.messages.map((m) => m.role)).toEqual(second.messages.map((m) => m.role));
  });
});

function messageEntry(id: string, parentId: string | null, body: string): SessionEntry {
  return { kind: "message", id, parentId, timestamp: Date.now(), message: userMessage(body) };
}

/** Chop the file's final byte, the way a crash mid-`write` leaves it. */
async function tearLastLine(path: string): Promise<void> {
  const raw = await readFile(path, "utf8");
  await truncate(path, raw.length - 5);
}

describe("a session whose last write was torn by a crash", () => {
  it("still stores and reads back everything appended afterwards", async () => {
    const store = new JsonlSessionStore({ dir });
    await store.create({ sessionId: "s", cwd: "/work" });
    await store.append("s", messageEntry("a", null, "first"));
    await store.append("s", messageEntry("b", "a", "torn"));
    await tearLastLine(join(dir, "s.jsonl"));

    // A fresh process picks the session back up and carries on writing.
    const reopened = new JsonlSessionStore({ dir });
    await reopened.append("s", messageEntry("c", "a", "after the crash"));
    await reopened.append("s", messageEntry("d", "c", "and another"));

    const entries = await reopened.entries("s");
    expect(entries.map((entry) => entry.id)).toEqual(["a", "c", "d"]);
    expect(contentText((entries[1] as { message: Message }).message.content)).toBe(
      "after the crash",
    );
  });

  it("does not turn one torn line into a permanently unreadable session", async () => {
    const store = new JsonlSessionStore({ dir });
    await store.create({ sessionId: "s", cwd: "/work" });
    await store.append("s", messageEntry("a", null, "first"));
    await store.append("s", messageEntry("b", "a", "torn"));
    await tearLastLine(join(dir, "s.jsonl"));

    for (const id of ["c", "d", "e"]) {
      await store.append("s", messageEntry(id, "a", id));
    }
    // Whatever the torn line costs, it costs it once. Reading must not fail.
    const entries = await store.entries("s");
    expect(entries.map((entry) => entry.id)).toEqual(["a", "c", "d", "e"]);
  });
});

describe("a rewind's fork is the branch a resume continues", () => {
  it("continues the new branch and never replays the abandoned one", async () => {
    const store = new JsonlSessionStore({ dir });
    const original = new Agent({
      ...agentOptions([textTurn("reply one"), textTurn("regrettable answer")]),
      sessionStore: store,
      sessionId: "s",
    });
    await original.prompt("one");
    const forkPoint = original.leafEntryId;
    await original.prompt("the question I regret asking");
    expect(transcript(original.messages)).toContain("regrettable answer");

    // Fork back — the same call `/rewind` makes via `rewindConversationTo`.
    const forked = await Agent.resume({
      ...agentOptions([textTurn("better answer")]),
      sessionStore: store,
      sessionId: "s",
      ...(forkPoint === null ? {} : { leafId: forkPoint }),
    });
    expect(transcript(forked.messages)).not.toContain("regrettable");
    await forked.prompt("a better question");

    // The store still holds both branches...
    const entries = await store.entries("s");
    expect(JSON.stringify(entries)).toContain("regrettable answer");

    // ...but the default resume — no leafId, the `--continue` path — lands on
    // the branch the fork built, not the one it walked away from.
    const resumed = await Agent.resume({
      ...agentOptions([]),
      sessionStore: store,
      sessionId: "s",
    });
    const text = transcript(resumed.messages);
    expect(text).toContain("a better question");
    expect(text).toContain("better answer");
    expect(text).not.toContain("regrettable");
    expect(text).not.toContain("the question I regret asking");
  });

  it("keeps two forks from one node apart", async () => {
    const store = new JsonlSessionStore({ dir });
    const root = new Agent({
      ...agentOptions([textTurn("shared reply")]),
      sessionStore: store,
      sessionId: "s",
    });
    await root.prompt("shared question");
    const shared = root.leafEntryId!;

    const left = await Agent.resume({
      ...agentOptions([textTurn("left reply")]),
      sessionStore: store,
      sessionId: "s",
      leafId: shared,
    });
    await left.prompt("left question");

    const right = await Agent.resume({
      ...agentOptions([textTurn("right reply")]),
      sessionStore: store,
      sessionId: "s",
      leafId: shared,
    });
    await right.prompt("right question");

    for (const [tip, mine, theirs] of [
      [left.leafEntryId!, "left", "right"],
      [right.leafEntryId!, "right", "left"],
    ] as const) {
      const replayed = await Agent.resume({
        ...agentOptions([]),
        sessionStore: store,
        sessionId: "s",
        leafId: tip,
      });
      const text = transcript(replayed.messages);
      expect(text).toContain("shared question");
      expect(text).toContain(`${mine} question`);
      expect(text).toContain(`${mine} reply`);
      expect(text).not.toContain(`${theirs} question`);
      expect(text).not.toContain(`${theirs} reply`);
    }
  });

  it("forks again from a node that is itself on an abandoned branch", async () => {
    const store = new JsonlSessionStore({ dir });
    const first = new Agent({
      ...agentOptions([textTurn("reply one"), textTurn("reply two")]),
      sessionStore: store,
      sessionId: "s",
    });
    await first.prompt("one");
    const afterOne = first.leafEntryId!;
    await first.prompt("two");
    const afterTwo = first.leafEntryId!;

    // Abandon everything after "one"...
    const abandoning = await Agent.resume({
      ...agentOptions([textTurn("reply three")]),
      sessionStore: store,
      sessionId: "s",
      leafId: afterOne,
    });
    await abandoning.prompt("three");

    // ...then change your mind and fork from the abandoned branch's tip.
    const revived = await Agent.resume({
      ...agentOptions([textTurn("reply four")]),
      sessionStore: store,
      sessionId: "s",
      leafId: afterTwo,
    });
    await revived.prompt("four");

    const replayed = await Agent.resume({
      ...agentOptions([]),
      sessionStore: store,
      sessionId: "s",
      leafId: revived.leafEntryId!,
    });
    const text = transcript(replayed.messages);
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("four");
    expect(text).not.toContain("three");
  });
});

describe("resuming an interrupted session", () => {
  it("carries the same conversation, todos and plan, twice over", async () => {
    const store = new JsonlSessionStore({ dir });
    await store.create({ sessionId: "s", cwd: "/work" });
    await store.append("s", messageEntry("m1", null, "do the thing"));
    await store.append("s", {
      kind: "state",
      id: "st1",
      parentId: "m1",
      timestamp: Date.now(),
      todos: [
        { id: "t1", text: "ship it", status: "inProgress" },
        { id: "t2", text: "and the next", status: "pending" },
      ],
      plan: "the plan of record",
    });
    await store.append("s", messageEntry("m2", "st1", "carry on"));

    for (const round of [1, 2]) {
      const resumed = await Agent.resume({
        ...agentOptions([]),
        sessionStore: store,
        sessionId: "s",
      });
      expect(transcript(resumed.messages), `round ${round}`).toContain("do the thing");
      expect(transcript(resumed.messages), `round ${round}`).toContain("carry on");
      expect(resumed.todos.map((todo) => todo.text)).toEqual(["ship it", "and the next"]);
      expect(resumed.plan).toBe("the plan of record");
      expect(resumed.leafEntryId).toBe("m2");
    }
  });

  it("picks up entries another process appended after this one opened the store", async () => {
    const mine = new JsonlSessionStore({ dir });
    const theirs = new JsonlSessionStore({ dir });
    await mine.create({ sessionId: "s", cwd: "/work" });
    await mine.append("s", messageEntry("m1", null, "mine"));
    // A second process — `arcturn serve` beside a terminal — writes to the
    // same file through its own store instance.
    await theirs.append("s", messageEntry("m2", "m1", "theirs"));

    const resumed = await Agent.resume({
      ...agentOptions([]),
      sessionStore: mine,
      sessionId: "s",
    });
    expect(transcript(resumed.messages)).toContain("theirs");
    expect(resumed.leafEntryId).toBe("m2");
  });
});

describe("entries a reader does not understand", () => {
  it("replays around an entry kind from a future version instead of failing", async () => {
    const store = new JsonlSessionStore({ dir });
    await store.create({ sessionId: "s", cwd: "/work" });
    await store.append("s", messageEntry("m1", null, "before the unknown"));
    await store.append("s", {
      // A kind this version has never heard of, on the branch's parent chain.
      kind: "attachment",
      id: "x1",
      parentId: "m1",
      timestamp: Date.now(),
      blobRef: "sha256:deadbeef",
    } as unknown as SessionEntry);
    await store.append("s", messageEntry("m2", "x1", "after the unknown"));

    const entries = await store.entries("s");
    // The reader keeps it: a future version's entry is not the reader's to
    // discard, and dropping it would break the parent chain through it.
    expect(entries.map((entry) => entry.id)).toEqual(["m1", "x1", "m2"]);

    const resumed = await Agent.resume({
      ...agentOptions([]),
      sessionStore: store,
      sessionId: "s",
    });
    const text = transcript(resumed.messages);
    expect(text).toContain("before the unknown");
    expect(text).toContain("after the unknown");
  });
});

describe("two writers on one session file", () => {
  it("never interleaves two processes' lines into one corrupt entry", async () => {
    const mine = new JsonlSessionStore({ dir });
    const theirs = new JsonlSessionStore({ dir });
    await mine.create({ sessionId: "s", cwd: "/work" });
    // Big enough that a non-atomic write would be visibly torn in half.
    const bulk = "x".repeat(20_000);

    await Promise.all([
      ...Array.from({ length: 12 }, (_, i) =>
        mine.append("s", messageEntry(`a${i}`, null, `mine ${i} ${bulk}`)),
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        theirs.append("s", messageEntry(`b${i}`, null, `theirs ${i} ${bulk}`)),
      ),
    ]);

    // Reading is the assertion: `entries` throws on any unparsable line that
    // is not the last one.
    const entries = await mine.entries("s");
    expect(entries).toHaveLength(24);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(24);
  });

  it("a title rewrite does not swallow an entry appended while it runs", async () => {
    const store = new JsonlSessionStore({ dir });
    await store.create({ sessionId: "s", cwd: "/work" });
    await store.append("s", messageEntry("m1", null, "first"));

    await Promise.all([
      store.setTitle("s", "a new title"),
      store.append("s", messageEntry("m2", "m1", "written during the retitle")),
    ]);

    expect(await store.open("s")).toMatchObject({ title: "a new title" });
    expect((await store.entries("s")).map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  /**
   * KNOWN GAP, pinned rather than fixed. Two live agents on one session id —
   * `arcturn serve` and a terminal — each hold their own in-memory branch tip,
   * so their appends build two branches from the node they last shared. A
   * default resume follows the *last appended* entry, so whichever process
   * wrote most recently wins the whole history and the other's turn becomes
   * an invisible sibling branch. Nothing warns.
   */
  it("silently forks when two live agents append from the same tip", async () => {
    const store = new JsonlSessionStore({ dir });
    await store.create({ sessionId: "s", cwd: "/work" });
    await store.append("s", messageEntry("shared", null, "shared turn"));

    // Terminal writes first, then serve writes from the tip IT still remembers.
    await store.append("s", messageEntry("terminal", "shared", "typed in the terminal"));
    await store.append("s", messageEntry("serve", "shared", "sent over the wire"));

    const resumed = await Agent.resume({
      ...agentOptions([]),
      sessionStore: store,
      sessionId: "s",
    });
    const text = transcript(resumed.messages);
    expect(text).toContain("shared turn");
    expect(text).toContain("sent over the wire");
    // This is the gap: the terminal's turn is on the file and unreachable
    // without knowing its entry id.
    expect(text).not.toContain("typed in the terminal");
    expect(JSON.stringify(await store.entries("s"))).toContain("typed in the terminal");
  });
});

describe("what compaction leaves in the file", () => {
  it("shortens the replayed conversation and keeps the recent turns verbatim", async () => {
    const store = new JsonlSessionStore({ dir });
    const agent = new Agent({
      ...agentOptions([
        textTurn("reply about the parser"),
        textTurn("reply about the lexer"),
        textTurn("reply about the emitter"),
        textTurn("## Goal\nport the compiler\n\n## Next steps\nfinish the emitter"),
      ]),
      sessionStore: store,
      sessionId: "s",
    });
    await agent.prompt("tell me about the parser");
    await agent.prompt("tell me about the lexer");
    await agent.prompt("tell me about the emitter");

    const before = materializeBranch(await store.entries("s")).messages;
    expect(await agent.compact()).toBe(true);

    // Measure the SAME thing before and after: what the file replays.
    const entries = await store.entries("s");
    const after = materializeBranch(entries).messages;
    expect(after.length).toBeLessThan(before.length);

    const text = transcript(after);
    expect(text).toContain("port the compiler");
    expect(text).toContain("finish the emitter");
    // The tail the summary did NOT claim to cover is still there word for word.
    expect(text).toContain("tell me about the emitter");
    expect(text).toContain("reply about the emitter");
    // ...and the head it did claim is gone from the replay.
    expect(text).not.toContain("reply about the parser");
  });

  it("records an upToId that is actually on the branch it was written to", async () => {
    const store = new JsonlSessionStore({ dir });
    const first = new Agent({
      ...agentOptions([
        textTurn("one"),
        textTurn("two"),
        textTurn("three"),
        textTurn("## Goal\nsummary one"),
        textTurn("four"),
        textTurn("## Goal\nsummary two"),
      ]),
      sessionStore: store,
      sessionId: "s",
    });
    await first.prompt("q1");
    await first.prompt("q2");
    await first.prompt("q3");
    await first.compact();
    const resumed = await Agent.resume({
      ...agentOptions([textTurn("four"), textTurn("## Goal\nsummary two")]),
      sessionStore: store,
      sessionId: "s",
    });
    await resumed.prompt("q4");
    await resumed.compact();

    // The invariant that makes a compaction replayable at all: `upToId` must
    // name a message the replay is still HOLDING when it reaches the
    // compaction — not merely an entry somewhere on the branch, which every
    // already-folded entry also is. Miss the distinction and the replay finds
    // no cut point, and folds either nothing or everything.
    const entries = await store.entries("s");
    const compactions = entries.filter((entry) => entry.kind === "compaction");
    expect(compactions.length).toBe(2);
    for (const compaction of compactions) {
      if (compaction.kind !== "compaction") throw new Error("unreachable");
      const branch = await store.branch("s", compaction.id);
      const upToThisPoint = branch.slice(0, branch.length - 1);
      expect(materializeBranch(upToThisPoint).messageEntryIds).toContain(compaction.upToId);
    }
  });
});

describe("the model a session was last switched to", () => {
  it("comes back on resume when the caller can resolve it, and is not re-written", async () => {
    const store = new JsonlSessionStore({ dir });
    const other = { ...TEST_MODEL, id: "test/other", displayName: "Other" };
    const agent = new Agent({
      ...agentOptions([textTurn("reply")]),
      sessionStore: store,
      sessionId: "s",
    });
    await agent.prompt("hello");
    agent.setModel(other);
    // setModel appends asynchronously; a following append orders behind it.
    await agent.prompt("again");
    expect(JSON.stringify(await store.entries("s"))).toContain("test/other");

    const before = (await store.entries("s")).length;
    const resumed = await Agent.resume({
      ...agentOptions([]),
      sessionStore: store,
      sessionId: "s",
      resolveModel: (id) => (id === other.id ? other : undefined),
    });
    expect(resumed.model.id).toBe("test/other");
    // A resume is a read: it must not append a state entry of its own.
    expect((await store.entries("s")).length).toBe(before);
  });

  it("falls back to the caller's model when the stored id is no longer registered", async () => {
    const store = new JsonlSessionStore({ dir });
    const agent = new Agent({
      ...agentOptions([textTurn("reply")]),
      sessionStore: store,
      sessionId: "s",
    });
    await agent.prompt("hello");
    agent.setModel({ ...TEST_MODEL, id: "retired/model" });
    await agent.prompt("again");

    const resumed = await Agent.resume({
      ...agentOptions([]),
      sessionStore: store,
      sessionId: "s",
      resolveModel: () => undefined,
    });
    expect(resumed.model.id).toBe(TEST_MODEL.id);
  });
});
