/**
 * The editor's half of an MCP authorization.
 *
 * The engine's half is proven in `packages/cli/src/mcp-auth-broker.effects.test.ts`
 * against a real authorization server. What is left to establish here is what
 * the *editor* contributes, and the claims are all about sequence and address:
 * that the redirect URI handed to the engine is the one `asExternalUri`
 * produced (not the raw `vscode://`, which is what breaks on remote), that the
 * URI handler is registered before the flow can redirect into it, that a
 * callback for another authorization cannot resolve this one, and that every
 * way of not finishing tells the engine to drop the flow.
 */

import { describe, expect, it } from "vitest";
import {
  authorizeMcpServer,
  type McpAuthClient,
  type McpAuthEditor,
  mcpCallbackUri,
  parseMcpCallback,
} from "./mcp-auth.js";

const EXTENSION_ID = "arcturn.arcturn-vscode";
const AUTH_URL = "https://figma.example/authorize?client_id=c1&state=st-1&code_challenge=x";

/** Records what the extension asked the editor to do, in order. */
function fakeEditor(overrides: Partial<McpAuthEditor> = {}) {
  const log: string[] = [];
  let deliver: ((query: string) => void) | undefined;
  let disposed = false;
  // Resolves once the browser has been opened, which is the point at which
  // the flow is armed and waiting. Tests await this instead of guessing how
  // many microtasks the awaits before it add up to.
  let armed: (() => void) | undefined;
  const whenOpened = new Promise<void>((resolve) => {
    armed = resolve;
  });
  const editor: McpAuthEditor = {
    asExternalUri: async (uri) => {
      log.push(`asExternalUri:${uri}`);
      // What a remote window really does: hand back a tunnelled https URL
      // that reaches this window from the user's own browser.
      return `https://tunnel.example/${encodeURIComponent(uri)}`;
    },
    openExternal: async (url) => {
      log.push(`openExternal:${url}`);
      armed?.();
      return true;
    },
    onUri: (handler) => {
      log.push("onUri:registered");
      deliver = handler;
      return {
        dispose: () => {
          disposed = true;
          log.push("onUri:disposed");
        },
      };
    },
    ...overrides,
  };
  return {
    editor,
    log,
    whenOpened,
    get disposed() {
      return disposed;
    },
    /** Stand in for the browser coming back to the editor. */
    redirect: (query: string) => deliver?.(query),
    get handlerRegistered() {
      return deliver !== undefined;
    },
  };
}

/** Records what the engine was asked, and lets a test steer the answers. */
function fakeClient(
  begin?: Partial<{ authorized: boolean; handle: string; authorizationUrl: string }>,
) {
  const calls: string[] = [];
  const client: McpAuthClient = {
    mcpAuthBegin: async (server, redirectUri) => {
      calls.push(`begin:${server}:${redirectUri}`);
      if (begin?.authorized) return { authorized: true };
      return {
        authorized: false,
        handle: begin?.handle ?? "h-1",
        authorizationUrl: begin?.authorizationUrl ?? AUTH_URL,
      };
    },
    mcpAuthComplete: async (handle, code, state) => {
      calls.push(`complete:${handle}:${code}:${state}`);
    },
    mcpAuthCancel: async (handle) => {
      calls.push(`cancel:${handle}`);
      return true;
    },
  };
  return { client, calls };
}

describe("reading a redirect", () => {
  it("takes code and state whether or not the query has a leading ?", () => {
    expect(parseMcpCallback("code=abc&state=st-1")).toEqual({ code: "abc", state: "st-1" });
    expect(parseMcpCallback("?state=st-1&code=abc")).toEqual({ code: "abc", state: "st-1" });
  });

  it("reads a denial as a denial, not as a missing code", () => {
    const parsed = parseMcpCallback("error=access_denied&error_description=User%20said%20no");
    expect(parsed.error).toBe("access_denied");
    expect(parsed.errorDescription).toBe("User said no");
    expect(parsed.code).toBeUndefined();
  });

  it("routes the callback to this extension's id", () => {
    expect(mcpCallbackUri(EXTENSION_ID)).toBe("vscode://arcturn.arcturn-vscode/mcp-callback");
  });
});

describe("authorizing an MCP server from the editor", () => {
  it("gives the engine the tunnelled redirect URI, not the raw vscode: one", async () => {
    const editor = fakeEditor();
    const engine = fakeClient();

    const run = authorizeMcpServer({
      client: engine.client,
      editor: editor.editor,
      server: "figma",
      extensionId: EXTENSION_ID,
    });
    await editor.whenOpened;
    editor.redirect("code=abc&state=st-1");
    expect(await run).toEqual({ kind: "authorized" });

    // The whole point of the feature: what the engine registers with the
    // authorization server is the URL the user's browser can reach, which on
    // remote is the tunnel and never `vscode://` or a loopback address.
    const begin = engine.calls.find((call) => call.startsWith("begin:"));
    expect(begin).toContain("https://tunnel.example/");
    expect(begin).not.toContain("127.0.0.1");
    expect(editor.log[0]).toBe("onUri:registered");
    expect(editor.log).toContain(`asExternalUri:${mcpCallbackUri(EXTENSION_ID)}`);
  });

  it("registers the URI handler before anything can redirect into it", async () => {
    // A provider that redirects during `openExternal` — fast, and legal.
    let registeredWhenOpened = false;
    const editor = fakeEditor();
    const withEarlyRedirect = fakeEditor();
    const observingOpen: McpAuthEditor = {
      ...withEarlyRedirect.editor,
      openExternal: async (url) => {
        registeredWhenOpened = editor.handlerRegistered;
        return withEarlyRedirect.editor.openExternal(url);
      },
    };
    const engine = fakeClient();

    const run = authorizeMcpServer({
      client: engine.client,
      editor: {
        ...observingOpen,
        onUri: editor.editor.onUri,
        asExternalUri: editor.editor.asExternalUri,
      },
      server: "figma",
      extensionId: EXTENSION_ID,
    });
    await withEarlyRedirect.whenOpened;
    editor.redirect("code=abc&state=st-1");
    await run;

    expect(registeredWhenOpened).toBe(true);
  });

  it("passes the code and the state straight through to the engine", async () => {
    const editor = fakeEditor();
    const engine = fakeClient();

    const run = authorizeMcpServer({
      client: engine.client,
      editor: editor.editor,
      server: "figma",
      extensionId: EXTENSION_ID,
    });
    await editor.whenOpened;
    editor.redirect("code=the-code&state=st-1");
    await run;

    expect(engine.calls).toContain("complete:h-1:the-code:st-1");
  });

  it("ignores a callback belonging to a different authorization", async () => {
    const editor = fakeEditor();
    const engine = fakeClient();

    const run = authorizeMcpServer({
      client: engine.client,
      editor: editor.editor,
      server: "figma",
      extensionId: EXTENSION_ID,
      timeoutMs: 50,
    });
    await editor.whenOpened;
    // Another window's redirect, with a state this flow never issued.
    editor.redirect("code=stolen&state=someone-elses");

    await expect(run).rejects.toThrow(/timed out/i);
    // It was not merely ignored: nothing was exchanged, and the engine was
    // told to drop the flow rather than hold it for its own five minutes.
    expect(engine.calls.some((call) => call.startsWith("complete:"))).toBe(false);
    expect(engine.calls).toContain("cancel:h-1");
  });

  it("reports a denial without exchanging anything", async () => {
    const editor = fakeEditor();
    const engine = fakeClient();

    const run = authorizeMcpServer({
      client: engine.client,
      editor: editor.editor,
      server: "figma",
      extensionId: EXTENSION_ID,
    });
    await editor.whenOpened;
    editor.redirect("error=access_denied&error_description=Nope&state=st-1");

    expect(await run).toEqual({ kind: "denied", reason: "Nope" });
    expect(engine.calls.some((call) => call.startsWith("complete:"))).toBe(false);
    expect(engine.calls).toContain("cancel:h-1");
  });

  it("opens no browser when stored credentials still work", async () => {
    const editor = fakeEditor();
    const engine = fakeClient({ authorized: true });

    const outcome = await authorizeMcpServer({
      client: engine.client,
      editor: editor.editor,
      server: "figma",
      extensionId: EXTENSION_ID,
    });

    expect(outcome).toEqual({ kind: "already-authorized" });
    expect(editor.log.some((entry) => entry.startsWith("openExternal:"))).toBe(false);
  });

  it("says so, rather than failing, when the engine is too old for the verb", async () => {
    const editor = fakeEditor();
    const engine = fakeClient();

    const outcome = await authorizeMcpServer({
      client: { ...engine.client, mcpAuthBegin: async () => undefined },
      editor: editor.editor,
      server: "figma",
      extensionId: EXTENSION_ID,
    });

    expect(outcome).toEqual({ kind: "unsupported" });
    expect(editor.log.some((entry) => entry.startsWith("openExternal:"))).toBe(false);
  });

  it("cancels the engine's flow when the user cancels the wait", async () => {
    const editor = fakeEditor();
    const engine = fakeClient();
    const controller = new AbortController();

    const run = authorizeMcpServer({
      client: engine.client,
      editor: editor.editor,
      server: "figma",
      extensionId: EXTENSION_ID,
      signal: controller.signal,
    });
    await editor.whenOpened;
    controller.abort();

    await expect(run).rejects.toThrow(/cancelled/i);
    expect(engine.calls).toContain("cancel:h-1");
  });

  it("unregisters the URI handler however it ends", async () => {
    const editor = fakeEditor();
    const engine = fakeClient();

    const run = authorizeMcpServer({
      client: engine.client,
      editor: editor.editor,
      server: "figma",
      extensionId: EXTENSION_ID,
      timeoutMs: 30,
    });
    await expect(run).rejects.toThrow(/timed out/i);

    // A handler left behind would catch the next authorization's redirect and
    // resolve a promise nobody is holding.
    expect(editor.disposed).toBe(true);
  });
});
