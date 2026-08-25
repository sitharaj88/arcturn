/**
 * The `/` menu: what it lists, in what order, and what pressing Enter does.
 *
 * A sibling of `webview-models.ts` and `webview-sessions.ts` — pure functions
 * over plain data, shipped as source, driven by `webview-commands.test.ts`
 * with no DOM — and the one place in the panel where RFC 0005 §3's "no command
 * the panel cannot run" is enforced a *second* time.
 *
 * ## Why twice
 *
 * The engine already refuses to list a command the wire cannot carry out
 * (`REMOTE_REACHABLE_BUILT_IN_COMMANDS` in `@arcturn/server` is that list, and
 * its doc comment is an argument about which verbs make which built-in real).
 * That is the right filter for *a* client. It is not sufficient for *this*
 * one: a built-in is only reachable if the panel also has a surface that runs
 * it, and the panel is a webview with no quick-pick and no terminal. So
 * `runnableCommands` keeps a built-in only when {@link builtinAction} names a
 * thing this page actually does — and if the engine grows a built-in tomorrow
 * that the panel has no answer for, the menu silently does not offer it rather
 * than offering a row that does nothing.
 *
 * ## Two kinds of row, two behaviours
 *
 * - **A skill** is prompt text (RFC 0005 §1.3: "Execution stays `prompt`"), so
 *   choosing one *inserts* `/name ` into the composer and leaves the user to
 *   add their argument and press Enter. The panel invents no second execution
 *   path, which is the whole point of the rule.
 * - **A built-in** the panel has a native surface for *opens that surface*:
 *   `/model` is the model chip, `/permissions` is the mode chip, `/sessions`
 *   is the history view, `/clear` is the New session button. Inserting the
 *   text instead would send a prompt asking the model to do something the
 *   panel has a button for, which is not what the terminal's `/model` does.
 *
 * ## What is not escaped here, and what is
 *
 * Nothing in this module escapes anything, exactly as `webview-sessions.ts`
 * does not: every field reaches the page through `textContent`, where
 * `$(check)` is already six characters. The escaping that *is* required
 * happens on the host side, in `projectCommandOption` — a skill description is
 * a string a cloned repository controls, and it reaches a VS Code
 * notification on the failure path as well as this menu.
 */

/**
 * One command as the panel sees it.
 *
 * A rebuilt projection of `CommandDescriptor` — the host copies field by field
 * on the way out (see `projectCommandOption` in `webview-messages.ts`), so
 * nothing the engine happens to add reaches the page unreviewed.
 */
export interface CommandOption {
  /** Name without the leading slash, e.g. `"review"`. */
  name: string;
  /** One line of help, as the engine sanitized it. `""` when there was none. */
  description: string;
  /** `"skill"` — a markdown file. `"builtin"` — a command the engine ships. */
  kind: "skill" | "builtin";
  /** Absolute path of a skill's markdown file. Absent for a built-in. */
  source?: string;
}

/**
 * JavaScript source defining the menu's pure functions:
 * `runnableCommands`, `orderCommands`, `filterCommands`, `commandMeta`,
 * `commandInsert`, `builtinAction`.
 */
export const COMMAND_MENU_SOURCE = String.raw`
/**
 * Which panel surface a built-in opens. '' when this panel has none, which is
 * what keeps the command out of the menu entirely.
 *
 * Each maps to a control that is already on screen — so a user who finds a
 * command through '/' and a user who clicks the chip or the review card end up
 * in the same place, which is the only way the two cannot drift.
 *
 * The dry-run three are here on the same terms as the rest: the engine lists
 * them because the wire carries 'pendingChanges', 'applyChanges' and
 * 'discardChanges', and the panel keeps them because it has a review card that
 * runs exactly those. An engine too old to list them simply does not, and
 * 'runnableCommands' never sees the names.
 */
var BUILTIN_ACTIONS = {
  model: "model",
  permissions: "permissions",
  sessions: "sessions",
  clear: "clear",
  diff: "diff",
  apply: "apply",
  discard: "discard",
  cost: "cost"
};

function builtinAction(command) {
  if (command.kind !== "builtin") return "";
  return Object.prototype.hasOwnProperty.call(BUILTIN_ACTIONS, command.name)
    ? BUILTIN_ACTIONS[command.name]
    : "";
}

/**
 * The commands this panel can actually carry out. See the module doc for why
 * this filter exists on top of the engine's own.
 */
function runnableCommands(commands) {
  var out = [];
  for (var i = 0; i < commands.length; i += 1) {
    var command = commands[i];
    if (command.kind === "skill" || builtinAction(command) !== "") out.push(command);
  }
  return out;
}

/**
 * Skills first with their descriptions, then built-ins — RFC 0005 §2, in the
 * order it asks for. Alphabetical inside each band.
 *
 * The engine sorts this way too, and this sorts again anyway: a menu that
 * inherited its order from whatever the server happened to send would show a
 * different list to a client of an engine that changed its mind, and the group
 * headers this order produces would be wrong rather than merely unsorted.
 */
function orderCommands(commands) {
  var copy = commands.slice();
  copy.sort(function (a, b) {
    if (a.kind !== b.kind) return a.kind === "skill" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return copy;
}

/**
 * Every token has to match the name or the description. Substring, not fuzzy,
 * for the reason 'filterModels' gives — and because a command list is short
 * enough that a substring match never leaves a user unable to find a row.
 *
 * A leading slash is stripped: it is what the user just typed to open this
 * menu, and matching it against a name that does not contain one would empty
 * the list the moment it opened.
 */
function filterCommands(commands, query) {
  var text = String(query || "").replace(/^\/+/, "");
  var tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return commands.slice();
  return commands.filter(function (command) {
    var haystack = (command.name + " " + command.description).toLowerCase();
    for (var i = 0; i < tokens.length; i += 1) {
      if (haystack.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  });
}

/** The last path segment: 300px has room for a filename, not for a path. */
function commandFile(source) {
  var parts = String(source).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || String(source);
}

/**
 * The row's second line: the engine's own description, and for a skill the
 * file it came from — which is how a user tells a command a cloned repository
 * provided from one they wrote themselves.
 *
 * A skill whose frontmatter set no description still says what it is rather
 * than showing a blank line, because a menu row with nothing under it reads as
 * a row that failed to load.
 */
function commandMeta(command) {
  var description = String(command.description || "").trim();
  if (command.kind !== "skill") return description;
  var file = command.source ? commandFile(command.source) : "";
  if (description === "") return file === "" ? "Workspace skill" : "Workspace skill · " + file;
  return file === "" ? description : description + " · " + file;
}

/** What a chosen skill puts in the composer: the command, and room to type. */
function commandInsert(command) {
  return "/" + command.name + " ";
}
`;
