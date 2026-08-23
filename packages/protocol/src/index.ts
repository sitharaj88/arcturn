/** @arcturn/protocol — NDJSON wire-protocol framing and validation for Arcturn server mode. */

export { PROTOCOL_VERSION } from "@arcturn/types";
export {
  ClientErrorCode,
  createProtocolClient,
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
  validateClientRequest,
  validatePermissionDecision,
  validatePermissionRule,
  validateServerMessage,
  validateSessionHeader,
} from "./validate.js";
