/**
 * `pruneWorkflowRuns` and the worktrees a raced or failed step leaves behind.
 *
 * The security review's F6 noted that losing race arms keep a full worktree
 * and an unapplied patch on disk "forever". They do not: every worktree a run
 * creates is nested inside that run's own directory under
 * `~/.arcturn/workflow-runs/<runId>/`, which the TTL sweep deletes whole
 * before re-registering git. This file is that claim, executable — a run
 * directory shaped like a real raced write-lane step, swept, and checked for
 * what survived.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneWorkflowRuns, WORKFLOW_RUN_TTL_MS } from "./workflow.js";

describe("pruneWorkflowRuns reaps a raced step's losing worktrees", () => {
  it("deletes the whole run directory — arms, patches and all — then re-prunes git", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "arcturn-prune-")), "workflow-runs");
    const now = Date.UTC(2026, 0, 30);
    const old = join(root, "2026-01-01T00-00-00Z-raced");

    // The shape a raced write-lane step leaves: one worktree per arm, the
    // winner's and the losers', each a real checkout, plus the losers'
    // unapplied patches and the run's baseline.
    for (const arm of ["3-builder-a", "3-builder-b", "3-builder-c"]) {
      await mkdir(join(old, arm, "src"), { recursive: true });
      await writeFile(join(old, arm, "src", "index.ts"), "export const x = 1;\n", "utf8");
      await writeFile(join(old, `${arm}.patch`), "diff --git a/x b/x\n", "utf8");
    }
    await writeFile(join(old, "_run-baseline.patch"), "diff --git a/y b/y\n", "utf8");
    await mkdir(join(root, "2026-01-29T00-00-00Z-fresh"), { recursive: true });

    const eightDaysAgo = new Date(now - WORKFLOW_RUN_TTL_MS - 24 * 60 * 60 * 1000);
    await utimes(old, eightDaysAgo, eightDaysAgo);

    const git: string[][] = [];
    const removed = await pruneWorkflowRuns({
      root,
      now,
      repo: "/repo",
      exec: async (cwd, args) => {
        git.push([cwd, ...args]);
      },
    });

    expect(removed).toEqual([old]);
    // Not one arm, not one patch survives.
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(old, "3-builder-b", "src", "index.ts"))).toBe(false);
    expect(existsSync(join(old, "3-builder-b.patch"))).toBe(false);
    // The fresh run is untouched, and git is told its worktree registrations
    // are stale — without that the next worktree at that path is refused.
    expect(existsSync(join(root, "2026-01-29T00-00-00Z-fresh"))).toBe(true);
    expect(git).toEqual([["/repo", "worktree", "prune"]]);
  });
});
