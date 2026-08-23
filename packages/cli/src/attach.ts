/**
 * `arcturn attach` — drive a remote `arcturn serve` session from this terminal.
 *
 * This is "tmux for agents": the agent, its tools and its files live wherever
 * `arcturn serve` runs; this process owns only the keyboard and the screen. The
 * transport half already exists (`@arcturn/protocol`'s
 * {@link createProtocolClient}); this module is the terminal front end that
 * sits on top of it.
 *
 * ## Shape
 *
 * {@link runAttach} builds a small client app that mirrors the local
 * `InteractiveApp` layout without depending on it:
 * `InteractiveApp` is welded to a local `ArcturnRuntime` (it reads
 * `runtime.agent.isRunning`, `runtime.metrics`, the command registry, git
 * status, @-mention expansion, …), none of which a socket can answer. The
 * pieces that *are* transport-agnostic are reused directly: the
 * {@link TranscriptFormatter} turns `AgentEvent`s into printable lines, and
 * `interactive/widgets.ts` / `interactive/dialogs.ts` supply the input box and
 * the permission dialog.
 *
 * Rendering follows `@arcturn/tui`'s rule: finished transcript lines are
 * printed straight to the terminal so they land in real scrollback, and the
 * {@link TUI} holds only the live region (streaming text, todos, the activity
 * line, the editor, the status bar).
 *
 * ## Three things the protocol forces on this client
 *
 * 1. **`prompt()` resolves when the *run* ends, not when the prompt is
 *    accepted** — the server's `SessionHost.prompt` awaits the agent. The
 *    client is therefore constructed with `requestTimeoutMs: 0` (deadline
 *    disabled) by default, and nothing here ever blocks the UI on `prompt()`:
 *    the inbound `runStart` event is the acknowledgement, and the promise is
 *    only watched so a late rejection can be surfaced as a notice.
 * 2. **Interrupt means `abort()`, never `close()`.** `close()` tears down the
 *    socket; `abort()` stops the remote run and leaves the session attached.
 * 3. **The socket is injected.** `ws` is not a dependency of this package, so
 *    {@link RunAttachOptions.socket} takes any {@link WebSocketLike} — a real
 *    `ws` `WebSocket` from `main.ts`, or an in-memory fake from a test. See
 *    `INTEGRATION-attach.md`.
 *
 * ## Permission requests
 *
 * A `permissionRequest` event carries a full `PermissionRequest` **including
 * its `id`**, and `respondToPermission` echoes that id back, so this client
 * shows the same modal dialog the local app shows and answers it precisely.
 * Dropping one would hang the remote run until the server's five-minute
 * auto-deny fires, so an unanswerable request is never silently ignored: on
 * shutdown every still-open request is denied explicitly.
 */

import {
  createProtocolClient,
  type ProtocolClient,
  ProtocolClosedError,
  type WebSocketLike,
} from "@arcturn/protocol";
import {
  type Key,
  matchesKey,
  ProcessTerminal,
  renderMarkdown,
  Spinner,
  StatusBar,
  style,
  type Terminal,
  TUI,
  truncateToWidth,
} from "@arcturn/tui";
import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequest,
  SessionHeader,
  TodoItem,
} from "@arcturn/types";
import { TranscriptFormatter } from "./display.js";
import { formatDuration, formatTokens, oneLine } from "./format.js";
import { type GlyphSet, resolveGlyphs } from "./glyphs.js";
import { SubagentTracker, TokenMeter } from "./interactive/activity.js";
import {
  type DialogHandle,
  EXIT_PLAN_SUBJECT,
  permissionDialog,
  planDialog,
  suggestRule,
} from "./interactive/dialogs.js";
import {
  Dynamic,
  InputBox,
  PromptEditor,
  renderSubagentRows,
  renderTodoWidget,
  tailLines,
} from "./interactive/widgets.js";

/** Exit codes {@link runAttach} can return. */
export const AttachExitCode = {
  /** The user quit (`Ctrl+C` twice, or `Ctrl+D` on an empty prompt). */
  ok: 0,
  /** The connection dropped while the session was attached. */
  disconnected: 1,
  /** Authentication or session attachment never succeeded. */
  attachFailed: 2,
} as const;

/** A value of {@link AttachExitCode}. */
export type AttachExitCode = (typeof AttachExitCode)[keyof typeof AttachExitCode];

/** Connection state shown in the status bar. */
type ConnectionState = "connecting" | "attached" | "closed";

/** Working-line verbs, cycled while a remote run is active. */
const WORKING_VERBS = ["working", "thinking", "crunching", "reasoning"] as const;

const SPINNER_INTERVAL_MS = 90;

/** Options for {@link runAttach}. */
export interface RunAttachOptions {
  /**
   * The already-constructed transport. `ws` is not a dependency of this
   * package, so the caller owns creating (and connecting) the socket; frames
   * are queued by the protocol client until the socket's `"open"` event, so a
   * still-CONNECTING socket may be handed over.
   */
  socket: WebSocketLike;
  /** Shared secret, when the server was started with a `--token`. */
  token?: string;
  /**
   * Session to attach to. Omitted, the newest session the server lists is
   * used, and a fresh one is created when the server lists none.
   */
  sessionId?: string;
  /** Terminal to drive. Defaults to a {@link ProcessTerminal}. */
  terminal?: Terminal;
  /** Working directory used only when a session has to be created. */
  cwd?: string;
  /** Display-only label for the status bar, e.g. `ws://127.0.0.1:7717`. */
  url?: string;
  /**
   * Per-request deadline handed to {@link createProtocolClient}. Defaults to
   * `0` — **deadlines disabled** — because `prompt()` only resolves when the
   * remote run ends, which is unbounded. Tests may set a small positive value.
   */
  requestTimeoutMs?: number;
  /** Milliseconds within which a second `Ctrl+C` exits (default `1500`). */
  interruptWindowMs?: number;
  /** Milliseconds between live re-renders while text streams (default `60`). */
  streamThrottleMs?: number;
  /** Glyph set; defaults to the terminal's detected Unicode capability. */
  glyphs?: GlyphSet;
}

/**
 * Connect to a `arcturn serve` instance and drive one of its sessions.
 *
 * @param options - Transport, credentials, target session and terminal.
 * @returns The process exit code — see {@link AttachExitCode}.
 *
 * @example
 * ```ts
 * import WebSocket from "ws";
 * const code = await runAttach({ socket: new WebSocket(url), token });
 * ```
 */
export async function runAttach(options: RunAttachOptions): Promise<number> {
  return new AttachApp(options).run();
}

/** The `arcturn attach` client app. */
class AttachApp {
  readonly #socket: WebSocketLike;
  readonly #client: ProtocolClient;
  readonly #terminal: Terminal;
  readonly #tui: TUI;
  readonly #editor: PromptEditor;
  readonly #inputBox: InputBox;
  readonly #status: StatusBar;
  readonly #spinner: Spinner;
  readonly #glyphs: GlyphSet;
  readonly #formatter: TranscriptFormatter;
  readonly #requestedSessionId: string | undefined;
  readonly #cwd: string;
  readonly #url: string;
  readonly #interruptWindowMs: number;
  readonly #streamThrottleMs: number;
  /** Permission requests shown but not yet answered, keyed by request id. */
  readonly #openPermissions = new Set<string>();

  #queued: string[] = [];
  #session: SessionHeader | undefined;
  #connection: ConnectionState = "connecting";
  #running = false;
  #runStartedAt = 0;
  readonly #meter = new TokenMeter();
  readonly #subagents = new SubagentTracker(this.#meter);
  #todos: readonly TodoItem[] = [];
  #streaming = false;
  #streamText = "";
  #dialogDepth = 0;
  #lastInterrupt = 0;
  #exitRequested = false;
  #exitCode: number = AttachExitCode.ok;
  /** Printed after the TUI stops, so a failure is the last thing on screen. */
  #farewell: string | undefined;
  #resolveExit: (() => void) | undefined;
  #spinnerTimer: ReturnType<typeof setInterval> | undefined;
  #liveTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribeEvents: (() => void) | undefined;
  #unsubscribeResize: (() => void) | undefined;

  constructor(options: RunAttachOptions) {
    this.#socket = options.socket;
    this.#terminal = options.terminal ?? new ProcessTerminal();
    this.#requestedSessionId = options.sessionId;
    this.#cwd = options.cwd ?? process.cwd();
    this.#url = options.url ?? "remote";
    this.#interruptWindowMs = options.interruptWindowMs ?? 1500;
    this.#streamThrottleMs = options.streamThrottleMs ?? 60;
    this.#glyphs = options.glyphs ?? resolveGlyphs();

    this.#client = createProtocolClient(options.socket, {
      ...(options.token === undefined ? {} : { token: options.token }),
      // See the module TSDoc: `prompt()` spans a whole run, so the default
      // 30s deadline would reject every real prompt mid-flight.
      requestTimeoutMs: options.requestTimeoutMs ?? 0,
      onProtocolError: (error) => {
        // Unroutable inbound traffic is a diagnostic, not a fatal condition.
        this.#notice("warn", error.message);
      },
    });

    this.#tui = new TUI(this.#terminal, { overflow: "truncate" });
    this.#formatter = new TranscriptFormatter({ width: this.#width(), glyphs: this.#glyphs });
    this.#spinner = new Spinner({ frames: this.#glyphs.spinner });

    this.#editor = new PromptEditor({
      placeholder: "Message the remote session",
      prompt: `${this.#glyphs.promptCaret} `,
      maxVisibleLines: 8,
      onSubmit: (text) => {
        void this.#onSubmit(text);
      },
      onCancel: () => this.#onEscape(),
      onUpdate: () => this.#tui.requestRender(),
      onEof: () => {
        this.#requestExit(AttachExitCode.ok);
        return true;
      },
    });
    this.#inputBox = new InputBox(this.#editor, this.#glyphs);
    this.#status = new StatusBar({ separator: " · " });
    this.#tui.setComponents(this.#liveComponents());
    this.#tui.focus(this.#inputBox);
    this.#tui.onKey((key) => this.#onGlobalKey(key));
  }

  /**
   * Start the UI, attach, and resolve when the user exits or the socket dies.
   *
   * @returns The process exit code.
   */
  async run(): Promise<number> {
    // Armed before any listener is registered, so an immediate socket failure
    // can never resolve into a `#resolveExit` that does not exist yet.
    const exited = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });

    this.#unsubscribeEvents = this.#client.onEvent((sessionId, event) =>
      this.#onEvent(sessionId, event),
    );
    this.#unsubscribeResize = this.#terminal.onResize(() => this.#refresh());
    // Registered *after* the protocol client's own handlers, so its in-flight
    // requests are rejected before this app decides the connection is gone.
    this.#socket.on("close", (code) => this.#onSocketClosed(code));
    this.#socket.on("error", (error) => this.#onSocketError(error));

    this.#tui.start();
    this.#notice("info", `Connecting to ${this.#url}…`);
    this.#refresh();

    void this.#attach();
    await exited;

    const denied = this.#denyOpenPermissions("The attached client disconnected.");
    this.#stopSpinner();
    if (this.#liveTimer) clearTimeout(this.#liveTimer);
    this.#unsubscribeEvents?.();
    this.#unsubscribeResize?.();
    this.flushScrollback();
    this.#tui.stop();
    // `respondToPermission` reaches the wire a microtask later (it awaits the
    // handshake first), so closing immediately would cancel the very denials
    // that keep the remote run from stalling. One macrotask is enough to let
    // every queued frame be sent.
    if (denied > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.#client.close();
    if (this.#farewell !== undefined) this.#terminal.write(`${this.#farewell}\r\n`);
    return this.#exitCode;
  }

  /* ------------------------------------------------------------- attaching */

  /**
   * Authenticate, then resolve the session to drive.
   *
   * Every failure here is terminal: there is nothing to drive, so the app
   * prints why and exits with {@link AttachExitCode.attachFailed}.
   */
  async #attach(): Promise<void> {
    try {
      await this.#client.authenticate();
      const header = await this.#resolveSession();
      this.#session = header;
      this.#connection = "attached";
      this.#notice(
        "info",
        `Attached to session ${header.sessionId} (${header.cwd}) on ${this.#url}.`,
      );
      this.#refresh();
    } catch (error) {
      if (this.#exitRequested) return;
      this.#connection = "closed";
      this.#farewell = style("error")(`${this.#glyphs.error} arcturn attach: ${errorText(error)}`);
      this.#requestExit(AttachExitCode.attachFailed);
    }
  }

  /**
   * Pick the session to attach to.
   *
   * An explicit id wins. Otherwise the newest listed session is reused —
   * "attach" should land you back where you were — and only an empty server
   * gets a freshly created session. `createSession` does **not** subscribe the
   * connection to the session's events (only `openSession` does, server-side),
   * so a created session is opened straight afterwards.
   */
  async #resolveSession(): Promise<SessionHeader> {
    if (this.#requestedSessionId !== undefined) {
      return this.#client.openSession(this.#requestedSessionId);
    }
    const sessions = await this.#client.listSessions();
    const newest = newestSession(sessions);
    if (newest) return this.#client.openSession(newest.sessionId);

    const created = await this.#client.createSession({ cwd: this.#cwd });
    return this.#client.openSession(created.sessionId);
  }

  /* ---------------------------------------------------------------- output */

  /**
   * Print transcript lines, keeping them in the terminal's scrollback.
   *
   * @param lines - Already-styled lines. Empty arrays are ignored.
   */
  write(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.#queued.push(...lines);
    // A dialog must never be torn in half, so writes wait for it to close.
    if (this.#dialogDepth === 0) this.flushScrollback();
  }

  /** Flush queued transcript lines above the live region. */
  flushScrollback(): void {
    if (this.#queued.length === 0) return;
    const lines = this.#queued;
    this.#queued = [];
    const payload = lines.map((line) => `${line}\r\n`).join("");

    if (!this.#tui.isRunning) {
      this.#terminal.write(payload);
      return;
    }
    const focused = this.#tui.focused;
    this.#tui.setComponents([]);
    this.#tui.renderNow();
    this.#terminal.write(payload);
    this.#tui.setComponents(this.#liveComponents());
    if (focused) this.#tui.focus(focused);
    this.#tui.renderNow();
  }

  #notice(level: "info" | "warn" | "error", text: string): void {
    this.write(this.#formatter.format({ type: "notice", level, text }));
  }

  #width(): number {
    return Math.max(20, this.#terminal.columns);
  }

  #liveComponents() {
    return [
      new Dynamic((width) => this.#renderStream(width)),
      new Dynamic((width) => renderTodoWidget(this.#todos, width, this.#glyphs, 8, this.#running)),
      new Dynamic((width) => this.#renderActivity(width)),
      new Dynamic((width) => renderSubagentRows(this.#subagents.active, width, this.#glyphs)),
      this.#inputBox,
      new Dynamic((width) => this.#renderStatusRule(width)),
      this.#status,
    ];
  }

  #renderStatusRule(width: number): string[] {
    if (width < 20) return [];
    return [style("hr")((this.#glyphs.unicode ? "─" : "-").repeat(width))];
  }

  #renderStream(width: number): string[] {
    if (!this.#streaming || this.#streamText.trim() === "") return [];
    const rendered = renderMarkdown(this.#streamText, width);
    return ["", ...tailLines(rendered, Math.max(3, this.#terminal.rows - 10))];
  }

  #renderActivity(width: number): string[] {
    if (!this.#running) return [];
    const elapsedMs = Date.now() - this.#runStartedAt;
    const verb = WORKING_VERBS[Math.floor(elapsedMs / 3000) % WORKING_VERBS.length] ?? "working";
    const detail = [
      formatDuration(elapsedMs),
      `${formatTokens(this.#meter.total)} tokens`,
      "esc to interrupt",
    ].join(" · ");
    const head = `${style("spinner")(this.#spinner.frame)} ${style("accent")(verb)} `;
    return [truncateToWidth(`${head}${style("muted")(`· ${detail}`)}`, width)];
  }

  /** Repaint the status bar and the input box from current state. */
  #refresh(): void {
    this.#inputBox.setState({ running: this.#running, mode: this.#connection });
    this.#status.setOptions({
      left: [
        { text: `${this.#glyphs.brand} arcturn attach`, style: "statusBarAccent" },
        { text: this.#url },
        { text: this.#session ? this.#session.sessionId : "no session" },
      ],
      right: [
        { text: this.#connection, style: this.#connection === "closed" ? "error" : undefined },
        { text: this.#running ? "running" : "idle" },
      ],
    });
    this.#formatter.setWidth(this.#width());
    this.#tui.requestRender();
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Route one server-pushed event.
   *
   * Events for other sessions are dropped: one connection may end up observing
   * several sessions (each `openSession` subscribes the socket), and this app
   * drives exactly one.
   */
  #onEvent(sessionId: string, event: AgentEvent): void {
    if (this.#session !== undefined && sessionId !== this.#session.sessionId) return;

    // Unwraps `subagentEvent` itself, so delegated work is metered and shown.
    this.#subagents.handle(event);

    switch (event.type) {
      case "runStart":
        this.#running = true;
        this.#runStartedAt = Date.now();
        this.#meter.reset();
        this.#subagents.reset();
        this.#startSpinner();
        break;
      case "messageStream": {
        const inner = event.event;
        if (inner.type === "textStart") {
          this.#streaming = true;
          this.#streamText = "";
        } else if (inner.type === "textDelta") {
          this.#streaming = true;
          this.#streamText += inner.delta;
          this.#scheduleLiveRender();
          return;
        }
        break;
      }
      case "messageEnd":
        this.#streaming = false;
        this.#streamText = "";
        break;
      case "todoUpdate":
        this.#todos = event.todos;
        break;
      case "permissionRequest":
        void this.#onPermissionRequest(event.request);
        break;
      case "runEnd":
        this.#stopSpinner();
        if (event.reason === "completed" && this.#runStartedAt !== 0) {
          const elapsed = formatDuration(Date.now() - this.#runStartedAt);
          this.write([
            "",
            `${style("success")(this.#glyphs.done)} ${style("muted")(
              `${elapsed} · ${formatTokens(this.#meter.total)} tokens`,
            )}`,
          ]);
        }
        this.#running = false;
        this.#runStartedAt = 0;
        this.#streaming = false;
        this.#streamText = "";
        this.#subagents.reset();
        break;
      default:
        break;
    }

    this.write(this.#formatter.format(event));
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

  /* ------------------------------------------------------------- transport */

  /**
   * The socket went away. Mid-session this is fatal — there is no reconnection
   * in the protocol client — so say so plainly and exit non-zero rather than
   * leaving the user typing into a dead terminal.
   */
  #onSocketClosed(code?: number): void {
    if (this.#exitRequested) return;
    this.#connection = "closed";
    const suffix = typeof code === "number" ? ` (code ${code})` : "";
    this.#farewell = style("error")(
      `${this.#glyphs.error} arcturn attach: connection to ${this.#url} closed${suffix}.`,
    );
    this.#requestExit(AttachExitCode.disconnected);
  }

  #onSocketError(error: unknown): void {
    if (this.#exitRequested) return;
    this.#connection = "closed";
    this.#farewell = style("error")(
      `${this.#glyphs.error} arcturn attach: connection to ${this.#url} failed: ${errorText(error)}`,
    );
    this.#requestExit(AttachExitCode.disconnected);
  }

  /* ---------------------------------------------------------------- input */

  #onGlobalKey(key: Key): boolean {
    if (matchesKey(key, "ctrl+c")) {
      this.#onInterrupt();
      return true;
    }
    return false;
  }

  /** Esc interrupts the remote run, or clears a half-typed prompt. */
  #onEscape(): void {
    if (this.#running) {
      this.#send("abort", () => this.#client.abort(this.#sessionId()));
      return;
    }
    if (this.#editor.text !== "") this.#editor.reset();
  }

  /**
   * Ctrl+C: interrupt a live run, or exit on a second press.
   *
   * Interrupt is `abort()`, never `close()` — closing the socket would end the
   * remote run's *observer*, not the run.
   */
  #onInterrupt(): void {
    if (this.#running) {
      this.#send("abort", () => this.#client.abort(this.#sessionId()));
      this.write([style("warning")(`${this.#glyphs.interrupt} Interrupting…`)]);
      this.#lastInterrupt = 0;
      return;
    }
    const now = Date.now();
    if (now - this.#lastInterrupt < this.#interruptWindowMs) {
      this.#requestExit(AttachExitCode.ok);
      return;
    }
    this.#lastInterrupt = now;
    if (this.#editor.text !== "") this.#editor.reset();
    this.write([style("muted")("Press Ctrl+C again to exit.")]);
  }

  #requestExit(code: number): void {
    if (this.#exitRequested) return;
    this.#exitRequested = true;
    this.#exitCode = code;
    this.#resolveExit?.();
  }

  /**
   * Submit a line: a steering message while a run is active, otherwise a new
   * prompt.
   *
   * Neither call is awaited before returning — `prompt()` spans the whole
   * remote run — so the UI stays live and the inbound `runStart` event is what
   * confirms the server accepted it.
   */
  async #onSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (this.#session === undefined) {
      this.#notice("warn", "Not attached to a session yet.");
      return;
    }
    const sessionId = this.#session.sessionId;

    if (this.#running) {
      this.#send("steer", () => this.#client.steer(sessionId, trimmed));
      this.write([
        "",
        `${style("accent")(this.#glyphs.userGutter)} ${style("text")(trimmed)}`,
        style("muted")(`  ${this.#glyphs.steer} steering the remote run`),
      ]);
      return;
    }
    this.#send("prompt", () => this.#client.prompt(sessionId, trimmed));
  }

  /**
   * Fire a request and surface only its failure.
   *
   * A `ProtocolClosedError` is swallowed: the socket handlers already own that
   * story, and a duplicate notice would race the farewell line.
   */
  #send(label: string, call: () => Promise<void>): void {
    void call().catch((error: unknown) => {
      if (this.#exitRequested || error instanceof ProtocolClosedError) return;
      this.#notice("error", `${label} failed: ${errorText(error)}`);
    });
  }

  #sessionId(): string {
    return this.#session?.sessionId ?? "";
  }

  /* --------------------------------------------------------------- dialogs */

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

  /**
   * Show a remote permission request and send the answer back.
   *
   * The event carries the request's `id`, and `respondToPermission` quotes it,
   * so answers correlate exactly even with several asks outstanding — no
   * guessing by arrival order.
   */
  async #onPermissionRequest(request: PermissionRequest): Promise<void> {
    if (this.#openPermissions.has(request.id)) return;
    this.#openPermissions.add(request.id);
    const sessionId = this.#sessionId();
    try {
      const decision = await this.#decide(request);
      if (!this.#openPermissions.delete(request.id)) return;
      this.#send("permission decision", () =>
        this.#client.respondToPermission(sessionId, decision),
      );
    } catch (error) {
      this.#openPermissions.delete(request.id);
      this.#notice("error", `Permission prompt failed: ${errorText(error)}`);
    }
  }

  async #decide(request: PermissionRequest): Promise<PermissionDecision> {
    if (request.subject === EXIT_PLAN_SUBJECT) {
      const plan = request.description.replace(/^[^\n]*\n+/, "");
      const choice = await this.#showDialog(planDialog(plan, this.#glyphs));
      if (choice === "once" || choice === "always") {
        if (choice === "always") {
          // The wire has no `setPermissionMode`, so "approve and auto-accept
          // edits" cannot be expressed remotely; approve this once and say so.
          this.#notice(
            "warn",
            "Auto-accepting edits cannot be set over the wire; approving this plan once.",
          );
        }
        return { requestId: request.id, behavior: "allow" };
      }
      return {
        requestId: request.id,
        behavior: "deny",
        message: "The user wants to keep planning. Revise the plan and present it again.",
      };
    }

    const choice = await this.#showDialog(permissionDialog(request, this.#width(), this.#glyphs));
    if (choice === "once") return { requestId: request.id, behavior: "allow" };
    if (choice === "always") {
      return {
        requestId: request.id,
        behavior: "allow",
        persistRule: { ...suggestRule(request), scope: "project" },
      };
    }
    return {
      requestId: request.id,
      behavior: "deny",
      message: "The user denied this action. Do not retry it; choose another approach or ask.",
    };
  }

  /**
   * Deny anything still on screen at shutdown.
   *
   * A permission request the client never answers stalls the remote run until
   * the server's auto-deny timeout, so leaving is an explicit "no".
   *
   * @returns How many requests were denied.
   */
  #denyOpenPermissions(message: string): number {
    const requestIds = [...this.#openPermissions];
    this.#openPermissions.clear();
    const sessionId = this.#sessionId();
    for (const requestId of requestIds) {
      void this.#client
        .respondToPermission(sessionId, { requestId, behavior: "deny", message })
        .catch(() => undefined);
    }
    return requestIds.length;
  }
}

/* -------------------------------------------------------------------------- */

/** The most recently created session, or `undefined` for an empty list. */
function newestSession(sessions: readonly SessionHeader[]): SessionHeader | undefined {
  let newest: SessionHeader | undefined;
  for (const session of sessions) {
    if (newest === undefined || session.createdAt > newest.createdAt) newest = session;
  }
  return newest;
}

/** One readable line for any thrown value. */
function errorText(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error), 200);
}
