import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildResumeState,
  classifyFailureKind,
  createFileRunJournal,
  decideInterruptedStep,
  failureKindFromAIError,
  hashPatch,
  hashPrompt,
  type InterruptedStep,
  isGitLockError,
  type JournalLine,
  RUN_JOURNAL_FILE,
  RUN_JOURNAL_SCHEMA_VERSION,
  readJournalLines,
  readManifest,
  writeManifest,
} from "./workflow-run.js";

function usage(inputTokens = 1, outputTokens = 2): Usage {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-journal-"));
  scratches.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    scratches
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

describe("createFileRunJournal", () => {
  it("appends one JSON object per line and reads them back in order", async () => {
    const dir = await scratch();
    const journal = createFileRunJournal(dir);
    await journal.append({
      kind: "run",
      v: RUN_JOURNAL_SCHEMA_VERSION,
      runId: "R1",
      workflow: "ship",
      source: "/ship.md",
      input: "in",
      stepTimeoutMs: 600000,
      maxStepRetries: 2,
      startedAt: 1,
    });
    await journal.append({ kind: "stageStart", stage: 1, parallel: false, steps: 1, ts: 2 });
    const lines = await readJournalLines(dir);
    expect(lines.map((l) => l.kind)).toEqual(["run", "stageStart"]);
    const raw = await readFile(join(dir, RUN_JOURNAL_FILE), "utf8");
    // Exactly two newline-terminated lines, each valid JSON.
    expect(raw.split("\n").filter((s) => s !== "")).toHaveLength(2);
  });

  it("serializes concurrent appends without interleaving", async () => {
    const dir = await scratch();
    const journal = createFileRunJournal(dir);
    // Fire many appends without awaiting each — the write queue must still
    // produce whole, parseable lines in submission order.
    await Promise.all(
      Array.from({ length: 25 }, (_v, i) =>
        journal.append({ kind: "budget", usage: usage(i, i), ts: i }),
      ),
    );
    const lines = await readJournalLines(dir);
    expect(lines).toHaveLength(25);
    expect(lines.every((l) => l.kind === "budget")).toBe(true);
  });

  it("never rejects when the directory cannot be created", async () => {
    // A path whose parent is a file cannot be a directory; the append must
    // swallow the failure and still resolve (a journal never fails a run).
    const dir = await scratch();
    const filePath = join(dir, "not-a-dir");
    await writeFile(filePath, "x", "utf8");
    const journal = createFileRunJournal(join(filePath, "under-a-file"));
    await expect(
      journal.append({ kind: "runEnd", status: "done", ts: 1 }),
    ).resolves.toBeUndefined();
  });

  it("tolerates a torn final line on read (crash mid-append)", async () => {
    const dir = await scratch();
    const journal = createFileRunJournal(dir);
    await journal.append({ kind: "stageStart", stage: 1, parallel: false, steps: 1, ts: 1 });
    // Simulate a crash that left a half-written final line.
    await writeFile(join(dir, RUN_JOURNAL_FILE), '{"kind":"stageStart","stage":1,', {
      flag: "a",
    });
    const lines = await readJournalLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe("stageStart");
  });

  it("returns [] for a run directory that has no journal", async () => {
    const dir = await scratch();
    expect(await readJournalLines(dir)).toEqual([]);
  });
});

describe("writeManifest / readManifest", () => {
  it("round-trips a run manifest", async () => {
    const dir = await scratch();
    await writeManifest(dir, {
      v: RUN_JOURNAL_SCHEMA_VERSION,
      runId: "R1",
      workflow: "ship",
      source: "/ship.md",
      input: "in",
      stepTimeoutMs: 600000,
      maxStepRetries: 2,
      startedAt: 42,
    });
    const back = await readManifest(dir);
    expect(back?.runId).toBe("R1");
    expect(back?.workflow).toBe("ship");
    expect(back?.startedAt).toBe(42);
  });

  it("returns undefined for a missing manifest", async () => {
    const dir = await scratch();
    expect(await readManifest(dir)).toBeUndefined();
  });
});

describe("buildResumeState", () => {
  const header: JournalLine = {
    kind: "run",
    v: 1,
    runId: "R1",
    workflow: "ship",
    source: "/ship.md",
    input: "in",
    stepTimeoutMs: 600000,
    maxStepRetries: 2,
    startedAt: 1,
  };
  const done = (id: string, stage: number, text: string, patchPath?: string): JournalLine => ({
    kind: "stepEnd",
    id,
    stage,
    branch: 0,
    status: "done",
    usage: usage(),
    text,
    promptHash: hashPrompt(`p${id}`),
    attempts: 1,
    startedAt: 1,
    endedAt: 2,
    ...(patchPath === undefined
      ? {}
      : { record: { status: "applied", role: "developer", stepId: id, files: 1, patchPath } }),
  });

  it("treats only `done` steps as complete and carries their patch + text", () => {
    const state = buildResumeState([
      header,
      done("1", 1, "first out", "/runs/R1/1-developer.patch"),
    ]);
    expect(state.runId).toBe("R1");
    expect(state.workflow).toBe("ship");
    expect([...state.completed.keys()]).toEqual(["1"]);
    const step = state.completed.get("1");
    expect(step?.text).toBe("first out");
    expect(step?.record?.patchPath).toBe("/runs/R1/1-developer.patch");
    expect(state.ended).toBe(false);
  });

  it("does NOT treat a dangling stepStart (the crash point) as complete", () => {
    const state = buildResumeState([
      header,
      done("1", 1, "first out"),
      { kind: "stepStart", id: "2", stage: 2, branch: 0, promptHash: hashPrompt("p2"), ts: 3 },
    ]);
    expect([...state.completed.keys()]).toEqual(["1"]);
    expect(state.completed.has("2")).toBe(false);
  });

  it("does NOT treat failed/cancelled/skipped steps as complete", () => {
    const failed: JournalLine = {
      kind: "stepEnd",
      id: "2",
      stage: 2,
      branch: 0,
      status: "failed",
      usage: usage(),
      text: "",
      promptHash: hashPrompt("p2"),
      attempts: 3,
      startedAt: 1,
      endedAt: 2,
    };
    const state = buildResumeState([header, done("1", 1, "a"), failed]);
    expect([...state.completed.keys()]).toEqual(["1"]);
  });

  it("lets a later stepEnd win (a resumed step re-run and finished)", () => {
    const first: JournalLine = {
      kind: "stepEnd",
      id: "2",
      stage: 2,
      branch: 0,
      status: "failed",
      usage: usage(),
      text: "",
      promptHash: hashPrompt("p2"),
      attempts: 1,
      startedAt: 1,
      endedAt: 2,
    };
    const state = buildResumeState([header, first, done("2", 2, "healed")]);
    expect(state.completed.get("2")?.text).toBe("healed");
  });

  it("marks a run ended when a runEnd line is present", () => {
    const state = buildResumeState([
      header,
      done("1", 1, "a"),
      { kind: "runEnd", status: "done", ts: 9 },
    ]);
    expect(state.ended).toBe(true);
    expect(state.endedStatus).toBe("done");
  });

  // The human-question gate: a `paused` terminal is neither complete nor
  // interrupted — it is surfaced separately as `pending` so a resume injects an
  // ANSWER rather than re-splicing the question.
  const paused = (id: string, stage: number, question: string): JournalLine => ({
    kind: "stepEnd",
    id,
    stage,
    branch: 0,
    status: "paused",
    usage: usage(),
    text: `ORG-ASK: ${question}`,
    question,
    promptHash: hashPrompt(`p${id}`),
    attempts: 1,
    startedAt: 1,
    endedAt: 2,
  });

  it("surfaces a paused stepEnd as `pending`, in neither completed nor interrupted", () => {
    // No runEnd — exactly the durable prefix a crash would leave behind.
    const state = buildResumeState([
      header,
      done("1", 1, "out1"),
      paused("2", 2, "which datastore?"),
    ]);
    expect(state.pending).toMatchObject({ stepId: "2", stage: 2, question: "which datastore?" });
    expect(state.pending?.promptHash).toBe(hashPrompt("p2"));
    // The pause survives the crash without a runEnd, and stage 1 is reusable.
    expect(state.ended).toBe(false);
    expect([...state.completed.keys()]).toEqual(["1"]);
    expect(state.completed.has("2")).toBe(false);
    expect(state.interrupted.has("2")).toBe(false);
  });

  it("clears `pending` once the paused step is answered (a later `done` wins)", () => {
    const answered = { ...done("2", 2, "use postgres"), answered: true } as JournalLine;
    const state = buildResumeState([
      header,
      done("1", 1, "out1"),
      paused("2", 2, "which?"),
      answered,
    ]);
    expect(state.pending).toBeUndefined();
    expect(state.completed.get("2")?.text).toBe("use postgres");
  });

  // A PARALLEL stage can raise MORE THAN ONE question: both branches ran to a
  // terminal, and both journalled `stepEnd{paused}`. Every one of them has to
  // be surfaced — a paused step the resume state does not know about is a step
  // the driver treats as unseen and RE-EXECUTES, side effect and all.
  it("surfaces EVERY paused step of a stage: `pendings` in journal order, `pending` first", () => {
    const state = buildResumeState([
      header,
      paused("1.1", 1, "which datastore?"),
      paused("1.2", 1, "which region?"),
    ]);
    expect(state.pendings.map((p) => p.stepId)).toEqual(["1.1", "1.2"]);
    expect(state.pendings[1]).toMatchObject({
      stepId: "1.2",
      stage: 1,
      question: "which region?",
    });
    expect(state.pendings[1]?.promptHash).toBe(hashPrompt("p1.2"));
    // `pending` stays the first question, so every existing reader is unchanged.
    expect(state.pending?.stepId).toBe("1.1");
  });

  it("files each paused terminal under `paused` — a paused step's terminal is KNOWN", () => {
    const landed: JournalLine = {
      ...(paused("1.2", 1, "which region?") as Extract<JournalLine, { kind: "stepEnd" }>),
      record: {
        status: "applied",
        role: "developer",
        stepId: "1.2",
        files: 2,
        patchPath: "/runs/R1/1.2.patch",
      },
    };
    const state = buildResumeState([header, paused("1.1", 1, "which datastore?"), landed]);
    expect([...state.paused.keys()]).toEqual(["1.1", "1.2"]);
    expect(state.paused.get("1.1")).toMatchObject({
      status: "paused",
      question: "which datastore?",
      text: "ORG-ASK: which datastore?",
      promptHash: hashPrompt("p1.1"),
    });
    // A paused step that already applied its patch carries the record here too,
    // so an answer can preserve it instead of dropping it from the run's state.
    expect(state.paused.get("1.2")?.record?.patchPath).toBe("/runs/R1/1.2.patch");
    // Unchanged safety rule: an applied record still forces it into `completed`.
    expect(state.completed.has("1.2")).toBe(true);
  });

  it("drops an answered pause from `paused`/`pendings`, keeping the unanswered one", () => {
    const state = buildResumeState([
      header,
      paused("1.1", 1, "which datastore?"),
      paused("1.2", 1, "which region?"),
      { ...(done("1.1", 1, "use postgres") as JournalLine), answered: true } as JournalLine,
    ]);
    expect([...state.paused.keys()]).toEqual(["1.2"]);
    expect(state.pendings.map((p) => p.stepId)).toEqual(["1.2"]);
    expect(state.pending?.stepId).toBe("1.2");
    expect(state.completed.get("1.1")?.text).toBe("use postgres");
  });
});

describe("classifyFailureKind", () => {
  it("classifies transient kinds", () => {
    for (const kind of ["network", "rateLimit", "overloaded", "timeout", "git-lock"] as const) {
      expect(classifyFailureKind(kind)).toBe("transient");
    }
  });

  it("classifies deterministic kinds (and undefined) as deterministic", () => {
    for (const kind of ["patch-refused", "config", "agent-error", "cancelled"] as const) {
      expect(classifyFailureKind(kind)).toBe("deterministic");
    }
    expect(classifyFailureKind(undefined)).toBe("deterministic");
  });
});

describe("failureKindFromAIError", () => {
  it("lifts the transient LLM kinds and folds the rest to agent-error", () => {
    expect(failureKindFromAIError("network")).toBe("network");
    expect(failureKindFromAIError("rateLimit")).toBe("rateLimit");
    expect(failureKindFromAIError("overloaded")).toBe("overloaded");
    expect(failureKindFromAIError("aborted")).toBe("cancelled");
    expect(failureKindFromAIError("auth")).toBe("agent-error");
    expect(failureKindFromAIError("invalidRequest")).toBe("agent-error");
    expect(failureKindFromAIError("unknown")).toBe("agent-error");
  });
});

describe("isGitLockError", () => {
  it("recognises git lock messages", () => {
    expect(isGitLockError("fatal: Unable to create '/repo/.git/index.lock': File exists")).toBe(
      true,
    );
    expect(isGitLockError("Another git process seems to be running")).toBe(true);
    expect(isGitLockError("patch does not apply")).toBe(false);
  });
});

// ===========================================================================
// THE CRASH WINDOW — a step the previous run STARTED and never durably
// finished. Its side effect (the write lane's `git apply` into the user's real
// checkout) may already have landed, because the apply happens inside the step
// and the `stepEnd` commit is only written after it returns. The old rule for
// this case — "no stepEnd, so run it again" — is a double-apply, so the state
// carries the write-ahead evidence out to the driver instead.
// ===========================================================================

const RUN_HEADER: JournalLine = {
  kind: "run",
  v: RUN_JOURNAL_SCHEMA_VERSION,
  runId: "R1",
  workflow: "ship",
  source: "/ship.md",
  input: "in",
  stepTimeoutMs: 600000,
  maxStepRetries: 2,
  startedAt: 1,
};

/** The step opened. */
function started(id: string): JournalLine {
  return { kind: "stepStart", id, stage: 1, branch: 0, promptHash: hashPrompt(`p${id}`), ts: 2 };
}
/** The runner promised to announce anything irreversible before doing it. */
function guarded(id: string): JournalLine {
  return { kind: "stepIntent", id, stage: 1, branch: 0, attempt: 0, act: "guarded", ts: 3 };
}
/** The irreversible window opened: this patch is about to reach the checkout. */
function applying(id: string, patchPath: string): JournalLine {
  return {
    kind: "stepIntent",
    id,
    stage: 1,
    branch: 0,
    attempt: 0,
    act: "apply",
    patchPath,
    patchHash: hashPatch("DIFF"),
    target: "/repo",
    ts: 4,
  };
}
/** The window closed, one way or the other. */
function settled(id: string, applied: boolean, patchPath: string): JournalLine {
  return {
    kind: "stepEffect",
    id,
    stage: 1,
    branch: 0,
    attempt: 0,
    act: "apply",
    applied,
    patchPath,
    ...(applied
      ? { record: { status: "applied", role: "developer", stepId: id, files: 1, patchPath } }
      : {}),
    ts: 5,
  };
}
/** A terminal line, with an optional patch record. */
function ended(
  id: string,
  status: "done" | "failed",
  record?: { status: "applied" | "refused"; patchPath: string },
): JournalLine {
  return {
    kind: "stepEnd",
    id,
    stage: 1,
    branch: 0,
    status,
    usage: usage(),
    text: `out-${id}`,
    promptHash: hashPrompt(`p${id}`),
    attempts: 1,
    startedAt: 1,
    endedAt: 2,
    ...(record === undefined
      ? {}
      : {
          record: {
            status: record.status,
            role: "developer",
            stepId: id,
            files: 1,
            patchPath: record.patchPath,
          },
        }),
  };
}

describe("buildResumeState — interrupted steps", () => {
  it("carries a dangling stepStart out as interrupted, with nothing assumed about it", () => {
    const state = buildResumeState([RUN_HEADER, started("1")]);
    expect(state.completed.has("1")).toBe(false);
    const step = state.interrupted.get("1");
    // "unknown": the runner never promised to announce irreversible acts, so
    // nothing at all may be inferred about what it did to the checkout.
    expect(step?.act).toBe("unknown");
    expect(step?.promptHash).toBe(hashPrompt("p1"));
    expect(step?.applied).toBeUndefined();
  });

  it("keeps the strongest write-ahead evidence the crash left behind", () => {
    const patch = "/runs/R1/1.patch";
    const open = buildResumeState([RUN_HEADER, started("1"), guarded("1"), applying("1", patch)]);
    expect(open.interrupted.get("1")).toMatchObject({
      act: "apply",
      patchPath: patch,
      patchHash: hashPatch("DIFF"),
      target: "/repo",
    });
    // …and the settlement, when it beat the crash.
    const done = buildResumeState([
      RUN_HEADER,
      started("1"),
      guarded("1"),
      applying("1", patch),
      settled("1", true, patch),
    ]);
    const step = done.interrupted.get("1");
    expect(step?.applied).toBe(true);
    expect(step?.record?.patchPath).toBe(patch);
  });

  it("treats a step that only ever declared `guarded` as safe to re-run", () => {
    const state = buildResumeState([RUN_HEADER, started("1"), guarded("1")]);
    expect(decideInterruptedStep(state.interrupted.get("1") as InterruptedStep).action).toBe(
      "rerun",
    );
  });

  it("closes the window on a stepEnd and re-opens it on a later stepStart", () => {
    const closed = buildResumeState([RUN_HEADER, started("1"), guarded("1"), ended("1", "done")]);
    expect(closed.interrupted.has("1")).toBe(false);
    expect(closed.completed.has("1")).toBe(true);

    // A resume re-ran this step and died inside it: the old terminal no longer
    // describes the step, so it is interrupted again rather than complete.
    const reopened = buildResumeState([
      RUN_HEADER,
      started("1"),
      ended("1", "failed"),
      started("1"),
      guarded("1"),
    ]);
    expect(reopened.completed.has("1")).toBe(false);
    expect(reopened.interrupted.get("1")?.act).toBe("guarded");
  });

  it("never re-runs a step whose terminal says its patch reached the checkout", () => {
    // A step scored `failed` whose record says `applied` is the nastiest shape
    // in this file: the patch IS in the user's tree, so re-running it applies
    // the change twice no matter what the step's own status claims.
    const state = buildResumeState([
      RUN_HEADER,
      ended("1", "failed", {
        status: "applied",
        patchPath: "/runs/R1/1.patch",
      }),
    ]);
    expect(state.completed.get("1")?.status).toBe("failed");
    expect(state.completed.get("1")?.record?.patchPath).toBe("/runs/R1/1.patch");
    expect(state.interrupted.has("1")).toBe(false);

    // A refused patch changed nothing, so that one still re-runs.
    const refused = buildResumeState([
      RUN_HEADER,
      ended("2", "failed", { status: "refused", patchPath: "/runs/R1/2.patch" }),
    ]);
    expect(refused.completed.has("2")).toBe(false);
  });

  it("degrades safely on a torn, truncated or foreign journal", async () => {
    const dir = await scratch();
    const good = [RUN_HEADER, started("1"), applying("1", "/runs/R1/1.patch")]
      .map((line) => JSON.stringify(line))
      .join("\n");
    // A crash mid-append leaves a torn final line; a foreign line and a blank
    // one are the other two things a hand-edited journal grows.
    await writeFile(join(dir, RUN_JOURNAL_FILE), `${good}\n\n{"kind":"stepEff`, "utf8");
    const lines = await readJournalLines(dir);
    const state = buildResumeState(lines);
    const step = state.interrupted.get("1") as InterruptedStep;
    expect(step.act).toBe("apply");
    // The settlement was in the torn line, so it is simply absent — and with no
    // probe available the verdict is the safe one.
    expect(step.applied).toBeUndefined();
    expect(decideInterruptedStep(step).action).toBe("recover");

    // An `apply` intent whose patch path never made it to disk cannot be probed
    // at all; it must not become "re-run it and hope".
    const truncated: InterruptedStep = { id: "9", stage: 1, branch: 0, act: "apply" };
    expect(decideInterruptedStep(truncated).action).toBe("recover");
  });
});

describe("decideInterruptedStep", () => {
  const step = (over: Partial<InterruptedStep>): InterruptedStep => ({
    id: "1",
    stage: 1,
    branch: 0,
    act: "unknown",
    ...over,
  });

  it("re-runs only on positive evidence that nothing landed", () => {
    expect(decideInterruptedStep(step({ act: "guarded" })).action).toBe("rerun");
    expect(decideInterruptedStep(step({ act: "apply", applied: false })).action).toBe("rerun");
    expect(
      decideInterruptedStep(step({ act: "apply", patchPath: "/p" }), "not-applied").action,
    ).toBe("rerun");
  });

  it("recovers whenever the patch may already be in the checkout", () => {
    expect(decideInterruptedStep(step({ act: "apply", applied: true })).action).toBe("recover");
    expect(decideInterruptedStep(step({ act: "apply", patchPath: "/p" }), "applied").action).toBe(
      "recover",
    );
    expect(
      decideInterruptedStep(step({ act: "apply", patchPath: "/p" }), "indeterminate").action,
    ).toBe("recover");
    // No probe ran at all.
    expect(decideInterruptedStep(step({ act: "apply", patchPath: "/p" })).action).toBe("recover");
  });

  it("never re-runs an opaque step, and says why", () => {
    const verdict = decideInterruptedStep(step({}));
    expect(verdict.action).toBe("recover");
    expect(verdict.reason).toMatch(/never recorded what it had done/);
  });
});

describe("createFileRunJournal — durable appends", () => {
  it("flushes a durability-critical line and reads it back", async () => {
    const dir = await scratch();
    const journal = createFileRunJournal(dir);
    await journal.append({ kind: "stageStart", stage: 1, parallel: false, steps: 1, ts: 1 });
    await journal.appendDurable?.({
      kind: "stepIntent",
      id: "1",
      stage: 1,
      branch: 0,
      attempt: 0,
      act: "apply",
      patchPath: "/runs/R1/1.patch",
      ts: 2,
    });
    const lines = await readJournalLines(dir);
    // Ordered behind the best-effort line: both go through the one queue.
    expect(lines.map((line) => line.kind)).toEqual(["stageStart", "stepIntent"]);
  });

  it("RAISES a failed durable append instead of swallowing it", async () => {
    const dir = await scratch();
    // A file where the journal's directory should be: every write below fails.
    const wall = join(dir, "wall");
    await writeFile(wall, "not a directory", "utf8");
    const journal = createFileRunJournal(join(wall, "run"));

    // The best-effort path keeps its old contract — hygiene never fails a run.
    await expect(
      journal.append({ kind: "stageStart", stage: 1, parallel: false, steps: 1, ts: 1 }),
    ).resolves.toBeUndefined();

    // The durable path must not: a write-ahead record that vanished is exactly
    // how a crash turns into a double-apply, so the caller has to hear about it.
    await expect(
      journal.appendDurable?.({
        kind: "stepIntent",
        id: "1",
        stage: 1,
        branch: 0,
        attempt: 0,
        act: "apply",
        patchPath: "/runs/R1/1.patch",
        ts: 2,
      }),
    ).rejects.toThrow();

    // …and the queue survives it: the next append still runs.
    await expect(journal.append({ kind: "runEnd", status: "failed", ts: 3 })).resolves.toBe(
      undefined,
    );
  });
});
