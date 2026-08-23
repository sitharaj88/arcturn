import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { LLMRequest, StreamEvent } from "@arcturn/types";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { getModel } from "../catalog.js";
import { collect, modelSpec, terminal, textOf, userMessage } from "../test-helpers/fixtures.js";
import type { AnthropicClientLike } from "./anthropic.js";
import type { GoogleClientLike } from "./google.js";
import type { ProviderFactoryContext } from "./registry.js";
import {
  checkVertexCredentials,
  createVertexProvider,
  resolveVertexConfig,
  VERTEX_DEFAULT_LOCATION,
  type VertexModelSpec,
  type VertexProviderOptions,
  vertexCacheKey,
  vertexFamily,
  vertexModel,
} from "./vertex.js";

const geminiSpec = modelSpec({
  id: "vertex/gemini-2.5-pro",
  provider: "vertex",
  model: "gemini-2.5-pro",
  maxOutputTokens: 65_536,
});

const claudeSpec = modelSpec({
  id: "vertex/claude-sonnet-4-5@20250929",
  provider: "vertex",
  model: "claude-sonnet-4-5@20250929",
  maxOutputTokens: 64_000,
});

/** Base options every test uses: an empty env plus a fixed project. */
const base: VertexProviderOptions = {
  env: {},
  project: "proj",
  location: "us-central1",
  discoverProject: async () => undefined,
};

interface FakeGemini extends GoogleClientLike {
  params?: GenerateContentParameters;
}

function fakeGemini(chunks: unknown[]): FakeGemini {
  const client: FakeGemini = {
    models: {
      generateContentStream: vi.fn(async (params: GenerateContentParameters) => {
        client.params = params;
        return (async function* () {
          for (const item of chunks) yield item as GenerateContentResponse;
        })();
      }),
    },
  };
  return client;
}

function throwingGemini(error: unknown): GoogleClientLike {
  return {
    models: {
      generateContentStream: vi.fn(async () => {
        throw error;
      }),
    },
  } as unknown as GoogleClientLike;
}

interface FakeClaude extends AnthropicClientLike {
  params?: unknown;
}

function fakeClaude(events: unknown[]): FakeClaude {
  const client = {
    params: undefined as unknown,
    messages: {
      create: vi.fn(async (params: unknown) => {
        client.params = params;
        return (async function* () {
          for (const event of events) yield event as RawMessageStreamEvent;
        })();
      }),
    },
  };
  return client as unknown as FakeClaude;
}

function geminiChunk(
  parts: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { candidates: [{ content: { parts, role: "model" }, ...extra }] };
}

async function geminiStream(
  chunks: unknown[],
  overrides: Partial<LLMRequest> = {},
): Promise<StreamEvent[]> {
  const provider = createVertexProvider({ ...base, geminiClient: fakeGemini(chunks) });
  return collect(
    provider.stream({ model: geminiSpec, messages: [userMessage("hi")], ...overrides }),
  );
}

async function claudeStream(
  events: unknown[],
  overrides: Partial<LLMRequest> = {},
): Promise<StreamEvent[]> {
  const provider = createVertexProvider({ ...base, anthropicClient: fakeClaude(events) });
  return collect(
    provider.stream({ model: claudeSpec, messages: [userMessage("hi")], ...overrides }),
  );
}

function factoryContext(spec: VertexModelSpec): ProviderFactoryContext {
  return { spec, apiKey: undefined, baseUrl: undefined, headers: undefined };
}

describe("vertexFamily", () => {
  it("routes Claude ids to the Anthropic SDK and everything else to Gemini", () => {
    expect(vertexFamily("claude-sonnet-4-5@20250929")).toBe("anthropic");
    expect(vertexFamily("publishers/anthropic/models/claude-opus-4-5")).toBe("anthropic");
    expect(vertexFamily("gemini-2.5-pro")).toBe("gemini");
    expect(vertexFamily("llama-4-maverick")).toBe("gemini");
  });
});

describe("resolveVertexConfig", () => {
  it("prefers spec providerOptions over provider options and the environment", () => {
    const spec: VertexModelSpec = {
      ...geminiSpec,
      providerOptions: { project: "from-spec", location: "europe-west4" },
    };
    expect(
      resolveVertexConfig(spec, {
        project: "from-options",
        location: "asia-east1",
        env: { GOOGLE_CLOUD_PROJECT: "from-env", GOOGLE_CLOUD_LOCATION: "us-east5" },
      }),
    ).toEqual({ project: "from-spec", location: "europe-west4", family: "gemini" });
  });

  it("falls back to provider options, then the environment", () => {
    expect(
      resolveVertexConfig(geminiSpec, {
        project: "from-options",
        env: { GOOGLE_CLOUD_PROJECT: "from-env", GOOGLE_CLOUD_LOCATION: "us-east5" },
      }),
    ).toMatchObject({ project: "from-options", location: "us-east5" });

    expect(
      resolveVertexConfig(geminiSpec, { env: { GOOGLE_CLOUD_PROJECT: "from-env" } }),
    ).toMatchObject({ project: "from-env", location: VERTEX_DEFAULT_LOCATION });
  });

  it("reads the alternate project and region environment variables", () => {
    expect(
      resolveVertexConfig(geminiSpec, {
        env: { GCLOUD_PROJECT: "alt", GOOGLE_CLOUD_REGION: "europe-west1" },
      }),
    ).toMatchObject({ project: "alt", location: "europe-west1" });
    expect(resolveVertexConfig(claudeSpec, { env: { CLOUD_ML_REGION: "global" } })).toMatchObject({
      location: "global",
      family: "anthropic",
    });
  });

  it("leaves the project undefined when nothing names one", () => {
    expect(resolveVertexConfig(geminiSpec, { env: {} }).project).toBeUndefined();
  });

  it("honours an explicit family override on the spec", () => {
    const spec: VertexModelSpec = { ...geminiSpec, providerOptions: { family: "anthropic" } };
    expect(resolveVertexConfig(spec, { env: {} }).family).toBe("anthropic");
  });
});

describe("vertexCacheKey", () => {
  it("separates projects and locations", () => {
    const a = vertexCacheKey(geminiSpec, { env: {}, project: "one", location: "us-central1" });
    const b = vertexCacheKey(geminiSpec, { env: {}, project: "two", location: "us-central1" });
    const c = vertexCacheKey(geminiSpec, { env: {}, project: "one", location: "europe-west4" });
    expect(a).toContain("one");
    expect(a).toContain("us-central1");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("is stable for the same coordinates reached by different routes", () => {
    const fromSpec: VertexModelSpec = {
      ...geminiSpec,
      providerOptions: { project: "one", location: "us-central1" },
    };
    expect(vertexCacheKey(fromSpec, { env: {} })).toBe(
      vertexCacheKey(geminiSpec, { env: {}, project: "one", location: "us-central1" }),
    );
  });
});

describe("checkVertexCredentials", () => {
  it("fails only when no project can be determined", () => {
    const failure = checkVertexCredentials(factoryContext(geminiSpec), { env: {} });
    expect(failure?.kind).toBe("invalidRequest");
    expect(failure?.message).toMatch(/GOOGLE_CLOUD_PROJECT/);
  });

  it("passes when a project is configured anywhere", () => {
    expect(
      checkVertexCredentials(factoryContext(geminiSpec), {
        env: { GOOGLE_CLOUD_PROJECT: "p" },
      }),
    ).toBeUndefined();
    const spec: VertexModelSpec = { ...geminiSpec, providerOptions: { project: "p" } };
    expect(checkVertexCredentials(factoryContext(spec), { env: {} })).toBeUndefined();
  });

  it("never pre-checks the ambient credentials themselves", () => {
    // A key file names its own project, so the precheck must defer to call time.
    expect(
      checkVertexCredentials(factoryContext(geminiSpec), {
        env: { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json" },
      }),
    ).toBeUndefined();
  });
});

describe("vertex Gemini streaming", () => {
  it("assembles text and usage through the google converters", async () => {
    const events = await geminiStream([
      geminiChunk([{ text: "Hel" }]),
      geminiChunk([{ text: "lo" }], { finishReason: "STOP" }),
      { usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 } },
    ]);
    expect(textOf(events)).toBe("Hello");
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("endTurn");
    expect(end.message.model).toBe("vertex/gemini-2.5-pro");
    expect(end.message.usage).toMatchObject({ inputTokens: 8, outputTokens: 2 });
  });

  it("emits a full tool-call block with accumulated arguments", async () => {
    const events = await geminiStream([
      geminiChunk([{ functionCall: { name: "read", args: { path: "a.ts" } } }], {
        finishReason: "STOP",
      }),
    ]);
    const deltas = events
      .filter(
        (event): event is Extract<StreamEvent, { type: "toolCallDelta" }> =>
          event.type === "toolCallDelta",
      )
      .map((event) => event.argumentsDelta)
      .join("");
    expect(deltas).toBe('{"path":"a.ts"}');
    const end = terminal(events);
    expect(end.message.stopReason).toBe("toolCalls");
    expect(end.message.content[0]).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "a.ts" },
    });
  });

  it("maps MAX_TOKENS and safety stops", async () => {
    expect(
      terminal(await geminiStream([geminiChunk([{ text: "x" }], { finishReason: "MAX_TOKENS" })]))
        .message.stopReason,
    ).toBe("maxTokens");
    const blocked = terminal(
      await geminiStream([geminiChunk([{ text: "x" }], { finishReason: "SAFETY" })]),
    );
    expect(blocked.message.stopReason).toBe("error");
  });

  it("sends the model name Vertex expects", async () => {
    const client = fakeGemini([geminiChunk([{ text: "hi" }], { finishReason: "STOP" })]);
    await createVertexProvider({ ...base, geminiClient: client }).complete({
      model: geminiSpec,
      messages: [userMessage("hi")],
    });
    expect(client.params?.model).toBe("gemini-2.5-pro");
  });
});

describe("vertex Claude streaming", () => {
  const started = {
    type: "message_start",
    message: { id: "msg_1", model: "claude", usage: { input_tokens: 10, output_tokens: 0 } },
  };
  const stopped = { type: "message_stop" };

  it("assembles text and usage through the anthropic converters", async () => {
    const events = await claudeStream([
      started,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      stopped,
    ]);
    expect(textOf(events)).toBe("Hi there");
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("endTurn");
    expect(end.message.model).toBe("vertex/claude-sonnet-4-5@20250929");
    expect(end.message.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  });

  it("accumulates partial tool-call JSON", async () => {
    const events = await claudeStream([
      started,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"pa' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'th":"a.ts"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 9 },
      },
      stopped,
    ]);
    const end = terminal(events);
    expect(end.message.stopReason).toBe("toolCalls");
    expect(end.message.content).toEqual([
      { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.ts" } },
    ]);
  });

  it("addresses the version-pinned Vertex model id", async () => {
    const client = fakeClaude([started, stopped]);
    await createVertexProvider({ ...base, anthropicClient: client }).complete({
      model: claudeSpec,
      messages: [userMessage("hi")],
    });
    expect(client.params).toMatchObject({ model: "claude-sonnet-4-5@20250929", stream: true });
  });
});

describe("vertex error handling", () => {
  const cases: Array<[string, unknown, string]> = [
    ["401 as auth", Object.assign(new Error("no"), { status: 401 }), "auth"],
    ["403 as auth", Object.assign(new Error("denied"), { status: 403 }), "auth"],
    ["400 as invalidRequest", Object.assign(new Error("bad"), { status: 400 }), "invalidRequest"],
    ["503 as overloaded", Object.assign(new Error("busy"), { status: 503 }), "overloaded"],
    ["500 as overloaded", Object.assign(new Error("boom"), { status: 500 }), "overloaded"],
  ];

  for (const [name, error, kind] of cases) {
    it(`classifies ${name}`, async () => {
      const provider = createVertexProvider({ ...base, geminiClient: throwingGemini(error) });
      const events = await collect(
        provider.stream({ model: geminiSpec, messages: [userMessage("hi")] }),
      );
      expect(events.filter((event) => event.type === "start")).toHaveLength(1);
      const last = terminal(events);
      if (last.type !== "error") throw new Error("expected an error event");
      expect(last.error.kind).toBe(kind);
      expect(last.message.stopReason).toBe("error");
    });
  }

  it("carries retryAfter off a 429", async () => {
    const error = Object.assign(new Error("slow down"), {
      status: 429,
      headers: { "retry-after": "12" },
    });
    const provider = createVertexProvider({ ...base, geminiClient: throwingGemini(error) });
    const last = terminal(
      await collect(provider.stream({ model: geminiSpec, messages: [userMessage("hi")] })),
    );
    if (last.type !== "error") throw new Error("expected an error event");
    expect(last.error.kind).toBe("rateLimit");
    expect(last.error.retryAfterMs).toBe(12_000);
  });

  it("classifies a failed ADC token exchange as auth", async () => {
    const error = new Error("Could not load the default credentials");
    const provider = createVertexProvider({ ...base, geminiClient: throwingGemini(error) });
    const last = terminal(
      await collect(provider.stream({ model: geminiSpec, messages: [userMessage("hi")] })),
    );
    if (last.type !== "error") throw new Error("expected an error event");
    expect(last.error.kind).toBe("auth");
  });

  it("fails with auth when no project resolves at call time", async () => {
    const provider = createVertexProvider({
      env: {},
      discoverProject: async () => undefined,
      geminiClient: fakeGemini([]),
    });
    const last = terminal(
      await collect(provider.stream({ model: geminiSpec, messages: [userMessage("hi")] })),
    );
    if (last.type !== "error") throw new Error("expected an error event");
    expect(last.error.kind).toBe("auth");
    expect(last.error.message).toMatch(/GOOGLE_CLOUD_PROJECT/);
  });

  it("discovers the project from ambient credentials", async () => {
    const discoverProject = vi.fn(async () => "discovered");
    const client = fakeGemini([geminiChunk([{ text: "ok" }], { finishReason: "STOP" })]);
    const message = await createVertexProvider({
      env: {},
      discoverProject,
      geminiClient: client,
    }).complete({ model: geminiSpec, messages: [userMessage("hi")] });
    expect(discoverProject).toHaveBeenCalledTimes(1);
    expect(message.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("ends as aborted when the signal is already set", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await geminiStream([geminiChunk([{ text: "never" }])], {
      signal: controller.signal,
    });
    expect(terminal(events).message.stopReason).toBe("aborted");
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("reports a mid-stream abort as a terminal end, not an error", async () => {
    const controller = new AbortController();
    const client: GoogleClientLike = {
      models: {
        generateContentStream: async () =>
          (async function* () {
            yield geminiChunk([{ text: "partial" }]) as unknown as GenerateContentResponse;
            controller.abort();
            throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
          })(),
      },
    };
    const events = await collect(
      createVertexProvider({ ...base, geminiClient: client }).stream({
        model: geminiSpec,
        messages: [userMessage("hi")],
        signal: controller.signal,
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("aborted");
    expect(end.message.content).toEqual([{ type: "text", text: "partial" }]);
  });
});

describe("vertexModel", () => {
  it("builds a spec for an unlisted model", () => {
    const spec = vertexModel("gemini-2.5-flash-lite", { project: "p", location: "europe-west4" });
    expect(spec.id).toBe("vertex/gemini-2.5-flash-lite");
    expect(spec.provider).toBe("vertex");
    expect(spec.model).toBe("gemini-2.5-flash-lite");
    expect(spec.providerOptions).toEqual({ project: "p", location: "europe-west4" });
    expect(resolveVertexConfig(spec, { env: {} })).toEqual({
      project: "p",
      location: "europe-west4",
      family: "gemini",
    });
  });

  it("defaults the window to the family and honours overrides", () => {
    expect(vertexModel("claude-opus-4-5@20251101").contextWindow).toBe(200_000);
    expect(vertexModel("gemini-2.5-pro").contextWindow).toBe(1_048_576);
    const custom = vertexModel("tuned-endpoint", {
      id: "vertex/tuned",
      displayName: "Tuned",
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      capabilities: { thinking: false },
      cost: { input: 1, output: 2 },
    });
    expect(custom.id).toBe("vertex/tuned");
    expect(custom.capabilities.thinking).toBe(false);
    expect(custom.providerOptions).toBeUndefined();
  });
});

describe("vertex catalog entries", () => {
  it("ships Gemini and Claude models under the vertex provider", () => {
    for (const id of [
      "vertex/gemini-2.5-pro",
      "vertex/gemini-2.5-flash",
      "vertex/claude-sonnet-4-5@20250929",
    ]) {
      const entry = getModel(id);
      expect(entry?.provider).toBe("vertex");
      expect(vertexFamily(entry?.model ?? "")).toBe(id.includes("claude") ? "anthropic" : "gemini");
    }
  });

  it("keeps the bare Gemini name pointing at the first-party catalog entry", () => {
    expect(getModel("gemini-2.5-pro")?.provider).toBe("google");
  });
});
