/**
 * Regression tests for permission decision correlation.
 *
 * An earlier build inferred which request a decision answered by arrival order.
 * Any check the engine settled from its own rules — every read-only tool call,
 * every rule-matched allow — never reached the prompt, so the queue drifted by
 * one and from then on real approvals were dropped and every gated tool call
 * hung until it timed out. Decisions are now matched by request id.
 */

import { Agent, MemorySessionStore } from "@arcturn/core";
import type { AgentEvent, PermissionRequest, Tool } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { SessionHost } from "./session-host.js";
import { createScriptedLLM, TEST_MODEL, textTurn, toolCallTurn } from "./test-helpers/fake-llm.js";
import { createGuardedTool } from "./test-helpers/tools.js";

/** A tool the engine auto-allows, so it never reaches the prompt. */
function createReadOnlyTool(): Tool {
  return {
    definition: {
      name: "read",
      description: "Reads a file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    async execute() {
      return { content: [{ type: "text", text: "file contents" }] };
    },
  };
}

function buildHost(llm: ReturnType<typeof createScriptedLLM>, tools: Tool[]): SessionHost {
  return new SessionHost({
    agentFactory: (opts) =>
      new Agent({
        llm,
        model: TEST_MODEL,
        systemPrompt: "You are a test agent.",
        tools,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      }),
    sessionStore: new MemorySessionStore(),
    defaultCwd: "/tmp/arcturn-test",
    // Short, so a correlation failure surfaces as a fast timeout-deny rather
    // than stalling the suite for the production five minutes.
    permissionTimeoutMs: 300,
  });
}

describe("permission decisions are matched by request id", () => {
  it("approves a gated tool that follows an auto-allowed one", async () => {
    const llm = createScriptedLLM([
      toolCallTurn("c1", "read", { path: "a.txt" }),
      toolCallTurn("c2", "guarded", { value: 1 }),
      textTurn("all done"),
    ]);
    const host = buildHost(llm, [createReadOnlyTool(), createGuardedTool()]);
    const header = await host.createSession({});

    const decisions: AgentEvent[] = [];
    const asked: PermissionRequest[] = [];
    host.observe(header.sessionId, (event) => {
      if (event.type === "permissionDecision") decisions.push(event);
      if (event.type === "permissionRequest") {
        asked.push(event.request);
        // Real clients answer over the network, never in the emitting tick.
        setTimeout(() => {
          host.handlePermissionDecision(header.sessionId, {
            requestId: event.request.id,
            behavior: "allow",
          });
        }, 0);
      }
    });

    await host.prompt(header.sessionId, "go");

    // The auto-allowed read must not raise a prompt at all: a client that
    // renders one modal per request would otherwise interrupt on every file
    // read, and a client tracking outstanding requests would drift out of sync.
    expect(asked.map((request) => request.toolName)).toEqual(["guarded"]);

    const allowed = decisions.filter(
      (event) => event.type === "permissionDecision" && event.decision.behavior === "allow",
    );
    expect(allowed).toHaveLength(2);
    for (const event of decisions) {
      if (event.type !== "permissionDecision") continue;
      expect(event.decision.message ?? "").not.toContain("timed out");
    }
    host.dispose();
  });

  it("ignores a decision quoting an unknown request id", async () => {
    const llm = createScriptedLLM([toolCallTurn("c1", "guarded", {}), textTurn("done")]);
    const host = buildHost(llm, [createGuardedTool()]);
    const header = await host.createSession({});

    const decisions: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => {
      if (event.type === "permissionDecision") decisions.push(event);
      if (event.type === "permissionRequest") {
        setTimeout(() => {
          // A stray id must not satisfy the outstanding request...
          host.handlePermissionDecision(header.sessionId, {
            requestId: "not-a-real-request",
            behavior: "allow",
          });
          // ...only the matching one does.
          host.handlePermissionDecision(header.sessionId, {
            requestId: event.request.id,
            behavior: "deny",
            message: "nope",
          });
        }, 0);
      }
    });

    await host.prompt(header.sessionId, "go");

    const settled = decisions.filter((event) => event.type === "permissionDecision");
    expect(settled).toHaveLength(1);
    const [only] = settled;
    if (only?.type !== "permissionDecision") throw new Error("expected a decision");
    expect(only.decision.behavior).toBe("deny");
    expect(only.decision.message).toBe("nope");
    host.dispose();
  });
});
