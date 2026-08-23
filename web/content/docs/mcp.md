---
title: MCP
description: Connect stdio and streamable-HTTP Model Context Protocol servers.
section: Core concepts
order: 6
---

## MCP built in

Arcturn ships `@arcturn/mcp` rather than leaving MCP as something you wire up yourself: a
client built on the official Model Context Protocol SDK that connects to configured
servers, bridges their tools into ordinary Arcturn `Tool`s, and exposes their resources and
prompts through the same manager.

## Config schema

```json
{
  "servers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/sse",
      "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" }
    }
  }
}
```

Two server types, validated field-by-field by `packages/mcp/src/config.ts`'s
`validateServerConfig` — a malformed entry throws `McpConfigError` naming the exact server
and file, rather than failing the whole load silently:

- **`stdio`** — `command` (required, non-empty string), optional `args` (string array),
  `env` (string-valued object), `cwd` (string). Arcturn spawns the process and speaks MCP
  over its stdin/stdout.
- **`http`** — `url` (required, non-empty string), optional `headers` (string-valued
  object), optional `auth` (only `"oauth"`). Arcturn tries the streamable-HTTP transport
  first; if that connection attempt fails, it automatically falls back to
  `SSEClientTransport` against the same `url` and `headers`, for servers that only speak
  the older SSE transport. Any other `auth` value throws `Invalid MCP server "<name>" in
  "<path>": "auth" must be "oauth".`

Any `type` other than `"stdio"` or `"http"` throws `Invalid MCP server "<name>" in
"<path>": "type" must be "stdio" or "http".` — there is no silent default.

`${ENV_VAR}` references inside `env`, `headers`, and `url` are expanded from
`process.env` **after** every config file has been read and merged — so a later file can
still override an earlier server definition before expansion runs. An unset variable is a
hard error, not a blank substitution: `Invalid MCP server "linear": environment variable
"LINEAR_TOKEN" (referenced as "${LINEAR_TOKEN}") is not set.` This is deliberate — a
silently-empty `Authorization: Bearer ` header is a worse failure mode than refusing to
start.

## Adding servers from the CLI

You never have to edit the JSON by hand — `arcturn mcp` manages the same two files:

```bash
# stdio server; everything after -- is the launch command, verbatim
arcturn mcp add macctl -- npx -y @sitharaj88/macctl

# user scope (available in every project) instead of the default project scope
arcturn mcp add macctl --scope user -- npx -y @sitharaj88/macctl

# environment for the server process, repeatable
arcturn mcp add db --env PGURL=${PGURL} -- my-db-server

# streamable-HTTP server, with headers ( ${VAR} expands at session start )
arcturn mcp add --transport http linear https://mcp.linear.app/sse \
  --header "Authorization: Bearer ${LINEAR_TOKEN}"

arcturn mcp list            # every configured server and which file defines it
arcturn mcp get linear      # print one server's JSON, per scope
arcturn mcp remove linear   # delete; asks for --scope if defined in both files
arcturn mcp auth docs       # authorize an "auth": "oauth" server (see below)
arcturn mcp logout docs     # forget that server's stored OAuth tokens
```

`add` refuses to overwrite an existing name in the same scope (remove it first), and
`remove` refuses to guess when a name exists at both scopes. The files stay the documented
JSON above — the command is sugar, not a second source of truth.

## OAuth servers

Remote MCP servers increasingly want a real user grant rather than a shared bearer token.
Mark such a server `"auth": "oauth"` and Arcturn runs the OAuth 2.1 authorization-code
flow (PKCE, loopback redirect) against it:

```json
{
  "servers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "auth": "oauth",
      "headers": { "X-Tenant": "acme" }
    }
  }
}
```

`headers` and `auth` coexist: static headers are still sent, and the OAuth access token is
attached alongside them. Omitting `auth` keeps the previous behaviour exactly — headers
only, no token handling.

Add one from the CLI with `--auth oauth`, then authorize it once:

```bash
arcturn mcp add --transport http --auth oauth docs https://mcp.example.com/mcp
arcturn mcp auth docs      # opens the browser, waits for the redirect, stores the tokens
arcturn mcp logout docs    # deletes the stored tokens for that server
```

`arcturn mcp auth` binds a one-shot listener on `127.0.0.1` with an ephemeral port, prints
the authorization URL and also tries to open your browser, then waits (five minutes, or
Ctrl+C) for exactly one callback. The `state` parameter is generated before the URL is
built and must come back unchanged, or the code is discarded unexchanged. Everything
protocol-level — the PKCE challenge, protected-resource-metadata discovery, dynamic client
registration and the token exchange — is the official MCP SDK's; Arcturn supplies the
storage, the loopback listener and the browser.

Tokens are written to:

```text
~/.arcturn/auth/mcp-<server>.json      mode 0600, inside a 0700 directory
```

That is the same directory and the same permissions `arcturn auth` uses for provider
sign-ins, with an `mcp-` prefix so the two namespaces cannot collide. The file holds the
access and refresh tokens plus the registered client id for that one server; refreshes are
performed by the SDK and written back through the same file. `arcturn mcp logout <name>`
deletes it — the grant still exists on the server's side, so revoke it there too if you
want it gone for good.

At session start Arcturn loads the stored tokens and lets the SDK refresh them silently.
If a server needs a grant you have never approved:

- **Interactive sessions** run the browser flow once and retry the connection.
- **`arcturn -p` and other non-interactive runs** never block on a browser. The server is
  reported `failed` in `/mcp` with `MCP server "docs" requires OAuth authorization. Run:
  arcturn mcp auth docs` — run that first, then re-run the non-interactive command.

Authorization URLs are printed only by the `arcturn mcp auth` flow you started yourself;
they never appear in warnings, `/mcp` status or logs, and no token, refresh token or PKCE
verifier is ever printed anywhere.

## File locations and precedence

Arcturn looks for MCP config in exactly two places, both optional:

```text
~/.arcturn/mcp.json            user-level servers
<cwd>/.arcturn/mcp.json        project-level servers
```

Both files are loaded together via `loadMcpConfig([userMcp, projectMcp])` (`packages/cli/src/runtime.ts`'s
`connectMcp`) — `runtime.paths.userMcp` and `runtime.paths.projectMcp` in `packages/cli/src/paths.ts`.
Files are read **user first, then project**, and per `loadMcpConfig`'s merge rule, a server
name that appears in both files takes its definition entirely from the later (project)
file — not a field-by-field merge, a full replacement. A server defined only in the user
file is unaffected. Neither file existing is not an error: `connectMcp` checks both paths
with `existsSync` first and simply skips MCP setup entirely if neither is present.

Missing config files are never an error, and a server that fails to start (bad command,
connection refused, malformed handshake) does not stop the others — it is recorded in
`manager.status()` and surfaced to the runtime's warnings, while every other configured
server still connects.

Skip MCP entirely, even when config files exist, with:

```bash
arcturn --no-mcp
```

## Checking status

Inside a session, `/mcp` prints each configured server's connection state and tool count:

```text
MCP servers
  playwright       connected  12 tools
  linear           failed     ECONNREFUSED
```

With no servers configured, it prints where to add them (`<project>/.arcturn/mcp.json` or
`~/.arcturn/mcp.json`) along with a minimal example. States mirror
`McpServerConnectionState`: `disconnected`, `connecting`, `connected`, `failed`.

## Tool naming

Every bridged tool is namespaced `mcp__<server>__<tool>` — `mcp__playwright__browser_click`,
`mcp__linear__create_issue` — so tools from different servers, or from an MCP server and
a built-in tool, never collide. Both parts are sanitized to `[a-zA-Z0-9_-]` by
`sanitizeMcpName` (any other character becomes `_`). The bridged tool's description is
prefixed `[<server>] `, and its JSON Schema parameters come straight from the MCP tool's
`inputSchema` — an empty `{ "type": "object" }` when the server declares none.

Every bridged tool call still goes through Arcturn's own permission gate before it reaches
the server: `McpToolBridge.execute` calls `ctx.requestPermission` with a description like
`Call MCP tool "browser_click" on server "playwright".` before invoking `client.callTool`,
so MCP tools obey the same permission modes and rules as every built-in tool — an MCP
server cannot bypass `default`/`plan`/`acceptEdits` gating just by being a different
process. A denied call returns an `isError` result with the requester's message (or a
generic fallback) instead of ever reaching the server.

Tool results map onto Arcturn's `ToolResultContent`: MCP `text` blocks pass through as-is,
`image` blocks keep their `data`/`mimeType`, an embedded `resource` with text becomes
`[resource <uri>]\n<text>` and a binary one becomes `[resource <uri>] (binary, <mime>)`,
and anything else (audio, `resource_link`, a future block type) is passed through as raw
JSON text rather than dropped.

## Connecting

```ts
import { McpManager, loadMcpConfig } from "@arcturn/mcp";

const config = await loadMcpConfig([".arcturn/mcp.json"]);
const manager = new McpManager(config);
await manager.connect(); // connects every configured server concurrently

const tools = manager.tools(); // bridged Tool[] — pass straight into createAgent
const status = manager.status(); // { playwright: { state: "connected", toolCount: 12 }, ... }
```

Per-server failures are isolated: one misbehaving server never prevents the others from
connecting, and `manager.status()` tells you exactly which ones failed and why.

```ts
agent.setTools([...builtins, ...manager.tools()]);

manager.onToolsChanged(({ server, tools }) => {
  // an MCP server can push a live tool-list update; re-wire the agent's tools
  agent.setTools([...builtins, ...manager.tools()]);
});
```

## Resources and prompts

Beyond tools, Arcturn can list and read MCP **resources** and fetch MCP **prompts**:

```ts
const resources = await manager.listResources("playwright");
const content = await manager.readResource("playwright", resources[0].uri);

const prompts = await manager.listPrompts("linear");
const messages = await manager.getPrompt("linear", "triage-issue", { issueId: "ENG-42" });
```

Omit the server name on `listResources` / `listPrompts` to aggregate across every
connected server.

## Tearing down

```ts
await manager.disconnectServer("playwright"); // one server
await manager.close();                        // everything
```

Always close the manager when a session ends — stdio servers are child processes, and an
unclosed one is a leaked process.

## Related

- [Arcturn as an MCP server](/docs/mcp-server) — the same protocol pointed the other way:
  `arcturn mcp-serve` lets a foreign client drive Arcturn, instead of Arcturn connecting
  out to servers you configured.
