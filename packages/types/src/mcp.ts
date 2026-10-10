/** MCP server configuration — consumed by @arcturn/mcp. */

/** Settings every MCP server entry may carry, whatever its transport. */
export interface McpServerCommonConfig {
  /**
   * Let this server ask the user's model to generate text
   * (`sampling/createMessage`). Off unless set to `true`: a sampling request
   * is the server spending on the user's key and putting its own prompt in
   * front of the user's model, so it is a per-server opt-in. When off the
   * `sampling` capability is not advertised to the server at all.
   */
  sampling?: boolean;
}

export type McpServerConfig = McpServerCommonConfig &
  (
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
      }
  );

export interface McpConfig {
  /** Keyed by server name; tool names are exposed as `mcp__<server>__<tool>`. */
  servers: Record<string, McpServerConfig>;
}
