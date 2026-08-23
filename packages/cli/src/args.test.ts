import { describe, expect, it } from "vitest";
import { helpText, parseArgs } from "./args.js";

function ok(argv: string[], stdinIsTty = true) {
  const result = parseArgs(argv, { stdinIsTty });
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  return result.args;
}

function fail(argv: string[], stdinIsTty = true): string {
  const result = parseArgs(argv, { stdinIsTty });
  if (result.ok) throw new Error("expected a parse error");
  return result.error;
}

describe("parseArgs", () => {
  it("defaults to interactive mode with no prompt", () => {
    const args = ok([]);
    expect(args).toMatchObject({
      prompt: "",
      print: false,
      outputFormat: "text",
      mcp: true,
      continueSession: false,
      help: false,
      version: false,
      listModels: false,
    });
  });

  it("joins positional words into the prompt", () => {
    expect(ok(["fix", "the", "build"]).prompt).toBe("fix the build");
  });

  it("treats everything after -- as prompt text", () => {
    expect(ok(["--", "--model", "is", "literal"]).prompt).toBe("--model is literal");
  });

  it("accepts -p and --print", () => {
    expect(ok(["-p", "hi"]).print).toBe(true);
    expect(ok(["--print", "hi"]).print).toBe(true);
  });

  it("accepts both --flag value and --flag=value", () => {
    expect(ok(["--model", "openai/gpt-5"]).model).toBe("openai/gpt-5");
    expect(ok(["--model=openai/gpt-5"]).model).toBe("openai/gpt-5");
  });

  it("supports short aliases", () => {
    expect(ok(["-m", "openai/gpt-5"]).model).toBe("openai/gpt-5");
    expect(ok(["-c"]).continueSession).toBe(true);
    expect(ok(["-r", "abc"]).resume).toBe("abc");
    expect(ok(["-h"]).help).toBe(true);
    expect(ok(["-v"]).version).toBe(true);
  });

  it("parses --no-mcp", () => {
    expect(ok(["--no-mcp"]).mcp).toBe(false);
  });

  it("parses --permission-mode", () => {
    expect(ok(["--permission-mode", "acceptEdits"]).permissionMode).toBe("acceptEdits");
    expect(fail(["--permission-mode", "wat"])).toContain("--permission-mode must be one of");
  });

  it("parses --max-turns as a positive integer", () => {
    expect(ok(["--max-turns", "12"]).maxTurns).toBe(12);
    expect(fail(["--max-turns", "0"])).toContain("positive integer");
    expect(fail(["--max-turns", "abc"])).toContain("positive integer");
  });

  it("requires --print for json output", () => {
    expect(fail(["--output-format", "json"])).toContain("requires --print");
    expect(ok(["-p", "hi", "--output-format", "json"]).outputFormat).toBe("json");
    expect(fail(["-p", "hi", "--output-format", "xml"])).toContain('"text" or "json"');
  });

  it("requires a prompt in print mode unless stdin is piped", () => {
    expect(fail(["-p"])).toContain("needs a prompt");
    // A piped stdin supplies the prompt, so an empty argv prompt is fine.
    expect(ok(["-p"], false).print).toBe(true);
  });

  it("rejects --resume together with --continue", () => {
    expect(fail(["--resume", "x", "--continue"])).toContain("mutually exclusive");
  });

  it("rejects unknown options and missing values", () => {
    expect(fail(["--nope"])).toBe("Unknown option: --nope");
    expect(fail(["--model"])).toBe("--model requires a value");
  });

  it("keeps --help and --version usable alongside anything else", () => {
    expect(ok(["--help", "--model", "openai/gpt-5"]).help).toBe(true);
    expect(ok(["--list-models"]).listModels).toBe(true);
  });

  it("does not mistake a lone dash for a flag", () => {
    expect(ok(["-"]).prompt).toBe("-");
  });

  it("parses --list-providers", () => {
    expect(ok(["--list-providers"]).listProviders).toBe(true);
    expect(ok([]).listProviders).toBe(false);
  });
});

describe("parseArgs: auth commands", () => {
  it("parses login, logout and status", () => {
    expect(ok(["auth", "login", "anthropic"]).command).toEqual({
      kind: "auth",
      action: "login",
      provider: "anthropic",
    });
    expect(ok(["auth", "logout", "github-copilot"]).command).toEqual({
      kind: "auth",
      action: "logout",
      provider: "github-copilot",
    });
    expect(ok(["auth", "status"]).command).toEqual({ kind: "auth", action: "status" });
  });

  it("leaves the prompt empty when a command was given", () => {
    expect(ok(["auth", "status"]).prompt).toBe("");
  });

  it("rejects a missing subcommand and a missing provider", () => {
    expect(fail(["auth"])).toContain("auth needs a subcommand");
    expect(fail(["auth", "login"])).toBe(
      "auth login needs a provider (arcturn auth login <provider>)",
    );
    expect(fail(["auth", "logout"])).toContain("auth logout needs a provider");
  });

  it("rejects an unknown subcommand", () => {
    expect(fail(["auth", "whoami"])).toContain('Unknown auth subcommand "whoami"');
    expect(fail(["auth", "whoami"])).toContain("login, logout, status");
  });

  it("accepts any provider token — the auth command validates it lazily", () => {
    // Provider validation lives in the auth command so parsing never has to
    // load the provider registry (see main.test.ts for the end-to-end check).
    const args = ok(["auth", "login", "gogle"]);
    expect(args.command).toEqual({ kind: "auth", action: "login", provider: "gogle" });
  });

  it("rejects extra arguments", () => {
    expect(fail(["auth", "status", "anthropic"])).toBe("auth status takes no arguments");
    expect(fail(["auth", "login", "anthropic", "extra"])).toContain("exactly one provider");
  });

  it("keeps flags usable alongside a command", () => {
    const args = ok(["auth", "status", "--cwd", "/tmp"]);
    expect(args.command).toEqual({ kind: "auth", action: "status" });
    expect(args.cwd).toBe("/tmp");
  });

  it("lets --help and --version win over the command", () => {
    expect(ok(["auth", "status", "--help"]).help).toBe(true);
    expect(ok(["auth", "status", "--version"]).version).toBe(true);
  });

  it("does not swallow --print's prompt requirement into a command", () => {
    // `auth` short-circuits the prompt checks, so a command never trips the
    // "--print needs a prompt" guard.
    const args = ok(["-p", "auth", "status"]);
    expect(args.command).toEqual({ kind: "auth", action: "status" });
    expect(args.prompt).toBe("");
  });

  it("treats auth after -- as prompt text", () => {
    const args = ok(["--", "auth", "login", "anthropic"]);
    expect(args.command).toBeUndefined();
    expect(args.prompt).toBe("auth login anthropic");
  });

  it("treats a quoted sentence starting with auth as a prompt", () => {
    const args = ok(["auth login is broken, explain it"]);
    expect(args.command).toBeUndefined();
    expect(args.prompt).toBe("auth login is broken, explain it");
  });
});

describe("helpText", () => {
  it("documents every flag the parser accepts", () => {
    const help = helpText();
    for (const flag of [
      "--print",
      "--output-format",
      "--model",
      "--continue",
      "--resume",
      "--permission-mode",
      "--cwd",
      "--no-mcp",
      "--max-turns",
      "--list-models",
      "--list-providers",
      "--help",
      "--version",
    ]) {
      expect(help).toContain(flag);
    }
  });

  it("documents the auth commands", () => {
    const help = helpText();
    expect(help).toContain("auth login <provider>");
    expect(help).toContain("auth logout <provider>");
    expect(help).toContain("auth status");
  });
});
