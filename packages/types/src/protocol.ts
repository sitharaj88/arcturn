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
  | { id: string; method: "listCommands" }
  /**
   * Summarise the head of a session's conversation to free up context — the
   * operation the terminal's `/compact` runs, reached over the wire.
   *
   * There is exactly one compactor. This verb drives `Agent.compact()`, which
   * is the method `@arcturn/cli`'s `/compact` command calls and the one the
   * run loop calls when it crosses the automatic threshold. A second
   * implementation would summarise with different options, cut at a different
   * turn boundary, and write a different `compaction` entry into the same
   * session file.
   *
   * **Refused mid-run** with `sessionBusy`, not queued. `Agent.compact()`
   * itself throws while a run is in flight, because compaction *rewrites the
   * message array the loop is iterating*; queueing would only move that hazard
   * behind a promise, and it would race the loop's own automatic compaction,
   * which can fire in the same window with different bounds. A queued
   * compaction would also settle at a moment the client cannot observe, so the
   * before/after numbers below would describe a conversation that had since
   * moved on. This is the refusal `setPermissionMode` and `deleteSession`
   * already make, for the same underlying reason — some operations have no
   * correct meaning halfway through a turn — and it hands the client something
   * to do: abort, or wait for `runEnd`.
   *
   * Answers with a {@link CompactionSummary}: the token estimate on both
   * sides, and whether anything was actually folded. "It did something" is not
   * a report — a client that cannot say how much context it just freed cannot
   * tell a compaction that worked from one that found nothing to fold.
   *
   * **Optional but deliberately not degradable.** A client told "fine" by a
   * server that ignored this would believe it had freed context it did not
   * free, keep filling the window, and hit the wall it just asked to be moved.
   * That is the `deleteSession` counter-precedent: an older server's
   * `invalidRequest` rejects like any other failure. See
   * `ProtocolClient.compact`.
   */
  | { id: string; method: "compact"; params: { sessionId: string } }
  /**
   * Render a session's conversation as a document the **client** saves.
   *
   * The terminal's `/export` writes a file next to the person who ran it. Over
   * this wire that would be the wrong machine: the engine's disk is not where
   * the person asking will look, and an engine that writes a file wherever a
   * remote client asks is an arbitrary-write primitive shaped like a
   * convenience. So this verb answers with the rendered content and a
   * suggested filename, and the client writes it — RFC 0005 §1.2's "nothing
   * persists to disk from a remote client", pointed at transcripts.
   *
   * `format` selects the same two renderers `/export` offers, and
   * `includeThinking` is its `--thinking` flag. The defaults are the
   * terminal's: markdown, thinking omitted.
   *
   * **Bounded, and truncation is reported.** See {@link SessionExport}.
   *
   * Session-scoped, and requires a **live** session: this renders the
   * conversation the agent is holding, and a session nobody has opened is
   * holding none. `openSession` first — the requirement `resolveContext`
   * makes, for the same reason.
   *
   * **Optional and additive**, degrading like `listModels`: it only reads and
   * hands back a document, so an older server's `invalidRequest` costs a
   * client its export and no guarantee.
   */
  | {
      id: string;
      method: "exportSession";
      params: { sessionId: string; format?: TranscriptFormat; includeThinking?: boolean };
    }
  /**
   * The MCP status listing the terminal's `/mcp` shows: which servers are
   * configured, what each is reached over, whether it is connected, and how
   * many tools it exposes.
   *
   * **Names and status. Nothing else.** An MCP config is where a workspace
   * keeps its secrets — a stdio server's `env` and `args`, an HTTP server's
   * `url` and its `Authorization` header, an OAuth bearer token minted at
   * connect time — and none of it is on this wire. Neither is a server's own
   * error text: a failure message is prose an MCP server wrote, and this
   * payload feeds a menu a person reads. {@link McpServerSummary} is therefore
   * four fields, two of them closed enumerations, and the validator copies
   * them out one at a time so a field the manager's status grows tomorrow
   * cannot ride along. That is the discipline {@link PermissionState.tools}
   * already keeps for tool names.
   *
   * Not session-scoped: MCP servers are a property of the server process, so
   * this is shaped like `listModels` rather than like `permissionState`.
   *
   * **Optional and additive**, degrading like `listModels`: read-only, so an
   * older server's `invalidRequest` costs a client the listing and nothing
   * else.
   */
  | { id: string; method: "mcpStatus" }
  /**
   * Ask what a `--dry-run` session has waiting for review.
   *
   * `--dry-run` reroutes every `write`/`edit` into a shadow copy of the
   * workspace and lets a person read the change before it lands. In a terminal
   * that is `/diff`, then `/apply` or `/discard`. Nothing on this wire could
   * reach any of it, so a remote client running a dry-run engine was told
   * nothing had happened while a whole refactor sat in a shadow tree.
   *
   * Answers with {@link PendingChanges}.
   *
   * ### Two shapes, one verb
   *
   * - **`path` omitted** — the *summary*: one row per waiting file with its
   *   path, its {@link PendingChange.kind} and its size before and after, and
   *   **no content at all**.
   * - **`path` given** — that one file's row, plus {@link PendingChange.after},
   *   the content `applyChanges` would write.
   *
   * The split is the whole payload argument. A hundred-file refactor's patches
   * are megabytes; `sessionHistory` established that a response is budgeted at
   * 1 MiB because that is `ws-server.ts`'s own backpressure threshold and a
   * quarter of the frame size above which `ws` closes the connection. A verb
   * that shipped every patch would be the frame that wedges the socket exactly
   * when a reviewer most needs it, so the list is bounded metadata and the
   * bytes are fetched one file at a time — which is also the only granularity
   * a diff editor ever renders.
   *
   * ### Why no "before"
   *
   * Because apply is a whole-file write, not a patch: the engine writes
   * {@link PendingChange.after} over the real file, and never diffs against a
   * snapshot. The left-hand side of an honest review is therefore *the real
   * file as it stands*, which is a moving target (`bash` is not wrapped by the
   * overlay, so the real tree can change under a dry run), and a `before` on
   * this wire would be a snapshot a client could show while the engine applied
   * against something else. A client renders the diff against the workspace
   * file it already has.
   *
   * **Optional and additive**, degrading like `listModels`: it only reads, so
   * an older engine's `invalidRequest` costs a client its review surface and
   * nothing more. See `ProtocolClient.pendingChanges`.
   */
  | { id: string; method: "pendingChanges"; params: { sessionId: string; path?: string } }
  /**
   * Write pending changes back over the real workspace files.
   *
   * This is the verb that touches a person's working directory, and everything
   * the engine enforces for a local `/apply` holds here unchanged: each file is
   * written via a temp file plus rename in its destination directory (an
   * interrupted apply cannot leave a half-written file), and each destination
   * has its existing ancestors resolved through symlinks and checked against
   * the workspace root before a byte is written. A path that resolves outside
   * is refused per file and reported, never written.
   *
   * `paths` is **selectable** — omit it to land everything, or name a subset,
   * spelled exactly as {@link PendingChange.path} reported it (workspace-
   * relative, `/`-separated). A name that is not currently pending refuses the
   * **whole** request rather than applying the rest: a client that selected
   * four files and got three, silently, is the failure this verb exists to
   * avoid, and it is also the only confinement a subset needs — nothing can be
   * applied that the engine did not itself just list.
   *
   * **Refused mid-run** with `sessionBusy`, like `setPermissionMode` and
   * `deleteSession`. Applying while the agent is still writing into the shadow
   * tree is a race with the user's files on one side; and because one served
   * engine has **one** shadow tree shared by every session it hosts, the check
   * covers every live session rather than only the one named here.
   *
   * Answers with an {@link ApplyChangesResult}.
   *
   * **Not degradable.** An `applyChanges` that resolved against an engine which
   * ignored it would tell a reviewer their change had landed while the file on
   * disk still said otherwise — and they would then discard the shadow tree
   * that held the only copy. An older engine's `invalidRequest` rejects, like
   * `deleteSession`'s.
   */
  | { id: string; method: "applyChanges"; params: { sessionId: string; paths?: string[] } }
  /**
   * Throw pending changes away. **Destructive and irreversible** — the shadow
   * tree is the only record of that work, and nothing survives this.
   *
   * `paths` is selectable on exactly the terms `applyChanges`'s is, including
   * the refusal for a name that is not pending. Omitted, the whole shadow tree
   * goes.
   *
   * There is no wire-level confirmation and deliberately so: `deleteSession`
   * set that discipline, and it puts the confirmation where a person can see
   * what they are losing — a native modal in the client, naming it — rather
   * than inventing a two-phase token the engine would have to keep state for.
   * What the engine owns is the refusal a client cannot make for itself:
   * **`sessionBusy` mid-run**, for the same reason `applyChanges` refuses.
   *
   * Answers with a {@link DiscardChangesResult}.
   *
   * **Not degradable**, and this is the sharper half of the pair. A discard
   * that silently did nothing leaves a user believing their pending edits are
   * gone; they are not, and the next apply lands them.
   */
  | { id: string; method: "discardChanges"; params: { sessionId: string; paths?: string[] } };

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

/**
 * The `compact` result: what the conversation cost before and after, and
 * whether anything moved.
 *
 * Read `compacted` first. `false` with `tokensBefore === tokensAfter` is the
 * honest shape of "nothing happened", and `reason` says which kind of nothing
 * it was — there was no turn boundary old enough to fold, or the summarizer
 * failed. Those two are not the same news: the first is a session that is
 * simply too short, the second is a fault worth retrying.
 *
 * Both token counts are the engine's own `Agent.estimatedTokens` measure — the
 * same number the terminal's `/compact` prints and the same one the run loop
 * compares against the context window before every turn. A client that
 * rendered a differently-derived figure would be showing a second answer to a
 * question the engine has already answered.
 */
export interface CompactionSummary {
  /** The session that was compacted. */
  sessionId: string;
  /**
   * Whether history was actually folded into a summary.
   *
   * `false` is a complete, successful answer — not an error. Nothing was
   * summarised, nothing was lost, and the session is exactly as it was.
   */
  compacted: boolean;
  /** Estimated context size before, in tokens. */
  tokensBefore: number;
  /**
   * Estimated context size after, in tokens. Equal to `tokensBefore` whenever
   * `compacted` is `false`, because nothing changed.
   */
  tokensAfter: number;
  /**
   * Why nothing was folded, in one sentence, when nothing was.
   *
   * The engine's own words — the same `notice` a local user sees — rather than
   * a code, because the two cases a client cares about ("too short to fold"
   * and "the summarizer failed") are things to *say*, not to branch on.
   * Absent when `compacted` is `true`.
   */
  reason?: string;
}

/**
 * The two documents `exportSession` renders, matching the terminal's `/export`.
 *
 * Spelled out rather than abbreviated (`/export md` takes `md`): a wire
 * contract is read by people who have never seen the terminal command, and
 * `"markdown"` needs no footnote. The suggested filename still ends `.md`.
 */
export type TranscriptFormat = "markdown" | "html";

/**
 * The `exportSession` result: a document, its name, and an honest account of
 * whether it is the whole conversation.
 *
 * ### Why content and not a path
 *
 * Because the client is the one that saves it. See the verb's own doc: a
 * remote client that could make the engine write a file would be choosing a
 * destination on someone else's disk.
 *
 * ### The bound, and why truncation drops from the front
 *
 * The payload is capped at the same 1 MiB `SessionHistory` is capped at, and
 * for the same reason stated there: 1 MiB is `ws-server.ts`'s own
 * `DEFAULT_BACKPRESSURE_THRESHOLD_BYTES` — the point at which the server
 * already considers a connection to be in trouble — and a quarter of the 4 MiB
 * frame size above which `ws` closes the connection with 1009. A response to
 * the client's own request is essential traffic that backpressure never drops,
 * which is exactly why it must not be the frame that wedges the socket.
 *
 * When the rendered document is over the cap, the **oldest** messages are
 * dropped and the document is re-rendered from what is left, so what arrives
 * is always a well-formed document rather than a file cut off mid-tag. Unlike
 * `SessionHistory` there is no second element-count bound: a client folds
 * history through a reducer and pays per event, but an export is a string it
 * writes to disk, and bytes are the only cost it has.
 *
 * `truncated` is reported rather than left to be inferred, for the reason
 * {@link SessionHistory.truncated} gives: a transcript that starts
 * mid-conversation and says nothing about it reads as the whole conversation.
 */
export interface SessionExport {
  /** The session this document renders. */
  sessionId: string;
  /** The format actually rendered — the request's, or the default. */
  format: TranscriptFormat;
  /**
   * A filename to offer in a save dialog, e.g.
   * `arcturn-session-2026-08-25-1200.md`. A **name**, never a path: where it
   * lands is the client's business, and a directory chosen by the engine would
   * be a directory on the wrong machine.
   */
  filename: string;
  /** The rendered document. */
  content: string;
  /** How many messages the document actually contains. */
  messageCount: number;
  /** Whether older messages were dropped to fit the cap. */
  truncated: boolean;
  /**
   * How many messages were dropped from the **front** (the oldest end). `0`
   * when `truncated` is `false`.
   */
  droppedMessages: number;
}

/** How an MCP server is reached. Mirrors `McpServerConfig`'s discriminant. */
export type McpTransport = "stdio" | "http";

/** Where one MCP server's connection stands. */
export type McpConnectionState = "disconnected" | "connecting" | "connected" | "failed";

/**
 * One row of {@link McpStatus}: a name, a transport, a state, a count.
 *
 * **Everything an MCP config holds that is not one of these four things stays
 * on the server.** The `url`, the `command`, the `args`, the `cwd`, the `env`,
 * the `headers`, the OAuth token — none of it is here, and none of it is here
 * by omission rather than by redaction: the projection is built from a closed
 * list of fields, so a config field added tomorrow is absent by default rather
 * than leaking until somebody notices.
 *
 * The failed server's own error text is left out on the same principle for a
 * second reason: it is prose an MCP server wrote, and this payload lands in a
 * menu a person reads. A client that wants to know *why* a server failed reads
 * the server's log, where untrusted text is already understood to be untrusted.
 */
export interface McpServerSummary {
  /**
   * The name the user gave this server in their own config — the key under
   * `servers`, and the only string here that is not a closed enumeration.
   */
  name: string;
  /** How it is reached. */
  transport: McpTransport;
  /**
   * Its connection state as the engine last observed it.
   *
   * Observed, not probed: this is the state the manager recorded, so a server
   * that died without announcing it still reads `"connected"`. A client may
   * present this as "the engine believes it is connected"; it is not a
   * liveness guarantee, and the terminal's `/mcp` pings precisely because a
   * person standing at a prompt can afford to wait for one.
   */
  state: McpConnectionState;
  /**
   * Tools this server currently exposes. Absent unless `state` is
   * `"connected"` — a disconnected server exposes none, and reporting `0`
   * would be indistinguishable from a connected server that offers none.
   */
  toolCount?: number;
}

/** The `mcpStatus` result: every MCP server this engine is configured with. */
export interface McpStatus {
  /**
   * The servers, sorted by name so two reads of an unchanged engine compare
   * equal. Empty when none are configured — which is a different and honest
   * answer from the `invalidRequest` an engine with no such verb sends.
   */
  servers: McpServerSummary[];
}

/**
 * One workspace file a `--dry-run` session is holding back.
 *
 * A row is metadata by default. {@link PendingChange.after} is present only on
 * a single-file `pendingChanges` fetch — see that verb's doc for why the list
 * carries no content.
 */
export interface PendingChange {
  /**
   * The file's path relative to the session's workspace, `/`-separated.
   *
   * **This is the identity**, and the only spelling `applyChanges` and
   * `discardChanges` accept. A client selects from what the engine listed and
   * cannot name anything else — which is what makes a selective apply a
   * narrowing of the engine's own list rather than a path the wire supplies.
   */
  path: string;
  /**
   * Where the file lives, absolute and normalized — what a client opens to
   * show the change against.
   *
   * The engine's, not the client's to compute: a client that joined `path`
   * onto a workspace root it guessed at would be wrong for a session rooted
   * anywhere but the first workspace folder.
   */
  absolutePath: string;
  /**
   * `"added"` — no such file exists yet, and applying creates it.
   * `"modified"` — the file exists and applying overwrites it.
   *
   * There is no `"deleted"`: the overlay wraps `write`, `edit` and `read`, and
   * none of them removes a file. A dry run cannot hold back a deletion, and a
   * kind that claimed otherwise would describe a change this engine cannot
   * make. (`bash` *can* delete a real file, but `bash` is not wrapped — that
   * deletion already happened and is not pending anything.)
   */
  kind: "added" | "modified";
  /** Byte length of the pending content — what the file becomes, not the delta. */
  bytes: number;
  /**
   * Byte length of the real file as it stands. `0` when `kind` is `"added"`.
   *
   * A size pair rather than the `+12 −3` a reviewer might expect, and that is
   * a deliberate refusal rather than an omission. Line counts that mean
   * anything are a line diff, this list is bounded at a thousand files, and a
   * *cheap* count — a multiset delta, say — is wrong for any change that moves
   * a block, which is most refactors. So the engine reports what it can state
   * exactly and leaves the counting to the surface that is already doing it:
   * a diff editor computes the real hunks from the same two contents when the
   * reviewer opens the file.
   */
  previousBytes: number;
  /**
   * The content `applyChanges` would write. Present **only** on a single-file
   * fetch, and absent when {@link PendingChange.contentOmitted} says why it
   * could not be carried.
   */
  after?: string;
  /**
   * Set when a single-file fetch could not carry the content because it
   * exceeds the response budget.
   *
   * Reported rather than truncated, which is the one place this payload
   * deliberately diverges from {@link SessionHistory}. Dropping the oldest
   * events from a transcript still leaves every surviving event true; half a
   * file rendered in a diff editor is a false account of the change, and a
   * reviewer would approve it. So the content is withheld and said to be
   * withheld.
   */
  contentOmitted?: boolean;
}

/**
 * The `pendingChanges` result: what a dry-run session is holding back.
 *
 * Read {@link PendingChanges.dryRun} first. A session that is not running
 * under `--dry-run` has no shadow tree and never will, and an empty
 * `changes` on its own reads as "nothing to review" — which is a different
 * and much more comforting sentence than "nothing is being held back here at
 * all, every edit went straight to your files". The flag is what keeps those
 * two apart, and a client that ignores it will tell somebody the wrong one.
 */
export interface PendingChanges {
  /** The session this was asked about. */
  sessionId: string;
  /**
   * Whether this engine is holding file mutations back at all.
   *
   * `false` means the session is not in dry-run mode: edits reached the
   * workspace as they were made, `changes` is empty because there is no
   * shadow tree, and `applyChanges`/`discardChanges` will refuse.
   *
   * A property of the served *engine* rather than of one conversation:
   * `--dry-run` is a flag on the process, and one shadow tree is shared by
   * every session it hosts.
   */
  dryRun: boolean;
  /** The waiting files, sorted by path. */
  changes: PendingChange[];
  /**
   * Whether rows were dropped to fit the caps.
   *
   * Reported explicitly for the reason {@link SessionHistory.truncated} is: a
   * list that silently stops short reads as the whole list, and here that
   * would mean a reviewer applying a change set they were never shown all of.
   */
  truncated: boolean;
  /** How many rows were dropped from the end. `0` when `truncated` is `false`. */
  droppedChanges: number;
}

/** One file that could not be written back, and why. */
export interface ApplyChangeFailure {
  /** The pending change's path, as {@link PendingChange.path} spelled it. */
  path: string;
  /** The engine's reason, in one sentence. */
  message: string;
}

/**
 * The `applyChanges` result.
 *
 * A per-file failure does not fail the request: the rest still land, and the
 * ones that did not are named. That is what the terminal's `/apply` does
 * ("Applied 4, failed 1. Pending changes kept.") and this is the same applier.
 */
export interface ApplyChangesResult {
  /** The session this was asked of. */
  sessionId: string;
  /** Paths that were written, as {@link PendingChange.path} spelled them. */
  applied: string[];
  /** Paths that were not, with a reason each. */
  failed: ApplyChangeFailure[];
  /**
   * How many changes are still pending afterwards.
   *
   * Counted by re-reading the shadow tree, not by subtracting: an applied file
   * stops being a change because its shadow copy now matches the real file,
   * and a number derived from arithmetic rather than from the tree would drift
   * the first time a run wrote something in between.
   */
  remaining: number;
}

/** The `discardChanges` result. */
export interface DiscardChangesResult {
  /** The session this was asked of. */
  sessionId: string;
  /** Paths that were thrown away, as {@link PendingChange.path} spelled them. */
  discarded: string[];
  /** How many changes are still pending afterwards. See {@link ApplyChangesResult.remaining}. */
  remaining: number;
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
 * The dry-run review verbs were decided the same way, and they split the same
 * way. `pendingChanges` degrades to `undefined` — it reads, and a client that
 * gets nothing shows no review surface, which is exactly true. `applyChanges`
 * and `discardChanges` do **not**, and between the two of them they are the
 * strongest case in this file for the rule: an apply that silently did not
 * happen tells a reviewer their change landed while the file still says
 * otherwise, and a discard that silently did not happen tells them their
 * pending work is gone while it sits waiting for the next apply. Both reject.
 *
 * The terminal-parity verbs split the same way again, which is by now the
 * point rather than a coincidence — the question is never "is this new", it is
 * "what would a shrug claim":
 *
 * - `exportSession` and `mcpStatus` degrade to `undefined`, on the
 *   `listModels` precedent. Both read. A client that gets nothing offers no
 *   export and shows no MCP listing, which is exactly what it knows.
 * - `compact` does **not**, on the `deleteSession` counter-precedent. It is
 *   the one of the three that *changes* the conversation, and a client told
 *   "fine" by a server that did nothing would report freed context that was
 *   never freed, keep filling the window, and hit the wall it had just asked
 *   to have moved. It rejects.
 *
 * A bump, by contrast, is a hard break in
 * both directions — `SessionHeader.version` is stamped with `1` and validated
 * as `1`, and `@arcturn/protocol`'s client rejects any header or handshake
 * that advertises a different number — so raising it would sever every
 * existing client/server pair to announce a feature neither of them needs to
 * negotiate.
 */
export const PROTOCOL_VERSION = 1;
