import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpOAuthState,
  DEFAULT_MCP_REDIRECT_URL,
  isMcpAuthRequiredError,
  McpAuthRequiredError,
  McpOAuthProvider,
  MemoryMcpOAuthStorage,
} from "./oauth.js";

const tokens: OAuthTokens = { access_token: "at-1", token_type: "Bearer" };

function build(options: { prompt?: (url: URL) => void; redirectUrl?: string } = {}) {
  const storage = new MemoryMcpOAuthStorage();
  const provider = new McpOAuthProvider({
    serverName: "docs",
    storage,
    ...(options.redirectUrl === undefined ? {} : { redirectUrl: options.redirectUrl }),
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  });
  return { storage, provider };
}

describe("McpOAuthProvider", () => {
  it("round-trips tokens, client information and the code verifier through storage", async () => {
    const { storage, provider } = build();
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toBeUndefined();

    await provider.saveClientInformation({ client_id: "cid" });
    await provider.saveCodeVerifier("verifier-1");
    expect(await provider.codeVerifier()).toBe("verifier-1");

    await provider.saveTokens(tokens);
    expect(await provider.tokens()).toEqual(tokens);
    // Saving tokens must not lose the registration…
    expect(await provider.clientInformation()).toEqual({ client_id: "cid" });
    // …but the verifier for the authorization that just completed is dropped.
    expect((await storage.load())?.codeVerifier).toBeUndefined();
  });

  it("clears everything on invalidateCredentials('all') and one field otherwise", async () => {
    const { storage, provider } = build();
    await provider.saveClientInformation({ client_id: "cid" });
    await provider.saveTokens(tokens);

    await provider.invalidateCredentials("tokens");
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toEqual({ client_id: "cid" });

    await provider.invalidateCredentials("all");
    expect(await storage.load()).toBeUndefined();
  });

  it("advertises a loopback redirect and a public-client registration", () => {
    const { provider } = build({ redirectUrl: "http://127.0.0.1:41234/callback" });
    expect(provider.redirectUrl).toBe("http://127.0.0.1:41234/callback");
    const metadata = provider.clientMetadata;
    expect(metadata.redirect_uris).toEqual(["http://127.0.0.1:41234/callback"]);
    expect(metadata.token_endpoint_auth_method).toBe("none");
    expect(metadata.grant_types).toContain("refresh_token");
    // RFC 8252 §7.3: never the string "localhost", which can resolve off-box.
    expect(DEFAULT_MCP_REDIRECT_URL).toContain("127.0.0.1");
    expect(build().provider.redirectUrl).toBe(DEFAULT_MCP_REDIRECT_URL);
  });

  it("keeps one state value for the whole authorization", () => {
    const { provider } = build();
    const first = provider.state();
    expect(first).toBe(provider.state());
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createMcpOAuthState()).not.toBe(first);
  });

  it("uses the caller's state, so a loopback listener can be bound first", () => {
    const provider = new McpOAuthProvider({
      serverName: "docs",
      storage: new MemoryMcpOAuthStorage(),
      state: "state-from-the-listener",
    });
    expect(provider.state()).toBe("state-from-the-listener");
  });

  it("hands the authorization URL to the prompt when one is supplied", async () => {
    const prompt = vi.fn();
    const { provider } = build({ prompt });
    const url = new URL("https://auth.example.com/authorize?client_id=cid");
    await provider.redirectToAuthorization(url);
    expect(prompt).toHaveBeenCalledWith(url);
  });

  it("fails with a run-auth-first message when no interaction is possible", async () => {
    const { provider } = build();
    await expect(
      provider.redirectToAuthorization(new URL("https://auth.example.com/authorize")),
    ).rejects.toThrow(McpAuthRequiredError);
    await expect(
      provider.redirectToAuthorization(new URL("https://auth.example.com/authorize")),
    ).rejects.toThrow(/arcturn mcp auth docs/);
    // The message is surfaced in /mcp status, so it must not carry the URL.
    await expect(provider.codeVerifier()).rejects.toThrow(McpAuthRequiredError);
  });
});

describe("isMcpAuthRequiredError", () => {
  it("recognises our error and the SDK's UnauthorizedError", () => {
    expect(isMcpAuthRequiredError(new McpAuthRequiredError("docs"))).toBe(true);
    expect(isMcpAuthRequiredError(new UnauthorizedError("401"))).toBe(true);
    expect(isMcpAuthRequiredError(new Error("connection refused"))).toBe(false);
    expect(isMcpAuthRequiredError("nope")).toBe(false);
  });
});
