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

describe("parseArgs: positional commands", () => {
  it("parses a command and leaves the prompt empty", () => {
    const args = ok(["completions", "zsh"]);
    expect(args.command).toEqual({ kind: "completions", shell: "zsh" });
    expect(args.prompt).toBe("");
  });

  it("rejects a command with the wrong number of arguments", () => {
    expect(fail(["completions"])).toContain("completions needs exactly one shell");
    expect(fail(["completions", "zsh", "extra"])).toContain("completions needs exactly one shell");
  });

  it("keeps flags usable alongside a command", () => {
    const args = ok(["completions", "zsh", "--cwd", "/tmp"]);
    expect(args.command).toEqual({ kind: "completions", shell: "zsh" });
    expect(args.cwd).toBe("/tmp");
  });

  it("lets --help and --version win over the command", () => {
    expect(ok(["completions", "zsh", "--help"]).help).toBe(true);
    expect(ok(["completions", "zsh", "--version"]).version).toBe(true);
  });

  it("does not swallow --print's prompt requirement into a command", () => {
    // A command short-circuits the prompt checks, so it never trips the
    // "--print needs a prompt" guard.
    const args = ok(["-p", "completions", "zsh"]);
    expect(args.command).toEqual({ kind: "completions", shell: "zsh" });
    expect(args.prompt).toBe("");
  });

  it("treats a command word after -- as prompt text", () => {
    const args = ok(["--", "completions", "zsh"]);
    expect(args.command).toBeUndefined();
    expect(args.prompt).toBe("completions zsh");
  });

  it("treats a quoted sentence starting with a command word as a prompt", () => {
    const args = ok(["completions zsh is broken, explain it"]);
    expect(args.command).toBeUndefined();
    expect(args.prompt).toBe("completions zsh is broken, explain it");
  });

  it("no longer recognises `auth` as a command", () => {
    // The subscription sign-in it drove never worked and was removed; the
    // words must fall through to the prompt rather than resolve to a command.
    const args = ok(["auth", "login", "anthropic"]);
    expect(args.command).toBeUndefined();
    expect(args.prompt).toBe("auth login anthropic");
    expect(ok(["auth", "status"]).command).toBeUndefined();
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

  it("documents the positional commands", () => {
    const help = helpText();
    expect(help).toContain("completions <shell>");
    expect(help).toContain("mcp auth <name>");
    expect(help).toContain("mcp logout <name>");
  });

  it("no longer advertises a subscription sign-in that never worked", () => {
    const help = helpText();
    expect(help).not.toContain("auth login");
    expect(help).not.toContain("auth status");
    expect(help).not.toContain("ARCTURN_OAUTH_");
  });
});
