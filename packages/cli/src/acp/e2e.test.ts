/**
 * End-to-end proof that `arcturn acp` works, not just that its pieces do in
 * isolation.
 *
 * This drives the REAL production stack — `AcpConnection` (protocol.ts),
 * `createAcpAgent` (adapter.ts), `createAcpHost` (host.ts) and a real
 * `ArcturnRuntime` with real tool execution and a real `PermissionEngine` — from
 * a scripted ACP client, over an in-memory duplex pair standing in for the
 * stdio pipe a real editor would open to a spawned `arcturn acp` process. The
 * only stand-in is the LLM: a scripted client from `test-helpers/fake-llm.ts`
 * (used throughout this package's test suite), so the run is deterministic
 * and needs zero network access and no API key.
 *
 * Covers the full lifecycle the task asks for: `initialize` → `session/new`
 * → `session/prompt` (with a real gated tool call routed through
 * `session/request_permission`) → a stream of `session/update`
 * notifications → the `session/prompt` response, and separately
 * `session/cancel` cutting a turn short.
 */

import { PassThrough } from "node:stream";
import type { PermissionMode } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import type { ArcturnRuntime } from "../runtime.js";
import type { FakeLLM } from "../test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch } from "../test-helpers/scratch.js";
import {
  ACP_PROTOCOL_VERSION,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  createAcpAgent,
} from "./adapter.js";
import { createAcpHost } from "./host.js";
import { AcpConnection } from "./protocol.js";

/**
 * Wire an ACP agent (real host, real runtime) to a scripted client over two
 * in-memory pipes — the "pipe pair" stand-in for a spawned `arcturn acp`
 * process's stdin/stdout.
 */
function wireAcp(runtime: ArcturnRuntime): {
  client: AcpConnection;
  updates: AcpSessionUpdate[];
} {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();

  const agentConnection = new AcpConnection({
    input: clientToAgent,
    output: agentToClient,
    onError: (error) => {
      throw error; // A protocol-layer error is always a test bug here.
    },
  });
  const client = new AcpConnection({ input: agentToClient, output: clientToAgent });

  // Exactly `main.ts`'s runAcpCommand wiring: build the host, build the
  // adapter over it, then close the loop by handing the adapter's own
  // permission-prompt factory back to the host.
  const host = createAcpHost(runtime, { agentInfo: { name: "arcturn", version: "test" } });
  const agent = createAcpAgent(host);
  host.bindPermissions((sessionId) => agent.permissionPrompt(sessionId));

  const updates: AcpSessionUpdate[] = [];
  client.onNotification("session/update", (params) => {
    updates.push((params as AcpSessionNotification).update);
  });

  agent.attach(agentConnection);
  agentConnection.listen();
  client.listen();

  return { client, updates };
}

async function initializeAndOpenSession(
  client: AcpConnection,
  cwd: string,
): Promise<{ init: AcpInitializeResult; sessionId: string }> {
  const init = (await client.sendRequest("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "zed", version: "1.0.0" },
  })) as AcpInitializeResult;
  const session = (await client.sendRequest("session/new", {
    cwd,
    mcpServers: [],
  })) as AcpNewSessionResult;
  return { init, sessionId: session.sessionId };
}

let runtime: ArcturnRuntime | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

describe("arcturn acp end to end (real runtime, scripted LLM, zero network)", () => {
  it("initialize -> session/new -> session/prompt with a real gated tool call, approved through session/request_permission", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [
      {
        text: "Sure, running it now.",
        toolCalls: [{ id: "call_1", name: "bash", arguments: { command: "echo hi-from-arcturn" } }],
      },
      { text: "Done! The output is above." },
    ]);
    const { client, updates } = wireAcp(runtime);

    const { init, sessionId } = await initializeAndOpenSession(client, scratch.cwd);
    expect(init.agentInfo).toEqual({ name: "arcturn", version: "test" });
    expect(init.agentCapabilities.promptCapabilities).toEqual({
      image: false,
      audio: false,
      embeddedContext: true,
    });

    const permissionRequests: AcpRequestPermissionParams[] = [];
    client.onRequest("session/request_permission", (params) => {
      permissionRequests.push(params as AcpRequestPermissionParams);
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });

    const result = (await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "please run echo hi-from-arcturn" }],
    })) as AcpPromptResult;

    expect(result).toEqual({ stopReason: "end_turn" });

    // The gated bash call really went through session/request_permission —
    // this is the runtime's own PermissionEngine asking, not a stub.
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      sessionId,
      toolCall: { kind: "execute" },
    });

    const toolCallUpdates = updates.filter(
      (u): u is Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }> =>
        u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update",
    );
    expect(
      toolCallUpdates.some((u) => u.sessionUpdate === "tool_call" && u.kind === "execute"),
    ).toBe(true);
    const completed = toolCallUpdates.find(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
    );
    expect(completed).toBeDefined();
    expect(JSON.stringify(completed)).toContain("hi-from-arcturn");

    const assembledText = updates
      .filter(
        (u): u is Extract<AcpSessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
          u.sessionUpdate === "agent_message_chunk",
      )
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
    expect(assembledText).toContain("Sure, running it now.");
    expect(assembledText).toContain("Done! The output is above.");
  });

  it("streams usage_update notifications sized by the session's real model", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [
      { text: "counting tokens", usage: { inputTokens: 1_200, outputTokens: 34 } },
    ]);
    const { client, updates } = wireAcp(runtime);
    const { sessionId } = await initializeAndOpenSession(client, scratch.cwd);

    await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "how many tokens?" }],
    });

    const usageUpdates = updates.filter(
      (u): u is Extract<AcpSessionUpdate, { sessionUpdate: "usage_update" }> =>
        u.sessionUpdate === "usage_update",
    );
    expect(usageUpdates).toHaveLength(1);
    // Straight from the scripted turn's usage and the runtime's real model —
    // no number here is invented by the adapter.
    expect(usageUpdates[0]).toMatchObject({
      used: 1_234,
      size: runtime.model.contextWindow,
    });
  });

  it("session/cancel stops a turn blocked on an unanswered permission request", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [
      {
        toolCalls: [{ id: "call_1", name: "bash", arguments: { command: "echo should-not-run" } }],
      },
      { text: "should not be reached" },
    ]);
    const { client, updates } = wireAcp(runtime);
    const { sessionId } = await initializeAndOpenSession(client, scratch.cwd);

    let permissionRequestSeen: () => void = () => {};
    const permissionRequested = new Promise<void>((resolve) => {
      permissionRequestSeen = resolve;
    });
    // The editor never answers — exactly what happens if a human closes the
    // dialog without choosing, or the thread is cancelled out from under it.
    client.onRequest("session/request_permission", () => {
      permissionRequestSeen();
      return new Promise(() => {});
    });

    const pending = client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "please run echo should-not-run" }],
    });

    await permissionRequested;
    // Give the pending tool_call update a chance to arrive before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.some((u) => u.sessionUpdate === "tool_call" && u.kind === "execute")).toBe(true);

    client.sendNotification("session/cancel", { sessionId });

    const result = (await pending) as AcpPromptResult;
    expect(result).toEqual({ stopReason: "cancelled" });

    // The decisive check: the real per-session Agent's abort() must have
    // actually stopped the run loop, not just had the ACP layer paper over
    // it — otherwise the agent would ask the model a second time (with the
    // denied tool result appended) and reach the "should not be reached"
    // scripted turn.
    const llm = runtime.llm as FakeLLM;
    expect(llm.requests).toHaveLength(1);
  });

  it("session/load replays history and resumes it as a genuinely live session", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [{ text: "first reply" }, { text: "second reply" }]);
    const { client, updates } = wireAcp(runtime);
    const { init, sessionId } = await initializeAndOpenSession(client, scratch.cwd);
    expect(init.agentCapabilities.loadSession).toBe(true);

    // Give the session some real history to load back.
    const firstResult = (await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "remember the number 42" }],
    })) as AcpPromptResult;
    expect(firstResult).toEqual({ stopReason: "end_turn" });

    updates.length = 0; // only session/load's own replay matters from here

    const loadResult = await client.sendRequest("session/load", { sessionId, cwd: scratch.cwd });
    expect(loadResult).toBeNull();

    // Spec: "The Agent replays conversation history via session/update
    // notifications before responding to session/load."
    const replayedText = updates
      .filter(
        (
          u,
        ): u is Extract<
          AcpSessionUpdate,
          { sessionUpdate: "user_message_chunk" | "agent_message_chunk" }
        > => u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk",
      )
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("\n");
    expect(replayedText).toContain("remember the number 42");
    expect(replayedText).toContain("first reply");

    // The decisive check: the reloaded session is genuinely live, not a
    // cosmetic transcript — its NEXT turn's model request must still carry
    // the earlier turn, proving Agent.resume() really rebuilt live
    // conversation state rather than just replaying history to the editor's
    // UI while the model itself has amnesia (the "half-feature" the prior
    // pass refused to ship — see ACP-STATUS.md).
    const secondResult = (await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "what number did I say?" }],
    })) as AcpPromptResult;
    expect(secondResult).toEqual({ stopReason: "end_turn" });

    const llm = runtime.llm as FakeLLM;
    const lastRequest = llm.requests[llm.requests.length - 1];
    const serialized = JSON.stringify(lastRequest?.messages);
    expect(serialized).toContain("remember the number 42");
    expect(serialized).toContain("first reply");
    expect(serialized).toContain("what number did I say?");
  });

  it("session/load answers -32602 for a sessionId with no stored history", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [{ text: "unused" }]);
    const { client } = wireAcp(runtime);
    await expect(
      client.sendRequest("session/load", { sessionId: "sess_never_existed", cwd: scratch.cwd }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("yolo mode set on the runtime is inherited by new ACP sessions, so a gated tool runs without asking the editor", async () => {
    const scratch = await makeScratch();
    const yolo: PermissionMode = "yolo";
    runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "call_1", name: "bash", arguments: { command: "echo auto-approved" } }] },
      { text: "done" },
    ]);
    runtime.setPermissionMode(yolo);
    const { client, updates } = wireAcp(runtime);
    const { sessionId } = await initializeAndOpenSession(client, scratch.cwd);

    let sawPermissionRequest = false;
    client.onRequest("session/request_permission", () => {
      sawPermissionRequest = true;
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });

    const result = (await client.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "run it" }],
    })) as AcpPromptResult;

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(sawPermissionRequest).toBe(false);
    const completed = updates.find(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
    );
    expect(JSON.stringify(completed)).toContain("auto-approved");
  });

  it("session/set_mode switches a session's own permission mode, so switching to yolo skips the next approval", async () => {
    const scratch = await makeScratch();
    runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "call_1", name: "bash", arguments: { command: "echo auto-approved" } }] },
      { text: "done" },
    ]);
    const { client, updates } = wireAcp(runtime);
    await client.sendRequest("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    const session = (await client.sendRequest("session/new", {
      cwd: scratch.cwd,
    })) as AcpNewSessionResult;
    expect(session.modes?.currentModeId).toBe("default");
    expect(session.modes?.availableModes.map((m) => m.id)).toEqual([
      "plan",
      "default",
      "acceptEdits",
      "yolo",
    ]);

    const setResult = await client.sendRequest("session/set_mode", {
      sessionId: session.sessionId,
      modeId: "yolo",
    });
    expect(setResult).toBeNull();

    let sawPermissionRequest = false;
    client.onRequest("session/request_permission", () => {
      sawPermissionRequest = true;
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });

    const result = (await client.sendRequest("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "run it" }],
    })) as AcpPromptResult;

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(sawPermissionRequest).toBe(false);
    const completed = updates.find(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
    );
    expect(JSON.stringify(completed)).toContain("auto-approved");
  });
});
