import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  TERMINAL_DIALOG_FOOTER,
  TERMINAL_GLYPHS,
  TERMINAL_PERMISSION_TITLE,
  terminalToolGlyph,
} from "./glyphs";
import {
  chromeFacts,
  doneFacts,
  FACT_SEPARATOR,
  inputLabel,
  inputText,
  permissionOptions,
  statusLeftFacts,
  statusRightFacts,
  thinkingFacts,
} from "./labels";
import {
  TERMINAL_TONES,
  type TerminalChromeLine,
  type TerminalDoneLine,
  type TerminalInputLine,
  type TerminalLine,
  type TerminalNoticeLevel,
  type TerminalNoticeLine,
  type TerminalPermissionLine,
  type TerminalResultLine,
  type TerminalStatusLine,
  type TerminalTextLine,
  type TerminalThinkingLine,
  type TerminalToolLine,
  type TerminalUserLine,
} from "./types";

/**
 * The painted transcript.
 *
 * Every row is drawn from the vocabulary in `./glyphs`, laid out on the
 * terminal's own grid: a one-character column per glyph so tool names align
 * down the transcript, results indented under the call they belong to, and the
 * two dialogs drawn as real bordered boxes with their labels riding the border
 * — the way the TUI's `Box` splices a title into its top run of `─`.
 *
 * Rows carry `whitespace-pre` individually rather than sitting inside a `<pre>`:
 * the boxes are flex/absolute layouts, and inherited `white-space: pre` turns
 * every newline in this file into a rendered line break.
 */

/** Number of glyph columns a nesting level indents by. */
const DEPTH_COLUMNS = 2;

/** Columns a result's connector is indented by, so it sits under the glyph. */
const RESULT_COLUMNS = 2;

/** Blank glyph columns, as literal spaces. */
function columns(count: number): string {
  return " ".repeat(Math.max(0, count));
}

/**
 * One character cell.
 *
 * Half of these marks come from blocks a monospace face may not cover, so they
 * fall back to whatever does — at whatever width that face draws them. A fixed
 * `1ch` box keeps the column honest regardless, which is what makes the tool
 * names line up.
 */
function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-block w-[1ch] text-center", className)}>{children}</span>;
}

/** The blinking block cursor, drawn only where a line asks for one. */
function Cursor() {
  return <span className="term-cursor ml-0.5 align-middle" />;
}

/** A transcript row: the stagger hook, the tone, and the terminal's grid. */
function Row({
  className,
  style,
  children,
}: {
  className?: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={cn("term-line whitespace-pre", className)} style={style}>
      {children}
    </div>
  );
}

function ChromeRow({ line, style }: { line: TerminalChromeLine; style: CSSProperties }) {
  const detail = chromeFacts(line).join(FACT_SEPARATOR);
  return (
    <Row style={style}>
      <Cell className="text-accent">{TERMINAL_GLYPHS.brand}</Cell>{" "}
      <span className="font-semibold text-accent">{line.app ?? "arcturn"}</span>
      {detail !== "" ? <span className="text-muted">{`${FACT_SEPARATOR}${detail}`}</span> : null}
      {line.cursor === true ? <Cursor /> : null}
    </Row>
  );
}

function UserRow({ line, style }: { line: TerminalUserLine; style: CSSProperties }) {
  return (
    <Row style={style}>
      <Cell className="text-accent">{TERMINAL_GLYPHS.userGutter}</Cell>{" "}
      <span className={TERMINAL_TONES[line.tone ?? "default"]}>{line.text}</span>
      {line.cursor === true ? <Cursor /> : null}
    </Row>
  );
}

function ToolRow({ line, style }: { line: TerminalToolLine; style: CSSProperties }) {
  const depth = line.depth ?? 0;
  const nested = depth > 0;
  return (
    <Row style={style}>
      {columns(depth * DEPTH_COLUMNS)}
      <Cell className={nested ? "text-muted" : line.state === "error" ? "text-bad" : "text-accent"}>
        {nested ? TERMINAL_GLYPHS.nested : TERMINAL_GLYPHS.statusDot}
      </Cell>{" "}
      <Cell className="text-accent">{terminalToolGlyph(line.name)}</Cell>{" "}
      <span className="font-semibold text-text">{line.name}</span>
      {line.args !== undefined && line.args !== "" ? (
        <span className={TERMINAL_TONES[line.tone ?? "muted"]}>{`  ${line.args}`}</span>
      ) : null}
      {line.cursor === true ? <Cursor /> : null}
    </Row>
  );
}

function ResultRow({ line, style }: { line: TerminalResultLine; style: CSSProperties }) {
  const indent = (line.depth ?? 0) * DEPTH_COLUMNS + RESULT_COLUMNS;
  return (
    <Row style={style}>
      {columns(indent)}
      {line.cont === true ? (
        columns(RESULT_COLUMNS)
      ) : (
        <>
          <Cell className="text-faint">{TERMINAL_GLYPHS.treeResult}</Cell>{" "}
        </>
      )}
      <span className={TERMINAL_TONES[line.tone ?? "muted"]}>{line.text}</span>
      {line.cursor === true ? <Cursor /> : null}
    </Row>
  );
}

const NOTICE_MARKS: Record<TerminalNoticeLevel, { glyph: string; tone: string }> = {
  info: { glyph: TERMINAL_GLYPHS.info, tone: "text-accent" },
  warn: { glyph: TERMINAL_GLYPHS.warn, tone: "text-warn" },
  good: { glyph: TERMINAL_GLYPHS.done, tone: "text-good" },
  bad: { glyph: TERMINAL_GLYPHS.error, tone: "text-bad" },
};

function NoticeRow({ line, style }: { line: TerminalNoticeLine; style: CSSProperties }) {
  const mark = NOTICE_MARKS[line.level];
  return (
    <Row style={style}>
      <Cell className={mark.tone}>{mark.glyph}</Cell>{" "}
      <span className={line.tone ? TERMINAL_TONES[line.tone] : mark.tone}>{line.text}</span>
      {line.cursor === true ? <Cursor /> : null}
    </Row>
  );
}

function ThinkingRow({ line, style }: { line: TerminalThinkingLine; style: CSSProperties }) {
  return (
    <Row style={style}>
      <Cell className="text-accent-hover">{TERMINAL_GLYPHS.spinner}</Cell>{" "}
      <span className="text-accent">{line.verb ?? "thinking"}</span>
      <span className="text-muted">{`${FACT_SEPARATOR}${thinkingFacts(line).join(FACT_SEPARATOR)}`}</span>
    </Row>
  );
}

function DoneRow({ line, style }: { line: TerminalDoneLine; style: CSSProperties }) {
  return (
    <Row style={style}>
      <Cell className="text-good">{TERMINAL_GLYPHS.done}</Cell>{" "}
      <span className={TERMINAL_TONES[line.tone ?? "muted"]}>
        {doneFacts(line).join(FACT_SEPARATOR)}
      </span>
      {line.cursor === true ? <Cursor /> : null}
    </Row>
  );
}

/**
 * A label riding a border line.
 *
 * The TUI splices its box title into the top run of `─`; on the web the
 * equivalent is a patch of the transcript's own ground painted over the
 * hairline. `-mt-[0.5em]` against a `leading-none` box centres the label on the
 * border exactly, and it is a margin rather than a `-translate-y-1/2` on
 * purpose: §2.5's reduced-motion switch flattens `translate` under `:hover`,
 * which would drop the label off its border the moment a pointer crossed it.
 */
function BorderLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("absolute whitespace-pre bg-surface-inset px-1 leading-none", className)}>
      {children}
    </span>
  );
}

/** One answer in a dialog's `SelectList`; `❯` marks the highlighted row. */
function ChoiceRow({ label, selected }: { label: string; selected: boolean }) {
  return (
    <div className="whitespace-pre">
      <Cell className="text-accent">{selected ? TERMINAL_GLYPHS.pointer : " "}</Cell>{" "}
      <span className={selected ? "font-semibold text-accent" : "text-text"}>{label}</span>
    </div>
  );
}

/**
 * The gate.
 *
 * `border-warn` is not a design choice made here: `permissionDialog` builds its
 * box with `borderStyle: "warning"`, and `--warn` is where that token lands on
 * the web. It is also the loudest hairline the mock draws, which is correct —
 * the gate is the one thing in the transcript that has stopped and is waiting.
 */
function PermissionRow({ line, style }: { line: TerminalPermissionLine; style: CSSProperties }) {
  const selected = line.selected ?? "once";
  return (
    <div className="term-line" style={style}>
      <div className="relative my-2 rounded-md border border-warn px-3 py-1.5">
        <BorderLabel className="left-2 top-0 -mt-[0.5em] text-warn">
          {TERMINAL_PERMISSION_TITLE}
        </BorderLabel>
        {line.origin !== undefined && line.origin !== "" ? (
          <div className="whitespace-pre text-accent">
            <Cell>{TERMINAL_GLYPHS.nested}</Cell> {line.origin}
          </div>
        ) : null}
        <div className="whitespace-pre text-warn">
          <Cell>{terminalToolGlyph(line.tool)}</Cell> {line.tool}
        </div>
        <div className="whitespace-pre font-semibold text-text">{line.subject}</div>
        {line.description !== undefined && line.description !== "" ? (
          <div className="whitespace-pre text-muted">{line.description}</div>
        ) : null}
        <div className="whitespace-pre"> </div>
        {permissionOptions(line).map((option) => (
          <ChoiceRow key={option.key} label={option.label} selected={option.key === selected} />
        ))}
        <div className="whitespace-pre text-muted">{line.footer ?? TERMINAL_DIALOG_FOOTER}</div>
      </div>
    </div>
  );
}

/**
 * The prompt editor's frame.
 *
 * `InputBox` paints its border with the accent, but a terminal draws that
 * border out of thin box-drawing glyphs, which land on screen at a fraction of
 * the colour's full weight. A crisp 1px CSS line at full `--accent` is a much
 * louder object than the one the product actually shows, and it would rival the
 * permission dialog above it — so the border takes `--accent-quiet`, the token
 * §2.1.5 reserves for exactly this: decoration, on an `aria-hidden` frame.
 */
function InputRow({ line, style }: { line: TerminalInputLine; style: CSSProperties }) {
  const typed = line.value !== undefined && line.value !== "";
  const running = line.running === true;
  return (
    <div className="term-line" style={style}>
      <div className="relative my-2 rounded-md border border-accent-quiet px-3 py-1.5">
        <div className="whitespace-pre">
          <Cell className="text-accent">{TERMINAL_GLYPHS.promptCaret}</Cell>{" "}
          <span className={typed ? "text-text" : "text-faint"}>{inputText(line)}</span>
          {line.cursor === true ? <Cursor /> : null}
        </div>
        <BorderLabel
          className={cn("bottom-0 right-2 -mb-[0.5em]", running ? "text-accent" : "text-muted")}
        >
          {inputLabel(line)}
        </BorderLabel>
      </div>
    </div>
  );
}

function StatusRow({ line, style }: { line: TerminalStatusLine; style: CSSProperties }) {
  const left = statusLeftFacts(line).join(FACT_SEPARATOR);
  const right = statusRightFacts(line).join(FACT_SEPARATOR);
  return (
    <div
      className="term-line flex w-full items-baseline justify-between gap-6 whitespace-pre"
      style={style}
    >
      <span>
        <Cell className="text-accent">{TERMINAL_GLYPHS.brand}</Cell>{" "}
        <span className="font-semibold text-accent">{line.app ?? "arcturn"}</span>
        {left !== "" ? <span className="text-faint">{`${FACT_SEPARATOR}${left}`}</span> : null}
      </span>
      {right !== "" ? <span className="text-faint">{right}</span> : null}
    </div>
  );
}

function TextRow({ line, style }: { line: TerminalTextLine; style: CSSProperties }) {
  return (
    <Row className={TERMINAL_TONES[line.tone ?? "default"]} style={style}>
      {line.text === "" ? " " : line.text}
      {line.cursor === true ? <Cursor /> : null}
    </Row>
  );
}

/** Props for {@link TerminalRow}. */
export interface TerminalRowProps {
  /** The line to draw. */
  line: TerminalLine;
  /** Entrance delay in milliseconds — the CSS-only stagger, §2.5. */
  delay: number;
}

/**
 * Draw one transcript line.
 *
 * The `default` arm is the `"text"` kind, whose discriminant is optional: it is
 * where every `{ text, tone }` line written before the structured kinds existed
 * still lands, unchanged.
 */
export function TerminalRow({ line, delay }: TerminalRowProps) {
  const style = { animationDelay: `${delay}ms` } as CSSProperties;
  switch (line.kind) {
    case "chrome":
      return <ChromeRow line={line} style={style} />;
    case "user":
      return <UserRow line={line} style={style} />;
    case "tool":
      return <ToolRow line={line} style={style} />;
    case "result":
      return <ResultRow line={line} style={style} />;
    case "notice":
      return <NoticeRow line={line} style={style} />;
    case "permission":
      return <PermissionRow line={line} style={style} />;
    case "thinking":
      return <ThinkingRow line={line} style={style} />;
    case "done":
      return <DoneRow line={line} style={style} />;
    case "input":
      return <InputRow line={line} style={style} />;
    case "status":
      return <StatusRow line={line} style={style} />;
    case "blank":
      return <Row style={style}> </Row>;
    default:
      return <TextRow line={line} style={style} />;
  }
}
