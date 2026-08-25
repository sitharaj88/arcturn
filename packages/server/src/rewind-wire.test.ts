/**
 * The rewind verbs at the host boundary: the refusals, the caps, and the swap.
 *
 * `@arcturn/cli`'s `serve-rewind.test.ts` is where the *filesystem* claims are
 * proved, because that is where the real checkpoint store lives and the only
 * honest assertion for "the files went back" is reading them. This file proves
 * the things only this layer owns and a real store would hide:
 *
 * - **The mid-run refusal covers the whole window.** `isBusy`, not
 *   `agent.isRunning` — a prompt that has been accepted but is still resolving
 *   its context has not started the agent yet, and a restore landing there
 *   would rewrite files the run is about to read.
 * - **An engine with no checkpoint store says so** rather than answering with
 *   an empty picker, and refuses a rewind rather than resolving it.
 * - **The confirmation is checked before the provider is touched at all.**
 * - **A fork keeps the session's watchers.** The observers stay attached and
 *   are told the conversation moved; a rewind is not a delete.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MemorySessionStore } from "@arcturn/core";
import { createProtocolClient, type ProtocolRequestError } from "@arcturn/protocol";
import type { AgentEvent, LLMClient } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ContextResolver } from "./prompt-context.js";
import {
  buildCheckpointList,
  CHECKPOINT_LIST_MAX_BYTES,
  type CheckpointRewindOutcome,
  type CheckpointTurnPreview,
  checkpointConfirmation,
  type SessionCheckpoints,
  workspaceRelative,
} from "./rewind.js";
import { SessionHost, type SessionHostOptions } from "./session-host.js";
import { createScriptedLLM, TEST_MODEL, textTurn } from "./test-helpers/fake-llm.js";
import { ArcturnServer } from "./ws-server.js";

const servers: ArcturnServer[] = [];
const clients: { close(): void }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
});

const ROOT = join(tmpdir(), "arcturn-rewind-host");

/** A scripted provider: fixed plans, and a record of what was asked of it. */
function fakeCheckpoints(previews: CheckpointTurnPreview[]): SessionCheckpoints & {
  rewinds: string[];
  fork?: Agent;
} {
  const rewinds: string[] = [];
  const provider = {
    rewinds,
    fork: undefined as Agent | undefined,
    list: () => Promise.resolve(previews),
    rewind: (_sessionId: string, turnId: string): Promise<CheckpointRewindOutcome> => {
      rewinds.push(turnId);
      const preview = previews.find((candidate) => candidate.id === turnId);
      return Promise.resolve({
        restored: preview?.restores ?? [],
        deleted: preview?.deletes ?? [],
        failed: [],
        ...(provider.fork === undefined ? {} : { agent: provider.fork }),
      });
    },
  };
  return provider;
}

function preview(
  id: string,
  overrides: Partial<CheckpointTurnPreview> = {},
): CheckpointTurnPreview {
  return {
    id,
    label: `turn ${id}`,
    timestamp: 1_700_000_000_000,
    restores: [join(ROOT, "src", "a.ts")],
    deletes: [],
    forksConversation: true,
    ...overrides,
  };
}

interface Fixture {
  host: SessionHost;
  llm: LLMClient;
  agents: Agent[];
  store: MemorySessionStore;
}

function buildHost(extra: Partial<SessionHostOptions> = {}): Fixture {
  const llm = createScriptedLLM([textTurn("ok")]);
  const agents: Agent[] = [];
  const store = new MemorySessionStore();
  const host = new SessionHost({
    agentFactory: (opts) => {
      const agent = new Agent({
        llm,
        model: TEST_MODEL,
        systemPrompt: "You are a test agent.",
        tools: [],
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        sessionStore: store,
      });
      agents.push(agent);
      return agent;
    },
    sessionStore: store,
    defaultCwd: ROOT,
    ...extra,
  });
  return { host, llm, agents, store };
}

/** A resolver that does not answer until released — the `starting` window. */
function slowResolver(): { resolver: ContextResolver; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    resolver: {
      async buildPrompt(request) {
        await gate;
        return { text: request.text, images: [], refusals: [] };
      },
      resolve: (request) =>
        Promise.resolve({
          query: request.query,
          path: request.query,
          relativePath: request.query,
          inWorkspace: true,
          exists: true,
          bytes: 1,
          kind: "file" as const,
        }),
    },
  };
}

describe("an engine that keeps no checkpoints", () => {
  it("says available:false rather than showing an empty picker", async () => {
    // Kept apart from an empty list on purpose: "nothing has been checkpointed
    // yet" and "nothing will ever be checkpointed here" are opposite pieces of
    // news, and a panel must not show the reassuring one for the other.
    const { host } = buildHost();
    const header = await host.createSession({});
    const list = await host.listCheckpoints(header.sessionId);
    expect(list.available).toBe(false);
    expect(list.checkpoints).toEqual([]);
  });

  it("refuses a rewind rather than resolving it", async () => {
    const { host } = buildHost();
    const header = await host.createSession({});
    await expect(host.rewindTo(header.sessionId, "turn-1", "anything")).rejects.toMatchObject({
      code: "invalidRequest",
    });
  });
});

describe("the mid-run refusal", () => {
  it("refuses while a prompt is still resolving its context, before the agent starts", async () => {
    // The wider `isBusy` check `deleteSession` and `compact` make, not
    // `setPermissionMode`'s narrower one. In this window `agent.isRunning` is
    // still false and a restore would rewrite files the run is about to read.
    const { resolver, release } = slowResolver();
    const checkpoints = fakeCheckpoints([preview("turn-1")]);
    const { host } = buildHost({ checkpoints, contextResolver: resolver });
    const header = await host.createSession({});
    const list = await host.listCheckpoints(header.sessionId);
    const row = list.checkpoints[0];
    if (row === undefined) throw new Error("expected a checkpoint");

    const running = host.prompt(header.sessionId, "one");
    await expect(host.rewindTo(header.sessionId, row.id, row.confirmation)).rejects.toMatchObject({
      code: "sessionBusy",
    });
    // Nothing reached the restorer at all.
    expect(checkpoints.rewinds).toEqual([]);

    release();
    await running;
  });
});

describe("the echoed confirmation", () => {
  it("refuses a stale token before the provider is touched", async () => {
    const checkpoints = fakeCheckpoints([preview("turn-1")]);
    const { host } = buildHost({ checkpoints });
    const header = await host.createSession({});
    await expect(host.rewindTo(header.sessionId, "turn-1", "0".repeat(32))).rejects.toMatchObject({
      code: "invalidRequest",
    });
    expect(checkpoints.rewinds).toEqual([]);
  });

  it("is a digest of the plan, so a plan that grew produces a different one", async () => {
    const before = checkpointConfirmation(preview("turn-1"), ROOT);
    const after = checkpointConfirmation(
      preview("turn-1", { deletes: [join(ROOT, "src", "b.ts")] }),
      ROOT,
    );
    expect(after).not.toBe(before);
    // Stable for the same plan, whatever order the manifest happened to yield.
    expect(
      checkpointConfirmation(
        preview("turn-1", {
          restores: [join(ROOT, "src", "b.ts"), join(ROOT, "src", "a.ts")],
        }),
        ROOT,
      ),
    ).toBe(
      checkpointConfirmation(
        preview("turn-1", {
          restores: [join(ROOT, "src", "a.ts"), join(ROOT, "src", "b.ts")],
        }),
        ROOT,
      ),
    );
  });
});

describe("the fork", () => {
  it("keeps the session's observers and tells them the conversation moved", async () => {
    // A rewind is not a delete: the same connections are still attached to the
    // same session, and dropping their subscriptions would silently stop the
    // transcript they are watching.
    const checkpoints = fakeCheckpoints([preview("turn-1")]);
    const { host, agents, store } = buildHost({ checkpoints });
    const header = await host.createSession({});
    const seen: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => seen.push(event));

    const forked = new Agent({
      llm: createScriptedLLM([textTurn("from the fork")]),
      model: TEST_MODEL,
      systemPrompt: "You are a test agent.",
      tools: [],
      sessionStore: store,
      sessionId: header.sessionId,
    });
    checkpoints.fork = forked;

    const list = await host.listCheckpoints(header.sessionId);
    const row = list.checkpoints[0];
    if (row === undefined) throw new Error("expected a checkpoint");
    const result = await host.rewindTo(header.sessionId, row.id, row.confirmation);

    expect(result.conversationForked).toBe(true);
    expect(seen.some((event) => event.type === "notice")).toBe(true);
    expect(agents[0]).not.toBe(forked);

    // The observer now follows the FORKED agent, not the one it was registered
    // against: a subscription left on the old one would render a session
    // nobody is talking to. Proved by driving the session and watching the
    // fork's own answer arrive on the *existing* subscription.
    seen.length = 0;
    await host.prompt(header.sessionId, "after the fork");
    expect(JSON.stringify(seen)).toContain("from the fork");
  });
});

describe("a rewind whose conversation cannot move", () => {
  it("reports conversationForked:false rather than failing, when the files already moved", async () => {
    // Two ways to get here: the turn predates this process (no link to a
    // transcript entry), or the fork itself failed after the restore. Either
    // way the workspace has changed, and answering with an error for an
    // operation that rewrote somebody's files would be the "silently did
    // nothing" failure pointed backwards.
    const checkpoints = fakeCheckpoints([preview("turn-1", { forksConversation: false })]);
    const { host } = buildHost({ checkpoints });
    const header = await host.createSession({});
    const list = await host.listCheckpoints(header.sessionId);
    const row = list.checkpoints[0];
    if (row === undefined) throw new Error("expected a checkpoint");
    expect(row.forksConversation).toBe(false);

    const result = await host.rewindTo(header.sessionId, row.id, row.confirmation);
    expect(result.restored).toEqual(["src/a.ts"]);
    expect(result.conversationForked).toBe(false);
  });
});

describe("the list's shape and bounds", () => {
  it("reports newest first, with paths spelled the way pendingChanges spells them", () => {
    const list = buildCheckpointList(
      "s1",
      [preview("old"), preview("new", { deletes: [join(ROOT, "src", "z.ts")] })],
      ROOT,
    );
    expect(list.checkpoints.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(list.checkpoints[0]?.files).toEqual(["src/a.ts", "src/z.ts"]);
    expect(list.checkpoints[0]?.deleteCount).toBe(1);
    expect(list.truncated).toBe(false);
  });

  it("drops the oldest rows to fit the cap and says how many", () => {
    const many = Array.from({ length: 10 }, (_unused, index) => preview(`turn-${String(index)}`));
    const list = buildCheckpointList("s1", many, ROOT, { maxEntries: 3 });
    expect(list.checkpoints).toHaveLength(3);
    expect(list.checkpoints.map((entry) => entry.id)).toEqual(["turn-9", "turn-8", "turn-7"]);
    expect(list.truncated).toBe(true);
    expect(list.droppedCheckpoints).toBe(7);
  });

  it("keeps fileCount exact when a row's path list is cut", () => {
    // The count is what a decision turns on; the list is what a modal prints.
    const paths = Array.from({ length: 6 }, (_unused, i) => join(ROOT, `f${String(i)}.ts`));
    const list = buildCheckpointList("s1", [preview("t", { restores: paths })], ROOT, {
      maxFilesPerEntry: 2,
    });
    expect(list.checkpoints[0]?.fileCount).toBe(6);
    expect(list.checkpoints[0]?.files).toHaveLength(2);
    expect(list.checkpoints[0]?.truncatedFiles).toBe(true);
  });

  it("strips control characters out of a label before it reaches a menu", () => {
    const list = buildCheckpointList("s1", [preview("t", { label: "fix\nthe login\tbug" })], ROOT);
    expect(list.checkpoints[0]?.label).toBe("fix the login bug");
  });

  it("budgets the response at the wire's own backpressure threshold", () => {
    expect(CHECKPOINT_LIST_MAX_BYTES).toBe(1024 * 1024);
  });

  it("leaves an out-of-root path absolute, and never puts one in a row's files", () => {
    // A path outside the workspace can only ever be a refusal, and a refusal
    // that named nothing would be unactionable — but it is not something that
    // *would happen*, so it is not offered.
    expect(workspaceRelative(ROOT, "/etc/passwd")).toBe("/etc/passwd");
    expect(workspaceRelative(ROOT, join(ROOT, "src", "a.ts"))).toBe("src/a.ts");
  });
});

describe("over a real socket", () => {
  it("carries both verbs, and rewindTo refuses a stale confirmation on the wire", async () => {
    const checkpoints = fakeCheckpoints([preview("turn-1")]);
    const { host } = buildHost({ checkpoints });
    const server = new ArcturnServer({ sessionHost: host });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });
    const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${String(port)}`));
    clients.push(client);

    const header = await client.createSession({ cwd: ROOT });
    await client.openSession(header.sessionId);

    const list = await client.listCheckpoints(header.sessionId);
    expect(list?.available).toBe(true);
    expect(list?.checkpoints[0]?.id).toBe("turn-1");

    const error = await client
      .rewindTo(header.sessionId, "turn-1", "0".repeat(32))
      .catch((e: unknown) => e);
    expect((error as ProtocolRequestError).code).toBe("invalidRequest");

    const row = list?.checkpoints[0];
    if (row === undefined) throw new Error("expected a checkpoint");
    const result = await client.rewindTo(header.sessionId, row.id, row.confirmation);
    expect(result.restored).toEqual(["src/a.ts"]);
  });
});
