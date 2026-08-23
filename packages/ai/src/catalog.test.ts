import { afterEach, describe, expect, it } from "vitest";
import {
  getModel,
  listModels,
  listModelsByProvider,
  openaiCompatible,
  presetModel,
  registerModel,
  requireModel,
  resetCatalog,
  unregisterModel,
} from "./catalog.js";
import { modelSpec } from "./test-helpers/fixtures.js";

afterEach(() => {
  resetCatalog();
});

describe("built-in catalog", () => {
  it("ships models for all three first-party providers", () => {
    for (const provider of ["anthropic", "openai", "google"]) {
      expect(listModelsByProvider(provider).length).toBeGreaterThan(0);
    }
  });

  it("ships the current flagship generations with their documented limits and pricing", () => {
    const expected = [
      {
        id: "anthropic/claude-opus-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        thinkingStyle: "adaptive",
      },
      {
        id: "anthropic/claude-sonnet-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        thinkingStyle: "adaptive",
      },
      {
        id: "anthropic/claude-fable-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        thinkingStyle: "adaptive",
      },
      {
        id: "openai/gpt-5.6-sol",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        cost: { input: 5, output: 30, cacheRead: 0.5 },
      },
      {
        id: "openai/gpt-5.6-terra",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        cost: { input: 2, output: 12, cacheRead: 0.2 },
      },
      {
        id: "openai/gpt-5.6-luna",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        cost: { input: 0.2, output: 1.2, cacheRead: 0.02 },
      },
      {
        id: "google/gemini-3.7-flash",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        cost: { input: 0.75, output: 3.75, cacheRead: 0.075 },
      },
      {
        id: "google/gemini-3.5-flash",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        cost: { input: 1.5, output: 9, cacheRead: 0.15 },
      },
      {
        id: "google/gemini-3.5-flash-lite",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        cost: { input: 0.3, output: 2.5, cacheRead: 0.03 },
      },
    ] as const;

    for (const entry of expected) {
      const model = getModel(entry.id);
      expect(model, entry.id).toBeDefined();
      expect(model?.contextWindow, entry.id).toBe(entry.contextWindow);
      expect(model?.maxOutputTokens, entry.id).toBe(entry.maxOutputTokens);
      expect(model?.cost, entry.id).toEqual(entry.cost);
      if ("thinkingStyle" in entry) {
        expect(model?.capabilities.thinkingStyle, entry.id).toBe(entry.thinkingStyle);
      }
    }
  });

  it("keeps the 4.5 generation on budget-style thinking", () => {
    for (const id of [
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-haiku-4-5",
    ]) {
      expect(getModel(id)?.capabilities.thinkingStyle, id).toBe("budget");
    }
  });

  it("makes every registered provider reachable from the catalog", () => {
    // `openai-responses` shipped as a registered provider, documented beside
    // `openai`, with zero catalog entries — and `--model` resolves against the
    // catalog, so 900 lines of working adapter were unreachable to anyone not
    // calling `registerModel` themselves. A provider nobody can select is the
    // same as one that does not exist, and the docs said otherwise.
    const providers = new Set(listModels().map((model) => model.provider));
    expect(providers).toContain("openai-responses");
  });

  it("mirrors every Chat Completions model onto the Responses surface", () => {
    // Derived, not duplicated: the two serve the same names at the same limits
    // and prices, so drift between them would be a bug with no upside.
    const chat = listModels().filter((model) => model.provider === "openai");
    const responses = listModels().filter((model) => model.provider === "openai-responses");
    expect(responses.map((model) => model.model).sort()).toEqual(
      chat.map((model) => model.model).sort(),
    );
    for (const model of responses) {
      const twin = chat.find((candidate) => candidate.model === model.model);
      expect(twin, model.id).toBeDefined();
      expect(model.contextWindow, model.id).toBe(twin?.contextWindow);
      expect(model.cost, model.id).toEqual(twin?.cost);
      expect(model.apiKeyEnv, model.id).toBe("OPENAI_API_KEY");
    }
  });

  it("adds global inference profiles only where Bedrock offers them", () => {
    expect(getModel("bedrock/global.anthropic.claude-opus-4-5-20251101-v1:0")).toBeDefined();
    expect(getModel("bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBeDefined();
    // No global profile is published for Opus 4.1 or Haiku 3.5.
    expect(getModel("bedrock/global.anthropic.claude-opus-4-1-20250805-v1:0")).toBeUndefined();
    expect(getModel("bedrock/global.anthropic.claude-3-5-haiku-20241022-v1:0")).toBeUndefined();
  });

  it("gives every entry a sane shape", () => {
    for (const model of listModels()) {
      expect(model.id).toBe(`${model.provider}/${model.model}`);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeLessThanOrEqual(model.contextWindow);
      expect(model.apiKeyEnv).toBeTruthy();
      if (model.cost) {
        expect(model.cost.output).toBeGreaterThanOrEqual(model.cost.input);
      }
    }
  });
});

describe("getModel", () => {
  it("resolves by catalog id", () => {
    expect(getModel("anthropic/claude-opus-4-5")?.displayName).toBe("Claude Opus 4.5");
  });

  it("resolves by bare wire name", () => {
    expect(getModel("gemini-2.5-pro")?.provider).toBe("google");
  });

  it("returns undefined for unknown ids", () => {
    expect(getModel("nope/nope")).toBeUndefined();
  });

  it("requireModel throws for unknown ids", () => {
    expect(() => requireModel("nope/nope")).toThrow(/Unknown model/);
    expect(requireModel("openai/gpt-5").model).toBe("gpt-5");
  });
});

describe("registerModel", () => {
  it("adds new entries and overrides built-ins", () => {
    const custom = modelSpec({ id: "custom/one", provider: "custom", model: "one" });
    expect(registerModel(custom)).toBe(custom);
    expect(getModel("custom/one")).toBe(custom);

    const override = { ...requireModel("openai/gpt-5"), displayName: "Patched" };
    registerModel(override);
    expect(getModel("openai/gpt-5")?.displayName).toBe("Patched");
  });

  it("unregister removes an entry and reset restores built-ins", () => {
    registerModel(modelSpec({ id: "custom/two", provider: "custom", model: "two" }));
    expect(unregisterModel("custom/two")).toBe(true);
    expect(unregisterModel("custom/two")).toBe(false);

    unregisterModel("openai/gpt-5");
    expect(getModel("openai/gpt-5")).toBeUndefined();
    resetCatalog();
    expect(getModel("openai/gpt-5")).toBeDefined();
  });
});

describe("openaiCompatible", () => {
  it("derives a readable id from the host", () => {
    const spec = openaiCompatible("https://api.groq.com/openai/v1", "llama-3.3-70b");
    expect(spec.id).toBe("groq/llama-3.3-70b");
    expect(spec.provider).toBe("openai-compatible");
    expect(spec.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(spec.capabilities).toEqual({
      tools: true,
      vision: false,
      thinking: false,
      caching: false,
    });
  });

  it("honours overrides and optional registration", () => {
    const spec = openaiCompatible("http://localhost:11434/v1", "qwen3", {
      id: "local/qwen3",
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      capabilities: { thinking: true },
      cost: { input: 0, output: 0 },
      apiKeyEnv: "MY_KEY",
      register: true,
    });
    expect(spec.capabilities.thinking).toBe(true);
    expect(spec.apiKeyEnv).toBe("MY_KEY");
    expect(getModel("local/qwen3")).toBe(spec);
  });

  it("tolerates an unparseable base URL", () => {
    expect(openaiCompatible("not a url", "m").id).toBe("openai-compatible/m");
  });
});

describe("presetModel", () => {
  it("fills in a known endpoint", () => {
    const spec = presetModel("deepseek", "deepseek-chat");
    expect(spec.id).toBe("deepseek/deepseek-chat");
    expect(spec.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(spec.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
  });

  it("throws for unknown presets", () => {
    expect(() => presetModel("nowhere", "m")).toThrow(/Unknown OpenAI-compatible preset/);
  });
});
