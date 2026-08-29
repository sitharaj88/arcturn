import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type ClipboardTool, clipboardToolsFor, copyToClipboard } from "./clipboard.js";

/** A scripted child process: records stdin, then errors or exits as told. */
interface FakeChildScript {
  /** `"missing"` emits ENOENT, a number exits with that code. */
  outcome: "missing" | number;
}

function fakeSpawn(scripts: Record<string, FakeChildScript>) {
  const calls: { command: string; args: string[]; written: string }[] = [];
  const impl = ((command: string, args: string[]) => {
    const call = { command, args, written: "" };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { end(t: string): void };
    };
    const stdin = new EventEmitter() as EventEmitter & { end(t: string): void };
    stdin.end = (text: string) => {
      call.written = text;
    };
    child.stdin = stdin;
    const script = scripts[command] ?? { outcome: "missing" };
    queueMicrotask(() => {
      if (script.outcome === "missing") child.emit("error", new Error("ENOENT"));
      else child.emit("close", script.outcome);
    });
    return child;
  }) as never;
  return { impl, calls };
}

describe("copyToClipboard", () => {
  const tools: ClipboardTool[] = [
    { command: "first", args: ["-a"] },
    { command: "second", args: [] },
  ];

  it("pipes the text into the first tool that exists and exits cleanly", async () => {
    const { impl, calls } = fakeSpawn({ first: { outcome: 0 } });
    const result = await copyToClipboard("the answer", { tools, spawnImpl: impl });
    expect(result).toEqual({ ok: true, via: "first" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "first", args: ["-a"], written: "the answer" });
  });

  it("falls through a missing tool to the next one", async () => {
    const { impl, calls } = fakeSpawn({ second: { outcome: 0 } });
    const result = await copyToClipboard("x", { tools, spawnImpl: impl });
    expect(result).toEqual({ ok: true, via: "second" });
    expect(calls.map((call) => call.command)).toEqual(["first", "second"]);
  });

  it("falls through a tool that exists but fails, not only a missing one", async () => {
    // A half-configured X session throwing from xclip must not hide a
    // working xsel right behind it.
    const { impl } = fakeSpawn({ first: { outcome: 1 }, second: { outcome: 0 } });
    const result = await copyToClipboard("x", { tools, spawnImpl: impl });
    expect(result).toEqual({ ok: true, via: "second" });
  });

  it("names what it tried when every tool refuses", async () => {
    const { impl } = fakeSpawn({});
    const result = await copyToClipboard("x", { tools, spawnImpl: impl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("first, second");
  });

  it("falls back to OSC 52 through the terminal when every pipe fails locally", async () => {
    const { impl } = fakeSpawn({});
    const written: string[] = [];
    const result = await copyToClipboard("hello", {
      tools,
      spawnImpl: impl,
      env: {},
      writeToTerminal: (sequence) => written.push(sequence),
    });
    expect(result).toEqual({ ok: true, via: "osc52" });
    expect(written).toHaveLength(1);
    expect(written[0]).toBe(`\u001b]52;c;${Buffer.from("hello").toString("base64")}\u0007`);
  });

  it("leads with OSC 52 over SSH — a remote pbcopy is the wrong clipboard", async () => {
    const { impl, calls } = fakeSpawn({ first: { outcome: 0 } });
    const written: string[] = [];
    const result = await copyToClipboard("x", {
      tools,
      spawnImpl: impl,
      env: { SSH_TTY: "/dev/ttys001" },
      writeToTerminal: (sequence) => written.push(sequence),
    });
    expect(result).toEqual({ ok: true, via: "osc52" });
    expect(calls).toHaveLength(0); // no pipe was ever spawned
    expect(written).toHaveLength(1);
  });

  it("wraps the sequence in tmux passthrough when inside tmux", async () => {
    const { impl } = fakeSpawn({});
    const written: string[] = [];
    await copyToClipboard("x", {
      tools,
      spawnImpl: impl,
      env: { SSH_TTY: "y", TMUX: "/tmp/tmux-1/default,123,0" },
      writeToTerminal: (sequence) => written.push(sequence),
    });
    expect(written[0]?.startsWith("\u001bPtmux;\u001b\u001b]52;c;")).toBe(true);
    expect(written[0]?.endsWith("\u001b\\")).toBe(true);
  });

  it("refuses to truncate: an oversized payload falls through, named honestly", async () => {
    const { impl } = fakeSpawn({});
    const written: string[] = [];
    const result = await copyToClipboard("y".repeat(100_000), {
      tools,
      spawnImpl: impl,
      env: {},
      writeToTerminal: (sequence) => written.push(sequence),
    });
    expect(written).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("osc52");
  });

  it("orders Wayland before X11 on linux and uses the native tool elsewhere", () => {
    expect(clipboardToolsFor("darwin").map((tool) => tool.command)).toEqual(["pbcopy"]);
    expect(clipboardToolsFor("win32").map((tool) => tool.command)).toEqual(["clip"]);
    expect(clipboardToolsFor("linux").map((tool) => tool.command)).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
  });
});
