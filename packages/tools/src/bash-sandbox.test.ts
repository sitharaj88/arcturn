import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager, createBashTool } from "./bash.js";
import type { SandboxProbe } from "./sandbox.js";
import { createFakeContext, removeTempDir } from "./test-utils.js";

function fakeProbe(overrides: Partial<SandboxProbe>): SandboxProbe {
  return {
    platform: "darwin",
    existsSync: () => true,
    path: "",
    homeDir: "/Users/arcturn",
    tmpDir: "/tmp",
    realpathSync: (p) => p,
    ...overrides,
  };
}

describe("createBashTool sandbox integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-bash-sandbox-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("default (no options) is unaffected: no sandbox fields in details", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.details).not.toHaveProperty("sandbox");
    expect(result.details).not.toHaveProperty("sandboxUnavailable");
  });

  it('sandbox: "off" passes the command straight through, identical to omitting the option', async () => {
    const tool = createBashTool(new BackgroundTaskManager(), { sandbox: "off" });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("hi");
    expect(result.details).not.toHaveProperty("sandbox");
  });

  it("prepends the unavailable note when the requested sandbox can't be honored (injected probe)", async () => {
    const tool = createBashTool(new BackgroundTaskManager(), {
      sandbox: "workspace-write",
      sandboxProbe: fakeProbe({ platform: "win32" }),
    });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    // win32 has no sandboxing backend at all (unlike darwin/linux, where the
    // binary is merely missing), so it gets the more explicit, platform-named
    // no-confinement note (D3) rather than the generic unavailable-binary one.
    expect(
      text.startsWith(
        'note: sandbox requested but Arcturn has no filesystem sandbox backend for "win32"',
      ),
    ).toBe(true);
    expect(text).toMatch(/without confinement/i);
    expect(text).toContain("hi");
    expect(result.details).toMatchObject({ sandbox: "workspace-write", sandboxUnavailable: true });
  });

  it("prepends the unavailable note on darwin when sandbox-exec is reported missing", async () => {
    const tool = createBashTool(new BackgroundTaskManager(), {
      sandbox: "workspace-write",
      sandboxProbe: fakeProbe({ platform: "darwin", existsSync: () => false }),
    });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("note: sandbox requested but unavailable on this platform");
  });

  it("prepends the unavailable note on linux when bwrap is reported missing from PATH", async () => {
    const tool = createBashTool(new BackgroundTaskManager(), {
      sandbox: "workspace-write",
      sandboxProbe: fakeProbe({ platform: "linux", path: "/usr/bin", existsSync: () => false }),
    });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("note: sandbox requested but unavailable on this platform");
  });
});

// Real sandbox-exec execution, gated so non-darwin/hardened CI machines skip it.
const hasRealSandboxExec = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

describe.runIf(hasRealSandboxExec)("createBashTool sandbox integration (real sandbox-exec)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-bash-sandbox-real-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("actually denies a write outside the workspace when sandboxed end-to-end", async () => {
    const { homedir } = await import("node:os");
    const tool = createBashTool(new BackgroundTaskManager(), { sandbox: "workspace-write" });
    const { ctx } = createFakeContext({ cwd: dir });
    const outsidePath = join(homedir(), `arcturn-bash-sandbox-should-not-exist-${Date.now()}.txt`);

    const result = await tool.execute({ command: `echo nope > ${outsidePath}` }, ctx);

    expect(result.isError).toBe(true);
    expect(existsSync(outsidePath)).toBe(false);
  });

  it("actually allows a write inside the workspace when sandboxed end-to-end", async () => {
    const tool = createBashTool(new BackgroundTaskManager(), { sandbox: "workspace-write" });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute(
      { command: "echo yes > allowed.txt && cat allowed.txt" },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("yes");
  });

  it("reports sandbox details and no unavailable note when actually sandboxed", async () => {
    const tool = createBashTool(new BackgroundTaskManager(), { sandbox: "workspace-write" });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ sandbox: "workspace-write", sandboxUnavailable: false });
    expect((result.content[0] as { text: string }).text.startsWith("note:")).toBe(false);
  });
});
