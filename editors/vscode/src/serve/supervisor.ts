/**
 * The `arcturn serve` child process: start it, learn its address, keep the
 * token out of everything, and make sure it dies when the sidebar does.
 *
 * RFC 0004 §1 Stage 2: "The extension spawns `arcturn serve` per workspace on
 * a loopback ephemeral port with a generated token, hands the token to the
 * client via the URL fragment, and never writes it to logs, settings or
 * globalState. Serve dying → sidebar shows a reconnect card, never a stack
 * trace."
 *
 * Three properties this module is responsible for:
 *
 * 1. **Nothing leaks.** The token is registered with a {@link Redactor} before
 *    the process is spawned, so every line of child output and every rejection
 *    below is redacted from the first byte. In particular the engine's own
 *    `attach with: … --token <secret>` line is never logged, only dropped.
 * 2. **Nothing is trusted.** The announced address is checked for loopback
 *    before the token is ever handed to a socket pointed at it. If the engine
 *    bound something else, the child is killed and the start fails.
 * 3. **Nothing is orphaned.** `dispose()` terminates the child (SIGTERM, then
 *    SIGKILL after a grace period) and suppresses the exit report, so a
 *    deliberate shutdown never reaches the user as a reconnect card.
 *
 * `spawn` is injected rather than imported so the whole lifecycle is testable
 * with no real process — see `supervisor.test.ts`.
 */

import { formatConnectUrl, isLoopbackSocketUrl, parseServeAnnouncement } from "./address.js";
import { createLineSplitter } from "./lines.js";
import { createRedactor } from "./redact.js";

/** The slice of `child_process.ChildProcess` this module uses. */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: string | number): boolean;
}

/** The slice of `child_process.spawn` this module uses. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string | undefined>; stdio: readonly string[] },
) => ChildLike;

/**
 * Why a start failed, in a shape the sidebar can render.
 *
 * The `Error` message these travel with is for the log; this is for the card.
 * `stderr` is the engine's **own words**, redacted and otherwise verbatim, so
 * the UI can show what `arcturn serve` actually said — which for the most
 * common failure is a complete, actionable sentence the extension has no
 * business paraphrasing:
 *
 * ```
 * arcturn: No API key found for Claude Sonnet 4.5 (anthropic/claude-sonnet-4-5).
 * Set ANTHROPIC_API_KEY in your environment, or pick another model with --model.
 * ```
 */
export interface ServeStartFailure {
  /**
   * - `spawn` — the child could not be executed at all.
   * - `exited` — it ran and then died before announcing an address.
   * - `timeout` — it is still running but never announced one.
   * - `address` — it announced something that is not loopback.
   */
  readonly reason: "spawn" | "exited" | "timeout" | "address";
  /** Exit code, when the platform reported one. */
  readonly code: number | null;
  /** Terminating signal, when there was one. */
  readonly signal: string | null;
  /** Redacted tail of the child's stderr. `""` when it said nothing. */
  readonly stderr: string;
}

/**
 * A failed start, with the failure attached rather than only spelled into the
 * message.
 *
 * The message stays human-readable (and redacted) because it is what reaches
 * the Output channel; {@link ServeStartError.failure} is what
 * `sidebar/connection-card.ts` turns into a card the user can act on.
 */
export class ServeStartError extends Error {
  readonly failure: ServeStartFailure;

  constructor(message: string, failure: ServeStartFailure) {
    super(message);
    this.name = "ServeStartError";
    this.failure = failure;
  }
}

/** How an exit after a successful start is reported. */
export interface ServeExitInfo {
  code: number | null;
  signal: string | null;
  /** Redacted tail of the child's stderr, for the reconnect card. */
  detail: string;
}

/** Options for {@link startServeProcess}. */
export interface ServeProcessOptions {
  /** Executable, from Builder A's `resolveCli`. */
  command: string;
  /** Argument vector, from `buildServeArgs`. */
  args: readonly string[];
  /** Working directory for the child. */
  cwd: string;
  /** The generated shared secret. Registered for redaction, never logged. */
  token: string;
  /** Injected `child_process.spawn`. */
  spawn: SpawnLike;
  /** Environment for the child. Defaults to inheriting the extension host's. */
  env?: Record<string, string | undefined>;
  /** How long to wait for the address line. Default 30s. */
  startupTimeoutMs?: number;
  /** How long SIGTERM gets before SIGKILL. Default 2s. */
  killGraceMs?: number;
  /** Diagnostics sink. Every line handed to it is already redacted. */
  log?: (line: string) => void;
  /** Called once if the child exits after a successful start. */
  onExit?: (info: ServeExitInfo) => void;
}

/** A running `arcturn serve`. */
export interface ServeProcess {
  /** `ws://host:port` — what a socket is opened against. */
  readonly socketUrl: string;
  /** `ws://host:port#token=…` — the address plus its credential. */
  readonly connectUrl: string;
  /** Process id, when the platform reported one. */
  readonly pid: number | undefined;
  /** Terminate the child and stop reporting its exit. Idempotent. */
  dispose(): void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** How much stderr is kept for a failure message. */
const STDERR_TAIL_LINES = 20;

/**
 * Spawn `arcturn serve` and resolve once it announces its address.
 *
 * @param options - See {@link ServeProcessOptions}.
 * @returns The running server, addressed by a fragment-carrying connect URL.
 * @throws When the child dies, times out, fails to spawn, or announces a
 *   non-loopback address. Every such error's message is redacted.
 */
export function startServeProcess(options: ServeProcessOptions): Promise<ServeProcess> {
  const redactor = createRedactor([options.token]);
  const log = (line: string): void => options.log?.(redactor.redact(line));
  const stderrTail: string[] = [];

  return new Promise<ServeProcess>((resolve, reject) => {
    let settled = false;
    let disposed = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;

    /** The redacted stderr tail, as one block. */
    const capturedStderr = (): string => stderrTail.join("\n").trim();

    let child: ChildLike;
    try {
      child = options.spawn(options.command, options.args, {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new ServeStartError(`Could not start arcturn serve: ${redactor.message(error)}`, {
          reason: "spawn",
          code: null,
          signal: null,
          stderr: "",
        }),
      );
      return;
    }

    const terminate = (): void => {
      if (exited) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // The child is already gone; nothing to escalate to.
        return;
      }
      killTimer = setTimeout(() => {
        if (exited) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      (killTimer as { unref?: () => void }).unref?.();
    };

    const fail = (message: string, failure: ServeStartFailure): void => {
      if (settled) return;
      settled = true;
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      terminate();
      reject(new ServeStartError(redactor.redact(message), failure));
    };

    const succeed = (socketUrl: string): void => {
      if (settled) return;
      settled = true;
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      resolve({
        socketUrl,
        connectUrl: formatConnectUrl(socketUrl, options.token),
        pid: child.pid,
        dispose(): void {
          if (disposed) return;
          disposed = true;
          stdout.dispose();
          stderr.dispose();
          terminate();
        },
      });
    };

    const stdout = createLineSplitter((line) => {
      const announced = parseServeAnnouncement(line);
      if (announced === undefined) {
        // Never log an unrecognised line verbatim before redaction — the
        // "attach with:" line the engine prints carries the token itself.
        log(`serve: ${line}`);
        return;
      }
      if (!isLoopbackSocketUrl(announced)) {
        fail(
          `arcturn serve bound ${announced}, which is not a loopback address; refusing to hand it a token`,
          { reason: "address", code: null, signal: null, stderr: capturedStderr() },
        );
        return;
      }
      log(`serve: listening on ${announced}`);
      succeed(announced);
    });

    const stderr = createLineSplitter((line) => {
      const redacted = redactor.redact(line);
      stderrTail.push(redacted);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      log(`serve: ${redacted}`);
    });

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));

    child.on("error", (error) => {
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      const message = `arcturn serve failed to start: ${redactor.message(error)}`;
      if (settled) {
        if (!disposed) options.onExit?.({ code: null, signal: null, detail: message });
        return;
      }
      settled = true;
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      reject(
        new ServeStartError(message, {
          reason: "spawn",
          code: null,
          signal: null,
          stderr: capturedStderr(),
        }),
      );
    });

    child.on("exit", (code, signal) => {
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      stdout.flush();
      stderr.flush();
      const detail = capturedStderr();
      if (!settled) {
        fail(
          `arcturn serve exited ${signal ?? `with code ${String(code)}`} before it announced an address` +
            (detail === "" ? "" : `:\n${detail}`),
          { reason: "exited", code, signal, stderr: detail },
        );
        return;
      }
      // A dispose()d child is a deliberate shutdown, not an outage.
      if (disposed) return;
      options.onExit?.({
        code,
        signal,
        detail:
          detail === "" ? `arcturn serve exited ${signal ?? `with code ${String(code)}`}` : detail,
      });
    });

    startupTimer = setTimeout(() => {
      fail(
        `arcturn serve did not start within ${String(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)}ms`,
        { reason: "timeout", code: null, signal: null, stderr: capturedStderr() },
      );
    }, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    (startupTimer as { unref?: () => void }).unref?.();
  });
}
