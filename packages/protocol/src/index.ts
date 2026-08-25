/** @arcturn/protocol — NDJSON wire-protocol framing and validation for Arcturn server mode. */

export { PROTOCOL_VERSION } from "@arcturn/types";
export {
  ClientErrorCode,
  createProtocolClient,
  isUnsupportedMethodError,
  type ProtocolClient,
  ProtocolClientError,
  type ProtocolClientOptions,
  ProtocolClosedError,
  type ProtocolEventListener,
  ProtocolRequestError,
  ProtocolTimeoutError,
  ProtocolVersionMismatchError,
  type WebSocketLike,
} from "./client.js";
export type { FrameDecoderOptions, ProtocolError } from "./framing.js";
export {
  DEFAULT_MAX_LINE_LENGTH,
  encodeFrame,
  FrameDecoder,
  isProtocolError,
} from "./framing.js";
export { ErrorCode, errorResponse, eventMessage, okResponse, sessionsMessage } from "./messages.js";
export { nextRequestId, RequestIdGenerator } from "./request-id.js";
export type {
  ClientRequestValidation,
  ServerMessageValidation,
  ValidationResult,
} from "./validate.js";
export {
  MAX_CHANGE_SELECTION,
  MAX_CONTEXT_QUERY_LENGTH,
  MAX_MCP_SERVER_NAME_LENGTH,
  MAX_PENDING_CHANGE_PATH_LENGTH,
  MAX_PROMPT_ATTACHMENTS,
  validateApplyChangesResult,
  validateClientRequest,
  validateCommandDescriptor,
  validateCommandList,
  validateCompactionSummary,
  validateContextResolution,
  validateDiscardChangesResult,
  validateMcpServerSummary,
  validateMcpStatus,
  validateModelCatalog,
  validateModelCatalogEntry,
  validateModelCost,
  validatePendingChange,
  validatePendingChanges,
  validatePermissionDecision,
  validatePermissionRule,
  validatePermissionState,
  validatePromptAttachment,
  validateServerMessage,
  validateSessionExport,
  validateSessionHeader,
  validateSessionHistory,
} from "./validate.js";
