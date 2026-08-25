import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry, SessionHeader } from "../serve/engine.js";
import { CONNECTION_ACTIONS } from "./connection-card.js";
import {
  MAX_COPY_LENGTH,
  MAX_MODEL_ID_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_SESSION_ID_LENGTH,
  parseWebviewMessage,
  projectModelOption,
  projectSessions,
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
    expect(parseWebviewMessage({ type: "requestSessions" })).toEqual({ type: "requestSessions" });
    expect(parseWebviewMessage({ type: "openSession", sessionId: "01JABC" })).toEqual({
      type: "openSession",
      sessionId: "01JABC",
    });
    expect(parseWebviewMessage({ type: "setModel", modelId: "anthropic/claude-sonnet-5" })).toEqual(
      { type: "setModel", modelId: "anthropic/claude-sonnet-5" },
    );
    expect(parseWebviewMessage({ type: "deleteSession", sessionId: "01JABC" })).toEqual({
      type: "deleteSession",
      sessionId: "01JABC",
    });
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
      { type: "openSession" },
      { type: "openSession", sessionId: 42 },
      { type: "openSession", sessionId: "   " },
      { type: "deleteSession" },
      { type: "deleteSession", sessionId: 42 },
      { type: "deleteSession", sessionId: "   " },
      { type: "deleteSession", sessionId: null },
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

describe("the session list's boundary", () => {
  it("refuses a control character, which would carry a newline into a log line", () => {
    for (const sessionId of ["a\nb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb"]) {
      expect(parseWebviewMessage({ type: "openSession", sessionId })).toBeUndefined();
    }
  });

  it("caps the id rather than forwarding an unbounded string to openSession", () => {
    expect(
      parseWebviewMessage({ type: "openSession", sessionId: "x".repeat(MAX_SESSION_ID_LENGTH) }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({
        type: "openSession",
        sessionId: "x".repeat(MAX_SESSION_ID_LENGTH + 1),
      }),
    ).toBeUndefined();
  });

  it("trims the id so the engine is asked for what the user meant", () => {
    expect(parseWebviewMessage({ type: "openSession", sessionId: "  01JABC  " })).toEqual({
      type: "openSession",
      sessionId: "01JABC",
    });
  });

  it("holds the destructive verb to exactly the same boundary rules", () => {
    // The confirmation lives in the host and the deletion in the engine; what
    // this boundary owes is a rebuilt, bounded, control-character-free id.
    for (const sessionId of ["a\nb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb"]) {
      expect(parseWebviewMessage({ type: "deleteSession", sessionId })).toBeUndefined();
    }
    expect(
      parseWebviewMessage({
        type: "deleteSession",
        sessionId: "x".repeat(MAX_SESSION_ID_LENGTH + 1),
      }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "deleteSession", sessionId: "  01JABC  " })).toEqual({
      type: "deleteSession",
      sessionId: "01JABC",
    });
  });

  it("rebuilds the message rather than spreading whatever arrived", () => {
    expect(
      parseWebviewMessage({ type: "deleteSession", sessionId: "01JABC", andAlso: "rm -rf /" }),
    ).toEqual({ type: "deleteSession", sessionId: "01JABC" });
  });
});

describe("projectSessions", () => {
  const header = (over: Partial<SessionHeader> & { sessionId: string }): SessionHeader => ({
    version: 1,
    cwd: "/w",
    createdAt: 1_700_000_000_000,
    ...over,
  });

  it("keeps only the sessions started in this workspace", () => {
    const rows = projectSessions(
      [header({ sessionId: "mine" }), header({ sessionId: "elsewhere", cwd: "/other" })],
      "/w",
    );
    expect(rows.map((row) => row.sessionId)).toEqual(["mine"]);
  });

  it("treats a trailing separator as the same directory, not a second one", () => {
    expect(projectSessions([header({ sessionId: "s", cwd: "/w/" })], "/w")).toHaveLength(1);
    expect(projectSessions([header({ sessionId: "s", cwd: "/w" })], "/w/")).toHaveLength(1);
  });

  it("rebuilds the row field by field instead of forwarding the engine's header", () => {
    const [row] = projectSessions([header({ sessionId: "s", title: "Rebuild" })], "/w");
    expect(Object.keys(row ?? {}).sort()).toEqual(["createdAt", "sessionId", "title"]);
  });

  it("carries a field the engine adds nowhere", () => {
    const extended = { ...header({ sessionId: "s" }), secretHint: "sk-live-1234" } as SessionHeader;
    expect(JSON.stringify(projectSessions([extended], "/w"))).not.toContain("sk-live-1234");
  });

  it("reports a missing title as empty rather than inventing one", () => {
    expect(projectSessions([header({ sessionId: "s" })], "/w")[0]?.title).toBe("");
  });

  it("reports an unusable timestamp as zero rather than as 1970", () => {
    const broken = { ...header({ sessionId: "s" }), createdAt: Number.NaN } as SessionHeader;
    expect(projectSessions([broken], "/w")[0]?.createdAt).toBe(0);
  });

  it("drops a header with no id, which no verb could be called with", () => {
    const nameless = { ...header({ sessionId: "" }) } as SessionHeader;
    expect(projectSessions([nameless, header({ sessionId: "s" })], "/w")).toHaveLength(1);
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
