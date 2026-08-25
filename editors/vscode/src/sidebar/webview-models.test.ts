/**
 * The in-panel model list, driven as functions.
 *
 * Same technique as `webview-markdown.test.ts`: `MODEL_LIST_SOURCE` is the
 * text the webview runs, compiled here so these tests exercise the shipped
 * bytes. Everything under test is pure — a catalog in, an ordering or a
 * sentence out — so there is no DOM and no `vscode`.
 */

import { describe, expect, it } from "vitest";
import { MODEL_LIST_SOURCE, type ModelGroup, type ModelOption } from "./webview-models.js";

const api = new Function(
  `${MODEL_LIST_SOURCE}\nreturn { orderModels, filterModels, modelGroup, modelMeta, modelChipLabel };`,
)() as {
  orderModels: (models: ModelOption[], currentId?: string) => ModelOption[];
  filterModels: (models: ModelOption[], query: string) => ModelOption[];
  modelGroup: (model: ModelOption, currentId?: string) => ModelGroup;
  modelMeta: (model: ModelOption) => string;
  modelChipLabel: (models: ModelOption[], currentId?: string) => string;
};

function model(over: Partial<ModelOption> & { id: string }): ModelOption {
  return {
    displayName: over.id,
    provider: over.id.split("/")[0] ?? "",
    contextWindow: 200_000,
    credentials: "absent",
    ...over,
  };
}

const catalog: ModelOption[] = [
  model({ id: "z/zeta", displayName: "Zeta", credentials: "present" }),
  model({ id: "a/alpha", displayName: "Alpha", credentials: "absent" }),
  model({ id: "m/mu", displayName: "Mu", credentials: "unknown" }),
  model({ id: "b/beta", displayName: "Beta", credentials: "present" }),
];

describe("modelGroup", () => {
  it("puts the model in use in its own band, above everything", () => {
    expect(api.modelGroup(model({ id: "a/alpha" }), "a/alpha")).toBe("current");
  });

  it("separates a model the server holds a key for from one it cannot tell about", () => {
    expect(api.modelGroup(model({ id: "x", credentials: "present" }))).toBe("ready");
    expect(api.modelGroup(model({ id: "x", credentials: "unknown" }))).toBe("unknown");
    expect(api.modelGroup(model({ id: "x", credentials: "absent" }))).toBe("absent");
  });
});

describe("orderModels", () => {
  it("shows the model in use, then usable models, then unknown, then unusable", () => {
    expect(api.orderModels(catalog, "a/alpha").map((entry) => entry.id)).toEqual([
      "a/alpha",
      "b/beta",
      "z/zeta",
      "m/mu",
    ]);
  });

  it("sorts by the name that is on screen, not by the id behind it", () => {
    const ordered = api.orderModels(
      [
        model({ id: "a/zzz", displayName: "Aardvark", credentials: "present" }),
        model({ id: "a/aaa", displayName: "Zebra", credentials: "present" }),
      ],
      undefined,
    );
    expect(ordered.map((entry) => entry.displayName)).toEqual(["Aardvark", "Zebra"]);
  });

  it("does not reorder the caller's array", () => {
    const input = catalog.slice();
    api.orderModels(input, "m/mu");
    expect(input.map((entry) => entry.id)).toEqual(catalog.map((entry) => entry.id));
  });
});

describe("filterModels", () => {
  it("returns everything for an empty query", () => {
    expect(api.filterModels(catalog, "").length).toBe(catalog.length);
    expect(api.filterModels(catalog, "   ").length).toBe(catalog.length);
  });

  it("matches the id, the display name, the provider and the key variable", () => {
    expect(api.filterModels(catalog, "zeta").map((entry) => entry.id)).toEqual(["z/zeta"]);
    expect(api.filterModels(catalog, "MU").map((entry) => entry.id)).toEqual(["m/mu"]);
    expect(api.filterModels(catalog, "b/").map((entry) => entry.id)).toEqual(["b/beta"]);
    expect(
      api
        .filterModels([model({ id: "o/one", apiKeyEnv: "OPENAI_API_KEY" })], "openai_api")
        .map((entry) => entry.id),
    ).toEqual(["o/one"]);
  });

  it("requires every token to match, so a second word narrows instead of widening", () => {
    const models = [
      model({ id: "anthropic/sonnet", displayName: "Claude Sonnet 5" }),
      model({ id: "anthropic/opus", displayName: "Claude Opus 5" }),
    ];
    expect(api.filterModels(models, "claude").length).toBe(2);
    expect(api.filterModels(models, "claude opus").map((entry) => entry.id)).toEqual([
      "anthropic/opus",
    ]);
    expect(api.filterModels(models, "claude gemini")).toEqual([]);
  });
});

describe("modelMeta", () => {
  it("prints context, price and the credential the server looked for", () => {
    expect(
      api.modelMeta(
        model({
          id: "anthropic/claude-sonnet-5",
          contextWindow: 200_000,
          cost: { input: 3, output: 15 },
          apiKeyEnv: "ANTHROPIC_API_KEY",
          credentials: "present",
        }),
      ),
    ).toBe("200k ctx · $3/$15 per Mtok · ANTHROPIC_API_KEY set");
  });

  it("says pricing is unknown rather than printing a free-looking zero", () => {
    expect(api.modelMeta(model({ id: "x/y" }))).toContain("pricing unknown");
    expect(api.modelMeta(model({ id: "x/y", cost: { input: 0, output: 0 } }))).toContain(
      "$0/$0 per Mtok",
    );
  });

  it("never turns 'the server could not tell' into 'you cannot use this'", () => {
    const meta = api.modelMeta(
      model({ id: "local/llama", credentials: "unknown", apiKeyEnv: "OPENAI_BASE_URL" }),
    );
    expect(meta).toContain("OPENAI_BASE_URL: credentials unknown");
    expect(meta).not.toContain("not set");
  });

  it("drops the context window rather than printing 0k for a catalog that omitted it", () => {
    expect(api.modelMeta(model({ id: "x/y", contextWindow: 0 }))).not.toContain("0k ctx");
  });
});

describe("modelChipLabel", () => {
  it("shows the display name when the catalog carries the model", () => {
    expect(api.modelChipLabel(catalog, "b/beta")).toBe("Beta");
  });

  it("falls back to the raw id for a model the catalog does not carry", () => {
    expect(api.modelChipLabel(catalog, "extension/registered")).toBe("extension/registered");
    expect(api.modelChipLabel([], "extension/registered")).toBe("extension/registered");
  });

  it("invites a choice when no model is known yet", () => {
    expect(api.modelChipLabel(catalog, undefined)).toBe("Select model");
    expect(api.modelChipLabel(catalog, "")).toBe("Select model");
  });
});
