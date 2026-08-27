import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult, ToolResultContent } from "@arcturn/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOffloadStub,
  DEFAULT_OFFLOAD_EXCLUDE,
  DEFAULT_OFFLOAD_KEEP_HEAD,
  DEFAULT_OFFLOAD_KEEP_TAIL,
  DEFAULT_OFFLOAD_MAX_CHARS,
  type OffloadDetails,
  type OffloadFileSystem,
  offloadableText,
  offloadFileName,
  wrapToolsWithOffload,
} from "./offload.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-offload-"));
  dirs.push(dir);
  return dir;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    signal: new AbortController().signal,
    requestPermission: async () => ({ behavior: "allow" }) as never,
    onUpdate: () => {},
    sessionId: "s1",
    toolCallId: "call_1",
    ...overrides,
  };
}

function makeTool(
  name: string,
  result: ToolResult | (() => ToolResult | Promise<ToolResult>),
): Tool {
  return {
    definition: { name, description: `${name} tool`, parameters: { type: "object" } },
    execute: vi.fn(async () => (typeof result === "function" ? result() : result)),
  };
}

function textResult(text: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { content: [{ type: "text", text }], ...extra };
}

const big = (n = 40_000, char = "x"): string => char.repeat(n);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

describe("offloadableText", () => {
  it("joins text blocks with newlines and skips images", () => {
    const content: ToolResultContent[] = [
      { type: "text", text: "a" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "b" },
    ];
    expect(offloadableText(content)).toBe("a\nb");
  });

  it("is empty for image-only content", () => {
    expect(offloadableText([{ type: "image", data: "AAAA", mimeType: "image/png" }])).toBe("");
  });
});

describe("offloadFileName", () => {
  it("includes the tool name and the tool call id", () => {
    expect(offloadFileName("bash", "toolu_01ABC")).toBe("bash-toolu_01ABC.txt");
  });

  it("sanitizes path separators and other unsafe characters", () => {
    const name = offloadFileName("mcp/server:tool", "../../etc/passwd");
    expect(name).toBe("mcp-server-tool-..-..-etc-passwd.txt");
    expect(name).not.toContain("/");
  });

  it("falls back to a placeholder for empty or fully stripped input", () => {
    expect(offloadFileName("", "///")).toBe("unknown-unknown.txt");
  });

  it("caps each segment so a pathological id cannot exceed the filename limit", () => {
    const name = offloadFileName("t", "i".repeat(500));
    expect(name.length).toBeLessThan(120);
  });
});

describe("wrapToolsWithOffload — pass-through", () => {
  it("returns excluded tools by reference and does not wrap them", async () => {
    const dir = await tempDir();
    const read = makeTool("read", textResult(big()));
    const [wrapped] = wrapToolsWithOffload([read], { dir });
    expect(wrapped).toBe(read);
  });

  it("excludes read by default", () => {
    expect(DEFAULT_OFFLOAD_EXCLUDE).toEqual(["read"]);
  });

  it("can be told to offload everything with an empty exclude list", async () => {
    const dir = await tempDir();
    const read = makeTool("read", textResult(big()));
    const [wrapped] = wrapToolsWithOffload([read], { dir, exclude: [] });
    expect(wrapped).not.toBe(read);
    const result = await wrapped.execute({}, makeContext());
    expect(result.details?.offloaded).toBe(true);
  });

  it("returns a small result as the identical object", async () => {
    const dir = await tempDir();
    const original = textResult("small output");
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", original)], { dir });
    const result = await wrapped.execute({}, makeContext());
    expect(result).toBe(original);
    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves a result exactly at the limit untouched", async () => {
    const dir = await tempDir();
    const original = textResult(big(100));
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", original)], { dir, maxChars: 100 });
    expect(await wrapped.execute({}, makeContext())).toBe(original);
  });

  it("offloads one character over the limit", async () => {
    const dir = await tempDir();
    const original = textResult(big(101));
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", original)], {
      dir,
      maxChars: 100,
      keepHead: 10,
      keepTail: 10,
    });
    const result = await wrapped.execute({}, makeContext());
    expect(result).not.toBe(original);
    expect(result.details?.offloaded).toBe(true);
  });

  it("does not count image data against the budget", async () => {
    const dir = await tempDir();
    const original: ToolResult = {
      content: [
        { type: "text", text: "tiny" },
        { type: "image", data: big(50_000, "A"), mimeType: "image/png" },
      ],
    };
    const [wrapped] = wrapToolsWithOffload([makeTool("screenshot", original)], { dir });
    expect(await wrapped.execute({}, makeContext())).toBe(original);
  });

  it("preserves the tool definition and annotations on the wrapper", async () => {
    const dir = await tempDir();
    const tool: Tool = {
      ...makeTool("bash", textResult("x")),
      annotations: { readOnlyHint: true, title: "Bash" },
    };
    const [wrapped] = wrapToolsWithOffload([tool], { dir });
    expect(wrapped.definition).toBe(tool.definition);
    expect(wrapped.annotations).toEqual({ readOnlyHint: true, title: "Bash" });
  });

  it("forwards input and context to the wrapped tool", async () => {
    const dir = await tempDir();
    const tool = makeTool("bash", textResult("ok"));
    const [wrapped] = wrapToolsWithOffload([tool], { dir });
    const ctx = makeContext();
    await wrapped.execute({ command: "ls" }, ctx);
    expect(tool.execute).toHaveBeenCalledWith({ command: "ls" }, ctx);
  });

  it("propagates thrown errors unchanged", async () => {
    const dir = await tempDir();
    const tool = makeTool("bash", () => {
      throw new Error("boom");
    });
    const [wrapped] = wrapToolsWithOffload([tool], { dir });
    await expect(wrapped.execute({}, makeContext())).rejects.toThrow("boom");
  });
});

describe("wrapToolsWithOffload — offloading", () => {
  it("writes the full output to disk and returns a stub pointing at it", async () => {
    const dir = await tempDir();
    const full = `HEAD${big(30_000)}TAIL`;
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(full))], {
      dir,
      maxChars: 1_000,
      keepHead: 20,
      keepTail: 10,
      now: () => 1234,
    });

    const result = await wrapped.execute({}, makeContext({ toolCallId: "call_abc" }));
    const details = result.details as unknown as OffloadDetails;

    expect(details.offloaded).toBe(true);
    expect(details.path).toBe(join(dir, "bash-call_abc.txt"));
    expect(details.originalChars).toBe(full.length);
    expect(details.originalBytes).toBe(Buffer.byteLength(full, "utf8"));
    expect(details.originalLines).toBe(1);
    expect(details.offloadedAt).toBe(1234);
    expect(await readFile(details.path, "utf8")).toBe(full);
  });

  it("keeps the stub far smaller than the original", async () => {
    const dir = await tempDir();
    const full = big(200_000);
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(full))], { dir });
    const result = await wrapped.execute({}, makeContext());
    const stub = (result.content[0] as { text: string }).text;
    expect(stub.length).toBeLessThan(DEFAULT_OFFLOAD_KEEP_HEAD + DEFAULT_OFFLOAD_KEEP_TAIL + 2_000);
    expect(stub.length).toBeLessThan(full.length / 10);
    expect((result.details as unknown as OffloadDetails).stubChars).toBe(stub.length);
  });

  it("keeps the head and the tail of the output in the excerpt", async () => {
    const dir = await tempDir();
    const full = `START-MARKER${big(5_000)}END-MARKER`;
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(full))], {
      dir,
      maxChars: 100,
      keepHead: 12,
      keepTail: 10,
    });
    const stub = ((await wrapped.execute({}, makeContext())).content[0] as { text: string }).text;
    expect(stub).toContain("START-MARKER");
    expect(stub).toContain("END-MARKER");
    expect(stub).toContain("characters (~1 lines) omitted");
  });

  it("names the absolute path and the read tool in the stub", async () => {
    const dir = await tempDir();
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(big()))], { dir });
    const stub = (
      (await wrapped.execute({}, makeContext({ toolCallId: "c9" }))).content[0] as { text: string }
    ).text;
    const path = join(dir, "bash-c9.txt");
    expect(stub).toContain(path);
    expect(stub).toContain("read({");
    expect(stub).toContain("grep({");
    expect(stub).toContain("[tool output offloaded]");
    expect(stub).toContain(`${DEFAULT_OFFLOAD_MAX_CHARS}-character`);
  });

  it("reports byte and line counts for multi-byte, multi-line output", async () => {
    const dir = await tempDir();
    const line = `${"é".repeat(99)}\n`;
    const full = line.repeat(400);
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(full))], {
      dir,
      maxChars: 1_000,
    });
    const details = (await wrapped.execute({}, makeContext())).details as unknown as OffloadDetails;
    expect(details.originalChars).toBe(full.length);
    expect(details.originalBytes).toBe(Buffer.byteLength(full, "utf8"));
    expect(details.originalBytes).toBeGreaterThan(details.originalChars);
    expect(details.originalLines).toBe(401);
    expect(await readFile(details.path, "utf8")).toBe(full);
  });

  it("preserves isError, structuredContent and pre-existing details", async () => {
    const dir = await tempDir();
    const original = textResult(big(), {
      isError: true,
      details: { exitCode: 2, command: "pnpm test" },
      structuredContent: { failures: 3 },
    });
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", original)], { dir });
    const result = await wrapped.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ failures: 3 });
    expect(result.details?.exitCode).toBe(2);
    expect(result.details?.command).toBe("pnpm test");
    expect(result.details?.offloaded).toBe(true);
    expect(original.content).toHaveLength(1);
    expect((original.content[0] as { text: string }).text).toBe(big());
  });

  it("merges all text blocks into one file and keeps images after the stub", async () => {
    const dir = await tempDir();
    const original: ToolResult = {
      content: [
        { type: "text", text: `A${big(20_000)}` },
        { type: "image", data: "IMG1", mimeType: "image/png" },
        { type: "text", text: `B${big(20_000)}` },
        { type: "image", data: "IMG2", mimeType: "image/jpeg" },
      ],
    };
    const [wrapped] = wrapToolsWithOffload([makeTool("mcp_tool", original)], { dir });
    const result = await wrapped.execute({}, makeContext());

    expect(result.content).toHaveLength(3);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[1]).toEqual({ type: "image", data: "IMG1", mimeType: "image/png" });
    expect(result.content[2]).toEqual({ type: "image", data: "IMG2", mimeType: "image/jpeg" });
    const written = await readFile((result.details as unknown as OffloadDetails).path, "utf8");
    expect(written).toBe(offloadableText(original.content));
    expect(written.startsWith("A")).toBe(true);
    expect(written).toContain("\nB");
  });

  it("creates the directory on demand, including nested paths", async () => {
    const dir = join(await tempDir(), "sessions", "s1", "offload");
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(big()))], { dir });
    const result = await wrapped.execute({}, makeContext());
    expect((result.details as unknown as OffloadDetails).path).toBe(join(dir, "bash-call_1.txt"));
    expect(await readdir(dir)).toEqual(["bash-call_1.txt"]);
  });

  it("resolves a relative dir to an absolute path in the stub", async () => {
    const dir = await tempDir();
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(big()))], {
      dir: "offload-rel",
    });
    const result = await wrapped.execute({}, makeContext());
    const path = (result.details as unknown as OffloadDetails).path;
    expect(path).toBe(join(dir, "offload-rel", "bash-call_1.txt"));
    spy.mockRestore();
  });

  it("does not clobber an existing file for the same tool call id", async () => {
    const dir = await tempDir();
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(big(20_000, "y")))], {
      dir,
      createId: () => "dup1",
    });
    await writeFile(join(dir, "bash-call_1.txt"), "PREVIOUS", "utf8");

    const result = await wrapped.execute({}, makeContext());
    const path = (result.details as unknown as OffloadDetails).path;
    expect(path).toBe(join(dir, "bash-call_1-dup1.txt"));
    expect(await readFile(join(dir, "bash-call_1.txt"), "utf8")).toBe("PREVIOUS");
    expect(await readFile(path, "utf8")).toBe(big(20_000, "y"));
  });
});

describe("wrapToolsWithOffload — failure and abort handling", () => {
  it("returns the original untruncated result when the write fails", async () => {
    const failing: OffloadFileSystem = {
      mkdir: async () => undefined,
      writeFile: async () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      },
    };
    const original = textResult(big());
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", original)], {
      dir: "/nowhere",
      fs: failing,
    });
    const result = await wrapped.execute({}, makeContext());
    expect(result).toBe(original);
    expect(result.details?.offloaded).toBeUndefined();
  });

  it("returns the original result when mkdir fails", async () => {
    const failing: OffloadFileSystem = {
      mkdir: async () => {
        throw new Error("EACCES");
      },
      writeFile: async () => {},
    };
    const original = textResult(big());
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", original)], {
      dir: "/nowhere",
      fs: failing,
    });
    expect(await wrapped.execute({}, makeContext())).toBe(original);
  });

  it("returns the original result when even the collision retry fails", async () => {
    const failing: OffloadFileSystem = {
      mkdir: async () => undefined,
      writeFile: async () => {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
    };
    const original = textResult(big());
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", original)], {
      dir: "/nowhere",
      fs: failing,
      createId: () => "retry",
    });
    expect(await wrapped.execute({}, makeContext())).toBe(original);
  });

  it("passes the result through without writing when the signal aborted", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const original = textResult(big());
    const tool = makeTool("bash", () => {
      controller.abort();
      return original;
    });
    const [wrapped] = wrapToolsWithOffload([tool], { dir });
    const result = await wrapped.execute({}, makeContext({ signal: controller.signal }));
    expect(result).toBe(original);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("option validation", () => {
  it("falls back to the defaults for non-positive or non-finite thresholds", async () => {
    const dir = await tempDir();
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(big(20)))], {
      dir,
      maxChars: 0,
      keepHead: Number.NaN,
      keepTail: -5,
    });
    // 20 chars is far below the default 16_000 limit, so nothing happens.
    expect((await wrapped.execute({}, makeContext())).details?.offloaded).toBeUndefined();
  });

  it("handles keepHead + keepTail larger than the output without a zero-omission note", async () => {
    const dir = await tempDir();
    const full = big(11);
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(full))], {
      dir,
      maxChars: 10,
      keepHead: 100,
      keepTail: 100,
    });
    const stub = ((await wrapped.execute({}, makeContext())).content[0] as { text: string }).text;
    expect(stub).toContain("[… 1 characters");
    expect(stub).not.toContain("[… 0 characters");
    expect(stub).not.toContain("-1 characters");
  });

  it("supports a zero-length tail", async () => {
    const dir = await tempDir();
    const [wrapped] = wrapToolsWithOffload([makeTool("bash", textResult(`HEAD${big(5_000)}`))], {
      dir,
      maxChars: 100,
      keepHead: 4,
      keepTail: 0,
    });
    const stub = ((await wrapped.execute({}, makeContext())).content[0] as { text: string }).text;
    expect(stub).toContain("HEAD");
    expect(stub.trimEnd().endsWith("…]")).toBe(true);
  });

  it("wraps every non-excluded tool in the array, preserving order", async () => {
    const dir = await tempDir();
    const tools = [
      makeTool("read", textResult("a")),
      makeTool("bash", textResult("b")),
      makeTool("grep", textResult("c")),
    ];
    const wrapped = wrapToolsWithOffload(tools, { dir });
    expect(wrapped.map((t) => t.definition.name)).toEqual(["read", "bash", "grep"]);
    expect(wrapped[0]).toBe(tools[0]);
    expect(wrapped[1]).not.toBe(tools[1]);
    expect(wrapped[2]).not.toBe(tools[2]);
  });
});

describe("buildOffloadStub", () => {
  it("quotes the path as JSON so the model can paste it into read", () => {
    const stub = buildOffloadStub({
      toolName: "bash",
      path: "/tmp/a b/out.txt",
      chars: 100,
      bytes: 100,
      lines: 4,
      maxChars: 10,
      excerpt: "EXCERPT",
    });
    expect(stub).toContain('"/tmp/a b/out.txt"');
    expect(stub).toContain("100 characters (100 bytes, 4 lines)");
    expect(stub).toContain("EXCERPT");
    expect(stub).toContain("Nothing was lost.");
  });
});
