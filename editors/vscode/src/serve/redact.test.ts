import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED, redactSecrets, safeMessage } from "./redact.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("redactSecrets", () => {
  it("replaces every occurrence of a known secret", () => {
    const text = `connecting to ws://127.0.0.1:1234#token=${TOKEN} with ${TOKEN}`;
    expect(redactSecrets(text, [TOKEN])).toBe(
      `connecting to ws://127.0.0.1:1234#token=${REDACTED} with ${REDACTED}`,
    );
    expect(redactSecrets(text, [TOKEN])).not.toContain(TOKEN);
  });

  it("ignores short or empty secrets so a one-character value cannot blank the text", () => {
    expect(redactSecrets("a normal line", ["", "a", "abc"])).toBe("a normal line");
  });

  it("redacts a --token argument even when the value is unknown to it", () => {
    const line = "attach with: arcturn attach ws://127.0.0.1:1234 --token deadbeefdeadbeef";
    const out = redactSecrets(line, []);
    expect(out).not.toContain("deadbeefdeadbeef");
    expect(out).toContain(`--token ${REDACTED}`);
  });

  it("redacts a token carried in a URL fragment or query", () => {
    expect(redactSecrets("open http://h/#token=secretvalue1234", [])).not.toContain(
      "secretvalue1234",
    );
    expect(redactSecrets("open http://h/?token=secretvalue1234", [])).not.toContain(
      "secretvalue1234",
    );
  });

  it("redacts a bare long hex run, the shape every generated token takes", () => {
    expect(redactSecrets(`the value is ${TOKEN} ok`, [])).toBe(`the value is ${REDACTED} ok`);
  });

  it("leaves a port, a pid and a short hex id alone", () => {
    expect(redactSecrets("arcturn serving on ws://127.0.0.1:53145 pid 4211 id abc123", [])).toBe(
      "arcturn serving on ws://127.0.0.1:53145 pid 4211 id abc123",
    );
  });
});

describe("createRedactor", () => {
  it("keeps redacting after a secret is registered later", () => {
    const redactor = createRedactor();
    expect(redactor.redact("value xyzzy-plugh-secret")).toContain("xyzzy-plugh-secret");
    redactor.add("xyzzy-plugh-secret");
    expect(redactor.redact("value xyzzy-plugh-secret")).toBe(`value ${REDACTED}`);
  });
});

describe("safeMessage", () => {
  it("renders an Error's message with secrets removed", () => {
    const error = new Error(`spawn failed: --token ${TOKEN}`);
    const message = safeMessage(error, [TOKEN]);
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("spawn failed");
  });

  it("never leaks a stack, only the message", () => {
    const error = new Error("boom");
    error.stack = `boom\n    at secretPath/${TOKEN}/file.ts`;
    expect(safeMessage(error, [TOKEN])).toBe("boom");
  });

  it("stringifies a non-Error and redacts it too", () => {
    expect(safeMessage({ token: TOKEN }, [TOKEN])).not.toContain(TOKEN);
    expect(safeMessage(undefined, [])).toBe("unknown error");
  });
});
