/**
 * What the panel actually builds, run against a stub DOM.
 *
 * ## What this proves, and what it does not
 *
 * The client is a string of JavaScript (see `webview-client.ts` for why), and
 * the two suites either side of it both stop short of running it: `vitest` has
 * no DOM, and the integration suite runs in a real extension host that
 * [cannot read a webview's document](../../TESTING.md). Between them sat every
 * bug whose symptom is "the panel is blank and the TypeError is in a devtools
 * console nobody has open" — a renamed id, an `appendChild(undefined)`, a
 * reconciler that drops the element it was updating.
 *
 * So the script is executed here against roughly 150 lines of stub DOM. What
 * that settles is **structure**: which elements get built, with which classes
 * and which text, in response to which host message, and which messages go
 * back. It settles **nothing about appearance**. This stub has no layout, no
 * cascade, no computed style and no font metrics; it cannot tell you the panel
 * is legible, that the theme tokens resolve, that the caret blinks, or that
 * anything is where it should be. Those remain human-eye claims and are listed
 * as such in `TESTING.md`.
 *
 * The stub is deliberately thin and deliberately strict — `appendChild(null)`
 * throws here, where a browser would too — so a test that passes against it is
 * a test about the script, not about the stub. Nothing here is shipped: the
 * file is a `*.test.ts` and the extension bundle never imports it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { renderSidebarHtml } from "./webview-html.js";

/* ------------------------------------------------------------------ */
/* the stub DOM                                                        */
/* ------------------------------------------------------------------ */

type Listener = (event: Record<string, unknown>) => void;

class StubClassList {
  constructor(private readonly node: StubNode) {}
  #set(): Set<string> {
    return new Set(this.node.className.split(/\s+/).filter(Boolean));
  }
  add(...names: string[]): void {
    const set = this.#set();
    for (const name of names) set.add(name);
    this.node.className = [...set].join(" ");
  }
  remove(...names: string[]): void {
    const set = this.#set();
    for (const name of names) set.delete(name);
    this.node.className = [...set].join(" ");
  }
  contains(name: string): boolean {
    return this.#set().has(name);
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force === undefined ? !this.contains(name) : force;
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

class StubNode {
  readonly childNodes: (StubNode | StubText)[] = [];
  parentNode: StubNode | undefined;
  readonly attributes: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners: Record<string, Listener[]> = {};
  readonly classList = new StubClassList(this);
  className = "";
  disabled = false;
  value = "";
  title = "";
  type = "";
  scrollTop = 0;
  /** A viewport with more content above it than fits, so "scrolled up" exists. */
  readonly scrollHeight = 1000;
  readonly clientHeight = 400;
  #text: string | undefined;

  constructor(readonly tagName: string) {}

  get id(): string {
    return this.attributes.id ?? "";
  }
  get firstChild(): StubNode | StubText | undefined {
    return this.childNodes[0];
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value);
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
  }
  appendChild<T extends StubNode | StubText>(child: T): T {
    if (child === null || child === undefined) {
      throw new TypeError(`appendChild(${String(child)}) on <${this.tagName}>`);
    }
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    this.#text = undefined;
    return child;
  }
  insertBefore<T extends StubNode | StubText>(child: T, ref: StubNode | StubText | null): T {
    child.parentNode?.removeChild(child);
    const at = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends StubNode | StubText>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at !== -1) this.childNodes.splice(at, 1);
    child.parentNode = undefined;
    return child;
  }
  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.childNodes.some((child) => child.contains(other));
  }
  get textContent(): string {
    if (this.#text !== undefined) return this.#text;
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = undefined;
    this.childNodes.length = 0;
    this.#text = String(value);
  }
  addEventListener(type: string, handler: Listener): void {
    const existing = this.listeners[type];
    if (existing === undefined) this.listeners[type] = [handler];
    else existing.push(handler);
  }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of this.listeners[type] ?? []) {
      handler({ target: this, preventDefault: () => {}, ...event });
    }
  }
  focus(): void {}
  scrollIntoView(): void {}

  /** Every descendant, self first — the query primitive the assertions use. */
  walk(): StubNode[] {
    const out: StubNode[] = [this];
    for (const child of this.childNodes) if (child instanceof StubNode) out.push(...child.walk());
    return out;
  }
  find(selector: (node: StubNode) => boolean): StubNode | undefined {
    return this.walk().find(selector);
  }
  all(className: string): StubNode[] {
    return this.walk().filter((node) => node.classList.contains(className));
  }
}

class StubText {
  readonly tagName = "#text";
  parentNode: StubNode | undefined;
  readonly childNodes: never[] = [];
  constructor(readonly textContent: string) {}
  contains(): boolean {
    return false;
  }
}

/** Parse the shipped skeleton far enough to register ids, nesting and text. */
function buildSkeleton(html: string, byId: Map<string, StubNode>): StubNode {
  const root = new StubNode("body");
  const stack: StubNode[] = [root];
  const voids = new Set(["input", "br", "hr", "img", "meta", "link"]);
  const token = /<(\/?)([a-z0-9]+)([^>]*?)(\/?)>|([^<]+)/gi;
  for (const match of html.matchAll(token)) {
    const [, closing, tag, attrs, selfClose, text] = match;
    const top = stack[stack.length - 1];
    if (top === undefined) continue;
    if (text !== undefined) {
      const trimmed = text.replace(/\s+/g, " ");
      if (trimmed.trim() !== "") top.appendChild(new StubText(trimmed));
      continue;
    }
    if (tag === undefined) continue;
    if (closing === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = new StubNode(tag);
    for (const attr of (attrs ?? "").matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      node.setAttribute(attr[1] as string, attr[2] as string);
    }
    if (node.id !== "") byId.set(node.id, node);
    top.appendChild(node);
    if (selfClose !== "/" && !voids.has(tag)) stack.push(node);
  }
  return root;
}

interface Panel {
  byId: (id: string) => StubNode;
  send: (message: unknown) => void;
  posted: { type: string; [key: string]: unknown }[];
  root: StubNode;
}

/** Render the real page, run the real script, hand back a way to drive it. */
function mount(): Panel {
  const page = renderSidebarHtml({ nonce: "AbCd1234AbCd1234", cspSource: "vscode-webview://x" });
  const open = page.indexOf("<body>") + "<body>".length;
  const scriptAt = page.indexOf("<script nonce=");
  const body = page.slice(open, scriptAt);
  const script = page.slice(page.indexOf(">", scriptAt) + 1, page.lastIndexOf("</script>"));

  const byId = new Map<string, StubNode>();
  const root = buildSkeleton(body, byId);
  const posted: { type: string; [key: string]: unknown }[] = [];
  const handlers: Listener[] = [];

  const document = {
    createElement: (tag: string) => new StubNode(tag),
    createElementNS: (_ns: string, tag: string) => new StubNode(tag),
    createTextNode: (value: string) => new StubText(value),
    getElementById: (id: string) => byId.get(id) ?? null,
    addEventListener: () => {},
  };
  const win = {
    addEventListener: (type: string, handler: Listener) => {
      if (type === "message") handlers.push(handler);
    },
    setTimeout: () => 0,
  };

  const run = new Function("document", "window", "setTimeout", "acquireVsCodeApi", script) as (
    ...args: unknown[]
  ) => void;
  run(
    document,
    win,
    () => 0,
    () => ({
      postMessage: (message: { type: string }) => posted.push(message),
    }),
  );

  return {
    root,
    posted,
    byId: (id) => {
      const node = byId.get(id);
      if (node === undefined) throw new Error(`the page has no #${id}`);
      return node;
    },
    send: (message) => {
      for (const handler of handlers) handler({ data: message });
    },
  };
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

interface StateOptions {
  blocks?: unknown[];
  running?: boolean;
  pendingPermissions?: number;
  todos?: unknown[];
  plan?: string;
  model?: string;
}

function state(options: StateOptions = {}): unknown {
  return {
    type: "state",
    state: {
      blocks: options.blocks ?? [],
      todos: options.todos ?? [],
      plan: options.plan ?? "",
      running: options.running ?? false,
      pendingPermissions: options.pendingPermissions ?? 0,
      ...(options.model === undefined ? {} : { model: options.model }),
    },
  };
}

function toolBlock(over: Record<string, unknown> = {}): unknown {
  return {
    kind: "tool",
    id: "tool:k1",
    toolCallId: "k1",
    name: "bash",
    argsText: '{"command":"pnpm -r run typecheck"}',
    argsComplete: true,
    status: "running",
    progress: "",
    result: "",
    collapsed: true,
    ...over,
  };
}

const catalog = [
  {
    id: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    provider: "anthropic",
    contextWindow: 200_000,
    cost: { input: 3, output: 15 },
    apiKeyEnv: "ANTHROPIC_API_KEY",
    credentials: "present",
  },
  {
    id: "openai/gpt-5",
    displayName: "GPT-5",
    provider: "openai",
    contextWindow: 400_000,
    apiKeyEnv: "OPENAI_API_KEY",
    credentials: "absent",
  },
];

let panel: Panel;
beforeEach(() => {
  panel = mount();
  panel.send({ type: "connection", status: "ready" });
});

/* ------------------------------------------------------------------ */

describe("the panel on load", () => {
  it("runs, finds every element it reaches for, and asks the host for state", () => {
    expect(panel.posted[0]).toEqual({ type: "ready" });
  });

  it("offers starter prompts when there is nothing in the transcript", () => {
    panel.send(state());
    expect(panel.byId("empty").classList.contains("hidden")).toBe(false);
    const starters = panel.byId("starters").childNodes;
    expect(starters.length).toBeGreaterThanOrEqual(3);
    expect(starters.length).toBeLessThanOrEqual(4);
    (starters[0] as StubNode).dispatch("click");
    expect(panel.posted.filter((message) => message.type === "send")).toHaveLength(1);
  });

  it("hides the starters once the conversation has started", () => {
    panel.send(state({ blocks: [{ kind: "user", id: "u1", text: "hi" }] }));
    expect(panel.byId("empty").classList.contains("hidden")).toBe(true);
  });

  it("disables the composer, the chip and the starters while the engine is down", () => {
    panel.send({ type: "connection", status: "disconnected", detail: "The engine stopped." });
    expect(panel.byId("prompt").disabled).toBe(true);
    expect(panel.byId("model").disabled).toBe(true);
    expect((panel.byId("starters").childNodes[0] as StubNode).disabled).toBe(true);
    expect(panel.byId("banner-text").textContent).toBe("The engine stopped.");
  });

  it("quotes the engine's own words and its buttons on the reconnect card", () => {
    panel.send({
      type: "connection",
      status: "disconnected",
      detail: "The Arcturn engine stopped.",
      engineOutput: "arcturn: No API key found for Claude Sonnet 5.",
      actions: [
        { id: "showLog", label: "Show Log" },
        { id: "reconnect", label: "Retry" },
      ],
    });
    expect(panel.byId("engine-output").textContent).toContain("No API key found");
    const buttons = panel.byId("banner-actions").childNodes as StubNode[];
    expect(buttons.map((node) => node.textContent)).toEqual(["Show Log", "Retry"]);
    buttons[1]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "action", id: "reconnect" });
  });
});

describe("rendering an assistant turn", () => {
  const answer = [
    "# Heading",
    "",
    "Some **bold** and `inline` text.",
    "",
    "- one",
    "- two",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "> quoted [docs](https://arcturn.dev)",
  ].join("\n");

  beforeEach(() => {
    panel.send(
      state({
        blocks: [
          { kind: "user", id: "u1", text: "explain it" },
          { kind: "text", id: "t1", text: answer },
        ],
      }),
    );
  });

  it("labels the two sides of the conversation", () => {
    const turns = panel.byId("turns").childNodes as StubNode[];
    expect(turns[0]?.className).toContain("turn-user");
    expect(turns[0]?.textContent).toContain("You");
    expect(turns[1]?.className).toContain("turn-assistant");
    expect(turns[1]?.textContent).toContain("Arcturn");
  });

  it("renders markdown as elements", () => {
    const md = panel.byId("turns").find((node) => node.classList.contains("md"));
    const tags = md?.walk().map((node) => node.tagName) ?? [];
    expect(tags).toEqual(
      expect.arrayContaining(["h1", "strong", "code", "ul", "li", "blockquote"]),
    );
  });

  it("gives a fenced block its language and a copy button that reaches the host", () => {
    const block = panel.byId("turns").find((node) => node.classList.contains("code-block"));
    expect(block?.find((node) => node.classList.contains("code-lang"))?.textContent).toBe("ts");
    expect(block?.find((node) => node.tagName === "pre")?.textContent).toBe("const a = 1;");
    block?.find((node) => node.classList.contains("code-copy"))?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "copy", text: "const a = 1;" });
  });

  it("keeps a safe link and its target", () => {
    const anchor = panel.byId("turns").find((node) => node.tagName === "a");
    expect(anchor?.getAttribute("href")).toBe("https://arcturn.dev");
    expect(anchor?.textContent).toBe("docs");
  });
});

describe("what model output cannot do to the panel", () => {
  function render(text: string): StubNode {
    panel.send(state({ blocks: [{ kind: "text", id: "t1", text }] }));
    return panel.byId("turns");
  }

  it("renders a tag the model wrote as characters, never as an element", () => {
    const turns = render('Try <img src=x onerror="alert(1)"> or <script>alert(1)</script>.');
    expect(turns.walk().map((node) => node.tagName)).not.toContain("img");
    expect(turns.walk().map((node) => node.tagName)).not.toContain("script");
    expect(turns.textContent).toContain("<img src=x onerror=");
    expect(turns.textContent).toContain("<script>alert(1)</script>");
  });

  it("refuses to make a javascript: or data: link clickable", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      const turns = render(`[click](${href})`);
      expect(turns.find((node) => node.tagName === "a")).toBeUndefined();
      expect(turns.textContent).toContain("[click](");
    }
  });

  it("puts engine text in textContent, so a tool result cannot become markup either", () => {
    panel.send(
      state({
        blocks: [
          toolBlock({ collapsed: false, status: "error", result: "<b>boom</b>", progress: "x" }),
        ],
      }),
    );
    const card = panel.byId("turns").find((node) => node.classList.contains("tool"));
    expect(card?.walk().map((node) => node.tagName)).not.toContain("b");
    expect(card?.textContent).toContain("<b>boom</b>");
  });
});

describe("tool calls", () => {
  it("shows the name, a one-line summary and the status, collapsed", () => {
    panel.send(state({ blocks: [toolBlock()] }));
    const card = panel.byId("turns").find((node) => node.classList.contains("tool"));
    expect(card?.className).toContain("tool-running");
    expect(card?.find((node) => node.classList.contains("tool-name"))?.textContent).toBe("bash");
    expect(card?.find((node) => node.classList.contains("tool-summary"))?.textContent).toBe(
      "pnpm -r run typecheck",
    );
    expect(card?.find((node) => node.classList.contains("tool-badge"))?.textContent).toBe(
      "Running",
    );
    expect(
      card?.find((node) => node.classList.contains("tool-body"))?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("summarises the arguments while they are still arriving", () => {
    panel.send(
      state({ blocks: [toolBlock({ argsText: '{"command":"npm run bui', argsComplete: false })] }),
    );
    expect(
      panel.byId("turns").find((node) => node.classList.contains("tool-summary"))?.textContent,
    ).toBe("npm run bui");
  });

  it("asks the host to toggle rather than expanding behind its back", () => {
    // Expansion is host state (`chat-state.ts`), so it survives the reload a
    // hidden panel goes through. The card asks; it does not decide.
    panel.send(state({ blocks: [toolBlock()] }));
    panel
      .byId("turns")
      .find((node) => node.classList.contains("disclosure"))
      ?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "toggle", blockId: "tool:k1" });
  });

  it("shows arguments, output and result once the host expands it", () => {
    panel.send(
      state({
        blocks: [
          toolBlock({ collapsed: false, status: "ok", progress: "compiling…", result: "Done." }),
        ],
      }),
    );
    const body = panel.byId("turns").find((node) => node.classList.contains("tool-body"));
    expect(body?.classList.contains("hidden")).toBe(false);
    expect(body?.textContent).toContain("pnpm -r run typecheck");
    expect(body?.textContent).toContain("compiling…");
    expect(body?.textContent).toContain("Done.");
  });

  it("marks a tool waiting on a permission dialog", () => {
    panel.send(state({ blocks: [toolBlock({ status: "awaitingPermission" })] }));
    const card = panel.byId("turns").find((node) => node.classList.contains("tool"));
    expect(card?.className).toContain("tool-awaitingPermission");
    expect(card?.textContent).toContain("Needs permission");
  });
});

describe("thinking, todos and pending permissions", () => {
  it("collapses thinking behind a disclosure", () => {
    panel.send(
      state({ blocks: [{ kind: "thinking", id: "th1", text: "weighing it up", collapsed: true }] }),
    );
    const node = panel.byId("turns").find((child) => child.classList.contains("thinking"));
    expect(node?.textContent).toContain("Thought process");
    expect(
      node
        ?.find((child) => child.classList.contains("thinking-body"))
        ?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("renders todos as a checklist with a count", () => {
    panel.send(
      state({
        plan: "Ship the panel.",
        todos: [
          { text: "Compose", status: "done" },
          { text: "Render", status: "inProgress" },
          { text: "Ship", status: "pending" },
        ],
      }),
    );
    expect(panel.byId("plan-card").classList.contains("hidden")).toBe(false);
    expect(panel.byId("plan-text").textContent).toBe("Ship the panel.");
    expect(panel.byId("plan-count").textContent).toBe("1/3");
    const items = panel.byId("todos").childNodes as StubNode[];
    expect(items.map((item) => item.className)).toEqual([
      "todo-done",
      "todo-inProgress",
      "todo-pending",
    ]);
  });

  it("hides the plan card when the engine has emitted neither a plan nor todos", () => {
    panel.send(state());
    expect(panel.byId("plan-card").classList.contains("hidden")).toBe(true);
  });

  it("says a permission dialog is up, so the panel is not silent behind a modal", () => {
    // The dialog itself stays native — that is the security property. This is
    // only the marker that says why nothing is moving.
    panel.send(state({ pendingPermissions: 1, running: true }));
    expect(panel.byId("permission").classList.contains("hidden")).toBe(false);
    expect(panel.byId("permission-text").textContent).toContain("permission");
    panel.send(state({ pendingPermissions: 0 }));
    expect(panel.byId("permission").classList.contains("hidden")).toBe(true);
  });
});

describe("streaming", () => {
  function stream(text: string, running: boolean): void {
    panel.send(
      state({
        running,
        blocks: [
          { kind: "user", id: "u1", text: "go" },
          { kind: "text", id: "t1", text },
          toolBlock({ id: "tool:k1" }),
        ],
      }),
    );
  }

  it("reuses the elements it already built instead of rebuilding the log", () => {
    stream("Half a sen", true);
    const turns = panel.byId("turns");
    const userTurn = turns.childNodes[0];
    const assistantTurn = turns.childNodes[1] as StubNode;
    const body = assistantTurn.find((node) => node.classList.contains("turn-body")) as StubNode;
    const textBlock = body.childNodes[0];
    const toolCard = body.childNodes[1];

    stream("Half a sentence, then the rest.", true);

    // Identity, not equality: a new element here is a lost scroll position, a
    // lost text selection, and a tool card that collapses under the reader.
    expect(turns.childNodes[0]).toBe(userTurn);
    expect(turns.childNodes[1]).toBe(assistantTurn);
    expect(body.childNodes[0]).toBe(textBlock);
    expect(body.childNodes[1]).toBe(toolCard);
    expect((textBlock as StubNode).textContent).toContain("then the rest");
  });

  it("marks the block still being written, and unmarks it when the run ends", () => {
    panel.send(state({ running: true, blocks: [{ kind: "text", id: "t1", text: "writing" }] }));
    const block = panel.byId("turns").find((node) => node.classList.contains("text-block"));
    expect(block?.className).toContain("streaming");
    panel.send(state({ running: false, blocks: [{ kind: "text", id: "t1", text: "writing" }] }));
    expect(block?.className).not.toContain("streaming");
  });

  it("does not yank a reader who has scrolled up back to the bottom", () => {
    stream("one", true);
    const transcript = panel.byId("transcript");
    transcript.scrollTop = 40;
    // 400 - 40 - 400 is far from the bottom, so the panel unsticks.
    transcript.dispatch("scroll");
    expect(panel.byId("jump").classList.contains("hidden")).toBe(false);
    stream("one two three", true);
    expect(transcript.scrollTop).toBe(40);
    panel.byId("jump").dispatch("click");
    expect(transcript.scrollTop).toBe(transcript.scrollHeight);
  });
});

describe("the composer", () => {
  it("sends on Enter and leaves Shift+Enter to the textarea", () => {
    const prompt = panel.byId("prompt");
    prompt.value = "do the thing";
    prompt.dispatch("input");
    prompt.dispatch("keydown", { key: "Enter", shiftKey: true });
    expect(panel.posted.filter((message) => message.type === "send")).toHaveLength(0);
    prompt.dispatch("keydown", { key: "Enter", shiftKey: false });
    expect(panel.posted.at(-1)).toEqual({ type: "send", text: "do the thing" });
    expect(prompt.value).toBe("");
  });

  it("refuses to send nothing", () => {
    panel.byId("prompt").value = "   ";
    panel.byId("prompt").dispatch("keydown", { key: "Enter" });
    expect(panel.posted.filter((message) => message.type === "send")).toHaveLength(0);
  });

  it("offers Stop while a run is in flight, and steering if you type", () => {
    panel.send(state({ running: true }));
    expect(panel.byId("abort").classList.contains("hidden")).toBe(false);
    expect(panel.byId("hint").textContent).toContain("Running");
    panel.byId("prompt").value = "actually, do this instead";
    panel.byId("prompt").dispatch("input");
    expect(panel.byId("hint").textContent).toContain("steers");
    expect(panel.byId("send").disabled).toBe(false);
    panel.byId("abort").dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "abort" });
  });

  it("hides Stop when nothing is running", () => {
    panel.send(state({ running: false }));
    expect(panel.byId("abort").classList.contains("hidden")).toBe(true);
  });

  it("grows with the text through an attribute, never an inline style", () => {
    panel.byId("prompt").value = "one\ntwo\nthree";
    panel.byId("prompt").dispatch("input");
    expect(panel.byId("grow").getAttribute("data-value")).toBe("one\ntwo\nthree");
  });
});

describe("the model selector", () => {
  function open(): void {
    panel.byId("model").dispatch("click");
  }

  it("names the model on the chip once the host says which one is in use", () => {
    expect(panel.byId("model-label").textContent).toBe("Select model");
    panel.send({
      type: "models",
      status: "ready",
      models: catalog,
      current: "anthropic/claude-sonnet-5",
    });
    expect(panel.byId("model-label").textContent).toBe("Claude Sonnet 5");
  });

  it("asks the host for the catalog when the connection comes up and when it is opened", () => {
    expect(panel.posted.filter((message) => message.type === "requestModels")).toHaveLength(1);
    open();
    expect(panel.posted.filter((message) => message.type === "requestModels")).toHaveLength(2);
  });

  it("groups rows by whether this server can actually use the model", () => {
    panel.send({
      type: "models",
      status: "ready",
      models: catalog,
      current: "anthropic/claude-sonnet-5",
    });
    open();
    const heads = panel
      .byId("model-list")
      .all("group-head")
      .map((node) => node.textContent);
    expect(heads).toEqual(["In use", "No credentials on this server"]);
    const rows = panel.byId("model-list").all("model-row");
    expect(rows[0]?.find((node) => node.classList.contains("model-dot"))?.className).toContain(
      "dot-present",
    );
    expect(rows[1]?.find((node) => node.classList.contains("model-dot"))?.className).toContain(
      "dot-absent",
    );
    expect(rows[0]?.textContent).toContain("Current");
    expect(rows[0]?.textContent).toContain("200k ctx · $3/$15 per Mtok · ANTHROPIC_API_KEY set");
    expect(rows[1]?.textContent).toContain("pricing unknown");
  });

  it("switches the model on click and shows the pick immediately", () => {
    panel.send({
      type: "models",
      status: "ready",
      models: catalog,
      current: "anthropic/claude-sonnet-5",
    });
    open();
    panel.byId("model-list").all("model-row")[1]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "setModel", modelId: "openai/gpt-5" });
    expect(panel.byId("model-label").textContent).toBe("GPT-5");
    expect(panel.byId("model-popover").classList.contains("hidden")).toBe(true);
  });

  it("does not revert the chip when a repaint carries the model the run started with", () => {
    // `state.model` is announced at the start of a run, so between a switch and
    // the next prompt it still names the old model. Reverting on that would
    // tell the user their switch did not take.
    panel.send({
      type: "models",
      status: "ready",
      models: catalog,
      current: "anthropic/claude-sonnet-5",
    });
    panel.send(state({ model: "anthropic/claude-sonnet-5" }));
    open();
    panel.byId("model-list").all("model-row")[1]?.dispatch("click");
    panel.send(state({ model: "anthropic/claude-sonnet-5" }));
    expect(panel.byId("model-label").textContent).toBe("GPT-5");
  });

  it("filters as you type", () => {
    panel.send({ type: "models", status: "ready", models: catalog });
    open();
    panel.byId("model-search").value = "gpt";
    panel.byId("model-search").dispatch("input");
    const rows = panel.byId("model-list").all("model-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("GPT-5");
  });

  it("is usable from the keyboard alone", () => {
    panel.send({ type: "models", status: "ready", models: catalog });
    open();
    const search = panel.byId("model-search");
    // The first row is active as soon as the list opens, the way a quick-pick
    // behaves, and the search box points a screen reader at it.
    expect(panel.byId("model-list").all("model-row")[0]?.className).toContain("active");
    expect(search.getAttribute("aria-activedescendant")).toBe("model-row-0");
    search.dispatch("keydown", { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe("model-row-1");
    search.dispatch("keydown", { key: "Enter" });
    expect(panel.posted.at(-1)).toEqual({ type: "setModel", modelId: "openai/gpt-5" });
    open();
    panel.byId("model-search").dispatch("keydown", { key: "Escape" });
    expect(panel.byId("model-popover").classList.contains("hidden")).toBe(true);
  });

  it("still lets an id be typed when the engine answers no catalog at all", () => {
    // `listModels` is optional. An older engine gets the same degradation
    // picker.ts has always given it: say so, and take free text.
    panel.send({ type: "models", status: "unavailable", models: [] });
    open();
    expect(panel.byId("model-status").textContent).toContain("does not answer listModels");
    panel.byId("model-search").value = "vendor/model-9";
    panel.byId("model-search").dispatch("input");
    panel.byId("model-list").all("model-row")[0]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "setModel", modelId: "vendor/model-9" });
  });

  it("says the catalog is loading rather than claiming the server has no models", () => {
    panel.send({ type: "models", status: "loading", models: [] });
    open();
    expect(panel.byId("model-status").textContent).toContain("Loading");
    expect(panel.byId("model-list").all("model-row")).toHaveLength(0);
  });
});

describe("the header", () => {
  it("names the session and the folder, and shows the honest cost", () => {
    panel.send({
      type: "session",
      sessionId: "01JABCDEFGHJKMNPQRS",
      title: "Rebuild the sidebar",
      cwd: "/repo/arcturn",
    });
    panel.send({ type: "cost", label: "$0.42+" });
    expect(panel.byId("session-title").textContent).toBe("Rebuild the sidebar");
    expect(panel.byId("session-sub").textContent).toBe("01JABCDE · arcturn");
    expect(panel.byId("cost").textContent).toBe("$0.42+");
  });

  it("falls back to the product name for a session with no title", () => {
    panel.send({ type: "session", sessionId: "01JABCDEFGHJKMNPQRS", cwd: "/repo/arcturn" });
    expect(panel.byId("session-title").textContent).toBe("Arcturn");
  });

  it("routes New Session and Sessions through the commands the manifest contributes", () => {
    panel.byId("new-session").dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "command", command: "newSession" });
    panel.byId("sessions").dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "command", command: "sessions" });
  });
});

describe("host messages the panel will not act on", () => {
  it("ignores a message whose type is not on the allowlist", () => {
    const before = panel.byId("cost").textContent;
    panel.send({ type: "evaluate", label: "pwned" });
    panel.send({ type: "constructor" });
    panel.send({ type: "toString" });
    panel.send(null);
    panel.send("state");
    expect(panel.byId("cost").textContent).toBe(before);
  });

  it("ignores a known message whose fields are the wrong shape", () => {
    panel.send({ type: "cost", label: 42 });
    panel.send({ type: "state", state: "everything is fine" });
    panel.send({ type: "connection", status: 7 });
    expect(panel.byId("cost").textContent).toBe("");
  });

  it("drops a catalog row with no id rather than rendering a nameless model", () => {
    panel.send({
      type: "models",
      status: "ready",
      models: [{ displayName: "Ghost", credentials: "present" }, ...catalog],
    });
    panel.byId("model").dispatch("click");
    expect(panel.byId("model-list").textContent).not.toContain("Ghost");
    expect(panel.byId("model-list").all("model-row")).toHaveLength(2);
  });
});
