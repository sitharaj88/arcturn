/**
 * The sidebar's markdown parser, shipped as source and tested as a function.
 *
 * ## Why this is a string
 *
 * The webview is a separate document whose only script is the nonce'd inline
 * block `webview-html.ts` emits. There is no bundler step for it, no second
 * asset in the VSIX, and no `import` it could resolve — so everything the page
 * runs has to arrive as text. That is the same reason `SIDEBAR_SCRIPT` is a
 * string; this module is a piece of it.
 *
 * ## Why that does not cost the tests
 *
 * The source defines one entry point, `parseMarkdown`, and returns *data* —
 * a tree of plain objects, no DOM anywhere. `webview-markdown.test.ts`
 * instantiates it with `new Function(MARKDOWN_SOURCE)` and drives the exact
 * bytes that ship, under `environment: "node"`, with no jsdom. The renderer
 * that walks the tree into elements stays in `webview-client.ts`, where it is
 * mechanical: one `createElement` per node kind.
 *
 * ## Why the tree, and not a string of HTML
 *
 * `webview-html.test.ts` asserts the client script contains no `innerHTML`.
 * That is not a style rule — assistant prose is model-controlled text, and a
 * markdown renderer that concatenates tags is one unescaped `<` away from
 * being an injection sink. Returning a tree makes the unsafe version
 * unwritable: there is no place to put a tag, because the renderer only ever
 * calls `createElement` with a fixed tag name and `textContent` with model
 * text.
 *
 * For the same reason **raw HTML in the markdown is not passed through**. A
 * model that emits `<img onerror=…>` gets a paragraph containing those
 * characters, which is what a user asked to see when they asked to see the
 * model's answer.
 *
 * ## Written with `String.raw`
 *
 * The body below is JavaScript source, not a JavaScript string, so escapes in
 * it belong to the *webview's* parser and must survive this file untouched:
 * `\d` has to stay two characters. `String.raw` does that. The one cost is
 * that a literal backtick would end the template, so the source spells one
 * ``` — which is a backtick to the engine that finally runs it.
 */

/** One inline run inside a paragraph, heading, list item or quote. */
export type MarkdownInline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: MarkdownInline[] }
  | { t: "em"; c: MarkdownInline[] }
  | { t: "del"; c: MarkdownInline[] }
  | { t: "link"; href: string; c: MarkdownInline[] }
  | { t: "br" };

/**
 * A column's alignment, or `""` when the delimiter row asked for none.
 *
 * Empty rather than a name like "default", because the renderer's question is
 * "is there an alignment to set" and an empty string answers it directly.
 */
export type MarkdownAlign = "" | "left" | "center" | "right";

/** One item of a `list` block. `checked` is `null` unless it is a task item. */
export interface MarkdownItem {
  checked: boolean | null;
  c: MarkdownBlock[];
}

/**
 * One block. `code.open` marks a fence the stream has not closed yet, and
 * `code.file` the path its info string named — absent, not empty, when it
 * named none, so a renderer can ask rather than test for a blank.
 */
export type MarkdownBlock =
  | { t: "p"; c: MarkdownInline[] }
  | { t: "h"; level: number; c: MarkdownInline[] }
  | { t: "code"; lang: string; file?: string; v: string; open: boolean }
  | { t: "quote"; c: MarkdownBlock[] }
  | { t: "list"; ordered: boolean; start: number; items: MarkdownItem[] }
  | { t: "table"; align: MarkdownAlign[]; head: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { t: "hr" };

/** JavaScript source defining `parseMarkdown(text) -> MarkdownBlock[]`. */
export const MARKDOWN_SOURCE = String.raw`/* --- shared helpers -------------------------------------------------- */

/**
 * A backtick.
 *
 * Spelled as an escape rather than typed, because this whole file is a
 * template literal in webview-markdown.ts and a literal one would end it.
 */
var MD_TICK = "\u0060";

/*
 * The info string is everything after the marker, not just the first word.
 * This used to be a single no-whitespace token anchored to end-of-line, which
 * meant that the moment a model opened a fence with "ts src/foo.ts" after the
 * markers — as they do, and as CommonMark allows — the line was not a fence at
 * all, and forty lines of TypeScript rendered as a paragraph with the markers
 * in it. A backtick fence's info string may not contain a backtick; that is the
 * one thing still excluded.
 */
var MD_FENCE = new RegExp("^ {0,3}(" + MD_TICK + "{3,}|~{3,})[ \\t]*([^" + MD_TICK + "]*)$");
var MD_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
var MD_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
var MD_QUOTE = /^ {0,3}>[ \t]?/;
var MD_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
var MD_TASK = /^\[([ xX])\][ \t]+(.*)$/;
var MD_BARE_URL = new RegExp("https?://[^\\s<>" + MD_TICK + "\\[\\]()]+", "y");
var MD_AUTOLINK = /^(?:https?:\/\/|mailto:)[^\s<>]+$/i;
var MD_ESCAPABLE = "\\" + MD_TICK + "*_{}[]()#+-.!>~|";

/** Deep nesting is a denial-of-service shape, not a document. */
var MD_MAX_DEPTH = 12;

function mdIndent(line) {
  var count = 0;
  while (count < line.length && line.charAt(count) === " ") count += 1;
  return count;
}

/**
 * A link target the page is willing to make clickable.
 *
 * Allowlisted by scheme, not denylisted: 'http', 'https' and 'mailto' are the
 * three a VS Code webview can actually hand to the workbench, and everything
 * else — 'javascript:', 'data:', 'vbscript:', a bare relative path — is
 * rendered as the characters the model sent. Returning "" is the caller's
 * signal to fall through and emit literal text, which is why an unsafe link
 * reads as its own markdown source rather than silently losing its target.
 *
 * Control characters are stripped before the scheme is tested, so
 * "java\tscript:" cannot smuggle a scheme past the check; the *returned* href
 * is the untouched first whitespace-delimited run, so nothing is rewritten.
 */
function mdSafeHref(raw) {
  var href = String(raw == null ? "" : raw).trim().split(/\s+/)[0];
  if (!href) return "";
  var probe = href.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (probe.indexOf("http://") === 0) return href;
  if (probe.indexOf("https://") === 0) return href;
  if (probe.indexOf("mailto:") === 0) return href;
  return "";
}

/**
 * A fence info token that names a file, or "".
 *
 * A path or something with an extension — nothing else. The point is to be
 * unable to mistake a language for a filename: "ts" is not a file, "src/a.ts"
 * and "Dockerfile.dev" are. Quotes are stripped because 'title="a/b.js"' is
 * one of the shapes that actually arrives.
 */
function mdFenceFile(token) {
  var value = String(token == null ? "" : token).replace(/^["']+|["']+$/g, "");
  if (value === "" || value.length > 200) return "";
  if (value.indexOf("/") !== -1 || value.indexOf("\\") !== -1) return value;
  return /^[\w.@+-]+\.[A-Za-z0-9]{1,8}$/.test(value) ? value : "";
}

/**
 * Split a fence info string into a language and, if it carries one, a path.
 *
 * Four shapes, because four are what models emit: "ts", "ts src/a.ts",
 * "ts:src/a.ts", and "js title=\"app/main.js\"". A bare path on its own
 * ("src/a.py") names its language by extension. Anything unrecognised stays
 * the language, which is the old behaviour and the safe one — a label the
 * reader does not recognise beats a filename row invented out of it.
 */
function mdFenceInfo(info) {
  var text = String(info == null ? "" : info).trim();
  if (text === "") return { lang: "", file: "" };
  var parts = text.split(/[ \t]+/);
  var head = parts[0];
  var file = "";

  var colon = head.indexOf(":");
  if (colon > 0) {
    var tail = mdFenceFile(head.slice(colon + 1));
    if (tail !== "") {
      file = tail;
      head = head.slice(0, colon);
    }
  }
  if (file === "") {
    var bare = mdFenceFile(head);
    if (bare !== "") {
      file = bare;
      var dot = bare.lastIndexOf(".");
      head = dot === -1 ? "" : bare.slice(dot + 1);
    }
  }
  for (var i = 1; i < parts.length && file === ""; i += 1) {
    var eq = parts[i].indexOf("=");
    file = mdFenceFile(eq === -1 ? parts[i] : parts[i].slice(eq + 1));
  }
  return { lang: head.toLowerCase(), file: file };
}

/* --- inline ---------------------------------------------------------- */

/** Index of a run of exactly 'run' backticks at or after 'from'. */
function mdFindTickRun(text, from, run) {
  var i = from;
  while (i < text.length) {
    if (text.charAt(i) === MD_TICK) {
      var n = 1;
      while (text.charAt(i + n) === MD_TICK) n += 1;
      if (n === run) return i;
      i += n;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Index of the closing 'marker', skipping escapes and code spans.
 *
 * Skipping code spans is what keeps '**a 'b**' c' from closing its bold run
 * inside the code — the same reason the scanner below handles code first.
 */
function mdFindClose(text, from, marker) {
  var i = from;
  while (i < text.length) {
    var ch = text.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === MD_TICK) {
      var run = 1;
      while (text.charAt(i + run) === MD_TICK) run += 1;
      var end = mdFindTickRun(text, i + run, run);
      i = end === -1 ? i + run : end + run;
      continue;
    }
    if (text.slice(i, i + marker.length) === marker) return i;
    i += 1;
  }
  return -1;
}

/** Index of the ']' matching the '[' at 'from', or -1. */
function mdMatchBracket(text, from) {
  var depth = 0;
  for (var i = from; i < text.length; i += 1) {
    var ch = text.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the ')' matching the '(' at 'from', or -1. Nesting counts. */
function mdMatchParen(text, from) {
  var depth = 0;
  for (var i = from; i < text.length; i += 1) {
    var ch = text.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function mdIsWordChar(ch) {
  return ch !== "" && /[A-Za-z0-9]/.test(ch);
}

/**
 * One run of inline markup into nodes.
 *
 * Every construct that fails to close falls through to the text buffer *whole*
 * — a run of n asterisks with no partner is consumed as n characters, not one
 * — which is both what a reader expects mid-stream and what keeps a line of
 * 2000 asterisks from costing O(n^2).
 */
function mdInline(text, depth) {
  var nodes = [];
  var buffer = "";
  var i = 0;
  var value = String(text == null ? "" : text);

  function flush() {
    if (buffer !== "") {
      nodes.push({ t: "text", v: buffer });
      buffer = "";
    }
  }

  if (depth > MD_MAX_DEPTH) return value === "" ? [] : [{ t: "text", v: value }];

  while (i < value.length) {
    var ch = value.charAt(i);

    if (ch === "\\") {
      var next = value.charAt(i + 1);
      if (next === "\n") {
        flush();
        nodes.push({ t: "br" });
        i += 2;
        continue;
      }
      if (next !== "" && MD_ESCAPABLE.indexOf(next) !== -1) {
        buffer += next;
        i += 2;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    if (ch === "\n") {
      if (/ {2,}$/.test(buffer)) {
        buffer = buffer.replace(/ +$/, "");
        flush();
        nodes.push({ t: "br" });
      } else {
        buffer += "\n";
      }
      i += 1;
      continue;
    }

    if (ch === MD_TICK) {
      var run = 1;
      while (value.charAt(i + run) === MD_TICK) run += 1;
      var codeEnd = mdFindTickRun(value, i + run, run);
      if (codeEnd !== -1) {
        var code = value.slice(i + run, codeEnd);
        if (code.length > 1 && code.charAt(0) === " " && code.charAt(code.length - 1) === " ") {
          code = code.slice(1, -1);
        }
        flush();
        nodes.push({ t: "code", v: code });
        i = codeEnd + run;
        continue;
      }
      buffer += MD_TICK.repeat(run);
      i += run;
      continue;
    }

    if (ch === "[") {
      var bracketEnd = mdMatchBracket(value, i);
      if (bracketEnd !== -1 && value.charAt(bracketEnd + 1) === "(") {
        var parenEnd = mdMatchParen(value, bracketEnd + 1);
        if (parenEnd !== -1) {
          var href = mdSafeHref(value.slice(bracketEnd + 2, parenEnd));
          if (href !== "") {
            flush();
            nodes.push({
              t: "link",
              href: href,
              c: mdInline(value.slice(i + 1, bracketEnd), depth + 1)
            });
            i = parenEnd + 1;
            continue;
          }
        }
      }
      buffer += ch;
      i += 1;
      continue;
    }

    if (ch === "<") {
      var gt = value.indexOf(">", i + 1);
      if (gt !== -1) {
        var inner = value.slice(i + 1, gt);
        if (MD_AUTOLINK.test(inner)) {
          var autoHref = mdSafeHref(inner);
          if (autoHref !== "") {
            flush();
            nodes.push({ t: "link", href: autoHref, c: [{ t: "text", v: inner }] });
            i = gt + 1;
            continue;
          }
        }
      }
      buffer += ch;
      i += 1;
      continue;
    }

    if (ch === "h" || ch === "H") {
      MD_BARE_URL.lastIndex = i;
      var bare = MD_BARE_URL.exec(value);
      if (bare && bare.index === i) {
        var url = bare[0].replace(/[.,;:!?'"]+$/, "");
        var bareHref = mdSafeHref(url);
        if (bareHref !== "") {
          flush();
          nodes.push({ t: "link", href: bareHref, c: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      var runLen = 1;
      while (value.charAt(i + runLen) === ch) runLen += 1;
      var want = ch === "~" ? 2 : runLen >= 2 ? 2 : 1;
      var openable = runLen >= want;
      // An underscore inside a word is a word, not emphasis: snake_case_names
      // are ordinary prose in a coding assistant.
      if (ch === "_" && mdIsWordChar(value.charAt(i - 1))) openable = false;
      if (openable) {
        var marker = ch.repeat(want);
        var closeAt = mdFindClose(value, i + runLen, marker);
        if (closeAt !== -1 && !(ch === "_" && mdIsWordChar(value.charAt(closeAt + want)))) {
          flush();
          var body = mdInline(value.slice(i + runLen, closeAt), depth + 1);
          nodes.push(
            ch === "~"
              ? { t: "del", c: body }
              : want === 2
                ? { t: "strong", c: body }
                : { t: "em", c: body }
          );
          i = closeAt + want;
          continue;
        }
      }
      buffer += ch.repeat(runLen);
      i += runLen;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return nodes;
}

/* --- blocks ---------------------------------------------------------- */

function mdIsFenceClose(line, marker) {
  var trimmed = line.trim();
  if (trimmed.length < marker.length) return false;
  var ch = marker.charAt(0);
  for (var i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charAt(i) !== ch) return false;
  }
  return true;
}

/**
 * One row of a table, split on the pipes that are actually separators.
 *
 * A leading and a trailing pipe are the table's own frame, not empty cells at
 * each end, so they come off first. Inside, a backslash-escaped pipe is data
 * and is carried through with its backslash intact — the inline pass owns
 * every escape in this file, and a second place that resolved them would be a
 * second place to get them wrong.
 */
function mdTableCells(line) {
  var text = line.trim();
  if (text.charAt(0) === "|") text = text.slice(1);
  if (text.length > 0 && text.charAt(text.length - 1) === "|" && text.charAt(text.length - 2) !== "\\") {
    text = text.slice(0, -1);
  }
  var cells = [];
  var buffer = "";
  for (var i = 0; i < text.length; i += 1) {
    var ch = text.charAt(i);
    if (ch === "\\" && text.charAt(i + 1) === "|") {
      buffer += "\\|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  cells.push(buffer.trim());
  return cells;
}

/**
 * The alignments a delimiter row asks for, or null if it is not one.
 *
 * This is the whole test for whether a line of pipes is a table: the row of
 * dashes underneath. Prose is full of pipes and none of it is followed by
 * one of these.
 */
function mdTableAlign(cells) {
  var align = [];
  for (var i = 0; i < cells.length; i += 1) {
    var cell = cells[i];
    if (!/^:?-+:?$/.test(cell)) return null;
    var left = cell.charAt(0) === ":";
    var right = cell.charAt(cell.length - 1) === ":";
    align.push(left && right ? "center" : right ? "right" : left ? "left" : "");
  }
  return align;
}

/**
 * A GitHub-flavoured table starting at 'from', or null.
 *
 * Two guards keep prose out. The delimiter row has to carry a pipe of its
 * own, which is what stops a paragraph that happens to end in a pipe from
 * capturing the horizontal rule under it. And its cell count has to match the
 * header's, as GFM requires — a mismatch is a coincidence, not a table.
 *
 * Body rows are padded and truncated to the header's width, because a ragged
 * row is the common shape of a table a model is still writing, and dropping
 * the row entirely would make the transcript flicker as it arrives.
 */
function mdTableAt(lines, from, depth) {
  if (from + 1 >= lines.length) return null;
  if (lines[from].indexOf("|") === -1) return null;
  if (lines[from + 1].indexOf("|") === -1) return null;
  var head = mdTableCells(lines[from]);
  var align = mdTableAlign(mdTableCells(lines[from + 1]));
  if (align === null || align.length !== head.length) return null;

  var rows = [];
  var i = from + 2;
  while (i < lines.length && lines[i].trim() !== "" && !mdStartsBlock(lines[i])) {
    var cells = mdTableCells(lines[i]);
    var row = [];
    for (var c = 0; c < head.length; c += 1) {
      row.push(mdInline(c < cells.length ? cells[c] : "", depth + 1));
    }
    rows.push(row);
    i += 1;
  }

  var headInline = [];
  for (var h = 0; h < head.length; h += 1) headInline.push(mdInline(head[h], depth + 1));
  return { block: { t: "table", align: align, head: headInline, rows: rows }, next: i };
}

function mdStartsBlock(line) {
  return (
    MD_FENCE.test(line) ||
    MD_HEADING.test(line) ||
    MD_HR.test(line) ||
    MD_QUOTE.test(line) ||
    MD_ITEM.test(line)
  );
}

/**
 * The lines belonging to a list that starts at 'from'.
 *
 * A line belongs while it is indented past the marker, is another item at the
 * same indent, or is a lazy continuation of the item's paragraph. A blank line
 * belongs only when something below it still does — which is what ends the
 * list at "- a\n\nb" and keeps it going at "- a\n\n- b".
 */
function mdCollectList(lines, from, baseIndent) {
  var out = [];
  var i = from;
  while (i < lines.length) {
    var line = lines[i];
    if (line.trim() === "") {
      var k = i;
      while (k < lines.length && lines[k].trim() === "") k += 1;
      if (k >= lines.length) break;
      var followIndent = mdIndent(lines[k]);
      var followIsItem = MD_ITEM.test(lines[k]);
      if (followIndent > baseIndent || (followIsItem && followIndent === baseIndent)) {
        while (i < k) {
          out.push("");
          i += 1;
        }
        continue;
      }
      break;
    }
    var indent = mdIndent(line);
    if (indent < baseIndent) break;
    if (indent === baseIndent && !MD_ITEM.test(line) && mdStartsBlock(line)) break;
    out.push(line);
    i += 1;
  }
  return { lines: out, next: i };
}

function mdDedent(line, width) {
  var cut = 0;
  while (cut < width && line.charAt(cut) === " ") cut += 1;
  return line.slice(cut);
}

function mdListItems(listLines, baseIndent, depth) {
  var raw = [];
  var current = null;
  for (var i = 0; i < listLines.length; i += 1) {
    var line = listLines[i];
    var match = line.trim() === "" ? null : MD_ITEM.exec(line);
    if (match && match[1].length === baseIndent) {
      current = {
        width: match[1].length + match[2].length + match[3].length,
        lines: [match[4]]
      };
      raw.push(current);
      continue;
    }
    if (current === null) continue;
    current.lines.push(mdDedent(line, current.width));
  }

  var items = [];
  for (var j = 0; j < raw.length; j += 1) {
    var body = raw[j].lines.slice();
    var checked = null;
    var task = MD_TASK.exec(body[0] || "");
    if (task) {
      checked = task[1] !== " ";
      body[0] = task[2];
    }
    items.push({ checked: checked, c: mdBlocks(body, depth + 1) });
  }
  return items;
}

function mdBlocks(lines, depth) {
  var blocks = [];
  var i = 0;
  if (depth > MD_MAX_DEPTH) {
    var flat = lines.join("\n").trim();
    return flat === "" ? [] : [{ t: "p", c: [{ t: "text", v: flat }] }];
  }

  while (i < lines.length) {
    var line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    var fence = MD_FENCE.exec(line);
    if (fence) {
      var marker = fence[1];
      var body = [];
      var closed = false;
      i += 1;
      while (i < lines.length) {
        if (mdIsFenceClose(lines[i], marker)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      var mdInfo = mdFenceInfo(fence[2] || "");
      var mdCode = { t: "code", lang: mdInfo.lang, v: body.join("\n"), open: !closed };
      if (mdInfo.file !== "") mdCode.file = mdInfo.file;
      blocks.push(mdCode);
      continue;
    }

    var heading = MD_HEADING.exec(line);
    if (heading) {
      blocks.push({
        t: "h",
        level: heading[1].length,
        c: mdInline(heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim(), depth + 1)
      });
      i += 1;
      continue;
    }

    if (MD_HR.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }

    if (MD_QUOTE.test(line)) {
      var quoted = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(MD_QUOTE, ""));
        i += 1;
      }
      blocks.push({ t: "quote", c: mdBlocks(quoted, depth + 1) });
      continue;
    }

    var item = MD_ITEM.exec(line);
    if (item) {
      var baseIndent = item[1].length;
      var ordered = /^\d/.test(item[2]);
      var collected = mdCollectList(lines, i, baseIndent);
      blocks.push({
        t: "list",
        ordered: ordered,
        start: ordered ? parseInt(item[2], 10) : 1,
        items: mdListItems(collected.lines, baseIndent, depth)
      });
      i = collected.next;
      continue;
    }

    var table = mdTableAt(lines, i, depth);
    if (table !== null) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    var paragraph = [];
    while (i < lines.length && lines[i].trim() !== "" && !mdStartsBlock(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length === 0) {
      // A block opener that no branch above claimed; take it as prose so the
      // loop always advances.
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ t: "p", c: mdInline(paragraph.join("\n").trim(), depth + 1) });
  }
  return blocks;
}

/**
 * Markdown to a tree of plain objects.
 *
 * Tabs at the head of a line become two spaces first, so the list nesting
 * rules have one unit to count in.
 *
 * @param text Assistant prose, possibly mid-stream and unterminated.
 */
function parseMarkdown(text) {
  var source = String(text == null ? "" : text);
  var lines = source.split(/\r\n|\r|\n/);
  for (var i = 0; i < lines.length; i += 1) {
    lines[i] = lines[i].replace(/^\t+/, function (tabs) {
      return "  ".repeat(tabs.length);
    });
  }
  return mdBlocks(lines, 0);
}
`;
