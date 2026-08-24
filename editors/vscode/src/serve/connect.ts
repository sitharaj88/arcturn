/**
 * Opening a {@link ProtocolClient} against a running `arcturn serve`.
 *
 * The socket is injected (`socketFactory`) for the same reason
 * `@arcturn/protocol` injects it: a real `ws` `WebSocket` satisfies
 * {@link WebSocketLike} structurally, and so does an in-memory fake, so the
 * whole connect path is testable without a port.
 *
 * Two safety rules live here rather than at the call site:
 *
 * - the token is split out of the URL fragment at the last possible moment,
 *   and the socket is opened against the fragment-free address;
 * - a non-loopback address is refused *before* the token is handed to it,
 *   even though `buildServeArgs` asked for `127.0.0.1` — the check is on what
 *   the engine actually announced, not on what it was asked for.
 */

import { isLoopbackSocketUrl, parseConnectUrl } from "./address.js";
import { createProtocolClient, type ProtocolClient, type WebSocketLike } from "./engine.js";
import { createRedactor } from "./redact.js";

/** Constructs a socket for `url`. In production, `new WebSocket(url)` from `ws`. */
export type SocketFactory = (url: string) => WebSocketLike;

/** Options for {@link connectToServe}. */
export interface ConnectOptions {
  /** `ws://host:port#token=…`, as produced by the supervisor. */
  connectUrl: string;
  /** How to construct the transport. */
  socketFactory: SocketFactory;
  /**
   * Per-request deadline. Defaults to `0` — **disabled** — which is what an
   * interactive caller needs and what `arcturn attach` already does.
   *
   * `ProtocolClient.prompt` resolves when the *run* ends, not when the server
   * accepts the prompt (`ws-server.ts` awaits `SessionHost.prompt`, which
   * awaits the agent). Under the client's 30s default, every run longer than
   * half a minute would reject with a timeout while it was still going
   * perfectly well. The acknowledgement the UI actually uses is the inbound
   * `runStart` event.
   *
   * A closed or errored socket still rejects every in-flight request, so
   * disabling the deadline does not leave a promise dangling when the engine
   * dies — only a live server that answers nothing could, and that is a bug in
   * the engine rather than a deadline this client should paper over.
   */
  requestTimeoutMs?: number;
  /** Redacted protocol diagnostics (malformed frames, late responses). */
  onDiagnostic?: (line: string) => void;
}

/**
 * Connect to a running server.
 *
 * @param options - See {@link ConnectOptions}.
 * @returns A client whose handshake has been started (the protocol client
 *   sends `authenticate` eagerly, so it is always the first frame).
 * @throws When the address is not loopback.
 */
export async function connectToServe(options: ConnectOptions): Promise<ProtocolClient> {
  const { socketUrl, token } = parseConnectUrl(options.connectUrl);
  if (!isLoopbackSocketUrl(socketUrl)) {
    throw new Error(`Refusing to connect to ${socketUrl}: not a loopback address`);
  }
  const redactor = createRedactor(token === undefined ? [] : [token]);
  const socket = options.socketFactory(socketUrl);
  return createProtocolClient(socket, {
    ...(token === undefined ? {} : { token }),
    requestTimeoutMs: options.requestTimeoutMs ?? 0,
    onProtocolError: (error) => {
      options.onDiagnostic?.(redactor.redact(`protocol: ${error.code}: ${error.message}`));
    },
  });
}
