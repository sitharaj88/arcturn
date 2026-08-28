/**
 * The brokered OAuth flow, against a real authorization server.
 *
 * The claim this file has to settle is narrow and load-bearing: when the
 * browser is on a machine the engine cannot reach, an authorization still
 * completes, and it completes with the *client's* redirect URI — not the
 * `127.0.0.1` one the loopback path would have bound. A reading of the broker
 * cannot establish that, because the thing that would break is a value sent to
 * a server: the `redirect_uri` in dynamic client registration and in the
 * authorization request. So the assertions here are on what the authorization
 * server received, not on what the broker returned.
 *
 * The stub is the authorization half of `oauth-flow.effects.test.ts` — RFC 9728
 * resource metadata, RFC 8414 server metadata, RFC 7591 registration, and a
 * token endpoint that verifies the PKCE challenge. The MCP half is absent on
 * purpose: `runMcpOAuthFlow` finishes at the token exchange, and a tool call
 * would test the transport rather than the broker.
 */

import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type McpOAuthCredentials, runMcpOAuthFlow } from "./mcp-auth.js";
import { McpAuthBroker } from "./mcp-auth-broker.js";

interface Stub {
  readonly base: string;
  /** What the authorization server was told, in order. */
  readonly log: string[];
  /** Every `redirect_uri` the server saw, from registration and from /authorize. */
  readonly redirectUris: string[];
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
  const log: string[] = [];
  const redirectUris: string[] = [];
  const challenges = new Map<string, string>();
  let base = "";

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
        for (const uri of parsed.redirect_uris ?? []) redirectUris.push(uri);
        log.push("register");
        return send(201, {
          client_id: "client-1",
          redirect_uris: parsed.redirect_uris,
          token_endpoint_auth_method: "none",
        });
      }
      if (url.pathname === "/authorize") {
        challenges.set("code-1", url.searchParams.get("code_challenge") ?? "");
        const redirect = url.searchParams.get("redirect_uri");
        if (redirect) redirectUris.push(redirect);
        log.push(`authorize:${url.searchParams.get("code_challenge_method")}`);
        return send(200, { ok: true });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await readBody(request));
        // A refresh needs no code and no browser — which is the whole point of
        // the "already authorized" case below.
        if (form.get("grant_type") === "refresh_token") {
          if (form.get("refresh_token") !== "ref-1") {
            log.push("refresh:rejected");
            return send(400, { error: "invalid_grant" });
          }
          log.push("refresh:issued");
          return send(200, {
            access_token: "tok-2",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "ref-1",
          });
        }
        const redirect = form.get("redirect_uri");
        if (redirect) redirectUris.push(redirect);
        const expected = challenges.get(form.get("code") ?? "");
        const derived = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (expected === undefined) {
          log.push(`token:unknown-code:${form.get("code")}`);
          return send(400, { error: "invalid_grant" });
        }
        if (derived !== expected) {
          log.push("token:pkce-rejected");
          return send(400, { error: "invalid_grant" });
        }
        log.push("token:issued");
        return send(200, {
          access_token: "tok-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "ref-1",
        });
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
    redirectUris,
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
      const had = record !== undefined;
      record = undefined;
      return had;
    },
  };
}

/** A broker wired to the real flow and one stub server. */
function brokerFor(stub: Stub, storage: ReturnType<typeof memoryStorage>) {
  return new McpAuthBroker({
    runFlow: runMcpOAuthFlow,
    resolveServer: async () => ({ serverUrl: `${stub.base}/mcp`, storage }),
    timeoutMs: 10_000,
  });
}

/**
 * Stand in for the user's browser.
 *
 * A real client hands the URL to `openExternal` and the user's browser visits
 * the authorization endpoint; that visit is what makes the server record the
 * PKCE challenge against the code it is about to issue. Skipping it would
 * leave the stub with nothing to verify the verifier against, and the token
 * exchange would fail for a reason that has nothing to do with the broker.
 */
async function visitInBrowser(authorizationUrl: string | undefined): Promise<void> {
  await fetch(String(authorizationUrl));
}

/**
 * The authorization URL carries the `state` the engine generated. A client
 * reads it back off its own redirect; here we read it off the URL, which is
 * the same value by the same route.
 */
function stateOf(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get("state") ?? "";
}

describe("authorizing an MCP server through a client's own redirect", () => {
  it("registers the client's redirect URI, not a loopback one", async () => {
    const stub = await startStub();
    const storage = memoryStorage();
    const broker = brokerFor(stub, storage);
    const redirect = "vscode://arcturn.arcturn-vscode/mcp-callback";

    const begun = await broker.begin("figma", redirect);
    expect(begun.authorized).toBe(false);
    expect(begun.authorizationUrl).toBeDefined();

    await visitInBrowser(begun.authorizationUrl);
    await broker.complete(begun.handle ?? "", "code-1", stateOf(begun.authorizationUrl ?? ""));

    // The point of the feature: every redirect_uri the authorization server was
    // shown is the editor's, and none of them is a loopback address.
    expect(stub.redirectUris.length).toBeGreaterThan(0);
    expect(new Set(stub.redirectUris)).toEqual(new Set([redirect]));
    expect(stub.redirectUris.some((uri) => uri.includes("127.0.0.1"))).toBe(false);

    // And it was a real authorization, PKCE included.
    expect(stub.log).toContain("authorize:S256");
    expect(stub.log).toContain("token:issued");
    expect(storage.peek()?.tokens?.access_token).toBe("tok-1");
  });

  it("parks the flow between begin and complete, and finishes on the code", async () => {
    const stub = await startStub();
    const storage = memoryStorage();
    const broker = brokerFor(stub, storage);

    const begun = await broker.begin("figma", "vscode://arcturn.arcturn-vscode/mcp-callback");

    // Between the two calls the exchange has not happened: the flow is parked
    // on a redirect that only `complete` can deliver.
    expect(stub.log).not.toContain("token:issued");
    expect(storage.peek()?.tokens).toBeUndefined();
    expect(broker.pendingCount).toBe(1);

    await visitInBrowser(begun.authorizationUrl);
    await broker.complete(begun.handle ?? "", "code-1", stateOf(begun.authorizationUrl ?? ""));

    expect(stub.log).toContain("token:issued");
    expect(broker.pendingCount).toBe(0);
  });

  it("refuses a code that arrives with the wrong state, and never exchanges it", async () => {
    const stub = await startStub();
    const storage = memoryStorage();
    const broker = brokerFor(stub, storage);

    const begun = await broker.begin("figma", "vscode://arcturn.arcturn-vscode/mcp-callback");

    await expect(broker.complete(begun.handle ?? "", "code-1", "some-other-state")).rejects.toThrow(
      /state did not match/i,
    );

    // The refusal is what matters, but so is its shape: the token endpoint was
    // never reached, so a stolen code cannot be redeemed by replaying it here.
    expect(stub.log).not.toContain("token:issued");
    expect(storage.peek()?.tokens).toBeUndefined();
  });

  it("burns the handle, so a second code cannot be redeemed against it", async () => {
    const stub = await startStub();
    const storage = memoryStorage();
    const broker = brokerFor(stub, storage);

    const begun = await broker.begin("figma", "vscode://arcturn.arcturn-vscode/mcp-callback");
    const state = stateOf(begun.authorizationUrl ?? "");
    await visitInBrowser(begun.authorizationUrl);
    await broker.complete(begun.handle ?? "", "code-1", state);

    await expect(broker.complete(begun.handle ?? "", "code-2", state)).rejects.toThrow(
      /no authorization is waiting/i,
    );
    expect(stub.log).not.toContain("token:unknown-code:code-2");
  });

  it("says so without a browser when stored credentials still work", async () => {
    const stub = await startStub();
    const storage = memoryStorage();
    const broker = brokerFor(stub, storage);

    const first = await broker.begin("figma", "vscode://arcturn.arcturn-vscode/mcp-callback");
    await visitInBrowser(first.authorizationUrl);
    await broker.complete(first.handle ?? "", "code-1", stateOf(first.authorizationUrl ?? ""));

    stub.log.length = 0;
    const again = await broker.begin("figma", "vscode://arcturn.arcturn-vscode/mcp-callback");
    expect(again.authorized).toBe(true);
    expect(again.authorizationUrl).toBeUndefined();
    expect(again.handle).toBeUndefined();
    expect(broker.pendingCount).toBe(0);
    // Not merely "no browser": the credentials were refreshed against the
    // token endpoint, and the new access token was stored.
    expect(stub.log).toContain("refresh:issued");
    expect(storage.peek()?.tokens?.access_token).toBe("tok-2");
  });

  it("drops a cancelled authorization instead of leaving the flow parked", async () => {
    const stub = await startStub();
    const storage = memoryStorage();
    const broker = brokerFor(stub, storage);

    const begun = await broker.begin("figma", "vscode://arcturn.arcturn-vscode/mcp-callback");
    expect(await broker.cancel(begun.handle ?? "")).toBe(true);

    expect(broker.pendingCount).toBe(0);
    expect(stub.log).not.toContain("token:issued");
    // Cancelling twice is a client racing a timeout, not an error.
    expect(await broker.cancel(begun.handle ?? "")).toBe(false);
  });
});
