import { describe, expect, it } from "vitest";
import { AIErrorException } from "../errors.js";
import { OAuthError, REDACTED, redactSecrets } from "./errors.js";

describe("redactSecrets", () => {
  it("redacts credential-bearing fields whichever encoding they arrive in", () => {
    expect(redactSecrets('{"access_token":"abc123","x":1}')).toBe(
      `{"access_token":"${REDACTED}","x":1}`,
    );
    expect(redactSecrets("refresh_token=zzz&state=ok")).toBe(`refresh_token=${REDACTED}&state=ok`);
  });

  it("redacts credentials recognisable on sight, outside any field", () => {
    expect(redactSecrets("bearer ghu_abcdefghijklmnopqrstuvwxyz")).toContain(REDACTED);
    expect(redactSecrets("key sk-proj-abcdefghijklmnopqrstuv")).toContain(REDACTED);
  });

  it("redacts literal secrets the caller names", () => {
    expect(redactSecrets("value is hunter2-secret-value", ["hunter2-secret-value"])).toBe(
      `value is ${REDACTED}`,
    );
  });

  it("ignores a 'secret' too short to be one, so a message is not shredded", () => {
    expect(redactSecrets("no such user", ["user"])).toBe("no such user");
  });
});

describe("OAuthError", () => {
  it("redacts its own message, so no call site has to remember to", () => {
    const error = new OAuthError("arcturn_bad_response", 'server said {"access_token":"abc123"}');
    expect(error.message).not.toContain("abc123");
    expect(error.message).toContain(REDACTED);
    expect(error.code).toBe("arcturn_bad_response");
  });

  it("projects onto the harness-wide auth error, keeping status and cause", () => {
    const error = new OAuthError("access_denied", "the user said no", {
      status: 403,
      provider: "example",
    });
    const projected = error.toAIErrorException();
    expect(projected).toBeInstanceOf(AIErrorException);
    expect(projected.kind).toBe("auth");
    expect(projected.status).toBe(403);
    expect(projected.message).toBe("the user said no");
    expect(projected.cause).toBe(error);
  });
});
