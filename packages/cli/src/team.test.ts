import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, ModelSpec, Usage } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRegistry, type CommandUi, type SelectOption } from "./commands.js";
import type { ArcturnRuntime } from "./runtime.js";
import type { ExecFn, GitExecResult } from "./scouts.js";
import {
  BUILT_IN_TEAM_ROLES,
  buildDecompositionPrompt,
  buildMemberPrompt,
  createTeamCommands,
  createTeamPlanner,
  createTeamSpawn,
  DEFAULT_TEAM_ROLE_NAME,
  formatMergeReport,
  formatTeamReport,
  getTeamManager,
  normalizeScope,
  parseTeamArgs,
  parseTeamPlan,
  repairTeamPlan,
  resolveTeamRole,
  type StartTeamOptions,
  scopesOverlap,
  type TeamAgent,
  TeamManager,
  type TeamManagerOptions,
  type TeamMemberBrief,
  type TeamPlanner,
  type TeamRole,
  type TeamStatus,
  type TeamSubtask,
  teamRoleFromAgentDef,
  teamRolesFor,
  validateTeamPlan,
} from "./team.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";

const execFileAsync = promisify(execFile);

const TEST_MODEL: ModelSpec = {
  id: "test/model",
  provider: "anthropic",
  model: "test-model",
  displayName: "Test Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  cost: { input: 1000, output: 2000 },
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
};

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function scratchDir(prefix = "arcturn-team-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function usage(costUsd?: number): Usage {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

// ------------------------------------------------------------------ fake git

interface ExecCall {
  args: string[];
  cwd: string;
}

interface FakeGit {
  execFn: ExecFn;
  calls: ExecCall[];
  argv(): string[];
}

function fakeGit(
  handler?: (args: readonly string[], cwd: string) => GitExecResult | Error | undefined,
): FakeGit {
  const calls: ExecCall[] = [];
  const execFn: ExecFn = async (command, args, options) => {
    expect(command).toBe("git");
    calls.push({ args: [...args], cwd: options.cwd });
    const reply = handler?.(args, options.cwd);
    if (reply instanceof Error) throw reply;
    return reply ?? { stdout: "", stderr: "" };
  };
  return { execFn, calls, argv: () => calls.map((call) => call.args.join(" ")) };
}

function addedDirs(git: FakeGit): string[] {
  return git.calls
    .filter((call) => call.args[0] === "worktree" && call.args[1] === "add")
    .map((call) => call.args[3] ?? "");
}

function removedDirs(git: FakeGit): string[] {
  return git.calls
    .filter((call) => call.args[0] === "worktree" && call.args[1] === "remove")
    .map((call) => call.args[3] ?? "");
}

// ---------------------------------------------------------------- fake agent

interface FakeAgentOptions {
  run?: (agent: FakeAgent) => Promise<void>;
  text?: string;
}

class FakeAgent implements TeamAgent {
  aborts = 0;
  prompts: string[] = [];
  readonly sessionId = "session-fake";
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #options: FakeAgentOptions;

  constructor(options: FakeAgentOptions = {}) {
    this.#options = options;
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    await (this.#options.run?.(this) ?? Promise.resolve());
  }

  abort(): void {
    this.aborts++;
  }

  finalText(): string {
    return this.#options.text ?? "";
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

const never = (): Promise<void> => new Promise<void>(() => {});
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- plan fixtures

function planJson(subtasks: Partial<TeamSubtask>[], notes?: string): string {
  return JSON.stringify({
    subtasks: subtasks.map((task, index) => ({
      id: task.id ?? `m${index + 1}`,
      title: task.title ?? `Task ${index + 1}`,
      role: task.role ?? "implementer",
      task: task.task ?? `do thing ${index + 1}`,
      files: task.files ?? [`src/${index + 1}.ts`],
    })),
    ...(notes === undefined ? {} : { notes }),
  });
}

/** A planner that replays a fixed list of replies, one per attempt. */
function scriptedPlanner(replies: readonly string[]): TeamPlanner & { asked: string[] } {
  const asked: string[] = [];
  const planner = async (request: Parameters<TeamPlanner>[0]): Promise<string> => {
    const index = asked.length;
    asked.push(buildDecompositionPrompt(request));
    const reply = replies[Math.min(index, replies.length - 1)];
    if (reply === undefined) throw new Error("planner ran out of replies");
    return reply;
  };
  return Object.assign(planner, { asked });
}

interface ManagerHarness {
  manager: TeamManager;
  git: FakeGit;
  dir: string;
  spawned: { brief: TeamMemberBrief; cwd: string; agent: FakeAgent }[];
}

async function harness(
  overrides: Partial<TeamManagerOptions> & { plan: TeamPlanner },
  makeAgent?: (brief: TeamMemberBrief, cwd: string) => FakeAgent,
): Promise<ManagerHarness> {
  const dir = await scratchDir();
  const git = overrides.execFn ? undefined : fakeGit();
  const spawned: ManagerHarness["spawned"] = [];
  const manager = new TeamManager({
    dir,
    repoRoot: "/repo",
    spawn: (brief, cwd) => {
      const agent = makeAgent?.(brief, cwd) ?? new FakeAgent({ text: `${brief.id} done` });
      spawned.push({ brief, cwd, agent });
      return agent;
    },
    minMembers: 2,
    maxMembers: 5,
    ...(git === undefined ? {} : { execFn: git.execFn }),
    ...overrides,
  });
  return { manager, git: git ?? fakeGit(), dir, spawned };
}

// ================================================================= plan parsing

describe("parseTeamPlan", () => {
  it("parses a well-formed plan", () => {
    const parsed = parseTeamPlan(planJson([{}, {}], "watch the shared types file"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.subtasks).toHaveLength(2);
    expect(parsed.subtasks[0]?.id).toBe("m1");
    expect(parsed.subtasks[0]?.files).toEqual(["src/1.ts"]);
    expect(parsed.notes).toBe("watch the shared types file");
  });

  it("digs the JSON out of a fenced, prefaced reply", () => {
    const raw = [
      "Sure! Here is the plan:",
      "```json",
      planJson([{}, {}]),
      "```",
      "Hope that helps.",
    ].join("\n");
    const parsed = parseTeamPlan(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.subtasks).toHaveLength(2);
  });

  it("accepts a bare array and the `members` alias", () => {
    const array = parseTeamPlan(
      JSON.stringify([
        { id: "a", task: "one", files: ["a.ts"] },
        { id: "b", task: "two" },
      ]),
    );
    expect(array.ok).toBe(true);
    const aliased = parseTeamPlan(
      JSON.stringify({ members: [{ task: "one", paths: "a.ts, b.ts" }] }),
    );
    expect(aliased.ok).toBe(true);
    if (aliased.ok) expect(aliased.subtasks[0]?.files).toEqual(["a.ts", "b.ts"]);
  });

  it("normalizes scopes and de-duplicates ids", () => {
    const parsed = parseTeamPlan(
      JSON.stringify({
        subtasks: [
          { id: "same", task: "a", files: ["./src/a.ts", "/src/b.ts/", "src/a.ts"] },
          { id: "same", task: "b", files: ["src\\c.ts"] },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.subtasks[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed.subtasks[1]?.files).toEqual(["src/c.ts"]);
    expect(parsed.subtasks[0]?.id).not.toBe(parsed.subtasks[1]?.id);
  });

  it("rejects a malformed plan rather than guessing", () => {
    expect(parseTeamPlan("I could not think of a split, sorry.")).toEqual({
      ok: false,
      error: "the reply contained no JSON object or array",
    });
    const broken = parseTeamPlan('{"subtasks": [{"id": "a", "task": ');
    expect(broken.ok).toBe(false);
    expect(parseTeamPlan('{"subtasks": []}')).toEqual({
      ok: false,
      error: 'the "subtasks" array is empty',
    });
    expect(parseTeamPlan('{"plan": "just do it"}')).toEqual({
      ok: false,
      error: 'the JSON has no "subtasks" array',
    });
    const missingTask = parseTeamPlan('{"subtasks": [{"id": "a", "files": ["x.ts"]}]}');
    expect(missingTask.ok).toBe(false);
    if (!missingTask.ok) expect(missingTask.error).toContain('has no "task" text');
  });

  it("defaults an unnamed role to the implementer", () => {
    const parsed = parseTeamPlan('{"subtasks": [{"task": "do it", "files": ["a.ts"]}]}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.subtasks[0]?.role).toBe(DEFAULT_TEAM_ROLE_NAME);
  });
});

// ============================================================== scope validation

describe("scope disjointness", () => {
  it("normalizes scopes to comparable relative paths", () => {
    expect(normalizeScope("  ./src/a.ts  ")).toBe("src/a.ts");
    expect(normalizeScope('"/src/b/"')).toBe("src/b");
    expect(normalizeScope("src\\c.ts")).toBe("src/c.ts");
    expect(normalizeScope("   ")).toBe("");
  });

  it("detects overlaps conservatively", () => {
    expect(scopesOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(scopesOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(scopesOverlap("src/**", "src/a.ts")).toBe(true);
    expect(scopesOverlap("src", "src/deep/a.ts")).toBe(true);
    expect(scopesOverlap("**/*.ts", "anything/at/all.ts")).toBe(true);
    expect(scopesOverlap("packages/cli/**", "packages/core/**")).toBe(false);
    // Not a segment boundary: a prefix match must not be a path match.
    expect(scopesOverlap("src/a.ts", "src/a.ts.bak")).toBe(false);
  });

  it("passes a plan whose scopes are disjoint", () => {
    const parsed = parseTeamPlan(
      planJson([
        { id: "a", files: ["packages/cli/**"] },
        { id: "b", files: ["packages/core/**"] },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateTeamPlan(parsed.subtasks)).toEqual({ ok: true, issues: [] });
  });

  it("flags an overlapping plan with the colliding pair", () => {
    const parsed = parseTeamPlan(
      planJson([
        { id: "a", files: ["src/api.ts"] },
        { id: "b", files: ["src/**"] },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateTeamPlan(parsed.subtasks);
    expect(result.ok).toBe(false);
    const overlap = result.issues.find((issue) => issue.kind === "overlap");
    expect(overlap).toBeDefined();
    if (overlap?.kind !== "overlap") return;
    expect(overlap.conflicts[0]?.a).toBe("a");
    expect(overlap.conflicts[0]?.b).toBe("b");
    expect(overlap.conflicts[0]?.paths[0]).toBe("src/api.ts ↔ src/**");
  });

  it("flags bounds, unscoped subtasks and unknown roles", () => {
    const single = validateTeamPlan([
      { id: "a", title: "a", role: "implementer", task: "t", files: ["a.ts"] },
    ]);
    expect(single.issues.some((issue) => issue.kind === "too-few")).toBe(true);

    const many = validateTeamPlan(
      Array.from({ length: 6 }, (_value, index) => ({
        id: `m${index}`,
        title: "t",
        role: "implementer",
        task: "t",
        files: [`f${index}.ts`],
      })),
    );
    expect(many.issues.some((issue) => issue.kind === "too-many")).toBe(true);

    const unscoped = validateTeamPlan([
      { id: "a", title: "a", role: "implementer", task: "t", files: [] },
      { id: "b", title: "b", role: "implementer", task: "t", files: ["b.ts"] },
    ]);
    const issue = unscoped.issues.find((entry) => entry.kind === "unscoped");
    expect(issue?.kind === "unscoped" && issue.ids).toEqual(["a"]);

    const roles = validateTeamPlan(
      [
        { id: "a", title: "a", role: "wizard", task: "t", files: ["a.ts"] },
        { id: "b", title: "b", role: "implementer", task: "t", files: ["b.ts"] },
      ],
      { roles: ["implementer", "reviewer"] },
    );
    const bad = roles.issues.find((entry) => entry.kind === "unknown-role");
    expect(bad?.kind === "unknown-role" && bad.ids).toEqual(["a"]);
  });
});

describe("repairTeamPlan", () => {
  it("merges transitively overlapping subtasks into one member without dropping work", () => {
    const repaired = repairTeamPlan([
      { id: "a", title: "A", role: "implementer", task: "task A", files: ["src/api.ts"] },
      { id: "b", title: "B", role: "tester", task: "task B", files: ["src/**"] },
      { id: "c", title: "C", role: "reviewer", task: "task C", files: ["docs/**"] },
    ]);
    expect(repaired.subtasks).toHaveLength(2);
    const merged = repaired.subtasks[0];
    expect(merged?.id).toBe("a");
    expect(merged?.task).toContain("task A");
    expect(merged?.task).toContain("task B");
    expect(merged?.files).toEqual(["src/api.ts", "src/**"]);
    expect(repaired.subtasks[1]?.id).toBe("c");
    expect(repaired.changes.join(" ")).toContain("merged");
    expect(validateTeamPlan(repaired.subtasks, { minMembers: 1 }).ok).toBe(true);
  });

  it("treats an unscoped subtask as claiming everything", () => {
    const repaired = repairTeamPlan([
      { id: "a", title: "A", role: "implementer", task: "task A", files: [] },
      { id: "b", title: "B", role: "implementer", task: "task B", files: ["src/b.ts"] },
    ]);
    expect(repaired.subtasks).toHaveLength(1);
    expect(repaired.subtasks[0]?.task).toContain("task B");
    expect(repaired.changes.join(" ")).toContain("declared no file scope");
  });

  it("folds an over-long plan's tail into the last member instead of truncating", () => {
    const many: TeamSubtask[] = Array.from({ length: 7 }, (_value, index) => ({
      id: `m${index}`,
      title: `T${index}`,
      role: "implementer",
      task: `task ${index}`,
      files: [`f${index}.ts`],
    }));
    const repaired = repairTeamPlan(many, { maxMembers: 3 });
    expect(repaired.subtasks).toHaveLength(3);
    const all = repaired.subtasks.map((task) => task.task).join("\n");
    for (let index = 0; index < 7; index++) expect(all).toContain(`task ${index}`);
  });
});

// ===================================================================== roles

describe("roles", () => {
  it("defaults the reviewer to read-only tools", () => {
    const reviewer = BUILT_IN_TEAM_ROLES.get("reviewer");
    expect(reviewer?.readOnly).toBe(true);
    expect(reviewer?.tools).toEqual(["read", "grep", "glob", "ls"]);
    expect(reviewer?.tools).not.toContain("write");
    expect(reviewer?.tools).not.toContain("edit");
    expect(reviewer?.tools).not.toContain("bash");
    expect(BUILT_IN_TEAM_ROLES.get("implementer")?.readOnly).toBe(false);
  });

  it("resolves host roles ahead of built-ins and reports unknown names", () => {
    const custom: TeamRole = {
      name: "reviewer",
      description: "project reviewer",
      systemPrompt: "be nice",
      tools: ["read"],
      readOnly: true,
    };
    const extra = new Map([["reviewer", custom]]);
    expect(resolveTeamRole("Reviewer", extra)).toBe(custom);
    expect(resolveTeamRole("tester", extra)?.name).toBe("tester");
    expect(resolveTeamRole("wizard", extra)).toBeUndefined();
    expect(resolveTeamRole("  ")).toBeUndefined();
  });

  it("adapts a markdown agent definition into a role", () => {
    const role = teamRoleFromAgentDef({
      name: "auditor",
      description: "reads everything",
      systemPrompt: "audit it",
      tools: ["read", "grep"],
      source: "/x/auditor.md",
    });
    expect(role.readOnly).toBe(true);
    expect(role.tools).toEqual(["read", "grep"]);

    const writer = teamRoleFromAgentDef({
      name: "writer",
      description: "",
      systemPrompt: "write it",
      tools: ["read", "write"],
      source: "/x/writer.md",
    });
    expect(writer.readOnly).toBe(false);
    expect(writer.description).toContain("/x/writer.md");
  });
});

describe("prompts", () => {
  it("demands disjoint scopes and echoes the rejection on the re-ask", () => {
    const first = buildDecompositionPrompt({
      goal: "add caching",
      roles: ["implementer", "reviewer"],
      minMembers: 2,
      maxMembers: 5,
    });
    expect(first).toContain("MUST list the files");
    expect(first).toContain("No two subtasks may list the same file");
    expect(first).not.toContain("REJECTED");

    const second = buildDecompositionPrompt({
      goal: "add caching",
      roles: ["implementer"],
      requestedRoles: ["implementer", "reviewer"],
      minMembers: 2,
      maxMembers: 5,
      previousError: "a ↔ b (src/**)",
    });
    expect(second).toContain("REJECTED");
    expect(second).toContain("a ↔ b (src/**)");
    expect(second).toContain("implementer, reviewer");
  });

  it("tells a member its scope and that its teammates are invisible", () => {
    const reviewer = BUILT_IN_TEAM_ROLES.get("reviewer");
    expect(reviewer).toBeDefined();
    if (!reviewer) return;
    const prompt = buildMemberPrompt({
      id: "a",
      teamId: "team-1",
      title: "Review the router",
      task: "look for races",
      role: reviewer,
      files: ["src/router.ts"],
      goal: "harden the router",
      maxTurns: 10,
    });
    expect(prompt).toContain("read-only tools");
    expect(prompt).toContain("src/router.ts");
    expect(prompt).toContain("cannot see their changes");
  });
});

// ============================================================ decomposition flow

describe("TeamManager decomposition", () => {
  it("dispatches a valid plan on the first supervisor turn", async () => {
    const planner = scriptedPlanner([
      planJson([
        { id: "cli", files: ["packages/cli/**"] },
        { id: "core", files: ["packages/core/**"] },
      ]),
    ]);
    const { manager, spawned } = await harness({ plan: planner });
    const status = await manager.start("split the work");
    expect(planner.asked).toHaveLength(1);
    expect(status.status).toBe("review");
    expect(status.members.map((member) => member.id)).toEqual(["cli", "core"]);
    expect(spawned).toHaveLength(2);
  });

  it("re-asks once when the plan is malformed, then dispatches the corrected one", async () => {
    const planner = scriptedPlanner([
      "sorry, no idea",
      planJson([
        { id: "a", files: ["a/**"] },
        { id: "b", files: ["b/**"] },
      ]),
    ]);
    const { manager } = await harness({ plan: planner });
    const status = await manager.start("do the thing");
    expect(planner.asked).toHaveLength(2);
    expect(planner.asked[1]).toContain("REJECTED");
    expect(status.status).toBe("review");
    expect(status.members).toHaveLength(2);
    expect(status.warnings.join(" ")).toContain("no JSON object");
  });

  it("re-asks once on overlapping scopes and never dispatches the overlapping plan", async () => {
    const overlapping = planJson([
      { id: "a", files: ["src/api.ts"] },
      { id: "b", files: ["src/**"] },
    ]);
    const planner = scriptedPlanner([
      overlapping,
      planJson([
        { id: "a", files: ["src/api.ts"] },
        { id: "b", files: ["src/db.ts"] },
      ]),
    ]);
    const { manager, spawned } = await harness({ plan: planner });
    const status = await manager.start("split it");
    expect(planner.asked).toHaveLength(2);
    expect(planner.asked[1]).toContain("overlapping files");
    expect(status.members).toHaveLength(2);
    // The scopes actually dispatched are the corrected, disjoint ones.
    expect(spawned.map((entry) => entry.brief.files)).toEqual([["src/api.ts"], ["src/db.ts"]]);
  });

  it("merges the colliding members when the re-ask still overlaps, rather than dispatching them", async () => {
    const overlapping = planJson([
      { id: "a", task: "task A", files: ["src/api.ts"] },
      { id: "b", task: "task B", files: ["src/**"] },
      { id: "c", task: "task C", files: ["docs/**"] },
    ]);
    const planner = scriptedPlanner([overlapping, overlapping]);
    const { manager, spawned } = await harness({ plan: planner });
    const status = await manager.start("split it");

    expect(planner.asked).toHaveLength(2);
    expect(status.members).toHaveLength(2);
    expect(spawned).toHaveLength(2);
    // Nothing was dropped: both colliding tasks are inside the merged member.
    expect(spawned[0]?.brief.task).toContain("task A");
    expect(spawned[0]?.brief.task).toContain("task B");
    expect(spawned[1]?.brief.task).toContain("task C");
    expect(status.warnings.join(" ")).toContain("Plan repair");
    // And what ran really is disjoint.
    const scopes = status.members.map((member) => member.files);
    expect(scopes[0]?.some((a) => scopes[1]?.some((b) => scopesOverlap(a, b)))).toBe(false);
  });

  it("collapses to a single member when the goal does not decompose, and says so", async () => {
    const unsplittable = planJson([
      { id: "a", task: "task A", files: ["src/one.ts"] },
      { id: "b", task: "task B", files: ["src/one.ts"] },
    ]);
    const { manager, spawned } = await harness({ plan: scriptedPlanner([unsplittable]) });
    const status = await manager.start("rename one symbol");
    expect(status.members).toHaveLength(1);
    expect(spawned).toHaveLength(1);
    expect(status.warnings.join(" ")).toContain("collapsed to a single member");
  });

  it("fails without dispatching anything when the supervisor never produces JSON", async () => {
    const planner = scriptedPlanner(["nope", "still nope"]);
    const { manager, git, spawned } = await harness({ plan: planner });
    const status = await manager.start("impossible");
    expect(planner.asked).toHaveLength(2);
    expect(status.status).toBe("failed");
    expect(status.members).toHaveLength(0);
    expect(spawned).toHaveLength(0);
    expect(addedDirs(git)).toHaveLength(0);
  });

  it("survives a supervisor turn that throws and retries once", async () => {
    let calls = 0;
    const plan: TeamPlanner = async () => {
      calls++;
      if (calls === 1) throw new Error("provider exploded");
      return planJson([
        { id: "a", files: ["a/**"] },
        { id: "b", files: ["b/**"] },
      ]);
    };
    const { manager } = await harness({ plan });
    const status = await manager.start("go");
    expect(status.status).toBe("review");
    expect(status.warnings.join(" ")).toContain("provider exploded");
  });

  it("rejects an empty goal", async () => {
    const { manager } = await harness({ plan: scriptedPlanner([planJson([{}, {}])]) });
    await expect(manager.start("   ")).rejects.toThrow(/non-empty/);
  });

  it("drives decomposition from a scripted LLMClient with zero network", async () => {
    const llm = fakeLLM([
      {
        text: `\`\`\`json\n${planJson([
          { id: "docs", role: "documenter", files: ["docs/**"] },
          { id: "code", role: "implementer", files: ["src/**"] },
        ])}\n\`\`\``,
      },
    ]);
    const plan: TeamPlanner = async () => {
      const message = await llm.complete({
        model: TEST_MODEL,
        messages: [{ role: "user", content: [{ type: "text", text: "plan" }], timestamp: 0 }],
      });
      return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    };
    const { manager } = await harness({ plan });
    const status = await manager.start("write docs and code");
    expect(status.members.map((member) => member.role)).toEqual(["documenter", "implementer"]);
  });
});

// ================================================================ dispatch

describe("TeamManager dispatch", () => {
  const twoWay = planJson([
    { id: "a", files: ["a/**"] },
    { id: "b", files: ["b/**"] },
  ]);

  it("gives every member its own worktree and cleans them all up", async () => {
    const { manager, git } = await harness({ plan: scriptedPlanner([twoWay]) });
    const status = await manager.start("go");
    const added = addedDirs(git);
    expect(added).toHaveLength(2);
    expect(new Set(added).size).toBe(2);
    expect(added[0]).toContain("1-a");
    expect(added[1]).toContain("2-b");
    expect(removedDirs(git).sort()).toEqual([...added].sort());
    for (const member of status.members) expect(member.worktreeDir).toBeUndefined();
  });

  it("respects the concurrency cap", async () => {
    const fiveWay = planJson([
      { id: "a", files: ["a/**"] },
      { id: "b", files: ["b/**"] },
      { id: "c", files: ["c/**"] },
      { id: "d", files: ["d/**"] },
      { id: "e", files: ["e/**"] },
    ]);
    let inFlight = 0;
    let peak = 0;
    const { manager } = await harness(
      { plan: scriptedPlanner([fiveWay]), concurrency: 2 },
      () =>
        new FakeAgent({
          // Says something, so the member is `done` rather than tripping the
          // void gate — this test is about concurrency, not about silence.
          text: "worked",
          run: async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await delay(10);
            inFlight--;
          },
        }),
    );
    const status = await manager.start("go");
    expect(status.members).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("keeps two members editing the same-named file isolated from each other", async () => {
    // Same file name in two different worktrees: neither spawn ever sees the
    // other's directory, which is exactly the isolation guarantee.
    const seen: string[] = [];
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]) }, (brief, cwd) => {
      seen.push(join(cwd, "shared.ts"));
      return new FakeAgent({ text: `${brief.id} wrote shared.ts` });
    });
    await manager.start("go");
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("records a failed member without disturbing its sibling", async () => {
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]) }, (brief) =>
      brief.id === "a"
        ? new FakeAgent({ run: () => Promise.reject(new Error("member blew up")) })
        : new FakeAgent({ text: "b fine" }),
    );
    const status = await manager.start("go");
    expect(status.members[0]?.status).toBe("failed");
    expect(status.members[0]?.error).toContain("member blew up");
    expect(status.members[1]?.status).toBe("done");
    expect(status.members[1]?.finalText).toBe("b fine");
  });

  it("counts cost and turns, and stops the team at its cost ceiling", async () => {
    const { manager } = await harness(
      { plan: scriptedPlanner([twoWay]), concurrency: 1, maxCostUsd: 0.5 },
      (brief) =>
        brief.id === "a"
          ? new FakeAgent({
              run: async (agent) => {
                agent.emit({ type: "turnEnd", turnIndex: 0, usage: usage(0.6) });
              },
              text: "spent a lot",
            })
          : new FakeAgent({ text: "never ran" }),
    );
    const status = await manager.start("go");
    expect(status.members[0]?.costUsd).toBeCloseTo(0.6);
    expect(status.members[0]?.turns).toBe(1);
    expect(status.members[1]?.status).toBe("cancelled");
    expect(status.warnings.join(" ")).toContain("ceiling");
    expect(status.costUsd).toBeCloseTo(0.6);
  });

  it("counts turns nobody could price instead of billing them at zero", async () => {
    // `/team` folds its total into the session, so a team that swallowed the
    // unknown here would reintroduce the "$0.00 means free" bug through the
    // team door: the member ledger has to carry the gap, not flatten it.
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]) }, (brief) =>
      brief.id === "a"
        ? new FakeAgent({
            run: async (agent) => {
              agent.emit({ type: "turnEnd", turnIndex: 0, usage: usage(0.25) });
              agent.emit({ type: "turnEnd", turnIndex: 1, usage: usage() });
            },
            text: "half priced",
          })
        : new FakeAgent({
            run: async (agent) => {
              agent.emit({ type: "turnEnd", turnIndex: 0, usage: usage() });
            },
            text: "not priced at all",
          }),
    );
    const status = await manager.start("go");
    expect(status.members[0]?.costUsd).toBeCloseTo(0.25);
    expect(status.members[0]?.unpricedTurns).toBe(1);
    expect(status.members[1]?.costUsd).toBe(0);
    expect(status.members[1]?.unpricedTurns).toBe(1);
    expect(status.costUsd).toBeCloseTo(0.25);
    expect(status.unpricedTurns).toBe(2);
    // The total is a floor, and the report says so rather than printing it flat.
    const report = formatTeamReport(status);
    expect(report).toContain("$0.25+");
    expect(report).toContain("n/a");
  });

  it("aborts a member that blows through its turn ceiling", async () => {
    const { manager, spawned } = await harness(
      { plan: scriptedPlanner([twoWay]), maxTurnsPerMember: 2 },
      () =>
        new FakeAgent({
          run: async (agent) => {
            for (let index = 0; index < 3; index++) {
              agent.emit({ type: "turnEnd", turnIndex: index, usage: usage() });
            }
          },
        }),
    );
    const status = await manager.start("go");
    expect(spawned[0]?.agent.aborts).toBeGreaterThan(0);
    expect(status.members[0]?.error).toContain("turn ceiling");
  });

  it("counts tool calls", async () => {
    const { manager } = await harness(
      { plan: scriptedPlanner([twoWay]) },
      () =>
        new FakeAgent({
          // Same reason as the concurrency fixture: a member that says nothing
          // and changes nothing is a failure now, and that is not this test.
          text: "read and edited",
          run: async (agent) => {
            agent.emit({ type: "toolStart", toolCallId: "1", toolName: "read", input: {} });
            agent.emit({ type: "toolStart", toolCallId: "2", toolName: "edit", input: {} });
          },
        }),
    );
    const status = await manager.start("go");
    expect(status.members[0]?.toolCalls).toBe(2);
  });

  it("emits live per-member status transitions", async () => {
    const seen: string[] = [];
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]) });
    const unsubscribe = manager.onUpdate((status) => {
      for (const member of status.members) seen.push(`${member.id}:${member.status}`);
    });
    await manager.start("go");
    unsubscribe();
    expect(seen).toContain("a:running");
    expect(seen).toContain("a:done");
    expect(seen).toContain("b:done");
  });

  it("passes the member's role, scope and turn budget to spawn", async () => {
    const planned = planJson([
      { id: "a", role: "reviewer", files: ["a/**"] },
      { id: "b", role: "implementer", files: ["b/**"] },
    ]);
    const { manager, spawned } = await harness({
      plan: scriptedPlanner([planned]),
      maxTurnsPerMember: 7,
    });
    await manager.start("go");
    expect(spawned[0]?.brief.role.name).toBe("reviewer");
    expect(spawned[0]?.brief.role.readOnly).toBe(true);
    expect(spawned[0]?.brief.files).toEqual(["a/**"]);
    expect(spawned[0]?.brief.maxTurns).toBe(7);
    expect(spawned[1]?.brief.role.readOnly).toBe(false);
  });

  it("falls back to the default role when the plan names an unknown one", async () => {
    const planned = planJson([
      { id: "a", role: "wizard", files: ["a/**"] },
      { id: "b", role: "implementer", files: ["b/**"] },
    ]);
    const { manager, spawned } = await harness({ plan: scriptedPlanner([planned]) });
    const status = await manager.start("go");
    expect(spawned[0]?.brief.role.name).toBe(DEFAULT_TEAM_ROLE_NAME);
    expect(status.members[0]?.role).toBe(DEFAULT_TEAM_ROLE_NAME);
  });

  it("records a member whose worktree could not be created", async () => {
    const git = fakeGit((args) =>
      args[0] === "worktree" && args[1] === "add" ? new Error("no space left") : undefined,
    );
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]), execFn: git.execFn });
    const status = await manager.start("go");
    expect(status.members.every((member) => member.status === "failed")).toBe(true);
    expect(status.status).toBe("failed");
  });
});

// ============================================================ capture + cancel

describe("TeamManager capture and cancellation", () => {
  const twoWay = planJson([
    { id: "a", files: ["a/**"] },
    { id: "b", files: ["b/**"] },
  ]);

  function gitWithDiff(diff: string): FakeGit {
    return fakeGit((args) =>
      args[0] === "diff" ? { stdout: diff, stderr: "" } : { stdout: "", stderr: "" },
    );
  }

  const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -0,0 +1 @@",
    "+export const a = 1;",
    "",
  ].join("\n");

  it("stages before diffing and writes each member's patch to disk", async () => {
    const git = gitWithDiff(DIFF);
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]), execFn: git.execFn });
    const status = await manager.start("go");

    const addIndex = git.argv().indexOf("add --all");
    const diffIndex = git.argv().findIndex((line) => line.startsWith("diff --cached"));
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(diffIndex).toBeGreaterThan(addIndex);

    for (const member of status.members) {
      expect(member.patchFile).toBeDefined();
      expect(member.diffStat).toEqual({ files: 1, added: 1, removed: 0 });
      if (!member.patchFile) continue;
      expect(await readFile(member.patchFile, "utf8")).toBe(DIFF);
    }
  });

  it("records no patch when a member changed nothing", async () => {
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]) });
    const status = await manager.start("go");
    expect(status.members[0]?.patchFile).toBeUndefined();
    expect(status.members[0]?.diffStat.files).toBe(0);
  });

  it("cancel cascades to every member, keeps their partial work, and removes every worktree", async () => {
    const git = gitWithDiff(DIFF);
    const fiveWay = planJson([
      { id: "a", files: ["a/**"] },
      { id: "b", files: ["b/**"] },
      { id: "c", files: ["c/**"] },
    ]);
    let started = 0;
    const { manager, spawned } = await harness(
      { plan: scriptedPlanner([fiveWay]), execFn: git.execFn, concurrency: 2 },
      () =>
        new FakeAgent({
          run: async () => {
            started++;
            await never();
          },
          text: "partial work",
        }),
    );

    const run = manager.start("go");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const live = manager.list()[0];
    expect(live).toBeDefined();
    if (!live) return;
    expect(manager.cancel(live.id)).toBe(true);
    const status = await run;

    expect(started).toBe(2);
    for (const entry of spawned) expect(entry.agent.aborts).toBeGreaterThan(0);
    expect(status.status).toBe("cancelled");
    expect(status.members.every((member) => member.status === "cancelled")).toBe(true);
    // Partial work survived as a patch even though the run was cut short.
    expect(status.members[0]?.patchFile).toBeDefined();
    // The queued member never got a worktree; the started ones got theirs removed.
    expect(removedDirs(git).sort()).toEqual([...addedDirs(git)].sort());
    for (const member of status.members) expect(member.worktreeDir).toBeUndefined();
    expect(manager.cancel(live.id)).toBe(false);
  });

  it("keeps a member that finished before the cutoff marked done, patch and all", async () => {
    const git = gitWithDiff(DIFF);
    const threeWay = planJson([
      { id: "a", files: ["a/**"] },
      { id: "b", files: ["b/**"] },
      { id: "c", files: ["c/**"] },
    ]);
    const { manager } = await harness(
      { plan: scriptedPlanner([threeWay]), execFn: git.execFn, concurrency: 1 },
      (brief) =>
        brief.id === "a"
          ? new FakeAgent({ text: "a landed" })
          : new FakeAgent({ run: never, text: "stuck" }),
    );
    const run = manager.start("go");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const live = manager.list()[0];
    expect(live).toBeDefined();
    if (!live) return;
    manager.cancel(live.id);
    const status = await run;

    expect(status.status).toBe("cancelled");
    expect(status.members[0]?.status).toBe("done");
    expect(status.members[0]?.patchFile).toBeDefined();
    expect(status.members[1]?.status).toBe("cancelled");
    // A cancelled team's work — the member that landed AND the partial work
    // captured from the one that was stopped — is all still mergeable.
    const report = await manager.merge(status.id);
    expect(report?.merged).toBe(2);
    expect(report?.outcomes[2]?.result).toBe("empty"); // never started, no worktree
    expect(manager.get(status.id)?.status).toBe("merged");
  });

  it("treats an external abort signal as a cancel", async () => {
    const controller = new AbortController();
    const { manager } = await harness(
      { plan: scriptedPlanner([twoWay]) },
      () => new FakeAgent({ run: never }),
    );
    const run = manager.start("go", { signal: controller.signal } satisfies StartTeamOptions);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const status = await run;
    expect(status.status).toBe("cancelled");
  });

  it("demotes a failed worktree teardown to a warning", async () => {
    const git = fakeGit((args) =>
      args[0] === "worktree" && args[1] === "remove" ? new Error("locked") : undefined,
    );
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]), execFn: git.execFn });
    const status = await manager.start("go");
    expect(status.status).toBe("review");
    expect(status.warnings.join(" ")).toContain("worktree remove failed");
  });
});

// =================================================================== merging

describe("TeamManager merge", () => {
  const twoWay = planJson([
    { id: "a", files: ["a/**"] },
    { id: "b", files: ["b/**"] },
  ]);

  function gitFor(options: { diff: string; conflictOn?: (patch: string) => boolean }): FakeGit {
    return fakeGit((args) => {
      if (args[0] === "diff") return { stdout: options.diff, stderr: "" };
      if (args[0] === "apply") {
        const patch = args[args.length - 1] ?? "";
        if (options.conflictOn?.(patch)) {
          return Object.assign(new Error("apply failed"), {
            stderr: "error: patch does not apply\nerror: src/a.ts: does not match index",
          });
        }
      }
      return { stdout: "", stderr: "" };
    });
  }

  const DIFF = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@", "+one", ""].join("\n");

  it("applies every member's patch cleanly and marks the team merged", async () => {
    const git = gitFor({ diff: DIFF });
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]), execFn: git.execFn });
    const status = await manager.start("go");

    const report = await manager.merge(status.id);
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.merged).toBe(2);
    expect(report.conflicts).toBe(0);
    expect(report.complete).toBe(true);
    expect(report.outcomes.map((outcome) => outcome.result)).toEqual(["merged", "merged"]);
    expect(manager.get(status.id)?.status).toBe("merged");

    // Check before apply, every time, and never --3way or --force.
    const applies = git.argv().filter((line) => line.startsWith("apply"));
    expect(applies).toHaveLength(4);
    expect(applies[0]).toContain("--check");
    expect(applies[1]).not.toContain("--check");
    expect(applies.join(" ")).not.toContain("3way");
    expect(applies.join(" ")).not.toContain("--force");
  });

  it("surfaces a conflict, stops, and keeps the member's patch on disk", async () => {
    const git = gitFor({ diff: DIFF, conflictOn: (patch) => patch.endsWith("b.patch") });
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]), execFn: git.execFn });
    const status = await manager.start("go");
    const report = await manager.merge(status.id);
    expect(report).toBeDefined();
    if (!report) return;

    expect(report.merged).toBe(1);
    expect(report.conflicts).toBe(1);
    expect(report.complete).toBe(false);
    expect(report.outcomes[0]?.result).toBe("merged");
    expect(report.outcomes[1]?.result).toBe("conflict");
    expect(report.outcomes[1]?.conflict).toContain("does not apply");

    const after = manager.get(status.id);
    expect(after?.status).toBe("review");
    const conflicted = after?.members[1];
    expect(conflicted?.merged).toBe(false);
    expect(conflicted?.patchFile).toBeDefined();
    if (conflicted?.patchFile) {
      // Nothing was dropped: the work is still on disk for the user to resolve.
      expect((await stat(conflicted.patchFile)).isFile()).toBe(true);
    }
    expect(formatMergeReport(report)).toContain("CONFLICT");
    expect(formatMergeReport(report)).toContain("--3way");
  });

  it("stops at the first conflict instead of applying later patches over a half-merged tree", async () => {
    const threeWay = planJson([
      { id: "a", files: ["a/**"] },
      { id: "b", files: ["b/**"] },
      { id: "c", files: ["c/**"] },
    ]);
    const git = gitFor({ diff: DIFF, conflictOn: (patch) => patch.endsWith("a.patch") });
    const { manager } = await harness({ plan: scriptedPlanner([threeWay]), execFn: git.execFn });
    const status = await manager.start("go");
    const report = await manager.merge(status.id);
    expect(report?.outcomes.map((outcome) => outcome.result)).toEqual([
      "conflict",
      "skipped",
      "skipped",
    ]);
    expect(report?.merged).toBe(0);
    // Only member a's patch was even offered to git.
    const applied = git.argv().filter((line) => line.startsWith("apply"));
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain("--check");
  });

  it("resumes a partially merged team without re-applying what already landed", async () => {
    let conflict = true;
    const git = gitFor({
      diff: DIFF,
      conflictOn: (patch) => conflict && patch.endsWith("b.patch"),
    });
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]), execFn: git.execFn });
    const status = await manager.start("go");
    await manager.merge(status.id);

    conflict = false;
    const second = await manager.merge(status.id);
    expect(second?.outcomes[0]?.result).toBe("already-merged");
    expect(second?.outcomes[1]?.result).toBe("merged");
    expect(second?.complete).toBe(true);
    // a.patch was applied exactly once across both merges (check + apply).
    const aApplies = git
      .argv()
      .filter((line) => line.startsWith("apply") && line.includes("a.patch"));
    expect(aApplies).toHaveLength(2);
  });

  it("merges only the requested members", async () => {
    const git = gitFor({ diff: DIFF });
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]), execFn: git.execFn });
    const status = await manager.start("go");
    const report = await manager.merge(status.id, { members: ["b"] });
    expect(report?.outcomes[0]?.result).toBe("skipped");
    expect(report?.outcomes[1]?.result).toBe("merged");
    expect(report?.complete).toBe(false);
  });

  it("reports an empty member instead of calling git apply", async () => {
    const git = fakeGit();
    // Each member SAYS it changed nothing: text with no diff is the honest
    // "empty". A member with neither is failed by the void gate, not empty.
    const { manager } = await harness(
      { plan: scriptedPlanner([twoWay]), execFn: git.execFn },
      () => new FakeAgent({ text: "nothing to change" }),
    );
    const status = await manager.start("go");
    const report = await manager.merge(status.id);
    expect(report?.outcomes.every((outcome) => outcome.result === "empty")).toBe(true);
    expect(report?.complete).toBe(true);
    expect(git.argv().some((line) => line.startsWith("apply"))).toBe(false);
  });

  it("returns undefined for an unknown team", async () => {
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]) });
    expect(await manager.merge("team-nope")).toBeUndefined();
    expect(await manager.discard("team-nope")).toBeUndefined();
  });

  it("discard deletes the patches and prunes the worktrees", async () => {
    const git = gitFor({ diff: DIFF });
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]), execFn: git.execFn });
    const status = await manager.start("go");
    const patch = status.members[0]?.patchFile;
    expect(patch).toBeDefined();

    const after = await manager.discard(status.id);
    expect(after?.status).toBe("discarded");
    expect(after?.members.every((member) => member.discarded)).toBe(true);
    expect(after?.members[0]?.patchFile).toBeUndefined();
    if (patch) await expect(stat(patch)).rejects.toThrow();
    expect(git.argv()).toContain("worktree prune");

    const report = await manager.merge(status.id);
    expect(report?.outcomes.every((outcome) => outcome.result === "discarded")).toBe(true);
  });
});

// ================================================================= void gate

describe("TeamManager void gate", () => {
  // The team's copy of the workflow engine's `stepProducedNothing`: a member
  // that finished on its own, changed no file and said nothing has not run.
  // Before the gate it was recorded `done`, merge() folded it into "empty",
  // and the team read as merged-and-complete while the member's work never
  // existed. Either half alone is a result — a patch with no words, or words
  // with no patch — and both must keep merging as they always have.
  const twoWay = planJson([
    { id: "a", files: ["a/**"] },
    { id: "b", files: ["b/**"] },
  ]);
  const DIFF = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@", "+one", ""].join("\n");

  it("fails a member that returned no text and changed no file, and merge() says so", async () => {
    const git = fakeGit();
    const { manager } = await harness(
      { plan: scriptedPlanner([twoWay]), execFn: git.execFn },
      (brief) =>
        brief.id === "a"
          ? new FakeAgent({ text: "" })
          : new FakeAgent({ text: "b: nothing to change here" }),
    );
    const status = await manager.start("go");
    expect(status.members[0]?.finalText).toBeUndefined();
    expect(status.members[0]?.patchFile).toBeUndefined();
    expect(status.members[0]?.status).toBe("failed");
    expect(status.members[0]?.error).toContain('member "a" produced nothing');
    // The sibling that said why it changed nothing is the honest "no changes".
    expect(status.members[1]?.status).toBe("done");
    expect(status.members[1]?.error).toBeUndefined();

    const report = await manager.merge(status.id);
    expect(report?.outcomes[0]?.result).toBe("failed");
    expect(report?.outcomes[0]?.failure).toContain("produced nothing");
    expect(report?.outcomes[1]?.result).toBe("empty");
    // The two lines that were lying before:
    expect(report?.complete).toBe(false);
    expect(manager.get(status.id)?.status).not.toBe("merged");
    expect(git.argv().some((line) => line.startsWith("apply"))).toBe(false);
    // And the report carries the reason where the user reads it.
    expect(formatMergeReport(report as NonNullable<typeof report>)).toContain("produced nothing");
  });

  it("keeps a member that said why it changed nothing done, and merges it as empty", async () => {
    const git = fakeGit();
    const { manager } = await harness(
      { plan: scriptedPlanner([twoWay]), execFn: git.execFn },
      () => new FakeAgent({ text: "nothing to change" }),
    );
    const status = await manager.start("go");
    expect(status.members.map((member) => member.status)).toEqual(["done", "done"]);
    expect(status.members.every((member) => member.error === undefined)).toBe(true);

    const report = await manager.merge(status.id);
    expect(report?.outcomes.map((outcome) => outcome.result)).toEqual(["empty", "empty"]);
    expect(report?.complete).toBe(true);
    expect(manager.get(status.id)?.status).toBe("merged");
  });

  it("keeps a member that changed a file but said nothing done — the patch is the result", async () => {
    const git = fakeGit((args) =>
      args[0] === "diff" ? { stdout: DIFF, stderr: "" } : { stdout: "", stderr: "" },
    );
    const { manager } = await harness(
      { plan: scriptedPlanner([twoWay]), execFn: git.execFn },
      () => new FakeAgent({ text: "" }),
    );
    const status = await manager.start("go");
    expect(status.members.map((member) => member.status)).toEqual(["done", "done"]);
    expect(status.members[0]?.patchFile).toBeDefined();
    expect(status.members[0]?.error).toBeUndefined();

    const report = await manager.merge(status.id);
    expect(report?.merged).toBe(2);
    expect(report?.complete).toBe(true);
  });

  it("keeps a cancelled member that produced nothing cancelled, not failed", async () => {
    const { manager } = await harness(
      { plan: scriptedPlanner([twoWay]) },
      () => new FakeAgent({ run: never }),
    );
    const run = manager.start("go");
    await delay(20);
    const live = manager.list()[0];
    expect(live).toBeDefined();
    if (!live) return;
    manager.cancel(live.id);
    const status = await run;

    expect(status.status).toBe("cancelled");
    expect(status.members.map((member) => member.status)).toEqual(["cancelled", "cancelled"]);
    for (const member of status.members) {
      expect(member.error).toBeDefined();
      expect(member.error).not.toContain("produced nothing");
    }
  });

  it("lets a thrown error win over the produced-nothing message", async () => {
    const { manager } = await harness({ plan: scriptedPlanner([twoWay]) }, (brief) =>
      brief.id === "a"
        ? new FakeAgent({ run: () => Promise.reject(new Error("member blew up")) })
        : new FakeAgent({ text: "b fine" }),
    );
    const status = await manager.start("go");
    expect(status.members[0]?.status).toBe("failed");
    expect(status.members[0]?.error).toContain("member blew up");
    expect(status.members[0]?.error).not.toContain("produced nothing");

    const report = await manager.merge(status.id);
    expect(report?.outcomes[0]?.result).toBe("failed");
    expect(report?.outcomes[0]?.failure).toContain("member blew up");
    expect(report?.complete).toBe(false);
  });

  it("fails a member stopped at its turn ceiling with nothing to show, and keeps the ceiling as the reason", async () => {
    // The ceiling note is a reason the run already recorded — it says WHY
    // nothing came back — so it outranks the generic message. The member is
    // still not `done`: it produced nothing.
    const { manager, spawned } = await harness(
      { plan: scriptedPlanner([twoWay]), maxTurnsPerMember: 1 },
      () =>
        new FakeAgent({
          run: async (agent) => {
            agent.emit({ type: "turnEnd", turnIndex: 0, usage: usage() });
          },
        }),
    );
    const status = await manager.start("go");
    expect(spawned[0]?.agent.aborts).toBeGreaterThan(0);
    expect(status.members[0]?.status).toBe("failed");
    expect(status.members[0]?.error).toContain("turn ceiling");
    expect(status.members[0]?.error).not.toContain("produced nothing");
  });
});

// ================================================================== recovery

describe("TeamManager recovery", () => {
  it("marks a stale running record interrupted, salvages its worktrees, then removes them", async () => {
    const dir = await scratchDir();
    const worktree = join(dir, "worktrees", "team-dead", "1-a");
    const record = {
      id: "team-dead",
      goal: "a goal from a dead process",
      roles: [],
      status: "running",
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 10_000,
      warnings: [],
      needsRecovery: true,
      members: [
        {
          id: "a",
          title: "A",
          role: "implementer",
          task: "t",
          files: ["a/**"],
          status: "running",
          worktreeDir: worktree,
          diffStat: { files: 0, added: 0, removed: 0 },
          merged: false,
          discarded: false,
          costUsd: 0,
          turns: 0,
          toolCalls: 0,
        },
      ],
    };
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    await mkdir(join(dir, "records"), { recursive: true });
    await write(join(dir, "records", "team-dead.json"), JSON.stringify(record));

    const salvagedDiff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+rescued\n";
    const git = fakeGit((args) =>
      args[0] === "diff" ? { stdout: salvagedDiff, stderr: "" } : { stdout: "", stderr: "" },
    );
    const manager = new TeamManager({
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([""]),
      spawn: () => new FakeAgent(),
      execFn: git.execFn,
    });

    // Loading alone corrects the record; the git work waits for recover().
    const loaded = manager.get("team-dead");
    expect(loaded?.status).toBe("interrupted");
    expect(loaded?.members[0]?.status).toBe("interrupted");
    expect(loaded?.warnings.join(" ")).toContain("exited before it finished");

    const report = await manager.recover();
    expect(report.teams).toEqual(["team-dead"]);
    expect(report.salvaged).toEqual(["team-dead/a"]);
    expect(report.removedWorktrees).toEqual([worktree]);
    expect(git.argv()).toContain(`worktree remove --force ${worktree}`);
    expect(git.argv()).toContain("worktree prune");

    const recovered = manager.get("team-dead");
    expect(recovered?.members[0]?.worktreeDir).toBeUndefined();
    expect(recovered?.members[0]?.patchFile).toBeDefined();
    if (recovered?.members[0]?.patchFile) {
      expect(await readFile(recovered.members[0].patchFile, "utf8")).toBe(salvagedDiff);
    }

    // Idempotent: a second recover does no further git work.
    const before = git.calls.length;
    const again = await manager.recover();
    expect(again.teams).toEqual(["team-dead"]);
    expect(git.calls.length).toBe(before);

    // And a fresh manager over the same dir has nothing left to recover.
    const reopened = new TeamManager({
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([""]),
      spawn: () => new FakeAgent(),
      execFn: git.execFn,
    });
    expect((await reopened.recover()).teams).toEqual([]);
    expect(reopened.get("team-dead")?.status).toBe("interrupted");
  });

  it("skips a corrupt record file instead of failing to load", async () => {
    const dir = await scratchDir();
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    await mkdir(join(dir, "records"), { recursive: true });
    await write(join(dir, "records", "broken.json"), "{not json");
    await write(join(dir, "records", "partial.json"), JSON.stringify({ id: "x" }));
    const manager = new TeamManager({
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([""]),
      spawn: () => new FakeAgent(),
      execFn: fakeGit().execFn,
    });
    expect(manager.list()).toHaveLength(0);
  });

  it("persists a finished team across managers", async () => {
    const dir = await scratchDir();
    const git = fakeGit();
    const options: TeamManagerOptions = {
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([
        planJson([
          { id: "a", files: ["a/**"] },
          { id: "b", files: ["b/**"] },
        ]),
      ]),
      spawn: () => new FakeAgent({ text: "ok" }),
      execFn: git.execFn,
    };
    const first = new TeamManager(options);
    const status = await first.start("go");

    const second = new TeamManager(options);
    const reloaded = second.get(status.id);
    expect(reloaded?.status).toBe("review");
    expect(reloaded?.members.map((member) => member.id)).toEqual(["a", "b"]);
    expect(second.latest()?.id).toBe(status.id);
  });
});

// ================================================================= reporting

describe("reporting", () => {
  it("renders the reconciliation view with patches and the merge instruction", async () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+one\n-two\n";
    const git = fakeGit((args) =>
      args[0] === "diff" ? { stdout: diff, stderr: "" } : { stdout: "", stderr: "" },
    );
    const { manager } = await harness(
      {
        plan: scriptedPlanner([
          planJson([
            { id: "a", files: ["a/**"] },
            { id: "b", files: ["b/**"] },
          ]),
        ]),
        execFn: git.execFn,
      },
      (brief) => new FakeAgent({ text: `${brief.id} report line` }),
    );
    const status = await manager.start("do everything");
    const rendered = formatTeamReport(status);
    expect(rendered).toContain(status.id);
    expect(rendered).toContain("goal: do everything");
    expect(rendered).toContain("scope: a/**");
    expect(rendered).toContain("1 file, +1/-1");
    expect(rendered).toContain("a report line");
    expect(rendered).toContain(`/team merge ${status.id}`);
  });

  it("says when there is nothing to merge", async () => {
    const { manager } = await harness({
      plan: scriptedPlanner([
        planJson([
          { id: "a", files: ["a/**"] },
          { id: "b", files: ["b/**"] },
        ]),
      ]),
    });
    const status = await manager.start("go");
    expect(formatTeamReport(status)).toContain("Nothing left to merge.");
  });
});

// ================================================================== commands

interface FakeUi extends CommandUi {
  lines: string[];
  notices: { level: string; text: string }[];
  input: string;
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    lines: [],
    notices: [],
    input: "",
    print(content) {
      ui.lines.push(...(typeof content === "string" ? content.split("\n") : content));
    },
    notice(level, text) {
      ui.notices.push({ level, text });
    },
    async select<T>(_title: string, _options: readonly SelectOption<T>[]) {
      return undefined;
    },
    setInput(text) {
      ui.input = text;
    },
    clear() {},
    exit() {},
  };
  return ui;
}

describe("parseTeamArgs", () => {
  it("parses flags then a goal", () => {
    const parsed = parseTeamArgs(
      "--roles implementer,Reviewer --members 3 --max-cost $2.50 --parallel 2 ship the thing",
    );
    expect(parsed.roles).toEqual(["implementer", "reviewer"]);
    expect(parsed.maxMembers).toBe(3);
    expect(parsed.maxCostUsd).toBe(2.5);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.goal).toBe("ship the thing");
    expect(parsed.sub).toBeUndefined();
  });

  it("accepts `--flag=value`", () => {
    expect(parseTeamArgs("--roles=tester,reviewer fix it").roles).toEqual(["tester", "reviewer"]);
  });

  it("recognises sub-commands only when they are the whole argument", () => {
    expect(parseTeamArgs("status").sub).toBe("status");
    expect(parseTeamArgs("merge team-1")).toMatchObject({ sub: "merge", id: "team-1" });
    expect(parseTeamArgs("cancel").sub).toBe("cancel");
    expect(parseTeamArgs("discard team-2")).toMatchObject({ sub: "discard", id: "team-2" });
    const goal = parseTeamArgs("status page shows stale data");
    expect(goal.sub).toBeUndefined();
    expect(goal.goal).toBe("status page shows stale data");
  });

  it("ignores nonsense flag values", () => {
    const parsed = parseTeamArgs("--members zero --parallel -3 go");
    expect(parsed.maxMembers).toBeUndefined();
    expect(parsed.concurrency).toBeUndefined();
    expect(parsed.goal).toBe("go");
  });
});

describe("/team command", () => {
  const twoWay = planJson([
    { id: "a", files: ["a/**"] },
    { id: "b", files: ["b/**"] },
  ]);
  const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+one\n";

  async function commandHarness(
    diff = DIFF,
    makeAgent?: (brief: TeamMemberBrief) => FakeAgent,
  ): Promise<{
    run: (args: string) => Promise<FakeUi>;
    manager: TeamManager;
    git: FakeGit;
  }> {
    const git = fakeGit((args) =>
      args[0] === "diff" ? { stdout: diff, stderr: "" } : { stdout: "", stderr: "" },
    );
    const dir = await scratchDir();
    const manager = new TeamManager({
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([twoWay]),
      spawn: (brief) => makeAgent?.(brief) ?? new FakeAgent({ text: `${brief.id} finished` }),
      execFn: git.execFn,
    });
    const [command] = createTeamCommands({ manager: () => manager });
    // A team's members bill against their own agents, so the command folds
    // their spend back into the session. The fake has to implement what the
    // command actually calls, and recording it lets the tests assert it.
    // `undefined` is part of the contract now: it is how a turn nobody could
    // price reaches the session, so the fake has to be able to receive it.
    const externalCosts: (number | undefined)[] = [];
    const runtime = {
      recordExternalCost: (costUsd: number | undefined) => {
        externalCosts.push(costUsd);
      },
    } as unknown as ArcturnRuntime;
    return {
      manager,
      git,
      externalCosts,
      async run(args: string): Promise<FakeUi> {
        const ui = fakeUi();
        await command?.run({ runtime, ui, args, commands: new CommandRegistry() });
        return ui;
      },
    };
  }

  it("tells the session about team turns it could not price", async () => {
    // `recordExternalCost(0)` early-returns, so an all-unpriced team used to
    // leave the session metrics untouched — the footer then swore the session
    // had spent nothing while a whole team ran. Report the unknowns instead.
    const { run, externalCosts } = await commandHarness(
      DIFF,
      () =>
        new FakeAgent({
          run: async (agent) => {
            agent.emit({ type: "turnEnd", turnIndex: 0, usage: usage() });
          },
          text: "done, price unknown",
        }),
    );
    const ui = await run("split the work");
    expect(externalCosts).toContain(undefined);
    expect(ui.lines.join("\n")).not.toContain("$0.00");
  });

  it("exposes one command with a usage string", () => {
    const [command] = createTeamCommands();
    expect(command?.name).toBe("team");
    expect(command?.description).toContain("/team <goal>");
    expect(command?.description).toContain("merge");
  });

  it("says there are no teams yet", async () => {
    const { run } = await commandHarness();
    const ui = await run("");
    expect(ui.notices[0]?.text).toContain("No teams yet");
  });

  it("dispatches, shows live per-member status, then the reconciliation view", async () => {
    const { run, externalCosts } = await commandHarness();
    const ui = await run("split the work");
    const output = ui.lines.join("\n");
    expect(output).toContain("members dispatched in parallel worktrees");
    // Team spend must reach the session, or /cost and --max-cost under-report.
    expect(externalCosts).toHaveLength(1);
    expect(output).toContain("a [implementer]");
    expect(output).toContain("✓ a [implementer] done");
    expect(output).toContain("a finished");
    expect(output).toContain("/team merge team-");
  });

  it("lists teams, then reports one", async () => {
    const { run, manager } = await commandHarness();
    await run("split the work");
    const list = await run("status");
    expect(list.lines[0]).toBe("Teams");
    const id = manager.latest()?.id;
    expect(id).toBeDefined();
    if (!id) return;
    const one = await run(`status ${id}`);
    expect(one.lines.join("\n")).toContain(`Team ${id}`);
  });

  it("merges the newest team when no id is given", async () => {
    const { run, git } = await commandHarness();
    await run("split the work");
    const ui = await run("merge");
    expect(ui.lines.join("\n")).toContain("2 applied, 0 conflicts");
    expect(git.argv().filter((line) => line.startsWith("apply"))).toHaveLength(4);
  });

  it("warns when the merge hits a conflict", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "diff") return { stdout: DIFF, stderr: "" };
      if (args[0] === "apply") {
        return Object.assign(new Error("boom"), { stderr: "error: patch does not apply" });
      }
      return { stdout: "", stderr: "" };
    });
    const dir = await scratchDir();
    const manager = new TeamManager({
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([twoWay]),
      spawn: () => new FakeAgent({ text: "done" }),
      execFn: git.execFn,
    });
    const [command] = createTeamCommands({ manager: () => manager });
    const runtime = {} as ArcturnRuntime;
    const dispatch = fakeUi();
    await command?.run({ runtime, ui: dispatch, args: "go", commands: new CommandRegistry() });
    const merge = fakeUi();
    await command?.run({ runtime, ui: merge, args: "merge", commands: new CommandRegistry() });
    expect(merge.notices.some((notice) => notice.text.includes("nothing lost"))).toBe(true);
    expect(merge.lines.join("\n")).toContain("CONFLICT");
  });

  it("discards a team", async () => {
    const { run } = await commandHarness();
    await run("split the work");
    const ui = await run("discard");
    expect(ui.notices[0]?.text).toContain("patches deleted");
  });

  it("reports an unknown team id", async () => {
    const { run } = await commandHarness();
    await run("split the work");
    const ui = await run("merge team-nope");
    expect(ui.notices[0]?.level).toBe("error");
    expect(ui.notices[0]?.text).toContain('No team "team-nope"');
  });

  it("says a settled team cannot be cancelled", async () => {
    const { run } = await commandHarness();
    await run("split the work");
    const ui = await run("cancel");
    expect(ui.notices[0]?.text).toContain("already review");
  });
});

// ------------------------------------------------------------ real git (gated)

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const hasGit = await gitAvailable();

describe.skipIf(!hasGit)("TeamManager against real git", () => {
  async function makeRepo(autocrlf = false): Promise<string> {
    const dir = await scratchDir("arcturn-team-repo-");
    const run = (args: string[]): Promise<unknown> => execFileAsync("git", args, { cwd: dir });
    await run(["init", "--quiet"]);
    await run(["config", "user.email", "team@example.com"]);
    await run(["config", "user.name", "Team"]);
    // A throwaway repository must not inherit the machine's line-ending
    // policy. Git for Windows defaults `core.autocrlf=true`, which rewrites
    // every checkout to CRLF — so a byte-exact assertion about what a member
    // wrote becomes an assertion about the runner's git config, and fails on
    // windows-latest for a reason that has nothing to do with the team lane.
    // Arcturn's own checkout gets this from `.gitattributes`; these get it
    // explicitly, and "survives a CRLF checkout" below turns the other
    // convention on deliberately rather than inheriting it by accident.
    await run(["config", "core.autocrlf", autocrlf ? "true" : "false"]);
    await run(["config", "core.eol", autocrlf ? "crlf" : "lf"]);
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await run(["add", "."]);
    await run(["commit", "--quiet", "-m", "seed"]);
    return dir;
  }

  async function managerFor(
    repo: string,
    plan: string,
    write: (brief: TeamMemberBrief, cwd: string) => Promise<void>,
  ): Promise<TeamManager> {
    return new TeamManager({
      dir: await scratchDir("arcturn-team-state-"),
      repoRoot: repo,
      plan: scriptedPlanner([plan]),
      spawn: (brief, cwd) =>
        new FakeAgent({
          text: `${brief.id} wrote files`,
          run: async () => {
            await write(brief, cwd);
          },
        }),
    });
  }

  it("isolates two members writing the SAME filename in their own worktrees", async () => {
    const repo = await makeRepo();
    const plan = planJson([
      { id: "a", files: ["a/**"] },
      { id: "b", files: ["b/**"] },
    ]);
    const seen = new Map<string, string>();
    const manager = await managerFor(repo, plan, async (brief, cwd) => {
      // Every member writes a file with the SAME name. In one tree that is a
      // collision; in three worktrees it is three independent files.
      await writeFile(join(cwd, "shared.ts"), `export const owner = "${brief.id}";\n`);
      seen.set(brief.id, await readFile(join(cwd, "shared.ts"), "utf8"));
      // The sibling's write must be invisible from here.
      const sibling = brief.id === "a" ? "b" : "a";
      const contents = await readFile(join(cwd, "shared.ts"), "utf8");
      expect(contents).not.toContain(sibling);
    });

    const status = await manager.start("both touch shared.ts");
    expect(status.members).toHaveLength(2);
    expect(seen.get("a")).toContain('"a"');
    expect(seen.get("b")).toContain('"b"');
    // Neither write reached the user's tree.
    await expect(stat(join(repo, "shared.ts"))).rejects.toThrow();
    // Both diffs were captured even though they conflict with each other.
    expect(status.members[0]?.diffStat.files).toBe(1);
    expect(status.members[1]?.diffStat.files).toBe(1);
    // And no worktree was left behind.
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
    expect(stdout.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
  });

  it("does not report a team merged while a failed member has no work in it", async () => {
    // The mac release flake, pinned at last: `git worktree add` for one member
    // was killed by the per-git timeout on a starved runner, the member was
    // recorded failed with an empty diff, and merge() folded that into
    // "empty" — one file merged, zero conflicts, complete: true, record
    // flipped to "merged". A member that never got to work is absence of
    // evidence, and the record must not read as a finished team.
    const repo = await makeRepo();
    const plan = planJson([
      { id: "alpha", files: ["alpha.ts"] },
      { id: "beta", files: ["beta.ts"] },
    ]);
    const manager = await managerFor(repo, plan, async (brief, cwd) => {
      if (brief.id === "beta") throw new Error("worktree died under load");
      await writeFile(join(cwd, `${brief.id}.ts`), `export const ${brief.id} = 1;\n`);
    });
    const status = await manager.start("add two files");
    const report = await manager.merge(status.id);

    expect(report?.merged).toBe(1);
    expect(report?.conflicts).toBe(0);
    const beta = report?.outcomes.find((outcome) => outcome.memberId === "beta");
    expect(beta?.result).toBe("failed");
    expect(beta?.failure).toContain("worktree died under load");
    // The two lines that were lying before:
    expect(report?.complete).toBe(false);
    expect(manager.get(status.id)?.status).not.toBe("merged");
    // And the honest half still holds — alpha's work is really in the tree.
    expect(await readFile(join(repo, "alpha.ts"), "utf8")).toContain("alpha");
  });

  it("merges disjoint members cleanly into the real tree", async () => {
    const repo = await makeRepo();
    const plan = planJson([
      { id: "alpha", files: ["alpha.ts"] },
      { id: "beta", files: ["beta.ts"] },
    ]);
    const manager = await managerFor(repo, plan, async (brief, cwd) => {
      await writeFile(join(cwd, `${brief.id}.ts`), `export const ${brief.id} = 1;\n`);
    });
    const status = await manager.start("add two files");
    const report = await manager.merge(status.id);
    expect(report?.merged).toBe(2);
    expect(report?.conflicts).toBe(0);
    expect(await readFile(join(repo, "alpha.ts"), "utf8")).toContain("alpha");
    expect(await readFile(join(repo, "beta.ts"), "utf8")).toContain("beta");
    expect(manager.get(status.id)?.status).toBe("merged");
  });

  /**
   * Whether git regards this directory as a linked worktree — asked of git,
   * from inside it, rather than by matching a path against a listing.
   *
   * Matching the path does not survive Windows, which hands Node an 8.3 short
   * name (…/RUNNER~1/…) while git prints the long one, so two spellings of
   * one directory never compare equal. A linked worktree's git-dir is the
   * main repository's .git/worktrees/<name>, which is the fact the assertion
   * actually wants and is independent of how either side spells a path.
   */
  const isLinkedWorktree = async (dir: string): Promise<boolean> => {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: dir });
    return stdout.replace(/\\/g, "/").includes("/.git/worktrees/");
  };

  /** How many worktrees the repository has, counted rather than string-matched. */
  const worktreeCount = async (repo: string): Promise<number> => {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo,
    });
    return stdout.split("\n").filter((line) => line.startsWith("worktree ")).length;
  };

  it("really creates each member's worktree on disk, and really removes it afterwards", async () => {
    // The existing coverage proves worktrees are *asked for* (argv against a
    // fake git) and that one line survives in `git worktree list` at the end.
    // Neither says the checkout existed while the member was working in it, or
    // that the directory left the filesystem — which is what "cleans them all
    // up" has to mean on a machine that has to keep running afterwards.
    const repo = await makeRepo();
    const plan = planJson([
      { id: "alpha", files: ["alpha.ts"] },
      { id: "beta", files: ["beta.ts"] },
    ]);
    const live: { dir: string; seeded: boolean; registered: boolean }[] = [];
    const manager = await managerFor(repo, plan, async (brief, cwd) => {
      live.push({
        dir: cwd,
        // A real checkout, not an empty directory: the repository's own seed
        // file is in it.
        seeded: (await stat(join(cwd, "seed.txt"))).isFile(),
        // …and git itself knows about it while it is in use.
        registered: await isLinkedWorktree(cwd),
      });
      await writeFile(join(cwd, `${brief.id}.ts`), `export const ${brief.id} = 1;\n`);
    });

    const status = await manager.start("add two files");
    expect(live).toHaveLength(2);
    for (const entry of live) {
      expect(entry.seeded).toBe(true);
      expect(entry.registered).toBe(true);
    }
    expect(new Set(live.map((entry) => entry.dir)).size).toBe(2);

    // …and every one of them is gone from the filesystem once the team settles.
    for (const entry of live) await expect(stat(entry.dir)).rejects.toThrow();
    // Counted, not string-matched. A "the listing does not contain this path"
    // assertion passes for free the moment the two sides spell the path
    // differently — which is exactly what Windows does — so it would have gone
    // green with both worktrees still registered. One worktree left is the
    // repository itself.
    expect(await worktreeCount(repo)).toBe(1);
    // The work itself is not lost with the checkout: the patches outlive it.
    for (const member of status.members) {
      expect(member.patchFile).toBeDefined();
      expect((await stat(member.patchFile as string)).isFile()).toBe(true);
    }
  });

  it("discard removes the member's bytes: nothing lands and the patch leaves disk", async () => {
    // The other half of the merge test. `merge` is proved by reading the
    // user's files; `discard` was only ever proved by a `worktree prune` in a
    // fake git's argv, which says nothing about what is on disk.
    const repo = await makeRepo();
    const plan = planJson([
      { id: "alpha", files: ["alpha.ts"] },
      { id: "beta", files: ["beta.ts"] },
    ]);
    const manager = await managerFor(repo, plan, async (brief, cwd) => {
      await writeFile(join(cwd, `${brief.id}.ts`), `export const ${brief.id} = 1;\n`);
    });
    const status = await manager.start("add two files");
    const patches = status.members.map((member) => member.patchFile as string);
    for (const patch of patches) expect((await stat(patch)).isFile()).toBe(true);

    const after = await manager.discard(status.id);
    expect(after?.status).toBe("discarded");

    // Nothing reached the user's checkout…
    await expect(stat(join(repo, "alpha.ts"))).rejects.toThrow();
    await expect(stat(join(repo, "beta.ts"))).rejects.toThrow();
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
    expect(stdout.trim()).toBe("");
    // …and the discarded work is really gone rather than merely unreferenced.
    for (const patch of patches) await expect(stat(patch)).rejects.toThrow();
  });

  it("merges into a CRLF checkout, the way a Windows repository is configured", async () => {
    // `core.autocrlf=true` is Git for Windows' default, so a member's worktree
    // is checked out CRLF while the patch cut from it is LF — and a patch that
    // does not apply is a member's work lost. This turns that configuration on
    // deliberately, on every platform, rather than waiting for a runner to
    // have it: the assertion is that the CONTENT lands, and that the endings
    // are the ones the repository asked for rather than the ones the member's
    // editor happened to write.
    const repo = await makeRepo(true);
    // The seed file was WRITTEN with LF; deleting it and checking it out again
    // is what makes the working tree hold what a Windows clone would hold.
    await rm(join(repo, "seed.txt"));
    await execFileAsync("git", ["checkout", "--", "seed.txt"], { cwd: repo });
    expect(await readFile(join(repo, "seed.txt"), "utf8")).toBe("seed\r\n");

    const plan = planJson([{ id: "alpha", files: ["seed.txt"] }]);
    const manager = await managerFor(repo, plan, async (_brief, cwd) => {
      // What the member sees is a CRLF checkout…
      expect(await readFile(join(cwd, "seed.txt"), "utf8")).toBe("seed\r\n");
      // …and what its editor writes is ordinary LF.
      await writeFile(join(cwd, "seed.txt"), "seed\nedited by alpha\n");
    });
    const status = await manager.start("edit the seed");
    const report = await manager.merge(status.id);

    expect(report?.conflicts).toBe(0);
    expect(report?.merged).toBe(1);
    const merged = await readFile(join(repo, "seed.txt"), "utf8");
    expect(merged.replace(/\r\n/g, "\n")).toBe("seed\nedited by alpha\n");
    expect(merged).toBe("seed\r\nedited by alpha\r\n");
  });

  it("detects a real conflict and leaves the tree and the patch untouched", async () => {
    const repo = await makeRepo();
    const plan = planJson([
      { id: "one", files: ["seed.txt"] },
      { id: "two", files: ["other.txt"] },
    ]);
    const manager = await managerFor(repo, plan, async (brief, cwd) => {
      await writeFile(join(cwd, "seed.txt"), `changed by ${brief.id}\n`);
    });
    const status = await manager.start("both rewrite seed.txt");

    // The first patch lands; the second was cut against the original seed.txt
    // and cannot apply on top of it.
    const report = await manager.merge(status.id);
    expect(report?.merged).toBe(1);
    expect(report?.conflicts).toBe(1);
    expect(report?.outcomes[1]?.conflict).toBeTruthy();

    const conflicted = manager.get(status.id)?.members[1];
    expect(conflicted?.merged).toBe(false);
    expect(conflicted?.patchFile).toBeDefined();
    if (conflicted?.patchFile) {
      const patch = await readFile(conflicted.patchFile, "utf8");
      expect(patch).toContain("changed by two");
    }
    // The tree holds member one's version, not a clobbered mix.
    expect(await readFile(join(repo, "seed.txt"), "utf8")).toBe("changed by one\n");
  });

  it("cleans up real worktrees when the run is cancelled", async () => {
    const repo = await makeRepo();
    const plan = planJson([
      { id: "a", files: ["a.ts"] },
      { id: "b", files: ["b.ts"] },
    ]);
    const manager = new TeamManager({
      dir: await scratchDir("arcturn-team-state-"),
      repoRoot: repo,
      plan: scriptedPlanner([plan]),
      spawn: (brief, cwd) =>
        new FakeAgent({
          text: "partial",
          run: async () => {
            await writeFile(join(cwd, `${brief.id}.ts`), "partial\n");
            await never();
          },
        }),
    });
    const run = manager.start("go");
    await delay(150);
    const live = manager.list()[0];
    expect(live).toBeDefined();
    if (!live) return;
    manager.cancel(live.id);
    const status = await run;
    expect(status.status).toBe("cancelled");
    // Partial work survived as patches, and git knows about no extra worktree.
    expect(status.members.some((member) => member.patchFile !== undefined)).toBe(true);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
    expect(stdout.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
  });

  it("salvages and removes a real worktree left by a dead process", async () => {
    const repo = await makeRepo();
    const stateDir = await scratchDir("arcturn-team-state-");
    // Stand up a worktree exactly where a crashed run would have left one.
    const worktree = join(stateDir, "worktrees", "team-dead", "1-a");
    await execFileAsync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: repo });
    await writeFile(join(worktree, "rescued.ts"), "export const rescued = true;\n");

    const { mkdir, writeFile: write } = await import("node:fs/promises");
    await mkdir(join(stateDir, "records"), { recursive: true });
    await write(
      join(stateDir, "records", "team-dead.json"),
      JSON.stringify({
        id: "team-dead",
        goal: "crashed",
        roles: [],
        status: "running",
        createdAt: Date.now(),
        warnings: [],
        needsRecovery: true,
        members: [
          {
            id: "a",
            title: "A",
            role: "implementer",
            task: "t",
            files: ["a/**"],
            status: "running",
            worktreeDir: worktree,
            diffStat: { files: 0, added: 0, removed: 0 },
            merged: false,
            discarded: false,
            costUsd: 0,
            turns: 0,
            toolCalls: 0,
          },
        ],
      }),
    );

    const manager = new TeamManager({
      dir: stateDir,
      repoRoot: repo,
      plan: scriptedPlanner([""]),
      spawn: () => new FakeAgent(),
    });
    const report = await manager.recover();
    expect(report.salvaged).toEqual(["team-dead/a"]);
    await expect(stat(worktree)).rejects.toThrow();
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).not.toContain(worktree);

    const patch = manager.get("team-dead")?.members[0]?.patchFile;
    expect(patch).toBeDefined();
    if (!patch) return;
    expect(await readFile(patch, "utf8")).toContain("rescued.ts");
    // The rescued patch still applies to the untouched repo.
    const merged = await manager.merge("team-dead");
    expect(merged?.merged).toBe(1);
    expect(await readFile(join(repo, "rescued.ts"), "utf8")).toContain("rescued");
  });
});

// ---------------------------------------------------------- runtime wiring

describe("runtime wiring", () => {
  interface FakeSessionAgent extends TeamAgent {
    tools: { definition: { name: string } }[];
    setTools(tools: { definition: { name: string } }[]): void;
  }

  const ALL_TOOL_NAMES = ["read", "grep", "glob", "ls", "write", "edit", "bash", "subagent"];

  function fakeRuntime(home: string): {
    runtime: ArcturnRuntime;
    built: { cwd: string; agent: FakeSessionAgent; options?: { fixedToolset?: boolean } }[];
  } {
    const built: { cwd: string; agent: FakeSessionAgent; options?: { fixedToolset?: boolean } }[] =
      [];
    const runtime = {
      paths: { home },
      cwd: "/repo",
      llm: fakeLLM([
        {
          text: planJson([
            { id: "reviewer", role: "reviewer", files: ["a/**"] },
            { id: "implementer", role: "implementer", files: ["b/**"] },
          ]),
        },
      ]),
      router: { specFor: () => TEST_MODEL },
      agents: new Map([
        [
          "auditor",
          {
            name: "auditor",
            description: "reads only",
            systemPrompt: "audit",
            tools: ["read", "grep"],
            source: "/x/auditor.md",
          },
        ],
      ]),
      buildSessionAgent(options: { cwd?: string; fixedToolset?: boolean }) {
        const agent: FakeSessionAgent = Object.assign(new FakeAgent({ text: "member done" }), {
          tools: ALL_TOOL_NAMES.map((name) => ({ definition: { name } })),
          setTools(tools: { definition: { name: string } }[]) {
            agent.tools = tools;
          },
        });
        built.push({ cwd: options.cwd ?? "/repo", agent, options });
        return agent;
      },
    } as unknown as ArcturnRuntime;
    return { runtime, built };
  }

  it("pins a member's toolset, so deferred disclosure cannot widen a narrowed role", async () => {
    // This seam has now bitten twice: `setTools` only replaces an Agent's own
    // tool list, but a deferred toolset installs a `getTools` closure that the
    // loop prefers on every turn. A read-only reviewer would silently get
    // `write`, `edit` and `bash` back — and the `subagent` tool this removes
    // to forbid nested teams. Found in the workflow write lane by the
    // worktree-confinement escape hunt; the same call shape lives here.
    const home = await scratchDir("arcturn-team-fixed-");
    const { runtime, built } = fakeRuntime(home);
    const spawn = createTeamSpawn(runtime);
    spawn(
      {
        id: "m1",
        task: "audit the diff",
        role: {
          name: "auditor",
          description: "reads only",
          systemPrompt: "audit",
          tools: ["read", "grep"],
          source: "/x/auditor.md",
        },
      } as Parameters<typeof spawn>[0],
      "/repo",
    );

    const spawned = built.at(-1);
    expect(spawned?.options?.fixedToolset).toBe(true);
    // …and the narrowing itself still holds.
    expect(spawned?.agent.tools.map((tool) => tool.definition.name).sort()).toEqual([
      "grep",
      "read",
    ]);
  });

  it("memoizes one manager per runtime and exposes markdown agents as roles", async () => {
    const home = await scratchDir("arcturn-team-home-");
    const { runtime } = fakeRuntime(home);
    const first = getTeamManager(runtime);
    expect(getTeamManager(runtime)).toBe(first);
    expect(first.roleNames).toContain("auditor");
    expect(first.roleNames).toContain("reviewer");
    expect(first.dir).toBe(join(home, "teams"));
    expect(teamRolesFor(runtime).get("auditor")?.readOnly).toBe(true);
  });

  it("asks the model once and returns its raw decomposition text", async () => {
    const home = await scratchDir("arcturn-team-home-");
    const { runtime } = fakeRuntime(home);
    const raw = await createTeamPlanner(runtime)({
      goal: "split it",
      roles: ["implementer"],
      minMembers: 2,
      maxMembers: 5,
    });
    expect(parseTeamPlan(raw).ok).toBe(true);
  });

  it("roots each member at its own worktree and narrows a read-only role's tools", async () => {
    const home = await scratchDir("arcturn-team-home-");
    const { runtime, built } = fakeRuntime(home);
    const git = fakeGit();
    const manager = new TeamManager({
      dir: await scratchDir(),
      repoRoot: "/repo",
      plan: createTeamPlanner(runtime),
      spawn: createTeamSpawn(runtime),
      roles: teamRolesFor(runtime),
      execFn: git.execFn,
    });
    const status = await manager.start("split it");

    expect(status.members.map((member) => member.role)).toEqual(["reviewer", "implementer"]);
    expect(built).toHaveLength(2);
    // A reviewer literally has no mutating tool to call.
    expect(built[0]?.agent.tools.map((tool) => tool.definition.name)).toEqual([
      "read",
      "grep",
      "glob",
      "ls",
    ]);
    // And nobody can fan out into a team of their own.
    const implementerTools = built[1]?.agent.tools.map((tool) => tool.definition.name);
    expect(implementerTools).toContain("write");
    expect(implementerTools).not.toContain("subagent");
    // Each member is rooted at its own worktree, never the user's tree.
    expect(built[0]?.cwd).not.toBe("/repo");
    expect(built[0]?.cwd).not.toBe(built[1]?.cwd);
  });
});

// A snapshot type assertion, so a breaking change to the public status shape
// is a compile error rather than a surprise at the call site.
const _statusShape: (status: TeamStatus) => string = (status) => status.members[0]?.id ?? status.id;
void _statusShape;

// ================================================ two processes, one ~/.arcturn

/**
 * A pid that is guaranteed not to name a live process: a real child, started
 * and reaped, whose number the OS will not have handed out again inside a test.
 *
 * Asserted rather than assumed — `process.kill(pid, 0)` is the same probe the
 * manager uses, so a fixture that silently named a live process would make the
 * "dead owner" tests below prove nothing.
 */
async function deadPid(): Promise<number> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn a child to reap");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

/** A `running` team record on disk with one live worktree, owned by `ownerPid`. */
async function writeRunningTeamRecord(
  dir: string,
  ownerPid: number | undefined,
  worktree: string,
): Promise<void> {
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  await mkdir(join(dir, "records"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await write(join(worktree, "work-in-progress.ts"), "half an edit\n", "utf8");
  await write(
    join(dir, "records", "team-live.json"),
    JSON.stringify({
      id: "team-live",
      goal: "a goal another process is still working on",
      roles: [],
      status: "running",
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 10_000,
      warnings: [],
      needsRecovery: true,
      ...(ownerPid === undefined ? {} : { ownerPid }),
      members: [
        {
          id: "a",
          title: "A",
          role: "implementer",
          task: "t",
          files: ["a/**"],
          status: "running",
          worktreeDir: worktree,
          diffStat: { files: 0, added: 0, removed: 0 },
          merged: false,
          discarded: false,
          costUsd: 0,
          turns: 0,
          toolCalls: 0,
        },
      ],
    }),
  );
}

describe("TeamManager — a second process must not recover a live team", () => {
  it("leaves a record whose owning process is ALIVE running, and never touches its worktree", async () => {
    const dir = await scratchDir();
    const worktree = join(dir, "worktrees", "team-live", "1-a");
    // `process.pid` stands in for the terminal that owns this live team: it is
    // the one pid this test can prove is alive.
    await writeRunningTeamRecord(dir, process.pid, worktree);

    const git = fakeGit((args) =>
      args[0] === "diff" ? { stdout: "diff --git a/x b/x\n+stolen\n", stderr: "" } : undefined,
    );
    const second = new TeamManager({
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([""]),
      spawn: () => new FakeAgent(),
      execFn: git.execFn,
    });

    // The record still tells the truth: that team is running, not interrupted.
    expect(second.get("team-live")?.status).toBe("running");
    expect(second.get("team-live")?.members[0]?.status).toBe("running");

    // …and the truth survived to disk, rather than being rewritten under the
    // process that owns it.
    const onDisk = JSON.parse(await readFile(join(dir, "records", "team-live.json"), "utf8")) as {
      status: string;
      members: { status: string }[];
    };
    expect(onDisk.status).toBe("running");
    expect(onDisk.members[0]?.status).toBe("running");

    // Recovery is the destructive half: it captures a diff and tears the
    // worktree down. A live team must be invisible to it.
    const report = await second.recover();
    expect(report.teams).toEqual([]);
    expect(report.removedWorktrees).toEqual([]);
    expect(git.argv().join(" ")).not.toContain("worktree remove");

    // The effect that matters: the other process's work is still on disk.
    expect(await readFile(join(worktree, "work-in-progress.ts"), "utf8")).toBe("half an edit\n");
    expect(second.get("team-live")?.members[0]?.worktreeDir).toBe(worktree);
  });

  it("still recovers a record whose owning process is GONE", async () => {
    const dir = await scratchDir();
    const worktree = join(dir, "worktrees", "team-live", "1-a");
    await writeRunningTeamRecord(dir, await deadPid(), worktree);

    const git = fakeGit((args) =>
      args[0] === "diff"
        ? { stdout: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+rescued\n", stderr: "" }
        : undefined,
    );
    const second = new TeamManager({
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([""]),
      spawn: () => new FakeAgent(),
      execFn: git.execFn,
    });

    expect(second.get("team-live")?.status).toBe("interrupted");
    const report = await second.recover();
    expect(report.teams).toEqual(["team-live"]);
    expect(report.salvaged).toEqual(["team-live/a"]);
    expect(git.argv()).toContain(`worktree remove --force ${worktree}`);
  });

  it("still recovers a record written before owner pids were stamped", async () => {
    const dir = await scratchDir();
    const worktree = join(dir, "worktrees", "team-live", "1-a");
    await writeRunningTeamRecord(dir, undefined, worktree);

    const git = fakeGit();
    const second = new TeamManager({
      dir,
      repoRoot: "/repo",
      plan: scriptedPlanner([""]),
      spawn: () => new FakeAgent(),
      execFn: git.execFn,
    });

    expect(second.get("team-live")?.status).toBe("interrupted");
    expect((await second.recover()).teams).toEqual(["team-live"]);
  });

  it("stamps the owning pid on a team it starts, so another process can see it is live", async () => {
    const { manager, dir } = await harness({ plan: scriptedPlanner([planJson([{}, {}])]) });
    const status = await manager.start("split it");

    const onDisk = JSON.parse(
      await readFile(join(dir, "records", `${status.id}.json`), "utf8"),
    ) as { ownerPid?: number };
    expect(onDisk.ownerPid).toBe(process.pid);
  });
});
