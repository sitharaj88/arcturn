import type { Message, SessionEntry } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { userMessage } from "../util/content.js";
import { buildTree, latestEntryId, leafEntries, materializeBranch, pathToLeaf } from "./tree.js";

function messageEntry(id: string, parentId: string | null, message: Message): SessionEntry {
  return { kind: "message", id, parentId, timestamp: 1, message };
}

const a = messageEntry("a", null, userMessage("first"));
const b = messageEntry("b", "a", userMessage("second"));
const c = messageEntry("c", "b", userMessage("third"));
const d = messageEntry("d", "a", userMessage("branch"));

describe("buildTree", () => {
  it("links children to parents", () => {
    const tree = buildTree([a, b, c, d]);
    expect(tree.roots.map((n) => n.entry.id)).toEqual(["a"]);
    expect(tree.byId.get("a")?.children.map((n) => n.entry.id)).toEqual(["b", "d"]);
    expect(tree.byId.get("b")?.children.map((n) => n.entry.id)).toEqual(["c"]);
  });

  it("promotes orphans to roots instead of dropping them", () => {
    const orphan = messageEntry("z", "missing", userMessage("orphan"));
    expect(buildTree([a, orphan]).roots.map((n) => n.entry.id)).toEqual(["a", "z"]);
  });
});

describe("pathToLeaf", () => {
  it("walks parent links root-first", () => {
    expect(pathToLeaf([a, b, c, d], "c").map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(pathToLeaf([a, b, c, d], "d").map((e) => e.id)).toEqual(["a", "d"]);
  });

  it("returns nothing for an unknown leaf", () => {
    expect(pathToLeaf([a, b], "nope")).toEqual([]);
  });

  it("survives a cycle", () => {
    const x: SessionEntry = messageEntry("x", "y", userMessage("x"));
    const y: SessionEntry = messageEntry("y", "x", userMessage("y"));
    expect(pathToLeaf([x, y], "x").map((e) => e.id)).toEqual(["y", "x"]);
  });
});

describe("leafEntries and latestEntryId", () => {
  it("finds every branch tip", () => {
    expect(
      leafEntries([a, b, c, d])
        .map((e) => e.id)
        .sort(),
    ).toEqual(["c", "d"]);
  });

  it("reports the newest appended entry", () => {
    expect(latestEntryId([a, b, c])).toBe("c");
    expect(latestEntryId([])).toBeNull();
  });
});

describe("materializeBranch", () => {
  it("replays messages in order", () => {
    const state = materializeBranch([a, b, c]);
    expect(state.messages).toHaveLength(3);
    expect(state.leafId).toBe("c");
  });

  it("applies state entries", () => {
    const stateEntry: SessionEntry = {
      kind: "state",
      id: "s",
      parentId: "a",
      timestamp: 2,
      todos: [{ id: "t1", text: "ship", status: "inProgress" }],
      plan: "the plan",
      model: "test/model",
    };
    const state = materializeBranch([a, stateEntry]);
    expect(state.todos).toHaveLength(1);
    expect(state.plan).toBe("the plan");
    expect(state.model).toBe("test/model");
  });

  it("folds compacted history into a single summary message", () => {
    const compaction: SessionEntry = {
      kind: "compaction",
      id: "comp",
      parentId: "b",
      timestamp: 3,
      summary: "## Goal\nship arcturn",
      upToId: "b",
      tokensBefore: 100,
      tokensAfter: 10,
    };
    const after = messageEntry("e", "comp", userMessage("after compaction"));
    const state = materializeBranch([a, b, compaction, after]);

    expect(state.messages).toHaveLength(2);
    const [summary, tail] = state.messages;
    expect(summary?.role).toBe("user");
    expect(JSON.stringify(summary)).toContain("compacted-history");
    expect(JSON.stringify(summary)).toContain("ship arcturn");
    expect(JSON.stringify(tail)).toContain("after compaction");
    expect(state.leafId).toBe("e");
  });

  it("ignores label entries", () => {
    const label: SessionEntry = {
      kind: "label",
      id: "l",
      parentId: "a",
      timestamp: 2,
      label: "v1",
    };
    expect(materializeBranch([a, label, b]).messages).toHaveLength(2);
  });
});
