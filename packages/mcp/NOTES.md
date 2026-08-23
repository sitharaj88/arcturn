# Implementation notes — @arcturn/mcp

Decisions and workarounds made while implementing against the frozen `@arcturn/types`
contracts and the `@modelcontextprotocol/sdk@1.30.0` API surface. Nothing in
`packages/types` was edited.

## Contract fit

- `ToolResultContent` (in `messages.ts`) is `TextContent | ImageContent` only — there is
  no `resource` variant in the exported union. MCP `resource` content blocks are
  therefore flattened to `TextContent`: a text resource becomes
  `[resource <uri>]\n<text>`, a binary resource becomes
  `[resource <uri>] (binary, <mimeType>)`. Any other MCP content type (`audio`,
  `resource_link`, and any future block type) falls through to
  `JSON.stringify(block)` as text, per the task spec's "anything else" rule.
- `Tool.execute` never throws for expected SDK/transport failures — `McpToolBridge`
  catches everything from `client.callTool` and from a permission denial and returns
  an `isError: true` `ToolResult` instead, per `ToolDefinition`'s contract that
  `execute` "only reject[s] on programming errors."

## MCP SDK usage choices

- **Change notifications**: rather than manually wiring
  `setNotificationHandler(ToolListChangedNotificationSchema, ...)`, each `Client` is
  constructed with the SDK's built-in `listChanged.tools` config
  (`ClientOptions.listChanged`). It already debounces, refetches `tools/list`, and
  calls back with the updated list — `debounceMs: 0` is passed so manager tests don't
  need fake timers. `McpManager.onToolsChanged` re-broadcasts this per server as
  `{ server, tools }` (bridged `Tool[]`, not raw MCP descriptors).
- **HTTP transport fallback**: `McpManager` first tries
  `StreamableHTTPClientTransport`; if `client.connect()` throws and the server is
  configured with `type: "http"` (using the *default* transport factory — see below),
  it retries once with `SSEClientTransport` against the same URL/headers before
  marking the server failed. This path is not exercised by the test suite (network
  access is disallowed there) — it's covered by TypeScript's type checking and code
  review only. The `SSEClientTransport` used for fallback does not attach custom
  `headers` to the initial `EventSource` GET request (the `eventsource` package's
  `EventSourceInit` doesn't take a plain header map in this SDK version); only the
  POST-side `requestInit.headers` are forwarded. This is a known limitation of the
  fallback path, inherited from the SDK, not worked around locally.
- **Transport injection for tests**: `McpManager`'s constructor accepts an optional
  second `McpManagerOptions` argument with `transportFactory`. Production code never
  sets it (defaults to real stdio/HTTP transports), but it lets the test suite
  substitute `InMemoryTransport` pairs (real in-test `Server` + `Client` round trips)
  and a `FailingTransport` stub for the per-server-failure-isolation test — without
  spawning a real child process or opening a real socket, per the "no network, no
  external processes" test rule. This is additive to the `constructor(config)` shape
  described in the task and does not change the primary call site.
- **Test server without `zod`**: the task's suggested pattern is "an in-test
  `McpServer`", but the SDK's high-level `McpServer.registerTool` requires Zod
  schemas, and `zod` is not a listed dependency of `@arcturn/mcp` (pnpm's strict
  isolation means it isn't resolvable from this package, only transitively inside the
  SDK's own install). `src/test-support.ts` instead uses the SDK's low-level `Server`
  class with hand-written JSON Schemas and the SDK's pre-built Zod request schemas
  (`ListToolsRequestSchema`, `CallToolRequestSchema`, etc., imported as values, not
  authored) — this exercises the identical wire protocol without adding a `zod`
  import to this package. `test-support.ts` is not exported from `index.ts`.

## Config loader (`src/config.ts`)

- `${ENV_VAR}` expansion is applied only to `env` values (stdio) and `url`/`headers`
  values (http), per the task spec — `command`, `args`, and `cwd` are left literal,
  since expanding a raw file path or executable name felt more likely to surprise
  users than help them (undocumented in the spec either way, so noted here).
- An unresolved `${VAR}` (not present in `process.env`) throws `McpConfigError`
  naming the variable and the offending server, rather than silently substituting an
  empty string. Spec didn't say either way; failing loudly seemed safer for things
  like auth headers where a silently-empty token is worse than a startup error.
- Merge semantics: later config files fully replace earlier ones per server name (no
  deep-merge of individual fields within a server entry) — matches "later paths win
  per server name" read as whole-entry replacement.

## Everything else

Build (`pnpm --filter @arcturn/mcp build`) and tests
(`npx vitest run packages/mcp`) both pass; see the final report for counts.
