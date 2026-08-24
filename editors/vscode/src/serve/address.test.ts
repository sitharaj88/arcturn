import { describe, expect, it } from "vitest";
import {
  formatConnectUrl,
  isLoopbackSocketUrl,
  parseConnectUrl,
  parseServeAnnouncement,
} from "./address.js";

describe("parseServeAnnouncement", () => {
  it("reads the address arcturn serve prints on startup", () => {
    expect(parseServeAnnouncement("arcturn serving on ws://127.0.0.1:53145")).toBe(
      "ws://127.0.0.1:53145",
    );
  });

  it("tolerates surrounding whitespace and a carriage return", () => {
    expect(parseServeAnnouncement("  arcturn serving on ws://127.0.0.1:53145 \r")).toBe(
      "ws://127.0.0.1:53145",
    );
  });

  it("reads a bracketed IPv6 address", () => {
    expect(parseServeAnnouncement("arcturn serving on ws://[::1]:53145")).toBe("ws://[::1]:53145");
  });

  it("ignores every other line serve prints, including the one carrying the token", () => {
    for (const line of [
      "  attach with: arcturn attach ws://127.0.0.1:53145 --token abc",
      "  open in a browser: http://127.0.0.1:8080#token=abc",
      "  press Ctrl+C to stop",
      "arcturn: some warning",
      "",
    ]) {
      expect(parseServeAnnouncement(line)).toBeUndefined();
    }
  });

  it("refuses a non-ws scheme", () => {
    expect(parseServeAnnouncement("arcturn serving on http://127.0.0.1:53145")).toBeUndefined();
  });
});

describe("isLoopbackSocketUrl", () => {
  it("accepts the loopback forms serve binds", () => {
    expect(isLoopbackSocketUrl("ws://127.0.0.1:1")).toBe(true);
    expect(isLoopbackSocketUrl("ws://127.5.5.5:1")).toBe(true);
    expect(isLoopbackSocketUrl("ws://localhost:1")).toBe(true);
    expect(isLoopbackSocketUrl("ws://[::1]:1")).toBe(true);
  });

  it("rejects anything else, including a hostname that merely looks local", () => {
    expect(isLoopbackSocketUrl("ws://192.168.0.4:1")).toBe(false);
    expect(isLoopbackSocketUrl("ws://localhost.evil.example:1")).toBe(false);
    expect(isLoopbackSocketUrl("ws://0.0.0.0:1")).toBe(false);
    expect(isLoopbackSocketUrl("not a url")).toBe(false);
  });
});

describe("connect url", () => {
  it("carries the token in the fragment, which never reaches a server", () => {
    const url = formatConnectUrl("ws://127.0.0.1:53145", "abc123");
    expect(url).toBe("ws://127.0.0.1:53145#token=abc123");
  });

  it("round-trips a token needing percent-encoding", () => {
    const token = "a b/c#d";
    const parsed = parseConnectUrl(formatConnectUrl("ws://127.0.0.1:1", token));
    expect(parsed.socketUrl).toBe("ws://127.0.0.1:1");
    expect(parsed.token).toBe(token);
  });

  it("hands the socket a url with no fragment on it", () => {
    const parsed = parseConnectUrl("ws://127.0.0.1:1#token=abc");
    expect(parsed.socketUrl).not.toContain("#");
  });

  it("omits the fragment entirely when there is no token", () => {
    expect(formatConnectUrl("ws://127.0.0.1:1", undefined)).toBe("ws://127.0.0.1:1");
    expect(parseConnectUrl("ws://127.0.0.1:1").token).toBeUndefined();
  });
});
