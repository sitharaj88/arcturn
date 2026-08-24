import { describe, expect, it } from "vitest";
import { CONNECTION_ACTIONS } from "./connection-card.js";
import { MAX_PROMPT_LENGTH, parseWebviewMessage } from "./webview-messages.js";

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
