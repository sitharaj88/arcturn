import { describe, expect, it } from "vitest";
import {
  validateClientRequest,
  validateModelCatalog,
  validatePermissionDecision,
  validatePermissionRule,
  validateServerMessage,
  validateSessionHeader,
} from "./validate.js";

describe("validateClientRequest: accepts every method", () => {
  const cases: Array<[string, unknown]> = [
    ["listSessions", { id: "1", method: "listSessions" }],
    ["createSession (minimal)", { id: "1", method: "createSession", params: { cwd: "/repo" } }],
    [
      "createSession (with model)",
      { id: "1", method: "createSession", params: { cwd: "/repo", model: "opus" } },
    ],
    ["openSession", { id: "1", method: "openSession", params: { sessionId: "s1" } }],
    ["prompt", { id: "1", method: "prompt", params: { sessionId: "s1", text: "hi" } }],
    ["steer", { id: "1", method: "steer", params: { sessionId: "s1", text: "hi" } }],
    ["abort", { id: "1", method: "abort", params: { sessionId: "s1" } }],
    [
      "permissionDecision",
      {
        id: "1",
        method: "permissionDecision",
        params: {
          sessionId: "s1",
          decision: { requestId: "r1", behavior: "allow" },
        },
      },
    ],
    [
      "permissionDecision with persistRule + message",
      {
        id: "1",
        method: "permissionDecision",
        params: {
          sessionId: "s1",
          decision: {
            requestId: "r1",
            behavior: "deny",
            persistRule: { tool: "bash", specifier: "git *", action: "allow", scope: "project" },
            message: "no",
          },
        },
      },
    ],
    ["setModel", { id: "1", method: "setModel", params: { sessionId: "s1", model: "opus" } }],
    ["listModels", { id: "1", method: "listModels" }],
  ];

  it.each(cases)("%s", (_name, value) => {
    const result = validateClientRequest(value);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request).toEqual(value);
    }
  });
});

describe("validateClientRequest: rejects corrupt shapes", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["non-object", "nope", /must be a JSON object/],
    ["null", null, /must be a JSON object/],
    ["array", [1, 2, 3], /must be a JSON object/],
    ["missing id", { method: "listSessions" }, /string "id"/],
    ["non-string id", { id: 5, method: "listSessions" }, /string "id"/],
    ["missing method", { id: "1" }, /string "method"/],
    ["unknown method", { id: "1", method: "doStuff" }, /Unknown method: "doStuff"/],
    [
      "createSession missing params",
      { id: "1", method: "createSession" },
      /createSession requires an object "params"/,
    ],
    [
      "createSession missing cwd",
      { id: "1", method: "createSession", params: {} },
      /params\.cwd must be a string/,
    ],
    [
      "createSession mistyped cwd",
      { id: "1", method: "createSession", params: { cwd: 5 } },
      /params\.cwd must be a string/,
    ],
    [
      "createSession mistyped model",
      { id: "1", method: "createSession", params: { cwd: "/repo", model: 5 } },
      /params\.model must be a string/,
    ],
    [
      "openSession missing sessionId",
      { id: "1", method: "openSession", params: {} },
      /sessionId must be a string/,
    ],
    [
      "prompt missing text",
      { id: "1", method: "prompt", params: { sessionId: "s1" } },
      /text must be a string/,
    ],
    [
      "steer missing sessionId",
      { id: "1", method: "steer", params: { text: "hi" } },
      /sessionId must be a string/,
    ],
    ["abort missing params", { id: "1", method: "abort" }, /abort requires an object "params"/],
    [
      "permissionDecision missing decision",
      { id: "1", method: "permissionDecision", params: { sessionId: "s1" } },
      /params\.decision invalid/,
    ],
    [
      "permissionDecision bad behavior",
      {
        id: "1",
        method: "permissionDecision",
        params: { sessionId: "s1", decision: { requestId: "r1", behavior: "maybe" } },
      },
      /behavior must be one of/,
    ],
    [
      "setModel missing model",
      { id: "1", method: "setModel", params: { sessionId: "s1" } },
      /model must be a string/,
    ],
  ];

  it.each(cases)("%s", (_name, value, expected) => {
    const result = validateClientRequest(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(expected);
    }
  });
});

describe("validateServerMessage: accepts every kind", () => {
  const cases: Array<[string, unknown]> = [
    ["response with result", { kind: "response", id: "1", result: { ok: true } }],
    ["response with result: null", { kind: "response", id: "1", result: null }],
    [
      "response with error",
      { kind: "response", id: "1", error: { code: "internal", message: "boom" } },
    ],
    [
      "event (shallow-validated payload)",
      { kind: "event", sessionId: "s1", event: { type: "turnStart", turnIndex: 0 } },
    ],
    ["sessions (empty)", { kind: "sessions", sessions: [] }],
    [
      "sessions (with headers)",
      {
        kind: "sessions",
        sessions: [
          { version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1000 },
          { version: 1, sessionId: "s2", cwd: "/other", createdAt: 2000, title: "t" },
        ],
      },
    ],
  ];

  it.each(cases)("%s", (_name, value) => {
    const result = validateServerMessage(value);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual(value);
    }
  });
});

describe("validateServerMessage: rejects corrupt shapes", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["non-object", 42, /must be a JSON object/],
    ["missing kind", {}, /string "kind"/],
    ["unknown kind", { kind: "ping" }, /Unknown kind: "ping"/],
    ["response missing id", { kind: "response", result: {} }, /requires a string "id"/],
    [
      "response with both result and error",
      {
        kind: "response",
        id: "1",
        result: {},
        error: { code: "internal", message: "x" },
      },
      /must not have both/,
    ],
    [
      "response with neither result nor error",
      { kind: "response", id: "1" },
      /must have either "result" or "error"/,
    ],
    [
      "response error missing message",
      { kind: "response", id: "1", error: { code: "internal" } },
      /error\.message must be a string/,
    ],
    [
      "event missing sessionId",
      { kind: "event", event: { type: "turnStart" } },
      /requires a string "sessionId"/,
    ],
    [
      "event with non-object event",
      { kind: "event", sessionId: "s1", event: "oops" },
      /object with a string "type"/,
    ],
    [
      "event with event.type not a string",
      { kind: "event", sessionId: "s1", event: { type: 5 } },
      /object with a string "type"/,
    ],
    ["sessions not an array", { kind: "sessions", sessions: {} }, /requires an array "sessions"/],
    [
      "sessions with a corrupt header",
      { kind: "sessions", sessions: [{ version: 2, sessionId: "s1", cwd: "/x", createdAt: 1 }] },
      /sessions\[0\] invalid.*version must be 1/,
    ],
  ];

  it.each(cases)("%s", (_name, value, expected) => {
    const result = validateServerMessage(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(expected);
    }
  });
});

describe("validatePermissionRule", () => {
  it("accepts a full rule", () => {
    const rule = { tool: "bash", specifier: "git *", action: "ask", scope: "user" };
    const result = validatePermissionRule(rule);
    expect(result).toEqual({ ok: true, value: rule });
  });

  it("rejects an invalid action", () => {
    const result = validatePermissionRule({ tool: "bash", action: "sometimes", scope: "user" });
    expect(result.ok).toBe(false);
  });
});

describe("validatePermissionDecision", () => {
  it("rejects a malformed persistRule", () => {
    const result = validatePermissionDecision({
      requestId: "r1",
      behavior: "allow",
      persistRule: { tool: "bash", action: "allow", scope: "galaxy" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/persistRule invalid/);
  });
});

describe("validateSessionHeader", () => {
  it("accepts a minimal header", () => {
    const header = { version: 1, sessionId: "s1", cwd: "/repo", createdAt: 0 };
    expect(validateSessionHeader(header)).toEqual({ ok: true, value: header });
  });

  it("rejects createdAt as a non-number", () => {
    const result = validateSessionHeader({
      version: 1,
      sessionId: "s1",
      cwd: "/repo",
      createdAt: "yesterday",
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateModelCatalog", () => {
  const entry = {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    apiKeyEnv: "ANTHROPIC_API_KEY",
    credentials: "present",
  };

  it("accepts a catalog and preserves every documented field", () => {
    const result = validateModelCatalog({ models: [entry] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.models[0]).toEqual(entry);
  });

  it("accepts a bare array, like listSessions does", () => {
    const result = validateModelCatalog([entry]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.models).toHaveLength(1);
  });

  it("keeps an unpriced model distinguishable from a free one", () => {
    const result = validateModelCatalog({
      models: [
        {
          id: "a/unpriced",
          provider: "a",
          displayName: "Unpriced",
          contextWindow: 8_000,
          credentials: "unknown",
        },
        {
          id: "a/free",
          provider: "a",
          displayName: "Free",
          contextWindow: 8_000,
          cost: { input: 0, output: 0 },
          credentials: "unknown",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.models[0]?.cost).toBeUndefined();
    expect(result.value.models[1]?.cost).toEqual({ input: 0, output: 0 });
  });

  it("drops any field the contract does not define, so a leaked secret cannot ride along", () => {
    const result = validateModelCatalog({
      models: [{ ...entry, apiKey: "sk-live-do-not-ship", token: "t" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).not.toContain("sk-live-do-not-ship");
    expect(Object.hasOwn(result.value.models[0] as object, "apiKey")).toBe(false);
  });

  it("rejects entries that are not the documented shape", () => {
    expect(validateModelCatalog({ models: "nope" }).ok).toBe(false);
    expect(validateModelCatalog({ models: [null] }).ok).toBe(false);
    expect(validateModelCatalog({ models: [{ ...entry, contextWindow: "big" }] }).ok).toBe(false);
    expect(validateModelCatalog({ models: [{ ...entry, credentials: "maybe" }] }).ok).toBe(false);
    expect(validateModelCatalog({ models: [{ ...entry, cost: { input: 1 } }] }).ok).toBe(false);
  });
});
