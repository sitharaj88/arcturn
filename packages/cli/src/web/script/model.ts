/**
 * The browser client's **pure** half: an `AgentEvent` reducer and a DOM-less
 * renderer that turns the reduced state into a tree of plain description
 * objects ("vnodes"), plus the small formatting helpers both halves share.
 *
 * ## Why this is a string
 *
 * The page must be a single self-contained HTML file with no build step (see
 * `page.ts`), so the browser half cannot be a normal TypeScript module — it
 * has to reach the browser as literal script text. Keeping it as one exported
 * constant means the shipped `dist/` artifact *is* the tested artifact: the
 * tests load this exact string with `new Function` and call the functions it
 * defines, so nothing can drift between what is tested and what is served.
 *
 * ## Why vnodes, not HTML
 *
 * Every value that reaches this module — assistant markdown, tool output,
 * diffs, permission subjects, session ids — is model- or tool-authored and is
 * assumed hostile. Nothing here ever produces markup: a vnode carries a `tag`,
 * a class name, optional attributes and either children or a plain `text`
 * string, and `app.ts`'s mounter is the only code that touches the DOM, using
 * `createElement` + `textContent` exclusively. Injection is therefore
 * structurally impossible rather than escaped-away, and the boundary is
 * testable without a DOM (see `model.test.ts` / `xss.test.ts`).
 *
 * The script is written in conservative ES5-style JavaScript with no template
 * literals — the constant below is itself a TypeScript template literal, so a
 * backtick or `${` inside it would terminate or interpolate the string.
 *
 * @packageDocumentation
 */

/**
 * Browser source text defining `globalThis.ArcturnWeb.model`.
 *
 * Loading it has no side effects beyond assigning that namespace: it touches
 * no DOM API, so it evaluates cleanly inside a test harness.
 */
export const MODEL_SCRIPT = `
(function (root) {
  "use strict";

  var TOOL_GLYPHS = {
    read: "\\u25c7", write: "\\u270e", edit: "\\u270e", bash: "\\u276f",
    grep: "\\u2315", glob: "\\u2315", ls: "\\u25b8", fetch: "\\u2913",
    websearch: "\\u2316", symbols: "\\u25c8", memory: "\\u2756", todo: "\\u2630",
    plan: "\\u2727", subagent: "\\u2318"
  };
  var TOOL_GLYPH_DEFAULT = "\\u25c7";
  var TODO_MARKS = { pending: "\\u2610", inProgress: "\\u25d0", done: "\\u2611" };
  var MARK = {
    dot: "\\u25cf", result: "\\u23bf", info: "\\u2139", warn: "\\u26a0",
    error: "\\u2717", done: "\\u2713", interrupt: "\\u2298", plan: "\\u2727",
    nested: "\\u21b3", ellipsis: "\\u22ef"
  };
  var SPINNER = ["\\u280b", "\\u2819", "\\u2839", "\\u2838", "\\u283c", "\\u2834",
    "\\u2826", "\\u2827", "\\u2807", "\\u280f"];
  var SUBJECT_KEYS = ["command", "file_path", "filePath", "path", "url", "pattern",
    "query", "target"];
  var MAX_TAIL_LINES = 8;
  var MAX_SAMPLE_LINES = 4;
  var MAX_DIFF_ROWS = 40;
  var MAX_BLOCKS = 400;
  var ELAPSED_THRESHOLD_MS = 1000;

  /* ------------------------------------------------------------------ vnodes */

  function node(tag, cls, children) {
    return { tag: tag, cls: cls || "", children: children || [] };
  }

  function text(tag, cls, value) {
    return {
      tag: tag,
      cls: cls || "",
      text: value === null || value === undefined ? "" : String(value),
      children: []
    };
  }

  function attrs(target, extra) {
    target.attrs = extra;
    return target;
  }

  /* --------------------------------------------------------------- helpers */

  function toolGlyph(name) {
    return Object.prototype.hasOwnProperty.call(TOOL_GLYPHS, name)
      ? TOOL_GLYPHS[name]
      : TOOL_GLYPH_DEFAULT;
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** Mirrors core's defaultSubject: the first well-known argument that names one. */
  function subjectOf(input) {
    if (!isRecord(input)) return "";
    for (var i = 0; i < SUBJECT_KEYS.length; i++) {
      var value = input[SUBJECT_KEYS[i]];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return "";
  }

  /** Flatten a message/tool-result content array to text, naming images. */
  function contentText(content) {
    if (!content || typeof content.length !== "number") return "";
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var block = content[i];
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "image") parts.push("[" + (block.mimeType || "image") + "]");
    }
    return parts.join("\\n");
  }

  function nonEmptyLines(value) {
    var lines = String(value === null || value === undefined ? "" : value).split("\\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== "") out.push(lines[i]);
    }
    return out;
  }

  function oneLine(value, max) {
    var flat = String(value === null || value === undefined ? "" : value)
      .replace(/\\s+/g, " ")
      .trim();
    var limit = max || 80;
    return flat.length <= limit ? flat : flat.slice(0, Math.max(0, limit - 1)) + "\\u2026";
  }

  function formatDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "0s";
    var seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + "s";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m" + String(seconds % 60).padStart(2, "0") + "s";
    var hours = Math.floor(minutes / 60);
    return hours + "h" + String(minutes % 60).padStart(2, "0") + "m";
  }

  function formatTokens(tokens) {
    if (typeof tokens !== "number" || !isFinite(tokens) || tokens < 0) return "0";
    if (tokens < 1000) return String(Math.round(tokens));
    if (tokens < 1000000) return (tokens / 1000).toFixed(1) + "k";
    return (tokens / 1000000).toFixed(2) + "M";
  }

  function detail(result, key) {
    return result && isRecord(result.details) ? result.details[key] : undefined;
  }

  /**
   * Reconnect delay for attempt N (0-based), exponential with jitter.
   * Deterministic when a random source is injected, so it is testable.
   */
  function backoffDelay(attempt, options, random) {
    var opts = options || {};
    var base = typeof opts.baseMs === "number" ? opts.baseMs : 500;
    var max = typeof opts.maxMs === "number" ? opts.maxMs : 15000;
    var jitter = typeof opts.jitter === "number" ? opts.jitter : 0.25;
    var pick = typeof random === "function" ? random : Math.random;
    var n = typeof attempt === "number" && attempt > 0 ? Math.min(attempt, 30) : 0;
    var raw = Math.min(max, base * Math.pow(2, n));
    var spread = raw * jitter;
    return Math.round(Math.max(0, raw - spread + pick() * spread * 2));
  }

  /**
   * Whether an approve button may be enabled: a subject the user has not been
   * able to read in full must never be approvable.
   */
  function approvalGate(view) {
    if (!view || view.scrollable !== true) return true;
    return view.atBottom === true;
  }

  /** Mirrors the CLI's suggestRule so "allow always" persists the same rule. */
  function suggestRule(request) {
    var req = request || {};
    var subject = typeof req.subject === "string" ? req.subject : "";
    var toolName = typeof req.toolName === "string" ? req.toolName : "";
    if (subject !== "" && toolName === "bash") {
      var head = subject.trim().split(/\\s+/)[0] || subject;
      return { tool: "bash", specifier: head + " *", action: "allow" };
    }
    if (isRecord(req.suggestedRule)) {
      return {
        tool: req.suggestedRule.tool,
        specifier: req.suggestedRule.specifier,
        action: req.suggestedRule.action || "allow"
      };
    }
    if (subject === "") return { tool: toolName, action: "allow" };
    return { tool: toolName, specifier: subject, action: "allow" };
  }

  /* ---------------------------------------------------------------- diffs */

  var HUNK_HEADER = /^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/;

  /** Parse a unified diff into numbered rows (mirrors display.ts's parseDiff). */
  function parseDiff(raw) {
    var source = String(raw === null || raw === undefined ? "" : raw);
    if (!/^@@ /m.test(source)) return null;
    var rows = [];
    var newNo = 0;
    var sawHunk = false;
    var lines = source.split("\\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var hunk = HUNK_HEADER.exec(line);
      if (hunk) {
        newNo = Number(hunk[1]);
        if (sawHunk) rows.push({ kind: " ", lineNo: null, text: "", separator: true });
        sawHunk = true;
        continue;
      }
      if (!sawHunk || line.indexOf("+++") === 0 || line.indexOf("---") === 0 ||
        line.indexOf("\\\\") === 0) {
        continue;
      }
      if (line.charAt(0) === "+") rows.push({ kind: "+", lineNo: newNo++, text: line });
      else if (line.charAt(0) === "-") rows.push({ kind: "-", lineNo: null, text: line });
      else rows.push({ kind: " ", lineNo: newNo++, text: line });
    }
    return rows;
  }

  /* ------------------------------------------------------------- markdown */

  var FENCE = /^\\s*(?:\`\`\`|~~~)(.*)$/;
  var HEADING = /^(#{1,6})\\s+(.*)$/;
  var BULLET = /^\\s*[-*+]\\s+(.*)$/;
  var ORDERED = /^\\s*(\\d+)[.)]\\s+(.*)$/;
  var QUOTE = /^\\s*>\\s?(.*)$/;
  var RULE = /^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$/;
  var INLINE = /(\`[^\`]+\`)|(\\*\\*[^*]+\\*\\*)|(__[^_]+__)|(\\[[^\\]]*\\]\\([^)\\s]*\\))/;

  /**
   * Inline markdown to vnodes. Links become their label plus a muted URL
   * *as text* — never an anchor — so a "javascript:" target can never become
   * clickable.
   */
  function inlineNodes(source) {
    var out = [];
    var rest = String(source === null || source === undefined ? "" : source);
    while (rest.length > 0) {
      var match = INLINE.exec(rest);
      if (!match) {
        out.push(text("span", "", rest));
        break;
      }
      if (match.index > 0) out.push(text("span", "", rest.slice(0, match.index)));
      var token = match[0];
      if (token.charAt(0) === "\`") {
        out.push(text("code", "", token.slice(1, -1)));
      } else if (token.indexOf("**") === 0 || token.indexOf("__") === 0) {
        out.push(text("strong", "", token.slice(2, -2)));
      } else {
        var split = token.indexOf("](");
        var label = token.slice(1, split);
        var href = token.slice(split + 2, -1);
        out.push(text("span", "", label === "" ? href : label));
        if (href !== "" && href !== label) out.push(text("span", "url", " (" + href + ")"));
      }
      rest = rest.slice(match.index + token.length);
    }
    return out;
  }

  /** A minimal block-level markdown renderer producing vnodes. */
  function markdownNodes(source) {
    var lines = String(source === null || source === undefined ? "" : source).split("\\n");
    var out = [];
    var paragraph = [];
    var list = null;
    var quote = null;

    function flushParagraph() {
      if (paragraph.length === 0) return;
      out.push(node("p", "", inlineNodes(paragraph.join(" "))));
      paragraph = [];
    }
    function flushList() {
      if (!list) return;
      out.push(node(list.tag, "", list.items));
      list = null;
    }
    function flushQuote() {
      if (!quote) return;
      out.push(node("blockquote", "", inlineNodes(quote.join(" "))));
      quote = null;
    }
    function flushAll() {
      flushParagraph();
      flushList();
      flushQuote();
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = FENCE.exec(line);
      if (fence) {
        flushAll();
        var body = [];
        i++;
        while (i < lines.length && !FENCE.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        out.push(text("pre", "", body.join("\\n")));
        continue;
      }
      if (line.trim() === "") {
        flushAll();
        continue;
      }
      if (RULE.test(line)) {
        flushAll();
        out.push(node("hr", "", []));
        continue;
      }
      var heading = HEADING.exec(line);
      if (heading) {
        flushAll();
        var level = heading[1].length;
        var tag = level <= 1 ? "h3" : level === 2 ? "h4" : "h5";
        out.push(node(tag, "", inlineNodes(heading[2])));
        continue;
      }
      var quoted = QUOTE.exec(line);
      if (quoted) {
        flushParagraph();
        flushList();
        if (!quote) quote = [];
        quote.push(quoted[1]);
        continue;
      }
      var bullet = BULLET.exec(line);
      var ordered = bullet ? null : ORDERED.exec(line);
      if (bullet || ordered) {
        flushParagraph();
        flushQuote();
        var wanted = bullet ? "ul" : "ol";
        if (!list || list.tag !== wanted) {
          flushList();
          list = { tag: wanted, items: [] };
        }
        list.items.push(node("li", "", inlineNodes(bullet ? bullet[1] : ordered[2])));
        continue;
      }
      flushList();
      flushQuote();
      paragraph.push(line);
    }
    flushAll();
    return out;
  }

  /* ------------------------------------------------------------------ state */

  /** A fresh, empty view state for one session. */
  function createState() {
    return {
      blocks: [],
      tools: {},
      subagents: {},
      todos: [],
      permissions: [],
      running: false,
      runStartedAt: -1,
      streaming: false,
      streamText: "",
      tokens: 0,
      seq: 0,
      dropped: 0
    };
  }

  function push(state, block) {
    state.seq += 1;
    block.key = "b" + state.seq;
    block.rev = 0;
    state.blocks.push(block);
    if (state.blocks.length > MAX_BLOCKS) {
      state.dropped += state.blocks.length - MAX_BLOCKS;
      state.blocks = state.blocks.slice(state.blocks.length - MAX_BLOCKS);
    }
    return block;
  }

  function bump(block) {
    if (block) block.rev += 1;
    return block;
  }

  function noticeBlock(state, level, value) {
    return push(state, { kind: "notice", level: level, text: String(value) });
  }

  /** Summarize a finished tool call the way display.ts does. */
  function summarize(name, result) {
    var body = contentText(result ? result.content : []);
    if (result && result.isError === true) {
      var lines = nonEmptyLines(body).slice(0, 4);
      return { kind: "error", lines: lines.length > 0 ? lines : ["failed"] };
    }
    if (name === "edit") {
      var raw = detail(result, "diff");
      if (typeof raw === "string" && raw.trim() !== "") {
        var rows = parseDiff(raw);
        var path = detail(result, "path");
        if (rows) {
          var added = 0;
          var removed = 0;
          for (var i = 0; i < rows.length; i++) {
            if (rows[i].kind === "+") added++;
            else if (rows[i].kind === "-") removed++;
          }
          return {
            kind: "diff",
            path: typeof path === "string" ? path : "",
            added: added,
            removed: removed,
            rows: rows.slice(0, MAX_DIFF_ROWS),
            hidden: Math.max(0, rows.length - MAX_DIFF_ROWS)
          };
        }
        return {
          kind: "diff",
          path: typeof path === "string" ? path : "",
          added: 0,
          removed: 0,
          rows: plainDiffRows(raw).slice(0, MAX_DIFF_ROWS),
          hidden: Math.max(0, plainDiffRows(raw).length - MAX_DIFF_ROWS)
        };
      }
      return tailResult(body);
    }
    if (name === "write") {
      var wpath = detail(result, "path");
      if (typeof wpath === "string") {
        var bytes = detail(result, "bytes");
        var verb = detail(result, "created") === true ? "created" : "updated";
        return {
          kind: "ok",
          lines: [verb + " " + wpath + (typeof bytes === "number" ? " (" + bytes + " bytes)" : "")]
        };
      }
      return tailResult(body);
    }
    if (name === "read") {
      var total = detail(result, "totalLines");
      var start = detail(result, "startLine");
      var end = detail(result, "endLine");
      var count = typeof total === "number" ? total : body.split("\\n").length;
      var range = typeof start === "number" && typeof end === "number" &&
        (start > 1 || end < count) ? " (showing " + start + "-" + end + ")" : "";
      return { kind: "summary", lines: [count + (count === 1 ? " line" : " lines") + range] };
    }
    if (name === "grep") {
      var matches = detail(result, "matchCount");
      if (typeof matches !== "number") return tailResult(body);
      if (matches === 0) return { kind: "summary", lines: ["no matches"] };
      var files = detail(result, "filesSearched");
      var searched = typeof files === "number"
        ? " \\u00b7 " + files + (files === 1 ? " file" : " files") + " searched"
        : "";
      return {
        kind: "summary",
        lines: [matches + (matches === 1 ? " match" : " matches") + searched],
        sample: nonEmptyLines(body).slice(0, MAX_SAMPLE_LINES),
        hidden: Math.max(0, nonEmptyLines(body).length - MAX_SAMPLE_LINES)
      };
    }
    if (name === "glob") {
      var globCount = detail(result, "matchCount");
      if (typeof globCount !== "number") return tailResult(body);
      if (globCount === 0) return { kind: "summary", lines: ["no files matched"] };
      return {
        kind: "summary",
        lines: [globCount + (globCount === 1 ? " file" : " files")],
        sample: nonEmptyLines(body).slice(0, MAX_SAMPLE_LINES),
        hidden: Math.max(0, nonEmptyLines(body).length - MAX_SAMPLE_LINES)
      };
    }
    if (name === "ls") {
      var entries = detail(result, "entryCount");
      if (typeof entries !== "number") return tailResult(body);
      return { kind: "summary", lines: [entries + (entries === 1 ? " entry" : " entries")] };
    }
    if (name === "fetch") {
      var status = detail(result, "status");
      if (typeof status !== "number") return tailResult(body);
      var contentType = detail(result, "contentType");
      var type = typeof contentType === "string" && contentType !== ""
        ? " \\u00b7 " + contentType : "";
      var truncated = detail(result, "truncated") === true ? " \\u00b7 truncated" : "";
      return { kind: "summary", lines: [status + type + truncated] };
    }
    if (name === "bash") {
      var tail = tailResult(body);
      var exitCode = detail(result, "exitCode");
      if (typeof exitCode === "number" && exitCode !== 0) tail.exit = exitCode;
      return tail;
    }
    return tailResult(body);
  }

  function plainDiffRows(raw) {
    var lines = String(raw).split("\\n");
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var kind = lines[i].charAt(0) === "+" ? "+" : lines[i].charAt(0) === "-" ? "-" : " ";
      rows.push({ kind: kind, lineNo: null, text: lines[i] });
    }
    return rows;
  }

  function tailResult(body) {
    var all = nonEmptyLines(body);
    if (all.length === 0) return { kind: "summary", lines: ["(no output)"] };
    var shown = all.length <= MAX_TAIL_LINES ? all : all.slice(all.length - MAX_TAIL_LINES);
    return { kind: "tail", lines: shown, hidden: all.length - shown.length };
  }

  /* ----------------------------------------------------------------- reduce */

  /**
   * Fold one AgentEvent into the view state. Returns the same state object,
   * mutated: the renderer diffs by block key + revision, not by identity.
   */
  function applyEvent(state, event, now) {
    if (!isRecord(event) || typeof event.type !== "string") return state;
    var at = typeof now === "number" ? now : Date.now();

    switch (event.type) {
      case "runStart": {
        state.running = true;
        state.runStartedAt = at;
        state.tokens = 0;
        var prompt = event.prompt;
        var value = prompt && prompt.role === "user" ? contentText(prompt.content).trim() : "";
        if (value !== "") push(state, { kind: "user", text: value });
        break;
      }
      case "messageStream": {
        var inner = event.event;
        if (!isRecord(inner)) break;
        if (inner.type === "textStart") {
          state.streaming = true;
          state.streamText = "";
        } else if (inner.type === "textDelta") {
          state.streaming = true;
          state.streamText += String(inner.delta === undefined ? "" : inner.delta);
        }
        break;
      }
      case "messageEnd": {
        state.streaming = false;
        state.streamText = "";
        var message = event.message;
        if (!isRecord(message)) break;
        var body = [];
        var content = message.content || [];
        for (var i = 0; i < content.length; i++) {
          if (content[i] && content[i].type === "text") body.push(content[i].text);
        }
        var joined = body.join("\\n").trim();
        if (joined !== "") push(state, { kind: "assistant", text: joined });
        if (message.stopReason === "error" && message.errorMessage) {
          noticeBlock(state, "error", message.errorMessage);
        }
        break;
      }
      case "toolStart": {
        var started = push(state, {
          kind: "tool",
          id: String(event.toolCallId),
          name: String(event.toolName),
          subject: subjectOf(event.input),
          status: "running",
          startedAt: at,
          elapsedMs: 0,
          result: null,
          progress: ""
        });
        state.tools[started.id] = started;
        break;
      }
      case "toolUpdate": {
        var updating = state.tools[String(event.toolCallId)];
        if (updating && isRecord(event.update) && typeof event.update.text === "string") {
          var merged = (updating.progress + event.update.text).split("\\n");
          updating.progress = merged.slice(Math.max(0, merged.length - MAX_TAIL_LINES)).join("\\n");
          bump(updating);
        }
        break;
      }
      case "toolEnd": {
        var result = event.result || {};
        var finished = state.tools[String(event.toolCallId)];
        if (!finished) {
          finished = push(state, {
            kind: "tool",
            id: String(event.toolCallId),
            name: String(result.toolName || "tool"),
            subject: "",
            status: "running",
            startedAt: at,
            elapsedMs: 0,
            result: null,
            progress: ""
          });
          state.tools[finished.id] = finished;
        }
        finished.status = result.isError === true ? "error" : "ok";
        finished.elapsedMs = Math.max(0, at - finished.startedAt);
        finished.result = summarize(finished.name, result);
        finished.progress = "";
        bump(finished);
        delete state.tools[finished.id];
        break;
      }
      case "permissionRequest": {
        var request = event.request;
        if (!isRecord(request) || typeof request.id !== "string") break;
        var known = false;
        for (var p = 0; p < state.permissions.length; p++) {
          if (state.permissions[p].id === request.id) known = true;
        }
        if (!known) state.permissions.push(request);
        var asking = state.tools[String(request.toolCallId)];
        if (asking) {
          asking.status = "asking";
          bump(asking);
        }
        break;
      }
      case "permissionDecision": {
        var decision = event.decision;
        if (!isRecord(decision)) break;
        state.permissions = state.permissions.filter(function (open) {
          return open.id !== decision.requestId;
        });
        if (decision.behavior === "deny") {
          noticeBlock(state, "warn", "Denied" +
            (decision.message ? ": " + decision.message : "."));
        }
        break;
      }
      case "todoUpdate": {
        state.todos = Array.isArray(event.todos) ? event.todos : [];
        break;
      }
      case "planUpdate": {
        push(state, { kind: "plan", text: String(event.plan === undefined ? "" : event.plan) });
        break;
      }
      case "subagentStart": {
        var agent = push(state, {
          kind: "subagent",
          agentId: String(event.agentId),
          task: String(event.task === undefined ? "" : event.task),
          steps: [],
          result: "",
          isError: false,
          done: false
        });
        state.subagents[agent.agentId] = agent;
        break;
      }
      case "subagentEvent": {
        var parent = state.subagents[String(event.agentId)];
        var child = event.event;
        if (!parent || !isRecord(child)) break;
        if (child.type === "toolStart") {
          var childSubject = subjectOf(child.input);
          parent.steps.push(String(child.toolName) +
            (childSubject === "" ? "" : " " + oneLine(childSubject, 90)));
          if (parent.steps.length > 8) parent.steps.shift();
          bump(parent);
        } else if (child.type === "notice" && child.level === "error") {
          parent.steps.push(String(child.text));
          bump(parent);
        }
        break;
      }
      case "subagentEnd": {
        var ended = state.subagents[String(event.agentId)];
        if (ended) {
          ended.done = true;
          ended.isError = event.isError === true;
          ended.result = String(event.resultText === undefined ? "" : event.resultText);
          bump(ended);
          delete state.subagents[ended.agentId];
        }
        break;
      }
      case "backgroundTaskStart": {
        noticeBlock(state, "info",
          "background " + event.taskId + ": " + oneLine(event.command, 90));
        break;
      }
      case "backgroundTaskEnd": {
        noticeBlock(state, "info", "background " + event.taskId + " exited" +
          (event.exitCode === null || event.exitCode === undefined
            ? "" : " (" + event.exitCode + ")"));
        break;
      }
      case "compactionStart": {
        noticeBlock(state, "muted", "Compacting conversation\\u2026");
        break;
      }
      case "compactionEnd": {
        noticeBlock(state, "muted", "Compacted context: " +
          Math.round(Number(event.tokensBefore || 0) / 1000) + "k \\u2192 " +
          Math.round(Number(event.tokensAfter || 0) / 1000) + "k tokens");
        break;
      }
      case "contextEdit": {
        noticeBlock(state, "muted", "Context edited: " +
          Number(event.elidedCount || 0) + " old tool result(s) elided (~" +
          Math.round(Number(event.charsSaved || 0) / 1000) + "k chars)");
        break;
      }
      case "turnEnd": {
        var usage = event.usage || {};
        state.tokens += Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
        break;
      }
      case "runEnd": {
        var elapsed = state.runStartedAt < 0 ? 0 : at - state.runStartedAt;
        state.running = false;
        state.runStartedAt = -1;
        state.streaming = false;
        state.streamText = "";
        state.subagents = {};
        if (event.reason === "error") {
          noticeBlock(state, "error", String(event.errorMessage || "The run failed."));
        } else if (event.reason === "aborted") {
          noticeBlock(state, "warn", "Interrupted.");
        } else {
          push(state, { kind: "done", elapsedMs: elapsed, tokens: state.tokens });
        }
        break;
      }
      case "notice": {
        noticeBlock(state, event.level === "warn" ? "warn"
          : event.level === "error" ? "error" : "info", String(event.text));
        break;
      }
      default:
        break;
    }
    return state;
  }

  /* --------------------------------------------------------------- rendering */

  function resultNodes(result) {
    if (!result) return [];
    if (result.kind === "diff") return [diffNode(result)];
    var cls = result.kind === "error" ? "result error"
      : result.kind === "ok" ? "result ok" : "result";
    var children = [];
    var lines = result.lines || [];
    for (var i = 0; i < lines.length; i++) {
      children.push(text("span", "line", (i === 0 ? MARK.result + " " : "  ") + lines[i]));
    }
    var sample = result.sample || [];
    for (var s = 0; s < sample.length; s++) {
      children.push(text("span", "line", "  " + sample[s]));
    }
    if (result.hidden > 0) {
      children.push(text("span", "line more",
        "  " + MARK.ellipsis + " " + result.hidden + " more lines"));
    }
    if (typeof result.exit === "number") {
      children.push(text("span", "line", "  exit " + result.exit));
    }
    return [node("div", cls, children)];
  }

  function diffNode(result) {
    var head = [];
    if (result.path !== "") head.push(text("span", "diff-path", result.path));
    if (result.added > 0) head.push(text("span", "diff-add", "+" + result.added));
    if (result.removed > 0) head.push(text("span", "diff-del", "-" + result.removed));
    var rows = [];
    if (head.length > 0) rows.push(node("div", "diff-head", head));
    for (var i = 0; i < result.rows.length; i++) {
      var row = result.rows[i];
      if (row.separator === true) {
        rows.push(node("div", "diff-row sep", [
          text("span", "diff-no", ""),
          text("span", "diff-text", MARK.ellipsis)
        ]));
        continue;
      }
      var cls = row.kind === "+" ? "diff-row add" : row.kind === "-" ? "diff-row del"
        : "diff-row ctx";
      rows.push(node("div", cls, [
        text("span", "diff-no", row.lineNo === null || row.lineNo === undefined
          ? "" : String(row.lineNo)),
        text("span", "diff-text", row.text === "" ? " " : row.text)
      ]));
    }
    if (result.hidden > 0) {
      rows.push(node("div", "diff-row sep", [
        text("span", "diff-no", ""),
        text("span", "diff-text", MARK.ellipsis + " " + result.hidden + " more diff lines")
      ]));
    }
    return node("div", "diff", rows);
  }

  function toolNode(block) {
    var head = [
      attrs(text("span", "tool-dot", MARK.dot), { "data-status": block.status }),
      text("span", "tool-glyph", toolGlyph(block.name)),
      text("span", "tool-name", block.name)
    ];
    if (block.subject !== "") head.push(text("span", "tool-subject", block.subject));
    if (block.status === "asking") head.push(text("span", "tool-elapsed", "needs permission"));
    else if (block.elapsedMs >= ELAPSED_THRESHOLD_MS) {
      head.push(text("span", "tool-elapsed", "\\u00b7 " + formatDuration(block.elapsedMs)));
    }
    var children = [node("div", "tool-head", head)];
    if (block.result) {
      children = children.concat(resultNodes(block.result));
    } else if (block.progress !== "") {
      children.push(text("div", "result", block.progress));
    }
    return node("div", "block tool", children);
  }

  function noticeNode(block) {
    var mark = block.level === "error" ? MARK.error
      : block.level === "warn" ? MARK.warn
        : block.level === "muted" ? MARK.dot : MARK.info;
    return node("div", "block notice " + block.level, [
      text("span", "mark", mark),
      text("span", "", block.text)
    ]);
  }

  function subagentNode(block) {
    var children = [
      node("div", "", [
        text("span", "tool-glyph", toolGlyph("subagent")),
        text("span", "task", " " + oneLine(block.task, 120))
      ])
    ];
    for (var i = 0; i < block.steps.length; i++) {
      children.push(text("span", "step", MARK.nested + " " + block.steps[i]));
    }
    if (block.done) {
      var lines = nonEmptyLines(block.result).slice(0, 6);
      children.push(node("div", block.isError ? "result error" : "result",
        lines.length === 0
          ? [text("span", "line", MARK.result + " (no result)")]
          : lines.map(function (line, index) {
            return text("span", "line", (index === 0 ? MARK.result + " " : "  ") + line);
          })));
    }
    return node("div", "block subagent", children);
  }

  /** One vnode per transcript block, each carrying its key and revision. */
  function transcriptNodes(state) {
    var out = [];
    for (var i = 0; i < state.blocks.length; i++) {
      var block = state.blocks[i];
      var vnode;
      if (block.kind === "user") vnode = text("div", "block user", block.text);
      else if (block.kind === "assistant") vnode = node("div", "block md", markdownNodes(block.text));
      else if (block.kind === "tool") vnode = toolNode(block);
      else if (block.kind === "notice") vnode = noticeNode(block);
      else if (block.kind === "subagent") vnode = subagentNode(block);
      else if (block.kind === "plan") {
        vnode = node("div", "block md", [text("h3", "", MARK.plan + " Plan")]
          .concat(markdownNodes(block.text)));
      } else if (block.kind === "done") {
        vnode = node("div", "block notice done", [
          text("span", "mark", MARK.done),
          text("span", "", formatDuration(block.elapsedMs) + " \\u00b7 " +
            formatTokens(block.tokens) + " tokens")
        ]);
      } else {
        vnode = text("div", "block notice muted", String(block.kind));
      }
      vnode.key = block.key;
      vnode.rev = block.rev;
      out.push(vnode);
    }
    return out;
  }

  /** The live streaming region: the assistant text still being generated. */
  function liveNodes(state) {
    if (!state.streaming || state.streamText.trim() === "") return [];
    var vnode = node("div", "block md", markdownNodes(state.streamText));
    vnode.key = "live";
    vnode.rev = state.streamText.length;
    return [vnode];
  }

  /** The todo checklist. */
  function todoNodes(state) {
    var out = [];
    for (var i = 0; i < state.todos.length; i++) {
      var todo = state.todos[i] || {};
      var status = todo.status === "done" || todo.status === "inProgress"
        ? todo.status : "pending";
      var item = attrs(node("li", "", [
        text("span", "mark", TODO_MARKS[status]),
        text("span", "", String(todo.text === undefined ? "" : todo.text))
      ]), { "data-status": status });
      item.key = "t" + i + ":" + status;
      item.rev = 0;
      out.push(item);
    }
    return out;
  }

  /**
   * The body of the permission sheet. The subject and description are shown
   * verbatim as text: a user must be able to read exactly what they approve.
   */
  function permissionNodes(request) {
    var req = request || {};
    var subject = typeof req.subject === "string" ? req.subject : "";
    var description = typeof req.description === "string" ? req.description : "";
    var children = [];
    children.push(text("span", "label", "tool"));
    children.push(text("div", "", String(req.toolName === undefined ? "" : req.toolName)));
    if (subject !== "") {
      children.push(text("span", "label", "subject"));
      children.push(text("div", "", subject));
    }
    if (description !== "" && description !== subject) {
      children.push(text("span", "label", "details"));
      children.push(text("div", "", description));
    }
    // Keyed by request id: without this the mounter would treat the next
    // request's nodes as unchanged and leave the previous one on screen — a
    // user could approve something other than what they are looking at.
    var id = String(req.id === undefined ? "" : req.id);
    for (var i = 0; i < children.length; i++) {
      children[i].key = id + ":" + i;
      children[i].rev = 0;
    }
    return children;
  }

  /** One row per known session, newest first. */
  function sessionNodes(sessions, currentId) {
    var list = (sessions || []).slice().sort(function (a, b) {
      return Number(b.createdAt || 0) - Number(a.createdAt || 0);
    });
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var header = list[i] || {};
      var id = String(header.sessionId === undefined ? "" : header.sessionId);
      var when = Number(header.createdAt || 0);
      var button = attrs(node("button", "", [
        text("span", "id", header.title ? String(header.title) : id),
        text("span", "meta", String(header.cwd === undefined ? "" : header.cwd) +
          (when > 0 ? " \\u00b7 " + new Date(when).toLocaleString() : ""))
      ]), { type: "button", "data-session": id });
      var row = attrs(node("li", "", [button]), { "data-current": id === currentId ? "true" : "false" });
      row.key = id;
      row.rev = id === currentId ? 1 : 0;
      out.push(row);
    }
    return out;
  }

  /** The working line shown while a run is active. */
  function activityText(state, now) {
    var elapsed = state.runStartedAt < 0
      ? 0 : Math.max(0, (typeof now === "number" ? now : Date.now()) - state.runStartedAt);
    var verbs = ["working", "thinking", "crunching", "reasoning"];
    var verb = verbs[Math.floor(elapsed / 3000) % verbs.length];
    return verb + " \\u00b7 " + formatDuration(elapsed) + " \\u00b7 " +
      formatTokens(state.tokens) + " tokens";
  }

  root.ArcturnWeb = root.ArcturnWeb || {};
  root.ArcturnWeb.model = {
    MARK: MARK,
    SPINNER: SPINNER,
    TODO_MARKS: TODO_MARKS,
    activityText: activityText,
    applyEvent: applyEvent,
    approvalGate: approvalGate,
    backoffDelay: backoffDelay,
    contentText: contentText,
    createState: createState,
    formatDuration: formatDuration,
    formatTokens: formatTokens,
    liveNodes: liveNodes,
    markdownNodes: markdownNodes,
    oneLine: oneLine,
    parseDiff: parseDiff,
    permissionNodes: permissionNodes,
    sessionNodes: sessionNodes,
    subjectOf: subjectOf,
    suggestRule: suggestRule,
    todoNodes: todoNodes,
    toolGlyph: toolGlyph,
    transcriptNodes: transcriptNodes
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
`;
