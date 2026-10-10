/**
 * How each adapter renders a `SystemMessage` — the operator channel — and
 * how the dispatcher refuses server-side context management a provider lacks.
 */

import type { LLMClient, Message, SystemMessage } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../client.js";
import { collect, modelSpec, terminal, toolResult, userMessage } from "../test-helpers/fixtures.js";
import { toConverseMessages } from "./bedrock.js";
import { GOOGLE_OPERATOR_PREFIX, toGoogleContents } from "./google.js";
import { openAISystemMessages, toOpenAIMessages } from "./openai.js";
import { toResponsesInput } from "./openai-responses.js";

const note: SystemMessage = {
  role: "system",
  content: [{ type: "text", text: "Turn budget: 2 left." }],
  timestamp: 1,
};
const history: Message[] = [userMessage("hi"), note];

describe("SystemMessage outside Anthropic", () => {
  it("is a mid-conversation system message on OpenAI, a reminder on a compatible gateway", () => {
    const openai = modelSpec({ id: "openai/gpt-5", provider: "openai", model: "gpt-5" });
    const gateway = modelSpec({ id: "local/llama", provider: "openai-compatible", model: "llama" });
    expect(openAISystemMessages(openai)).toBe(true);
    expect(openAISystemMessages(gateway)).toBe(false);
    expect(toOpenAIMessages(history, "sys", { systemMessages: true }).at(-1)).toEqual({
      role: "system",
      content: "Turn budget: 2 left.",
    });
    expect(toOpenAIMessages(history, "sys", { systemMessages: false }).at(-1)).toEqual({
      role: "user",
      content: "<system-reminder>\nTurn budget: 2 left.\n</system-reminder>",
    });
  });

  it("is a developer item on the Responses API", () => {
    expect(toResponsesInput(history).at(-1)).toEqual({
      role: "developer",
      content: "Turn budget: 2 left.",
    });
  });

  it("is an [operator] user turn on Gemini, never merged into a function-response turn", () => {
    const contents = toGoogleContents(
      [
        userMessage("go"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
          model: "gemini",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "toolCalls",
          timestamp: 1,
        },
        toolResult("c1", "read", "ok"),
        note,
      ],
      "gemini-2.5-pro",
    );
    expect(contents.at(-1)).toEqual({
      role: "user",
      parts: [{ text: `${GOOGLE_OPERATOR_PREFIX}Turn budget: 2 left.` }],
    });
    expect(contents.at(-2)?.parts?.[0]?.functionResponse).toBeDefined();
  });

  it("rides the user turn as a reminder on Bedrock Converse", () => {
    expect(toConverseMessages(history)).toEqual([
      {
        role: "user",
        content: [
          { text: "hi" },
          { text: "<system-reminder>\nTurn budget: 2 left.\n</system-reminder>" },
        ],
      },
    ]);
  });
});

describe("server-side context management at dispatch", () => {
  it("is refused, before any request, by a provider that lacks it", async () => {
    const stream = vi.fn();
    const openai = { stream, complete: vi.fn() } as unknown as LLMClient;
    const client = createClient({ providers: { openai }, retry: false });
    const events = await collect(
      client.stream({
        model: modelSpec({ id: "openai/gpt-5", provider: "openai", model: "gpt-5" }),
        messages: [userMessage("hi")],
        contextManagement: { compact: true },
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe("error");
    expect(end.type === "error" ? end.error.message : "").toMatch(/no server-side compaction/);
    expect(stream).not.toHaveBeenCalled();
  });
});
