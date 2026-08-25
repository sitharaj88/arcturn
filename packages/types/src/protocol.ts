/** Wire protocol for server mode (@arcturn/protocol implements framing/validation). */

import type { AgentEvent } from "./events.js";
import type { ModelCost } from "./models.js";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  PermissionScope,
} from "./permissions.js";
import type { SessionHeader } from "./session.js";

/** Client → server requests. */
export type ClientRequest =
  | { id: string; method: "listSessions" }
  | { id: string; method: "createSession"; params: { cwd: string; model?: string } }
  | { id: string; method: "openSession"; params: { sessionId: string } }
  /**
   * Start a run from a user prompt.
   *
   * `text` is expanded **server-side** before it reaches the model: `@path`
   * mentions are resolved against the session's `cwd` under the same workspace
   * confinement the TUI applies, so a remote client sends the mention and the
   * engine — the only process the permission engine can see — does the reading.
   * See RFC 0005 §3: a file read by a client is a file the permission engine
   * never saw.
   *
   * `attachments` is optional and additive; see {@link PromptAttachment}. A
   * server that predates it ignores the field (it validates and drops unknown
   * params), which is why a client that cares whether its attachments arrived
   * must probe with `resolveContext` first — that verb's absence is the honest
   * signal that this engine has no attachment support either.
   */
  | {
      id: string;
      method: "prompt";
      params: { sessionId: string; text: string; attachments?: PromptAttachment[] };
    }
  /** Queue a mid-run steering message the agent sees after the current tool finishes. */
  | { id: string; method: "steer"; params: { sessionId: string; text: string } }
  | { id: string; method: "abort"; params: { sessionId: string } }
  /**
   * Answer a pending permission ask.
   *
   * `scope` says **how long the allow lasts**, so "allow once" and "allow for
   * this session" are distinguishable at the moment of asking rather than
   * inferred afterwards from whether a rule showed up:
   *
   * - **omitted** — allow once. This call and nothing else.
   * - **`"session"`** — allow for the rest of this session. The *engine*
   *   builds the rule, from the {@link PermissionRequest.suggestedRule} it
   *   itself put on the ask; a client never authors one. A request with no
   *   `suggestedRule` is not repeatable, and asking for `"session"` on one is
   *   refused rather than quietly downgraded to once.
   * - **`"project"` / `"user"`** — **refused**, `invalidRequest`. Those two
   *   scopes are the ones that outlive the session, and a rule that outlives a
   *   session is written by a person in their own config file. RFC 0005 §3:
   *   "no remote write to a user's permission config."
   *
   * {@link PermissionDecision.persistRule} is still honoured for clients that
   * already send it, under exactly the same wall: its `scope` must be
   * `"session"`. Anything wider is refused by the same rule, at the same seam.
   *
   * ### Degradation
   *
   * `scope` is an optional field on an existing verb, not a new verb, so a
   * server that predates it drops the field (validation copies params out one
   * at a time) and the decision lands as an allow-*once*. That direction is
   * safe on purpose: the client is asked again next time, which is a nuisance,
   * where the reverse — a stale server granting a session rule it does not
   * understand — would be a lie about what was granted.
   */
  | {
      id: string;
      method: "permissionDecision";
      params: { sessionId: string; decision: PermissionDecision; scope?: PermissionScope };
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
  | { id: string; method: "deleteSession"; params: { sessionId: string } }
  /**
   * Ask what a mention *would* resolve to, without sending anything.
   *
   * A file picker that offers a path it cannot actually attach is a picker
   * that lies; RFC 0005 §1.1 exists to make one honest. The answer carries the
   * resolved path, the byte count, whether the path exists, and — the field
   * that decides whether a chip may be offered at all — whether it lands
   * inside the session's workspace.
   *
   * **Read-only, and deliberately so.** Nothing is attached, no turn is
   * started, no file is opened for a path that fails confinement: an
   * out-of-workspace query is answered from string arithmetic on what the
   * client itself supplied, so this verb can never become a filesystem oracle
   * for paths the engine would refuse to read.
   *
   * Session-scoped because the resolution is against the session's `cwd`;
   * answers with a {@link ContextResolution}.
   *
   * **Optional and additive**, on the same terms as `listModels` and
   * `sessionHistory` — and safe to degrade for the same reason those are: it
   * only reads, so an older server's `invalidRequest` costs a client a preview,
   * never a guarantee. See `ProtocolClient.resolveContext`.
   */
  | { id: string; method: "resolveContext"; params: { sessionId: string; query: string } }
  /**
   * Ask what permission regime this session is running under.
   *
   * Answers with a {@link PermissionState}: the mode, the rules in force, and
   * **the names of the tools the session actually holds**. That last field is
   * RFC 0005 §1.4 in its entirety — there is no `canBrowseWeb` verb and there
   * will not be one, because "can this engine reach the web" is not a separate
   * capability, it is whether `fetch` and `websearch` are in the tool set. A
   * panel that renders a browse affordance reads it from here or does not
   * render one; §3 refuses "capability implied by an affordance".
   *
   * Session-scoped: mode and rules belong to one agent, not to the server.
   *
   * **Optional and additive**, degrading like `listModels`: this verb only
   * *reads*, so an older server's `invalidRequest` costs a client a mode chip
   * and a tools line, never a guarantee. A client that gets `undefined` shows
   * neither rather than guessing at either.
   */
  | { id: string; method: "permissionState"; params: { sessionId: string } }
  /**
   * Ask this session to run under a different permission mode.
   *
   * **A mode is a request, not a grant.** The engine stays the authority: a
   * stored `deny` rule outranks every mode including `yolo`, exactly as it
   * does for a local user (see `PermissionEngine`'s resolution order — rules
   * are step 3, modes are step 5). Setting a mode never gives a client
   * anything the permission engine would not give the person at the terminal.
   *
   * **It never edits rules.** Rules live in a file a person owns; there is no
   * wire path that writes one. See `permissionDecision`'s `scope`.
   *
   * **Refused mid-run** with `sessionBusy`. A mode changed halfway through a
   * turn would mean one half of that turn ran under one policy and the other
   * half under another — a tool call already blocked on a client's answer
   * settling under the old rules while the next call in the same turn settles
   * under the new. RFC 0005 §2 promises the change "takes effect on the next
   * turn"; refusing while a run is in flight is what makes that literally
   * true, and it hands the client something to act on (abort, or wait) rather
   * than a change silently deferred to a moment it cannot observe.
   *
   * Answers with the resulting {@link PermissionState} — the *engine's* answer
   * to "what am I now", not an echo of what was asked, so a client never has
   * to make a second round trip to find out whether it got what it wanted.
   *
   * **Not optional, and deliberately not degradable.** This is the
   * counter-precedent `deleteSession` set, and it matters more here. A client
   * told "fine" by a server that ignored the request would show a `plan` chip
   * over an engine still in `yolo` — the user believes they have restricted
   * the agent, and the next write executes. Silently doing nothing is the one
   * outcome a permission control may not have, so an older server's
   * `invalidRequest` rejects like any other failure; see
   * `ProtocolClient.setPermissionMode`.
   */
  | {
      id: string;
      method: "setPermissionMode";
      params: { sessionId: string; mode: PermissionMode };
    }
  /**
   * Ask what a `/` could invoke here.
   *
   * Answers with a {@link CommandList}: every markdown skill the workspace
   * holds, plus the built-in commands a remote client can **actually reach**.
   * "Actually reach" is the whole discipline — a menu offering `/rewind` to a
   * client with no rewind verb is a menu that lies, so a built-in is listed
   * only when the verbs on this wire can carry it out. See
   * {@link CommandDescriptor.kind}.
   *
   * Not session-scoped: skills are discovered from the served workspace and
   * the user's home, both properties of the server, so this is shaped like
   * `listModels` rather than like `permissionState`.
   *
   * **Execution stays `prompt`.** A skill is prompt text; there is no
   * `runCommand` verb and there will not be one, because a second execution
   * path would give one skill two behaviours that could drift.
   *
   * **Optional and additive**, degrading like `listModels`: read-only, so an
   * older server's `invalidRequest` costs a client its `/` menu and nothing
   * else.
   */
  | { id: string; method: "listCommands" };

/**
 * One piece of context a client attaches to a `prompt`.
 *
 * ### Why a path, and not the bytes
 *
 * RFC 0005 §3 refuses client-side context assembly: "The panel never reads a
 * file to build a prompt... A file read by the extension is a file the
 * permission engine never saw." A `file` attachment is therefore **always** a
 * path — the engine opens it, under the same workspace confinement a mention
 * gets, or refuses. Sending bytes for something that exists on disk would move
 * the read to the one process that cannot be confined.
 *
 * ### Why `image` may still carry bytes
 *
 * An image pasted from the clipboard has no path, was never a workspace file,
 * and so has nothing for confinement to check — there is no read to move and
 * no file to protect. Refusing it would mean the panel could not honour
 * RFC 0005 §2's "paste-an-image", or would have to write a temp file into the
 * user's workspace first, which is a worse trade. So inline data is accepted
 * for `image` and only for `image`, capped with everything else against the
 * total attachment budget, and restricted to the image types the engine
 * already knows how to send.
 */
export type PromptAttachment =
  /** A workspace file, read by the engine and injected as a context block. */
  | { kind: "file"; path: string }
  /** A workspace image, read by the engine and sent as a vision block. */
  | { kind: "image"; path: string }
  /** An image with no path — a paste, a drop from outside the filesystem. */
  | { kind: "image"; data: string; mimeType: string };

/**
 * What a resolved context item turns out to be.
 *
 * `"other"` is the honest answer for something that is neither a regular file
 * nor a directory — a socket, a fifo, a device node. Given its own value rather
 * than folded into `"missing"` because a picker told "nothing is there" about a
 * path the user can plainly see would be told something false.
 */
export type ContextKind = "file" | "image" | "directory" | "missing" | "other";

/**
 * The `resolveContext` result: what one mention would resolve to.
 *
 * Every field is answerable without attaching anything, and the two that a
 * client must not conflate are kept apart deliberately: `inWorkspace` is a
 * *policy* answer (may the engine read this at all) and `exists` is a *fact*
 * (is there a file there). A path outside the workspace reports
 * `inWorkspace: false`, `exists: false` and `bytes: 0` because the engine
 * never looked — not because it looked and found nothing.
 */
export interface ContextResolution {
  /** The query exactly as the client asked it. */
  query: string;
  /**
   * Where the query lands, absolute and normalized.
   *
   * Present even when the path is outside the workspace: it is pure string
   * arithmetic over a value the client itself supplied, and telling a user
   * *where* their `../../etc/passwd` would have gone is what makes the refusal
   * legible. No filesystem call is made to produce it.
   */
  path: string;
  /**
   * The same path relative to the session's workspace, `/`-separated — what a
   * chip shows. Empty when the path is outside the workspace, because there is
   * no honest relative spelling of one.
   */
  relativePath: string;
  /** Whether the path resolves inside the session's workspace. */
  inWorkspace: boolean;
  /** Whether a file is actually there. Always `false` when `inWorkspace` is `false`. */
  exists: boolean;
  /** Size in bytes. `0` when the path does not exist or was never looked at. */
  bytes: number;
  /** What it is. `"missing"` when nothing is there, or nothing was looked at. */
  kind: ContextKind;
  /**
   * Why this cannot be attached, in one sentence, when it cannot. Absent when
   * the item is attachable as-is.
   */
  reason?: string;
}

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

/**
 * The `permissionState` / `setPermissionMode` result: what one session is
 * allowed to do, and by whose authority.
 *
 * Read as a whole rather than field by field. `mode` is what was *asked for*
 * and granted; `rules` is what the mode cannot talk its way past; `tools` is
 * the outer bound on both — a rule about a tool the session does not hold, or
 * a mode permissive enough to allow one, still cannot conjure it.
 */
export interface PermissionState {
  /** The session this state belongs to. */
  sessionId: string;
  /** The mode in force right now. */
  mode: PermissionMode;
  /**
   * The engine's *effective* rules, in resolution order: what the server's
   * config seeded plus every session-scoped allow granted during this session.
   *
   * A snapshot, and read-only in both senses — there is no verb that writes
   * one. A rule that outlives a session is written by a person, in their own
   * config file (RFC 0005 §1.2).
   */
  rules: PermissionRule[];
  /**
   * The names of the tools this session holds, sorted.
   *
   * The **entire** mechanism behind RFC 0005 §1.4: a client that wants to say
   * "this engine can browse the web" checks for `fetch` / `websearch` here and
   * says it truthfully, or does not say it. Names only — never a tool's
   * description or schema, which are the model's business and would put an
   * untrusted extension's prose on a wire that feeds a UI.
   *
   * The full set the session was built with, not the subset currently
   * disclosed to the model: progressive tool disclosure changes what the model
   * is *shown* this turn, not what the engine *can do*, and a capabilities
   * line that flickered turn to turn would be worse than none.
   */
  tools: string[];
}

/**
 * One entry in a {@link CommandList}.
 *
 * The contract a client can rely on: **everything listed here is something
 * this wire can carry out.** Nothing is listed on the strength of existing
 * somewhere in the engine.
 */
export interface CommandDescriptor {
  /** Name without the leading slash, e.g. `"review"`. */
  name: string;
  /**
   * One line of help. `""` when the source set none.
   *
   * For a skill this is the file's `description` frontmatter, **sanitized**
   * exactly as the model-facing skill index sanitizes it — first line only,
   * control characters collapsed, length-capped. A skill under
   * `<cwd>/.arcturn/skills` is content a cloned repository controls, and this
   * string now lands in a menu a person reads and clicks; it gets the same
   * treatment on the way to a UI that it already gets on the way to a prompt.
   */
  description: string;
  /**
   * `"skill"` — a markdown file in the workspace or the user's home.
   * `"builtin"` — a command the engine ships, listed only because the verbs on
   * this wire can actually carry it out.
   *
   * A client groups on this (RFC 0005 §2 puts skills first, built-ins after).
   */
  kind: "skill" | "builtin";
  /**
   * Absolute path of the markdown file a skill was loaded from — the same
   * value `Skill.source` carries, so a menu can show provenance and a person
   * can tell a project-provided command from one of their own.
   *
   * Absent for a built-in: there is no file, and inventing a path would be a
   * worse answer than none.
   */
  source?: string;
}

/**
 * The `listCommands` result.
 *
 * Ordered as a menu wants it: skills first, alphabetically, then built-ins.
 * Sorting server-side means every client's `/` menu agrees.
 */
export interface CommandList {
  /** Everything a `/` could invoke here. */
  commands: CommandDescriptor[];
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
 *
 * RFC 0005's verbs were added on those same terms, and the interesting part is
 * that "optional" and "degradable" are not the same question. All of them are
 * optional — an older peer never sends them and refuses them with
 * `invalidRequest`. Whether a *client* may translate that refusal into a shrug
 * is decided per verb, by what the shrug would claim:
 *
 * - `permissionState` and `listCommands` degrade to `undefined`, on the
 *   `listModels` precedent. They read. A client that gets nothing shows no
 *   mode chip and no `/` menu, which is exactly true.
 * - `setPermissionMode` does **not**, on the `deleteSession` counter-precedent
 *   — and for a sharper reason than `deleteSession` had. A delete that
 *   silently did not happen leaves a user confused; a permission mode that
 *   silently did not happen leaves them believing they restricted an agent
 *   they did not restrict, and the next write executes. It rejects.
 * - `permissionDecision`'s `scope` is a new *field*, not a verb: an older
 *   server drops it and the allow lands as an allow-once. That degradation
 *   narrows, never widens, which is the only direction a permission field may
 *   silently move.
 *
 * A bump, by contrast, is a hard break in
 * both directions — `SessionHeader.version` is stamped with `1` and validated
 * as `1`, and `@arcturn/protocol`'s client rejects any header or handshake
 * that advertises a different number — so raising it would sever every
 * existing client/server pair to announce a feature neither of them needs to
 * negotiate.
 */
export const PROTOCOL_VERSION = 1;
