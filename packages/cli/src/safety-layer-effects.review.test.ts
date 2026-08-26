/**
 * The three safety layers that sit *beside* the rule engine — the opt-in OS
 * sandbox, the lifecycle hooks, and the plan-mode exit gate — asserted on what
 * they actually did.
 *
 * The engine's own rules are covered in `permission-effects.review.test.ts`.
 * What is covered here is the **wiring**: a sandbox that is enforced by
 * `sandbox.ts` but never reaches the tool the agent runs confines nothing, and
 * a hook runner that returns `"deny"` to a caller that ignores it is a
 * consultation, not a veto. Both of those are "the call returned the right
 * thing while the wrong thing happened on disk", which is the failure mode
 * this file exists to rule out.
 *
 * Every assertion is `stat`/`readFile` on a real path.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArcturnRuntime } from "./runtime.js";
import type { ScriptedTurn } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";

const runtimes: ArcturnRuntime[] = [];
const strays: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  // A path a test asserts must NOT exist still has to be cleaned up when the
  // assertion fails, or a red run leaves litter in the developer's home.
  for (const path of strays.splice(0)) await rm(path, { force: true, recursive: true });
});

const itPosix = it.skipIf(process.platform === "win32");

/** The real `sandbox-exec` path the darwin backend shells out to. */
const hasRealSandboxExec = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function projectConfig(scratch: Scratch, body: Record<string, unknown>): Promise<string> {
  await mkdir(join(scratch.cwd, ".arcturn"), { recursive: true });
  const file = join(scratch.cwd, ".arcturn", "config.json");
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

async function run(
  scratch: Scratch,
  turns: readonly ScriptedTurn[],
  overrides: Parameters<typeof buildTestRuntime>[2] = {},
): Promise<ArcturnRuntime> {
  const runtime = await buildTestRuntime(scratch, turns, {
    onPermissionAsk: async (request) => ({
      requestId: request.id,
      behavior: "deny" as const,
      message: "no interactive user in this test",
    }),
    ...overrides,
  });
  runtimes.push(runtime);
  await runtime.agent.prompt("go");
  return runtime;
}

/** A path outside the workspace, outside `os.tmpdir()`, and outside `$HOME/.arcturn`. */
function outsideEveryWritableRoot(label: string): string {
  const path = join(homedir(), `arcturn-${label}-should-not-exist-${process.pid}-${Date.now()}`);
  strays.push(path);
  return path;
}

/* ------------------------------------------------------------------ *
 * The OS sandbox, reached the way a user reaches it: a config key.
 * ------------------------------------------------------------------ */

describe.runIf(hasRealSandboxExec)(
  '"sandbox": "workspace-write" confines the real bash tool',
  () => {
    it("a write outside every writable root leaves no file behind", async () => {
      const scratch = await makeScratch();
      const outside = outsideEveryWritableRoot("sandbox-wiring");
      await projectConfig(scratch, { sandbox: "workspace-write" });

      await run(
        scratch,
        [
          {
            toolCalls: [
              { id: "c1", name: "bash", arguments: { command: `echo pwned > ${outside}` } },
            ],
          },
          { text: "done" },
        ],
        { permissionMode: "yolo" },
      );

      expect(await exists(outside)).toBe(false);
    });

    it("the same write DOES land with the sandbox off — so the test above proves the sandbox", async () => {
      // The control. Without it, "the file is absent" could equally mean the
      // command never ran, the tool was denied, or the shell was broken.
      const scratch = await makeScratch();
      const outside = outsideEveryWritableRoot("sandbox-control");
      await projectConfig(scratch, { sandbox: "off" });

      await run(
        scratch,
        [
          {
            toolCalls: [
              { id: "c1", name: "bash", arguments: { command: `echo landed > ${outside}` } },
            ],
          },
          { text: "done" },
        ],
        { permissionMode: "yolo" },
      );

      expect((await readFile(outside, "utf8")).trim()).toBe("landed");
    });

    it("a write inside the workspace still lands", async () => {
      const scratch = await makeScratch();
      await projectConfig(scratch, { sandbox: "workspace-write" });

      await run(
        scratch,
        [
          {
            toolCalls: [
              { id: "c1", name: "bash", arguments: { command: "echo inside > allowed.txt" } },
            ],
          },
          { text: "done" },
        ],
        { permissionMode: "yolo" },
      );

      expect((await readFile(join(scratch.cwd, "allowed.txt"), "utf8")).trim()).toBe("inside");
    });

    it("a deny rule and the sandbox are independent walls: each stands without the other", async () => {
      // The sandbox is off; the rule is the only wall, and it holds.
      const scratch = await makeScratch();
      const inside = join(scratch.cwd, "ruled.txt");
      await projectConfig(scratch, {
        sandbox: "off",
        permissions: [{ tool: "bash", specifier: "*", action: "deny", scope: "project" }],
      });

      await run(
        scratch,
        [
          {
            toolCalls: [{ id: "c1", name: "bash", arguments: { command: `echo x > ${inside}` } }],
          },
          { text: "done" },
        ],
        { permissionMode: "yolo" },
      );

      expect(await exists(inside)).toBe(false);
    });
  },
);

/* ------------------------------------------------------------------ *
 * Hooks: what a veto stops, and what a broken hook does NOT stop.
 * ------------------------------------------------------------------ */

describe("a preToolUse veto stops the effect on every path a tool arrives by", () => {
  itPosix("it stops a bash command the permission engine had already allowed", async () => {
    const scratch = await makeScratch();
    const marker = join(scratch.cwd, "ran.txt");
    await projectConfig(scratch, {
      permissions: [{ tool: "*", specifier: "*", action: "allow", scope: "project" }],
      hooks: { preToolUse: [{ command: "exit 2" }] },
    });

    await run(
      scratch,
      [
        {
          toolCalls: [{ id: "c1", name: "bash", arguments: { command: `echo x > ${marker}` } }],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await exists(marker)).toBe(false);
  });

  itPosix("it stops the same call made by a fresh session agent after /clear", async () => {
    // `/clear` mints a new Agent from `#agentOptions`. A hook wrap that was
    // applied once at startup and lost on rebuild would be a veto with a
    // one-session shelf life.
    const scratch = await makeScratch();
    const marker = join(scratch.cwd, "after-clear.txt");
    await projectConfig(scratch, {
      hooks: { preToolUse: [{ command: "exit 2" }] },
    });

    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [{ id: "c1", name: "bash", arguments: { command: `echo x > ${marker}` } }],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );
    runtimes.push(runtime);
    runtime.startNewSession();
    await runtime.agent.prompt("go");

    expect(await exists(marker)).toBe(false);
  });

  itPosix("a matcher that does not name the tool leaves the call alone", async () => {
    const scratch = await makeScratch();
    const marker = join(scratch.cwd, "ran.txt");
    await projectConfig(scratch, {
      hooks: { preToolUse: [{ command: "exit 2", matcher: "write" }] },
    });

    await run(
      scratch,
      [
        {
          toolCalls: [{ id: "c1", name: "bash", arguments: { command: `echo x > ${marker}` } }],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect((await readFile(marker, "utf8")).trim()).toBe("x");
  });
});

describe("a BROKEN preToolUse hook does not stop the effect — hooks fail open", () => {
  // Recorded, not endorsed. `web/content/docs/hooks.md` states this outright
  // ("Hooks fail **open** by design — a broken script never wedges the agent")
  // and the table there lists timeout, spawn failure and any non-2 exit code
  // as `allow`. These tests pin it at the level that matters, so that the
  // choice stays a choice: whoever writes a hook as a security control is
  // relying on a control that turns itself off when it breaks, and the fix for
  // that is a `deny` RULE, which no failure mode can switch off.
  itPosix("a hook that exits non-zero (but not 2) lets the write through", async () => {
    const scratch = await makeScratch();
    await projectConfig(scratch, {
      hooks: { preToolUse: [{ command: "exit 1" }] },
    });

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "written.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await readFile(join(scratch.cwd, "written.txt"), "utf8")).toBe("x");
  });

  itPosix("a hook that writes garbage to stdout and exits 0 lets the write through", async () => {
    const scratch = await makeScratch();
    await projectConfig(scratch, {
      hooks: { preToolUse: [{ command: "printf 'not json at all'" }] },
    });

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "written.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await readFile(join(scratch.cwd, "written.txt"), "utf8")).toBe("x");
  });

  itPosix("a hook that hangs past its timeout lets the write through", async () => {
    const scratch = await makeScratch();
    await projectConfig(scratch, {
      hooks: { preToolUse: [{ command: "sleep 30", timeoutMs: 150 }] },
    });

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "written.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await readFile(join(scratch.cwd, "written.txt"), "utf8")).toBe("x");
  });

  itPosix("a deny RULE is the wall that a broken hook is not", async () => {
    // Same broken hook, plus the rule. The rule cannot fail open, so the
    // effect does not happen — which is the migration path out of the
    // behaviour above, stated as a passing test rather than as advice.
    const scratch = await makeScratch();
    await projectConfig(scratch, {
      permissions: [{ tool: "write", specifier: "*", action: "deny", scope: "project" }],
      hooks: { preToolUse: [{ command: "sleep 30", timeoutMs: 150 }] },
    });

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "written.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await exists(join(scratch.cwd, "written.txt"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The plan-mode exit gate.
 * ------------------------------------------------------------------ */

describe("no stored rule can pre-approve leaving plan mode", () => {
  it("a blanket allow does not let the plan tool open the door", async () => {
    const scratch = await makeScratch();
    await projectConfig(scratch, {
      permissions: [
        { tool: "*", specifier: "*", action: "allow", scope: "project" },
        { tool: "plan", specifier: "*", action: "allow", scope: "project" },
      ],
    });

    let asked = 0;
    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [
            {
              id: "c1",
              name: "plan",
              arguments: { plan: "1. write the file" },
            },
          ],
        },
        {
          toolCalls: [
            { id: "c2", name: "write", arguments: { path: "after-plan.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
      {
        permissionMode: "plan",
        onPermissionAsk: async (request) => {
          asked++;
          return { requestId: request.id, behavior: "deny" as const, message: "not approved" };
        },
      },
    );
    runtimes.push(runtime);
    await runtime.agent.prompt("go");

    // The gate really was put to the user despite the blanket allow...
    expect(asked).toBeGreaterThan(0);
    // ...and the refusal held: the mode never changed, so the follow-up write
    // was refused by plan mode and nothing reached disk.
    expect(runtime.agent.permissionMode).toBe("plan");
    expect(await exists(join(scratch.cwd, "after-plan.txt"))).toBe(false);
  });
});
