/**
 * `/mcp` over the wire: names and status, and nothing that could be a
 * credential.
 *
 * The decisive test here plants secrets in every place an MCP config can hold
 * one — a stdio server's `env`, its `args`, an HTTP server's `url` and its
 * `Authorization` header — and then greps the **raw bytes that crossed the
 * socket**. Asserting on the parsed object would only prove that the fields
 * this test thought to check are clean; asserting on the frame proves nothing
 * else rode along. This is the shape the `listModels` review used for
 * `apiKeyEnv`, pointed at a richer config.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@arcturn/core";
import { McpManager } from "@arcturn/mcp";
import { createProtocolClient } from "@arcturn/protocol";
import { ArcturnServer } from "@arcturn/server";
import type { McpConfig, ModelSpec } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createServeHost, type ServableRuntime } from "./serve.js";
import { mcpServerSummaries } from "./serve-mcp.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";

const TEST_MODEL: ModelSpec = {
  id: "test/model",
  provider: "anthropic",
  model: "test-model",
  displayName: "Test Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
};

/** Every secret this test plants, so one list drives both the config and the grep. */
const SECRETS = [
  "sk-live-51H9planted-secret",
  "Bearer sk-oauth-planted-token",
  "hunter2-planted-password",
  "planted-token-in-args",
] as const;

const CONFIG: McpConfig = {
  servers: {
    files: {
      type: "stdio",
      command: "/usr/local/bin/mcp-files",
      args: ["--api-key", SECRETS[3]],
      env: { MCP_API_KEY: SECRETS[0], DB_PASSWORD: SECRETS[2] },
      cwd: "/home/someone/secrets",
    },
    remote: {
      type: "http",
      url: `https://mcp.example.com/sse?token=${SECRETS[0]}`,
      headers: { Authorization: SECRETS[1] },
      auth: "oauth",
    },
  },
};

const servers: ArcturnServer[] = [];
const clients: { close(): void }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
});

async function fakeRuntime(overrides: Partial<ServableRuntime> = {}): Promise<ServableRuntime> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-serve-mcp-"));
  return {
    llm: fakeLLM([{ text: "hi" }]),
    model: TEST_MODEL,
    cwd: dir,
    env: {},
    store: new JsonlSessionStore({ dir }),
    systemPrompt: "You are a test agent.",
    tools: [],
    config: { permissions: [], permissionMode: "yolo" },
    dispose: async () => {},
    ...overrides,
  };
}

describe("mcpServerSummaries — names and status only", () => {
  it("projects name, transport, state and nothing else", () => {
    const summaries = mcpServerSummaries(new McpManager(CONFIG));
    expect(summaries).toEqual([
      { name: "files", transport: "stdio", state: "disconnected" },
      { name: "remote", transport: "http", state: "disconnected" },
    ]);
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual(["name", "state", "transport"]);
    }
  });

  it("answers an empty list for an engine with no MCP manager at all", () => {
    expect(mcpServerSummaries(undefined)).toEqual([]);
  });
});

describe("mcpStatus over the wire", () => {
  it("carries no credential-shaped value in the frame the client received", async () => {
    const runtime = await fakeRuntime({ mcp: new McpManager(CONFIG) });
    const host = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost: host });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const raw: string[] = [];
    socket.on("message", (data: unknown) => raw.push(String(data)));
    const client = createProtocolClient(socket);
    clients.push(client);

    const status = await client.mcpStatus();
    expect(status?.servers.map((entry) => entry.name).sort()).toEqual(["files", "remote"]);

    const wire = raw.join("\n");
    expect(wire).toContain("files");
    for (const secret of SECRETS) {
      expect(wire).not.toContain(secret);
    }
    // The whole config, not only its secrets: no url, no command, no cwd, no
    // header name. A field added to `McpServerConfig` tomorrow cannot leak
    // through a payload that never carries the config at all.
    expect(wire).not.toContain("mcp.example.com");
    expect(wire).not.toContain("/usr/local/bin/mcp-files");
    expect(wire).not.toContain("/home/someone/secrets");
    expect(wire).not.toContain("Authorization");
    expect(wire).not.toContain("MCP_API_KEY");
    expect(wire).not.toContain("oauth");
  });

  it("answers an empty list rather than failing when no MCP is configured", async () => {
    const runtime = await fakeRuntime();
    const host = createServeHost(runtime);
    const server = new ArcturnServer({ sessionHost: host });
    servers.push(server);
    const port = await server.start({ host: "127.0.0.1", port: 0 });
    const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
    clients.push(client);
    expect(await client.mcpStatus()).toEqual({ servers: [] });
  });
});
