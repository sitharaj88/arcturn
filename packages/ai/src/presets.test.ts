import { afterEach, describe, expect, it } from "vitest";
import { getModel, resetCatalog } from "./catalog.js";
import { listPresets, PROVIDER_PRESETS, presetSpec, registerPresetModels } from "./presets.js";

afterEach(() => {
  resetCatalog();
});

describe("PROVIDER_PRESETS", () => {
  it("gives every preset a sane shape", () => {
    for (const [name, entry] of Object.entries(PROVIDER_PRESETS)) {
      expect(entry.label, name).toBeTruthy();
      expect(entry.apiKeyEnv, name).toBeTruthy();
      expect(["openai", "anthropic"], name).toContain(entry.protocol);

      const isLocal = entry.baseUrl.startsWith("http://localhost");
      if (isLocal) continue;

      expect(() => new URL(entry.baseUrl), name).not.toThrow();
      expect(new URL(entry.baseUrl).protocol, name).toBe("https:");
    }
  });

  it("marks local endpoints as http, not https", () => {
    for (const name of ["ollama", "lmstudio", "vllm"]) {
      expect(PROVIDER_PRESETS[name]?.baseUrl.startsWith("http://localhost")).toBe(true);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PROVIDER_PRESETS)).toBe(true);
  });

  it("points regional variants at entries that exist", () => {
    for (const [name, entry] of Object.entries(PROVIDER_PRESETS)) {
      for (const variant of entry.regionalVariants ?? []) {
        expect(PROVIDER_PRESETS[variant], `${name} -> ${variant}`).toBeDefined();
      }
    }
  });
});

describe("presetSpec", () => {
  it("builds an openai-compatible spec for an openai-protocol preset", () => {
    const spec = presetSpec("groq", "llama-3.3-70b-versatile");
    expect(spec.id).toBe("groq/llama-3.3-70b-versatile");
    expect(spec.provider).toBe("openai-compatible");
    expect(spec.model).toBe("llama-3.3-70b-versatile");
    expect(spec.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(spec.apiKeyEnv).toBe("GROQ_API_KEY");
  });

  it("builds an anthropic-compatible spec for an anthropic-protocol preset", () => {
    const spec = presetSpec("minimax", "MiniMax-M2");
    expect(spec.id).toBe("minimax/MiniMax-M2");
    expect(spec.provider).toBe("anthropic-compatible");
    expect(spec.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(spec.apiKeyEnv).toBe("MINIMAX_API_KEY");
  });

  it("passes the model id through verbatim", () => {
    const spec = presetSpec("openrouter", "anthropic/claude-sonnet-4-5");
    expect(spec.model).toBe("anthropic/claude-sonnet-4-5");
    expect(spec.id).toBe("openrouter/anthropic/claude-sonnet-4-5");
  });

  it("honours overrides and optional registration", () => {
    const spec = presetSpec("deepseek", "deepseek-chat", {
      displayName: "DeepSeek chat (custom)",
      contextWindow: 32_000,
      capabilities: { thinking: true },
      register: true,
    });
    expect(spec.displayName).toBe("DeepSeek chat (custom)");
    expect(spec.contextWindow).toBe(32_000);
    expect(spec.capabilities.thinking).toBe(true);
    expect(getModel("deepseek/deepseek-chat")).toBe(spec);
  });

  it("does not register unless asked to", () => {
    presetSpec("groq", "some-model-not-registered");
    expect(getModel("groq/some-model-not-registered")).toBeUndefined();
  });

  it("throws a helpful error naming valid presets for an unknown preset", () => {
    expect(() => presetSpec("not-a-real-preset", "m")).toThrow(/Unknown provider preset/);
    expect(() => presetSpec("not-a-real-preset", "m")).toThrow(/groq/);
  });
});

describe("registerPresetModels", () => {
  it("registers a non-trivial, resolvable set of models", () => {
    const registered = registerPresetModels();
    expect(registered.length).toBeGreaterThan(10);
    for (const spec of registered) {
      const resolved = getModel(spec.id);
      expect(resolved, spec.id).toBeDefined();
      expect(resolved?.model).toBe(spec.model);
      expect(resolved?.contextWindow).toBeGreaterThan(0);
      expect(resolved?.maxOutputTokens).toBeGreaterThan(0);
      expect(resolved?.maxOutputTokens).toBeLessThanOrEqual(resolved?.contextWindow ?? 0);
      expect(resolved?.apiKeyEnv).toBeTruthy();
    }
  });

  it("is idempotent: a second call does not duplicate or throw", () => {
    const first = registerPresetModels();
    expect(() => registerPresetModels()).not.toThrow();
    const second = registerPresetModels();
    expect(second.length).toBe(first.length);
    for (const spec of second) {
      expect(getModel(spec.id)?.id).toBe(spec.id);
    }
  });

  it("only ever registers models under a known preset", () => {
    for (const spec of registerPresetModels()) {
      const preset = spec.id.split("/")[0] ?? "";
      expect(PROVIDER_PRESETS[preset], spec.id).toBeDefined();
    }
  });
});

describe("listPresets", () => {
  it("lists every preset, sorted by name", () => {
    const listing = listPresets({});
    expect(listing.length).toBe(Object.keys(PROVIDER_PRESETS).length);
    const names = listing.map((entry) => entry.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("detects key presence from an injected env", () => {
    const listing = listPresets({ GROQ_API_KEY: "sk-test", DEEPSEEK_API_KEY: "" });
    const groq = listing.find((entry) => entry.name === "groq");
    const deepseek = listing.find((entry) => entry.name === "deepseek");
    const cerebras = listing.find((entry) => entry.name === "cerebras");

    expect(groq?.keyPresent).toBe(true);
    // An empty string is not a usable key.
    expect(deepseek?.keyPresent).toBe(false);
    expect(cerebras?.keyPresent).toBe(false);
  });

  it("reports each entry's protocol and env var alongside its name", () => {
    const listing = listPresets({});
    const fireworks = listing.find((entry) => entry.name === "fireworks");
    expect(fireworks?.protocol).toBe("anthropic");
    expect(fireworks?.apiKeyEnv).toBe("FIREWORKS_API_KEY");
  });
});
