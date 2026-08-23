import { describe, expect, it } from "vitest";
import { ErrorCode, errorResponse, eventMessage, okResponse, sessionsMessage } from "./messages.js";
import { validateServerMessage } from "./validate.js";

describe("message builders", () => {
  it("okResponse builds a response with a result", () => {
    const msg = okResponse("1", { hello: "world" });
    expect(msg).toEqual({ kind: "response", id: "1", result: { hello: "world" } });
    expect(validateServerMessage(msg).ok).toBe(true);
  });

  it("errorResponse builds a response with an error", () => {
    const msg = errorResponse("1", ErrorCode.sessionNotFound, "no such session");
    expect(msg).toEqual({
      kind: "response",
      id: "1",
      error: { code: "sessionNotFound", message: "no such session" },
    });
    expect(validateServerMessage(msg).ok).toBe(true);
  });

  it("eventMessage builds an event message", () => {
    const msg = eventMessage("s1", { type: "turnStart", turnIndex: 0 });
    expect(msg).toEqual({
      kind: "event",
      sessionId: "s1",
      event: { type: "turnStart", turnIndex: 0 },
    });
    expect(validateServerMessage(msg).ok).toBe(true);
  });

  it("sessionsMessage builds a sessions message", () => {
    const headers = [{ version: 1 as const, sessionId: "s1", cwd: "/repo", createdAt: 0 }];
    const msg = sessionsMessage(headers);
    expect(msg).toEqual({ kind: "sessions", sessions: headers });
    expect(validateServerMessage(msg).ok).toBe(true);
  });

  it("ErrorCode exposes the five documented codes as stable strings", () => {
    expect(ErrorCode).toEqual({
      invalidRequest: "invalidRequest",
      unknownMethod: "unknownMethod",
      sessionNotFound: "sessionNotFound",
      sessionBusy: "sessionBusy",
      internal: "internal",
    });
  });
});
