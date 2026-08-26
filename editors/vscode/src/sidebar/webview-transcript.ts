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
 * JavaScript source defining `groupTurns`, `toolSummary`, `toolStatusLabel`,
 * `toolIcon`, `showWorking`, `toolGroup`, `toolDiff` and `formatElapsed`.
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

/**
 * Whether the panel owes the reader a "the model is working" signal.
 *
 * A run has three kinds of moment. Text is arriving, and the caret on the
 * block being written says so. A tool is running, and that card's own spinner
 * says so. And then there are the gaps — after Enter and before the first
 * token, and after a tool settles while the model decides what to do next —
 * where a correct panel is completely still and an incorrect one is
 * indistinguishable from a hung one. This is true only in the gaps: two
 * indicators for one state make the panel look busier than the run it is
 * describing.
 */
function showWorking(blocks, running) {
  if (!running) return false;
  var last = blocks.length === 0 ? null : blocks[blocks.length - 1];
  if (last === null) return true;
  // Text and thinking are both visibly growing on screen.
  if (last.kind === "text" || last.kind === "thinking") return false;
  if (last.kind === "tool" && (last.status === "running" || last.status === "awaitingPermission")) {
    return false;
  }
  return true;
}

/**
 * Where one tool card sits in a run of consecutive ones.
 *
 * A turn that ran six greps in a row is one action, not six cards each with
 * its own border, its own corners and its own 6px of air. The renderer draws
 * the run as a single stack — outer corners, hairline dividers — and this is
 * the only decision behind it: what came immediately before and after.
 */
function toolGroup(before, after) {
  if (before === "tool") return after === "tool" ? "mid" : "last";
  return after === "tool" ? "first" : "solo";
}

/*
 * Argument spellings that mean "this text became that text". Arcturn's own
 * edit tool says oldText/newText; other agents and MCP servers in the same
 * panel say old_string/new_string or old/new, and the panel renders whatever
 * engine it is pointed at rather than only its own tools.
 */
var DIFF_PAIRS = [["oldText", "newText"], ["old_string", "new_string"], ["old", "new"]];

/* Arguments that are a whole body of text rather than a change to one. */
var DIFF_WHOLE = ["content", "contents", "text"];

/* Rendered lines per card. A generated 4000-line file is not worth 4000 nodes. */
var DIFF_MAX_LINES = 400;

function splitDiffLines(text) {
  var lines = String(text).split("\n");
  // A trailing newline terminates the last line, it does not add an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function signedLines(text, sign) {
  var lines = splitDiffLines(text);
  var out = [];
  for (var i = 0; i < lines.length; i += 1) out.push({ sign: sign, text: lines[i] });
  return out;
}

/**
 * An edit, drawn as the change it makes rather than the JSON that asks for it.
 *
 * {"path":"a.ts","oldText":"if (x)\nreturn","newText":"if (y)\nreturn"} is a
 * diff in disguise: every newline is a literal backslash-n and both versions
 * sit on one unreadable line. For a coding agent the change *is* the thing the
 * reader came to see, so it is drawn as removed lines above added ones.
 *
 * Two rules keep it honest:
 *
 * Only complete arguments are drawn. Mid-stream JSON is a truncated fragment,
 * and half of a newText is a change nobody is making — the card shows the
 * raw arguments until the call is whole, which is the same fragment the reader
 * would have seen anyway.
 *
 * Whatever is left over is still shown. A diff that swallowed replaceAll or
 * path would be a reviewer reading an edit with an argument hidden from
 * them, so every key the diff did not consume comes back as rest.
 *
 * A lone body of text (a write) is returned unsigned and untinted. Green
 * means "added, as against that red"; with nothing to contrast it is only
 * decoration, and on an unrecognised MCP tool it would be an assertion the
 * panel cannot make.
 */
function toolDiff(argsText, complete) {
  if (complete !== true) return null;
  var parsed;
  try {
    parsed = JSON.parse(String(argsText || ""));
  } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  var used = [];
  var lines = null;
  var label = "";
  for (var p = 0; p < DIFF_PAIRS.length && lines === null; p += 1) {
    var before = parsed[DIFF_PAIRS[p][0]];
    var after = parsed[DIFF_PAIRS[p][1]];
    if (typeof before === "string" && typeof after === "string" && before !== after) {
      lines = signedLines(before, "-").concat(signedLines(after, "+"));
      label = "Change";
      used = [DIFF_PAIRS[p][0], DIFF_PAIRS[p][1]];
    }
  }
  // A tool that named either half of a pair is an edit, and the pair path
  // above has already had its say. Falling through to the whole-body path
  // would draw the new half of a no-op edit as a freshly written file — the
  // one shape where the two readings disagree, and the reading it would pick
  // is the wrong one.
  var isEdit = false;
  for (var q = 0; q < DIFF_PAIRS.length; q += 1) {
    if (typeof parsed[DIFF_PAIRS[q][0]] === "string" || typeof parsed[DIFF_PAIRS[q][1]] === "string") {
      isEdit = true;
    }
  }
  for (var w = 0; w < DIFF_WHOLE.length && lines === null && !isEdit; w += 1) {
    var body = parsed[DIFF_WHOLE[w]];
    if (typeof body === "string" && body !== "") {
      lines = signedLines(body, "");
      label = "Content";
      used = [DIFF_WHOLE[w]];
    }
  }
  if (lines === null) return null;

  var shown = lines.length > DIFF_MAX_LINES ? lines.slice(0, DIFF_MAX_LINES) : lines;
  var rest = {};
  var remaining = 0;
  for (var key in parsed) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    if (used.indexOf(key) !== -1) continue;
    rest[key] = parsed[key];
    remaining += 1;
  }
  return {
    label: label,
    lines: shown,
    hidden: lines.length - shown.length,
    rest: remaining === 0 ? "" : JSON.stringify(rest)
  };
}

/**
 * How long a turn took, in the coarsest unit that still says something.
 *
 * Sub-second work reads in milliseconds, a minute of it does not: "94523ms"
 * is a number the reader has to do arithmetic on. Returns "" for anything
 * that is not a real elapsed time, and the caller then says nothing rather
 * than printing a placeholder.
 */
function formatElapsed(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  var seconds = ms / 1000;
  if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + "s";
  var minutes = Math.floor(seconds / 60);
  var rest = Math.round(seconds - minutes * 60);
  if (rest === 60) {
    minutes += 1;
    rest = 0;
  }
  if (minutes < 60) return minutes + "m " + rest + "s";
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}
`;
