/**
 * The interactive TUI application.
 *
 * Layout follows the guidance in `@arcturn/tui`'s notes: finished transcript
 * lines are printed straight to the terminal so they land in real scrollback,
 * and the {@link TUI} instance holds only the live region — the streaming
 * assistant block, the todo checklist, the activity line, the editor and the
 * status bar.
 *
 * Printing to a terminal that a differential renderer is driving needs care.
 * {@link InteractiveApp.flushScrollback} empties the component list and renders
 * once, which makes the renderer erase its own block and park the cursor at the
 * top of it; the transcript is then written there and the live region is
 * repainted below. While a modal dialog is open the transcript is queued
 * instead, so a dialog never gets torn in half.
 */

import { statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore, text as textBlock } from "@arcturn/core";
import {
  backgroundHexOf,
  darkTheme,
  detectImageSupport,
  type Editor,
  getTheme,
  type ImageSupport,
  type Key,
  MarkdownStream,
  matchesKey,
  onThemeChange,
  ProcessTerminal,
  queryTerminalBackground,
  Spinner,
  StatusBar,
  setBackgroundSequence,
  setTheme,
  stringWidth,
  style,
  type Terminal,
  TUI,
  themeVersion,
  truncateToWidth,
  Viewport,
} from "@arcturn/tui";
import type {
  AgentEvent,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  TodoItem,
} from "@arcturn/types";
import { bannerLines } from "../banner.js";
import { type CopyResult, copyToClipboard } from "../clipboard.js";
import {
  type CommandRegistry,
  type CommandUi,
  createCommandRegistry,
  type SelectOption,
} from "../commands.js";
import { TranscriptFormatter } from "../display.js";
import {
  contextPercent,
  formatCostTotal,
  formatDuration,
  formatTokens,
  relativeAge,
} from "../format.js";
import { createGitStatusTracker, type GitStatusTracker } from "../git-status.js";
import { type GlyphSet, resolveGlyphs } from "../glyphs.js";
import { WORDMARK_WIDTH } from "../logo.js";
import {
  createFileMentionSource,
  expandMentions,
  type FileMentionSource,
  pastedPathsAsMentions,
} from "../mentions.js";
import { version } from "../meta.js";
import type { ArcturnRuntime, SessionMetrics } from "../runtime.js";
import { resolveTheme } from "../themes.js";
import { checkForUpdate } from "../update-check.js";
import {
  type SubagentStatus,
  SubagentTracker,
  TokenMeter,
  ToolCallProgressTracker,
} from "./activity.js";
import {
  type DialogHandle,
  EXIT_PLAN_SUBJECT,
  permissionDialog,
  planDialog,
  selectDialog,
  suggestRule,
} from "./dialogs.js";
import {
  CachedDynamic,
  Dynamic,
  InputBox,
  PromptEditor,
  renderSubagentRows,
  renderTodoWidget,
  renderToolCallProgress,
  renderWorkflowActivity,
  tailLines,
} from "./widgets.js";
import { WorkflowActivity } from "./workflow-activity.js";

/**
 * One block of the screen-mode transcript.
 *
 * A `raw` block is styled text the app was handed from outside — a slash
 * command's `print`, a caller's {@link InteractiveApp.write} — and can never be
 * restyled: the palette is already baked into its ANSI. A `themed` block keeps
 * the recipe that produced it instead, so a `/theme` switch can simply run the
 * recipe again and the whole scrollback region arrives in the new palette.
 *
 * `lines`/`version` are the per-block cache: a block is formatted once per
 * theme, never once per frame.
 */
type TranscriptEntry =
  | { readonly kind: "raw"; readonly lines: readonly string[] }
  | {
      readonly kind: "themed";
      readonly format: (formatter: TranscriptFormatter) => string[];
      lines: readonly string[];
      version: number;
      /** Wall time of the original render, replayed into the re-theme formatter's clock. */
      readonly at: number;
    };

/** Working-line verbs, cycled while a run is active to keep the UI alive. */
const WORKING_VERBS = ["working", "thinking", "crunching", "reasoning"] as const;

/** Options for {@link InteractiveApp}. */
export interface InteractiveAppOptions {
  /** The assembled runtime. */
  runtime: ArcturnRuntime;
  /** Terminal to drive. Defaults to a {@link ProcessTerminal}. */
  terminal?: Terminal;
  /** Prompt submitted automatically once the UI is up. */
  initialPrompt?: string;
  /** Milliseconds between live re-renders while text streams (default `60`). */
  streamThrottleMs?: number;
  /** Milliseconds within which a second `Ctrl+C` exits (default `1500`). */
  interruptWindowMs?: number;
  /**
   * Overrides the OSC 11 original-background query (tests). Resolving
   * `undefined` disables terminal-background syncing entirely.
   */
  queryTerminalBackground?: () => Promise<string | undefined>;
  /** Overrides the clipboard pipe (tests). Defaults to the real one. */
  copyToClipboard?: (text: string) => Promise<CopyResult>;
  /** Overrides the daily update probe (tests). Defaults to the real one. */
  checkForUpdate?: () => Promise<string | undefined>;
}

const SPINNER_INTERVAL_MS = 90;

/** The interactive Arcturn app. */
export class InteractiveApp {
  readonly #runtime: ArcturnRuntime;
  readonly #terminal: Terminal;
  readonly #tui: TUI;
  readonly #editor: PromptEditor;
  readonly #inputBox: InputBox;
  readonly #status: StatusBar;
  readonly #spinner: Spinner;
  readonly #glyphs: GlyphSet;
  readonly #formatter: TranscriptFormatter;
  readonly #mentions: FileMentionSource;
  readonly #gitStatus: GitStatusTracker;
  readonly #commands: CommandRegistry;
  readonly #streamThrottleMs: number;
  readonly #interruptWindowMs: number;
  readonly #initialPrompt: string | undefined;

  /** Rendering mode: full-screen app (default) or the classic inline block. */
  readonly #mode: "screen" | "inline";
  /** Screen mode: the transcript blocks behind the viewport. */
  #transcript: TranscriptEntry[] = [];
  /** Flattened transcript lines, valid for one `(theme, block count)` pair. */
  #flat: { version: number; entries: number; lines: string[] } | undefined;
  /** How the terminal draws images, kept for the re-theming replay formatter. */
  readonly #imageSupport: ImageSupport;
  /** Screen mode: the scrollable transcript region. */
  readonly #viewport: Viewport;
  #queued: string[] = [];
  /**
   * `true` once the welcome banner has been printed. The banner goes straight
   * into scrollback (see {@link InteractiveApp.run}): a banner kept in the
   * live region would be rewrapped by the terminal on every resize, and once
   * its top rows slip into scrollback they are unreachable — each resize
   * would leave a stale copy behind. History rewraps natively instead.
   */
  #welcomed = false;
  #dialogDepth = 0;
  /** Incremental renderer for the streaming assistant block. */
  readonly #stream = new MarkdownStream({ osc8Links: true });
  #streaming = false;
  /** Bumped whenever the todo list (or the running flag it renders with) changes. */
  #todosVersion = 0;
  #runStartedAt = 0;
  readonly #meter = new TokenMeter();
  readonly #subagents = new SubagentTracker(this.#meter);
  /**
   * The live org-workflow view. Fed the workflow's own event stream (not the
   * agent stream) through {@link CommandUi.workflowLive}; the compact per-stage
   * block reads its live per-step figures back out of {@link #subagents}.
   */
  readonly #workflow = new WorkflowActivity();
  /**
   * Progress for the tool call the model is dictating right now, so a long
   * `write` shows a growing character count instead of a silent spinner.
   */
  readonly #toolProgress = new ToolCallProgressTracker();
  #todos: readonly TodoItem[] = [];
  #lastInterrupt = 0;
  /**
   * Text selection, owned by the app — one gesture, no modes.
   *
   * Screen mode holds the mouse (cell-motion tracking), so the drag arrives
   * as mousedown/mousedrag/mouseup with cells. The viewport turns those into
   * a live reverse-video span over its own display rows — absolute
   * coordinates, so riding the top edge auto-scrolls and the selection grows
   * across screenfuls — and on release the selected text goes straight to
   * the system clipboard. Shift-drag still bypasses the grab entirely for
   * anyone who wants the terminal's own selection.
   */
  #selecting = false;
  /** The click chain (same cell, inside the multi-click window): 2 = word, 3+ = row. */
  #clickStreak: { x: number; y: number; at: number; count: number } | undefined;
  readonly #copyToClipboard: (text: string) => Promise<CopyResult>;
  /**
   * The copy receipt's fade timer. The receipt is chrome, not history: a
   * line printed into the transcript — or even a temporary component row —
   * shifts the layout under a pointer that is mid-gesture, and a
   * triple-click after its own double-click receipt would select the wrong
   * line. The status bar's centre slot is the one place on screen with a
   * fixed height, so the receipt lives there and fades on this timer.
   */
  #flashTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #checkForUpdate: (() => Promise<string | undefined>) | undefined;
  /** Whether the terminal window has the user's focus (1004 reporting). */
  #terminalFocused = true;
  #exitRequested = false;
  /**
   * The terminal's own default background as it was at startup (raw OSC 11
   * spec), when it could be read. While the app runs, the terminal background
   * is kept in sync with the theme's canvas so the window margin — pixels
   * outside the cell grid that no app can paint — matches the themed screen.
   * Restored verbatim at teardown; never touched when unknown.
   */
  #originalTerminalBg: string | undefined;
  readonly #queryTerminalBg: () => Promise<string | undefined>;
  #resolveExit: (() => void) | undefined;
  #spinnerTimer: ReturnType<typeof setInterval> | undefined;
  #liveTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;
  #unsubscribeResize: (() => void) | undefined;
  #unsubscribeTheme: (() => void) | undefined;
  /** Whether the app created the terminal itself (and must dispose it). */
  readonly #ownsTerminal: boolean;

  constructor(options: InteractiveAppOptions) {
    this.#runtime = options.runtime;
    this.#ownsTerminal = options.terminal === undefined;
    this.#terminal = options.terminal ?? new ProcessTerminal();
    this.#streamThrottleMs = options.streamThrottleMs ?? 60;
    this.#interruptWindowMs = options.interruptWindowMs ?? 1500;
    this.#initialPrompt = options.initialPrompt;
    this.#copyToClipboard =
      options.copyToClipboard ??
      ((text) =>
        copyToClipboard(text, { writeToTerminal: (sequence) => this.#terminal.write(sequence) }));
    this.#checkForUpdate = options.checkForUpdate;
    this.#queryTerminalBg =
      options.queryTerminalBackground ?? (() => queryTerminalBackground({ timeoutMs: 150 }));

    const resolvedTheme = resolveTheme(options.runtime.config.theme, options.runtime.themes);
    if (!resolvedTheme && options.runtime.config.theme !== "dark") {
      options.runtime.warnings.push(`Unknown theme "${options.runtime.config.theme}"; using dark.`);
    }
    setTheme(resolvedTheme ?? darkTheme);

    this.#glyphs = resolveGlyphs();
    const envUi = process.env.ARCTURN_UI;
    this.#mode = envUi === "screen" || envUi === "inline" ? envUi : options.runtime.config.ui;
    this.#tui = new TUI(this.#terminal, { overflow: "truncate", mode: this.#mode });
    this.#viewport = new Viewport({
      getLines: (width) => this.#viewportLines(width),
      // A fresh session floats its welcome block mid-screen like a splash;
      // the first transcript line returns it to the bottom-anchored flow.
      centered: () => this.#transcript.length === 0 && !this.#streaming,
      // A trackpad flick lands as one stdin chunk of many wheel reports, so
      // the viewport shows it a bounded number of rows at a time. This is
      // what keeps the rest of the flick moving once the input has stopped.
      onScrollPending: () => this.#tui.requestRender(),
    });
    this.#imageSupport = detectImageSupport();
    this.#formatter = this.#newFormatter();
    this.#spinner = new Spinner({ frames: this.#glyphs.spinner });
    this.#mentions = createFileMentionSource(options.runtime.cwd);
    this.#gitStatus = createGitStatusTracker(options.runtime.cwd);
    this.#commands = createCommandRegistry(options.runtime.extensions.commands, (message) =>
      options.runtime.warnings.push(message),
    );

    this.#editor = new PromptEditor({
      placeholder: "Ask arcturn anything, or type / for commands",
      prompt: `${this.#glyphs.promptCaret} `,
      // A file dragged onto the terminal arrives as a pasted absolute path;
      // rewriting it into an @-mention is what makes the drop attach the
      // file, from anywhere on disk, the same as the editor panel's drop.
      transformPaste: (text) =>
        pastedPathsAsMentions(text, (candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        }) ?? text,
      maxVisibleLines: 8,
      autocompleteTriggers: ["/", "@"],
      autocomplete: {
        getSuggestions: (context) => {
          // File mentions work on any line of a multi-line prompt.
          if (context.prefix.startsWith("@")) {
            const mentions = this.#mentions.getSuggestions(context.prefix);
            // Close the dropdown once the typed text *is* the only match, so
            // the first Enter submits instead of re-accepting the completion.
            if (mentions.length === 1 && mentions[0]?.value === context.prefix) return [];
            return mentions;
          }
          if (!context.prefix.startsWith("/")) return [];
          if (context.cursorLine !== 0) return [];
          const matches = this.#commands.complete(context.prefix);
          // Close the dropdown once the typed text *is* the only match, so
          // Enter submits the command instead of re-accepting the completion.
          if (matches.length === 1 && `/${matches[0]?.name}` === context.prefix) return [];
          return matches.map((command) => ({
            value: `/${command.name}`,
            label: `/${command.name}`,
            description: command.description,
          }));
        },
      },
      onSubmit: (text) => {
        void this.#onSubmit(text);
      },
      onCancel: () => this.#onEscape(),
      onUpdate: () => this.#tui.requestRender(),
      onEof: () => {
        this.#requestExit();
        return true;
      },
    });

    this.#inputBox = new InputBox(this.#editor, this.#glyphs);
    this.#status = new StatusBar({ separator: " · " });
    this.#tui.setComponents(this.#liveComponents());
    this.#tui.focus(this.#inputBox);
    this.#tui.onKey((key) => this.#onGlobalKey(key));
    // Home/End belong to the editor — except while the transcript is scrolled
    // away from the tail, which is when the reader is reading rather than
    // typing and when the scroll banner offers them. A priority handler is the
    // only way to reach a key the focused editor already binds; it declines
    // every other key, and every key at all once the view is following again.
    this.#tui.onKey((key) => this.#onScrollJumpKey(key), { priority: true });
  }

  /** The command registry, exposed for tests and extensions. */
  get commands(): CommandRegistry {
    return this.#commands;
  }

  /** The editor component, exposed for tests. */
  get editor(): Editor {
    return this.#editor;
  }

  /** The renderer, exposed for tests. */
  get tui(): TUI {
    return this.#tui;
  }

  /**
   * Start the UI and resolve when the user exits.
   *
   * @returns The process exit code.
   */
  async run(): Promise<number> {
    // FIRST, before anything can schedule a render: learn the terminal's own
    // background and decide who owns the ground. A render that fires during
    // this await would otherwise paint per-cell grounds that the flipped
    // ownership can no longer explain.
    if (this.#mode === "screen") {
      this.#originalTerminalBg = await this.#queryTerminalBg();
      if (this.#originalTerminalBg !== undefined) {
        // The terminal answered, so it can own the ground outright: its
        // default background becomes the theme's canvas (margin included) and
        // the composer stops painting per-cell backgrounds — mixing the two
        // renders the same colour in two shades under Terminal.app's
        // background blur. Unanswered, cells stay the (opaque) fallback.
        this.#tui.setGroundOwner("terminal");
      }
      this.#syncTerminalBackground();
    }

    this.#unsubscribe = this.#runtime.subscribe((event) => this.#onEvent(event));
    this.#runtime.setPermissionRequester((request) => this.#requestPermission(request));
    // A human is at this runtime, so its sessions may be titled — see the
    // field's doc in runtime.ts for why --print/serve/acp never set this.
    this.#runtime.sessionTitlesEligible = true;
    this.#unsubscribeResize = this.#terminal.onResize(() => this.#refresh());
    this.#unsubscribeTheme = onThemeChange(() => this.#onThemeSwitch());
    void this.#gitStatus.refresh().then(() => this.#refresh());

    if (this.#mode === "screen") {
      void this.#loadRecentSessions();
      this.#startIgnition();
    }

    // The banner is printed into scrollback before the UI starts, with any
    // startup warnings directly beneath it.
    this.#retireWelcome();
    for (const warning of this.#runtime.warnings) {
      this.#writeThemed((formatter) =>
        formatter.format({ type: "notice", level: "warn", text: warning }),
      );
    }
    this.#runtime.warnings.length = 0;
    this.flushScrollback();

    this.#tui.start();
    this.#refresh();
    // start() paints an empty frame; this is the first one with the status
    // bar and composer in it. Synchronous on purpose — the frame governor
    // smooths floods, and startup is not a flood.
    this.#tui.renderNow();
    this.#maybeAnnounceUpdate();

    const exited = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    if (this.#initialPrompt && this.#initialPrompt.trim() !== "") {
      void this.#onSubmit(this.#initialPrompt);
    }
    await exited;

    this.#stopSpinner();
    this.#workflow.reset();
    if (this.#revealTimer) clearInterval(this.#revealTimer);
    if (this.#liveTimer) clearTimeout(this.#liveTimer);
    if (this.#flashTimer) clearTimeout(this.#flashTimer);
    this.#unsubscribe?.();
    this.#unsubscribeResize?.();
    this.#unsubscribeTheme?.();
    this.#tui.stop();
    if (this.#originalTerminalBg !== undefined) {
      this.#terminal.write(setBackgroundSequence(this.#originalTerminalBg));
    }
    // Leaving the alternate screen restores the shell exactly as it was —
    // deliberately nothing is reprinted. A full-screen session should exit
    // clean, the way other alt-screen apps do; the transcript is not lost,
    // it lives in the session store (`--resume`, `/resume`) and `/export`.
    // A terminal this app created must also be disposed, or its resumed stdin
    // keeps the event loop alive and the process never exits after Ctrl+D.
    if (this.#ownsTerminal) this.#terminal.dispose();
    await this.#runtime.dispose();
    return 0;
  }

  /**
   * Print transcript lines, keeping them in the terminal's scrollback.
   *
   * @param lines - Already-styled lines. Empty arrays are ignored.
   */
  write(lines: readonly string[]): void {
    if (lines.length === 0) return;
    // Normally a no-op: run() retires the banner before anything else writes.
    this.#retireWelcome();
    if (this.#mode === "screen") {
      // The transcript is app-owned state rendered by the viewport — there is
      // no scrollback choreography and nothing a resize could smear.
      this.#push({ kind: "raw", lines: [...lines] });
      return;
    }
    this.#queued.push(...lines);
    if (this.#dialogDepth === 0) this.flushScrollback();
  }

  /**
   * Print a block the app itself produced, keeping the recipe that made it.
   *
   * In screen mode the block is stored as a {@link TranscriptEntry} of kind
   * `themed`, so a later `/theme` re-runs `format` and the block arrives in the
   * new palette. Inline mode has no such luxury — those lines are in the
   * terminal's own scrollback, which nothing can restyle — so the block is
   * printed exactly as before.
   *
   * @param format - Renders the block against the formatter it is handed and
   *   the active theme. Called once now, and once per later theme switch.
   */
  #writeThemed(format: (formatter: TranscriptFormatter) => string[]): void {
    const lines = format(this.#formatter);
    if (lines.length === 0) return;
    this.#retireWelcome();
    if (this.#mode !== "screen") {
      this.#queued.push(...lines);
      if (this.#dialogDepth === 0) this.flushScrollback();
      return;
    }
    this.#push({ kind: "themed", format, lines, version: themeVersion(), at: Date.now() });
  }

  /** Append a transcript block and ask for a repaint (screen mode). */
  #push(entry: TranscriptEntry): void {
    this.#transcript.push(entry);
    this.#tui.requestRender();
  }

  /** A formatter configured like the app's own, at the current width. */
  #newFormatter(now?: () => number): TranscriptFormatter {
    return new TranscriptFormatter({
      width: this.#width(),
      glyphs: this.#glyphs,
      imageSupport: this.#imageSupport,
      hyperlinks: { cwd: this.#runtime.cwd },
      ...(now === undefined ? {} : { now }),
    });
  }

  /**
   * The screen-mode transcript as flat lines, re-themed if the theme moved on.
   *
   * Blocks are formatted once per theme and cached, so a frame costs a single
   * flatten and a switch costs one pass over the transcript.
   *
   * {@link TranscriptFormatter.format} is *almost* a pure function of its event
   * and the theme: it also remembers in-flight tool calls (`toolStart` →
   * `toolEnd`, which is where a tool card gets its name and its `· 4s` elapsed
   * annotation) and sub-agent tasks. So the re-theme replays the blocks in
   * order through a fresh formatter — the live one is mid-run and must not be
   * disturbed — which reconstructs names and tasks exactly. The one thing it
   * cannot reconstruct is elapsed time, which is measured from the moment
   * `toolStart` was formatted: a re-themed tool card loses its sub-second-gated
   * elapsed suffix. Nothing else about a block changes.
   */
  #transcriptLines(): string[] {
    const version = themeVersion();
    const flat = this.#flat;
    if (flat && flat.version === version && flat.entries === this.#transcript.length) {
      return flat.lines;
    }
    if (!flat || flat.version !== version) {
      // The replay formatter's clock is pinned to each block's original wall
      // time, so a re-themed tool card keeps its true `· 4s` suffix (display's
      // elapsed is measured between toolStart and toolEnd format calls).
      let replayAt = 0;
      const replay = this.#newFormatter(() => replayAt);
      for (const entry of this.#transcript) {
        if (entry.kind !== "themed" || entry.version === version) continue;
        replayAt = entry.at;
        entry.lines = entry.format(replay);
        entry.version = version;
      }
    }
    const lines = this.#transcript.flatMap((entry) => entry.lines);
    this.#flat = { version, entries: this.#transcript.length, lines };
    return lines;
  }

  /**
   * Re-paint everything after a `/theme` switch.
   *
   * Styled text is cached in a dozen places — the banner and night-sky memos,
   * the viewport's wrap cache, every {@link CachedDynamic} zone, the editor's
   * rendered rows — and each cache holds the *old* palette's ANSI. The
   * transcript re-themes itself lazily via {@link themeVersion}; everything
   * else is dropped here and drawn again on the next frame.
   */
  /**
   * Push the active theme's canvas colour into the terminal's own default
   * background (OSC 11), so the window margin matches. Only when the original
   * was captured — an unrestorable change is worse than a margin — and only
   * when the theme actually has a truecolour ground.
   */
  #syncTerminalBackground(): void {
    if (this.#mode !== "screen" || this.#originalTerminalBg === undefined) return;
    const hex = backgroundHexOf(getTheme().styles.background.open);
    if (hex) this.#terminal.write(setBackgroundSequence(hex));
  }

  #onThemeSwitch(): void {
    this.#syncTerminalBackground();
    this.#bannerCache = undefined;
    this.#skyCache = undefined;
    this.#tui.invalidate();
    this.#tui.requestRender();
  }

  /** Queue the welcome banner for scrollback, once (inline mode only). */
  #retireWelcome(): void {
    if (this.#welcomed) return;
    this.#welcomed = true;
    // Screen mode renders the banner live at the top of the viewport — see
    // #viewportLines — so it re-lays out on every resize instead of being
    // baked into transcript text at one width.
    if (this.#mode !== "screen") this.#queued.push(...this.#bannerAt(this.#width()));
  }

  /** The banner at a width, memoized so viewport wrap caches stay warm. */
  #bannerCache: { width: number; lines: string[] } | undefined;

  /** Recent titled sessions in this directory, newest first (screen mode). */
  #recent: { age: string; title: string }[] = [];
  /** Columns of the wordmark lit by the launch ignition (screen mode). */
  #reveal = Number.POSITIVE_INFINITY;
  #revealTimer: ReturnType<typeof setInterval> | undefined;
  /** The night-sky band, memoized per width. */
  #skyCache: { width: number; lines: string[] } | undefined;

  #bannerLines(width: number): string[] {
    // While the ignition sweeps, render fresh each frame; memoize once lit.
    if (this.#reveal !== Number.POSITIVE_INFINITY) return this.#bannerAt(width);
    if (this.#bannerCache?.width !== width) {
      this.#bannerCache = { width, lines: this.#bannerAt(width) };
    }
    return this.#bannerCache.lines;
  }

  /** Sweep the wordmark alight over the first ~half second after launch. */
  #startIgnition(): void {
    this.#reveal = 0;
    this.#revealTimer = setInterval(() => {
      this.#reveal += 4;
      if (this.#reveal >= WORDMARK_WIDTH + 4) {
        this.#reveal = Number.POSITIVE_INFINITY;
        if (this.#revealTimer) clearInterval(this.#revealTimer);
        this.#revealTimer = undefined;
      }
      this.#tui.requestRender();
    }, 33);
    this.#revealTimer.unref?.();
  }

  /**
   * The night sky over the splash: the Boötes constellation — Arcturus, its
   * brightest star, glowing gold at the kite's foot — over a scatter of dim,
   * deterministic ambient stars. Pure atmosphere, zero motion, stable across
   * repaints at a given width.
   */
  #skyLines(width: number): string[] {
    if (!this.#glyphs.unicode) return [];
    if (this.#skyCache?.width === width) return this.#skyCache.lines;
    const rows = 8;
    const grid: { col: number; glyph: string; paint: "accent" | "muted" | "hr" }[][] = Array.from(
      { length: rows },
      () => [],
    );
    const center = Math.floor(width / 2);
    // Boötes, roughly to scale (columns doubled for terminal cell aspect):
    // Nekkar and Seginus crown the kite, Izar and Delta hold its right side,
    // Rho sits inside, Arcturus burns at the foot, Muphrid trails below.
    const constellation: [number, number, string, "accent" | "muted"][] = [
      [-5, 0, "·", "muted"], // Nekkar (β)
      [-15, 1, "·", "muted"], // Seginus (γ)
      [9, 1, "·", "muted"], // Delta (δ)
      [15, 3, "·", "muted"], // Izar (ε)
      [6, 4, "·", "muted"], // Rho (ρ)
      [0, 6, "✦", "accent"], // Arcturus (α) — our star
      [-6, 7, "·", "muted"], // Muphrid (η)
    ];
    for (const [dx, row, glyph, paint] of constellation) {
      const col = center + dx;
      if (col >= 0 && col < width) grid[row]?.push({ col, glyph, paint });
    }
    // Ambient stars: sparse, deterministic per (row, width) so nothing ever
    // twinkles or shifts between repaints.
    for (let row = 0; row < rows; row++) {
      const stride = 17 + ((row * 13) % 11);
      for (let col = (row * 37 + width) % stride; col < width; col += stride) {
        if (Math.abs(col - center) < 20 && row >= 4) continue; // keep the kite clear
        grid[row]?.push({ col, glyph: "·", paint: "hr" });
      }
    }
    const lines = grid.map((stars) => {
      let line = "";
      for (const star of stars.sort((a, b) => a.col - b.col)) {
        if (star.col < stringWidth(line)) continue;
        line += " ".repeat(star.col - stringWidth(line)) + style(star.paint)(star.glyph);
      }
      return line;
    });
    lines.push("");
    this.#skyCache = { width, lines };
    return lines;
  }

  /** A time-of-day greeting: the start page recognises its person. */
  #greetingLines(width: number): string[] {
    const hour = new Date().getHours();
    const salutation =
      hour >= 5 && hour < 11
        ? "good morning"
        : hour >= 11 && hour < 17
          ? "good afternoon"
          : hour >= 17 && hour < 22
            ? "good evening"
            : "late night session";
    let name = "";
    try {
      name = userInfo().username;
    } catch {
      // No account name available; greet namelessly.
    }
    const text = name === "" ? salutation : `${salutation}, ${name}`;
    return [
      truncateToWidth(`  ${style("accent")(this.#glyphs.brand)} ${style("muted")(text)}`, width),
      "",
    ];
  }

  /** The recent-sessions block: real, resumable work — never filler. */
  #recentLines(width: number): string[] {
    if (this.#recent.length === 0) return [];
    const clip = (line: string): string => truncateToWidth(line, width);
    const lines = [clip(`  ${style("muted")("recent in this directory")}`)];
    for (const item of this.#recent) {
      const age = style("muted")(item.age.padEnd(12));
      lines.push(clip(`    ${age}${style("text")(item.title)}`));
    }
    lines.push(
      clip(
        `    ${style("muted")(`${style("accent")("--continue")} resumes the newest ${this.#glyphs.dot} ${style("accent")("/resume")} browses`)}`,
      ),
    );
    lines.push("");
    return lines;
  }

  /** Load the newest sessions for this directory, off the hot path. */
  async #loadRecentSessions(): Promise<void> {
    try {
      const store = new JsonlSessionStore({ dir: this.#runtime.paths.sessions });
      const headers = await store.list();
      const now = Date.now();
      const current = this.#runtime.agent.sessionId;
      const recent: { age: string; title: string }[] = [];
      for (const header of headers) {
        if (recent.length >= 4) break;
        // The just-created session and sub-agent scratch sessions are noise.
        if (header.sessionId === current) continue;
        if (header.title?.startsWith("subagent:")) continue;
        // A generated title (session-title.ts) is the label when the header
        // carries one; sessions from before titling — or with it switched
        // off — fall back to their first user prompt, as they always did.
        let label = header.title ?? "";
        if (label.trim() === "") {
          const entries = await store.entries(header.sessionId);
          const first = entries.find(
            (entry) => entry.kind === "message" && entry.message.role === "user",
          );
          if (first?.kind === "message") {
            const text = first.message.content.find((block) => block.type === "text");
            label = text?.type === "text" ? text.text.replace(/\s+/g, " ").trim() : "";
          }
        }
        if (label === "") continue;
        recent.push({ age: relativeAge(now - header.createdAt), title: label });
      }
      this.#recent = recent;
      if (recent.length > 0) this.#tui.requestRender();
    } catch {
      // No session directory yet — the block simply stays absent.
    }
  }

  /** Flush queued transcript lines above the live region (inline mode). */
  flushScrollback(): void {
    if (this.#mode === "screen") return;
    if (this.#queued.length === 0) return;
    const lines = this.#queued;
    this.#queued = [];

    if (!this.#tui.isRunning) {
      this.#terminal.write(lines.map((line) => `${line}\r\n`).join(""));
      return;
    }
    // One atomic write: erase the live block, print the transcript where it
    // stood, repaint the block below — no intermediate states, no flicker.
    this.#tui.printAbove(lines);
  }

  /* ------------------------------------------------------------------ UI */

  #width(): number {
    return Math.max(20, this.#terminal.columns);
  }

  #liveComponents() {
    if (this.#mode === "screen") {
      return [
        this.#viewport,
        new CachedDynamic(
          () => this.#todosVersion,
          (width) =>
            renderTodoWidget(this.#todos, width, this.#glyphs, 8, this.#runStartedAt !== 0),
        ),
        new Dynamic((width) => this.#renderActivity(width)),
        new Dynamic((width) => this.#renderWorkflow(width)),
        new Dynamic((width) =>
          renderToolCallProgress(this.#toolProgress.progress, width, this.#glyphs),
        ),
        new Dynamic((width) => renderSubagentRows(this.#liveSubagents(), width, this.#glyphs)),
        this.#inputBox,
        new CachedDynamic(
          () => 0,
          (width) => this.#renderStatusRule(width),
        ),
        this.#status,
      ];
    }
    return [
      new CachedDynamic(
        () => this.#welcomed,
        (width) => (this.#welcomed ? [] : this.#bannerAt(width)),
      ),
      new Dynamic((width) => this.#renderStream(width)),
      new CachedDynamic(
        () => this.#todosVersion,
        (width) => renderTodoWidget(this.#todos, width, this.#glyphs, 8, this.#runStartedAt !== 0),
      ),
      new Dynamic((width) => this.#renderActivity(width)),
      new Dynamic((width) => this.#renderWorkflow(width)),
      new Dynamic((width) =>
        renderToolCallProgress(this.#toolProgress.progress, width, this.#glyphs),
      ),
      new Dynamic((width) => renderSubagentRows(this.#liveSubagents(), width, this.#glyphs)),
      this.#inputBox,
      new CachedDynamic(
        () => 0,
        (width) => this.#renderStatusRule(width),
      ),
      this.#status,
    ];
  }

  /** The live org-workflow block, or nothing when no run is active. */
  #renderWorkflow(width: number): string[] {
    return renderWorkflowActivity(
      this.#workflow.snapshot(),
      this.#subagents.active,
      width,
      this.#glyphs,
    );
  }

  /**
   * Sub-agent rows minus the ones a live workflow already draws as step rows.
   *
   * A workflow step is republished as a sub-agent so its child's activity is
   * visible, but while the structured workflow block is up it would show the
   * same step twice. Dropping the running steps' agent ids keeps a step to one
   * row and still surfaces any genuinely nested sub-agent a step spawns.
   */
  #liveSubagents(): readonly SubagentStatus[] {
    if (!this.#workflow.running) return this.#subagents.active;
    const owned = this.#workflow.runningAgentIds();
    return this.#subagents.active.filter((agent) => !owned.has(agent.id));
  }

  /** A faint full-width rule that gives the status bar its "bar" footing. */
  #renderStatusRule(width: number): string[] {
    if (width < 20) return [];
    const bar = this.#glyphs.unicode ? "─" : "-";
    return [style("hr")(bar.repeat(width))];
  }

  /** Screen mode: sky, then the centered welcome block, then the session. */
  #viewportLines(width: number): string[] {
    const block = [
      ...this.#greetingLines(width),
      ...this.#bannerLines(width),
      ...this.#recentLines(width),
    ];
    // Poster composition: the welcome block floats centered on wide screens.
    const blockWidth = block.reduce((max, line) => Math.max(max, stringWidth(line)), 0);
    const pad = " ".repeat(Math.max(0, Math.floor((width - blockWidth) / 2)));
    const head = [
      ...this.#skyLines(width),
      ...block.map((line) => (line === "" ? line : pad + line)),
    ];
    const stream = this.#streaming ? this.#stream.render(width) : [];
    const transcript = this.#transcriptLines();
    if (stream.length === 0) return [...head, ...transcript];
    return [...head, ...transcript, "", ...stream];
  }

  #renderStream(width: number): string[] {
    if (!this.#streaming) return [];
    const rendered = this.#stream.render(width);
    if (rendered.length === 0) return [];
    // The tail budget stays well under half the viewport: when a resize makes
    // the terminal rewrap the live block, the block must still fit on screen
    // or its top rows slip into scrollback, where stale content is
    // unreachable and would survive as duplicates.
    const rows = this.#terminal.rows;
    const budget = Math.max(3, Math.min(rows - 10, Math.floor(rows / 2) - 6));
    return ["", ...tailLines(rendered, budget)];
  }

  #renderActivity(width: number): string[] {
    if (!this.#runStartedAt) return [];
    const elapsedMs = Date.now() - this.#runStartedAt;
    const verb = WORKING_VERBS[Math.floor(elapsedMs / 3000) % WORKING_VERBS.length] ?? "working";
    const detail = [
      formatDuration(elapsedMs),
      `${formatTokens(this.#meter.total)} tokens`,
      "esc to interrupt",
    ].join(" · ");
    const head = `${style("spinner")(this.#spinner.frame)} ${style("accent")(verb)} `;
    const line = `${head}${style("muted")(`· ${detail}`)}`;
    return [truncateToWidth(line, width)];
  }

  #refresh(): void {
    const runtime = this.#runtime;
    const tokens = runtime.agent.estimatedTokens;
    this.#inputBox.setState({ running: this.#runStartedAt !== 0, mode: runtime.permissionMode });
    this.#status.setOptions({
      left: [
        { text: `${this.#glyphs.brand} arcturn`, style: "statusBarAccent" },
        { text: runtime.model.displayName },
        { text: runtime.permissionMode },
        ...this.#gitSegments(),
      ],
      right: [
        this.#costSegment(runtime.metrics),
        this.#contextSegment(tokens, runtime.model.contextWindow),
      ],
    });
    this.#formatter.setWidth(this.#width());
    this.#tui.requestRender();
  }

  /**
   * The spend segment.
   *
   * A model that publishes no per-token price still spends money, so the
   * total is at best a floor and at worst nothing at all — never `$0.00`,
   * which an operator reads as "this run was free". With nothing priced the
   * segment names itself, because a bare "n/a" sitting between the model name
   * and "ctx 41%" does not say *what* is unknown; in every other state the
   * dollar sign does that job.
   */
  #costSegment(metrics: SessionMetrics): { text: string } {
    const complete = metrics.unpricedTurns === 0;
    if (!complete && metrics.costUsd <= 0) return { text: "cost n/a" };
    return { text: formatCostTotal(metrics.costUsd, complete) };
  }

  /**
   * The context-usage status segment, painted by pressure: unstyled while
   * comfortable, warning from 70% and error from 90% so an approaching
   * compaction is visible before it happens.
   */
  #contextSegment(
    tokens: number,
    contextWindow: number,
  ): { text: string; style?: "warning" | "error" } {
    const percent = contextPercent(tokens, contextWindow);
    const text = `ctx ${percent}%`;
    if (percent >= 90) return { text, style: "error" };
    if (percent >= 70) return { text, style: "warning" };
    return { text };
  }

  /** The git branch segment, read from the tracker's cache (never spawns). */
  #gitSegments(): { text: string }[] {
    const status = this.#gitStatus.current();
    if (!status) return [];
    return [{ text: `${status.branch}${status.dirty ? "*" : ""}` }];
  }

  /** Collapse the user's home directory to `~` for display. */
  #displayCwd(): string {
    const cwd = this.#runtime.cwd;
    const home = homedir();
    if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
    return cwd;
  }

  /**
   * The welcome banner at a given width — see {@link bannerLines}.
   *
   * The banner lives in scrollback, where it cannot be re-laid-out, so it is
   * capped at 72 columns: a card that narrow survives any realistic later
   * narrowing without the terminal wrapping its borders.
   */
  #bannerAt(width: number): string[] {
    return bannerLines({
      width: Math.min(width, 72),
      reveal: this.#reveal,
      glyphs: this.#glyphs,
      model: this.#runtime.model.displayName,
      mode: this.#runtime.permissionMode,
      cwd: this.#displayCwd(),
      version: version(),
    });
  }

  /** Wipe the screen and return to the live get-started screen. */
  #clearScreen(): void {
    const running = this.#tui.isRunning;
    if (running) {
      this.#tui.setComponents([]);
      this.#tui.renderNow();
    }
    this.#terminal.clearScreen();
    this.#welcomed = false;
    if (running) {
      this.#tui.setComponents(this.#liveComponents());
      this.#tui.focus(this.#inputBox);
      this.#tui.renderNow();
    }
  }

  /* -------------------------------------------------------------- events */

  #onEvent(event: AgentEvent): void {
    // Every event, at every nesting depth: the tracker unwraps `subagentEvent`
    // itself so sub-agent usage reaches the meter and sub-agent progress
    // reaches the live region.
    this.#subagents.handle(event);
    this.#toolProgress.handle(event);
    switch (event.type) {
      case "runStart":
        this.#runStartedAt = Date.now();
        this.#todosVersion++;
        this.#meter.reset();
        this.#subagents.reset();
        this.#startSpinner();
        void this.#gitStatus.refresh().then(() => this.#refresh());
        break;
      case "messageStream": {
        const inner = event.event;
        if (inner.type === "textStart") {
          this.#streaming = true;
          this.#stream.reset();
        } else if (inner.type === "textDelta") {
          this.#streaming = true;
          this.#stream.append(inner.delta);
          this.#scheduleLiveRender();
          return;
        } else if (
          inner.type === "toolCallStart" ||
          inner.type === "toolCallDelta" ||
          inner.type === "toolCallEnd"
        ) {
          // Arguments stream for minutes on a big `write`; repaint the live
          // region so the progress line's character count keeps moving.
          this.#scheduleLiveRender();
          return;
        }
        break;
      }
      case "messageEnd":
        this.#streaming = false;
        this.#stream.reset();
        break;
      case "todoUpdate":
        this.#todos = event.todos;
        this.#todosVersion++;
        break;
      case "runEnd":
        this.#stopSpinner();
        this.#notifyRunFinished(event.reason);
        if (event.reason === "completed" && this.#runStartedAt !== 0) {
          const elapsed = formatDuration(Date.now() - this.#runStartedAt);
          const tokens = `${formatTokens(this.#meter.total)} tokens`;
          this.#writeThemed(() => [
            "",
            `${style("success")(this.#glyphs.done)} ${style("muted")(`${elapsed} · ${tokens}`)}`,
          ]);
        }
        this.#runStartedAt = 0;
        this.#todosVersion++;
        this.#streaming = false;
        this.#stream.reset();
        this.#toolProgress.reset();
        // An interrupt can end the run while children are still unwinding, so
        // clear them rather than leaving ghosts in the live region.
        this.#subagents.reset();
        void this.#gitStatus.refresh().then(() => this.#refresh());
        break;
      default:
        break;
    }

    // The formatter's output is a function of the event and the theme, so a
    // themed block can simply format the event again when the palette changes.
    this.#writeThemed((formatter) => formatter.format(event));
    this.#refresh();
  }

  #scheduleLiveRender(): void {
    if (this.#liveTimer) return;
    this.#liveTimer = setTimeout(() => {
      this.#liveTimer = undefined;
      this.#tui.requestRender();
    }, this.#streamThrottleMs);
    this.#liveTimer.unref?.();
  }

  #startSpinner(): void {
    if (this.#spinnerTimer) return;
    this.#spinnerTimer = setInterval(() => {
      this.#spinner.tick();
      this.#tui.requestRender();
    }, SPINNER_INTERVAL_MS);
    this.#spinnerTimer.unref?.();
  }

  #stopSpinner(): void {
    if (!this.#spinnerTimer) return;
    clearInterval(this.#spinnerTimer);
    this.#spinnerTimer = undefined;
  }

  /* --------------------------------------------------------------- input */

  #onGlobalKey(key: Key): boolean {
    if (matchesKey(key, "ctrl+c")) {
      this.#onInterrupt();
      return true;
    }
    if (key.name === "focusin" || key.name === "focusout") {
      this.#terminalFocused = key.name === "focusin";
      return true;
    }
    if (matchesKey(key, "shift+tab")) {
      this.#cyclePermissionMode();
      return true;
    }
    if (this.#mode === "screen") {
      if (key.name === "mousedown" || key.name === "mousedrag" || key.name === "mouseup") {
        this.#onMouseSelection(key);
        return true;
      }
      if (
        matchesKey(key, "wheelup") ||
        matchesKey(key, "wheeldown") ||
        matchesKey(key, "pageup") ||
        matchesKey(key, "pagedown")
      ) {
        return this.#viewport.handleInput(key);
      }
    }
    return false;
  }

  /**
   * `Home`/`End` while the transcript is scrolled up: jump to the top of the
   * session, or back to the live tail. Declined in every other state, so the
   * editor keeps both keys for the line they are on — and, since this is a
   * priority handler that runs ahead of the focused component, declined
   * outright while a dialog is open so an overlaid `SelectList` (a permission
   * prompt, plan approval, a picker) keeps both keys for its own selection.
   */
  #onScrollJumpKey(key: Key): boolean {
    if (this.#dialogDepth > 0) return false;
    if (this.#mode !== "screen" || this.#viewport.isFollowing) return false;
    if (!matchesKey(key, "end") && !matchesKey(key, "home")) return false;
    return this.#viewport.handleInput(key);
  }

  /** See {@link #selecting}: the drag is the selection, the release is the copy. */
  #onMouseSelection(key: Key): void {
    const cell = key.mouse;
    if (cell === undefined) return;
    const localRow = cell.y - 1;
    const column = cell.x - 1;
    if (key.name === "mousedown") {
      // Only the transcript is selectable; the viewport is the first
      // component, so its area is the top `renderedHeight` screen rows.
      const now = Date.now();
      const streak = this.#clickStreak;
      const chained =
        streak !== undefined && streak.x === cell.x && streak.y === cell.y && now - streak.at < 450;
      const count = chained ? streak.count + 1 : 1;
      this.#clickStreak = { x: cell.x, y: cell.y, at: now, count };
      const inViewport = localRow < this.#viewport.renderedHeight;
      if (count >= 2 && inViewport) {
        // Double-click takes the word, triple the row; the copy is
        // immediate and the highlight stays up as the receipt.
        this.#selecting = false;
        const selected =
          count === 2
            ? this.#viewport.selectWordAt(localRow, column)
            : this.#viewport.selectRowAt(localRow);
        if (selected) {
          const text = this.#viewport.selectionText();
          if (text !== undefined) void this.#copySelection(text);
        }
        return;
      }
      this.#viewport.clearSelection();
      this.#selecting = inViewport && this.#viewport.beginSelectionAt(localRow, column);
      return;
    }
    if (key.name === "mousedrag") {
      if (this.#selecting) this.#viewport.dragSelectionTo(localRow, column);
      return;
    }
    if (!this.#selecting) return;
    this.#selecting = false;
    const text = this.#viewport.endSelection();
    if (text !== undefined) void this.#copySelection(text);
  }

  async #copySelection(text: string): Promise<void> {
    const result = await this.#copyToClipboard(text);
    if (result.ok) {
      const chars = [...text].length;
      // Short on purpose: the status bar's centre slot yields when the three
      // groups cannot share the width, so a receipt that fits is a receipt
      // that shows. The longer story (Shift-drag, /copy) lives in /help.
      this.#showFlash(`${this.#glyphs.unicode ? "✓" : "+"} Copied ${chars} chars`);
      return;
    }
    // Failure is durable information, so it does go to the transcript.
    this.#writeThemed(() => [style("warning")(`${result.why} /copy and /export still work.`)]);
  }

  /**
   * Shift+Tab cycles default -> acceptEdits -> plan -> default, any time:
   * idle, mid-run, or with a permission prompt on screen — mid-run is when
   * the switch is most wanted, and the engine applies it from the next
   * permission evaluation. `yolo` is deliberately not in the cycle (a
   * bypass should never be one accidental keystroke away; /permissions
   * still reaches it) and cycling from yolo steps back to default.
   */
  #cyclePermissionMode(): void {
    const cycle: PermissionMode[] = ["default", "acceptEdits", "plan"];
    const current = this.#runtime.permissionMode;
    const index = cycle.indexOf(current);
    const next = cycle[(index + 1) % cycle.length] ?? "default";
    this.#runtime.setPermissionMode(next);
    this.#showFlash(`mode: ${next}`);
    this.#refresh();
  }

  /**
   * Rings the terminal's notification channel when a run ends behind the
   * user's back — OSC 9 for the emulators that post a real notification,
   * BEL for the ones that badge or bounce on the bell. Focus is the gate
   * (1004 reporting), so a run watched to its end rings nothing; so does an
   * interrupt, because the hand that pressed it is already here.
   */
  #notifyRunFinished(reason: string): void {
    if (this.#terminalFocused || reason === "interrupted") return;
    if (this.#runtime.config.notify === false) return;
    const title = reason === "completed" ? "run finished" : `run ${reason}`;
    this.#terminal.write(`\u001b]9;Arcturn: ${title}\u0007\u0007`);
  }

  /**
   * The daily update notice, off the startup path: one muted line when npm
   * has moved on, nothing in every other case, and never an install — see
   * update-check.ts. `updateCheck: false` turns it off entirely.
   */
  #maybeAnnounceUpdate(): void {
    if (this.#runtime.config.updateCheck === false) return;
    const check =
      this.#checkForUpdate ??
      (() =>
        checkForUpdate({
          currentVersion: version(),
          stateFile: join(this.#runtime.paths.home, "update-check.json"),
        }));
    void check()
      .then((latest) => {
        if (latest === undefined) return;
        this.#writeThemed(() => [
          style("muted")(
            `Update available: ${version()} -> ${latest} - npm install -g arcturn (updateCheck: false silences this)`,
          ),
        ]);
      })
      .catch(() => undefined);
  }

  #showFlash(text: string): void {
    this.#status.setOptions({ center: [{ text, style: "statusBarAccent" }] });
    if (this.#flashTimer !== undefined) clearTimeout(this.#flashTimer);
    this.#flashTimer = setTimeout(() => {
      this.#flashTimer = undefined;
      this.#status.setOptions({ center: [] });
      this.#tui.requestRender();
    }, 2_600);
    this.#flashTimer.unref?.();
    this.#tui.requestRender();
  }

  #onEscape(): void {
    if (this.#runtime.agent.isRunning) {
      this.#runtime.agent.abort();
      return;
    }
    if (this.#editor.text !== "") this.#editor.reset();
  }

  #onInterrupt(): void {
    if (this.#runtime.agent.isRunning) {
      this.#runtime.agent.abort();
      this.#writeThemed(() => [style("warning")(`${this.#glyphs.interrupt} Interrupting…`)]);
      this.#lastInterrupt = 0;
      return;
    }
    const now = Date.now();
    if (now - this.#lastInterrupt < this.#interruptWindowMs) {
      this.#requestExit();
      return;
    }
    this.#lastInterrupt = now;
    if (this.#editor.text !== "") this.#editor.reset();
    this.#writeThemed(() => [style("muted")("Press Ctrl+C again to exit.")]);
  }

  #requestExit(): void {
    if (this.#exitRequested) return;
    this.#exitRequested = true;
    this.#runtime.agent.abort();
    this.#resolveExit?.();
  }

  /**
   * Handle a submitted line: a slash command, a steering message for the
   * in-flight run, or a new prompt.
   */
  async #onSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;
    // Sending is the strongest possible "I am done reading back there": the
    // answer arrives at the tail, so the view goes there to meet it.
    this.#viewport.follow();

    if (trimmed.startsWith("/")) {
      const result = await this.#commands.dispatch(trimmed, {
        runtime: this.#runtime,
        ui: this.#commandUi(),
      });
      if (result.handled) {
        this.#refresh();
        return;
      }
    }

    // @-mentions expand the same way whether steering or starting a run, so a
    // mentioned file or image is never silently dropped mid-run.
    let expanded: Awaited<ReturnType<typeof expandMentions>>;
    try {
      expanded = await expandMentions(trimmed, this.#runtime.cwd);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.#writeThemed((formatter) => formatter.format({ type: "notice", level: "error", text }));
      return;
    }
    const content =
      expanded.images.length > 0 ? [textBlock(expanded.text), ...expanded.images] : expanded.text;

    // Say so before spending the turn: the request still goes through, but the
    // model is handed a placeholder rather than the picture.
    const model = this.#runtime.agent.model;
    if (expanded.images.length > 0 && !model.capabilities.vision) {
      const text =
        `${model.displayName} has no vision support, so the ` +
        `${expanded.images.length === 1 ? "attached image is" : "attached images are"} ` +
        "described to it rather than shown. Switch models with /model to send it for real.";
      this.#writeThemed((formatter) => formatter.format({ type: "notice", level: "warn", text }));
    }

    if (this.#runtime.agent.isRunning) {
      this.#runtime.agent.steer(content);
      this.#writeThemed(() => [
        "",
        `${style("accent")(this.#glyphs.userGutter)} ${style("text")(trimmed)}`,
        style("muted")(`  ${this.#glyphs.steer} steering the run`),
      ]);
      return;
    }

    try {
      await this.#runtime.agent.prompt(content);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.#writeThemed((formatter) => formatter.format({ type: "notice", level: "error", text }));
    }
  }

  /* ------------------------------------------------------------- dialogs */

  async #showDialog<T>(dialog: DialogHandle<T>): Promise<T | undefined> {
    this.#dialogDepth++;
    this.#tui.setOverlay(dialog.component, { align: "middle", width: 0.8 });
    this.#tui.requestRender();
    try {
      return await dialog.result;
    } finally {
      this.#tui.setOverlay(null);
      this.#dialogDepth--;
      this.#tui.focus(this.#inputBox);
      this.flushScrollback();
      this.#tui.requestRender();
    }
  }

  async #requestPermission(request: Omit<PermissionRequest, "id">): Promise<PermissionDecision> {
    if (request.subject === EXIT_PLAN_SUBJECT) return this.#requestPlanApproval(request);

    const choice = await this.#showDialog(permissionDialog(request, this.#width(), this.#glyphs));
    if (choice === "once") return { requestId: "", behavior: "allow" };
    if (choice === "always") {
      return {
        requestId: "",
        behavior: "allow",
        persistRule: { ...suggestRule(request), scope: "project" },
      };
    }
    return {
      requestId: "",
      behavior: "deny",
      message: "The user denied this action. Do not retry it; choose another approach or ask.",
    };
  }

  async #requestPlanApproval(request: Omit<PermissionRequest, "id">): Promise<PermissionDecision> {
    const plan = request.description.replace(/^[^\n]*\n+/, "");
    const choice = await this.#showDialog(planDialog(plan, this.#glyphs));
    if (choice === "once") return { requestId: "", behavior: "allow" };
    if (choice === "always") {
      this.#runtime.setPermissionMode("acceptEdits");
      return { requestId: "", behavior: "allow" };
    }
    return {
      requestId: "",
      behavior: "deny",
      message: "The user wants to keep planning. Revise the plan and present it again.",
    };
  }

  /** The {@link CommandUi} handed to slash commands. */
  #commandUi(): CommandUi {
    return {
      print: (content) => {
        const lines = typeof content === "string" ? content.split("\n") : [...content];
        this.write(["", ...lines]);
      },
      notice: (level, text) => {
        this.#writeThemed((formatter) => formatter.format({ type: "notice", level, text }));
      },
      select: <T>(
        title: string,
        options: readonly SelectOption<T>[],
        settings?: { filterable?: boolean },
      ) => this.#showDialog(selectDialog(title, options, settings ?? {})),
      setInput: (text) => {
        this.#editor.setText(text);
        this.#tui.requestRender();
      },
      writeRaw: (sequence) => {
        this.#terminal.write(sequence);
      },
      workflowLive: (event) => {
        this.#workflow.handle(event);
        // The block ticks its elapsed clocks between events off the spinner
        // timer; start it while a run is live and stop it when the run ends,
        // unless a main-agent run is also driving the spinner.
        if (event.type === "workflowStart") this.#startSpinner();
        else if (event.type === "workflowEnd") {
          // A step abandoned on a deadline may never emit its `subagentEnd`, so
          // clear the sub-agent rows too rather than leave a ghost behind.
          this.#subagents.reset();
          if (this.#runStartedAt === 0) this.#stopSpinner();
        }
        this.#tui.requestRender();
      },
      clear: () => {
        this.#formatter.reset();
        this.#todos = [];
        this.#queued = [];
        if (this.#mode === "screen") {
          this.#transcript = [];
          this.#flat = undefined;
          this.#viewport.follow();
          this.#viewport.invalidate();
          this.#welcomed = false;
          this.#retireWelcome();
          this.#tui.requestRender();
          return;
        }
        this.#clearScreen();
        // The fresh banner goes into scrollback, same as at startup.
        this.#retireWelcome();
        this.flushScrollback();
      },
      exit: () => this.#requestExit(),
    };
  }
}

/**
 * Build the interactive app and run it to completion.
 *
 * @param options - Runtime, terminal and initial prompt.
 * @returns The process exit code.
 */
export async function runInteractive(options: InteractiveAppOptions): Promise<number> {
  return new InteractiveApp(options).run();
}
