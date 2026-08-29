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
  | {
      id: string;
      method: "resolveContext";
      params: { sessionId: string; query: string; range?: LineRange };
    }
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
   * **Applies mid-run.** The mode is consulted at each permission
   * evaluation, so a change lands on the session's very next tool call —
   * three prompts into a long run is exactly when "stop asking, accept
   * edits" is worth saying. A prompt already on screen settles under the
   * answer the person gives it; every later call evaluates under the new
   * mode; a stored `deny` rule outranks every mode either side of the
   * change. (Servers before protocol 0.5.3 refused this mid-run with
   * `sessionBusy`; a client should treat that answer as "try again after
   * runEnd", which is also what the refusal used to mean.)
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
   * Begin authorizing an OAuth-protected MCP server, with the client catching
   * the redirect.
   *
   * The engine runs discovery, dynamic client registration and PKCE, and
   * parks on the redirect; the client contributes only the browser round trip
   * it can actually perform. This exists because the engine's own loopback
   * redirect is wrong whenever the browser is elsewhere — an editor attached
   * over SSH, a devcontainer, a Codespace — where `127.0.0.1` on the user's
   * machine is not `127.0.0.1` on the engine's.
   *
   * `redirectUri` is whatever the client can catch, e.g. a `vscode://` URI.
   * The engine registers exactly that with the authorization server, so a
   * client that names a URI it cannot receive on will simply never complete.
   *
   * **Optional and additive.** An older server answers `invalidRequest`, and
   * the client falls back to telling the user to run `arcturn mcp auth`.
   */
  | {
      id: string;
      method: "mcpAuthBegin";
      params: { server: string; redirectUri: string };
    }
  /**
   * Hand back the authorization code the redirect carried.
   *
   * `state` is echoed from the callback and must match the value the engine
   * put in the authorization URL; a mismatch fails the request without
   * reaching the token endpoint, so a code belonging to some other
   * authorization cannot be redeemed against this one. The handle is
   * single-use.
   */
  | {
      id: string;
      method: "mcpAuthComplete";
      params: { handle: string; code: string; state: string };
    }
  /**
   * Abandon an authorization begun by {@link mcpAuthBegin}.
   *
   * Answers `false` for an unknown handle rather than failing: a client
   * cancelling after the engine's own timeout is racing a drop that already
   * happened, and that is not an error.
   */
  | { id: string; method: "mcpAuthCancel"; params: { handle: string } }
  /**
   * Start a scout run: two or more approaches, each explored in its own
   * throwaway git worktree, raced against a deadline.
   *
   * Returns an id immediately rather than the report, because a scout run
   * takes minutes and a request that blocks for minutes cannot be reported on
   * or cancelled. Poll {@link scoutRun} for progress; results appear there as
   * each approach settles rather than all at the end.
   *
   * **Optional and additive.** An engine without it answers `invalidRequest`,
   * and the client falls back to naming `/scout` in the terminal.
   */
  | {
      id: string;
      method: "startScout";
      params: { approaches: { name: string; task: string }[] };
    }
  /**
   * Ask how a scout run is going, and what has settled so far.
   *
   * Each result carries the scout's `git diff` as text. The worktree it was
   * made in is long gone by then — captured before teardown — which is why a
   * client can render a comparison at all.
   */
  | { id: string; method: "scoutRun"; params: { runId: string } }
  /**
   * Stop a scout run.
   *
   * Every live scout is aborted and every worktree is still cleaned up.
   * Results that had already settled are kept: a comparison the user cut short
   * is still worth reading.
   */
  | { id: string; method: "cancelScout"; params: { runId: string } }
  /**
   * List the resources MCP servers publish.
   *
   * A resource is context a server offers rather than an action it performs —
   * a design frame, a schema, an issue. Arcturn used only the tool third of
   * MCP until this verb; a client attaches one by naming it in a
   * `{ kind: "mcpResource" }` attachment, and the engine does the reading.
   *
   * **Optional and additive**, degrading like `listModels`.
   */
  | { id: string; method: "mcpResources"; params?: { server?: string } }
  /**
   * Read one resource, for preview.
   *
   * Deliberately *not* the path an attachment takes: a prompt's copy is read
   * by the engine at prompt time, so there is exactly one reader in the path
   * that spends tokens. This exists so a person can look before they attach,
   * and what it returns is untrusted text from a remote server — a client
   * renders it as text and never as markup.
   */
  | { id: string; method: "mcpReadResource"; params: { server: string; uri: string } }
  /**
   * List the prompt templates MCP servers publish.
   *
   * These also appear in `listCommands` as `kind: "mcpPrompt"`, so a `/` menu
   * shows them beside skills without a client having to merge two lists. This
   * verb exists for the argument metadata, which a command descriptor has no
   * room for.
   */
  | { id: string; method: "mcpPrompts"; params?: { server?: string } }
  /**
   * Render one prompt template into messages.
   *
   * `arguments` are the template's own, by name. What comes back is untrusted
   * text from a remote server: it is prompt material, and a client that shows
   * it before sending should show it as text.
   */
  | {
      id: string;
      method: "mcpGetPrompt";
      params: { server: string; name: string; arguments?: Record<string, string> };
    }
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
  | { id: string; method: "discardChanges"; params: { sessionId: string; paths?: string[] } }
  /**
   * Ask what background agents this engine knows about — the `/bg` listing,
   * and (for one id) the transcript `/bg logs` prints.
   *
   * A background agent is a whole child conversation running off-thread with a
   * durable record on disk. Nothing about it rides a session's event stream:
   * it has its own session, its own tool loop, and it outlives the connection
   * that started it. A remote client with no verb for this could not tell that
   * an engine had four agents running at all.
   *
   * ### Two shapes, one verb
   *
   * - **`id` omitted** — every known agent, newest first, as metadata:
   *   {@link BackgroundAgentSummary} without its `transcript`.
   * - **`id` given** — that one agent's row, plus the rendered transcript.
   *   An id nothing matches answers with an **empty list**, not an error:
   *   this verb degrades, and a client cannot tell a server-sent
   *   `invalidRequest` for a typo from one for an unknown method, so erroring
   *   here would hide the whole surface over a mistyped id.
   *
   * The split is `pendingChanges`'s, made for the same reason: a listing is
   * bounded metadata a client can render immediately, and a transcript is
   * unbounded prose that only one row at a time ever needs. See
   * {@link BackgroundAgentTranscript} for the cap and how truncation is
   * reported.
   *
   * Not session-scoped: background agents belong to the engine, not to a
   * conversation, so this is shaped like `mcpStatus` rather than like
   * `permissionState`.
   *
   * **Optional and additive**, degrading like `listModels`: read-only, so an
   * older engine's `invalidRequest` costs a client the listing and nothing
   * else. See `ProtocolClient.backgroundAgents`.
   */
  | { id: string; method: "backgroundAgents"; params?: { id?: string } }
  /**
   * Start one background agent on `task`.
   *
   * **This is a verb that spends money**, and the whole of its containment is
   * that it carries *nothing but the task*. There is no `tools`, no
   * `permissionMode`, no `cwd`, no `model`: the agent is built from the
   * engine's own defaults, which are the same defaults a `/bg` typed at the
   * terminal gets — permission mode `default` (never `yolo`), the read-only
   * tool set plus `fetch`, `subagent` removed so it cannot fan out, rooted at
   * the served workspace, and queued behind the manager's concurrency cap.
   * A remote caller cannot widen any of them, because the wire has no field to
   * widen them with. That is deliberate: every one of those is a *cap*, and a
   * cap a client can raise is not one.
   *
   * Answers with a {@link StartedBackgroundAgent} — the id to ask about and
   * the child's session id — not with the finished work. The agent may not
   * even have started; poll `backgroundAgents`.
   *
   * **Not degradable.** A client told "fine" by an engine that ignored this
   * would show a running agent that does not exist and wait forever for a
   * result nothing is producing. That is the `deleteSession` counter-
   * precedent: an older engine's `invalidRequest` rejects like any other
   * failure. See `ProtocolClient.startBackgroundAgent`.
   */
  | { id: string; method: "startBackgroundAgent"; params: { task: string } }
  /**
   * Abort one background agent — the terminal's `/bg cancel`.
   *
   * Answers with a {@link CancelBackgroundAgentResult}: whether the engine
   * took the cancellation, and the agent's row as it stands *now*. The two are
   * separate because the transition is asynchronous — aborting a running child
   * cascades through the run loop, so the row a cancel answers with usually
   * still says `running`, and a client that read only the row would report
   * that nothing happened.
   *
   * **Not degradable**, for the reason `discardChanges` is not: a cancel
   * reported as done that was not done leaves a person believing they stopped
   * spending money they are still spending.
   */
  | { id: string; method: "cancelBackgroundAgent"; params: { id: string } }
  /**
   * Pull a finished background agent's result into a live session — the
   * terminal's `/bg adopt`.
   *
   * The engine composes the injection (naming the agent, its task and its
   * outcome) and delivers it to the session: `steer` when a run is in flight,
   * a fresh `prompt` when it is idle. Both halves are why this is a verb
   * rather than something a client assembles from `finalText`: a client cannot
   * see whether the session is mid-turn without racing it, and two clients
   * papering over that race would compose two different sentences for the same
   * event.
   *
   * ### The text is **not** expanded
   *
   * A background agent's final text is written by a model. It goes to the
   * session exactly as it is — no `@`-mention expansion, no leading-`/name`
   * expansion — which is what the terminal's `/bg adopt` does, and it is
   * load-bearing rather than incidental: expanding mentions here would let a
   * child agent that wrote `@.env` in its answer make the parent read the file
   * on the strength of somebody clicking "adopt". `prompt` expands the
   * mentions a *person* typed; this is not that.
   *
   * Refused while the background agent is still running — there is no result
   * to adopt yet — and refused for one that produced no output at all.
   *
   * **Not degradable**: an adopt reported as delivered that was not delivered
   * is a client showing a turn that never started.
   */
  | {
      id: string;
      method: "adoptBackgroundAgent";
      params: { sessionId: string; id: string };
    }
  /**
   * Read the org-memory store: the per-role lessons that get appended to a
   * role's system prompt on later runs.
   *
   * Answers with an {@link OrgMemoryList} — every entry, `proposed` and
   * `active` alike, plus the warnings the store's own bounds produced on read
   * (an over-long file, an entry dropped for failing a cap). A client that saw
   * only the entries could not tell "this store is empty" from "this store was
   * refused for being too large".
   *
   * Not session-scoped: the store is keyed by project and lives under the
   * user's home, so it is a property of the engine — shaped like `mcpStatus`.
   *
   * **Optional and additive**, degrading like `listModels`: read-only, so an
   * older engine's `invalidRequest` costs a client the listing and nothing
   * else.
   */
  | { id: string; method: "orgMemory" }
  /**
   * File a **proposed** org-memory entry. It reaches no prompt.
   *
   * ### The one rule this verb exists to keep
   *
   * An `active` entry is standing instruction text in every later run of its
   * role. Approving one is therefore not a state change, it is an
   * authorisation — and the gate on it is a person, "the same way
   * `/permissions suggest` proposes a rule and never applies one". **There is
   * no verb on this wire that makes an entry active**, and that is the whole
   * design rather than an omission: this verb hard-codes
   * `status: "proposed"`, the engine has no field to override it with, and the
   * only thing that can promote an entry is `/org memory approve` typed by
   * whoever owns the machine.
   *
   * The terminal's `/org memory add` — which files an entry *already active* —
   * has no counterpart here for exactly that reason. `add` is live because a
   * person typed it at their own keyboard; a frame arriving over a socket is
   * not that, and an engine cannot tell one that a person clicked from one an
   * agent sent. RFC 0005 §1.2 already settled the identical question for
   * permission rules: a decision made over the wire may not outlive its
   * session, because a rule that does "is written by a person, in their own
   * config". An org-memory entry outlives the session in precisely that sense.
   *
   * `text` is subject to the store's own bounds — one line, 160 characters,
   * no control markers, no fence delimiters — and an over-long lesson is
   * **refused, not truncated**, because clipping can invert a sentence.
   *
   * Answers with an {@link OrgMemoryProposal}: the entry as filed, and the
   * store as it now stands.
   *
   * **Not degradable.** A proposal reported as filed that was not filed is a
   * client showing a queue of suggestions that do not exist.
   */
  | { id: string; method: "proposeOrgMemory"; params: { role: string; text: string } }
  /**
   * Take an org-memory entry back: demote it to `proposed`, or delete it.
   *
   * The two halves of `/org memory revoke` and `/org memory rm`, and both are
   * on this wire for the same reason the promoting half is not — **direction**.
   * Revoking or deleting an entry can only ever *reduce* the standing
   * instruction text later runs are given, and the gate this feature keeps is
   * about text a model could grant itself, not text it could take away. A
   * client that wrongly revokes costs a person one re-approval; a client that
   * could wrongly approve costs them a standing instruction they never read.
   *
   * - **`remove` omitted or `false`** — `active` becomes `proposed`. The entry
   *   stays in the store and stays visible, so a person can approve it again.
   * - **`remove: true`** — the entry is deleted outright. Irreversible; there
   *   is no wire-level confirmation, on `deleteSession`'s discipline, because
   *   a confirmation belongs where a person can read what they are losing.
   *
   * Answers with the resulting {@link OrgMemoryList} — the engine's answer to
   * "what is in the store now", not an echo of what was asked.
   *
   * **Not degradable**, for the reason `discardChanges` is not: a revoke
   * reported as done that was not done leaves a person believing a lesson has
   * stopped reaching their roles' prompts while it still does.
   */
  | { id: string; method: "revokeOrgMemory"; params: { id: string; remove?: boolean } }
  /**
   * Ask which earlier turns this session could be rewound to, and what each
   * one would cost.
   *
   * Before a `write` or `edit` touches a file for the first time in a turn,
   * the engine snapshots that file's content — or its absence. `/rewind`
   * restores those snapshots and forks the conversation back to the same
   * point. In a terminal that is a picker; over this wire it was nothing at
   * all, and `built-in-commands.ts` named `/rewind` as the example of a
   * command RFC 0005 §1.3 forbids listing because no verb carried it.
   *
   * Answers with a {@link CheckpointList}. Each row carries the turn's label
   * and time, **and what a rewind to it would actually do**: how many files,
   * which ones, and how many of those would be deleted rather than rewritten.
   * That is the whole reason this verb exists rather than a bare id list — a
   * picker offering "rewind to here" without saying what it costs is a picker
   * somebody clicks by accident, and the cost is not something a client can
   * compute: it is the union of the earliest snapshot per path from that turn
   * to the end of the manifest.
   *
   * **Read-only.** Nothing is restored, nothing is deleted, no turn is forked.
   *
   * Session-scoped, because checkpoints are: one store per session, rooted at
   * that session's own working directory.
   *
   * **Optional and additive**, degrading like `listModels`: it only reads, so
   * an older engine's `invalidRequest` costs a client its rewind picker and no
   * guarantee. See `ProtocolClient.listCheckpoints`.
   */
  | { id: string; method: "listCheckpoints"; params: { sessionId: string } }
  /**
   * Restore this session's files to a checkpoint, and fork its conversation
   * back to the same point.
   *
   * **The most destructive verb on this wire.** It writes files and it deletes
   * files, and the terminal's own confirmation says the quiet part out loud —
   * "restores and deletes files; cannot be undone". Everything below exists
   * because a socket held by anyone with the serve token can now reach it.
   *
   * ### The confirmation is echoed, and this is the one verb that has one
   *
   * `deleteSession` and `discardChanges` deliberately carry no wire-level
   * confirmation: the confirmation belongs in a native modal where a person
   * can read what they are losing, and a two-phase token would be state the
   * engine had to keep. Both of those are still true — and this verb takes a
   * confirmation anyway, because it differs from them in exactly the way that
   * matters. What a `deleteSession` destroys is *named by its own parameter*;
   * so is a `discardChanges` selection, spelled as the engine just listed it.
   * What a `rewindTo` destroys is named by **neither** — `checkpointId` is an
   * opaque turn id, and the files it would delete are derived from a manifest
   * that grows with every turn. A client that showed "this deletes 2 files",
   * then let a run append three more before the user clicked, would rewind
   * something it never displayed.
   *
   * So `confirmation` is {@link CheckpointEntry.confirmation}, copied from the
   * row the client rendered. The engine recomputes the plan and compares. A
   * mismatch is `invalidRequest` naming the drift, not a silent proceed. It is
   * **not** a server-kept nonce — there is no state, no expiry and nothing to
   * evict; it is a digest of the plan itself, which is why it can be required
   * without becoming the two-phase handshake `deleteSession` refused.
   *
   * ### Refused mid-run
   *
   * `sessionBusy`, on `deleteSession`'s wider check rather than
   * `setPermissionMode`'s narrower one: a prompt that has been accepted but is
   * still resolving its context has not started the agent yet, and a restore
   * landing in that window would rewrite files the run is about to read and
   * fork a conversation it is about to append to. The TUI already refuses this
   * ("A run is in progress; press Esc to interrupt it before rewinding") and
   * this is the same refusal, phrased for a client that can act on it.
   *
   * ### Confined to the workspace
   *
   * A restore writes and deletes real files, so it is gated by the same
   * `restoreRoot` a local `/rewind` is gated by — the session's own working
   * directory, which `createSession` already confined to the served workspace.
   * A manifest record outside it is **reported and skipped**, never written.
   * There is no second restorer on this path: the engine's own checkpoint
   * store does the work, exactly as `applyChanges` drives the engine's own
   * overlay.
   *
   * Answers with a {@link RewindResult}: what was rewritten, what was deleted,
   * what was refused, and whether the conversation actually forked. "It
   * worked" is not a report for an operation whose whole purpose is to change
   * files a person is looking at.
   *
   * **Not degradable**, on the `deleteSession`/`setPermissionMode`
   * counter-precedent and for the sharpest reason in this file. An
   * `applyChanges` that silently did nothing tells a reviewer their change
   * landed; a `rewindTo` that silently did nothing tells a user their files
   * went back to a state they never returned to — and they will keep working
   * on top of the code they thought they had discarded. An older engine's
   * `invalidRequest` rejects like any other failure. See
   * `ProtocolClient.rewindTo`.
   */
  | {
      id: string;
      method: "rewindTo";
      params: { sessionId: string; checkpointId: string; confirmation: string };
    }
  /**
   * The workflow catalog: every markdown pipeline this engine discovered, and
   * what each one costs before it runs.
   *
   * A workflow is a file the workspace (or the user's home) holds, so this is
   * a property of the *server*, not of a conversation — shaped like
   * `listModels` and `listCommands` rather than like `permissionState`.
   *
   * Answers with a {@link WorkflowCatalog}.
   *
   * ### The lane is derived, never quoted
   *
   * {@link WorkflowRoleSummary.lane} is what
   * `roleDispatch` computes from the role file's declared `tools:` — the same
   * function the dispatcher itself calls — and never what a role's prose
   * claims about itself. A catalog that showed the description's word for it
   * would be telling a person "this reviewer only reads" about a role holding
   * `write`, which is the single most consequential sentence this payload
   * carries. Two of the five lane values exist for the same reason: a role a
   * step names but this engine has not loaded is `"unknown"`, and one loaded
   * without a `tools:` line is `"undeclared"` — both are runs that fail before
   * spending anything, and reporting either as `"read"` would be a guess.
   *
   * **Optional and additive**, degrading like `listModels`: read-only, so an
   * older engine's `invalidRequest` costs a client its workflow menu and
   * nothing else. See `ProtocolClient.listWorkflows`.
   */
  | { id: string; method: "listWorkflows" }
  /**
   * Start a workflow run.
   *
   * **This spends real money and can change the user's files.** A write-lane
   * role's patch is applied to the checkout the moment its step succeeds, and
   * the pipeline pays for every step until it is done. It is the most
   * consequential verb on this wire, and the shape below is what keeps it from
   * being the widest.
   *
   * ### Session-scoped, and why
   *
   * A run is bound to a session for three reasons, not one: its progress rides
   * that session's event stream (see below), its steps are attributed to it,
   * and the plan-mode gate reads the session's own permission mode alongside
   * the engine's. Any of those alone would be a convenience; together they are
   * why a `sessionId` is required rather than optional.
   *
   * ### It answers on acceptance, not on completion
   *
   * `prompt` resolves when the *run* ends, and that is right for one turn. A
   * pipeline is minutes to hours, past every sane request deadline (the
   * client's default is 30 seconds), so a `runWorkflow` that answered at the
   * end would hand a client a timeout for a run that is spending money
   * perfectly happily. It therefore answers with a {@link WorkflowRunHandle}
   * as soon as the run is accepted — the run id, the pipeline's shape, and the
   * ceilings that actually bind it — and the run itself is followed on the
   * session's own event stream.
   *
   * **There is no second event channel.** Every step republishes its child
   * agent onto the session stream as a namespaced sub-agent, and each progress
   * event becomes the same `notice` the terminal prints, from the same
   * function. A client that called `openSession` is already subscribed to all
   * of it. The durable half is `workflowStatus`, which reads the run journal
   * the engine already writes — not a second record kept for the wire.
   *
   * ### `budgetUsd` may only ever lower the ceiling
   *
   * The workflow file's own `budgetUsd:` is the authority. A caller may pass a
   * **smaller** number to cap this one run further; a larger one is
   * `invalidRequest`, naming both figures, rather than silently clamped — the
   * client can read the file's ceiling from `listWorkflows` before it asks, so
   * the refusal is actionable, and a client told "fine" that got a different
   * ceiling would render a number the engine is not enforcing. A non-positive
   * value is refused for the opposite reason: `0` means "disabled" to the cost
   * guard, so accepting it would *widen* an otherwise-bounded run. A file with
   * no ceiling of its own accepts any positive value, because bounding an
   * unbounded run is a narrowing too.
   *
   * Nothing else on this wire can be raised either. The file's
   * `stepTimeoutMs`, each role's `maxTurns`, each role's declared `tools:` and
   * the engine's permission rules all still bind exactly as they do for the
   * person at the terminal, and none of them has a parameter here.
   *
   * **Not degradable**, on the `deleteSession`/`setPermissionMode`
   * counter-precedent and for a sharper reason than either. A client told
   * "started" by an engine that ignored the request believes a review pipeline
   * ran, reads a verdict that was never produced, and merges on it. An older
   * engine's `invalidRequest` rejects like any other failure. See
   * `ProtocolClient.runWorkflow`.
   */
  | {
      id: string;
      method: "runWorkflow";
      params: { sessionId: string; name: string; input?: string; budgetUsd?: number };
    }
  /**
   * What a run reached: which stage, how many turns, what it spent, and why it
   * stopped.
   *
   * Answered from the run journal — the append-only record `/workflow status`
   * already reads — so a run started in a terminal is legible from a panel and
   * vice versa, and a run interrupted by a crash reports the same thing to
   * both. Nothing here is a second bookkeeping record kept for the wire.
   *
   * Not session-scoped: runs live under the served home, so this is shaped
   * like `listModels`. A run started by *any* client, or by the terminal, is
   * visible to all of them, which is the point.
   *
   * ### Two shapes, one verb
   *
   * - **`runId` omitted** — every recent run as a summary row: state, stage
   *   reached, steps done, spend, turns, and any `ORG-ASK:` it is waiting on.
   * - **`runId` given** — that one run, plus its per-step breakdown.
   *
   * The split is `pendingChanges`' split, for `pendingChanges`' reason: a
   * listing is a menu and a menu must stay small, while the step rows are what
   * a person opens one run to read.
   *
   * An id with no journal on this engine answers **zero rows**, not an error.
   * That is not a softening: `isUnsupportedMethodError` reads every
   * `invalidRequest` as "this engine does not know the verb", so a read that
   * refused in-band would be indistinguishable from an older engine and a
   * client would degrade it to `undefined`. Zero rows for a *named* run is
   * unambiguous on its own — only the listing form can legitimately be empty.
   * It is the rule `pendingChanges` already keeps by answering `dryRun: false`
   * instead of erroring.
   *
   * **Optional and additive**, degrading like `listModels`: read-only, so an
   * older engine's `invalidRequest` costs a client its run view and no
   * guarantee. See `ProtocolClient.workflowStatus`.
   */
  | { id: string; method: "workflowStatus"; params: { runId?: string } }
  /**
   * Re-enter an interrupted run where it left off — optionally carrying the
   * answer to an `ORG-ASK:`.
   *
   * **Resume is not a re-run.** Completed steps are replayed from the journal
   * rather than executed again, and a write-lane patch that already landed is
   * probed with `git apply --check --reverse` before anything decides to apply
   * it a second time. That property belongs to the engine and is not
   * re-implemented here; this verb is the door to it.
   *
   * `answer` settles the paused stage. A run stopped at an `ORG-ASK:` needs a
   * person's words, not merely a nudge: resuming one without an `answer` is
   * accepted and simply re-surfaces the question, which is what the terminal
   * does, so a client can offer "remind me" and "here is my answer" as the two
   * things they are.
   *
   * Answers with a {@link WorkflowRunHandle} whose `resumed` is `true`, and is
   * followed on the session event stream exactly as `runWorkflow` is.
   *
   * **Not degradable**, on `runWorkflow`'s terms plus one of its own: an
   * answer to a human gate that silently went nowhere leaves a run paused
   * forever while the person who answered it believes the pipeline is moving.
   * See `ProtocolClient.resumeWorkflow`.
   */
  | {
      id: string;
      method: "resumeWorkflow";
      params: { sessionId: string; runId: string; answer?: string };
    };

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
 *
 * ### Why a `file` may carry a range, and the engine still does the reading
 *
 * A client that knows the user has lines 12–40 selected should be able to say
 * so, rather than sending an 800-line file and hoping the model finds the part
 * that matters. So `file` takes an optional {@link LineRange} — but only the
 * *coordinates* of the selection, never its text. The engine opens the file
 * under the same confinement, applies the same size caps, and slices; one
 * reader, one set of rules, and the read still happens where the permission
 * engine can see it. A range is accepted for `kind: "file"` only: an image has
 * no lines, so a range on one is refused rather than ignored.
 *
 * ### Why naming a file is its own kind, and not a flag on `file`
 *
 * Not every file a client knows about is a file the user asked a question
 * about. An editor panel knows which file is *open* — the VS Code sidebar's
 * ambient chip is exactly that — and that is worth telling a model, because
 * "explain this function" only means something if the model knows which file
 * is on screen. It is emphatically **not** worth 22,000 tokens a turn, which
 * is what `packages/protocol/src/client.ts` (2,161 lines) costs when it is
 * injected whole, on every turn, whether or not the question is about it.
 * The agent has a `read` tool; a path is enough for it to decide.
 *
 * So {@link PromptAttachment} has a third kind, `fileReference`, which names a
 * path and sends none of its bytes. It is spelled as a **distinct kind** rather
 * than as `{ kind: "file", mode: "reference" }` for three reasons, in
 * increasing order of importance:
 *
 * 1. **It is a different object, not a `file` with a switch.** A reference has
 *    no bytes, so it cannot be truncated, cannot be an image, and cannot carry
 *    a `LineRange` — a selection *is* the request for an excerpt, and
 *    "reference the file, but only lines 12–40 of it" means nothing. A `mode`
 *    field would make that contradiction representable and leave the validator
 *    to talk clients out of it; a distinct kind makes it unspellable.
 * 2. **The two are billed differently**, and a reader should be able to see
 *    which one is in front of it without reading a second field.
 * 3. **The absent-field default points the wrong way.** This is the one that
 *    decides it. An engine that predates a `mode` field validates the
 *    attachment, drops the field it does not know, and injects the **whole
 *    file** — silently, every turn, at the user's expense: the precise bug
 *    this kind exists to remove, reintroduced by the fallback. An engine that
 *    predates a *kind* cannot make that mistake: its validator already refuses
 *    anything outside `"file" | "image"`, so the frame is rejected before a
 *    turn is spent and the client is told why. The safe outcome is a property
 *    of the spelling rather than of a client remembering to probe — see
 *    {@link ContextResolution.attachmentKinds} for the probe that turns that
 *    refusal into a good message rather than a wire-enum complaint.
 *
 * The engine still owns the path. A reference is confined by
 * {@link ContextResolution}'s own gate exactly as an attachment is, and refused
 * fatally when it escapes the workspace or names something that is not a file
 * — a client never reads a file to build one (RFC 0005 §3), and a client that
 * could name an unconfined path in the prompt would have moved the disclosure
 * it could not move the read.
 */
export type PromptAttachment =
  /**
   * A workspace file, read by the engine and injected as a context block.
   *
   * `range` narrows it to a *selection*: see {@link LineRange} for the
   * convention, and {@link PromptAttachment} above for why the engine — never
   * the client — is the one that slices.
   */
  | { kind: "file"; path: string; range?: LineRange }
  /**
   * A workspace file **named, not read**: the model is told the path exists and
   * is in play, and nothing else. No bytes are read and none are injected.
   *
   * For context a client knows about but the user did not ask for — the file
   * open in the editor being the case this was built for. The model decides
   * whether it matters and reaches for its `read` tool if it does, which is a
   * turn's worth of tokens spent on purpose instead of every turn's worth
   * spent on spec.
   *
   * Deliberately carries no `range`: a client that knows which lines are
   * selected knows what the user meant, and should send
   * `{ kind: "file", path, range }` — the excerpt is small, precise, and
   * unambiguously the thing they pointed at. See {@link PromptAttachment}
   * above for why this is a kind rather than a flag.
   */
  | { kind: "fileReference"; path: string }
  /** A workspace image, read by the engine and sent as a vision block. */
  | { kind: "image"; path: string }
  /** An image with no path — a paste, a drop from outside the filesystem. */
  | { kind: "image"; data: string; mimeType: string }
  /**
   * A resource published by an MCP server, **read by the engine** at prompt
   * time and injected as a context block.
   *
   * The client names it and never fetches it, for the reason the whole union
   * is built that way: a client that read the bytes would have moved the read
   * outside the one place the engine confines, budgets and accounts for it.
   * Here that matters more than usual, because the bytes come from a remote
   * server rather than from the user's disk — so they are charged against the
   * same context budget a file is, and truncated the same way.
   *
   * The server must be connected. An unknown or disconnected one is refused
   * fatally rather than dropped, exactly as an unconfined path is: the user
   * asked for this content, and a turn that quietly proceeds without it is the
   * silent drop RFC 0005 §1.1 forbids.
   */
  | { kind: "mcpResource"; server: string; uri: string };

/**
 * The `kind` discriminant of a {@link PromptAttachment}, as a value.
 *
 * Exists so {@link ContextResolution.attachmentKinds} can state which of them
 * an engine actually honours, in the engine's own vocabulary rather than in a
 * parallel set of booleans that would have to be kept in step with this union.
 */
export type PromptAttachmentKind = PromptAttachment["kind"];

/**
 * A span of lines inside a text file — one editor selection, on the wire.
 *
 * ## The convention, stated once
 *
 * **Lines are 1-based, and both ends are inclusive.** `{ start: 12, end: 40 }`
 * means exactly what a person means by "lines 12 to 40": line 12 is the first
 * line of the excerpt, line 40 is the last, and the excerpt is
 * `end - start + 1` = 29 lines long. One line is `{ start: 7, end: 7 }` —
 * never `{ start: 7, end: 8 }`, and there is no such thing as an empty range.
 *
 * This is deliberately the convention `@file:12-34` speaks, and the one every
 * editor's gutter shows, rather than any internal representation: the number a
 * user can see next to their selection is the number that should appear here.
 * A client built on a **0-based** editor API — VS Code's `Selection.start.line`
 * is 0-based, as are Monaco's document offsets and most tree-sitter ranges —
 * must add one to each end before sending. An off-by-one in this conversion is
 * invisible in the result (the model simply reads a slightly shifted window
 * and answers confidently), which is why the convention is written here rather
 * than left to be inferred.
 *
 * ## What the engine does with an imperfect one
 *
 * Only ranges that cannot *mean* anything are rejected on the wire: `start`
 * below 1, `end` before `start`, or a bound that is not a whole number. Those
 * are client bugs, and clamping one would mean inventing an intent nobody
 * expressed.
 *
 * A range that merely does not fit the file is not a client bug — a
 * select-to-end, or a file edited since the selection was taken, produces one
 * routinely — so:
 *
 * - An `end` past the last line is **clamped, and the clamp is reported** in
 *   the injected block, along with the range that was asked for.
 * - A `start` past the last line is **refused**, because there is no excerpt to
 *   clamp to and quietly substituting the file's tail would hand the model a
 *   different selection than the one that was named.
 *
 * There is no upper bound on `end` beyond "a whole number": the engine never
 * reads more than the file, so `{ start: 1, end: 10_000_000 }` costs exactly
 * what attaching that file costs and not a byte more.
 */
export interface LineRange {
  /** First line of the excerpt. 1-based, and included. Must be at least `1`. */
  start: number;
  /** Last line of the excerpt. 1-based, and included. Must be at least `start`. */
  end: number;
}

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
  /**
   * The {@link LineRange} the query asked about, echoed back normalized.
   *
   * Present **only** when the request carried a `range`, and absent otherwise —
   * which makes it the one thing a client can use to tell an engine that
   * understands ranges from one that silently drops them. That distinction
   * matters because `range` is a new field on an existing parameter: an older
   * engine validates a ranged `file` attachment, copies out the fields it
   * knows, drops this one, and sends the model the *whole file* while answering
   * `ok`. `ProtocolClient.prompt` reads this echo before sending any ranged
   * attachment and refuses locally when it is missing.
   *
   * It is an echo and nothing more. It says the engine understood the
   * parameter; it does **not** say the range fits the file, because
   * `resolveContext` stats and never reads, and how many lines a file has
   * cannot be known without reading it. Whether the range fits is answered at
   * prompt time, in the injected block (clamped and reported) or in a refusal.
   */
  range?: LineRange;
  /**
   * Which {@link PromptAttachment} kinds this engine can actually honour.
   *
   * A statement about the *engine*, not about the path in the query, and the
   * only field here that is: it rides on `resolveContext` because that verb is
   * already the one a client calls before it attaches anything, and a
   * capability handshake of its own would be a second round trip to learn one
   * fact.
   *
   * **Absent means "this engine predates the field"**, which a client must read
   * as `["file", "image"]` — the two kinds that shipped with `attachments` —
   * and never as "no kinds at all". That is what makes it usable as a probe:
   * `ProtocolClient.prompt` refuses a `fileReference` locally when
   * `"fileReference"` is not listed, rather than letting the engine reject the
   * frame with a complaint about a wire enum.
   *
   * It says what the engine will *accept*, not what it will permit for a given
   * path: a listed kind is still confined, still budgeted, and still refusable
   * at prompt time. And a client must not read it as licence to silently swap
   * one kind for another — a `fileReference` an engine cannot take is a prompt
   * that gets refused, not one that quietly ships the whole file instead.
   */
  attachmentKinds?: readonly PromptAttachmentKind[];
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
  kind: "skill" | "builtin" | "mcpPrompt";
  /**
   * The MCP server a `mcpPrompt` came from. Absent for every other kind.
   *
   * Needed because prompt names are only unique per server: two servers may
   * both publish `review`, and `mcpGetPrompt` has to be told which one.
   */
  server?: string;
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

/**
 * The `mcpAuthBegin` result.
 *
 * Exactly one of two shapes: `authorized` with nothing else, meaning stored
 * credentials were refreshed and no browser is needed; or a handle and a URL
 * for the client to open.
 */
export interface McpAuthBegun {
  /** True when the server is already authorized and there is nothing to complete. */
  authorized: boolean;
  /** Opaque single-use handle for `mcpAuthComplete`. Absent when `authorized`. */
  handle?: string;
  /** The URL the client must open in a browser. Absent when `authorized`. */
  authorizationUrl?: string;
}

/** One resource an MCP server publishes. */
export interface McpResourceEntry {
  /** The configured server name it came from. */
  server: string;
  uri: string;
  /** The server's own display name, sanitized. Absent when it set none. */
  name?: string;
  /**
   * One line about the resource, **sanitized** exactly as a skill's
   * description is — first line only, control characters collapsed,
   * length-capped. This is text a remote server wrote that lands in a menu a
   * person reads and clicks, which is the same problem a skill's frontmatter
   * poses and gets the same answer.
   */
  description?: string;
  mimeType?: string;
}

/** A URI template a server offers, for resources it generates on demand. */
export interface McpResourceTemplateEntry {
  server: string;
  uriTemplate: string;
  name?: string;
  /** Sanitized, for the reason {@link McpResourceEntry.description} is. */
  description?: string;
  mimeType?: string;
}

/** The `mcpResources` result. */
export interface McpResourceList {
  resources: McpResourceEntry[];
  templates: McpResourceTemplateEntry[];
}

/** One block of a resource's content. */
export interface McpResourceBlock {
  uri: string;
  mimeType?: string;
  /** Text content. Untrusted: a remote server wrote it. */
  text?: string;
  /** Base64 content, for a resource that is not text. */
  blob?: string;
}

/** The `mcpReadResource` result. */
export interface McpResourceContents {
  contents: McpResourceBlock[];
}

/** One argument a prompt template takes. */
export interface McpPromptArgument {
  name: string;
  /** Sanitized, for the reason {@link McpResourceEntry.description} is. */
  description?: string;
  required?: boolean;
}

/** One prompt template an MCP server publishes. */
export interface McpPromptEntry {
  server: string;
  name: string;
  /** Sanitized, for the reason {@link McpResourceEntry.description} is. */
  description?: string;
  arguments?: McpPromptArgument[];
}

/** The `mcpPrompts` result. */
export interface McpPromptList {
  prompts: McpPromptEntry[];
}

/** The `mcpGetPrompt` result: the rendered template, flattened to role/text. */
export interface McpPromptRendering {
  messages: { role: string; text: string }[];
}

/** One approach's outcome inside a {@link ScoutRun}. */
export interface ScoutRunResult {
  /** The approach's name, as the client named it. */
  name: string;
  /** The task it was given. */
  task: string;
  /** `finished`, `timeout` or `error`. */
  status: string;
  /** Last assistant text — findings when finished, partial notes otherwise. */
  finalText: string;
  /** Tool names in call order. Names only, the rule `PermissionState.tools` keeps. */
  toolCalls: string[];
  /** Cumulative USD cost, absent when the model was unpriced. */
  costUsd?: number;
  /**
   * The scout's work product, as `git diff` text.
   *
   * Absent when the scout changed nothing, or when the diff could not be
   * captured — `warnings` on the run says which.
   */
  diff?: string;
  /** Failure text when `status` is `error`, or the abort reason on a timeout. */
  error?: string;
  /** Wall time from worktree creation to teardown, in milliseconds. */
  durationMs: number;
}

/** The `scoutRun` result: one run, as the engine currently holds it. */
export interface ScoutRun {
  id: string;
  /** `running`, `finished`, `cancelled` or `failed`. */
  state: string;
  /** What was asked for, in the order it was given. */
  approaches: { name: string; task: string }[];
  /** What has settled so far. Grows while `state` is `running`. */
  results: ScoutRunResult[];
  /** True when the deadline fired or a cancel cut the run short. */
  timedOut: boolean;
  /** Non-fatal problems — failed cleanups, unreadable diffs. */
  warnings: string[];
  /** Why the run failed, when `state` is `failed`. */
  error?: string;
}

/** The `startScout` result. */
export interface ScoutStarted {
  /** Poll `scoutRun` with this. */
  runId: string;
}

/** The `cancelScout` result. */
export interface ScoutCancelled {
  /** `false` when the run was unknown or had already settled. */
  cancelled: boolean;
}

/** The `mcpAuthCancel` result. */
export interface McpAuthCancelled {
  /** `false` when the handle was already gone, which is not an error. */
  cancelled: boolean;
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

/**
 * Lifecycle of one background agent.
 *
 * `interrupted` is not `failed`: it means the record was still `running` when
 * a manager loaded it from disk, which happens when the process that owned it
 * exited without finishing. There is no error from the agent itself — just an
 * unfinished run. It is also the state a client is most likely to see and
 * misread, which is why it is named on the wire rather than folded into
 * `failed`.
 *
 * There is deliberately no `queued`: a queued agent reports `running`, and
 * whether it has actually begun is {@link BackgroundAgentSummary.startedAt}
 * being present. That is the engine's own model, restated rather than
 * improved on — a wire that split the states would disagree with `/bg`.
 */
export type BackgroundAgentState = "running" | "done" | "failed" | "cancelled" | "interrupted";

/**
 * The transcript of one background agent, rendered.
 *
 * **Lines, not messages.** The engine renders with the same function `/bg
 * logs` prints through, so a transcript reads identically in a panel and in a
 * terminal; a wire that carried the raw `Message[]` would be handing every
 * client the job of writing a second renderer that could drift from the first.
 * It also keeps tool *arguments* — which is where a model's own untrusted text
 * ends up — already flattened and length-capped rather than arriving as
 * structure a client might render as its own UI.
 *
 * Bounded. See {@link BackgroundAgentTranscript.truncated}.
 */
export interface BackgroundAgentTranscript {
  /** The rendered lines, oldest first. */
  lines: string[];
  /**
   * Whether the **oldest** lines were dropped to fit the response budget.
   *
   * Reported rather than left to be inferred, for the reason
   * {@link SessionHistory.truncated} gives: a transcript that starts
   * mid-conversation and says nothing about it reads as the whole
   * conversation. Truncation drops from the front because the interesting end
   * of an unattended run is the end.
   */
  truncated: boolean;
  /** How many lines were dropped from the front. `0` when not truncated. */
  droppedLines: number;
}

/**
 * One background agent, as the wire reports it.
 *
 * A row is metadata by default. {@link BackgroundAgentSummary.transcript} is
 * present only on a single-id `backgroundAgents` fetch — see that verb's doc
 * for why the listing carries no transcripts.
 *
 * ### What is here and what is not
 *
 * Token counts are not. The engine tracks them per agent, but the one figure a
 * `/bg` listing is read for is spend, and a second usage payload on this wire
 * would be a second place for numbers a client is already being given in
 * dollars to disagree with themselves. `costUsd` is what the terminal's
 * listing shows, and it is what this carries.
 */
export interface BackgroundAgentSummary {
  /** Short id, e.g. `bg-a1b2c3d4`. This is what every other `/bg` verb names. */
  id: string;
  /**
   * The child conversation's own session id.
   *
   * Carried because a background agent's session is an ordinary session in an
   * ordinary store, and naming it is what lets a client say *which* one. It is
   * **not** a session this connection can `openSession` on: the child lives in
   * the manager's own store, not the served one, so a client that tried would
   * get `sessionNotFound`. Ask this verb for the transcript instead.
   */
  sessionId: string;
  /**
   * The task the agent was given, capped for the wire. See
   * {@link BackgroundAgentSummary.finalText} for why these three strings are
   * previews rather than the whole thing.
   */
  task: string;
  /** Catalog id of the model it ran with. */
  modelId: string;
  /** Where it stands. */
  status: BackgroundAgentState;
  /** When it was started, as epoch milliseconds. */
  createdAt: number;
  /**
   * When it actually began its first turn. Absent while it is still queued
   * behind the engine's concurrency cap — which is the only way to tell a
   * queued agent from a running one, since both report `running`.
   */
  startedAt?: number;
  /** When it reached a terminal status. Absent while it is still going. */
  endedAt?: number;
  /** Wall-clock time since it began (or since it was queued), in milliseconds. */
  elapsedMs: number;
  /**
   * Best-effort spend, in USD.
   *
   * `0` for an agent that has not billed a priced turn yet — which includes an
   * agent running on a model the catalog publishes no pricing for. The engine
   * cannot distinguish those two on this field alone, and neither can the
   * terminal's own listing; a client that needs certainty about an unpriced
   * model reads the catalog.
   */
  costUsd: number;
  /**
   * The last assistant message's text — **a preview, not the whole answer**.
   *
   * Capped, along with `task` and `error`, and the cap is part of the contract
   * rather than an accident: this field is model output, so it is unbounded at
   * the source, and a listing of a hundred agents that carried every one in
   * full would be the megabytes-long frame that wedges a socket exactly when
   * somebody is trying to find out what their agents did.
   *
   * A client that wants the whole thing does not read it from here. The rendered
   * transcript carries the conversation, and `adoptBackgroundAgent` delivers the
   * complete final text into a session without it ever crossing this field.
   */
  finalText?: string;
  /** Why it failed, or why it was interrupted, capped like `finalText`. Absent otherwise. */
  error?: string;
  /** Present only on a single-id fetch. See {@link BackgroundAgentTranscript}. */
  transcript?: BackgroundAgentTranscript;
}

/** The `backgroundAgents` result. */
export interface BackgroundAgentList {
  /**
   * The agents the engine knows about, newest first. Empty when there are none
   * — a different and honest answer from the `invalidRequest` an engine with no
   * such verb sends, and also the answer for an `id` that names nothing.
   */
  agents: BackgroundAgentSummary[];
  /**
   * Whether the **oldest** rows were dropped to keep the listing bounded.
   *
   * A manager remembers every agent it ever started, and a machine that has run
   * one a day for a year has a listing nobody asked to be unbounded. Reported
   * rather than left to be inferred, for the reason
   * {@link SessionHistory.truncated} gives: a list that silently stops reads as
   * the whole list, and a person looking for an agent they started last month
   * would conclude it never existed.
   *
   * Always `false` for a single-id fetch, which is one row by construction.
   */
  truncated: boolean;
  /** How many rows were dropped from the oldest end. `0` when not truncated. */
  droppedAgents: number;
}

/** The `startBackgroundAgent` result: what to ask about next. */
export interface StartedBackgroundAgent {
  /** The id every other `/bg` verb names. */
  id: string;
  /** The child conversation's session id. See {@link BackgroundAgentSummary.sessionId}. */
  sessionId: string;
}

/** The `cancelBackgroundAgent` result. */
export interface CancelBackgroundAgentResult {
  /**
   * Whether the engine took the cancellation.
   *
   * `false` means there was nothing to cancel — the agent had already settled,
   * or belonged to a process that is gone. It is **not** a failure, and it is
   * distinct from the agent's `status` below precisely because a cancel that
   * was accepted usually leaves the row still saying `running`: aborting a
   * child cascades through its run loop and the transition lands afterwards.
   */
  accepted: boolean;
  /** The agent's row as it stands now, without a transcript. */
  agent: BackgroundAgentSummary;
}

/** The `adoptBackgroundAgent` result. */
export interface AdoptBackgroundAgentResult {
  /** The background agent whose result was delivered. */
  agentId: string;
  /**
   * How it reached the session: `"steer"` into a run already in flight, or
   * `"prompt"` as a fresh turn.
   *
   * Reported because the two are observably different — a steer lands after
   * the current tool call and a prompt starts a turn — and a client that
   * rendered them the same would show a message appearing at a moment it
   * cannot explain.
   */
  delivered: "prompt" | "steer";
}

/**
 * Whether an org-memory entry is inert or in force.
 *
 * Only `active` entries are ever rendered into a role's prompt. `proposed` is
 * the state everything a model suggests lands in, and the only thing that
 * moves an entry out of it is a person at the machine — see
 * `proposeOrgMemory` for why that gate has no verb on this wire.
 */
export type OrgMemoryStatus = "proposed" | "active";

/**
 * One per-role lesson in the org-memory store.
 *
 * The store's own bounds have already been applied by the time an entry
 * reaches here: one line, at most 160 characters, control and bidi characters
 * stripped, no `ORG-ASK:`/`ORG-HALT:`/`ARCTURN-PATCH:` marker and no fence
 * delimiter. Those bounds are re-applied on *read*, not only on write, so an
 * entry that fails them is dropped with a warning rather than repaired — which
 * is why {@link OrgMemoryList.warnings} exists.
 */
export interface OrgMemoryEntry {
  /** Short id, e.g. `m4c1e9`. What `revokeOrgMemory` names. */
  id: string;
  /** The role this lesson is appended to, normalized (lowercase, `[a-z0-9-]`). */
  role: string;
  /** The lesson. One line, already sanitized and length-capped. */
  text: string;
  /** Inert, or in force. */
  status: OrgMemoryStatus;
  /** When it was filed, as epoch milliseconds. */
  createdAt: number;
  /**
   * Where it came from — `operator` for one a person filed, `remote` for one
   * proposed over this wire. A short, character-restricted tag, never prose.
   *
   * Carried because provenance is what a person approving an entry most needs
   * and cannot otherwise see: an entry that arrived over a socket and one
   * typed at the keyboard read identically once they are both text in a list.
   */
  origin?: string;
}

/** The `orgMemory` (and `revokeOrgMemory`) result. */
export interface OrgMemoryList {
  /**
   * Every entry, `proposed` and `active` alike, sorted by role and then by id
   * so two reads of an unchanged store compare equal.
   */
  entries: OrgMemoryEntry[];
  /**
   * What the store's bounds rejected on this read: an over-large file, an
   * entry dropped for failing a cap.
   *
   * Engine-authored sentences, never an entry's own text — the same rule
   * {@link McpServerSummary} keeps by leaving a server's error prose behind.
   * Present because a client that saw only `entries` could not tell an empty
   * store from a refused one.
   */
  warnings: string[];
}

/** The `proposeOrgMemory` result. */
export interface OrgMemoryProposal {
  /**
   * The entry as filed. Its `status` is always `"proposed"` — there is no
   * request field that could make it anything else.
   */
  entry: OrgMemoryEntry;
  /** The store as it now stands. */
  store: OrgMemoryList;
}

/**
 * One turn a client could rewind to, and what rewinding to it would cost.
 *
 * The cost fields are the reason this type is not three fields. A picker row
 * reading "14:32 — add rate limiting" tells a person when, not what: rewinding
 * to that turn might rewrite one file or delete nine, and those are different
 * decisions. So every row carries the plan the engine computed for it, and the
 * client renders the price next to the offer.
 */
export interface CheckpointEntry {
  /** Opaque turn id — what {@link ClientRequest} `rewindTo` is sent. */
  id: string;
  /**
   * The turn's label: the first ~60 characters of the prompt that began it.
   *
   * Model- and user-influenced text heading for a menu a person clicks, so it
   * is sanitized exactly as a skill description is — first line only, control
   * characters dropped, length-capped — on the way out of the engine.
   */
  label: string;
  /** When the turn began, ms since the epoch. */
  timestamp: number;
  /**
   * How many files a rewind to this point would touch — `files.length` plus
   * whatever the cap dropped.
   *
   * Reported separately from `files` so a truncated list still yields an
   * honest number. This is **not** "files changed during this turn": it is the
   * size of the plan, which spans this turn and every turn after it.
   */
  fileCount: number;
  /**
   * How many of those would be **deleted** — files that did not exist at this
   * point and would be removed.
   *
   * Split out because the two halves are not equally alarming. "12 files
   * rewritten" is a revert; "12 files deleted" is an afternoon gone, and a
   * modal that folded them into one number would let a person approve the
   * second while reading the first.
   */
  deleteCount: number;
  /**
   * The paths, workspace-relative and `/`-separated, sorted — the spelling
   * {@link PendingChange.path} uses, for the same reason: it is what a person
   * reads and what a panel renders next to a file icon.
   *
   * Bounded. A path the engine would **refuse** to touch (a manifest record
   * outside the workspace) is not listed here at all and is not counted: this
   * is what would happen, not what was recorded.
   */
  files: string[];
  /** Whether `files` was cut to fit the cap. `fileCount` is still exact. */
  truncatedFiles: boolean;
  /**
   * Whether the engine can also **fork the conversation** to this point, or
   * only restore the files.
   *
   * `false` for a turn whose conversation link predates this process — a
   * session resumed from disk has snapshots but no in-memory record of which
   * transcript entry each turn began at. The terminal says so rather than
   * guessing a fork point, and so does this: a client that rendered every row
   * identically would promise a transcript fork it is not going to get.
   */
  forksConversation: boolean;
  /**
   * The token `rewindTo` must echo back.
   *
   * A digest of the plan above — not a server-kept nonce. It ties a rewind to
   * the *cost that was displayed*: a client cannot rewind to a state it never
   * showed the user, because a plan that has since changed produces a
   * different digest and the engine refuses. Opaque; compare it, do not parse
   * it, and do not construct one.
   */
  confirmation: string;
}

/**
 * The `listCheckpoints` result: the turns this session could be rewound to.
 *
 * Newest first, which is the order a picker wants and the order the terminal's
 * own `/rewind` shows.
 */
export interface CheckpointList {
  /** The session this was asked about. */
  sessionId: string;
  /** The rewindable turns, newest first. */
  checkpoints: CheckpointEntry[];
  /**
   * Whether this engine can rewind at all.
   *
   * `false` means no checkpoint store is wired to this host — the same shape
   * {@link PendingChanges.dryRun} has, and kept apart from an empty list for
   * the same reason. "Nothing has been checkpointed yet" and "nothing will
   * ever be checkpointed here" are opposite pieces of news, and a panel must
   * not show the reassuring one for the other.
   */
  available: boolean;
  /**
   * Whether rows were dropped to fit the caps.
   *
   * Reported explicitly for the reason {@link SessionHistory.truncated} is: a
   * list that silently stops short reads as the whole list, and here that
   * would mean a person believing an earlier turn is unreachable when it is
   * simply not shown.
   */
  truncated: boolean;
  /** How many rows were dropped from the **oldest** end. `0` when not truncated. */
  droppedCheckpoints: number;
}

/** One file a rewind could not touch, and why. */
export interface RewindFailure {
  /** The path, as {@link CheckpointEntry.files} would have spelled it. */
  path: string;
  /** The engine's reason, in one sentence. */
  message: string;
}

/**
 * The `rewindTo` result.
 *
 * Every field is a count of something that happened on a disk, which is the
 * point: a status would be indistinguishable from the failure this verb most
 * needs to rule out. A per-file failure does not fail the request — the rest
 * still land and the ones that did not are named — which is what the
 * terminal's `/rewind` does, from the same restorer.
 */
export interface RewindResult {
  /** The session this was asked of. */
  sessionId: string;
  /** The checkpoint restored to. */
  checkpointId: string;
  /** Paths whose earlier content was written back. */
  restored: string[];
  /** Paths removed because they did not exist at that point. */
  deleted: string[];
  /** Paths that could not be touched, with a reason each. */
  failed: RewindFailure[];
  /**
   * Whether the conversation was forked back as well.
   *
   * `false` when only the files moved — see
   * {@link CheckpointEntry.forksConversation}. A client that sees `false`
   * should say so: the transcript on screen still describes work that is no
   * longer on disk.
   */
  conversationForked: boolean;
}

/**
 * Which of the three dispatch lanes a workflow role's step runs on, as the
 * engine **derives** it from that role's declared `tools:`.
 *
 * The three real lanes are the ones `roleDispatch` answers with:
 *
 * - `"read"` — no write and no shell. Runs as an ordinary child agent, cannot
 *   execute and cannot touch a file.
 * - `"exec"` — declares `bash` and no write tool. Runs in a throwaway seeded
 *   worktree; its diff is never captured and never applied.
 * - `"write"` — declares `write`, `edit` or `multiedit`. Runs in a seeded
 *   worktree whose diff is captured to a patch and applied to the user's
 *   checkout when the step succeeds.
 *
 * The other two are not lanes at all; they are the two honest ways a lane can
 * be *unknowable*, and they exist so a catalog never has to guess:
 *
 * - `"unknown"` — the step names a role this engine has not loaded. The run
 *   fails pre-flight, before a token is spent.
 * - `"undeclared"` — the role loaded but declares no `tools:` at all, which
 *   dispatch refuses outright rather than reading as "the read lane".
 *
 * Reporting either of those as `"read"` would be the one wrong answer: it
 * would tell a person a pipeline is harmless when what is actually true is
 * that nobody can say.
 */
export type WorkflowRoleLane = "read" | "exec" | "write" | "unknown" | "undeclared";

/** One `@role` a workflow dispatches to, with the lane the engine derived. */
export interface WorkflowRoleSummary {
  /** Role name as written after `@`, lowercased. */
  name: string;
  /** The derived lane. Never read off the role's own prose — see {@link WorkflowRoleLane}. */
  lane: WorkflowRoleLane;
}

/** One discovered workflow, as a catalog row. */
export interface WorkflowSummary {
  /** Name a `runWorkflow` names, normalized to `[a-z0-9-]`. */
  name: string;
  /**
   * One line of help, `""` when the file set none.
   *
   * Sanitized exactly as a {@link CommandDescriptor.description} is — first
   * line only, control characters collapsed, length-capped. A workflow under
   * `<cwd>/.arcturn/workflows` is content a cloned repository controls, and
   * this string lands in a menu a person reads and clicks.
   */
  description: string;
  /**
   * Absolute path of the markdown file it was loaded from, so a menu can show
   * provenance and a person can tell a project's pipeline from their own.
   */
  source: string;
  /** How many stages the file defines. */
  stages: number;
  /** How many steps across every stage (a parallel stage contributes each branch). */
  steps: number;
  /**
   * The run-scope USD ceiling from the file's own `budgetUsd:`, when it set
   * one. Absent means the file bounds nothing, which is a fact a client should
   * say rather than round to zero.
   *
   * This is also the ceiling `runWorkflow`'s own `budgetUsd` may lower and may
   * not raise, which is why a catalog that omitted it would leave a client
   * guessing at a refusal it could have avoided.
   */
  budgetUsd?: number;
  /** Per-step wall-clock ceiling from `stepTimeoutMs:`, when the file set one. */
  stepTimeoutMs?: number;
  /**
   * Every `@role` the pipeline dispatches to, in first-appearance order,
   * deduplicated — with the lane derived for each.
   */
  roles: WorkflowRoleSummary[];
}

/** The `listWorkflows` result. */
export interface WorkflowCatalog {
  /** Every discovered workflow, sorted by name so every client's menu agrees. */
  workflows: WorkflowSummary[];
}

/**
 * What `runWorkflow` and `resumeWorkflow` answer with: the run was accepted,
 * and here is what binds it.
 *
 * Deliberately not an outcome. See `ClientRequest`'s `runWorkflow` for why the
 * verb answers on acceptance; the outcome arrives on the session event stream
 * and is read back durably with `workflowStatus`.
 */
export interface WorkflowRunHandle {
  /** The run's id — what `workflowStatus` and `resumeWorkflow` name. */
  runId: string;
  /** The workflow that is running. */
  workflow: string;
  /** The session whose event stream carries this run. */
  sessionId: string;
  /** Stages in the pipeline. */
  stages: number;
  /** Steps across every stage. */
  steps: number;
  /**
   * The USD ceiling **actually in force** for this run — the file's own, or
   * the smaller number the caller asked for.
   *
   * Echoed rather than left to be inferred: a client that lowered the ceiling
   * and a client that did not must be able to render the same field and be
   * right both times.
   */
  budgetUsd?: number;
  /** The per-step wall-clock ceiling in force. */
  stepTimeoutMs?: number;
  /** `true` when this re-entered an existing run's journal rather than starting one. */
  resumed: boolean;
}

/**
 * The state a run is rendered in — the one-glance "is it hung?" answer, as the
 * journal fold computes it.
 *
 * `"stalled"` and `"resumable"` are the two that make this more than a status
 * enum: a run whose newest journal line is older than its own step deadline is
 * stalled (the process that was writing it is gone), and one that stopped
 * without a terminal line is resumable. Collapsing either into `"running"`
 * would tell a person to keep waiting for a run nothing is running.
 */
export type WorkflowRunState =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "paused"
  | "stalled"
  | "resumable"
  | "unknown";

/** One unanswered `ORG-ASK:`, and the step that raised it. */
export interface WorkflowRunQuestion {
  /** The step that asked — what a resume addresses. */
  stepId: string;
  /**
   * The question text after the marker.
   *
   * Model-written prose heading for a UI, so it is sanitized on the way out of
   * the engine exactly as a skill description is.
   */
  question: string;
}

/** One step of a run, as the journal recorded it. */
export interface WorkflowRunStepStatus {
  /** Positional id: `"2"` for a lone step, `"2.1"` for its first branch. */
  id: string;
  /** 1-based stage. */
  stage: number;
  /** 0-based branch within a parallel stage. */
  branch?: number;
  /** The `@role` it dispatched to, when it named one. */
  agent?: string;
  /** The `[tag]` it carried, when it carried one. */
  modelTag?: string;
  /** Terminal status, or `"running"` while its `stepEnd` line is still missing. */
  status: "running" | "done" | "failed" | "skipped" | "cancelled" | "paused";
  /** Tokens the step reported. */
  tokens?: number;
  /** Attempts, when the self-healing retry needed more than one. */
  attempts?: number;
  /**
   * What happened to this step's diff: `applied`, `refused`, `empty`,
   * `discarded` or `captured`. Absent for a step that ran on the read lane.
   */
  patch?: string;
  startedAt?: number;
  endedAt?: number;
}

/** One run, as `workflowStatus` reports it. */
export interface WorkflowRunStatus {
  runId: string;
  /** The workflow that ran; `""` when the journal never recorded a header. */
  workflow: string;
  state: WorkflowRunState;
  /** The stage it reached. */
  stage?: number;
  stageCount: number;
  stepsDone: number;
  stepsTotal: number;
  /** Cumulative spend, as the run's own budget line recorded it. */
  spentUsd?: number;
  /** Model turns burned. */
  turns?: number;
  /** Why it halted, when it halted for a named condition. */
  stopReason?: string;
  startedAt?: number;
  /** Wall clock of the newest journal line — the staleness signal behind `"stalled"`. */
  updatedAt?: number;
  /**
   * Every `ORG-ASK:` the run is waiting on, in journal order. Empty unless it
   * is paused.
   *
   * A list rather than one question because a *stage* pauses: a parallel stage
   * whose branches each ask owes an answer for each of them, and a client
   * shown one of three would resume into an immediate second pause.
   */
  questions: WorkflowRunQuestion[];
  /** Per-step rows. Present only when one run was asked for by id. */
  steps?: WorkflowRunStepStatus[];
}

/** The `workflowStatus` result. */
export interface WorkflowRuns {
  /** Newest first. One element when a `runId` was named. */
  runs: WorkflowRunStatus[];
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
 * The rewind verbs are the last word on it so far, and they split the same way
 * a third time. `listCheckpoints` degrades to `undefined` — it reads, and a
 * client that gets nothing offers no rewind picker, which is exactly what it
 * knows. `rewindTo` does **not**, and it is the strongest case in this file:
 * `applyChanges` silently doing nothing tells a reviewer their change landed
 * while the file says otherwise, and `rewindTo` silently doing nothing tells a
 * user their files went back to a state they never returned to — so they carry
 * on building on code they believe they discarded. It rejects.
 *
 * The workflow verbs split the same way a fourth time, and they are the
 * clearest illustration of why the question is per verb rather than per
 * feature — one feature, four verbs, two answers:
 *
 * - `listWorkflows` and `workflowStatus` degrade to `undefined`, on the
 *   `listModels` precedent. Both read. A client that gets nothing offers no
 *   workflow menu and no run view, which is exactly what it knows.
 * - `runWorkflow` and `resumeWorkflow` do **not**. They start work that spends
 *   real money and can apply a write-lane role's patch to the user's checkout,
 *   so a client told "started" by an engine that ignored the request believes
 *   a review pipeline ran and merges on a verdict nobody produced — and an
 *   `ORG-ASK` answer that silently went nowhere leaves a run paused forever
 *   while the person who answered believes it is moving. Both reject.
 *
 * A bump, by contrast, is a hard break in
 * both directions — `SessionHeader.version` is stamped with `1` and validated
 * as `1`, and `@arcturn/protocol`'s client rejects any header or handshake
 * that advertises a different number — so raising it would sever every
 * existing client/server pair to announce a feature neither of them needs to
 * negotiate.
 */
export const PROTOCOL_VERSION = 1;
