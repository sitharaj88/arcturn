/**
 * `@arcturn/server` — the WebSocket server exposing Arcturn agent sessions.
 *
 * {@link SessionHost} manages live sessions independent of transport;
 * {@link ArcturnServer} exposes a `SessionHost` over JSON WebSocket text frames
 * validated against `@arcturn/protocol`'s wire contracts.
 */

export type { AuthenticateFrame } from "./auth.js";
export { isAuthenticateFrame, tokensMatch } from "./auth.js";
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
