/**
 * The builder's parser/serialiser against the engine's grammar.
 *
 * `web/lib/workflow-doc.ts` mirrors `packages/cli/src/workflow.ts` — same
 * regexes, same strictness, same error strings — and adds what an editor
 * needs: the preamble kept verbatim, raw frontmatter values, and a serialiser
 * whose output the engine would accept. These tests pin the mirror to the
 * grammar and pin the round-trip (parse → serialise → parse) to a fixed
 * point, including over the real kit workflows read from disk at test time —
 * never inlined, so an edit to a kit file is tested as shipped.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type DocStage,
  type DocStep,
  frontmatterValueError,
  isWorkflowDocError,
  nameNormalizationWarning,
  normalizeWorkflowName,
  type ParsedWorkflowDoc,
  parseWorkflowDoc,
  placeholderError,
  serializeWorkflowDoc,
  stepReparseIssues,
  validateWorkflowDoc,
  type WorkflowDoc,
} from "../lib/workflow-doc";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = join(WEB_DIR, "..");

/** Parse, asserting success — failures print the parser's own message. */
function parseOk(raw: string, defaults?: { name?: string }): ParsedWorkflowDoc {
  const result = parseWorkflowDoc(raw, defaults);
  if (isWorkflowDocError(result)) throw new Error(`expected parse to succeed: ${result.error}`);
  return result;
}

/** Parse, asserting failure, and return the message. */
function parseErr(raw: string, defaults?: { name?: string }): string {
  const result = parseWorkflowDoc(raw, defaults);
  if (!isWorkflowDocError(result)) throw new Error("expected parse to fail");
  return result.error;
}

describe("frontmatter", () => {
  it("parses all seven recognised keys as raw strings", () => {
    const { doc } = parseOk(
      [
        "---",
        "name: fix-bug",
        "description: colons: are: fine in the value",
        "continueOnError: true",
        "stepTimeoutMs: 60000",
        "maxStepRetries: 2",
        "budgetUsd: 12.5",
        "budgetTokens: 250000",
        "---",
        "1. do the thing described in {{input}}",
      ].join("\n"),
    );
    expect(doc.frontmatter).toEqual({
      name: "fix-bug",
      description: "colons: are: fine in the value",
      continueOnError: "true",
      stepTimeoutMs: "60000",
      maxStepRetries: "2",
      budgetUsd: "12.5",
      budgetTokens: "250000",
    });
  });

  it("strips one matched pair of quotes from a value", () => {
    const { doc } = parseOk("---\nname: \"fix-bug\"\ndescription: 'quoted'\n---\n1. go");
    expect(doc.frontmatter.name).toBe("fix-bug");
    expect(doc.frontmatter.description).toBe("quoted");
  });

  it("keeps a value that is itself quote-wrapped through the round-trip", () => {
    const first = parseOk("---\nname: x\ndescription: '\"exact\"'\n---\n1. go");
    expect(first.doc.frontmatter.description).toBe('"exact"');
    const serialized = serializeWorkflowDoc(first.doc);
    const second = parseOk(serialized);
    expect(second.doc.frontmatter.description).toBe('"exact"');
    expect(serializeWorkflowDoc(second.doc)).toBe(serialized);
  });

  it("treats an unterminated fence as no frontmatter at all", () => {
    const { doc, warnings } = parseOk("---\nname: broken\n1. do a thing", { name: "stem" });
    expect(doc.frontmatter.name).toBe("stem");
    expect(doc.preamble).toBe("---\nname: broken");
    expect(doc.stages).toHaveLength(1);
    expect(warnings.some((note) => note.includes('file name: "stem"'))).toBe(true);
  });

  it("warns about an unknown key instead of silently eating it", () => {
    const { doc, warnings } = parseOk("---\nname: x\nauthor: me\n---\n1. go");
    expect("author" in doc.frontmatter).toBe(false);
    expect(warnings.some((note) => note.includes('"author"'))).toBe(true);
  });

  it("rejects a bad continueOnError with the engine's message, unprefixed", () => {
    expect(parseErr("---\nname: x\ncontinueOnError: yes\n---\n1. go")).toBe(
      'continueOnError must be "true" or "false", got "yes"',
    );
  });

  it("rejects bad numeric values with the engine's line-numbered messages", () => {
    expect(parseErr("---\nname: x\nstepTimeoutMs: 0\n---\n1. go")).toBe(
      'line 3: stepTimeoutMs must be a positive whole number of milliseconds, got "0"',
    );
    expect(parseErr("---\nname: x\nmaxStepRetries: -1\n---\n1. go")).toBe(
      'line 3: maxStepRetries must be a non-negative whole number, got "-1"',
    );
    expect(parseErr("---\nname: x\nbudgetUsd: lots\n---\n1. go")).toBe(
      'line 3: budgetUsd must be a non-negative number of US dollars, got "lots"',
    );
    expect(parseErr("---\nname: x\nbudgetTokens: 3.5\n---\n1. go")).toBe(
      'line 3: budgetTokens must be a non-negative whole number of tokens, got "3.5"',
    );
  });

  it("accepts zero for the two budgets (disabled) and rejects fractions of a token", () => {
    expect(frontmatterValueError("budgetUsd", "0")).toBeUndefined();
    expect(frontmatterValueError("budgetTokens", "0")).toBeUndefined();
    expect(frontmatterValueError("budgetTokens", "120000")).toBeUndefined();
    expect(frontmatterValueError("budgetTokens", "1.5")).toBe(
      'budgetTokens must be a non-negative whole number of tokens, got "1.5"',
    );
  });

  it("requires a usable name, from the frontmatter or the caller's default", () => {
    expect(parseErr("1. go")).toBe('workflow has no usable name; set "name:" in the frontmatter');
    expect(parseErr("---\nname: '!!!'\n---\n1. go")).toBe(
      'workflow has no usable name; set "name:" in the frontmatter',
    );
    const { doc } = parseOk("1. go", { name: "from-file" });
    expect(doc.frontmatter.name).toBe("from-file");
  });
});

describe("name normalisation", () => {
  it("mirrors the engine's lowercase-and-strip rule", () => {
    expect(normalizeWorkflowName("My Flow!")).toBe("myflow");
    expect(normalizeWorkflowName("fix-bug")).toBe("fix-bug");
  });

  it("surfaces the silent normalisation as a warning", () => {
    expect(nameNormalizationWarning("My Flow")).toContain('installed as "myflow"');
    expect(nameNormalizationWarning("fix-bug")).toBeUndefined();
    expect(nameNormalizationWarning("!!!")).toContain("normalises to nothing");
    const { warnings } = parseOk("---\nname: My Flow\n---\n1. go");
    expect(warnings.some((note) => note.includes('installed as "myflow"'))).toBe(true);
  });
});

describe("body grammar", () => {
  it("keeps the preamble verbatim, blank interior lines included", () => {
    const preamble = "First paragraph of prose.\n\nSecond paragraph, after a blank line.";
    const raw = `---\nname: x\n---\n${preamble}\n\n1. go do it with {{input}}\n`;
    const first = parseOk(raw);
    expect(first.doc.preamble).toBe(preamble);
    const serialized = serializeWorkflowDoc(first.doc);
    expect(serialized).toContain(preamble);
    expect(parseOk(serialized).doc.preamble).toBe(preamble);
  });

  it("parses a parallel stage, keeping the label's trailing colon", () => {
    const { doc } = parseOk(
      [
        "---",
        "name: x",
        "---",
        "1. Oracle lanes:",
        "   - [tier:fast] run the suite over {{input}}",
        "   - @qa audit the result of {{input}}",
      ].join("\n"),
    );
    expect(doc.stages).toHaveLength(1);
    const stage = doc.stages[0] as DocStage;
    expect(stage.parallel).toBe(true);
    expect(stage.label).toBe("Oracle lanes:");
    expect(stage.steps).toEqual([
      { modelTag: "tier:fast", prompt: "run the suite over {{input}}" },
      { role: "qa", prompt: "audit the result of {{input}}" },
    ]);
  });

  it("parses a label-less parallel stage from a bare numbered line", () => {
    const { doc } = parseOk("---\nname: x\n---\n1.\n   - alpha\n   - beta");
    const stage = doc.stages[0] as DocStage;
    expect(stage.parallel).toBe(true);
    expect(stage.label).toBeUndefined();
    expect(stage.steps).toHaveLength(2);
  });

  it("enforces the [tag] @role prompt prefix order", () => {
    const { doc } = parseOk("---\nname: x\n---\n1. [tier:judgment] @architect design {{input}}");
    expect(doc.stages[0]?.steps[0]).toEqual({
      modelTag: "tier:judgment",
      role: "architect",
      prompt: "design {{input}}",
    });
    expect(parseErr("---\nname: x\n---\n1. @architect [tier:judgment] design it")).toContain(
      "a model tag must come before the role",
    );
  });

  it("rejects the engine's malformed-step shapes with its messages", () => {
    expect(parseErr("---\nname: x\n---\n1. a\n3. b")).toBe(
      "line 5: steps must be numbered consecutively from 1; expected 2, got 3",
    );
    expect(parseErr("---\nname: x\n---\n   - orphan branch")).toBe(
      "line 4: parallel branch appears before any numbered step",
    );
    expect(parseErr("---\nname: x\n---\n1. lanes:\n   * star bullet")).toBe(
      'line 5: use "-" for a parallel branch, not "*"',
    );
    expect(parseErr("---\nname: x\n---\n- top level")).toBe(
      "line 4: a top-level bullet is not a step; use a numbered item, or indent it to make it a parallel branch",
    );
    expect(parseErr("---\nname: x\n---\n1. a step\nstray continuation line")).toBe(
      "line 5: unexpected text after the step list; a step is exactly one line (no continuations)",
    );
    expect(parseErr("---\nname: x\n---\n1. a prompt\n   - and a branch")).toContain(
      'end the line with ":" to make it a label',
    );
    expect(parseErr("---\nname: x\n---\n1. [] empty tag")).toContain("model tag is empty");
    expect(parseErr("---\nname: x\n---\nno steps here")).toBe(
      "workflow has no steps; write a numbered list of them",
    );
  });

  it("validates placeholders, rejecting prev and journal in stage 1", () => {
    expect(parseErr("---\nname: x\n---\nprose first\n1. use {{prev}}")).toBe(
      "line 5: {{prev}} has no value in the first step",
    );
    expect(parseErr("---\nname: x\n---\n1. use {{journal}}")).toBe(
      "line 4: {{journal}} has no value in the first step",
    );
    expect(parseErr("---\nname: x\n---\n1. use {{previous}}")).toBe(
      'line 4: unknown placeholder "{{previous}}"; only {{prev}}, {{input}} and {{journal}} exist',
    );
    // Inner whitespace is trimmed, and later stages may use prev.
    const { doc } = parseOk("---\nname: x\n---\n1. start from {{ input }}\n2. refine {{prev}}");
    expect(doc.stages).toHaveLength(2);
    expect(placeholderError("see {{prev}}", 1)).toBe("{{prev}} has no value in the first step");
    expect(placeholderError("see {{prev}}", 2)).toBeUndefined();
  });

  it("accepts `N)` numbering on import and canonicalises it to `N.`", () => {
    const { doc } = parseOk("---\nname: x\n---\n1) first thing");
    expect(serializeWorkflowDoc(doc)).toContain("\n1. first thing\n");
  });
});

describe("serialiser", () => {
  it("emits `N. ` stages and three-space `   - ` branches", () => {
    const doc: WorkflowDoc = {
      frontmatter: { name: "demo" },
      preamble: "",
      stages: [
        { parallel: false, steps: [{ role: "dev", prompt: "build it from {{input}}" }] },
        {
          parallel: true,
          label: "Check it:",
          steps: [{ prompt: "test {{prev}}" }, { modelTag: "tier:fast", prompt: "lint {{prev}}" }],
        },
      ],
    };
    const lines = serializeWorkflowDoc(doc).split("\n");
    expect(lines).toContain("1. @dev build it from {{input}}");
    expect(lines).toContain("2. Check it:");
    expect(lines).toContain("   - test {{prev}}");
    expect(lines).toContain("   - [tier:fast] lint {{prev}}");
  });

  it("renumbers consecutively after a reorder or delete", () => {
    const { doc } = parseOk("---\nname: x\n---\n1. alpha\n2. beta\n3. gamma");
    const reordered: WorkflowDoc = {
      ...doc,
      stages: [doc.stages[2], doc.stages[0]].filter((stage): stage is DocStage => Boolean(stage)),
    };
    const serialized = serializeWorkflowDoc(reordered);
    expect(serialized).toContain("\n1. gamma\n2. alpha\n");
    expect(isWorkflowDocError(parseWorkflowDoc(serialized))).toBe(false);
  });

  it("appends the label's colon and keeps every step on one physical line", () => {
    const doc: WorkflowDoc = {
      frontmatter: { name: "demo" },
      preamble: "",
      stages: [
        { parallel: true, label: "Lanes", steps: [{ prompt: "first\nline broken" }] },
        { parallel: false, steps: [{ prompt: "also\nbroken {{prev}}" }] },
      ],
    };
    const serialized = serializeWorkflowDoc(doc);
    expect(serialized).toContain("1. Lanes:\n   - first line broken\n");
    expect(serialized).toContain("2. also broken {{prev}}\n");
    expect(isWorkflowDocError(parseWorkflowDoc(serialized))).toBe(false);
  });

  it("reaches a fixed point: parse → serialise → parse → serialise", () => {
    const raw = [
      "---",
      "name: fixed-point",
      "description: a doc with every construct",
      "budgetTokens: 9000",
      "---",
      "Preamble prose.",
      "",
      "More preamble.",
      "",
      "1. [tier:cheap] @dev start from {{input}}",
      "2. Fan out:",
      "   - probe {{prev}}",
      "   - @qa cross-check {{prev}} against {{journal}}",
      "3. @lead assemble {{prev}}",
    ].join("\n");
    const first = parseOk(raw);
    const serialized = serializeWorkflowDoc(first.doc);
    const second = parseOk(serialized);
    expect(second.doc).toEqual(first.doc);
    expect(serializeWorkflowDoc(second.doc)).toBe(serialized);
  });
});

describe("validateWorkflowDoc", () => {
  it("collects every problem instead of stopping at the first", () => {
    const doc: WorkflowDoc = {
      frontmatter: { name: "", budgetTokens: "1.5" },
      preamble: "",
      stages: [
        { parallel: false, steps: [{ modelTag: "bad tag", role: "-oops", prompt: "{{prev}} x" }] },
        { parallel: true, label: "Lanes:", steps: [{ prompt: "" }] },
      ],
    };
    const issues = validateWorkflowDoc(doc);
    const messages = issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain("no usable name");
    expect(messages).toContain("budgetTokens must be a non-negative whole number of tokens");
    expect(messages).toContain('model tag "bad tag"');
    expect(messages).toContain('role name "-oops"');
    expect(messages).toContain("{{prev}} has no value in the first step");
    expect(messages).toContain("step has an empty prompt");
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });

  it("marks the silent-normalisation case as a warning, not an error", () => {
    const doc: WorkflowDoc = {
      frontmatter: { name: "My Flow" },
      preamble: "",
      stages: [{ parallel: false, steps: [{ prompt: "go" }] }],
    };
    const issues = validateWorkflowDoc(doc);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.message).toContain('installed as "myflow"');
  });

  it("passes a well-formed document with no issues", () => {
    const { doc } = parseOk("---\nname: clean\n---\n1. begin with {{input}}\n2. finish {{prev}}");
    expect(validateWorkflowDoc(doc)).toEqual([]);
  });
});

describe("prompt-prefix collisions (the grammar has no escaping)", () => {
  const solo = (step: DocStep): WorkflowDoc => ({
    frontmatter: { name: "x" },
    preamble: "",
    stages: [{ parallel: false, steps: [step] }],
  });
  const errorMessages = (doc: WorkflowDoc): string[] =>
    validateWorkflowDoc(doc)
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);

  it("flags an empty role field with a prompt starting '@word' — silent role dispatch", () => {
    const doc = solo({ prompt: "@here is the summary to send" });
    // Serialised verbatim, the prompt's first word re-parses as the role…
    const reparsed = parseOk(serializeWorkflowDoc(doc));
    expect(reparsed.doc.stages[0]?.steps[0]).toEqual({
      role: "here",
      prompt: "is the summary to send",
    });
    expect(reparsed.doc).not.toEqual(doc);
    // …so validation must block the "Valid" claim, with a way out.
    expect(
      errorMessages(doc).some((m) => m.includes('will read "@here" as this step\'s role')),
    ).toBe(true);
  });

  it("flags the silent role adoption even when a model tag is set", () => {
    const doc = solo({ modelTag: "tier:fast", prompt: "@qa check the output" });
    const reparsed = parseOk(serializeWorkflowDoc(doc));
    expect(reparsed.doc.stages[0]?.steps[0]).toEqual({
      modelTag: "tier:fast",
      role: "qa",
      prompt: "check the output",
    });
    expect(errorMessages(doc).some((m) => m.includes('"@qa"'))).toBe(true);
  });

  it("flags a set role with a prompt starting '[valid-tag]' — the engine hard-errors", () => {
    const doc = solo({ role: "qa", prompt: "[RFC-1] verify the fix" });
    expect(parseErr(serializeWorkflowDoc(doc))).toContain("a model tag must come before the role");
    expect(
      errorMessages(doc).some((m) => m.includes("a model tag must come before the role")),
    ).toBe(true);
  });

  it("flags an empty tag field with a prompt starting '[valid-tag]' — silent model tag", () => {
    const doc = solo({ prompt: "[RFC-1] verify the fix" });
    const reparsed = parseOk(serializeWorkflowDoc(doc));
    expect(reparsed.doc.stages[0]?.steps[0]).toEqual({
      modelTag: "RFC-1",
      prompt: "verify the fix",
    });
    expect(reparsed.doc).not.toEqual(doc);
    expect(
      errorMessages(doc).some((m) => m.includes('will read "[RFC-1]" as this step\'s model tag')),
    ).toBe(true);
  });

  it("flags a bracketed chunk that is not a valid tag — the engine errors, not prose", () => {
    // "[x y]" fails VALID_TAG, so the engine rejects the line outright.
    const doc = solo({ prompt: "[x y] measure both" });
    expect(parseErr(serializeWorkflowDoc(doc))).toContain('model tag "x y" may only contain');
    expect(errorMessages(doc).some((m) => m.includes('model tag "x y" may only contain'))).toBe(
      true,
    );
  });

  it("flags an '@word' that is not a valid role — the engine errors, not prose", () => {
    const doc = solo({ prompt: "@Weird! but true" });
    expect(parseErr(serializeWorkflowDoc(doc))).toContain('role name "Weird!" may only contain');
    expect(errorMessages(doc).some((m) => m.includes('role name "Weird!" may only contain'))).toBe(
      true,
    );
  });

  it("addresses a branch collision to its stage and branch", () => {
    const doc: WorkflowDoc = {
      frontmatter: { name: "x" },
      preamble: "",
      stages: [
        { parallel: false, steps: [{ prompt: "start from {{input}}" }] },
        {
          parallel: true,
          label: "Lanes:",
          steps: [{ prompt: "safe {{prev}}" }, { prompt: "@qa audit {{prev}}" }],
        },
      ],
    };
    const issues = validateWorkflowDoc(doc).filter((issue) => issue.severity === "error");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toBe("stage 2 · branch 2");
  });

  it("stays quiet when the prefixes are set fields or mid-prompt text", () => {
    const clean: WorkflowDoc = {
      frontmatter: { name: "x" },
      preamble: "",
      stages: [
        { parallel: false, steps: [{ role: "qa", prompt: "@later ping the channel" }] },
        {
          parallel: false,
          steps: [{ modelTag: "tier:x", prompt: "[RFC-1] apply it to {{prev}}" }],
        },
        { parallel: false, steps: [{ role: "qa", prompt: "[x y] verify {{prev}} by hand" }] },
        { parallel: false, steps: [{ prompt: "email @qa about [RFC-1] and {{prev}}" }] },
      ],
    };
    expect(validateWorkflowDoc(clean)).toEqual([]);
    // Flag-free documents keep the parse ⇄ serialise fixed point.
    const serialized = serializeWorkflowDoc(clean);
    const reparsed = parseOk(serialized);
    expect(reparsed.doc).toEqual(clean);
    expect(serializeWorkflowDoc(reparsed.doc)).toBe(serialized);
  });

  it("skips steps whose own field errors already block the file", () => {
    expect(stepReparseIssues({ modelTag: "bad tag", prompt: "@x y" })).toEqual([]);
    expect(stepReparseIssues({ prompt: "plain prose about {{input}}" })).toEqual([]);
    expect(stepReparseIssues({ prompt: "   " })).toEqual([]);
  });
});

describe("real kit workflows, read from disk", () => {
  const files = [
    join(REPO_DIR, "kits", "enterprise-org", "workflows", "bug-fix.md"),
    join(REPO_DIR, "kits", "enterprise-org", "workflows", "release-check.md"),
    join(REPO_DIR, "kits", "rag-blueprint", "workflows", "rag-setup.md"),
  ];

  it.each(files)("round-trips %s to a fixed point", (file) => {
    const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const first = parseOk(raw);
    const serialized = serializeWorkflowDoc(first.doc);
    const second = parseOk(serialized);
    expect(second.doc).toEqual(first.doc);
    expect(serializeWorkflowDoc(second.doc)).toBe(serialized);
    // Preamble and steps survive intact, verbatim.
    expect(first.doc.preamble.length).toBeGreaterThan(0);
    expect(raw).toContain(first.doc.preamble);
    expect(first.doc.stages.length).toBeGreaterThan(0);
    // Shipped files should already satisfy the editor's own validation.
    expect(validateWorkflowDoc(first.doc).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("sees the shapes the builder seeds on: sequential, parallel, long", () => {
    const bugFix = parseOk(readFileSync(files[0] ?? "", "utf8"));
    expect(bugFix.doc.stages).toHaveLength(4);
    expect(bugFix.doc.stages.every((stage) => !stage.parallel)).toBe(true);
    expect(bugFix.warnings).toEqual([]);

    const releaseCheck = parseOk(readFileSync(files[1] ?? "", "utf8"));
    expect(
      releaseCheck.doc.stages.some((stage) => stage.parallel && stage.label?.endsWith(":")),
    ).toBe(true);

    const ragSetup = parseOk(readFileSync(files[2] ?? "", "utf8"));
    // Fourteen since the entry-point stage was added; the registry's `stages`
    // and the hub test hold the same number, so a drift shows up in two places.
    expect(ragSetup.doc.stages).toHaveLength(14);
    expect(ragSetup.doc.stages.some((stage) => stage.parallel)).toBe(true);
  });
});
