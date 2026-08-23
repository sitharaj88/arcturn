import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOverlay } from "./overlay.js";
import {
  createSpeculation,
  formatSpeculationOutcome,
  isSpeculatable,
  type SpeculationController,
  wrapToolsWithSpeculation,
} from "./speculation.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fakeContext(cwd: string): ToolExecutionContext {
  return {
    cwd,
    signal: new AbortController().signal,
    requestPermission: async () => ({ requestId: "r", behavior: "allow" }),
    onUpdate: () => {},
    sessionId: "s1",
    toolCallId: "t1",
  };
}

/** A `write`-shaped tool: creates the file at `input.path` with `input.content`. */
function writeTool(): Tool {
  return {
    definition: { name: "write", description: "write", parameters: { type: "object" } },
    async execute(input, ctx): Promise<ToolResult> {
      // Real tools resolve relative paths against the session cwd; the fakes
      // must too, or a non-redirected call would write next to the test runner.
      const path = resolve(ctx.cwd, input.path as string);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, input.content as string, "utf8");
      return { content: [{ type: "text", text: `wrote ${path}` }] };
    },
  };
}

/** A `read`-shaped tool, so the shadow fall-through can be observed. */
function readTool(): Tool {
  return {
    definition: { name: "read", description: "read", parameters: { type: "object" } },
    async execute(input, ctx): Promise<ToolResult> {
      const path = resolve(ctx.cwd, input.path as string);
      try {
        return { content: [{ type: "text", text: await readFile(path, "utf8") }] };
      } catch {
        return { content: [{ type: "text", text: `missing ${path}` }], isError: true };
      }
    },
  };
}

/** A tool whose execution is observable, standing in for anything irreversible. */
function spyTool(name: string): { tool: Tool; ran: ReturnType<typeof vi.fn> } {
  const ran = vi.fn();
  return {
    ran,
    tool: {
      definition: { name, description: name, parameters: { type: "object" } },
      async execute(input): Promise<ToolResult> {
        ran(input);
        return { content: [{ type: "text", text: `${name} ran` }] };
      },
    },
  };
}

describe("speculation", () => {
  let root: string;
  let cwd: string;
  let shadowRoot: string;
  let controller: SpeculationController;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "arcturn-speculation-"));
    cwd = join(root, "workspace");
    shadowRoot = join(root, "shadows");
    await mkdir(cwd, { recursive: true });
    // One shadow directory per request id — safety rule 3 depends on it.
    controller = createSpeculation({
      overlayFor: (id) => createOverlay({ cwd, dir: join(shadowRoot, id) }),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("rule 1: nothing lands without an explicit approval", () => {
    it("a write while a speculation is open does not touch the real file", async () => {
      await writeFile(join(cwd, "a.txt"), "original", "utf8");
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      controller.begin("req-1");

      await write?.execute({ path: "a.txt", content: "speculative" }, fakeContext(cwd));

      expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("original");
      expect(await readFile(join(shadowRoot, "req-1", "a.txt"), "utf8")).toBe("speculative");
      expect(controller.active()).toEqual(["req-1"]);
    });

    it("approving lands the speculative work and clears the shadow", async () => {
      await writeFile(join(cwd, "a.txt"), "original", "utf8");
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      controller.begin("req-1");
      await write?.execute({ path: "a.txt", content: "speculative" }, fakeContext(cwd));

      const outcome = await controller.settle("req-1", true);

      expect(outcome.status).toBe("applied");
      expect(outcome.applied).toEqual([join(cwd, "a.txt")]);
      expect(outcome.errors).toEqual([]);
      expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("speculative");
      expect(await exists(join(shadowRoot, "req-1"))).toBe(false);
      expect(controller.active()).toEqual([]);
    });

    it("denying leaves the real file untouched and removes the shadow", async () => {
      await writeFile(join(cwd, "a.txt"), "original", "utf8");
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      controller.begin("req-1");
      await write?.execute({ path: "a.txt", content: "speculative" }, fakeContext(cwd));
      await write?.execute({ path: "new.txt", content: "brand new" }, fakeContext(cwd));

      const outcome = await controller.settle("req-1", false);

      expect(outcome.status).toBe("discarded");
      expect(outcome.applied).toEqual([]);
      expect(outcome.discarded).toEqual([join(cwd, "a.txt"), join(cwd, "new.txt")]);
      expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("original");
      expect(await exists(join(cwd, "new.txt"))).toBe(false);
      expect(await exists(join(shadowRoot, "req-1"))).toBe(false);
    });

    it("settling the same request twice cannot apply twice", async () => {
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      controller.begin("req-1");
      await write?.execute({ path: "a.txt", content: "speculative" }, fakeContext(cwd));
      await controller.settle("req-1", false);

      const second = await controller.settle("req-1", true);

      expect(second.status).toBe("unknown");
      expect(second.applied).toEqual([]);
      expect(await exists(join(cwd, "a.txt"))).toBe(false);
    });

    it("abandonAll discards every open speculation without applying (fail closed)", async () => {
      await writeFile(join(cwd, "a.txt"), "original", "utf8");
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      controller.begin("req-1");
      await write?.execute({ path: "a.txt", content: "from-1" }, fakeContext(cwd));
      controller.begin("req-2");
      await write?.execute({ path: "b.txt", content: "from-2" }, fakeContext(cwd));

      await controller.abandonAll();

      expect(controller.active()).toEqual([]);
      expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("original");
      expect(await exists(join(cwd, "b.txt"))).toBe(false);
      expect(await exists(join(shadowRoot, "req-1"))).toBe(false);
      expect(await exists(join(shadowRoot, "req-2"))).toBe(false);
    });

    it("a speculation nobody wrote through settles cleanly and touches nothing", async () => {
      controller.begin("req-1");
      const outcome = await controller.settle("req-1", true);

      expect(outcome.status).toBe("applied");
      expect(outcome.applied).toEqual([]);
      expect(await exists(join(shadowRoot, "req-1"))).toBe(false);
    });
  });

  describe("rule 2: irreversible tools are blocked while a speculation is open", () => {
    it("blocks bash while open and proves it never ran", async () => {
      const bash = spyTool("bash");
      const wrapped = wrapToolsWithSpeculation([bash.tool], controller)[0] as Tool;
      controller.begin("req-1");

      const result = await wrapped.execute({ command: "rm -rf /" }, fakeContext(cwd));

      expect(bash.ran).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("req-1");
      expect(result.details).toMatchObject({
        blockedBySpeculation: true,
        pendingRequestIds: ["req-1"],
      });
    });

    it("blocks fetch, websearch and mcp tools too", async () => {
      const spies = ["fetch", "websearch", "mcp__server__send", "task"].map(spyTool);
      const wrapped = wrapToolsWithSpeculation(
        spies.map((spy) => spy.tool),
        controller,
      );
      controller.begin("req-1");

      for (const tool of wrapped) {
        const result = await tool.execute({}, fakeContext(cwd));
        expect(result.isError).toBe(true);
      }
      for (const spy of spies) expect(spy.ran).not.toHaveBeenCalled();
    });

    it("runs the same tool untouched when no speculation is open", async () => {
      const bash = spyTool("bash");
      const [wrapped] = wrapToolsWithSpeculation([bash.tool], controller);

      const before = await wrapped?.execute({ command: "ls" }, fakeContext(cwd));
      expect(bash.ran).toHaveBeenCalledTimes(1);
      expect(before?.isError).toBeUndefined();

      // ... and again after the speculation is settled.
      controller.begin("req-1");
      await controller.settle("req-1", true);
      await wrapped?.execute({ command: "ls" }, fakeContext(cwd));
      expect(bash.ran).toHaveBeenCalledTimes(2);
    });

    it("allows read-only tools while open, and serves read from the shadow", async () => {
      await writeFile(join(cwd, "a.txt"), "original", "utf8");
      const grep = spyTool("grep");
      const tools = wrapToolsWithSpeculation([writeTool(), readTool(), grep.tool], controller);
      const write = tools[0] as Tool;
      const read = tools[1] as Tool;
      const wrappedGrep = tools[2] as Tool;
      controller.begin("req-1");

      // Untouched files fall through to the real workspace.
      const untouched = await read.execute({ path: "a.txt" }, fakeContext(cwd));
      expect((untouched.content[0] as { text: string }).text).toBe("original");

      await write.execute({ path: "a.txt", content: "speculative" }, fakeContext(cwd));
      const pending = await read.execute({ path: "a.txt" }, fakeContext(cwd));
      expect((pending.content[0] as { text: string }).text).toBe("speculative");

      await wrappedGrep.execute({ pattern: "x" }, fakeContext(cwd));
      expect(grep.ran).toHaveBeenCalledTimes(1);
    });

    it("isSpeculatable allows only write and edit", () => {
      expect(isSpeculatable("write")).toBe(true);
      expect(isSpeculatable("edit")).toBe(true);
      for (const name of ["bash", "fetch", "websearch", "mcp__x__y", "read", "task", "verify"]) {
        expect(isSpeculatable(name)).toBe(false);
      }
    });
  });

  describe("rule 3: concurrent speculations are isolated", () => {
    it("two open speculations never see each other's writes", async () => {
      await writeFile(join(cwd, "shared.txt"), "original", "utf8");
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      const ctx = fakeContext(cwd);

      controller.begin("req-a");
      await write?.execute({ path: "shared.txt", content: "from-a" }, ctx);
      controller.begin("req-b"); // Innermost from here on.
      await write?.execute({ path: "shared.txt", content: "from-b" }, ctx);

      expect(await readFile(join(shadowRoot, "req-a", "shared.txt"), "utf8")).toBe("from-a");
      expect(await readFile(join(shadowRoot, "req-b", "shared.txt"), "utf8")).toBe("from-b");
      expect(await readFile(join(cwd, "shared.txt"), "utf8")).toBe("original");
      expect(controller.active()).toEqual(["req-a", "req-b"]);

      // Denying the inner one leaves the outer one's shadow completely intact.
      await controller.settle("req-b", false);
      expect(await readFile(join(cwd, "shared.txt"), "utf8")).toBe("original");
      expect(await readFile(join(shadowRoot, "req-a", "shared.txt"), "utf8")).toBe("from-a");

      await controller.settle("req-a", true);
      expect(await readFile(join(cwd, "shared.txt"), "utf8")).toBe("from-a");
    });

    it("settling the inner speculation routes later writes back to the outer one", async () => {
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      const ctx = fakeContext(cwd);
      controller.begin("req-a");
      controller.begin("req-b");
      await controller.settle("req-b", false);

      await write?.execute({ path: "later.txt", content: "outer" }, ctx);

      expect(await readFile(join(shadowRoot, "req-a", "later.txt"), "utf8")).toBe("outer");
      expect(await exists(join(cwd, "later.txt"))).toBe(false);
    });

    it("begin is idempotent for an already-open request", () => {
      const first = controller.begin("req-1");
      const second = controller.begin("req-1");
      expect(second).toBe(first);
      expect(controller.active()).toEqual(["req-1"]);
    });
  });

  describe("rule 4: failures are reported honestly", () => {
    it("refuses a change whose real path escapes the workspace through a symlink", async () => {
      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(cwd, "link"), "dir");
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      controller.begin("req-1");
      await write?.execute({ path: "link/escape.txt", content: "pwned" }, fakeContext(cwd));

      const outcome = await controller.settle("req-1", true);

      expect(outcome.status).toBe("partial");
      expect(outcome.applied).toEqual([]);
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]?.message).toContain("outside the workspace");
      expect(await exists(join(outside, "escape.txt"))).toBe(false);
    });

    it("reports a partial apply without throwing", async () => {
      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(cwd, "link"), "dir");
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      const ctx = fakeContext(cwd);
      controller.begin("req-1");
      await write?.execute({ path: "ok.txt", content: "landed" }, ctx);
      await write?.execute({ path: "link/escape.txt", content: "pwned" }, ctx);

      const outcome = await controller.settle("req-1", true);

      expect(outcome.status).toBe("partial");
      expect(outcome.applied).toEqual([join(cwd, "ok.txt")]);
      expect(outcome.errors).toHaveLength(1);
      expect(await readFile(join(cwd, "ok.txt"), "utf8")).toBe("landed");
      expect(await exists(join(shadowRoot, "req-1"))).toBe(false);
    });

    it("reports an unreadable workspace destination instead of throwing", async () => {
      // A directory where the speculative change expects a file: `changes()`
      // cannot even diff it, and the failure must surface as an error.
      const [write] = wrapToolsWithSpeculation([writeTool()], controller);
      controller.begin("req-1");
      await write?.execute({ path: "clash.txt", content: "speculative" }, fakeContext(cwd));
      await mkdir(join(cwd, "clash.txt"), { recursive: true });

      const outcome = await controller.settle("req-1", true);

      expect(outcome.status).toBe("partial");
      expect(outcome.applied).toEqual([]);
      expect(outcome.errors).toHaveLength(1);
      expect((await stat(join(cwd, "clash.txt"))).isDirectory()).toBe(true);
    });
  });

  describe("formatSpeculationOutcome", () => {
    it("says what landed", () => {
      const text = formatSpeculationOutcome(
        {
          requestId: "req-1",
          approved: true,
          status: "applied",
          applied: [join(cwd, "a.txt")],
          discarded: [],
          errors: [],
        },
        cwd,
      );
      expect(text).toContain("approved");
      expect(text).toContain("1 file landed");
      expect(text).toContain("landed a.txt");
    });

    it("says what was discarded and that the workspace is untouched", () => {
      const text = formatSpeculationOutcome(
        {
          requestId: "req-1",
          approved: false,
          status: "discarded",
          applied: [],
          discarded: [join(cwd, "a.txt"), join(cwd, "b.txt")],
          errors: [],
        },
        cwd,
      );
      expect(text).toContain("denied");
      expect(text).toContain("2 files discarded");
      expect(text).toContain("workspace untouched");
    });

    it("reports failures on a partial apply", () => {
      const text = formatSpeculationOutcome({
        requestId: "req-1",
        approved: true,
        status: "partial",
        applied: [],
        discarded: [join(cwd, "a.txt")],
        errors: [{ path: join(cwd, "a.txt"), message: "boom" }],
      });
      expect(text).toContain("1 file failed");
      expect(text).toContain("boom");
    });

    it("has a line for a request nothing was speculated for", () => {
      const text = formatSpeculationOutcome({
        requestId: "req-9",
        approved: true,
        status: "unknown",
        applied: [],
        discarded: [],
        errors: [],
      });
      expect(text).toContain("nothing was speculated");
    });
  });
});
