import { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePath } from "@arcturn/tools";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeFrame,
  type LspClient,
  LspFrameDecoder,
  resolveLspSpawn,
  spawnLspClient,
} from "./client.js";
import { createLspManager, formatDiagnostics } from "./manager.js";
import { clearServerExistsCache, serverFor } from "./servers.js";
import { wrapToolsWithLsp } from "./wrap.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeServerPath = join(here, "fake-server.mjs");

function fakeCommand(...extraArgs: string[]): string[] {
  return [process.execPath, fakeServerPath, ...extraArgs];
}

/**
 * Remove a temp tree, retrying the way `fs.rm` documents for Windows.
 *
 * Every directory here is the `cwd` of a spawned server, and Windows keeps a
 * handle on a live process's working directory — so a lagging handle release
 * surfaces as `EBUSY` on `rmdir`. `dispose()` is what guarantees the process
 * is gone (and a dedicated test asserts that); the retries only absorb the OS
 * releasing the handle a beat later.
 */
function rmTree(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

/** Extract the text of a `ToolResult`'s first content block, failing loudly if there isn't one. */
function firstText(result: ToolResult | undefined): string {
  const item = result?.content[0];
  if (item?.type !== "text") throw new Error("expected a text content block");
  return item.text;
}

describe("LspFrameDecoder", () => {
  it("decodes a single frame delivered in one chunk", () => {
    const decoder = new LspFrameDecoder();
    const frame = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(decoder.push(frame)).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  });

  it("decodes a frame split across many small chunks", () => {
    const decoder = new LspFrameDecoder();
    const frame = encodeFrame({ jsonrpc: "2.0", id: 2, method: "split", params: { n: 42 } });
    const collected: unknown[] = [];
    for (let i = 0; i < frame.length; i++) {
      collected.push(...decoder.push(frame.subarray(i, i + 1)));
    }
    expect(collected).toEqual([{ jsonrpc: "2.0", id: 2, method: "split", params: { n: 42 } }]);
  });

  it("decodes several frames coalesced into a single chunk", () => {
    const decoder = new LspFrameDecoder();
    const a = encodeFrame({ jsonrpc: "2.0", id: 1, method: "a" });
    const b = encodeFrame({ jsonrpc: "2.0", id: 2, method: "b" });
    const c = encodeFrame({ jsonrpc: "2.0", id: 3, method: "c" });
    const messages = decoder.push(Buffer.concat([a, b, c]));
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "a" },
      { jsonrpc: "2.0", id: 2, method: "b" },
      { jsonrpc: "2.0", id: 3, method: "c" },
    ]);
  });

  it("buffers a partial frame until the rest arrives, even mid-body", () => {
    const decoder = new LspFrameDecoder();
    const frame = encodeFrame({ jsonrpc: "2.0", id: 9, method: "later", params: { x: "y" } });
    const headerAndSomeBody = frame.subarray(0, frame.length - 3);
    const rest = frame.subarray(frame.length - 3);
    expect(decoder.push(headerAndSomeBody)).toEqual([]);
    expect(decoder.push(rest)).toEqual([
      { jsonrpc: "2.0", id: 9, method: "later", params: { x: "y" } },
    ]);
  });
});

describe("spawnLspClient against the fake server", () => {
  let dir: string;
  let client: LspClient | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-lsp-client-"));
  });

  afterEach(async () => {
    await client?.dispose();
    client = undefined;
    await rmTree(dir);
  });

  it("completes the handshake and returns diagnostics published after didOpen", async () => {
    client = await spawnLspClient(fakeCommand(), {
      cwd: dir,
      rootUri: pathToFileURL(dir).toString(),
    });
    const uri = pathToFileURL(join(dir, "a.ts")).toString();

    client.didOpen(uri, "typescript", "const x = 1;");
    const diagnostics = await client.waitForDiagnostics(uri, 2000);

    expect(diagnostics).not.toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics?.[0]?.message).toBe("fake diagnostic");
    expect(diagnostics?.[0]?.severity).toBe(1);
  });

  it("returns fresh diagnostics after didChange, not the stale didOpen ones", async () => {
    client = await spawnLspClient(fakeCommand(), {
      cwd: dir,
      rootUri: pathToFileURL(dir).toString(),
    });
    const uri = pathToFileURL(join(dir, "b.ts")).toString();

    client.didOpen(uri, "typescript", "const x = 1;");
    await client.waitForDiagnostics(uri, 2000);

    client.didChange(uri, "const x = 1; // NO_DIAGNOSTICS");
    const diagnostics = await client.waitForDiagnostics(uri, 2000);

    expect(diagnostics).toEqual([]);
  });

  it("resolves null, never rejecting, when nothing publishes before the timeout", async () => {
    client = await spawnLspClient(fakeCommand(), {
      cwd: dir,
      rootUri: pathToFileURL(dir).toString(),
    });
    const uri = pathToFileURL(join(dir, "never-opened.ts")).toString();

    const diagnostics = await client.waitForDiagnostics(uri, 150);

    expect(diagnostics).toBeNull();
  });

  it("dispose() completes and kills the process even if shutdown is never answered", async () => {
    client = await spawnLspClient(fakeCommand("--ignore-shutdown"), {
      cwd: dir,
      rootUri: pathToFileURL(dir).toString(),
    });
    const localClient = client;
    client = undefined; // already disposing below; afterEach must not double-dispose

    const start = Date.now();
    await localClient.dispose();
    const elapsed = Date.now() - start;

    // The client's internal shutdown timeout is 1000ms, after which it kills
    // the process outright — this must never hang indefinitely.
    expect(elapsed).toBeLessThan(5000);

    // The process is gone: a fresh wait for diagnostics on a never-opened uri
    // times out to null instead of ever getting an answer.
    const uri = pathToFileURL(join(dir, "after-dispose.ts")).toString();
    const diagnostics = await localClient.waitForDiagnostics(uri, 150);
    expect(diagnostics).toBeNull();
  });

  it("rejects when the command does not exist", async () => {
    await expect(
      spawnLspClient(["definitely-not-a-real-lsp-binary-xyz"], {
        cwd: dir,
        rootUri: pathToFileURL(dir).toString(),
      }),
    ).rejects.toThrow();
  });

  it("sends workspaceFolders, clientInfo, and the expected capabilities in InitializeParams", async () => {
    const rootUri = pathToFileURL(dir).toString();
    client = await spawnLspClient(fakeCommand(), { cwd: dir, rootUri });

    const line = client.stderr.find((entry) =>
      entry.startsWith("[fake-server] initialize params="),
    );
    expect(line).toBeDefined();
    const params = JSON.parse((line as string).slice("[fake-server] initialize params=".length));

    expect(params.workspaceFolders).toEqual([{ uri: rootUri, name: expect.any(String) }]);
    expect(params.clientInfo).toEqual({ name: "arcturn", version: expect.any(String) });
    expect(params.workspaceFoldersCapability).toBe(true);
    expect(params.workspaceSymbolCapability).toEqual({});
    expect(params.hierarchicalDocumentSymbolSupport).toBe(true);
    expect(params.positionEncodings).toEqual(["utf-16"]);
  });

  it("answers workspace/configuration with an array sized to params.items, and initialization still completes", async () => {
    // The fake server withholds its `initialize` reply until it gets back a
    // correctly-sized `workspace/configuration` answer, so `spawnLspClient`
    // resolving at all already proves the handshake completed past that
    // round trip — this regresses the old `result: null` fallback, which a
    // real gopls/rust-analyzer can reject and block on indefinitely.
    client = await spawnLspClient(fakeCommand("--configure-items=3"), {
      cwd: dir,
      rootUri: pathToFileURL(dir).toString(),
    });

    const line = client.stderr.find((entry) => entry.includes("configuration result"));
    expect(line).toContain("length=3");
  });

  it("sends $/cancelRequest with the matching id when a request times out", async () => {
    client = await spawnLspClient(fakeCommand(), {
      cwd: dir,
      rootUri: pathToFileURL(dir).toString(),
    });

    // The fake server never answers unknown methods, so this times out.
    await expect(client.request("custom/neverAnswered", {}, 30)).rejects.toThrow(/timed out/i);

    // The cancel notification is sent synchronously from the timeout
    // handler, but stderr delivery from the child process is async.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelLine = client.stderr.find((entry) => entry.includes("$/cancelRequest"));
    expect(cancelLine).toBeDefined();
    expect(cancelLine).toMatch(/params=\{"id":\d+\}/);
  });

  it("does not force-kill a server that exits promptly after `exit`", async () => {
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill");
    try {
      client = await spawnLspClient(fakeCommand(), {
        cwd: dir,
        rootUri: pathToFileURL(dir).toString(),
      });
      const localClient = client;
      client = undefined;

      await localClient.dispose();

      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("does not resolve dispose() until the killed server has really exited", async () => {
    // `proc.killed` only records that a signal was *delivered*. Resolving on
    // that leaves the process dying in the background, and on Windows a live
    // process holds its working directory open — so the next thing to touch
    // the workspace (this suite's own cleanup, or a manager reusing the
    // directory) fails with EBUSY.
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill");
    try {
      client = await spawnLspClient(fakeCommand("--ignore-exit"), {
        cwd: dir,
        rootUri: pathToFileURL(dir).toString(),
      });
      const localClient = client;
      client = undefined;

      await localClient.dispose();

      const target = killSpy.mock.contexts[0] as ChildProcess | undefined;
      expect(target).toBeDefined();
      // Exited on its own (`exitCode`) or died on the signal (`signalCode`);
      // both null would mean it was still running when dispose() resolved.
      expect(target?.signalCode ?? target?.exitCode).not.toBeNull();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("kills a server that ignores `exit` only after the grace period elapses", async () => {
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill");
    try {
      client = await spawnLspClient(fakeCommand("--ignore-exit"), {
        cwd: dir,
        rootUri: pathToFileURL(dir).toString(),
      });
      const localClient = client;
      client = undefined;

      const start = Date.now();
      await localClient.dispose();
      const elapsed = Date.now() - start;

      expect(killSpy).toHaveBeenCalled();
      // The grace period is ~300ms; allow some slack for timer jitter but
      // still assert it wasn't killed immediately (the old bug).
      expect(elapsed).toBeGreaterThanOrEqual(250);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("resolveLspSpawn", () => {
  it("spawns a plain binary directly, with no shell in between", () => {
    expect(resolveLspSpawn(["gopls"], "linux", {})).toEqual({
      executable: "gopls",
      args: [],
      spawnOptions: {},
    });
    expect(resolveLspSpawn(["/usr/local/bin/pyright-langserver", "--stdio"], "darwin", {})).toEqual(
      {
        executable: "/usr/local/bin/pyright-langserver",
        args: ["--stdio"],
        spawnOptions: {},
      },
    );
  });

  it("spawns a real Windows executable directly as well", () => {
    expect(resolveLspSpawn(["C:\\bin\\rust-analyzer.exe"], "win32", {})).toEqual({
      executable: "C:\\bin\\rust-analyzer.exe",
      args: [],
      spawnOptions: {},
    });
  });

  it("routes a Windows .cmd shim through %ComSpec%, quoted so a spaced path survives", () => {
    // `npm i -g typescript-language-server` installs a `.cmd` shim on Windows,
    // and `CreateProcess` cannot execute one — Node refuses to spawn a
    // `.bat`/`.cmd` without a shell at all. Spawned directly, every
    // npm-installed language server is simply unavailable on Windows.
    const plan = resolveLspSpawn(
      ["C:\\Program Files\\nodejs\\typescript-language-server.CMD", "--stdio"],
      "win32",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    );
    expect(plan.executable).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(plan.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\nodejs\\typescript-language-server.CMD" --stdio"',
    ]);
    // Without this, libuv re-escapes the line and cmd.exe sees something else.
    expect(plan.spawnOptions).toEqual({ windowsVerbatimArguments: true });
  });

  it("covers .bat too, and falls back to cmd.exe when %ComSpec% is unset", () => {
    const plan = resolveLspSpawn(["C:\\bin\\some-langserver.bat", "--stdio"], "win32", {});
    expect(plan.executable).toBe("cmd.exe");
    expect(plan.args).toEqual(["/d", "/s", "/c", '"C:\\bin\\some-langserver.bat --stdio"']);
  });

  it("never involves a shell on POSIX, whatever the file happens to be called", () => {
    // A file named `x.cmd` on Linux is just a file, and there is no cmd.exe
    // to hand it to — the decision follows the platform, not the extension.
    const plan = resolveLspSpawn(["/opt/servers/x.cmd", "--stdio"], "linux", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(plan).toEqual({
      executable: "/opt/servers/x.cmd",
      args: ["--stdio"],
      spawnOptions: {},
    });
  });

  it("rejects an empty command instead of spawning nothing", () => {
    expect(() => resolveLspSpawn([], "linux", {})).toThrow(/at least one element/);
  });
});

describe("createLspManager", () => {
  let dir: string;
  let manager: ReturnType<typeof createLspManager>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-lsp-manager-"));
    manager = createLspManager({
      cwd: dir,
      commandFor: (path) => (path.endsWith(".ts") ? fakeCommand() : undefined),
    });
  });

  afterEach(async () => {
    await manager.dispose();
    await rmTree(dir);
  });

  it("returns null for an extension with no configured server", async () => {
    const diagnostics = await manager.diagnosticsFor(join(dir, "script.unknownext"), "content");
    expect(diagnostics).toBeNull();
  });

  it("returns diagnostics for a file handled by the fake server", async () => {
    const path = join(dir, "app.ts");
    const diagnostics = await manager.diagnosticsFor(path, "const x = 1;", 2000);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics?.[0]?.message).toBe("fake diagnostic");
  });

  it("reuses one client across repeated calls instead of respawning", async () => {
    const path = join(dir, "reused.ts");
    const first = await manager.diagnosticsFor(path, "const x = 1;", 2000);
    const second = await manager.diagnosticsFor(path, "const x = 1; // NO_DIAGNOSTICS", 2000);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("remembers a spawn failure instead of retrying every call", async () => {
    const failing = createLspManager({
      cwd: dir,
      commandFor: () => ["definitely-not-a-real-lsp-binary-xyz"],
    });
    try {
      const first = await failing.diagnosticsFor(join(dir, "x.ts"), "content", 500);
      const second = await failing.diagnosticsFor(join(dir, "y.ts"), "content", 500);
      expect(first).toBeNull();
      expect(second).toBeNull();
    } finally {
      await failing.dispose();
    }
  });
});

describe("formatDiagnostics", () => {
  it("renders one-based line:col with severity and message", () => {
    const text = formatDiagnostics(
      [
        {
          range: { start: { line: 11, character: 4 }, end: { line: 11, character: 5 } },
          severity: 1,
          message: "something is wrong",
        },
      ],
      "src/foo.ts",
    );
    expect(text).toBe("src/foo.ts:12:5 error: something is wrong");
  });

  it("caps at 10 lines and summarizes the rest", () => {
    const diagnostics = Array.from({ length: 13 }, (_, i) => ({
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
      severity: 2,
      message: `issue ${i}`,
    }));
    const text = formatDiagnostics(diagnostics, "f.ts");
    const lines = text.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("… 3 more");
  });
});

describe("serverFor", () => {
  let tempBinDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempBinDir = await mkdtemp(join(tmpdir(), "arcturn-lsp-bin-"));
    originalPath = process.env.PATH;
    clearServerExistsCache();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    clearServerExistsCache();
    await rmTree(tempBinDir);
  });

  it("returns undefined for an unknown extension", () => {
    expect(serverFor("file.unknownext")).toBeUndefined();
  });

  it("returns undefined when the registry's binary is not on PATH", () => {
    process.env.PATH = tempBinDir;
    expect(serverFor("main.go")).toBeUndefined();
  });

  it("returns the command once its binary is resolvable on PATH", async () => {
    const binPath = join(tempBinDir, "gopls");
    await writeFile(binPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binPath, 0o755);
    process.env.PATH = tempBinDir;
    clearServerExistsCache();

    // The resolved file, not the bare name: on Windows the winner may be a
    // `.cmd`/`.bat` shim, and only the resolved name says how to spawn it.
    expect(serverFor("main.go")).toEqual([join(tempBinDir, "gopls")]);
  });
});

describe("wrapToolsWithLsp", () => {
  let dir: string;

  function fakeWriteTool(text = "wrote it"): Tool {
    return {
      definition: {
        name: "write",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
      async execute(input, ctx): Promise<ToolResult> {
        const absolutePath = resolvePath(ctx.cwd, input.path as string);
        await writeFile(absolutePath, input.content as string, "utf8");
        return { content: [{ type: "text", text }] };
      },
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-lsp-wrap-"));
  });

  afterEach(async () => {
    await rmTree(dir);
  });

  it("appends formatted diagnostics to a successful write result", async () => {
    const manager = createLspManager({ cwd: dir, commandFor: () => fakeCommand() });
    try {
      const [wrapped] = wrapToolsWithLsp([fakeWriteTool()], manager);
      const result = await wrapped?.execute(
        { path: "app.ts", content: "const x = 1;" },
        fakeContext(dir),
      );

      expect(result?.isError).toBeFalsy();
      expect(result?.content[0]?.type).toBe("text");
      const text = firstText(result);
      expect(text).toContain("wrote it");
      expect(text).toContain("lsp diagnostics:");
      expect(text).toContain("error: fake diagnostic");
    } finally {
      await manager.dispose();
    }
  });

  it("passes tools through unchanged when their name is not write/edit", async () => {
    const manager = createLspManager({ cwd: dir, commandFor: () => fakeCommand() });
    const passthrough: Tool = {
      definition: { name: "ls", description: "d", parameters: { type: "object", properties: {} } },
      async execute() {
        return { content: [{ type: "text", text: "listing" }] };
      },
    };
    const [wrapped] = wrapToolsWithLsp([passthrough], manager);
    expect(wrapped).toBe(passthrough);
    await manager.dispose();
  });

  it("never turns a failing tool call into a success, and does not touch its result", async () => {
    const manager = createLspManager({ cwd: dir, commandFor: () => fakeCommand() });
    const failing: Tool = {
      definition: {
        name: "write",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        return { content: [{ type: "text", text: "boom" }], isError: true };
      },
    };
    const [wrapped] = wrapToolsWithLsp([failing], manager);
    const result = await wrapped?.execute({ path: "x.ts", content: "y" }, fakeContext(dir));
    expect(result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
    await manager.dispose();
  });

  it("swallows a diagnosticsFor rejection and returns the original result", async () => {
    const manager = {
      diagnosticsFor: async () => {
        throw new Error("boom");
      },
      dispose: async () => {},
    };
    const [wrapped] = wrapToolsWithLsp([fakeWriteTool("ok")], manager);
    const result = await wrapped?.execute({ path: "z.ts", content: "1" }, fakeContext(dir));
    expect(result?.isError).toBeFalsy();
    expect(firstText(result)).toBe("ok");
  });

  it("leaves the result unchanged for an unknown extension (manager returns null)", async () => {
    const manager = createLspManager({ cwd: dir });
    const [wrapped] = wrapToolsWithLsp([fakeWriteTool("ok")], manager);
    const result = await wrapped?.execute(
      { path: "plain.unknownext", content: "1" },
      fakeContext(dir),
    );
    expect(firstText(result)).toBe("ok");
    await manager.dispose();
  });
});
