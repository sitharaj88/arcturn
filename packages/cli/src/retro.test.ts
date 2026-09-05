/**
 * `arcturn retro` / `/retro` — run retrospectives.
 *
 * Drives {@link computeRetro} and {@link runRetroCommand} against a REAL run
 * directory (`journal.jsonl` + `manifest.json`, written the way
 * `createFileRunJournal`/`writeManifest` write them) and REAL kit files on
 * disk (a workflow `.md` and two `@role` agent files under a scratch
 * `~/.arcturn`), so every assertion is on an actual effect: the bytes a file
 * has after the command runs, the exit code, and what the fake LLM actually
 * received.
 *
 * The diff renderer gets the harshest test in the file: 20 randomly generated
 * before/after pairs are rendered, handed to the REAL `git apply`, and the
 * patched file compared byte-for-byte with the intended after-text. A renderer
 * that is merely plausible fails that.
 */

import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PRINT_EXIT, runPrint } from "./print.js";
import {
  anchorFile,
  computeRetro,
  createRetroCommands,
  GIT_LITERAL_BYTES,
  parseEditBlocks,
  renderUnifiedDiff,
  resolveEditBlocks,
  retroHint,
  runRetroCommand,
} from "./retro.js";
import { type ArcturnRuntime, buildRuntime } from "./runtime.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";
import { makeScratch, type Scratch, writeFileAt } from "./test-helpers/scratch.js";
import type { WorkflowRunResult, WorkflowStepResult } from "./workflow.js";
import { createFileRunJournal, type JournalLine, writeManifest } from "./workflow-run.js";

const execFileAsync = promisify(execFileCb);

/** Marker that must never survive into the packet the retro sub-agent reads. */
const SECRET_TAIL = "SECRET-REASONING-TAIL-MUST-NOT-LEAK";

const REVIEWER_LINE = "You are the reviewer. Read the change and leave comments in review.md.";

const REVIEWER_MD =
  "---\nname: reviewer\ndescription: reviewer role\ntools: read, grep\n---\n" +
  `${REVIEWER_LINE}\n`;

const BUILDER_MD =
  "---\nname: builder\ndescription: builder role\ntools: read, write\n---\n" +
  "You are the builder. Build the thing.\n";

const WORKFLOW_MD =
  "---\nname: demo\ndescription: a demo pipeline\n---\n1. @builder build it\n2. @reviewer review it\n";

const REVIEWER_FIX =
  "You are the reviewer. Read the change and leave comments in review.md. Write review.md " +
  "within your first 20 turns; do not keep reading after that.";

/** A well-formed edit block against the reviewer role file. */
const VALID_BLOCK = [
  "<<<<<<< EDIT agents/reviewer.md",
  REVIEWER_LINE,
  "=======",
  REVIEWER_FIX,
  ">>>>>>> END",
].join("\n");

function reply(blocks: string, findings = "- Step 2 (@reviewer) hit its turn ceiling.\n"): string {
  return [
    "## Findings",
    findings.trimEnd(),
    "",
    "## Edits",
    blocks,
    "",
    "## Risk",
    "Low: this only tightens the reviewer's own instructions.",
    "",
  ].join("\n");
}

const VALID_REPLY = reply(
  VALID_BLOCK,
  [
    "- Step 2 (@reviewer) hit its turn ceiling after 80 turns, 77 of them reads and zero writes.",
    "- The role file never tells the reviewer to write review.md early.",
    "- The stepFailAsk cause corroborates a read-only stall.",
  ].join("\n"),
);

/** An edit block naming a path outside the run's editable set. */
const OUTSIDE_REPLY = reply(
  ["<<<<<<< EDIT agents/ghost.md", "old", "=======", "new", ">>>>>>> END"].join("\n"),
  "- Bogus finding.",
);

/** An edit block whose search text was never in the file. */
const MISMATCHED_REPLY = reply(
  [
    "<<<<<<< EDIT agents/reviewer.md",
    "You are the reviewer. Read the diff and leave comments in review.md.",
    "=======",
    REVIEWER_FIX,
    ">>>>>>> END",
  ].join("\n"),
);

/** Usage with a known cost, so the packet's cost line is never "unknown". */
function usage(output: number, costUsd: number) {
  return {
    inputTokens: 20,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  };
}

/**
 * Write a real run: two kit files, a workflow file, and a hand-written
 * journal + manifest with one done step and one turn-ceiling park.
 */
async function seedRun(
  scratch: Scratch,
  runId: string,
): Promise<{ workflowPath: string; reviewerPath: string; builderPath: string }> {
  const workflowPath = join(scratch.home, "workflows", "demo.md");
  const reviewerPath = join(scratch.home, "agents", "reviewer.md");
  const builderPath = join(scratch.home, "agents", "builder.md");
  await writeFileAt(workflowPath, WORKFLOW_MD);
  await writeFileAt(reviewerPath, REVIEWER_MD);
  await writeFileAt(builderPath, BUILDER_MD);

  const dir = join(scratch.home, "workflow-runs", runId);
  const journal = createFileRunJournal(dir);
  const lines: JournalLine[] = [
    {
      kind: "run",
      v: 1,
      runId,
      workflow: "demo",
      source: workflowPath,
      input: "ship the feature",
      stepTimeoutMs: 600_000,
      maxStepRetries: 2,
      startedAt: 1000,
    },
    { kind: "stageStart", stage: 1, parallel: false, steps: 1, ts: 1100 },
    {
      kind: "stepStart",
      id: "1",
      stage: 1,
      branch: 0,
      agent: "builder",
      promptHash: "h1",
      ts: 1100,
    },
    {
      kind: "stepEnd",
      id: "1",
      stage: 1,
      branch: 0,
      status: "done",
      agent: "builder",
      usage: usage(50, 0.01),
      text: "built it",
      promptHash: "h1",
      attempts: 1,
      startedAt: 1100,
      endedAt: 2000,
      activity: { turns: 3, toolCalls: { read: 2, write: 1 }, writes: 1 },
      lastTurn: {
        model: "zai/glm-5.3-flash",
        stopReason: "endTurn",
        blocks: [{ type: "text", chars: 20 }],
      },
    },
    { kind: "stageEnd", stage: 1, status: "done", ts: 2000 },
    { kind: "stageStart", stage: 2, parallel: false, steps: 1, ts: 2000 },
    {
      kind: "stepStart",
      id: "2",
      stage: 2,
      branch: 0,
      agent: "reviewer",
      promptHash: "h2",
      ts: 2000,
    },
    {
      kind: "stepEnd",
      id: "2",
      stage: 2,
      branch: 0,
      status: "failed",
      agent: "reviewer",
      usage: usage(200, 0.03),
      text: "",
      finalText: "I have read most of the change.",
      promptHash: "h2",
      attempts: 1,
      startedAt: 2000,
      endedAt: 3000,
      activity: { turns: 80, toolCalls: { read: 77, bash: 2 }, writes: 0 },
      lastTurn: {
        model: "zai/glm-5.3-flash",
        stopReason: "maxTokens",
        blocks: [{ type: "thinking", chars: 5000 }],
        reasoningTail: SECRET_TAIL,
      },
    },
    {
      kind: "stepFailAsk",
      stepId: "2",
      role: "reviewer",
      failureKind: "turn-ceiling",
      cause: "step 2 ran out of turns after reading extensively, no file written",
      patchPath: undefined,
      ceiling: 80,
      attempts: 1,
      lastTurn: {
        model: "zai/glm-5.3-flash",
        stopReason: "maxTokens",
        blocks: [{ type: "thinking", chars: 5000 }],
        reasoningTail: SECRET_TAIL,
      },
      activity: { turns: 80, toolCalls: { read: 77, bash: 2 }, writes: 0 },
      ts: 3000,
    },
    { kind: "stageEnd", stage: 2, status: "failed", ts: 3000 },
    { kind: "runEnd", status: "paused", ts: 3000 },
  ];
  for (const line of lines) await journal.append(line);
  await writeManifest(dir, {
    v: 1,
    runId,
    workflow: "demo",
    source: workflowPath,
    input: "ship the feature",
    stepTimeoutMs: 600_000,
    maxStepRetries: 2,
    startedAt: 1000,
  });

  return { workflowPath, reviewerPath, builderPath };
}

describe("retro", () => {
  async function setup(...replies: string[]): Promise<{
    scratch: Scratch;
    runtime: ArcturnRuntime;
    paths: { workflowPath: string; reviewerPath: string; builderPath: string };
    runId: string;
  }> {
    const s = await makeScratch();
    const runId = "2026-01-02T00-00-00Z-deadbeef";
    const paths = await seedRun(s, runId);
    const rt = await buildRuntime({
      cwd: s.cwd,
      home: s.home,
      env: s.env,
      llm: fakeLLM(replies.map((text) => ({ text }))),
      extensions: false,
      skipRepoLookup: true,
      sessionTitles: false,
      trustProject: true,
      permissionMode: "plan",
    });
    return { scratch: s, runtime: rt, paths, runId };
  }

  function requestsOf(runtime: ArcturnRuntime): unknown[] {
    return (runtime.llm as unknown as { requests: unknown[] }).requests;
  }

  it("resolves edit blocks into a rendered diff, and never leaks the reasoning tail", async () => {
    const { runtime: rt, runId } = await setup(VALID_REPLY);
    const result = await computeRetro({
      home: rt.paths.home,
      project: rt.paths.project,
      runId,
      runtime: rt,
    });
    expect(result.status).toBe("ok");
    expect(result.files).toEqual(["agents/reviewer.md"]);
    expect(result.edits).toEqual([{ path: "agents/reviewer.md", matched: true }]);
    // The diff is OURS: proper headers, and hunk counts we never asked a model for.
    expect(result.diff).toContain("--- a/agents/reviewer.md");
    expect(result.diff).toContain("+++ b/agents/reviewer.md");
    expect(result.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(result.diff).toContain(`-${REVIEWER_LINE}`);
    expect(result.diff).toContain(`+${REVIEWER_FIX}`);
    expect(result.findings).toContain("turn ceiling");

    const raw = JSON.stringify(requestsOf(rt));
    expect(raw).not.toContain(SECRET_TAIL);
    // Sanity: the packet DID carry the failure kind and the park cause, so the
    // absence of the tail above is a deliberate omission, not an empty packet.
    expect(raw).toContain("turn-ceiling");
    expect(raw).toContain("no file written");
  });

  it("the packet carries every editable file in FULL, and demands verbatim edit blocks", async () => {
    const { runtime: rt, runId, paths } = await setup(VALID_REPLY);
    // A role file well past the old 6k per-file cap: the whole point of the
    // rewrite is that the model sees text it is asked to quote back.
    const long = `${BUILDER_MD}${"Build carefully and check your imports.\n".repeat(300)}`;
    await writeFile(paths.builderPath, long, "utf8");

    await computeRetro({ home: rt.paths.home, project: rt.paths.project, runId, runtime: rt });
    const raw = JSON.stringify(requestsOf(rt));
    expect(long.length).toBeGreaterThan(10_000);
    expect(raw).toContain(JSON.stringify(long).slice(1, -1));
    expect(raw).toContain("COPIED VERBATIM");
    expect(raw).toContain("<<<<<<< EDIT agents/reviewer.md");
    expect(raw).not.toContain("TRUNCATED");
  });

  it("says so explicitly, and forbids edits past the cut, when a file must be truncated", async () => {
    const { runtime: rt, runId, paths } = await setup(VALID_REPLY);
    const huge = `${BUILDER_MD}${"Build carefully and check every single import you write.\n".repeat(2000)}`;
    await writeFile(paths.builderPath, huge, "utf8");
    expect(huge.length).toBeGreaterThan(60_000);

    await computeRetro({ home: rt.paths.home, project: rt.paths.project, runId, runtime: rt });
    const raw = JSON.stringify(requestsOf(rt));
    expect(raw).toContain("TRUNCATED");
    expect(raw).toContain("Only propose edits inside the text shown");
    // The small files are still whole — one huge file must not starve them.
    expect(raw).toContain(JSON.stringify(REVIEWER_MD).slice(1, -1));
  });

  it("applies the rendered patch: only the touched file changes, and retro.md is written", async () => {
    const { scratch: s, runtime: rt, paths, runId } = await setup(VALID_REPLY);
    const before = {
      workflow: await readFile(paths.workflowPath, "utf8"),
      builder: await readFile(paths.builderPath, "utf8"),
      reviewer: await readFile(paths.reviewerPath, "utf8"),
    };

    const code = await runRetroCommand({
      runId,
      home: s.home,
      cwd: s.cwd,
      env: s.env,
      apply: true,
      yes: true,
      runtime: rt,
    });
    expect(code).toBe(0);

    const after = {
      workflow: await readFile(paths.workflowPath, "utf8"),
      builder: await readFile(paths.builderPath, "utf8"),
      reviewer: await readFile(paths.reviewerPath, "utf8"),
    };
    expect(after.workflow).toBe(before.workflow);
    expect(after.builder).toBe(before.builder);
    // Byte-for-byte what the edit block asked for, and nothing else.
    expect(after.reviewer).toBe(before.reviewer.replace(REVIEWER_LINE, REVIEWER_FIX));

    const note = await readFile(join(s.home, "workflow-runs", runId, "retro.md"), "utf8");
    expect(note).toContain("applied: yes");
    expect(note).toContain("Write review.md within your first 20 turns");
  });

  it("rejects an edit block naming a file outside the run's editable set, and touches nothing", async () => {
    const { scratch: s, runtime: rt, paths, runId } = await setup(OUTSIDE_REPLY);
    const before = await readFile(paths.reviewerPath, "utf8");

    const result = await computeRetro({
      home: rt.paths.home,
      project: rt.paths.project,
      runId,
      runtime: rt,
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toMatch(/not one of this run's editable files/);

    const code = await runRetroCommand({
      runId,
      home: s.home,
      cwd: s.cwd,
      env: s.env,
      apply: true,
      yes: true,
      runtime: await buildRuntime({
        cwd: s.cwd,
        home: s.home,
        env: s.env,
        llm: fakeLLM([{ text: OUTSIDE_REPLY }]),
        extensions: false,
        skipRepoLookup: true,
        sessionTitles: false,
        trustProject: true,
        permissionMode: "plan",
      }),
    });
    expect(code).toBe(1);
    expect(await readFile(paths.reviewerPath, "utf8")).toBe(before);
  });

  it("sends exactly ONE correction turn quoting the failing block, then succeeds", async () => {
    const { scratch: s, runtime: rt, paths, runId } = await setup(MISMATCHED_REPLY, VALID_REPLY);
    const progress: string[] = [];
    const result = await computeRetro({
      home: rt.paths.home,
      project: rt.paths.project,
      runId,
      runtime: rt,
      onProgress: (line) => progress.push(line),
    });

    expect(result.status).toBe("ok");
    expect(result.edits).toEqual([{ path: "agents/reviewer.md", matched: true }]);
    // The diagnosis from the FIRST turn survives a blocks-only correction.
    expect(result.findings).toContain("turn ceiling");

    const requests = requestsOf(rt);
    expect(requests.length).toBe(2);
    const followUp = JSON.stringify(requests[1]);
    expect(followUp).toContain("could not be applied");
    // The failing block is quoted back verbatim, with the nearest real line.
    expect(followUp).toContain("You are the reviewer. Read the diff and leave comments");
    expect(followUp).toContain("nearest text is line");
    expect(progress.some((line) => line.includes("asking once for a correction"))).toBe(true);

    // Nothing was written: computeRetro only ever proposes.
    expect(await readFile(paths.reviewerPath, "utf8")).toBe(REVIEWER_MD);
    expect(s.home).toBeTruthy();
  });

  it("gives up after the ONE retry, still prints the findings, and exits 1", async () => {
    const { scratch: s, runtime: rt, paths, runId } = await setup(MISMATCHED_REPLY);
    let stdout = "";
    let stderr = "";
    const code = await runRetroCommand({
      runId,
      home: s.home,
      cwd: s.cwd,
      env: s.env,
      apply: true,
      yes: true,
      runtime: rt,
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(1);
    // One initial turn, one correction turn, and no third.
    expect(requestsOf(rt).length).toBe(2);
    expect(stdout).toContain("## Findings");
    expect(stderr).toContain("retro patch rejected");
    expect(stderr).toContain("matched 0 times");
    expect(await readFile(paths.reviewerPath, "utf8")).toBe(REVIEWER_MD);
  });

  it("headless --apply without --yes exits 3 and applies nothing", async () => {
    const { scratch: s, runtime: rt, paths, runId } = await setup(VALID_REPLY);
    const before = await readFile(paths.reviewerPath, "utf8");

    const code = await runRetroCommand({
      runId,
      home: s.home,
      cwd: s.cwd,
      env: s.env,
      apply: true,
      // no `yes`
      runtime: rt,
    });
    expect(code).toBe(3);
    expect(await readFile(paths.reviewerPath, "utf8")).toBe(before);
  });

  it("/retro <id> --apply under --print exits 3 and applies nothing, matching the top-level verb", async () => {
    // The slash-command path goes through print.ts's headless CommandUi
    // rather than runRetroCommand directly. It must reach the same exit
    // code as the top-level verb above: ui.select is refused under
    // --print, the command's own confirmed !== true branch now calls
    // ui.needsHuman?.() there, and print.ts's headless ui sets
    // seen.needsHuman from it.
    const { runtime: rt, paths, runId } = await setup(VALID_REPLY);
    const before = await readFile(paths.reviewerPath, "utf8");

    const result = await runPrint({
      runtime: rt,
      prompt: `/retro ${runId} --apply`,
      stdout: () => {},
      stderr: () => {},
    });

    expect(result.exitCode).toBe(PRINT_EXIT.needsHuman);
    expect(await readFile(paths.reviewerPath, "utf8")).toBe(before);
  });

  it("/retro's own approval path tolerates a TUI-style ui that has no needsHuman (optional method)", async () => {
    // The interactive app's real CommandUi does not need to implement
    // needsHuman — it's optional, since only a headless host has an exit
    // code to steer. `ui.needsHuman?.()` must be a safe no-op here, and the
    // command must still take its normal "cancelled" branch.
    const { runtime: rt, paths, runId } = await setup(VALID_REPLY);
    const before = await readFile(paths.reviewerPath, "utf8");
    const notices: { level: string; text: string }[] = [];
    const [command] = createRetroCommands();

    await command?.run({
      args: `${runId} --apply`,
      runtime: rt,
      commands: {} as never,
      ui: {
        print: () => {},
        notice: (level, text) => notices.push({ level, text }),
        select: async () => undefined, // refuses the same way a picker-less host would
        setInput: () => {},
        clear: () => {},
        exit: () => {},
        // needsHuman intentionally omitted
      } as never,
    });

    expect(notices.at(-1)).toMatchObject({ level: "info", text: "Not applied." });
    expect(await readFile(paths.reviewerPath, "utf8")).toBe(before);
  });

  it("--json emits {findings, diff, edits, files, applied} and keeps progress off stdout", async () => {
    const { scratch: s, runtime: rt, runId } = await setup(VALID_REPLY);
    let stdout = "";
    let stderr = "";
    const code = await runRetroCommand({
      runId,
      home: s.home,
      cwd: s.cwd,
      env: s.env,
      json: true,
      runtime: rt,
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as {
      findings: string;
      diff: string;
      edits: { path: string; matched: boolean }[];
      files: string[];
      applied: boolean;
    };
    expect(parsed.applied).toBe(false);
    expect(parsed.files).toEqual(["agents/reviewer.md"]);
    expect(parsed.edits).toEqual([{ path: "agents/reviewer.md", matched: true }]);
    expect(parsed.diff).toContain("--- a/agents/reviewer.md");
    expect(typeof parsed.findings).toBe("string");

    // Every phase line went to stderr, and NONE of them to stdout.
    expect(stdout).not.toContain("retro:");
    expect(stderr).toContain(`retro: reading run ${runId} (2 steps, 2 roles)`);
    expect(stderr).toContain("retro: 3 editable files,");
    expect(stderr).toMatch(/retro: asking .* — this usually takes a few minutes/);
    expect(stderr).toMatch(/retro: \d+ findings, 1 edits across 1 file/);
  });

  it("an unknown run id exits 1 without building a patch", async () => {
    const s = await makeScratch();
    const rt = await buildRuntime({
      cwd: s.cwd,
      home: s.home,
      env: s.env,
      llm: fakeLLM([{ text: VALID_REPLY }]),
      extensions: false,
      skipRepoLookup: true,
      sessionTitles: false,
      trustProject: true,
      permissionMode: "plan",
    });
    let stderr = "";
    const code = await runRetroCommand({
      runId: "does-not-exist",
      home: s.home,
      cwd: s.cwd,
      env: s.env,
      runtime: rt,
      stderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/no run journal/);
    expect(requestsOf(rt).length).toBe(0);
  });
});

describe("parseEditBlocks", () => {
  it("reads several blocks out of one reply, in order", () => {
    const { blocks, warnings } = parseEditBlocks(
      [
        "## Edits",
        "<<<<<<< EDIT agents/a.md",
        "one",
        "two",
        "=======",
        "ONE",
        ">>>>>>> END",
        "some chatter between blocks",
        "<<<<<<< EDIT workflows/demo.md",
        "stage",
        "=======",
        "stage, but better",
        "and a second line",
        ">>>>>>> END",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(blocks).toEqual([
      { index: 1, path: "agents/a.md", search: "one\ntwo", replace: "ONE" },
      {
        index: 2,
        path: "workflows/demo.md",
        search: "stage",
        replace: "stage, but better\nand a second line",
      },
    ]);
  });

  it("strips Windows line endings so CRLF search text can still match an LF file", () => {
    const { blocks } = parseEditBlocks(
      "<<<<<<< EDIT agents/a.md\r\nalpha\r\nbeta\r\n=======\r\ngamma\r\n>>>>>>> END\r\n",
    );
    expect(blocks).toEqual([
      { index: 1, path: "agents/a.md", search: "alpha\nbeta", replace: "gamma" },
    ]);
  });

  it("warns instead of guessing when a block is unterminated or has no separator", () => {
    const noEnd = parseEditBlocks("<<<<<<< EDIT agents/a.md\nalpha\n=======\nbeta\n");
    expect(noEnd.blocks).toEqual([]);
    expect(noEnd.warnings[0]).toMatch(/line 1: .*no ">>>>>>> END" line/);

    const noSplit = parseEditBlocks("<<<<<<< EDIT agents/a.md\nalpha\n>>>>>>> END\n");
    expect(noSplit.blocks).toEqual([]);
    expect(noSplit.warnings[0]).toMatch(/no "=======" separator/);
  });

  it("finds no blocks in a reply that has none", () => {
    expect(parseEditBlocks("## Findings\n- nothing to fix\n").blocks).toEqual([]);
  });
});

describe("resolveEditBlocks", () => {
  const block = (path: string, search: string, replace: string, index = 1) => ({
    index,
    path,
    search,
    replace,
  });

  it("applies a block that matches exactly once, and composes two blocks on one file", () => {
    const files = new Map([["a.md", "alpha\nbeta\ngamma\n"]]);
    const result = resolveEditBlocks(
      [block("a.md", "alpha", "ALPHA"), block("a.md", "gamma", "GAMMA", 2)],
      files,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits).toEqual([
      { path: "a.md", matched: true },
      { path: "a.md", matched: true },
    ]);
    expect(result.after.get("a.md")).toBe("ALPHA\nbeta\nGAMMA\n");
    // The caller's map is never mutated.
    expect(files.get("a.md")).toBe("alpha\nbeta\ngamma\n");
  });

  it("falls back to trailing-whitespace-insensitive line matching", () => {
    const result = resolveEditBlocks(
      [block("a.md", "alpha\nbeta", "ALPHA\nBETA")],
      new Map([["a.md", "head\nalpha   \nbeta\t\ntail\n"]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.after.get("a.md")).toBe("head\nALPHA\nBETA\ntail\n");
  });

  it("refuses a search text that matches 0 times, and quotes the nearest line", () => {
    const result = resolveEditBlocks(
      [block("a.md", "You are the reviewer. Read the diff.", "x")],
      new Map([["a.md", "intro\nYou are the reviewer. Read the change.\noutro\n"]]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("matched 0 times in a.md");
    expect(result.failures[0]?.reason).toContain("must match exactly once");
    expect(result.failures[0]?.reason).toContain(
      'nearest text is line 2: "You are the reviewer. Read the change."',
    );
  });

  it("refuses a search text that matches 2 times, and says how to make it unique", () => {
    const result = resolveEditBlocks(
      [block("a.md", "same", "different")],
      new Map([["a.md", "same\nother\nsame\n"]]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.reason).toContain("matched 2 times in a.md");
    expect(result.failures[0]?.reason).toContain("include the lines above and below it");
  });

  it("reports EVERY failing block, and applies none of them", () => {
    const result = resolveEditBlocks(
      [
        block("a.md", "alpha", "ALPHA"),
        block("ghost.md", "x", "y", 2),
        block("a.md", "nowhere", "z", 3),
      ],
      new Map([["a.md", "alpha\n"]]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.block.index)).toEqual([2, 3]);
    expect(result.failures[0]?.reason).toContain("not one of this run's editable files");
  });

  it("refuses an empty search half rather than inserting at the top of the file", () => {
    const result = resolveEditBlocks(
      [block("a.md", "", "new text")],
      new Map([["a.md", "alpha\n"]]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.reason).toContain("search half of the block is empty");
  });
});

describe("renderUnifiedDiff", () => {
  /** Deterministic PRNG, so a failure here is always reproducible. */
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomText(rand: () => number): string {
    const count = 1 + Math.floor(rand() * 12);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const roll = rand();
      lines.push(
        roll < 0.2 ? "" : `line ${Math.floor(rand() * 5)} ${"x".repeat(Math.floor(rand() * 6))}`,
      );
    }
    // Half the samples end without a final newline — the case a naive renderer
    // gets wrong and `git apply` then refuses.
    return lines.join("\n") + (rand() < 0.5 ? "\n" : "");
  }

  function randomEdit(text: string, rand: () => number): string {
    const hadNewline = text.endsWith("\n");
    const lines = text.replace(/\n$/, "").split("\n");
    const at = Math.floor(rand() * lines.length);
    const roll = rand();
    if (roll < 0.3) lines.splice(at, 1);
    else if (roll < 0.6) lines.splice(at, 0, `inserted ${Math.floor(rand() * 100)}`);
    else if (roll < 0.85) lines[at] = `replaced ${Math.floor(rand() * 100)}`;
    else lines.push(`appended ${Math.floor(rand() * 100)}`);
    if (lines.length === 0) return "";
    return lines.join("\n") + (rand() < 0.5 === hadNewline ? "\n" : "");
  }

  it("renders a patch real git applies, reproducing the after-text byte for byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcturn-retro-diff-"));
    const target = join(dir, "file.md");
    const patchFile = join(dir, "p.patch");
    const rand = mulberry32(20260904);

    for (let i = 0; i < 20; i++) {
      const before = randomText(rand);
      const after = randomEdit(before, rand);
      const diff = renderUnifiedDiff("file.md", before, after);
      if (diff === "") {
        expect(after).toBe(before);
        continue;
      }
      await writeFile(target, before, "utf8");
      await writeFile(patchFile, `${diff}\n`, "utf8");
      await execFileAsync("git", [...GIT_LITERAL_BYTES, "apply", "--check", "p.patch"], {
        cwd: dir,
      });
      await execFileAsync("git", [...GIT_LITERAL_BYTES, "apply", "p.patch"], { cwd: dir });
      expect(await readFile(target, "utf8")).toBe(after);
    }
  });

  it("reproduces a CRLF file byte for byte, as a Windows checkout stores one", async () => {
    // A repository cloned with core.autocrlf=true has CRLF on disk. The
    // renderer splits on "\n" only, so each line carries its own "\r" — and
    // the patch must put the file back exactly, CRs included.
    const dir = await mkdtemp(join(tmpdir(), "arcturn-retro-crlf-"));
    const target = join(dir, "role.md");
    const before = "line one\r\nline two\r\nline three\r\n";
    const after = "line one\r\nline TWO\r\nline three\r\n";
    const diff = renderUnifiedDiff("role.md", before, after);
    expect(diff).toContain("-line two\r");
    expect(diff).toContain("+line TWO\r");
    await writeFile(target, before, "utf8");
    await writeFile(join(dir, "p.patch"), `${diff}\n`, "utf8");
    await execFileAsync("git", [...GIT_LITERAL_BYTES, "apply", "--check", "p.patch"], { cwd: dir });
    await execFileAsync("git", [...GIT_LITERAL_BYTES, "apply", "p.patch"], { cwd: dir });
    expect(await readFile(target, "utf8")).toBe(after);
    await rm(dir, { recursive: true, force: true });
  });

  it("is empty for identical texts, and marks a missing final newline", () => {
    expect(renderUnifiedDiff("f.md", "a\n", "a\n")).toBe("");
    const diff = renderUnifiedDiff("f.md", "a\nb", "a\nc");
    expect(diff).toContain("\\ No newline at end of file");
    expect(diff).toContain("-b");
    expect(diff).toContain("+c");
  });

  it("keeps three lines of context around a hunk", () => {
    const before = `${Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n")}\n`;
    const after = before.replace("l6", "SIX");
    const body = renderUnifiedDiff("f.md", before, after).split("\n").slice(2);
    expect(body[0]).toBe("@@ -4,7 +4,7 @@");
    expect(body.slice(1)).toEqual([" l3", " l4", " l5", "-l6", "+SIX", " l7", " l8", " l9"]);
  });
});

describe("retroHint", () => {
  function step(overrides: Partial<WorkflowStepResult>): WorkflowStepResult {
    return {
      id: "1",
      stageIndex: 1,
      branchIndex: 0,
      prompt: "",
      status: "done",
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...overrides,
    };
  }

  function result(steps: WorkflowStepResult[]): WorkflowRunResult {
    return {
      workflow: "demo",
      status: "done",
      steps,
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      pauses: [],
      startedAt: 0,
      endedAt: 0,
    };
  }

  it("is undefined for a clean run", () => {
    expect(retroHint(result([step({ status: "done" })]), "run-1")).toBeUndefined();
  });

  it("names parks, failures and retried steps, and the command to run", () => {
    const hint = retroHint(
      result([
        step({ id: "1", status: "paused" }),
        step({ id: "2", status: "failed" }),
        step({ id: "3", status: "done", attempts: 2 }),
      ]),
      "run-xyz",
    );
    expect(hint).toContain("1 park");
    expect(hint).toContain("1 failed step");
    expect(hint).toContain("1 retried step");
    expect(hint).toContain("arcturn retro run-xyz");
  });
});

/**
 * The editable root.
 *
 * A run draws its kit files from TWO independent trees — `~/.arcturn`
 * (workflows, home roles) and `<cwd>/.arcturn` (roles a cloned repository
 * ships). Retro used to take the longest shared directory prefix of that set
 * as its root, which climbs above both the moment a run uses one role from
 * each: `git apply --check` and the scratch copy then ran in `$HOME`, or in
 * `/` when the checkout sat on another top level. These assert on the roots
 * the command would actually write into, and on the bytes it wrote.
 */
describe("retro anchors every editable file on the tree it came from", () => {
  const HOME_ROLE_LINE = "You are the builder. Build the thing.";
  const PROJECT_ROLE_LINE = "You are the local reviewer. Review the thing.";
  const PROJECT_ROLE_FIX = `${PROJECT_ROLE_LINE} Write review.md within 20 turns.`;
  const HOME_ROLE_FIX = `${HOME_ROLE_LINE} Say what you built.`;

  function twoTreeReply(): string {
    return [
      "## Findings",
      "- The local reviewer never says when to stop reading.",
      "- The builder never reports what it built.",
      "",
      "## Edits",
      "<<<<<<< EDIT project/agents/local-reviewer.md",
      PROJECT_ROLE_LINE,
      "=======",
      PROJECT_ROLE_FIX,
      ">>>>>>> END",
      "<<<<<<< EDIT agents/builder.md",
      HOME_ROLE_LINE,
      "=======",
      HOME_ROLE_FIX,
      ">>>>>>> END",
      "",
      "## Risk",
      "Low.",
      "",
    ].join("\n");
  }

  /** A run whose two steps dispatched to one home role and one project role. */
  async function seedTwoTreeRun(
    s: Scratch,
    runId: string,
    projectRoleBody?: string,
  ): Promise<string> {
    const workflowPath = join(s.home, "workflows", "demo.md");
    await writeFileAt(
      workflowPath,
      "---\nname: demo\ndescription: demo\n---\n1. @builder build it\n2. @local-reviewer review it\n",
    );
    await writeFileAt(
      join(s.home, "agents", "builder.md"),
      `---\nname: builder\ndescription: builder\ntools: read\n---\n${HOME_ROLE_LINE}\n`,
    );
    await writeFileAt(
      join(s.cwd, ".arcturn", "agents", "local-reviewer.md"),
      projectRoleBody ??
        `---\nname: local-reviewer\ndescription: local reviewer\ntools: read\n---\n${PROJECT_ROLE_LINE}\n`,
    );

    const dir = join(s.home, "workflow-runs", runId);
    const journal = createFileRunJournal(dir);
    const header = {
      v: 1 as const,
      runId,
      workflow: "demo",
      source: workflowPath,
      input: "ship it",
      stepTimeoutMs: 600_000,
      maxStepRetries: 2,
      startedAt: 1000,
    };
    const lines: JournalLine[] = [
      { kind: "run", ...header },
      { kind: "stageStart", stage: 1, parallel: false, steps: 1, ts: 1100 },
      {
        kind: "stepEnd",
        id: "1",
        stage: 1,
        branch: 0,
        status: "done",
        agent: "builder",
        usage: usage(10, 0.01),
        text: "built",
        promptHash: "h1",
        attempts: 1,
        startedAt: 1100,
        endedAt: 1200,
      },
      { kind: "stageEnd", stage: 1, status: "done", ts: 1200 },
      { kind: "stageStart", stage: 2, parallel: false, steps: 1, ts: 1200 },
      {
        kind: "stepEnd",
        id: "2",
        stage: 2,
        branch: 0,
        status: "failed",
        agent: "local-reviewer",
        usage: usage(10, 0.01),
        text: "",
        finalText: "still reading",
        promptHash: "h2",
        attempts: 1,
        startedAt: 1200,
        endedAt: 1300,
        activity: { turns: 80, toolCalls: { read: 79 }, writes: 0 },
      },
      { kind: "stageEnd", stage: 2, status: "failed", ts: 1300 },
      { kind: "runEnd", status: "paused", ts: 1300 },
    ];
    for (const line of lines) await journal.append(line);
    await writeManifest(dir, header);
    return workflowPath;
  }

  async function twoTreeRuntime(s: Scratch, ...replies: string[]): Promise<ArcturnRuntime> {
    return buildRuntime({
      cwd: s.cwd,
      home: s.home,
      env: s.env,
      llm: fakeLLM(replies.map((text) => ({ text }))),
      extensions: false,
      skipRepoLookup: true,
      sessionTitles: false,
      trustProject: true,
      permissionMode: "plan",
    });
  }

  it("produces one patch per tree, each rooted inside the tree it came from", async () => {
    const s = await makeScratch();
    const runId = "2026-01-02T00-00-00Z-tworoot";
    await seedTwoTreeRun(s, runId);
    const rt = await twoTreeRuntime(s, twoTreeReply());

    const result = await computeRetro({
      home: rt.paths.home,
      project: rt.paths.project,
      runId,
      runtime: rt,
    });

    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("ok");
    // The project's role is addressed through a `project/` prefix, never
    // through a path that walks in from some shared parent directory.
    expect(result.files?.slice().sort()).toEqual([
      "agents/builder.md",
      "project/agents/local-reviewer.md",
    ]);

    const patches = result.patches ?? [];
    expect(patches.length).toBe(2);
    const homeReal = await realpath(rt.paths.home);
    const projectReal = await realpath(rt.paths.project);
    expect(patches.map((patch) => patch.root).sort()).toEqual([homeReal, projectReal].sort());
    // Every diff header is relative to its own root, so `git apply` in that
    // root resolves it — and no header walks up out of one.
    for (const patch of patches) {
      expect(patch.diff).not.toContain("..");
      for (const rel of patch.files) expect(patch.diff).toContain(`--- a/${rel}`);
    }
    await rm(s.root, { recursive: true, force: true });
  });

  it("applies both trees' edits, writing only inside those trees", async () => {
    const s = await makeScratch();
    const runId = "2026-01-02T00-00-00Z-twoapply";
    await seedTwoTreeRun(s, runId);
    const rt = await twoTreeRuntime(s, twoTreeReply());
    let stdout = "";

    const code = await runRetroCommand({
      runId,
      home: s.home,
      cwd: s.cwd,
      env: s.env,
      apply: true,
      yes: true,
      runtime: rt,
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Applied to 2 file(s)");
    expect(await readFile(join(s.home, "agents", "builder.md"), "utf8")).toContain(HOME_ROLE_FIX);
    expect(
      await readFile(join(s.cwd, ".arcturn", "agents", "local-reviewer.md"), "utf8"),
    ).toContain(PROJECT_ROLE_FIX);
    // Nothing was created in the parent of the two trees — the directory the
    // old common-prefix root would have picked.
    expect((await readdir(s.root)).filter((entry) => entry.startsWith(".retro-apply-"))).toEqual(
      [],
    );
    await rm(s.root, { recursive: true, force: true });
  });

  it("refuses a role file whose realpath escapes the tree that declared it", async () => {
    const s = await makeScratch();
    const runId = "2026-01-02T00-00-00Z-escape";
    await seedTwoTreeRun(s, runId);
    // The project's role file is a symlink pointing out of the project tree —
    // the shape a cloned repository can commit.
    const outside = join(s.root, "outside", "local-reviewer.md");
    await writeFileAt(
      outside,
      `---\nname: local-reviewer\ndescription: local reviewer\ntools: read\n---\n${PROJECT_ROLE_LINE}\n`,
    );
    const link = join(s.cwd, ".arcturn", "agents", "local-reviewer.md");
    await rm(link, { force: true });
    await symlink(outside, link);

    const rt = await twoTreeRuntime(s, twoTreeReply(), twoTreeReply());
    const result = await computeRetro({
      home: rt.paths.home,
      project: rt.paths.project,
      runId,
      runtime: rt,
    });

    // The escaping file is not editable at all, so the block naming it is
    // refused — and the file outside the trees is untouched.
    expect(result.editableWarnings?.join("\n")).toContain("is outside both");
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("not one of this run's editable files");
    expect(await readFile(outside, "utf8")).toContain(PROJECT_ROLE_LINE);
    expect(await readFile(outside, "utf8")).not.toContain(PROJECT_ROLE_FIX);
    await rm(s.root, { recursive: true, force: true });
  });
});

describe("anchoring under Windows path semantics", () => {
  // The real defect these cover: `path.relative` answers with backslashes on
  // win32, so `homeRel.split("/")[0]` was the WHOLE path, matched no
  // HOME_SUBTREE, and every editable file fell out of the set — retro then
  // said "no editable file could be resolved for this run" for every Windows
  // run. Asserted with `path.win32` so it is provable off Windows.
  const ops = { sep: win32.sep, isAbsolute: win32.isAbsolute, relative: win32.relative };
  const trees = { home: "C:\\Users\\dev\\.arcturn", project: "D:\\repo\\.arcturn" };

  it("keys a home-tree role on a POSIX path, whatever the platform separator is", () => {
    expect(anchorFile("C:\\Users\\dev\\.arcturn\\agents\\reviewer.md", trees, ops)).toEqual({
      root: trees.home,
      rel: "agents/reviewer.md",
      path: "agents/reviewer.md",
    });
    expect(
      anchorFile("C:\\Users\\dev\\.arcturn\\packages\\kit\\workflows\\a.md", trees, ops),
    ).toEqual({
      root: trees.home,
      rel: "packages/kit/workflows/a.md",
      path: "packages/kit/workflows/a.md",
    });
  });

  it("prefixes a project-tree role with `project/`, still POSIX", () => {
    expect(anchorFile("D:\\repo\\.arcturn\\agents\\local.md", trees, ops)).toEqual({
      root: trees.project,
      rel: "agents/local.md",
      path: "project/agents/local.md",
    });
  });

  it("refuses a file in neither tree, including one on a THIRD drive letter", () => {
    // `win32.relative` across volumes returns the target absolute, with no
    // ".." to reject — the case a `startsWith("..")` guard alone lets through.
    expect(win32.relative(trees.home, "E:\\elsewhere\\evil.md")).toBe("E:\\elsewhere\\evil.md");
    expect(anchorFile("E:\\elsewhere\\evil.md", trees, ops)).toBeUndefined();
    // Inside the home tree, but not in a subtree a run's kit may come from.
    expect(anchorFile("C:\\Users\\dev\\.arcturn\\sessions\\s1.json", trees, ops)).toBeUndefined();
  });

  it("matches a drive letter case-insensitively, as win32 itself does", () => {
    expect(anchorFile("c:\\Users\\dev\\.arcturn\\agents\\reviewer.md", trees, ops)?.path).toBe(
      "agents/reviewer.md",
    );
  });
});
