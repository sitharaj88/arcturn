/**
 * The built-in commands a remote client can **actually reach**.
 *
 * RFC 0005 §1.3 states the rule this file exists to keep: "A command the panel
 * cannot execute is not listed — a menu offering `/rewind` to a client with no
 * rewind verb is a menu that lies." The list is therefore not "the commands
 * the CLI has" (there are seventeen, and most of them drive a terminal) but
 * "the commands the verbs on THIS wire can carry out".
 *
 * That is also why the list lives in `@arcturn/server` rather than in
 * `@arcturn/cli`, where the commands themselves are defined: the truth
 * condition for an entry is *which verbs the protocol implements*, and this is
 * the package that implements them. When a verb is added, the question "does a
 * built-in become reachable now?" is asked next to the dispatch table that
 * answers it. When one is removed, the list breaks here rather than in a menu.
 *
 * Names and descriptions are kept aligned with `@arcturn/cli`'s
 * `createBuiltInCommands()` so a person moving between the panel and the
 * terminal finds the same word for the same thing. Where a wire client can
 * reach only *part* of what the terminal command does, the description says
 * what the wire can do rather than what the terminal can — a menu entry is a
 * promise, and half a promise kept is a broken one.
 */

import type { CommandDescriptor } from "@arcturn/types";

/**
 * Built-ins listed by {@link SessionHost.listCommands}, each with the verbs
 * that make it real.
 *
 * ### What made the cut, and why
 *
 * - **`model`** — `listModels` offers the catalog, `setModel` switches. Both
 *   halves exist, and they are wired from one source (see `createServeHost`),
 *   so what a client is offered is what a pick actually does.
 * - **`permissions`** — `permissionState` reads the mode and the rules,
 *   `setPermissionMode` changes the mode. The terminal command also persists a
 *   learned rule via `/permissions suggest`; that half is refused on this wire
 *   *by design* (RFC 0005 §1.2 — nothing persists to disk from a remote
 *   client), so the description here promises only the half that works.
 * - **`sessions`** — `listSessions` enumerates, `openSession` attaches, and
 *   `sessionHistory` replays what was already said, so a client can render a
 *   resumed session rather than an empty one.
 * - **`clear`** — `createSession` mints a fresh session and `openSession`
 *   attaches to it, which is exactly what the terminal's `/clear` does.
 * - **`diff` / `apply` / `discard`** — `pendingChanges` lists what a
 *   `--dry-run` session is holding back, `applyChanges` writes it to the real
 *   files through the engine's own overlay, and `discardChanges` throws it
 *   away. Listed **unconditionally**, not only on an engine that happens to be
 *   running `--dry-run`, and the reason is that the truth condition for this
 *   list is "can the wire carry this command out", not "is there anything for
 *   it to do right now": a `/diff` on a session with no overlay answers "this
 *   engine is not running under --dry-run" — which is the same sentence the
 *   terminal's `/diff` prints, from the same fact, so the two surfaces agree.
 *   Withholding the entry instead would make the panel's menu differ from the
 *   terminal's by engine mode, which is the divergence RFC 0004 §0 forbids.
 *
 * - **`compact`** — the `compact` verb drives `Agent.compact()`, the same
 *   method the terminal's `/compact` calls and the same one the run loop calls
 *   at the automatic threshold. It refuses mid-run rather than queueing, and
 *   answers with the tokens on both sides so a client can report what it
 *   freed.
 * - **`export`** — `exportSession` renders the transcript and hands it back;
 *   the **client** saves it. The terminal writes a file, this does not, and
 *   the description below promises the half that works rather than the half
 *   the terminal does — the same treatment `permissions` gets.
 * - **`mcp`** — `mcpStatus` reports the configured servers, their transport,
 *   their connection state and their tool counts. Names and status only: no
 *   credential, no URL, no server-supplied error prose.
 * - **`cost`** — the one entry here backed by no verb of its own, and the
 *   reason the rule this file keeps had to be read more carefully than "is
 *   there a verb". Every number `/cost` shows already rides the event stream a
 *   client subscribed to with `openSession`: `turnEnd` carries the usage and
 *   the price, which is why a `cost` *verb* was rejected below and stays
 *   rejected — it would be a second, drifting source for figures the client is
 *   already receiving. But the truth condition is "can a client carry this
 *   command out", and a client folding `turnEnd` can. So the command is listed
 *   and the verb is not invented.
 *
 * ### What was excluded, and why
 *
 * Each of these is a command the CLI really has, left out because no verb on
 * this wire carries it out:
 *
 * - **`rewind`** — restoring files to a checkpoint and forking the
 *   conversation. No verb. RFC 0005 §1.3 names this one specifically.
 * - **`theme`** — a terminal concern with nothing behind it on this wire.
 * - **`todos`** — the todo list rides the event stream (`todoUpdate`), so its
 *   data is reachable exactly as `/cost`'s is and needs no verb either. It is
 *   left out for the *other* half of the rule: a built-in earns a menu entry
 *   by naming something a client can then **do**, and the panel already
 *   renders todos continuously in its plan card — there is no surface for
 *   `/todos` to open, so the row would do nothing when chosen. Adding it the
 *   day a client grows somewhere for it to lead is a one-line change here.
 * - **`scout`** — no verb.
 * - **`help`** — a client renders its own help from `listCommands`; listing it
 *   would make the engine promise a rendering it does not do.
 * - **`exit`** — a client closes its own socket. Not an engine command.
 *
 * Deliberately **not** included even though a verb exists: there is no
 * `/delete` built-in in the CLI, so listing one for `deleteSession` would be
 * inventing a command the terminal does not have — the divergence RFC 0004 §0
 * exists to prevent, pointed the other way.
 */
export const REMOTE_REACHABLE_BUILT_IN_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  Object.freeze({
    name: "model",
    description: "Switch the model",
    kind: "builtin" as const,
  }),
  Object.freeze({
    name: "permissions",
    description: "Show the permission mode and rules, and switch mode",
    kind: "builtin" as const,
  }),
  Object.freeze({
    name: "sessions",
    description: "Resume an earlier session in this directory",
    kind: "builtin" as const,
  }),
  Object.freeze({
    name: "clear",
    description: "Start a fresh session",
    kind: "builtin" as const,
  }),
  Object.freeze({
    name: "diff",
    description: "Show pending dry-run changes",
    kind: "builtin" as const,
  }),
  Object.freeze({
    name: "apply",
    description: "Apply pending dry-run changes to the workspace",
    kind: "builtin" as const,
  }),
  Object.freeze({
    name: "discard",
    description: "Throw away pending dry-run changes",
    kind: "builtin" as const,
  }),
  Object.freeze({
    name: "compact",
    description: "Summarise the conversation to free up context",
    kind: "builtin" as const,
  }),
  Object.freeze({
    // Not "Export the conversation to a file": the engine renders and the
    // client saves. A description promising a file would promise the wrong
    // machine's disk.
    name: "export",
    description: "Download the conversation as markdown or HTML",
    kind: "builtin" as const,
  }),
  Object.freeze({
    name: "mcp",
    description: "Show MCP server status",
    kind: "builtin" as const,
  }),
  Object.freeze({
    // The terminal's `/cost` also sets a limit and previews a plan's spend.
    // Neither half exists on this wire, so the description promises only the
    // half that does — the treatment `permissions` gets, for the same reason.
    name: "cost",
    description: "Show this session's usage and cost",
    kind: "builtin" as const,
  }),
]);

/**
 * The verbs behind each listed built-in, named so a refusal can be acted on.
 *
 * `listCommands` marks these `kind: "builtin"`, which tells a client they are
 * not prompt text — but a client that inserts `/model` into its composer and
 * sends it anyway (a `/` menu that pastes the name, an older panel, a person
 * typing) has to be told *what to call instead*, not merely that it was wrong.
 * The serve path's `/name` expansion reads this to write that sentence.
 *
 * "Behind" is deliberately wider than "invoked by". `cost` names `openSession`
 * because the subscription that verb opens is what carries the numbers; there
 * is no `cost` verb and there will not be one. The invariant this map holds
 * with the list above is that every listed command names at least one verb a
 * client can actually reach, which is the question membership is decided by —
 * not that every command has a verb of its own.
 *
 * Kept beside {@link REMOTE_REACHABLE_BUILT_IN_COMMANDS} rather than at the
 * refusal site for the reason the list itself lives in this package: "which
 * verbs make this command real" is the same question membership above is
 * decided by, and answering it twice is how the menu entry and the error
 * message come to name different verbs. Deliberately **not** on the wire —
 * `CommandDescriptor` stays as it is; this is server-side prose.
 */
export const REMOTE_BUILT_IN_COMMAND_VERBS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    model: Object.freeze(["listModels", "setModel"]),
    permissions: Object.freeze(["permissionState", "setPermissionMode"]),
    sessions: Object.freeze(["listSessions", "openSession", "sessionHistory"]),
    clear: Object.freeze(["createSession", "openSession"]),
    diff: Object.freeze(["pendingChanges"]),
    apply: Object.freeze(["pendingChanges", "applyChanges"]),
    discard: Object.freeze(["pendingChanges", "discardChanges"]),
    compact: Object.freeze(["compact"]),
    export: Object.freeze(["exportSession"]),
    mcp: Object.freeze(["mcpStatus"]),
    // The subscription, not a verb of its own. `openSession` is what puts a
    // connection on the session's event stream, and `turnEnd` on that stream
    // is where every figure `/cost` shows comes from. Naming it here keeps the
    // refusal sentence honest — "this is answered by openSession" is what a
    // client that sent `/cost` as prompt text actually needs to hear — and
    // keeps this map's one invariant with the list above intact.
    cost: Object.freeze(["openSession"]),
  });
