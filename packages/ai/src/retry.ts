/**
 * Retry and backoff for streaming LLM calls.
 *
 * Provider SDK retries are disabled inside the adapters because their timers
 * ignore `AbortSignal`. This module replaces them with an abortable,
 * jittered exponential backoff that understands `retryAfterMs`.
 */

import type { AIError, AssistantMessage, LLMClient, LLMRequest, StreamEvent } from "@arcturn/types";
import { isRetryableError } from "./errors.js";
import { completeFromStream } from "./internal/stream.js";

/** Details handed to {@link RetryOptions.onRetry} before each backoff sleep. */
export interface RetryAttemptInfo {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Milliseconds the client will wait before the next attempt. */
  delayMs: number;
  error: AIError;
}

/** Tuning knobs for {@link streamWithRetry}. */
export interface RetryOptions {
  /** Total attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Delay before the second attempt, before jitter. Default 500ms. */
  initialDelayMs?: number;
  /** Upper bound on computed backoff. Default 30s. */
  maxDelayMs?: number;
  /** Multiplier applied per attempt. Default 2. */
  backoffFactor?: number;
  /** Fraction of the delay that may be shaved off at random. Default 0.25. */
  jitter?: number;
  /** Server-requested delays above this abort the retry loop. Default 60s. */
  maxRetryAfterMs?: number;
  /** Override which errors are retried. Defaults to rateLimit/overloaded/network. */
  isRetryable?: (error: AIError) => boolean;
  /** Observability hook. */
  onRetry?: (info: RetryAttemptInfo) => void;
  /** Injectable sleep, mainly for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable RNG in `[0, 1)`, mainly for tests. */
  random?: () => number;
}

/** Defaults applied by {@link streamWithRetry}. */
export const DEFAULT_RETRY_OPTIONS = {
  maxAttempts: 4,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffFactor: 2,
  jitter: 0.25,
  maxRetryAfterMs: 60_000,
} as const;

/** Sleep that rejects with an `AbortError` when the signal fires. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Delay before the next attempt.
 *
 * A server-supplied `retryAfterMs` wins outright; otherwise the delay grows
 * exponentially, is capped at `maxDelayMs`, and has up to `jitter` of its value
 * shaved off at random so concurrent clients do not resynchronise.
 *
 * @param attempt - 1-based index of the attempt that just failed.
 */
export function computeBackoffDelay(
  attempt: number,
  error?: AIError,
  options: RetryOptions = {},
): number {
  const initial = options.initialDelayMs ?? DEFAULT_RETRY_OPTIONS.initialDelayMs;
  const factor = options.backoffFactor ?? DEFAULT_RETRY_OPTIONS.backoffFactor;
  const maxDelay = options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs;
  const jitter = options.jitter ?? DEFAULT_RETRY_OPTIONS.jitter;
  const random = options.random ?? Math.random;

  if (error?.retryAfterMs !== undefined && error.retryAfterMs >= 0) {
    return Math.round(error.retryAfterMs);
  }
  const base = Math.min(maxDelay, initial * factor ** Math.max(0, attempt - 1));
  return Math.round(base * (1 - random() * jitter));
}

function isContentEvent(event: StreamEvent): boolean {
  switch (event.type) {
    case "textStart":
    case "textDelta":
    case "thinkingStart":
    case "thinkingDelta":
    case "toolCallStart":
    case "toolCallDelta":
    case "toolCallEnd":
      return true;
    default:
      return false;
  }
}

function abortedMessage(message: AssistantMessage): AssistantMessage {
  const { errorMessage: _dropped, ...rest } = message;
  return { ...rest, stopReason: "aborted" };
}

/**
 * Stream a request, retrying transient failures with exponential backoff.
 *
 * A retry is only attempted while nothing has been emitted yet; once content
 * has reached the consumer the stream is passed through untouched so the
 * caller never sees a partial answer replaced by a different one. Exactly one
 * `start` and one terminal event are emitted across all attempts.
 */
export async function* streamWithRetry(
  client: LLMClient,
  request: LLMRequest,
  options: RetryOptions = {},
): AsyncIterable<StreamEvent> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts;
  const maxRetryAfter = options.maxRetryAfterMs ?? DEFAULT_RETRY_OPTIONS.maxRetryAfterMs;
  const retryable = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? abortableSleep;

  let startEmitted = false;

  for (let attempt = 1; ; attempt++) {
    let produced = false;
    let failure: Extract<StreamEvent, { type: "error" }> | undefined;

    for await (const event of client.stream(request)) {
      if (event.type === "start") {
        if (startEmitted) continue;
        startEmitted = true;
        yield event;
        continue;
      }
      if (event.type === "error") {
        const canRetry =
          !produced &&
          attempt < maxAttempts &&
          retryable(event.error) &&
          !(event.error.retryAfterMs !== undefined && event.error.retryAfterMs > maxRetryAfter);
        if (canRetry) {
          failure = event;
          break;
        }
        yield event;
        return;
      }
      if (event.type === "end") {
        yield event;
        return;
      }
      if (isContentEvent(event)) produced = true;
      yield event;
    }

    if (!failure) return;

    const delayMs = computeBackoffDelay(attempt, failure.error, options);
    options.onRetry?.({ attempt, delayMs, error: failure.error });
    try {
      await sleep(delayMs, request.signal);
    } catch {
      yield { type: "end", message: abortedMessage(failure.message) };
      return;
    }
    if (request.signal?.aborted) {
      yield { type: "end", message: abortedMessage(failure.message) };
      return;
    }
  }
}

/** Wrap a client so every `stream`/`complete` call retries transient failures. */
export function withRetry(client: LLMClient, options: RetryOptions = {}): LLMClient {
  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return streamWithRetry(client, request, options);
    },
    complete(request: LLMRequest) {
      return completeFromStream(streamWithRetry(client, request, options));
    },
  };
}
