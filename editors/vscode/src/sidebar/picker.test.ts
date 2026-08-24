import { describe, expect, it } from "vitest";
import type { SessionHeader } from "../serve/engine.js";
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

  it("always ends with a free-text entry, since the protocol exposes no catalog", () => {
    const items = modelPickItems({ observed: ["a/one"] });
    expect(items.at(-1)).toMatchObject({ action: "other" });
    expect(items.at(-1)?.modelId).toBeUndefined();
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
