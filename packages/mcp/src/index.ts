/** Public API of `@arcturn/mcp`. */

export {
  McpToolBridge,
  mcpToolFullName,
  sanitizeMcpName,
  toolResultFromMcp,
} from "./bridge.js";
export { loadMcpConfig, McpConfigError } from "./config.js";
export {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  type McpAuthorizationHandler,
  type McpAuthProviderFactory,
  McpManager,
  type McpManagerOptions,
  type McpPromptsChangedEvent,
  type McpResourcesChangedEvent,
  type McpResourceUpdatedEvent,
  type McpServerConnectionState,
  type McpServerStatus,
  type McpToolsChangedEvent,
  type McpTransportFactory,
} from "./manager.js";
export {
  createMcpOAuthState,
  DEFAULT_MCP_REDIRECT_URL,
  isMcpAuthRequiredError,
  MCP_LOOPBACK_HOST,
  type McpAuthorizationPrompt,
  McpAuthRequiredError,
  type McpOAuthCredentials,
  McpOAuthProvider,
  type McpOAuthProviderOptions,
  type McpOAuthStorage,
  MemoryMcpOAuthStorage,
} from "./oauth.js";
export {
  getPrompt,
  listPrompts,
  listResources,
  listResourceTemplates,
  type McpPromptInfo,
  type McpPromptMessage,
  type McpResourceContent,
  type McpResourceInfo,
  type McpResourceTemplateInfo,
  readResource,
} from "./resources.js";
export {
  isSensitivePath,
  SENSITIVE_PATH_PATTERNS,
  type SensitivePartition,
  withholdSensitive,
} from "./sensitive-paths.js";
export {
  type ArcturnMcpHost,
  type ArcturnMcpServerOptions,
  ASK_ARCTURN_TOOL,
  createArcturnMcpServer,
  LIMITS,
  LIST_SESSIONS_TOOL,
  type McpAskOutcome,
  type McpAskRequest,
  McpRefusalError,
  type McpSearchHit,
  type McpSearchOutcome,
  type McpSearchRequest,
  type McpSessionSummary,
  type McpTranscript,
  type McpTranscriptEntry,
  READ_SESSION_TOOL,
  SEARCH_CODE_TOOL,
  SEARCH_DETAIL_LEVELS,
  type SearchDetail,
} from "./server.js";
