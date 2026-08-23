/** Wire protocol for server mode (@arcturn/protocol implements framing/validation). */

import type { AgentEvent } from "./events.js";
import type { PermissionDecision } from "./permissions.js";
import type { SessionHeader } from "./session.js";

/** Client → server requests. */
export type ClientRequest =
  | { id: string; method: "listSessions" }
  | { id: string; method: "createSession"; params: { cwd: string; model?: string } }
  | { id: string; method: "openSession"; params: { sessionId: string } }
  | { id: string; method: "prompt"; params: { sessionId: string; text: string } }
  /** Queue a mid-run steering message the agent sees after the current tool finishes. */
  | { id: string; method: "steer"; params: { sessionId: string; text: string } }
  | { id: string; method: "abort"; params: { sessionId: string } }
  | {
      id: string;
      method: "permissionDecision";
      params: { sessionId: string; decision: PermissionDecision };
    }
  | { id: string; method: "setModel"; params: { sessionId: string; model: string } };

/** Server → client responses and notifications. */
export type ServerMessage =
  | { kind: "response"; id: string; result: unknown }
  | { kind: "response"; id: string; error: { code: string; message: string } }
  | { kind: "event"; sessionId: string; event: AgentEvent }
  | { kind: "sessions"; sessions: SessionHeader[] };

export const PROTOCOL_VERSION = 1;
