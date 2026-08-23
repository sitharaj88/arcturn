import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpConfig } from "@arcturn/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpManager, type McpTransportFactory } from "./manager.js";
import { McpAuthRequiredError, McpOAuthProvider, MemoryMcpOAuthStorage } from "./oauth.js";
import {
  createTestServer,
  FailingTransport,
  stubPermissionRequester,
  type TestServerHandle,
} from "./test-support.js";

const config: McpConfig = {
  servers: {
    alpha: { type: "stdio", command: "unused" },
    "beta server": { type: "stdio", command: "unused" },
    broken: { type: "stdio", command: "unused" },
  },
};

describe("McpManager", () => {
  let handles: TestServerHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.server.close();
    handles = [];
  });

  function buildTransportFactory(): McpTransportFactory {
    return (name) => {
      if (name === "broken") {
        return new FailingTransport("simulated connect failure");
      }
      const handle = createTestServer();
      handles.push(handle);
      return handle.clientTransport;
    };
  }

  it("connects good servers concurrently and isolates a failing one", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connect();

    const status = manager.status();
    expect(status.alpha).toEqual({ state: "connected", toolCount: 3 });
    expect(status["beta server"]).toEqual({ state: "connected", toolCount: 3 });
    expect(status.broken?.state).toBe("failed");
    expect(status.broken?.error).toMatch(/simulated connect failure/);
  });

  it("aggregates bridged tools across servers with sanitized, server-scoped names", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connect();

    const names = manager
      .tools()
      .map((t) => t.definition.name)
      .sort();
    expect(names).toEqual(
      [
        "mcp__alpha__echo",
        "mcp__alpha__boom",
        "mcp__alpha__snapshot",
        "mcp__beta_server__echo",
        "mcp__beta_server__boom",
        "mcp__beta_server__snapshot",
      ].sort(),
    );

    await manager.close();
  });

  it("executes a bridged tool end-to-end through requestPermission", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connect();
    const echo = manager.tools().find((t) => t.definition.name === "mcp__alpha__echo");
    expect(echo).toBeDefined();

    const result = await echo?.execute(
      { message: "ping" },
      {
        cwd: "/tmp",
        signal: new AbortController().signal,
        requestPermission: stubPermissionRequester("allow"),
        onUpdate: () => {},
        sessionId: "s1",
        toolCallId: "c1",
      },
    );
    expect(result).toEqual({ content: [{ type: "text", text: "ping" }], isError: false });

    await manager.close();
  });

  it("connectServer/disconnectServer support runtime reconfiguration", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connectServer("alpha");
    expect(manager.status().alpha?.state).toBe("connected");
    expect(manager.tools()).toHaveLength(3);

    await manager.disconnectServer("alpha");
    expect(manager.status().alpha?.state).toBe("disconnected");
    expect(manager.tools()).toHaveLength(0);
  });

  it("close() tears down every connected server", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connect();
    await manager.close();
    expect(manager.tools()).toHaveLength(0);
  });

  it("refreshes a server's tools and notifies subscribers on tools/list_changed", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connect();

    const events: string[] = [];
    const unsubscribe = manager.onToolsChanged((event) => {
      events.push(event.server);
    });

    // Add a 4th tool on every good server and announce the change; assert at least one manager
    // server picks it up (each handle corresponds 1:1 with a connected server).
    for (const h of handles) {
      h.setTools([
        ...h.tools,
        { name: "extra", description: "extra tool", inputSchema: { type: "object" } },
      ]);
      await h.announceToolsChanged();
    }

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(0);
    });

    const toolNames = manager.tools().map((t) => t.definition.name);
    expect(toolNames.some((n) => n.endsWith("__extra"))).toBe(true);

    unsubscribe();
    await manager.close();
  });

  it("throws when connecting an unknown server name", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await expect(manager.connectServer("does-not-exist")).rejects.toThrow(/Unknown MCP server/);
  });

  it("refreshes a server's resources and notifies subscribers on resources/list_changed", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connect();

    const events: string[] = [];
    const unsubscribe = manager.onResourcesChanged((event) => {
      events.push(event.server);
    });

    for (const h of handles) {
      h.setResources([
        ...h.resources,
        { uri: "test://extra.txt", name: "extra", mimeType: "text/plain" },
      ]);
      await h.announceResourcesChanged();
    }

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(0);
    });

    unsubscribe();
    await manager.close();
  });

  it("refreshes a server's prompts and notifies subscribers on prompts/list_changed", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connect();

    const events: string[] = [];
    const unsubscribe = manager.onPromptsChanged((event) => {
      events.push(event.server);
    });

    for (const h of handles) {
      h.setPrompts([...h.prompts, { name: "extra-prompt" }]);
      await h.announcePromptsChanged();
    }

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(0);
    });

    unsubscribe();
    await manager.close();
  });

  it("subscribeResource delegates to the SDK and delivers resources/updated events", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connectServer("alpha");

    const events: { server: string; uri: string }[] = [];
    const unsubscribe = manager.onResourceUpdated((event) => events.push(event));

    await manager.subscribeResource("alpha", "test://greeting.txt");

    const handle = handles.find((h) => h.subscribedUris.has("test://greeting.txt"));
    expect(handle).toBeDefined();

    await handle?.announceResourceUpdated("test://greeting.txt");

    await vi.waitFor(() => {
      expect(events).toEqual([{ server: "alpha", uri: "test://greeting.txt" }]);
    });

    await manager.unsubscribeResource("alpha", "test://greeting.txt");
    expect(handle?.subscribedUris.has("test://greeting.txt")).toBe(false);

    unsubscribe();
    await manager.close();
  });

  it("subscribeResource rejects cleanly when the server doesn't support subscriptions", async () => {
    const manager = new McpManager(
      { servers: { alpha: config.servers.alpha } },
      {
        transportFactory: () => {
          const handle = createTestServer({ subscribable: false });
          handles.push(handle);
          return handle.clientTransport;
        },
      },
    );
    await manager.connectServer("alpha");

    await expect(manager.subscribeResource("alpha", "test://greeting.txt")).rejects.toThrow(
      /does not support resource subscriptions/,
    );

    await manager.close();
  });

  it("passes the OAuth provider's token to the real HTTP transport", async () => {
    // A live OAuth dance can't run in CI, so this exercises the seam that
    // actually regressed: the manager must hand the SDK transport an
    // `authProvider`, and the transport must put its token on the wire.
    const seen: (string | undefined)[] = [];
    const http = createServer((request, response) => {
      seen.push(request.headers.authorization);
      // 401 without a resource-metadata hint ends the SDK's auth attempt
      // quickly; the header assertion below is the point of the test.
      response.writeHead(401, { "www-authenticate": "Bearer" });
      response.end();
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;

    const storage = new MemoryMcpOAuthStorage({
      tokens: { access_token: "token-on-the-wire", token_type: "Bearer" },
      clientInformation: { client_id: "cid" },
    });
    const httpConfig: McpConfig = {
      servers: {
        remote: { type: "http", url: `http://127.0.0.1:${port}/mcp`, auth: "oauth" },
      },
    };
    const manager = new McpManager(httpConfig, {
      authProviderFactory: (name, server) =>
        server.type === "http" && server.auth === "oauth"
          ? new McpOAuthProvider({ serverName: name, storage })
          : undefined,
    });

    await manager.connectServer("remote");

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe("Bearer token-on-the-wire");
    expect(manager.status().remote?.state).toBe("failed");

    await manager.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it("runs the authorization handler once and retries the connection", async () => {
    let attempt = 0;
    const onAuthorizationRequired = vi.fn(() => true);
    const manager = new McpManager(
      { servers: { alpha: { type: "stdio", command: "unused" } } },
      {
        onAuthorizationRequired,
        transportFactory: () => {
          attempt += 1;
          if (attempt === 1) throw new McpAuthRequiredError("alpha");
          const handle = createTestServer();
          handles.push(handle);
          return handle.clientTransport;
        },
      },
    );

    await manager.connectServer("alpha");

    expect(onAuthorizationRequired).toHaveBeenCalledTimes(1);
    expect(manager.status().alpha?.state).toBe("connected");
    await manager.close();
  });

  it("keeps the run-auth-first message when authorization is not possible", async () => {
    const manager = new McpManager(
      { servers: { alpha: { type: "stdio", command: "unused" } } },
      {
        onAuthorizationRequired: () => false,
        transportFactory: () => {
          throw new McpAuthRequiredError("alpha");
        },
      },
    );

    await manager.connectServer("alpha");

    expect(manager.status().alpha).toEqual({
      state: "failed",
      error: expect.stringContaining("arcturn mcp auth alpha"),
    });
  });

  it("ping resolves true for a live server", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connectServer("alpha");

    await expect(manager.ping("alpha")).resolves.toBe(true);

    await manager.close();
  });

  it("ping resolves false when the server doesn't respond within the timeout", async () => {
    const manager = new McpManager(config, { transportFactory: buildTransportFactory() });
    await manager.connectServer("alpha");

    const handle = handles[0];
    // Simulate a hung server: swallow the ping request instead of responding.
    // @ts-expect-error -- reaching into the low-level Server to drop requests.
    handle.server._requestHandlers.delete("ping");

    await expect(manager.ping("alpha", 50)).resolves.toBe(false);

    await manager.close();
  });
});
