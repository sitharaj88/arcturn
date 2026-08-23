/**
 * `arcturn auth` — subscription (OAuth) sign-in for the CLI.
 *
 * Three sub-commands, all driven through {@link runAuthCommand}:
 *
 * ```bash
 * arcturn auth login anthropic      # print the URL, wait for the callback, store the tokens
 * arcturn auth logout anthropic     # forget the stored tokens
 * arcturn auth status               # who is signed in, and until when
 * ```
 *
 * No browser is ever launched: the authorization URL (PKCE) or the verification
 * URI plus user code (device flow) is printed and the user opens it themselves.
 * Nothing here ever prints a token, a refresh token, or any part of one — the
 * status listing reports presence and expiry only.
 *
 * Every dependency that touches the network, the clock or the filesystem is
 * injectable, so the whole command surface is testable headlessly.
 */

import { oauth } from "@arcturn/ai";
import type { ProviderId } from "@arcturn/types";
import type { AuthCommand } from "./args.js";
import { formatDuration } from "./format.js";
import type { ArcturnPaths, EnvMap } from "./paths.js";
import { resolveArcturnPaths } from "./paths.js";

/**
 * The caveat printed once by every `arcturn auth` invocation.
 *
 * Arcturn's OAuth client ids and endpoints were assembled offline and are not
 * verified against any provider's live documentation; when one is wrong the fix
 * is a runtime override, not a release.
 */
export const UNVERIFIED_ENDPOINTS_NOTE =
  "Note: Arcturn's OAuth endpoints and client ids are UNVERIFIED against live provider\n" +
  "documentation and may be out of date. If a sign-in fails, override the endpoint\n" +
  "with the ARCTURN_OAUTH_<PROVIDER>_{CLIENT_ID,AUTHORIZATION_ENDPOINT,TOKEN_ENDPOINT,\n" +
  "DEVICE_ENDPOINT,SCOPES} environment variables, or call configureOAuthProvider()\n" +
  "from an extension.";

/** Exit code used when the user cancels a login with Ctrl+C. */
export const CANCELLED_EXIT_CODE = 130;

/** Writes one chunk of output. Mirrors `process.stdout.write`. */
export type AuthWriter = (text: string) => void;

/** Starts a login; the seam that keeps tests off the network. */
export type BeginLoginFn = (
  provider: ProviderId,
  options: oauth.BeginLoginOptions,
) => Promise<oauth.LoginSession>;

/** Options for {@link runAuthCommand}. */
export interface RunAuthCommandOptions {
  /** The parsed command. */
  command: AuthCommand;
  /** Credential store. Defaults to a {@link oauth.FileOAuthTokenStore} under `~/.arcturn/auth`. */
  store?: oauth.OAuthTokenStore;
  /** Resolved layout, used for the default store and for messages. */
  paths?: ArcturnPaths;
  /** Working directory, when `paths` is not supplied. */
  cwd?: string;
  /** User directory root, when `paths` is not supplied. */
  home?: string;
  /** Environment used for `ARCTURN_HOME` and the `ARCTURN_OAUTH_*` overrides. */
  env?: EnvMap;
  /** Where normal output goes. Defaults to stdout. */
  stdout?: AuthWriter;
  /** Where errors go. Defaults to stderr. */
  stderr?: AuthWriter;
  /** Clock used to render expiry. Defaults to `Date.now`. */
  now?: () => number;
  /** Login driver. Defaults to `oauth.beginLogin`. */
  beginLogin?: BeginLoginFn;
  /** How long a PKCE login waits for the browser redirect. */
  timeoutMs?: number;
  /** Cancels a login in progress; `Ctrl+C` is wired to this when omitted. */
  signal?: AbortSignal;
  /** Skip the `SIGINT` handler (tests drive `signal` directly). */
  handleSigint?: boolean;
}

/** One row of `arcturn auth status`. */
export interface AuthStatusRow {
  /** Provider id, e.g. `"anthropic"`. */
  readonly provider: string;
  /** Human-readable provider name, when the provider is registered. */
  readonly displayName: string;
  /** Which grant the provider uses, when it is registered. */
  readonly flow: oauth.OAuthFlowKind | "unknown";
  /** Whether credentials are stored. */
  readonly signedIn: boolean;
  /** Absolute expiry in ms since the epoch, when the provider reported one. */
  readonly expiresAt?: number;
}

/** The credential store `arcturn` uses by default: `~/.arcturn/auth`, `0700`/`0600`. */
export function createAuthStore(paths: ArcturnPaths): oauth.OAuthTokenStore {
  return new oauth.FileOAuthTokenStore({ directory: paths.auth });
}

function resolvePaths(options: RunAuthCommandOptions): ArcturnPaths {
  if (options.paths) return options.paths;
  return resolveArcturnPaths({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

/**
 * Render an expiry as something a human reads at a glance.
 *
 * @param expiresAt - Absolute expiry in ms, or `undefined` when unknown.
 * @param now - Current time in ms.
 */
export function formatExpiry(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return "no expiry reported";
  const remaining = expiresAt - now;
  if (remaining <= 0) return `EXPIRED ${formatDuration(-remaining)} ago`;
  return `expires in ${formatDuration(remaining)}`;
}

/**
 * Collect the status of every provider that can be, or has been, signed into.
 *
 * The registered OAuth providers are unioned with whatever the store holds, so
 * a credential left behind by a provider that is no longer registered is still
 * reported rather than silently ignored.
 *
 * @param store - Credential store to inspect.
 * @returns One row per provider, sorted by id.
 */
export async function collectAuthStatus(store: oauth.OAuthTokenStore): Promise<AuthStatusRow[]> {
  const ids = new Set<string>();
  for (const provider of oauth.listOAuthProviders()) ids.add(String(provider));
  for (const provider of await store.list()) ids.add(String(provider));

  const rows: AuthStatusRow[] = [];
  for (const provider of [...ids].sort()) {
    const config = oauth.getOAuthProviderConfig(provider);
    const tokens = await store.get(provider);
    rows.push({
      provider,
      displayName: config?.displayName ?? provider,
      flow: config?.flow ?? "unknown",
      signedIn: tokens !== undefined,
      ...(tokens?.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    });
  }
  return rows;
}

/**
 * Render `arcturn auth status`.
 *
 * Only presence, provider metadata and expiry are shown: no token, no refresh
 * token and no prefix of either ever reaches this string.
 *
 * @param rows - Rows from {@link collectAuthStatus}.
 * @param directory - Where the credentials live, shown as a hint.
 * @param now - Current time in ms, used for the relative expiry.
 */
export function formatAuthStatus(
  rows: readonly AuthStatusRow[],
  directory: string,
  now: number,
): string {
  const lines = [`OAuth sign-in status (credentials in ${directory}):`, ""];
  if (rows.length === 0) {
    lines.push("  (no OAuth providers are registered)");
    return lines.join("\n");
  }
  const width = rows.reduce((max, row) => Math.max(max, row.provider.length), 0);
  for (const row of rows) {
    const state = row.signedIn ? "signed in " : "signed out";
    const detail = row.signedIn ? ` · ${formatExpiry(row.expiresAt, now)}` : "";
    lines.push(
      `  ${row.provider.padEnd(width)}  ${state}  ${row.displayName} (${row.flow})${detail}`,
    );
  }
  const signedOut = rows.filter((row) => !row.signedIn);
  if (signedOut.length > 0) {
    lines.push("", `Sign in with: arcturn auth login <provider>`);
  }
  return lines.join("\n");
}

/** Instructions shown for a pending login, before it is awaited. */
function loginInstructions(session: oauth.LoginSession): string {
  if (session.flow === "pkce") {
    return [
      `Open this URL in your browser to sign in to ${session.provider}:`,
      "",
      `  ${session.authorizationUrl}`,
      "",
      `Waiting for the redirect to ${session.redirectUri} … (Ctrl+C to cancel)`,
    ].join("\n");
  }
  const complete = session.verificationUriComplete;
  return [
    `Open this URL on any device to sign in to ${session.provider}:`,
    "",
    `  ${session.verificationUri}`,
    "",
    `and enter the code: ${session.userCode}`,
    ...(complete === undefined ? [] : ["", `Or use the pre-filled link: ${complete}`]),
    "",
    `The code expires in ${formatDuration(session.expiresIn * 1000)}. ` +
      "Waiting for approval … (Ctrl+C to cancel)",
  ].join("\n");
}

/** `arcturn auth login <provider>`. */
async function runLogin(
  provider: ProviderId,
  options: RunAuthCommandOptions,
  store: oauth.OAuthTokenStore,
  out: AuthWriter,
  err: AuthWriter,
): Promise<number> {
  const begin = options.beginLogin ?? oauth.beginLogin;
  const controller = new AbortController();
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // Ctrl+C must release the loopback port and leave no half-written credential,
  // so SIGINT aborts the flow rather than killing the process outright.
  const onSigint = (): void => controller.abort();
  const wantsSigint = options.handleSigint !== false && external === undefined;
  if (wantsSigint) process.on("SIGINT", onSigint);

  let session: oauth.LoginSession | undefined;
  try {
    session = await begin(provider, {
      store,
      signal: controller.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    out(`${loginInstructions(session)}\n\n`);
    const tokens = await session.complete();
    const expiry =
      tokens.expiresAt === undefined
        ? "no expiry reported"
        : formatExpiry(tokens.expiresAt, (options.now ?? Date.now)());
    out(`Signed in to ${provider}. Credentials stored in ${storeDirectory(store)} (${expiry}).\n`);
    return 0;
  } catch (error) {
    await session?.cancel().catch(() => undefined);
    if (controller.signal.aborted || isCancellation(error)) {
      err(`arcturn: login to ${provider} cancelled; nothing was stored.\n`);
      return CANCELLED_EXIT_CODE;
    }
    if (isTimeout(error)) {
      err(
        `arcturn: login to ${provider} timed out waiting for the provider. ` +
          "Run the command again, or check the endpoint overrides below.\n",
      );
      return 1;
    }
    err(`arcturn: login to ${provider} failed: ${describe(error)}\n`);
    return 1;
  } finally {
    if (wantsSigint) process.off("SIGINT", onSigint);
  }
}

/** `arcturn auth logout <provider>`. */
async function runLogout(
  provider: ProviderId,
  store: oauth.OAuthTokenStore,
  out: AuthWriter,
): Promise<number> {
  const removed = await oauth.logout(provider, store);
  out(
    removed
      ? `Signed out of ${provider}: stored credentials removed.\n` +
          "The grant still exists on the provider's side; remove Arcturn from your account there " +
          "to revoke it fully.\n"
      : `Nothing to do: no credentials were stored for ${provider}.\n`,
  );
  return 0;
}

/** The directory a store writes to, when it has one. */
function storeDirectory(store: oauth.OAuthTokenStore): string {
  return store instanceof oauth.FileOAuthTokenStore ? store.directory : "the configured store";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(error: unknown): boolean {
  if (error instanceof oauth.OAuthError) return error.code === "arcturn_cancelled";
  return error instanceof Error && error.name === "AbortError";
}

function isTimeout(error: unknown): boolean {
  return error instanceof oauth.OAuthError && error.code === "arcturn_timeout";
}

/**
 * Execute a parsed `arcturn auth` command.
 *
 * Applies the `ARCTURN_OAUTH_*` environment overrides first, so a corrected
 * endpoint takes effect without a code change, then dispatches. The unverified
 * -endpoints caveat is printed exactly once per invocation, after the command's
 * own output.
 *
 * @param options - The command plus its injectable dependencies.
 * @returns The process exit code: `0` on success, `1` on failure,
 *   {@link CANCELLED_EXIT_CODE} when the user cancelled a login.
 */
export async function runAuthCommand(options: RunAuthCommandOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = options.stderr ?? ((text: string) => void process.stderr.write(text));
  const paths = resolvePaths(options);
  const store = options.store ?? createAuthStore(paths);

  oauth.applyOAuthEnvOverrides(options.env ?? process.env);

  let code: number;
  try {
    switch (options.command.action) {
      case "status": {
        const rows = await collectAuthStatus(store);
        out(`${formatAuthStatus(rows, storeDirectory(store), (options.now ?? Date.now)())}\n`);
        code = 0;
        break;
      }
      case "login":
        code = await runLogin(requireProvider(options.command), options, store, out, err);
        break;
      case "logout":
        code = await runLogout(requireProvider(options.command), store, out);
        break;
    }
  } catch (error) {
    err(`arcturn: ${describe(error)}\n`);
    code = 1;
  }

  out(`\n${UNVERIFIED_ENDPOINTS_NOTE}\n`);
  return code;
}

/**
 * The provider a `login`/`logout` command names.
 *
 * @throws When the parser let a provider-less command through, which it does
 *   not; this only keeps the type narrowing honest.
 */
function requireProvider(command: AuthCommand): ProviderId {
  if (command.provider === undefined) {
    throw new Error(`auth ${command.action} needs a provider`);
  }
  return command.provider;
}
