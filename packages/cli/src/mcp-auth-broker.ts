/**
 * OAuth for MCP servers when the browser is somewhere else.
 *
 * `runMcpOAuthFlow` is one `await`: bind a listener, print a URL, wait for the
 * redirect, exchange the code. That shape assumes the process that wants the
 * token is also the process the browser can reach. Over a request/response
 * wire it is assumes-too-much twice over — a client cannot hold one call open
 * across a human going to a browser and back, and on a remote engine the
 * loopback the flow binds is on the wrong machine entirely.
 *
 * This module splits that one await into two verbs without reimplementing any
 * of it. `begin` starts the real flow with a redirect listener whose callback
 * never arrives on its own, and returns the authorization URL as soon as the
 * flow asks for a browser. `complete` hands the code to that listener, which
 * unblocks the flow exactly where it was parked. Discovery, dynamic client
 * registration, PKCE and the token exchange all still happen in the engine,
 * against the engine's stored credentials; the client contributes precisely
 * one thing, which is the round trip through a browser it can actually see.
 *
 * ## What the client is trusted with, and what it is not
 *
 * The client chooses the redirect URI and supplies the authorization code, so
 * a hostile client could point the redirect at itself and keep the code. That
 * is not a new power: this wire is already authenticated by the serve token,
 * and anything holding that token can ask the engine to run a shell command.
 * The token is the boundary, and there is no weaker one to add here.
 *
 * What a client is *not* trusted with is `state`. The engine generates it, the
 * client must echo it back on `complete`, and a mismatch fails the exchange —
 * so a callback belonging to some other authorization cannot be redeemed
 * against this one. Handles are random and single-use for the same reason.
 *
 * Nothing here logs a code, a token or an authorization URL.
 */

import { randomBytes } from "node:crypto";
import type {
  McpOAuthFlowOptions,
  McpRedirectListener,
  McpRedirectListenerFactory,
} from "./mcp-auth.js";

/** How long a begun authorization waits for `complete` before it is dropped. */
export const DEFAULT_BROKERED_AUTH_TIMEOUT_MS = 300_000;

/** What `begin` answers with. */
export interface McpAuthBeginResult {
  /**
   * True when stored credentials were still good (or refreshed) and no browser
   * is needed. The other two fields are then absent and there is nothing to
   * complete.
   */
  readonly authorized: boolean;
  /** Opaque single-use handle for {@link McpAuthBroker.complete}. */
  readonly handle?: string;
  /** The URL the client must open in a browser. */
  readonly authorizationUrl?: string;
}

/** A brokered authorization waiting for its code. */
interface PendingAuth {
  readonly server: string;
  readonly state: string;
  readonly deliver: (code: string) => void;
  readonly fail: (error: Error) => void;
  /** The running flow. Settles after `deliver`/`fail`. */
  readonly flow: Promise<void>;
  readonly timer: NodeJS.Timeout;
}

/**
 * A redirect listener the engine cannot satisfy on its own.
 *
 * `waitForCallback` parks forever; it is resolved from outside, by the broker,
 * when a client calls `complete`. The `redirectUri` is whatever the client
 * said it can catch — this object never binds a socket.
 */
class BrokeredRedirectListener implements McpRedirectListener {
  readonly redirectUri: string;
  readonly #result: Promise<{ code: string }>;
  #deliver!: (value: { code: string }) => void;
  #fail!: (error: Error) => void;
  #settled = false;

  constructor(redirectUri: string) {
    this.redirectUri = redirectUri;
    this.#result = new Promise<{ code: string }>((resolve, reject) => {
      this.#deliver = resolve;
      this.#fail = reject;
    });
    // Nothing observes this promise until the flow reaches `waitForCallback`,
    // and a `fail` before then would otherwise be an unhandled rejection.
    this.#result.catch(() => undefined);
  }

  waitForCallback(): Promise<{ code: string }> {
    return this.#result;
  }

  async close(): Promise<void> {
    // There is no socket to close. Rejecting a still-parked wait here would
    // race the flow's own `finally`, so a caller that wants to abandon an
    // authorization calls `fail` first.
  }

  /** Resolve the parked wait. Second and later calls are ignored. */
  deliver(code: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#deliver({ code });
  }

  /** Reject the parked wait. Second and later calls are ignored. */
  fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#fail(error);
  }
}

/** What the broker needs in order to run a flow. */
export interface McpAuthBrokerOptions {
  /**
   * Runs the real authorization. Injected rather than imported so a test can
   * drive the two halves without an authorization server, and so this module
   * does not pull the SDK into processes that never authorize anything.
   */
  readonly runFlow: (options: McpOAuthFlowOptions) => Promise<void>;
  /** Resolves a configured server name to everything the flow needs. */
  readonly resolveServer: (
    server: string,
  ) => Promise<Pick<McpOAuthFlowOptions, "serverUrl" | "storage">>;
  /** How long a begun authorization survives without a `complete`. */
  readonly timeoutMs?: number;
}

/**
 * Holds authorizations open between `begin` and `complete`.
 *
 * One instance per engine process. Pending entries are dropped on timeout, on
 * `cancel`, and when the flow itself fails, so an abandoned browser tab costs
 * one timer and nothing else.
 */
export class McpAuthBroker {
  readonly #options: McpAuthBrokerOptions;
  readonly #pending = new Map<string, PendingAuth>();

  constructor(options: McpAuthBrokerOptions) {
    this.#options = options;
  }

  /** Authorizations begun and not yet completed. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Start authorizing `server`, with the redirect caught by the caller.
   *
   * Resolves as soon as the flow asks for a browser — or, when stored
   * credentials still work, as soon as the flow finishes without asking.
   *
   * @throws When the server is not configured, or discovery fails.
   */
  async begin(server: string, redirectUri: string): Promise<McpAuthBeginResult> {
    const target = await this.#options.resolveServer(server);
    const handle = randomBytes(32).toString("base64url");

    let listener: BrokeredRedirectListener | undefined;
    let capturedState = "";
    let announce: ((url: string) => void) | undefined;
    const authorizationUrl = new Promise<string>((resolve) => {
      announce = resolve;
    });

    const flow = this.#options.runFlow({
      serverName: server,
      serverUrl: target.serverUrl,
      storage: target.storage,
      // The engine's stdout is not this client's; the URL travels in the
      // result, and a second copy on a terminal nobody is reading is a leak
      // with no reader.
      stdout: () => undefined,
      open: false,
      timeoutMs: this.#options.timeoutMs ?? DEFAULT_BROKERED_AUTH_TIMEOUT_MS,
      redirect: ((bindOptions) => {
        capturedState = bindOptions.state;
        listener = new BrokeredRedirectListener(redirectUri);
        return Promise.resolve(listener);
      }) satisfies McpRedirectListenerFactory,
      onAuthorizationUrl: (url: URL) => {
        announce?.(url.toString());
      },
    });

    // Whichever comes first: the flow wanted a browser, or the flow finished
    // without one. A flow that throws propagates, because `begin` failing is
    // the honest answer to "discovery did not work".
    const asked = await Promise.race([
      authorizationUrl.then((url) => ({ url }) as const),
      flow.then(() => ({ url: undefined }) as const),
    ]);

    if (asked.url === undefined) {
      return { authorized: true };
    }

    const pending: PendingAuth = {
      server,
      state: capturedState,
      deliver: (code) => listener?.deliver(code),
      fail: (error) => listener?.fail(error),
      flow,
      timer: setTimeout(() => {
        this.#drop(handle, new Error(`authorization for "${server}" timed out`));
      }, this.#options.timeoutMs ?? DEFAULT_BROKERED_AUTH_TIMEOUT_MS),
    };
    // A begun authorization must not hold the process open on its own.
    pending.timer.unref?.();
    // The flow is now owned by `complete`; nothing else may observe it, and an
    // unobserved rejection would take the process down.
    flow.catch(() => undefined);
    this.#pending.set(handle, pending);
    return { authorized: false, handle, authorizationUrl: asked.url };
  }

  /**
   * Hand the authorization code back and finish the exchange.
   *
   * @throws When the handle is unknown or already used, when `state` does not
   *   match the one this authorization issued, or when the token exchange
   *   fails.
   */
  async complete(handle: string, code: string, state: string): Promise<void> {
    const pending = this.#pending.get(handle);
    if (!pending) {
      throw new Error("no authorization is waiting for that handle");
    }
    // Single-use: taken before anything can throw, so a failed exchange cannot
    // be retried against the same handle with a different code.
    this.#pending.delete(handle);
    clearTimeout(pending.timer);

    if (state !== pending.state) {
      pending.fail(new Error("authorization state did not match"));
      await pending.flow.catch(() => undefined);
      throw new Error("authorization state did not match");
    }

    pending.deliver(code);
    await pending.flow;
  }

  /**
   * Abandon a begun authorization.
   *
   * @returns `false` when the handle was unknown, which is not an error: a
   *   client cancelling after a timeout is racing a drop that already happened.
   */
  async cancel(handle: string): Promise<boolean> {
    const pending = this.#pending.get(handle);
    if (!pending) return false;
    this.#drop(handle, new Error("authorization was cancelled"));
    await pending.flow.catch(() => undefined);
    return true;
  }

  /** Drop every pending authorization. Called when the engine shuts down. */
  dispose(): void {
    for (const handle of [...this.#pending.keys()]) {
      this.#drop(handle, new Error("the engine is shutting down"));
    }
  }

  #drop(handle: string, reason: Error): void {
    const pending = this.#pending.get(handle);
    if (!pending) return;
    this.#pending.delete(handle);
    clearTimeout(pending.timer);
    pending.fail(reason);
  }
}
