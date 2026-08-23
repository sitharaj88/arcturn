/**
 * Transcript export: turning a session's {@link Message} list into a
 * standalone Markdown document or a self-contained HTML page, mirroring
 * what Claude Code's `/export` produces.
 *
 * Both {@link exportMarkdown} and {@link exportHtml} are pure functions of
 * their inputs — no filesystem access, no clocks — so the orchestrator is
 * free to call them from a `/export` command, a test, or a script. See
 * `INTEGRATION-export.md` at the repo root for how a `/export` slash
 * command should wire them up.
 */

import type {
  AssistantContent,
  Message,
  ToolResultContent,
  ToolResultMessage,
  UserContent,
} from "@arcturn/types";

/** Caller-supplied header information; every field is optional. */
export interface ExportMeta {
  /** Document title / `<title>`. Defaults to `"Arcturn Session"`. */
  title?: string;
  /** Model id or display name, shown in the header. */
  model?: string;
  /**
   * ISO-8601 (or any `Date`-parseable) timestamp for "exported at" and for
   * {@link suggestExportFilename}. Library code never reads the clock
   * itself — the caller supplies this so exports stay deterministic and
   * testable.
   */
  exportedAt?: string;
}

/** Behavior toggles shared by {@link exportMarkdown} and {@link exportHtml}. */
export interface ExportOptions {
  /** Include `thinking` content blocks. Defaults to `false`. */
  showThinking?: boolean;
}

/** Tool-result text is capped at this many lines before a truncation marker is appended. */
const MAX_RESULT_LINES = 200;

function titleOf(meta: ExportMeta): string {
  return meta.title ?? "Arcturn Session";
}

/**
 * Index tool results by the call id they answer, so a `toolCall` block can
 * render its result inline.
 *
 * Each id maps to a *queue* in conversation order rather than a single
 * message: `ToolCallContent.id` is documented as unique, but nothing enforces
 * it, and a last-write-wins map would make an earlier call display a later
 * call's output. Consuming from the front pairs each call with its own result
 * even when an id is reused.
 */
function indexToolResults(messages: readonly Message[]): Map<string, ToolResultMessage[]> {
  const index = new Map<string, ToolResultMessage[]>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const queue = index.get(message.toolCallId);
    if (queue) queue.push(message);
    else index.set(message.toolCallId, [message]);
  }
  return index;
}

/** Take the next unrendered result for a call id, marking it consumed. */
function takeResult(
  index: Map<string, ToolResultMessage[]>,
  consumed: Set<ToolResultMessage>,
  callId: string,
): ToolResultMessage | undefined {
  const next = index.get(callId)?.shift();
  if (next) consumed.add(next);
  return next;
}

/** Flatten a tool result's content blocks to plain text, noting images inline. */
function toolResultText(message: ToolResultMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n");
}

/**
 * Cap `text` at `max` lines, appending a marker describing how much was cut.
 *
 * @param text - Text to (possibly) truncate.
 * @param max - Maximum lines to keep.
 */
function truncateLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  const hidden = lines.length - max;
  const shown = lines.slice(0, max).join("\n");
  return `${shown}\n… output truncated (${hidden} more line${hidden === 1 ? "" : "s"}) …`;
}

/** Format an `ExportMeta` as one italic Markdown line, or `undefined` when there's nothing to show. */
function metaLineMarkdown(meta: ExportMeta): string | undefined {
  const parts: string[] = [];
  if (meta.model) parts.push(`Model: ${meta.model}`);
  if (meta.exportedAt) parts.push(`Exported: ${meta.exportedAt}`);
  return parts.length > 0 ? `_${parts.join(" · ")}_` : undefined;
}

/** Wrap `content` in a fenced code block, widening the fence if `content` itself contains backticks. */
function fence(content: string, lang: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${lang}\n${content}\n${ticks}`;
}

function renderUserContentMarkdown(content: readonly UserContent[]): string[] {
  const lines: string[] = [];
  for (const block of content) {
    lines.push("");
    lines.push(block.type === "text" ? block.text : "`[image]`");
  }
  return lines;
}

function renderToolCallMarkdown(
  block: Extract<AssistantContent, { type: "toolCall" }>,
  resultsByCallId: Map<string, ToolResultMessage[]>,
  consumed: Set<ToolResultMessage>,
): string[] {
  const lines: string[] = [
    "",
    "<details>",
    `<summary>🔧 ${block.name}</summary>`,
    "",
    "**Input:**",
    "",
    fence(JSON.stringify(block.arguments, null, 2), "json"),
  ];
  const result = takeResult(resultsByCallId, consumed, block.id);
  if (result) {
    const truncated = truncateLines(toolResultText(result), MAX_RESULT_LINES);
    lines.push("", `**Result:**${result.isError ? " (error)" : ""}`, "", fence(truncated, ""));
  } else {
    lines.push("", "_No result recorded._");
  }
  lines.push("", "</details>");
  return lines;
}

function renderAssistantContentMarkdown(
  content: readonly AssistantContent[],
  resultsByCallId: Map<string, ToolResultMessage[]>,
  consumed: Set<ToolResultMessage>,
  showThinking: boolean,
): string[] {
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      lines.push("", block.text);
    } else if (block.type === "thinking") {
      if (!showThinking) continue;
      lines.push(
        "",
        "<details>",
        "<summary>🧠 Thinking</summary>",
        "",
        block.thinking,
        "",
        "</details>",
      );
    } else {
      lines.push(...renderToolCallMarkdown(block, resultsByCallId, consumed));
    }
  }
  return lines;
}

function renderOrphanToolResultMarkdown(message: ToolResultMessage): string[] {
  const truncated = truncateLines(toolResultText(message), MAX_RESULT_LINES);
  return [
    "",
    "## Tool",
    "",
    "<details>",
    `<summary>🔧 ${message.toolName}</summary>`,
    "",
    `**Result:**${message.isError ? " (error)" : ""}`,
    "",
    fence(truncated, ""),
    "",
    "</details>",
  ];
}

/**
 * Render a session's messages as a standalone Markdown document: one
 * `## User` / `## Assistant` heading per turn, tool calls as collapsed
 * `<details>` blocks (tool name, fenced JSON input, fenced — and
 * line-truncated — result text), `thinking` blocks omitted unless
 * `options.showThinking` is set, and images noted as `` `[image]` ``.
 *
 * @param messages - The conversation, in chronological order.
 * @param meta - Optional header information (title / model / exportedAt).
 * @param options - Behavior toggles; see {@link ExportOptions}.
 */
export function exportMarkdown(
  messages: readonly Message[],
  meta: ExportMeta = {},
  options: ExportOptions = {},
): string {
  const showThinking = options.showThinking ?? false;
  const resultsByCallId = indexToolResults(messages);
  const consumed = new Set<ToolResultMessage>();

  const lines: string[] = [`# ${titleOf(meta)}`];
  const metaLine = metaLineMarkdown(meta);
  if (metaLine) lines.push("", metaLine);

  if (messages.length === 0) {
    lines.push("", "_No messages in this session._");
    return `${lines.join("\n")}\n`;
  }

  for (const message of messages) {
    if (message.role === "user") {
      lines.push("", "## User", ...renderUserContentMarkdown(message.content));
    } else if (message.role === "assistant") {
      lines.push(
        "",
        "## Assistant",
        ...renderAssistantContentMarkdown(message.content, resultsByCallId, consumed, showThinking),
      );
    } else if (!consumed.has(message)) {
      lines.push(...renderOrphanToolResultMarkdown(message));
    }
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// HTML export
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape then turn newlines into `<br>` so multi-line text reads as written. */
function escapeHtmlMultiline(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>\n");
}

function renderUserContentHtml(content: readonly UserContent[]): string {
  return content
    .map((block) =>
      block.type === "text"
        ? `<p>${escapeHtmlMultiline(block.text)}</p>`
        : '<p class="image-note">[image]</p>',
    )
    .join("\n");
}

function renderToolResultContentHtml(content: readonly ToolResultContent[]): string {
  return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function renderToolCallHtml(
  block: Extract<AssistantContent, { type: "toolCall" }>,
  resultsByCallId: Map<string, ToolResultMessage[]>,
  consumed: Set<ToolResultMessage>,
): string {
  const input = escapeHtml(JSON.stringify(block.arguments, null, 2));
  const result = takeResult(resultsByCallId, consumed, block.id);
  let resultHtml: string;
  if (result) {
    const truncated = truncateLines(renderToolResultContentHtml(result.content), MAX_RESULT_LINES);
    const label = result.isError ? "Result (error)" : "Result";
    resultHtml = `<div class="tool-result${result.isError ? " tool-error" : ""}"><strong>${label}</strong><pre>${escapeHtml(truncated)}</pre></div>`;
  } else {
    resultHtml = '<div class="tool-result"><em>No result recorded.</em></div>';
  }
  return (
    `<details class="tool"><summary>🔧 ${escapeHtml(block.name)}</summary>` +
    `<div class="tool-input"><strong>Input</strong><pre>${input}</pre></div>` +
    `${resultHtml}</details>`
  );
}

function renderAssistantContentHtml(
  content: readonly AssistantContent[],
  resultsByCallId: Map<string, ToolResultMessage[]>,
  consumed: Set<ToolResultMessage>,
  showThinking: boolean,
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(`<p>${escapeHtmlMultiline(block.text)}</p>`);
    } else if (block.type === "thinking") {
      if (!showThinking) continue;
      parts.push(
        `<details class="thinking"><summary>🧠 Thinking</summary><pre>${escapeHtml(block.thinking)}</pre></details>`,
      );
    } else {
      parts.push(renderToolCallHtml(block, resultsByCallId, consumed));
    }
  }
  return parts.join("\n");
}

function renderOrphanToolResultHtml(message: ToolResultMessage): string {
  const truncated = truncateLines(renderToolResultContentHtml(message.content), MAX_RESULT_LINES);
  const label = message.isError ? "Result (error)" : "Result";
  return (
    '<section class="turn tool"><h2>Tool</h2>' +
    `<details class="tool"><summary>🔧 ${escapeHtml(message.toolName)}</summary>` +
    `<div class="tool-result${message.isError ? " tool-error" : ""}"><strong>${label}</strong><pre>${escapeHtml(truncated)}</pre></div>` +
    "</details></section>"
  );
}

const HTML_STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1b1f24;
    --muted: #6b7280;
    --border: #e5e7eb;
    --user-bg: #eff6ff;
    --user-border: #bfdbfe;
    --assistant-bg: #f9fafb;
    --assistant-border: #e5e7eb;
    --code-bg: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --fg: #e6e8eb;
      --muted: #9aa3af;
      --border: #2a2e37;
      --user-bg: #15233c;
      --user-border: #2c4a7c;
      --assistant-bg: #181a20;
      --assistant-border: #2a2e37;
      --code-bg: #1e2128;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1rem 4rem;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.55;
  }
  main { max-width: 760px; margin: 0 auto; }
  header.export-header { max-width: 760px; margin: 0 auto 2rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  .export-meta { color: var(--muted); font-size: 0.9rem; }
  .turn {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
  }
  .turn.user { background: var(--user-bg); border-color: var(--user-border); }
  .turn.assistant { background: var(--assistant-bg); border-color: var(--assistant-border); }
  .turn.tool { background: var(--assistant-bg); border-color: var(--assistant-border); }
  .turn h2 {
    margin: 0 0 0.5rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .turn p { margin: 0.5rem 0; overflow-wrap: anywhere; }
  .image-note { color: var(--muted); font-style: italic; }
  details { margin: 0.5rem 0; border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.75rem; }
  details summary { cursor: pointer; font-weight: 600; }
  .tool-input, .tool-result { margin-top: 0.5rem; }
  .tool-error { color: #b42318; }
  @media (prefers-color-scheme: dark) {
    .tool-error { color: #f87171; }
  }
  pre {
    background: var(--code-bg);
    border-radius: 6px;
    padding: 0.75rem;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.85rem;
  }
`;

/**
 * Render a session's messages as one self-contained HTML page: inline CSS
 * (dark-friendly via `prefers-color-scheme`), no external assets, user and
 * assistant turns visually distinct, tool calls in collapsed `<details>`
 * blocks, code/JSON/results in `<pre>`. All user- and model-provided text is
 * HTML-escaped.
 *
 * @param messages - The conversation, in chronological order.
 * @param meta - Optional header information (title / model / exportedAt).
 * @param options - Behavior toggles; see {@link ExportOptions}.
 */
export function exportHtml(
  messages: readonly Message[],
  meta: ExportMeta = {},
  options: ExportOptions = {},
): string {
  const showThinking = options.showThinking ?? false;
  const resultsByCallId = indexToolResults(messages);
  const consumed = new Set<ToolResultMessage>();
  const title = titleOf(meta);

  const metaBits: string[] = [];
  if (meta.model) metaBits.push(`Model: ${escapeHtml(meta.model)}`);
  if (meta.exportedAt) metaBits.push(`Exported: ${escapeHtml(meta.exportedAt)}`);

  const sections: string[] = [];
  if (messages.length === 0) {
    sections.push("<p>No messages in this session.</p>");
  } else {
    for (const message of messages) {
      if (message.role === "user") {
        sections.push(
          `<section class="turn user"><h2>User</h2>${renderUserContentHtml(message.content)}</section>`,
        );
      } else if (message.role === "assistant") {
        sections.push(
          `<section class="turn assistant"><h2>Assistant</h2>${renderAssistantContentHtml(
            message.content,
            resultsByCallId,
            consumed,
            showThinking,
          )}</section>`,
        );
      } else if (!consumed.has(message)) {
        sections.push(renderOrphanToolResultHtml(message));
      }
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<header class="export-header">
<h1>${escapeHtml(title)}</h1>
${metaBits.length > 0 ? `<div class="export-meta">${metaBits.join(" · ")}</div>` : ""}
</header>
<main>
${sections.join("\n")}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Filename suggestion
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `yyyy-MM-dd-HHmm` (UTC) derived from `iso`, or the Unix epoch when `iso`
 * is missing or unparseable — never the current time, so this stays
 * deterministic.
 */
function timestampForFilename(iso: string | undefined): string {
  const parsed = iso !== undefined ? new Date(iso) : undefined;
  const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(0);
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

/**
 * Suggest a filename for an export: `arcturn-session-<yyyy-MM-dd-HHmm>.<md|html>`.
 * The timestamp comes from `meta.exportedAt` (UTC), never from the system
 * clock — pass it explicitly for a deterministic name.
 *
 * @param meta - Export metadata; only `exportedAt` is consulted.
 * @param format - `"md"` or `"html"`.
 */
export function suggestExportFilename(meta: ExportMeta, format: "md" | "html"): string {
  return `arcturn-session-${timestampForFilename(meta.exportedAt)}.${format}`;
}
