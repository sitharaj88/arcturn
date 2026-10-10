/**
 * Append-only history, measured where it matters: the Anthropic request
 * bodies themselves. Core's `Agent` drives the real Anthropic adapter against
 * a client that records every body it is handed, and each pair of
 * consecutive bodies must share `system`, `tools` and every earlier message
 * byte for byte (cache breakpoints aside — moving one is not an edit).
 *
 * This is the first step of the three-step check in the Fable 5.1 migration
 * guide, run in CI instead of against a live endpoint.
 */

import { type AnthropicClientLike, createAnthropicProvider, getModel } from "@arcturn/ai";
import { Agent, createDeferredToolset } from "@arcturn/core";
import type { Tool, ToolResult } from "@arcturn/types";
import { describe, expect, it } from "vitest";

type Block = Record<string, unknown>;

/** The SSE events for one assistant response made of `blocks`. */
function response(blocks: Block[], stopReason: string): unknown[] {
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        id: "msg",
        model: "claude-opus-5-5",
        usage: { input_tokens: 10, output_tokens: 0 },
        input_transformations: [],
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      const { input, ...start } = block;
      events.push({ type: "content_block_start", index, content_block: { ...start, input: {} } });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      });
    } else if (block.type === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature },
      });
    } else if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 5 },
  });
  events.push({ type: "message_stop" });
  return events;
}

const thinking = (id: string): Block => ({
  type: "thinking",
  thinking: `why ${id}`,
  signature: `sig-${id}`,
});
const toolUse = (id: string, name: string): Block => ({ type: "tool_use", id, name, input: {} });

/** A client that records every body and answers from a script, on either surface. */
function recordingClient(script: unknown[][]) {
  const bodies: Record<string, unknown>[] = [];
  const create = async (params: unknown) => {
    bodies.push(JSON.parse(JSON.stringify(params)) as Record<string, unknown>);
    const events =
      script[bodies.length - 1] ?? response([{ type: "text", text: "done" }], "end_turn");
    return (async function* () {
      for (const event of events) yield event;
    })();
  };
  const client = { messages: { create }, beta: { messages: { create } } };
  return { client: client as unknown as AnthropicClientLike, bodies };
}

/** Drop every `cache_control`: a breakpoint moving between requests is not an edit. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key !== "cache_control") out[key] = withoutCacheControl(inner);
  }
  return out;
}

type WireMessage = { role: string; content: unknown[] };

/**
 * `next` extends `previous`: the same system and tools, every earlier message
 * identical, and the last one at most grown by blocks appended to its end
 * (new content merged into the same turn is still an append).
 */
function expectWireAppendOnly(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  label: string,
) {
  const a = withoutCacheControl(previous) as Record<string, unknown>;
  const b = withoutCacheControl(next) as Record<string, unknown>;
  expect(JSON.stringify(b.system), `${label}: system`).toBe(JSON.stringify(a.system));
  expect(JSON.stringify(b.tools), `${label}: tools`).toBe(JSON.stringify(a.tools));
  const before = a.messages as WireMessage[];
  const after = b.messages as WireMessage[];
  expect(after.length, `${label}: history shrank`).toBeGreaterThanOrEqual(before.length);
  before.forEach((message, index) => {
    const later = after[index]!;
    if (index < before.length - 1) {
      expect(JSON.stringify(later), `${label}: messages[${index}]`).toBe(JSON.stringify(message));
      return;
    }
    expect(later.role, `${label}: messages[${index}].role`).toBe(message.role);
    expect(
      JSON.stringify(later.content.slice(0, message.content.length)),
      `${label}: messages[${index}]`,
    ).toBe(JSON.stringify(message.content));
  });
}

function tool(name: string, size: number): Tool {
  return {
    definition: {
      name,
      description: `The ${name} tool.`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(): Promise<ToolResult> {
      return { content: [{ type: "text", text: name.repeat(size / name.length) }] };
    },
  };
}

describe("Anthropic request bodies stay append-only", () => {
  it("across a native tool_search activation, steering, a ceiling warning and context editing", async () => {
    const opus = getModel("anthropic/claude-opus-5-5")!;
    const searchUse: Block = {
      type: "server_tool_use",
      id: "srv1",
      name: "tool_search_tool_bm25",
      input: { query: "dump the logs" },
    };
    const searchResult: Block = {
      type: "tool_search_tool_result",
      tool_use_id: "srv1",
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "dump" }],
      },
    };
    const { client, bodies } = recordingClient([
      response([thinking("a"), searchUse, searchResult, toolUse("d1", "dump")], "tool_use"),
      response([thinking("b"), toolUse("d2", "dump")], "tool_use"),
      response([thinking("c"), toolUse("d3", "dump")], "tool_use"),
      response([thinking("d"), { type: "text", text: "all dumped" }], "end_turn"),
    ]);
    const toolset = createDeferredToolset({
      tools: [tool("read", 40), tool("deploy", 60), tool("dump", 3_000)],
      alwaysActive: ["read"],
    });
    const agent = new Agent({
      llm: createAnthropicProvider({ client, thinkingBinding: "drop_block" }),
      model: opus,
      systemPrompt: "You are Arcturn.",
      tools: [...toolset.allTools(), toolset.searchTool()],
      deferredTools: toolset,
      thinking: "high",
      cwd: "/work",
      permissions: { mode: "yolo" },
      maxTurns: 4,
      // What `providers.anthropic.thinkingBinding` turns on: tool results are
      // cleared server-side, so the client never rewrites one.
      contextEditing: {
        mode: "auto",
        keepRecentTurns: 1,
        maxTotalToolResultChars: 0,
        minCharsPerPass: 1,
      },
    });
    let steered = false;
    agent.on("toolStart", () => {
      if (steered) return;
      steered = true;
      agent.steer("also keep the timestamps");
    });

    await agent.prompt("dump the logs");

    expect(bodies).toHaveLength(4);
    for (let index = 1; index < bodies.length; index++) {
      expectWireAppendOnly(bodies[index - 1]!, bodies[index]!, `request ${index}`);
    }

    const first = bodies[0]!;
    // Every tool from the first request, deferred ones flagged, the server's
    // search beside them and arcturn's own nowhere.
    const tools = first.tools as Array<{ name: string; defer_loading?: boolean }>;
    expect(tools.map((entry) => [entry.name, entry.defer_loading === true])).toEqual([
      ["read", false],
      ["deploy", true],
      ["dump", true],
      ["tool_search_tool_bm25", false],
    ]);
    // The binding controls and server-side clearing ride every request.
    for (const body of bodies) {
      expect(body.betas).toEqual([
        "thinking-binding-controls-2026-08-01",
        "context-management-2025-06-27",
      ]);
      expect(body.context_management).toEqual({
        edits: [{ type: "clear_tool_uses_20250919", exclude_tools: ["todo", "plan"] }],
      });
      expect(body.thinking).toMatchObject({
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      });
    }

    const last = bodies.at(-1)!.messages as WireMessage[];
    const flat = JSON.stringify(last);
    // The user's steer is the user speaking …
    expect(
      last.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("also keep the timestamps"),
      ),
    ).toBe(true);
    // … the turn budget is the harness speaking, on the operator channel …
    expect(
      last.some((m) => m.role === "system" && JSON.stringify(m.content).includes("Turn budget:")),
    ).toBe(true);
    // … every thinking block is still replayed, and no result was stubbed.
    for (const id of ["a", "b", "c"]) expect(flat).toContain(`sig-${id}`);
    expect(flat).not.toContain("context-edited");
    // The server's activation reached arcturn's record.
    expect(toolset.snapshot()).toEqual({ activated: ["dump"], native: ["dump"] });
  });

  it("with local context editing, rewrites history only at a recorded pass", async () => {
    const opus = { ...getModel("anthropic/claude-opus-5-5")!, provider: "vertex" };
    const script = [0, 1, 2, 3, 4, 5].map((i) =>
      response([thinking(`t${i}`), toolUse(`d${i}`, "dump")], "tool_use"),
    );
    const { client, bodies } = recordingClient(script);
    const agent = new Agent({
      llm: createAnthropicProvider({ client }),
      model: opus,
      systemPrompt: "You are Arcturn.",
      tools: [tool("dump", 3_000)],
      thinking: "high",
      cwd: "/work",
      permissions: { mode: "yolo" },
      contextEditing: { keepRecentTurns: 1, maxTotalToolResultChars: 0, minCharsPerPass: 8_000 },
    });

    await agent.prompt("dump repeatedly");

    const passes = new Set(agent.contextEditPasses.map((pass) => pass.requestIndex));
    expect(passes.size).toBeGreaterThan(0);
    expect(passes.size).toBeLessThan(bodies.length - 2);
    for (let index = 1; index < bodies.length; index++) {
      if (passes.has(index)) continue;
      expectWireAppendOnly(bodies[index - 1]!, bodies[index]!, `request ${index}`);
    }
    // At a pass, the thinking produced over a rewritten result is withheld
    // from then on — never replayed against a prefix it was not bound to.
    const pass = [...passes][0]!;
    const atPass = JSON.stringify(bodies[pass]!.messages);
    expect(atPass).toContain("context-edited");
    expect(atPass).toContain("sig-t0");
    expect(atPass).not.toContain(`sig-t${pass - 1}`);
  });
});
