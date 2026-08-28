/**
 * Reading a model's review as diagnostics.
 *
 * The parser is where this feature can hurt someone: a finding placed at the
 * wrong file or an invented severity is a red squiggle in code that may be
 * fine, and a parser that gives up on slightly-wrong JSON silently reports "no
 * findings" over a review that found five. So the tests are mostly about the
 * shapes models actually emit — fences, prose around the JSON, a bare array,
 * numbers as strings — and about what gets dropped versus repaired.
 */

import { describe, expect, it } from "vitest";
import { capDiff, MAX_DIFF_CHARS, parseFindings, reviewPrompt, reviewSummary } from "./model.js";

const CLEAN = JSON.stringify({
  findings: [
    {
      path: "src/cart.ts",
      line: 42,
      severity: "error",
      title: "total() ignores quantity",
      detail: "Multi-quantity items are charged once.",
    },
  ],
});

describe("the prompt", () => {
  it("asks for JSON and forbids fences, because the answer is for a machine", () => {
    const prompt = reviewPrompt("diff --git a/x b/x");
    expect(prompt).toContain('{"findings":');
    expect(prompt).toContain("no markdown fences");
  });

  it("names the empty shape, so a model with nothing to say has a way to say it", () => {
    // A model told only to emit findings invents one sooner than it emits an
    // empty array unprompted.
    expect(reviewPrompt("diff")).toContain('{"findings": []}');
  });

  it("keeps the head of a huge diff, where the file headers are", () => {
    const diff = `diff --git a/first.ts b/first.ts\n${"x".repeat(MAX_DIFF_CHARS * 2)}`;
    const prompt = reviewPrompt(diff);
    expect(prompt).toContain("diff --git a/first.ts");
    expect(prompt).toContain("truncated for review");
  });

  it("never grows a diff by capping it", () => {
    // The failures module paid for this lesson: a marker added on top of the
    // cap makes trimming lengthen anything just over the line.
    const diff = "y".repeat(MAX_DIFF_CHARS + 10);
    expect(capDiff(diff).length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
  });
});

describe("parsing what a compliant model returns", () => {
  it("reads the findings", () => {
    expect(parseFindings(CLEAN)).toEqual([
      {
        path: "src/cart.ts",
        line: 42,
        severity: "error",
        title: "total() ignores quantity",
        detail: "Multi-quantity items are charged once.",
      },
    ]);
  });

  it("treats an empty list as a clean review, not a failure", () => {
    expect(parseFindings('{"findings": []}')).toEqual([]);
  });
});

describe("parsing the shapes models actually emit", () => {
  it("tolerates fences, despite having asked for none", () => {
    expect(parseFindings(`\`\`\`json\n${CLEAN}\n\`\`\``)).toHaveLength(1);
  });

  it("tolerates prose before and after the JSON", () => {
    expect(parseFindings(`Here is my review.\n\n${CLEAN}\n\nLet me know!`)).toHaveLength(1);
  });

  it("tolerates a bare array in place of the wrapping object", () => {
    const bare = JSON.stringify([{ path: "a.ts", title: "t", severity: "info" }]);
    expect(parseFindings(bare)).toHaveLength(1);
  });

  it("repairs a line number sent as a string", () => {
    const stringy = JSON.stringify({ findings: [{ path: "a.ts", title: "t", line: "17" }] });
    expect(parseFindings(stringy)?.[0]?.line).toBe(17);
  });

  it("keeps a finding whose line is unusable, without a line", () => {
    // Placed at the top of its file by the renderer — honest about what is
    // known, instead of dropping a real finding over a bad number.
    const bad = JSON.stringify({ findings: [{ path: "a.ts", title: "t", line: -3 }] });
    expect(parseFindings(bad)?.[0]?.line).toBeUndefined();
  });

  it("clamps an invented severity to warning rather than dropping the finding", () => {
    const odd = JSON.stringify({ findings: [{ path: "a.ts", title: "t", severity: "critical" }] });
    expect(parseFindings(odd)?.[0]?.severity).toBe("warning");
  });

  it("strips diff prefixes from paths, which models copy from the hunk headers", () => {
    const prefixed = JSON.stringify({ findings: [{ path: "b/src/x.ts", title: "t" }] });
    expect(parseFindings(prefixed)?.[0]?.path).toBe("src/x.ts");
  });

  it("drops an entry with no path or no title, which cannot be placed or read", () => {
    const partial = JSON.stringify({
      findings: [{ title: "orphan" }, { path: "a.ts" }, { path: "b.ts", title: "kept" }],
    });
    expect(parseFindings(partial)?.map((finding) => finding.title)).toEqual(["kept"]);
  });

  it("says undefined for an answer with no JSON at all", () => {
    // Distinct from an empty list: "the review did not produce findings" and
    // "the review found nothing" are different news.
    expect(parseFindings("I reviewed the diff and it all looks fine to me.")).toBeUndefined();
  });

  it("survives JSON embedded in a sentence with trailing braces", () => {
    expect(parseFindings(`The result is ${CLEAN} — which covers it.`)).toHaveLength(1);
  });
});

describe("the summary line", () => {
  it("celebrates a clean review", () => {
    expect(reviewSummary([])).toContain("no issues");
  });

  it("counts, and calls out errors", () => {
    const findings = parseFindings(CLEAN) ?? [];
    expect(reviewSummary(findings)).toBe("Review complete: 1 finding, 1 error.");
  });

  it("does not mention errors when there are none", () => {
    const info = parseFindings(
      JSON.stringify({ findings: [{ path: "a.ts", title: "t", severity: "info" }] }),
    );
    expect(reviewSummary(info ?? [])).toBe("Review complete: 1 finding.");
  });
});
