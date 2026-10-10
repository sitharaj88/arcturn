/**
 * Advisor pairing from the CLI side: `route.advisor` validated against the
 * pairing table at config time, the planner that sends the advisor tool when
 * the request's model is the executor — and keeps sending it once the session
 * has advisor blocks, wherever the pair is still valid — and the advisor's
 * model and share in `/cost`.
 */

import { requireModel } from "@arcturn/ai";
import type { AssistantMessage, LLMRequest, Message } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "./commands.js";
import { DEFAULT_CONFIG, parseConfigFile } from "./config.js";
import { advisorCostLines, serverToolPlanner } from "./server-tools.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

function parse(raw: unknown) {
  const warnings: string[] = [];
  const parsed = parseConfigFile(raw, "user", "cfg", warnings);
  return { parsed, warnings: warnings.join("\n") };
}

describe("route.advisor", () => {
  it("keeps a valid pair beside the other routes", () => {
    const { parsed, warnings } = parse({
      route: {
        subagent: "anthropic/claude-haiku-5-5",
        advisor: { executor: "anthropic/claude-sonnet-5-5", advisor: "anthropic/claude-opus-5-5" },
      },
    });
    expect(parsed.route).toEqual({
      subagent: "anthropic/claude-haiku-5-5",
      advisor: { executor: "anthropic/claude-sonnet-5-5", advisor: "anthropic/claude-opus-5-5" },
    });
    expect(warnings).toBe("");
  });

  it("drops a pair the API would refuse, naming both models and the valid advisors", () => {
    const { parsed, warnings } = parse({
      route: {
        advisor: { executor: "anthropic/claude-sonnet-5-5", advisor: "anthropic/claude-opus-4-8" },
      },
    });
    expect(parsed.route?.advisor).toBeUndefined();
    expect(warnings).toContain("claude-opus-4-8");
    expect(warnings).toContain("claude-sonnet-5-5");
    expect(warnings).toContain(
      "claude-mythos-5-1, claude-fable-5-1, claude-mythos-5, claude-fable-5, claude-opus-5-5, claude-opus-5, claude-sonnet-5-5",
    );
  });

  it("drops a pair off the first-party API, and a malformed value", () => {
    const bedrock = parse({
      route: {
        advisor: {
          executor: "bedrock/anthropic.claude-sonnet-5-5",
          advisor: "anthropic/claude-opus-5-5",
        },
      },
    });
    expect(bedrock.parsed.route?.advisor).toBeUndefined();
    expect(bedrock.warnings).toContain("first-party");
    const malformed = parse({ route: { advisor: "anthropic/claude-opus-5-5" } });
    expect(malformed.parsed.route?.advisor).toBeUndefined();
    expect(malformed.warnings).toContain('"route.advisor" must be');
  });
});

const sonnet55 = () => requireModel("anthropic/claude-sonnet-5-5");
const opus55 = () => requireModel("anthropic/claude-opus-5-5");
const haiku55 = () => requireModel("anthropic/claude-haiku-5-5");
const fable51 = () => requireModel("anthropic/claude-fable-5-1");

const advised: AssistantMessage = {
  role: "assistant",
  model: "anthropic/claude-sonnet-5-5",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: "endTurn",
  timestamp: 1,
  content: [
    {
      type: "serverTool",
      provider: "anthropic",
      block: { type: "server_tool_use", id: "a1", name: "advisor", input: {} },
    },
    {
      type: "serverTool",
      provider: "anthropic",
      block: {
        type: "advisor_tool_result",
        tool_use_id: "a1",
        content: {
          type: "advisor_redacted_result",
          encrypted_content: "x",
          stop_reason: "end_turn",
        },
      },
    },
  ],
};

function req(model: LLMRequest["model"], messages: Message[] = []): LLMRequest {
  return { model, messages };
}

describe("the advisor planner", () => {
  const plan = serverToolPlanner({ advisor: { executor: sonnet55(), advisor: opus55() } });

  it("sends the advisor when the request's model is the executor", () => {
    expect(plan(req(sonnet55()))).toEqual([{ kind: "advisor", model: "claude-opus-5-5" }]);
    expect(plan(req(haiku55()))).toEqual([]);
  });

  it("keeps sending it once the session has advisor blocks, while the pair stays valid", () => {
    // After /model to Haiku 5.5 — Opus 5.5 may advise it — the tool stays, so
    // the history's advisor blocks are still legal to send.
    expect(plan(req(haiku55(), [advised]))).toEqual([
      { kind: "advisor", model: "claude-opus-5-5" },
    ]);
    // Fable 5.1 takes no Opus advisor: nothing is sent, and the adapter drops
    // the advisor blocks with it (a removed tool beside its blocks is a 400).
    expect(plan(req(fable51(), [advised]))).toEqual([]);
  });
});

describe("/cost with an advisor", () => {
  it("names the advisor's model and its share of the cost", async () => {
    const lines = advisorCostLines(
      {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.02,
        advisor: [
          {
            model: "anthropic/claude-opus-5-5",
            inputTokens: 2_000,
            outputTokens: 300,
            cacheReadTokens: 1_000,
            cacheWriteTokens: 0,
            costUsd: 0.005,
          },
        ],
      },
      0.02,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("advisor");
    expect(lines[0]).toContain("Claude Opus 5.5");
    expect(lines[0]).toContain("2.0k in");
    expect(lines[0]).toContain("$0.0050");
    expect(lines[0]).toContain("25%");

    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      config: {
        ...DEFAULT_CONFIG,
        model: "anthropic/claude-sonnet-5-5",
        route: {
          advisor: {
            executor: "anthropic/claude-sonnet-5-5",
            advisor: "anthropic/claude-opus-5-5",
          },
        },
      },
    });
    try {
      runtime.metrics = {
        turns: 1,
        usage: {
          inputTokens: 1_000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          advisor: [
            {
              model: "anthropic/claude-opus-5-5",
              inputTokens: 2_000,
              outputTokens: 300,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: 0.005,
            },
          ],
        },
        costUsd: 0.02,
        unpricedTurns: 0,
      };
      const printed: string[] = [];
      await createCommandRegistry().dispatch("/cost", {
        runtime,
        ui: {
          print: (content) => {
            printed.push(...(typeof content === "string" ? [content] : content));
          },
          notice: () => undefined,
          select: async () => undefined,
          setInput: () => undefined,
          clear: () => undefined,
          exit: () => undefined,
        },
      });
      const text = printed.join("\n");
      expect(text).toContain("advisor    Claude Opus 5.5");
      expect(text).toContain("25%");
    } finally {
      await runtime.dispose();
    }
  });
});
