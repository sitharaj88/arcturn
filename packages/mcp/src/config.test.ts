import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig, McpConfigError } from "./config.js";

describe("loadMcpConfig", () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-mcp-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  async function writeConfig(name: string, contents: unknown): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(contents), "utf8");
    return path;
  }

  it("loads a single valid config file", async () => {
    const path = await writeConfig("a.json", {
      servers: {
        files: { type: "stdio", command: "mcp-files", args: ["--root", "."] },
      },
    });
    const config = await loadMcpConfig([path]);
    expect(config.servers.files).toEqual({
      type: "stdio",
      command: "mcp-files",
      args: ["--root", "."],
      env: undefined,
      cwd: undefined,
    });
  });

  it("merges multiple files, later paths winning per server name", async () => {
    const a = await writeConfig("a.json", {
      servers: {
        shared: { type: "stdio", command: "old-cmd" },
        onlyInA: { type: "stdio", command: "a-cmd" },
      },
    });
    const b = await writeConfig("b.json", {
      servers: {
        shared: { type: "stdio", command: "new-cmd" },
        onlyInB: { type: "http", url: "https://example.com/mcp" },
      },
    });
    const config = await loadMcpConfig([a, b]);
    expect(config.servers.shared?.type).toBe("stdio");
    expect((config.servers.shared as { command: string }).command).toBe("new-cmd");
    expect(config.servers.onlyInA).toBeDefined();
    expect(config.servers.onlyInB).toBeDefined();
  });

  it("expands ${ENV_VAR} references in env, headers, and url", async () => {
    process.env.ARCTURN_TEST_TOKEN = "secret-token";
    process.env.ARCTURN_TEST_HOST = "example.com";
    const path = await writeConfig("http.json", {
      servers: {
        api: {
          type: "http",
          url: "https://${ARCTURN_TEST_HOST}/mcp",
          headers: { Authorization: "Bearer ${ARCTURN_TEST_TOKEN}" },
        },
        proc: {
          type: "stdio",
          command: "mcp-proc",
          env: { TOKEN: "${ARCTURN_TEST_TOKEN}" },
        },
      },
    });
    const config = await loadMcpConfig([path]);
    const api = config.servers.api as { url: string; headers?: Record<string, string> };
    expect(api.url).toBe("https://example.com/mcp");
    expect(api.headers?.Authorization).toBe("Bearer secret-token");
    const proc = config.servers.proc as { env?: Record<string, string> };
    expect(proc.env?.TOKEN).toBe("secret-token");
  });

  it("does not expand ${ENV_VAR} in command/args/cwd", async () => {
    const path = await writeConfig("cmd.json", {
      servers: {
        proc: { type: "stdio", command: "${NOT_EXPANDED}", args: ["${ALSO_NOT}"] },
      },
    });
    const config = await loadMcpConfig([path]);
    const proc = config.servers.proc as { command: string; args?: string[] };
    expect(proc.command).toBe("${NOT_EXPANDED}");
    expect(proc.args).toEqual(["${ALSO_NOT}"]);
  });

  it("throws a clear error for an unset environment variable", async () => {
    const path = await writeConfig("missing-env.json", {
      servers: { api: { type: "http", url: "https://${ARCTURN_DOES_NOT_EXIST}/mcp" } },
    });
    await expect(loadMcpConfig([path])).rejects.toThrow(McpConfigError);
    await expect(loadMcpConfig([path])).rejects.toThrow(/ARCTURN_DOES_NOT_EXIST/);
  });

  it("throws on invalid JSON", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{not json", "utf8");
    await expect(loadMcpConfig([path])).rejects.toThrow(McpConfigError);
  });

  it("throws when the top-level shape is wrong", async () => {
    const path = await writeConfig("wrong-shape.json", { notServers: {} });
    await expect(loadMcpConfig([path])).rejects.toThrow(/servers/);
  });

  it("throws when a server is missing a required field", async () => {
    const path = await writeConfig("missing-command.json", {
      servers: { broken: { type: "stdio" } },
    });
    await expect(loadMcpConfig([path])).rejects.toThrow(/command/);
  });

  it('accepts auth: "oauth" on an http server, alongside headers', async () => {
    const path = await writeConfig("oauth.json", {
      servers: {
        api: {
          type: "http",
          url: "https://example.com/mcp",
          auth: "oauth",
          headers: { "X-Tenant": "acme" },
        },
      },
    });
    const config = await loadMcpConfig([path]);
    expect(config.servers.api).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      auth: "oauth",
      headers: { "X-Tenant": "acme" },
    });
  });

  it("leaves auth absent when it is not configured", async () => {
    const path = await writeConfig("no-auth.json", {
      servers: { api: { type: "http", url: "https://example.com/mcp" } },
    });
    const config = await loadMcpConfig([path]);
    const server = config.servers.api;
    expect(server?.type === "http" ? server.auth : "unreachable").toBeUndefined();
  });

  it("rejects an auth value other than oauth", async () => {
    const path = await writeConfig("bad-auth.json", {
      servers: { api: { type: "http", url: "https://example.com/mcp", auth: "basic" } },
    });
    await expect(loadMcpConfig([path])).rejects.toThrow(McpConfigError);
    await expect(loadMcpConfig([path])).rejects.toThrow(/"auth" must be "oauth"/);
  });

  it("throws when a server has an unknown type", async () => {
    const path = await writeConfig("bad-type.json", {
      servers: { broken: { type: "carrier-pigeon" } },
    });
    await expect(loadMcpConfig([path])).rejects.toThrow(/"stdio" or "http"/);
  });
});
