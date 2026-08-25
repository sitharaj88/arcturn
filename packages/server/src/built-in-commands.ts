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
 *
 * ### What was excluded, and why
 *
 * Each of these is a command the CLI really has, left out because no verb on
 * this wire carries it out:
 *
 * - **`rewind`** — restoring files to a checkpoint and forking the
 *   conversation. No verb. RFC 0005 §1.3 names this one specifically.
 * - **`compact`** — needs `Agent.compact()`; nothing on the wire calls it.
 * - **`diff` / `apply` / `discard`** — the dry-run overlay lives in the
 *   runtime and is not addressable from here.
 * - **`export`** — writes an HTML/Markdown file on the *server's* disk. A
 *   client holding `sessionHistory` can render its own export; listing
 *   `/export` would promise the engine writes a file, which it would not.
 * - **`theme`** — a terminal concern with nothing behind it on this wire.
 * - **`mcp`** — no verb reports MCP server status.
 * - **`todos` / `cost`** — both read live runtime state that a client already
 *   receives on the event stream. A command that duplicated an event feed
 *   would be a second, drifting source for the same numbers.
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
]);
