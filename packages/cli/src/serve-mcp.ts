/**
 * The serve path's MCP listing: what `mcpStatus` answers with, and — more to
 * the point — what it leaves behind.
 *
 * This module exists so that the decision about which fields leave the process
 * is made **next to the object that holds the secrets**. An `McpConfig` is
 * where a workspace keeps a stdio server's `env` and `args`, an HTTP server's
 * `url` and its `Authorization` header, and the `auth: "oauth"` flag behind
 * which a bearer token is minted at connect time. `@arcturn/server` cannot see
 * any of that (it does not depend on `@arcturn/mcp`), which is exactly why the
 * projection belongs here rather than there: a function that never receives
 * the credential cannot be reviewed for whether it forwards one, and a
 * function that does receive it can.
 *
 * ## Four fields, and everything else by omission
 *
 * A row is `{ name, transport, state, toolCount? }`. It is built by *naming*
 * those four, never by copying an object — so a field added to
 * `McpServerConfig` or `McpServerStatus` tomorrow is absent by default rather
 * than present until somebody notices. `@arcturn/server` then re-validates the
 * result against `validateMcpStatus`, which copies the same four out by name
 * again; two independent narrow gates, on the payload with the most to leak.
 *
 * ## Two things the terminal shows that this deliberately does not
 *
 * - **The failure reason.** `McpServerStatus.error` is prose an MCP server (or
 *   its transport) wrote, and this payload lands in a `/` menu a person reads
 *   and clicks. RFC 0005 §1.4's rule for `PermissionState.tools` — names, never
 *   descriptions, because a tool description is untrusted text from an
 *   extension — is the same rule, and a connection error is the same kind of
 *   string. A person who needs to know *why* a server failed reads the
 *   engine's log, where untrusted text is already understood as untrusted.
 * - **A liveness ping.** The terminal's `/mcp` pings each connected server
 *   with a 1.5s timeout, because a person standing at a prompt can afford to
 *   wait and cached state can go stale. A request/response verb cannot: one
 *   dead server would add its whole timeout to every client's round trip, and
 *   a second liveness field beside `state` would give a client two answers to
 *   one question. So this reports the state the manager recorded, and
 *   `McpServerSummary.state` says in its own doc that it is an observation
 *   rather than a guarantee.
 */

import type { McpManager } from "@arcturn/mcp";
import type {
  McpPromptList,
  McpPromptRendering,
  McpResourceContents,
  McpResourceList,
  McpServerSummary,
} from "@arcturn/types";
import { sanitizeDescription } from "./skill-tool.js";

/**
 * Project a manager's servers into the wire's four fields.
 *
 * Sorted by name so two reads of an unchanged engine compare equal — the same
 * reason `PermissionState.tools` is sorted.
 *
 * @param manager - The runtime's MCP manager, or `undefined` when the engine
 *   has none (no config file, or `--no-mcp`). Absent, the answer is an empty
 *   list: this engine has no MCP servers, which is a true and complete answer
 *   and a different one from the `invalidRequest` an engine with no such verb
 *   sends.
 * @returns One row per configured server.
 */
export function mcpServerSummaries(manager: McpManager | undefined): McpServerSummary[] {
  if (!manager) return [];
  const statuses = manager.status();
  const transports = manager.transports();
  return Object.keys(transports)
    .sort((a, b) => a.localeCompare(b))
    .map((name): McpServerSummary => {
      const status = statuses[name];
      const state = status?.state ?? "disconnected";
      // The count is carried only for a connected server, because that is the
      // only state the manager records one in — and a `0` for a disconnected
      // server would be indistinguishable from a connected one offering none.
      const toolCount = state === "connected" ? (status?.toolCount ?? 0) : undefined;
      return {
        name,
        transport: transports[name] ?? "stdio",
        state,
        ...(toolCount === undefined ? {} : { toolCount }),
      };
    });
}

/**
 * Project a manager's resources and prompt templates onto the wire.
 *
 * The same decision `mcpServerSummaries` makes, made in the same place and for
 * the same reason — except that here the risk runs the other way. A status row
 * risks leaking a *credential outward*; a resource listing risks carrying
 * *untrusted text inward*, into a menu a person reads and clicks. Every
 * description a remote server wrote goes through `sanitizeDescription`, which
 * is the treatment a skill's frontmatter already gets on the way to the same
 * kind of surface: first line only, control characters collapsed, capped.
 *
 * A server's own `name` is sanitized too. It is shown as a label, and a label
 * carrying newlines or control characters is a label that can be made to look
 * like two rows.
 *
 * Resource *contents* are deliberately not sanitized: truncating a schema or a
 * design document to one line would destroy the thing the user asked for. They
 * are marked untrusted on the wire type instead, and the rule is the client's
 * — render as text, never as markup.
 */
export async function mcpResourceList(
  manager: McpManager | undefined,
  server?: string,
): Promise<McpResourceList> {
  if (manager === undefined) return { resources: [], templates: [] };
  const [resources, templates] = await Promise.all([
    manager.listResources(server).catch(() => []),
    manager.listResourceTemplates(server).catch(() => []),
  ]);
  return {
    // Named field by field rather than spread, the rule this module already
    // keeps: a field the SDK grows tomorrow is absent until somebody decides.
    resources: resources
      .map((entry) => ({
        server: entry.server,
        uri: entry.uri,
        ...(entry.name === undefined ? {} : { name: sanitizeDescription(entry.name) }),
        ...(entry.description === undefined
          ? {}
          : { description: sanitizeDescription(entry.description) }),
        ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
      }))
      .sort(byServerThen((entry) => entry.uri)),
    templates: templates
      .map((entry) => ({
        server: entry.server,
        uriTemplate: entry.uriTemplate,
        ...(entry.name === undefined ? {} : { name: sanitizeDescription(entry.name) }),
        ...(entry.description === undefined
          ? {}
          : { description: sanitizeDescription(entry.description) }),
        ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
      }))
      .sort(byServerThen((entry) => entry.uriTemplate)),
  };
}

/** Project a manager's prompt templates onto the wire. */
export async function mcpPromptList(
  manager: McpManager | undefined,
  server?: string,
): Promise<McpPromptList> {
  if (manager === undefined) return { prompts: [] };
  const prompts = await manager.listPrompts(server).catch(() => []);
  return {
    prompts: prompts
      .map((entry) => ({
        server: entry.server,
        name: entry.name,
        ...(entry.description === undefined
          ? {}
          : { description: sanitizeDescription(entry.description) }),
        ...(entry.arguments === undefined
          ? {}
          : {
              arguments: entry.arguments.map((argument) => ({
                name: argument.name,
                ...(argument.description === undefined
                  ? {}
                  : { description: sanitizeDescription(argument.description) }),
                ...(argument.required === undefined ? {} : { required: argument.required }),
              })),
            }),
      }))
      .sort(byServerThen((entry) => entry.name)),
  };
}

/** Read one resource, unsanitized and marked so. */
export async function mcpResourceRead(
  manager: McpManager | undefined,
  server: string,
  uri: string,
): Promise<McpResourceContents> {
  if (manager === undefined) throw new Error("this engine has no MCP servers configured");
  const contents = await manager.readResource(server, uri);
  return {
    contents: contents.map((block) => ({
      uri: block.uri,
      ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
      ...(block.text === undefined ? {} : { text: block.text }),
      ...(block.blob === undefined ? {} : { blob: block.blob }),
    })),
  };
}

/** Render one prompt template into role/text messages. */
export async function mcpPromptRender(
  manager: McpManager | undefined,
  server: string,
  name: string,
  args?: Record<string, string>,
): Promise<McpPromptRendering> {
  if (manager === undefined) throw new Error("this engine has no MCP servers configured");
  const messages = await manager.getPrompt(server, name, args);
  return { messages: messages.map((message) => ({ role: message.role, text: message.text })) };
}

/** Sort by server, then by the caller's key, so two reads compare equal. */
function byServerThen<T extends { server: string }>(
  key: (entry: T) => string,
): (left: T, right: T) => number {
  return (left, right) =>
    left.server === right.server
      ? key(left).localeCompare(key(right))
      : left.server.localeCompare(right.server);
}
