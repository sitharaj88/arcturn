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
  MAX_CONTEXT_QUERY_LENGTH,
  MAX_PROMPT_ATTACHMENTS,
  validateClientRequest,
  validateCommandDescriptor,
  validateCommandList,
  validateContextResolution,
  validateModelCatalog,
  validateModelCatalogEntry,
  validateModelCost,
  validatePermissionDecision,
  validatePermissionRule,
  validatePermissionState,
  validatePromptAttachment,
  validateServerMessage,
  validateSessionHeader,
  validateSessionHistory,
} from "./validate.js";
