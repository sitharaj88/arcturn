/**
 * The two decisions the scout view makes before it touches an editor.
 *
 * Reading what the user typed, and turning a run's results into something a
 * comparison can render. Everything else in `view.ts` is `vscode` calls, and
 * those are covered where they can actually be observed — in the integration
 * suite, in a real workbench.
 *
 * The parsing claim is worth a test for a reason that is not obvious: the
 * grammar is *copied* from the terminal's `/scout`, deliberately, so somebody
 * who knows one does not have to learn the other. A divergence would be
 * invisible until a user typed the same line into both and got two different
 * runs.
 */

import { describe, expect, it } from "vitest";
import { parseApproaches, summarise } from "./patch.js";

const DIFF = `diff --git a/src/store.ts b/src/store.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/store.ts
@@ -0,0 +1,2 @@
+import { create } from "zustand";
+export const useStore = create(() => ({}));
`;

describe("reading what the user typed", () => {
  it("splits on the pipe, the way the terminal does", () => {
    expect(parseApproaches("use zustand | use redux")).toEqual([
      { name: "approach-1", task: "use zustand" },
      { name: "approach-2", task: "use redux" },
    ]);
  });

  it("takes a name from a prefix, the way the terminal does", () => {
    expect(parseApproaches("zustand: use zustand | redux: use redux toolkit")).toEqual([
      { name: "zustand", task: "use zustand" },
      { name: "redux", task: "use redux toolkit" },
    ]);
  });

  it("mixes named and unnamed, numbering by position", () => {
    // The index is the position in the whole list, not a counter of unnamed
    // ones — so removing a name does not renumber the others.
    expect(parseApproaches("zustand: a | b")).toEqual([
      { name: "zustand", task: "a" },
      { name: "approach-2", task: "b" },
    ]);
  });

  it("drops empty segments rather than making an approach out of nothing", () => {
    expect(parseApproaches("a | | b |")).toHaveLength(2);
    expect(parseApproaches("   ")).toHaveLength(0);
  });

  it("does not mistake a colon inside a sentence for a name", () => {
    // A name has to be identifier-shaped and short, because it becomes a git
    // branch and a worktree directory. Prose with a colon in it is one task,
    // and the whole line — colon included — stays the task.
    const [phrase] = parseApproaches("refactor this: it has a colon in the middle");
    expect(phrase?.name).toBe("approach-1");
    expect(phrase?.task).toBe("refactor this: it has a colon in the middle");

    const [tooLong] = parseApproaches("a-prefix-far-longer-than-twenty-four: do the thing");
    expect(tooLong?.name).toBe("approach-1");
  });
});

describe("turning results into a comparison", () => {
  const results = [
    {
      name: "zustand",
      task: "use zustand",
      status: "finished",
      finalText: "Added a store.",
      costUsd: 0.25,
      diff: DIFF,
      durationMs: 4000,
    },
    {
      name: "redux",
      task: "use redux",
      status: "timeout",
      finalText: "Was still wiring the reducer.",
      durationMs: 180000,
    },
  ];

  it("parses each approach's diff into files", () => {
    const [zustand] = summarise(results);
    expect(zustand?.files.map((file) => file.path)).toEqual(["src/store.ts"]);
  });

  it("gives an approach that changed nothing an empty file list, not a missing one", () => {
    // A scout that timed out before writing anything still has findings worth
    // reading, and the renderer must not have to guard against `undefined`.
    const [, redux] = summarise(results);
    expect(redux?.files).toEqual([]);
    expect(redux?.finalText).toContain("reducer");
  });

  it("keeps an unpriced approach unpriced rather than free", () => {
    const [zustand, redux] = summarise(results);
    expect(zustand?.costUsd).toBe(0.25);
    expect(redux?.costUsd).toBeUndefined();
  });

  it("carries the status through, because timeout and finished read differently", () => {
    expect(summarise(results).map((entry) => entry.status)).toEqual(["finished", "timeout"]);
  });
});
