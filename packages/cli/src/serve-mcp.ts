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
import type { McpServerSummary } from "@arcturn/types";

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
