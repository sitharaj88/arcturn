/** MCP server configuration — consumed by @arcturn/mcp. */

export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      /**
       * Authorization scheme for the server. `"oauth"` runs the OAuth 2.1
       * authorization-code flow (PKCE, loopback redirect) and attaches the
       * resulting bearer token; omit it for the unauthenticated/static-header
       * behaviour. `headers` are still sent when both are present.
       */
      auth?: "oauth";
    };

export interface McpConfig {
  /** Keyed by server name; tool names are exposed as `mcp__<server>__<tool>`. */
  servers: Record<string, McpServerConfig>;
}
