/**
 * Boots the real page app against a fake DOM.
 *
 * `boot()` is the wiring between the static shell in `page.ts` and the client
 * in `script/app.ts`: element lookups, listeners, the composer, the permission
 * sheet, the session picker. It is the one part that a browser would normally
 * be needed to exercise, so it is driven here through a DOM stand-in that
 * implements only the handful of APIs the client is allowed to use — and the
 * element ids are taken from the served page itself, so the shell and the code
 * cannot drift apart.
 */

import { describe, expect, it } from "vitest";
import { renderWebClientPage } from "./page.js";
import { APP_SCRIPT } from "./script/app.js";
import { FakeSocket, loadWebClient } from "./test-helpers/load.js";

const { app } = loadWebClient();
const PAGE = renderWebClientPage({ wsPort: 7717 });

/**
 * Every `id="…"` the served shell defines, with the elements the markup marks
 * `hidden` — so the harness starts in the same state a browser would.
 */
const PAGE_IDS = new Map<string, boolean>();
for (const tag of PAGE.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/g)) {
  const markup = tag[0];
  const id = /\bid="([^"]+)"/.exec(markup)?.[1];
  if (id !== undefined) PAGE_IDS.set(id, /\shidden[\s>]/.test(markup));
}

/** Every `byId("…")` lookup the client performs. */
const LOOKUPS = [...APP_SCRIPT.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1] as string);

type Listener = (event: Record<string, unknown>) => void;

/** A DOM element stand-in with just enough surface for the client. */
class UiElement {
  readonly tag: string;
  readonly attributes = new Map<string, string>();
  readonly childNodes: UiElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly style = {
    height: "",
    setProperty(): void {
      /* recorded nowhere; the client only ever sets --app-h */
    },
  };
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  scrollHeight = 0;
  clientHeight = 0;
  scrollTop = 0;
  focused = false;
  parentNode: UiElement | null = null;

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: UiElement): UiElement {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  replaceChild(next: UiElement, previous: UiElement): void {
    const index = this.childNodes.indexOf(previous);
    next.parentNode = this;
    if (index >= 0) this.childNodes[index] = next;
    else this.childNodes.push(next);
  }

  removeChild(child: UiElement): void {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  focus(): void {
    this.focused = true;
  }

  /** Fire every listener registered for `type`. */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault: () => undefined, target: this, ...event });
    }
  }

  /** All text in this subtree. */
  get text(): string {
    return this.textContent + this.childNodes.map((child) => child.text).join("");
  }
}

class UiDocument {
  readonly elements = new Map<string, UiElement>();
  readonly listeners = new Map<string, Listener[]>();
  readonly documentElement = new UiElement("html");
  visibilityState = "visible";

  constructor(ids: ReadonlyMap<string, boolean>) {
    for (const [id, hidden] of ids) {
      const element = new UiElement("div");
      element.hidden = hidden;
      this.elements.set(id, element);
    }
  }

  createElement(tag: string): UiElement {
    return new UiElement(tag);
  }

  getElementById(id: string): UiElement | null {
    return this.elements.get(id) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** The element with this id, failing loudly when the shell lacks it. */
  el(id: string): UiElement {
    const element = this.elements.get(id);
    if (!element) throw new Error(`The page has no element with id "${id}"`);
    return element;
  }
}

interface Harness {
  doc: UiDocument;
  sockets: FakeSocket[];
  instance: { client: { close(): void; getStatus(): string }; render(): void };
  stored: Map<string, string>;
  reloads: number;
  socket(): FakeSocket;
  /** Answer the newest request frame of `method` with `result`. */
  answer(method: string, result: unknown): void;
}

function boot(options: { hash?: string; storedToken?: string } = {}): Harness {
  const doc = new UiDocument(PAGE_IDS);
  const sockets: FakeSocket[] = [];
  const stored = new Map<string, string>();
  if (options.storedToken !== undefined) stored.set("arcturn.web.token", options.storedToken);
  const counters = { reloads: 0 };

  const win = {
    __ARCTURN__: { wsPort: 7717 },
    innerHeight: 800,
    location: {
      protocol: "http:",
      hostname: "127.0.0.1",
      port: "8788",
      pathname: "/",
      search: "",
      hash: options.hash ?? "",
      reload: () => {
        counters.reloads += 1;
      },
    },
    history: { replaceState: () => undefined },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
    WebSocket: function WebSocketStub(this: unknown, url: string) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    } as unknown as new (
      url: string,
    ) => FakeSocket,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 0;
    },
    setInterval: () => 0,
    addEventListener: () => undefined,
  };

  const instance = app.boot(doc, win) as unknown as Harness["instance"];
  const harness: Harness = {
    doc,
    sockets,
    instance,
    stored,
    get reloads() {
      return counters.reloads;
    },
    socket: () => sockets[sockets.length - 1] as FakeSocket,
    answer: (method, result) => {
      const socket = sockets[sockets.length - 1] as FakeSocket;
      const frame = [...socket.sent].reverse().find((sent) => sent.method === method);
      if (!frame) throw new Error(`No ${method} frame was sent`);
      socket.deliver({ kind: "response", id: frame.id, result });
    },
  };
  return harness;
}

/** Bring a booted page all the way to an open session. */
async function attach(test: Harness): Promise<void> {
  test.socket().open();
  await Promise.resolve();
  test.answer("listSessions", {
    sessions: [{ version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1 }],
  });
  await Promise.resolve();
  await Promise.resolve();
  test.answer("openSession", { version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1 });
  await Promise.resolve();
  await Promise.resolve();
}

function event(test: Harness, payload: Record<string, unknown>): void {
  test.socket().deliver({ kind: "event", sessionId: "s1", event: payload });
}

describe("the page shell and the client agree", () => {
  it("looks up only elements the served page actually defines", () => {
    expect(LOOKUPS.length).toBeGreaterThan(15);
    for (const id of LOOKUPS) expect(PAGE_IDS.has(id)).toBe(true);
  });
});

describe("booting the page", () => {
  it("connects, lists sessions and attaches to the newest one", async () => {
    const test = boot();
    expect(test.sockets).toHaveLength(1);
    await attach(test);

    expect(test.doc.el("session-title").textContent).toBe("s1");
    expect(test.doc.el("session-cwd").textContent).toBe("/repo");
    expect(test.doc.el("conn").textContent).toBe("online");
    expect(test.stored.get("arcturn.web.session")).toBe("s1");
    test.instance.client.close();
  });

  it("creates a session when the server lists none", async () => {
    const test = boot();
    test.socket().open();
    await Promise.resolve();
    test.answer("listSessions", { sessions: [] });
    await Promise.resolve();
    await Promise.resolve();
    const created = test.socket().sent.find((frame) => frame.method === "createSession");
    expect(created).toMatchObject({ params: { cwd: "." } });
    test.instance.client.close();
  });

  it("renders streamed events into the transcript, todos and activity line", async () => {
    const test = boot();
    await attach(test);

    event(test, {
      type: "runStart",
      sessionId: "s1",
      prompt: { role: "user", content: [{ type: "text", text: "do it" }], timestamp: 0 },
    });
    event(test, {
      type: "toolStart",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "ls -la" },
    });
    event(test, {
      type: "todoUpdate",
      todos: [{ id: "1", text: "check the build", status: "inProgress" }],
    });

    expect(test.doc.el("transcript").text).toContain("do it");
    expect(test.doc.el("transcript").text).toContain("ls -la");
    expect(test.doc.el("todos").text).toContain("check the build");
    expect(test.doc.el("activity").hidden).toBe(false);
    expect(test.doc.el("btn-abort").hidden).toBe(false);
    expect(test.doc.el("btn-send").textContent).toBe("Steer");

    event(test, { type: "runEnd", reason: "completed" });
    expect(test.doc.el("activity").hidden).toBe(true);
    expect(test.doc.el("btn-abort").hidden).toBe(true);
    expect(test.doc.el("btn-send").textContent).toBe("Send");
    test.instance.client.close();
  });

  it("sends a prompt when idle and a steer while running", async () => {
    const test = boot();
    await attach(test);

    test.doc.el("composer-input").value = "  first message  ";
    test.doc.el("composer").dispatch("submit");
    await Promise.resolve();
    expect(test.socket().last).toMatchObject({
      method: "prompt",
      params: { sessionId: "s1", text: "first message" },
    });
    expect(test.doc.el("composer-input").value).toBe("");

    event(test, {
      type: "runStart",
      sessionId: "s1",
      prompt: { role: "user", content: [{ type: "text", text: "first message" }], timestamp: 0 },
    });
    test.doc.el("composer-input").value = "actually, stop at the tests";
    test.doc.el("composer").dispatch("submit");
    await Promise.resolve();
    expect(test.socket().last).toMatchObject({
      method: "steer",
      params: { sessionId: "s1", text: "actually, stop at the tests" },
    });
    test.instance.client.close();
  });

  it("ignores an empty submission", async () => {
    const test = boot();
    await attach(test);
    const before = test.socket().sent.length;
    test.doc.el("composer-input").value = "   ";
    test.doc.el("composer").dispatch("submit");
    await Promise.resolve();
    expect(test.socket().sent).toHaveLength(before);
    test.instance.client.close();
  });

  it("aborts the run in flight", async () => {
    const test = boot();
    await attach(test);
    test.doc.el("btn-abort").dispatch("click");
    await Promise.resolve();
    expect(test.socket().last).toMatchObject({ method: "abort", params: { sessionId: "s1" } });
    test.instance.client.close();
  });
});

describe("the permission sheet", () => {
  const request = {
    id: "p1",
    toolName: "bash",
    toolCallId: "c1",
    subject: "rm -rf build",
    description: "bash: rm -rf build",
  };

  it("shows the requested subject and answers with allow-once", async () => {
    const test = boot();
    await attach(test);
    event(test, { type: "permissionRequest", request });

    const sheet = test.doc.el("permission");
    expect(sheet.hidden).toBe(false);
    expect(test.doc.el("permission-body").text).toContain("rm -rf build");
    expect(test.doc.el("scrim").hidden).toBe(false);
    // Focus lands on the safe choice, not on an approve button.
    expect(test.doc.el("perm-deny").focused).toBe(true);

    test.doc.el("perm-allow").dispatch("click");
    await Promise.resolve();
    expect(test.socket().last).toMatchObject({
      method: "permissionDecision",
      params: { sessionId: "s1", decision: { requestId: "p1", behavior: "allow" } },
    });
    expect(sheet.hidden).toBe(true);
    expect(test.doc.el("scrim").hidden).toBe(true);
    test.instance.client.close();
  });

  it("persists a project rule for allow-always", async () => {
    const test = boot();
    await attach(test);
    event(test, { type: "permissionRequest", request });
    test.doc.el("perm-always").dispatch("click");
    await Promise.resolve();
    expect(test.socket().last).toMatchObject({
      method: "permissionDecision",
      params: {
        decision: {
          behavior: "allow",
          persistRule: { tool: "bash", specifier: "rm *", action: "allow", scope: "project" },
        },
      },
    });
    test.instance.client.close();
  });

  it("sends a denial the model can act on", async () => {
    const test = boot();
    await attach(test);
    event(test, { type: "permissionRequest", request });
    test.doc.el("perm-deny").dispatch("click");
    await Promise.resolve();
    const frame = test.socket().last as { params: { decision: { message: string } } };
    expect(frame.params.decision).toMatchObject({ behavior: "deny" });
    expect(frame.params.decision.message).toContain("denied");
    test.instance.client.close();
  });

  it("will not let a user approve a request they have not read to the end", async () => {
    const test = boot();
    await attach(test);
    const body = test.doc.el("permission-body");
    // A subject taller than the sheet: the approve buttons stay disabled…
    body.scrollHeight = 900;
    body.clientHeight = 300;
    event(test, {
      type: "permissionRequest",
      request: { ...request, subject: "x\n".repeat(400) },
    });
    expect(test.doc.el("perm-allow").disabled).toBe(true);
    expect(test.doc.el("perm-always").disabled).toBe(true);
    expect(test.doc.el("permission-gate").hidden).toBe(false);
    // …but denying is always available.
    expect(test.doc.el("perm-deny").disabled).toBe(false);

    body.scrollTop = 600;
    body.dispatch("scroll");
    expect(test.doc.el("perm-allow").disabled).toBe(false);
    expect(test.doc.el("permission-gate").hidden).toBe(true);
    test.instance.client.close();
  });

  it("queues a second request instead of losing it", async () => {
    const test = boot();
    await attach(test);
    event(test, { type: "permissionRequest", request });
    event(test, {
      type: "permissionRequest",
      request: { ...request, id: "p2", subject: "curl example.com" },
    });
    test.doc.el("perm-allow").dispatch("click");
    await Promise.resolve();
    expect(test.doc.el("permission").hidden).toBe(false);
    expect(test.doc.el("permission-body").text).toContain("curl example.com");
    test.instance.client.close();
  });
});

describe("sessions, reconnection and the token prompt", () => {
  it("switches sessions from the picker and resets the transcript", async () => {
    const test = boot();
    await attach(test);
    event(test, { type: "notice", level: "info", text: "from the first session" });
    expect(test.doc.el("transcript").text).toContain("from the first session");

    test.doc.el("btn-sessions").dispatch("click");
    expect(test.doc.el("sessions").hidden).toBe(false);
    test.answer("listSessions", {
      sessions: [
        { version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1 },
        { version: 1, sessionId: "s2", cwd: "/other", createdAt: 2 },
      ],
    });
    await Promise.resolve();
    const rows = test.doc.el("sessions-list").childNodes;
    expect(rows).toHaveLength(2);
    const row = rows.find((item) => item.text.includes("s2"));
    test.doc.el("sessions-list").dispatch("click", { target: row?.childNodes[0] });
    await Promise.resolve();
    expect(test.doc.el("sessions").hidden).toBe(true);
    test.answer("openSession", { version: 1, sessionId: "s2", cwd: "/other", createdAt: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.doc.el("session-title").textContent).toBe("s2");
    expect(test.doc.el("transcript").text).not.toContain("from the first session");
    test.instance.client.close();
  });

  it("reconnects when the tab becomes visible again", async () => {
    const test = boot();
    await attach(test);
    test.socket().drop();
    expect(test.doc.el("conn").getAttribute("data-state")).toBe("offline");

    // A phone waking up.
    test.doc.dispatch("visibilitychange");
    expect(test.sockets).toHaveLength(2);
    test.socket().open();
    await Promise.resolve();
    expect(test.doc.el("conn").textContent).toBe("online");
    // The reconnect re-lists and then re-opens the same session, which is what
    // resubscribes this connection to its event stream.
    test.answer("listSessions", {
      sessions: [{ version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1 }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.socket().sent.some((frame) => frame.method === "openSession")).toBe(true);
    test.answer("openSession", { version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.doc.el("transcript").text).toContain("Reconnected.");
    test.instance.client.close();
  });

  it("keeps an unanswered permission on screen across a reconnect", async () => {
    const test = boot();
    await attach(test);
    event(test, {
      type: "permissionRequest",
      request: {
        id: "p9",
        toolName: "bash",
        toolCallId: "c1",
        subject: "git push --force",
        description: "bash: git push --force",
      },
    });
    expect(test.doc.el("permission").hidden).toBe(false);

    // The phone locks mid-approval and the socket dies. The request is still
    // outstanding server-side, so the sheet must survive and still be
    // answerable once the socket is back.
    test.socket().drop();
    test.doc.dispatch("visibilitychange");
    test.socket().open();
    await Promise.resolve();
    test.answer("listSessions", {
      sessions: [{ version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1 }],
    });
    await Promise.resolve();
    await Promise.resolve();
    test.answer("openSession", { version: 1, sessionId: "s1", cwd: "/repo", createdAt: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(test.doc.el("permission").hidden).toBe(false);
    expect(test.doc.el("permission-body").text).toContain("git push --force");
    test.doc.el("perm-allow").dispatch("click");
    await Promise.resolve();
    expect(test.socket().last).toMatchObject({
      method: "permissionDecision",
      params: { decision: { requestId: "p9", behavior: "allow" } },
    });
    test.instance.client.close();
  });

  it("takes the token out of the URL and never puts it back on screen", async () => {
    const test = boot({ hash: "#token=sup3r-s3cret" });
    expect(test.stored.get("arcturn.web.token")).toBe("sup3r-s3cret");
    test.socket().open();
    await Promise.resolve();
    expect(test.socket().sent[0]).toMatchObject({
      method: "authenticate",
      params: { token: "sup3r-s3cret" },
    });
    for (const element of test.doc.elements.values()) {
      expect(element.text).not.toContain("sup3r-s3cret");
      expect(element.value).not.toContain("sup3r-s3cret");
    }
    test.instance.client.close();
  });

  it("asks for a token when the server rejects the one it had", async () => {
    const test = boot({ storedToken: "stale" });
    test.socket().open();
    await Promise.resolve();
    test.socket().drop(4401);
    await Promise.resolve();

    expect(test.doc.el("token").hidden).toBe(false);
    expect(test.doc.el("token-error").hidden).toBe(false);
    expect(test.doc.el("token-error").textContent).toContain("rejected");
    expect(test.doc.el("token-input").focused).toBe(true);
    // The rejected token is not shown back to the user.
    expect(test.doc.el("token-input").value).toBe("");

    test.doc.el("token-input").value = "fresh-token";
    test.doc.el("token-form").dispatch("submit");
    expect(test.stored.get("arcturn.web.token")).toBe("fresh-token");
    expect(test.doc.el("token-input").value).toBe("");
    expect(test.reloads).toBe(1);
    test.instance.client.close();
  });

  it("can drop the token entirely for a server that has none", async () => {
    const test = boot({ storedToken: "stale" });
    test.socket().open();
    await Promise.resolve();
    test.socket().drop(4401);
    await Promise.resolve();
    test.doc.el("btn-token-skip").dispatch("click");
    expect(test.stored.has("arcturn.web.token")).toBe(false);
    expect(test.reloads).toBe(1);
    test.instance.client.close();
  });
});
