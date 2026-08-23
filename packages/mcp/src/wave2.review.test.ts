/**
 * Adversarial review of `arcturn mcp-serve`'s protocol half.
 *
 * `FINDING:` tests assert what the design claims and fail against this tree.
 * `CLOSED:` tests pass and record an escape route that was tried and is shut,
 * so the next reader does not re-derive it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { isSensitivePath } from "./sensitive-paths.js";
import {
  type ArcturnMcpHost,
  createArcturnMcpServer,
  LIMITS,
  McpRefusalError,
  type McpSearchRequest,
} from "./server.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A host that records what it was asked and answers with whatever it is given. */
function stubHost(overrides: Partial<ArcturnMcpHost> = {}): ArcturnMcpHost & {
  readonly searches: McpSearchRequest[];
  readonly sessionIds: string[];
} {
  const searches: McpSearchRequest[] = [];
  const sessionIds: string[] = [];
  return {
    searches,
    sessionIds,
    chunkKinds: ["function", "class"],
    async searchCode(request) {
      searches.push(request);
      return { hits: [], totalMatches: 0 };
    },
    async listSessions() {
      return [];
    },
    async readSession(sessionId) {
      sessionIds.push(sessionId);
      return { sessionId, entries: [], omitted: 0 };
    },
    ...overrides,
  };
}

async function connect(host: ArcturnMcpHost, onInternalError?: () => void): Promise<Client> {
  const server = createArcturnMcpServer({
    host,
    serverInfo: { name: "arcturn", version: "test" },
    ...(onInternalError === undefined ? {} : { onInternalError }),
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "adversary", version: "1.0.0" });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ================================================================== findings

describe("FINDING: the credential-path list misses the suffix spellings", () => {
  it("FINDING: does not recognise `<name>.env` or a bare `credentials.json`", () => {
    // The list is anchored per path *segment*, which is right for `.env` and
    // wrong for the forms that live beside it: `config/production.env` and a
    // root `credentials.json` hold exactly the same bytes and match nothing.
    // The consequence is not "one fewer withheld count" — these files are
    // indexed as a single `file` chunk, so `detail: "snippets"` hands their
    // whole body to the peer on the always-on, read-only surface.
    expect(isSensitivePath("config/production.env")).toBe(true);
    expect(isSensitivePath(".env-production")).toBe(true);
    expect(isSensitivePath(".envrc.local")).toBe(true);
    expect(isSensitivePath("credentials.json")).toBe(true);

    // Controls: the spellings the list does know, so a fix must not be "match
    // everything".
    expect(isSensitivePath("apps/web/.env")).toBe(true);
    expect(isSensitivePath("src/secrets.ts")).toBe(false);
  });
});

// ============================================================ closed routes

describe("CLOSED: the protocol layer does not trust its host", () => {
  it("withholds a credential hit even when the host hands one over", async () => {
    // The outer filter is load-bearing on its own: this host has "forgotten"
    // to filter, and the bytes still do not cross.
    const client = await connect(
      stubHost({
        async searchCode() {
          return {
            hits: [
              { path: ".env", line: 1, kind: "file", name: "env", snippet: "AWS_SECRET=leaked" },
              { path: "src/app.ts", line: 4, kind: "function", name: "boot" },
            ],
            totalMatches: 2,
          };
        },
      }),
    );
    const text = textOf(await call(client, "search_code", { query: "AWS_SECRET" }));
    expect(text).not.toContain("leaked");
    expect(text).not.toContain(".env");
    expect(text).toContain("src/app.ts:4");
    expect(text).toContain("1 result withheld");
  });

  it("validates the session id before the host is ever called", async () => {
    const host = stubHost();
    const client = await connect(host);
    for (const id of ["..", ".", "../../etc/passwd", "a/b", "a\\b", "a\u0000b"]) {
      const result = await call(client, "read_session", { session_id: id });
      expect(result.isError, id).toBe(true);
    }
    expect(host.sessionIds).toEqual([]);
  });

  it("refuses a path filter that leaves the workspace, before the host is called", async () => {
    const host = stubHost();
    const client = await connect(host);
    for (const path of [
      "../../etc",
      "/etc/passwd",
      "C:\\Windows",
      "src/../../secrets",
      "\\\\srv",
    ]) {
      const result = await call(client, "search_code", { query: "x", path });
      expect(result.isError, path).toBe(true);
    }
    expect(host.searches).toEqual([]);
  });
});

describe("CLOSED: nothing widens the surface from the wire", () => {
  it("advertises no ask_arcturn when the host holds no such capability", async () => {
    const client = await connect(stubHost());
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("ask_arcturn");
    // Calling the name anyway is refused, not executed.
    const result = await call(client, "ask_arcturn", { prompt: "do it" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("read-only");
  });

  it("gives ask_arcturn exactly one input property, and it is not a mode", async () => {
    const client = await connect(
      stubHost({
        askArcturn: async () => ({ text: "ok", tools: [], turns: 1, reason: "completed" }),
      }),
    );
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "ask_arcturn");
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["prompt"]);
    // Extra arguments the peer invents are ignored rather than honoured.
    const result = await call(client, "ask_arcturn", {
      prompt: "go",
      permissionMode: "yolo",
      cwd: "/",
      tools: ["bash"],
    });
    expect(result.isError).toBeFalsy();
  });

  it("advertises only the tools capability", async () => {
    const client = await connect(stubHost());
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
  });

  it("refuses the whole-file detail level that was deliberately cut", async () => {
    const client = await connect(stubHost());
    const result = await call(client, "search_code", { query: "x", detail: "full" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("signatures");
  });

  it("clamps a runaway limit instead of honouring it", async () => {
    const host = stubHost();
    const client = await connect(host);
    await call(client, "search_code", { query: "x", limit: 100_000 });
    await call(client, "search_code", { query: "x", limit: -12 });
    expect(host.searches.map((request) => request.limit)).toEqual([LIMITS.listLimit, 1]);
  });
});

describe("CLOSED: an internal failure does not leak the environment", () => {
  it("sends the operator the real message and the peer a bare failure", async () => {
    const seen: unknown[] = [];
    const client = await connect(
      stubHost({
        async searchCode() {
          throw new Error("ENOENT: /Users/alice/.arcturn/index/deadbeef — token sk-live-42");
        },
      }),
      () => seen.push(true),
    );
    const text = textOf(await call(client, "search_code", { query: "x" }));
    expect(text).not.toContain("/Users/alice");
    expect(text).not.toContain("sk-live-42");
    expect(text).toContain("See the arcturn server's log.");
    expect(seen).toHaveLength(1);
  });

  it("lets a deliberate refusal through verbatim, and only that", async () => {
    const client = await connect(
      stubHost({
        async listSessions() {
          throw new McpRefusalError("denied by this workspace's permission rules");
        },
      }),
    );
    expect(textOf(await call(client, "list_sessions", {}))).toContain("denied by this workspace");
  });
});
