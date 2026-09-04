import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LARGE_CONTENT_CHARS, LARGE_CONTENT_LINES } from "@arcturn/core";
import { describe, expect, it } from "vitest";
import { BRAIN_FENCE_CLOSE, BRAIN_FENCE_OPEN } from "./brain.js";
import {
  buildSystemPrompt,
  collectSystemPromptContext,
  MAX_PROJECT_DOC_CHARS,
  PROJECT_DOC_FILENAME,
  readProjectDoc,
} from "./system-prompt.js";

describe("buildSystemPrompt", () => {
  const base = { cwd: "/work/repo", platform: "darwin", date: "2026-08-18" };

  it("always states the working directory, platform and date", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain("Working directory: /work/repo");
    expect(prompt).toContain("Platform: darwin");
    expect(prompt).toContain("Today's date: 2026-08-18");
  });

  it("describes the tool contract", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain("Tool use");
    expect(prompt).toContain("todo tool");
    expect(prompt).toContain("plan tool");
    expect(prompt).toContain("subagent tool");
  });

  it("nudges toward edit over write when both tools are available", () => {
    const prompt = buildSystemPrompt({ ...base, toolNames: ["edit", "write", "bash"] });
    expect(prompt).toContain("use edit's targeted replacement");
  });

  it("omits the edit-over-write nudge when either tool is missing", () => {
    const editOnly = buildSystemPrompt({ ...base, toolNames: ["edit", "bash"] });
    const writeOnly = buildSystemPrompt({ ...base, toolNames: ["write", "bash"] });
    const neither = buildSystemPrompt({ ...base, toolNames: ["bash"] });
    expect(editOnly).not.toContain("use edit's targeted replacement");
    expect(writeOnly).not.toContain("use edit's targeted replacement");
    expect(neither).not.toContain("use edit's targeted replacement");
  });

  it("carries the engine's large-content rule verbatim, for every session", () => {
    // Not a kit's problem and not this prompt's own wording: one rule, defined
    // in `@arcturn/core`, spliced here as-is. A model that meets it in the
    // system prompt, in a lane contract and in the write tool must meet the
    // same sentences each time.
    const prompt = buildSystemPrompt(base);
    for (const line of LARGE_CONTENT_LINES) expect(prompt).toContain(line);
    expect(prompt).toContain(String(LARGE_CONTENT_CHARS.toLocaleString("en-US")));
    // It sits with the other tool-use guidance, not in some section of its own.
    expect(prompt.indexOf(LARGE_CONTENT_LINES[0] ?? "")).toBeGreaterThan(
      prompt.indexOf("Tool use"),
    );
  });

  it("omits optional sections when they are absent", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).not.toContain("Git:");
    expect(prompt).not.toContain(PROJECT_DOC_FILENAME);
    expect(prompt).not.toContain("# User instructions");
  });

  it("includes the git line, tool inventory, project doc and user append", () => {
    const prompt = buildSystemPrompt({
      ...base,
      git: "branch main, 2 uncommitted files",
      toolNames: ["read", "bash"],
      projectDoc: "Always run pnpm check.",
      append: "Prefer tabs.",
    });
    expect(prompt).toContain("Git: branch main, 2 uncommitted files");
    expect(prompt).toContain("Available tools: read, bash");
    expect(prompt).toContain(`# Project instructions (${PROJECT_DOC_FILENAME})`);
    expect(prompt).toContain("Always run pnpm check.");
    expect(prompt).toContain("# User instructions");
    expect(prompt).toContain("Prefer tabs.");
  });

  it("carries the project brain, fenced, after project memory", () => {
    // The brain arrives ALREADY fenced (`renderBrainPrompt` owns the
    // delimiters) because, unlike ARCTURN.md and memory, it was distilled from
    // files a cloned repository controls. This prompt only frames it.
    const brain = `${BRAIN_FENCE_OPEN}\n## Modules\n- src — code\n${BRAIN_FENCE_CLOSE}`;
    const prompt = buildSystemPrompt({ ...base, memories: "Note one.", brain });
    expect(prompt).toContain("# Project brain");
    expect(prompt).toContain(BRAIN_FENCE_OPEN);
    expect(prompt).toContain("- src — code");
    expect(prompt).toContain(BRAIN_FENCE_CLOSE);
    // Ordering: what the user/model wrote comes before what was derived.
    expect(prompt.indexOf("# Project brain")).toBeGreaterThan(prompt.indexOf("# Project memory"));
  });

  it("omits the project brain when there is none", () => {
    expect(buildSystemPrompt(base)).not.toContain("# Project brain");
    expect(buildSystemPrompt({ ...base, brain: "   " })).not.toContain("# Project brain");
  });

  it("ignores blank optional values", () => {
    const prompt = buildSystemPrompt({ ...base, projectDoc: "   ", append: "" });
    expect(prompt).not.toContain("# Project instructions");
    expect(prompt).not.toContain("# User instructions");
  });
});

describe("collectSystemPromptContext", () => {
  it("passes memories, agents and the brain through to the context", async () => {
    // A REGRESSION test for a silent drop. These three fields are gathered by
    // the caller, not by this function, and they were not declared on its
    // options — so `buildRuntime`'s conditional spreads handed them over and
    // this function returned a context without them. Project memory and the
    // named-agent roster never reached a real session's system prompt.
    const context = await collectSystemPromptContext({
      cwd: "/work/repo",
      skipRepoLookup: true,
      memories: "Remember the flaky test.",
      brain: "BRAINBLOCK",
      agents: [{ name: "reviewer", description: "reviews" }],
    });
    expect(context.memories).toBe("Remember the flaky test.");
    expect(context.brain).toBe("BRAINBLOCK");
    expect(context.agents).toEqual([{ name: "reviewer", description: "reviews" }]);

    const prompt = buildSystemPrompt(context);
    expect(prompt).toContain("# Project memory");
    expect(prompt).toContain("Remember the flaky test.");
    expect(prompt).toContain("# Project brain");
    expect(prompt).toContain("# Specialized agents");
  });
});

describe("readProjectDoc", () => {
  it("reads ARCTURN.md from the root, then the working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcturn-cli-doc-"));
    await writeFile(join(root, PROJECT_DOC_FILENAME), "# Rules\nBe brief.", "utf8");
    expect(await readProjectDoc(root, root)).toContain("Be brief.");
  });

  it("returns undefined when there is no doc", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcturn-cli-doc-"));
    expect(await readProjectDoc(root, root)).toBeUndefined();
  });

  it("truncates a very large doc", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcturn-cli-doc-"));
    await writeFile(join(root, PROJECT_DOC_FILENAME), "x".repeat(MAX_PROJECT_DOC_CHARS + 500));
    const doc = await readProjectDoc(root, root);
    expect(doc?.endsWith("…(truncated)")).toBe(true);
    expect(doc?.length).toBeLessThan(MAX_PROJECT_DOC_CHARS + 40);
  });
});

describe("collectSystemPromptContext", () => {
  it("skips repository lookups when asked", async () => {
    const context = await collectSystemPromptContext({
      cwd: "/nowhere",
      skipRepoLookup: true,
      append: "hello",
      toolNames: ["read"],
      now: new Date("2026-08-18T10:00:00Z"),
    });
    expect(context).toEqual({
      cwd: "/nowhere",
      platform: process.platform,
      date: "2026-08-18",
      append: "hello",
      toolNames: ["read"],
    });
  });

  it("degrades gracefully outside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcturn-cli-nogit-"));
    const context = await collectSystemPromptContext({ cwd: root });
    expect(context.cwd).toBe(root);
    expect(context.projectDoc).toBeUndefined();
  });
});
