/**
 * The one-page HTTP server that hands out the browser client.
 *
 * `ArcturnServer` (`@arcturn/server`) owns its own port and speaks only
 * WebSocket, so the page cannot be served from it without changing that
 * package. This module therefore binds a second, deliberately tiny listener
 * whose entire vocabulary is "GET / → the page".
 *
 * ## What this server does and does not hold
 *
 * It serves exactly one static document and **never** the shared token: the
 * page is unauthenticated because it is inert on its own, and a page that
 * handed out the credential would turn "can reach this port" into "can run
 * commands as this user". The token reaches the browser only from the person
 * opening it — as a URL fragment (never sent to any server) or typed into the
 * page's prompt — and the WebSocket handshake is what actually authenticates.
 *
 * The response carries a strict Content-Security-Policy: no external origin is
 * reachable at all, the inline style and scripts are nonce-pinned, and
 * `connect-src` is narrowed to WebSocket URLs on the very host the page was
 * loaded from. `form-action 'none'` matters more than it looks — it stops the
 * token form from ever falling back to a real submission (which would put the
 * token in a URL) if scripting fails.
 *
 * Browsers send `Origin` on a WebSocket upgrade and `ArcturnServer` rejects any
 * origin it was not told about, so `runServe` passes it {@link webClientOrigins}.
 *
 * @packageDocumentation
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { renderWebClientPage } from "./page.js";

/** Bind addresses meaning "every interface". */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "[::]"]);

/** Options for {@link startWebClientServer}. */
export interface WebClientServerOptions {
  /** Interface to bind. Defaults to `"127.0.0.1"`. */
  readonly host?: string;
  /** Port to bind, or `0`/omitted for an OS-assigned ephemeral port. */
  readonly port?: number;
  /**
   * The port `arcturn serve`'s WebSocket listener ended up on. A function, because
   * the socket binds *after* this server does (its allowed-origins list needs
   * this server's port first), and the page is rendered per request anyway.
   */
  readonly wsPort: () => number;
}

/** A running browser-client server. */
export interface WebClientServer {
  /** Interface actually bound. */
  readonly host: string;
  /** Port actually bound. */
  readonly port: number;
  /** `http://host:port` — where to open the client. */
  readonly url: string;
  /** Close every connection and stop listening. */
  stop(): Promise<void>;
}

/** Render an `http://` URL, bracketing a literal IPv6 host. */
export function formatWebUrl(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}

/**
 * The browser origins that must be allowed to open the WebSocket for the page
 * to work.
 *
 * A browser stamps `Origin: http://<whatever the user typed>:<web port>` on
 * the upgrade, and `ArcturnServer` refuses origins it was not given, so this
 * enumerates the addresses a user plausibly typed: loopback names always, the
 * bound address when it is a concrete one, and every non-internal IPv4
 * interface when the bind is a wildcard (the "open it from my phone" case).
 * A hostname that is not an address of this machine — a tunnel, an mDNS name,
 * a reverse proxy — cannot be guessed and must be passed in `extra`.
 *
 * @param host - The interface the page server is bound to.
 * @param port - The port the page server is bound to.
 * @param extra - Additional origins, e.g. from a `--web-origin` flag.
 * @returns Deduplicated origin strings, ready for `ArcturnServer`.
 */
export function webClientOrigins(
  host: string,
  port: number,
  extra: readonly string[] = [],
): string[] {
  const origins = [
    formatWebUrl("127.0.0.1", port),
    formatWebUrl("localhost", port),
    formatWebUrl("::1", port),
  ];
  if (WILDCARD_HOSTS.has(host)) {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal || entry.family !== "IPv4") continue;
        origins.push(formatWebUrl(entry.address, port));
      }
    }
  } else {
    origins.push(formatWebUrl(host, port));
  }
  for (const origin of extra) {
    const trimmed = origin.trim().replace(/\/$/, "");
    if (trimmed !== "") origins.push(trimmed);
  }
  return [...new Set(origins)];
}

/**
 * The hostname the client used to reach this server, for `connect-src`.
 *
 * Taken from the `Host` header so the policy follows the user onto a LAN
 * address or a tunnel name; falls back to the bound host when the header is
 * missing or contains anything outside the hostname character set.
 */
function requestHostname(request: IncomingMessage, fallback: string): string {
  const raw = request.headers.host;
  if (typeof raw !== "string" || raw === "") return fallback;
  const closing = raw.startsWith("[") ? raw.indexOf("]") : -1;
  const hostname = closing >= 0 ? raw.slice(0, closing + 1) : (raw.split(":")[0] ?? "");
  if (hostname === "" || !/^[A-Za-z0-9._\-[\]:]+$/.test(hostname)) return fallback;
  return hostname;
}

/**
 * Build the page's Content-Security-Policy.
 *
 * @param nonce - Per-response nonce pinning the inline style and scripts.
 * @param hostname - Host the page was requested from; the only host the page
 *   is allowed to open a WebSocket to.
 */
export function contentSecurityPolicy(nonce: string, hostname: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src data:",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ws://${hostname}:* wss://${hostname}:*`,
  ].join("; ");
}

/**
 * Bind the browser-client server.
 *
 * @param options - Interface, port and a resolver for the WebSocket port.
 * @returns The running server, including the port actually bound.
 *
 * @example
 * ```ts
 * const web = await startWebClientServer({ host: "127.0.0.1", wsPort: () => port });
 * console.log(`open ${web.url}`);
 * ```
 */
export async function startWebClientServer(
  options: WebClientServerOptions,
): Promise<WebClientServer> {
  const host = options.host ?? "127.0.0.1";
  const server: Server = createServer((request, response) => {
    handle(request, response, host, options.wsPort);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, host);
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    server.close();
    throw new Error("Expected a network address after binding the web client server");
  }
  const port = address.port;

  let stopped = false;
  return {
    host,
    port,
    url: formatWebUrl(host, port),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** Answer one request: the page, a 404, or a 405. */
function handle(
  request: IncomingMessage,
  response: ServerResponse,
  host: string,
  wsPort: () => number,
): void {
  request.resume();
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed\n");
    return;
  }
  const path = (request.url ?? "/").split("?")[0];
  if (path !== "/" && path !== "/index.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  const nonce = randomBytes(16).toString("base64");
  const html = renderWebClientPage({ wsPort: wsPort(), nonce });
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "content-security-policy": contentSecurityPolicy(nonce, requestHostname(request, host)),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    // The page never needs any of these; denying them outright means a
    // future markup mistake (or a bug in a browser's CSP handling) can't
    // turn "reachable" into "can prompt for camera/mic/location access".
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  response.end(html);
}
