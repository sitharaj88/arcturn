import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager, createDefaultTools } from "./index.js";
import { createFakeContext, removeTempDir } from "./test-utils.js";

describe("createDefaultTools", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-index-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("returns all 9 built-in tools with the expected names", () => {
    const { tools } = createDefaultTools({ cwd: dir });
    expect(tools).toHaveLength(9);
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual([
      "bash",
      "edit",
      "fetch",
      "glob",
      "grep",
      "ls",
      "read",
      "websearch",
      "write",
    ]);
  });

  it("exposes each tool individually and matches the tools array", () => {
    const result = createDefaultTools({ cwd: dir });
    expect(result.tools).toContain(result.read);
    expect(result.tools).toContain(result.write);
    expect(result.tools).toContain(result.edit);
    expect(result.tools).toContain(result.bash);
    expect(result.tools).toContain(result.grep);
    expect(result.tools).toContain(result.glob);
    expect(result.tools).toContain(result.ls);
    expect(result.tools).toContain(result.fetch);
    expect(result.tools).toContain(result.websearch);
  });

  it("returns an independent BackgroundTaskManager instance used by the bash tool", async () => {
    const { bash, backgroundTasks } = createDefaultTools({ cwd: dir });
    expect(backgroundTasks).toBeInstanceOf(BackgroundTaskManager);

    const { ctx } = createFakeContext({ cwd: dir });
    const result = await bash.execute({ command: "echo hi", background: true }, ctx);
    const taskId = (result.details as { taskId: string }).taskId;
    expect(backgroundTasks.poll(taskId)).toBeDefined();

    // The assertion is done; this is teardown. The task was spawned with
    // `cwd: dir` and a live process holds its working directory open on
    // Windows, so leaving it running would have `afterEach` racing a handle
    // the test itself opened. Wait for the manager to see it exit.
    for (let i = 0; i < 100 && backgroundTasks.poll(taskId)?.running; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("gives each call to createDefaultTools its own background task manager", () => {
    const a = createDefaultTools({ cwd: dir });
    const b = createDefaultTools({ cwd: dir });
    expect(a.backgroundTasks).not.toBe(b.backgroundTasks);
  });
});
