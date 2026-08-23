import type { LLMClient, LLMRequest, StreamEvent } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { requireModel } from "./catalog.js";
import { createClient, resolveApiKey } from "./client.js";
import { collect, modelSpec, terminal, userMessage } from "./test-helpers/fixtures.js";

const messages = [userMessage("hi")];

function stubProvider(): LLMClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    requests,
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      requests.push(request);
      return (async function* () {
        yield { type: "start", model: request.model.id };
        yield {
          type: "end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: request.model.id,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "endTurn",
            timestamp: 0,
          },
        } satisfies StreamEvent;
      })();
    },
    async complete() {
      throw new Error("unused");
    },
  } as LLMClient & { requests: LLMRequest[] };
}

describe("resolveApiKey", () => {
  const spec = modelSpec({ provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" });

  it("prefers a per-provider key, then a shared key", () => {
    expect(resolveApiKey(spec, { apiKeys: { anthropic: "per" }, apiKey: "shared" })).toBe("per");
    expect(resolveApiKey(spec, { apiKey: "shared" })).toBe("shared");
  });

  it("reads the spec-declared env var", () => {
    expect(resolveApiKey(spec, { env: { ANTHROPIC_API_KEY: "from-env" } })).toBe("from-env");
  });

  it("falls back to provider defaults and aliases", () => {
    const google = modelSpec({ provider: "google", apiKeyEnv: undefined });
    expect(resolveApiKey(google, { env: { GOOGLE_API_KEY: "g" } })).toBe("g");
    expect(resolveApiKey(google, { env: { GEMINI_API_KEY: "gem" } })).toBe("gem");
  });

  it("returns undefined when nothing is set", () => {
    expect(resolveApiKey(spec, { env: {} })).toBeUndefined();
  });
});

describe("createClient", () => {
  it("dispatches on the spec provider", async () => {
    const anthropic = stubProvider();
    const openai = stubProvider();
    const client = createClient({ providers: { anthropic, openai }, retry: false });

    await collect(client.stream({ model: requireModel("anthropic/claude-opus-4-5"), messages }));
    await collect(client.stream({ model: requireModel("openai/gpt-5"), messages }));

    expect(anthropic.requests).toHaveLength(1);
    expect(openai.requests).toHaveLength(1);
  });

  it("routes openai-compatible specs to the openai adapter", async () => {
    const openai = stubProvider();
    const client = createClient({
      providers: { "openai-compatible": openai },
      retry: false,
    });
    const spec = modelSpec({
      id: "groq/llama",
      provider: "openai-compatible",
      model: "llama",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    await collect(client.stream({ model: spec, messages }));
    expect(openai.requests).toHaveLength(1);
  });

  it("reports a missing API key as a terminal error event", async () => {
    const client = createClient({ env: {}, retry: false });
    const events = await collect(
      client.stream({ model: requireModel("anthropic/claude-opus-4-5"), messages }),
    );
    expect(events[0]).toMatchObject({ type: "start" });
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("auth");
    expect(last.error.message).toContain("ANTHROPIC_API_KEY");
    expect(last.message.stopReason).toBe("error");
  });

  it("reports an openai-compatible spec with no baseUrl as invalidRequest", async () => {
    const client = createClient({ retry: false });
    const spec = modelSpec({ id: "x/y", provider: "openai-compatible", model: "y" });
    const events = await collect(client.stream({ model: spec, messages }));
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("invalidRequest");
  });

  it("rejects unknown providers", async () => {
    const client = createClient({ apiKey: "k", retry: false });
    const spec = modelSpec({ id: "z/y", provider: "not-a-provider", model: "y" });
    const events = await collect(client.stream({ model: spec, messages }));
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.message).toContain("Unsupported provider");
  });

  it("wraps the dispatcher in retries by default", async () => {
    let calls = 0;
    const flaky: LLMClient = {
      stream(): AsyncIterable<StreamEvent> {
        calls++;
        const failing = calls === 1;
        return (async function* () {
          yield { type: "start", model: "m" };
          if (failing) {
            yield {
              type: "error",
              error: { kind: "overloaded", message: "busy" },
              message: {
                role: "assistant",
                content: [],
                model: "m",
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
                stopReason: "error",
                timestamp: 0,
              },
            };
            return;
          }
          yield {
            type: "end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "recovered" }],
              model: "m",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              stopReason: "endTurn",
              timestamp: 0,
            },
          };
        })();
      },
      async complete() {
        throw new Error("unused");
      },
    };
    const sleep = vi.fn(async () => {});
    const client = createClient({
      providers: { anthropic: flaky },
      retry: { sleep, maxAttempts: 3 },
    });
    const message = await client.complete({
      model: requireModel("anthropic/claude-opus-4-5"),
      messages,
    });
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(message.content).toEqual([{ type: "text", text: "recovered" }]);
  });

  it("skips retries when retry is false", async () => {
    let calls = 0;
    const failing: LLMClient = {
      stream(): AsyncIterable<StreamEvent> {
        calls++;
        return (async function* () {
          yield { type: "start", model: "m" };
          yield {
            type: "error",
            error: { kind: "overloaded", message: "busy" },
            message: {
              role: "assistant",
              content: [],
              model: "m",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              stopReason: "error",
              timestamp: 0,
            },
          };
        })();
      },
      async complete() {
        throw new Error("unused");
      },
    };
    const client = createClient({ providers: { anthropic: failing }, retry: false });
    await collect(client.stream({ model: requireModel("anthropic/claude-opus-4-5"), messages }));
    expect(calls).toBe(1);
  });
});
