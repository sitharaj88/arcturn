/**
 * Reconstructing two documents from a scout's patch.
 *
 * The patches here are real `git diff` output rather than hand-shaped strings,
 * because the failure modes worth catching are all in the shapes git actually
 * emits and a test author would not think to write: `/dev/null` on one side of
 * an add, a rename with no hunks at all, `\ No newline at end of file`
 * annotating a line rather than being one, and an empty context line git
 * writes with no leading space.
 *
 * The claim that matters most is the one about honesty. A file is rebuilt from
 * its hunks, and the parts no hunk described are *marked* rather than closed
 * over. Silently joining two distant hunks would render two functions as
 * neighbours when a hundred lines sit between them, and a reviewer comparing
 * approaches would be reading a document that never existed.
 */

import { describe, expect, it } from "vitest";
import {
  approachSummaryLine,
  ELIDED_MARKER,
  parseUnifiedDiff,
  type ScoutApproachSummary,
  touchedPaths,
} from "./patch.js";

const MODIFIED = `diff --git a/src/cart.ts b/src/cart.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,5 +1,6 @@
 export function total(items) {
-  return items.reduce((sum, item) => sum + item.price, 0);
+  const sum = items.reduce((acc, item) => acc + item.price, 0);
+  return Math.max(0, sum);
 }

 export const TAX = 0.2;
`;

const ADDED = `diff --git a/src/store.ts b/src/store.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/store.ts
@@ -0,0 +1,3 @@
+import { create } from "zustand";
+
+export const useStore = create(() => ({ items: [] }));
`;

const DELETED = `diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const OLD = true;
-export const OLDER = true;
`;

const RENAMED = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
`;

const TWO_HUNKS = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 import { boot } from "./boot";
-boot({ fast: false });
+boot({ fast: true });

@@ -120,3 +120,4 @@ export function shutdown() {
   close();
+  flush();
 }
`;

const NO_NEWLINE = `diff --git a/src/tail.ts b/src/tail.ts
index 1111111..2222222 100644
--- a/src/tail.ts
+++ b/src/tail.ts
@@ -1 +1 @@
-export const a = 1;
\\ No newline at end of file
+export const a = 2;
\\ No newline at end of file
`;

const BINARY = `diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

describe("reading a modified file", () => {
  const [file] = parseUnifiedDiff(MODIFIED);

  it("names the file and how it changed", () => {
    expect(file).toMatchObject({ path: "src/cart.ts", change: "modified" });
  });

  it("rebuilds the pre-image from context and removed lines", () => {
    expect(file?.before).toBe(
      [
        "export function total(items) {",
        "  return items.reduce((sum, item) => sum + item.price, 0);",
        "}",
        "",
        "export const TAX = 0.2;",
      ].join("\n"),
    );
  });

  it("rebuilds the post-image from context and added lines", () => {
    expect(file?.after).toBe(
      [
        "export function total(items) {",
        "  const sum = items.reduce((acc, item) => acc + item.price, 0);",
        "  return Math.max(0, sum);",
        "}",
        "",
        "export const TAX = 0.2;",
      ].join("\n"),
    );
  });

  it("counts what moved", () => {
    expect(file).toMatchObject({ added: 2, removed: 1 });
  });

  it("keeps an empty context line empty rather than dropping it", () => {
    // git writes a blank context line as "" with no leading space, so the
    // usual `slice(1)` would eat the line entirely and shift everything after.
    // One line became two, so the sides are 5 and 6 — and the blank line
    // survives on both, with the export still after it rather than shifted up
    // into its place.
    expect(file?.before.split("\n")).toHaveLength(5);
    expect(file?.after.split("\n")).toHaveLength(6);
    expect(file?.before.split("\n").at(-2)).toBe("");
    expect(file?.after.split("\n").at(-2)).toBe("");
    expect(file?.before.split("\n").at(-1)).toBe("export const TAX = 0.2;");
    expect(file?.after.split("\n").at(-1)).toBe("export const TAX = 0.2;");
  });
});

describe("reading the shapes git emits at the edges", () => {
  it("reads an added file, whose old side is /dev/null", () => {
    const [file] = parseUnifiedDiff(ADDED);
    expect(file).toMatchObject({ path: "src/store.ts", change: "added", before: "" });
    expect(file?.after).toContain("zustand");
  });

  it("reads a deleted file, whose new side is /dev/null", () => {
    const [file] = parseUnifiedDiff(DELETED);
    expect(file).toMatchObject({ path: "src/legacy.ts", change: "deleted", after: "" });
    expect(file?.removed).toBe(2);
  });

  it("reads a pure rename, which has no hunks at all", () => {
    const [file] = parseUnifiedDiff(RENAMED);
    expect(file).toMatchObject({
      change: "renamed",
      oldPath: "src/old-name.ts",
      path: "src/new-name.ts",
      added: 0,
      removed: 0,
    });
  });

  it("treats the no-newline marker as an annotation, not as a line", () => {
    const [file] = parseUnifiedDiff(NO_NEWLINE);
    expect(file?.before).toBe("export const a = 1;");
    expect(file?.after).toBe("export const a = 2;");
  });

  it("marks a binary file instead of rendering bytes as text", () => {
    const [file] = parseUnifiedDiff(BINARY);
    expect(file).toMatchObject({ path: "assets/logo.png", binary: true, before: "", after: "" });
  });

  it("skips what it cannot parse rather than throwing over it", () => {
    // The input is a subprocess's stdout. Fewer files shown is a far better
    // failure than an error dialog in place of a comparison.
    expect(() => parseUnifiedDiff("not a diff at all\n@@ garbage @@\n")).not.toThrow();
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("the parts of a file no hunk described", () => {
  const [file] = parseUnifiedDiff(TWO_HUNKS);

  it("marks the gap between distant hunks rather than closing it", () => {
    // Line 3 and line 120 are not neighbours. Joining them would render a
    // document that never existed, and a reviewer would read it as one.
    expect(file?.before).toContain(ELIDED_MARKER);
    expect(file?.after).toContain(ELIDED_MARKER);
  });

  it("says the reconstruction is partial, so the renderer can say so too", () => {
    expect(file?.partial).toBe(true);
  });

  it("does not claim partial when one hunk covers the file from line 1", () => {
    const [whole] = parseUnifiedDiff(MODIFIED);
    expect(whole?.partial).toBe(false);
    expect(whole?.before).not.toContain(ELIDED_MARKER);
  });
});

describe("summarising an approach", () => {
  const approach = (over: Partial<ScoutApproachSummary>): ScoutApproachSummary => ({
    name: "zustand",
    task: "use zustand",
    status: "finished",
    finalText: "",
    durationMs: 1000,
    files: parseUnifiedDiff(MODIFIED),
    ...over,
  });

  it("counts files and lines", () => {
    expect(approachSummaryLine(approach({}))).toBe("1 file, +2 −1");
  });

  it("distinguishes a scout that changed nothing from one that failed", () => {
    // Both are outcomes a reader has to act on differently: one explored and
    // concluded no change was needed, the other never got that far.
    expect(approachSummaryLine(approach({ files: [] }))).toBe("changed nothing");
    expect(approachSummaryLine(approach({ status: "error", files: [] }))).toBe("failed");
  });

  it("says when a result is what a scout had reached at the deadline", () => {
    expect(approachSummaryLine(approach({ status: "timeout" }))).toBe("1 file, +2 −1 (timed out)");
    expect(approachSummaryLine(approach({ status: "timeout", files: [] }))).toBe(
      "timed out, changed nothing",
    );
  });

  it("unions the paths, because the divergence is the point", () => {
    // An intersection would hide the one thing a comparison is for: what this
    // approach touched that the other did not.
    const paths = touchedPaths([
      approach({ files: parseUnifiedDiff(MODIFIED) }),
      approach({ name: "redux", files: parseUnifiedDiff(ADDED) }),
    ]);
    expect(paths).toEqual(["src/cart.ts", "src/store.ts"]);
  });
});
