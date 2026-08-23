/**
 * Adversarial review of the `/workflow` worktree confinement (RFC 0001 §7.1 /
 * §8.1) and the per-step wall-clock deadline.
 *
 * Every `it` here is a repro that was run against the code as landed. The ones
 * that FAIL are the findings; the ones that PASS are refutations kept
 * deliberately, because each is an escape route someone will try again and the
 * cheapest way to keep the answer honest is a test that says "already tried,
 * already closed".
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PermissionEngine } from "@arcturn/core";
import type { AgentEvent, PermissionRule, ToolResultMessage, Usage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import { type ArcturnConfig, DEFAULT_CONFIG } from "./config.js";
import { buildRuntime } from "./runtime.js";
import { fakeLLM, type ScriptedTurn } from "./test-helpers/fake-llm.js";
import { makeScratch, type Scratch } from "./test-helpers/scratch.js";
import {
  createRuntimeWriteLane,
  isWorkflowParseError,
  parseWorkflow,
  runWorkflow,
  type Workflow,
  type WorkflowStepRequest,
  worktreeBashRefusal,
  worktreeConfinementRules,
} from "./workflow.js";

const run = promisify(execFile);

// ------------------------------------------------------------------ scaffolding

function configWith(overrides: Partial<ArcturnConfig>): ArcturnConfig {
  return {
    ...DEFAULT_CONFIG,
    permissions: [],
    hooks: { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] },
    ...overrides,
  };
}

function roleDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "developer",
    description: "",
    systemPrompt: "you write code",
    tools: ["read", "write", "edit", "bash"],
    source: "/roles/developer.md",
    ...overrides,
  };
}

/** A path that is emphatically NOT under any `SYSTEM_PATH_PREFIXES` entry. */
const REAL_CHECKOUT = join(homedir(), "Documents", "arcturn-org-test");

const textOf = (result: ToolResultMessage): string =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

/** Spawn a confined worktree-lane child over a real runtime. */
async function spawnConfined(options: {
  scratch: Scratch;
  worktree: string;
  turns: ScriptedTurn[];
  config?: Partial<ArcturnConfig>;
  def?: Partial<AgentDef>;
}) {
  const runtime = await buildRuntime({
    cwd: options.scratch.cwd,
    home: options.scratch.home,
    env: options.scratch.env,
    llm: fakeLLM(options.turns),
    extensions: false,
    skipRepoLookup: true,
    permissionMode: "yolo",
    config: configWith(options.config ?? {}),
  });
  const lane = createRuntimeWriteLane(runtime);
  const agent = await lane.spawn({
    def: roleDef(options.def ?? {}),
    cwd: options.worktree,
    stepId: "3",
  });
  const results: ToolResultMessage[] = [];
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "toolEnd") results.push(event.result);
  });
  return { runtime, agent, results };
}

function usage(inputTokens = 1, outputTokens = 2): Usage {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function parseOk(raw: string): Workflow {
  const parsed = parseWorkflow(raw, { name: "wf" });
  if (isWorkflowParseError(parsed)) throw new Error(`expected a workflow: ${parsed.error}`);
  return parsed;
}

// ---------------------------------------------- 1. deferred tool disclosure

describe("deferred tool disclosure vs the worktree confinement", () => {
  it("keeps the bash confinement guard when deferredTools is enabled", async () => {
    const scratch = await makeScratch();
    const worktree = join(scratch.root, "wt");
    await mkdir(worktree, { recursive: true });

    const { runtime, agent, results } = await spawnConfined({
      scratch,
      worktree,
      config: { deferredTools: { enabled: true } },
      turns: [
        {
          toolCalls: [{ id: "c1", name: "bash", arguments: { command: `cd ${homedir()} && pwd` } }],
        },
        { text: "done" },
      ],
    });
    await agent.prompt("go");

    const bash = results.find((result) => result.toolName === "bash");
    expect(bash).toBeDefined();
    // `cd` out of the worktree must be refused with the confinement message.
    expect(textOf(bash as ToolResultMessage)).toContain("isolated git worktree");
    await runtime.dispose();
  }, 30_000);

  it("honours the role's declared tools and tracks its background tasks when deferredTools is enabled", async () => {
    const scratch = await makeScratch();
    const worktree = join(scratch.root, "wt");
    await mkdir(worktree, { recursive: true });

    // A role that declared NO shell at all.
    const { runtime, agent, results } = await spawnConfined({
      scratch,
      worktree,
      def: { tools: ["read", "write", "edit"] },
      config: { deferredTools: { enabled: true } },
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "bash", arguments: { command: "sleep 30", background: true } },
          ],
        },
        { text: "done" },
      ],
    });
    await agent.prompt("go");

    const bash = results.find((result) => result.toolName === "bash");
    expect(bash).toBeDefined();
    // The role never asked for `bash`, so the loop must report it as unknown.
    expect(textOf(bash as ToolResultMessage)).toContain("Unknown tool");
    // ...and whatever a role does start, the step must be able to reap.
    expect(await agent.killBackgroundTasks?.()).toBe(0);
    await runtime.dispose();
  }, 30_000);
});

// ---------------------------------------------- 2. permission-rule confinement

describe("the confinement rules, as the engine resolves them", () => {
  const root = join(homedir(), ".arcturn", "workflow-runs", "run-1", "3-developer");
  const outside = join(REAL_CHECKOUT, "test", "server-bugs.test.js");

  const engineWith = (inherited: PermissionRule[] = []) =>
    new PermissionEngine({
      mode: "yolo",
      rules: worktreeConfinementRules(root, inherited),
    });

  const decide = async (engine: PermissionEngine, tool: string, subject: string) =>
    await engine.check({ toolName: tool, toolCallId: `t-${subject}`, subject });

  it("denies a write outside the worktree under every mode, yolo included", async () => {
    for (const mode of ["yolo", "acceptEdits", "default"] as const) {
      const engine = new PermissionEngine({ mode, rules: worktreeConfinementRules(root) });
      const decision = await decide(engine, "write", outside);
      expect(decision.behavior, mode).toBe("deny");
      expect(decision.message).toContain("isolated git worktree");
    }
  });

  it("still allows writes inside the worktree", async () => {
    const engine = engineWith();
    expect((await decide(engineWith(), "write", join(root, "src/app.ts"))).behavior).toBe("allow");
    expect((await decide(engine, "edit", join(root, "a/b/c.ts"))).behavior).toBe("allow");
  });

  it("drops the permissive rules the owner's sandbox already carries", async () => {
    const inherited: PermissionRule[] = [
      { tool: "write", specifier: `${REAL_CHECKOUT}/**`, action: "allow", scope: "session" },
      { tool: "write", specifier: outside, action: "allow", scope: "session" },
      { tool: "write", specifier: "*", action: "allow", scope: "project" },
      { tool: "*", specifier: "*", action: "allow", scope: "session" },
      { tool: "*", specifier: outside, action: "allow", scope: "session" },
      { tool: "bash", specifier: "cd *", action: "allow", scope: "project" },
      // A stale grant naming a SIBLING step's worktree.
      {
        tool: "write",
        specifier: `${join(root, "..", "5-qa")}/**`,
        action: "allow",
        scope: "session",
      },
    ];
    expect((await decide(engineWith(inherited), "write", outside)).behavior).toBe("deny");
    expect(
      (await decide(engineWith(inherited), "write", join(root, "..", "5-qa", "x.ts"))).behavior,
    ).toBe("deny");
  });

  it("does not leak into a directory whose name merely prefixes the worktree", async () => {
    const engine = engineWith();
    expect((await decide(engine, "write", `${root}-2/x.ts`)).behavior).toBe("deny");
    expect((await decide(engine, "write", `${root}.bak/x.ts`)).behavior).toBe("deny");
  });

  it("keeps an inherited deny in force inside the worktree", async () => {
    const inherited: PermissionRule[] = [
      { tool: "*", specifier: "**/.env", action: "deny", scope: "user" },
    ];
    expect((await decide(engineWith(inherited), "write", join(root, ".env"))).behavior).toBe(
      "deny",
    );
  });

  it("confines every mutating tool a worktree role can hold, not just three names", async () => {
    // A role that declares an MCP/extension write tool gets it — and under
    // yolo nothing in the confinement has an opinion about where it writes.
    const engine = engineWith();
    const decision = await decide(engine, "mcp__fs__write_file", outside);
    expect(decision.behavior).toBe("deny");
  });
});

describe("the confinement against the real write tool", () => {
  it("refuses a `..` traversal out of the worktree", async () => {
    const scratch = await makeScratch();
    const worktree = join(scratch.root, "wt");
    await mkdir(worktree, { recursive: true });
    const target = join(scratch.root, "pwned-traversal.js");

    const { runtime, agent, results } = await spawnConfined({
      scratch,
      worktree,
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "write",
              arguments: { path: "../pwned-traversal.js", content: "pwned" },
            },
          ],
        },
        { text: "done" },
      ],
    });
    await agent.prompt("go");
    expect(existsSync(target)).toBe(false);
    expect(textOf(results[0] as ToolResultMessage)).toContain("isolated git worktree");
    await runtime.dispose();
  }, 30_000);

  it("refuses a write that reaches the user's checkout through a symlink in the worktree", async () => {
    const scratch = await makeScratch();
    const worktree = join(scratch.root, "wt");
    await mkdir(worktree, { recursive: true });
    // The user's real checkout, and a symlink to it sitting in the worktree —
    // exactly what `git worktree add` reproduces when the repository has one
    // checked in, and what `ln -s "$HOME/repo" link` leaves behind.
    const checkout = join(scratch.root, "real-checkout");
    await mkdir(checkout, { recursive: true });
    await symlink(checkout, join(worktree, "escape"), "dir");

    const { runtime, agent } = await spawnConfined({
      scratch,
      worktree,
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "escape/server.js", content: "pwned" } },
          ],
        },
        { text: "done" },
      ],
    });
    await agent.prompt("go");
    expect(existsSync(join(checkout, "server.js"))).toBe(false);
    await runtime.dispose();
  }, 30_000);

  it("does not copy a file outside the worktree into the checkpoint store on a denied write", async () => {
    const scratch = await makeScratch();
    const worktree = join(scratch.root, "wt");
    await mkdir(worktree, { recursive: true });
    const secretFile = join(scratch.root, "outside-secret.txt");
    const secret = "TOP-SECRET-PRE-IMAGE-0f1e2d";
    await writeFile(secretFile, secret, "utf8");

    const { runtime, agent, results } = await spawnConfined({
      scratch,
      worktree,
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: secretFile, content: "pwned" } },
          ],
        },
        { text: "done" },
      ],
    });
    await agent.prompt("go");

    // The write itself IS refused...
    expect(textOf(results[0] as ToolResultMessage)).toContain("isolated git worktree");
    // ...but the checkpoint layer runs OUTSIDE the tool, so it has already
    // read the file and copied its pre-image into ~/.arcturn/checkpoints.
    const { stdout } = await run("grep", ["-rl", secret, join(scratch.home, "checkpoints")]).catch(
      () => ({ stdout: "" }),
    );
    expect(stdout.trim()).toBe("");
    await runtime.dispose();
  }, 30_000);
});

// ---------------------------------------------- 3. the bash heuristic wall

describe("worktreeBashRefusal", () => {
  const root = "/private/tmp/arcturn-wt/3-developer";
  const refused = (command: string) => worktreeBashRefusal(command, root) !== undefined;

  it("refuses every shape of `cd` out that an honest agent reaches for", () => {
    for (const command of [
      `cd ${REAL_CHECKOUT} && npm test`,
      `cd ${REAL_CHECKOUT}; npm test`,
      `(cd ${REAL_CHECKOUT} && npm test)`,
      `pushd ${REAL_CHECKOUT} && npm test`,
      "cd ~/Documents/arcturn-org-test && npm test",
      "cd ../../..",
      "cd",
      `bash -c "cd ${REAL_CHECKOUT} && npm test"`,
      `env -C ${REAL_CHECKOUT} npm test`,
      `git -C ${REAL_CHECKOUT} status`,
      `npm --prefix ${REAL_CHECKOUT} test`,
      `npm --prefix=${REAL_CHECKOUT} test`,
      `echo hi > ${REAL_CHECKOUT}/x.js`,
      `echo hi >${REAL_CHECKOUT}/x.js`,
      `echo hi | tee ${REAL_CHECKOUT}/x.js`,
      `cp out.js ${REAL_CHECKOUT}/out.js`,
      `cat > ${REAL_CHECKOUT}/x.js <<'EOF'\nbody\nEOF`,
    ]) {
      expect(refused(command), command).toBe(true);
    }
  });

  it("lets a role work normally inside its own worktree", () => {
    for (const command of [
      "npm test",
      "node --version",
      "NODE_ENV=test npm run build",
      `cd ${root} && npm test`,
      "cd src && npm test",
      "git add --all && git commit -m 'wip'",
    ]) {
      expect(refused(command), command).toBe(false);
    }
  });

  it("refuses a write into a checkout that happens to live under a system prefix", () => {
    // `SYSTEM_PATH_PREFIXES` exempts /tmp, /var, /opt, /Library, ... so a repo
    // checked out anywhere under them is invisible to the wall — while `cd`
    // to the very same place is refused, which is the tell that this is an
    // oversight rather than a decision.
    expect(refused("cp out.js /tmp/victim-checkout/out.js"), "cp into /tmp").toBe(true);
    expect(refused("npm --prefix /opt/victim-checkout test"), "--prefix /opt").toBe(true);
    expect(refused("echo x > /var/victim-checkout/x.js"), "redirect into /var").toBe(true);
  });

  it("does not refuse a command that merely mentions a path as data", () => {
    // The role is writing INSIDE its worktree; the absolute path is content,
    // not a target. Refusing it hands the role a wall it cannot see the shape
    // of on a command that was never an escape.
    expect(refused(`echo "see ${REAL_CHECKOUT}/README.md" > notes.txt`)).toBe(false);
  });
});

// ---------------------------------------------- 4. the per-step deadline

describe("the per-step wall-clock deadline", () => {
  const FRONT = ["---", "name: demo", "description: A demo", "stepTimeoutMs: 40", "---"].join("\n");

  it("fails a step that ignores its abort without waiting for it", async () => {
    const workflow = parseOk([FRONT, "1. hang"].join("\n"));
    const startedAt = Date.now();
    const result = await runWorkflow(workflow, {
      // A runner that never looks at `signal` — the "a tool ignores abort" case.
      runStep: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 3_000).unref();
        });
        return { text: "late", usage: usage(), isError: false };
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.error).toContain("deadline");
  });

  it("counts what a timed-out step actually spent", async () => {
    const workflow = parseOk([FRONT, "1. hang"].join("\n"));
    const result = await runWorkflow(workflow, {
      runStep: async (request: WorkflowStepRequest) => {
        // A runaway step burns tokens for as long as it runs — that is the
        // whole failure mode the deadline exists for — and then reports them.
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve());
        });
        return { text: "", usage: usage(9_000, 4_000), isError: true, error: "aborted" };
      },
    });
    expect(result.status).toBe("failed");
    expect(result.usage.inputTokens).toBe(9_000);
    expect(result.usage.outputTokens).toBe(4_000);
  });

  it("still reaps and preserves a worktree when the deadline fires", async () => {
    const workflow = parseOk([FRONT, "1. hang"].join("\n"));
    let reaped = false;
    const result = await runWorkflow(workflow, {
      runStep: async (request: WorkflowStepRequest) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve());
        });
        reaped = true;
        return { text: "", usage: usage(), isError: true, error: "cancelled" };
      },
    });
    expect(result.status).toBe("failed");
    // teardown runs on the abandoned promise
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reaped).toBe(true);
  });
});
