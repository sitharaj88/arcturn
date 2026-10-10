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
  type ClientCapabilities,
  CreateMessageRequestSchema,
  type CreateMessageResult,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  ErrorCode,
  McpError,
  type Prompt as McpPromptDescriptor,
  type Resource as McpResourceDescriptor,
  type Tool as McpToolDescriptor,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { McpToolBridge } from "./bridge.js";
import {
  checkElicitationContent,
  type McpElicitationHandler,
  type McpElicitationRefusedEvent,
  validateElicitationSchema,
} from "./elicitation.js";
import { isMcpAuthRequiredError } from "./oauth.js";
import {
  getPrompt as getPromptImpl,
  listPrompts as listPromptsImpl,
  listResources as listResourcesImpl,
  listResourceTemplates as listResourceTemplatesImpl,
  type McpPromptInfo,
  type McpPromptMessage,
  type McpResourceContent,
  type McpResourceInfo,
  type McpResourceTemplateInfo,
  readResource as readResourceImpl,
} from "./resources.js";
import {
  DEFAULT_MCP_SAMPLING_MAX_TOKENS,
  type McpSamplingHandler,
  narrowSamplingRequest,
} from "./sampling.js";

export type {
  McpElicitationField,
  McpElicitationHandler,
  McpElicitationRefusedEvent,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationValue,
} from "./elicitation.js";
export {
  DEFAULT_MCP_SAMPLING_MAX_TOKENS,
  type McpSamplingHandler,
  type McpSamplingMessage,
  type McpSamplingRequest,
  type McpSamplingResult,
} from "./sampling.js";

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

/**
 * How long one server gets to complete the MCP `initialize` handshake before
 * the connection is abandoned.
 *
 * The SDK's own default is 60 seconds, and `connect()` is awaited during
 * startup for every configured server, so a server that accepts the connection
 * and then never speaks the protocol — a crashed binary still holding stdout
 * open, an HTTP endpoint that swallows the POST, a package's `mcp.json`
 * pointing at the wrong command — froze the whole CLI for a minute before it
 * would print its first prompt. Half a minute is still generous for a cold
 * `npx` that has to download the server first, and it is bounded.
 */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;

export interface McpManagerOptions {
  /** Overrides how transports are created. Defaults to the real stdio/HTTP transports. */
  transportFactory?: McpTransportFactory;
  /**
   * Ceiling on one server's `initialize` handshake, in milliseconds.
   * Defaults to {@link DEFAULT_MCP_CONNECT_TIMEOUT_MS}. Exceeding it leaves
   * the server `failed` with a timeout message; the SDK closes the transport
   * on the way out, so a spawned stdio child is reaped rather than left
   * running.
   */
  connectTimeoutMs?: number;
  /** Client identity advertised during MCP `initialize`. Defaults to a arcturn identity. */
  clientInfo?: { name: string; version: string };
  /** Per-server OAuth providers, passed to the HTTP transports as `authProvider`. */
  authProviderFactory?: McpAuthProviderFactory;
  /** Runs an interactive authorization after a 401, then retries once. */
  onAuthorizationRequired?: McpAuthorizationHandler;
  /**
   * Answers a server's `elicitation/create` by putting the (already
   * validated, flat) form in front of the user. Form-mode elicitation is
   * advertised to every server either way; without this handler every
   * request is answered `decline`, the honest answer from a host with nobody
   * to ask.
   */
  elicit?: McpElicitationHandler;
  /**
   * Told about each elicitation refused before the user saw it (a schema
   * outside the flat subset), so a host can keep a record. Never awaited; a
   * throw is swallowed.
   */
  onElicitationRefused?: (event: McpElicitationRefusedEvent) => void;
  /**
   * Runs a server's `sampling/createMessage` on the host's model. The
   * `sampling` capability is advertised, and this is called, only for a
   * server whose config says `sampling: true`; every other server's request
   * gets the protocol's MethodNotFound, exactly as from a client that never
   * heard of sampling.
   */
  sample?: McpSamplingHandler;
  /**
   * Output ceiling for one sampling request, in tokens. A server's
   * `maxTokens` can lower it, never raise it. Defaults to
   * {@link DEFAULT_MCP_SAMPLING_MAX_TOKENS}.
   */
  samplingMaxTokens?: number;
}

interface ConnectedServer {
  client: Client;
  bridge: McpToolBridge;
}

/** How many forms one server may put in front of the user per {@link ELICITATION_WINDOW_MS}. */
const MAX_ELICITATIONS_PER_WINDOW = 5;
const ELICITATION_WINDOW_MS = 60_000;

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
  private readonly connectTimeoutMs: number;
  private readonly elicit: McpElicitationHandler | undefined;
  private readonly onElicitationRefused: ((event: McpElicitationRefusedEvent) => void) | undefined;
  private readonly sample: McpSamplingHandler | undefined;
  private readonly samplingMaxTokens: number;
  private readonly elicitationTimes = new Map<string, number[]>();

  constructor(
    private readonly config: McpConfig,
    options: McpManagerOptions = {},
  ) {
    this.authProviderFactory = options.authProviderFactory;
    this.onAuthorizationRequired = options.onAuthorizationRequired;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    this.elicit = options.elicit;
    this.onElicitationRefused = options.onElicitationRefused;
    this.sample = options.sample;
    const ceiling = options.samplingMaxTokens ?? DEFAULT_MCP_SAMPLING_MAX_TOKENS;
    this.samplingMaxTokens =
      Number.isFinite(ceiling) && ceiling >= 1
        ? Math.floor(ceiling)
        : DEFAULT_MCP_SAMPLING_MAX_TOKENS;
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
      // Bounded: a transport that opens and then goes quiet must not hold
      // startup open for the SDK's 60-second default.
      await client.connect(transport, { timeout: this.connectTimeoutMs });
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
          await client.connect(transport, { timeout: this.connectTimeoutMs });
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

  /**
   * Which transport each configured server is reached over, keyed by name.
   *
   * The **discriminant only** — never the `url`, `command`, `args`, `cwd`,
   * `env` or `headers` that sit beside it in the same config object. That
   * narrowness is the whole reason this accessor exists rather than a
   * `config()` getter: `/mcp` and the `mcpStatus` wire verb both want to say
   * "stdio" or "http" next to a server's name, and neither has any business
   * holding the object that carries the credentials.
   *
   * Pairs with {@link McpManager.status}, which answers the other half of the
   * same row.
   */
  transports(): Record<string, McpServerConfig["type"]> {
    const result: Record<string, McpServerConfig["type"]> = {};
    for (const [name, server] of Object.entries(this.config.servers)) {
      result[name] = server.type;
    }
    return result;
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

  /**
   * Lists resource *templates* for `server`, or every connected server when
   * omitted.
   *
   * A template is a URI pattern a server fills in on demand — the shape a
   * server uses for resources it generates rather than holds. Sibling to
   * {@link listResources}, and absent until a caller needed both halves of the
   * listing rather than one.
   */
  async listResourceTemplates(server?: string): Promise<McpResourceTemplateInfo[]> {
    return listResourceTemplatesImpl(this.clientMap(), server);
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
    // Sampling is per server and opt-in: a server that was never granted it in
    // config is never told the client could, so it cannot even try.
    const sample = this.config.servers[name]?.sampling === true ? this.sample : undefined;
    const capabilities: ClientCapabilities = {
      // Form mode only: URL mode would send the user to a server-chosen page.
      elicitation: { form: {} },
      ...(sample === undefined ? {} : { sampling: {} }),
    };
    const client = new Client(this.clientInfo, {
      capabilities,
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
    client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
      this.handleElicitation(name, request.params, extra.signal),
    );
    if (sample !== undefined) {
      client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
        const narrowed = narrowSamplingRequest(request.params, this.samplingMaxTokens);
        if (!narrowed.ok) {
          throw new McpError(ErrorCode.InvalidParams, `Sampling refused: ${narrowed.reason}.`);
        }
        const result = await sample({ ...narrowed.request, server: name, signal: extra.signal });
        const answer: CreateMessageResult = {
          role: "assistant",
          content: { type: "text", text: result.text },
          model: result.model,
          ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
        };
        return answer;
      });
    }
    return client;
  }

  /**
   * Validate an elicitation, ask the host, and check the answer fits the form.
   *
   * The SDK has already parsed the request against its own schema; this is
   * the explicit flat-subset gate (see `elicitation.ts`), and the only place
   * a request is refused with a reason the host gets to record.
   */
  private async handleElicitation(
    name: string,
    params: ElicitRequest["params"],
    signal: AbortSignal,
  ): Promise<ElicitResult> {
    if (params.mode === "url") {
      throw new McpError(ErrorCode.InvalidParams, "URL-mode elicitation is not supported.");
    }
    const check = validateElicitationSchema(params.requestedSchema);
    if (!check.ok) {
      try {
        this.onElicitationRefused?.({ server: name, reason: check.reason });
      } catch {
        // A host's bookkeeping must never change what the server is told.
      }
      throw new McpError(ErrorCode.InvalidParams, `Elicitation refused: ${check.reason}.`);
    }
    if (this.elicit === undefined) return { action: "decline" };
    // A person answers these one at a time; a server that re-asks in a loop
    // would hold the terminal hostage, so each server gets a few per minute.
    const now = Date.now();
    const recent = (this.elicitationTimes.get(name) ?? []).filter(
      (at) => now - at < ELICITATION_WINDOW_MS,
    );
    if (recent.length >= MAX_ELICITATIONS_PER_WINDOW) {
      const reason = `too many requests (more than ${MAX_ELICITATIONS_PER_WINDOW} a minute)`;
      try {
        this.onElicitationRefused?.({ server: name, reason });
      } catch {
        // Bookkeeping never changes what the server is told.
      }
      throw new McpError(ErrorCode.InvalidRequest, `Elicitation refused: ${reason}.`);
    }
    recent.push(now);
    this.elicitationTimes.set(name, recent);
    const answer = await this.elicit({
      server: name,
      message: params.message,
      fields: check.fields,
      signal,
    });
    if (answer.action !== "accept") return { action: answer.action };
    const problem = checkElicitationContent(check.fields, answer.content);
    if (problem !== undefined) {
      throw new McpError(
        ErrorCode.InternalError,
        `The answer does not fit the requested form: ${problem}.`,
      );
    }
    return { action: "accept", content: answer.content };
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
