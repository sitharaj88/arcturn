/** Wire protocol for server mode (@arcturn/protocol implements framing/validation). */

import type { AgentEvent } from "./events.js";
import type { ModelCost } from "./models.js";
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
  | { id: string; method: "setModel"; params: { sessionId: string; model: string } }
  /**
   * Ask for the server's model catalog, so a client can render a real picker
   * instead of guessing from the ids one session happened to announce.
   *
   * Takes no params and touches no session: it is a property of the server,
   * not of a conversation. Answers with a {@link ModelCatalog}.
   *
   * **Optional and additive.** A server that predates this verb answers
   * `{ code: "invalidRequest", message: 'Unknown method: "listModels"' }` and
   * keeps the connection open, so a client that wants the catalog can ask and
   * fall back on the rejection. That is why adding it did not bump
   * {@link PROTOCOL_VERSION}.
   */
  | { id: string; method: "listModels" };

/**
 * Whether the credential a model authenticates with is present on the server.
 *
 * - `"present"` — the server found a key for this model in its environment.
 * - `"absent"` — the model names an environment variable and it is not set.
 * - `"unknown"` — the server cannot tell from the environment alone: the model
 *   names no variable (it authenticates from ambient credentials — an AWS
 *   profile, Google application-default credentials), or it needs no key at
 *   all (a local OpenAI-compatible endpoint).
 *
 * `"unknown"` is not a polite `"absent"`: a client must not present it as
 * "you cannot use this model", only as "the server could not tell".
 */
export type ModelCredentialStatus = "present" | "absent" | "unknown";

/** One model in a {@link ModelCatalog}. */
export interface ModelCatalogEntry {
  /** Catalog id, as `setModel` accepts it, e.g. `"anthropic/claude-sonnet-5"`. */
  id: string;
  /** The `provider` field of the underlying model spec, e.g. `"anthropic"`. */
  provider: string;
  /** Human-readable name, e.g. `"Claude Sonnet 5"`. */
  displayName: string;
  /** Total context window, in tokens. */
  contextWindow: number;
  /** Largest completion the model will produce, in tokens. */
  maxOutputTokens?: number;
  /**
   * USD per million tokens.
   *
   * **Absent means the price is unknown, which is not the same as free.** A
   * model that genuinely costs nothing reports `{ input: 0, output: 0 }`; a
   * model nobody has published a rate for reports no `cost` at all. A client
   * that renders the missing case as `$0.00` is telling the user something
   * false — say "pricing unknown" instead. This mirrors what the CLI's
   * `--list-models` has always printed.
   */
  cost?: ModelCost;
  /**
   * Name of the environment variable this model authenticates with, e.g.
   * `"ANTHROPIC_API_KEY"`. **Never its value** — the wire carries the name so
   * a client can tell the user what to set, and nothing more.
   */
  apiKeyEnv?: string;
  /** Whether that credential is present on the server. See {@link ModelCredentialStatus}. */
  credentials: ModelCredentialStatus;
}

/** The `listModels` result: every model this server can be switched to. */
export interface ModelCatalog {
  models: ModelCatalogEntry[];
}

/** Server → client responses and notifications. */
export type ServerMessage =
  | { kind: "response"; id: string; result: unknown }
  | { kind: "response"; id: string; error: { code: string; message: string } }
  | { kind: "event"; sessionId: string; event: AgentEvent }
  | { kind: "sessions"; sessions: SessionHeader[] };

/**
 * The wire revision this build speaks.
 *
 * Bump it only for a change an existing peer cannot survive. Adding an
 * *optional* verb is not one: `listModels` is refused by an older server with
 * an ordinary `invalidRequest` response, which a newer client handles, and an
 * older client simply never sends. A bump, by contrast, is a hard break in
 * both directions — `SessionHeader.version` is stamped with `1` and validated
 * as `1`, and `@arcturn/protocol`'s client rejects any header or handshake
 * that advertises a different number — so raising it would sever every
 * existing client/server pair to announce a feature neither of them needs to
 * negotiate.
 */
export const PROTOCOL_VERSION = 1;
