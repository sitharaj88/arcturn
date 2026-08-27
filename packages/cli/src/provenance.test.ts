import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Message, ToolResultMessage } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The real generator the `edit` tool uses, so the diffs these tests feed the
// observer are byte-for-byte what a live `EditToolDetails.diff` carries. It is
// not re-exported from `@arcturn/tools`'s entry point, hence the source path.
import { createUnifiedDiff } from "../../tools/src/diff.js";
import {
  type BlameLine,
  createProvenanceStore,
  diffLineOps,
  formatBlame,
  isUntrustedEvidenceSource,
  type ProvenanceEvidenceRecord,
  type ProvenanceManifestEntry,
  type ProvenanceStore,
  provenanceObserver,
  reconstructBefore,
} from "./provenance.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcturn-provenance-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** Read the raw manifest lines, so tests can assert on-disk integrity. */
async function manifest(): Promise<ProvenanceManifestEntry[]> {
  const raw = await readFile(join(dir, "manifest.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ProvenanceManifestEntry);
}

/** The text of every blame line, in order. */
function texts(lines: readonly BlameLine[]): string[] {
  return lines.map((line) => line.text);
}

/** The turn ordinal of every blame line; `null` for unattributed ones. */
function turnIndices(lines: readonly BlameLine[]): Array<number | null> {
  return lines.map((line) => line.turnIndex ?? null);
}

function lineFor(lines: readonly BlameLine[], text: string): BlameLine {
  const found = lines.find((line) => line.text === text);
  if (!found) throw new Error(`no blame line with text ${JSON.stringify(text)}`);
  return found;
}

/* -------------------------------------------------------------------------- */
/* Store round trip                                                            */
/* -------------------------------------------------------------------------- */

describe("ProvenanceStore round trip", () => {
  it("records turns, evidence and mutations to one append-only manifest", async () => {
    const store = createProvenanceStore(dir);
    const turnId = await store.beginTurn("  fix   the session bug\n");
    await store.recordEvidence("read", "/repo/src/a.ts", false);
    await store.recordEvidence("fetch", "https://docs.test/api", true);
    await store.recordMutation("/repo/src/a.ts", null, "one\ntwo\n");
    await store.close();

    const entries = await manifest();
    expect(entries.map((entry) => entry.kind)).toEqual([
      "turn",
      "evidence",
      "evidence",
      "mutation",
    ]);

    const turn = entries[0];
    if (turn?.kind !== "turn") throw new Error("expected a turn record");
    expect(turn.id).toBe(turnId);
    // Whitespace is collapsed, so a multi-line prompt stays one manifest line.
    expect(turn.prompt).toBe("fix the session bug");
    expect(turn.startedAt).toBeGreaterThan(0);

    const mutation = entries[3];
    if (mutation?.kind !== "mutation") throw new Error("expected a mutation record");
    expect(mutation.turnId).toBe(turnId);
    expect(mutation.beforeBlob).toBeNull();
    expect(mutation.afterBlob).toMatch(/^[0-9a-f]{64}$/);

    const summaries = await store.turns();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: turnId,
      index: 1,
      prompt: "fix the session bug",
      mutationCount: 1,
      evidenceCount: 2,
      untrustedCount: 1,
    });

    const evidence = await store.evidence(turnId);
    expect(evidence.map((entry) => entry.toolName)).toEqual(["read", "fetch"]);
    expect(evidence[1]?.untrusted).toBe(true);
  });

  it("de-duplicates content across mutations that share a file state", async () => {
    const store = createProvenanceStore(dir);
    await store.beginTurn("p");
    // after(#1) === before(#2), and #3 reverts to the very first state.
    await store.recordMutation("/repo/a.ts", "a\n", "b\n");
    await store.recordMutation("/repo/a.ts", "b\n", "c\n");
    await store.recordMutation("/repo/a.ts", "c\n", "a\n");
    await store.close();

    const blobs = await readdir(join(dir, "blobs"));
    expect(blobs.filter((name) => !name.startsWith("."))).toHaveLength(3);
  });

  it("opens an untracked turn rather than dropping a record with no turn", async () => {
    const store = createProvenanceStore(dir);
    await store.recordMutation("/repo/a.ts", null, "x\n");
    await store.close();

    const summaries = await store.turns();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.prompt).toBe("(untracked)");
    expect(summaries[0]?.mutationCount).toBe(1);
  });

  it("reads back as empty when nothing was ever recorded", async () => {
    const store = createProvenanceStore(dir);
    expect(await store.turns()).toEqual([]);
    expect(await store.evidence()).toEqual([]);
    expect(await store.blame("/repo/a.ts")).toEqual([]);
  });

  it("keeps the record but drops the content for an oversize write", async () => {
    const store = createProvenanceStore(dir, { maxContentBytes: 16 });
    await store.beginTurn("p");
    await store.recordMutation("/repo/big.ts", null, "x".repeat(64));
    await store.close();

    const entries = await manifest();
    const mutation = entries[1];
    if (mutation?.kind !== "mutation") throw new Error("expected a mutation record");
    expect(mutation.oversize).toBe(true);
    expect(mutation.afterBlob).toBeNull();
    // Nothing was stored, so nothing can be attributed — and blame says so
    // rather than inventing an attribution.
    expect(await store.blame("/repo/big.ts")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Line attribution                                                            */
/* -------------------------------------------------------------------------- */

describe("blame line attribution", () => {
  it("attributes each line to the turn that wrote it", async () => {
    const store = createProvenanceStore(dir);
    const turn1 = await store.beginTurn("create the file");
    await store.recordMutation("/repo/a.ts", null, "const a = 1;\nconst b = 2;");
    const turn2 = await store.beginTurn("append c");
    await store.recordMutation(
      "/repo/a.ts",
      "const a = 1;\nconst b = 2;",
      "const a = 1;\nconst b = 2;\nconst c = 3;",
    );
    await store.close();

    const lines = await store.blame("/repo/a.ts");
    expect(texts(lines)).toEqual(["const a = 1;", "const b = 2;", "const c = 3;"]);
    expect(lines.map((line) => line.turnId)).toEqual([turn1, turn1, turn2]);
    expect(turnIndices(lines)).toEqual([1, 1, 2]);
    expect(lines[2]?.prompt).toBe("append c");
    expect(lines[2]?.at).toBeGreaterThan(0);
    expect(lines[0]?.line).toBe(1);
  });

  it("keeps a line's ORIGINAL turn when later edits leave it untouched", async () => {
    const store = createProvenanceStore(dir);
    const turn1 = await store.beginTurn("turn one");
    const v1 = ["alpha", "KEEPER", "gamma"].join("\n");
    await store.recordMutation("/repo/a.ts", null, v1);

    // Turn 2 rewrites the line above KEEPER and deletes the one below it.
    const turn2 = await store.beginTurn("turn two");
    const v2 = ["ALPHA-2", "KEEPER"].join("\n");
    await store.recordMutation("/repo/a.ts", v1, v2);

    // Turn 3 inserts on both sides of KEEPER.
    const turn3 = await store.beginTurn("turn three");
    const v3 = ["header", "ALPHA-2", "KEEPER", "footer"].join("\n");
    await store.recordMutation("/repo/a.ts", v2, v3);

    // Turn 4 rewrites everything except KEEPER and footer.
    const turn4 = await store.beginTurn("turn four");
    const v4 = ["HEADER-4", "alpha-4", "KEEPER", "footer", "tail-4"].join("\n");
    await store.recordMutation("/repo/a.ts", v3, v4);
    await store.close();

    const lines = await store.blame("/repo/a.ts");
    expect(texts(lines)).toEqual(["HEADER-4", "alpha-4", "KEEPER", "footer", "tail-4"]);
    // The core property: three later turns swept over this file and KEEPER
    // still belongs to turn 1, not to whoever edited around it.
    expect(lineFor(lines, "KEEPER").turnId).toBe(turn1);
    expect(lineFor(lines, "KEEPER").turnIndex).toBe(1);
    expect(lineFor(lines, "KEEPER").prompt).toBe("turn one");
    // Same for a line introduced mid-history and then edited around.
    expect(lineFor(lines, "footer").turnId).toBe(turn3);
    expect(lines.every((line) => line.text !== "ALPHA-2")).toBe(true);
    expect(lineFor(lines, "HEADER-4").turnId).toBe(turn4);
    expect(lineFor(lines, "alpha-4").turnId).toBe(turn4);
    expect(lineFor(lines, "tail-4").turnId).toBe(turn4);
    expect(turn2).not.toBe(turn1);
    // Every line turn 2 wrote is gone, so turn 2 owns nothing any more.
    expect(lines.some((line) => line.turnId === turn2)).toBe(false);
  });

  it("does not re-attribute a line that is deleted and later re-added", async () => {
    const store = createProvenanceStore(dir);
    const turn1 = await store.beginTurn("one");
    await store.recordMutation("/repo/a.ts", null, "x\ny");
    const turn2 = await store.beginTurn("two");
    await store.recordMutation("/repo/a.ts", "x\ny", "x");
    const turn3 = await store.beginTurn("three");
    await store.recordMutation("/repo/a.ts", "x", "x\ny");
    await store.close();

    const lines = await store.blame("/repo/a.ts");
    expect(lineFor(lines, "x").turnId).toBe(turn1);
    // `y` is textually identical to turn 1's line but was re-typed in turn 3;
    // provenance credits the turn that actually wrote it back.
    expect(lineFor(lines, "y").turnId).toBe(turn3);
    expect(turn2).not.toBe(turn3);
  });

  it("attributes pre-existing lines to nobody", async () => {
    const store = createProvenanceStore(dir);
    const turn1 = await store.beginTurn("edit a human-written file");
    const original = ["// written by a human", "export const x = 1;", "// trailing note"].join(
      "\n",
    );
    const edited = ["// written by a human", "export const x = 2;", "// trailing note"].join("\n");
    await store.recordMutation("/repo/a.ts", original, edited);
    await store.close();

    const lines = await store.blame("/repo/a.ts");
    expect(lines[0]?.turnId).toBeUndefined();
    expect(lines[0]?.prompt).toBeUndefined();
    expect(lines[0]?.turnIndex).toBeUndefined();
    expect(lines[0]?.at).toBeUndefined();
    expect(lines[1]?.turnId).toBe(turn1);
    expect(lines[2]?.turnId).toBeUndefined();
    expect(turnIndices(lines)).toEqual([null, 1, null]);
  });

  it("credits the recreating turn for a file written, deleted, then recreated", async () => {
    const store = createProvenanceStore(dir);
    const turn1 = await store.beginTurn("write it");
    await store.recordMutation("/repo/a.ts", null, "alpha\nbeta");

    // The file is removed outside the agent's write tools (e.g. `rm`), then
    // written again with content that happens to share a line.
    const turn2 = await store.beginTurn("recreate it");
    await store.recordMutation("/repo/a.ts", null, "alpha\ngamma");
    await store.close();

    const lines = await store.blame("/repo/a.ts");
    expect(texts(lines)).toEqual(["alpha", "gamma"]);
    // Nothing survived the deletion, so every line belongs to turn 2 — the
    // pre-image of `null` overrides the replayed state.
    expect(lines.map((line) => line.turnId)).toEqual([turn2, turn2]);
    expect(turn1).not.toBe(turn2);
  });

  it("resyncs when the pre-image disagrees with the replayed state", async () => {
    const store = createProvenanceStore(dir);
    const turn1 = await store.beginTurn("one");
    await store.recordMutation("/repo/a.ts", null, "a\nb");
    // Someone edited the file outside the agent: the next pre-image contains a
    // line the store never saw written.
    const turn2 = await store.beginTurn("two");
    await store.recordMutation("/repo/a.ts", "a\nb\nHUMAN", "a\nb\nHUMAN\nc");
    await store.close();

    const lines = await store.blame("/repo/a.ts");
    expect(texts(lines)).toEqual(["a", "b", "HUMAN", "c"]);
    // Resyncing to the recorded pre-image means the whole pre-image is
    // unattributed — including `a`/`b`, whose turn-1 attribution cannot be
    // trusted once an unobserved edit intervened.
    expect(turnIndices(lines)).toEqual([null, null, null, 2]);
    expect(lines[3]?.turnId).toBe(turn2);
    expect(turn1).not.toBe(turn2);
  });

  it("blames only the requested path", async () => {
    const store = createProvenanceStore(dir);
    await store.beginTurn("two files");
    await store.recordMutation("/repo/a.ts", null, "in a");
    await store.recordMutation("/repo/b.ts", null, "in b");
    await store.close();

    expect(texts(await store.blame("/repo/a.ts"))).toEqual(["in a"]);
    expect(texts(await store.blame("/repo/b.ts"))).toEqual(["in b"]);
    expect(await store.blame("/repo/c.ts")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                 */
/* -------------------------------------------------------------------------- */

describe("concurrent writes", () => {
  it("never interleaves concurrent recordMutation calls into a torn manifest", async () => {
    const store = createProvenanceStore(dir);
    await store.beginTurn("burst");

    const count = 40;
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < count; i++) {
      // Deliberately not awaited one at a time: every call races the others.
      writes.push(store.recordMutation(`/repo/f${i}.ts`, null, `line ${i}\ncontent ${i}`));
      writes.push(store.recordEvidence("read", `/repo/f${i}.ts`, false));
    }
    await Promise.all(writes);
    await store.close();

    // Every line must be whole, parseable JSON — a torn write would throw here.
    const entries = await manifest();
    expect(entries).toHaveLength(count * 2 + 1);
    const mutations = entries.filter((entry) => entry.kind === "mutation");
    expect(mutations).toHaveLength(count);
    expect(new Set(mutations.map((entry) => entry.path)).size).toBe(count);

    // And each file's content survived intact.
    for (let i = 0; i < count; i++) {
      const lines = await store.blame(`/repo/f${i}.ts`);
      expect(texts(lines)).toEqual([`line ${i}`, `content ${i}`]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Diff helpers                                                                */
/* -------------------------------------------------------------------------- */

describe("diffLineOps", () => {
  it("reports equal, add and del with the indices of each side", () => {
    expect(diffLineOps(["a", "b"], ["a", "c", "b"])).toEqual([
      { type: "equal", oldIndex: 0, newIndex: 0 },
      { type: "add", newIndex: 1 },
      { type: "equal", oldIndex: 1, newIndex: 2 },
    ]);
    expect(diffLineOps(["a"], [])).toEqual([{ type: "del", oldIndex: 0 }]);
    expect(diffLineOps([], ["a"])).toEqual([{ type: "add", newIndex: 0 }]);
    expect(diffLineOps([], [])).toEqual([]);
  });
});

describe("reconstructBefore", () => {
  it("rebuilds the pre-image from the post-image and a unified diff", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 12", "LINE TWELVE").replace("line 25", "");
    const diff = createUnifiedDiff("a.ts", before, after);

    expect(reconstructBefore(after, diff)).toBe(before);
  });

  it("returns undefined for text that is not a unified diff", () => {
    expect(reconstructBefore("x\n", "not a diff")).toBeUndefined();
    expect(reconstructBefore("x\n", "")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Observer                                                                    */
/* -------------------------------------------------------------------------- */

function userPrompt(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function toolResult(
  toolName: string,
  details: Record<string, unknown>,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName,
    content: [{ type: "text", text: "ok" }],
    isError,
    details,
    timestamp: 1,
  };
}

/** Drive the observer with a whole write/edit tool call. */
function callEvents(
  toolName: string,
  input: Record<string, unknown>,
  details: Record<string, unknown>,
  toolCallId = "call-1",
  isError = false,
): AgentEvent[] {
  return [
    { type: "toolStart", toolCallId, toolName, input },
    {
      type: "toolEnd",
      toolCallId,
      result: { ...toolResult(toolName, details, isError), toolCallId },
    },
  ];
}

describe("provenanceObserver", () => {
  let store: ProvenanceStore;
  const disk = new Map<string, string>();

  beforeEach(() => {
    disk.clear();
    store = createProvenanceStore(dir);
  });

  const read = async (path: string): Promise<string | null> => disk.get(path) ?? null;

  it("turns a write/edit/fetch event stream into turns, evidence and mutations", async () => {
    const observe = provenanceObserver(store, read);

    observe({ type: "runStart", sessionId: "s1", prompt: userPrompt("add a greeting") });

    // The agent consults a doc page first, then writes a file.
    for (const event of callEvents(
      "fetch",
      { url: "https://docs.test/greeting" },
      {},
      "call-fetch",
    )) {
      observe(event);
    }
    disk.set("/repo/g.ts", "hello\nworld");
    for (const event of callEvents(
      "write",
      { path: "g.ts", content: "hello\nworld" },
      { path: "/repo/g.ts", created: true, bytes: 11 },
      "call-write",
    )) {
      observe(event);
    }
    await observe.flush();

    const summaries = await store.turns();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      prompt: "add a greeting",
      evidenceCount: 1,
      untrustedCount: 1,
      mutationCount: 1,
    });

    const evidence = await store.evidence();
    expect(evidence[0]).toMatchObject({
      toolName: "fetch",
      subject: "https://docs.test/greeting",
      untrusted: true,
    });

    const lines = await store.blame("/repo/g.ts");
    expect(texts(lines)).toEqual(["hello", "world"]);
    expect(lines[0]?.prompt).toBe("add a greeting");
  });

  it("derives an edit's pre-image from the reported diff, so nothing pre-existing is claimed", async () => {
    const observe = provenanceObserver(store, read);
    const original = ["// human header", "const value = 1;", "// human footer"].join("\n");
    const edited = ["// human header", "const value = 2;", "// human footer"].join("\n");
    disk.set("/repo/e.ts", edited);

    observe({ type: "runStart", sessionId: "s1", prompt: userPrompt("bump the value") });
    for (const event of callEvents(
      "edit",
      { path: "e.ts", oldText: "1", newText: "2" },
      {
        path: "/repo/e.ts",
        replacements: 1,
        diff: createUnifiedDiff("e.ts", original, edited),
      },
      "call-edit",
    )) {
      observe(event);
    }
    await observe.flush();

    const lines = await store.blame("/repo/e.ts");
    expect(turnIndices(lines)).toEqual([null, 1, null]);
    expect(lines[1]?.prompt).toBe("bump the value");
  });

  it("records nothing for a failed tool call", async () => {
    const observe = provenanceObserver(store, read);
    observe({ type: "runStart", sessionId: "s1", prompt: userPrompt("try it") });
    disk.set("/repo/x.ts", "written anyway");
    for (const event of callEvents(
      "write",
      { path: "x.ts" },
      { path: "/repo/x.ts", created: true, bytes: 1 },
      "call-fail",
      true,
    )) {
      observe(event);
    }
    for (const event of callEvents("read", { path: "y.ts" }, {}, "call-read-fail", true)) {
      observe(event);
    }
    await observe.flush();

    expect(await store.blame("/repo/x.ts")).toEqual([]);
    expect(await store.evidence()).toEqual([]);
  });

  it("chains successive edits so attribution carries across turns", async () => {
    const observe = provenanceObserver(store, read);

    observe({ type: "runStart", sessionId: "s1", prompt: userPrompt("first prompt") });
    disk.set("/repo/c.ts", "one\ntwo");
    for (const event of callEvents(
      "write",
      { path: "c.ts" },
      { path: "/repo/c.ts", created: true, bytes: 7 },
      "w1",
    )) {
      observe(event);
    }

    observe({ type: "runStart", sessionId: "s1", prompt: userPrompt("second prompt") });
    const previous = "one\ntwo";
    const next = "one\ntwo\nthree";
    disk.set("/repo/c.ts", next);
    for (const event of callEvents(
      "edit",
      { path: "c.ts" },
      { path: "/repo/c.ts", replacements: 1, diff: createUnifiedDiff("c.ts", previous, next) },
      "e1",
    )) {
      observe(event);
    }
    await observe.flush();

    const lines = await store.blame("/repo/c.ts");
    expect(lines.map((line) => line.prompt)).toEqual([
      "first prompt",
      "first prompt",
      "second prompt",
    ]);
  });

  it("captures each write's post-image at its own toolEnd, not when the queue drains", async () => {
    const observe = provenanceObserver(store, read);

    // Two writes to the SAME path with no await in between — exactly what a
    // burst of synchronously delivered events looks like. If the post-image
    // were read lazily (when the queue got around to it) both records would
    // capture the second write's content and turn 1 would be credited with
    // turn 2's line.
    observe({ type: "runStart", sessionId: "s1", prompt: userPrompt("first prompt") });
    disk.set("/repo/r.ts", "a");
    for (const event of callEvents(
      "write",
      { path: "r.ts" },
      { path: "/repo/r.ts", created: true, bytes: 1 },
      "w1",
    )) {
      observe(event);
    }

    observe({ type: "runStart", sessionId: "s1", prompt: userPrompt("second prompt") });
    disk.set("/repo/r.ts", "a\nb");
    for (const event of callEvents(
      "write",
      { path: "r.ts" },
      { path: "/repo/r.ts", created: false, bytes: 3 },
      "w2",
    )) {
      observe(event);
    }
    await observe.flush();

    const lines = await store.blame("/repo/r.ts");
    expect(texts(lines)).toEqual(["a", "b"]);
    expect(lines.map((line) => line.prompt)).toEqual(["first prompt", "second prompt"]);
  });

  it("marks MCP output untrusted and ordinary reads trusted", () => {
    expect(isUntrustedEvidenceSource("fetch")).toBe(true);
    expect(isUntrustedEvidenceSource("websearch")).toBe(true);
    expect(isUntrustedEvidenceSource("mcp__notion__search")).toBe(true);
    expect(isUntrustedEvidenceSource("read")).toBe(false);
    expect(isUntrustedEvidenceSource("bash")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

describe("formatBlame", () => {
  const lines: BlameLine[] = [
    { line: 1, text: "// pre-existing" },
    {
      line: 2,
      text: "const x = 1",
      turnId: "t3",
      turnIndex: 3,
      prompt: "fix the session bug",
      at: 5,
    },
    {
      line: 3,
      text: "const y = 2",
      turnId: "t3",
      turnIndex: 3,
      prompt: "fix the session bug",
      at: 5,
    },
    { line: 4, text: "const z = 3", turnId: "t1", turnIndex: 1, prompt: "scaffold", at: 1 },
  ];

  const evidence: ProvenanceEvidenceRecord[] = [
    {
      kind: "evidence",
      turnId: "t1",
      toolName: "read",
      subject: "/repo/src/a.ts",
      untrusted: false,
      timestamp: 1,
    },
    {
      kind: "evidence",
      turnId: "t3",
      toolName: "fetch",
      subject: "https://evil.test/docs",
      untrusted: true,
      timestamp: 2,
    },
  ];

  it("prints line, turn, prompt and text per row", () => {
    const out = formatBlame(lines);
    expect(out).toHaveLength(4);
    expect(out[1]).toBe('2  turn 3  "fix the session bug"  const x = 1');
    // Pre-existing lines show `-` in both attribution columns, aligned with
    // the rows around them.
    expect(out[0]).toBe("1  -       -                      // pre-existing");
    expect(out[3]).toBe('4  turn 1  "scaffold"             const z = 3');
  });

  it("groups by turn in summary mode, newest first", () => {
    const out = formatBlame(lines, { summary: true, path: "/repo/src/a.ts" });
    expect(out[0]).toBe("/repo/src/a.ts");
    expect(out[1]).toContain("turn 3");
    expect(out[1]).toContain('"fix the session bug"');
    expect(out[1]).toContain("2 lines");
    expect(out[2]).toContain("turn 1");
    expect(out[2]).toContain("1 line");
    expect(out[3]).toContain("(pre-existing)");
    expect(out[3]).toContain("1 line");
  });

  it("appends an evidence footer that marks untrusted sources distinctly", () => {
    const out = formatBlame(lines, { summary: true, evidence });
    const footer = out.join("\n");
    expect(footer).toContain("Evidence");
    expect(footer).toContain("    read  /repo/src/a.ts");
    expect(footer).toContain("  ! fetch  https://evil.test/docs  [untrusted]");
    // The trusted row must NOT be marked.
    expect(footer).not.toContain("read  /repo/src/a.ts  [untrusted]");
    expect(footer).toContain("1 untrusted source informed the turns above");
  });

  it("omits the footer's untrusted warning when no untrusted source is involved", () => {
    const onlyTurn1 = lines.filter((line) => line.turnIndex === 1);
    const footer = formatBlame(onlyTurn1, { evidence }).join("\n");
    expect(footer).toContain("Evidence");
    expect(footer).toContain("read  /repo/src/a.ts");
    expect(footer).not.toContain("[untrusted]");
  });

  it("says so when there is nothing to blame", () => {
    expect(formatBlame([])).toEqual(["no provenance recorded for this file"]);
  });

  it("renders a real store's blame end to end", async () => {
    const store = createProvenanceStore(dir);
    await store.beginTurn("scaffold the module");
    await store.recordEvidence("websearch", "esm exports", true);
    await store.recordMutation("/repo/m.ts", null, "export const m = 1;");
    await store.close();

    const out = formatBlame(await store.blame("/repo/m.ts"), {
      evidence: await store.evidence(),
    });
    expect(out[0]).toBe('1  turn 1  "scaffold the module"  export const m = 1;');
    expect(out.join("\n")).toContain("! websearch  esm exports  [untrusted]");
  });
});
