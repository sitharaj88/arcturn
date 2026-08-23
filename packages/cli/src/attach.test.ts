/**
 * `arcturn attach` client tests.
 *
 * Everything is in memory: a {@link FakeSocket} speaking the wire protocol
 * (the same approach `packages/protocol/src/client.test.ts` uses) and a
 * `TestTerminal`. No TTY, no network, no `ws`.
 */

import type { WebSocketLike } from "@arcturn/protocol";
import { ColorLevel, setColorLevel, stripAnsi, TestTerminal } from "@arcturn/tui";
import type { AgentEvent, SessionHeader } from "@arcturn/types";
import { beforeAll, describe, expect, it } from "vitest";
import { AttachExitCode, runAttach } from "./attach.js";

beforeAll(() => {
  setColorLevel(ColorLevel.None);
});

// ---------------------------------------------------------------------------
// In-memory fake socket
// ---------------------------------------------------------------------------

type AnyListener = (...args: unknown[]) => void;

interface Frame {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

class FakeSocket implements WebSocketLike {
  /** Raw text frames handed to `send`, in order. */
  readonly sent: string[] = [];
  closeCalls = 0;
  readyState: number | undefined;
  readonly #handlers = new Map<string, AnyListener[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "open", listener: () => void): void;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: string, listener: unknown): void {
    const handler = listener as AnyListener;
    const existing = this.#handlers.get(event);
    if (existing) existing.push(handler);
    else this.#handlers.set(event, [handler]);
  }

  /** Deliver an inbound message; objects are JSON-encoded. */
  emit(payload: unknown): void {
    this.#fire("message", typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  emitClose(code?: number): void {
    this.readyState = 3;
    this.#fire("close", code);
  }

  /** Push one session event, as `ws-server.ts` does. */
  emitEvent(sessionId: string, event: AgentEvent): void {
    this.emit({ kind: "event", sessionId, event });
  }

  frames(): Frame[] {
    return this.sent.map((text) => JSON.parse(text) as Frame);
  }

  frame(index: number): Frame {
    const frame = this.frames()[index];
    if (!frame) throw new Error(`No frame at index ${index} (sent ${this.sent.length})`);
    return frame;
  }

  /** Index of the first frame with `method`, or `-1`. */
  indexOf(method: string): number {
    return this.frames().findIndex((frame) => frame.method === method);
  }

  find(method: string): Frame | undefined {
    return this.frames().find((frame) => frame.method === method);
  }

  respondOk(index: number, result: unknown): void {
    this.emit({ kind: "response", id: this.frame(index).id, result });
  }

  respondError(index: number, code: string, message: string): void {
    this.emit({ kind: "response", id: this.frame(index).id, error: { code, message } });
  }

  #fire(event: string, ...args: unknown[]): void {
    for (const listener of this.#handlers.get(event) ?? []) listener(...args);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ESCAPE = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";

const HEADER: SessionHeader = {
  version: 1,
  sessionId: "s1",
  cwd: "/repo",
  createdAt: 1_700_000_000_000,
};

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  { timeout = 5_000, label = "condition" }: { timeout?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(2);
  }
  throw new Error(`${label} was never met within ${timeout}ms`);
}

interface Harness {
  socket: FakeSocket;
  terminal: TestTerminal;
  exit: Promise<number>;
  text: () => string;
  /** Press Ctrl+C twice and await the exit code. */
  quit: () => Promise<number>;
}

function harness(overrides: Partial<Parameters<typeof runAttach>[0]> = {}): Harness {
  const socket = new FakeSocket();
  const terminal = new TestTerminal({ columns: 100, rows: 30 });
  const exit = runAttach({
    socket,
    terminal,
    url: "ws://test:1",
    cwd: "/repo",
    streamThrottleMs: 1,
    ...overrides,
  });
  return {
    socket,
    terminal,
    exit,
    text: () => stripAnsi(terminal.output),
    quit: async () => {
      terminal.injectInput(CTRL_C);
      terminal.injectInput(CTRL_C);
      return exit;
    },
  };
}

/** Attach to `s1` and settle, leaving the app idle and ready for input. */
async function attached(
  overrides: Partial<Parameters<typeof runAttach>[0]> = {},
): Promise<Harness> {
  const h = harness({ sessionId: "s1", ...overrides });
  await waitFor(() => h.socket.indexOf("openSession") >= 0, { label: "openSession frame" });
  h.socket.respondOk(h.socket.indexOf("openSession"), HEADER);
  await waitFor(() => h.text().includes("Attached to session s1"), { label: "attach notice" });
  return h;
}

// ---------------------------------------------------------------------------

describe("runAttach — attaching", () => {
  it("opens the session it was given", async () => {
    const h = await attached();
    expect(h.socket.frame(0).method).toBe("openSession");
    expect(h.socket.frame(0).params).toEqual({ sessionId: "s1" });
    expect(h.text()).toContain("ws://test:1");
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("authenticates before anything else when a token is given", async () => {
    const h = harness({ sessionId: "s1", token: "secret" });
    await waitFor(() => h.socket.sent.length >= 1, { label: "first frame" });
    expect(h.socket.frame(0).method).toBe("authenticate");
    expect(h.socket.frame(0).params).toMatchObject({ token: "secret" });
    // Nothing else goes out until the handshake resolves.
    expect(h.socket.sent).toHaveLength(1);

    h.socket.respondOk(0, { authenticated: true });
    await waitFor(() => h.socket.indexOf("openSession") >= 0, { label: "openSession frame" });
    h.socket.respondOk(h.socket.indexOf("openSession"), HEADER);
    await waitFor(() => h.text().includes("Attached to session s1"), { label: "attach notice" });
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("attaches to the newest listed session when none is named", async () => {
    const h = harness();
    await waitFor(() => h.socket.indexOf("listSessions") >= 0, { label: "listSessions frame" });
    h.socket.respondOk(0, {
      sessions: [
        { ...HEADER, sessionId: "old", createdAt: 1 },
        { ...HEADER, sessionId: "new", createdAt: 2 },
      ],
    });
    await waitFor(() => h.socket.indexOf("openSession") >= 0, { label: "openSession frame" });
    expect(h.socket.find("openSession")?.params).toEqual({ sessionId: "new" });

    h.socket.respondOk(1, { ...HEADER, sessionId: "new" });
    await waitFor(() => h.text().includes("Attached to session new"), { label: "attach notice" });
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("creates a session when the server lists none, then opens it", async () => {
    const h = harness();
    await waitFor(() => h.socket.indexOf("listSessions") >= 0, { label: "listSessions frame" });
    h.socket.respondOk(0, { sessions: [] });

    await waitFor(() => h.socket.indexOf("createSession") >= 0, { label: "createSession frame" });
    expect(h.socket.find("createSession")?.params).toEqual({ cwd: "/repo" });
    h.socket.respondOk(1, HEADER);

    // `createSession` does not subscribe the connection server-side, so the
    // client must still open the session it just made.
    await waitFor(() => h.socket.indexOf("openSession") >= 0, { label: "openSession frame" });
    h.socket.respondOk(2, HEADER);
    await waitFor(() => h.text().includes("Attached to session s1"), { label: "attach notice" });
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("exits non-zero with a message when the server rejects the session", async () => {
    const h = harness({ sessionId: "nope" });
    await waitFor(() => h.socket.indexOf("openSession") >= 0, { label: "openSession frame" });
    h.socket.respondError(0, "notFound", 'Unknown session "nope"');

    expect(await h.exit).toBe(AttachExitCode.attachFailed);
    expect(h.text()).toContain('Unknown session "nope"');
  });
});

describe("runAttach — rendering", () => {
  it("renders a scripted event sequence through the TranscriptFormatter", async () => {
    const h = await attached();

    h.socket.emitEvent("s1", {
      type: "runStart",
      sessionId: "s1",
      prompt: { role: "user", content: [{ type: "text", text: "list the files" }] },
    });
    h.socket.emitEvent("s1", {
      type: "toolStart",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "ls -1" },
    });
    h.socket.emitEvent("s1", {
      type: "toolEnd",
      toolCallId: "t1",
      result: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "README.md" }],
        details: { exitCode: 0 },
      },
    });
    h.socket.emitEvent("s1", {
      type: "messageEnd",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "There is one file." }],
        stopReason: "endTurn",
      },
    });
    h.socket.emitEvent("s1", { type: "runEnd", reason: "completed" });

    await waitFor(() => h.text().includes("There is one file."), { label: "assistant text" });
    const text = h.text();
    expect(text).toContain("list the files");
    expect(text).toContain("bash");
    expect(text).toContain("README.md");
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("ignores events for a session it is not attached to", async () => {
    const h = await attached();
    h.socket.emitEvent("other", {
      type: "notice",
      level: "error",
      text: "belongs to another session",
    });
    h.socket.emitEvent("s1", { type: "notice", level: "info", text: "belongs to this session" });

    await waitFor(() => h.text().includes("belongs to this session"), { label: "own notice" });
    expect(h.text()).not.toContain("belongs to another session");
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });
});

describe("runAttach — input", () => {
  it("sends a prompt frame when a line is submitted while idle", async () => {
    const h = await attached();
    h.terminal.injectInput("hello remote");
    h.terminal.injectInput(ENTER);

    await waitFor(() => h.socket.indexOf("prompt") >= 0, { label: "prompt frame" });
    expect(h.socket.find("prompt")?.params).toEqual({ sessionId: "s1", text: "hello remote" });
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("sends a steer frame instead while a run is active", async () => {
    const h = await attached();
    h.socket.emitEvent("s1", {
      type: "runStart",
      sessionId: "s1",
      prompt: { role: "user", content: [{ type: "text", text: "go" }] },
    });
    await tick();

    h.terminal.injectInput("actually use ripgrep");
    h.terminal.injectInput(ENTER);

    await waitFor(() => h.socket.indexOf("steer") >= 0, { label: "steer frame" });
    expect(h.socket.find("steer")?.params).toEqual({
      sessionId: "s1",
      text: "actually use ripgrep",
    });
    expect(h.socket.indexOf("prompt")).toBe(-1);
    expect(h.text()).toContain("steering the remote run");

    // Leave the run "finished" so the quit path is a plain double Ctrl+C.
    h.socket.emitEvent("s1", { type: "runEnd", reason: "completed" });
    await tick();
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("aborts the remote run on Esc", async () => {
    const h = await attached();
    h.socket.emitEvent("s1", {
      type: "runStart",
      sessionId: "s1",
      prompt: { role: "user", content: [{ type: "text", text: "go" }] },
    });
    await tick();

    h.terminal.injectInput(ESCAPE);
    await waitFor(() => h.socket.indexOf("abort") >= 0, { label: "abort frame" });
    expect(h.socket.find("abort")?.params).toEqual({ sessionId: "s1" });

    h.socket.emitEvent("s1", { type: "runEnd", reason: "aborted" });
    await tick();
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("exits 0 on a second Ctrl+C and closes the client", async () => {
    const h = await attached();
    h.terminal.injectInput(CTRL_C);
    await waitFor(() => h.text().includes("Press Ctrl+C again to exit."), {
      label: "interrupt hint",
    });
    h.terminal.injectInput(CTRL_C);

    expect(await h.exit).toBe(AttachExitCode.ok);
    expect(h.socket.closeCalls).toBeGreaterThan(0);
  });
});

describe("runAttach — permissions", () => {
  it("answers a permission request with a correlated permissionDecision", async () => {
    const h = await attached();
    h.socket.emitEvent("s1", {
      type: "permissionRequest",
      request: {
        id: "p1",
        toolName: "bash",
        toolCallId: "t1",
        subject: "rm -rf build",
        description: "Run rm -rf build",
      },
    });
    await waitFor(() => h.text().includes("rm -rf build"), { label: "permission dialog" });

    // The dialog's first row is "Allow once"; Enter confirms it.
    h.terminal.injectInput(ENTER);
    await waitFor(() => h.socket.indexOf("permissionDecision") >= 0, { label: "decision frame" });

    expect(h.socket.find("permissionDecision")?.params).toEqual({
      sessionId: "s1",
      decision: { requestId: "p1", behavior: "allow" },
    });
    expect(await h.quit()).toBe(AttachExitCode.ok);
  });

  it("denies a still-open permission request on exit rather than hanging the run", async () => {
    const h = await attached();
    h.socket.emitEvent("s1", {
      type: "permissionRequest",
      request: {
        id: "p2",
        toolName: "write",
        toolCallId: "t2",
        subject: "src/app.ts",
        description: "Write src/app.ts",
      },
    });
    await waitFor(() => h.text().includes("src/app.ts"), { label: "permission dialog" });

    // Ctrl+C is a global handler, so it still reaches the app with the dialog up.
    h.terminal.injectInput(CTRL_C);
    h.terminal.injectInput(CTRL_C);
    expect(await h.exit).toBe(AttachExitCode.ok);

    const decision = h.socket.find("permissionDecision");
    expect(decision?.params).toMatchObject({
      sessionId: "s1",
      decision: { requestId: "p2", behavior: "deny" },
    });
  });
});

describe("runAttach — disconnection", () => {
  it("exits non-zero with a clear message when the socket closes mid-session", async () => {
    const h = await attached();
    h.socket.emitClose(1006);

    expect(await h.exit).toBe(AttachExitCode.disconnected);
    expect(h.text()).toContain("connection to ws://test:1 closed (code 1006)");
  });

  it("exits non-zero when the socket errors", async () => {
    const h = await attached();
    // A socket error is delivered through the same handler chain as a close.
    h.socket.emit("not json at all");
    await tick();
    h.socket.emitClose();

    expect(await h.exit).toBe(AttachExitCode.disconnected);
    expect(h.text()).toContain("connection to ws://test:1 closed");
  });
});
