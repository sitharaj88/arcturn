/**
 * ADVERSARIAL AUDIT of the four just-landed org-runtime-v2 features:
 * question-gate pause/resume, router tiers, enforced budgets, and untracked-file
 * seeding.
 *
 * Discipline of this file (identical to worktree-escape.review.test.ts):
 *   - Every `it` was run against the code AS LANDED.
 *   - A test that FAILS is a FINDING: it asserts the behaviour the feature
 *     PROMISES and the current code breaks.
 *   - A test that PASSES is a REFUTATION kept on purpose: an escape route that
 *     was tried and is genuinely closed, so the next auditor need not re-walk it.
 *
 * New file only — nothing existing is edited.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ModelSpec, Usage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { createModelRouter } from "./router.js";
import {
  createRuntimeWriteLane,
  isWorkflowParseError,
  parseWorkflow,
  runWorkflow,
  type Workflow,
  type WorkflowPatchRecord,
  type WorkflowStepRequest,
  type WriteLaneHost,
} from "./workflow.js";
import {
  buildResumeState,
  type JournalLine,
  type ResumeState,
  type RunJournal,
} from "./workflow-run.js";

const run = promisify(execFile);

// ------------------------------------------------------------------ scaffolding

function parseOk(raw: string): Workflow {
  const parsed = parseWorkflow(raw, { name: "wf" });
  if (isWorkflowParseError(parsed)) throw new Error(`expected a workflow, got: ${parsed.error}`);
  return parsed;
}

const FRONT = ["---", "name: demo", "description: A demo", "---"].join("\n");

function spend(n: number): Usage {
  return { inputTokens: n, outputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** In-memory journal whose `appendDurable` reaches "disk" synchronously. */
function memoryJournal(): { sink: RunJournal; lines: JournalLine[] } {
  const lines: JournalLine[] = [];
  return {
    lines,
    sink: {
      append: async (line) => void lines.push(line),
      appendDurable: async (line) => void lines.push(line),
    },
  };
}

const modelSpec = (id: string, name: string): ModelSpec =>
  ({ id, provider: "p", displayName: name, capabilities: { tools: true } }) as unknown as ModelSpec;

// ===========================================================================
// FINDING 1 — QUESTION GATE: a parallel stage where TWO steps raise `ORG-ASK`
// answers only ONE of them on resume; the other paused step is neither
// `completed` nor `interrupted`, so it is RE-EXECUTED live.
//
// CLAIM (workflow-run.ts buildResumeState docs, item 4): "an answered pause
// re-writes it as done… a step re-run on one resume and finished appends a
// fresh stepEnd". And runWorkflow's resume contract: a settled step is never
// redone. Both are broken for the SIBLING pause: a pause short-circuits the
// rest of the run, so only the FIRST paused step is captured as `pending`, but
// BOTH were journalled `stepEnd{status:"paused"}`. On resume the sibling — with
// a terminal line but no `done`/`applied` record — falls through every splice
// branch and runs again. A settled step re-runs; if it carries an irreversible
// side effect (a write-lane apply, an exec-lane deploy) that side effect fires
// a SECOND time — the exact double-apply class the resume machinery exists to
// prevent, reopened through the human-question gate.
// ===========================================================================
describe("FINDING 1: resume re-executes a parallel stage's non-pending ORG-ASK sibling", () => {
  it("does not re-run (or repeat the side effect of) the paused sibling on resume", async () => {
    const wf = parseOk(
      [FRONT, "1.", "   - Ask A {{input}}", "   - Ask B {{input}}", "2. after {{prev}}"].join("\n"),
    );

    // Each ask step performs an irreversible side effect on EVERY invocation
    // (model it as "applied a change to the checkout") and asks the first time,
    // then settles the second time. A correct resume runs each ask step exactly
    // once across the whole run.
    const invocations = new Map<string, number>();
    const sideEffects: string[] = [];
    const runStep = async (r: WorkflowStepRequest) => {
      if (r.step.id.startsWith("1.")) {
        const n = (invocations.get(r.step.id) ?? 0) + 1;
        invocations.set(r.step.id, n);
        sideEffects.push(r.step.id); // the irreversible act — fires on every run
        if (n === 1) {
          return {
            text: `ORG-ASK: which for ${r.step.id}?`,
            usage: spend(1),
            isError: false as const,
          };
        }
        return { text: `settled ${r.step.id}`, usage: spend(1), isError: false as const };
      }
      return { text: "after", usage: spend(1), isError: false as const };
    };

    const mem = memoryJournal();
    const first = await runWorkflow(wf, { runStep, journal: mem.sink });
    expect(first.status).toBe("paused");
    // Both parallel steps paused and were journalled as such.
    const pausedIds = mem.lines
      .filter(
        (l): l is Extract<JournalLine, { kind: "stepEnd" }> =>
          l.kind === "stepEnd" && l.status === "paused",
      )
      .map((l) => l.id)
      .sort();
    expect(pausedIds).toEqual(["1.1", "1.2"]);

    const state = buildResumeState(mem.lines);
    const pendingId = state.pending?.stepId;
    expect(pendingId).toBeDefined();
    const siblingId = pendingId === "1.1" ? "1.2" : "1.1";

    // Resume with the human's answer to whichever step the gate surfaced.
    const answered: ResumeState = {
      ...state,
      answer: { stepId: pendingId as string, text: "the human answer" },
    };
    const second = await runWorkflow(wf, {
      runStep,
      journal: mem.sink,
      resumeFrom: answered,
      input: "",
    });

    // The answered step must NOT re-run (it is spliced with the answer).
    expect(invocations.get(pendingId as string)).toBe(1);
    // THE BUG: the sibling paused step is re-executed on resume — a settled step
    // redone, its irreversible side effect fired a SECOND time.
    expect(invocations.get(siblingId)).toBe(1); // FAILS: it is 2
    // Each ask step's side effect must have happened exactly once, all run.
    expect(sideEffects.filter((id) => id === siblingId)).toHaveLength(1); // FAILS: length 2
    expect(second.status).toBe("done");
  });
});

// ===========================================================================
// FINDING 2 — ROUTER TIERS/ROUTES: after `rebind`, a route whose configured id
// fails to resolve returns the NEW fallback (correct) but the recorded warning
// still names the PRE-rebind fallback.
//
// CLAIM (router.ts createModelRouter): rebind "drop[s] cached resolutions and
// adopt a new fallback — call after the session's main model changes, or routes
// that defaulted to the old one keep resolving to it." The resolution is fixed;
// the operator-facing warning is not — `resolveConfigured` returns `active`
// (the rebound model) but interpolates the closure-captured `fallback` into the
// message. An operator reading "/model route" after switching models is told
// the route fell back to a model it is no longer using.
// ===========================================================================
describe("FINDING 2: rebind leaves the fallback warning naming the old model", () => {
  it("names the current fallback, not the pre-rebind one", () => {
    const resolve = (id: string): ModelSpec => {
      throw new Error(`no such model ${id}`);
    };
    const router = createModelRouter(
      { subagent: "deregistered/model" },
      resolve,
      modelSpec("old/main", "OldMain"),
    );
    router.rebind(modelSpec("new/main", "NewMain"));

    const spec = router.specFor("subagent");
    // Resolution is correct: the rebound fallback wins.
    expect(spec.displayName).toBe("NewMain");
    // THE BUG: the warning still advertises the pre-rebind fallback.
    expect(router.warnings().join("\n")).toContain("NewMain"); // FAILS: says "OldMain"
    expect(router.warnings().join("\n")).not.toContain("OldMain");
  });
});

// ===========================================================================
// FINDING 3 — QUESTION GATE × WORKTREE SEEDING: a write-lane step that BOTH
// applied its patch AND raised `ORG-ASK` is reclassified to `paused` WITHOUT
// clearing its applied patch record. On resume-with-answer the step is
// completed with the human's answer (status done, NO record), so the applied
// patch it really landed is DROPPED from the run's reconstructed
// `appliedPatches` — the very list a later stage's worktree is seeded from.
//
// CLAIM (workflow.ts): "Only a patch that actually landed becomes part of the
// run's state" and a later stage is seeded with "this run's applied patches in
// order". The paused-write step's applied patch satisfies the first rule (it is
// in the checkout — buildResumeState even forces it into `completed` for that
// reason) yet is absent from the seed a downstream role receives. The next
// role is handed a base that omits a change that genuinely landed.
// ===========================================================================
describe("FINDING 3: answer-resume drops a paused-write step's applied patch from the seed", () => {
  it("keeps the applied patch in the downstream stage's appliedPatches", async () => {
    const wf = parseOk([FRONT, "1. write-and-ask {{input}}", "2. later {{prev}}"].join("\n"));
    const applied: WorkflowPatchRecord = {
      status: "applied",
      role: "",
      stepId: "1",
      files: 1,
      patchPath: "/tmp/landed.patch",
    };
    let seedForStage2: readonly string[] | undefined;
    const runStep = async (r: WorkflowStepRequest) => {
      if (r.step.id === "1") {
        // Landed a patch AND asked a question in the same turn.
        return {
          text: "ORG-ASK: keep going?",
          usage: spend(1),
          isError: false as const,
          record: applied,
        };
      }
      seedForStage2 = r.state?.appliedPatches;
      return { text: "later", usage: spend(1), isError: false as const };
    };

    const mem = memoryJournal();
    const first = await runWorkflow(wf, { runStep, journal: mem.sink });
    expect(first.status).toBe("paused");

    const state = buildResumeState(mem.lines);
    // buildResumeState itself files the paused-write step under BOTH maps.
    expect(state.completed.has("1")).toBe(true);
    expect(state.pending?.stepId).toBe("1");

    const answered: ResumeState = { ...state, answer: { stepId: "1", text: "yes" } };
    const second = await runWorkflow(wf, {
      runStep,
      journal: mem.sink,
      resumeFrom: answered,
      input: "",
    });
    expect(second.status).toBe("done");

    // THE BUG: the patch that actually landed is gone from the downstream seed.
    expect(seedForStage2).toContain("/tmp/landed.patch"); // FAILS: seed is []
  });
});

// ===========================================================================
// REFUTATIONS — escape routes tried and found genuinely closed. Kept PASSING so
// the next auditor does not re-walk them.
// ===========================================================================
describe("REFUTED: a write step that landed BEFORE the pause is not re-run on answer-resume", () => {
  it("splices the earlier write from `completed`, never re-executing it", async () => {
    const wf = parseOk(
      [FRONT, "1. write {{input}}", "2. ask {{prev}}", "3. after {{prev}}"].join("\n"),
    );
    const applied: WorkflowPatchRecord = {
      status: "applied",
      role: "",
      stepId: "1",
      files: 1,
      patchPath: "/tmp/w.patch",
    };
    const calls: string[] = [];
    const runStep = async (r: WorkflowStepRequest) => {
      calls.push(r.step.id);
      if (r.step.id === "1")
        return { text: "wrote", usage: spend(1), isError: false as const, record: applied };
      if (r.step.id === "2")
        return { text: "ORG-ASK: proceed?", usage: spend(1), isError: false as const };
      return { text: "after", usage: spend(1), isError: false as const };
    };
    const mem = memoryJournal();
    const first = await runWorkflow(wf, { runStep, journal: mem.sink });
    expect(first.status).toBe("paused");

    const state = buildResumeState(mem.lines);
    calls.length = 0;
    const answered: ResumeState = {
      ...state,
      answer: { stepId: state.pending!.stepId, text: "yes" },
    };
    const second = await runWorkflow(wf, {
      runStep,
      journal: mem.sink,
      resumeFrom: answered,
      input: "",
    });
    expect(second.status).toBe("done");
    // Step 1 (the applied write) was NOT re-run; only the post-pause stage did.
    expect(calls).not.toContain("1");
    expect(calls).toEqual(["3"]);
  });
});

describe("REFUTED: a run-level budget breach in the pausing stage beats the pause", () => {
  it("reports failed (budget), never a resumable pause, when both trip together", async () => {
    const wf = parseOk(
      [FRONT, "1.", "   - burn {{input}}", "   - ask {{input}}", "2. after {{prev}}"].join("\n"),
    );
    const runStep = async (r: WorkflowStepRequest) => {
      if (r.step.id === "1.1")
        return { text: "burned", usage: { ...spend(1), costUsd: 100 }, isError: false as const };
      if (r.step.id === "1.2")
        return {
          text: "ORG-ASK: really?",
          usage: { ...spend(1), costUsd: 0 },
          isError: false as const,
        };
      return { text: "after", usage: spend(1), isError: false as const };
    };
    // budgetUsd is not a parse key exposed on Workflow here via frontmatter in
    // this harness; drive the same guard by asserting the documented precedence
    // through the result path: a failure set alongside a pause reports failed.
    const withBudget: Workflow = { ...wf, budgetUsd: 1 };
    const mem = memoryJournal();
    const result = await runWorkflow(withBudget, { runStep, journal: mem.sink });
    expect(result.status).toBe("failed");
    expect(result.error ?? "").toMatch(/budget/i);
  });
});

// ------- worktree untracked seeding (real git repo) --------------------------

const seedModel = modelSpec("m", "M");
async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-seed-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "a@b.c"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "tracked.txt"), "committed\n");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}
function seedHost(cwd: string, home: string): WriteLaneHost {
  return {
    cwd,
    paths: { home },
    router: { specFor: () => seedModel },
    buildSessionAgent: () => ({}) as never,
  };
}

describe("REFUTED: untracked seeding does not carry a symlink into the worktree", () => {
  it("skips an untracked symlink, copies a plain untracked file", async () => {
    const repo = await gitRepo();
    const home = await mkdtemp(join(tmpdir(), "arc-home-"));
    await symlink("/etc/passwd", join(repo, "sneaky-link"));
    await writeFile(join(repo, "scratch.txt"), "hello\n");
    const lane = createRuntimeWriteLane(seedHost(repo, home), "run-symlink");
    const wt = await lane.createWorktree("s1", { patches: [] });
    try {
      expect(existsSync(join(wt.dir, "scratch.txt"))).toBe(true);
      expect(existsSync(join(wt.dir, "sneaky-link"))).toBe(false);
    } finally {
      await wt.remove();
    }
  });
});

describe("REFUTED: untracked seeding respects .gitignore (a gitignored .env stays out)", () => {
  it("excludes a gitignored secret, includes a non-ignored file", async () => {
    const repo = await gitRepo();
    const home = await mkdtemp(join(tmpdir(), "arc-home-"));
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await run("git", ["add", ".gitignore"], { cwd: repo });
    await run("git", ["commit", "-qm", "ignore"], { cwd: repo });
    await writeFile(join(repo, ".env"), "SECRET=hunter2\n");
    await writeFile(join(repo, "public.txt"), "ok\n");
    const lane = createRuntimeWriteLane(seedHost(repo, home), "run-env");
    const wt = await lane.createWorktree("s1", { patches: [] });
    try {
      expect(existsSync(join(wt.dir, ".env"))).toBe(false);
      expect(existsSync(join(wt.dir, "public.txt"))).toBe(true);
    } finally {
      await wt.remove();
    }
  });
});

describe("REFUTED: seeding does not double-count an untracked file a role's patch modifies", () => {
  it("shows the modified content once, not duplicated, in the next stage's seed", async () => {
    const repo = await gitRepo();
    const home = await mkdtemp(join(tmpdir(), "arc-home-"));
    await writeFile(join(repo, "data.txt"), "line1\nline2\n"); // untracked before the run
    const lane = createRuntimeWriteLane(seedHost(repo, home), "run-dc");
    const wt1 = await lane.createWorktree("s1", { patches: [] });
    expect(readFileSync(join(wt1.dir, "data.txt"), "utf8")).toBe("line1\nline2\n");
    await writeFile(join(wt1.dir, "data.txt"), "line1\nLINE2\n"); // the role's edit
    const diff = (await run("git", ["diff", wt1.baseRef as string], { cwd: wt1.dir })).stdout;
    const patchDir = join(home, "workflow-runs", "run-dc");
    await mkdir(patchDir, { recursive: true });
    const patchPath = join(patchDir, "s1.patch");
    await writeFile(patchPath, diff);
    await wt1.remove();
    const wt2 = await lane.createWorktree("s2", { patches: [patchPath] });
    try {
      expect(readFileSync(join(wt2.dir, "data.txt"), "utf8")).toBe("line1\nLINE2\n");
    } finally {
      await wt2.remove();
    }
  });
});
