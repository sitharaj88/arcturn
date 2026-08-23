/**
 * Idle-stall timeout for streaming LLM calls.
 *
 * A long thinking turn or a big streamed response is *healthy* and must never
 * be interrupted — so this is deliberately **not** a total-duration cap. It is
 * an *idle* watchdog: the timer is armed before the first event and reset on
 * every {@link StreamEvent} the provider emits (`textDelta`, `thinkingDelta`,
 * `toolCallDelta`, `usage`, `start`, `blockEnd`, …). Only when the stream falls
 * completely silent for `timeoutMs` — no event at all, the signature of a dead
 * socket rather than a slow one — does the watchdog fire.
 *
 * ## Why a client wrapper, and how the abort reaches the socket
 *
 * The wrapper composes the caller's `AbortSignal` with a private idle
 * controller and hands the *composed* signal down as `request.signal`. Every
 * provider adapter already forwards `request.signal` to its SDK, so the one
 * composition here reaches all of them — no adapter is edited, and when the
 * watchdog aborts the idle controller the underlying HTTP request is torn down
 * for real (the stalled socket is closed, not merely abandoned).
 *
 * ## Classification: a stall is a *transient network* failure
 *
 * When the idle controller aborts, the adapter surfaces an aborted terminal via
 * {@link assembleStream}. Left as-is that would read as a user cancellation and
 * stop the whole run. Instead the wrapper re-labels *its own* timeout as a
 * `network` error — the same kind a dropped connection produces — so the
 * existing retry ({@link streamWithRetry}) and failover ({@link streamFailover})
 * layers treat a stalled provider exactly like any other transient blip: retried
 * with backoff, then failed over. A *real* caller abort is never re-labelled; it
 * passes through untouched.
 */

import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  ModelSpec,
  StreamEvent,
} from "@arcturn/types";
import { createAIError } from "./errors.js";
import { completeFromStream } from "./internal/stream.js";

/**
 * Default idle ceiling: 120 seconds without a single stream event.
 *
 * The watchdog measures the gap *between* events, not the length of the turn,
 * so this is not a budget for how long the model may think — a healthy
 * extended-thinking turn streams `thinkingDelta`/`usage` events the whole way
 * and resets the timer continuously. The only naturally quiet window is the
 * wait for the first byte, which even a heavily loaded provider fills within
 * tens of seconds. 120s sits at the very top of that "still plausibly alive"
 * band: generous enough that a slow reasoning model never trips it, decisive
 * enough that a dead socket becomes a ~2-minute recoverable failure instead of
 * the ~23-minute hang it was before. A false trip before any output is simply
 * retried (harmless); a 120s gap *after* output has begun is genuinely
 * anomalous. Override per-config with `requestStallTimeoutMs`; `0` disables it.
 */
export const DEFAULT_REQUEST_STALL_TIMEOUT_MS = 120_000;

/** Schedules a one-shot callback and returns a canceller. */
export type ScheduleTimeout = (ms: number, fire: () => void) => () => void;

/** Tuning knobs for {@link withIdleTimeout}. */
export interface IdleTimeoutOptions {
  /**
   * Milliseconds of total silence tolerated before the request is treated as
   * stalled. Defaults to {@link DEFAULT_REQUEST_STALL_TIMEOUT_MS}. `0`,
   * negative, or non-finite disables the watchdog entirely (pass-through).
   */
  timeoutMs?: number;
  /** Injectable timer, mainly for tests. Defaults to `setTimeout`/`clearTimeout`. */
  schedule?: ScheduleTimeout;
  /** Observability hook fired when a request is declared stalled. */
  onTimeout?: (info: { model: string; timeoutMs: number }) => void;
}

/** Real-timer scheduler; unref'd so a pending watchdog never keeps the process alive. */
function defaultSchedule(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

/**
 * Compose the caller's signal with the idle controller's signal.
 *
 * The result aborts when *either* input aborts, carrying that input's abort
 * reason. Listeners are removed by `dispose` so a completed stream leaves
 * nothing attached to a long-lived caller signal.
 */
function linkSignals(
  caller: AbortSignal | undefined,
  idle: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!caller) return { signal: idle, dispose: () => {} };
  const controller = new AbortController();
  if (caller.aborted) {
    controller.abort(caller.reason);
    return { signal: controller.signal, dispose: () => {} };
  }
  const onCaller = (): void => controller.abort(caller.reason);
  const onIdle = (): void => controller.abort(idle.reason);
  caller.addEventListener("abort", onCaller, { once: true });
  idle.addEventListener("abort", onIdle, { once: true });
  const dispose = (): void => {
    caller.removeEventListener("abort", onCaller);
    idle.removeEventListener("abort", onIdle);
  };
  return { signal: controller.signal, dispose };
}

/** True for a terminal event whose stop reason is an abort (either shape). */
function isAbortTerminal(event: StreamEvent): boolean {
  if (event.type === "end") return event.message.stopReason === "aborted";
  if (event.type === "error") return event.error.kind === "aborted";
  return false;
}

/** Human-readable stall message: names the model, the endpoint and the knob to turn. */
function stallMessage(spec: ModelSpec, timeoutMs: number): string {
  const endpoint = spec.baseUrl ? `${spec.provider} at ${spec.baseUrl}` : spec.provider;
  return (
    `${spec.displayName} (${endpoint}) streamed no data for ${timeoutMs}ms; ` +
    `the request stalled and is being treated as a transient network error. ` +
    `Raise or disable this limit with "requestStallTimeoutMs" in your Arcturn ` +
    `config (0 disables it).`
  );
}

/**
 * Re-label an idle-timeout abort as a transient `network` error event, keeping
 * any partial content the stream produced before it went silent.
 */
function stallError(
  spec: ModelSpec,
  timeoutMs: number,
  terminal: Extract<StreamEvent, { type: "end" | "error" }>,
): Extract<StreamEvent, { type: "error" }> {
  const message = stallMessage(spec, timeoutMs);
  const partial: AssistantMessage = {
    ...terminal.message,
    stopReason: "error",
    errorMessage: message,
  };
  return { type: "error", error: createAIError("network", message), message: partial };
}

/**
 * Stream a request under an idle watchdog.
 *
 * Arms a timer before the first event (bounding a dead connect) and resets it on
 * every event that reaches the consumer. On silence past `timeoutMs` it aborts
 * the composed signal — tearing down the real socket — and surfaces the
 * resulting terminal as a `network` error so retry/failover can recover. Exactly
 * one terminal event is emitted; a genuine caller abort is passed through as-is.
 */
export async function* streamWithIdleTimeout(
  client: LLMClient,
  request: LLMRequest,
  options: IdleTimeoutOptions = {},
): AsyncIterable<StreamEvent> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_STALL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    // Disabled: no watchdog, no signal composition, no per-request overhead.
    yield* client.stream(request);
    return;
  }

  const schedule = options.schedule ?? defaultSchedule;
  const callerSignal = request.signal;
  const idleController = new AbortController();
  const { signal: composedSignal, dispose } = linkSignals(callerSignal, idleController.signal);
  const composedRequest: LLMRequest =
    composedSignal === callerSignal ? request : { ...request, signal: composedSignal };

  let timedOut = false;
  let cancel: (() => void) | undefined;
  const clearTimer = (): void => {
    cancel?.();
    cancel = undefined;
  };
  const arm = (): void => {
    clearTimer();
    cancel = schedule(timeoutMs, () => {
      timedOut = true;
      options.onTimeout?.({ model: request.model.id, timeoutMs });
      idleController.abort();
    });
  };
  // A stall the caller also aborted is the caller's intent, not ours.
  const causedByCaller = (): boolean => callerSignal?.aborted === true;

  try {
    arm(); // bound time-to-first-event
    for await (const event of client.stream(composedRequest)) {
      clearTimer();
      const isTerminal = event.type === "end" || event.type === "error";
      if (timedOut && !causedByCaller() && isAbortTerminal(event)) {
        yield stallError(
          request.model,
          timeoutMs,
          event as Extract<StreamEvent, { type: "end" | "error" }>,
        );
        return;
      }
      if (isTerminal) {
        yield event;
        return;
      }
      yield event;
      // Only a live stream re-arms; once we have fired, the abort is in flight
      // and we are just waiting for the terminal to reclassify.
      if (!timedOut) arm();
    }
  } finally {
    clearTimer();
    dispose();
  }
}

/**
 * Wrap a client so every `stream`/`complete` call is guarded by an idle
 * watchdog. Place this *inside* retry/failover (closest to the provider) so each
 * attempt gets its own fresh timer and a stall is retried/failed-over like any
 * transient network error.
 */
export function withIdleTimeout(client: LLMClient, options: IdleTimeoutOptions = {}): LLMClient {
  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return streamWithIdleTimeout(client, request, options);
    },
    complete(request: LLMRequest) {
      return completeFromStream(streamWithIdleTimeout(client, request, options));
    },
  };
}
