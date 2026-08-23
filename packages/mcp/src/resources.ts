/**
 * Minimal resource & prompt bridging over connected MCP clients.
 *
 * Kept deliberately thin: these are the primitives future CLI `@`-mentions
 * will build on, not a full resource/prompt subsystem.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { PromptMessage } from "@modelcontextprotocol/sdk/types.js";

/** A resource advertised by an MCP server. */
export interface McpResourceInfo {
  server: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** A resource template (`resources/templates/list`) advertised by an MCP server. */
export interface McpResourceTemplateInfo {
  server: string;
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** The content of one resource read (`resources/read`), text or base64 blob. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** A prompt advertised by an MCP server. */
export interface McpPromptInfo {
  server: string;
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** A prompt message, flattened from MCP's content blocks to a plain role/text pair. */
export interface McpPromptMessage {
  role: string;
  text: string;
}

/** Lists resources for `server`, or every server in `clients` when `server` is omitted. */
export async function listResources(
  clients: ReadonlyMap<string, Client>,
  server?: string,
): Promise<McpResourceInfo[]> {
  const targets = resolveTargets(clients, server);
  const results = await Promise.all(
    targets.map(async ([name, client]) => {
      const resources: McpResourceInfo[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listResources(cursor ? { cursor } : undefined);
        resources.push(
          ...result.resources.map(
            (resource): McpResourceInfo => ({
              server: name,
              uri: resource.uri,
              name: resource.name,
              description: resource.description,
              mimeType: resource.mimeType,
            }),
          ),
        );
        cursor = result.nextCursor;
      } while (cursor !== undefined);
      return resources;
    }),
  );
  return results.flat();
}

/**
 * Lists resource templates (`resources/templates/list`) for `server`, or
 * every server in `clients` when `server` is omitted.
 */
export async function listResourceTemplates(
  clients: ReadonlyMap<string, Client>,
  server?: string,
): Promise<McpResourceTemplateInfo[]> {
  const targets = resolveTargets(clients, server);
  const results = await Promise.all(
    targets.map(async ([name, client]) => {
      const templates: McpResourceTemplateInfo[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listResourceTemplates(cursor ? { cursor } : undefined);
        templates.push(
          ...result.resourceTemplates.map(
            (template): McpResourceTemplateInfo => ({
              server: name,
              uriTemplate: template.uriTemplate,
              name: template.name,
              description: template.description,
              mimeType: template.mimeType,
            }),
          ),
        );
        cursor = result.nextCursor;
      } while (cursor !== undefined);
      return templates;
    }),
  );
  return results.flat();
}

/** Reads a resource by URI from the given server's client. */
export async function readResource(client: Client, uri: string): Promise<McpResourceContent[]> {
  const { contents } = await client.readResource({ uri });
  return contents.map(
    (content): McpResourceContent => ({
      uri: content.uri,
      mimeType: content.mimeType,
      text: "text" in content ? content.text : undefined,
      blob: "blob" in content ? content.blob : undefined,
    }),
  );
}

/** Lists prompts for `server`, or every server in `clients` when `server` is omitted. */
export async function listPrompts(
  clients: ReadonlyMap<string, Client>,
  server?: string,
): Promise<McpPromptInfo[]> {
  const targets = resolveTargets(clients, server);
  const results = await Promise.all(
    targets.map(async ([name, client]) => {
      const prompts: McpPromptInfo[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listPrompts(cursor ? { cursor } : undefined);
        prompts.push(
          ...result.prompts.map(
            (prompt): McpPromptInfo => ({
              server: name,
              name: prompt.name,
              description: prompt.description,
              arguments: prompt.arguments,
            }),
          ),
        );
        cursor = result.nextCursor;
      } while (cursor !== undefined);
      return prompts;
    }),
  );
  return results.flat();
}

/** Fetches a prompt's rendered messages, flattened to plain `{role, text}` pairs. */
export async function getPrompt(
  client: Client,
  name: string,
  args?: Record<string, string>,
): Promise<McpPromptMessage[]> {
  const { messages } = await client.getPrompt({ name, arguments: args });
  return messages.map(flattenPromptMessage);
}

function flattenPromptMessage(message: PromptMessage): McpPromptMessage {
  return { role: message.role, text: contentToText(message.content) };
}

function contentToText(content: PromptMessage["content"]): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "image":
      return `[image: ${content.mimeType}]`;
    case "audio":
      return `[audio: ${content.mimeType}]`;
    case "resource": {
      const resource = content.resource;
      return "text" in resource ? resource.text : `[resource: ${resource.uri}]`;
    }
    case "resource_link":
      return `[resource: ${content.uri}]`;
    default:
      return JSON.stringify(content);
  }
}

function resolveTargets(clients: ReadonlyMap<string, Client>, server?: string): [string, Client][] {
  if (server !== undefined) {
    const client = clients.get(server);
    if (!client) {
      throw new Error(`MCP server "${server}" is not connected.`);
    }
    return [[server, client]];
  }
  return Array.from(clients.entries());
}
