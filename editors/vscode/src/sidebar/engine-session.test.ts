import { describe, expect, it, vi } from "vitest";
import type { SessionHistory } from "../serve/engine.js";
import type { ChildLike, SpawnLike } from "../serve/supervisor.js";
import { FakeSocket, flush, type SentFrame } from "../serve/test-socket.js";
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
    if (frame.method === "sessionHistory") {
      return storedHistory(String(frame.params?.sessionId));
    }
    return {};
  };
  return socket;
}

/** What a real engine replays for a session with one completed turn in it. */
function storedHistory(sessionId: string, truncated = false, droppedEvents = 0): SessionHistory {
  return {
    sessionId,
    events: [
      {
        type: "runStart",
        sessionId,
        prompt: {
          role: "user",
          content: [{ type: "text", text: "what did I ask before?" }],
          timestamp: 1,
        },
      },
      {
        type: "messageEnd",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "you asked about the parser" }],
          model: "test/model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "endTurn",
          timestamp: 2,
        },
      },
      { type: "runEnd", reason: "completed" },
    ],
    truncated,
    droppedEvents,
  };
}

/**
 * A scripted socket that answers one method with an error response instead —
 * an older engine refusing a verb, or a busy session refusing a delete.
 */
function socketRefusing(method: string, code: string, message: string): FakeSocket {
  const socket = scriptedSocket();
  const scripted = socket.autoRespond as (frame: SentFrame) => unknown;
  socket.autoRespond = (frame) => (frame.method === method ? undefined : scripted(frame));
  const send = socket.send.bind(socket);
  socket.send = (data: string) => {
    send(data);
    const frame = JSON.parse(data) as SentFrame;
    if (frame.method !== method) return;
    queueMicrotask(() => socket.emit({ kind: "response", id: frame.id, error: { code, message } }));
  };
  return socket;
}

/** Every block's text, joined — what the user would be looking at. */
function transcriptText(h: Harness): string {
  return (h.session.controller?.state.blocks ?? [])
    .map((block) => ("text" in block ? block.text : ""))
    .join("\n");
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
    const before = h.session.controller?.state.blocks.length ?? 0;
    h.socket.emitEvent("s-new", { type: "notice", level: "info", text: "hello" });
    // A live event lands on top of whatever the replay already put there.
    expect(h.session.controller?.state.blocks).toHaveLength(before + 1);
    expect(h.session.controller?.state.blocks.at(-1)).toMatchObject({
      kind: "notice",
      text: "hello",
    });
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

  it("lists the engine's model catalog through the protocol", async () => {
    const h = harness();
    await started(h);
    h.socket.autoRespond = (frame) =>
      frame.method === "listModels"
        ? {
            models: [
              {
                id: "anthropic/claude-sonnet-5",
                provider: "anthropic",
                displayName: "Claude Sonnet 5",
                contextWindow: 1_000_000,
                credentials: "present",
              },
            ],
          }
        : {};
    const models = await h.session.listModels();
    expect(models?.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("reports no catalog, rather than failing, against an engine without the verb", async () => {
    const h = harness();
    await started(h);
    const socket = h.socket;
    socket.autoRespond = (frame) => {
      if (frame.method !== "listModels") return {};
      // What an engine older than the verb answers; see ws-server.ts.
      queueMicrotask(() =>
        socket.emit({
          kind: "response",
          id: frame.id,
          error: { code: "invalidRequest", message: 'Unknown method: "listModels"' },
        }),
      );
      return undefined;
    };
    await expect(h.session.listModels()).resolves.toBeUndefined();
  });

  it("reads capabilities off the authenticate handshake, once connected", async () => {
    // Set before `start()`, unlike the `listModels` overrides above: the
    // handshake this reads runs once, inside `boot()`, so a socket swapped in
    // afterwards would be answering a question nobody is asking any more.
    const h = harness({
      socketFactory: () => {
        const socket = scriptedSocket();
        const scripted = socket.autoRespond as (frame: SentFrame) => unknown;
        socket.autoRespond = (frame) =>
          frame.method === "authenticate"
            ? { authenticated: true, capabilities: { ceilingRaise: true } }
            : scripted(frame);
        return socket;
      },
    });
    expect(h.session.capabilities).toEqual({});
    await started(h);
    expect(h.session.capabilities).toEqual({ ceilingRaise: true });
  });

  it("reads {} from an engine that predates capabilities, rather than throwing", async () => {
    const h = harness();
    await started(h);
    expect(h.session.capabilities).toEqual({});
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
    expect(onConnection).toHaveBeenLastCalledWith(
      "disconnected",
      expect.stringMatching(/serve/i),
      expect.objectContaining({ actions: expect.any(Array) }),
    );
  });
});

describe("createEngineSession: telling the user why the engine never started", () => {
  /** A spawn whose child writes the engine's real refusal and exits, like `arcturn serve` does. */
  function refusingSpawn(stderr: string, code = 2): SpawnLike {
    return () => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stderr.emit(stderr);
        child.exit(code, null);
      });
      return child;
    };
  }

  const NO_KEY =
    "arcturn: No API key found for Claude Sonnet 4.5 (anthropic/claude-sonnet-4-5).\n" +
    "Set ANTHROPIC_API_KEY in your environment, or pick another model with --model.\n";

  it("hands the card the engine's own words, verbatim, alongside the summary", async () => {
    const reports: unknown[] = [];
    const h = harness({
      spawn: refusingSpawn(NO_KEY),
      host: {
        onChat: () => {},
        onCost: () => {},
        askPermission: async () => ({ behavior: "deny" }),
        onConnection: (_status, _detail, report) => reports.push(report),
      },
    });
    await h.session.start();
    const report = reports.at(-1) as { engineOutput: string; headline: string; actions: unknown[] };
    expect(report.engineOutput).toContain("No API key found for Claude Sonnet 4.5");
    expect(report.engineOutput).toContain("Set ANTHROPIC_API_KEY in your environment");
    expect(report.headline).toMatch(/could not start/i);
    expect(report.actions.length).toBeGreaterThan(0);
  });

  it("keeps the token out of the structured report as well as the detail", async () => {
    const reports: { engineOutput: string }[] = [];
    const h = harness({
      spawn: refusingSpawn(`arcturn: refusing --token ${TOKEN}\n`),
      host: {
        onChat: () => {},
        onCost: () => {},
        askPermission: async () => ({ behavior: "deny" }),
        onConnection: (_s, _d, report) => {
          if (report !== undefined) reports.push(report);
        },
      },
    });
    await h.session.start();
    expect(reports.at(-1)?.engineOutput).not.toContain(TOKEN);
    expect(reports.at(-1)?.engineOutput).toContain("arcturn: refusing");
  });

  it("reports a missing CLI as a card that offers the installer", async () => {
    const reports: { actions: { id: string }[] }[] = [];
    const h = harness({
      resolveCli: async () => undefined,
      host: {
        onChat: () => {},
        onCost: () => {},
        askPermission: async () => ({ behavior: "deny" }),
        onConnection: (_s, _d, report) => {
          if (report !== undefined) reports.push(report);
        },
      },
    });
    await h.session.start();
    expect(reports.at(-1)?.actions.map((a) => a.id)).toContain("installCli");
  });

  it("exposes the failure so a command invoked from the palette can show it too", async () => {
    const h = harness({ spawn: refusingSpawn(NO_KEY) });
    await h.session.start();
    expect(h.session.failure?.engineOutput).toContain("No API key found");
    expect(h.session.status).toBe("disconnected");
  });

  it("clears the remembered failure once the engine comes back", async () => {
    const h = harness();
    await started(h);
    expect(h.session.failure).toBeUndefined();
  });

  it("spawns serve with the environment it is given, not the extension host's", async () => {
    const envs: (Record<string, string | undefined> | undefined)[] = [];
    const h = harness({
      resolveEnv: async () => ({ PATH: "/opt/homebrew/bin", ANTHROPIC_API_KEY: "k" }),
      spawn: (_command, _args, options) => {
        envs.push(options.env);
        const child = new FakeChild();
        queueMicrotask(() => child.announce());
        return child;
      },
    });
    await h.session.start();
    expect(envs[0]?.PATH).toBe("/opt/homebrew/bin");
    expect(envs[0]?.ANTHROPIC_API_KEY).toBe("k");
  });

  it("does not resolve the environment until it is actually starting the engine", async () => {
    let calls = 0;
    const h = harness({
      resolveEnv: async () => {
        calls += 1;
        return { PATH: "/usr/bin" };
      },
    });
    expect(calls).toBe(0);
    await started(h);
    expect(calls).toBe(1);
  });
});

describe("createEngineSession: replaying what was already said", () => {
  it("renders a session's stored conversation when it attaches, not an empty chat", async () => {
    const h = harness();
    await started(h);
    await h.session.openSession("s-old");

    expect(h.socket.lastFrame("sessionHistory")?.params).toEqual({ sessionId: "s-old" });
    // The transcript is built by the *same* reducer live events go through —
    // this file added no rendering logic to gain it.
    expect(transcriptText(h)).toContain("what did I ask before?");
    expect(transcriptText(h)).toContain("you asked about the parser");
    // A replay describes stored history; nothing in it is still in flight.
    expect(h.session.controller?.state.running).toBe(false);
  });

  it("replays the session it opened on start, too", async () => {
    const h = harness();
    await started(h);
    expect(h.socket.lastFrame("sessionHistory")?.params).toEqual({ sessionId: "s-new" });
    expect(transcriptText(h)).toContain("you asked about the parser");
  });

  it("says earlier messages are missing rather than starting mid-conversation", async () => {
    const socket = scriptedSocket();
    const scripted = socket.autoRespond as (frame: SentFrame) => unknown;
    socket.autoRespond = (frame) =>
      frame.method === "sessionHistory"
        ? storedHistory(String(frame.params?.sessionId), true, 42)
        : scripted(frame);

    const h = harness({ socketFactory: () => socket });
    await started(h);

    expect(transcriptText(h)).toContain("Earlier messages are not shown");
    expect(transcriptText(h)).toContain("42");
  });

  it("still attaches when the engine is too old to replay anything", async () => {
    const h = harness({
      socketFactory: () =>
        socketRefusing("sessionHistory", "invalidRequest", 'Unknown method: "sessionHistory"'),
    });
    await started(h);

    expect(h.session.status).toBe("ready");
    expect(h.session.controller).toBeDefined();
    expect(transcriptText(h)).toBe("");
    expect(h.logged.some((line) => line.includes("cannot replay session history"))).toBe(true);
  });
});

describe("createEngineSession: deleting a session", () => {
  it("asks the engine to delete it and detaches when it was the open one", async () => {
    const h = harness();
    await started(h);
    expect(h.session.controller?.sessionId).toBe("s-new");

    await h.session.deleteSession("s-new");

    expect(h.socket.lastFrame("deleteSession")?.params).toEqual({ sessionId: "s-new" });
    // The panel stops rendering a conversation that no longer exists; what it
    // shows instead is the caller's decision (see `index.ts`).
    expect(h.session.controller).toBeUndefined();
  });

  it("leaves a different session's controller alone", async () => {
    const h = harness();
    await started(h);
    await h.session.deleteSession("some-other-session");

    expect(h.socket.lastFrame("deleteSession")?.params).toEqual({
      sessionId: "some-other-session",
    });
    expect(h.session.controller?.sessionId).toBe("s-new");
  });

  it("keeps the panel attached when the engine refuses the delete", async () => {
    const h = harness({
      socketFactory: () =>
        socketRefusing("deleteSession", "sessionBusy", "Session s-new is running a turn"),
    });
    await started(h);

    await expect(h.session.deleteSession("s-new")).rejects.toMatchObject({ code: "sessionBusy" });
    // Nothing was deleted, so nothing was torn down.
    expect(h.session.controller?.sessionId).toBe("s-new");
  });
});
