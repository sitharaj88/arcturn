import { describe, expect, it } from "vitest";
import type { PendingChange, PendingChanges } from "../serve/engine.js";
import {
  confirmsDiscard,
  DISCARD_CHANGES,
  describeDiscard,
  diffTitle,
  formatBytes,
  pendingDocumentPath,
  projectPendingChange,
  toDryRunView,
} from "./dry-run.js";

function change(overrides: Partial<PendingChange> = {}): PendingChange {
  return {
    path: "src/app.ts",
    absolutePath: "/repo/src/app.ts",
    kind: "modified",
    bytes: 2048,
    previousBytes: 1024,
    ...overrides,
  };
}

function answer(overrides: Partial<PendingChanges> = {}): PendingChanges {
  return {
    sessionId: "s1",
    dryRun: true,
    changes: [change()],
    truncated: false,
    droppedChanges: 0,
    ...overrides,
  };
}

describe("projecting a pending change", () => {
  it("keeps the engine's path as identity and escapes only what is rendered", () => {
    const row = projectPendingChange(change({ path: "src/$(verified) ok.ts" }));
    // `path` goes back to the engine as a selection, so it must be untouched.
    expect(row.path).toBe("src/$(verified) ok.ts");
    // `label` reaches a notification and a quick-pick, where VS Code expands
    // `$(name)` into a glyph. A file cannot award itself a badge.
    expect(row.label).toBe("src/\\$(verified) ok.ts");
  });

  it("says what the change does to the file's size", () => {
    expect(projectPendingChange(change()).detail).toBe("1.0 kB → 2.0 kB");
    expect(projectPendingChange(change({ kind: "added", previousBytes: 0 })).detail).toBe(
      "new file · 2.0 kB",
    );
  });
});

describe("formatBytes", () => {
  it("uses the units a file listing uses", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("refuses to invent a size for a number that is not one", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown size");
    expect(formatBytes(-1)).toBe("unknown size");
  });
});

describe("what the engine's answer means", () => {
  it("keeps 'no verb', 'not in dry-run mode' and 'nothing pending' apart", () => {
    // Three different pieces of news, three different states. Collapsing any
    // two of them tells somebody the reassuring one for the other.
    expect(toDryRunView(undefined).status).toBe("unavailable");
    expect(toDryRunView(answer({ dryRun: false, changes: [] })).status).toBe("off");
    const empty = toDryRunView(answer({ changes: [] }));
    expect(empty.status).toBe("ready");
    expect(empty.changes).toEqual([]);
  });

  it("carries the truncation flag through", () => {
    expect(toDryRunView(answer({ truncated: true, droppedChanges: 5 })).truncated).toBe(true);
  });
});

describe("the discard confirmation", () => {
  const rows = [change({ path: "a.ts" }), change({ path: "b.ts" })].map(projectPendingChange);

  it("names the files, not just a number", () => {
    const prompt = describeDiscard(rows);
    expect(prompt.message).toBe("Discard 2 pending file changes?");
    expect(prompt.detail).toContain("a.ts");
    expect(prompt.detail).toContain("b.ts");
    expect(prompt.detail).toMatch(/cannot be recovered/);
  });

  it("stops naming files before the modal stops being readable", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      projectPendingChange(change({ path: `file-${String(index)}.ts` })),
    );
    const prompt = describeDiscard(many);
    expect(prompt.message).toBe("Discard 20 pending file changes?");
    expect(prompt.detail).toContain("and 12 more");
  });

  it("treats everything that is not the confirm button as a refusal", () => {
    const prompt = describeDiscard(rows);
    expect(confirmsDiscard(DISCARD_CHANGES, prompt)).toBe(true);
    // A dismissed modal, VS Code's own Cancel, and a label from somewhere else
    // all mean keep them. "No answer" is never consent for a destructive act.
    expect(confirmsDiscard(undefined, prompt)).toBe(false);
    expect(confirmsDiscard("Cancel", prompt)).toBe(false);
    expect(confirmsDiscard("Apply", prompt)).toBe(false);
  });
});

describe("the diff editor's identity", () => {
  it("ends the virtual document in the real basename, so the tab reads right", () => {
    expect(pendingDocumentPath("src/app.ts")).toBe("/src/app.ts");
    expect(pendingDocumentPath("/src/app.ts")).toBe("/src/app.ts");
  });

  it("says which half of the diff is which", () => {
    expect(diffTitle(projectPendingChange(change()))).toBe("src/app.ts (workspace ↔ pending)");
    expect(diffTitle(projectPendingChange(change({ kind: "added" })))).toBe(
      "src/app.ts (new file — pending)",
    );
  });
});
