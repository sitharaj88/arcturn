/**
 * Test-only helpers: an in-process MCP server (low-level `Server`, no zod
 * dependency) wired to `InMemoryTransport`, plus a stub permission requester.
 *
 * Not exported from `index.ts` — imported directly by colocated `*.test.ts` files.
 */

import type { PermissionDecision, PermissionRequest } from "@arcturn/types";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  type ListPromptsResult,
  ListResourcesRequestSchema,
  type ListResourcesResult,
  ListResourceTemplatesRequestSchema,
  type ListResourceTemplatesResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool as McpToolDescriptor,
  type Prompt,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface TestServerHandle {
  server: Server;
  /** Transport to hand to a `Client.connect()` call. */
  clientTransport: Transport;
  tools: McpToolDescriptor[];
  setTools(tools: McpToolDescriptor[]): void;
  announceToolsChanged(): Promise<void>;
  resources: Resource[];
  setResources(resources: Resource[]): void;
  announceResourcesChanged(): Promise<void>;
  prompts: Prompt[];
  setPrompts(prompts: Prompt[]): void;
  announcePromptsChanged(): Promise<void>;
  /** URIs the connected client has subscribed to via `resources/subscribe`. */
  subscribedUris: Set<string>;
  /** Sends a `notifications/resources/updated` for `uri`, as if it changed. */
  announceResourceUpdated(uri: string): Promise<void>;
}

export const ECHO_TOOL: McpToolDescriptor = {
  name: "echo",
  description: "Echoes back its input arguments.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};

export const BOOM_TOOL: McpToolDescriptor = {
  name: "boom",
  description: "Always returns an error result.",
  inputSchema: { type: "object" },
};

export const SNAPSHOT_TOOL: McpToolDescriptor = {
  name: "snapshot",
  description: "Returns a tiny image.",
  inputSchema: { type: "object" },
};

/** Returns `structuredContent` only, no `content` blocks — exercises the text fallback. */
export const STRUCTURED_ONLY_TOOL: McpToolDescriptor = {
  name: "structuredOnly",
  description: "Returns structured content with no content blocks.",
  inputSchema: { type: "object" },
};

/** Returns both `content` and `structuredContent` — content must win, no duplicated fallback. */
export const STRUCTURED_WITH_TEXT_TOOL: McpToolDescriptor = {
  name: "structuredWithText",
  description: "Returns both a text content block and structured content.",
  inputSchema: { type: "object" },
};

/** Sends two progress notifications, then resolves — exercises the `onprogress` wiring. */
export const PROGRESS_TOOL: McpToolDescriptor = {
  name: "progress",
  description: "Reports progress before completing.",
  inputSchema: { type: "object" },
};

/** Carries full `annotations`, to exercise the annotation-passthrough and permission-hint paths. */
export const ANNOTATED_TOOL: McpToolDescriptor = {
  name: "annotated",
  description: "A tool with server-supplied annotations.",
  inputSchema: { type: "object" },
  annotations: {
    title: "Annotated Tool",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const STRUCTURED_PAYLOAD = { ok: true, value: 42 };

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const DEFAULT_RESOURCES: Resource[] = [
  { uri: "test://greeting.txt", name: "greeting", mimeType: "text/plain" },
];

const DEFAULT_PROMPTS: Prompt[] = [
  { name: "greet", description: "Greets someone", arguments: [{ name: "who" }] },
];

/**
 * Splits `items` into one page starting at `cursor` (a stringified offset).
 * With `pageSize` unset, returns everything in a single page (no `nextCursor`)
 * — the default, pre-pagination behavior existing tests rely on.
 */
function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number | undefined,
): { page: T[]; nextCursor?: string } {
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  const end = pageSize ? start + pageSize : items.length;
  const page = items.slice(start, end);
  const nextCursor = pageSize !== undefined && end < items.length ? String(end) : undefined;
  return { page, nextCursor };
}

export interface CreateTestServerOptions {
  initialTools?: McpToolDescriptor[];
  /** When set, `tools/list` pages results this many at a time instead of all at once. */
  toolPageSize?: number;
  resources?: Resource[];
  resourcePageSize?: number;
  prompts?: Prompt[];
  promptPageSize?: number;
  resourceTemplates?: ResourceTemplate[];
  resourceTemplatePageSize?: number;
  /** Whether to declare `resources.subscribe` support. Defaults to `true`. */
  subscribable?: boolean;
}

/** Builds a small in-process MCP server exposing echo/boom/snapshot tools plus a resource and prompt. */
export function createTestServer(options: CreateTestServerOptions = {}): TestServerHandle {
  const subscribable = options.subscribable ?? true;
  const server = new Server(
    { name: "test-server", version: "1.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: subscribable },
        prompts: { listChanged: true },
      },
    },
  );

  let tools = options.initialTools ?? [ECHO_TOOL, BOOM_TOOL, SNAPSHOT_TOOL];
  let resources = options.resources ?? DEFAULT_RESOURCES;
  let prompts = options.prompts ?? DEFAULT_PROMPTS;
  const resourceTemplates = options.resourceTemplates ?? [];
  const subscribedUris = new Set<string>();

  if (subscribable) {
    server.setRequestHandler(SubscribeRequestSchema, (request) => {
      subscribedUris.add(request.params.uri);
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      subscribedUris.delete(request.params.uri);
      return {};
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, (request): ListToolsResult => {
    const { page, nextCursor } = paginate(tools, request.params?.cursor, options.toolPageSize);
    return { tools: page, ...(nextCursor === undefined ? {} : { nextCursor }) };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      if (name === "progress") {
        const progressToken = request.params._meta?.progressToken;
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: 1, total: 2, message: "step 1" },
          });
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: 2, total: 2, message: "step 2" },
          });
        }
        return { content: [{ type: "text", text: "done" }] };
      }
      if (name === "echo") {
        const message = (args as Record<string, unknown> | undefined)?.message;
        return { content: [{ type: "text", text: String(message) }] };
      }
      if (name === "boom") {
        return { content: [{ type: "text", text: "boom failed on purpose" }], isError: true };
      }
      if (name === "snapshot") {
        return { content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }] };
      }
      if (name === "structuredOnly") {
        return { content: [], structuredContent: STRUCTURED_PAYLOAD };
      }
      if (name === "structuredWithText") {
        return {
          content: [{ type: "text", text: "human-readable summary" }],
          structuredContent: STRUCTURED_PAYLOAD,
        };
      }
      if (name === "annotated") {
        return { content: [{ type: "text", text: "ok" }] };
      }
      throw new Error(`Unknown tool "${name}"`);
    },
  );

  server.setRequestHandler(ListResourcesRequestSchema, (request): ListResourcesResult => {
    const { page, nextCursor } = paginate(
      resources,
      request.params?.cursor,
      options.resourcePageSize,
    );
    return { resources: page, ...(nextCursor === undefined ? {} : { nextCursor }) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, (request): ReadResourceResult => {
    if (request.params.uri === "test://greeting.txt") {
      return {
        contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "hello there" }],
      };
    }
    throw new Error(`Unknown resource "${request.params.uri}"`);
  });

  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    (request): ListResourceTemplatesResult => {
      const { page, nextCursor } = paginate(
        resourceTemplates,
        request.params?.cursor,
        options.resourceTemplatePageSize,
      );
      return { resourceTemplates: page, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
  );

  server.setRequestHandler(ListPromptsRequestSchema, (request): ListPromptsResult => {
    const { page, nextCursor } = paginate(prompts, request.params?.cursor, options.promptPageSize);
    return { prompts: page, ...(nextCursor === undefined ? {} : { nextCursor }) };
  });

  server.setRequestHandler(GetPromptRequestSchema, (request): GetPromptResult => {
    if (request.params.name === "greet") {
      const who = request.params.arguments?.who ?? "world";
      return {
        messages: [{ role: "user", content: { type: "text", text: `Say hi to ${who}` } }],
      };
    }
    throw new Error(`Unknown prompt "${request.params.name}"`);
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);

  return {
    server,
    clientTransport,
    get tools() {
      return tools;
    },
    setTools(next: McpToolDescriptor[]) {
      tools = next;
    },
    async announceToolsChanged() {
      await server.sendToolListChanged();
    },
    get resources() {
      return resources;
    },
    setResources(next: Resource[]) {
      resources = next;
    },
    async announceResourcesChanged() {
      await server.sendResourceListChanged();
    },
    get prompts() {
      return prompts;
    },
    setPrompts(next: Prompt[]) {
      prompts = next;
    },
    async announcePromptsChanged() {
      await server.sendPromptListChanged();
    },
    subscribedUris,
    async announceResourceUpdated(uri: string) {
      await server.sendResourceUpdated({ uri });
    },
  };
}

/** A transport whose `start()` always rejects, simulating a server that refuses to connect. */
export class FailingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;

  constructor(private readonly message = "connection refused") {}

  start(): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  send(): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A stub `PermissionRequester`: `mode: "allow"` allows everything, `"deny"` denies everything. */
export function stubPermissionRequester(
  mode: "allow" | "deny",
  message?: string,
): (request: Omit<PermissionRequest, "id">) => Promise<PermissionDecision> {
  return async (request) => ({
    requestId: "test-request",
    behavior: mode,
    message: mode === "deny" ? (message ?? `denied: ${request.subject}`) : undefined,
  });
}

/** A `PermissionRequester` stub that records every request it receives, then allows it. */
export function recordingPermissionRequester(sink: Omit<PermissionRequest, "id">[]) {
  return async (request: Omit<PermissionRequest, "id">): Promise<PermissionDecision> => {
    sink.push(request);
    return { requestId: "test-request", behavior: "allow" };
  };
}
