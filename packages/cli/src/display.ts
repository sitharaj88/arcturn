/**
 * Turns the agent event stream into transcript lines.
 *
 * The formatter is deliberately stateful-but-small: it remembers the input of
 * every in-flight tool call so `toolEnd` can be rendered against the arguments
 * that produced it. It returns plain strings (already styled with ANSI when the
 * terminal supports colour) so the caller can print them straight to stdout —
 * see `@arcturn/tui`'s note about keeping scrollback outside the renderer.
 */

import { defaultSubject } from "@arcturn/core";
import {
  type ImageSupport,
  renderImage,
  renderMarkdown,
  style,
  truncateToWidth,
} from "@arcturn/tui";
import type {
  AgentEvent,
  AssistantMessage,
  Message,
  TodoItem,
  ToolResultMessage,
} from "@arcturn/types";
import { formatDuration, oneLine } from "./format.js";
import { FANCY_GLYPHS, type GlyphSet, toolGlyph } from "./glyphs.js";

/** Options for {@link TranscriptFormatter}. */
export interface TranscriptOptions {
  /** Render width in columns (default `80`). */
  width?: number;
  /** Render assistant messages as markdown (default `true`). */
  markdown?: boolean;
  /** Include the model's thinking blocks (default `false`). */
  showThinking?: boolean;
  /** Lines of tool output kept in the transcript (default `8`). */
  maxOutputLines?: number;
  /** Lines of a diff kept in the transcript (default `24`). */
  maxDiffLines?: number;
  /** Echo the user prompt that started each run (default `true`). */
  showUserPrompt?: boolean;
  /**
   * Clock for tool-elapsed measurement (default `Date.now`). The re-theming
   * replay injects each block's original wall time here so a re-styled tool
   * card keeps the `· 4s` it originally showed instead of re-measuring ~0ms.
   */
  now?: () => number;
  /** Render `todoUpdate` as a checklist block (default `false`; the TUI uses a widget). */
  showTodos?: boolean;
  /**
   * How to draw image content blocks. Defaults to `"none"` (a text
   * placeholder) so headless output stays deterministic; the interactive app
   * passes the terminal's detected capability.
   */
  imageSupport?: ImageSupport;
  /**
   * Glyph set used for status dots, connectors and per-tool icons (defaults to
   * {@link FANCY_GLYPHS} so headless output is deterministic; the interactive
   * app passes a set resolved from the terminal's Unicode capability).
   */
  glyphs?: GlyphSet;
}

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
}

/** Tool calls faster than this render without an elapsed-time annotation. */
const ELAPSED_THRESHOLD_MS = 1_000;

const CONTINUE = "    ";

function imageLine(block: { mimeType: string; data: string }, support: ImageSupport): string {
  const altText = `[${block.mimeType} image]`;
  if (support === "none") return altText;
  try {
    return renderImage(Buffer.from(block.data, "base64"), { support, altText });
  } catch {
    // A malformed payload must never break the transcript.
    return altText;
  }
}

function textOf(content: ToolResultMessage["content"], support: ImageSupport): string {
  return content
    .map((block) => (block.type === "text" ? block.text : imageLine(block, support)))
    .join("\n");
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").filter((line) => line.trim().length > 0);
}

function detail(result: ToolResultMessage, key: string): unknown {
  return result.details?.[key];
}

/** A unified-diff body line tagged with the line number it lands on. */
interface DiffRow {
  /** `+`, `-` or ` ` (context). */
  kind: "+" | "-" | " ";
  /** New-file line number for context/added rows; `undefined` for removed rows. */
  lineNo: number | undefined;
  /** The raw diff line, marker included. */
  text: string;
  /** `true` for the synthetic separator drawn between hunks. */
  separator?: boolean;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff into displayable rows.
 *
 * Rows are numbered against the new file; removed rows keep a blank gutter so
 * the numbering stays monotone. File headers are dropped and hunk headers
 * become separators (except before the first hunk).
 */
function parseDiff(raw: string): DiffRow[] | undefined {
  if (!/^@@ /m.test(raw)) return undefined;
  const rows: DiffRow[] = [];
  let newNo = 0;
  let sawHunk = false;
  for (const line of raw.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      newNo = Number(hunk[1]);
      if (sawHunk) rows.push({ kind: " ", lineNo: undefined, text: "", separator: true });
      sawHunk = true;
      continue;
    }
    if (!sawHunk || line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+")) rows.push({ kind: "+", lineNo: newNo++, text: line });
    else if (line.startsWith("-")) rows.push({ kind: "-", lineNo: undefined, text: line });
    else rows.push({ kind: " ", lineNo: newNo++, text: line });
  }
  return rows;
}

/**
 * Formats agent events into printable transcript lines.
 *
 * @example
 * ```ts
 * const formatter = new TranscriptFormatter({ width: 100 });
 * agent.subscribe((event) => {
 *   for (const line of formatter.format(event)) process.stdout.write(`${line}\n`);
 * });
 * ```
 */
export class TranscriptFormatter {
  #options: Required<Omit<TranscriptOptions, "width" | "glyphs" | "now">> & { width: number };
  readonly #glyphs: GlyphSet;
  /** Prefix introducing a tool's result, e.g. `"  ⎿ "`. */
  readonly #result: string;
  /** Prefix introducing nested sub-agent activity, e.g. `"    ↳ "`. */
  readonly #nested: string;
  readonly #pending = new Map<string, PendingTool>();
  readonly #now: () => number;
  readonly #subagents = new Map<string, string>();

  constructor(options: TranscriptOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#options = {
      width: options.width ?? 80,
      markdown: options.markdown ?? true,
      showThinking: options.showThinking ?? false,
      maxOutputLines: options.maxOutputLines ?? 8,
      maxDiffLines: options.maxDiffLines ?? 24,
      showUserPrompt: options.showUserPrompt ?? true,
      showTodos: options.showTodos ?? false,
      imageSupport: options.imageSupport ?? "none",
    };
    this.#glyphs = options.glyphs ?? FANCY_GLYPHS;
    this.#result = `  ${this.#glyphs.treeResult} `;
    this.#nested = `    ${this.#glyphs.nested} `;
  }

  /** Current render width. */
  get width(): number {
    return this.#options.width;
  }

  /**
   * Change the render width, e.g. after a terminal resize.
   *
   * @param width - New width in columns.
   */
  setWidth(width: number): void {
    this.#options.width = Math.max(20, width);
  }

  /** Forget in-flight tool calls (used when a session is replaced). */
  reset(): void {
    this.#pending.clear();
    this.#subagents.clear();
  }

  /**
   * Render one event.
   *
   * @param event - The agent event.
   * @returns Zero or more lines to print. Events with no visual
   *   representation (raw stream deltas, permission plumbing) return `[]`.
   */
  format(event: AgentEvent): string[] {
    switch (event.type) {
      case "runStart":
        return this.#runStart(event.prompt);
      case "messageEnd":
        return this.#assistantMessage(event.message);
      case "toolStart":
        return this.#toolStart(event.toolCallId, event.toolName, event.input);
      case "toolEnd":
        return this.#toolEnd(event.toolCallId, event.result);
      case "subagentStart": {
        this.#subagents.set(event.agentId, event.task);
        const dot = style("accent")(this.#glyphs.statusDot);
        const glyph = style("accent")(toolGlyph("subagent", this.#glyphs));
        return [
          `${dot} ${glyph} ${style("title")("subagent")} ${style("muted")(oneLine(event.task, this.width - 16))}`,
        ];
      }
      case "subagentEvent":
        return this.#subagentEvent(event.event);
      case "subagentEnd":
        return this.#subagentEnd(event.resultText, event.isError);
      case "todoUpdate":
        return this.#todos(event.todos);
      case "notice":
        return this.#notice(event.level, event.text);
      case "compactionStart":
        return [style("muted")(`${this.#glyphs.statusDot} Compacting conversation…`)];
      case "compactionEnd":
        return event.summary.length === 0
          ? []
          : [
              style("muted")(
                `${this.#glyphs.statusDot} Compacted context: ${Math.round(event.tokensBefore / 1000)}k ${this.#glyphs.arrow} ${Math.round(event.tokensAfter / 1000)}k tokens`,
              ),
            ];
      case "contextEdit":
        return [
          style("muted")(
            `${this.#glyphs.statusDot} Context edited: ${event.elidedCount} old tool result${event.elidedCount === 1 ? "" : "s"} elided (~${Math.round(event.charsSaved / 1000)}k chars)`,
          ),
        ];
      case "backgroundTaskStart":
        return [
          style("info")(
            `${this.#glyphs.statusDot} background ${event.taskId}: ${oneLine(event.command, 70)}`,
          ),
        ];
      case "backgroundTaskEnd":
        return [
          style("info")(
            `${this.#glyphs.statusDot} background ${event.taskId} exited${event.exitCode === null ? "" : ` (${event.exitCode})`}`,
          ),
        ];
      case "runEnd":
        if (event.reason === "error") {
          return [
            style("error")(`${this.#glyphs.error} ${event.errorMessage ?? "The run failed."}`),
          ];
        }
        if (event.reason === "aborted") {
          return [style("warning")(`${this.#glyphs.interrupt} Interrupted.`)];
        }
        return [];
      default:
        return [];
    }
  }

  #runStart(prompt: Message): string[] {
    if (!this.#options.showUserPrompt) return [];
    if (prompt.role !== "user") return [];
    const value = prompt.content
      .map((block) =>
        block.type === "text" ? block.text : imageLine(block, this.#options.imageSupport),
      )
      .join("\n")
      .trim();
    if (value === "") return [];
    const gutter = style("accent")(this.#glyphs.userGutter);
    return ["", ...value.split("\n").map((line) => `${gutter} ${style("text")(line)}`)];
  }

  #assistantMessage(message: AssistantMessage): string[] {
    const lines: string[] = [];
    if (this.#options.showThinking) {
      for (const block of message.content) {
        if (block.type !== "thinking" || block.thinking.trim() === "") continue;
        lines.push(style("muted")(`${this.#glyphs.plan} Thinking`));
        for (const line of nonEmptyLines(block.thinking)) lines.push(style("muted")(`  ${line}`));
      }
    }
    const body = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (body !== "") {
      lines.push("");
      lines.push(...(this.#options.markdown ? renderMarkdown(body, this.width) : body.split("\n")));
    }
    if (message.stopReason === "error" && message.errorMessage) {
      lines.push(style("error")(`✗ ${message.errorMessage}`));
    }
    return lines;
  }

  #toolStart(toolCallId: string, toolName: string, input: Record<string, unknown>): string[] {
    this.#pending.set(toolCallId, { name: toolName, input, startedAt: this.#now() });
    const subject = defaultSubject(toolName, input);
    const label =
      subject === "" ? "" : `  ${style("muted")(oneLine(subject, Math.max(20, this.width - 14)))}`;
    const dot = style("accent")(this.#glyphs.statusDot);
    const glyph = style("accent")(toolGlyph(toolName, this.#glyphs));
    return [`${dot} ${glyph} ${style("title")(toolName)}${label}`];
  }

  #toolEnd(toolCallId: string, result: ToolResultMessage): string[] {
    const pending = this.#pending.get(toolCallId);
    this.#pending.delete(toolCallId);
    const name = pending?.name ?? result.toolName;
    const body = textOf(result.content, this.#options.imageSupport);
    return this.#withElapsed(this.#toolEndBody(name, result, body), pending);
  }

  #toolEndBody(name: string, result: ToolResultMessage, body: string): string[] {
    if (result.isError) {
      const lines = nonEmptyLines(body).slice(0, 4);
      if (lines.length === 0) return [style("error")(`${this.#result}failed`)];
      return lines.map((line, index) =>
        style("error")(`${index === 0 ? this.#result : CONTINUE}${oneLine(line, this.width - 6)}`),
      );
    }

    switch (name) {
      case "edit":
        return this.#diff(result, body);
      case "read": {
        const total = detail(result, "totalLines");
        const start = detail(result, "startLine");
        const end = detail(result, "endLine");
        const lineCount = typeof total === "number" ? total : body.split("\n").length;
        const range =
          typeof start === "number" && typeof end === "number" && (start > 1 || end < lineCount)
            ? ` (showing ${start}-${end})`
            : "";
        return [this.#summary(`${lineCount} ${lineCount === 1 ? "line" : "lines"}${range}`)];
      }
      case "grep": {
        const count = detail(result, "matchCount");
        if (typeof count !== "number") return this.#tail(body);
        if (count === 0) return [this.#summary("no matches")];
        const files = detail(result, "filesSearched");
        const searched =
          typeof files === "number" ? ` · ${files} ${files === 1 ? "file" : "files"} searched` : "";
        return [
          this.#summary(`${count} ${count === 1 ? "match" : "matches"}${searched}`),
          ...this.#sample(body),
        ];
      }
      case "glob": {
        const count = detail(result, "matchCount");
        if (typeof count !== "number") return this.#tail(body);
        if (count === 0) return [this.#summary("no files matched")];
        return [this.#summary(`${count} ${count === 1 ? "file" : "files"}`), ...this.#sample(body)];
      }
      case "ls": {
        const count = detail(result, "entryCount");
        if (typeof count !== "number") return this.#tail(body);
        return [this.#summary(`${count} ${count === 1 ? "entry" : "entries"}`)];
      }
      case "fetch": {
        const status = detail(result, "status");
        if (typeof status !== "number") return this.#tail(body);
        const contentType = detail(result, "contentType");
        const truncated = detail(result, "truncated") === true ? " · truncated" : "";
        const type =
          typeof contentType === "string" && contentType !== "" ? ` · ${contentType}` : "";
        return [this.#summary(`${status}${type}${truncated}`)];
      }
      case "write": {
        const path = detail(result, "path");
        const bytes = detail(result, "bytes");
        const created = detail(result, "created");
        if (typeof path === "string") {
          return [
            style("success")(
              `${this.#result}${created === true ? "created" : "updated"} ${path}${typeof bytes === "number" ? ` (${bytes} bytes)` : ""}`,
            ),
          ];
        }
        return this.#tail(body);
      }
      case "bash": {
        const exitCode = detail(result, "exitCode");
        const lines = this.#tail(body);
        if (typeof exitCode === "number" && exitCode !== 0) {
          lines.push(style("error")(`${CONTINUE}exit ${exitCode}`));
        }
        return lines;
      }
      default:
        return this.#tail(body);
    }
  }

  /**
   * Append a faint elapsed time to the first result line of a completed call.
   *
   * Sub-second calls are left unannotated: a `· 0s` on every fast read is
   * noise, and the timing only earns its place once a call is slow enough to
   * have been felt.
   */
  #withElapsed(lines: string[], pending: PendingTool | undefined): string[] {
    if (!pending || lines.length === 0) return lines;
    const ms = this.#now() - pending.startedAt;
    if (ms < ELAPSED_THRESHOLD_MS) return lines;
    lines[0] = `${lines[0]} ${style("muted")(`· ${formatDuration(ms)}`)}`;
    return lines;
  }

  #diff(result: ToolResultMessage, fallback: string): string[] {
    const raw = detail(result, "diff");
    if (typeof raw !== "string" || raw.trim() === "") return this.#tail(fallback);
    const path = detail(result, "path");

    const rows = parseDiff(raw);
    if (!rows) return this.#plainDiff(raw, path);

    const added = rows.filter((row) => row.kind === "+").length;
    const removed = rows.filter((row) => row.kind === "-").length;
    const counts = [
      added > 0 ? style("success")(`+${added}`) : "",
      removed > 0 ? style("error")(`-${removed}`) : "",
    ]
      .filter((part) => part !== "")
      .join(" ");
    const name = typeof path === "string" ? path : "";
    const head =
      name === "" && counts === ""
        ? []
        : [
            `${style("success")(this.#result)}${style("title")(name)}${counts === "" ? "" : ` ${counts}`}`,
          ];

    const gutterWidth = String(rows.reduce((max, row) => Math.max(max, row.lineNo ?? 0), 0)).length;
    const bodyWidth = Math.max(10, this.width - gutterWidth - 8);

    const shown = rows.slice(0, this.#options.maxDiffLines);
    const lines = shown.map((row) => {
      if (row.separator) {
        return style("muted")(
          `${CONTINUE}${" ".repeat(gutterWidth)} ${this.#glyphs.unicode ? "⋯" : "..."}`,
        );
      }
      const gutter = style("muted")(String(row.lineNo ?? "").padStart(gutterWidth));
      const paint =
        row.kind === "+"
          ? style("diffAdded")
          : row.kind === "-"
            ? style("diffRemoved")
            : style("muted");
      return `${CONTINUE}${gutter} ${paint(truncateToWidth(row.text, bodyWidth) || " ")}`;
    });
    if (rows.length > shown.length) {
      lines.push(style("muted")(`${CONTINUE}… ${rows.length - shown.length} more diff lines`));
    }
    return [...head, ...lines];
  }

  /** Fallback for diffs without hunk headers: no line numbers, marker colours only. */
  #plainDiff(raw: string, path: unknown): string[] {
    const all = raw.split("\n");
    const shown = all.slice(0, this.#options.maxDiffLines);
    const head = typeof path === "string" ? [style("success")(`${this.#result}${path}`)] : [];
    const lines = shown.map((line) => {
      const paint = line.startsWith("+")
        ? style("diffAdded")
        : line.startsWith("-")
          ? style("diffRemoved")
          : style("muted");
      return CONTINUE + paint(line);
    });
    if (all.length > shown.length) {
      lines.push(style("muted")(`${CONTINUE}… ${all.length - shown.length} more diff lines`));
    }
    return [...head, ...lines];
  }

  /** A one-line muted result summary behind the result connector. */
  #summary(text: string): string {
    return style("muted")(`${this.#result}${text}`);
  }

  /**
   * The first few lines of a tool's output, as a dim sample under a summary.
   */
  #sample(body: string, max = 4): string[] {
    const all = nonEmptyLines(body);
    const shown = all.slice(0, max);
    const lines = shown.map((line) => style("muted")(CONTINUE + oneLine(line, this.width - 6)));
    if (all.length > shown.length) {
      lines.push(style("muted")(`${CONTINUE}… ${all.length - shown.length} more lines`));
    }
    return lines;
  }

  /** Render the last few lines of a tool's textual output. */
  #tail(body: string): string[] {
    const all = nonEmptyLines(body);
    if (all.length === 0) return [style("muted")(`${this.#result}(no output)`)];
    const max = this.#options.maxOutputLines;
    const shown = all.length <= max ? all : all.slice(all.length - max);
    const lines: string[] = [];
    if (all.length > shown.length) {
      lines.push(style("muted")(`${this.#result}… ${all.length - shown.length} earlier lines`));
      for (const line of shown)
        lines.push(style("muted")(CONTINUE + oneLine(line, this.width - 6)));
    } else {
      shown.forEach((line, index) => {
        lines.push(
          style("muted")((index === 0 ? this.#result : CONTINUE) + oneLine(line, this.width - 6)),
        );
      });
    }
    return lines;
  }

  #subagentEvent(inner: AgentEvent): string[] {
    if (inner.type === "toolStart") {
      const subject = defaultSubject(inner.toolName, inner.input);
      return [
        style("muted")(
          `${this.#nested}${inner.toolName}${subject === "" ? "" : ` ${oneLine(subject, this.width - 20)}`}`,
        ),
      ];
    }
    if (inner.type === "notice" && inner.level === "error") {
      return [style("error")(`${this.#nested}${oneLine(inner.text, this.width - 8)}`)];
    }
    return [];
  }

  #subagentEnd(resultText: string, isError: boolean): string[] {
    const lines = nonEmptyLines(resultText).slice(0, 6);
    const paint = isError ? style("error") : style("muted");
    if (lines.length === 0) return [paint(`${this.#result}(no result)`)];
    return lines.map((line, index) =>
      paint((index === 0 ? this.#result : CONTINUE) + oneLine(line, this.width - 6)),
    );
  }

  #todos(todos: readonly TodoItem[]): string[] {
    if (!this.#options.showTodos || todos.length === 0) return [];
    const marks = { pending: "☐", inProgress: "◐", done: "☑" } as const;
    return todos.map((todo) => {
      const line = `  ${marks[todo.status]} ${todo.text}`;
      if (todo.status === "done") return style("muted")(line);
      if (todo.status === "inProgress") return style("accent")(line);
      return style("text")(line);
    });
  }

  #notice(level: "info" | "warn" | "error", text: string): string[] {
    const glyph =
      level === "error"
        ? this.#glyphs.error
        : level === "warn"
          ? this.#glyphs.warn
          : this.#glyphs.info;
    const paint =
      level === "error" ? style("error") : level === "warn" ? style("warning") : style("info");
    return text
      .split("\n")
      .map((line, index) => paint(`${index === 0 ? `${glyph} ` : "  "}${line}`));
  }
}
