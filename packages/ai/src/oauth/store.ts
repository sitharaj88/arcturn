/**
 * Persistence for OAuth credentials.
 *
 * The store is the only place a token is written to disk. Files are created
 * `0600` inside a `0700` directory, written through a temporary file and
 * renamed into place so a crash never leaves a half-written credential.
 *
 * {@link BaseOAuthTokenStore.getValidAccessToken} adds the part every caller
 * would otherwise re-implement: expiry with a skew window, transparent refresh,
 * the optional second-stage exchange, and de-duplication so ten concurrent
 * requests trigger exactly one refresh.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@arcturn/types";
import { OAuthError } from "./errors.js";
import type { Clock, DerivedCredential, OAuthTokens } from "./types.js";
import { defaultClock } from "./types.js";

/** Refresh anything expiring within this window, so a request never races the clock. */
export const DEFAULT_EXPIRY_SKEW_MS = 60_000;

/** Directory mode: owner-only. Credentials must not be world- or group-readable. */
export const AUTH_DIR_MODE = 0o700;

/** File mode: owner read/write only. */
export const AUTH_FILE_MODE = 0o600;

/** Renews an expired stage-1 credential. Errors propagate to the caller. */
export type TokenRefresher = (
  provider: ProviderId,
  current: OAuthTokens,
) => Promise<OAuthTokens> | OAuthTokens;

/** Mints the short-lived stage-2 credential from a valid stage-1 token. */
export type SecondStageExchanger = (
  provider: ProviderId,
  current: OAuthTokens,
) => Promise<DerivedCredential> | DerivedCredential;

/** Options for {@link BaseOAuthTokenStore.getValidAccessToken}. */
export interface ValidAccessTokenOptions {
  /** Renews the stage-1 token when it is expired or inside the skew window. */
  refresh?: TokenRefresher;
  /**
   * When present, the resolved token is the *second-stage* credential and is
   * re-minted whenever it is missing or expiring.
   */
  exchange?: SecondStageExchanger;
  /** Expiry skew in ms. Defaults to {@link DEFAULT_EXPIRY_SKEW_MS}. */
  skewMs?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: Clock;
  /** Force a refresh even when the stored token still looks valid. */
  forceRefresh?: boolean;
}

/** Per-provider OAuth credential persistence. */
export interface OAuthTokenStore {
  /** The stored credentials, or `undefined` when the provider is not signed in. */
  get(provider: ProviderId): Promise<OAuthTokens | undefined>;
  /** Persist (replacing) the credentials for one provider. */
  set(provider: ProviderId, tokens: OAuthTokens): Promise<void>;
  /** Remove a provider's credentials. Resolves `false` when nothing was stored. */
  delete(provider: ProviderId): Promise<boolean>;
  /** Every provider with stored credentials, sorted. */
  list(): Promise<ProviderId[]>;
  /** A usable bearer token, refreshed and re-minted as needed. */
  getValidAccessToken(provider: ProviderId, options?: ValidAccessTokenOptions): Promise<string>;
}

/**
 * True when `expiresAt` is unknown-safe: an absent expiry never expires, and a
 * known expiry is treated as expired once it is within `skewMs` of `now`.
 */
export function isExpiring(
  expiresAt: number | undefined,
  now: number,
  skewMs: number = DEFAULT_EXPIRY_SKEW_MS,
): boolean {
  if (expiresAt === undefined) return false;
  return expiresAt - skewMs <= now;
}

/**
 * Fold a refresh response into the stored record.
 *
 * The refresh token, scopes and metadata are carried forward when the provider
 * omits them. The stage-2 credential is dropped: it was minted from the token
 * that just got replaced.
 */
export function mergeRefreshedTokens(previous: OAuthTokens, next: OAuthTokens): OAuthTokens {
  const merged: OAuthTokens = {
    accessToken: next.accessToken,
    tokenType: next.tokenType || previous.tokenType,
  };
  const refreshToken = next.refreshToken ?? previous.refreshToken;
  if (refreshToken !== undefined) merged.refreshToken = refreshToken;
  if (next.expiresAt !== undefined) merged.expiresAt = next.expiresAt;
  const scopes = next.scopes ?? previous.scopes;
  if (scopes !== undefined) merged.scopes = [...scopes];
  const metadata = next.metadata ?? previous.metadata;
  if (metadata !== undefined) merged.metadata = { ...metadata };
  return merged;
}

/**
 * Shared behaviour for every store implementation.
 *
 * Subclasses provide only the four persistence primitives; expiry handling,
 * refresh, the second-stage exchange and concurrency live here so they cannot
 * drift between the file-backed and in-memory stores.
 */
export abstract class BaseOAuthTokenStore implements OAuthTokenStore {
  /** One in-flight resolution per provider, so concurrent callers share a refresh. */
  readonly #inflight = new Map<string, Promise<string>>();

  abstract get(provider: ProviderId): Promise<OAuthTokens | undefined>;
  abstract set(provider: ProviderId, tokens: OAuthTokens): Promise<void>;
  abstract delete(provider: ProviderId): Promise<boolean>;
  abstract list(): Promise<ProviderId[]>;

  /**
   * Resolve a bearer token that is valid *now*.
   *
   * Concurrent calls for the same provider share one promise, so N parallel
   * requests hitting an expired token perform exactly one refresh. The entry is
   * released as soon as the resolution settles, so a later call refreshes again.
   *
   * @param provider - Provider id, e.g. `"anthropic"`.
   * @param options - Refresh/exchange callbacks and the skew window.
   * @returns The token to place in the `Authorization` header.
   * @throws {OAuthError} `arcturn_no_credentials` when nothing is stored,
   *   `arcturn_token_expired` when the token is expired and cannot be refreshed, or
   *   the underlying failure from `refresh`/`exchange`.
   */
  getValidAccessToken(
    provider: ProviderId,
    options: ValidAccessTokenOptions = {},
  ): Promise<string> {
    const key = String(provider);
    const existing = this.#inflight.get(key);
    if (existing) return existing;

    const pending = this.#resolveAccessToken(provider, options).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, pending);
    return pending;
  }

  async #resolveAccessToken(
    provider: ProviderId,
    options: ValidAccessTokenOptions,
  ): Promise<string> {
    const now = (options.now ?? defaultClock)();
    const skewMs = options.skewMs ?? DEFAULT_EXPIRY_SKEW_MS;

    const stored = await this.get(provider);
    if (!stored) {
      throw new OAuthError(
        "arcturn_no_credentials",
        `No OAuth credentials stored for ${provider}`,
        {
          provider: String(provider),
        },
      );
    }

    let current = stored;
    const stale = options.forceRefresh === true || isExpiring(current.expiresAt, now, skewMs);
    if (stale) {
      if (!options.refresh) {
        throw new OAuthError(
          "arcturn_token_expired",
          `The stored ${provider} access token has expired and no refresh handler was supplied`,
          { provider: String(provider) },
        );
      }
      const refreshed = await options.refresh(provider, current);
      current = mergeRefreshedTokens(current, refreshed);
      await this.set(provider, current);
    }

    if (!options.exchange) return current.accessToken;

    const derived = current.derived;
    if (derived && !isExpiring(derived.expiresAt, now, skewMs)) return derived.accessToken;

    const minted = await options.exchange(provider, current);
    current = { ...current, derived: minted };
    await this.set(provider, current);
    return minted.accessToken;
  }
}

/**
 * A store that keeps credentials in process memory only.
 *
 * The default for tests, and a reasonable choice for short-lived processes that
 * should not leave a credential on disk.
 */
export class MemoryOAuthTokenStore extends BaseOAuthTokenStore {
  readonly #records = new Map<string, OAuthTokens>();

  /** @param initial - Seed credentials, keyed by provider id. */
  constructor(initial?: Readonly<Record<string, OAuthTokens>>) {
    super();
    for (const [provider, tokens] of Object.entries(initial ?? {})) {
      this.#records.set(provider, structuredClone(tokens));
    }
  }

  override get(provider: ProviderId): Promise<OAuthTokens | undefined> {
    const found = this.#records.get(String(provider));
    return Promise.resolve(found ? structuredClone(found) : undefined);
  }

  override set(provider: ProviderId, tokens: OAuthTokens): Promise<void> {
    this.#records.set(String(provider), structuredClone(tokens));
    return Promise.resolve();
  }

  override delete(provider: ProviderId): Promise<boolean> {
    return Promise.resolve(this.#records.delete(String(provider)));
  }

  override list(): Promise<ProviderId[]> {
    return Promise.resolve([...this.#records.keys()].sort());
  }
}

/** Options for {@link FileOAuthTokenStore}. */
export interface FileOAuthTokenStoreOptions {
  /** Directory holding one JSON file per provider. Defaults to `~/.arcturn/auth`. */
  directory?: string;
  /** Environment consulted for `ARCTURN_AUTH_DIR`/`HOME`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** On-disk envelope. Versioned so the format can change without silent misreads. */
interface StoredRecord {
  version: 1;
  provider: string;
  tokens: OAuthTokens;
  /** When the record was last written; diagnostics only. */
  updatedAt?: number;
}

function processEnv(): Record<string, string | undefined> {
  const globalProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return globalProcess?.env ?? {};
}

/**
 * The default credential directory: `$ARCTURN_AUTH_DIR`, else `~/.arcturn/auth`.
 *
 * @param env - Environment to read. Defaults to `process.env`.
 */
export function defaultAuthDirectory(
  env: Record<string, string | undefined> = processEnv(),
): string {
  const override = env.ARCTURN_AUTH_DIR;
  if (override && override !== "") return override;
  return join(
    env.ARCTURN_HOME && env.ARCTURN_HOME !== "" ? env.ARCTURN_HOME : homedir(),
    ".arcturn",
    "auth",
  );
}

/**
 * Map a provider id onto a safe file name.
 *
 * Anything outside `[A-Za-z0-9._-]` is escaped, so a hostile provider id cannot
 * traverse out of the auth directory. The id is also stored inside the file and
 * verified on read, so two ids escaping to the same name cannot be confused.
 */
export function providerFileName(provider: ProviderId): string {
  const safe = String(provider).replace(/[^A-Za-z0-9._-]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `_${code.toString(16)}`;
  });
  return `${safe || "_"}.json`;
}

function isOAuthTokens(value: unknown): value is OAuthTokens {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.accessToken === "string" && typeof record.tokenType === "string";
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 && typeof record.provider === "string" && isOAuthTokens(record.tokens)
  );
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

/**
 * Credentials persisted as one JSON file per provider under a `0700` directory.
 *
 * Reads always hit the filesystem so a token refreshed by another Arcturn process
 * is picked up immediately.
 */
export class FileOAuthTokenStore extends BaseOAuthTokenStore {
  /** Absolute path of the directory holding the credential files. */
  readonly directory: string;

  constructor(options: FileOAuthTokenStoreOptions = {}) {
    super();
    this.directory = options.directory ?? defaultAuthDirectory(options.env ?? processEnv());
  }

  /** Full path of the file backing one provider. Exposed for diagnostics. */
  pathFor(provider: ProviderId): string {
    return join(this.directory, providerFileName(provider));
  }

  override async get(provider: ProviderId): Promise<OAuthTokens | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(provider), "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt file is treated as "not signed in" rather than a hard failure:
      // the user can recover by logging in again.
      return undefined;
    }
    if (!isStoredRecord(parsed) || parsed.provider !== String(provider)) return undefined;
    return parsed.tokens;
  }

  override async set(provider: ProviderId, tokens: OAuthTokens): Promise<void> {
    await this.#ensureDirectory();
    const record: StoredRecord = {
      version: 1,
      provider: String(provider),
      tokens,
      updatedAt: Date.now(),
    };
    const target = this.pathFor(provider);
    // A unique temp name keeps two concurrent writers from corrupting each other.
    const temp = `${target}.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: AUTH_FILE_MODE,
      });
      // `writeFile`'s mode is subject to umask and ignored when the file exists,
      // so the mode is asserted explicitly before the file becomes visible.
      await chmod(temp, AUTH_FILE_MODE);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  override async delete(provider: ProviderId): Promise<boolean> {
    const target = this.pathFor(provider);
    try {
      await stat(target);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    await rm(target, { force: true });
    return true;
  }

  override async list(): Promise<ProviderId[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const providers: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = await readFile(join(this.directory, entry), "utf8");
      } catch {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isStoredRecord(parsed)) providers.push(parsed.provider);
      } catch {
        // Skip files that are not ours.
      }
    }
    return providers.sort();
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: AUTH_DIR_MODE });
    // `mkdir`'s mode is masked by umask, and the directory may pre-date this
    // release with looser permissions, so tighten it unconditionally.
    await chmod(this.directory, AUTH_DIR_MODE).catch(() => undefined);
  }
}
