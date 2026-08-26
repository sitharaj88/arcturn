/**
 * The ambient chip's decisions, with no editor in the room.
 *
 * Everything here is a question about *what the panel should be holding* —
 * which editors count, what a selection is called, when a change has settled —
 * and none of it needs `vscode`, a DOM or a clock. `index.ts` supplies the
 * three real event streams and nothing else; if a rule can be stated without
 * an editor, it is stated here.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AMBIENT_DEBOUNCE_MS,
  ambientAttachment,
  ambientIsRedundant,
  ambientLabel,
  createAmbientTracker,
  engineKnowsReferences,
  isAmbientScheme,
  sameAmbient,
  toAmbientEditor,
} from "./active-editor.js";

/** A stand-in `TextEditor`, built from the three fields that decide anything. */
function editor(
  fsPath: string,
  selection?: [number, number, number, number],
  scheme = "file",
): {
  document: { uri: { scheme: string; fsPath: string } };
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
} {
  const [sl, sc, el, ec] = selection ?? [0, 0, 0, 0];
  return {
    document: { uri: { scheme, fsPath } },
    selection: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  };
}

describe("which editors the panel is allowed to watch", () => {
  it("takes a file on disk, which is the only thing the engine can resolve", () => {
    expect(isAmbientScheme("file")).toBe(true);
  });

  it("refuses the schemes that are panes rather than files", () => {
    // Attaching the Output pane, the settings editor, a webview or this
    // extension's own dry-run preview is noise at best: none of them is a path
    // `resolveContext` could answer for, and three of them are things the user
    // opened to look at *the agent*, not at their code.
    for (const scheme of [
      "output",
      "arcturn-dry-run",
      "vscode-settings",
      "vscode-userdata",
      "webview-panel",
      "untitled",
      "git",
    ]) {
      expect(isAmbientScheme(scheme)).toBe(false);
    }
  });

  it("reports nothing at all for an editor it will not watch, rather than a blank path", () => {
    expect(toAmbientEditor(editor("/w/log", undefined, "output"))).toBeUndefined();
    expect(toAmbientEditor(undefined)).toBeUndefined();
  });
});

describe("what the chip is called", () => {
  it("names the file when the caret is just sitting somewhere", () => {
    // A caret is not a selection. Sending 'src/auth.ts:12-12' for somebody who
    // clicked once would be the panel inventing an intent.
    const seen = toAmbientEditor(editor("/w/src/auth.ts", [11, 4, 11, 4]));
    expect(seen?.selection).toBeUndefined();
    expect(ambientLabel("src/auth.ts", seen?.selection)).toBe("src/auth.ts");
  });

  it("names the lines when there is a selection, counting the way the gutter does", () => {
    const seen = toAmbientEditor(editor("/w/src/auth.ts", [11, 0, 39, 12]));
    expect(seen?.selection).toEqual({ startLine: 12, endLine: 40 });
    expect(ambientLabel("src/auth.ts", seen?.selection)).toBe("src/auth.ts:12-40");
  });

  it("names one line once, not as a range from itself to itself", () => {
    const seen = toAmbientEditor(editor("/w/a.ts", [4, 2, 4, 9]));
    expect(ambientLabel("a.ts", seen?.selection)).toBe("a.ts:5");
  });

  it("does not count the line a drag merely touched", () => {
    // A triple-click ends at column 0 of the *next* line. Counting it selects
    // a line the user never highlighted — and for a one-line selection it
    // doubles the range. Same rule `rangeFromSelection` already holds for the
    // terminal path, and deliberately the same function.
    const seen = toAmbientEditor(editor("/w/a.ts", [4, 0, 5, 0]));
    expect(seen?.selection).toEqual({ startLine: 5, endLine: 5 });
  });
});

describe("when two observations are the same observation", () => {
  it("is the same when the file and the lines are", () => {
    expect(
      sameAmbient(
        { fsPath: "/w/a.ts", selection: { startLine: 1, endLine: 3 } },
        { fsPath: "/w/a.ts", selection: { startLine: 1, endLine: 3 } },
      ),
    ).toBe(true);
  });

  it("is not the same when the selection appeared, moved or went away", () => {
    const withRange = { fsPath: "/w/a.ts", selection: { startLine: 1, endLine: 3 } };
    expect(sameAmbient(withRange, { fsPath: "/w/a.ts" })).toBe(false);
    expect(
      sameAmbient(withRange, { fsPath: "/w/a.ts", selection: { startLine: 1, endLine: 4 } }),
    ).toBe(false);
    expect(sameAmbient(withRange, { fsPath: "/w/b.ts" })).toBe(false);
    expect(sameAmbient(undefined, withRange)).toBe(false);
    expect(sameAmbient(undefined, undefined)).toBe(true);
  });
});

/** A tracker over a hand-driven clock, so a debounce is a fact rather than a wait. */
function trackerHarness() {
  const settled: (ReturnType<typeof toAmbientEditor> | undefined)[] = [];
  let pending: { at: number; run: () => void } | undefined;
  let next = 1;
  const tracker = createAmbientTracker({
    setTimer: (run, ms) => {
      pending = { at: ms, run };
      return next++;
    },
    clearTimer: () => {
      pending = undefined;
    },
    onSettled: (value) => settled.push(value),
  });
  return {
    tracker,
    settled,
    delay: (): number | undefined => pending?.at,
    tick: (): void => {
      const due = pending;
      pending = undefined;
      due?.run();
    },
    scheduled: (): boolean => pending !== undefined,
  };
}

describe("the tracker, which is what keeps a cursor from costing a round trip", () => {
  it("says nothing until the moving stops", () => {
    const h = trackerHarness();
    h.tracker.observe(editor("/w/a.ts", [0, 0, 2, 0]));
    h.tracker.observe(editor("/w/a.ts", [0, 0, 5, 0]));
    h.tracker.observe(editor("/w/a.ts", [0, 0, 9, 0]));
    expect(h.settled).toEqual([]);
    expect(h.delay()).toBe(AMBIENT_DEBOUNCE_MS);
    h.tick();
    // One answer for three keystrokes, and it is the last one — a drag that
    // passed over twenty lines must not cost twenty resolveContext calls.
    expect(h.settled).toEqual([{ fsPath: "/w/a.ts", selection: { startLine: 1, endLine: 9 } }]);
  });

  it("schedules nothing at all when the observation has not changed", () => {
    const h = trackerHarness();
    h.tracker.observe(editor("/w/a.ts"));
    h.tick();
    expect(h.settled).toHaveLength(1);
    // VS Code fires onDidChangeTextEditorSelection for a click that landed
    // where the caret already was, and onDidChangeActiveTextEditor for a tab
    // that was already active. Neither is news.
    h.tracker.observe(editor("/w/a.ts"));
    expect(h.scheduled()).toBe(false);
    expect(h.settled).toHaveLength(1);
  });

  it("keeps the last file when focus moves to something that is not one", () => {
    const h = trackerHarness();
    h.tracker.observe(editor("/w/a.ts"));
    h.tick();
    // Clicking into the Arcturn panel itself makes activeTextEditor undefined.
    // A chip that emptied at that moment would empty every single time somebody
    // went to type a message about the file they were just reading.
    h.tracker.observe(undefined);
    h.tracker.observe(editor("/w/build.log", undefined, "output"));
    expect(h.scheduled()).toBe(false);
    expect(h.settled).toHaveLength(1);
    expect(h.tracker.current()).toEqual({ fsPath: "/w/a.ts" });
  });

  it("drops the file when it is actually closed, and does not wait to say so", () => {
    const h = trackerHarness();
    h.tracker.observe(editor("/w/a.ts"));
    h.tick();
    h.tracker.closed("/w/a.ts");
    // No debounce: the file is gone, and a chip offering to attach it is
    // offering something that is not there.
    expect(h.settled).toEqual([{ fsPath: "/w/a.ts" }, undefined]);
    expect(h.tracker.current()).toBeUndefined();
  });

  it("ignores the closing of a file it was not holding", () => {
    const h = trackerHarness();
    h.tracker.observe(editor("/w/a.ts"));
    h.tick();
    h.tracker.closed("/w/other.ts");
    expect(h.settled).toHaveLength(1);
  });

  it("cancels a pending answer when the file it was about is closed", () => {
    const h = trackerHarness();
    h.tracker.observe(editor("/w/a.ts"));
    h.tracker.closed("/w/a.ts");
    h.tick();
    expect(h.settled).toEqual([undefined]);
  });

  it("forgets everything when it is disposed, so a stale timer cannot fire into it", () => {
    const h = trackerHarness();
    h.tracker.observe(editor("/w/a.ts"));
    h.tracker.dispose();
    h.tick();
    expect(h.settled).toEqual([]);
    expect(h.tracker.current()).toBeUndefined();
  });

  it("can be emptied on request, which is what turning the setting off does", () => {
    const h = trackerHarness();
    h.tracker.observe(editor("/w/a.ts"));
    h.tick();
    h.tracker.clear();
    expect(h.tracker.current()).toBeUndefined();
    expect(h.settled.at(-1)).toBeUndefined();
  });

  it("uses the real clock when it is given no timers of its own", () => {
    vi.useFakeTimers();
    try {
      const seen: unknown[] = [];
      const tracker = createAmbientTracker({ onSettled: (value) => seen.push(value) });
      tracker.observe(editor("/w/a.ts"));
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(AMBIENT_DEBOUNCE_MS);
      expect(seen).toEqual([{ fsPath: "/w/a.ts" }]);
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the ambient chip next to the chips somebody attached on purpose", () => {
  it("stands down when the same file is already attached with an @", () => {
    // Two chips naming one file, one attachment on the wire: the row would
    // stop being the whole truth about what the prompt carries. The explicit
    // one wins because it is the one the user put there.
    expect(ambientIsRedundant("src/auth.ts", ["src/auth.ts", "docs/plan.md"])).toBe(true);
  });

  it("stays when nothing else names it", () => {
    expect(ambientIsRedundant("src/auth.ts", ["docs/plan.md"])).toBe(false);
    expect(ambientIsRedundant("src/auth.ts", [])).toBe(false);
  });

  it("compares paths, not labels, so a selection does not look like a different file", () => {
    // The chip reads 'src/auth.ts:12-40'; its path is still 'src/auth.ts', and
    // that is what has to match or the same file would be attached twice.
    expect(ambientIsRedundant("src/auth.ts", ["src/auth.ts:12-40"])).toBe(false);
    expect(ambientIsRedundant("", ["src/auth.ts"])).toBe(false);
  });
});

describe("what the file you are looking at becomes on the wire", () => {
  const looking = { path: "src/auth.ts", kind: "file" as const, ok: true };

  it("names an open file rather than sending it", () => {
    // THE fix. `{ kind: "file", path }` here is what put the whole of
    // `packages/protocol/src/client.ts` — 2,161 lines, ~22,600 tokens — in
    // front of the model on every single turn, for a file the user had merely
    // left open. A reference names the path and sends none of the bytes; the
    // agent reaches for `read` on the turns where it turns out to matter.
    expect(ambientAttachment(looking)).toEqual({
      kind: "fileReference",
      path: "src/auth.ts",
    });
    // Stated as its own assertion because this is the regression: any shape
    // carrying `kind: "file"` without a range is the bug coming back.
    expect(ambientAttachment(looking)).not.toMatchObject({ kind: "file" });
  });

  it("sends the excerpt when the user actually pointed at something", () => {
    // A selection is a request, and the request is small and precise. The
    // numbers cross unchanged: `ActiveEditorItem.selection` is already 1-based
    // and inclusive, which is what `LineRange` documents.
    expect(ambientAttachment({ ...looking, selection: { startLine: 12, endLine: 40 } })).toEqual({
      kind: "file",
      path: "src/auth.ts",
      range: { start: 12, end: 40 },
    });
  });

  it("leaves an image alone, because `read` cannot answer for a .png", () => {
    expect(ambientAttachment({ ...looking, kind: "image", path: "shot.png" })).toEqual({
      kind: "image",
      path: "shot.png",
    });
  });

  it("attaches nothing the engine already said it would refuse", () => {
    // The chip still *shows* it, with the reason. Sending it would fail the
    // whole turn and take the user's typed text with it.
    expect(ambientAttachment({ ...looking, ok: false })).toBeUndefined();
    expect(
      ambientAttachment({ ...looking, ok: false, selection: { startLine: 1, endLine: 2 } }),
    ).toBeUndefined();
  });
});

describe("whether the engine can be told a file is open at all", () => {
  it("believes an engine that says so", () => {
    expect(engineKnowsReferences({ attachmentKinds: ["file", "fileReference", "image"] })).toBe(
      true,
    );
  });

  it("does NOT read an absent field as an engine that supports nothing", () => {
    // Absent means older than the field, which is older than the kind. Read as
    // "no kinds at all" it would also condemn the `@` attachments that work
    // perfectly well on that engine.
    expect(engineKnowsReferences({})).toBe(false);
    expect(engineKnowsReferences({ attachmentKinds: ["file", "image"] })).toBe(false);
  });
});
