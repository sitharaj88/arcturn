import { describe, expect, it, vi } from "vitest";
import type { ChildLike, SpawnLike } from "../serve/supervisor.js";
import { FakeSocket, flush } from "../serve/test-socket.js";
import { createEngineSession, type EngineSessionOptions } from "./engine-session.js";
import type { ConnectionStatus } from "./webview-messages.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

class FakeStream {
  readonly #listeners: ((chunk: unknown) => void)[] = [];
  on(_event: "data", listener: (chunk: unknown) => void): this {
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
  readonly pid = 99;
  readonly signals: (string | number | undefined)[] = [];
  #exit: ((code: number | null, signal: string | null) => void)[] = [];

  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: unknown): this {
    if (event === "exit") this.#exit.push(listener as (c: number | null, s: string | null) => void);
    return this;
  }

  kill(signal?: string | number): boolean {
    this.signals.push(signal);
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    for (const listener of [...this.#exit]) listener(code, signal);
  }

  announce(url = "ws://127.0.0.1:53145"): void {
    this.stdout.emit(`arcturn serving on ${url}\n`);
  }
}

interface Harness {
  child: FakeChild;
  /** Every socket the session opened, in order. */
  sockets: FakeSocket[];
  /** The socket the session is currently using. */
  socket: FakeSocket;
  spawned: { command: string; args: readonly string[] }[];
  statuses: { status: ConnectionStatus; detail?: string }[];
  logged: string[];
  /** Everything the session pushed at `host.onDiagnostic`. */
  diagnostics: string[];
  session: ReturnType<typeof createEngineSession>;
}

/** A scripted server: real session headers where the protocol demands them. */
function scriptedSocket(): FakeSocket {
  const socket = new FakeSocket();
  socket.autoRespond = (frame) => {
    if (frame.method === "createSession") {
      return { version: 1, sessionId: "s-new", cwd: "/workspace", createdAt: 1 };
    }
    if (frame.method === "openSession") {
      return {
        version: 1,
        sessionId: String(frame.params?.sessionId),
        cwd: "/workspace",
        createdAt: 2,
      };
    }
    if (frame.method === "listSessions") {
      return { sessions: [{ version: 1, sessionId: "s1", cwd: "/workspace", createdAt: 3 }] };
    }
    return {};
  };
  return socket;
}

function harness(over: Partial<EngineSessionOptions> = {}): Harness {
  const child = new FakeChild();
  const sockets: FakeSocket[] = [];
  const spawned: Harness["spawned"] = [];
  const statuses: Harness["statuses"] = [];
  const logged: string[] = [];
  const diagnostics: string[] = [];
  const spawn: SpawnLike = (command, args) => {
    spawned.push({ command, args });
    // The engine announces as soon as it is asked to start.
    queueMicrotask(() => child.announce());
    return child;
  };
  const session = createEngineSession({
    cwd: "/workspace",
    resolveCli: async () => ({ command: "/bin/arcturn" }),
    spawn,
    socketFactory: () => {
      const next = scriptedSocket();
      sockets.push(next);
      return next;
    },
    generateToken: () => TOKEN,
    startupTimeoutMs: 200,
    log: (line) => logged.push(line),
    host: {
      onChat: () => {},
      onCost: () => {},
      askPermission: async () => ({ behavior: "deny" }),
      onConnection: (status, detail) =>
        statuses.push(detail === undefined ? { status } : { status, detail }),
      onDiagnostic: (line) => diagnostics.push(line),
    },
    ...over,
  });
  return {
    child,
    sockets,
    get socket(): FakeSocket {
      const latest = sockets.at(-1);
      if (latest === undefined) throw new Error("no socket has been opened yet");
      return latest;
    },
    spawned,
    statuses,
    logged,
    diagnostics,
    session,
  };
}

async function started(h: Harness): Promise<void> {
  await h.session.start();
}

describe("createEngineSession", () => {
  it("spawns nothing until it is started", () => {
    const h = harness();
    expect(h.spawned).toHaveLength(0);
    expect(h.session.status).toBe("idle");
  });

  it("spawns arcturn serve on loopback with an ephemeral port and a generated token", async () => {
    const h = harness();
    await started(h);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.command).toBe("/bin/arcturn");
    expect(h.spawned[0]?.args).toEqual([
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--cwd",
      "/workspace",
      "--token",
      TOKEN,
    ]);
  });

  it("reaches ready with a session open", async () => {
    const h = harness();
    await started(h);
    expect(h.session.status).toBe("ready");
    expect(h.session.controller?.sessionId).toBe("s-new");
    expect(h.statuses.map((s) => s.status)).toEqual(["starting", "ready"]);
  });

  it("subscribes to the session it created — createSession alone does not", async () => {
    const h = harness();
    await started(h);
    // `ws-server.ts` attaches the event observer in `openSession` only; a
    // connection that merely created a session receives nothing.
    expect(h.socket.lastFrame("openSession")?.params).toEqual({ sessionId: "s-new" });
    h.socket.emitEvent("s-new", { type: "notice", level: "info", text: "hello" });
    expect(h.session.controller?.state.blocks).toHaveLength(1);
  });

  it("starts once, however many times it is asked", async () => {
    const h = harness();
    await Promise.all([h.session.start(), h.session.start()]);
    expect(h.spawned).toHaveLength(1);
  });

  it("reports a missing CLI as a reconnect card, not a thrown stack", async () => {
    const h = harness({ resolveCli: async () => undefined });
    await h.session.start();
    expect(h.session.status).toBe("disconnected");
    expect(h.statuses.at(-1)?.detail).toMatch(/arcturn/i);
    expect(h.spawned).toHaveLength(0);
  });

  it("shows a reconnect card when serve dies, and never a token with it", async () => {
    const h = harness();
    await started(h);
    h.child.stderr.emit(`fatal: bad thing near ${TOKEN}\n`);
    h.child.exit(1, null);
    await flush();
    expect(h.session.status).toBe("disconnected");
    const detail = h.statuses.at(-1)?.detail ?? "";
    expect(detail).toContain("fatal: bad thing");
    expect(detail).not.toContain(TOKEN);
  });

  it("shows a reconnect card when the socket closes under it", async () => {
    const h = harness();
    await started(h);
    h.socket.emitClose(1006);
    await flush();
    expect(h.session.status).toBe("disconnected");
  });

  it("ignores a late close from the connection it already replaced", async () => {
    const h = harness();
    await started(h);
    const first = h.sockets[0];
    await h.session.restart();
    expect(h.session.status).toBe("ready");
    // A real `ws` socket reports its close long after `close()` returned.
    first?.emitClose(1006);
    await flush();
    expect(h.session.status).toBe("ready");
  });

  it("restarts from the reconnect card", async () => {
    const h = harness();
    await started(h);
    h.child.exit(1, null);
    await flush();
    await h.session.restart();
    expect(h.spawned).toHaveLength(2);
    expect(h.session.status).toBe("ready");
  });

  it("redacts a controller diagnostic before it leaves the session", async () => {
    const h = harness();
    await started(h);
    // Leave `prompt` unanswered so the test controls how it fails.
    h.socket.autoRespond = (frame) => (frame.method === "prompt" ? undefined : {});
    await h.session.controller?.send("go");
    // A server error whose message happens to carry the token. Nothing in the
    // wire protocol puts it there today — this is the defense-in-depth case.
    h.socket.emit({
      kind: "response",
      id: h.socket.lastFrame("prompt")?.id,
      error: { code: "internal", message: `boom ${TOKEN}` },
    });
    await flush();
    expect(h.diagnostics.length).toBeGreaterThan(0);
    expect(h.diagnostics.join("\n")).not.toContain(TOKEN);
    expect(h.diagnostics.join("\n")).toContain("boom");
  });

  it("never logs the token", async () => {
    const h = harness();
    await started(h);
    h.child.stderr.emit(`token is ${TOKEN}\n`);
    expect(h.logged.join("\n")).not.toContain(TOKEN);
  });

  it("opens an existing session on request", async () => {
    const h = harness();
    await started(h);
    await h.session.openSession("s-old");
    expect(h.socket.lastFrame("openSession")?.params).toEqual({ sessionId: "s-old" });
    expect(h.session.controller?.sessionId).toBe("s-old");
  });

  it("lists sessions through the protocol", async () => {
    const h = harness();
    await started(h);
    const headers = await h.session.listSessions();
    expect(headers.map((header) => header.sessionId)).toEqual(["s1"]);
  });

  it("dispose kills the child, closes the client and disposes the controller", async () => {
    const h = harness();
    await started(h);
    const controller = h.session.controller;
    h.session.dispose();
    expect(h.child.signals).toContain("SIGTERM");
    expect(h.socket.closeCalls).toBe(1);
    expect(controller?.permissions.disposed).toBe(true);
    expect(h.session.status).toBe("idle");
  });

  it("dispose is idempotent and suppresses the child's exit report", async () => {
    const h = harness();
    await started(h);
    const before = h.statuses.length;
    h.session.dispose();
    h.session.dispose();
    h.child.exit(null, "SIGTERM");
    await flush();
    expect(h.statuses.slice(before).some((s) => s.status === "disconnected")).toBe(false);
  });

  it("refuses to start after disposal rather than leaking a process", async () => {
    const h = harness();
    h.session.dispose();
    await h.session.start();
    expect(h.spawned).toHaveLength(0);
  });

  it("surfaces a failed start as a reconnect card", async () => {
    const spawnThatDies: SpawnLike = () => {
      const child = new FakeChild();
      queueMicrotask(() => child.exit(2, null));
      return child;
    };
    const onConnection = vi.fn();
    const h = harness({
      spawn: spawnThatDies,
      host: {
        onChat: () => {},
        onCost: () => {},
        askPermission: async () => ({ behavior: "deny" }),
        onConnection,
      },
    });
    await h.session.start();
    expect(h.session.status).toBe("disconnected");
    expect(onConnection).toHaveBeenLastCalledWith("disconnected", expect.stringMatching(/serve/i));
  });
});
