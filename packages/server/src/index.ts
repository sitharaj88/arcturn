/**
 * `@arcturn/server` — the WebSocket server exposing Arcturn agent sessions.
 *
 * {@link SessionHost} manages live sessions independent of transport;
 * {@link ArcturnServer} exposes a `SessionHost` over JSON WebSocket text frames
 * validated against `@arcturn/protocol`'s wire contracts.
 */

export type { AuthenticateFrame } from "./auth.js";
export { isAuthenticateFrame, tokensMatch } from "./auth.js";
export {
  REMOTE_BUILT_IN_COMMAND_VERBS,
  REMOTE_REACHABLE_BUILT_IN_COMMANDS,
} from "./built-in-commands.js";
export type {
  DryRunApplyError,
  DryRunApplyOutcome,
  DryRunChange,
  DryRunOverlay,
  DryRunResult,
  DryRunReview,
  PendingChangesLimits,
} from "./dry-run.js";
export {
  createDryRunReview,
  PENDING_CHANGES_MAX_BYTES,
  PENDING_CHANGES_MAX_FILES,
} from "./dry-run.js";
export type {
  ContextQueryRequest,
  ContextRefusal,
  ContextResolver,
  PromptContextRequest,
  ResolvedImage,
  ResolvedPrompt,
} from "./prompt-context.js";
export {
  ContextRefusedError,
  PROMPT_ATTACHMENT_MAX_BYTES,
  visionRefusalMessage,
} from "./prompt-context.js";
export type {
  SessionExportLimits,
  TranscriptExporter,
  TranscriptRenderRequest,
} from "./session-export.js";
export { buildSessionExport, SESSION_EXPORT_MAX_BYTES } from "./session-export.js";
export type { SessionHistoryLimits } from "./session-history.js";
export {
  buildSessionHistory,
  capSessionEvents,
  projectSessionEvents,
  SESSION_HISTORY_MAX_BYTES,
  SESSION_HISTORY_MAX_EVENTS,
} from "./session-history.js";
export type {
  AgentFactoryOptions,
  SessionHostErrorCode,
  SessionHostOptions,
} from "./session-host.js";
export { DEFAULT_MAX_SESSIONS, SessionHost, SessionHostError } from "./session-host.js";
export type { ArcturnServerOptions, ArcturnServerStartOptions } from "./ws-server.js";
export {
  ArcturnServer,
  DEFAULT_BACKPRESSURE_SUSTAINED_MS,
  DEFAULT_BACKPRESSURE_THRESHOLD_BYTES,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from "./ws-server.js";
