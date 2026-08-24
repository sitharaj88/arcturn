import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { withStableKeys } from "@/lib/keys";
import { describeTerminalLine, isStructuredScript } from "./terminal/describe";
import { TerminalRow } from "./terminal/rows";
import type { TerminalLine } from "./terminal/types";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * Terminal art (DESIGN.md §2.4, §2.6).
 *
 * The block depicts a real terminal, so it is pinned dark in both themes via
 * `.force-dark` and is `aria-hidden`; the mandatory `description` prop is
 * rendered visually-hidden beside it so assistive technology gets the meaning
 * without the ANSI-style noise. The line stagger is CSS-only — no client JS.
 *
 * Lines are **structured**, not strings: `{ kind: "tool", name, args }` rather
 * than a hand-spaced `"  read   src/routes/signup.ts"`. The component owns the
 * glyph, the column and the tone, so a mock is drawn from the same vocabulary
 * the CLI prints — see `./terminal/glyphs`. `{ text, tone }` is still a legal
 * line (it is the `"text"` kind with its discriminant left off), so scripts
 * written against the old shape render exactly as they did.
 *
 * The chrome lives in `<TerminalFrame>` rather than here because
 * `<TerminalPlayer>` — the interactive session on `/` and `/terminal` — has to
 * draw the identical window. One copy of the window means the still and the
 * moving picture can never drift apart.
 */
export type TerminalVariant = "session" | "permission" | "diff" | "subagent" | "rewind";
export type TerminalSize = "md" | "lg";

export * from "./terminal/describe";
export * from "./terminal/glyphs";
export * from "./terminal/rows";
export * from "./terminal/types";

export interface TerminalMockProps {
  variant?: TerminalVariant;
  size?: TerminalSize;
  /** One sentence describing the session, for screen readers. Required. */
  description: string;
  /** Override the scripted lines with custom content. */
  lines?: TerminalLine[];
  /** §2.3.4 reserves the glow for the hero terminal, so every other one is flat. */
  glow?: boolean;
  title?: string;
  className?: string;
}

export interface TerminalFrameProps {
  /** Window title, shown beside the traffic lights. */
  title: string;
  size?: TerminalSize;
  /** §2.3.4: `--shadow-glow` belongs to the primary CTA and the hero terminal. */
  glow?: boolean;
  /** The transcript. Rendered inside the `aria-hidden` subtree. */
  children: ReactNode;
  /**
   * Controls rendered under the transcript, still inside the window but
   * OUTSIDE the `aria-hidden` subtree. §2.6 hides the transcript from
   * assistive technology, so a button placed in it would be unreachable —
   * this slot is the only place in the frame where a real control can live.
   */
  footer?: ReactNode;
}

/**
 * The window: traffic lights, title, and a transcript area that owns its own
 * horizontal scroll (§2.3.5 — the page body never scrolls sideways).
 */
export function TerminalFrame({
  title,
  size = "md",
  glow = false,
  children,
  footer,
}: TerminalFrameProps) {
  return (
    <div
      className={cn(
        "force-dark arc-corner rounded-xl border border-default bg-surface-raised",
        glow && "elev-glow",
        // §2.2.2 owns both terminal sizes; this file used to carry the literal.
        size === "lg" ? "text-code-block-lg" : "text-code-block",
      )}
    >
      <div aria-hidden="true">
        <div className="flex items-center gap-2 rounded-t-xl border-b border-default bg-surface-card px-4 py-3">
          <span className="size-2.5 rounded-full bg-bad-dark" />
          <span className="size-2.5 rounded-full bg-warn-dark" />
          <span className="size-2.5 rounded-full bg-good-dark" />
          <span className="ml-2 truncate font-mono text-caption text-faint">{title}</span>
        </div>
        <div
          className={cn(
            "overflow-x-auto bg-surface-inset px-4 py-4",
            // The footer, when present, owns the bottom corners instead.
            footer ? undefined : "rounded-b-xl",
          )}
        >
          {children}
        </div>
      </div>
      {footer}
    </div>
  );
}

/**
 * The shipped scripts.
 *
 * Every line is the product's own output shape — a tool call is a tool call,
 * the gate is the CLI's own bordered dialog with its own three answers, the
 * last row is the status bar the terminal always ends on (DESIGN.md §3.9).
 */
const SCRIPTS: Record<TerminalVariant, { title: string; lines: TerminalLine[] }> = {
  session: {
    title: "arcturn — ~/projects/api",
    lines: [
      { kind: "chrome", model: "claude-sonnet-4-5", cwd: "~/projects/api" },
      { kind: "user", text: "add input validation to the /signup handler" },
      { kind: "blank" },
      { kind: "tool", name: "read", args: "src/routes/signup.ts" },
      { kind: "result", text: "84 lines" },
      { kind: "tool", name: "grep", args: '"validate" src/**' },
      { kind: "result", text: "2 files" },
      { kind: "tool", name: "edit", args: "src/routes/signup.ts" },
      { kind: "result", text: "+24 −3" },
      { kind: "result", text: "lsp 0 errors, 0 warnings", cont: true },
      { kind: "blank" },
      { kind: "done", elapsed: "1m34s", tokens: "1.3k" },
      { kind: "input" },
      {
        kind: "status",
        model: "claude-sonnet-4-5",
        mode: "default",
        cost: "$0.0412",
        ctx: "12%",
      },
    ],
  },
  permission: {
    title: "arcturn — permission",
    lines: [
      { kind: "chrome", model: "claude-sonnet-4-5", cwd: "~/projects/api" },
      { kind: "user", text: "add input validation to the /signup handler" },
      { kind: "blank" },
      { kind: "tool", name: "read", args: "src/routes/signup.ts" },
      { kind: "tool", name: "grep", args: '"validate" src/**' },
      { kind: "blank" },
      {
        kind: "permission",
        tool: "edit",
        subject: "src/routes/signup.ts",
        description: "edit: add a SignupSchema check before the handler body",
        rule: "edit src/**.ts",
        selected: "once",
      },
      {
        kind: "status",
        model: "claude-sonnet-4-5",
        mode: "default",
        cost: "$0.0087",
        ctx: "9%",
      },
    ],
  },
  diff: {
    title: "arcturn — dry run",
    lines: [
      { kind: "user", text: "/diff" },
      { kind: "blank" },
      { text: "  src/routes/signup.ts", tone: "muted" },
      { text: "+   const parsed = SignupSchema.safeParse(req.body);", tone: "good" },
      { text: "+   if (!parsed.success) return res.status(400).json(parsed.error);", tone: "good" },
      { text: "-   const parsed = req.body;", tone: "bad" },
      { kind: "blank" },
      { kind: "notice", level: "info", text: "shadow tree · /apply to land · /discard to drop" },
    ],
  },
  subagent: {
    title: "arcturn — sub-agent",
    lines: [
      { kind: "user", text: "/agents run reviewer" },
      { kind: "blank" },
      { kind: "tool", name: "subagent", args: "reviewer · gpt-5 · read-only tools" },
      { kind: "tool", name: "read", args: "src/routes/signup.ts", depth: 1 },
      { kind: "tool", name: "read", args: "src/schema/signup.ts", depth: 1 },
      { kind: "result", text: "returned to parent session" },
      { kind: "blank" },
      {
        kind: "notice",
        level: "info",
        text: "sub-agent spend $0.0091 · counted against --max-cost",
      },
    ],
  },
  rewind: {
    title: "arcturn — rewind",
    lines: [
      { kind: "user", text: "/rewind 3" },
      { kind: "blank" },
      { kind: "notice", level: "good", text: "restored  src/routes/signup.ts" },
      { kind: "notice", level: "good", text: "restored  src/schema/signup.ts" },
      { kind: "notice", level: "info", text: "forked    turn 3 → branch b2 (turns 4–6 kept)" },
      { kind: "blank" },
      { text: "both branches remain walkable", tone: "muted" },
    ],
  },
};

export function TerminalMock({
  variant = "session",
  size = "md",
  description,
  lines,
  glow = false,
  title,
  className,
}: TerminalMockProps) {
  const script = SCRIPTS[variant];
  const body = lines ?? script.lines;
  // §2.6 hides hand-spaced transcripts because reading them aloud is noise.
  // A structured script is different: every line can name what it is, so the
  // reader gets the steps as well as the summary.
  const spoken = isStructuredScript(body)
    ? body.map(describeTerminalLine).filter((sentence) => sentence !== "")
    : [];

  return (
    <div className={cn("w-full", className)}>
      <TerminalFrame title={title ?? script.title} size={size} glow={glow}>
        <div className="min-w-max font-mono leading-[1.65]">
          {withStableKeys(body, describeTerminalLine).map(({ key, item }, index) => (
            <TerminalRow key={key} line={item} delay={index * 60} />
          ))}
        </div>
      </TerminalFrame>
      <VisuallyHidden as="div">
        <p>{description}</p>
        {spoken.length > 0 ? (
          <ol>
            {withStableKeys(spoken, (sentence) => sentence).map(({ key, item }) => (
              <li key={key}>{item}</li>
            ))}
          </ol>
        ) : null}
      </VisuallyHidden>
    </div>
  );
}
