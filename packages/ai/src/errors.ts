/**
 * Error classification shared by every provider adapter.
 *
 * Provider SDKs throw structurally similar but nominally different errors, so
 * classification is done by duck typing rather than `instanceof` checks. This
 * keeps the module free of hard dependencies on any single SDK.
 */

import type { AIError } from "@arcturn/types";

/** Error kinds that are worth retrying with backoff. */
const RETRYABLE_KINDS: ReadonlySet<AIError["kind"]> = new Set([
  "rateLimit",
  "overloaded",
  "network",
]);

/** Google RPC status strings that map onto our error kinds. */
const GOOGLE_STATUS_KINDS: Readonly<Record<string, AIError["kind"]>> = {
  UNAUTHENTICATED: "auth",
  PERMISSION_DENIED: "auth",
  RESOURCE_EXHAUSTED: "rateLimit",
  UNAVAILABLE: "overloaded",
  DEADLINE_EXCEEDED: "network",
  INVALID_ARGUMENT: "invalidRequest",
  FAILED_PRECONDITION: "invalidRequest",
  NOT_FOUND: "invalidRequest",
  CANCELLED: "aborted",
  INTERNAL: "overloaded",
  UNKNOWN: "unknown",
};

/** Node/undici network error codes. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** An `Error` subclass that also satisfies the {@link AIError} contract. */
export class AIErrorException extends Error implements AIError {
  readonly kind: AIError["kind"];
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(error: AIError, options?: { cause?: unknown }) {
    super(error.message, options);
    this.name = "AIErrorException";
    this.kind = error.kind;
    if (error.status !== undefined) this.status = error.status;
    if (error.retryAfterMs !== undefined) this.retryAfterMs = error.retryAfterMs;
  }

  /** Plain data view, safe to place on a `StreamEvent`. */
  toAIError(): AIError {
    const out: AIError = { kind: this.kind, message: this.message };
    if (this.status !== undefined) out.status = this.status;
    if (this.retryAfterMs !== undefined) out.retryAfterMs = this.retryAfterMs;
    return out;
  }
}

/** Build an {@link AIError} without the noise of optional-property juggling. */
export function createAIError(
  kind: AIError["kind"],
  message: string,
  extra?: { status?: number; retryAfterMs?: number },
): AIError {
  const error: AIError = { kind, message };
  if (extra?.status !== undefined) error.status = extra.status;
  if (extra?.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs;
  return error;
}

/** True when the error is transient and a retry could plausibly succeed. */
export function isRetryableError(error: AIError): boolean {
  return RETRYABLE_KINDS.has(error.kind);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const getter = record(headers)?.get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  const plain = record(headers);
  if (!plain) return undefined;
  for (const [key, value] of Object.entries(plain)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}

/**
 * Parse `retry-after` / `retry-after-ms` headers into milliseconds.
 * Supports the seconds form, the millisecond form and the HTTP-date form.
 */
export function parseRetryAfterMs(headers: unknown, now = Date.now()): number | undefined {
  const ms = readHeader(headers, "retry-after-ms");
  if (ms !== undefined) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  const raw = readHeader(headers, "retry-after");
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function kindFromStatus(status: number): AIError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 409) return "network";
  if (status === 429) return "rateLimit";
  if (status === 529 || status === 503 || status === 502 || status === 504) return "overloaded";
  if (status >= 500) return "overloaded";
  if (status >= 400) return "invalidRequest";
  return "unknown";
}

function numericStatus(source: Record<string, unknown>): number | undefined {
  for (const key of ["status", "statusCode", "code"]) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 100 && value < 600) {
      return value;
    }
  }
  return undefined;
}

function isAbort(err: unknown, source: Record<string, unknown> | undefined, text: string): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  const name = source?.name;
  if (name === "AbortError" || name === "APIUserAbortError") return true;
  return /\baborted\b|\babort(ed)? (request|signal)\b|operation was aborted/i.test(text);
}

/**
 * Normalise anything thrown by a provider SDK into an {@link AIError}.
 *
 * @param err - The thrown value.
 * @param signal - Optional request signal; when already aborted the error is
 *   classified as `aborted` regardless of what the SDK reported.
 */
export function toAIError(err: unknown, signal?: AbortSignal): AIError {
  if (err instanceof AIErrorException) return err.toAIError();

  const source = record(err);
  const message =
    (typeof source?.message === "string" && (source.message as string)) ||
    (typeof err === "string" ? err : "") ||
    "Unknown provider error";

  if (signal?.aborted || isAbort(err, source, message)) {
    return createAIError("aborted", "The request was aborted");
  }

  const headers = source?.headers ?? record(source?.response)?.headers;
  const retryAfterMs = parseRetryAfterMs(headers);

  const status = source ? numericStatus(source) : undefined;
  if (status !== undefined) {
    return createAIError(kindFromStatus(status), message, { status, retryAfterMs });
  }

  const rpcStatus = source?.status;
  if (typeof rpcStatus === "string") {
    const mapped = GOOGLE_STATUS_KINDS[rpcStatus.toUpperCase()];
    if (mapped) return createAIError(mapped, message, { retryAfterMs });
  }

  const code = source?.code;
  if (typeof code === "string") {
    if (NETWORK_CODES.has(code.toUpperCase())) {
      return createAIError("network", message, { retryAfterMs });
    }
    const mapped = GOOGLE_STATUS_KINDS[code.toUpperCase()];
    if (mapped) return createAIError(mapped, message, { retryAfterMs });
  }

  const cause = record(source?.cause);
  const causeCode = cause?.code;
  if (typeof causeCode === "string" && NETWORK_CODES.has(causeCode.toUpperCase())) {
    return createAIError("network", message, { retryAfterMs });
  }

  if (
    /fetch failed|network error|socket hang up|premature close|terminated|stream ended (before|without)/i.test(
      message,
    )
  ) {
    return createAIError("network", message, { retryAfterMs });
  }
  if (/rate.?limit|too many requests|quota/i.test(message)) {
    return createAIError("rateLimit", message, { retryAfterMs });
  }
  if (/overloaded|unavailable|temporarily/i.test(message)) {
    return createAIError("overloaded", message, { retryAfterMs });
  }
  if (/api key|unauthenticated|unauthorized|permission denied/i.test(message)) {
    return createAIError("auth", message, { retryAfterMs });
  }

  return createAIError("unknown", message, { retryAfterMs });
}
