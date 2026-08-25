import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../serve/engine.js";
import { CONNECTION_ACTIONS } from "./connection-card.js";
import {
  MAX_COPY_LENGTH,
  MAX_MODEL_ID_LENGTH,
  MAX_PROMPT_LENGTH,
  parseWebviewMessage,
  projectModelOption,
} from "./webview-messages.js";

describe("parseWebviewMessage", () => {
  it("accepts the messages the webview is allowed to send", () => {
    expect(parseWebviewMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebviewMessage({ type: "abort" })).toEqual({ type: "abort" });
    expect(parseWebviewMessage({ type: "action", id: "reconnect" })).toEqual({
      type: "action",
      id: "reconnect",
    });
    expect(parseWebviewMessage({ type: "send", text: "hi" })).toEqual({ type: "send", text: "hi" });
    expect(parseWebviewMessage({ type: "toggle", blockId: "b1" })).toEqual({
      type: "toggle",
      blockId: "b1",
    });
    expect(parseWebviewMessage({ type: "command", command: "model" })).toEqual({
      type: "command",
      command: "model",
    });
    expect(parseWebviewMessage({ type: "requestModels" })).toEqual({ type: "requestModels" });
    expect(parseWebviewMessage({ type: "setModel", modelId: "anthropic/claude-sonnet-5" })).toEqual(
      { type: "setModel", modelId: "anthropic/claude-sonnet-5" },
    );
    expect(parseWebviewMessage({ type: "copy", text: "npm test" })).toEqual({
      type: "copy",
      text: "npm test",
    });
  });

  it("rejects anything that is not a known message", () => {
    for (const value of [
      undefined,
      null,
      "send",
      42,
      [],
      {},
      { type: "eval" },
      { type: "command", command: "rm" },
      { type: "send" },
      { type: "send", text: 42 },
      { type: "send", text: "   " },
      { type: "toggle" },
      { type: "toggle", blockId: 7 },
      { type: "reconnect" },
      { type: "action" },
      { type: "action", id: "openSettings" },
      { type: "action", id: "executeCommand" },
      { type: "action", id: 3 },
      { type: "setModel" },
      { type: "setModel", modelId: 42 },
      { type: "setModel", modelId: "   " },
      { type: "copy" },
      { type: "copy", text: "" },
      { type: "copy", text: 1 },
    ]) {
      expect(parseWebviewMessage(value)).toBeUndefined();
    }
  });

  it("drops extra properties rather than passing them through", () => {
    const parsed = parseWebviewMessage({ type: "send", text: "hi", __proto__: { evil: true } });
    expect(parsed).toEqual({ type: "send", text: "hi" });
    expect(Object.keys(parsed ?? {})).toEqual(["type", "text"]);
  });

  it("refuses a prompt larger than the cap instead of posting it to the engine", () => {
    expect(
      parseWebviewMessage({ type: "send", text: "x".repeat(MAX_PROMPT_LENGTH) }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({ type: "send", text: "x".repeat(MAX_PROMPT_LENGTH + 1) }),
    ).toBeUndefined();
  });

  it("refuses an absurd block id", () => {
    expect(parseWebviewMessage({ type: "toggle", blockId: "x".repeat(500) })).toBeUndefined();
  });
});

describe("the connection card's actions", () => {
  it("accepts every action the card is allowed to offer, and nothing else", () => {
    for (const id of CONNECTION_ACTIONS) {
      expect(parseWebviewMessage({ type: "action", id })).toEqual({ type: "action", id });
    }
    expect(parseWebviewMessage({ type: "action", id: "arcturn.installCli" })).toBeUndefined();
  });
});

describe("the model selector's boundary", () => {
  it("trims the id so the engine is asked for what the user meant", () => {
    expect(parseWebviewMessage({ type: "setModel", modelId: "  openai/gpt-5  " })).toEqual({
      type: "setModel",
      modelId: "openai/gpt-5",
    });
  });

  it("refuses a control character, which would carry a newline into a log line", () => {
    for (const modelId of ["a\nb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb", "model\u0007"]) {
      expect(parseWebviewMessage({ type: "setModel", modelId })).toBeUndefined();
    }
  });

  it("caps the id rather than forwarding an unbounded string to setModel", () => {
    expect(
      parseWebviewMessage({ type: "setModel", modelId: "x".repeat(MAX_MODEL_ID_LENGTH) }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({ type: "setModel", modelId: "x".repeat(MAX_MODEL_ID_LENGTH + 1) }),
    ).toBeUndefined();
  });

  it("does not validate the id against a catalog — that is the engine's answer to give", () => {
    // picker.ts has always offered a free-text row for exactly this reason: an
    // extension may register a model the catalog does not list, and setModel
    // validates server-side. Refusing an unknown id here would be a second,
    // local, drifting copy of the provider table.
    expect(parseWebviewMessage({ type: "setModel", modelId: "some/unlisted-model" })).toEqual({
      type: "setModel",
      modelId: "some/unlisted-model",
    });
  });

  it("caps clipboard text at the transcript's own ceiling", () => {
    expect(parseWebviewMessage({ type: "copy", text: "x".repeat(MAX_COPY_LENGTH) })).toBeDefined();
    expect(
      parseWebviewMessage({ type: "copy", text: "x".repeat(MAX_COPY_LENGTH + 1) }),
    ).toBeUndefined();
  });
});

describe("projectModelOption", () => {
  const entry: ModelCatalogEntry = {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 3, output: 15 },
    apiKeyEnv: "ANTHROPIC_API_KEY",
    credentials: "present",
  };

  it("rebuilds the row field by field instead of forwarding the engine's object", () => {
    const option = projectModelOption(entry);
    expect(Object.keys(option).sort()).toEqual([
      "apiKeyEnv",
      "contextWindow",
      "cost",
      "credentials",
      "displayName",
      "id",
      "provider",
    ]);
    // maxOutputTokens is not rendered, so it is not sent.
    expect("maxOutputTokens" in option).toBe(false);
  });

  it("carries a field the engine adds nowhere", () => {
    const extended = { ...entry, secretHint: "sk-live-1234" } as ModelCatalogEntry;
    expect(JSON.stringify(projectModelOption(extended))).not.toContain("sk-live-1234");
  });

  it("keeps an absent price absent rather than turning it into zero", () => {
    const { cost: _cost, ...unpriced } = entry;
    const option = projectModelOption(unpriced as ModelCatalogEntry);
    expect("cost" in option).toBe(false);
  });

  it("falls back to the id when the catalog has no display name", () => {
    expect(projectModelOption({ ...entry, displayName: "" }).displayName).toBe(entry.id);
  });

  it("carries the variable's name and never a value", () => {
    expect(projectModelOption(entry).apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(projectModelOption({ ...entry, apiKeyEnv: undefined }).apiKeyEnv).toBeUndefined();
  });
});
