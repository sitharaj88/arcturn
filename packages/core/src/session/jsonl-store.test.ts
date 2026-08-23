import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, SessionEntry } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userMessage } from "../util/content.js";
import { JsonlSessionStore, SessionStoreError } from "./jsonl-store.js";
import { MemorySessionStore } from "./memory-store.js";

function entry(id: string, parentId: string | null, message: Message): SessionEntry {
  return { kind: "message", id, parentId, timestamp: Date.now(), message };
}

describe("JsonlSessionStore", () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-core-session-"));
    store = new JsonlSessionStore({ dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a session with a header line and round-trips entries", async () => {
    const header = await store.create({ sessionId: "s1", cwd: "/work", title: "first" });
    expect(header).toMatchObject({ version: 1, sessionId: "s1", cwd: "/work", title: "first" });

    await store.append("s1", entry("a", null, userMessage("hello")));
    await store.append("s1", entry("b", "a", userMessage("world")));

    expect(await store.open("s1")).toMatchObject({ sessionId: "s1", title: "first" });
    const entries = await store.entries("s1");
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(entries[0]).toMatchObject({ kind: "message", parentId: null });

    const raw = await readFile(join(dir, "s1.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3);
    expect(JSON.parse(raw.split("\n")[0]!)).toMatchObject({ version: 1 });
  });

  it("survives a fresh store instance reading the same directory", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    await store.append("s1", entry("a", null, userMessage("hello")));

    const reopened = new JsonlSessionStore({ dir });
    expect((await reopened.entries("s1")).map((e) => e.id)).toEqual(["a"]);
  });

  it("rejects duplicate session ids", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    await expect(store.create({ sessionId: "s1", cwd: "/work" })).rejects.toMatchObject({
      code: "exists",
    });
  });

  it("reports missing sessions", async () => {
    await expect(store.open("nope")).rejects.toBeInstanceOf(SessionStoreError);
    await expect(store.entries("nope")).rejects.toMatchObject({ code: "notFound" });
    await expect(store.append("nope", entry("a", null, userMessage("x")))).rejects.toMatchObject({
      code: "notFound",
    });
  });

  it("rejects session ids that would escape the store directory", async () => {
    await expect(store.create({ sessionId: "../escape", cwd: "/work" })).rejects.toMatchObject({
      code: "invalidId",
    });
  });

  it("walks branches through parentId links", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    await store.append("s1", entry("a", null, userMessage("root")));
    await store.append("s1", entry("b", "a", userMessage("main-1")));
    await store.append("s1", entry("c", "b", userMessage("main-2")));
    // A branch off the first entry.
    await store.append("s1", entry("d", "a", userMessage("alt-1")));

    expect((await store.branch("s1", "c")).map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect((await store.branch("s1", "d")).map((e) => e.id)).toEqual(["a", "d"]);
    expect((await store.entries("s1")).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("serializes concurrent appends without interleaving", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.append("s1", entry(`e${i}`, i === 0 ? null : `e${i - 1}`, userMessage(`m${i}`))),
      ),
    );
    const entries = await store.entries("s1");
    expect(entries).toHaveLength(25);
    expect(new Set(entries.map((e) => e.id)).size).toBe(25);
  });

  it("lists sessions newest first and updates titles in place", async () => {
    await store.create({ sessionId: "old", cwd: "/work" });
    await store.append("old", entry("a", null, userMessage("hi")));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.create({ sessionId: "new", cwd: "/work" });

    expect((await store.list()).map((h) => h.sessionId)).toEqual(["new", "old"]);

    await store.setTitle("old", "renamed");
    expect((await store.open("old")).title).toBe("renamed");
    expect((await store.entries("old")).map((e) => e.id)).toEqual(["a"]);
  });

  it("reports corruption in the middle of a file", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "s1.jsonl"), "{not json}\n");
    // A later well-formed line means the bad one was not a torn write.
    await store.append("s1", entry("a", null, userMessage("root")));
    await expect(store.entries("s1")).rejects.toMatchObject({ code: "corrupt" });
  });

  it("recovers a session whose last line was torn by a crash", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    await store.append("s1", entry("a", null, userMessage("root")));
    await store.append("s1", entry("b", "a", userMessage("child")));
    const { appendFile } = await import("node:fs/promises");
    // A process killed mid-append leaves a half-written final entry.
    await appendFile(join(dir, "s1.jsonl"), '{"id":"c","parentId":"b","kind":"messa');

    const entries = await store.entries("s1");
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("MemorySessionStore", () => {
  it("behaves like the JSONL store for the core operations", async () => {
    const store = new MemorySessionStore();
    await store.create({ sessionId: "s1", cwd: "/work" });
    await store.append("s1", entry("a", null, userMessage("root")));
    await store.append("s1", entry("b", "a", userMessage("child")));

    expect((await store.entries("s1")).map((e) => e.id)).toEqual(["a", "b"]);
    expect((await store.branch("s1", "b")).map((e) => e.id)).toEqual(["a", "b"]);
    await store.setTitle("s1", "titled");
    expect((await store.open("s1")).title).toBe("titled");
    await expect(store.open("missing")).rejects.toMatchObject({ code: "notFound" });
  });
});
