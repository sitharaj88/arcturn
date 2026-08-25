import type { AgentEvent, SessionEntry } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  buildSessionHistory,
  capSessionEvents,
  projectSessionEvents,
  SESSION_HISTORY_MAX_BYTES,
  SESSION_HISTORY_MAX_EVENTS,
} from "./session-history.js";

let nextId = 0;
function entry(
  partial: Omit<SessionEntry, "id" | "parentId" | "timestamp">,
  parentId: string | null,
) {
  nextId += 1;
  return { ...partial, id: `e${String(nextId)}`, parentId, timestamp: nextId } as SessionEntry;
}

/** A linear branch built from a list of partial entries. */
function chain(
  ...parts: Array<Omit<SessionEntry, "id" | "parentId" | "timestamp">>
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parent: string | null = null;
  for (const part of parts) {
    const built = entry(part, parent);
    entries.push(built);
    parent = built.id;
  }
  return entries;
}

const userEntry = (text: string) =>
  ({
    kind: "message" as const,
    message: { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 },
  }) satisfies Omit<SessionEntry, "id" | "parentId" | "timestamp">;

const assistantEntry = (text: string) =>
  ({
    kind: "message" as const,
    message: {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn" as const,
      timestamp: 2,
    },
  }) satisfies Omit<SessionEntry, "id" | "parentId" | "timestamp">;

const toolResultEntry = (toolCallId: string, text: string) =>
  ({
    kind: "message" as const,
    message: {
      role: "toolResult" as const,
      toolCallId,
      toolName: "bash",
      content: [{ type: "text" as const, text }],
      isError: false,
      timestamp: 3,
    },
  }) satisfies Omit<SessionEntry, "id" | "parentId" | "timestamp">;

describe("projectSessionEvents", () => {
  it("turns a stored conversation into the events a live client would have seen", () => {
    const events = projectSessionEvents(
      "s1",
      chain(userEntry("do the thing"), assistantEntry("done"), toolResultEntry("tc1", "output")),
    );

    expect(events.map((event) => event.type)).toEqual([
      "runStart",
      "messageEnd",
      "toolEnd",
      "runEnd",
    ]);
    expect(events[0]).toMatchObject({ type: "runStart", sessionId: "s1" });
    expect(events[2]).toMatchObject({ type: "toolEnd", toolCallId: "tc1" });
    // Closed, so a reducer's `running` flag lands false rather than sticking
    // on a turn that ended hours ago.
    expect(events.at(-1)).toEqual({ type: "runEnd", reason: "completed" });
  });

  it("opens a new run per user message and closes the previous one", () => {
    const events = projectSessionEvents(
      "s1",
      chain(userEntry("one"), assistantEntry("a"), userEntry("two"), assistantEntry("b")),
    );
    expect(events.map((event) => event.type)).toEqual([
      "runStart",
      "messageEnd",
      "runEnd",
      "runStart",
      "messageEnd",
      "runEnd",
    ]);
  });

  it("replays only the active branch, not a branch the session was rewound off", () => {
    // root → abandoned, and root → kept. `latestEntryId` picks the last
    // appended entry, which is the tip of the branch the agent will continue.
    const root = entry(userEntry("shared prompt"), null);
    const abandoned = entry(assistantEntry("the answer nobody kept"), root.id);
    const kept = entry(assistantEntry("the answer that stands"), root.id);

    const events = projectSessionEvents("s1", [root, abandoned, kept]);
    const text = JSON.stringify(events);
    expect(text).toContain("the answer that stands");
    expect(text).not.toContain("the answer nobody kept");
  });

  it("carries compaction and agent state, and drops what no live event carries", () => {
    const events = projectSessionEvents(
      "s1",
      chain(
        userEntry("hi"),
        {
          kind: "compaction",
          summary: "we discussed the parser",
          upToId: "e0",
          tokensBefore: 900,
          tokensAfter: 100,
        },
        { kind: "state", todos: [{ id: "t1", text: "ship it", status: "pending" }] },
        { kind: "state", plan: "the plan" },
        // A branch label and a state entry's model id have no live event of
        // their own; neither may be given a shape a client has never seen.
        { kind: "label", label: "before the refactor" },
        { kind: "state", model: "secret/model-nobody-announced" },
      ),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain("compactionEnd");
    expect(types).toContain("todoUpdate");
    expect(types).toContain("planUpdate");
    expect(JSON.stringify(events)).not.toContain("before the refactor");
    expect(JSON.stringify(events)).not.toContain("secret/model-nobody-announced");
  });

  it("returns nothing for a session with no entries", () => {
    expect(projectSessionEvents("s1", [])).toEqual([]);
  });
});

describe("capSessionEvents", () => {
  const run = (label: string): AgentEvent[] => [
    {
      type: "runStart",
      sessionId: "s1",
      prompt: { role: "user", content: [{ type: "text", text: label }], timestamp: 1 },
    },
    { type: "runEnd", reason: "completed" },
  ];

  it("keeps everything, and reports no truncation, when it fits", () => {
    const events = [...run("one"), ...run("two")];
    expect(capSessionEvents(events)).toEqual({ events, truncated: false, droppedEvents: 0 });
  });

  it("keeps the newest events and reports exactly what it dropped", () => {
    const events = [...run("one"), ...run("two"), ...run("three")];
    const capped = capSessionEvents(events, { maxEvents: 2 });

    expect(capped.truncated).toBe(true);
    expect(capped.droppedEvents).toBe(4);
    expect(capped.events).toHaveLength(2);
    expect(JSON.stringify(capped.events)).toContain("three");
    expect(JSON.stringify(capped.events)).not.toContain("one");
  });

  it("cuts at a run boundary rather than through the middle of a turn", () => {
    const events = [...run("one"), ...run("two")];
    // Budget for three of the four events; the boundary walk gives back the
    // orphaned `runEnd` rather than starting the transcript on it.
    const capped = capSessionEvents(events, { maxEvents: 3 });
    expect(capped.events[0]).toMatchObject({ type: "runStart" });
    expect(capped.droppedEvents).toBe(2);
  });

  it("honours a byte budget independently of the event count", () => {
    const events = [...run("x".repeat(400)), ...run("y".repeat(400))];
    const capped = capSessionEvents(events, { maxBytes: 600 });
    expect(capped.truncated).toBe(true);
    expect(JSON.stringify(capped.events).length).toBeLessThanOrEqual(600);
  });

  it("keeps a partial run rather than nothing when the last run alone is over budget", () => {
    const events = run("z".repeat(2_000));
    const capped = capSessionEvents(events, { maxBytes: 200 });
    // The `runStart` cannot fit, so the boundary walk finds none and the
    // `runEnd` survives on its own: a truncated transcript beats an empty one
    // presented as if it were the whole conversation.
    expect(capped.truncated).toBe(true);
    expect(capped.events).toEqual([{ type: "runEnd", reason: "completed" }]);
  });

  it("budgets in bytes, not UTF-16 code units", () => {
    // 300 CJK characters: 300 code units, 900 UTF-8 bytes. A cap measured with
    // `.length` would let this through and put three times the promised
    // payload on the wire.
    const wide = capSessionEvents(run("私".repeat(300)), { maxBytes: 500 });
    const narrow = capSessionEvents(run("x".repeat(300)), { maxBytes: 500 });

    expect(narrow.events).toHaveLength(2);
    expect(wide.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(wide.events), "utf8")).toBeLessThanOrEqual(500);
  });
});

describe("buildSessionHistory", () => {
  it("defaults to the documented caps", () => {
    expect(SESSION_HISTORY_MAX_BYTES).toBe(1024 * 1024);
    expect(SESSION_HISTORY_MAX_EVENTS).toBe(1000);

    const history = buildSessionHistory("s1", chain(userEntry("hi"), assistantEntry("hello")));
    expect(history).toMatchObject({ sessionId: "s1", truncated: false, droppedEvents: 0 });
    expect(history.events).toHaveLength(3);
  });
});
