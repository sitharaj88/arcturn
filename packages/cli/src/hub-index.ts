/**
 * The hub index: `https://arcturn.dev/hub/index.json`, the registry as one
 * JSON file (RFC 0002, "the file is the API").
 *
 * `arcturn search` reads it; `arcturn add <name>` and `arcturn inspect <name>`
 * resolve a bare name through it. Nothing else in the CLI touches the network
 * for the registry, and adding a package to the hub is a pull request to
 * `registry/` plus a site deploy — no CLI release.
 *
 * **The index is data, not instructions.** Everything this module returns is
 * text that came off the wire, and the invariants it holds are what keep that
 * text from acting:
 *
 * - No field is ever executed, followed, or fetched from here. `source` is
 *   *returned* to the caller as a string; the caller hands it to
 *   `resolveSource`, which re-validates it exactly as if a person had typed
 *   it. This module never clones anything.
 * - A `source` is accepted only in the `owner/repo[/subdir][@ref]` GitHub
 *   shorthand a listing is allowed to carry. The resolver would also accept
 *   a local path or an arbitrary git URL, so this is a narrower gate than the
 *   resolver's on purpose: a bare name must never be able to land on the
 *   reader's own disk or on a host of the index's choosing.
 * - A `ref` is a single git ref: no whitespace, no `/`, no `@`, no leading
 *   `-` (it becomes a `--branch=<ref>` argument downstream).
 * - The index itself is read only over https, except from a loopback host so
 *   a local `next build` can be tested. Anything else is refused before any
 *   request is made.
 * - Any deviation from the expected shape is one error, `malformed hub
 *   index`, for the whole file. A half-trusted index is worse than none.
 *
 * @packageDocumentation
 */

/** Where the index lives, unless `ARCTURN_HUB_URL` or an explicit option says otherwise. */
export const DEFAULT_HUB_URL = "https://arcturn.dev/hub/index.json";

/** Environment variable that overrides {@link DEFAULT_HUB_URL}. */
export const HUB_URL_ENV = "ARCTURN_HUB_URL";

/** How long a hub read may take before it is reported as unreachable. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * What a hub name looks like — the charset `registry/<name>.json` files are
 * named in, and the shape `arcturn add <name>` treats as a bare name rather
 * than a source. Deliberately disjoint from every source shape the resolver
 * accepts: no `/`, no `:`, no `@`, no leading `.`/`~`/`-`/`\`, so no string a
 * person could already install changes meaning.
 */
export const HUB_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A pinned tag, branch or commit as a listing may spell it. */
const HUB_REF = /^[^\s/@-][^\s/@]*$/;

/** `@ref` on the last path segment of a source, the way `splitRef` reads it. */
const REF_SUFFIX = /@([^@/]+)$/;

/** Hosts on which plain http is allowed, for reading a local site build. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `owner/repo[/subdir…]` — restated from `registry.ts` rather than imported,
 * because `registry.ts` imports this module and the two must not form a
 * cycle. `hub-index.test.ts` parses the literal out of both files and fails
 * if they differ. Kept last among this file's `$/;`-terminated literals so
 * that extraction stays unambiguous.
 */
const GITHUB_SHORTHAND =
  /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))\/([a-zA-Z0-9._-]+)((?:\/[a-zA-Z0-9._-]+)*)$/;

/** Any problem reading the hub index: unreachable, refused, or malformed. */
export class HubIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubIndexError";
  }
}

/**
 * One listed package as the CLI sees it. The four validated fields plus
 * `ref` are what the CLI acts on; anything else the hub published
 * (`maintainer`, `disclosure`) rides along untouched for `search --json`.
 */
export interface HubIndexEntry {
  readonly name: string;
  readonly kinds: readonly string[];
  /** A GitHub `owner/repo[/subdir][@ref]` shorthand — never anything else. */
  readonly source: string;
  readonly description: string;
  /** A tag, branch or commit the listing pins; installed as `source@ref`. */
  readonly ref?: string;
  readonly [extra: string]: unknown;
}

/** The document at {@link DEFAULT_HUB_URL}. */
export interface HubIndex {
  readonly v: 1;
  /** ISO-8601 time of the export that wrote the file, when it said. */
  readonly generatedAt?: string;
  readonly entries: readonly HubIndexEntry[];
}

/** What a bare name resolves to: exactly the two strings the resolver needs. */
export interface HubResolution {
  readonly source: string;
  readonly ref?: string;
}

/** `fetch`, injectable so tests never touch the network. */
export type FetchFn = typeof fetch;

/** Options for {@link fetchHubIndex}. */
export interface FetchHubIndexOptions {
  /** Defaults to the global `fetch`. */
  readonly fetchFn?: FetchFn;
  /** Defaults to `$ARCTURN_HUB_URL`, then {@link DEFAULT_HUB_URL}. */
  readonly url?: string;
  /** Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** The running CLI version, sent as `User-Agent: arcturn/<version>`. */
  readonly version: string;
}

/** Whether a source argument is a bare hub name rather than a source. */
export function isBareHubName(text: string): boolean {
  return HUB_NAME.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message !== ""
    ? `${error.message}: ${cause.message}`
    : error.message;
}

/**
 * The URL to read, validated before anything is requested.
 *
 * An explicit option wins over the environment, which wins over the default.
 * Plain http is refused except on a loopback host: the index decides what a
 * bare name installs, and a downgrade on the way to it is a listing anyone
 * on the path could rewrite.
 */
function resolveHubUrl(explicit: string | undefined): string {
  const fromEnv = process.env[HUB_URL_ENV];
  const raw = explicit ?? (fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : undefined);
  const url = raw ?? DEFAULT_HUB_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HubIndexError(`invalid hub URL "${url}"`);
  }
  if (parsed.protocol === "https:") return url;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return url;
  throw new HubIndexError(
    `refusing to read the hub index from "${url}": it must be https ` +
      "(plain http is allowed only on localhost)",
  );
}

function malformed(detail: string): HubIndexError {
  return new HubIndexError(`malformed hub index: ${detail}`);
}

/** One entry, validated; throws {@link HubIndexError} on any deviation. */
function parseEntry(raw: unknown, i: number): HubIndexEntry {
  const at = `entries[${i}]`;
  if (!isRecord(raw)) throw malformed(`${at} is not an object`);

  const name = raw.name;
  if (typeof name !== "string" || !HUB_NAME.test(name)) {
    throw malformed(`${at}.name is not a hub name`);
  }

  const kinds = raw.kinds;
  if (!Array.isArray(kinds) || !kinds.every((kind) => typeof kind === "string")) {
    throw malformed(`${at}.kinds is not an array of strings`);
  }

  const source = raw.source;
  if (typeof source !== "string" || !GITHUB_SHORTHAND.test(source.replace(REF_SUFFIX, ""))) {
    throw malformed(`${at}.source is not an owner/repo[/subdir][@ref] shorthand`);
  }
  for (const segment of source.replace(REF_SUFFIX, "").split("/")) {
    if (segment === "." || segment === "..") {
      throw malformed(`${at}.source contains a "${segment}" segment`);
    }
  }

  const description = raw.description;
  if (typeof description !== "string") throw malformed(`${at}.description is not a string`);

  const ref = raw.ref;
  if (ref !== undefined) {
    if (typeof ref !== "string" || !HUB_REF.test(ref)) {
      throw malformed(`${at}.ref is not a git ref`);
    }
    if (REF_SUFFIX.test(source)) throw malformed(`${at} is pinned twice (ref and source@ref)`);
  }

  // Spread first so the validated fields win over whatever the raw object
  // carried under the same keys; `ref` stays absent when it was absent.
  return { ...raw, name, kinds: [...(kinds as string[])], source, description };
}

/** The whole document, validated. Exported for the shell tests; not a public API. */
export function parseHubIndex(json: unknown): HubIndex {
  if (!isRecord(json)) throw malformed("not an object");
  if (json.v !== 1) throw malformed(`unsupported version ${JSON.stringify(json.v)}`);
  if (!Array.isArray(json.entries)) throw malformed("entries is not an array");
  const entries = json.entries.map((entry, i) => parseEntry(entry, i));
  const generatedAt = json.generatedAt;
  return {
    v: 1,
    ...(typeof generatedAt === "string" ? { generatedAt } : {}),
    entries,
  };
}

/**
 * GET the hub index and validate it.
 *
 * One request, no body, two headers: `User-Agent: arcturn/<version>` so the
 * site's logs can tell CLI reads from browsers, and `Accept:
 * application/json`. A non-2xx status, a timeout, a network failure and a
 * malformed body are each a {@link HubIndexError} whose message says which.
 *
 * @param options - See {@link FetchHubIndexOptions}.
 */
export async function fetchHubIndex(options: FetchHubIndexOptions): Promise<HubIndex> {
  const url = resolveHubUrl(options.url);
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  try {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers: { "User-Agent": `arcturn/${options.version}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HubIndexError(`timed out after ${timeoutMs}ms reading ${url}`);
      }
      throw new HubIndexError(`could not reach ${url}: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      const status = response.statusText
        ? `${response.status} ${response.statusText}`
        : `${response.status}`;
      throw new HubIndexError(`hub responded ${status} for ${url}`);
    }
    try {
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HubIndexError(`timed out after ${timeoutMs}ms reading ${url}`);
      }
      throw new HubIndexError(`could not read ${url}: ${errorMessage(error)}`);
    }
  } finally {
    clearTimeout(timer);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw malformed("not JSON");
  }
  return parseHubIndex(json);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Case-insensitive substring search over name, kinds and description.
 *
 * With no query (or a blank one) every entry comes back in name order. With
 * one, a name hit outranks a kind hit, which outranks a description hit —
 * exact name first, then a name prefix, then a name substring — and ties
 * keep name order. Ranking is by where the query was found, never by how
 * an entry describes itself.
 *
 * @param index - A validated index.
 * @param query - What the user typed after `arcturn search`, if anything.
 */
export function searchHub(index: HubIndex, query?: string): HubIndexEntry[] {
  const q = (query ?? "").trim().toLowerCase();
  if (q === "") return [...index.entries].sort(byName);
  const ranked: { rank: number; entry: HubIndexEntry }[] = [];
  for (const entry of index.entries) {
    const name = entry.name.toLowerCase();
    let rank: number;
    if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else if (entry.kinds.some((kind) => kind.toLowerCase().includes(q))) rank = 3;
    else if (entry.description.toLowerCase().includes(q)) rank = 4;
    else continue;
    ranked.push({ rank, entry });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || byName(a.entry, b.entry))
    .map((item) => item.entry);
}

/**
 * What a bare name installs: the listing's `source`, and its `ref` when it
 * pins one. An exact, case-sensitive match on `name` — a bare name is an
 * identifier, and "close enough" is how a typo installs the wrong package.
 * Returns `undefined` for a name the hub does not list.
 *
 * Only ever *returns* the source; following it is the caller's business,
 * and the caller is the same resolver that handles what a person types.
 */
export function resolveHubName(index: HubIndex, name: string): HubResolution | undefined {
  const entry = index.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) return undefined;
  return entry.ref === undefined
    ? { source: entry.source }
    : { source: entry.source, ref: entry.ref };
}

/** Length of the prefix two strings share. */
function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** How much of a name must agree before a typo is worth pointing at. */
const SUGGEST_MIN_PREFIX = 4;

/**
 * Up to `limit` listed names that resemble a name the hub does not have:
 * names the input is a prefix of, then names containing it, then names the
 * input itself contains (a typo'd suffix), then names sharing at least
 * {@link SUGGEST_MIN_PREFIX} leading characters with it (a typo near the
 * end), longest agreement first. Plain string matching — enough to point at
 * the entry someone almost typed, and never used to install.
 */
export function suggestHubNames(index: HubIndex, name: string, limit = 5): string[] {
  const q = name.trim().toLowerCase();
  if (q === "") return [];
  const names = [...index.entries].sort(byName).map((entry) => entry.name);
  const seen = new Set<string>();
  const out: string[] = [];
  const take = (candidates: readonly string[], predicate: (candidate: string) => boolean) => {
    for (const candidate of candidates) {
      if (out.length >= limit) return;
      if (seen.has(candidate) || !predicate(candidate.toLowerCase())) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  };
  take(names, (candidate) => candidate.startsWith(q));
  take(names, (candidate) => candidate.includes(q));
  take(names, (candidate) => candidate.length >= 3 && q.includes(candidate));
  const byAgreement = [...names].sort(
    (a, b) =>
      sharedPrefix(b.toLowerCase(), q) - sharedPrefix(a.toLowerCase(), q) ||
      byName({ name: a }, { name: b }),
  );
  take(byAgreement, (candidate) => sharedPrefix(candidate, q) >= SUGGEST_MIN_PREFIX);
  return out;
}
