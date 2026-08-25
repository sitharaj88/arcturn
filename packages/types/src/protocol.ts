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
  | { id: string; method: "listModels" }
  /**
   * Ask for a session's **stored** conversation, so a client that just
   * attached can render what was already said.
   *
   * `openSession` answers with a {@link SessionHeader} and subscribes the
   * connection to *future* events; nothing replays the past. A client with no
   * way to ask for it can only show an empty chat for a session that has
   * hours of work in it, which is the gap this verb closes.
   *
   * Answers with a {@link SessionHistory}: the stored entries projected back
   * onto the same {@link AgentEvent} union the live stream carries, so a
   * client folds them through whatever reducer it already runs on
   * `{ kind: "event" }` frames — no second transcript builder, no second set
   * of rendering rules that can drift from the live one.
   *
   * Deliberately **not** folded into `openSession`. Three reasons: an
   * `openSession` that answered with more than a `SessionHeader` would change
   * a payload every existing client validates as a header (and so would need a
   * {@link PROTOCOL_VERSION} bump); a client re-attaching after a reconnect
   * often does not want the replay again; and a bounded, separately-requested
   * payload is one a client can choose to skip when it is showing something
   * else.
   *
   * **Optional and additive**, on exactly the same terms as `listModels`: a
   * server that predates this verb answers
   * `{ code: "invalidRequest", message: 'Unknown method: "sessionHistory"' }`
   * and keeps the connection open, so a newer client degrades to the empty
   * transcript it showed before. That is why adding it did not bump
   * {@link PROTOCOL_VERSION}.
   */
  | { id: string; method: "sessionHistory"; params: { sessionId: string } }
  /**
   * Delete a session permanently: its header, every entry, and the file (or
   * record) behind them.
   *
   * The **engine** owns this. A client that unlinked the session file itself
   * would be a second implementation of session storage living outside the
   * process that owns it — it would miss a session still live in the server's
   * memory, and it would have no way to know a run was in flight. So the verb
   * exists and the deletion happens where the store does.
   *
   * Irreversible, and refused for a session that is **currently running**: the
   * server answers `sessionBusy` rather than deleting the file out from under
   * an agent that is still appending to it. Abort the run first, then delete.
   *
   * A session that is live but idle *is* deleted — the server evicts it from
   * memory as part of the same operation, and every connection observing it is
   * sent a final `notice` event saying so before its subscription is dropped,
   * so an attached client is told rather than left watching a session that no
   * longer exists.
   *
   * **Optional and additive**, like `listModels` and `sessionHistory` — but a
   * client must *not* read the older server's `invalidRequest` refusal as
   * success. Nothing was deleted; see `ProtocolClient.deleteSession`.
   */
  | { id: string; method: "deleteSession"; params: { sessionId: string } };

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

/**
 * The `sessionHistory` result: one session's stored conversation, replayed as
 * events and bounded so it can never be the frame that wedges a connection.
 *
 * ### Why events and not a message list
 *
 * A projected `{ role, text }[]` would be smaller, and every client would then
 * have to grow a second renderer for it — one that decides all over again how
 * a tool call, a denied permission, a compaction or a sub-agent reads, and
 * that drifts from the live one the first time either side changes. Replaying
 * the same {@link AgentEvent}s the live stream already carries means a client
 * folds history through the *identical* reducer, so a transcript rebuilt from
 * disk and a transcript watched as it happened are the same code path by
 * construction.
 *
 * The events are a faithful projection, not a recording: the stream that
 * produced them was not stored (only the resulting messages were), so a
 * replayed assistant turn arrives as one `messageEnd` rather than the token
 * deltas a live client saw. Every *string* in it comes from the stored entry
 * that carried it — nothing is re-derived, paraphrased or invented — and only
 * event types the live stream also emits are used.
 */
export interface SessionHistory {
  /** The session this history belongs to. */
  sessionId: string;
  /** The stored conversation, oldest first. */
  events: AgentEvent[];
  /**
   * Whether older events were dropped to fit the cap.
   *
   * Reported explicitly rather than left for a client to infer, because the
   * failure this exists to prevent is silent: a transcript that starts
   * mid-conversation and says nothing about it reads as the whole
   * conversation. A client that sees `true` must tell the user that earlier
   * messages are not shown.
   */
  truncated: boolean;
  /**
   * How many events were dropped from the **front** (the oldest end). `0`
   * when `truncated` is `false`.
   */
  droppedEvents: number;
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
 * older client simply never sends. `sessionHistory` and `deleteSession` were
 * added on exactly those terms and did not bump it either — neither changes
 * the shape of any payload an existing peer already parses.
 * A bump, by contrast, is a hard break in
 * both directions — `SessionHeader.version` is stamped with `1` and validated
 * as `1`, and `@arcturn/protocol`'s client rejects any header or handshake
 * that advertises a different number — so raising it would sever every
 * existing client/server pair to announce a feature neither of them needs to
 * negotiate.
 */
export const PROTOCOL_VERSION = 1;
