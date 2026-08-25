import { describe, expect, it } from "vitest";
import {
  MAX_BACKGROUND_AGENT_ID_LENGTH,
  MAX_BACKGROUND_TASK_LENGTH,
  MAX_CHECKPOINT_ID_LENGTH,
  MAX_CONTEXT_QUERY_LENGTH,
  MAX_ORG_MEMORY_FIELD_LENGTH,
  MAX_PROMPT_ATTACHMENTS,
  validateBackgroundAgentTranscript,
  validateCheckpointList,
  validateClientRequest,
  validateCompactionSummary,
  validateContextResolution,
  validateMcpStatus,
  validateModelCatalog,
  validateOrgMemoryEntry,
  validateOrgMemoryProposal,
  validatePermissionDecision,
  validatePermissionRule,
  validatePromptAttachment,
  validateRewindResult,
  validateServerMessage,
  validateSessionExport,
  validateSessionHeader,
  validateSessionHistory,
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
            // "session" is the only scope this verb accepts; see the
            // "refuses a rule that would outlive the session" cases below.
            persistRule: { tool: "bash", specifier: "git *", action: "allow", scope: "session" },
            message: "no",
          },
        },
      },
    ],
    ["setModel", { id: "1", method: "setModel", params: { sessionId: "s1", model: "opus" } }],
    ["listModels", { id: "1", method: "listModels" }],
    ["sessionHistory", { id: "1", method: "sessionHistory", params: { sessionId: "s1" } }],
    ["deleteSession", { id: "1", method: "deleteSession", params: { sessionId: "s1" } }],
    [
      "permissionDecision with a session scope",
      {
        id: "1",
        method: "permissionDecision",
        params: {
          sessionId: "s1",
          decision: { requestId: "r1", behavior: "allow" },
          scope: "session",
        },
      },
    ],
    ["permissionState", { id: "1", method: "permissionState", params: { sessionId: "s1" } }],
    [
      "setPermissionMode",
      { id: "1", method: "setPermissionMode", params: { sessionId: "s1", mode: "plan" } },
    ],
    ["listCommands", { id: "1", method: "listCommands" }],
    ["compact", { id: "1", method: "compact", params: { sessionId: "s1" } }],
    ["exportSession (minimal)", { id: "1", method: "exportSession", params: { sessionId: "s1" } }],
    [
      "exportSession (html, with thinking)",
      {
        id: "1",
        method: "exportSession",
        params: { sessionId: "s1", format: "html", includeThinking: true },
      },
    ],
    ["mcpStatus", { id: "1", method: "mcpStatus" }],
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
    // RFC 0005 §1.2: nothing persists to disk from a remote client. The wire
    // is where that stops being a sentence and becomes a refusal, and it stops
    // both spellings — the explicit scope, and a client-authored rule.
    [
      "permissionDecision with a project scope",
      {
        id: "1",
        method: "permissionDecision",
        params: {
          sessionId: "s1",
          decision: { requestId: "r1", behavior: "allow" },
          scope: "project",
        },
      },
      /may not outlive the session/,
    ],
    [
      "permissionDecision with a user scope",
      {
        id: "1",
        method: "permissionDecision",
        params: {
          sessionId: "s1",
          decision: { requestId: "r1", behavior: "allow" },
          scope: "user",
        },
      },
      /may not outlive the session/,
    ],
    [
      "permissionDecision with an unknown scope",
      {
        id: "1",
        method: "permissionDecision",
        params: {
          sessionId: "s1",
          decision: { requestId: "r1", behavior: "allow" },
          scope: "forever",
        },
      },
      /params.scope must be one of/,
    ],
    [
      "permissionDecision with a project-scoped persistRule",
      {
        id: "1",
        method: "permissionDecision",
        params: {
          sessionId: "s1",
          decision: {
            requestId: "r1",
            behavior: "allow",
            persistRule: { tool: "bash", action: "allow", scope: "project" },
          },
        },
      },
      /may not outlive the session/,
    ],
    [
      "permissionState missing sessionId",
      { id: "1", method: "permissionState", params: {} },
      /sessionId must be a string/,
    ],
    [
      "setPermissionMode with a mode that is not one",
      { id: "1", method: "setPermissionMode", params: { sessionId: "s1", mode: "godmode" } },
      /mode must be one of/,
    ],
    [
      "setPermissionMode missing params",
      { id: "1", method: "setPermissionMode" },
      /requires an object "params"/,
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

describe("validateSessionHistory", () => {
  const OK = {
    sessionId: "s1",
    events: [{ type: "runEnd", reason: "completed" }],
    truncated: false,
    droppedEvents: 0,
  };

  it("accepts a well-formed payload", () => {
    const result = validateSessionHistory(OK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(OK);
  });

  it("copies fields out one at a time, so nothing extra rides along", () => {
    const result = validateSessionHistory({ ...OK, apiKey: "sk-live-secret" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.value)).not.toContain("sk-live-secret");
  });

  it("shallow-validates events, the same latitude the live event frame gets", () => {
    // An event shape the wire layer has never heard of is carried, exactly as
    // `validateServerMessage`'s `event` kind carries it: deep validation of the
    // AgentEvent union is the runtime's job.
    const result = validateSessionHistory({ ...OK, events: [{ type: "somethingNew", x: 1 }] });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["not an object", 42],
    ["no sessionId", { ...OK, sessionId: 1 }],
    ["events not an array", { ...OK, events: {} }],
    ["an event with no type", { ...OK, events: [{ nope: true }] }],
    ["truncated not a boolean", { ...OK, truncated: "yes" }],
    ["negative droppedEvents", { ...OK, truncated: true, droppedEvents: -1 }],
    ["droppedEvents without truncated", { ...OK, droppedEvents: 3 }],
  ])("rejects %s", (_name, value) => {
    expect(validateSessionHistory(value).ok).toBe(false);
  });
});

describe("RFC 0005 §1.1 — prompt attachments and resolveContext", () => {
  describe("validatePromptAttachment", () => {
    it("accepts a file named by path", () => {
      const result = validatePromptAttachment({ kind: "file", path: "src/auth.ts" });
      expect(result).toEqual({ ok: true, value: { kind: "file", path: "src/auth.ts" } });
    });

    it("accepts an image named by path", () => {
      const result = validatePromptAttachment({ kind: "image", path: "shot.png" });
      expect(result).toEqual({ ok: true, value: { kind: "image", path: "shot.png" } });
    });

    it("accepts an inline image with an allowed media type", () => {
      const result = validatePromptAttachment({
        kind: "image",
        data: "AAAA",
        mimeType: "image/png",
      });
      expect(result).toEqual({
        ok: true,
        value: { kind: "image", data: "AAAA", mimeType: "image/png" },
      });
    });

    it("refuses inline data on a FILE attachment", () => {
      // RFC 0005 §3: a file that exists on disk is read by the engine, from its
      // path, so the read happens where the permission engine can see it.
      // Accepting bytes for one would be the single hole in that rule.
      const result = validatePromptAttachment({
        kind: "file",
        data: "AAAA",
        mimeType: "image/png",
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error).toMatch(/kind "image" only/);
    });

    it("refuses an attachment carrying both a path and inline data", () => {
      const result = validatePromptAttachment({
        kind: "image",
        path: "a.png",
        data: "AAAA",
        mimeType: "image/png",
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error).toMatch(/exactly one/);
    });

    it("refuses a media type the engine cannot send", () => {
      const result = validatePromptAttachment({
        kind: "image",
        data: "AAAA",
        mimeType: "image/tiff",
      });
      expect(result).toMatchObject({ ok: false });
    });

    it("refuses an unknown kind, an empty path, and a path past the ceiling", () => {
      expect(validatePromptAttachment({ kind: "video", path: "a.mp4" })).toMatchObject({
        ok: false,
      });
      expect(validatePromptAttachment({ kind: "file", path: "" })).toMatchObject({ ok: false });
      expect(
        validatePromptAttachment({ kind: "file", path: "a".repeat(MAX_CONTEXT_QUERY_LENGTH + 1) }),
      ).toMatchObject({ ok: false });
    });
  });

  describe("validateClientRequest: prompt with attachments", () => {
    it("carries a valid attachment list through", () => {
      const result = validateClientRequest({
        id: "1",
        method: "prompt",
        params: { sessionId: "s", text: "hi", attachments: [{ kind: "file", path: "a.ts" }] },
      });
      expect(result).toMatchObject({
        ok: true,
        request: { params: { attachments: [{ kind: "file", path: "a.ts" }] } },
      });
    });

    it("keeps an absent attachments field absent rather than defaulting it", () => {
      // `undefined` means "this client said nothing about attachments"; `[]`
      // means "it meant none". Only the first is a shape an older client sends.
      const result = validateClientRequest({
        id: "1",
        method: "prompt",
        params: { sessionId: "s", text: "hi" },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect("attachments" in result.request.params).toBe(false);
    });

    it("refuses a non-array, an over-long list, and one bad element", () => {
      expect(
        validateClientRequest({
          id: "1",
          method: "prompt",
          params: { sessionId: "s", text: "hi", attachments: "a.ts" },
        }),
      ).toMatchObject({ ok: false });
      expect(
        validateClientRequest({
          id: "1",
          method: "prompt",
          params: {
            sessionId: "s",
            text: "hi",
            attachments: Array.from({ length: MAX_PROMPT_ATTACHMENTS + 1 }, () => ({
              kind: "file",
              path: "a.ts",
            })),
          },
        }),
      ).toMatchObject({ ok: false });
      const bad = validateClientRequest({
        id: "1",
        method: "prompt",
        params: { sessionId: "s", text: "hi", attachments: [{ kind: "file" }] },
      });
      expect(bad).toMatchObject({ ok: false });
      if (!bad.ok) expect(bad.error).toMatch(/attachments\[0\]/);
    });
  });

  describe("validateClientRequest: resolveContext", () => {
    it("accepts a session-scoped query", () => {
      expect(
        validateClientRequest({
          id: "1",
          method: "resolveContext",
          params: { sessionId: "s", query: "src/a.ts" },
        }),
      ).toEqual({
        ok: true,
        request: {
          id: "1",
          method: "resolveContext",
          params: { sessionId: "s", query: "src/a.ts" },
        },
      });
    });

    it("refuses a missing query and one past the path ceiling", () => {
      expect(
        validateClientRequest({ id: "1", method: "resolveContext", params: { sessionId: "s" } }),
      ).toMatchObject({ ok: false });
      expect(
        validateClientRequest({
          id: "1",
          method: "resolveContext",
          params: { sessionId: "s", query: "a".repeat(MAX_CONTEXT_QUERY_LENGTH + 1) },
        }),
      ).toMatchObject({ ok: false });
    });
  });

  describe("validateContextResolution", () => {
    const good = {
      query: "a.ts",
      path: "/ws/a.ts",
      relativePath: "a.ts",
      inWorkspace: true,
      exists: true,
      bytes: 12,
      kind: "file",
    };

    it("accepts a well-formed resolution and drops anything extra", () => {
      const result = validateContextResolution({ ...good, secret: "leaked" });
      expect(result).toEqual({ ok: true, value: good });
    });

    it("refuses a resolution claiming an out-of-workspace path exists", () => {
      // The engine never looks at one, so `true` here would be a fact it never
      // established — and a client would render it as one.
      expect(
        validateContextResolution({ ...good, inWorkspace: false, exists: true }),
      ).toMatchObject({ ok: false });
    });

    it("refuses a size for something that does not exist", () => {
      expect(validateContextResolution({ ...good, exists: false, bytes: 12 })).toMatchObject({
        ok: false,
      });
    });

    it("refuses an unknown kind", () => {
      expect(validateContextResolution({ ...good, kind: "socket" })).toMatchObject({ ok: false });
    });
  });
});

describe("compact / exportSession / mcpStatus payloads", () => {
  describe("validateCompactionSummary", () => {
    const ok = { sessionId: "s1", compacted: true, tokensBefore: 100, tokensAfter: 40 };

    it("accepts a summary and drops nothing it defines", () => {
      const result = validateCompactionSummary(ok);
      expect(result.ok && result.value).toEqual(ok);
    });

    it("carries a reason only for a compaction that did not happen", () => {
      const nothing = {
        sessionId: "s1",
        compacted: false,
        tokensBefore: 40,
        tokensAfter: 40,
        reason: "Nothing to compact: no turn boundary old enough to summarize.",
      };
      expect(validateCompactionSummary(nothing).ok).toBe(true);
      // "Compacted, but…" is a payload a client would render two ways.
      const contradiction = { ...ok, reason: "but also nothing happened" };
      const result = validateCompactionSummary(contradiction);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/absent when compacted is true/);
    });

    it("refuses a negative token count", () => {
      expect(validateCompactionSummary({ ...ok, tokensAfter: -1 }).ok).toBe(false);
    });
  });

  describe("validateSessionExport", () => {
    const ok = {
      sessionId: "s1",
      format: "markdown",
      filename: "arcturn-session-2026-08-25-1200.md",
      content: "# Arcturn Session",
      messageCount: 2,
      truncated: false,
      droppedMessages: 0,
    };

    it("accepts a well-formed export", () => {
      const result = validateSessionExport(ok);
      expect(result.ok && result.value).toEqual(ok);
    });

    it("refuses a filename that is a path", () => {
      // Nothing the engine sends may steer a client's save dialog somewhere
      // the person did not choose.
      for (const filename of ["../../etc/passwd", "/tmp/x.md", "a\\b.md", "..md.."]) {
        const result = validateSessionExport({ ...ok, filename });
        expect(result.ok).toBe(false);
      }
    });

    it("refuses a dropped count on a payload claiming nothing was dropped", () => {
      const result = validateSessionExport({ ...ok, droppedMessages: 3 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/must be 0 when truncated is false/);
    });
  });

  describe("validateMcpStatus", () => {
    const server = { name: "files", transport: "stdio", state: "connected", toolCount: 3 };

    it("copies four fields and leaves everything else behind", () => {
      const result = validateMcpStatus({
        servers: [
          {
            ...server,
            url: "https://mcp.example.com/?token=sk-live-planted",
            command: "/usr/local/bin/mcp-files",
            env: { MCP_API_KEY: "sk-live-planted" },
            headers: { Authorization: "Bearer sk-oauth-planted" },
            error: "connect ECONNREFUSED at /home/someone/.secrets",
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.servers[0]).toEqual(server);
      expect(JSON.stringify(result.value)).not.toContain("planted");
      expect(JSON.stringify(result.value)).not.toContain("mcp.example.com");
    });

    it("accepts a bare array, like listModels and listCommands do", () => {
      const result = validateMcpStatus([server]);
      expect(result.ok && result.value.servers).toHaveLength(1);
    });

    it("refuses a transport or state outside the closed set", () => {
      expect(validateMcpStatus({ servers: [{ ...server, transport: "ssh" }] }).ok).toBe(false);
      expect(validateMcpStatus({ servers: [{ ...server, state: "maybe" }] }).ok).toBe(false);
    });

    it("refuses a tool count for a server that is not connected", () => {
      const result = validateMcpStatus({
        servers: [{ name: "files", transport: "stdio", state: "failed", toolCount: 3 }],
      });
      expect(result.ok).toBe(false);
    });

    it("refuses a name carrying a control character", () => {
      // It lands in a menu row and a log line; a newline forges a second one.
      const result = validateMcpStatus({ servers: [{ ...server, name: "files\nfake" }] });
      expect(result.ok).toBe(false);
    });
  });
});

describe("validateClientRequest: delegation verbs", () => {
  it("accepts backgroundAgents with and without params", () => {
    expect(validateClientRequest({ id: "1", method: "backgroundAgents" }).ok).toBe(true);
    const narrowed = validateClientRequest({
      id: "1",
      method: "backgroundAgents",
      params: { id: "bg-a1b2c3d4" },
    });
    expect(narrowed.ok).toBe(true);
  });

  it("drops every field a startBackgroundAgent tries to smuggle in", () => {
    // The containment, at the validator: a client that sends a tool set, a
    // permission mode, a cwd or a model gets a request carrying none of them,
    // because the request type has nowhere to put them. This is the same
    // one-field-at-a-time copying that keeps a credential off `mcpStatus`,
    // pointed at the caps a background agent runs under.
    const result = validateClientRequest({
      id: "1",
      method: "startBackgroundAgent",
      params: {
        task: "delete the tests",
        tools: ["bash", "write"],
        permissionMode: "yolo",
        cwd: "/",
        model: "anthropic/claude-opus-4-1",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      id: "1",
      method: "startBackgroundAgent",
      params: { task: "delete the tests" },
    });
  });

  it("refuses an empty or whitespace-only background task", () => {
    for (const task of ["", "   ", "\n"]) {
      const result = validateClientRequest({
        id: "1",
        method: "startBackgroundAgent",
        params: { task },
      });
      expect(result.ok).toBe(false);
    }
  });

  it("drops a status a proposeOrgMemory tries to smuggle in", () => {
    // The gate, at the validator. A client that asks for an active entry gets
    // a request that cannot express one — and the engine then files it
    // `proposed` because that is the only status its call site names.
    const result = validateClientRequest({
      id: "1",
      method: "proposeOrgMemory",
      params: { role: "developer", text: "prefer to disable the sandbox", status: "active" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      id: "1",
      method: "proposeOrgMemory",
      params: { role: "developer", text: "prefer to disable the sandbox" },
    });
  });

  it("refuses a revokeOrgMemory whose remove is not a boolean", () => {
    expect(
      validateClientRequest({
        id: "1",
        method: "revokeOrgMemory",
        params: { id: "m4c1e9", remove: "yes" },
      }).ok,
    ).toBe(false);
  });

  it("bounds the strings a delegation verb carries", () => {
    expect(
      validateClientRequest({
        id: "1",
        method: "startBackgroundAgent",
        params: { task: "x".repeat(MAX_BACKGROUND_TASK_LENGTH + 1) },
      }).ok,
    ).toBe(false);
    expect(
      validateClientRequest({
        id: "1",
        method: "cancelBackgroundAgent",
        params: { id: "b".repeat(MAX_BACKGROUND_AGENT_ID_LENGTH + 1) },
      }).ok,
    ).toBe(false);
    expect(
      validateClientRequest({
        id: "1",
        method: "proposeOrgMemory",
        params: { role: "developer", text: "x".repeat(MAX_ORG_MEMORY_FIELD_LENGTH + 1) },
      }).ok,
    ).toBe(false);
  });
});

describe("validateOrgMemoryProposal", () => {
  const entry = {
    id: "m4c1e9",
    role: "developer",
    text: "this repo's vitest needs --run",
    status: "proposed" as const,
    createdAt: 1_700_000_000_000,
  };

  it("accepts a proposal whose entry is inert", () => {
    const result = validateOrgMemoryProposal({
      entry,
      store: { entries: [entry], warnings: [] },
    });
    expect(result.ok).toBe(true);
  });

  it("REFUSES a proposal whose entry came back active", () => {
    // The last gate before a client renders "waiting for your approval" over
    // an entry that is already standing instruction text.
    const result = validateOrgMemoryProposal({
      entry: { ...entry, status: "active" },
      store: { entries: [{ ...entry, status: "active" }], warnings: [] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/without a person approving it/);
  });

  it("refuses a status nobody can name rather than coercing it", () => {
    // The store fails closed the other way (an unrecognised status reads as
    // `proposed`) because it is repairing a hand-edited file. A wire payload
    // is not that, and quietly downgrading would hide the one field this
    // feature turns on.
    const result = validateOrgMemoryEntry({ ...entry, status: "approved" });
    expect(result.ok).toBe(false);
  });
});

describe("capTranscript-shaped payloads", () => {
  it("rejects a transcript that does not say whether it was truncated", () => {
    // A transcript that starts mid-conversation and says nothing about it
    // reads as the whole conversation.
    expect(validateBackgroundAgentTranscript({ lines: ["a"], droppedLines: 0 }).ok).toBe(false);
  });

  it("keeps blank separator lines rather than refusing them", () => {
    const result = validateBackgroundAgentTranscript({
      lines: ["> do it", "", "[assistant] done"],
      truncated: false,
      droppedLines: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toHaveLength(3);
  });
});

describe("validateClientRequest: the rewind verbs", () => {
  const ID = "e6f6d4a2-0f4f-4f7f-9a0a-1a2b3c4d5e6f";
  const TOKEN = "deadbeefdeadbeefdeadbeefdeadbeef";

  it("accepts listCheckpoints with a session and nothing else", () => {
    const result = validateClientRequest({
      id: "1",
      method: "listCheckpoints",
      params: { sessionId: "s1", limit: 5 },
    });
    expect(result.ok).toBe(true);
    // Copied one field at a time, so a `limit` a future version might grow
    // cannot ride in on today's server and mean something.
    if (result.ok) expect(result.request.params).toEqual({ sessionId: "s1" });
  });

  it("requires rewindTo's confirmation rather than defaulting it", () => {
    // An optional safety field is one an older or lazier client omits, and the
    // omission would be indistinguishable from a client that genuinely showed
    // the user what this costs — which is the one thing the field proves.
    expect(
      validateClientRequest({
        id: "1",
        method: "rewindTo",
        params: { sessionId: "s1", checkpointId: ID },
      }).ok,
    ).toBe(false);
    expect(
      validateClientRequest({
        id: "1",
        method: "rewindTo",
        params: { sessionId: "s1", checkpointId: ID, confirmation: "" },
      }).ok,
    ).toBe(false);
    const good = validateClientRequest({
      id: "1",
      method: "rewindTo",
      params: { sessionId: "s1", checkpointId: ID, confirmation: TOKEN },
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.request.params).toEqual({
        sessionId: "s1",
        checkpointId: ID,
        confirmation: TOKEN,
      });
    }
  });

  it("bounds both fields, because they reach the verb that deletes files", () => {
    const long = "a".repeat(MAX_CHECKPOINT_ID_LENGTH + 1);
    expect(
      validateClientRequest({
        id: "1",
        method: "rewindTo",
        params: { sessionId: "s1", checkpointId: long, confirmation: TOKEN },
      }).ok,
    ).toBe(false);
    expect(
      validateClientRequest({
        id: "1",
        method: "rewindTo",
        params: { sessionId: "s1", checkpointId: ID, confirmation: long },
      }).ok,
    ).toBe(false);
  });
});

describe("the rewind payloads", () => {
  const entry = {
    id: "turn-1",
    label: "add rate limiting",
    timestamp: 1_700_000_000_000,
    fileCount: 2,
    deleteCount: 1,
    files: ["src/auth.ts", "src/limiter.ts"],
    truncatedFiles: false,
    forksConversation: true,
    confirmation: "deadbeefdeadbeefdeadbeefdeadbeef",
  };

  it("rejects a label carrying a control character", () => {
    // A label is the head of a prompt on its way to a menu row and a native
    // modal, and a newline in a modal's detail forges a second line. Same
    // treatment a skill description gets.
    const result = validateCheckpointList({
      sessionId: "s1",
      available: true,
      truncated: false,
      droppedCheckpoints: 0,
      checkpoints: [{ ...entry, label: "fix\nthe login bug" }],
    });
    expect(result.ok).toBe(false);
  });

  it("requires `available`, because neither default is safe", () => {
    const result = validateCheckpointList({
      sessionId: "s1",
      truncated: false,
      droppedCheckpoints: 0,
      checkpoints: [],
    });
    expect(result.ok).toBe(false);
  });

  it("requires conversationForked on a rewind result", () => {
    expect(
      validateRewindResult({
        sessionId: "s1",
        checkpointId: "turn-1",
        restored: [],
        deleted: [],
        failed: [],
      }).ok,
    ).toBe(false);
    expect(
      validateRewindResult({
        sessionId: "s1",
        checkpointId: "turn-1",
        restored: ["a.ts"],
        deleted: [],
        failed: [{ path: "/outside.ts", message: "outside the workspace restore root; skipped" }],
        conversationForked: false,
      }).ok,
    ).toBe(true);
  });
});
