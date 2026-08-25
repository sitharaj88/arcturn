/**
 * The built-in commands a remote client can **actually reach**.
 *
 * RFC 0005 §1.3 states the rule this file exists to keep: "A command the panel
 * cannot execute is not listed — a menu offering `/rewind` to a client with no
 * rewind verb is a menu that lies." The list is therefore not "the commands
 * the CLI has" (there are seventeen, and most of them drive a terminal) but
 * "the commands the verbs on THIS wire can carry out".
 *
 * `/rewind` was the RFC's own example and sat in the excluded list below for
 * exactly as long as that was true. It is listed now because `listCheckpoints`
 * and `rewindTo` exist — which is the rule working, not an exception to it.
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
 * - **`rewind`** — `listCheckpoints` reports the turns this session could go
 *   back to *and what each one would cost*, and `rewindTo` restores the files
 *   and forks the conversation through the engine's own checkpoint store. This
 *   is the entry the rule in this file was written against: the doc below used
 *   to name `/rewind` as the example of a command with no verb, and it stayed
 *   out until both halves existed. It goes in now for the same reason it
 *   stayed out then — the truth condition is whether the wire can carry the
 *   command out, and it can. Listed **unconditionally**, on `diff`/`apply`/
 *   `discard`'s terms: an engine that keeps no checkpoints answers
 *   `available: false`, which is a fact a client states rather than a reason to
 *   hide the row and make the panel's menu differ from the terminal's by
 *   engine mode.
 * - **`bg`** — `backgroundAgents` lists them and renders one's transcript,
 *   `startBackgroundAgent` starts one, `cancelBackgroundAgent` stops one and
 *   `adoptBackgroundAgent` delivers a finished one's result into a live
 *   session. Subverb for subverb, that is the terminal's `/bg`, `/bg logs`,
 *   `/bg cancel` and `/bg adopt`, so this entry promises the whole command.
 *   What the *wire* narrows is not which subverbs work but what a start may
 *   ask for: `startBackgroundAgent` carries a task and nothing else, so a
 *   remote caller cannot widen the tool set, the permission mode, the working
 *   directory or the model that a background agent runs under. That is a
 *   narrower `start`, not a narrower command.
 * - **`org`** — and this one is listed with a description that promises
 *   **less** than the terminal's, on `permissions`' and `export`'s terms.
 *   `orgMemory` reads the store, `proposeOrgMemory` files an inert entry and
 *   `revokeOrgMemory` takes one back; the terminal's `/org memory add` and
 *   `/org memory approve` have no counterpart and are not going to get one. An
 *   `active` entry is standing instruction text in every later run of its role,
 *   and the gate on it is a person at the machine — the same shape
 *   `/permissions suggest` has, whose persisting half is refused here for the
 *   same reason. So the row is offered and the description says "propose", not
 *   "approve": half a promise kept is a broken one, and the way not to break it
 *   is to promise the half that works.
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
 * - **`workflow`** — another entry whose *whole* terminal command is reachable,
 *   subverb for subverb: `listWorkflows` is `/workflow list`,
 *   `runWorkflow` is `/workflow <name> [args]`, `workflowStatus` is
 *   `/workflow status [runId]` and `resumeWorkflow` is
 *   `/workflow resume <runId> [answer]`. What the wire narrows is not which
 *   subverbs work but what a start may ask for: `runWorkflow` carries a name,
 *   an input and a budget that can only ever be *lower* than the workflow
 *   file's own — so a remote caller can bound a pipeline harder than the file
 *   does and can never loosen it, nor touch a role's tools, a step's deadline
 *   or the permission engine. Registered by `createWorkflowCommands()` rather
 *   than `createBuiltInCommands()`, which is a fact about where the CLI keeps
 *   its factories and not about whether the terminal has the command — see
 *   `serve-commands.test.ts`, which checks the whole registry.
 *
 * ### What was excluded, and why
 *
 * Each of these is a command the CLI really has, left out because no verb on
 * this wire carries it out:
 *
 * - **`theme`** — a terminal concern with nothing behind it on this wire.
 * - **`todos`** — the todo list rides the event stream (`todoUpdate`), so its
 *   data is reachable exactly as `/cost`'s is and needs no verb either. It is
 *   left out for the *other* half of the rule: a built-in earns a menu entry
 *   by naming something a client can then **do**, and the panel already
 *   renders todos continuously in its plan card — there is no surface for
 *   `/todos` to open, so the row would do nothing when chosen. Adding it the
 *   day a client grows somewhere for it to lead is a one-line change here.
 * - **`scout`** — no verb, and the reason is worth writing down because it is
 *   not "nobody got to it". A scout run has no durable record anywhere: it
 *   creates throwaway git worktrees, races the approaches against a deadline,
 *   captures each diff into memory, deletes every worktree in a `finally`, and
 *   returns a report that exists only as the text it printed. There is
 *   therefore nothing for a listing verb to list and nothing for a cancel verb
 *   to name — a `startScout` would be a single request that blocks for minutes,
 *   cannot be reported on, cannot be cancelled, and hands back worktrees that
 *   are already gone. Making it reachable means giving scouts a registry with
 *   durable records first, which is an engine change, not a protocol one.
 * - **`team`** — no verb, and for two reasons that are each sufficient. First,
 *   the only way to reach a team manager is to construct one, and constructing
 *   one adopts the records directory and rewrites every record still `running`
 *   to `interrupted` — sound when a fresh manager really is a fresh process,
 *   and false in a serve process running alongside a terminal that owns a live
 *   team. A "read-only" status verb whose first call declares somebody else's
 *   running team dead is not read-only. Second, `merge` and `discard` write to
 *   the user's checkout — `git apply` into the real tree, `rm` of the patch
 *   that is the only copy of a member's work — and the manager has no
 *   mid-run guard on either, so there is no `sessionBusy` for this wire to
 *   answer with. Both are fixable in `@arcturn/cli` (an owner lease in the
 *   record; a running check on merge and discard) and neither is fixable here.
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
    // The terminal's `/rewind` also takes a query and jumps by intent. That
    // half is a ranking over turn labels with no verb behind it, so the
    // description promises the half that works — the treatment `permissions`
    // and `cost` get, for the same reason.
    name: "rewind",
    description: "Restore files to an earlier turn and fork the conversation",
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
    // Promises the whole terminal command, because all four subverbs are here.
    // The description says "background" rather than naming a cost, because what
    // one costs is not knowable before it runs and a menu row must not imply it.
    name: "bg",
    description: "Run a task in the background, and list, log, cancel or adopt one",
    kind: "builtin" as const,
  }),
  Object.freeze({
    // Promises LESS than the terminal's `/org memory`, deliberately: "propose",
    // never "approve". See the doc above — an entry that reaches a role's
    // prompt is approved by a person, and a menu row saying otherwise would be
    // the lying menu RFC 0005 §3 rules out, pointed at the one gate where it
    // would matter most.
    name: "org",
    description: "Inspect per-role org memory, and propose or revoke a lesson",
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
  Object.freeze({
    // All four subverbs of the terminal's `/workflow` are on this wire, which
    // is why this entry can promise the whole command rather than half of it:
    // `listWorkflows` is `/workflow list`, `runWorkflow` is `/workflow <name>`,
    // `workflowStatus` is `/workflow status`, and `resumeWorkflow` is
    // `/workflow resume` — including the `[answer]` an `ORG-ASK:` gate needs.
    //
    // Registered by `createWorkflowCommands()` rather than
    // `createBuiltInCommands()`, in the same `createCommandRegistry()`. The
    // rule this list keeps is "the terminal really has this command", not "one
    // particular factory defines it" — see `serve-commands.test.ts`.
    name: "workflow",
    description: "Run, follow and resume a markdown workflow",
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
    rewind: Object.freeze(["listCheckpoints", "rewindTo"]),
    export: Object.freeze(["exportSession"]),
    mcp: Object.freeze(["mcpStatus"]),
    // The subscription, not a verb of its own. `openSession` is what puts a
    // connection on the session's event stream, and `turnEnd` on that stream
    // is where every figure `/cost` shows comes from. Naming it here keeps the
    // refusal sentence honest — "this is answered by openSession" is what a
    // client that sent `/cost` as prompt text actually needs to hear — and
    // keeps this map's one invariant with the list above intact.
    cost: Object.freeze(["openSession"]),
    // Four verbs, four subverbs, one-to-one — so a client that sent `/bg` as
    // prompt text is told all four rather than the one it happened to mean.
    bg: Object.freeze([
      "backgroundAgents",
      "startBackgroundAgent",
      "cancelBackgroundAgent",
      "adoptBackgroundAgent",
    ]),
    // Three verbs for five terminal subverbs, and the two that are missing are
    // missing on purpose: there is no verb here for `add` or `approve`. A
    // client told to "use the orgMemory, proposeOrgMemory and revokeOrgMemory
    // verbs" is being told, by omission and accurately, that approving is not
    // something this wire does.
    org: Object.freeze(["orgMemory", "proposeOrgMemory", "revokeOrgMemory"]),
    // Four verbs, four subverbs, and the mapping is one-to-one — so a client
    // that sent `/workflow` as prompt text is told all four rather than the
    // one it happened to want.
    workflow: Object.freeze(["listWorkflows", "runWorkflow", "workflowStatus", "resumeWorkflow"]),
  });
