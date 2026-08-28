/**
 * Authorizing an OAuth-protected MCP server from the editor.
 *
 * The engine can already do this on its own, and on a laptop that is the right
 * answer: `arcturn mcp auth <server>` binds a listener on `127.0.0.1`, opens a
 * browser, and catches the redirect. The assumption underneath is that the
 * browser and the engine share a loopback address.
 *
 * An editor breaks that assumption routinely. `extensionKind` puts this
 * extension — and the engine it spawns — on the *workspace* side, which over
 * Remote-SSH, in a devcontainer, or in a Codespace is a different machine from
 * the browser. `127.0.0.1` there is not `127.0.0.1` here, so the redirect
 * lands nowhere and the flow times out with nothing to show for it.
 *
 * VS Code has the missing piece. `asExternalUri` on a `vscode://` URI returns
 * something the *user's* browser can reach — a tunnelled `https://` URL on
 * remote, the URI itself on desktop — and the redirect comes back through the
 * editor's own URI handler regardless of which machine the engine is on. So
 * the client contributes the browser round trip and nothing else: discovery,
 * dynamic client registration, PKCE and the tokens all stay in the engine,
 * where the credential file already is.
 *
 * ## What this module does not hold
 *
 * No token, no refresh token, no code verifier — none of those are ever sent
 * to a client. What passes through here is an authorization URL, and a `code`
 * and `state` pair on the way back. The `state` is the engine's; this module
 * compares nothing and decides nothing about it, it just echoes it back so the
 * engine can refuse a callback belonging to some other authorization.
 */

/** The editor surface this needs. Narrow, so the tests can supply all of it. */
export interface McpAuthEditor {
  /**
   * `vscode.env.asExternalUri`.
   *
   * On desktop this returns the URI unchanged. On remote it returns a
   * tunnelled URL that reaches this editor window from the user's browser,
   * which is the entire reason this module exists.
   */
  asExternalUri(uri: string): Promise<string>;
  /** `vscode.env.openExternal`. Resolves `false` when the browser did not open. */
  openExternal(url: string): Promise<boolean>;
  /**
   * `vscode.window.registerUriHandler`, narrowed to the query string.
   *
   * One handler serves every authorization; `state` is what tells two
   * concurrent ones apart.
   */
  onUri(handler: (query: string) => void): { dispose(): void };
}

/** The engine verbs this needs, matching `ProtocolClient`. */
export interface McpAuthClient {
  mcpAuthBegin(
    server: string,
    redirectUri: string,
  ): Promise<{ authorized: boolean; handle?: string; authorizationUrl?: string } | undefined>;
  mcpAuthComplete(handle: string, code: string, state: string): Promise<void>;
  mcpAuthCancel(handle: string): Promise<boolean>;
}

/** What came back on the redirect. */
export interface McpCallback {
  readonly code?: string;
  readonly state?: string;
  /** The provider's `error` parameter — `access_denied` when the user said no. */
  readonly error?: string;
  readonly errorDescription?: string;
}

/**
 * Read a redirect's query string.
 *
 * Tolerant of a leading `?` because `vscode.Uri.query` omits it and a hand-built
 * URI may not, and of the parameters arriving in any order. An OAuth error
 * response carries `error` instead of `code`, and is a normal outcome — the
 * user clicked "deny" — rather than a malformed callback.
 */
export function parseMcpCallback(query: string): McpCallback {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  const description = params.get("error_description");
  return {
    ...(code === null ? {} : { code }),
    ...(state === null ? {} : { state }),
    ...(error === null ? {} : { error }),
    ...(description === null ? {} : { errorDescription: description }),
  };
}

/**
 * The `vscode://` URI the redirect comes back to.
 *
 * The authority is the extension's fully-qualified id, because that is what
 * VS Code routes on; getting it wrong means the callback opens the marketplace
 * page for an extension that does not exist rather than reaching this handler.
 */
export function mcpCallbackUri(extensionId: string): string {
  return `vscode://${extensionId}/mcp-callback`;
}

/** How the authorization ended. */
export type McpAuthOutcome =
  /** Stored credentials were refreshed; no browser was needed. */
  | { readonly kind: "already-authorized" }
  /** The full flow ran and the engine holds tokens. */
  | { readonly kind: "authorized" }
  /** The user denied it, or the provider refused. */
  | { readonly kind: "denied"; readonly reason: string }
  /** The engine is too old to broker an authorization. */
  | { readonly kind: "unsupported" };

/** Options for {@link authorizeMcpServer}. */
export interface AuthorizeMcpServerOptions {
  readonly client: McpAuthClient;
  readonly editor: McpAuthEditor;
  /** Configured MCP server name. */
  readonly server: string;
  /** Fully-qualified extension id, e.g. `arcturn.arcturn-vscode`. */
  readonly extensionId: string;
  /** How long to wait for the redirect. Defaults to five minutes. */
  readonly timeoutMs?: number;
  /** Cancels the wait — a progress notification's cancellation token. */
  readonly signal?: AbortSignal;
}

/** How long the editor waits for the user to finish in the browser. */
export const DEFAULT_MCP_CALLBACK_TIMEOUT_MS = 300_000;

/**
 * Run one authorization, with this editor catching the redirect.
 *
 * The URI handler is registered *before* `mcpAuthBegin`, not after: on desktop
 * a fast provider can redirect before an await resolves, and a handler
 * registered afterwards would miss its own callback.
 *
 * @throws When the engine rejects the exchange, or the browser could not be
 *   opened. A denial is not a throw — the user saying no is an outcome, and
 *   {@link McpAuthOutcome} carries it.
 */
export async function authorizeMcpServer(
  options: AuthorizeMcpServerOptions,
): Promise<McpAuthOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_CALLBACK_TIMEOUT_MS;

  let settle: ((callback: McpCallback) => void) | undefined;
  let expectedState: string | undefined;
  const arrived = new Promise<McpCallback>((resolve) => {
    settle = resolve;
  });
  const subscription = options.editor.onUri((query) => {
    const callback = parseMcpCallback(query);
    // A callback for a *different* authorization must not resolve this one.
    // The engine checks `state` too, and authoritatively; this check only
    // stops one window's two concurrent flows from stealing each other's
    // redirect, which the engine cannot see.
    if (expectedState !== undefined && callback.state !== expectedState) return;
    settle?.(callback);
  });

  try {
    const redirectUri = await options.editor.asExternalUri(mcpCallbackUri(options.extensionId));
    const begun = await options.client.mcpAuthBegin(options.server, redirectUri);
    if (begun === undefined) return { kind: "unsupported" };
    if (begun.authorized) return { kind: "already-authorized" };

    const handle = begun.handle ?? "";
    const authorizationUrl = begun.authorizationUrl ?? "";
    expectedState = new URL(authorizationUrl).searchParams.get("state") ?? undefined;

    const opened = await options.editor.openExternal(authorizationUrl);
    if (!opened) {
      await options.client.mcpAuthCancel(handle).catch(() => undefined);
      throw new Error("the browser could not be opened for authorization");
    }

    const callback = await waitForCallback(arrived, timeoutMs, options.signal).catch(
      async (error: unknown) => {
        // An abandoned authorization is dropped in the engine too, so a
        // cancelled attempt does not hold a flow open for five more minutes.
        await options.client.mcpAuthCancel(handle).catch(() => undefined);
        throw error;
      },
    );

    if (callback.error !== undefined || callback.code === undefined) {
      await options.client.mcpAuthCancel(handle).catch(() => undefined);
      return {
        kind: "denied",
        reason: callback.errorDescription ?? callback.error ?? "the redirect carried no code",
      };
    }

    await options.client.mcpAuthComplete(handle, callback.code, callback.state ?? "");
    return { kind: "authorized" };
  } finally {
    subscription.dispose();
  }
}

/** Race the redirect against the clock and the caller's cancellation. */
function waitForCallback(
  arrived: Promise<McpCallback>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<McpCallback> {
  return new Promise<McpCallback>((resolve, reject) => {
    // Checked before the listener is attached, because `addEventListener` on
    // an already-aborted signal never fires: a user who cancels while the
    // browser is still opening would otherwise wait out the whole timeout.
    if (signal?.aborted) {
      reject(new Error("authorization was cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for the authorization redirect"));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("authorization was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    arrived.then(
      (callback) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(callback);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * The fully-qualified id VS Code routes `vscode://` URIs on.
 *
 * A constant rather than `context.extension.id`, because it also has to be
 * correct in a unit test with no extension host, and because a mismatch is
 * silent: VS Code opens the marketplace page for the id it was given instead
 * of reporting that nothing handles it.
 */
export const ARCTURN_EXTENSION_ID = "arcturn.arcturn-vscode";
