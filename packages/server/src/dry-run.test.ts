/**
 * `dry-run.ts` in isolation: the projection, the caps and the refusals, over a
 * fake overlay. The filesystem behaviour these verbs actually produce is
 * asserted against a real overlay and a real server in `@arcturn/cli`'s
 * `dry-run-wire.test.ts` — this file is about the payload contract.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDryRunReview,
  type DryRunApplyOutcome,
  type DryRunChange,
  type DryRunOverlay,
} from "./dry-run.js";

// Resolved, not spelled. "/repo" is an absolute path on POSIX and a
// drive-relative one on Windows, where the engine resolves it to D:\repo — so
// a fixture written as a literal asserts one platform's punctuation rather
// than the behaviour. Every fixture path is built from this root, and the
// assertions compare against the same construction.
const CWD = resolve("/repo");
const at = (relative: string): string => join(CWD, relative);

interface FakeOverlay extends DryRunOverlay {
  readonly appliedWith: (readonly string[] | undefined)[];
  readonly discardedWith: (readonly string[] | undefined)[];
}

function fakeOverlay(
  changes: DryRunChange[],
  outcome?: (paths: readonly string[] | undefined) => DryRunApplyOutcome,
): FakeOverlay {
  const appliedWith: (readonly string[] | undefined)[] = [];
  const discardedWith: (readonly string[] | undefined)[] = [];
  let pending = [...changes];
  return {
    cwd: CWD,
    appliedWith,
    discardedWith,
    changes: () => Promise.resolve([...pending]),
    apply(paths) {
      appliedWith.push(paths);
      const result = outcome?.(paths) ?? {
        applied: (paths ?? pending.map((change) => change.path)) as string[],
        errors: [],
      };
      pending = pending.filter((change) => !result.applied.includes(change.path));
      return Promise.resolve(result);
    },
    discard(paths) {
      discardedWith.push(paths);
      pending = paths === undefined ? [] : pending.filter((c) => !paths.includes(c.path));
      return Promise.resolve();
    },
  };
}

function change(path: string, after: string, before: string | null = ""): DryRunChange {
  return { path, kind: before === null ? "added" : "modified", before, after };
}

describe("pendingChanges", () => {
  it("says dryRun: false for an engine with no overlay, rather than an empty list", async () => {
    const review = createDryRunReview(undefined);
    const result = await review.pendingChanges("s1");
    expect(result).toEqual({
      ok: true,
      value: {
        sessionId: "s1",
        dryRun: false,
        changes: [],
        truncated: false,
        droppedChanges: 0,
      },
    });
  });

  it("lists metadata only, sorted by path, with the sizes on both sides", async () => {
    const review = createDryRunReview(
      fakeOverlay([
        change(at("src/b.ts"), "bb"),
        change(at("a.ts"), "aaaa", null),
        change(at("src/a.ts"), "a", "xyz"),
      ]),
    );
    const result = await review.pendingChanges("s1");
    if (!result.ok) throw new Error(result.error);
    expect(result.value.changes.map((row) => row.path)).toEqual(["a.ts", "src/a.ts", "src/b.ts"]);
    expect(result.value.changes[0]).toEqual({
      path: "a.ts",
      absolutePath: at("a.ts"),
      kind: "added",
      bytes: 4,
      previousBytes: 0,
    });
    // The payload bound, asserted: no content in the list, at any size.
    for (const row of result.value.changes) expect(row.after).toBeUndefined();
  });

  it("carries the content for a single-file fetch", async () => {
    const review = createDryRunReview(fakeOverlay([change(at("src/a.ts"), "new text")]));
    const result = await review.pendingChanges("s1", "src/a.ts");
    if (!result.ok) throw new Error(result.error);
    expect(result.value.changes[0]?.after).toBe("new text");
  });

  it("withholds the content of an oversized file rather than truncating it", async () => {
    const review = createDryRunReview(fakeOverlay([change(at("big.ts"), "x".repeat(200))]), {
      maxBytes: 100,
    });
    const result = await review.pendingChanges("s1", "big.ts");
    if (!result.ok) throw new Error(result.error);
    // Half a file rendered in a diff editor is a false account of the change,
    // and a reviewer would approve it. So it is withheld and said to be.
    expect(result.value.changes[0]?.after).toBeUndefined();
    expect(result.value.changes[0]?.contentOmitted).toBe(true);
    expect(result.value.changes[0]?.bytes).toBe(200);
  });

  it("caps the row count and reports how many were dropped", async () => {
    const review = createDryRunReview(
      fakeOverlay(["a", "b", "c", "d"].map((name) => change(`/repo/${name}.ts`, name))),
      { maxFiles: 2 },
    );
    const result = await review.pendingChanges("s1");
    if (!result.ok) throw new Error(result.error);
    expect(result.value.changes).toHaveLength(2);
    expect(result.value.truncated).toBe(true);
    expect(result.value.droppedChanges).toBe(2);
  });

  it("refuses a fetch for a path nothing is pending under", async () => {
    const review = createDryRunReview(fakeOverlay([change(at("a.ts"), "a")]));
    const result = await review.pendingChanges("s1", "b.ts");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("No pending change") });
  });
});

describe("applyChanges", () => {
  it("hands the overlay the engine's own absolute paths, never the client's strings", async () => {
    const overlay = fakeOverlay([change(at("src/a.ts"), "a")]);
    const review = createDryRunReview(overlay);
    const result = await review.applyChanges("s1", ["src/a.ts"]);
    if (!result.ok) throw new Error(result.error);
    expect(overlay.appliedWith[0]).toEqual([at("src/a.ts")]);
    expect(result.value.applied).toEqual(["src/a.ts"]);
    expect(result.value.remaining).toBe(0);
  });

  it("refuses the whole request when one named path is not pending", async () => {
    const overlay = fakeOverlay([change(at("a.ts"), "a")]);
    const review = createDryRunReview(overlay);
    const result = await review.applyChanges("s1", ["a.ts", "../../etc/passwd"]);
    expect(result.ok).toBe(false);
    // Not "applied the one it recognised": nothing reached the overlay at all.
    expect(overlay.appliedWith).toEqual([]);
  });

  it("empties the shadow tree after a clean full apply, and not after a partial one", async () => {
    const clean = fakeOverlay([change(at("a.ts"), "a"), change(at("b.ts"), "b")]);
    await createDryRunReview(clean).applyChanges("s1");
    expect(clean.discardedWith).toEqual([undefined]);

    const partial = fakeOverlay([change(at("a.ts"), "a"), change(at("b.ts"), "b")]);
    await createDryRunReview(partial).applyChanges("s1", ["a.ts"]);
    // The copies that did NOT land are the pending changes; deleting them
    // would be a discard nobody asked for.
    expect(partial.discardedWith).toEqual([]);

    const failing = fakeOverlay([change(at("a.ts"), "a")], () => ({
      applied: [],
      errors: [{ path: at("a.ts"), message: "resolves outside the workspace (symlink); refused" }],
    }));
    const result = await createDryRunReview(failing).applyChanges("s1");
    if (!result.ok) throw new Error(result.error);
    expect(failing.discardedWith).toEqual([]);
    expect(result.value.failed).toEqual([
      { path: "a.ts", message: "resolves outside the workspace (symlink); refused" },
    ]);
  });

  it("refuses on an engine that is not in dry-run mode", async () => {
    const review = createDryRunReview(undefined);
    await expect(review.applyChanges("s1")).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("not running under --dry-run"),
    });
    await expect(review.discardChanges("s1")).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("not running under --dry-run"),
    });
  });
});

describe("discardChanges", () => {
  it("passes the whole tree through when nothing is selected", async () => {
    const overlay = fakeOverlay([change(at("a.ts"), "a")]);
    const result = await createDryRunReview(overlay).discardChanges("s1");
    if (!result.ok) throw new Error(result.error);
    expect(overlay.discardedWith).toEqual([undefined]);
    expect(result.value.discarded).toEqual(["a.ts"]);
    expect(result.value.remaining).toBe(0);
  });

  it("acts on a repeated selection exactly once", async () => {
    const overlay = fakeOverlay([change(at("a.ts"), "a")]);
    const result = await createDryRunReview(overlay).discardChanges("s1", ["a.ts", "a.ts"]);
    if (!result.ok) throw new Error(result.error);
    expect(overlay.discardedWith).toEqual([[at("a.ts")]]);
    expect(result.value.discarded).toEqual(["a.ts"]);
  });
});
