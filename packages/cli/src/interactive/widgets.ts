/**
 * Small TUI components used only by the interactive app.
 *
 * The live region is deliberately thin: a render callback per zone, so the app
 * keeps all state in one place and the renderer stays a pure function of it.
 */

import type { BorderChars, Component, CursorPosition, ThemeToken } from "@arcturn/tui";
import {
  BORDERS,
  Editor,
  type EditorOptions,
  type Key,
  matchesKey,
  padToWidth,
  stringWidth,
  style,
  themeVersion,
  truncateToWidth,
} from "@arcturn/tui";
import type { TodoItem } from "@arcturn/types";
import { formatDuration, formatTokens } from "../format.js";
import { FANCY_GLYPHS, type GlyphSet, toolGlyph } from "../glyphs.js";
import type { SubagentStatus, ToolCallProgress } from "./activity.js";
import type { WorkflowRunView, WorkflowStepPhase, WorkflowStepView } from "./workflow-activity.js";

/**
 * A component whose output is produced by a callback.
 *
 * Returning an empty array costs no rows, which is what lets the live region
 * collapse completely while the agent is idle.
 */
export class Dynamic implements Component {
  readonly #render: (width: number) => string[];

  /**
   * @param render - Called on every frame with the available width.
   */
  constructor(render: (width: number) => string[]) {
    this.#render = render;
  }

  render(width: number): string[] {
    return this.#render(width);
  }
}

/**
 * A {@link Dynamic} whose output is reused until its version changes.
 *
 * The renderer rebuilds the whole frame on every keystroke, stream delta and
 * spinner tick; caching by `(width, version)` means a zone only pays its render
 * cost when the state it draws actually changed. The version getter should be
 * cheap — a counter the app bumps, or a stable object reference.
 *
 * The active theme is part of that key, and deliberately not left to the
 * caller: what a zone caches is *styled* text, so every cached line is stale
 * the moment the theme changes. Folding {@link themeVersion} in here means
 * no construction site can forget it, and a `/theme` switch re-paints the whole
 * live region whether or not anything else invalidated the component.
 */
export class CachedDynamic implements Component {
  readonly #render: (width: number) => string[];
  readonly #version: () => unknown;
  #lines: string[] | undefined;
  #width = -1;
  #seen: unknown;
  #seenTheme = -1;

  /**
   * @param version - Returns the current version of the zone's inputs.
   * @param render - Called only when the width, version or theme changed.
   */
  constructor(version: () => unknown, render: (width: number) => string[]) {
    this.#render = render;
    this.#version = version;
  }

  render(width: number): string[] {
    const version = this.#version();
    const theme = themeVersion();
    if (
      this.#lines &&
      this.#width === width &&
      this.#seenTheme === theme &&
      Object.is(this.#seen, version)
    ) {
      return this.#lines;
    }
    this.#lines = this.#render(width);
    this.#width = width;
    this.#seen = version;
    this.#seenTheme = theme;
    return this.#lines;
  }

  invalidate(): void {
    this.#lines = undefined;
  }
}

/** Options for {@link PromptEditor}. */
export interface PromptEditorOptions extends EditorOptions {
  /**
   * Called for `Ctrl+D` on an empty buffer. Return `true` to consume the key.
   * The base {@link Editor} maps `Ctrl+D` to forward-delete, so this hook is
   * the only way to reach "exit on empty buffer".
   */
  onEof?: () => boolean;
}

/** The prompt editor: an {@link Editor} that also reports `Ctrl+D` on empty input. */
export class PromptEditor extends Editor {
  readonly #onEof: (() => boolean) | undefined;

  constructor(options: PromptEditorOptions = {}) {
    super(options);
    this.#onEof = options.onEof;
  }

  override handleInput(key: Key): boolean {
    if (this.#onEof && matchesKey(key, "ctrl+d") && this.text === "") return this.#onEof();
    return super.handleInput(key);
  }
}

/** Minimum width at which the input editor is drawn inside a border. */
const INPUT_BOX_MIN_WIDTH = 24;
/** Minimum width at which the input box shows its state hint in the footer. */
const INPUT_HINT_MIN_WIDTH = 40;

/** Mutable presentation state of an {@link InputBox}. */
export interface InputBoxState {
  /** Whether a run is currently active (border switches to the working colour). */
  readonly running: boolean;
  /** Permission mode shown as the idle footer hint, e.g. `"default"`. */
  readonly mode: string;
}

/**
 * A rounded, stateful frame around the prompt {@link Editor}.
 *
 * The border colour tells the user whose turn it is — accent while idle ("type
 * here"), a distinct working colour while the agent runs ("it's thinking, but
 * you can still steer") — and the bottom border carries a right-aligned hint
 * (the permission mode, or a steering prompt while running). Focus, key input
 * and the hardware cursor are forwarded to the wrapped editor so it behaves
 * exactly as if it were a top-level component.
 *
 * At very narrow widths the border is dropped and the bare editor is drawn, so
 * the layout never corrupts.
 */
export class InputBox implements Component {
  readonly #editor: Editor;
  readonly #glyphs: GlyphSet;
  #state: InputBoxState = { running: false, mode: "default" };
  #boxed = true;

  /**
   * @param editor - The editor to frame.
   * @param glyphs - Glyph set deciding border characters (round vs ASCII).
   */
  constructor(editor: Editor, glyphs: GlyphSet) {
    this.#editor = editor;
    this.#glyphs = glyphs;
  }

  /** The wrapped editor, exposed for the app and tests. */
  get editor(): Editor {
    return this.#editor;
  }

  /** Update the border colour and footer hint. */
  setState(state: InputBoxState): void {
    this.#state = state;
  }

  onFocus(): void {
    this.#editor.onFocus();
  }

  onBlur(): void {
    this.#editor.onBlur();
  }

  invalidate(): void {
    this.#editor.invalidate();
  }

  handleInput(key: Key): boolean {
    return this.#editor.handleInput(key);
  }

  getCursor(): CursorPosition | undefined {
    const cursor = this.#editor.getCursor();
    if (!cursor) return undefined;
    if (!this.#boxed) return cursor;
    // One row for the top border, two columns for the left border + padding.
    return { row: cursor.row + 1, col: cursor.col + 2 };
  }

  render(width: number): string[] {
    const chars = this.#glyphs.unicode ? BORDERS.round : BORDERS.ascii;
    this.#boxed = width >= INPUT_BOX_MIN_WIDTH;
    if (!this.#boxed) return this.#editor.render(width);

    const innerWidth = Math.max(1, width - 4);
    const editorLines = this.#editor.render(innerWidth);
    const borderFn = style(this.#state.running ? "info" : "accent");
    const vertical = borderFn(chars.vertical);

    const runWidth = Math.max(0, width - 2);
    const top = borderFn(chars.topLeft + chars.horizontal.repeat(runWidth) + chars.topRight);
    const body = editorLines.map(
      (line) => `${vertical} ${padToWidth(line, innerWidth)} ${vertical}`,
    );
    const bottom = this.#bottomBorder(chars, borderFn, runWidth, width);
    return [top, ...body, bottom];
  }

  #bottomBorder(
    chars: BorderChars,
    borderFn: (text: string) => string,
    runWidth: number,
    width: number,
  ): string {
    const label = this.#state.running ? `${this.#glyphs.steer} steering` : this.#state.mode;
    const framed = ` ${label} `;
    const labelWidth = stringWidth(framed);
    if (width < INPUT_HINT_MIN_WIDTH || labelWidth + 4 > runWidth) {
      return borderFn(chars.bottomLeft + chars.horizontal.repeat(runWidth) + chars.bottomRight);
    }
    const trailing = 2;
    const leadRun = Math.max(0, runWidth - labelWidth - trailing);
    const paint = this.#state.running ? style("info") : style("muted");
    return (
      borderFn(chars.bottomLeft + chars.horizontal.repeat(leadRun)) +
      paint(framed) +
      borderFn(chars.horizontal.repeat(trailing) + chars.bottomRight)
    );
  }
}

/** Maximum cells drawn in the todo header's progress bar. */
const TODO_BAR_MAX_CELLS = 16;

/**
 * Render the todo checklist shown above the prompt.
 *
 * The header carries a one-cell-per-todo progress bar (scaled down past
 * {@link TODO_BAR_MAX_CELLS}) so overall progress is readable at a glance even
 * when older done rows are folded away.
 *
 * Between runs an item left `inProgress` is drawn in the warning colour rather
 * than the accent one. Nothing is running, so the accent — which everywhere
 * else means "happening now" — would claim work is under way when the agent has
 * actually stopped with that item open.
 *
 * @param todos - Current todo list.
 * @param width - Available columns.
 * @param glyphs - Glyph set deciding checkbox and bar characters.
 * @param maxRows - Maximum checklist rows before older done items are folded away.
 * @param running - Whether a run is currently active.
 */
export function renderTodoWidget(
  todos: readonly TodoItem[],
  width: number,
  glyphs: GlyphSet = FANCY_GLYPHS,
  maxRows = 8,
  running = true,
): string[] {
  if (todos.length === 0) return [];
  const done = todos.filter((todo) => todo.status === "done").length;

  let shown = [...todos];
  if (shown.length > maxRows) {
    const open = shown.filter((todo) => todo.status !== "done");
    shown = open.slice(0, maxRows);
  }

  const cells = Math.min(todos.length, TODO_BAR_MAX_CELLS);
  const filled = Math.round((done / todos.length) * cells);
  const bar =
    style("success")(glyphs.barFilled.repeat(filled)) +
    style("muted")(glyphs.barEmpty.repeat(cells - filled));
  const lines = [`${style("muted")("Todos")} ${bar} ${style("muted")(`${done}/${todos.length}`)}`];

  const marks: Record<TodoItem["status"], string> = {
    pending: glyphs.todoPending,
    inProgress: glyphs.todoActive,
    done: glyphs.todoDone,
  };
  for (const todo of shown) {
    const body = truncateToWidth(`  ${marks[todo.status]} ${todo.text}`, width);
    if (todo.status === "done") lines.push(style("muted")(body));
    else if (todo.status === "inProgress") lines.push(style(running ? "accent" : "warning")(body));
    else lines.push(style("text")(body));
  }
  if (shown.length < todos.length) {
    lines.push(style("muted")(`  … ${todos.length - shown.length} more`));
  }
  return lines;
}

/**
 * Render the "arguments are still streaming" progress line.
 *
 * Shown under the activity line while the model dictates a tool call, e.g.
 * `↳ ✎ write · 18.2k chars`. Two or more concurrent calls collapse to an
 * aggregate — `↳ ◇ 2 tool calls · 24.0k chars` — rather than picking one name
 * arbitrarily; a single call always names its tool.
 *
 * @param progress - The in-flight tool call, or `undefined` when idle.
 * @param width - Available columns.
 * @param glyphs - Glyph set supplying the tool marks.
 */
export function renderToolCallProgress(
  progress: ToolCallProgress | undefined,
  width: number,
  glyphs: GlyphSet = FANCY_GLYPHS,
): string[] {
  if (!progress || progress.count === 0) return [];
  const mark = progress.count > 1 ? glyphs.toolDefault : toolGlyph(progress.name, glyphs);
  const label = progress.count > 1 ? `${progress.count} tool calls` : progress.name;
  const detail = `${glyphs.dot} ${formatTokens(progress.chars)} chars`;
  const lead = style("muted")(`  ${glyphs.nested} `);
  const line = `${lead}${style("accent")(`${mark} ${label}`)} ${style("muted")(detail)}`;
  return [truncateToWidth(line, width)];
}

/** Columns below which a sub-agent row drops its right-hand detail column. */
const SUBAGENT_TASK_MIN_WIDTH = 12;
/** Gap between a sub-agent's task and its detail column. */
const SUBAGENT_GAP = 2;

/**
 * Render one row per live sub-agent, shown under the activity line.
 *
 * Without this the live region says only "working", and a run that delegates
 * everything looks identical to one that has hung. Each row names the task and
 * carries a detail column — elapsed, tokens, the sub-agent's own todo progress,
 * and what it is doing right now — whose segments are dropped from the right as
 * the terminal narrows, so the task itself always survives.
 *
 * @param agents - Live sub-agents, oldest first.
 * @param width - Available columns.
 * @param glyphs - Glyph set deciding the nesting connector.
 * @param now - Current wall clock, for elapsed times.
 * @param maxRows - Maximum rows before the remainder is summarised.
 */
export function renderSubagentRows(
  agents: readonly SubagentStatus[],
  width: number,
  glyphs: GlyphSet = FANCY_GLYPHS,
  now: number = Date.now(),
  maxRows = 4,
): string[] {
  if (agents.length === 0) return [];
  const shown = agents.slice(0, maxRows);
  const lines = shown.map((agent) => renderSubagentRow(agent, width, glyphs, now));
  if (shown.length < agents.length) {
    lines.push(
      style("muted")(truncateToWidth(`    … ${agents.length - shown.length} more`, width)),
    );
  }
  return lines;
}

/** Render a single sub-agent row, shedding detail segments as width shrinks. */
function renderSubagentRow(
  agent: SubagentStatus,
  width: number,
  glyphs: GlyphSet,
  now: number,
): string {
  const lead = `${"  ".repeat(agent.depth + 1)}${glyphs.nested} `;
  const segments = [formatDuration(Math.max(0, now - agent.startedAt)), formatTokens(agent.tokens)];
  if (agent.todos && agent.todos.total > 0) {
    segments.push(`${agent.todos.done}/${agent.todos.total}`);
  }
  segments.push(agent.activity);

  for (let keep = segments.length; keep > 0; keep -= 1) {
    const detail = segments.slice(0, keep).join(" · ");
    const room = width - stringWidth(lead) - stringWidth(detail) - SUBAGENT_GAP;
    if (room < SUBAGENT_TASK_MIN_WIDTH) continue;
    const task = padToWidth(truncateToWidth(agent.task, room), room);
    return (
      style("muted")(lead) + style("text")(task) + " ".repeat(SUBAGENT_GAP) + style("muted")(detail)
    );
  }
  return style("muted")(truncateToWidth(`${lead}${agent.task}`, width));
}

/** Columns below which a workflow row drops its right-hand detail column. */
const WORKFLOW_LABEL_MIN_WIDTH = 10;
/** Gap between a workflow step's label and its detail column. */
const WORKFLOW_GAP = 2;
/** Maximum step rows drawn under a stage before the rest are summarised. */
const WORKFLOW_MAX_ROWS = 6;

/** The style token that paints a step in each phase. */
const PHASE_STYLE: Record<WorkflowStepPhase, ThemeToken> = {
  pending: "muted",
  running: "accent",
  done: "success",
  failed: "error",
  skipped: "muted",
  cancelled: "warning",
  paused: "warning",
};

/** The leading glyph that marks a step in each phase. */
function phaseGlyph(phase: WorkflowStepPhase, glyphs: GlyphSet): string {
  switch (phase) {
    case "running":
      return glyphs.statusDot;
    case "done":
      return glyphs.done;
    case "failed":
      return glyphs.error;
    case "cancelled":
      return glyphs.interrupt;
    case "paused":
      return glyphs.warn;
    default:
      return glyphs.dot;
  }
}

/** The `@role [lane] · model` label a step row leads with. */
function stepLabel(step: WorkflowStepView): string {
  const head = step.role ? `@${step.role}` : `step ${step.id}`;
  const parts = [`${head} [${step.lane}]`];
  if (step.model) parts.push(step.model);
  return parts.join(" · ");
}

/**
 * Render the live per-stage / per-role status block for a running workflow.
 *
 * This is the one-glance answer to "is it working or hung": the active stage's
 * steps, each with its lane, elapsed, turns, tokens and what it is doing right
 * now. The structure (which stage, which roles, which lanes) comes from the
 * workflow's own events; the live figures for the step running *now* are read
 * back out of the same {@link SubagentStatus} rows the sub-agent view already
 * shows — there is no second progress meter. It returns an empty array the
 * moment the run ends, so the block collapses with no ghost rows.
 *
 * @param run - The live run view, or `undefined` when nothing is running.
 * @param subagents - The live sub-agent rows, for per-step tokens/turns/tool.
 * @param width - Available columns.
 * @param glyphs - Glyph set deciding marks and connectors.
 * @param now - Current wall clock, for elapsed times.
 */
export function renderWorkflowActivity(
  run: WorkflowRunView | undefined,
  subagents: readonly SubagentStatus[],
  width: number,
  glyphs: GlyphSet = FANCY_GLYPHS,
  now: number = Date.now(),
): string[] {
  if (!run) return [];
  const stageCount = run.stages.length;
  const active =
    run.activeStageIndex !== undefined
      ? run.stages.find((stage) => stage.index === run.activeStageIndex)
      : run.stages.at(-1);

  const header = [
    `${glyphs.arrow} ${style("accent")(`workflow ${run.workflow}`)}`,
    active ? `stage ${active.index}/${stageCount}` : `${stageCount} stage(s)`,
    `${run.doneSteps}/${run.totalSteps} steps`,
    formatDuration(Math.max(0, now - run.startedAt)),
  ].join(` ${style("muted")(glyphs.dot)} `);
  const lines = [truncateToWidth(`${style("muted")(header)}`, width)];

  if (!active) return lines;
  const byAgent = new Map(subagents.map((agent) => [agent.id, agent]));
  const shown = active.steps.slice(0, WORKFLOW_MAX_ROWS);
  for (const step of shown) {
    lines.push(renderWorkflowStepRow(step, byAgent.get(step.agentId), width, glyphs, now));
  }
  if (active.steps.length > shown.length) {
    lines.push(
      style("muted")(
        truncateToWidth(`    ${glyphs.dot} ${active.steps.length - shown.length} more`, width),
      ),
    );
  }
  return lines;
}

/** Render one workflow step row, shedding detail segments as width shrinks. */
function renderWorkflowStepRow(
  step: WorkflowStepView,
  live: SubagentStatus | undefined,
  width: number,
  glyphs: GlyphSet,
  now: number,
): string {
  const paint = style(PHASE_STYLE[step.phase] ?? "text");
  const lead = `  ${paint(phaseGlyph(step.phase, glyphs))} `;

  const segments: string[] = [];
  if (step.phase === "running" && live) {
    segments.push(formatDuration(Math.max(0, now - (step.startedAt ?? live.startedAt))));
    if (live.turns > 0) segments.push(`${live.turns} turn${live.turns === 1 ? "" : "s"}`);
    segments.push(formatTokens(live.tokens));
    segments.push(live.activity);
  } else if (step.phase === "running") {
    segments.push(formatDuration(Math.max(0, now - (step.startedAt ?? now))));
    segments.push("starting");
  } else if (step.phase === "pending") {
    segments.push("queued");
  } else {
    if (step.startedAt !== undefined && step.endedAt !== undefined) {
      segments.push(formatDuration(Math.max(0, step.endedAt - step.startedAt)));
    }
    if (step.tokens > 0) segments.push(formatTokens(step.tokens));
    segments.push(step.recordStatus ?? step.phase);
  }

  const label = stepLabel(step);
  for (let keep = segments.length; keep > 0; keep -= 1) {
    const detail = segments.slice(0, keep).join(" · ");
    const room = width - stringWidth(lead) - stringWidth(detail) - WORKFLOW_GAP;
    if (room < WORKFLOW_LABEL_MIN_WIDTH) continue;
    const body = padToWidth(truncateToWidth(label, room), room);
    return `${style("muted")(lead)}${paint(body)}${" ".repeat(WORKFLOW_GAP)}${style("muted")(detail)}`;
  }
  return `${style("muted")(lead)}${paint(truncateToWidth(label, Math.max(1, width - stringWidth(lead))))}`;
}

/**
 * Keep only the trailing `max` entries of a rendered block.
 *
 * @param lines - Rendered lines.
 * @param max - Maximum rows to keep.
 */
export function tailLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  return [
    style("muted")(`… ${lines.length - max + 1} earlier lines`),
    ...lines.slice(lines.length - max + 1),
  ];
}
