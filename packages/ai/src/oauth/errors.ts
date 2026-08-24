/**
 * OAuth error type and the redaction every message it carries goes through.
 *
 * Rule for this subsystem: a credential never reaches a log or an exception
 * message. An authorization server's error text routinely echoes what it
 * rejected, so {@link OAuthError} redacts its own message on construction
 * rather than trusting each call site to remember.
 */

import { AIErrorException } from "../errors.js";

/** Placeholder substituted for anything that looks like a credential. */
export const REDACTED = "[redacted]";

/**
 * Error codes this subsystem raises.
 *
 * An authorization server's own RFC 6749 code (`access_denied`,
 * `invalid_request`, …) is passed through verbatim, which is why the union
 * stays open; the `arcturn_`-prefixed ones are raised locally by the loopback
 * listener.
 */
export type OAuthErrorCode =
  | "access_denied"
  | "invalid_request"
  | "arcturn_state_mismatch"
  | "arcturn_timeout"
  | "arcturn_cancelled"
  | "arcturn_bad_response"
  | (string & {});

/** Everything that went wrong during an OAuth flow, with the secrets stripped. */
export class OAuthError extends Error {
  /** Machine-readable code; provider codes pass through unchanged. */
  readonly code: OAuthErrorCode;
  /** HTTP status, when the failure came from a response. */
  readonly status?: number;
  /** The provider whose flow failed, when known. */
  readonly provider?: string;

  constructor(
    code: OAuthErrorCode,
    message: string,
    options?: { status?: number; provider?: string; cause?: unknown },
  ) {
    super(redactSecrets(message), options?.cause !== undefined ? { cause: options.cause } : {});
    this.name = "OAuthError";
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.provider !== undefined) this.provider = options.provider;
  }

  /**
   * Project onto the harness-wide auth error so a failure raised while
   * resolving a token surfaces as a normal `auth` stream error.
   */
  toAIErrorException(): AIErrorException {
    return new AIErrorException(
      {
        kind: "auth",
        message: this.message,
        ...(this.status !== undefined ? { status: this.status } : {}),
      },
      { cause: this },
    );
  }
}

/** JSON/form field names whose values are always credentials. */
const SECRET_FIELDS = [
  "access_token",
  "refresh_token",
  "id_token",
  "device_code",
  "client_secret",
  "code_verifier",
  "authorization",
  "token",
];

/** Credential shapes recognisable on sight, redacted even outside a field. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + base62, and the tid=…;exp=… Copilot form.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Anthropic and OpenAI style keys.
  /\bsk-[A-Za-z0-9-]{2,}-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // JWTs (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip credentials from text destined for an error message or a diagnostic.
 *
 * Three passes: caller-supplied literal secrets, then `"access_token": "…"` /
 * `access_token=…` field values, then recognisable token shapes.
 *
 * @param text - Text that may embed a credential.
 * @param secrets - Literal values known to be secret (the token just used).
 * @returns The text with every credential replaced by {@link REDACTED}.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;

  for (const secret of secrets) {
    // Very short values would redact half the message; they are not credentials.
    if (typeof secret !== "string" || secret.length < 8) continue;
    out = out.replaceAll(secret, REDACTED);
  }

  for (const field of SECRET_FIELDS) {
    const json = new RegExp(`("${escapeRegExp(field)}"\\s*:\\s*")([^"]*)(")`, "gi");
    out = out.replace(json, `$1${REDACTED}$3`);
    const form = new RegExp(`(\\b${escapeRegExp(field)}=)([^&\\s"']+)`, "gi");
    out = out.replace(form, `$1${REDACTED}`);
    const header = new RegExp(`(\\b${escapeRegExp(field)}\\s*:\\s*)(Bearer|token)\\s+\\S+`, "gi");
    out = out.replace(header, `$1$2 ${REDACTED}`);
  }

  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }

  return out;
}
