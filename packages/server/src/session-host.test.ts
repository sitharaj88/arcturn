import { isAbsolute, resolve } from "node:path";
import { Agent, MemorySessionStore } from "@arcturn/core";
import type { AgentEvent, ModelCatalogEntry, ModelSpec, Tool } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { SessionHost, SessionHostError } from "./session-host.js";
import {
  createGatedLLM,
  createScriptedLLM,
  TEST_MODEL,
  textTurn,
  toolCallTurn,
} from "./test-helpers/fake-llm.js";
import { createGuardedTool } from "./test-helpers/tools.js";

interface HostFixture {
  host: SessionHost;
}

function buildHost(
  llm: ReturnType<typeof createScriptedLLM> | ReturnType<typeof createGatedLLM>,
  tools: Tool[] = [],
  defaultCwd = "/tmp/arcturn-test",
): HostFixture {
  const host = new SessionHost({
    agentFactory: (opts) =>
      new Agent({
        llm,
        model: TEST_MODEL,
        systemPrompt: "You are a test agent.",
        tools,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      }),
    defaultCwd,
    permissionTimeoutMs: 200,
  });
  return { host };
}

describe("SessionHost", () => {
  it("creates a session with a generated id and the default cwd", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const header = await host.createSession({});
    expect(header.sessionId).toBeTruthy();
    // `resolve`, not the literal: on Windows a leading-slash path is
    // drive-*relative*, and the header reports the resolved absolute form.
    expect(header.cwd).toBe(resolve("/tmp/arcturn-test"));
    expect(header.version).toBe(1);
  });

  it("honours an explicit cwd inside the served workspace", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const header = await host.createSession({ cwd: "sub/dir" });
    // `resolve`, not `join`: the host resolves the request against the served
    // root, and on Windows resolving is what supplies the drive letter that
    // joining two drive-less paths never would.
    expect(header.cwd).toBe(resolve("/tmp/arcturn-test", "sub/dir"));
  });

  it("reports one canonical, absolute cwd whether or not the client named one", async () => {
    // The confinement wall is a string comparison against the *resolved*
    // root, so a default cwd kept in whatever spelling the caller happened to
    // use hands out working directories the wall no longer matches — and
    // every tool in the session resolves its paths against that value. A
    // relative `defaultCwd` shows it on any platform; on Windows a
    // leading-slash path like `/tmp/ws` is drive-relative and does the same.
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]), [], ".");
    const implicit = await host.createSession({});
    const explicit = await host.createSession({ cwd: "." });
    expect(isAbsolute(implicit.cwd)).toBe(true);
    expect(implicit.cwd).toBe(explicit.cwd);
  });

  it("refuses a cwd outside the served workspace", async () => {
    // A remote client picks this value and every tool resolves paths against
    // it, so an unconfined cwd would hand a token holder the whole disk.
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    await expect(host.createSession({ cwd: "/elsewhere" })).rejects.toThrow(/outside/);
    await expect(host.createSession({ cwd: "../.." })).rejects.toThrow(/outside/);
  });

  it("lists sessions created during the process lifetime when no store is configured", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const a = await host.createSession({});
    const b = await host.createSession({});
    const listed = await host.listSessions();
    expect(listed.map((h) => h.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
  });

  it("openSession returns the live header for an already-created session", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const created = await host.createSession({});
    const opened = await host.openSession(created.sessionId);
    expect(opened).toEqual(created);
  });

  it("openSession rejects an unknown session with sessionNotFound", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    await expect(host.openSession("no-such-session")).rejects.toMatchObject({
      code: "sessionNotFound",
    });
  });

  it("refuses to create a session past maxSessions", async () => {
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-test",
      maxSessions: 2,
    });
    await host.createSession({});
    await host.createSession({});
    await expect(host.createSession({})).rejects.toMatchObject({
      code: "invalidRequest",
      message: expect.stringMatching(/limit/i),
    });
  });

  it("maxSessions does not block re-attaching to an already-live session", async () => {
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-test",
      maxSessions: 1,
    });
    const header = await host.createSession({});
    await expect(host.openSession(header.sessionId)).resolves.toEqual(header);
  });

  it("openSession refuses to mint a new session past maxSessions", async () => {
    const store = new MemorySessionStore();
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
      maxSessions: 1,
    });
    await host.createSession({});
    const other = await store.create({ sessionId: "other-session", cwd: "/tmp/arcturn-test" });
    await expect(host.openSession(other.sessionId)).rejects.toMatchObject({
      code: "invalidRequest",
      message: expect.stringMatching(/limit/i),
    });
  });

  it("resumes a session backed by a shared session store", async () => {
    const store = new MemorySessionStore();
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
    });
    const created = await host.createSession({});
    // Simulate the process losing the live agent (e.g. a restart) — the
    // in-memory `#sessions` map inside SessionHost still has it, so build a
    // second host sharing the same store to exercise the resume path.
    const host2 = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
    });
    const reopened = await host2.openSession(created.sessionId);
    expect(reopened.sessionId).toBe(created.sessionId);
    expect(reopened.cwd).toBe(created.cwd);
  });

  it("drives a prompt end to end and fans out events to observers", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hello there")]));
    const header = await host.createSession({});
    const events: AgentEvent[] = [];
    const unsubscribe = host.observe(header.sessionId, (event) => events.push(event));

    await host.prompt(header.sessionId, "hi");

    unsubscribe();
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("runStart");
    expect(types).toContain("messageStream");
    expect(types[types.length - 1]).toBe("runEnd");
    const runEnd = events.find((e) => e.type === "runEnd");
    expect(runEnd).toMatchObject({ type: "runEnd", reason: "completed" });
  });

  it("rejects a concurrent prompt with sessionBusy while a run is active", async () => {
    const llm = createGatedLLM(textTurn("done"));
    const { host } = buildHost(llm);
    const header = await host.createSession({});

    const first = host.prompt(header.sessionId, "hi");
    await expect(host.prompt(header.sessionId, "hi again")).rejects.toMatchObject({
      code: "sessionBusy",
    });

    llm.release();
    await first;
  });

  it("prompt/steer/abort/setModel reject sessionNotFound for an unknown session", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    await expect(host.prompt("nope", "hi")).rejects.toBeInstanceOf(SessionHostError);
    // `steer` rejects rather than throwing synchronously: it now expands
    // mentions and `/name` through the same resolver `prompt` uses.
    await expect(host.steer("nope", "hi")).rejects.toBeInstanceOf(SessionHostError);
    expect(() => host.abort("nope")).toThrow(SessionHostError);
    expect(() => host.setModel("nope", "some/model")).toThrow(SessionHostError);
    expect(() => host.observe("nope", () => undefined)).toThrow(SessionHostError);
  });

  describe("setModel", () => {
    /**
     * A host plus a handle on the `Agent` it built, so a test can read the
     * model actually in force rather than trust the call's return value.
     * `SessionHost` exposes no accessor for the live agent; the factory is
     * where one is available, and it is the same object the host holds.
     */
    function hostWithAgent(options: { resolveModel?: (id: string) => ModelSpec } = {}): {
      host: SessionHost;
      agentFor: (sessionId: string) => Agent;
    } {
      const agents = new Map<string, Agent>();
      const llm = createScriptedLLM([textTurn("hi")]);
      const host = new SessionHost({
        agentFactory: (opts) => {
          const agent = new Agent({
            llm,
            model: TEST_MODEL,
            systemPrompt: "You are a test agent.",
            tools: [],
            cwd: opts.cwd,
            sessionId: opts.sessionId,
          });
          agents.set(opts.sessionId, agent);
          return agent;
        },
        defaultCwd: "/tmp/arcturn-test",
        ...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
      });
      return {
        host,
        agentFor: (sessionId) => {
          const agent = agents.get(sessionId);
          if (!agent) throw new Error(`No agent recorded for ${sessionId}`);
          return agent;
        },
      };
    }

    const ELSEWHERE: ModelSpec = {
      ...TEST_MODEL,
      id: "elsewhere/model",
      provider: "openai-compatible",
      baseUrl: "https://elsewhere.example/v1",
    };

    it("refuses outright when no resolveModel was wired, rather than guessing a provider", async () => {
      const { host, agentFor } = hostWithAgent();
      const header = await host.createSession({});
      const agent = agentFor(header.sessionId);

      // A guessed spec is worse than an error: it sends this session's next
      // prompt, and the credential that goes with it, to whichever provider
      // the guess named. The refusal has to be total.
      expect(() => host.setModel(header.sessionId, "zai-api/glm-5.3")).toThrow(
        /without SessionHostOptions\.resolveModel/,
      );
      expect(agent.model).toBe(TEST_MODEL);
    });

    it("uses the wired resolver's spec verbatim", async () => {
      const { host, agentFor } = hostWithAgent({
        resolveModel: (id) => {
          if (id !== ELSEWHERE.id) throw new Error(`Unknown model "${id}"`);
          return ELSEWHERE;
        },
      });
      const header = await host.createSession({});

      host.setModel(header.sessionId, ELSEWHERE.id);
      expect(agentFor(header.sessionId).model).toEqual(ELSEWHERE);
    });

    it("reports a resolver rejection as invalidRequest and leaves the model alone", async () => {
      const { host, agentFor } = hostWithAgent({
        resolveModel: (id) => {
          throw new Error(`No API key found for ${id}`);
        },
      });
      const header = await host.createSession({});
      const agent = agentFor(header.sessionId);

      expect(() => host.setModel(header.sessionId, "zai-api/glm-5.3")).toThrow(
        expect.objectContaining({ code: "invalidRequest" }),
      );
      expect(() => host.setModel(header.sessionId, "zai-api/glm-5.3")).toThrow(/No API key found/);
      expect(agent.model).toBe(TEST_MODEL);
    });
  });

  it("routes a permission ask to observers and resolves on handlePermissionDecision", async () => {
    const llm = createScriptedLLM([
      toolCallTurn("call-1", "guarded", { note: "please" }),
      textTurn("all done"),
    ]);
    const { host } = buildHost(llm, [createGuardedTool("guarded")]);
    const header = await host.createSession({});

    const events: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => {
      events.push(event);
      if (event.type === "permissionRequest") {
        // Real clients answer over the network, i.e. never in the same tick
        // as the request; defer so the host has finished wiring up the
        // pending-decision slot for this request id before we resolve it.
        setTimeout(() => {
          host.handlePermissionDecision(header.sessionId, {
            requestId: event.request.id,
            behavior: "allow",
          });
        }, 0);
      }
    });

    await host.prompt(header.sessionId, "please run the guarded tool");

    const toolEnd = events.find((e) => e.type === "toolEnd");
    expect(toolEnd).toBeDefined();
    expect(toolEnd).toMatchObject({ type: "toolEnd", result: { isError: false } });
    const runEnd = events.find((e) => e.type === "runEnd");
    expect(runEnd).toMatchObject({ reason: "completed" });
  });

  it("auto-denies a permission ask after the configured timeout", async () => {
    const llm = createScriptedLLM([toolCallTurn("call-1", "guarded", {}), textTurn("done anyway")]);
    const { host } = buildHost(llm, [createGuardedTool("guarded")]);
    const header = await host.createSession({});

    const events: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => events.push(event));

    await host.prompt(header.sessionId, "run it");

    const toolEnd = events.find((e) => e.type === "toolEnd");
    expect(toolEnd).toMatchObject({ type: "toolEnd", result: { isError: true } });
  }, 10_000);

  it("dispose aborts running agents and denies pending permission asks", async () => {
    const llm = createScriptedLLM([toolCallTurn("call-1", "guarded", {}), textTurn("done")]);
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm,
          model: TEST_MODEL,
          systemPrompt: "test",
          tools: [createGuardedTool("guarded")],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-test",
      // Long enough that the timeout can't race the explicit dispose() below.
      permissionTimeoutMs: 60_000,
    });
    const header = await host.createSession({});

    const events: AgentEvent[] = [];
    let promptSettled = false;
    host.observe(header.sessionId, (event) => events.push(event));
    const promptPromise = host.prompt(header.sessionId, "run it").finally(() => {
      promptSettled = true;
    });

    // Give the permission ask a tick to be raised before disposing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(promptSettled).toBe(false);

    host.dispose();
    await promptPromise;

    const runEnd = events.find((e) => e.type === "runEnd");
    expect(runEnd).toBeDefined();
  });
});

describe("SessionHost.listModels", () => {
  const CATALOG: ModelCatalogEntry[] = [
    {
      id: "anthropic/claude-sonnet-5",
      provider: "anthropic",
      displayName: "Claude Sonnet 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      cost: { input: 2, output: 10 },
      apiKeyEnv: "ANTHROPIC_API_KEY",
      credentials: "present",
    },
    {
      id: "local/whatever",
      provider: "openai-compatible",
      displayName: "Whatever",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      credentials: "unknown",
    },
  ];

  it("reports the catalog it was given, pricing gaps and all", async () => {
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "You are a test agent.",
          tools: [],
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      defaultCwd: "/tmp/arcturn-test",
      modelCatalog: () => CATALOG,
    });
    const models = await host.listModels();
    expect(models).toEqual(CATALOG);
    expect(models[1]?.cost).toBeUndefined();
  });

  it("reports an empty catalog when no source was wired, rather than inventing one", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    expect(await host.listModels()).toEqual([]);
  });
});

describe("SessionHost.sessionHistory", () => {
  function storedHost(store: MemorySessionStore): SessionHost {
    return new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("the answer")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
    });
  }

  it("replays a session that is not live in this process at all", async () => {
    const store = new MemorySessionStore();
    const first = storedHost(store);
    const header = await first.createSession({});
    await first.prompt(header.sessionId, "the question");

    // A second host over the same store, as a restarted server would be. It
    // has never opened this session, and does not need to.
    const second = storedHost(store);
    const history = await second.sessionHistory(header.sessionId);

    expect(history.sessionId).toBe(header.sessionId);
    expect(JSON.stringify(history)).toContain("the question");
    expect(JSON.stringify(history)).toContain("the answer");
    expect(history.truncated).toBe(false);
  });

  it("refuses an id no store and no live session knows", async () => {
    const host = storedHost(new MemorySessionStore());
    await expect(host.sessionHistory("nope")).rejects.toMatchObject({ code: "sessionNotFound" });
  });

  it("does not report an unreadable session as one that does not exist", async () => {
    const store = new MemorySessionStore();
    const host = storedHost(store);
    const header = await host.createSession({});
    // A torn file, a permissions problem: a real fault, and telling the user
    // the session does not exist would send them looking for one they can see
    // listed.
    store.entries = async () => {
      throw new Error("EACCES: permission denied");
    };

    await expect(host.sessionHistory(header.sessionId)).rejects.toThrow(/EACCES/);
  });

  it("answers an empty history for a live session on a host with no store", async () => {
    const { host } = buildHost(createScriptedLLM([textTurn("hi")]));
    const header = await host.createSession({});
    // Nothing was persisted, so there is nothing to replay — which is not the
    // same answer as "no such session", and must not be given for one.
    await expect(host.sessionHistory(header.sessionId)).resolves.toEqual({
      sessionId: header.sessionId,
      events: [],
      truncated: false,
      droppedEvents: 0,
    });
    await expect(host.sessionHistory("nope")).rejects.toMatchObject({ code: "sessionNotFound" });
  });

  it("applies the injected caps and reports them", async () => {
    const store = new MemorySessionStore();
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("a")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
      sessionHistoryLimits: { maxEvents: 3 },
    });
    const header = await host.createSession({});
    await host.prompt(header.sessionId, "one");
    await host.prompt(header.sessionId, "two");

    const history = await host.sessionHistory(header.sessionId);
    expect(history.truncated).toBe(true);
    expect(history.droppedEvents).toBe(3);
    expect(history.events).toHaveLength(3);
  });
});

describe("SessionHost.deleteSession", () => {
  function storedHost(store: MemorySessionStore, llm = createScriptedLLM([textTurn("hi")])) {
    return new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm,
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        }),
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
    });
  }

  it("removes it from the store and evicts it from this process", async () => {
    const store = new MemorySessionStore();
    const host = storedHost(store);
    const header = await host.createSession({});

    await host.deleteSession(header.sessionId);

    expect(await store.list()).toEqual([]);
    await expect(host.openSession(header.sessionId)).rejects.toMatchObject({
      code: "sessionNotFound",
    });
    // Evicted, so it no longer counts against `maxSessions` either.
    expect(() => host.abort(header.sessionId)).toThrow(SessionHostError);
  });

  it("tells every observer before it drops them", async () => {
    const store = new MemorySessionStore();
    const host = storedHost(store);
    const header = await host.createSession({});
    const seen: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => seen.push(event));

    await host.deleteSession(header.sessionId);

    expect(seen.at(-1)).toMatchObject({
      type: "notice",
      level: "warn",
      text: expect.stringContaining(header.sessionId),
    });
  });

  it("refuses while a run is in flight, and leaves the session intact", async () => {
    const store = new MemorySessionStore();
    const llm = createGatedLLM(textTurn("eventually"));
    const host = storedHost(store, llm as unknown as ReturnType<typeof createScriptedLLM>);
    const header = await host.createSession({});
    const running = host.prompt(header.sessionId, "go");

    await expect(host.deleteSession(header.sessionId)).rejects.toMatchObject({
      code: "sessionBusy",
    });
    expect((await store.list()).map((h) => h.sessionId)).toEqual([header.sessionId]);

    llm.release();
    await running;
    await host.deleteSession(header.sessionId);
    expect(await store.list()).toEqual([]);
  });

  it("refuses loudly when the configured store cannot delete, rather than unlinking anything itself", async () => {
    const store = new MemorySessionStore();
    // A third-party `SessionStore` predating the optional `delete`.
    const older = {
      create: store.create.bind(store),
      open: store.open.bind(store),
      append: store.append.bind(store),
      entries: store.entries.bind(store),
      branch: store.branch.bind(store),
      list: store.list.bind(store),
      setTitle: store.setTitle.bind(store),
    };
    const host = new SessionHost({
      agentFactory: (opts) =>
        new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        }),
      sessionStore: older,
      defaultCwd: "/tmp/arcturn-test",
    });
    const header = await host.createSession({});

    await expect(host.deleteSession(header.sessionId)).rejects.toThrow(/SessionStore/);
    // And it really is still there: refusing is loud, not silently destructive.
    expect((await store.list()).map((h) => h.sessionId)).toEqual([header.sessionId]);
  });

  it("refuses an id nothing knows", async () => {
    const host = storedHost(new MemorySessionStore());
    await expect(host.deleteSession("nope")).rejects.toMatchObject({ code: "sessionNotFound" });
  });

  it("surfaces a store failure as itself, and leaves the session live", async () => {
    const store = new MemorySessionStore();
    const host = storedHost(store);
    const header = await host.createSession({});
    store.delete = async () => {
      throw new Error("EROFS: read-only file system");
    };

    await expect(host.deleteSession(header.sessionId)).rejects.toThrow(/EROFS/);
    // Not half-deleted: nothing was told the session is gone, and it still is
    // not — the store goes first precisely so this stays true.
    expect((await store.list()).map((h) => h.sessionId)).toEqual([header.sessionId]);
    expect(() => host.abort(header.sessionId)).not.toThrow();
  });

  it("finishes the job when the store says a still-live session is already gone", async () => {
    const store = new MemorySessionStore();
    const host = storedHost(store);
    const header = await host.createSession({});
    // Someone removed the file behind the server's back. The caller asked for
    // this session not to exist, and it does not — evict and succeed.
    await store.delete(header.sessionId);

    await expect(host.deleteSession(header.sessionId)).resolves.toBeUndefined();
    expect(() => host.abort(header.sessionId)).toThrow(SessionHostError);
  });
});

describe("openSession: build once, resume once, rebuild never", () => {
  /**
   * A host whose factory records every call and can be made slow, so "how many
   * agents were built for this session" is a direct read rather than an
   * inference from behaviour.
   */
  function recordingHost(store: MemorySessionStore, delayMs = 0) {
    const calls: Array<{ sessionId: string; resume: boolean | undefined }> = [];
    const host = new SessionHost({
      agentFactory: async (opts) => {
        calls.push({ sessionId: opts.sessionId, resume: opts.resume });
        if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
        return new Agent({
          llm: createScriptedLLM([textTurn("hi"), textTurn("hi again")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        });
      },
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
    });
    return { host, calls };
  }

  it("asks for a resume when re-attaching, and never when creating", async () => {
    const store = new MemorySessionStore();
    const first = recordingHost(store);
    const created = await first.host.createSession({});
    // A brand-new session cannot be resumed: its store record does not exist
    // yet when the factory runs.
    expect(first.calls).toEqual([{ sessionId: created.sessionId, resume: undefined }]);

    // A second process over the same store: the only thing that can rebuild
    // the conversation is the factory, so the host has to say that it must.
    const second = recordingHost(store);
    await second.host.openSession(created.sessionId);
    expect(second.calls).toEqual([{ sessionId: created.sessionId, resume: true }]);
  });

  it("returns the live session untouched rather than rebuilding it", async () => {
    const store = new MemorySessionStore();
    const { host, calls } = recordingHost(store);
    const created = await host.createSession({});

    // Subscribed to the agent this host is holding *now*. A rebuild would
    // register a new live session with a new observer set, and this listener
    // would go on watching an orphan.
    const events: AgentEvent[] = [];
    host.observe(created.sessionId, (event) => events.push(event));

    const reopened = await host.openSession(created.sessionId);
    expect(reopened).toEqual(created);
    expect(calls).toHaveLength(1);

    await host.prompt(created.sessionId, "still there?");
    expect(events.map((event) => event.type)).toContain("runEnd");
  });

  it("hands two simultaneous attaches the same agent, not one each", async () => {
    const store = new MemorySessionStore();
    const created = await recordingHost(store).host.createSession({});

    // Resuming reads and materializes a whole stored branch, so "already live"
    // has to include "being built right now" — otherwise two clients opening
    // the same session in the same tick each get an agent, both appending to
    // one session file, and only one of them is reachable.
    const { host, calls } = recordingHost(store, 20);
    const [a, b] = await Promise.all([
      host.openSession(created.sessionId),
      host.openSession(created.sessionId),
    ]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("builds nothing at all for an id the store has never seen", async () => {
    const store = new MemorySessionStore();
    const { host, calls } = recordingHost(store);
    await expect(host.openSession("sess_never_created")).rejects.toMatchObject({
      code: "sessionNotFound",
    });
    // Not merely an error in the response: minting an empty session under an
    // id nobody created would hand a client a live, writable session whose
    // name it invented.
    expect(calls).toEqual([]);
    await expect(host.listSessions()).resolves.toEqual([]);
  });

  it("forgets a failed open, so the next attempt is tried rather than replayed", async () => {
    const store = new MemorySessionStore();
    const created = await recordingHost(store).host.createSession({});
    let fail = true;
    const host = new SessionHost({
      agentFactory: (opts) => {
        if (fail) throw new Error("resume blew up");
        return new Agent({
          llm: createScriptedLLM([textTurn("hi")]),
          model: TEST_MODEL,
          systemPrompt: "test",
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          sessionStore: store,
        });
      },
      sessionStore: store,
      defaultCwd: "/tmp/arcturn-test",
    });

    await expect(host.openSession(created.sessionId)).rejects.toThrow(/resume blew up/);
    fail = false;
    await expect(host.openSession(created.sessionId)).resolves.toMatchObject({
      sessionId: created.sessionId,
    });
  });
});
