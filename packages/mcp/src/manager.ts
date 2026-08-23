/**
 * Connects to a set of configured MCP servers, bridges their tools, and keeps
 * per-server connection state isolated so one bad server never breaks the rest.
 */

import type { McpConfig, McpServerConfig, Tool } from "@arcturn/types";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type Prompt as McpPromptDescriptor,
  type Resource as McpResourceDescriptor,
  type Tool as McpToolDescriptor,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { McpToolBridge } from "./bridge.js";
import { isMcpAuthRequiredError } from "./oauth.js";
import {
  getPrompt as getPromptImpl,
  listPrompts as listPromptsImpl,
  listResources as listResourcesImpl,
  type McpPromptInfo,
  type McpPromptMessage,
  type McpResourceContent,
  type McpResourceInfo,
  readResource as readResourceImpl,
} from "./resources.js";

/** Connection state for a single configured MCP server. */
export type McpServerConnectionState = "disconnected" | "connecting" | "connected" | "failed";

/** Point-in-time status for a configured MCP server. */
export interface McpServerStatus {
  state: McpServerConnectionState;
  /** Number of tools currently exposed, populated once connected. */
  toolCount?: number;
  /** Failure reason, populated when `state` is `"failed"`. */
  error?: string;
}

/** Fired when a server's tool list changes, after the bridge has refreshed. */
export interface McpToolsChangedEvent {
  server: string;
  tools: Tool[];
}

/** Fired when a server's resource list changes. */
export interface McpResourcesChangedEvent {
  server: string;
  resources: McpResourceInfo[];
}

/** Fired when a server's prompt list changes. */
export interface McpPromptsChangedEvent {
  server: string;
  prompts: McpPromptInfo[];
}

/** Fired when a subscribed-to resource is updated (`notifications/resources/updated`). */
export interface McpResourceUpdatedEvent {
  server: string;
  uri: string;
}

/**
 * Creates the low-level SDK transport for a server config.
 *
 * Overridable via {@link McpManagerOptions.transportFactory}, primarily so
 * tests can substitute `InMemoryTransport` pairs instead of spawning real
 * processes or opening real sockets.
 */
export type McpTransportFactory = (
  serverName: string,
  config: McpServerConfig,
) => Transport | Promise<Transport>;

/**
 * Supplies the SDK OAuth client provider for one server, or `undefined` when
 * the server is not `auth: "oauth"`.
 *
 * Kept as a factory so `@arcturn/mcp` never learns where credentials live: the
 * CLI closes over its `~/.arcturn/auth` layout and hands back a provider.
 */
export type McpAuthProviderFactory = (
  serverName: string,
  config: McpServerConfig,
) => OAuthClientProvider | undefined;

/**
 * Invoked when connecting fails because the server needs an interactive OAuth
 * authorization. Return `true` once the flow has completed and the connection
 * is worth retrying; `false` leaves the server `failed` with the original,
 * URL-free "run arcturn mcp auth" message.
 */
export type McpAuthorizationHandler = (
  serverName: string,
  config: McpServerConfig,
) => boolean | Promise<boolean>;

export interface McpManagerOptions {
  /** Overrides how transports are created. Defaults to the real stdio/HTTP transports. */
  transportFactory?: McpTransportFactory;
  /** Client identity advertised during MCP `initialize`. Defaults to a arcturn identity. */
  clientInfo?: { name: string; version: string };
  /** Per-server OAuth providers, passed to the HTTP transports as `authProvider`. */
  authProviderFactory?: McpAuthProviderFactory;
  /** Runs an interactive authorization after a 401, then retries once. */
  onAuthorizationRequired?: McpAuthorizationHandler;
}

interface ConnectedServer {
  client: Client;
  bridge: McpToolBridge;
}

const DEFAULT_CLIENT_INFO = { name: "arcturn-mcp", version: "0.1.0" };

/**
 * Manages connections to every server in an {@link McpConfig}, bridging their
 * tools, resources, and prompts, and isolating per-server failures so one
 * misbehaving server never prevents the others from working.
 */
export class McpManager {
  private readonly servers = new Map<string, ConnectedServer>();
  private readonly statuses = new Map<string, McpServerStatus>();
  private readonly listeners = new Set<(event: McpToolsChangedEvent) => void>();
  private readonly resourcesChangedListeners = new Set<(event: McpResourcesChangedEvent) => void>();
  private readonly promptsChangedListeners = new Set<(event: McpPromptsChangedEvent) => void>();
  private readonly resourceUpdatedListeners = new Set<(event: McpResourceUpdatedEvent) => void>();
  private readonly transportFactory: McpTransportFactory;
  private readonly usingDefaultTransport: boolean;
  private readonly clientInfo: { name: string; version: string };
  private readonly authProviderFactory: McpAuthProviderFactory | undefined;
  private readonly onAuthorizationRequired: McpAuthorizationHandler | undefined;

  constructor(
    private readonly config: McpConfig,
    options: McpManagerOptions = {},
  ) {
    this.authProviderFactory = options.authProviderFactory;
    this.onAuthorizationRequired = options.onAuthorizationRequired;
    this.transportFactory =
      options.transportFactory ??
      ((name, serverConfig) =>
        createDefaultTransport(name, serverConfig, this.authProviderFactory?.(name, serverConfig)));
    this.usingDefaultTransport = options.transportFactory === undefined;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    for (const name of Object.keys(config.servers)) {
      this.statuses.set(name, { state: "disconnected" });
    }
  }

  /** Connects to every configured server concurrently. Per-server failures are isolated. */
  async connect(): Promise<void> {
    await Promise.all(Object.keys(this.config.servers).map((name) => this.connectServer(name)));
  }

  /** Connects (or reconnects) a single named server. Never throws; check {@link status}. */
  async connectServer(name: string): Promise<void> {
    const config = this.config.servers[name];
    if (!config) {
      throw new Error(`Unknown MCP server "${name}": not present in config.`);
    }

    const failure = await this.attemptConnect(name, config);
    if (failure === undefined) return;

    // A 401 the SDK could not resolve means the user has to approve the grant.
    // Interactive hosts run that flow once and retry; everyone else keeps the
    // "run arcturn mcp auth <name>" message as the server's status.
    if (this.onAuthorizationRequired && isMcpAuthRequiredError(failure)) {
      let authorized = false;
      try {
        authorized = await this.onAuthorizationRequired(name, config);
      } catch (authError) {
        this.statuses.set(name, { state: "failed", error: errorMessage(authError) });
        return;
      }
      if (authorized) {
        const retryFailure = await this.attemptConnect(name, config);
        if (retryFailure === undefined) return;
        this.statuses.set(name, { state: "failed", error: errorMessage(retryFailure) });
        return;
      }
    }
    this.statuses.set(name, { state: "failed", error: errorMessage(failure) });
  }

  /**
   * One connection attempt, including the SSE fallback for HTTP servers.
   *
   * @returns `undefined` on success, otherwise the error to report or retry on.
   */
  private async attemptConnect(name: string, config: McpServerConfig): Promise<unknown> {
    await this.disconnectServer(name);
    this.statuses.set(name, { state: "connecting" });

    try {
      const client = this.createClient(name);
      const transport = await this.transportFactory(name, config);
      await client.connect(transport);
      await this.finishConnect(name, client);
      return undefined;
    } catch (primaryError) {
      if (config.type === "http" && this.usingDefaultTransport) {
        try {
          const client = this.createClient(name);
          const authProvider = this.authProviderFactory?.(name, config);
          const transport = new SSEClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
            ...(authProvider === undefined ? {} : { authProvider }),
          });
          await client.connect(transport);
          await this.finishConnect(name, client);
          return undefined;
        } catch (fallbackError) {
          // An authorization problem is the same on both transports; report the
          // actionable one rather than "SSE handshake failed".
          return isMcpAuthRequiredError(primaryError) ? primaryError : fallbackError;
        }
      }
      return primaryError;
    }
  }

  /** Disconnects a single named server, if connected. Safe to call when not connected. */
  async disconnectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (server) {
      this.servers.delete(name);
      try {
        await server.client.close();
      } catch {
        // Best-effort teardown; the transport may already be gone.
      }
    }
    if (this.config.servers[name]) {
      this.statuses.set(name, { state: "disconnected" });
    }
  }

  /** Tears down every connection. */
  async close(): Promise<void> {
    await Promise.all(Array.from(this.servers.keys()).map((name) => this.disconnectServer(name)));
  }

  /** Per-server connection status and tool counts. */
  status(): Record<string, McpServerStatus> {
    return Object.fromEntries(this.statuses.entries());
  }

  /** All bridged tools across every connected server. */
  tools(): Tool[] {
    const result: Tool[] = [];
    for (const server of this.servers.values()) {
      result.push(...server.bridge.tools());
    }
    return result;
  }

  /** Subscribes to tool-list-changed events; returns an unsubscribe function. */
  onToolsChanged(cb: (event: McpToolsChangedEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Subscribes to resource-list-changed events; returns an unsubscribe function. */
  onResourcesChanged(cb: (event: McpResourcesChangedEvent) => void): () => void {
    this.resourcesChangedListeners.add(cb);
    return () => {
      this.resourcesChangedListeners.delete(cb);
    };
  }

  /** Subscribes to prompt-list-changed events; returns an unsubscribe function. */
  onPromptsChanged(cb: (event: McpPromptsChangedEvent) => void): () => void {
    this.promptsChangedListeners.add(cb);
    return () => {
      this.promptsChangedListeners.delete(cb);
    };
  }

  /** Subscribes to resource-updated events (`notifications/resources/updated`). */
  onResourceUpdated(cb: (event: McpResourceUpdatedEvent) => void): () => void {
    this.resourceUpdatedListeners.add(cb);
    return () => {
      this.resourceUpdatedListeners.delete(cb);
    };
  }

  /** Lists resources for `server`, or every connected server when omitted. */
  async listResources(server?: string): Promise<McpResourceInfo[]> {
    return listResourcesImpl(this.clientMap(), server);
  }

  /** Reads a resource by URI from the given (connected) server. */
  async readResource(server: string, uri: string): Promise<McpResourceContent[]> {
    return readResourceImpl(this.requireClient(server), uri);
  }

  /** Lists prompts for `server`, or every connected server when omitted. */
  async listPrompts(server?: string): Promise<McpPromptInfo[]> {
    return listPromptsImpl(this.clientMap(), server);
  }

  /** Fetches a prompt's rendered messages from the given (connected) server. */
  async getPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<McpPromptMessage[]> {
    return getPromptImpl(this.requireClient(server), name, args);
  }

  /**
   * Subscribes to updates for one resource on `server`, so
   * {@link onResourceUpdated} fires when the server sends
   * `notifications/resources/updated` for it. Never subscribes implicitly —
   * only called when a caller explicitly asks for a given URI.
   *
   * Throws a clear error when the server never declared the
   * `resources.subscribe` capability during `initialize`, rather than letting
   * the request fail deep inside the SDK.
   */
  async subscribeResource(server: string, uri: string): Promise<void> {
    const client = this.requireClient(server);
    if (!client.getServerCapabilities()?.resources?.subscribe) {
      throw new Error(`MCP server "${server}" does not support resource subscriptions.`);
    }
    await client.subscribeResource({ uri });
  }

  /** Cancels a previous {@link subscribeResource} for one resource on `server`. */
  async unsubscribeResource(server: string, uri: string): Promise<void> {
    const client = this.requireClient(server);
    await client.unsubscribeResource({ uri });
  }

  /**
   * Checks whether `server` is still reachable via the MCP `ping` request,
   * bounded by `timeoutMs` so a dead or hung server can't block callers (e.g.
   * `/mcp` status). Returns `false` on timeout or any other error rather than
   * throwing, since "unreachable" is an expected outcome here.
   */
  async ping(server: string, timeoutMs = 3000): Promise<boolean> {
    const client = this.requireClient(server);
    try {
      await client.ping({ timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  private createClient(name: string): Client {
    const client = new Client(this.clientInfo, {
      // Elicitation (server-initiated user prompts) is deliberately not
      // declared here yet: relaying it to the user needs UI design first.
      capabilities: {},
      listChanged: {
        tools: {
          debounceMs: 0,
          onChanged: (error, tools) => {
            if (error || !tools) return;
            this.handleToolsChanged(name, tools);
          },
        },
        resources: {
          debounceMs: 0,
          onChanged: (error, resources) => {
            if (error || !resources) return;
            this.handleResourcesChanged(name, resources);
          },
        },
        prompts: {
          debounceMs: 0,
          onChanged: (error, prompts) => {
            if (error || !prompts) return;
            this.handlePromptsChanged(name, prompts);
          },
        },
      },
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      this.handleResourceUpdated(name, notification.params.uri);
    });
    return client;
  }

  private async finishConnect(name: string, client: Client): Promise<void> {
    const bridge = new McpToolBridge(name, client);
    await bridge.refresh();
    this.servers.set(name, { client, bridge });
    this.statuses.set(name, { state: "connected", toolCount: bridge.tools().length });
  }

  private handleToolsChanged(name: string, tools: McpToolDescriptor[]): void {
    const server = this.servers.get(name);
    if (!server) return;
    server.bridge.setMcpTools(tools);
    this.statuses.set(name, { state: "connected", toolCount: tools.length });
    const event: McpToolsChangedEvent = { server: name, tools: server.bridge.tools() };
    for (const listener of this.listeners) listener(event);
  }

  private handleResourcesChanged(name: string, resources: McpResourceDescriptor[]): void {
    if (!this.servers.has(name)) return;
    const mapped: McpResourceInfo[] = resources.map((resource) => ({
      server: name,
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
    const event: McpResourcesChangedEvent = { server: name, resources: mapped };
    for (const listener of this.resourcesChangedListeners) listener(event);
  }

  private handlePromptsChanged(name: string, prompts: McpPromptDescriptor[]): void {
    if (!this.servers.has(name)) return;
    const mapped: McpPromptInfo[] = prompts.map((prompt) => ({
      server: name,
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    }));
    const event: McpPromptsChangedEvent = { server: name, prompts: mapped };
    for (const listener of this.promptsChangedListeners) listener(event);
  }

  private handleResourceUpdated(name: string, uri: string): void {
    if (!this.servers.has(name)) return;
    const event: McpResourceUpdatedEvent = { server: name, uri };
    for (const listener of this.resourceUpdatedListeners) listener(event);
  }

  private clientMap(): ReadonlyMap<string, Client> {
    const map = new Map<string, Client>();
    for (const [name, server] of this.servers) map.set(name, server.client);
    return map;
  }

  private requireClient(server: string): Client {
    const entry = this.servers.get(server);
    if (!entry) {
      throw new Error(`MCP server "${server}" is not connected.`);
    }
    return entry.client;
  }
}

/**
 * Default transport factory: stdio spawns a child process, http uses
 * streamable-HTTP.
 *
 * `authProvider` is what turns on the SDK's OAuth client for a server; static
 * `headers` are still sent alongside it, so a gateway that wants both an API
 * key and a bearer token keeps working.
 */
function createDefaultTransport(
  _name: string,
  config: McpServerConfig,
  authProvider?: OAuthClientProvider,
): Transport {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
    ...(authProvider === undefined ? {} : { authProvider }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
