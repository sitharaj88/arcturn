/**
 * Reading a model's answer as an edit.
 *
 * This is the part of an inline edit that can be wrong in a way the user pays
 * for: an answer parsed loosely puts prose in their file, and one parsed
 * strictly throws away a good edit because it lacked a fence. Both failures
 * are silent at the point they happen and loud a moment later, which is why
 * they get a test each rather than a careful reading.
 *
 * The instruction is tested too, and for a reason that is not obvious: it is
 * the only place that tells the agent *not* to write the file itself. If that
 * sentence goes missing the gesture still appears to work — the edit lands —
 * and the two things it was built for, undo and decline, quietly stop existing.
 */

import { describe, expect, it } from "vitest";
import {
  describeEdit,
  type EditTarget,
  editInstruction,
  extractReplacement,
  fitToSelection,
  isNoChange,
} from "./model.js";

function target(over: Partial<EditTarget> = {}): EditTarget {
  return {
    path: "src/cart.ts",
    start: 40,
    end: 42,
    text: "function total(items) {\n  return items.length;\n}",
    languageId: "typescript",
    ...over,
  };
}

describe("the instruction", () => {
  const instruction = editInstruction(target(), "sum the prices instead");

  it("names the file and the exact lines", () => {
    expect(instruction).toContain("src/cart.ts");
    expect(instruction).toContain("lines 40-42");
  });

  it("carries the selected text inline rather than as an attachment", () => {
    // An attachment arrives as a whole-file context block with the selection
    // somewhere inside it, which is exactly the "which lines?" ambiguity this
    // gesture exists to remove.
    expect(instruction).toContain("function total(items) {");
    expect(instruction).toContain("```typescript");
  });

  it("asks for a fenced block and nothing else", () => {
    expect(instruction).toMatch(/single\s*\n?fenced code block/);
    expect(instruction).toContain("No explanation");
  });

  it("forbids writing the file, which is what makes undo and decline work", () => {
    // The load-bearing sentence. Without it the agent writes the file itself,
    // the edit leaves the editor's undo stack, and declining costs a revert.
    expect(instruction).toMatch(/do not write this one/i);
    expect(instruction).toMatch(/undo stack/i);
  });

  it("says only these lines will be replaced, so the agent does not reach out", () => {
    // An agent told to change lines 40-42 may decide 12 and 88 need it too.
    // Sometimes it is right — and that is what the panel is for.
    expect(instruction).toMatch(/only these lines will be replaced/i);
  });

  it("passes the user's words through unchanged", () => {
    expect(editInstruction(target(), "use Intl.NumberFormat")).toContain("use Intl.NumberFormat");
  });
});

describe("pulling the replacement out of an answer", () => {
  it("takes the fenced block", () => {
    expect(extractReplacement("Here you go:\n\n```ts\nconst a = 1;\n```\n\nHope that helps.")).toBe(
      "const a = 1;",
    );
  });

  it("keeps a nested fence from ending the block early", () => {
    // A code block containing a markdown example is not two blocks. Only
    // anchoring the closing fence to a line start gets this right.
    const answer = "```md\n# Title\n\n" + "```" + "js\nconst a = 1;\n" + "```" + "\n```";
    expect(extractReplacement(answer)).toContain("# Title");
  });

  it("takes what a truncated answer managed to produce", () => {
    // An unterminated fence is a cut-off response. Showing it as a diff the
    // user can decline beats discarding a nearly complete edit.
    expect(extractReplacement("```ts\nconst a = 1;\nconst b = 2;")).toBe(
      "const a = 1;\nconst b = 2;",
    );
  });

  it("accepts a bare answer that is plainly code", () => {
    // A model that answered with exactly the code and no fence did the right
    // thing in the wrong shape. Refusing it is pedantry the user pays for.
    expect(extractReplacement("const a = 1;")).toBe("const a = 1;");
  });

  it("refuses an answer that is only a sentence", () => {
    // The failure that puts prose in someone's file.
    expect(extractReplacement("I could not find anything to change here.")).toBeUndefined();
    expect(extractReplacement("   ")).toBeUndefined();
    expect(extractReplacement("")).toBeUndefined();
  });

  it("keeps blank lines inside the block", () => {
    expect(extractReplacement("```\na\n\nb\n```")).toBe("a\n\nb");
  });
});

describe("fitting a replacement to the selection", () => {
  it("keeps a selection that ended without a newline ending without one", () => {
    // Otherwise an inline edit silently adds a blank line every time.
    expect(fitToSelection(target({ text: "const a = 1;" }), "const a = 2;\n")).toBe("const a = 2;");
  });

  it("keeps a selection that ended with a newline ending with one", () => {
    // And the reverse joins two lines together.
    expect(fitToSelection(target({ text: "const a = 1;\n" }), "const a = 2;")).toBe(
      "const a = 2;\n",
    );
  });

  it("collapses several trailing newlines to the one convention", () => {
    expect(fitToSelection(target({ text: "a\n" }), "b\n\n\n")).toBe("b\n");
  });
});

describe("recognising that nothing changed", () => {
  it("says so when the answer is the selection", () => {
    // A legitimate outcome, and one that deserves a sentence rather than a
    // diff editor with no diff in it.
    expect(isNoChange(target(), target().text)).toBe(true);
  });

  it("ignores trailing whitespace and line-ending style", () => {
    expect(isNoChange(target({ text: "a\nb\n" }), "a\nb")).toBe(true);
    expect(isNoChange(target({ text: "a\r\nb" }), "a\nb")).toBe(true);
  });

  it("does not call a real change no change", () => {
    expect(isNoChange(target({ text: "a" }), "b")).toBe(false);
  });
});

describe("describing what will happen", () => {
  it("names the range", () => {
    expect(describeEdit(target(), "x\ny\nz")).toBe("Replace lines 40-42 of src/cart.ts");
  });

  it("says a single line is a single line", () => {
    expect(describeEdit(target({ start: 7, end: 7, text: "a" }), "b")).toContain("line 7 of");
  });

  it("says how many lines it grows or shrinks by", () => {
    expect(describeEdit(target(), "a\nb\nc\nd\ne")).toContain("(+2 lines)");
    expect(describeEdit(target(), "a")).toContain("(-2 lines)");
  });
});
