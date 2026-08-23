/** Bridges the tools exposed by one connected MCP server into `@arcturn/types` `Tool`s. */

import type {
  JsonSchema,
  Tool,
  ToolAnnotations,
  ToolExecutionContext,
  ToolResult,
  ToolResultContent,
} from "@arcturn/types";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult,
  ContentBlock,
  Tool as McpToolDescriptor,
} from "@modelcontextprotocol/sdk/types.js";

const INVALID_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

/** Replaces any character outside `[a-zA-Z0-9_-]` with `_`. */
export function sanitizeMcpName(name: string): string {
  return name.replace(INVALID_NAME_CHARS, "_");
}

/** Builds the bridged tool name `mcp__<server>__<tool>`, sanitizing both parts. */
export function mcpToolFullName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`;
}

const DEFAULT_PARAMETERS: JsonSchema = { type: "object" };

/**
 * Bridges the tools exposed by a single connected MCP server into {@link Tool}
 * implementations usable by the Arcturn runtime. Holds the last-known MCP tool
 * list for the server; call {@link McpToolBridge.refresh} or
 * {@link McpToolBridge.setMcpTools} to update it.
 */
export class McpToolBridge {
  private mcpTools: McpToolDescriptor[] = [];

  constructor(
    private readonly serverName: string,
    private readonly client: Client,
  ) {}

  /** Re-fetches the tool list from the server via `tools/list`, following pagination to exhaustion. */
  async refresh(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    this.mcpTools = tools;
    return tools;
  }

  /** Replaces the cached tool list directly, e.g. from a list-changed notification. */
  setMcpTools(tools: McpToolDescriptor[]): void {
    this.mcpTools = tools;
  }

  /** The raw MCP tool descriptors currently known for this server. */
  mcpToolDescriptors(): readonly McpToolDescriptor[] {
    return this.mcpTools;
  }

  /** The bridged {@link Tool} objects for the current tool list. */
  tools(): Tool[] {
    return this.mcpTools.map((tool) => this.bridgeTool(tool));
  }

  private bridgeTool(mcpTool: McpToolDescriptor): Tool {
    const fullName = mcpToolFullName(this.serverName, mcpTool.name);
    const description = mcpTool.description
      ? `[${this.serverName}] ${mcpTool.description}`
      : `[${this.serverName}] ${mcpTool.name}`;
    const annotations = toArcturnAnnotations(mcpTool.annotations);
    return {
      definition: {
        name: fullName,
        description,
        parameters: (mcpTool.inputSchema as JsonSchema | undefined) ?? DEFAULT_PARAMETERS,
      },
      annotations,
      execute: (input, ctx) => this.execute(mcpTool.name, fullName, annotations, input, ctx),
    };
  }

  private async execute(
    mcpToolName: string,
    fullName: string,
    annotations: ToolAnnotations | undefined,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const decision = await ctx.requestPermission({
      toolName: fullName,
      toolCallId: ctx.toolCallId,
      subject: fullName,
      description: `Call MCP tool "${mcpToolName}" on server "${this.serverName}".${annotationHintSuffix(annotations)}`,
    });
    if (decision.behavior === "deny") {
      return {
        content: [
          {
            type: "text",
            text: decision.message ?? `Permission denied for MCP tool "${fullName}".`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await this.client.callTool(
        { name: mcpToolName, arguments: input },
        undefined,
        {
          signal: ctx.signal,
          onprogress: (progress) => {
            ctx.onUpdate({
              text: progress.message,
              details: { progress: progress.progress, total: progress.total },
            });
          },
        },
      );
      return toolResultFromMcp(result as CallToolResult);
    } catch (error) {
      return {
        content: [{ type: "text", text: `MCP tool "${fullName}" failed: ${errorMessage(error)}` }],
        isError: true,
      };
    }
  }
}

/** Maps an MCP tool's `annotations` onto the arcturn {@link ToolAnnotations} shape. */
function toArcturnAnnotations(
  mcpAnnotations: McpToolDescriptor["annotations"],
): ToolAnnotations | undefined {
  if (!mcpAnnotations) return undefined;
  return {
    title: mcpAnnotations.title,
    readOnlyHint: mcpAnnotations.readOnlyHint,
    destructiveHint: mcpAnnotations.destructiveHint,
    idempotentHint: mcpAnnotations.idempotentHint,
    openWorldHint: mcpAnnotations.openWorldHint,
  };
}

/**
 * Builds a short "(server hints: ...)" suffix from a tool's annotations, for
 * display in permission prompts. These are untrusted hints, never a
 * substitute for an actual permission decision — see {@link ToolAnnotations}.
 */
function annotationHintSuffix(annotations: ToolAnnotations | undefined): string {
  if (!annotations) return "";
  const hints: string[] = [];
  if (annotations.readOnlyHint) hints.push("read-only");
  if (annotations.destructiveHint) hints.push("destructive");
  if (annotations.idempotentHint) hints.push("idempotent");
  if (annotations.openWorldHint) hints.push("open-world");
  return hints.length > 0 ? ` (server hints: ${hints.join(", ")})` : "";
}

/**
 * Maps an MCP `CallToolResult` onto the Arcturn {@link ToolResult} shape.
 *
 * `structuredContent` is passed through verbatim. Per spec, servers SHOULD
 * provide both `content` and `structuredContent` for backwards compatibility,
 * so `content` is trusted as the primary rendering when present; the
 * serialized `structuredContent` fallback is only synthesized as a text
 * block when the server returned no content blocks at all, so the model
 * still sees *something* rather than an empty result.
 */
export function toolResultFromMcp(result: CallToolResult): ToolResult {
  const content = (result.content ?? []).map(contentBlockToToolResultContent);
  const structuredContent = result.structuredContent;
  if (content.length === 0 && structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(structuredContent) });
  }
  return {
    content,
    isError: result.isError === true,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function contentBlockToToolResultContent(block: ContentBlock): ToolResultContent {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", data: block.data, mimeType: block.mimeType };
    case "resource": {
      const resource = block.resource;
      if ("text" in resource) {
        return { type: "text", text: `[resource ${resource.uri}]\n${resource.text}` };
      }
      const mime = resource.mimeType ? `, ${resource.mimeType}` : "";
      return { type: "text", text: `[resource ${resource.uri}] (binary${mime})` };
    }
    default:
      // Anything else (audio, resource_link, future block types) is passed through as JSON.
      return { type: "text", text: JSON.stringify(block) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
