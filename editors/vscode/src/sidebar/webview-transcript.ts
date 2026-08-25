/**
 * How the flat block list becomes a conversation: turn grouping, and the one
 * line a tool card shows before anyone expands it.
 *
 * `chat-state.ts` reduces the engine's stream into an ordered list of blocks
 * because that is what the *stream* is — text, thinking and tool calls
 * interleaved in arrival order. What a reader wants is turns: one "You" and
 * then one "Arcturn" that contains everything the model did before it stopped.
 * That regrouping is a rendering decision, so it lives here rather than in the
 * reducer, and it is a pure function of the block list so it can be tested
 * without a DOM.
 *
 * The tool summary exists for the same reason a file explorer shows a name and
 * not a stat block: a collapsed row that says only `bash` tells a user nothing
 * about which command is running. It is extracted from the arguments the
 * engine sent, never invented, and it works on the *partial* JSON that arrives
 * mid-stream so a card is informative while it is still filling in.
 *
 * Shipped as source (see `webview-markdown.ts` for why) and tested through it.
 */

/** The role a group of consecutive blocks is rendered under. */
export type TurnRole = "user" | "assistant" | "notice";

/** One rendered turn: a header and the blocks beneath it. */
export interface Turn {
  /** The first block's id — stable across renders, so the DOM can be keyed. */
  key: string;
  role: TurnRole;
  blockIds: string[];
}

/** The icon family a tool card draws. */
export type ToolIcon = "terminal" | "file" | "edit" | "search" | "web" | "list" | "tool";

/**
 * JavaScript source defining `groupTurns`, `toolSummary`, `toolStatusLabel`
 * and `toolIcon`.
 */
export const TRANSCRIPT_SOURCE = String.raw`
function turnRole(kind) {
  if (kind === "user") return "user";
  if (kind === "notice") return "notice";
  return "assistant";
}

/**
 * Group consecutive blocks of the same role into turns.
 *
 * Keyed by the first block's id so a repaint can match a group to the element
 * that already renders it. Two prompts in a row are two groups, because a user
 * who sent two messages sent two messages.
 */
function groupTurns(blocks) {
  var turns = [];
  var open = null;
  for (var i = 0; i < blocks.length; i += 1) {
    var block = blocks[i];
    var role = turnRole(block.kind);
    if (open === null || open.role !== role || role === "user") {
      open = { key: block.id, role: role, blockIds: [] };
      turns.push(open);
    }
    open.blockIds.push(block.id);
  }
  return turns;
}

/** Argument names worth putting on a collapsed row, most identifying first. */
var SUMMARY_KEYS = [
  "command", "cmd", "script",
  "file_path", "filePath", "path", "file", "target_file",
  "pattern", "query", "regex", "search",
  "url", "uri",
  "old_string", "content",
  "description", "prompt", "task", "name"
];

function tidySummary(value) {
  var text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= 120) return text;
  return text.slice(0, 119) + "…";
}

function pickSummaryValue(args) {
  for (var i = 0; i < SUMMARY_KEYS.length; i += 1) {
    var value = args[SUMMARY_KEYS[i]];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  var keys = Object.keys(args);
  for (var j = 0; j < keys.length; j += 1) {
    if (typeof args[keys[j]] === "string" && args[keys[j]] !== "") return args[keys[j]];
  }
  return "";
}

/**
 * One line describing what a tool was asked to do.
 *
 * Tries the complete object first. Mid-stream the arguments are a truncated
 * JSON fragment that will not parse, so the fallback reads the first
 * identifying key out of the fragment directly — which is what makes a card
 * useful while it is still arriving. Returns "" rather than guessing when the
 * arguments say nothing yet.
 */
function toolSummary(argsText) {
  var text = String(argsText || "");
  if (text === "") return "";
  try {
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return tidySummary(pickSummaryValue(parsed));
    }
    if (typeof parsed === "string") return tidySummary(parsed);
  } catch (error) {
    // Falls through to the partial reader below.
  }
  for (var i = 0; i < SUMMARY_KEYS.length; i += 1) {
    var pattern = new RegExp('"' + SUMMARY_KEYS[i] + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', "");
    var match = pattern.exec(text);
    if (match) {
      var raw = match[1];
      var unescaped = raw
        .replace(/\\n/g, " ")
        .replace(/\\t/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      var tidied = tidySummary(unescaped);
      if (tidied !== "") return tidied;
    }
  }
  return "";
}

/** The engine's status word, in the extension's own English. */
function toolStatusLabel(status) {
  if (status === "running") return "Running";
  if (status === "ok") return "Done";
  if (status === "error") return "Failed";
  if (status === "denied") return "Denied";
  if (status === "awaitingPermission") return "Needs permission";
  return "Queued";
}

/**
 * Icon families, most specific first. Order is the tie-break and it is
 * load-bearing: 'todo_write' is a todo list before it is a write, and
 * 'web_search' is the web before it is a search.
 */
var TOOL_ICONS = [
  ["list", ["todo", "todos", "plan"]],
  ["terminal", ["bash", "sh", "zsh", "shell", "terminal", "exec", "cmd", "command", "run", "process"]],
  ["edit", ["write", "edit", "editor", "patch", "replace", "create", "insert", "append", "delete", "remove", "move", "rename", "mkdir"]],
  ["web", ["web", "fetch", "http", "https", "browser", "url", "curl", "download"]],
  ["file", ["read", "cat", "open", "view", "notebook", "stat"]],
  ["search", ["grep", "rg", "search", "glob", "find", "ls", "list", "tree"]]
];

/**
 * Which of the seven glyphs a tool draws.
 *
 * Matched on whole *segments* of the name — split on punctuation and on
 * camelCase — not on substrings. A substring test looks simpler and is wrong:
 * 'frobnicate' contains 'cat', so an unknown MCP tool would be labelled a file
 * read. Tool names are engine- and MCP-supplied with no registry behind them,
 * so anything unrecognised gets the generic mark rather than a confident wrong
 * one.
 */
function toolIcon(name) {
  var segments = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (var i = 0; i < TOOL_ICONS.length; i += 1) {
    var words = TOOL_ICONS[i][1];
    for (var j = 0; j < segments.length; j += 1) {
      if (words.indexOf(segments[j]) !== -1) return TOOL_ICONS[i][0];
    }
  }
  return "tool";
}
`;
