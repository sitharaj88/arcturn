import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { withStableKeys } from "@/lib/keys";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * Terminal art (DESIGN.md §2.4, §2.6).
 *
 * The block depicts a real terminal, so it is pinned dark in both themes via
 * `.force-dark` and is `aria-hidden`; the mandatory `description` prop is
 * rendered visually-hidden beside it so assistive technology gets the meaning
 * without the ANSI-style noise. The line stagger is CSS-only — no client JS.
 *
 * The chrome lives in `<TerminalFrame>` rather than here because
 * `<TerminalPlayer>` — the interactive session on `/` and `/terminal` — has to
 * draw the identical window. One copy of the window means the still and the
 * moving picture can never drift apart.
 */
export type TerminalVariant = "session" | "permission" | "diff" | "subagent" | "rewind";
export type TerminalSize = "md" | "lg";
export type TerminalTone = "default" | "muted" | "accent" | "good" | "warn" | "bad" | "prompt";

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

export interface TerminalLine {
  text: string;
  tone?: TerminalTone;
  /** Render a blinking cursor at the end of this line. */
  cursor?: boolean;
}

/**
 * Tone → utility class. Exported so `<TerminalPlayer>` paints its streamed
 * lines from the same table; a second table would be a second truth.
 */
export const TERMINAL_TONES: Record<TerminalTone, string> = {
  default: "text-text",
  muted: "text-muted",
  accent: "text-accent",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  prompt: "text-faint",
};

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
        size === "lg" ? "text-[0.875rem]" : "text-code-block",
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

const SCRIPTS: Record<TerminalVariant, { title: string; lines: TerminalLine[] }> = {
  session: {
    title: "arcturn — ~/projects/api",
    lines: [
      { text: "✦ arcturn · claude-sonnet-4-5 · ~/projects/api", tone: "accent" },
      { text: "› add input validation to the /signup handler", tone: "prompt" },
      { text: "" },
      { text: "  read   src/routes/signup.ts", tone: "muted" },
      { text: '  grep   "validate" src/**', tone: "muted" },
      { text: "  edit   src/routes/signup.ts  +24 −3", tone: "good" },
      { text: "  lsp    0 errors, 0 warnings", tone: "muted" },
      { text: "" },
      { text: "  session 019a1f · 3 turns · $0.0412 of $2.00", tone: "muted", cursor: true },
    ],
  },
  permission: {
    title: "arcturn — permission",
    lines: [
      { text: "✦ arcturn · claude-sonnet-4-5 · ~/projects/api", tone: "accent" },
      { text: "› add input validation to the /signup handler", tone: "prompt" },
      { text: "" },
      { text: "⚠ Permission required — edit src/routes/signup.ts", tone: "warn" },
      { text: "  a  allow    d  deny    A  always allow src/**.ts", tone: "muted" },
      { text: "" },
      { text: "  ▸ ", tone: "muted", cursor: true },
    ],
  },
  diff: {
    title: "arcturn — dry run",
    lines: [
      { text: "› /diff", tone: "prompt" },
      { text: "" },
      { text: "  src/routes/signup.ts", tone: "muted" },
      { text: "+   const parsed = SignupSchema.safeParse(req.body);", tone: "good" },
      { text: "+   if (!parsed.success) return res.status(400).json(parsed.error);", tone: "good" },
      { text: "-   const parsed = req.body;", tone: "bad" },
      { text: "" },
      { text: "  shadow tree · /apply to land · /discard to drop", tone: "muted", cursor: true },
    ],
  },
  subagent: {
    title: "arcturn — sub-agent",
    lines: [
      { text: "› /agents run reviewer", tone: "prompt" },
      { text: "" },
      { text: "  ⤷ reviewer · gpt-5 · read-only tools", tone: "accent" },
      { text: "    read   src/routes/signup.ts", tone: "muted" },
      { text: "    read   src/schema/signup.ts", tone: "muted" },
      { text: "  ⤶ returned to parent session", tone: "muted" },
      { text: "" },
      {
        text: "  sub-agent spend $0.0091 · counted against --max-cost",
        tone: "muted",
        cursor: true,
      },
    ],
  },
  rewind: {
    title: "arcturn — rewind",
    lines: [
      { text: "› /rewind 3", tone: "prompt" },
      { text: "" },
      { text: "  restored  src/routes/signup.ts", tone: "good" },
      { text: "  restored  src/schema/signup.ts", tone: "good" },
      { text: "  forked    turn 3 → branch b2 (turns 4–6 kept)", tone: "accent" },
      { text: "" },
      { text: "  both branches remain walkable", tone: "muted", cursor: true },
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

  return (
    <div className={cn("w-full", className)}>
      <TerminalFrame title={title ?? script.title} size={size} glow={glow}>
        <pre className="min-w-max font-mono leading-[1.65]">
          {withStableKeys(body, (line) => line.text).map(({ key, item: line }, index) => (
            <div
              key={key}
              className={cn("term-line", TERMINAL_TONES[line.tone ?? "default"] ?? "text-text")}
              style={{ animationDelay: `${index * 60}ms` } as CSSProperties}
            >
              {line.text || " "}
              {line.cursor ? <span className="term-cursor ml-0.5 align-middle" /> : null}
            </div>
          ))}
        </pre>
      </TerminalFrame>
      <VisuallyHidden as="p">{description}</VisuallyHidden>
    </div>
  );
}
