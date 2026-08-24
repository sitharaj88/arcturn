/**
 * Secret redaction for everything the extension logs or throws.
 *
 * `arcturn serve`'s own module doc is explicit about the threat model: a
 * connection that holds the token gets full tool execution as the user
 * running the server. So the token is a credential, and the extension treats
 * it as one — it lives in memory, is never written to settings, `globalState`
 * or a log, and every string that could carry it goes through this module
 * first.
 *
 * Three layers, deliberately overlapping:
 *
 * 1. **Known secrets.** The token the extension generated is registered up
 *    front, so redaction is total from the first byte the child process
 *    writes — there is no window where a secret exists but the redactor does
 *    not know it.
 * 2. **Shape rules.** `--token <value>`, `token=<value>` in a query or
 *    fragment. These catch a secret this process never generated, e.g. one
 *    the engine produced itself and echoed on its "attach with:" line.
 * 3. **A long hex run.** {@link https://nodejs.org/api/crypto.html | randomBytes}
 *    hex is the shape every generated token takes. A commit sha would be
 *    caught too; in a serve diagnostic that is a trade worth making, because
 *    the alternative failure is a credential in a log file.
 *
 * Pure and `vscode`-free so every rule is testable directly.
 */

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/**
 * Secrets shorter than this are ignored. A one- or two-character "secret"
 * would blank out unrelated text and make a diagnostic useless without
 * protecting anything a token-length credential needs protecting from.
 */
const MIN_SECRET_LENGTH = 8;

/** `--token <value>` / `--token=<value>` on a command line. */
const TOKEN_FLAG = /(--token[=\s]+)(\S+)/g;
/** `token=<value>` in a URL query or fragment. */
const TOKEN_PARAM = /([?#&]token=)([^\s&]+)/g;
/** A bare hex run of at least 32 characters — the shape of a generated token. */
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;

/** Escape a literal for use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove every secret from `text`.
 *
 * @param text - Text that may contain a credential.
 * @param secrets - Known secrets; values shorter than 8 characters are ignored.
 * @returns `text` with every secret (and every secret-shaped run) replaced by
 *   {@link REDACTED}.
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  out = out.replace(TOKEN_FLAG, `$1${REDACTED}`);
  out = out.replace(TOKEN_PARAM, `$1${REDACTED}`);
  out = out.replace(LONG_HEX, REDACTED);
  return out;
}

/**
 * Render any thrown value as a message safe to show or log.
 *
 * Only an `Error`'s `message` is used — never its `stack`, which routinely
 * carries absolute paths and, for a spawn failure, the whole argument vector.
 *
 * @param error - The thrown value.
 * @param secrets - Known secrets to strip.
 */
export function safeMessage(error: unknown, secrets: Iterable<string>): string {
  if (error === undefined || error === null) return "unknown error";
  const raw = error instanceof Error ? error.message : String(safeStringify(error));
  return redactSecrets(raw, secrets);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A redactor whose secret set can grow after construction. */
export interface Redactor {
  /** Register a secret. Values shorter than 8 characters are ignored. */
  add(secret: string | undefined): void;
  /** Strip every known secret (and every secret-shaped run) from `text`. */
  redact(text: string): string;
  /** {@link safeMessage} against this redactor's secrets. */
  message(error: unknown): string;
}

/**
 * Create a {@link Redactor}.
 *
 * @param secrets - Secrets known at construction time.
 */
export function createRedactor(secrets: Iterable<string> = []): Redactor {
  const known = new Set<string>();
  const add = (secret: string | undefined): void => {
    if (typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH) known.add(secret);
  };
  for (const secret of secrets) add(secret);
  return {
    add,
    redact: (text) => redactSecrets(text, known),
    message: (error) => safeMessage(error, known),
  };
}
