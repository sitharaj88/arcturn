/**
 * `@arcturn/core` — the Arcturn agent runtime.
 *
 * Everything here is provider-agnostic: the {@link Agent} takes an injected
 * `LLMClient` (from `@arcturn/types`), a tool list, and optional session,
 * permission and compaction wiring.
 */

export type { AgentOptions, AgentResumeOptions } from "./agent.js";
export { Agent, createAgent } from "./agent.js";
export type {
  CompactionOptions,
  CompactionResult,
  CompactMessagesInput,
  ResolvedCompactionOptions,
} from "./compaction.js";
export {
  buildSummaryPrompt,
  compactMessages,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  estimateMessageTokens,
  estimateTokens,
  findCutPoint,
  resolveCompactionOptions,
  SUMMARY_SYSTEM_PROMPT,
  serializeConversation,
  shouldCompact,
} from "./compaction.js";
export type {
  ContextEditOptions,
  ContextEditResult,
  ElisionInfo,
  ResolvedContextEditOptions,
} from "./context-edit.js";
export {
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS,
  DEFAULT_MIN_CHARS_TO_ELIDE,
  DEFAULT_PROTECTED_TOOL_NAMES,
  ELIDED_DETAIL_KEY,
  editContext,
  findElisionBoundary,
  isElided,
  renderElisionStub,
  resolveContextEditOptions,
  shouldEditContext,
  toolResultChars,
  totalToolResultChars,
} from "./context-edit.js";
export type {
  ActivationReport,
  DeferredToolsetOptions,
  DeferredToolsetSnapshot,
} from "./deferred-tools.js";
export {
  createDeferredToolset,
  DEFAULT_ALWAYS_ACTIVE_TOOLS,
  DEFAULT_SEARCH_TOOL_NAME,
  DeferredToolset,
} from "./deferred-tools.js";
export type { AgentHooks, BeforeToolCallResult, ToolCallInfo } from "./hooks.js";
export type { LoopResult, LoopRuntime } from "./loop.js";
export { runLoop } from "./loop.js";
export type { OffloadDetails, OffloadFileSystem, OffloadOptions } from "./offload.js";
export {
  buildOffloadStub,
  DEFAULT_OFFLOAD_EXCLUDE,
  DEFAULT_OFFLOAD_KEEP_HEAD,
  DEFAULT_OFFLOAD_KEEP_TAIL,
  DEFAULT_OFFLOAD_MAX_CHARS,
  offloadableText,
  offloadFileName,
  wrapToolsWithOffload,
} from "./offload.js";
export type {
  ExplainedPermissionRule,
  GlobCompileOptions,
  PathMatchOptions,
  PermissionCheck,
  PermissionEngineOptions,
  SpecifierMatchOptions,
  SubjectKind,
} from "./permissions.js";
export {
  DEFAULT_ALWAYS_ALLOW_TOOLS,
  DEFAULT_EDIT_TOOLS,
  DEFAULT_READ_ONLY_TOOLS,
  defaultCaseInsensitivePaths,
  defaultSubject,
  globToRegExp,
  isPathLike,
  matchRules,
  matchSpecifier,
  PermissionEngine,
  shellSegments,
} from "./permissions.js";
export type { SchemaError, SchemaValidationResult } from "./schema.js";
export { formatSchemaErrors, validateSchema, validateToolInput } from "./schema.js";
export type { JsonlSessionStoreOptions } from "./session/jsonl-store.js";
export { JsonlSessionStore, SessionStoreError } from "./session/jsonl-store.js";
export { MemorySessionStore } from "./session/memory-store.js";
export type { MaterializedBranch, SessionNode, SessionTree } from "./session/tree.js";
export {
  buildTree,
  formatCompactionSummary,
  latestEntryId,
  leafEntries,
  materializeBranch,
  pathToLeaf,
} from "./session/tree.js";
export type { AgentStateController, BindableTool, PlanApproval } from "./state.js";
export { isBindableTool } from "./state.js";
export type { PlanToolOptions, TodoToolOptions } from "./state-tools.js";
export { createPlanTool, createTodoTool, isStateToolName } from "./state-tools.js";
export type { SubagentToolOptions } from "./subagent.js";
export { createSubagentTool } from "./subagent.js";
export type {
  AgentMetric,
  TelemetryListenerOptions,
  TelemetrySpan,
  TelemetrySpanOptions,
  TelemetrySpanStatus,
  TelemetryTracer,
} from "./telemetry.js";
export { createConsoleTelemetry, createTelemetryListener, otelTracer } from "./telemetry.js";

export {
  addUsage,
  contentText,
  emptyUsage,
  errorText,
  errorToolResult,
  lastAssistantText,
  text,
  toolCallsOf,
  toolResultMessage,
  toUserContent,
  userMessage,
} from "./util/content.js";
export { createId, createSessionId } from "./util/ids.js";
