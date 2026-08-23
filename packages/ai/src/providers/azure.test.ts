import type { LLMRequest, StreamEvent } from "@arcturn/types";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import { describe, expect, it, vi } from "vitest";
import { collect, modelSpec, terminal, textOf, userMessage } from "../test-helpers/fixtures.js";
import {
  AZURE_DEFAULT_API_VERSION,
  type AzureModelSpec,
  type AzureProviderOptions,
  azureCacheKey,
  azureModel,
  azureStreamRequest,
  checkAzureCredentials,
  createAzureProvider,
  resolveAzureConfig,
} from "./azure.js";
import type { OpenAIClientLike } from "./openai.js";
import type { ProviderFactoryContext } from "./registry.js";

const spec: AzureModelSpec = {
  ...modelSpec({
    id: "azure/prod-gpt5",
    provider: "azure",
    model: "prod-gpt5",
    maxOutputTokens: 16_384,
  }),
  providerOptions: { endpoint: "https://res.openai.azure.com", apiVersion: "2024-10-21" },
};

const base: AzureProviderOptions = { env: {}, apiKey: "k" };

interface FakeAzure extends OpenAIClientLike {
  params?: ChatCompletionCreateParamsStreaming;
}

function fakeClient(chunks: unknown[]): FakeAzure {
  const client: FakeAzure = {
    chat: {
      completions: {
        create: vi.fn(async (params: ChatCompletionCreateParamsStreaming) => {
          client.params = params;
          return (async function* () {
            for (const item of chunks) yield item as ChatCompletionChunk;
          })();
        }),
      },
    },
  };
  return client;
}

function throwingClient(error: unknown): OpenAIClientLike {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          throw error;
        }),
      },
    },
  } as unknown as OpenAIClientLike;
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "prod-gpt5",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageChunk(usage: Record<string, unknown>): Record<string, unknown> {
  return { id: "c1", object: "chat.completion.chunk", created: 0, model: "x", choices: [], usage };
}

async function streamOf(
  chunks: unknown[],
  overrides: Partial<LLMRequest> = {},
): Promise<StreamEvent[]> {
  const provider = createAzureProvider({ ...base, client: fakeClient(chunks) });
  return collect(provider.stream({ model: spec, messages: [userMessage("hi")], ...overrides }));
}

function factoryContext(
  model: AzureModelSpec,
  extra: Partial<ProviderFactoryContext> = {},
): ProviderFactoryContext {
  return { spec: model, apiKey: undefined, baseUrl: undefined, headers: undefined, ...extra };
}

describe("resolveAzureConfig", () => {
  it("prefers spec providerOptions over provider options and the environment", () => {
    expect(
      resolveAzureConfig(spec, {
        endpoint: "https://other.openai.azure.com",
        apiVersion: "2023-05-15",
        env: {
          AZURE_OPENAI_ENDPOINT: "https://env.openai.azure.com",
          AZURE_OPENAI_API_VERSION: "2022-12-01",
        },
      }),
    ).toEqual({
      endpoint: "https://res.openai.azure.com",
      deployment: "prod-gpt5",
      apiVersion: "2024-10-21",
    });
  });

  it("falls back to provider options, spec.baseUrl, then the environment", () => {
    const bare = modelSpec({ provider: "azure", model: "dep" });
    expect(resolveAzureConfig(bare, { endpoint: "https://opts.azure.com", env: {} }).endpoint).toBe(
      "https://opts.azure.com",
    );
    expect(
      resolveAzureConfig({ ...bare, baseUrl: "https://spec.azure.com" }, { env: {} }).endpoint,
    ).toBe("https://spec.azure.com");
    expect(
      resolveAzureConfig(bare, { env: { AZURE_OPENAI_ENDPOINT: "https://env.azure.com" } })
        .endpoint,
    ).toBe("https://env.azure.com");
  });

  it("treats spec.model as the deployment unless one is named", () => {
    const bare = modelSpec({ provider: "azure", model: "gpt-4o" });
    expect(resolveAzureConfig(bare, { env: {} }).deployment).toBe("gpt-4o");
    expect(resolveAzureConfig(bare, { env: {}, deployment: "my-deployment" }).deployment).toBe(
      "my-deployment",
    );
    const pinned: AzureModelSpec = { ...bare, providerOptions: { deployment: "spec-deployment" } };
    expect(resolveAzureConfig(pinned, { env: {}, deployment: "my-deployment" }).deployment).toBe(
      "spec-deployment",
    );
  });

  it("defaults the API version and reads both version variables", () => {
    const bare = modelSpec({ provider: "azure", model: "dep" });
    expect(resolveAzureConfig(bare, { env: {} }).apiVersion).toBe(AZURE_DEFAULT_API_VERSION);
    expect(
      resolveAzureConfig(bare, { env: { AZURE_OPENAI_API_VERSION: "2025-01-01-preview" } })
        .apiVersion,
    ).toBe("2025-01-01-preview");
    expect(resolveAzureConfig(bare, { env: { OPENAI_API_VERSION: "2024-06-01" } }).apiVersion).toBe(
      "2024-06-01",
    );
  });
});

describe("azureCacheKey", () => {
  it("separates endpoints, deployments and API versions", () => {
    const bare = modelSpec({ provider: "azure", model: "dep" });
    const keys = new Set([
      azureCacheKey(bare, { env: {}, endpoint: "https://a", apiVersion: "v1" }),
      azureCacheKey(bare, { env: {}, endpoint: "https://b", apiVersion: "v1" }),
      azureCacheKey(bare, { env: {}, endpoint: "https://a", apiVersion: "v2" }),
      azureCacheKey(bare, {
        env: {},
        endpoint: "https://a",
        apiVersion: "v1",
        deployment: "other",
      }),
    ]);
    expect(keys.size).toBe(4);
    expect(azureCacheKey(spec, { env: {} })).toContain("res.openai.azure.com");
    expect(azureCacheKey(spec, { env: {} })).toContain("prod-gpt5");
    expect(azureCacheKey(spec, { env: {} })).toContain("2024-10-21");
  });
});

describe("checkAzureCredentials", () => {
  it("requires an endpoint", () => {
    const bare = modelSpec({ provider: "azure", model: "dep" });
    const failure = checkAzureCredentials(factoryContext(bare), { env: {} });
    expect(failure?.kind).toBe("invalidRequest");
    expect(failure?.message).toMatch(/AZURE_OPENAI_ENDPOINT/);
  });

  it("requires an API key or a token provider", () => {
    const failure = checkAzureCredentials(factoryContext(spec), { env: {} });
    expect(failure?.kind).toBe("auth");
    expect(failure?.message).toMatch(/AZURE_OPENAI_API_KEY/);
  });

  it("accepts a resolved key, an environment key, or Entra ID", () => {
    expect(
      checkAzureCredentials(factoryContext(spec, { apiKey: "k" }), { env: {} }),
    ).toBeUndefined();
    expect(
      checkAzureCredentials(factoryContext(spec), { env: { AZURE_OPENAI_API_KEY: "k" } }),
    ).toBeUndefined();
    expect(
      checkAzureCredentials(factoryContext(spec), {
        env: {},
        azureADTokenProvider: async () => "token",
      }),
    ).toBeUndefined();
    expect(
      checkAzureCredentials(factoryContext(spec, { getAccessToken: async () => "token" }), {
        env: {},
      }),
    ).toBeUndefined();
  });
});

describe("azureStreamRequest", () => {
  it("replaces the model with the deployment and keeps the catalog id for reporting", () => {
    const request: LLMRequest = { model: spec, messages: [userMessage("hi")] };
    const rewritten = azureStreamRequest(request, "my-deployment");
    expect(rewritten.model.model).toBe("my-deployment");
    expect(rewritten.model.id).toBe("azure/prod-gpt5");
    // The OpenAI dialect (max_completion_tokens, reasoning_effort) is what Azure serves.
    expect(rewritten.model.provider).toBe("openai");
    expect(request.model.model).toBe("prod-gpt5");
  });

  it("drops temperature when the catalog model is a reasoning model", () => {
    const reasoning: AzureModelSpec = { ...spec, model: "gpt-5" };
    expect(
      azureStreamRequest({ model: reasoning, messages: [], temperature: 0.3 }, "friendly-name")
        .temperature,
    ).toBeUndefined();
    const chatty: AzureModelSpec = { ...spec, model: "gpt-4o" };
    expect(
      azureStreamRequest({ model: chatty, messages: [], temperature: 0.3 }, "friendly-name")
        .temperature,
    ).toBe(0.3);
  });
});

describe("azure streaming", () => {
  it("addresses the deployment, not the model id", async () => {
    const client = fakeClient([chunk({ content: "ok" }, "stop")]);
    const deployed: AzureModelSpec = {
      ...spec,
      model: "gpt-4o",
      providerOptions: { ...spec.providerOptions, deployment: "prod-chat" },
    };
    await createAzureProvider({ ...base, client }).complete({
      model: deployed,
      messages: [userMessage("hi")],
    });
    expect(client.params?.model).toBe("prod-chat");
  });

  it("assembles text and usage", async () => {
    const events = await streamOf([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
      usageChunk({
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 2 },
      }),
    ]);
    expect(textOf(events)).toBe("Hello");
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("endTurn");
    expect(end.message.model).toBe("azure/prod-gpt5");
    expect(end.message.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
    });
  });

  it("accumulates tool-call argument deltas", async () => {
    const events = await streamOf([
      chunk({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
      chunk({}, "tool_calls"),
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
    expect(end.message.content).toEqual([
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
    ]);
  });

  it("maps finish reasons", async () => {
    expect(terminal(await streamOf([chunk({ content: "x" }, "length")])).message.stopReason).toBe(
      "maxTokens",
    );
    const filtered = terminal(await streamOf([chunk({ content: "x" }, "content_filter")]));
    expect(filtered.message.stopReason).toBe("error");
    expect(filtered.message.errorMessage).toBe("Provider finish_reason: content_filter");
  });

  it("sends the OpenAI-proper token field", async () => {
    const client = fakeClient([chunk({ content: "ok" }, "stop")]);
    await createAzureProvider({ ...base, client }).complete({
      model: spec,
      messages: [userMessage("hi")],
      maxOutputTokens: 512,
    });
    expect(client.params?.max_completion_tokens).toBe(512);
    expect(client.params?.max_tokens).toBeUndefined();
  });
});

describe("azure error handling", () => {
  const cases: Array<[string, unknown, string]> = [
    ["401 as auth", Object.assign(new Error("no"), { status: 401 }), "auth"],
    ["403 as auth", Object.assign(new Error("denied"), { status: 403 }), "auth"],
    ["400 as invalidRequest", Object.assign(new Error("bad"), { status: 400 }), "invalidRequest"],
    ["500 as overloaded", Object.assign(new Error("boom"), { status: 500 }), "overloaded"],
    ["503 as overloaded", Object.assign(new Error("busy"), { status: 503 }), "overloaded"],
  ];

  for (const [name, error, kind] of cases) {
    it(`classifies ${name}`, async () => {
      const provider = createAzureProvider({ ...base, client: throwingClient(error) });
      const events = await collect(provider.stream({ model: spec, messages: [userMessage("hi")] }));
      expect(events.filter((event) => event.type === "start")).toHaveLength(1);
      const last = terminal(events);
      if (last.type !== "error") throw new Error("expected an error event");
      expect(last.error.kind).toBe(kind);
    });
  }

  it("carries retryAfter off a 429", async () => {
    const error = Object.assign(new Error("slow down"), {
      status: 429,
      headers: { "retry-after-ms": "1500" },
    });
    const provider = createAzureProvider({ ...base, client: throwingClient(error) });
    const last = terminal(
      await collect(provider.stream({ model: spec, messages: [userMessage("hi")] })),
    );
    if (last.type !== "error") throw new Error("expected an error event");
    expect(last.error.kind).toBe("rateLimit");
    expect(last.error.retryAfterMs).toBe(1500);
  });

  it("reports a missing endpoint as a terminal error, not a throw", async () => {
    const bare = modelSpec({ provider: "azure", model: "dep" });
    const last = terminal(
      await collect(
        createAzureProvider({ env: {}, apiKey: "k" }).stream({
          model: bare,
          messages: [userMessage("hi")],
        }),
      ),
    );
    if (last.type !== "error") throw new Error("expected an error event");
    expect(last.error.kind).toBe("invalidRequest");
    expect(last.error.message).toMatch(/AZURE_OPENAI_ENDPOINT/);
  });

  it("reports a missing credential as a terminal auth error", async () => {
    const last = terminal(
      await collect(
        createAzureProvider({ env: {} }).stream({ model: spec, messages: [userMessage("hi")] }),
      ),
    );
    if (last.type !== "error") throw new Error("expected an error event");
    expect(last.error.kind).toBe("auth");
  });

  it("ends as aborted when the signal is already set", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await streamOf([chunk({ content: "never" })], { signal: controller.signal });
    expect(terminal(events).message.stopReason).toBe("aborted");
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("reports a mid-stream abort as a terminal end", async () => {
    const controller = new AbortController();
    const client = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield chunk({ content: "partial" }) as unknown as ChatCompletionChunk;
              controller.abort();
              throw Object.assign(new Error("Request was aborted."), { name: "AbortError" });
            })(),
        },
      },
    } as unknown as OpenAIClientLike;
    const end = terminal(
      await collect(
        createAzureProvider({ ...base, client }).stream({
          model: spec,
          messages: [userMessage("hi")],
          signal: controller.signal,
        }),
      ),
    );
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("aborted");
    expect(end.message.content).toEqual([{ type: "text", text: "partial" }]);
  });
});

describe("azureModel", () => {
  it("builds a per-tenant spec keyed on the deployment name", () => {
    const built = azureModel("prod-chat", {
      endpoint: "https://res.openai.azure.com",
      apiVersion: "2025-01-01-preview",
      displayName: "Prod chat",
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      capabilities: { thinking: true },
    });
    expect(built.id).toBe("azure/prod-chat");
    expect(built.provider).toBe("azure");
    expect(built.model).toBe("prod-chat");
    expect(built.apiKeyEnv).toBe("AZURE_OPENAI_API_KEY");
    expect(built.capabilities.thinking).toBe(true);
    expect(resolveAzureConfig(built, { env: {} })).toEqual({
      endpoint: "https://res.openai.azure.com",
      deployment: "prod-chat",
      apiVersion: "2025-01-01-preview",
    });
  });

  it("omits the providerOptions bag when nothing is configured", () => {
    const built = azureModel("bare");
    expect(built.providerOptions).toBeUndefined();
    expect(resolveAzureConfig(built, { env: {} })).toMatchObject({
      endpoint: undefined,
      deployment: "bare",
      apiVersion: AZURE_DEFAULT_API_VERSION,
    });
  });
});
