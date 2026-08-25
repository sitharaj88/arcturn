/**
 * The mode chip's words, and the empty state's line about what this engine can
 * do.
 *
 * A sibling of `webview-models.ts` — pure functions over plain data, shipped as
 * source, driven by `webview-permission.test.ts` with no DOM — and the place
 * two of RFC 0005 §3's refusals are spelled out in code rather than in a
 * comment.
 *
 * ## The chip never guesses
 *
 * `permissionState` is optional, so an engine that predates RFC 0005 answers
 * `undefined` and the panel knows *nothing* about the mode in force. The
 * chip's label for that case is `"Permissions"` — not `"default"`, which is
 * the mode most engines are in and therefore the most tempting lie. A user who
 * reads `default` on a session running `yolo` has been told the agent will ask
 * before it writes, and the next write executes. So: an unknown mode is shown
 * as unknown, and a mode this panel has never heard of is shown *verbatim*,
 * because quoting an engine's own word for it is the only answer that cannot
 * be wrong.
 *
 * That is also why `setPermissionMode` is not given the "old engine →
 * `undefined`" treatment anywhere on this path (see `ProtocolClient`'s own
 * doc): the chip moves when the engine's answer says it moved, and on a
 * refusal it snaps back to the mode still in force and the popover says why.
 *
 * ## The capability line names only what is there
 *
 * "No capability implied by an affordance." The line is built from
 * `PermissionState.tools` — the names the engine reported — and a clause
 * appears only when the tool behind it does. If `fetch` and `websearch` are
 * both absent, nothing on this page mentions the web at all: no sentence, and
 * (in `webview-client.ts`) no button. An engine that reported no tools gets no
 * line rather than an empty one, because "" is the honest rendering of "I was
 * not told".
 */

import type { PermissionMode } from "../serve/engine.js";

/** The four modes, in the order the popover lists them. */
export const PERMISSION_MODE_IDS: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "yolo",
];

/**
 * JavaScript source defining the chip's pure functions:
 * `PERMISSION_MODES`, `modeChipLabel`, `modeSummary`, `capabilityLine`.
 *
 * `String.raw`, like all four of its siblings in this directory, even though
 * this one happens to hold no escape sequence today. Escapes in these strings
 * belong to the *webview's* parser (see `webview-client.ts`'s header), so a
 * backslash added to a regex here has to reach the page intact — and spelling
 * this module differently from the others is how the next person to add one
 * writes a silent bug.
 */
// biome-ignore lint/complexity/noUselessStringRaw: consistency with its four siblings; see above.
export const PERMISSION_SOURCE = String.raw`
/**
 * The four modes the engine accepts, each with the one line RFC 0005 §2 asks
 * for: 'what each grants stated in one line'.
 *
 * Ordered by how much they give away, least first, so the list reads as a dial
 * rather than as four unrelated options — and so the most dangerous one is
 * never the one under the cursor when the popover opens.
 *
 * 'yolo' says out loud that a deny rule still wins. That is not a caveat, it
 * is the contract (RFC 0005 §1.2: 'a mode is a request, and a deny rule still
 * wins over yolo exactly as it does in the TUI'), and a chip that promised
 * otherwise would be describing an engine that does not exist.
 */
var PERMISSION_MODES = [
  {
    id: "default",
    label: "Default",
    grants: "Asks you before it writes a file or runs a command."
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    grants: "Edits files without asking. Still asks before running a command."
  },
  {
    id: "plan",
    label: "Plan",
    grants: "Reads and reasons only — no edits, no commands, no changes at all."
  },
  {
    id: "yolo",
    label: "Yolo",
    grants: "Runs everything without asking. A deny rule in your config still wins."
  }
];

function modeRow(mode) {
  for (var i = 0; i < PERMISSION_MODES.length; i += 1) {
    if (PERMISSION_MODES[i].id === mode) return PERMISSION_MODES[i];
  }
  return undefined;
}

/**
 * The chip's word for the mode in force.
 *
 * 'Permissions' — a noun, not a mode — is what an engine that never answered
 * gets, because every real value here would be a claim about what the agent is
 * allowed to do. A mode this panel does not recognise is quoted verbatim: the
 * engine knows what it is running under and this page does not, so repeating
 * its word is the only answer that cannot be wrong.
 */
function modeChipLabel(mode) {
  var id = String(mode || "");
  if (id === "") return "Permissions";
  var row = modeRow(id);
  return row === undefined ? id : row.label;
}

/** The one line under the chip. Empty for a mode with nothing true to say. */
function modeSummary(mode) {
  var row = modeRow(String(mode || ""));
  return row === undefined ? "" : row.grants;
}

/**
 * What this engine can do, in one sentence, from the tool names it reported.
 *
 * Each clause is present only if a tool behind it is — RFC 0005 §3, 'no
 * capability implied by an affordance', applied to prose. The web clause in
 * particular is the whole reason §1.4 exists: a panel cannot ask 'can you
 * browse', only 'is fetch in the tool set', and this says so truthfully or
 * says nothing.
 *
 * Tools nobody here has a word for are counted rather than named. An MCP
 * server contributes tools with names of its own choosing, and a sentence that
 * read 'and mcp__jira__search_issues' would be a worse answer at 300px than a
 * number.
 */
var CAPABILITY_CLAUSES = [
  { phrase: "read your files", tools: ["read", "glob", "grep", "ls", "outline"] },
  { phrase: "edit them", tools: ["edit", "write"] },
  { phrase: "run commands", tools: ["bash", "shell"] },
  { phrase: "browse the web", tools: ["fetch", "websearch"] }
];

/** Tools that exist to move the panel's own furniture, not to do work. */
var HOUSEKEEPING_TOOLS = { todo: 1, plan: 1 };

function joinClauses(parts) {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

function capabilityLine(tools) {
  var list = Array.isArray(tools) ? tools : [];
  if (list.length === 0) return "";
  var held = {};
  for (var i = 0; i < list.length; i += 1) held[String(list[i])] = 1;
  var phrases = [];
  var named = {};
  for (var c = 0; c < CAPABILITY_CLAUSES.length; c += 1) {
    var clause = CAPABILITY_CLAUSES[c];
    var has = false;
    for (var t = 0; t < clause.tools.length; t += 1) {
      if (Object.prototype.hasOwnProperty.call(held, clause.tools[t])) {
        has = true;
        named[clause.tools[t]] = 1;
      }
    }
    if (has) phrases.push(clause.phrase);
  }
  var rest = 0;
  for (var k = 0; k < list.length; k += 1) {
    var tool = String(list[k]);
    if (Object.prototype.hasOwnProperty.call(named, tool)) continue;
    if (Object.prototype.hasOwnProperty.call(HOUSEKEEPING_TOOLS, tool)) continue;
    rest += 1;
  }
  if (rest > 0) phrases.push(String(rest) + " tools this panel has no word for");
  if (phrases.length === 0) return "";
  return "This engine can " + joinClauses(phrases) + ".";
}
`;
