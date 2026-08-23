import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { isSensitivePath, withholdSensitive } from "./sensitive-paths.js";
import {
  type ArcturnMcpHost,
  ASK_ARCTURN_TOOL,
  createArcturnMcpServer,
  LIMITS,
  LIST_SESSIONS_TOOL,
  type McpAskOutcome,
  type McpSearchOutcome,
  type McpSearchRequest,
  READ_SESSION_TOOL,
  SEARCH_CODE_TOOL,
} from "./server.js";

const KINDS = ["function", "class", "file"] as const;

interface Recorder {
  searches: McpSearchRequest[];
  sessionReads: { sessionId: string; limit: number }[];
  listLimits: number[];
  asks: string[];
}

function fakeHost(overrides: Partial<ArcturnMcpHost> = {}): {
  host: ArcturnMcpHost;
  seen: Recorder;
} {
  const seen: Recorder = { searches: [], sessionReads: [], listLimits: [], asks: [] };
  const host: ArcturnMcpHost = {
    chunkKinds: KINDS,
    async searchCode(request): Promise<McpSearchOutcome> {
      seen.searches.push(request);
      return {
        hits: [
          { path: "src/auth.ts", line: 12, kind: "function", name: "signIn", signature: "fn()" },
        ],
        totalMatches: 1,
      };
    },
    async listSessions(limit) {
      seen.listLimits.push(limit);
      return [{ sessionId: "sess-1", createdAt: "2026-08-23T00:00:00.000Z", title: "Auth" }];
    },
    async readSession(sessionId, limit) {
      seen.sessionReads.push({ sessionId, limit });
      return {
        sessionId,
        entries: [{ role: "user", text: "hello" }],
        omitted: 0,
      };
    },
    ...overrides,
  };
  return { host, seen };
}

const openClients: Client[] = [];

async function connect(host: ArcturnMcpHost): Promise<Client> {
  const server = createArcturnMcpServer({
    host,
    serverInfo: { name: "arcturn", version: "0.1.0" },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close();
});

describe("tool surface", () => {
  it("advertises only the three read-only tools when the host grants no agent", async () => {
    const { host } = fakeHost();
    const client = await connect(host);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual([SEARCH_CODE_TOOL, LIST_SESSIONS_TOOL, READ_SESSION_TOOL]);
  });

  it("advertises ask_arcturn exactly when the host carries the capability", async () => {
    const { host } = fakeHost({
      askArcturn: async (): Promise<McpAskOutcome> => ({
        text: "done",
        tools: [],
        turns: 1,
        reason: "completed",
      }),
    });
    const client = await connect(host);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain(ASK_ARCTURN_TOOL);
  });

  it("declares no capability other than tools", async () => {
    const { host } = fakeHost();
    const client = await connect(host);
    const capabilities = client.getServerCapabilities();
    expect(capabilities).toEqual({ tools: {} });
  });

  it("closes the kind enum over the host's vocabulary", async () => {
    const { host } = fakeHost();
    const client = await connect(host);
    const search = (await client.listTools()).tools.find((t) => t.name === SEARCH_CODE_TOOL);
    expect(JSON.stringify(search?.inputSchema)).toContain('"function","class","file"');
  });

  it("refuses a tool name it never advertised, without throwing a protocol error", async () => {
    const { host } = fakeHost();
    const client = await connect(host);
    const result = (await client.callTool({ name: "write_file", arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown tool "write_file"');
  });
});

describe("search_code", () => {
  it("returns addresses and points the caller at the file", async () => {
    const { host } = fakeHost();
    const client = await connect(host);
    const result = (await client.callTool({
      name: SEARCH_CODE_TOOL,
      arguments: { query: "sign in" },
    })) as CallToolResult;
    expect(textOf(result)).toContain("src/auth.ts:12  function signIn");
    // Only what was disclosed is counted: the host's pre-filter `totalMatches`
    // is not rendered, because the difference between it and what came back is
    // a withheld count written as subtraction.
    expect(textOf(result)).toContain("1 result shown");
    expect(textOf(result)).not.toContain("of 1 match");
  });

  it("withholds hits whose path is a credential file", async () => {
    const { host } = fakeHost({
      async searchCode(): Promise<McpSearchOutcome> {
        return {
          hits: [
            { path: ".env.production", line: 1, kind: "file", name: ".env.production" },
            { path: "deploy/server.key", line: 1, kind: "file", name: "server.key" },
            { path: "src/ok.ts", line: 3, kind: "function", name: "ok" },
          ],
          totalMatches: 3,
        };
      },
    });
    const client = await connect(host);
    const text = textOf(
      (await client.callTool({
        name: SEARCH_CODE_TOOL,
        arguments: { query: "SECRET_KEY" },
      })) as CallToolResult,
    );
    expect(text).not.toContain(".env.production");
    expect(text).not.toContain("server.key");
    expect(text).toContain("src/ok.ts:3");
    expect(text).toContain("2 results withheld");
  });

  it("refuses detail: full so the index never becomes a bulk file reader", async () => {
    const { host, seen } = fakeHost();
    const client = await connect(host);
    const result = (await client.callTool({
      name: SEARCH_CODE_TOOL,
      arguments: { query: "x", detail: "full" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("detail");
    expect(seen.searches).toHaveLength(0);
  });

  it("refuses an absolute or traversing path filter", async () => {
    const { host, seen } = fakeHost();
    const client = await connect(host);
    for (const path of ["../../etc", "/etc/passwd", "C:\\Windows", "src/../../secrets"]) {
      const result = (await client.callTool({
        name: SEARCH_CODE_TOOL,
        arguments: { query: "x", path },
      })) as CallToolResult;
      expect(result.isError, path).toBe(true);
      expect(textOf(result)).toContain("repo-relative");
    }
    expect(seen.searches).toHaveLength(0);
  });

  it("clamps an oversized limit rather than passing it through", async () => {
    const { host, seen } = fakeHost();
    const client = await connect(host);
    await client.callTool({ name: SEARCH_CODE_TOOL, arguments: { query: "x", limit: 100_000 } });
    expect(seen.searches[0]?.limit).toBe(LIMITS.listLimit);
  });

  it("rejects a query longer than the cap before the host sees it", async () => {
    const { host, seen } = fakeHost();
    const client = await connect(host);
    const result = (await client.callTool({
      name: SEARCH_CODE_TOOL,
      arguments: { query: "a".repeat(LIMITS.queryChars + 1) },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(seen.searches).toHaveLength(0);
  });

  it("rejects a kind outside the host's vocabulary", async () => {
    const { host, seen } = fakeHost();
    const client = await connect(host);
    const result = (await client.callTool({
      name: SEARCH_CODE_TOOL,
      arguments: { query: "x", kind: "secret" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(seen.searches).toHaveLength(0);
  });
});

describe("search_code disclosure", () => {
  /**
   * A host that filters credential files itself — like the real one — and so
   * reports a withheld count that moves with the query. Whatever this host
   * knows about `secretToken`, the peer must not be able to read back.
   */
  function oracleHost(secretToken: string): ArcturnMcpHost {
    return fakeHost({
      async searchCode(request): Promise<McpSearchOutcome> {
        const inCredentialFile = request.query.includes(secretToken);
        return {
          hits: [
            { path: "src/app.ts", line: 4, kind: "function", name: "boot", signature: "boot()" },
          ],
          totalMatches: inCredentialFile ? 2 : 1,
          withheld: inCredentialFile ? 1 : 0,
        };
      },
    }).host;
  }

  it("answers identically whether or not the query matched a credential file", async () => {
    // The oracle this closes: the old `N results withheld` line, and the
    // `N shown of M matches` line that leaks the same bit by subtraction, were
    // both computed after the index had ranked the credential file.
    const client = await connect(oracleHost("correcthorse"));
    const present = textOf(
      (await client.callTool({
        name: SEARCH_CODE_TOOL,
        arguments: { query: "correcthorse" },
      })) as CallToolResult,
    );
    const absent = textOf(
      (await client.callTool({
        name: SEARCH_CODE_TOOL,
        arguments: { query: "wronghorse" },
      })) as CallToolResult,
    );
    expect(present).toBe(absent);
    expect(present).not.toMatch(/\d+ results? withheld/);
  });

  it("says the same thing about an all-withheld query as about an empty one", async () => {
    const client = await connect(
      fakeHost({
        async searchCode(request): Promise<McpSearchOutcome> {
          const hit = request.query.includes("correcthorse");
          return { hits: [], totalMatches: hit ? 1 : 0, ...(hit ? { withheld: 1 } : {}) };
        },
      }).host,
    );
    const scrub = (text: string, query: string): string => text.replaceAll(query, "<query>");
    const present = scrub(
      textOf(
        (await client.callTool({
          name: SEARCH_CODE_TOOL,
          arguments: { query: "correcthorse" },
        })) as CallToolResult,
      ),
      "correcthorse",
    );
    const absent = scrub(
      textOf(
        (await client.callTool({
          name: SEARCH_CODE_TOOL,
          arguments: { query: "wronghorse" },
        })) as CallToolResult,
      ),
      "wronghorse",
    );
    expect(present).toBe(absent);
  });

  it("still tells every caller that filtering happens, so no result reads as absence", async () => {
    // The defect the withheld counter was introduced to fix — silent filtering
    // — stays fixed: the notice is unconditional rather than deleted.
    const { host } = fakeHost();
    const client = await connect(host);
    const text = textOf(
      (await client.callTool({
        name: SEARCH_CODE_TOOL,
        arguments: { query: "anything" },
      })) as CallToolResult,
    );
    expect(text).toMatch(/results? withheld/);
    expect(text).toContain("never disclosed over MCP");
  });

  it("hands the operator the numbers it refuses the peer", async () => {
    const events: { hostWithheld: number; serverWithheld: number }[] = [];
    const { host } = fakeHost({
      async searchCode(): Promise<McpSearchOutcome> {
        return {
          hits: [
            { path: "config/production.env", line: 1, kind: "file", name: "production" },
            { path: "src/ok.ts", line: 3, kind: "function", name: "ok" },
          ],
          totalMatches: 9,
          withheld: 4,
        };
      },
    });
    const server = createArcturnMcpServer({ host, onWithheld: (event) => events.push(event) });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);

    const text = textOf(
      (await client.callTool({
        name: SEARCH_CODE_TOOL,
        arguments: { query: "DATABASE_URL" },
      })) as CallToolResult,
    );
    expect(events).toEqual([{ hostWithheld: 4, serverWithheld: 1 }]);
    // The host's four never become a number on the wire; the one this server
    // caught does, because it reports a host that failed to filter.
    expect(text).not.toContain("4 results withheld");
    expect(text).toContain("1 result withheld");
    expect(text).not.toContain("production.env");
  });

  it("never renders the body of a whole-file chunk, however short the file is", async () => {
    // `detail: "full"` was cut so this tool could not read arbitrary indexed
    // paths. For a file the index stores as one chunk, an unbounded snippet is
    // that same read under another name.
    const { host } = fakeHost({
      async searchCode(): Promise<McpSearchOutcome> {
        return {
          hits: [
            {
              path: "config/settings.yaml",
              line: 1,
              kind: "file",
              name: "settings",
              snippet: "db:\n  password: PLAINTEXT_PASSWORD\n",
            },
          ],
          totalMatches: 1,
        };
      },
    });
    const client = await connect(host);
    const text = textOf(
      (await client.callTool({
        name: SEARCH_CODE_TOOL,
        arguments: { query: "password", detail: "snippets" },
      })) as CallToolResult,
    );
    expect(text).toContain("config/settings.yaml:1");
    expect(text).not.toContain("PLAINTEXT_PASSWORD");
    expect(text).toContain("whole-file matches");
  });

  it("bounds a declaration snippet to a few lines rather than the chunk", async () => {
    const body = Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n");
    const { host } = fakeHost({
      async searchCode(): Promise<McpSearchOutcome> {
        return {
          hits: [{ path: "src/big.ts", line: 1, kind: "function", name: "big", snippet: body }],
          totalMatches: 1,
        };
      },
    });
    const client = await connect(host);
    const text = textOf(
      (await client.callTool({
        name: SEARCH_CODE_TOOL,
        arguments: { query: "big", detail: "snippets" },
      })) as CallToolResult,
    );
    const rendered = text.split("\n").filter((line) => line.startsWith("    | line-"));
    expect(rendered).toHaveLength(LIMITS.snippetLines);
    expect(text).toContain("snippet truncated");
    expect(text).not.toContain("line-39");
  });
});

describe("read_session", () => {
  it("projects a transcript", async () => {
    const { host, seen } = fakeHost();
    const client = await connect(host);
    const text = textOf(
      (await client.callTool({
        name: READ_SESSION_TOOL,
        arguments: { session_id: "sess-1" },
      })) as CallToolResult,
    );
    expect(text).toContain("session sess-1");
    expect(text).toContain("hello");
    expect(seen.sessionReads[0]).toEqual({
      sessionId: "sess-1",
      limit: LIMITS.defaultTranscriptLimit,
    });
  });

  it("refuses a traversing session id before the host is called", async () => {
    const { host, seen } = fakeHost();
    const client = await connect(host);
    for (const id of ["../../../etc/passwd", "a/b", "..", ".", "x\u0000y", "a\\b"]) {
      const result = (await client.callTool({
        name: READ_SESSION_TOOL,
        arguments: { session_id: id },
      })) as CallToolResult;
      expect(result.isError, id).toBe(true);
      expect(textOf(result)).toContain("Invalid session id");
    }
    expect(seen.sessionReads).toHaveLength(0);
  });
});

describe("ask_arcturn", () => {
  it("has no parameter that could change the permission mode or working directory", async () => {
    const { host } = fakeHost({
      askArcturn: async () => ({ text: "ok", tools: [], turns: 1, reason: "completed" as const }),
    });
    const client = await connect(host);
    const ask = (await client.listTools()).tools.find((tool) => tool.name === ASK_ARCTURN_TOOL);
    const schema = ask?.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["prompt"]);
  });

  it("reports the tools the agent ran", async () => {
    const { host } = fakeHost({
      askArcturn: async ({ prompt }) => ({
        text: `answered: ${prompt}`,
        tools: ["read", "grep"],
        turns: 3,
        reason: "completed" as const,
        costUsd: 0.0123,
      }),
    });
    const client = await connect(host);
    const text = textOf(
      (await client.callTool({
        name: ASK_ARCTURN_TOOL,
        arguments: { prompt: "what does auth do" },
      })) as CallToolResult,
    );
    expect(text).toContain("answered: what does auth do");
    expect(text).toContain("[tools run: read, grep]");
    expect(text).toContain("[3 turns, completed, $0.0123]");
  });

  it("is not callable when the host withheld the capability", async () => {
    const { host } = fakeHost();
    const client = await connect(host);
    const result = (await client.callTool({
      name: ASK_ARCTURN_TOOL,
      arguments: { prompt: "rm -rf /" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("read-only");
  });
});

describe("failure disclosure", () => {
  it("never forwards an unexpected error's message to the client", async () => {
    const seen: unknown[] = [];
    const host = fakeHost({
      async searchCode(): Promise<McpSearchOutcome> {
        throw new Error("ENOENT: /Users/alice/.arcturn/index/deadbeef — token sk-live-42");
      },
    }).host;
    const server = createArcturnMcpServer({
      host,
      onInternalError: (_tool, error) => seen.push(error),
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);

    const result = (await client.callTool({
      name: SEARCH_CODE_TOOL,
      arguments: { query: "x" },
    })) as CallToolResult;
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).not.toContain("/Users/alice");
    expect(text).not.toContain("sk-live-42");
    expect(text).toContain("See the arcturn server's log");
    // The operator still gets the real thing.
    expect(String(seen[0])).toContain("sk-live-42");
  });

  it("caps the text of any one result", async () => {
    const { host } = fakeHost({
      askArcturn: async () => ({
        text: "x".repeat(LIMITS.resultChars * 2),
        tools: [],
        turns: 1,
        reason: "completed" as const,
      }),
    });
    const client = await connect(host);
    const result = (await client.callTool({
      name: ASK_ARCTURN_TOOL,
      arguments: { prompt: "go" },
    })) as CallToolResult;
    expect(textOf(result).length).toBeLessThanOrEqual(LIMITS.resultChars + 32);
  });
});

describe("isSensitivePath", () => {
  it("matches credential files by path shape", () => {
    for (const path of [
      ".env",
      ".env.local",
      "apps/web/.env.production",
      ".envrc",
      "certs/server.pem",
      "deploy/tls.key",
      "keys/apple.p8",
      "home/.ssh/config",
      "infra/.aws/credentials",
      ".npmrc",
      "packages/x/.netrc",
      "id_ed25519",
      "secrets/credentials",
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
  });

  it("matches the spellings that live beside the dotfile ones", () => {
    // Every one of these holds exactly the bytes the dotfile spellings hold,
    // and every one of them matched nothing while the list was anchored to a
    // whole path segment.
    for (const path of [
      "config/production.env",
      "env/production.env",
      ".env-production",
      ".env_local",
      ".envrc.local",
      "credentials.json",
      "deploy/credentials.yaml",
      "private.pem.bak",
      "deploy/tls.key.old",
      "certs/server.pem.1",
      ".npmrc.local",
      "secrets/client_secret_9.apps.googleusercontent.com.json",
      "svc/service_account.json",
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
  });

  it("leaves ordinary source alone", () => {
    for (const path of [
      "src/secrets.ts",
      "src/env.ts",
      "docs/environment.md",
      "src/keyboard.tsx",
      "test/fixtures/envelope.json",
      "src/ssh-client.ts",
      // The widened shapes must not swallow code named after a credential: a
      // trailing extension outside the known backup/data sets is source.
      "src/api.key.ts",
      "src/credentials.ts",
      "src/credentials-store.tsx",
      "math/implement.pemdas",
      "src/environments/prod.ts",
    ]) {
      expect(isSensitivePath(path), path).toBe(false);
    }
  });

  it("normalises Windows separators before matching", () => {
    expect(isSensitivePath("apps\\web\\.env.production")).toBe(true);
  });

  it("counts what it withholds", () => {
    const partition = withholdSensitive([{ path: ".env" }, { path: "a.ts" }, { path: "b.pem" }]);
    expect(partition.kept).toEqual([{ path: "a.ts" }]);
    expect(partition.withheld).toBe(2);
  });
});
