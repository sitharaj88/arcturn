import { describe, expect, it, vi } from "vitest";
import type { ChildLike, SpawnLike } from "./supervisor.js";
import { ServeStartError, startServeProcess } from "./supervisor.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

type DataListener = (chunk: unknown) => void;

class FakeStream {
  readonly #listeners: DataListener[] = [];
  on(_event: "data", listener: DataListener): this {
    this.#listeners.push(listener);
    return this;
  }
  emit(chunk: string): void {
    for (const listener of [...this.#listeners]) listener(Buffer.from(chunk, "utf8"));
  }
}

class FakeChild implements ChildLike {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly pid = 4242;
  readonly signals: (string | number | undefined)[] = [];
  #exit: ((code: number | null, signal: string | null) => void)[] = [];
  #error: ((error: Error) => void)[] = [];

  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: unknown): this {
    if (event === "exit") this.#exit.push(listener as (c: number | null, s: string | null) => void);
    if (event === "error") this.#error.push(listener as (e: Error) => void);
    return this;
  }

  kill(signal?: string | number): boolean {
    this.signals.push(signal);
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    for (const listener of [...this.#exit]) listener(code, signal);
  }

  fail(error: Error): void {
    for (const listener of [...this.#error]) listener(error);
  }
}

interface Harness {
  child: FakeChild;
  spawn: SpawnLike;
  calls: { command: string; args: readonly string[]; cwd: string }[];
}

function harness(): Harness {
  const child = new FakeChild();
  const calls: Harness["calls"] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return child;
  };
  return { child, spawn, calls };
}

function options(h: Harness, extra: Record<string, unknown> = {}) {
  return {
    command: "/bin/arcturn",
    args: ["serve", "--token", TOKEN],
    cwd: "/workspace",
    token: TOKEN,
    spawn: h.spawn,
    startupTimeoutMs: 50,
    ...extra,
  };
}

describe("startServeProcess", () => {
  it("resolves with the announced address once serve prints it", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.stdout.emit("arcturn serving on ws://127.0.0.1:53145\n");
    const serve = await started;
    expect(serve.socketUrl).toBe("ws://127.0.0.1:53145");
    expect(h.calls[0]?.cwd).toBe("/workspace");
    serve.dispose();
  });

  it("hands the token to the client in the url fragment", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.stdout.emit("arcturn serving on ws://127.0.0.1:53145\n");
    const serve = await started;
    expect(serve.connectUrl).toBe(`ws://127.0.0.1:53145#token=${TOKEN}`);
    serve.dispose();
  });

  it("never logs the token, not even the line serve prints it on", async () => {
    const h = harness();
    const logged: string[] = [];
    const started = startServeProcess(options(h, { log: (line: string) => logged.push(line) }));
    h.child.stdout.emit(
      `arcturn serving on ws://127.0.0.1:53145\n  attach with: arcturn attach ws://127.0.0.1:53145 --token ${TOKEN}\n`,
    );
    const serve = await started;
    h.child.stderr.emit(`boom ${TOKEN}\n`);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(TOKEN);
    serve.dispose();
  });

  it("refuses an announcement that is not loopback and kills the child", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.stdout.emit("arcturn serving on ws://192.168.1.5:53145\n");
    await expect(started).rejects.toThrow(/loopback/i);
    expect(h.child.signals.length).toBeGreaterThan(0);
  });

  it("rejects with the child's stderr, redacted, when it dies before announcing", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.stderr.emit(`arcturn: no API key configured (token ${TOKEN})\n`);
    h.child.exit(2, null);
    const error = await started.catch((e: unknown) => e);
    expect(String(error)).toContain("no API key configured");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("rejects when the child never announces before the deadline", async () => {
    const h = harness();
    await expect(startServeProcess(options(h, { startupTimeoutMs: 5 }))).rejects.toThrow(
      /did not start/i,
    );
    expect(h.child.signals.length).toBeGreaterThan(0);
  });

  it("rejects, redacted, when spawn itself fails", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.fail(new Error(`ENOENT --token ${TOKEN}`));
    const error = await started.catch((e: unknown) => e);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).toContain("ENOENT");
  });

  it("reports an exit after startup through onExit, with a redacted detail", async () => {
    const h = harness();
    const onExit = vi.fn();
    const started = startServeProcess(options(h, { onExit }));
    h.child.stdout.emit("arcturn serving on ws://127.0.0.1:53145\n");
    await started;
    h.child.stderr.emit(`fatal ${TOKEN}\n`);
    h.child.exit(1, null);
    expect(onExit).toHaveBeenCalledTimes(1);
    const info = onExit.mock.calls[0]?.[0] as { code: number | null; detail: string };
    expect(info.code).toBe(1);
    expect(info.detail).not.toContain(TOKEN);
    expect(info.detail).toContain("fatal");
  });

  it("does not report an exit that dispose asked for", async () => {
    const h = harness();
    const onExit = vi.fn();
    const started = startServeProcess(options(h, { onExit }));
    h.child.stdout.emit("arcturn serving on ws://127.0.0.1:53145\n");
    const serve = await started;
    serve.dispose();
    h.child.exit(null, "SIGTERM");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("dispose is idempotent and terminates the child", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.stdout.emit("arcturn serving on ws://127.0.0.1:53145\n");
    const serve = await started;
    serve.dispose();
    serve.dispose();
    expect(h.child.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const h = harness();
    const started = startServeProcess(options(h, { killGraceMs: 5 }));
    h.child.stdout.emit("arcturn serving on ws://127.0.0.1:53145\n");
    const serve = await started;
    serve.dispose();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("startServeProcess: the failure the user has to be shown", () => {
  it("carries the child's own stderr as a field, not only inside a sentence", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.stderr.emit(
      "arcturn: No API key found for Claude Sonnet 4.5 (anthropic/claude-sonnet-4-5).\n" +
        "Set ANTHROPIC_API_KEY in your environment, or pick another model with --model.\n",
    );
    h.child.exit(2, null);
    const error = await started.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServeStartError);
    const failure = (error as ServeStartError).failure;
    expect(failure.reason).toBe("exited");
    expect(failure.code).toBe(2);
    expect(failure.stderr).toBe(
      "arcturn: No API key found for Claude Sonnet 4.5 (anthropic/claude-sonnet-4-5).\n" +
        "Set ANTHROPIC_API_KEY in your environment, or pick another model with --model.",
    );
  });

  it("redacts the token out of the structured stderr too, not just the message", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.stderr.emit(`arcturn: bad --token ${TOKEN}\n`);
    h.child.exit(2, null);
    const error = (await started.catch((e: unknown) => e)) as ServeStartError;
    expect(error.failure.stderr).not.toContain(TOKEN);
    expect(error.failure.stderr).toContain("arcturn: bad");
  });

  it("reports an empty stderr rather than inventing one when the child said nothing", async () => {
    const h = harness();
    const started = startServeProcess(options(h));
    h.child.exit(127, null);
    const error = (await started.catch((e: unknown) => e)) as ServeStartError;
    expect(error.failure.stderr).toBe("");
    expect(error.failure.code).toBe(127);
  });

  it("distinguishes a timeout, a spawn failure and a bad address from a plain exit", async () => {
    const timedOut = (await startServeProcess(options(harness(), { startupTimeoutMs: 5 })).catch(
      (e: unknown) => e,
    )) as ServeStartError;
    expect(timedOut.failure.reason).toBe("timeout");

    const spawnFailed = harness();
    const spawning = startServeProcess(options(spawnFailed));
    spawnFailed.child.fail(new Error("ENOENT"));
    expect(((await spawning.catch((e: unknown) => e)) as ServeStartError).failure.reason).toBe(
      "spawn",
    );

    const badAddress = harness();
    const announcing = startServeProcess(options(badAddress));
    badAddress.child.stdout.emit("arcturn serving on ws://192.168.1.5:53145\n");
    expect(((await announcing.catch((e: unknown) => e)) as ServeStartError).failure.reason).toBe(
      "address",
    );
  });
});
