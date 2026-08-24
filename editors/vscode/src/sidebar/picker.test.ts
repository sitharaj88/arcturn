import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry, SessionHeader } from "../serve/engine.js";
import { chooseSendVerb, escapeCodicons, modelPickItems, sessionPickItems } from "./picker.js";

function header(over: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 1, sessionId: "s1", cwd: "/w", createdAt: 1_000, ...over };
}

describe("chooseSendVerb", () => {
  it("prompts when idle and steers mid-run", () => {
    expect(chooseSendVerb(false)).toBe("prompt");
    expect(chooseSendVerb(true)).toBe("steer");
  });
});

describe("sessionPickItems", () => {
  it("lists only the sessions belonging to this workspace", () => {
    const items = sessionPickItems(
      [header({ sessionId: "mine" }), header({ sessionId: "other", cwd: "/elsewhere" })],
      { cwd: "/w" },
    );
    expect(items.filter((item) => item.sessionId !== undefined).map((i) => i.sessionId)).toEqual([
      "mine",
    ]);
  });

  it("puts the newest session first", () => {
    const items = sessionPickItems(
      [
        header({ sessionId: "old", createdAt: 1 }),
        header({ sessionId: "new", createdAt: 9 }),
        header({ sessionId: "mid", createdAt: 5 }),
      ],
      { cwd: "/w" },
    );
    expect(items.map((i) => i.sessionId).filter(Boolean)).toEqual(["new", "mid", "old"]);
  });

  it("always offers a new session, even with nothing to resume", () => {
    const items = sessionPickItems([], { cwd: "/w" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: "new" });
    expect(items[0]?.sessionId).toBeUndefined();
  });

  it("uses the engine's title when it has one and the id when it does not", () => {
    const items = sessionPickItems(
      [header({ sessionId: "titled", title: "Fix the parser" }), header({ sessionId: "bare" })],
      { cwd: "/w" },
    );
    expect(items[0]?.label).toContain("Fix the parser");
    expect(items[1]?.label).toContain("bare");
  });

  it("marks the session already open", () => {
    const items = sessionPickItems([header({ sessionId: "s1" })], {
      cwd: "/w",
      activeSessionId: "s1",
    });
    expect(items[0]?.description).toMatch(/current/i);
  });

  it("normalises a trailing slash so the workspace still matches", () => {
    const items = sessionPickItems([header({ cwd: "/w/" })], { cwd: "/w" });
    expect(items.some((item) => item.sessionId === "s1")).toBe(true);
  });
});

describe("modelPickItems", () => {
  it("offers models seen in this session, most recent first", () => {
    const items = modelPickItems({ observed: ["a/one", "b/two"] });
    expect(items.filter((i) => i.modelId !== undefined).map((i) => i.modelId)).toEqual([
      "b/two",
      "a/one",
    ]);
  });

  it("lists a model seen twice only once, at its most recent position", () => {
    const items = modelPickItems({ observed: ["a/one", "b/two", "a/one"] });
    expect(items.filter((i) => i.modelId !== undefined).map((i) => i.modelId)).toEqual([
      "a/one",
      "b/two",
    ]);
  });

  it("includes the configured default even when it has not been seen", () => {
    const items = modelPickItems({ observed: [], configured: "anthropic/x" });
    expect(items.map((i) => i.modelId)).toContain("anthropic/x");
  });

  it("marks the model in use", () => {
    const items = modelPickItems({ observed: ["a/one"], current: "a/one" });
    expect(items[0]?.description).toMatch(/current/i);
  });

  it("always ends with a free-text entry, even when the engine has a catalog", () => {
    const items = modelPickItems({ observed: ["a/one"] });
    expect(items.at(-1)).toMatchObject({ action: "other" });
    expect(items.at(-1)?.modelId).toBeUndefined();
  });
});

function entry(over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 2, output: 10 },
    apiKeyEnv: "ANTHROPIC_API_KEY",
    credentials: "present",
    ...over,
  };
}

describe("modelPickItems: the engine catalog", () => {
  it("offers every model the engine listed", () => {
    const items = modelPickItems({
      observed: [],
      catalog: [entry(), entry({ id: "openai/gpt-5", displayName: "GPT-5" })],
    });
    expect(items.filter((i) => i.modelId !== undefined).map((i) => i.modelId)).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-5",
    ]);
  });

  it("names the model, and shows the id, context window and price", () => {
    const [item] = modelPickItems({ observed: [], catalog: [entry()] });
    expect(item?.label).toBe("Claude Sonnet 5");
    expect(item?.description).toContain("anthropic/claude-sonnet-5");
    expect(item?.detail).toContain("1000k ctx");
    expect(item?.detail).toContain("$2/$10 per Mtok");
  });

  it("says pricing is unknown rather than printing a free-looking zero", () => {
    const unpriced = modelPickItems({ observed: [], catalog: [entry({ cost: undefined })] })[0];
    expect(unpriced?.detail).toContain("pricing unknown");
    expect(unpriced?.detail).not.toContain("$0");
    const free = modelPickItems({
      observed: [],
      catalog: [entry({ cost: { input: 0, output: 0 } })],
    })[0];
    expect(free?.detail).toContain("$0/$0 per Mtok");
    expect(free?.detail).not.toContain("unknown");
  });

  it("tells the user which models they actually have credentials for", () => {
    const [present] = modelPickItems({ observed: [], catalog: [entry()] });
    expect(present?.detail).toContain("ANTHROPIC_API_KEY set");
    const [absent] = modelPickItems({
      observed: [],
      catalog: [entry({ credentials: "absent" })],
    });
    expect(absent?.detail).toContain("ANTHROPIC_API_KEY not set");
  });

  it("names the variable even when it cannot tell whether the key is there", () => {
    // Every real `unknown` entry in the catalog — the openai-compatible
    // providers, seventeen of them — names a variable. Dropping it made those
    // models unfindable by typing the key they need, which is exactly how
    // somebody looks for them.
    const [unknown] = modelPickItems({
      observed: [],
      catalog: [
        entry({ id: "groq/llama-3.3-70b", apiKeyEnv: "GROQ_API_KEY", credentials: "unknown" }),
      ],
    });
    expect(unknown?.detail).toContain("GROQ_API_KEY");
    expect(unknown?.detail).toContain("credentials unknown");
  });

  it("puts the models with credentials ahead of the ones without", () => {
    const items = modelPickItems({
      observed: [],
      catalog: [
        entry({ id: "a/no-key", credentials: "absent" }),
        entry({ id: "b/has-key", credentials: "present" }),
      ],
    });
    expect(items.filter((i) => i.modelId !== undefined).map((i) => i.modelId)).toEqual([
      "b/has-key",
      "a/no-key",
    ]);
  });

  it("puts the model in use first and marks it, wherever the catalog listed it", () => {
    const items = modelPickItems({
      observed: [],
      current: "z/last",
      catalog: [entry({ id: "a/first" }), entry({ id: "z/last" })],
    });
    expect(items[0]?.modelId).toBe("z/last");
    expect(items[0]?.description).toMatch(/current/i);
  });

  it("puts a model in use that the catalog does not carry first, and marks it", () => {
    const items = modelPickItems({
      observed: ["extension/registered"],
      current: "extension/registered",
      catalog: [entry()],
    });
    expect(items[0]).toMatchObject({ modelId: "extension/registered", description: "current" });
    expect(items.filter((i) => i.modelId === "extension/registered")).toHaveLength(1);
  });

  it("keeps ids the session announced but the catalog does not carry", () => {
    const items = modelPickItems({
      observed: ["mystery/model"],
      configured: "configured/model",
      catalog: [entry()],
    });
    const ids = items.filter((i) => i.modelId !== undefined).map((i) => i.modelId);
    expect(ids).toContain("mystery/model");
    expect(ids).toContain("configured/model");
    expect(ids).toContain("anthropic/claude-sonnet-5");
  });

  it("lists a catalog model once, even when the session also announced it", () => {
    const items = modelPickItems({
      observed: ["anthropic/claude-sonnet-5"],
      catalog: [entry()],
    });
    expect(items.filter((i) => i.modelId === "anthropic/claude-sonnet-5")).toHaveLength(1);
  });

  it("falls back to today's behaviour when the engine has no catalog verb", () => {
    const items = modelPickItems({ observed: ["a/one"], configured: "b/two" });
    expect(items.filter((i) => i.modelId !== undefined).map((i) => i.modelId)).toEqual([
      "a/one",
      "b/two",
    ]);
    expect(items.at(-1)).toMatchObject({ action: "other" });
  });
});

describe("escapeCodicons", () => {
  it("neutralises a codicon so it renders as the characters the engine actually sent", () => {
    expect(escapeCodicons("$(check) Trusted")).toBe("\\$(check) Trusted");
  });

  it("neutralises every occurrence, including the spinning-modifier form", () => {
    expect(escapeCodicons("$(loading~spin)a$(check)b")).toBe("\\$(loading~spin)a\\$(check)b");
  });

  it("leaves an already-escaped sequence alone rather than doubling the backslash", () => {
    expect(escapeCodicons("\\$(check) x")).toBe("\\$(check) x");
  });

  it("touches nothing that is not codicon syntax", () => {
    for (const text of ["Fix the parser", "costs $5 (really)", "$()", "$(Not A Codicon)", "a$b"]) {
      expect(escapeCodicons(text)).toBe(text);
    }
  });
});

describe("engine-supplied strings reaching quick-pick fields", () => {
  it("does not let a session title render as a codicon glyph", () => {
    const items = sessionPickItems([header({ title: "$(check) Trusted session" })], { cwd: "/w" });
    expect(items[0]?.label).toBe("\\$(check) Trusted session");
  });

  it("does not let a session id render as one, in the label or the detail line", () => {
    const items = sessionPickItems([header({ sessionId: "$(shield)evil" })], { cwd: "/w" });
    expect(items[0]?.label).toBe("\\$(shield)evil");
    expect(items[0]?.detail).toContain("\\$(shield)evil");
  });

  it("does not let a model id the engine announced render as one", () => {
    const items = modelPickItems({ observed: ["$(verified) totally/safe"] });
    expect(items[0]?.label).toBe("\\$(verified) totally/safe");
  });

  it("does not let a catalogued model render one, in any rendered field", () => {
    const items = modelPickItems({
      observed: [],
      catalog: [
        entry({
          id: "$(verified) totally/safe",
          displayName: "$(check) Recommended",
          apiKeyEnv: "$(key) API_KEY",
        }),
      ],
    });
    expect(items[0]?.label).toBe("\\$(check) Recommended");
    expect(items[0]?.description).toContain("\\$(verified) totally/safe");
    expect(items[0]?.detail).toContain("\\$(key) API_KEY");
    // The id sent back to the engine is never rewritten.
    expect(items[0]?.modelId).toBe("$(verified) totally/safe");
  });

  it("does not let a workspace path render as one", () => {
    const items = sessionPickItems([], { cwd: "/w/$(check)" });
    expect(items.at(-1)?.detail).toBe("Start a new Arcturn session in /w/\\$(check)");
  });

  it("sanitizes the display only — the id sent to the engine stays byte-for-byte", () => {
    const items = sessionPickItems([header({ sessionId: "$(shield)evil" })], { cwd: "/w" });
    expect(items[0]?.sessionId).toBe("$(shield)evil");
    expect(modelPickItems({ observed: ["$(verified) m"] })[0]?.modelId).toBe("$(verified) m");
  });

  it("keeps the extension's own codicons live — those are not engine input", () => {
    expect(sessionPickItems([], { cwd: "/w" }).at(-1)?.label).toBe("$(add) New session");
    expect(modelPickItems({ observed: [] }).at(-1)?.label).toBe("$(edit) Enter a model id\u2026");
  });
});
