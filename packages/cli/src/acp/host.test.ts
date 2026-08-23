/**
 * `createAcpHost` against a real {@link ArcturnRuntime} (scripted LLM, real
 * `Agent`s, real tool execution) — no JSON-RPC wire, no editor.
 *
 * `acp.test.ts` proves the adapter's wire semantics against stub deps;
 * `e2e.test.ts` proves the full stack over an ACP connection. This file
 * proves the one thing neither of those touches: that `createAcpHost`
 * actually isolates concurrent ACP sessions instead of sharing
 * `ArcturnRuntime`'s single "live" agent — the bug this host exists to fix (see
 * the module doc on `host.ts` and `ACP-STATUS.md`).
 */

import { calculateCostUsd } from "@arcturn/ai";
import type { AgentEvent, PermissionDecision, PermissionRequest } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import type { ArcturnRuntime } from "../runtime.js";
import type { fakeLLM } from "../test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "../test-helpers/scratch.js";
import { createAcpHost } from "./host.js";

/** Resolves once `predicate()` is true, polling on a short interval. Fails the test on timeout. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let runtime: ArcturnRuntime | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

describe("createAcpHost", () => {
  it("gives each session/new call its own isolated Agent, unlike startNewSession", async () => {
    const scratch: Scratch = await makeScratch();
    // Three turns: session A's first reply, session B's only reply, session
    // A's second reply. If sessions shared one swapped agent, prompting B
    // between A's two turns would either answer on the wrong agent or lose
    // A's first turn from its own history.
    runtime = await buildTestRuntime(scratch, [
      { text: "hello from A1" },
      { text: "hello from B1" },
      { text: "hello from A2" },
    ]);
    const host = createAcpHost(runtime);

    host.createSession?.({ cwd: scratch.cwd }, "session-a");
    host.createSession?.({ cwd: scratch.cwd }, "session-b");

    const aEvents1: AgentEvent[] = [];
    await host.prompt({ sessionId: "session-a", cwd: scratch.cwd, text: "hi A", blocks: [] }, (e) =>
      aEvents1.push(e),
    );

    const bEvents: AgentEvent[] = [];
    await host.prompt({ sessionId: "session-b", cwd: scratch.cwd, text: "hi B", blocks: [] }, (e) =>
      bEvents.push(e),
    );

    const aEvents2: AgentEvent[] = [];
    await host.prompt(
      { sessionId: "session-a", cwd: scratch.cwd, text: "continue A", blocks: [] },
      (e) => aEvents2.push(e),
    );

    const textOf = (events: AgentEvent[]): string =>
      events
        .filter((e): e is Extract<AgentEvent, { type: "messageEnd" }> => e.type === "messageEnd")
        .flatMap((e) => e.message.content)
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");

    expect(textOf(aEvents1)).toBe("hello from A1");
    expect(textOf(bEvents)).toBe("hello from B1");
    expect(textOf(aEvents2)).toBe("hello from A2");

    // The decisive check: session A's second turn must have been answered by
    // the SAME agent that ran its first turn, so the model request for it
    // carries A's own prior turn in history and never B's.
    const llm = runtime.llm as ReturnType<typeof fakeLLM>;
    const thirdRequest = llm.requests[2];
    expect(thirdRequest).toBeDefined();
    const serialized = JSON.stringify(thirdRequest?.messages);
    expect(serialized).toContain("hi A");
    expect(serialized).toContain("hello from A1");
    expect(serialized).not.toContain("hi B");
    expect(serialized).not.toContain("hello from B1");
  });

  it("routes abort(sessionId) to that session's own agent only", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [{ text: "unused" }]);
    const host = createAcpHost(runtime);
    host.createSession?.({ cwd: scratch.cwd }, "only-session");
    // No in-flight prompt: Agent.abort() must be a safe no-op when idle.
    expect(() => host.abort("only-session")).not.toThrow();
    expect(() => host.abort("never-created")).not.toThrow();
  });

  it("sizes usage_update from the session's own model, and prices what the provider did not", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [{ text: "done" }]);
    const host = createAcpHost(runtime);
    await host.createSession?.({ cwd: scratch.cwd }, "sized");

    const priced = host.sessionUsage?.("sized", {
      inputTokens: 1_000,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.5,
    });
    // The context window is the model's, never a guess made by the adapter.
    expect(priced?.contextWindow).toBe(runtime.model.contextWindow);
    // A provider-reported cost is taken as given.
    expect(priced?.costUsd).toBe(0.5);

    // Without one, the model's own catalog pricing is used — the same order
    // the per-session `--max-cost` guard uses, so the two cannot disagree.
    const unpriced = host.sessionUsage?.("sized", {
      inputTokens: 1_000,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(unpriced?.costUsd).toBe(
      calculateCostUsd(runtime.model, {
        inputTokens: 1_000,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );

    // An untracked session gets silence, not a throw: a cosmetic notification
    // must never be able to fail a prompt.
    expect(
      host.sessionUsage?.("ghost", {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeUndefined();
  });

  it("throws a clear error when prompt() targets a sessionId with no createSession call", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [{ text: "unused" }]);
    const host = createAcpHost(runtime);
    await expect(
      host.prompt({ sessionId: "ghost", cwd: scratch.cwd, text: "x", blocks: [] }, () => {}),
    ).rejects.toThrow(/ghost/);
  });

  it("binds each session's permission requester once, at session creation — not per turn", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [{ text: "no tools needed" }, { text: "again" }]);
    const host = createAcpHost(runtime);

    const seenSessionIds: string[] = [];
    host.bindPermissions((sessionId) => {
      seenSessionIds.push(sessionId);
      return async (request) => ({ requestId: request.id, behavior: "deny" });
    });

    host.createSession?.({ cwd: scratch.cwd }, "s1");
    // The factory is called once, right here — not lazily deferred to the
    // first prompt, and never again for a second turn on the same session.
    expect(seenSessionIds).toEqual(["s1"]);

    await host.prompt({ sessionId: "s1", cwd: scratch.cwd, text: "hi", blocks: [] }, () => {});
    await host.prompt({ sessionId: "s1", cwd: scratch.cwd, text: "again", blocks: [] }, () => {});
    expect(seenSessionIds).toEqual(["s1"]);
  });

  it("retroactively binds a session created before bindPermissions was called", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [{ text: "no tools needed" }]);
    const host = createAcpHost(runtime);
    host.createSession?.({ cwd: scratch.cwd }, "s1");

    const seenSessionIds: string[] = [];
    host.bindPermissions((sessionId) => {
      seenSessionIds.push(sessionId);
      return async (request) => ({ requestId: request.id, behavior: "deny" });
    });

    // "s1" existed before bindPermissions ran; the retroactive pass in
    // bindPermissions itself is what registers it — no prompt required.
    expect(seenSessionIds).toEqual(["s1"]);
  });

  it("keeps two sessions' overlapping turns from cross-wiring each other's permission decisions", async () => {
    const scratch = await makeScratch();
    // Both scripted turns need a permission check; which session's turn
    // actually consumes which array slot is NOT guaranteed (both sessions
    // share one runtime.llm, and two independently-kicked-off async chains
    // race to reach it) — so the test never assumes an index/session mapping
    // and instead discovers it from each session's own real AgentEvent
    // stream (`aEvents`/`bEvents` below), which IS unambiguously scoped to
    // that session's own Agent.
    runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "call_1", name: "bash", arguments: { command: "echo one" } }] },
      { toolCalls: [{ id: "call_2", name: "bash", arguments: { command: "echo two" } }] },
      { text: "done" },
      { text: "done" },
    ]);
    const host = createAcpHost(runtime);

    // Stands in for the ACP adapter's `acp.permissionPrompt(sessionId)`
    // factory: records which ACP sessionId each permission request was
    // tagged with, and lets the test hold each decision open until both
    // turns' requests have actually arrived — the genuine overlap a client
    // is free to create (two open threads, two in-flight session/prompt
    // calls, neither awaited before the other starts).
    //
    // Bound BEFORE either session is created, exactly like `main.ts`'s real
    // `runAcpCommand` (`host.bindPermissions(...)` always precedes any
    // `session/new`) — this is what exercises the primary
    // `buildSessionAgent({ onPermissionAsk })` binding path rather than the
    // best-effort retroactive fallback `bindPermissions` also offers for a
    // session created earlier (see its JSDoc). Getting this ordering wrong
    // was caught by this test's own author while verifying it: with
    // `createSession` called first, the retroactive fallback alone made this
    // test pass even with the shared-slot bug deliberately reintroduced —
    // see ACP-STATUS.md / this pass's report for the full account.
    const seenRequests: { sessionId: string; subject: string }[] = [];
    const decisionResolvers = new Map<string, (decision: PermissionDecision) => void>();
    host.bindPermissions((sessionId) => {
      return (request: PermissionRequest) => {
        seenRequests.push({ sessionId, subject: request.subject });
        return new Promise<PermissionDecision>((resolve) => {
          decisionResolvers.set(request.subject, (decision) =>
            resolve({ ...decision, requestId: request.id }),
          );
        });
      };
    });
    host.createSession?.({ cwd: scratch.cwd }, "session-a");
    host.createSession?.({ cwd: scratch.cwd }, "session-b");

    const aEvents: AgentEvent[] = [];
    const bEvents: AgentEvent[] = [];
    const aDone = host.prompt(
      { sessionId: "session-a", cwd: scratch.cwd, text: "run A", blocks: [] },
      (e) => aEvents.push(e),
    );
    const bDone = host.prompt(
      { sessionId: "session-b", cwd: scratch.cwd, text: "run B", blocks: [] },
      (e) => bEvents.push(e),
    );

    // Both turns must reach their own permission check before either is
    // answered — this is the actual overlap window the old shared-slot
    // rebind-per-turn design could not survive.
    await waitUntil(() => seenRequests.length === 2);

    // Ground truth for "which command did session X's OWN agent actually try
    // to run": read it off that session's own event stream, scoped via
    // `requireSession(request.sessionId)` inside `host.prompt`, never off the
    // (possibly-mistagged) `seenRequests` array under test.
    const commandOf = (events: readonly AgentEvent[]): string => {
      const start = events.find(
        (e): e is Extract<AgentEvent, { type: "toolStart" }> => e.type === "toolStart",
      );
      const command = start?.input.command;
      if (typeof command !== "string") throw new Error("no toolStart with a command seen");
      return command;
    };
    const aCommand = commandOf(aEvents);
    const bCommand = commandOf(bEvents);
    expect(aCommand).not.toBe(bCommand);

    const forA = seenRequests.find((r) => r.subject === aCommand);
    const forB = seenRequests.find((r) => r.subject === bCommand);
    // THE decisive check: each tool call's permission request must be tagged
    // with the ACP session that actually asked for it, never the other one.
    expect(forA?.sessionId).toBe("session-a");
    expect(forB?.sessionId).toBe("session-b");

    decisionResolvers.get(aCommand)?.({ requestId: "", behavior: "allow" });
    decisionResolvers.get(bCommand)?.({ requestId: "", behavior: "deny" });
    await Promise.all([aDone, bDone]);

    // The decisions themselves must have landed on the right agent too: A's
    // bash call actually ran (allowed), B's was refused (denied) — proving
    // this isn't just the request's `sessionId` label being right while the
    // decision itself still executes against the wrong agent.
    const toolEndFor = (events: readonly AgentEvent[]) =>
      events.find((e): e is Extract<AgentEvent, { type: "toolEnd" }> => e.type === "toolEnd");
    expect(toolEndFor(aEvents)?.result.isError).toBe(false);
    expect(toolEndFor(bEvents)?.result.isError).toBe(true);
  });
});
