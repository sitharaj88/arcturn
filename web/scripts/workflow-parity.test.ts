/**
 * Drift guard: the builder's mirror against the engine's real parser.
 *
 * `web/lib/workflow-doc.ts` claims to mirror `packages/cli/src/workflow.ts` —
 * same regexes, same strictness, same error strings. Nothing else enforces
 * that claim: a future engine grammar change (an eighth frontmatter key, a
 * regex tweak, a reworded error) would otherwise leave the builder validating
 * a stale grammar while still announcing "the CLI's parser accepts this
 * file". So this suite imports BOTH parsers — the engine one directly from
 * the CLI package, transformed by the monorepo vitest like any other TS —
 * and feeds one corpus through the two:
 *
 * - the real kit workflows, read from disk at test time;
 * - a synthetic document exercising every frontmatter key and every step
 *   construct at once;
 * - every error shape the workflow-doc tests enumerate, asserting both
 *   parsers reject AND the error strings match byte for byte (`line N:`
 *   prefixes included), because the mirror claims exactly that.
 *
 * For accepted documents the structures must agree — stage count, per-stage
 * parallel flag and label, per-step id/modelTag/agent/prompt, and the seven
 * frontmatter-derived `Workflow` fields — and the engine must accept the
 * mirror's own serialisation as meaning the same thing as the original.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isWorkflowDocError,
  normalizeWorkflowName,
  parseWorkflowDoc,
  serializeWorkflowDoc,
  validateWorkflowDoc,
  type WorkflowDoc,
} from "../lib/workflow-doc";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = join(WEB_DIR, "..");

// --------------------------------------------------------- the engine, loaded
//
// The import path is computed rather than a static `import … from
// "../../packages/cli/src/workflow.js"` for one reason only: a static import
// (even a type-only one) pulls the whole CLI module graph into `pnpm --dir web
// typecheck`, where Next's `ProcessEnv` augmentation (a required `NODE_ENV`)
// rejects `packages/cli/src/runtime.ts`. Vitest transforms the dynamic import
// exactly the same way, so the functions under test ARE the engine's real
// `parseWorkflow`/`isWorkflowParseError` — only the *types* below are local,
// deliberately minimal declarations of the `Workflow` surface this suite
// compares. If the engine's runtime shape drifts from them, the structural
// assertions against the mirror fail — which is this suite's entire job.

/** The engine's `WorkflowStep`, as far as parity compares it. */
interface EngineStep {
  readonly id: string;
  readonly stageIndex: number;
  readonly branchIndex: number;
  readonly modelTag?: string;
  readonly agent?: string;
  readonly prompt: string;
}

/** The engine's `WorkflowStage`, as far as parity compares it. */
interface EngineStage {
  readonly index: number;
  readonly parallel: boolean;
  readonly label?: string;
  readonly steps: readonly EngineStep[];
}

/** The engine's `Workflow`, as far as parity compares it. */
interface Workflow {
  readonly name: string;
  readonly description: string;
  readonly continueOnError: boolean;
  readonly stepTimeoutMs?: number;
  readonly maxStepRetries?: number;
  readonly budgetUsd?: number;
  readonly budgetTokens?: number;
  readonly stages: readonly EngineStage[];
  readonly source: string;
}

interface EngineParseError {
  readonly error: string;
}

interface EngineModule {
  parseWorkflow(
    raw: string,
    defaults?: { name?: string; source?: string },
  ): Workflow | EngineParseError;
  isWorkflowParseError(value: object): value is EngineParseError;
}

const { parseWorkflow, isWorkflowParseError } = (await import(
  join(REPO_DIR, "packages", "cli", "src", "workflow.ts")
)) as EngineModule;

/** Engine numeric frontmatter parse: `Number(value.trim())`, absent stays absent. */
function num(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value.trim());
}

/**
 * Assert both parsers accept `raw` and agree on everything the engine keeps:
 * the seven frontmatter-derived fields and the full stage/step structure.
 * Returns the engine's parse for further comparison.
 */
function expectBothAcceptAlike(raw: string, name: string): Workflow {
  const engine = parseWorkflow(raw, { name });
  if (isWorkflowParseError(engine)) throw new Error(`engine rejected: ${engine.error}`);
  const mirror = parseWorkflowDoc(raw, { name });
  if (isWorkflowDocError(mirror)) throw new Error(`mirror rejected: ${mirror.error}`);
  const doc = mirror.doc;

  // The seven frontmatter-derived fields on the engine's `Workflow`.
  expect(normalizeWorkflowName((doc.frontmatter.name ?? "").trim())).toBe(engine.name);
  expect(doc.frontmatter.description ?? "").toBe(engine.description);
  expect((doc.frontmatter.continueOnError ?? "").trim().toLowerCase() === "true").toBe(
    engine.continueOnError,
  );
  expect(num(doc.frontmatter.stepTimeoutMs)).toBe(engine.stepTimeoutMs);
  expect(num(doc.frontmatter.maxStepRetries)).toBe(engine.maxStepRetries);
  expect(num(doc.frontmatter.budgetUsd)).toBe(engine.budgetUsd);
  expect(num(doc.frontmatter.budgetTokens)).toBe(engine.budgetTokens);

  // Stage and step structure, member by member.
  expect(doc.stages.length).toBe(engine.stages.length);
  engine.stages.forEach((stage, position) => {
    const mirrored = doc.stages[position];
    expect(stage.index).toBe(position + 1);
    expect(mirrored?.parallel).toBe(stage.parallel);
    expect(mirrored?.label).toBe(stage.label);
    expect(mirrored?.steps.length).toBe(stage.steps.length);
    stage.steps.forEach((step, branch) => {
      const mirroredStep = mirrored?.steps[branch];
      expect(step.id).toBe(stage.parallel ? `${stage.index}.${branch + 1}` : String(stage.index));
      expect(step.stageIndex).toBe(position + 1);
      expect(step.branchIndex).toBe(branch);
      expect(mirroredStep?.modelTag).toBe(step.modelTag);
      expect(mirroredStep?.role).toBe(step.agent);
      expect(mirroredStep?.prompt).toBe(step.prompt);
    });
  });
  return engine;
}

// ------------------------------------------------------------ accepted corpus

const KIT_FILES = [
  { name: "bug-fix", file: join(REPO_DIR, "kits", "enterprise-org", "workflows", "bug-fix.md") },
  {
    name: "release-check",
    file: join(REPO_DIR, "kits", "enterprise-org", "workflows", "release-check.md"),
  },
  { name: "rag-setup", file: join(REPO_DIR, "kits", "rag-blueprint", "workflows", "rag-setup.md") },
];

/** Every frontmatter key, a labelled parallel stage, `[tier:x] @role`, all placeholders. */
const SYNTHETIC = [
  "---",
  "name: full-corpus",
  'description: "every recognised key, exercised once"',
  "continueOnError: true",
  "stepTimeoutMs: 60000",
  "maxStepRetries: 2",
  "budgetUsd: 12.5",
  "budgetTokens: 250000",
  "---",
  "Preamble prose the engine ignores and the mirror keeps.",
  "",
  "1. [tier:cheap] @architect design a plan from {{input}}",
  "2. Fan out:",
  "   - [tier:fast] probe {{prev}}",
  "   - @qa cross-check {{prev}} against {{journal}}",
  "   - measure {{input}} again",
  "3. @lead assemble {{prev}}",
].join("\n");

describe("accepted documents parse identically", () => {
  it.each(KIT_FILES)("agrees with the engine on kit workflow $name", ({ name, file }) => {
    const raw = readFileSync(file, "utf8");
    expectBothAcceptAlike(raw, name);
  });

  it("agrees on a synthetic document exercising every construct", () => {
    const engine = expectBothAcceptAlike(SYNTHETIC, "full-corpus");
    // The synthetic doc really does cover the grammar: all seven fields set…
    expect(engine.continueOnError).toBe(true);
    expect(engine.stepTimeoutMs).toBe(60000);
    expect(engine.maxStepRetries).toBe(2);
    expect(engine.budgetUsd).toBe(12.5);
    expect(engine.budgetTokens).toBe(250000);
    // …and a labelled parallel stage between two `[tag] @role` singles.
    expect(engine.stages.map((stage) => stage.parallel)).toEqual([false, true, false]);
    expect(engine.stages[1]?.label).toBe("Fan out:");
    expect(engine.stages[0]?.steps[0]).toMatchObject({
      modelTag: "tier:cheap",
      agent: "architect",
    });
  });

  it.each([
    ...KIT_FILES.map(({ name, file }) => ({ name, raw: readFileSync(file, "utf8") })),
    { name: "full-corpus", raw: SYNTHETIC },
  ])(
    "the engine reads the mirror's serialisation of $name as the same workflow",
    ({ name, raw }) => {
      const fromRaw = parseWorkflow(raw, { name });
      if (isWorkflowParseError(fromRaw)) throw new Error(`engine rejected: ${fromRaw.error}`);
      const mirror = parseWorkflowDoc(raw, { name });
      if (isWorkflowDocError(mirror)) throw new Error(`mirror rejected: ${mirror.error}`);
      const fromSerialized = parseWorkflow(serializeWorkflowDoc(mirror.doc), { name });
      if (isWorkflowParseError(fromSerialized)) {
        throw new Error(`engine rejected the serialisation: ${fromSerialized.error}`);
      }
      expect(fromSerialized).toEqual(fromRaw);
    },
  );
});

// -------------------------------------------------------------- error corpus

interface ErrorCase {
  case: string;
  raw: string;
  /** Passed to BOTH parsers; defaults to a usable stem name. */
  defaults?: { name?: string };
}

const ERROR_CORPUS: ErrorCase[] = [
  { case: "bad numbering", raw: "---\nname: x\n---\n1. a\n3. b" },
  { case: "top-level bullet", raw: "---\nname: x\n---\n- top level" },
  {
    case: "reversed tag/role order",
    raw: "---\nname: x\n---\n1. @architect [tier:judgment] design it",
  },
  { case: "unknown placeholder", raw: "---\nname: x\n---\n1. use {{previous}}" },
  { case: "prev in stage 1", raw: "---\nname: x\n---\nprose first\n1. use {{prev}}" },
  { case: "journal in stage 1", raw: "---\nname: x\n---\n1. use {{journal}}" },
  { case: "invalid tag charset", raw: "---\nname: x\n---\n1. [x y] go" },
  { case: "invalid role charset", raw: "---\nname: x\n---\n1. @-oops go" },
  { case: "empty tag", raw: "---\nname: x\n---\n1. [] empty" },
  { case: "empty role", raw: "---\nname: x\n---\n1. @ nothing" },
  { case: "tag but no prompt", raw: "---\nname: x\n---\n1. [tier:x]" },
  { case: "role but no prompt", raw: "---\nname: x\n---\n1. @dev" },
  { case: "bare stage line", raw: "---\nname: x\n---\n1." },
  { case: "orphan branch", raw: "---\nname: x\n---\n   - orphan branch" },
  { case: "star bullet branch", raw: "---\nname: x\n---\n1. lanes:\n   * star bullet" },
  { case: "empty branch prompt", raw: "---\nname: x\n---\n1. lanes:\n   -" },
  { case: "prompt plus branches, no colon", raw: "---\nname: x\n---\n1. a prompt\n   - branch" },
  { case: "stray continuation line", raw: "---\nname: x\n---\n1. a step\nstray text" },
  { case: "no steps", raw: "---\nname: x\n---\nno steps here" },
  { case: "bad continueOnError", raw: "---\nname: x\ncontinueOnError: yes\n---\n1. go" },
  { case: "bad stepTimeoutMs", raw: "---\nname: x\nstepTimeoutMs: 0\n---\n1. go" },
  { case: "bad maxStepRetries", raw: "---\nname: x\nmaxStepRetries: -1\n---\n1. go" },
  { case: "bad budgetUsd", raw: "---\nname: x\nbudgetUsd: lots\n---\n1. go" },
  { case: "bad budgetTokens", raw: "---\nname: x\nbudgetTokens: 3.5\n---\n1. go" },
  { case: "no usable name", raw: "1. go", defaults: {} },
  { case: "name normalises to nothing", raw: "---\nname: '!!!'\n---\n1. go", defaults: {} },
];

describe("rejected documents fail identically, error strings included", () => {
  it.each(ERROR_CORPUS)("agrees on $case", ({ raw, defaults }) => {
    const engine = parseWorkflow(raw, defaults ?? { name: "corpus" });
    const mirror = parseWorkflowDoc(raw, defaults ?? { name: "corpus" });
    if (!isWorkflowParseError(engine)) throw new Error("expected the engine to reject");
    if (!isWorkflowDocError(mirror)) throw new Error("expected the mirror to reject");
    expect(mirror.error).toBe(engine.error);
  });
});

// ----------------------------------------- prompt-prefix collisions, for real

/**
 * The engine as the oracle for the builder's collision warnings: serialise a
 * document whose prompt begins with a prefix shape and show the real parser
 * re-reads (or rejects) it exactly as `validateWorkflowDoc` predicts.
 */
describe("prompt-prefix collisions against the real engine", () => {
  const solo = (step: { modelTag?: string; role?: string; prompt: string }): WorkflowDoc => ({
    frontmatter: { name: "x" },
    preamble: "",
    stages: [{ parallel: false, steps: [step] }],
  });

  it("reads '@here …' from an empty role field as a role, as flagged", () => {
    const doc = solo({ prompt: "@here is the summary to send" });
    const engine = parseWorkflow(serializeWorkflowDoc(doc), { name: "x" });
    if (isWorkflowParseError(engine)) throw new Error(`engine rejected: ${engine.error}`);
    expect(engine.stages[0]?.steps[0]?.agent).toBe("here");
    expect(engine.stages[0]?.steps[0]?.prompt).toBe("is the summary to send");
    expect(
      validateWorkflowDoc(doc).some(
        (issue) => issue.severity === "error" && issue.message.includes('"@here"'),
      ),
    ).toBe(true);
  });

  it("hard-errors on a set role followed by a leading '[RFC-1]', as flagged", () => {
    const doc = solo({ role: "qa", prompt: "[RFC-1] verify the fix" });
    const engine = parseWorkflow(serializeWorkflowDoc(doc), { name: "x" });
    if (!isWorkflowParseError(engine)) throw new Error("expected the engine to reject");
    expect(engine.error).toContain("a model tag must come before the role");
    expect(
      validateWorkflowDoc(doc).some(
        (issue) =>
          issue.severity === "error" && issue.message.includes("a model tag must come before"),
      ),
    ).toBe(true);
  });

  it("reads a leading '[RFC-1]' from an empty tag field as the model tag, as flagged", () => {
    const doc = solo({ prompt: "[RFC-1] verify the fix" });
    const engine = parseWorkflow(serializeWorkflowDoc(doc), { name: "x" });
    if (isWorkflowParseError(engine)) throw new Error(`engine rejected: ${engine.error}`);
    expect(engine.stages[0]?.steps[0]?.modelTag).toBe("RFC-1");
    expect(engine.stages[0]?.steps[0]?.prompt).toBe("verify the fix");
    expect(
      validateWorkflowDoc(doc).some(
        (issue) => issue.severity === "error" && issue.message.includes('"[RFC-1]"'),
      ),
    ).toBe(true);
  });
});
