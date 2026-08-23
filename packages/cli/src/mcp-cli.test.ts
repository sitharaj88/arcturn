import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpCliCommand } from "./args.js";
import { parseArgs } from "./args.js";
import { runMcpCommand } from "./mcp-cli.js";

function parseMcp(argv: string[]): McpCliCommand {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(result.error);
  const command = result.args.command;
  if (command?.kind !== "mcp") throw new Error("expected an mcp command");
  return command;
}

describe("parseArgs: mcp commands", () => {
  it("parses a stdio add with args after --", () => {
    const command = parseMcp(["mcp", "add", "macctl", "--", "npx", "-y", "@sitharaj88/macctl"]);
    expect(command).toEqual({
      kind: "mcp",
      action: "add",
      name: "macctl",
      server: { type: "stdio", command: "npx", args: ["-y", "@sitharaj88/macctl"] },
    });
  });

  it("parses scope, env and a bare command without --", () => {
    const command = parseMcp([
      "mcp",
      "add",
      "db",
      "--scope",
      "user",
      "--env",
      "PGURL=postgres://x",
      "my-server",
    ]);
    expect(command.scope).toBe("user");
    expect(command.server).toEqual({
      type: "stdio",
      command: "my-server",
      env: { PGURL: "postgres://x" },
    });
  });

  it("parses an http add with headers", () => {
    const command = parseMcp([
      "mcp",
      "add",
      "--transport",
      "http",
      "search",
      "https://mcp.example.com/sse",
      "--header",
      "Authorization: Bearer ${TOKEN}",
    ]);
    expect(command.server).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
  });

  it("parses list, get and remove", () => {
    expect(parseMcp(["mcp", "list"]).action).toBe("list");
    expect(parseMcp(["mcp", "get", "macctl"])).toMatchObject({ action: "get", name: "macctl" });
    expect(parseMcp(["mcp", "remove", "macctl", "--scope", "user"])).toMatchObject({
      action: "remove",
      name: "macctl",
      scope: "user",
    });
  });

  it("parses an http add with --auth oauth", () => {
    const command = parseMcp([
      "mcp",
      "add",
      "--transport",
      "http",
      "--auth",
      "oauth",
      "docs",
      "https://mcp.example.com/mcp",
    ]);
    expect(command.server).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      auth: "oauth",
    });
  });

  it("parses auth and logout", () => {
    expect(parseMcp(["mcp", "auth", "docs"])).toEqual({
      kind: "mcp",
      action: "auth",
      name: "docs",
    });
    expect(parseMcp(["mcp", "logout", "docs"])).toEqual({
      kind: "mcp",
      action: "logout",
      name: "docs",
    });
  });

  it("rejects bad input loudly", () => {
    for (const argv of [
      ["mcp"],
      ["mcp", "frobnicate"],
      ["mcp", "add", "x"],
      ["mcp", "add", "bad name", "--", "cmd"],
      ["mcp", "add", "x", "--env", "not-a-pair", "--", "cmd"],
      ["mcp", "add", "--transport", "http", "x"],
      ["mcp", "add", "--transport", "http", "x", "https://u", "--env", "A=b"],
      ["mcp", "list", "extra"],
      // OAuth-specific misuse.
      ["mcp", "auth"],
      ["mcp", "logout"],
      ["mcp", "auth", "docs", "extra"],
      ["mcp", "auth", "docs", "--scope", "user"],
      ["mcp", "logout", "bad name"],
      ["mcp", "add", "--transport", "http", "x", "https://u", "--auth", "basic"],
      ["mcp", "add", "--auth", "oauth", "x", "--", "cmd"],
    ]) {
      expect(parseArgs(argv).ok, argv.join(" ")).toBe(false);
    }
  });

  it("leaves quoted prompts alone", () => {
    const result = parseArgs(["explain mcp add for me"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.command).toBeUndefined();
  });
});

describe("runMcpCommand", () => {
  let home: string;
  let cwd: string;
  let output: string[];
  let errors: string[];

  const run = (command: McpCliCommand) =>
    runMcpCommand(command, {
      cwd,
      env: { ARCTURN_HOME: home },
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "arcturn-mcp-home-"));
    cwd = await mkdtemp(join(tmpdir(), "arcturn-mcp-cwd-"));
    output = [];
    errors = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const macctl: McpCliCommand = {
    kind: "mcp",
    action: "add",
    name: "macctl",
    server: { type: "stdio", command: "npx", args: ["-y", "@sitharaj88/macctl"] },
  };

  it("add writes the project file by default and round-trips through get/list/remove", async () => {
    expect(await run(macctl)).toBe(0);
    const written = JSON.parse(await readFile(join(cwd, ".arcturn", "mcp.json"), "utf8"));
    expect(written.servers.macctl).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@sitharaj88/macctl"],
    });

    expect(await run({ kind: "mcp", action: "list" })).toBe(0);
    expect(output.join("")).toContain("macctl");
    expect(output.join("")).toContain("[project]");

    expect(await run({ kind: "mcp", action: "get", name: "macctl" })).toBe(0);
    expect(await run({ kind: "mcp", action: "remove", name: "macctl" })).toBe(0);
    const after = JSON.parse(await readFile(join(cwd, ".arcturn", "mcp.json"), "utf8"));
    expect(after.servers).toEqual({});
  });

  it("respects --scope user and refuses duplicate names in the same scope", async () => {
    const userScoped = { ...macctl, scope: "user" as const };
    expect(await run(userScoped)).toBe(0);
    const written = JSON.parse(await readFile(join(home, "mcp.json"), "utf8"));
    expect(written.servers.macctl.type).toBe("stdio");

    expect(await run(userScoped)).toBe(2);
    expect(errors.join("")).toContain("already exists");
  });

  it("preserves unknown top-level keys and demands --scope on ambiguous remove", async () => {
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({ comment: "keep me", servers: { macctl: { type: "stdio", command: "a" } } }),
    );
    expect(await run(macctl)).toBe(0); // project scope; now defined in both

    expect(await run({ kind: "mcp", action: "remove", name: "macctl" })).toBe(2);
    expect(errors.join("")).toContain("--scope");

    expect(await run({ kind: "mcp", action: "remove", name: "macctl", scope: "user" })).toBe(0);
    const user = JSON.parse(await readFile(join(home, "mcp.json"), "utf8"));
    expect(user.comment).toBe("keep me");
    expect(user.servers).toEqual({});
  });

  const docs: McpCliCommand = {
    kind: "mcp",
    action: "add",
    name: "docs",
    server: { type: "http", url: "https://mcp.example.com/mcp", auth: "oauth" },
  };

  it("add writes an oauth http server and list marks it", async () => {
    expect(await run(docs)).toBe(0);
    const written = JSON.parse(await readFile(join(cwd, ".arcturn", "mcp.json"), "utf8"));
    expect(written.servers.docs).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      auth: "oauth",
    });

    expect(await run({ kind: "mcp", action: "list" })).toBe(0);
    expect(output.join("")).toContain("(oauth)");
  });

  it("auth runs the flow against the configured URL and the per-server store", async () => {
    expect(await run(docs)).toBe(0);
    const calls: { serverName: string; serverUrl: string }[] = [];
    const code = await runMcpCommand(
      { kind: "mcp", action: "auth", name: "docs" },
      {
        cwd,
        env: { ARCTURN_HOME: home },
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
        authFlow: async (flow) => {
          calls.push({ serverName: flow.serverName, serverUrl: flow.serverUrl });
          // Stand in for the browser dance: a real one can't run in CI.
          await flow.storage.save({ tokens: { access_token: "at", token_type: "Bearer" } });
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ serverName: "docs", serverUrl: "https://mcp.example.com/mcp" }]);

    const tokenFile = join(home, "auth", "mcp-docs.json");
    expect(JSON.parse(await readFile(tokenFile, "utf8")).tokens.access_token).toBe("at");

    // logout deletes exactly that file, and is idempotent.
    expect(await run({ kind: "mcp", action: "logout", name: "docs" })).toBe(0);
    await expect(readFile(tokenFile, "utf8")).rejects.toThrow();
    expect(await run({ kind: "mcp", action: "logout", name: "docs" })).toBe(0);
    expect(output.join("")).toContain("Nothing to do");
  });

  it("auth expands ${ENV_VAR} in the server URL, like the runtime does", async () => {
    await run({
      kind: "mcp",
      action: "add",
      name: "docs",
      server: { type: "http", url: "https://${ARCTURN_TEST_MCP_HOST}/mcp", auth: "oauth" },
    });
    let seen = "";
    const code = await runMcpCommand(
      { kind: "mcp", action: "auth", name: "docs" },
      {
        cwd,
        env: { ARCTURN_HOME: home, ARCTURN_TEST_MCP_HOST: "docs.example.com" },
        stdout: () => undefined,
        stderr: (text) => errors.push(text),
        authFlow: async (flow) => {
          seen = flow.serverUrl;
        },
      },
    );
    expect(code).toBe(0);
    expect(seen).toBe("https://docs.example.com/mcp");
  });

  it("auth refuses servers that are unknown, stdio, or not oauth", async () => {
    expect(await run({ kind: "mcp", action: "auth", name: "nope" })).toBe(2);
    expect(errors.join("")).toContain('no MCP server named "nope"');

    errors = [];
    expect(await run(macctl)).toBe(0);
    expect(await run({ kind: "mcp", action: "auth", name: "macctl" })).toBe(2);
    expect(errors.join("")).toContain("stdio server");

    errors = [];
    await run({
      kind: "mcp",
      action: "add",
      name: "plain",
      server: { type: "http", url: "https://plain.example.com/mcp" },
    });
    expect(await run({ kind: "mcp", action: "auth", name: "plain" })).toBe(2);
    expect(errors.join("")).toContain('"auth": "oauth"');
  });

  it("fails with a clear message on a corrupt config file", async () => {
    await writeFile(join(home, "mcp.json"), "{not json");
    expect(await run({ ...macctl, scope: "user" })).toBe(2);
    expect(errors.join("")).toContain("not valid JSON");
  });
});
