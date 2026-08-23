/**
 * OAuth for remote MCP servers — the parts that need a filesystem and a user.
 *
 * `@arcturn/mcp` owns the SDK-facing provider and knows nothing about disks or
 * browsers; this module supplies both halves it leaves open:
 *
 * - **Storage.** One `0600` JSON file per server, `mcp-<server>.json`, inside
 *   the `0700` `~/.arcturn/auth` directory — the same discipline the provider
 *   OAuth store already uses, written through a temp file and renamed so a
 *   crash never leaves a half-written credential. Those mode bits are POSIX:
 *   on Windows `mkdir`'s mode is ignored and `chmod` only toggles the
 *   read-only attribute, so there the credential is protected by the ACL on
 *   the user's profile directory instead. The modes are still requested
 *   unconditionally, because they are what protects the file everywhere else.
 * - **Interaction.** A one-shot loopback listener on `127.0.0.1` with an
 *   ephemeral port, the authorization URL printed to the terminal, and a
 *   best-effort attempt to open the user's browser.
 *
 * Nothing here writes a token, a refresh token or a code verifier to stdout,
 * and the authorization URL is printed only by the interactive flow the user
 * explicitly started — never into a warning, a status line or a log.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { oauth } from "@arcturn/ai";
import type {
  McpAuthorizationHandler,
  McpAuthProviderFactory,
  McpOAuthCredentials,
  McpOAuthStorage,
} from "@arcturn/mcp";
import type { McpServerConfig } from "@arcturn/types";
import type { ArcturnPaths } from "./paths.js";

/** Directory mode: owner-only. Credentials must not be world- or group-readable. */
export const MCP_AUTH_DIR_MODE = 0o700;

/** File mode: owner read/write only. */
export const MCP_AUTH_FILE_MODE = 0o600;

/** How long `arcturn mcp auth` waits for the browser redirect. */
export const DEFAULT_MCP_AUTH_TIMEOUT_MS = 300_000;

/** How long a mid-startup authorization may block a session. Deliberately shorter. */
export const CONNECT_MCP_AUTH_TIMEOUT_MS = 120_000;

/**
 * File name holding one server's credentials.
 *
 * The `mcp-` prefix keeps the namespace disjoint from the provider credential
 * files that share the directory, and anything outside `[A-Za-z0-9._-]` is
 * escaped so a hostile server name cannot traverse out of it. The name is also
 * stored inside the file and verified on read, so two names escaping to the
 * same file cannot be confused for each other.
 */
export function mcpAuthFileName(server: string): string {
  const safe = server.replace(/[^A-Za-z0-9._-]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `_${code.toString(16)}`;
  });
  return `mcp-${safe || "_"}.json`;
}

/** Absolute path of the credential file for one server. */
export function mcpAuthPath(authDirectory: string, server: string): string {
  return join(authDirectory, mcpAuthFileName(server));
}

/** On-disk envelope. Versioned so the format can change without silent misreads. */
interface StoredMcpAuthRecord extends McpOAuthCredentials {
  version: 1;
  server: string;
  /** When the record was last written; diagnostics only. */
  updatedAt?: number;
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

/**
 * Credentials for one OAuth-protected MCP server, persisted as a `0600` file.
 *
 * Reads always hit the filesystem, so a token another arcturn process
 * refreshed is picked up immediately.
 */
export class FileMcpOAuthStorage implements McpOAuthStorage {
  /** Directory holding the credential file. */
  readonly directory: string;
  /** Configured server name these credentials belong to. */
  readonly server: string;

  constructor(directory: string, server: string) {
    this.directory = directory;
    this.server = server;
  }

  /** Full path of the backing file. Exposed for diagnostics and `mcp logout`. */
  get path(): string {
    return mcpAuthPath(this.directory, this.server);
  }

  async load(): Promise<McpOAuthCredentials | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt file is treated as "not authorized" rather than a hard
      // failure: the user recovers by running `arcturn mcp auth` again.
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Partial<StoredMcpAuthRecord>;
    if (record.version !== 1 || record.server !== this.server) return undefined;
    const credentials: McpOAuthCredentials = {};
    if (record.tokens !== undefined) credentials.tokens = record.tokens;
    if (record.clientInformation !== undefined) {
      credentials.clientInformation = record.clientInformation;
    }
    if (record.codeVerifier !== undefined) credentials.codeVerifier = record.codeVerifier;
    return credentials;
  }

  async save(credentials: McpOAuthCredentials): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: MCP_AUTH_DIR_MODE });
    // `mkdir`'s mode is masked by umask, and the directory may pre-date this
    // release with looser permissions, so tighten it unconditionally.
    await chmod(this.directory, MCP_AUTH_DIR_MODE).catch(() => undefined);

    const record: StoredMcpAuthRecord = {
      version: 1,
      server: this.server,
      ...credentials,
      updatedAt: Date.now(),
    };
    const target = this.path;
    // A unique temp name keeps two concurrent writers from corrupting each other.
    const temp = `${target}.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: MCP_AUTH_FILE_MODE,
      });
      // `writeFile`'s mode is subject to umask and ignored when the file
      // exists, so the mode is asserted before the file becomes visible.
      await chmod(temp, MCP_AUTH_FILE_MODE);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<boolean> {
    try {
      await stat(this.path);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    await rm(this.path, { force: true });
    return true;
  }
}

/**
 * Best-effort browser launch.
 *
 * The URL is printed by the caller first, so a failure here is never fatal:
 * the user can always paste it. The child is detached and its output is
 * discarded so a chatty opener cannot corrupt the terminal.
 */
export async function openUrlInBrowser(url: string): Promise<boolean> {
  const launch: { command: string; args: string[] } =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  try {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Options for {@link runMcpOAuthFlow}. */
export interface McpOAuthFlowOptions {
  /** Configured server name. */
  readonly serverName: string;
  /** The MCP server's URL, i.e. the OAuth protected resource. */
  readonly serverUrl: string;
  /** Where credentials are persisted. */
  readonly storage: McpOAuthStorage;
  /** Normal output. Defaults to stdout. */
  readonly stdout?: (text: string) => void;
  /** Browser launcher. Defaults to {@link openUrlInBrowser}; `false` disables it. */
  readonly open?: ((url: string) => Promise<boolean> | boolean) | false;
  /** How long to wait for the redirect. Defaults to five minutes. */
  readonly timeoutMs?: number;
  /** Cancels the wait. */
  readonly signal?: AbortSignal;
}

/**
 * Run the OAuth 2.1 authorization-code flow for one MCP server.
 *
 * The loopback listener is bound *before* the authorization URL is built, so
 * the redirect URI carries the real ephemeral port and the `state` the listener
 * will demand back. PKCE, discovery, dynamic client registration and the token
 * exchange are all the SDK's; this function only sequences them around the
 * listener and the user.
 *
 * @throws When the authorization is denied, times out, is cancelled, or the
 *   callback's `state` does not match the one we issued.
 */
export async function runMcpOAuthFlow(options: McpOAuthFlowOptions): Promise<void> {
  const out = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const [{ auth }, { McpOAuthProvider }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/auth.js"),
    import("@arcturn/mcp"),
  ]);

  const state = oauth.createStateToken();
  const listener = await oauth.startLoopbackServer({
    state,
    timeoutMs: options.timeoutMs ?? DEFAULT_MCP_AUTH_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  try {
    const provider = new McpOAuthProvider({
      serverName: options.serverName,
      storage: options.storage,
      redirectUrl: listener.redirectUri,
      state,
      clientName: "Arcturn",
      prompt: async (authorizationUrl: URL) => {
        const href = authorizationUrl.toString();
        out(
          `Authorize arcturn to use the MCP server "${options.serverName}":\n\n  ${href}\n\n` +
            `Waiting for the redirect to ${listener.redirectUri} … (Ctrl+C to cancel)\n`,
        );
        if (options.open !== false) {
          const opener = options.open ?? openUrlInBrowser;
          await opener(href);
        }
      },
    });

    const first = await auth(provider, { serverUrl: options.serverUrl });
    if (first === "AUTHORIZED") {
      out(`"${options.serverName}" is authorized (existing credentials were refreshed).\n`);
      return;
    }

    const callback = await listener.waitForCallback();
    const result = await auth(provider, {
      serverUrl: options.serverUrl,
      authorizationCode: callback.code,
    });
    if (result !== "AUTHORIZED") {
      throw new Error("the authorization server did not return tokens");
    }
    out(`Authorized "${options.serverName}".\n`);
  } finally {
    await listener.close();
  }
}

/** Options for {@link createMcpAuthProviderFactory}. */
export interface McpAuthProviderFactoryOptions {
  /** Resolved layout; only `auth` is used. */
  readonly paths: ArcturnPaths;
}

/**
 * Build the per-server provider factory the manager passes to its transports.
 *
 * The providers made here are deliberately *non-interactive*: they load and
 * refresh stored credentials, and a flow that would need the user throws
 * `McpAuthRequiredError` ("run arcturn mcp auth <name>"). Interactive recovery
 * is the manager's `onAuthorizationRequired` handler, not a surprise browser
 * launch from inside a transport.
 */
export async function createMcpAuthProviderFactory(
  options: McpAuthProviderFactoryOptions,
): Promise<McpAuthProviderFactory> {
  const { McpOAuthProvider } = await import("@arcturn/mcp");
  return (serverName: string, config: McpServerConfig) => {
    if (config.type !== "http" || config.auth !== "oauth") return undefined;
    return new McpOAuthProvider({
      serverName,
      storage: new FileMcpOAuthStorage(options.paths.auth, serverName),
      clientName: "Arcturn",
    });
  };
}

/** Options for {@link createMcpAuthorizationHandler}. */
export interface McpAuthorizationHandlerOptions {
  /** Resolved layout; only `auth` is used. */
  readonly paths: ArcturnPaths;
  /** Normal output. Defaults to stderr, so it never pollutes `--print` stdout. */
  readonly stdout?: (text: string) => void;
  /** How long the mid-startup flow may block. Defaults to two minutes. */
  readonly timeoutMs?: number;
}

/**
 * Handler that runs the browser flow once when a server answers 401 during
 * startup, so the connection can be retried.
 *
 * Only wire this up for interactive sessions: `--print` must never block on a
 * browser, and gets the "run arcturn mcp auth" status instead.
 */
export function createMcpAuthorizationHandler(
  options: McpAuthorizationHandlerOptions,
): McpAuthorizationHandler {
  const out = options.stdout ?? ((text: string) => void process.stderr.write(text));
  return async (serverName: string, config: McpServerConfig) => {
    if (config.type !== "http" || config.auth !== "oauth") return false;
    try {
      await runMcpOAuthFlow({
        serverName,
        serverUrl: config.url,
        storage: new FileMcpOAuthStorage(options.paths.auth, serverName),
        stdout: out,
        timeoutMs: options.timeoutMs ?? CONNECT_MCP_AUTH_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      out(
        `arcturn: authorizing MCP server "${serverName}" failed: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return false;
    }
  };
}
