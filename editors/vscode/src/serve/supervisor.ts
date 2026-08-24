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

    let child: ChildLike;
    try {
      child = options.spawn(options.command, options.args, {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`Could not start arcturn serve: ${redactor.message(error)}`));
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

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      terminate();
      reject(new Error(redactor.redact(message)));
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
      reject(new Error(message));
    });

    child.on("exit", (code, signal) => {
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      stdout.flush();
      stderr.flush();
      const detail = stderrTail.join("\n").trim();
      if (!settled) {
        fail(
          `arcturn serve exited ${signal ?? `with code ${String(code)}`} before it announced an address` +
            (detail === "" ? "" : `:\n${detail}`),
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
      );
    }, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    (startupTimer as { unref?: () => void }).unref?.();
  });
}
