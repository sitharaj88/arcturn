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
  readonly contract?: string;
  readonly judges?: number;
  readonly race?: readonly string[];
  readonly prompt: string;
}

/** The engine's `WorkflowContract`, as far as parity compares it. */
interface EngineContract {
  readonly name: string;
  readonly line: number;
  readonly fields: readonly {
    readonly name: string;
    readonly optional: boolean;
    readonly type: { readonly kind: string; readonly values?: readonly string[] };
  }[];
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
  readonly contracts: ReadonlyMap<string, EngineContract>;
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
      // The stage-line options.
      expect(mirroredStep?.contract).toBe(step.contract);
      expect(mirroredStep?.judges).toBe(step.judges);
      expect(mirroredStep?.race).toEqual(step.race);
    });
  });

  // Contract declarations: same names in the same order, same fields. The
  // mirror keeps no line number (an editor addresses a contract by name), so
  // that one field is compared against the engine only for presence.
  const mirroredContracts = doc.contracts ?? [];
  expect(mirroredContracts.map((entry) => entry.name)).toEqual([...engine.contracts.keys()]);
  for (const contract of mirroredContracts) {
    const declared = engine.contracts.get(contract.name);
    expect(declared).toBeDefined();
    expect(declared?.line).toBeGreaterThan(0);
    expect(contract.fields).toEqual(declared?.fields);
  }
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

/**
 * Every frontmatter key, a labelled parallel stage, `[tier:x] @role`, every
 * placeholder, all three stage-line options, and a contract declaration whose
 * fields cover every type the grammar has.
 */
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
  "3. [contract:release-verdict] [judges:3] @lead assemble {{prev}}",
  "4. [race:tier:cheap|tier:fast] act on {{contract.decision}} given {{contract}}",
  "",
  "```contract release-verdict",
  "decision: SHIP | SHIP-WITH-FIXES | DO-NOT-SHIP",
  "reasons: string[]",
  "blockers?: string[]",
  "confidence: number",
  "counts: number[]",
  "settled?: boolean",
  "rounds: integer",
  "```",
].join("\n");

/** A workflow with every contract's fence line blanked, for round-trip compare. */
function forget(workflow: Workflow): unknown {
  return {
    ...workflow,
    contracts: new Map(
      [...workflow.contracts].map(([name, contract]) => [name, { ...contract, line: 0 }]),
    ),
  };
}

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
    expect(engine.stages.map((stage) => stage.parallel)).toEqual([false, true, false, false]);
    expect(engine.stages[1]?.label).toBe("Fan out:");
    expect(engine.stages[0]?.steps[0]).toMatchObject({
      modelTag: "tier:cheap",
      agent: "architect",
    });
    // …and every stage-line option, read onto the step it was written on.
    expect(engine.stages[2]?.steps[0]).toMatchObject({
      contract: "release-verdict",
      judges: 3,
      agent: "lead",
    });
    expect(engine.stages[3]?.steps[0]?.race).toEqual(["tier:cheap", "tier:fast"]);
    expect(engine.stages[3]?.steps[0]?.modelTag).toBeUndefined();
    // …and the contract, with every field type the grammar has.
    const declared = engine.contracts.get("release-verdict");
    expect(declared?.fields.map((field) => field.type.kind)).toEqual([
      "enum",
      "string[]",
      "string[]",
      "number",
      "number[]",
      "boolean",
      "integer",
    ]);
    expect(declared?.fields.find((field) => field.name === "blockers")?.optional).toBe(true);
    expect(declared?.fields[0]?.type.values).toEqual(["SHIP", "SHIP-WITH-FIXES", "DO-NOT-SHIP"]);
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
      // A contract's `line` is where its fence sits in THAT file, and the
      // mirror is free to move a declaration when it re-emits one; everything
      // else must be identical, the contract's fields included.
      expect(forget(fromSerialized)).toEqual(forget(fromRaw));
    },
  );
});

// -------------------------------------------------------------- error corpus

/** Frontmatter plus a one-field contract named `v`, for the option cases. */
const DECL = ["---", "name: x", "---", "```contract v", "a: string", "```", ""].join("\n");

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

  // --- stage-line options ---------------------------------------------------
  { case: "duplicate option key", raw: `${DECL}1. [judges:2] [judges:3] @qa go` },
  { case: "options with no prompt", raw: `${DECL}1. [contract:v]` },
  { case: "option after the role", raw: `${DECL}1. @qa [contract:v] go` },
  { case: "bad contract name", raw: "---\nname: x\n---\n1. [contract:V] @qa go" },
  { case: "bad judges count", raw: "---\nname: x\n---\n1. [judges:4] @qa go" },
  { case: "judges without a role", raw: `${DECL}1. [judges:2] [contract:v] go` },
  { case: "judges without a contract", raw: "---\nname: x\n---\n1. [judges:2] @qa go" },
  { case: "judges with race", raw: `${DECL}1. [race:a|b] [judges:2] [contract:v] @qa go` },
  { case: "race with a model tag", raw: "---\nname: x\n---\n1. [tier:x] [race:a|b] go" },
  { case: "race of one", raw: "---\nname: x\n---\n1. [race:solo] go" },
  { case: "race of four", raw: "---\nname: x\n---\n1. [race:a|b|c|d] go" },
  { case: "race with a bad tag", raw: "---\nname: x\n---\n1. [race:a|b c] go" },
  { case: "race repeating a tag", raw: "---\nname: x\n---\n1. [race:a|a] go" },
  { case: "undeclared contract", raw: "---\nname: x\n---\n1. [contract:missing] @qa go" },

  // --- contract declarations ------------------------------------------------
  { case: "nameless contract", raw: "---\nname: x\n---\n```contract\na: string\n```\n1. go" },
  {
    case: "badly named contract",
    raw: "---\nname: x\n---\n```contract V\na: string\n```\n1. go",
  },
  {
    case: "duplicate contract",
    raw: `${DECL}\`\`\`contract v\nb: string\n\`\`\`\n1. go`,
  },
  { case: "empty contract", raw: "---\nname: x\n---\n```contract v\n# nothing\n```\n1. go" },
  { case: "unterminated contract", raw: "---\nname: x\n---\n```contract v\na: string\n1. go" },
  {
    case: "malformed contract field",
    raw: "---\nname: x\n---\n```contract v\njust prose\n```\n1. go",
  },
  {
    case: "bad contract field name",
    raw: "---\nname: x\n---\n```contract v\n2a: string\n```\n1. go",
  },
  {
    case: "duplicate contract field",
    raw: "---\nname: x\n---\n```contract v\na: string\na: number\n```\n1. go",
  },
  {
    case: "unknown contract type",
    raw: "---\nname: x\n---\n```contract v\na: nope\n```\n1. go",
  },
  {
    case: "bad enum value",
    raw: "---\nname: x\n---\n```contract v\na: A | 2B\n```\n1. go",
  },
  {
    case: "duplicate enum value",
    raw: "---\nname: x\n---\n```contract v\na: A | B | A\n```\n1. go",
  },

  // --- contract placeholders ------------------------------------------------
  { case: "{{contract}} in stage 1", raw: "---\nname: x\n---\n1. use {{contract}}" },
  { case: "{{contract.f}} in stage 1", raw: "---\nname: x\n---\n1. use {{contract.a}}" },
  {
    case: "{{contract}} with no carrier",
    raw: "---\nname: x\n---\n1. plan it\n2. use {{contract}}",
  },
  {
    case: "{{contract.f}} after a parallel stage",
    raw: `${DECL}1. Fan out:\n   - [contract:v] @qa judge\n   - probe\n2. use {{contract.a}}`,
  },
  {
    case: "{{contract.f}} naming no field",
    raw: `${DECL}1. [contract:v] @qa judge\n2. use {{contract.nope}}`,
  },
  { case: "malformed contract placeholder", raw: "---\nname: x\n---\n1. use {{contract.}}" },
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
