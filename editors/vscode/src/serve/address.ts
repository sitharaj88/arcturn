/**
 * Parsing the address `arcturn serve` announces, and carrying the token to the
 * client without ever putting it on a wire or a command line the socket sees.
 *
 * `cli-main.ts`'s `runServeCommand` writes exactly this to stdout on startup:
 *
 * ```text
 * arcturn serving on ws://127.0.0.1:53145
 *   attach with: arcturn attach ws://127.0.0.1:53145 --token <secret>
 *   press Ctrl+C to stop
 * ```
 *
 * Only the first line is parsed here. The second is deliberately ignored:
 * it carries a credential, and the less code that touches it the better (it
 * is redacted rather than read — see `redact.ts`).
 *
 * The token then rides in the URL **fragment** (`ws://host:port#token=…`),
 * which is the same convention `serve.ts` uses for its browser client and for
 * the same reason: a fragment is never transmitted by the client, so the
 * string can be passed around as one value without the secret leaking into a
 * request. {@link parseConnectUrl} splits it apart again right before the
 * socket is opened — the socket only ever sees the fragment-free URL.
 */

/** The exact prefix `runServeCommand` prints the bound address behind. */
const ANNOUNCE = /^\s*arcturn serving on\s+(\S+?)\s*$/;

/**
 * Read the WebSocket address out of one line of `arcturn serve`'s stdout.
 *
 * @param line - One line, with or without a trailing carriage return.
 * @returns The `ws://…` address, or `undefined` for any other line.
 */
export function parseServeAnnouncement(line: string): string | undefined {
  const match = ANNOUNCE.exec(line.replace(/\r$/, ""));
  const url = match?.[1];
  if (url === undefined) return undefined;
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) return undefined;
  return url;
}

/**
 * Whether a socket URL points at this machine only.
 *
 * Mirrors `serve.ts`'s `isLoopbackHost` — a literal address check, never a DNS
 * lookup, so a hostname that merely *resolves* to loopback is not accepted.
 * The extension always asks for `--host 127.0.0.1`; this is the check that the
 * engine actually did what was asked before a token is sent to it.
 *
 * @param url - A `ws://` or `wss://` URL.
 */
export function isLoopbackSocketUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  if (hostname === "localhost") return true;
  // `URL` strips the brackets from a literal IPv6 host.
  if (hostname === "::1" || hostname === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Attach a token to a socket URL as a fragment.
 *
 * @param socketUrl - The address `arcturn serve` announced.
 * @param token - The shared secret, or `undefined` for an unauthenticated server.
 */
export function formatConnectUrl(socketUrl: string, token: string | undefined): string {
  if (token === undefined || token === "") return socketUrl;
  return `${socketUrl}#token=${encodeURIComponent(token)}`;
}

/** A connect URL split back into the part the socket sees and the secret. */
export interface ConnectTarget {
  /** The address to open, with no fragment on it. */
  socketUrl: string;
  /** The shared secret to hand {@link ProtocolClientOptions.token}. */
  token: string | undefined;
}

/**
 * Split a connect URL into the socket address and the token.
 *
 * @param connectUrl - A URL produced by {@link formatConnectUrl}.
 */
export function parseConnectUrl(connectUrl: string): ConnectTarget {
  const hash = connectUrl.indexOf("#");
  if (hash === -1) return { socketUrl: connectUrl, token: undefined };
  const socketUrl = connectUrl.slice(0, hash);
  const fragment = connectUrl.slice(hash + 1);
  const params = new URLSearchParams(fragment);
  const token = params.get("token");
  return { socketUrl, token: token === null || token === "" ? undefined : token };
}
