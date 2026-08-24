import { describe, expect, it } from "vitest";
import { buildServeArgs, cliInvocation } from "./args.js";

describe("buildServeArgs", () => {
  it("binds loopback on an ephemeral port with the supplied token", () => {
    expect(buildServeArgs({ cwd: "/w", token: "tok" })).toEqual([
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--cwd",
      "/w",
      "--token",
      "tok",
    ]);
  });

  it("honours an explicit port, the arcturn.serve.port setting's non-zero case", () => {
    expect(buildServeArgs({ cwd: "/w", token: "tok", port: 9123 })).toContain("9123");
  });

  it("rejects a port outside the engine's own accepted range rather than shipping it", () => {
    expect(() => buildServeArgs({ cwd: "/w", token: "tok", port: 70_000 })).toThrow(/port/i);
    expect(() => buildServeArgs({ cwd: "/w", token: "tok", port: -1 })).toThrow(/port/i);
  });

  it("passes a model only when one was chosen", () => {
    expect(buildServeArgs({ cwd: "/w", token: "tok" })).not.toContain("--model");
    expect(buildServeArgs({ cwd: "/w", token: "tok", model: "anthropic/x" })).toEqual(
      expect.arrayContaining(["--model", "anthropic/x"]),
    );
  });

  it("never passes an empty token, which would ask the engine to disable auth", () => {
    expect(() => buildServeArgs({ cwd: "/w", token: "" })).toThrow(/token/i);
  });
});

describe("cliInvocation", () => {
  it("accepts the { command } shape", () => {
    expect(cliInvocation({ command: "/usr/local/bin/arcturn" })).toEqual({
      command: "/usr/local/bin/arcturn",
      args: [],
    });
  });

  it("accepts the { path } shape, since the seam's exact field name is Builder A's", () => {
    expect(cliInvocation({ path: "/usr/local/bin/arcturn" })).toEqual({
      command: "/usr/local/bin/arcturn",
      args: [],
    });
  });

  it("keeps leading arguments, so a `npx arcturn` style resolution still works", () => {
    expect(cliInvocation({ command: "npx", args: ["arcturn"] })).toEqual({
      command: "npx",
      args: ["arcturn"],
    });
  });

  it("returns undefined when the CLI could not be resolved at all", () => {
    expect(cliInvocation(undefined)).toBeUndefined();
    expect(cliInvocation({})).toBeUndefined();
    expect(cliInvocation({ command: "   " })).toBeUndefined();
  });
});
