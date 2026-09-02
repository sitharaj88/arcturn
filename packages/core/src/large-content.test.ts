/**
 * The large-content rule is one rule, quoted in five places.
 *
 * It lives here rather than in a kit's role prompt because rediscovering it
 * costs a $40 run: four times in one week a write-lane role reasoned for
 * 35–70K characters, closed with "Write the file now.", and ended its turn
 * without emitting the `write` call at all.
 */

import { describe, expect, it } from "vitest";
import { LARGE_CONTENT_CHARS, LARGE_CONTENT_LINES, LARGE_CONTENT_RULE } from "./large-content.js";

describe("the large-content rule", () => {
  it("quotes the one threshold constant, so nothing can drift from it", () => {
    expect(LARGE_CONTENT_CHARS).toBe(6_000);
    expect(LARGE_CONTENT_RULE).toContain(LARGE_CONTENT_CHARS.toLocaleString("en-US"));
  });

  it("says the four things a model has to do", () => {
    // Not a wording check for its own sake: each of these is a step the
    // observed failure skipped. Drop one and the rule stops being followable.
    expect(LARGE_CONTENT_RULE).toContain("single tool-call argument");
    expect(LARGE_CONTENT_RULE).toContain("`write`");
    expect(LARGE_CONTENT_RULE).toContain("one section per `edit` call");
    expect(LARGE_CONTENT_RULE).toContain("`read` the file once");
    expect(LARGE_CONTENT_RULE).toContain("report the path");
  });

  it("is the same text in both shapes — a model must not meet two rules", () => {
    expect(LARGE_CONTENT_LINES.join(" ")).toBe(LARGE_CONTENT_RULE);
  });

  it("splices into a lane contract at prompt width, with no blank or ragged line", () => {
    for (const line of LARGE_CONTENT_LINES) {
      expect(line.trim(), JSON.stringify(line)).toBe(line);
      expect(line.length, line).toBeGreaterThan(0);
      expect(line.length, line).toBeLessThanOrEqual(96);
    }
  });

  it("stays short enough to read — this is a paragraph, not a policy document", () => {
    expect(LARGE_CONTENT_RULE.length).toBeLessThan(700);
  });
});
