/**
 * The OAuth flow, against a server that actually refuses without a token.
 *
 * `oauth.test.ts` covers the provider's pieces — storage round-trips, the
 * state value, the metadata it advertises. Every one of those passes with a
 * provider that could never complete an authorization, because none of them
 * involves an authorization server. This file closes that gap: a real HTTP
 * listener speaking RFC 9728 resource metadata, RFC 8414 server metadata,
 * RFC 7591 registration and a PKCE-checked token endpoint, serving MCP only to
 * a request carrying a token it issued.
 *
 * The question it settles is the one asked about any hosted MCP server — does
 * this work at all against something that requires OAuth — and the answer has
 * to be a run rather than a reading of the provider.
 *
 * The SDK's server half is reached through `createRequire`, the way
 * `transport-effects.review.test.ts` reaches it, with raw JSON schemas rather
 * than the `McpServer` helper: that helper wants zod and this package does not
 * depend on it.
 */

import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { type McpOAuthCredentials, McpOAuthProvider } from "./oauth.js";

const require_ = createRequire(import.meta.url);
const SDK = dirname(require_.resolve("@modelcontextprotocol/sdk/types.js"));

interface Stub {
  readonly base: string;
  /** What the authorization server did, in order, so the flow can be asserted. */
  readonly log: string[];
  close(): Promise<void>;
}

const running: Stub[] = [];
afterEach(async () => {
  for (const stub of running.splice(0)) await stub.close();
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => {
      text += String(chunk);
    });
    request.on("end", () => resolve(text));
  });
}

async function startStub(): Promise<Stub> {
  const { Server } = require_(join(SDK, "server", "index.js"));
  const { StreamableHTTPServerTransport } = require_(join(SDK, "server", "streamableHttp.js"));
  const T = require_(join(SDK, "types.js"));

  const log: string[] = [];
  const challenges = new Map<string, string>();
  const tokens = new Set<string>();
  let base = "";

  const makeServer = () => {
    const server = new Server({ name: "stub", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(T.ListToolsRequestSchema, () => ({
      tools: [
        { name: "get_code", description: "Code for a frame.", inputSchema: { type: "object" } },
      ],
    }));
    server.setRequestHandler(
      T.CallToolRequestSchema,
      (request: { params: { arguments?: Record<string, string> } }) => ({
        content: [{ type: "text", text: `<Frame id="${request.params.arguments?.nodeId}"/>` }],
      }),
    );
    return server;
  };

  const http: HttpServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", base);
      const send = (code: number, payload: unknown) => {
        response.writeHead(code, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        log.push("resource-metadata");
        return send(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (
        url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
        url.pathname.startsWith("/.well-known/openid-configuration")
      ) {
        log.push("server-metadata");
        return send(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const parsed = JSON.parse(await readBody(request)) as { redirect_uris?: string[] };
        log.push(`register:${parsed.redirect_uris?.[0] ?? "none"}`);
        return send(201, {
          client_id: "client-1",
          redirect_uris: parsed.redirect_uris,
          token_endpoint_auth_method: "none",
        });
      }
      if (url.pathname === "/authorize") {
        challenges.set("code-1", url.searchParams.get("code_challenge") ?? "");
        log.push(`authorize:${url.searchParams.get("code_challenge_method")}`);
        return send(200, { ok: true });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await readBody(request));
        const expected = challenges.get(form.get("code") ?? "");
        const derived = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (expected === undefined || derived !== expected) {
          log.push("token:pkce-rejected");
          return send(400, { error: "invalid_grant" });
        }
        tokens.add("tok-1");
        log.push("token:issued");
        return send(200, { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.pathname === "/mcp") {
        const header = request.headers.authorization ?? "";
        if (!header.startsWith("Bearer ") || !tokens.has(header.slice(7))) {
          log.push("mcp:401");
          response.writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          });
          return response.end();
        }
        log.push("mcp:authorized");
        const raw = await readBody(request);
        const inner = makeServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        response.on("close", () => {
          void transport.close();
          void inner.close();
        });
        await inner.connect(transport);
        return transport.handleRequest(request, response, raw === "" ? undefined : JSON.parse(raw));
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const stub: Stub = {
    base,
    log,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
  running.push(stub);
  return stub;
}

/** In-memory credentials, standing in for the CLI's 0600 file. */
function memoryStorage() {
  let record: McpOAuthCredentials | undefined;
  return {
    peek: () => record,
    load: async () => record,
    save: async (next: McpOAuthCredentials) => {
      record = { ...record, ...next };
    },
    clear: async () => {
      record = undefined;
    },
  };
}

describe("a hosted MCP server that requires OAuth", () => {
  it("registers, proves PKCE, and reaches the tools behind the 401", async () => {
    const stub = await startStub();
    const storage = memoryStorage();

    // The server really does guard the endpoint, and says where to authorize.
    // Asserted before anything else, because every step after it is only
    // meaningful if an unauthenticated call would have been refused.
    const unauthorized = await fetch(`${stub.base}/mcp`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toContain("resource_metadata=");

    let authorizeUrl: URL | undefined;
    const provider = new McpOAuthProvider({
      serverName: "stub",
      storage,
      redirectUrl: "http://127.0.0.1:9999/callback",
      state: "state-1",
      clientName: "Arcturn",
      prompt: async (url: URL) => {
        authorizeUrl = url;
        // Standing in for the person: hit the authorization endpoint so the
        // server records the challenge, exactly as their browser would.
        await fetch(url.toString());
      },
    });

    // No credentials yet, so the SDK discovers, registers, and stops where a
    // human has to approve.
    const first = await auth(provider, { serverUrl: `${stub.base}/mcp` });
    expect(first).toBe("REDIRECT");
    expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl?.searchParams.get("state")).toBe("state-1");

    const second = await auth(provider, {
      serverUrl: `${stub.base}/mcp`,
      authorizationCode: "code-1",
    });
    expect(second).toBe("AUTHORIZED");

    // Persisted, not merely held by the SDK for the length of the call.
    expect(storage.peek()?.tokens?.access_token).toBe("tok-1");
    expect(storage.peek()?.clientInformation?.client_id).toBe("client-1");

    // And it reaches the server: a real connection and a real tool call.
    const client = new Client({ name: "arcturn-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${stub.base}/mcp`), { authProvider: provider }),
      { timeout: 20_000 },
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("get_code");
    const called = await client.callTool({ name: "get_code", arguments: { nodeId: "12:34" } });
    // The block itself, not a JSON dump of it: stringifying escapes every
    // quote, so a needle carrying quotes never matches the haystack.
    const blocks = called.content as { type: string; text: string }[];
    expect(blocks[0]?.text).toBe('<Frame id="12:34"/>');
    await client.close();

    // The whole exchange: the refusal, the registration, the token, and a
    // request that got through. auth() begins at discovery rather than at a
    // 401, so the refusal above is the one in this log.
    expect(stub.log).toContain("mcp:401");
    expect(stub.log).toContain("resource-metadata");
    expect(stub.log).toContain("register:http://127.0.0.1:9999/callback");
    expect(stub.log).toContain("token:issued");
    expect(stub.log).toContain("mcp:authorized");
  }, 60_000);

  it("refuses a token exchange whose PKCE verifier does not match", async () => {
    // The guarantee PKCE exists for: an intercepted code is not enough on its
    // own. Driven against the endpoint rather than trusting that the SDK sends
    // a verifier at all.
    const stub = await startStub();
    const challenge = createHash("sha256").update("real-verifier").digest("base64url");
    await fetch(`${stub.base}/authorize?code_challenge=${challenge}&code_challenge_method=S256`);

    const response = await fetch(`${stub.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "code-1",
        code_verifier: "wrong-verifier",
      }),
    });
    expect(response.status).toBe(400);
    expect(stub.log).toContain("token:pkce-rejected");
  }, 30_000);
});
