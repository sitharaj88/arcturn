/**
 * Credential-file shapes that must never come back out of a workspace query.
 *
 * WHY this lives here rather than in the indexer's ignore list. The code index
 * is built once and shared: `~/.arcturn/index/<hash(root)>` is written by
 * whatever ran first — usually an interactive session, whose walker has its own
 * ignore rules and whose consumer is the human who owns the files. Teaching the
 * walker to skip `.env` would only protect indexes built *after* that change,
 * and would not protect a store an older arcturn already filled. A server
 * handing results to a process it did not write cannot rely on that: it has to
 * filter at the point of *disclosure*, against whatever the store happens to
 * contain.
 *
 * The list is deliberately file-*shaped* rather than name-shaped. `secrets.ts`
 * is ordinary source and stays searchable; `.env`, a private key and an
 * `.ssh/` path are not, whatever they are called inside.
 *
 * WHY the shapes are matched by token rather than by whole path segment. The
 * first version of this list anchored every pattern to a segment boundary
 * (`(^|/)\.env(\.|$)`), which is right for the dotfile spelling and wrong for
 * the spellings that live in the same repositories and hold the same bytes:
 * `config/production.env`, `env/production.env`, `.env-production`,
 * `.envrc.local`, `private.pem.bak`. Those are not exotic — they are what a
 * config directory, a direnv layout and `cp` produce — and every one of them
 * matched nothing. A file the index cannot parse becomes a single whole-file
 * chunk, so "not recognised" meant the peer could ask for `detail: "snippets"`
 * and be handed the body. So the anchors now bind the *token*: a `.env` token
 * that ends a name or is followed by a separator, a key extension that may
 * carry a known backup suffix, a credential basename that may carry a data
 * extension. What stays out is as load-bearing as what comes in: `src/env.ts`,
 * `docs/environment.md` and `src/api.key.ts` have no credential token in them
 * and remain searchable.
 *
 * A false positive costs one searchable file. It is not silent: `server.ts`
 * prints, on every single query, that credential-shaped paths are filtered —
 * deliberately without a per-query count, because a count that moves with the
 * query is itself an answer to "is this string in your credentials file?".
 */

/**
 * Trailing suffixes a backup, editor or rotation step leaves beside a file.
 *
 * WHY they belong in the shape: `cp private.pem private.pem.bak` produces a
 * file with the same bytes and a name that an extension anchored to the end of
 * the path no longer matches. The set is closed on purpose — an unrecognised
 * trailing extension (`src/api.key.ts`) is source code named after a key, not a
 * key, and must stay searchable.
 */
const BACKUP_SUFFIXES = String.raw`(?:\.(?:bak|old|orig|save|backup|copy|tmp|swp|\d+))*`;

/** Extensions whose file *is* a key or a key store, whatever it is called. */
const KEY_EXTENSIONS = "pem|key|p8|p12|pfx|jks|keystore|ppk|asc|gpg";

/**
 * Extensions that carry data rather than code.
 *
 * Used only to qualify a credential *basename*: `credentials.json` is a
 * credential, `src/credentials.ts` is code about credentials and stays on the
 * same side of the line as `secrets.ts`.
 */
const DATA_EXTENSIONS = "json|yaml|yml|ini|cfg|conf|txt|csv|xml|toml|properties";

/**
 * Patterns matched against a POSIX-separated, lower-cased path.
 *
 * Each one binds a credential token to a boundary — a separator, a known
 * suffix, or the end of the path — so a match is never an accident of
 * substring (`implement.pemdas` is not a key) and never misses a real spelling
 * because it sits at the wrong end of the name (`production.env` is one).
 */
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  // dotenv and direnv in every spelling that holds the same bytes: the dotfile
  // (`.env`, `apps/web/.env.production`), the suffix form a config directory
  // uses instead (`config/production.env`), and the hyphen/underscore variants
  // (`.env-production`, `.envrc.local`). The required dot before `env` is what
  // keeps `src/env.ts` and `docs/environment.md` searchable.
  /\.env(rc)?($|[.\-_/])/,
  // Private keys and key stores, by extension, including a rotated or
  // backed-up copy of one.
  new RegExp(String.raw`\.(${KEY_EXTENSIONS})${BACKUP_SUFFIXES}$`),
  // Conventional SSH key basenames, with or without a `.pub`-style suffix.
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/,
  // Tool credential files that hold bearer tokens verbatim, and the per-project
  // copies people keep beside them (`.npmrc.local`, `.netrc-work`).
  /(^|\/)\.(npmrc|netrc|pgpass|htpasswd|git-credentials|dockercfg|pypirc)($|[.\-_/])/,
  /(^|\/)_netrc($|[.\-_/])/,
  // Whole credential directories, wherever they are rooted.
  /(^|\/)\.(ssh|gnupg|aws|gcloud|kube|azure)\//,
  // Cloud and CLI credential files that are not dotfiles. `credentials.json`
  // is what gcloud, a service-account export and a dozen CI recipes call the
  // file, and it is the commonest spelling of a key committed by accident.
  new RegExp(`(^|/)(credentials?|service[-_]account)(\\.(${DATA_EXTENSIONS}))?${BACKUP_SUFFIXES}$`),
  new RegExp(String.raw`(^|/)(client_secret|gha-creds-)[^/]*\.json${BACKUP_SUFFIXES}$`),
] as const;

/**
 * Whether a repository-relative path names a file whose *contents* are
 * credentials rather than code.
 *
 * @param path - Repository-relative path; either separator is accepted.
 */
export function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** A partition of `items` into what may be disclosed and how much was not. */
export interface SensitivePartition<T> {
  /** Items whose path is not credential-shaped. */
  kept: T[];
  /**
   * How many items were dropped.
   *
   * Reported to the *operator*, and to the peer only when it counts a host
   * that failed to filter — see `server.ts`, where the disclosure rules for
   * this number live.
   */
  withheld: number;
}

/**
 * Drop every item addressing a credential-shaped path.
 *
 * Generic over `{ path }` on purpose: `@arcturn/mcp` must not learn the index
 * package's hit type to be able to defend against it.
 *
 * @param items - Anything carrying a repository-relative `path`.
 */
export function withholdSensitive<T extends { readonly path: string }>(
  items: readonly T[],
): SensitivePartition<T> {
  const kept: T[] = [];
  let withheld = 0;
  for (const item of items) {
    if (isSensitivePath(item.path)) withheld++;
    else kept.push(item);
  }
  return { kept, withheld };
}
