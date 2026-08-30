/**
 * Fault-injection tests for {@link JsonlSessionStore}'s two write hazards.
 *
 * Both are races against something outside this process — a second writer
 * finishing its line, or Windows letting go of a file handle — so neither can
 * be provoked by ordinary test code without a sleep and a prayer. `fs` is
 * mocked here instead, which makes the interleaving exact: the "other
 * process" acts at a named point in our own call sequence, every run.
 *
 * `node:fs/promises` is mocked for this whole file, which is why these live
 * apart from `jsonl-store.test.ts`.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, SessionEntry } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userMessage } from "../util/content.js";

/**
 * Hooks the mocked `fs` fires. Built through `vi.hoisted` because the mock
 * factory is hoisted above every import and would otherwise read this before
 * it exists.
 */
const faults = vi.hoisted(() => ({
  /** Runs just before the store opens its repair handle (`r+`). */
  beforeRepairOpen: undefined as (() => Promise<void>) | undefined,
  /** Error codes the next `rename` calls should fail with, in order. */
  renameFailures: [] as string[],
  /** How many renames were attempted. */
  renameAttempts: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(path: string, flags?: string | number, mode?: number) {
      if (flags === "r+" && faults.beforeRepairOpen) await faults.beforeRepairOpen();
      return actual.open(path, flags, mode);
    },
    async rename(from: string, to: string) {
      faults.renameAttempts++;
      const code = faults.renameFailures.shift();
      if (code !== undefined) {
        const error: NodeJS.ErrnoException = new Error(`${code}: injected, rename '${from}'`);
        error.code = code;
        throw error;
      }
      return actual.rename(from, to);
    },
  };
});

const { JsonlSessionStore } = await import("./jsonl-store.js");

function entry(id: string, parentId: string | null, message: Message): SessionEntry {
  return { kind: "message", id, parentId, timestamp: Date.now(), message };
}

let dir: string;
let store: InstanceType<typeof JsonlSessionStore>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcturn-store-faults-"));
  store = new JsonlSessionStore({ dir });
  faults.beforeRepairOpen = undefined;
  faults.renameFailures = [];
  faults.renameAttempts = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("a torn tail that belongs to a writer who is still alive", () => {
  it("is not truncated away when the writer finishes mid-repair", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    await store.append("s1", entry("a", null, userMessage("root")));
    const path = join(dir, "s1.jsonl");

    // A second process is part-way through writing an entry: half its line is
    // on disk, so this store sees a tail that does not end in a newline.
    const line = `${JSON.stringify(entry("live", "a", userMessage("mid-write")))}\n`;
    const cut = Math.floor(line.length / 2);
    const raw = await import("node:fs/promises");
    await raw.appendFile(path, line.slice(0, cut));

    // ...and it finishes at the worst possible moment: after this store has
    // decided the tail is torn, and before it truncates. The old code dropped
    // a complete, already-acknowledged entry here — silently, with the other
    // writer's own append resolved and nothing in the file to show for it.
    faults.beforeRepairOpen = async () => {
      faults.beforeRepairOpen = undefined;
      await raw.appendFile(path, line.slice(cut));
    };

    await store.append("s1", entry("c", "live", userMessage("after")));

    expect((await store.entries("s1")).map((e) => e.id)).toEqual(["a", "live", "c"]);
  });

  it("still repairs a tail that nobody is writing to", async () => {
    // The other half of the contract: with no live writer, the torn bytes are
    // dead and dropping them is what keeps the session appendable.
    const warnings: { kind: string; bytes: number }[] = [];
    const watched = new JsonlSessionStore({ dir, onWarning: (w) => warnings.push(w) });
    await watched.create({ sessionId: "s1", cwd: "/work" });
    await watched.append("s1", entry("a", null, userMessage("root")));
    const raw = await import("node:fs/promises");
    await raw.appendFile(join(dir, "s1.jsonl"), '{"id":"b","parentId":"a","kind":"messa');

    await watched.append("s1", entry("c", "a", userMessage("after the crash")));

    expect((await watched.entries("s1")).map((e) => e.id)).toEqual(["a", "c"]);
    expect(warnings).toMatchObject([{ kind: "tornTailRepaired" }]);
    expect(warnings[0]?.bytes).toBe(38);
  });
});

describe("a header rewrite on a filesystem that refuses the first rename", () => {
  it("lands the title anyway when Windows releases the handle", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    await store.append("s1", entry("a", null, userMessage("root")));
    // What an antivirus scanner or the search indexer holding the session
    // file open looks like from here: MoveFileExW refuses, then stops
    // refusing. Every code libuv reports for it is retried.
    faults.renameFailures = ["EPERM", "EACCES", "EBUSY"];

    await store.setTitle("s1", "Fixing the login bug");

    expect(faults.renameAttempts).toBe(4);
    expect((await store.open("s1")).title).toBe("Fixing the login bug");
    // The rewrite is still a rewrite: the body has to survive it intact.
    expect((await store.entries("s1")).map((e) => e.id)).toEqual(["a"]);
  });

  it("reports a rename that never succeeds, and leaves no temp file behind", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    faults.renameFailures = Array.from({ length: 20 }, () => "EPERM");

    await expect(store.setTitle("s1", "never lands")).rejects.toMatchObject({ code: "EPERM" });

    // A swallowed failure here is how a Windows user's titles could quietly
    // never work; the store's job is to say so, not to pretend.
    expect((await store.open("s1")).title).toBeUndefined();
    expect(await readdir(dir)).toEqual(["s1.jsonl"]);
  });

  it("does not retry an error that is not a Windows sharing violation", async () => {
    await store.create({ sessionId: "s1", cwd: "/work" });
    faults.renameFailures = ["ENOSPC", "ENOSPC"];

    await expect(store.setTitle("s1", "no room")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(faults.renameAttempts).toBe(1);
  });
});

describe("append durability", () => {
  it("writes an entry larger than fs.appendFile's chunk size as one write", async () => {
    // fs.appendFile splits anything over kWriteFileMaxChunkSize (512 KiB)
    // into separate writes, and a second process's O_APPEND write can land in
    // the gap. Entries this big are ordinary — a large tool result, a pasted
    // file — so the store issues the write itself.
    await store.create({ sessionId: "s1", cwd: "/work" });
    const big = "x".repeat(700_000);
    await store.append("s1", entry("big", null, userMessage(big)));

    const entries = await store.entries("s1");
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).toContain(big.slice(0, 64));
  });

  it("does not create a session file for an append to one that is gone", async () => {
    // `open(path, "a")` would create it; the `access` guard is what stops a
    // headerless orphan appearing after a delete.
    await writeFile(join(dir, "keep.jsonl"), "");
    await expect(store.append("s1", entry("a", null, userMessage("x")))).rejects.toMatchObject({
      code: "notFound",
    });
    expect(await readdir(dir)).toEqual(["keep.jsonl"]);
  });
});
