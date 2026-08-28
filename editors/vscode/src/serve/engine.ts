/**
 * The one place the extension names `@arcturn/protocol` and `@arcturn/types`.
 *
 * RFC 0004 §0: the protocol is the *only* boundary. Every engine type the
 * sidebar renders is re-exported here verbatim — the extension defines no
 * parallel event union, no second `PermissionRequest`, no private copy of a
 * `SessionHeader`, and no local restatement of the client surface. When the
 * engine adds an event or a verb, this file is the only place that has to
 * notice, and `git grep "@arcturn/"` under `src/` returns exactly this module.
 *
 * That is the whole job. There is deliberately no wrapper around
 * `createProtocolClient`: the socket is injected by the caller (see
 * {@link WebSocketLike}'s own doc for why), so there is nothing left for a
 * wrapper to adapt, and a pass-through would only be one more name for the
 * same function.
 */

export type {
  ProtocolClient,
  ProtocolClientOptions,
  ProtocolEventListener,
  WebSocketLike,
} from "@arcturn/protocol";
export {
  createProtocolClient,
  isUnsupportedMethodError,
  MAX_CHANGE_SELECTION,
  MAX_CHECKPOINT_ID_LENGTH,
  MAX_CONTEXT_QUERY_LENGTH,
  MAX_PROMPT_ATTACHMENTS,
  MAX_WORKFLOW_INPUT_LENGTH,
  MAX_WORKFLOW_NAME_LENGTH,
  MAX_WORKFLOW_RUN_ID_LENGTH,
} from "@arcturn/protocol";
export type {
  AgentEvent,
  AgentEventType,
  ApplyChangeFailure,
  ApplyChangesResult,
  AssistantMessage,
  CheckpointEntry,
  CheckpointList,
  CommandDescriptor,
  CommandList,
  ContextKind,
  ContextResolution,
  DiscardChangesResult,
  McpServerSummary,
  Message,
  ModelCatalog,
  ModelCatalogEntry,
  ModelCost,
  ModelCredentialStatus,
  PendingChange,
  PendingChanges,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRule,
  PermissionScope,
  PermissionState,
  PromptAttachment,
  RewindFailure,
  RewindResult,
  SessionHeader,
  SessionHistory,
  StreamEvent,
  TodoItem,
  ToolResultMessage,
  ToolUpdate,
  Usage,
  WorkflowCatalog,
  WorkflowRoleLane,
  WorkflowRoleSummary,
  WorkflowRunHandle,
  WorkflowRunQuestion,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
  WorkflowRuns,
  WorkflowSummary,
} from "@arcturn/types";
