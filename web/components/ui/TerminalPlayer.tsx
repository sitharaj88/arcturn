"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useReducer, useState } from "react";
import { cn } from "@/lib/cn";
import {
  TERMINAL_TONES,
  TerminalFrame,
  type TerminalLine,
  type TerminalSize,
} from "./TerminalMock";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * A played arcturn session, not a still of one (DESIGN.md §3.1, §3.9).
 *
 * The point the site has to make is that the permission gate is real, and a
 * transcript that already contains its own outcome cannot make it: the reader
 * has no way to tell an enforced stop from a screenshot of one. So this
 * component types the prompt, streams the tool calls, **stops at the gate**,
 * and hands the decision to the reader. Denying is the branch that proves it —
 * the edit never lands, and the turn ends saying so.
 *
 * Every glyph and every line below is the product's own output style, checked
 * against `packages/cli/src/glyphs.ts` (`✦ ⚠ ✓ ✗ ⎿ ▸ ›`), the permission
 * dialog in `packages/cli/src/interactive/`, and the static mocks already on
 * the site. Nothing here is output Arcturn would not print (§3.9).
 */

export interface TerminalPlayerProps {
  /** Window title. Defaults to the session the script depicts. */
  title?: string;
  size?: TerminalSize;
  /** §2.3.4 reserves `--shadow-glow` for the primary CTA and the hero terminal. */
  glow?: boolean;
  className?: string;
}

/* ---------------------------------------------------------------- script -- */

const PROMPT = "add input validation to the /signup handler";

const HEADER: TerminalLine = {
  text: "✦ arcturn · claude-sonnet-4-5 · ~/projects/api",
  tone: "accent",
};

/** Rows 2–7: what the agent does before it is allowed to touch anything. */
const APPROACH: readonly TerminalLine[] = [
  { text: "" },
  { text: "  read   src/routes/signup.ts", tone: "muted" },
  { text: '  grep   "validate" src/**', tone: "muted" },
  { text: "" },
  { text: "⚠ Permission required — edit src/routes/signup.ts", tone: "warn" },
  { text: "  a  allow    d  deny    A  always allow src/**.ts", tone: "muted" },
];

/** Header + prompt + {@link APPROACH} + the answer row the gate waits on. */
const GATE_ROWS = 2 + APPROACH.length + 1;

type Branch = "allow" | "deny";

/**
 * Both branches are exactly five rows, which is what lets the frame reserve
 * its full height up front: switching branches can never resize the window.
 *
 * The denial text is verbatim from `interactive/app.ts` — it is the message
 * the model itself receives — carried onto the CLI's own four-space
 * continuation indent so it fits the frame at 360px.
 */
const TAILS: Record<Branch, readonly TerminalLine[]> = {
  allow: [
    { text: "✓ allowed · edit src/routes/signup.ts  +24 −3", tone: "good" },
    { text: "  checkpoint 019a1f@3 · /rewind restores", tone: "muted" },
    { text: "  lsp    0 errors, 0 warnings", tone: "muted" },
    { text: "" },
    { text: "  session 019a1f · $0.0412 / $2.00", tone: "muted" },
  ],
  deny: [
    { text: "✗ denied · edit src/routes/signup.ts", tone: "bad" },
    { text: "  ⎿ The user denied this action. Do not retry it;", tone: "muted" },
    { text: "    choose another approach or ask.", tone: "muted" },
    { text: "" },
    { text: "  I cannot proceed without that edit. Nothing written.", tone: "default" },
  ],
};

const TOTAL_ROWS = GATE_ROWS + TAILS.allow.length;

/** Stable per-position keys: the transcript is a fixed grid, not a list. */
const ROW_KEYS = Array.from({ length: TOTAL_ROWS }, (_, index) => `row-${index}`);

const DESCRIPTIONS: Record<Branch, string> = {
  allow:
    "An arcturn session. The header names the model and the working directory; a prompt asks " +
    "for input validation on the /signup handler; Arcturn reads the route and greps for " +
    "existing validation, then stops and asks permission before editing src/routes/signup.ts, " +
    "offering allow, deny, or always-allow for src/**.ts. The edit is allowed: it lands as 24 " +
    "lines added and 3 removed, a checkpoint is recorded for /rewind, LSP reports no errors, " +
    "and the session's spend so far is shown against its budget.",
  deny:
    "The same arcturn session with the edit denied. Nothing is written; the model is told the " +
    "user denied the action and not to retry it; and the agent ends the turn saying it cannot " +
    "proceed without that edit.",
};

/* ----------------------------------------------------------------- timing -- */

/** Cross-fade between the shipped still and the first frame of the run. */
const HANDOFF_MS = 200;
/** No interaction at the gate for this long and the page answers for you. */
const AUTO_MS = 6000;

interface Beat {
  visible: number;
  delay: number;
  next?: Stage;
}

/** ~300ms tool beats; the first delay doubles as the model's think pause. */
const TOOL_BEATS: readonly Beat[] = [
  { visible: 4, delay: 520 },
  { visible: 5, delay: 340 },
  { visible: GATE_ROWS, delay: 460, next: "gate" },
];

const TAIL_BEATS: readonly Beat[] = [
  { visible: GATE_ROWS + 1, delay: 220 },
  { visible: GATE_ROWS + 2, delay: 300 },
  { visible: GATE_ROWS + 3, delay: 300 },
  { visible: TOTAL_ROWS, delay: 280, next: "done" },
];

/**
 * Gap before the next keystroke. A constant rate reads as a machine typing
 * rather than a person, so the interval is jittered — but derived from the
 * character index, so a replay is identical to the first run.
 */
function keystrokeDelay(index: number): number {
  return 22 + ((index * 37) % 5) * 6;
}

/* ------------------------------------------------------------------ state -- */

type Stage = "static" | "handoff" | "typing" | "tools" | "gate" | "tail" | "done";

interface State {
  stage: Stage;
  /** Characters of {@link PROMPT} on screen. */
  typed: number;
  /** How many leading rows are on screen; the rest are reserved but blank. */
  visible: number;
  branch: Branch;
  /** True once the gate has an answer, which is what draws the key echo. */
  decided: boolean;
  /** The answer came from {@link AUTO_MS}, not from the reader. */
  auto: boolean;
}

/**
 * The frame the static export ships: the completed allow branch.
 *
 * Same inversion as `<Reveal>` — the server-rendered markup is the finished,
 * meaningful thing, and JS opts it into the animation afterwards. A player
 * that shipped an empty window would leave a blank rectangle for anyone
 * without JS, for crawlers, and for the gap before hydration.
 */
const SETTLED = {
  stage: "static",
  typed: PROMPT.length,
  visible: TOTAL_ROWS,
  branch: "allow",
  decided: true,
  auto: false,
} as const satisfies State;

type Action =
  | { type: "handoff" }
  | { type: "begin" }
  | { type: "type" }
  | { type: "reveal"; visible: number; next?: Stage }
  | { type: "decide"; branch: Branch; auto: boolean; reduced: boolean }
  | { type: "settle" };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "handoff":
      return { ...SETTLED, stage: "handoff" };
    case "begin":
      return {
        stage: "typing",
        typed: 0,
        visible: 2,
        branch: "allow",
        decided: false,
        auto: false,
      };
    case "type": {
      const typed = Math.min(state.typed + 1, PROMPT.length);
      // Reaching the end of the prompt IS the transition, so no extra timer.
      return typed < PROMPT.length ? { ...state, typed } : { ...state, typed, stage: "tools" };
    }
    case "reveal":
      return { ...state, visible: action.visible, stage: action.next ?? state.stage };
    case "decide": {
      // Switching branches on a finished run swaps the tail with no replay;
      // deciding at (or before) the gate plays the outcome out beat by beat.
      const instant = action.reduced || state.stage === "tail" || state.stage === "done";
      return {
        ...state,
        stage: instant ? "done" : "tail",
        typed: PROMPT.length,
        visible: instant ? TOTAL_ROWS : GATE_ROWS,
        branch: action.branch,
        decided: true,
        auto: action.auto,
      };
    }
    case "settle":
      return { ...SETTLED, stage: "done" };
  }
}

/* --------------------------------------------------------------- component -- */

export function TerminalPlayer({
  title = "arcturn — ~/projects/api",
  size = "lg",
  glow = false,
  className,
}: TerminalPlayerProps) {
  const [state, dispatch] = useReducer(reduce, SETTLED);
  const { stage, typed, visible, branch, decided, auto } = state;

  // `null` until the media query has been read, so nothing is scheduled on the
  // strength of a guess about the reader's motion preference.
  const [reduced, setReduced] = useState<boolean | null>(null);

  // The caption only becomes a live region once the reader has touched a
  // control. Autoplay is not a reason to interrupt a screen reader three times
  // on a page nobody asked to hear narrated; a decision they made is.
  const [announce, setAnnounce] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (reduced === null) return;
    // Reduced motion gets the completed allow branch and no timers at all;
    // the buttons still switch branches, instantly.
    dispatch(reduced ? { type: "settle" } : { type: "handoff" });
  }, [reduced]);

  // One scheduler, one timer, one teardown: whatever the stage, at most a
  // single timeout is outstanding, and it is cleared before the next runs —
  // so a finished (or unmounted) player leaves nothing behind.
  useEffect(() => {
    if (reduced !== false) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (stage === "handoff") {
      timer = setTimeout(() => dispatch({ type: "begin" }), HANDOFF_MS);
    } else if (stage === "typing") {
      timer = setTimeout(() => dispatch({ type: "type" }), keystrokeDelay(typed));
    } else if (stage === "gate") {
      timer = setTimeout(
        () => dispatch({ type: "decide", branch: "allow", auto: true, reduced: false }),
        AUTO_MS,
      );
    } else if (stage === "tools" || stage === "tail") {
      const beats = stage === "tools" ? TOOL_BEATS : TAIL_BEATS;
      const beat = beats.find((candidate) => candidate.visible > visible);
      if (beat) {
        timer = setTimeout(
          () =>
            dispatch({
              type: "reveal",
              visible: beat.visible,
              ...(beat.next && { next: beat.next }),
            }),
          beat.delay,
        );
      }
    }

    return () => clearTimeout(timer);
  }, [reduced, stage, typed, visible]);

  const decide = useCallback(
    (next: Branch) => {
      setAnnounce(true);
      dispatch({ type: "decide", branch: next, auto: false, reduced: reduced === true });
    },
    [reduced],
  );

  const replay = useCallback(() => {
    setAnnounce(true);
    dispatch(reduced ? { type: "settle" } : { type: "begin" });
  }, [reduced]);

  const rows: TerminalLine[] = [
    HEADER,
    { text: `› ${PROMPT.slice(0, typed)}`, tone: "prompt", cursor: stage === "typing" },
    ...APPROACH,
    // The gate's answer prompt. The cursor blinks here because the CLI is
    // genuinely waiting on a keystroke — and the echoed key is how an
    // auto-chosen answer stays visibly an answer, not lines that just appeared.
    {
      text: `  ▸ ${decided ? (branch === "allow" ? "a" : "d") : ""}`,
      tone: "muted",
      cursor: stage === "gate",
    },
    ...TAILS[branch],
  ];

  return (
    <div className={cn("w-full", className)}>
      <TerminalFrame
        title={title}
        size={size}
        glow={glow}
        footer={
          <div className="rounded-b-xl border-t border-default bg-surface-card px-3 py-3 sm:px-4">
            <div className="flex items-center gap-2">
              <GateKey
                cap="a"
                label="allow"
                name="Allow the edit"
                tone="text-good"
                pressed={decided && branch === "allow"}
                onClick={() => decide("allow")}
              />
              <GateKey
                cap="d"
                label="deny"
                name="Deny the edit"
                tone="text-bad"
                pressed={decided && branch === "deny"}
                onClick={() => decide("deny")}
              />
              <button
                type="button"
                onClick={replay}
                aria-label="Replay the session"
                className={cn(
                  "ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-md sm:size-9",
                  "border border-default bg-surface-raised text-faint",
                  "transition-colors dur-fast ease-out hover:border-strong hover:text-text",
                )}
              >
                <RotateCcw aria-hidden="true" className="size-4" />
              </button>
            </div>
            <p
              aria-live={announce ? "polite" : "off"}
              className="mt-2 line-clamp-2 min-h-10 text-caption leading-5 text-faint sm:line-clamp-1 sm:min-h-5"
            >
              {caption(stage, branch, decided, auto)}
            </p>
          </div>
        }
      >
        <pre
          className={cn(
            "min-w-max font-mono leading-[1.65] transition-opacity dur-base ease-out",
            stage === "handoff" ? "opacity-0" : "opacity-100",
          )}
        >
          {ROW_KEYS.map((key, index) => {
            const line = rows[index];
            const shown = index < visible;
            return (
              <div
                key={key}
                className={cn(
                  // Adding the class is what starts the fade-up, so a row
                  // animates exactly once: when it arrives.
                  shown ? "term-line" : "opacity-0",
                  TERMINAL_TONES[line.tone ?? "default"],
                )}
              >
                {(shown && line.text) || " "}
                {shown && line.cursor ? <span className="term-cursor ml-0.5 align-middle" /> : null}
              </div>
            );
          })}
        </pre>
      </TerminalFrame>
      <VisuallyHidden as="p">{DESCRIPTIONS[branch]}</VisuallyHidden>
    </div>
  );
}

function caption(stage: Stage, branch: Branch, decided: boolean, auto: boolean): string {
  if (stage === "gate") return "Waiting for you: allow or deny.";
  if (!decided) return "Running the session.";
  if (branch === "deny") return "Denied. Nothing was written; the turn ended there.";
  if (auto) return "Allowed automatically after 6 seconds. Deny to see the other branch.";
  return "Allowed. The edit landed, and a checkpoint was written first.";
}

interface GateKeyProps {
  /** The key the CLI itself listens for. */
  cap: string;
  label: string;
  /** Accessible name — the transcript that gives these buttons context is
   *  `aria-hidden`, so the name has to carry the whole meaning on its own. */
  name: string;
  tone: string;
  pressed: boolean;
  onClick: () => void;
}

function GateKey({ cap, label, name, tone, pressed, onClick }: GateKeyProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-11 items-center gap-1.5 rounded-md border px-3 font-mono text-caption sm:h-9",
        "transition-colors dur-fast ease-out",
        pressed
          ? cn("border-accent-edge bg-surface-hover", tone)
          : "border-default bg-surface-raised text-muted hover:border-strong hover:text-text",
      )}
    >
      <span
        className={cn(
          "rounded-xs border px-1 py-px text-[0.6875rem]",
          pressed ? "border-accent-edge" : "border-strong",
        )}
      >
        {cap}
      </span>
      {label}
    </button>
  );
}
