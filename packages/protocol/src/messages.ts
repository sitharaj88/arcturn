/** Tiny builder helpers for constructing well-formed {@link ServerMessage} values. */

import type { AgentEvent, ServerMessage, SessionHeader } from "@arcturn/types";

/**
 * Well-known error codes used in {@link ServerMessage} `response` errors.
 * A plain string-constant map (not a TS `enum`) so values stay ordinary
 * strings on the wire.
 */
export const ErrorCode = {
  /** The request failed shape/type validation. */
  invalidRequest: "invalidRequest",
  /** The request's `method` is not recognized. */
  unknownMethod: "unknownMethod",
  /** The referenced `sessionId` does not exist. */
  sessionNotFound: "sessionNotFound",
  /** The session is already running a turn and cannot accept this request. */
  sessionBusy: "sessionBusy",
  /** An unexpected server-side failure. */
  internal: "internal",
} as const;

/** A value of {@link ErrorCode}. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Build a successful `response` message for request `id`. */
export function okResponse(id: string, result: unknown): ServerMessage {
  return { kind: "response", id, result };
}

/** Build a failed `response` message for request `id`. */
export function errorResponse(id: string, code: string, message: string): ServerMessage {
  return { kind: "response", id, error: { code, message } };
}

/** Build an `event` message carrying one session's {@link AgentEvent}. */
export function eventMessage(sessionId: string, event: AgentEvent): ServerMessage {
  return { kind: "event", sessionId, event };
}

/** Build a `sessions` message listing all known session headers. */
export function sessionsMessage(sessions: SessionHeader[]): ServerMessage {
  return { kind: "sessions", sessions };
}
