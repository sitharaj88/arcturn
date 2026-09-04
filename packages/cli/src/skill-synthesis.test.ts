/**
 * SKILL SYNTHESIS — effects tests.
 *
 * Every fixture run's journal is written the way `workflow-run.ts` itself
 * writes one (`createFileRunJournal` + `writeManifest`), so the reader half
 * under test here can never drift from the writer's own shape. What is
 * asserted throughout is EFFECTS: bytes actually on disk, what the fake
 * provider actually received, exit codes, and — for the collision guard —
 * what `createCommandRegistry` actually does with a same-named skill.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "./commands.js";
import { PRINT_EXIT, runPrint } from "./print.js";
import {
  parseSkillSynthesizeArgs,
  renderSkillShare,
  runSkillSynthesizeCommand,
  saveSkillDraft,
  skillFilePath,
  skillSynthesisHint,
  synthesizeSkill,
} from "./skill-synthesis.js";
import { respondingLLM } from "./test-helpers/fake-llm.js";
import {
  buildTestRuntime,
  makeScratch,
  type Scratch,
  writeFileAt,
} from "./test-helpers/scratch.js";
import type { WorkflowRunResult } from "./workflow.js";
import { createFileRunJournal, writeManifest } from "./workflow-run.js";

/** A reply carrying one valid fenced SKILL.md draft. */
function validSkillReply(name: string, extra = ""): string {
  return [
    "Here is the draft.",
    "",
    "```md",
    "---",
    `name: ${name}`,
    "description: Redo the demo task end to end.",
    "---",
    "",
    "## When to use this",
    "Use this after a similar demo run.",
    "",
    "## Procedure",
    "1. Read $ARGUMENTS.",
    "2. Write a summary.",
    extra,
    "```",
  ].join("\n");
}

const USAGE: Usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Write a run journal + manifest exactly the way the engine writes one. */
async function writeFixtureRun(
  scratch: Scratch,
  options: {
    runId: string;
    input?: string;
    runEndStatus?: string;
    stage2Status?: string;
  },
): Promise<{ workflowPath: string }> {
  const workflowPath = join(scratch.cwd, "demo.md");
  await writeFileAt(
    workflowPath,
    [
      "---",
      "name: demo",
      "description: a demo workflow",
      "---",
      "1. @worker read the input: {{input}}",
      "2. @writer write the summary: {{prev}}",
    ].join("\n"),
  );

  const dir = join(scratch.home, "workflow-runs", options.runId);
  await writeManifest(dir, {
    v: 1,
    runId: options.runId,
    workflow: "demo",
    source: workflowPath,
    input: options.input ?? "do the demo task",
    stepTimeoutMs: 600_000,
    maxStepRetries: 2,
    startedAt: 1000,
  });
  const journal = createFileRunJournal(dir);
  await journal.append({
    kind: "run",
    v: 1,
    runId: options.runId,
    workflow: "demo",
    source: workflowPath,
    input: options.input ?? "do the demo task",
    stepTimeoutMs: 600_000,
    maxStepRetries: 2,
    startedAt: 1000,
  });
  await journal.append({ kind: "stageStart", stage: 1, parallel: false, steps: 1, ts: 1001 });
  await journal.append({
    kind: "stepEnd",
    id: "1",
    stage: 1,
    branch: 0,
    status: "done",
    agent: "worker",
    usage: USAGE,
    text: "worker read the input and found three things worth summarising.",
    promptHash: "hash-1",
    attempts: 1,
    startedAt: 1001,
    endedAt: 1050,
    activity: { turns: 3, toolCalls: { read: 2, bash: 1 }, writes: 0 },
    record: {
      status: "applied",
      role: "worker",
      stepId: "1",
      files: 2,
      patchPath: "/tmp/step1.patch",
    },
  });
  await journal.append({ kind: "stageEnd", stage: 1, status: "done", ts: 1051 });
  await journal.append({ kind: "stageStart", stage: 2, parallel: false, steps: 1, ts: 1052 });
  await journal.append({
    kind: "stepEnd",
    id: "2",
    stage: 2,
    branch: 0,
    status: "done",
    agent: "writer",
    usage: USAGE,
    text: "wrote a three-paragraph summary.",
    promptHash: "hash-2",
    attempts: 1,
    startedAt: 1052,
    endedAt: 1100,
    activity: { turns: 2, toolCalls: { write: 1 }, writes: 1 },
  });
  await journal.append({
    kind: "stageEnd",
    stage: 2,
    status: (options.stage2Status ?? "done") as never,
    ts: 1101,
  });
  await journal.append({
    kind: "runEnd",
    status: (options.runEndStatus ?? "done") as never,
    ts: 1102,
  });
  return { workflowPath };
}

describe("synthesizeSkill", () => {
  it("drafts and saves a skill from a finished run; loads back and appears as a command", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-happy" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("demo-skill") })),
    });

    const result = await synthesizeSkill({ runtime, runId: "run-happy", scope: "user" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.draft.name).toBe("demo-skill");
    expect(result.draft.content).toContain("source-run: run-happy");
    expect(result.draft.content).toContain("generated:");
    expect(result.draft.content).not.toContain("```");

    const saved = await saveSkillDraft(runtime, result.draft, "user");
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("expected ok");
    const expectedPath = skillFilePath(runtime, "user", "demo-skill");
    expect(saved.path).toBe(expectedPath);

    const onDisk = await readFile(expectedPath, "utf8");
    expect(onDisk).toBe(result.draft.content);

    // Effect check: a FRESH runtime reading the same home now offers it as a
    // slash command, and the registry accepts it (no name collision here).
    const reloaded = await buildTestRuntime(scratch, [{ text: "unused" }]);
    expect(reloaded.extensions.commands.some((command) => command.name === "demo-skill")).toBe(
      true,
    );
    const registry = createCommandRegistry(reloaded.extensions.commands);
    expect(registry.get("demo-skill")?.name).toBe("demo-skill");
  });

  it("refuses a run that has not finished", async () => {
    const scratch = await makeScratch();
    const dir = join(scratch.home, "workflow-runs", "run-unfinished");
    const workflowPath = join(scratch.cwd, "demo.md");
    await writeFileAt(
      workflowPath,
      ["---", "name: demo", "---", "1. @worker go: {{input}}"].join("\n"),
    );
    await writeManifest(dir, {
      v: 1,
      runId: "run-unfinished",
      workflow: "demo",
      source: workflowPath,
      input: "x",
      stepTimeoutMs: 600_000,
      maxStepRetries: 2,
      startedAt: 1000,
    });
    const journal = createFileRunJournal(dir);
    await journal.append({
      kind: "run",
      v: 1,
      runId: "run-unfinished",
      workflow: "demo",
      source: workflowPath,
      input: "x",
      stepTimeoutMs: 600_000,
      maxStepRetries: 2,
      startedAt: 1000,
    });
    // No stepEnd, no runEnd: the run is still "in flight" as far as the journal says.

    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("should-not-matter") })),
    });
    const result = await synthesizeSkill({ runtime, runId: "run-unfinished", scope: "user" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toContain("has not finished");
    expect(result.overridable).toBe(true);

    await expect(stat(skillFilePath(runtime, "user", "should-not-matter"))).rejects.toThrow();
  });

  it("refuses a failed run unless --force", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, {
      runId: "run-failed",
      runEndStatus: "failed",
      stage2Status: "failed",
    });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("recovered-skill") })),
    });

    const refused = await synthesizeSkill({ runtime, runId: "run-failed", scope: "user" });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected refusal");
    expect(refused.error).toMatch(/failed stage|not "done"/);

    const forced = await synthesizeSkill({
      runtime,
      runId: "run-failed",
      scope: "user",
      force: true,
    });
    expect(forced.ok).toBe(true);
  });

  it("refuses an invalid drafted name; nothing is written", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-bad-name" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("Not A Valid Name!!") })),
    });

    const result = await synthesizeSkill({ runtime, runId: "run-bad-name", scope: "user" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toContain("not a valid skill name");
    expect(result.overridable).toBe(false);

    const skillsDir = join(scratch.home, "skills");
    await expect(stat(skillsDir)).rejects.toThrow();
  });

  it("refuses a body containing a code fence", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-fenced-body" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({
        text: validSkillReply("fenced-skill", "```js\nconsole.log(1)\n```"),
      })),
    });
    const result = await synthesizeSkill({ runtime, runId: "run-fenced-body", scope: "user" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toContain("code fence");
  });

  it("refuses a name collision without --force; --force overwrites", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-collide" });
    const existingPath = join(scratch.home, "skills", "demo-skill", "SKILL.md");
    await mkdir(join(scratch.home, "skills", "demo-skill"), { recursive: true });
    await writeFile(
      existingPath,
      [
        "---",
        "name: demo-skill",
        "description: an existing hand-written skill",
        "---",
        "old body",
      ].join("\n"),
      "utf8",
    );

    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("demo-skill") })),
    });

    const refused = await synthesizeSkill({ runtime, runId: "run-collide", scope: "user" });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected refusal");
    expect(refused.error).toContain("already exists");
    expect(refused.overridable).toBe(true);
    expect(await readFile(existingPath, "utf8")).toContain("old body");

    const forced = await synthesizeSkill({
      runtime,
      runId: "run-collide",
      scope: "user",
      force: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) throw new Error("expected ok");
    const saved = await saveSkillDraft(runtime, forced.draft, "user");
    expect(saved.ok).toBe(true);
    const overwritten = await readFile(existingPath, "utf8");
    expect(overwritten).not.toContain("old body");
    expect(overwritten).toContain("source-run: run-collide");
  });

  it("gives ONE correction turn: an invalid first draft, a valid second, saves", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-correct" });
    const replies = [
      // Fence in the body — the exact slip a fast model makes unprompted.
      validSkillReply("corrected-skill", "```js\nconsole.log(1)\n```"),
      validSkillReply("corrected-skill"),
    ];
    let call = 0;
    const llm = respondingLLM(() => ({
      text: replies[Math.min(call++, replies.length - 1)] ?? "",
    }));
    const runtime = await buildTestRuntime(scratch, [], { llm });

    const result = await synthesizeSkill({ runtime, runId: "run-correct", scope: "user" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.draft.name).toBe("corrected-skill");
    expect(result.draft.content).not.toContain("```");

    // Effect: exactly two requests, the second quoting the validation error.
    expect(llm.requests).toHaveLength(2);
    const second = JSON.stringify(llm.requests[1]?.messages ?? []);
    expect(second).toContain("REJECTED");
    expect(second).toContain("body contains a code fence");

    const saved = await saveSkillDraft(runtime, result.draft, "user");
    expect(saved.ok).toBe(true);
    expect(await readFile(skillFilePath(runtime, "user", "corrected-skill"), "utf8")).toContain(
      "name: corrected-skill",
    );
  });

  it("two invalid drafts refuse with the second failure and write nothing", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-correct-twice" });
    const replies = [
      // First: no frontmatter at all. Second: a bad name.
      ["```md", "no frontmatter here, just a body", "```"].join("\n"),
      validSkillReply("Not A Valid Name!!"),
    ];
    let call = 0;
    const llm = respondingLLM(() => ({
      text: replies[Math.min(call++, replies.length - 1)] ?? "",
    }));
    const runtime = await buildTestRuntime(scratch, [], { llm });

    const result = await synthesizeSkill({ runtime, runId: "run-correct-twice", scope: "user" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toContain("not a valid skill name");

    // Both turns were asked for, and the correction quoted the first error.
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1]?.messages ?? [])).toContain("no frontmatter block");
    await expect(stat(join(scratch.home, "skills"))).rejects.toThrow();
  });

  it("--name renames past a collision without --force", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-rename" });
    await mkdir(join(scratch.home, "skills", "demo-skill"), { recursive: true });
    await writeFile(
      join(scratch.home, "skills", "demo-skill", "SKILL.md"),
      ["---", "name: demo-skill", "description: existing", "---", "old body"].join("\n"),
      "utf8",
    );
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("demo-skill") })),
    });
    const result = await synthesizeSkill({
      runtime,
      runId: "run-rename",
      scope: "user",
      name: "demo-skill-v2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.draft.name).toBe("demo-skill-v2");
  });
});

describe("runSkillSynthesizeCommand", () => {
  it("headless without --yes previews, writes nothing, and exits 3", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-preview" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("preview-skill") })),
    });
    let stdout = "";
    let stderr = "";
    const code = await runSkillSynthesizeCommand({
      argv: ["run-preview"],
      cwd: scratch.cwd,
      home: scratch.home,
      runtime,
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(3);
    expect(stdout).toContain("name: preview-skill");
    expect(stderr).toContain("--yes");
    await expect(stat(skillFilePath(runtime, "user", "preview-skill"))).rejects.toThrow();
  });

  it("/skills synthesize under --print exits 3 and saves nothing (no --yes flag exists there; approval is a picker)", async () => {
    // The slash command has no --yes of its own — approval is always a
    // picker (ui.select). Under --print the picker is refused, the
    // command's own `approved !== true` branch calls ui.needsHuman?.(),
    // and print.ts's headless ui turns that into exit 3, matching the
    // top-level verb's contract above.
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-preview-slash" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("preview-slash-skill") })),
    });

    const result = await runPrint({
      runtime,
      prompt: "/skills synthesize run-preview-slash",
      stdout: () => {},
      stderr: () => {},
    });

    expect(result.exitCode).toBe(PRINT_EXIT.needsHuman);
    await expect(stat(skillFilePath(runtime, "user", "preview-slash-skill"))).rejects.toThrow();
  });

  it("usage error exits 2 with no run id", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "unused" }]);
    let stderr = "";
    const code = await runSkillSynthesizeCommand({
      argv: [],
      cwd: scratch.cwd,
      home: scratch.home,
      runtime,
      stderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("needs a run id");
  });

  it("--yes saves and prints the path and slash command", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-save" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("save-skill") })),
    });
    let stdout = "";
    const code = await runSkillSynthesizeCommand({
      argv: ["run-save", "--yes"],
      cwd: scratch.cwd,
      home: scratch.home,
      runtime,
      stdout: (chunk) => {
        stdout += chunk;
      },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("/save-skill");
    const path = skillFilePath(runtime, "user", "save-skill");
    expect(await readFile(path, "utf8")).toContain("name: save-skill");
  });

  it("--json shape includes name, path, saved and (with --share) url", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-json" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("json-skill") })),
    });
    let stdout = "";
    const code = await runSkillSynthesizeCommand({
      argv: ["run-json", "--yes", "--json", "--share"],
      cwd: scratch.cwd,
      home: scratch.home,
      runtime,
      stdout: (chunk) => {
        stdout += chunk;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.name).toBe("json-skill");
    expect(parsed.saved).toBe(true);
    expect(parsed.path).toBe(skillFilePath(runtime, "user", "json-skill"));
    expect(typeof parsed.url).toBe("string");
    expect(Buffer.byteLength(parsed.url, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(parsed.url).toMatch(/^https:\/\/github\.com\/.+\/issues\/new\?title=/);
  });

  it("--share without --yes still prints the proposal URL for the unsaved draft, exit 3", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-share-preview" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("share-preview-skill") })),
    });
    let stdout = "";
    let stderr = "";
    const code = await runSkillSynthesizeCommand({
      argv: ["run-share-preview", "--share"],
      cwd: scratch.cwd,
      home: scratch.home,
      runtime,
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(code).toBe(3);
    expect(stdout).toContain("## Skill proposal: share-preview-skill");
    expect(stdout).toContain("Nothing was sent");
    const url = stdout.split("\n").findLast((line) => line.startsWith("https://github.com/"));
    expect(url).toBeDefined();
    expect(Buffer.byteLength(url ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(decodeURIComponent(new URL(url ?? "").searchParams.get("body") ?? "")).toContain(
      "share-preview-skill",
    );
    // Says plainly that nothing landed, and the rerun keeps --share.
    expect(stderr).toContain("NOT saved");
    expect(stderr).toContain("--share --yes");
    await expect(stat(skillFilePath(runtime, "user", "share-preview-skill"))).rejects.toThrow();
  });

  it("--share --yes saves the file and prints the same URL", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-share-save" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("share-save-skill") })),
    });
    let stdout = "";
    const code = await runSkillSynthesizeCommand({
      argv: ["run-share-save", "--yes", "--share"],
      cwd: scratch.cwd,
      home: scratch.home,
      runtime,
      stdout: (chunk) => {
        stdout += chunk;
      },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("## Skill proposal: share-save-skill");
    expect(stdout).toContain("https://github.com/");
    const path = skillFilePath(runtime, "user", "share-save-skill");
    expect(await readFile(path, "utf8")).toContain("name: share-save-skill");
  });

  it("a run not found on disk is a plain refusal, not a crash", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "unused" }]);
    let stderr = "";
    const code = await runSkillSynthesizeCommand({
      argv: ["nonexistent-run", "--yes"],
      cwd: scratch.cwd,
      home: scratch.home,
      runtime,
      stderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("no run journal found");
  });
});

describe("renderSkillShare", () => {
  it("stays under the URL cap and decodes back to the skill text", async () => {
    const scratch = await makeScratch();
    await writeFixtureRun(scratch, { runId: "run-share" });
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: validSkillReply("share-skill") })),
    });
    const result = await synthesizeSkill({ runtime, runId: "run-share", scope: "user" });
    if (!result.ok) throw new Error("expected ok");
    const lines = renderSkillShare(result.draft);
    const url = lines.at(-1) ?? "";
    expect(Buffer.byteLength(url, "utf8")).toBeLessThanOrEqual(8 * 1024);
    const body = decodeURIComponent(new URL(url).searchParams.get("body") ?? "");
    expect(body).toContain("share-skill");
    expect(lines.join("\n")).toContain("Nothing was sent");
  });
});

describe("parseSkillSynthesizeArgs", () => {
  it("parses every flag", () => {
    const parsed = parseSkillSynthesizeArgs([
      "run-1",
      "--name",
      "foo",
      "--scope",
      "project",
      "--yes",
      "--force",
      "--share",
      "--json",
    ]);
    expect(parsed).toMatchObject({
      runId: "run-1",
      name: "foo",
      scope: "project",
      yes: true,
      force: true,
      share: true,
      json: true,
    });
  });

  it("rejects an unknown scope", () => {
    const parsed = parseSkillSynthesizeArgs(["run-1", "--scope", "nowhere"]);
    expect(parsed.error).toContain("--scope");
  });
});

describe("skillSynthesisHint", () => {
  function result(status: WorkflowRunResult["status"]): WorkflowRunResult {
    return {
      workflow: "demo",
      status,
      steps: [],
      text: "",
      usage: USAGE,
    };
  }

  it("suggests the command only for a run that finished done", () => {
    expect(skillSynthesisHint(result("done"), "run-1")).toContain("arcturn skill synthesize run-1");
    expect(skillSynthesisHint(result("failed"), "run-1")).toBeUndefined();
    expect(skillSynthesisHint(result("paused"), "run-1")).toBeUndefined();
    expect(skillSynthesisHint(result("cancelled"), "run-1")).toBeUndefined();
  });
});

describe("createCommandRegistry collision guard", () => {
  it("keeps the built-in /skills command even when a project skill is named the same", async () => {
    const scratch = await makeScratch();
    await mkdir(join(scratch.home, "skills", "skills"), { recursive: true });
    await writeFile(
      join(scratch.home, "skills", "skills", "SKILL.md"),
      ["---", "name: skills", "description: a user skill that collides", "---", "body"].join("\n"),
      "utf8",
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "unused" }]);
    const collidingCommand = runtime.extensions.commands.find(
      (command) => command.name === "skills",
    );
    expect(collidingCommand).toBeDefined();

    const warnings: string[] = [];
    const registry = createCommandRegistry(runtime.extensions.commands, (message) =>
      warnings.push(message),
    );
    expect(registry.get("skills")?.source).toBe("built-in");
    expect(warnings.some((message) => message.includes("/skills is already defined"))).toBe(true);
  });
});
