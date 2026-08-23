/**
 * Tokenization for code retrieval.
 *
 * Developers search for identifiers they half-remember. `getUserById` must be
 * findable by "user id", by "getUser", and by its exact spelling — so every
 * identifier is indexed **both** whole and split on its camelCase / snake_case
 * / kebab-case / dotted boundaries. That single decision is what makes a plain
 * BM25 index behave semantically on code without any embedding cost.
 */

/** Runs of identifier characters, the only thing worth indexing in source text. */
const IDENTIFIER_RUN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** `fooBar` / `foo9Bar` → `foo Bar`. Lower-or-digit followed by upper. */
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

/** `HTTPResponse` → `HTTP Response`. Acronym followed by a capitalized word. */
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;

/** `parse2Json` → `parse 2 Json`. Letter/digit transitions in both directions. */
const DIGIT_BOUNDARY = /([A-Za-z])([0-9])/g;

/** Everything that separates words but is not a camel boundary. */
const HARD_SEPARATORS = /[^A-Za-z0-9]+/;

/**
 * Single-character tokens carry no retrieval signal and inflate the postings
 * list; two-character ones (`id`, `db`, `fs`, `ok`) very much do.
 */
const MIN_TOKEN_LENGTH = 2;

/**
 * Split one identifier into its lowercase word parts.
 *
 * @example
 * splitIdentifier("getUserById")     // ["get", "user", "by", "id"]
 * splitIdentifier("parseHTTPResponse") // ["parse", "http", "response"]
 * splitIdentifier("MAX_RETRY_COUNT") // ["max", "retry", "count"]
 * splitIdentifier("rate-limit.ts")   // ["rate", "limit", "ts"]
 */
export function splitIdentifier(identifier: string): string[] {
  const spaced = identifier
    .replace(ACRONYM_BOUNDARY, "$1 $2")
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .replace(DIGIT_BOUNDARY, "$1 $2");
  return spaced
    .split(HARD_SEPARATORS)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Expand one identifier into every token it should be findable by: the whole
 * lowercased identifier plus each of its parts.
 *
 * The whole form is what makes an exact spelling rank highest (it is a rare
 * term, so BM25's IDF rewards it); the parts are what make a half-remembered
 * phrase match at all.
 */
export function expandIdentifier(identifier: string): string[] {
  const whole = identifier.toLowerCase();
  const parts = splitIdentifier(identifier);
  const out: string[] = [];
  if (whole.length >= MIN_TOKEN_LENGTH) out.push(whole);
  for (const part of parts) {
    if (part.length >= MIN_TOKEN_LENGTH && part !== whole) out.push(part);
  }
  return out;
}

/**
 * Tokenize arbitrary text (a signature, a doc comment, a query, a path) into
 * the term list used for both indexing and querying. Duplicates are kept —
 * term frequency is a BM25 input.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(IDENTIFIER_RUN);
  if (!matches) return out;
  for (const match of matches) {
    // `$`/`_` are identifier characters in several languages but never useful
    // as a term on their own; strip them from the whole form.
    const cleaned = match.replace(/^[_$]+|[_$]+$/g, "");
    if (cleaned.length === 0) continue;
    out.push(...expandIdentifier(cleaned));
  }
  return out;
}

/**
 * Tokenize a repo-relative path into searchable terms: each segment, each
 * segment's word parts, and the extension. Path terms are part of every
 * chunk's document, which is why `search_code("auth session")` finds
 * `src/auth/session.ts` even when neither word appears in the source.
 */
export function tokenizePath(path: string): string[] {
  return tokenize(path.replace(/[/\\]/g, " "));
}

/**
 * Estimated model tokens for a rendered string.
 *
 * Deliberately the crude `chars / 4` heuristic rather than a real BPE
 * tokenizer: a tokenizer would be a heavyweight (often native) dependency, and
 * this number is only ever used to decide *when to stop appending lines*. It
 * runs slightly conservative on code (which tokenizes worse than prose), which
 * is the safe direction to be wrong in.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Multiplied-weight tokenization: emit `text`'s terms `weight` times.
 *
 * BM25 has no native notion of fields, and the standard cheap trick for field
 * weighting is repetition — a term in a symbol's *name* should count for far
 * more than the same term buried in its body. Saturation (the `k1` term) keeps
 * this from running away.
 */
export function weightedTokens(text: string, weight: number): string[] {
  const base = tokenize(text);
  if (weight <= 1) return base;
  const out: string[] = [];
  for (let i = 0; i < weight; i++) out.push(...base);
  return out;
}
