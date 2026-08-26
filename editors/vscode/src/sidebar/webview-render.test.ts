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
  /** A textarea's caret. The `@` and `/` menus read it to find the token. */
  selectionStart = 0;
  selectionEnd = 0;
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
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

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
  /** Run every timer the script scheduled — the composer's debounce lives on one. */
  flushTimers: () => void;
  /** Fire a document-level event, which is where drop and dismiss listeners live. */
  onDocument: (type: string, event: Record<string, unknown>) => void;
  /** Type into the composer the way a person does: value, caret, then input. */
  type: (text: string) => void;
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

  const documentListeners: Record<string, Listener[]> = {};
  const timers: (() => void)[] = [];
  const document = {
    createElement: (tag: string) => new StubNode(tag),
    createElementNS: (_ns: string, tag: string) => new StubNode(tag),
    createTextNode: (value: string) => new StubText(value),
    getElementById: (id: string) => byId.get(id) ?? null,
    addEventListener: (type: string, handler: Listener) => {
      const existing = documentListeners[type];
      if (existing === undefined) documentListeners[type] = [handler];
      else existing.push(handler);
    },
  };
  /**
   * A FileReader that answers synchronously with a data URL, which is the
   * shape the paste path reads. Nothing here decodes anything: the script's
   * job is to split the prefix off and hand the base64 to the host.
   */
  class StubFileReader {
    result = "";
    onload: (() => void) | undefined;
    onerror: (() => void) | undefined;
    readAsDataURL(file: { dataUrl?: string }): void {
      this.result = file.dataUrl ?? "data:image/png;base64,AAAA";
      this.onload?.();
    }
  }
  const win = {
    addEventListener: (type: string, handler: Listener) => {
      if (type === "message") handlers.push(handler);
    },
    setTimeout: (handler: () => void) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimeout: (id: number) => {
      if (typeof id === "number" && id > 0) timers[id - 1] = () => {};
    },
    FileReader: StubFileReader,
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

  const lookup = (id: string): StubNode => {
    const node = byId.get(id);
    if (node === undefined) throw new Error(`the page has no #${id}`);
    return node;
  };

  return {
    root,
    posted,
    byId: lookup,
    send: (message) => {
      for (const handler of handlers) handler({ data: message });
    },
    flushTimers: () => {
      for (const run of timers.splice(0)) run();
    },
    onDocument: (type, event) => {
      for (const handler of documentListeners[type] ?? []) {
        handler({ preventDefault: () => {}, stopPropagation: () => {}, ...event });
      }
    },
    type: (text) => {
      const prompt = lookup("prompt");
      prompt.value = text;
      prompt.selectionStart = text.length;
      prompt.selectionEnd = text.length;
      prompt.dispatch("input");
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

describe("the session history, in the panel", () => {
  const HOUR = 3_600_000;
  const sessions = [
    { sessionId: "01JOLDEST", title: "Find the setModel bug", createdAt: Date.now() - 50 * HOUR },
    { sessionId: "01JNEWEST", title: "Rebuild the sidebar", createdAt: Date.now() - 3 * HOUR },
  ];

  /** The header button and the palette are two doors; this opens the near one. */
  function open(): void {
    panel.byId("sessions").dispatch("click");
    panel.send({ type: "showSessions" });
  }

  function list(over: Record<string, unknown> = {}): unknown {
    return {
      type: "sessions",
      status: "ready",
      sessions,
      current: "01JNEWEST",
      cwd: "/repo/arcturn",
      ...over,
    };
  }

  it("opens where the transcript was, rather than over it", () => {
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(true);
    open();
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(false);
    // A full-panel view, not a popover: the transcript and the composer are
    // gone while it is up, because opening a session replaces both.
    expect(panel.byId("transcript").classList.contains("hidden")).toBe(true);
    expect(panel.byId("dock").classList.contains("hidden")).toBe(true);
    expect(panel.posted.at(-1)).toEqual({ type: "requestSessions" });
  });

  it("names each session, its id and how long ago it was started", () => {
    open();
    panel.send(list());
    const rows = panel.byId("sessions-list").all("session-row");
    expect(rows).toHaveLength(2);
    // Newest first: the session a user is most likely coming back for.
    expect(rows[0]?.textContent).toContain("Rebuild the sidebar");
    expect(rows[0]?.textContent).toContain("01JNEWEST · 3h ago");
    expect(rows[0]?.textContent).toContain("Current");
    expect(rows[1]?.textContent).toContain("Find the setModel bug");
    expect(rows[1]?.textContent).toContain("2d ago");
    expect(rows[1]?.textContent).not.toContain("Current");
  });

  it("opens the session that was clicked and puts the transcript back", () => {
    open();
    panel.send(list());
    panel.byId("sessions-list").all("session-row")[1]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "openSession", sessionId: "01JOLDEST" });
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(true);
    expect(panel.byId("transcript").classList.contains("hidden")).toBe(false);
    expect(panel.byId("dock").classList.contains("hidden")).toBe(false);
  });

  it("offers a new session without making the user find the header again", () => {
    open();
    panel.send(list());
    panel.byId("sessions-new").dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "command", command: "newSession" });
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(true);
  });

  it("names the folder a new session would start in", () => {
    open();
    panel.send(list());
    expect(panel.byId("sessions-new").textContent).toContain("New session");
    expect(panel.byId("sessions-new").textContent).toContain("arcturn");
  });

  it("filters as you type, and says so when nothing matches", () => {
    open();
    panel.send(list());
    panel.byId("sessions-search").value = "setmodel";
    panel.byId("sessions-search").dispatch("input");
    const rows = panel.byId("sessions-list").all("session-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Find the setModel bug");
    panel.byId("sessions-search").value = "nothing like this";
    panel.byId("sessions-search").dispatch("input");
    expect(panel.byId("sessions-list").all("session-row")).toHaveLength(0);
    expect(panel.byId("sessions-list").textContent).toContain("No session matches that search");
  });

  it("is usable from the keyboard alone, the way the model list is", () => {
    open();
    panel.send(list());
    const search = panel.byId("sessions-search");
    expect(panel.byId("sessions-list").all("session-row")[0]?.className).toContain("active");
    expect(search.getAttribute("aria-activedescendant")).toBe("session-row-0");
    search.dispatch("keydown", { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe("session-row-1");
    search.dispatch("keydown", { key: "Enter" });
    expect(panel.posted.at(-1)).toEqual({ type: "openSession", sessionId: "01JOLDEST" });
    open();
    panel.byId("sessions-search").dispatch("keydown", { key: "Escape" });
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(true);
    expect(panel.byId("transcript").classList.contains("hidden")).toBe(false);
  });

  it("asks again when the engine comes back, and stays quiet when it is closed", () => {
    panel.send({ type: "connection", status: "disconnected", detail: "gone" });
    const before = panel.posted.filter((message) => message.type === "requestSessions").length;
    panel.send({ type: "connection", status: "ready" });
    expect(panel.posted.filter((message) => message.type === "requestSessions")).toHaveLength(
      before,
    );
    open();
    panel.send({ type: "connection", status: "disconnected", detail: "gone" });
    const open_ = panel.posted.filter((message) => message.type === "requestSessions").length;
    panel.send({ type: "connection", status: "ready" });
    expect(
      panel.posted.filter((message) => message.type === "requestSessions").length,
    ).toBeGreaterThan(open_);
  });

  it("gets out of the way when the transcript becomes a different conversation", () => {
    // Whoever changed it — the header's New Session button, the palette — the
    // list was only ever open in order to do this.
    panel.send({ type: "session", sessionId: "01JNEWEST", title: "Rebuild", cwd: "/repo/arcturn" });
    open();
    panel.send({ type: "session", sessionId: "01JFRESH", title: "Untitled", cwd: "/repo/arcturn" });
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(true);
    expect(panel.byId("transcript").classList.contains("hidden")).toBe(false);
  });

  it("stays put when a repaint names the session it is already showing", () => {
    panel.send({ type: "session", sessionId: "01JNEWEST", title: "Rebuild", cwd: "/repo/arcturn" });
    open();
    panel.send({ type: "session", sessionId: "01JNEWEST", title: "Rebuild", cwd: "/repo/arcturn" });
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(false);
  });

  it("says the workspace has no sessions yet rather than showing a blank list", () => {
    open();
    panel.send(list({ sessions: [], current: undefined }));
    expect(panel.byId("sessions-status").classList.contains("hidden")).toBe(false);
    expect(panel.byId("sessions-status").textContent).toContain(
      "No sessions in this workspace yet",
    );
    // The one thing a user can do from here is still on screen.
    expect(panel.byId("sessions-new").classList.contains("hidden")).toBe(false);
  });

  it("says the engine is not connected rather than claiming there are no sessions", () => {
    open();
    panel.send(list({ status: "disconnected", sessions: [] }));
    expect(panel.byId("sessions-status").textContent).toContain("not connected");
    expect(panel.byId("sessions-status").textContent).not.toContain(
      "No sessions in this workspace",
    );
  });

  it("separates a failed listSessions from a disconnected engine", () => {
    open();
    panel.send(list({ status: "failed", sessions: [] }));
    expect(panel.byId("sessions-status").textContent).toContain("could not list");
    expect(panel.byId("sessions-status").textContent).not.toContain("not connected");
  });

  it("says it is still asking rather than claiming the workspace is empty", () => {
    open();
    panel.send(list({ status: "loading", sessions: [] }));
    expect(panel.byId("sessions-status").textContent).toContain("Loading");
    expect(panel.byId("sessions-list").all("session-row")).toHaveLength(0);
  });

  it("renders codicon syntax in a title as the characters the engine sent", () => {
    // A session title is model-influenceable. `picker.ts` escapes it on the way
    // into a quick-pick because VS Code expands `$(check)` into a glyph; this
    // page has no such renderer, so the characters must arrive unescaped and
    // unexpanded — no glyph, and no backslash the engine never sent.
    open();
    panel.send(list({ sessions: [{ ...sessions[0], title: "$(check) Trusted session" }] }));
    const row = panel.byId("sessions-list").all("session-row")[0];
    expect(row?.textContent).toContain("$(check) Trusted session");
    expect(row?.textContent).not.toContain("\\$(check)");
    expect(row?.walk().some((node) => node.tagName === "svg")).toBe(false);
  });

  it("drops a header with no id rather than rendering a row nothing can open", () => {
    open();
    panel.send(list({ sessions: [{ title: "Ghost", createdAt: Date.now() }, ...sessions] }));
    expect(panel.byId("sessions-list").textContent).not.toContain("Ghost");
    expect(panel.byId("sessions-list").all("session-row")).toHaveLength(2);
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

describe("motion, as state rather than decoration", () => {
  /* Appearance is not assertable against a stub with no cascade. What is
   * assertable is the *mechanism*: which class the script puts on which
   * element in response to which state change, and — just as important —
   * which it withholds, because an animation that fires on a repaint is the
   * one that turns a long answer into a strobe. */

  it("lands a newly submitted prompt, and does not re-land a restored transcript", () => {
    // A panel that was hidden and came back gets its whole history in one
    // message. Animating that is a wall of movement describing nothing.
    panel.send(state({ blocks: [{ kind: "user", id: "u1", text: "first" }] }));
    const first = panel.byId("turns").childNodes[0] as StubNode;
    expect(first.className).not.toContain("arc-enter");

    panel.send(
      state({
        blocks: [
          { kind: "user", id: "u1", text: "first" },
          { kind: "text", id: "t1", text: "answer" },
          { kind: "user", id: "u2", text: "second" },
        ],
      }),
    );
    const turns = panel.byId("turns").childNodes as StubNode[];
    expect(turns[0]).toBe(first);
    expect(turns[0]?.className).not.toContain("arc-enter");
    expect(turns[2]?.className).toContain("arc-enter");
  });

  it("shows a working signal in the gap before the first output, and only there", () => {
    const working = panel.byId("working");
    expect(working.classList.contains("hidden")).toBe(true);

    panel.send(state({ running: true, blocks: [{ kind: "user", id: "u1", text: "go" }] }));
    expect(working.classList.contains("hidden")).toBe(false);
    expect(working.textContent).toContain("Working");

    // The caret takes over the moment text starts arriving.
    panel.send(
      state({
        running: true,
        blocks: [
          { kind: "user", id: "u1", text: "go" },
          { kind: "text", id: "t1", text: "Sure" },
        ],
      }),
    );
    expect(working.classList.contains("hidden")).toBe(true);

    panel.send(state({ running: false, blocks: [{ kind: "user", id: "u1", text: "go" }] }));
    expect(working.classList.contains("hidden")).toBe(true);
  });

  it("does not re-animate text that is already on screen", () => {
    // The classic streaming mistake. The caret is a class on the block being
    // written; nothing inside the rendered markdown carries an entrance.
    panel.send(state({ running: true, blocks: [{ kind: "text", id: "t1", text: "Half a sen" }] }));
    panel.send(
      state({ running: true, blocks: [{ kind: "text", id: "t1", text: "Half a sentence." }] }),
    );
    const block = panel.byId("turns").find((node) => node.classList.contains("text-block"));
    expect(block?.className).toContain("streaming");
    const animated = (block?.walk() ?? []).filter(
      (node) => node.classList.contains("arc-enter") || node.classList.contains("arc-pop"),
    );
    expect(animated).toEqual([]);
  });

  it("pops a tool badge when its status settles, and not when it arrives settled", () => {
    panel.send(state({ blocks: [toolBlock({ status: "ok" })] }));
    const settledOnArrival = panel
      .byId("turns")
      .find((node) => node.classList.contains("tool-status"));
    expect(settledOnArrival?.className).not.toContain("arc-pop");

    panel.send(state({ blocks: [toolBlock({ id: "tool:k2", status: "running" })] }));
    panel.send(state({ blocks: [toolBlock({ id: "tool:k2", status: "error" })] }));
    const card = panel.byId("turns").all("tool").at(-1);
    expect(card?.find((node) => node.classList.contains("tool-status"))?.className).toContain(
      "arc-pop",
    );
  });

  it("reveals a tool body the host has just expanded", () => {
    panel.send(state({ blocks: [toolBlock({ collapsed: true })] }));
    panel.send(state({ blocks: [toolBlock({ collapsed: false, result: "done" })] }));
    const body = panel.byId("turns").find((node) => node.classList.contains("tool-body"));
    expect(body?.className).toContain("arc-reveal");
    expect(body?.classList.contains("hidden")).toBe(false);
  });

  it("punctuates the end of a turn, once, and never on a transcript that was never running", () => {
    panel.send(
      state({
        running: false,
        blocks: [
          { kind: "user", id: "u1", text: "go" },
          { kind: "text", id: "t1", text: "done" },
        ],
      }),
    );
    const turn = panel.byId("turns").childNodes[1] as StubNode;
    expect(turn.className).not.toContain("turn-settled");

    panel.send(
      state({
        running: true,
        blocks: [
          { kind: "user", id: "u1", text: "go" },
          { kind: "text", id: "t1", text: "don" },
        ],
      }),
    );
    expect(turn.className).not.toContain("turn-settled");
    panel.send(
      state({
        running: false,
        blocks: [
          { kind: "user", id: "u1", text: "go" },
          { kind: "text", id: "t1", text: "done" },
        ],
      }),
    );
    expect(turn.className).toContain("turn-settled");
  });
});

describe("how code is packaged", () => {
  function render(text: string): StubNode {
    panel.send(state({ blocks: [{ kind: "text", id: "t1", text }] }));
    return panel.byId("turns");
  }

  const long = [
    "```ts",
    ...Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`),
    "```",
  ].join("\n");

  it("folds a long block behind its line count rather than burying the conversation", () => {
    const block = render(long).find((node) => node.classList.contains("code-block"));
    expect(block?.classList.contains("code-clamped")).toBe(true);
    const more = block?.find((node) => node.classList.contains("code-more"));
    expect(more?.textContent).toContain("40 lines");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    more?.dispatch("click");
    expect(block?.classList.contains("code-clamped")).toBe(false);
    expect(more?.getAttribute("aria-expanded")).toBe("true");
    expect(more?.textContent).toContain("Show less");
  });

  it("leaves a short block alone", () => {
    const block = render("```ts\nconst a = 1;\n```").find((node) =>
      node.classList.contains("code-block"),
    );
    expect(block?.classList.contains("code-clamped")).toBe(false);
    expect(block?.find((node) => node.classList.contains("code-more"))).toBeUndefined();
  });

  it("names the file a fence carries, by its basename, with the path in the title", () => {
    const block = render("```ts src/sidebar/webview-client.ts\nconst a = 1;\n```").find((node) =>
      node.classList.contains("code-block"),
    );
    const file = block?.find((node) => node.classList.contains("code-file"));
    expect(file?.textContent).toBe("webview-client.ts");
    expect(file?.title).toBe("src/sidebar/webview-client.ts");
    expect(block?.find((node) => node.classList.contains("code-lang"))?.textContent).toBe("ts");
  });

  it("says a fence is still being written instead of offering to copy half of it", () => {
    const block = render("```py\nprint(").find((node) => node.classList.contains("code-block"));
    expect(block?.classList.contains("code-open")).toBe(true);
    expect(block?.find((node) => node.classList.contains("code-copy"))).toBeUndefined();
    expect(block?.textContent).toContain("writing");
    // A fence the model has not closed never folds: it would fold around the
    // top while the tail is what the reader is watching.
    expect(block?.classList.contains("code-clamped")).toBe(false);
  });

  it("does not rebuild a settled block when a later one arrives", () => {
    // The fold is view state that lives in the element, so a repaint throws
    // it away — along with the reader's text selection and their scroll
    // position inside the block. Grouping is computed per block on every
    // render, and it must not become a field that changes under a *text*
    // block every time something lands after it.
    panel.send(state({ blocks: [{ kind: "text", id: "t1", text: long }] }));
    const before = panel.byId("turns").find((node) => node.classList.contains("code-block"));
    before?.find((node) => node.classList.contains("code-more"))?.dispatch("click");
    expect(before?.classList.contains("code-clamped")).toBe(false);

    panel.send(state({ blocks: [{ kind: "text", id: "t1", text: long }, toolBlock({ id: "a" })] }));
    const after = panel.byId("turns").find((node) => node.classList.contains("code-block"));
    expect(after).toBe(before);
    expect(after?.classList.contains("code-clamped")).toBe(false);
  });

  it("stacks consecutive tool calls into one card and leaves a lone one alone", () => {
    panel.send(state({ blocks: [toolBlock({ id: "tool:a" })] }));
    expect(panel.byId("turns").all("tool")[0]?.className).toContain("tool-group-solo");

    panel.send(
      state({
        blocks: [
          toolBlock({ id: "tool:a" }),
          toolBlock({ id: "tool:b" }),
          toolBlock({ id: "tool:c" }),
          { kind: "text", id: "t1", text: "and there you go" },
        ],
      }),
    );
    expect(
      panel
        .byId("turns")
        .all("tool")
        .map((node) => node.className),
    ).toEqual([
      expect.stringContaining("tool-group-first"),
      expect.stringContaining("tool-group-mid"),
      expect.stringContaining("tool-group-last"),
    ]);
  });
});

describe("deleting a session from the history list", () => {
  const HOUR = 3_600_000;
  const rows = [
    { sessionId: "01JOLDEST", title: "Find the setModel bug", createdAt: Date.now() - 50 * HOUR },
    { sessionId: "01JNEWEST", title: "Rebuild the sidebar", createdAt: Date.now() - 3 * HOUR },
  ];

  function open(): void {
    panel.byId("sessions").dispatch("click");
    panel.send({ type: "showSessions" });
  }

  function list(over: Record<string, unknown> = {}): unknown {
    return {
      type: "sessions",
      status: "ready",
      sessions: rows,
      current: "01JNEWEST",
      cwd: "/repo/arcturn",
      ...over,
    };
  }

  function deletes(): StubNode[] {
    return panel.byId("sessions-list").all("session-delete");
  }

  it("puts a delete button on every row, naming what it would delete", () => {
    open();
    panel.send(list());
    expect(deletes()).toHaveLength(2);
    expect(deletes()[0]?.tagName).toBe("button");
    expect(deletes()[0]?.getAttribute("aria-label")).toContain("Rebuild the sidebar");
  });

  it("posts exactly the verb the host is listening for", () => {
    open();
    panel.send(list());
    deletes()[1]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "deleteSession", sessionId: "01JOLDEST" });
  });

  it("does not open the session it was asked to delete", () => {
    // Two intents on one row. Deleting must not also be picking.
    open();
    panel.send(list());
    deletes()[0]?.dispatch("click");
    expect(panel.posted.filter((message) => message.type === "openSession")).toHaveLength(0);
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(false);
  });

  it("leaves the row on screen until the host sends a list without it", () => {
    // The host raises a native modal and may be told no. A row that vanishes
    // on click would say a session is gone that is still there.
    open();
    panel.send(list());
    deletes()[0]?.dispatch("click");
    expect(panel.byId("sessions-list").all("session-row")).toHaveLength(2);
    expect(panel.byId("sessions-list").textContent).toContain("Rebuild the sidebar");
    panel.send(list({ sessions: [rows[0]], current: undefined }));
    expect(panel.byId("sessions-list").all("session-row")).toHaveLength(1);
    expect(panel.byId("sessions-list").textContent).not.toContain("Rebuild the sidebar");
  });

  it("is reachable without a mouse: Delete removes the highlighted row", () => {
    // A control that only exists on hover does not exist for a keyboard user.
    open();
    panel.send(list());
    const search = panel.byId("sessions-search");
    expect(search.getAttribute("aria-activedescendant")).toBe("session-row-0");
    search.dispatch("keydown", { key: "ArrowDown" });
    search.dispatch("keydown", { key: "Delete" });
    expect(panel.posted.at(-1)).toEqual({ type: "deleteSession", sessionId: "01JOLDEST" });
    // …and the list is still up, because the host has not answered yet.
    expect(panel.byId("sessions-view").classList.contains("hidden")).toBe(false);
  });

  it("does not delete when no row is highlighted", () => {
    open();
    panel.send(list({ sessions: [], current: undefined }));
    panel.byId("sessions-search").dispatch("keydown", { key: "Delete" });
    expect(panel.posted.filter((message) => message.type === "deleteSession")).toHaveLength(0);
  });

  it("keeps the row itself the option a screen reader reads", () => {
    // The delete button rides in a presentational wrapper so the listbox's
    // children are still the rows, and aria-activedescendant still resolves.
    open();
    panel.send(list());
    const row = panel.byId("sessions-list").all("session-row")[0];
    expect(row?.getAttribute("role")).toBe("option");
    expect(row?.getAttribute("id")).toBe("session-row-0");
    expect(row?.parentNode?.getAttribute("role")).toBe("presentation");
    expect(deletes()[0]?.parentNode).toBe(row?.parentNode);
  });
});

/* ------------------------------------------------------------------ */
/* RFC 0005 §2 — the composer                                          */
/* ------------------------------------------------------------------ */

const contextItems = [
  {
    id: "src/auth.ts",
    path: "src/auth.ts",
    label: "src/auth.ts",
    bytes: 4300,
    kind: "file",
    ok: true,
  },
  {
    id: "docs/plan.md",
    path: "docs/plan.md",
    label: "docs/plan.md",
    bytes: 812,
    kind: "file",
    ok: true,
  },
];

describe("the @ context picker", () => {
  it("asks the host what a mention resolves to, rather than guessing", () => {
    panel.type("@auth");
    panel.flushTimers();
    expect(panel.posted.at(-1)).toEqual({ type: "resolveContext", query: "auth" });
  });

  it("shows the engine's own size on every row, which is the point of the round trip", () => {
    panel.type("@auth");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "auth", items: contextItems });
    const rows = panel.byId("suggest-list").all("suggest-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("src/auth.ts");
    expect(rows[0]?.textContent).toContain("4.2 KB");
  });

  it("says why a file cannot be attached instead of quietly omitting it", () => {
    panel.type("@../../etc/passwd");
    panel.flushTimers();
    panel.send({
      type: "contextCandidates",
      query: "../../etc/passwd",
      items: [
        {
          id: "/etc/passwd",
          path: "/etc/passwd",
          label: "/etc/passwd",
          bytes: 0,
          kind: "missing",
          ok: false,
          reason: "outside the workspace",
        },
      ],
    });
    expect(panel.byId("suggest-list").textContent).toContain("outside the workspace");
  });

  it("attaches on click and takes the @ text back out of the composer", () => {
    panel.type("look at @auth");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "auth", items: contextItems });
    panel.byId("suggest-list").all("suggest-row")[0]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "attach", paths: ["src/auth.ts"] });
    // The chip is the whole truth about what the prompt carries, so the
    // mention that opened the picker does not also ride along in the text.
    expect(panel.byId("prompt").value).toBe("look at ");
  });

  it("is usable from the keyboard alone", () => {
    panel.type("@auth");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "auth", items: contextItems });
    const prompt = panel.byId("prompt");
    // The first row is already highlighted, the way a completion menu is, so
    // one press moves to the second.
    prompt.dispatch("keydown", { key: "ArrowDown" });
    prompt.dispatch("keydown", { key: "Enter" });
    expect(panel.posted.at(-1)).toEqual({ type: "attach", paths: ["docs/plan.md"] });
    expect(panel.posted.filter((message) => message.type === "send")).toHaveLength(0);
  });

  it("closes on Escape and leaves what was typed alone", () => {
    panel.type("@auth");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "auth", items: contextItems });
    expect(panel.byId("suggest").classList.contains("hidden")).toBe(false);
    panel.byId("prompt").dispatch("keydown", { key: "Escape" });
    expect(panel.byId("suggest").classList.contains("hidden")).toBe(true);
    expect(panel.byId("prompt").value).toBe("@auth");
  });

  it("closes once the mention is finished, so a space returns the box to prose", () => {
    panel.type("@auth");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "auth", items: contextItems });
    panel.type("@auth ");
    expect(panel.byId("suggest").classList.contains("hidden")).toBe(true);
  });

  it("ignores an answer to a query the user has already typed past", () => {
    panel.type("@auth");
    panel.flushTimers();
    panel.type("@authz");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "auth", items: contextItems });
    expect(panel.byId("suggest-list").all("suggest-row")).toHaveLength(0);
  });

  it("opens from the composer's own button as well as from typing", () => {
    panel.byId("context").dispatch("click");
    expect(panel.byId("prompt").value).toBe("@");
    panel.flushTimers();
    expect(panel.posted.at(-1)).toEqual({ type: "resolveContext", query: "" });
  });

  it("renders codicon syntax in a path as the characters the engine sent", () => {
    panel.type("@x");
    panel.flushTimers();
    panel.send({
      type: "contextCandidates",
      query: "x",
      items: [
        { ...contextItems[0], id: "$(check)/x.ts", path: "$(check)/x.ts", label: "$(check)/x.ts" },
      ],
    });
    expect(panel.byId("suggest-list").textContent).toContain("$(check)");
  });
});

describe("the chips above the composer", () => {
  it("shows what is attached, with its real size, and nothing when nothing is", () => {
    expect(panel.byId("chips").classList.contains("hidden")).toBe(true);
    panel.send({ type: "context", items: contextItems });
    expect(panel.byId("chips").classList.contains("hidden")).toBe(false);
    const chips = panel.byId("chips").all("context-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toContain("auth.ts");
    expect(chips[0]?.textContent).toContain("4.2 KB");
  });

  it("removes one by asking the host, which owns the set the prompt will carry", () => {
    panel.send({ type: "context", items: contextItems });
    panel.byId("chips").all("chip-remove")[0]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "detach", id: "src/auth.ts" });
    // Nothing is removed here: the row is a render of the host's set, and a
    // chip that vanished before the host agreed would be the panel and the
    // prompt disagreeing about what is attached.
    expect(panel.byId("chips").all("context-chip")).toHaveLength(2);
  });

  it("marks a chip the engine refused, so it is visibly not going to be sent", () => {
    panel.send({
      type: "context",
      items: [
        {
          id: "big.bin",
          path: "big.bin",
          label: "big.bin",
          bytes: 0,
          kind: "other",
          ok: false,
          reason: "not a text file",
        },
      ],
    });
    const chip = panel.byId("chips").all("context-chip")[0];
    expect(chip?.classList.contains("chip-bad")).toBe(true);
    expect(chip?.textContent).toContain("not a text file");
  });

  it("attaches a file dropped on the panel through the same set", () => {
    panel.onDocument("drop", {
      dataTransfer: {
        getData: (type: string) =>
          type === "text/uri-list" ? "file:///w/src/auth.ts\nfile:///w/docs/plan.md" : "",
        files: [],
        items: [],
      },
    });
    expect(panel.posted.at(-1)).toEqual({
      type: "attach",
      paths: ["file:///w/src/auth.ts", "file:///w/docs/plan.md"],
    });
  });

  it("sends a pasted image as bytes, because a paste has no path", () => {
    panel.byId("prompt").dispatch("paste", {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => ({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
          },
        ],
      },
    });
    expect(panel.posted.at(-1)).toEqual({
      type: "attachImage",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
  });

  it("leaves a pasted text clipboard to the textarea", () => {
    const before = panel.posted.length;
    panel.byId("prompt").dispatch("paste", {
      clipboardData: { items: [{ kind: "string", type: "text/plain" }] },
    });
    expect(panel.posted.length).toBe(before);
  });

  it("asks the host to open its own file dialog, which is the only one that yields a path", () => {
    panel.byId("attach").dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "browseForFiles" });
  });
});

describe("the ambient chip — the file the user is looking at", () => {
  const ambient = {
    id: "src/auth.ts",
    path: "src/auth.ts",
    label: "src/auth.ts",
    bytes: 4300,
    kind: "file",
    ok: true,
  };

  it("appears with the explicit chips and is not one of them", () => {
    // The distinction is the whole point. An `@` chip is a thing the user put
    // there and that stays until they remove it; this one changes under them
    // as they move around the editor, and a row where those two look identical
    // is a row that lies about which of its entries is stable.
    panel.send({ type: "context", items: contextItems, active: ambient });
    const chips = panel.byId("chips").all("context-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0]?.classList.contains("chip-ambient")).toBe(true);
    expect(chips[1]?.classList.contains("chip-ambient")).toBe(false);
    expect(chips[2]?.classList.contains("chip-ambient")).toBe(false);
  });

  it("names the file and says its contents are NOT sent, when nothing is selected", () => {
    // The size used to be here, and was true while an open file was attached
    // whole. It travels as `kind: "fileReference"` now — a path and none of
    // the bytes — so the chip must not put a weight next to something that is
    // not being weighed.
    panel.send({ type: "context", items: [], active: ambient });
    const chip = panel.byId("chips").all("context-chip")[0];
    expect(chip?.textContent).toContain("src/auth.ts");
    expect(chip?.textContent).toContain("path only, contents not sent");
    expect(chip?.textContent).not.toContain("4.2 KB");
    // The hover carries the rest: what happens instead, and what it saves.
    expect(chip?.title).toContain("read");
    expect(chip?.title).toContain("4.2 KB a turn");
  });

  it("shows the selected lines, and counts them, because that is what goes", () => {
    panel.send({
      type: "context",
      items: [],
      active: { ...ambient, label: "src/auth.ts:12-40", selection: { startLine: 12, endLine: 40 } },
    });
    const chip = panel.byId("chips").all("context-chip")[0];
    expect(chip?.textContent).toContain("src/auth.ts:12-40");
    expect(chip?.textContent).toContain("29 lines");
    expect(chip?.textContent).not.toContain("whole file");
    // Nothing extra on the hover: the excerpt is exactly what is sent, so
    // there is nothing surprising left to explain. This assertion inverted
    // when the wire learned to carry a range.
    expect(chip?.title).toBe("src/auth.ts:12-40\n29 lines of 4.2 KB");
  });

  it("shows the engine's refusal for a file outside the workspace", () => {
    // Not hidden and not silently dropped: somebody reading a file the engine
    // will not touch has to see that before they press send, or the answer
    // they get is about nothing.
    panel.send({
      type: "context",
      items: [],
      active: {
        ...ambient,
        id: "/etc/passwd",
        path: "/etc/passwd",
        label: "/etc/passwd",
        bytes: 0,
        kind: "missing",
        ok: false,
        reason: "escapes the workspace",
      },
    });
    const chip = panel.byId("chips").all("context-chip")[0];
    expect(chip?.classList.contains("chip-bad")).toBe(true);
    expect(chip?.textContent).toContain("escapes the workspace");
  });

  it("shows no chip row at all when there is no file and nothing attached", () => {
    panel.send({ type: "context", items: [], active: ambient });
    expect(panel.byId("chips").classList.contains("hidden")).toBe(false);
    panel.send({ type: "context", items: [] });
    expect(panel.byId("chips").classList.contains("hidden")).toBe(true);
    expect(panel.byId("chips").all("context-chip")).toHaveLength(0);
  });

  it("turns the watching off rather than pretending to remove a chip", () => {
    // A dismiss that only cleared this one chip would be undone by the next
    // keystroke in the editor. The control does the thing it can actually do.
    panel.send({ type: "context", items: [], active: ambient });
    const dismiss = panel.byId("chips").all("chip-remove")[0];
    expect(dismiss?.getAttribute("aria-label")).toContain("Stop");
    dismiss?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "disableActiveEditorContext" });
  });

  it("does not detach the ambient chip, which the host does not hold in that set", () => {
    panel.send({ type: "context", items: contextItems, active: ambient });
    const removes = panel.byId("chips").all("chip-remove");
    removes[1]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "detach", id: "src/auth.ts" });
  });

  it("renders codicon syntax in the path as the characters the engine sent", () => {
    panel.send({
      type: "context",
      items: [],
      active: { ...ambient, id: "$(check)/a.ts", path: "$(check)/a.ts", label: "$(check)/a.ts:3" },
    });
    expect(panel.byId("chips").textContent).toContain("$(check)");
  });

  it("ignores an ambient chip that is not a record, rather than throwing at the row", () => {
    panel.send({ type: "context", items: contextItems, active: "src/auth.ts" });
    expect(panel.byId("chips").all("chip-ambient")).toHaveLength(0);
    expect(panel.byId("chips").all("context-chip")).toHaveLength(2);
  });
});

describe("the / command menu", () => {
  const commands = [
    {
      name: "review",
      description: "Review the diff for bugs",
      kind: "skill",
      source: "/w/.arcturn/skills/review.md",
    },
    { name: "changelog", description: "Write a changelog entry", kind: "skill" },
    { name: "model", description: "Switch the model", kind: "builtin" },
    { name: "theme", description: "Change the terminal theme", kind: "builtin" },
  ];

  function open(text = "/"): void {
    panel.type(text);
    panel.send({ type: "commands", status: "ready", commands });
  }

  it("asks the host for the list when the composer opens the menu", () => {
    panel.type("/");
    expect(panel.posted.filter((message) => message.type === "requestCommands")).toHaveLength(1);
  });

  it("puts skills first with their descriptions, then the built-ins", () => {
    open();
    const rows = panel.byId("suggest-list").all("suggest-row");
    expect(
      rows.map((row) => row.find((node) => node.classList.contains("suggest-name"))?.textContent),
    ).toEqual(["/changelog", "/review", "/model"]);
    expect(rows[1]?.textContent).toContain("Review the diff for bugs");
    expect(rows[1]?.textContent).toContain("review.md");
  });

  it("lists no command the panel cannot run — RFC 0005 §3", () => {
    // `theme` rather than `rewind`: the panel grew a rewind picker, so
    // `/rewind` is now a row it can honour. `theme` is a terminal concern with
    // nothing behind it here, which is what this rule is actually about.
    open();
    expect(panel.byId("suggest-list").textContent).not.toContain("theme");
  });

  it("offers /rewind, which opens the picker rather than sending prompt text", () => {
    open();
    panel.send({
      type: "commands",
      status: "ready",
      commands: [
        { name: "rewind", description: "Restore files to an earlier turn", kind: "builtin" },
      ],
    });
    const rows = panel.byId("suggest-list").all("suggest-row");
    expect(rows).toHaveLength(1);
    rows[0]?.dispatch("click");
    // The picker asks the engine; nothing is sent as a prompt.
    expect(panel.posted.some((message) => message.type === "requestCheckpoints")).toBe(true);
    expect(panel.posted.some((message) => message.type === "send")).toBe(false);
  });

  it("filters as you type", () => {
    open("/rev");
    const rows = panel.byId("suggest-list").all("suggest-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("/review");
  });

  it("inserts a skill rather than sending it, because execution stays prompt", () => {
    open("/rev");
    panel.byId("prompt").dispatch("keydown", { key: "Enter" });
    expect(panel.byId("prompt").value).toBe("/review ");
    expect(panel.posted.filter((message) => message.type === "send")).toHaveLength(0);
  });

  it("runs a built-in on the surface the panel already has for it", () => {
    open("/model");
    panel.byId("suggest-list").all("suggest-row")[0]?.dispatch("click");
    expect(panel.byId("model-popover").classList.contains("hidden")).toBe(false);
    expect(panel.byId("prompt").value).toBe("");
  });

  it("says nothing at all when the engine cannot list commands", () => {
    panel.type("/");
    panel.send({ type: "commands", status: "unavailable", commands: [] });
    expect(panel.byId("suggest").classList.contains("hidden")).toBe(true);
  });

  it("renders codicon syntax in a skill description as the characters it was sent", () => {
    panel.type("/");
    panel.send({
      type: "commands",
      status: "ready",
      commands: [{ name: "x", description: "\\$(verified) Trusted", kind: "skill" }],
    });
    expect(panel.byId("suggest-list").textContent).toContain("\\$(verified)");
  });
});

describe("the permission mode chip", () => {
  it("says nothing about a mode until the engine has named one", () => {
    expect(panel.byId("mode-label").textContent).toBe("Permissions");
  });

  it("names the mode in force and what it grants", () => {
    panel.send({ type: "permission", status: "ready", mode: "plan", tools: ["read"] });
    expect(panel.byId("mode-label").textContent).toBe("Plan");
    panel.byId("mode").dispatch("click");
    const rows = panel.byId("mode-list").all("mode-row");
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.textContent).join(" ")).toContain("no edits, no commands");
  });

  it("asks the engine to change mode rather than deciding for itself", () => {
    panel.send({ type: "permission", status: "ready", mode: "default", tools: ["read"] });
    panel.byId("mode").dispatch("click");
    panel.byId("mode-list").all("mode-row")[2]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "setPermissionMode", mode: "plan" });
    // The chip does not move on the click: the engine's answer moves it, so a
    // refused change never leaves the panel claiming a mode that is not in
    // force. RFC 0005 §1.2.
    expect(panel.byId("mode-label").textContent).toBe("Default");
  });

  it("moves only when the engine says the mode is what it now is", () => {
    panel.send({ type: "permission", status: "ready", mode: "yolo", tools: ["read"] });
    expect(panel.byId("mode-label").textContent).toBe("Yolo");
  });

  it("says the engine is too old rather than showing a chip that lies", () => {
    panel.send({ type: "permission", status: "unavailable", tools: [] });
    expect(panel.byId("mode-label").textContent).toBe("Permissions");
    panel.byId("mode").dispatch("click");
    expect(panel.byId("mode-status").textContent).toMatch(/too old/i);
  });

  it("repeats the engine's refusal instead of failing silently", () => {
    panel.send({ type: "permission", status: "ready", mode: "default", tools: ["read"] });
    panel.byId("mode").dispatch("click");
    panel.send({
      type: "permission",
      status: "ready",
      mode: "default",
      tools: ["read"],
      note: "A run is in flight. Stop it, or wait for it to finish, and try again.",
    });
    expect(panel.byId("mode-status").textContent).toContain("A run is in flight");
    expect(panel.byId("mode-label").textContent).toBe("Default");
  });

  it("asks for the state when the connection comes up", () => {
    expect(
      panel.posted.filter((message) => message.type === "requestPermission").length,
    ).toBeGreaterThan(0);
  });
});

describe("the rewind picker", () => {
  function checkpoints(
    rows: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): unknown {
    return {
      type: "rewind",
      view: { status: "ready", truncated: false, checkpoints: rows, ...extra },
    };
  }

  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "turn-1",
      confirmation: "deadbeefdeadbeefdeadbeefdeadbeef",
      label: "add rate limiting",
      timestamp: 1_700_000_000_000,
      fileCount: 2,
      deleteCount: 1,
      detail: "2 files · 1 deleted",
      ...overrides,
    };
  }

  function openPicker(): void {
    panel.type("/");
    panel.send({
      type: "commands",
      status: "ready",
      commands: [{ name: "rewind", description: "Restore files", kind: "builtin" }],
    });
    panel.byId("suggest-list").all("suggest-row")[0]?.dispatch("click");
  }

  it("stays closed until something opens it, and asks the engine when it does", () => {
    // Unlike the review card, this is not fetched on load: a picker nobody
    // opened is a round trip nobody asked for, and it deletes files.
    expect(panel.posted.filter((message) => message.type === "requestCheckpoints")).toHaveLength(0);
    openPicker();
    expect(panel.byId("rewind-view").classList.contains("hidden")).toBe(false);
    expect(panel.posted.filter((message) => message.type === "requestCheckpoints")).toHaveLength(1);
  });

  it("shows what each turn would change, next to the turn", () => {
    openPicker();
    panel.send(checkpoints([row(), row({ id: "turn-2", label: "fix login", detail: "1 file" })]));
    const rows = panel.byId("rewind-list").all("rewind-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("add rate limiting");
    expect(rows[0]?.textContent).toContain("2 files · 1 deleted");
    expect(rows[1]?.textContent).toContain("1 file");
  });

  it("colours a row that would delete something, and leaves one that would not", () => {
    openPicker();
    panel.send(checkpoints([row(), row({ id: "turn-2", deleteCount: 0, detail: "1 file" })]));
    const metas = panel.byId("rewind-list").all("rewind-meta");
    expect(metas[0]?.classList.contains("deletes")).toBe(true);
    expect(metas[1]?.classList.contains("deletes")).toBe(false);
  });

  it("carries the confirmation back verbatim, and nothing else", () => {
    // The page is a courier for this token. A page that regenerated it would
    // be vouching for a cost it did not compute.
    openPicker();
    panel.send(checkpoints([row()]));
    panel.byId("rewind-list").all("rewind-row")[0]?.dispatch("click");
    const sent = panel.posted.find((message) => message.type === "rewindTo");
    expect(sent).toEqual({
      type: "rewindTo",
      checkpointId: "turn-1",
      confirmation: "deadbeefdeadbeefdeadbeefdeadbeef",
    });
  });

  it("drops a row with no id or no confirmation rather than rendering a dead button", () => {
    openPicker();
    panel.send(
      checkpoints([
        row({ confirmation: "" }),
        row({ id: "", confirmation: "x" }),
        row({ id: "ok" }),
      ]),
    );
    const rows = panel.byId("rewind-list").all("rewind-row");
    expect(rows).toHaveLength(1);
  });

  it("says which of the three 'no rewind' stories applies", () => {
    openPicker();
    panel.send({ type: "rewind", view: { status: "off", checkpoints: [], truncated: false } });
    expect(panel.byId("rewind-status").textContent).toContain("keeps no file checkpoints");
    panel.send({
      type: "rewind",
      view: { status: "unavailable", checkpoints: [], truncated: false },
    });
    expect(panel.byId("rewind-status").textContent).toContain("too old to rewind");
    panel.send(checkpoints([]));
    expect(panel.byId("rewind-status").textContent).toContain("No checkpoints in this session yet");
  });

  it("prints the engine's refusal where the user is looking", () => {
    openPicker();
    panel.send(
      checkpoints([row()], { note: "A run is in flight. Stop it, or wait for it to finish." }),
    );
    expect(panel.byId("rewind-status").textContent).toContain("A run is in flight");
  });

  it("states the cost once, above the list, rather than on every row", () => {
    // A warning repeated N times reads as decoration by the third.
    openPicker();
    expect(panel.byId("rewind-warning").textContent).toContain("cannot be undone");
  });

  it("has no Enter action — rows are clicked, not defaulted into", () => {
    openPicker();
    panel.send(checkpoints([row()]));
    panel.byId("prompt").dispatch("keydown", { key: "Enter", shiftKey: false });
    expect(panel.posted.some((message) => message.type === "rewindTo")).toBe(false);
  });
});

describe("the dry-run review card", () => {
  function pending(count: number, extra: Record<string, unknown> = {}): unknown {
    return {
      type: "dryRun",
      view: {
        status: "ready",
        truncated: false,
        changes: Array.from({ length: count }, (_, index) => ({
          path: `src/file-${String(index)}.ts`,
          label: `src/file-${String(index)}.ts`,
          kind: index === 0 ? "modified" : "added",
          detail: "1.0 kB → 2.0 kB",
        })),
        ...extra,
      },
    };
  }

  it("asks what is pending as soon as the page loads, without being opened", () => {
    // The whole point of the card: a user must not have to remember to look.
    expect(panel.posted.filter((message) => message.type === "requestDryRun").length).toBe(1);
  });

  it("shows nothing until the engine says something is waiting", () => {
    expect(panel.byId("dryrun").classList.contains("hidden")).toBe(true);
    panel.send(pending(0));
    expect(panel.byId("dryrun").classList.contains("hidden")).toBe(true);
  });

  it("appears with a count and one row per file the moment changes are pending", () => {
    panel.send(pending(2));
    expect(panel.byId("dryrun").classList.contains("hidden")).toBe(false);
    expect(panel.byId("dryrun-text").textContent).toBe("2 files pending review");
    expect(panel.byId("dryrun-files").all("dryrun-file")).toHaveLength(2);
  });

  it("stays hidden for an engine that is not holding anything back", () => {
    // A review affordance over an engine with no shadow tree would imply a
    // safety net that is not there. RFC 0005 §3.
    panel.send({ type: "dryRun", view: { status: "off", changes: [], truncated: false } });
    expect(panel.byId("dryrun").classList.contains("hidden")).toBe(true);
    panel.send({ type: "dryRun", view: { status: "unavailable", changes: [], truncated: false } });
    expect(panel.byId("dryrun").classList.contains("hidden")).toBe(true);
  });

  it("says out loud when the engine would not list the whole set", () => {
    panel.send(pending(2, { truncated: true }));
    expect(panel.byId("dryrun-text").textContent).toMatch(/more than the engine will list/);
  });

  it("asks the host to open the diff for the file that was clicked", () => {
    panel.send(pending(2));
    panel.byId("dryrun-files").all("dryrun-file")[1]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "showDiff", path: "src/file-1.ts" });
  });

  it("opens the review from the card's own button", () => {
    panel.send(pending(1));
    panel.byId("dryrun-review").dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "showDiff" });
  });

  it("asks the host to apply, and never writes anything itself", () => {
    panel.send(pending(1));
    panel.byId("dryrun-apply").dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "applyChanges" });
  });

  it("sends discard bare, and raises no confirmation of its own", () => {
    panel.send(pending(1));
    panel.byId("dryrun-discard").dispatch("click");
    // The modal is the host's — a webview button that says "are you sure" is a
    // button, not a confirmation.
    expect(panel.posted.at(-1)).toEqual({ type: "discardChanges" });
  });

  it("cannot send a second apply before the host has answered the first", () => {
    panel.send(pending(1));
    panel.byId("dryrun-apply").dispatch("click");
    panel.byId("dryrun-apply").dispatch("click");
    panel.byId("dryrun-discard").dispatch("click");
    expect(panel.posted.filter((message) => message.type === "applyChanges")).toHaveLength(1);
    expect(panel.posted.filter((message) => message.type === "discardChanges")).toHaveLength(0);
  });

  it("takes the buttons back the moment the host answers", () => {
    panel.send(pending(1));
    panel.byId("dryrun-apply").dispatch("click");
    panel.send(pending(1));
    panel.byId("dryrun-apply").dispatch("click");
    expect(panel.posted.filter((message) => message.type === "applyChanges")).toHaveLength(2);
  });

  it("repeats the engine's refusal rather than failing silently", () => {
    panel.send(
      pending(1, {
        note: "A run is in flight. Stop it, or wait for it to finish, and apply then.",
      }),
    );
    expect(panel.byId("dryrun-note").classList.contains("hidden")).toBe(false);
    expect(panel.byId("dryrun-note").textContent).toContain("A run is in flight");
    // The card still says what is pending: a refusal changes nothing about it.
    expect(panel.byId("dryrun-text").textContent).toBe("1 file pending review");
  });

  it("drops a row the host did not identify rather than rendering a blank one", () => {
    panel.send({
      type: "dryRun",
      view: {
        status: "ready",
        truncated: false,
        changes: [{ label: "no path here", kind: "modified", detail: "" }],
      },
    });
    expect(panel.byId("dryrun").classList.contains("hidden")).toBe(true);
  });
});

describe("the / menu runs the review loop's built-ins", () => {
  function offer(): void {
    panel.send({
      type: "commands",
      status: "ready",
      commands: [
        { name: "diff", description: "Show pending dry-run changes", kind: "builtin" },
        { name: "apply", description: "Apply pending dry-run changes", kind: "builtin" },
        { name: "discard", description: "Throw away pending dry-run changes", kind: "builtin" },
      ],
    });
  }

  function choose(name: string): void {
    offer();
    panel.type("/");
    panel.flushTimers();
    const rows = panel.byId("suggest-list").all("suggest-row");
    const row = rows.find((candidate) => candidate.textContent.includes(`/${name}`));
    row?.dispatch("click");
  }

  it("lists all three, because the panel has a surface for each", () => {
    offer();
    panel.type("/");
    panel.flushTimers();
    const text = panel
      .byId("suggest-list")
      .all("suggest-row")
      .map((row) => row.textContent);
    expect(text.join(" ")).toContain("/diff");
    expect(text.join(" ")).toContain("/apply");
    expect(text.join(" ")).toContain("/discard");
  });

  it("runs the card's own controls rather than sending the name as a prompt", () => {
    choose("diff");
    expect(panel.posted.at(-1)).toEqual({ type: "showDiff" });
    expect(panel.byId("prompt").value).toBe("");

    choose("apply");
    expect(panel.posted.at(-1)).toEqual({ type: "applyChanges" });

    // A fresh answer clears the page's in-flight guard between the two.
    panel.send({ type: "dryRun", view: { status: "ready", changes: [], truncated: false } });
    choose("discard");
    expect(panel.posted.at(-1)).toEqual({ type: "discardChanges" });
  });
});

describe("the capability line in the empty state", () => {
  it("says nothing while the engine has not reported its tools", () => {
    panel.send(state());
    expect(panel.byId("capability").classList.contains("hidden")).toBe(true);
  });

  it("names what this engine can do, the web included, when it can reach it", () => {
    panel.send(state());
    panel.send({
      type: "permission",
      status: "ready",
      mode: "default",
      tools: ["read", "edit", "bash", "fetch"],
    });
    const line = panel.byId("capability");
    expect(line.classList.contains("hidden")).toBe(false);
    expect(line.textContent).toMatch(/web/i);
  });

  it("says nothing about the web on an engine with no fetch, and shows no button for it", () => {
    panel.send(state());
    panel.send({
      type: "permission",
      status: "ready",
      mode: "default",
      tools: ["read", "edit", "bash"],
    });
    expect(panel.byId("capability").textContent).not.toMatch(/web|brows/i);
    // RFC 0005 §3: no capability implied by an affordance.
    expect(panel.root.all("browse").length).toBe(0);
  });
});

describe("the composer's menus and the keys they share with it", () => {
  it("hands Enter back to the composer when the menu is showing nothing", () => {
    panel.type("@zzzz");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "zzzz", items: [], status: "ready" });
    expect(panel.byId("suggest-list").all("suggest-row")).toHaveLength(0);
    panel.byId("prompt").dispatch("keydown", { key: "Enter" });
    expect(panel.posted.at(-1)).toEqual({ type: "send", text: "@zzzz" });
  });

  it("closes the menu when the message it was completing is sent", () => {
    panel.type("@auth");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "auth", items: contextItems });
    expect(panel.byId("suggest").classList.contains("hidden")).toBe(false);
    panel.byId("send").dispatch("click");
    expect(panel.byId("suggest").classList.contains("hidden")).toBe(true);
  });

  it("closes the picker rather than claiming the workspace has no files", () => {
    panel.type("@auth");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "auth", items: contextItems });
    // Open, with rows, and then the engine turns out not to have the verb.
    expect(panel.byId("suggest").classList.contains("hidden")).toBe(false);
    panel.type("@authe");
    panel.flushTimers();
    panel.send({ type: "contextCandidates", query: "authe", items: [], status: "unavailable" });
    expect(panel.byId("suggest").classList.contains("hidden")).toBe(true);
  });

  it("keeps focus in the composer when a row is clicked, so the click lands", () => {
    // Without this the mousedown blurs the textarea, blur closes the popover,
    // the row leaves the document and the click never happens.
    let prevented = false;
    panel.byId("suggest").dispatch("mousedown", {
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });
});

describe("the workflow surface", () => {
  function catalog(extra: Record<string, unknown> = {}): unknown {
    return {
      type: "workflows",
      view: {
        status: "ready",
        workflows: [
          {
            name: "ship-fix",
            label: "ship-fix",
            description: "Reproduce, patch and review one bug report",
            source: "/ws/.arcturn/workflows/ship-fix.md",
            stages: 3,
            steps: 4,
            budgetUsd: 15,
            roles: [
              { label: "auditor", lane: "read" },
              { label: "developer", lane: "write" },
            ],
          },
        ],
        ...extra,
      },
    };
  }

  function run(extra: Record<string, unknown> = {}): unknown {
    return {
      type: "workflows",
      view: {
        status: "ready",
        workflows: [],
        run: {
          runId: "run-1",
          workflow: "ship-fix",
          state: "running",
          stage: 2,
          stageCount: 3,
          stepsDone: 1,
          stepsTotal: 4,
          spentUsd: 1.5,
          budgetUsd: 15,
          questions: [],
          ...extra,
        },
      },
    };
  }

  /** Open the catalog the way a person does: the `/` menu's `/workflow` row. */
  function openCatalog(): void {
    panel.send({
      type: "commands",
      status: "ready",
      commands: [{ name: "workflow", description: "Run a workflow", kind: "builtin" }],
    });
    panel.type("/");
    panel.flushTimers();
    panel.byId("suggest-list").all("suggest-row")[0]?.dispatch("click");
  }

  it("shows nothing until something opens it", () => {
    expect(panel.byId("wf").classList.contains("hidden")).toBe(true);
  });

  it("opens on the / menu's workflow row and asks the engine for the catalog", () => {
    openCatalog();
    expect(panel.posted.filter((message) => message.type === "requestWorkflows")).toHaveLength(1);
    // The row opened a panel surface rather than inserting text — a `/workflow`
    // pasted into the composer would send the model a message about wanting to
    // run a pipeline.
    expect(panel.byId("prompt").value).toBe("");
  });

  it("lists each pipeline with its ceiling and a chip per role's derived lane", () => {
    openCatalog();
    panel.send(catalog());
    expect(panel.byId("wf").classList.contains("hidden")).toBe(false);
    const rows = panel.byId("wf-list").all("wf-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("ship-fix");
    expect(rows[0]?.textContent).toContain("$15.00");
    expect(rows[0]?.textContent).toContain("@auditor read");
    expect(rows[0]?.textContent).toContain("@developer write");
  });

  it("says a pipeline with no budgetUsd is unbounded rather than showing $0.00", () => {
    openCatalog();
    panel.send(
      catalog({
        workflows: [
          {
            name: "plain",
            label: "plain",
            description: "",
            source: "/ws/plain.md",
            stages: 1,
            steps: 1,
            roles: [],
          },
        ],
      }),
    );
    expect(panel.byId("wf-list").all("wf-row")[0]?.textContent).toContain("unbounded");
  });

  it("says so rather than showing an empty list when the engine has no such verb", () => {
    // "This workspace defines no pipelines" and "this engine cannot tell me"
    // are not the same news.
    openCatalog();
    panel.send({ type: "workflows", view: { status: "unavailable", workflows: [] } });
    expect(panel.byId("wf-list").textContent).toContain("too old");
    expect(panel.byId("wf-list").all("wf-row")).toHaveLength(0);
  });

  it("runs the chosen pipeline with whatever is in the composer as its input", () => {
    openCatalog();
    panel.send(catalog());
    panel.type("the retry test flakes");
    panel.byId("wf-list").all("wf-row")[0]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({
      type: "runWorkflow",
      name: "ship-fix",
      input: "the retry test flakes",
    });
  });

  it("sends no input at all when the composer is empty", () => {
    openCatalog();
    panel.send(catalog());
    panel.byId("wf-list").all("wf-row")[0]?.dispatch("click");
    expect(panel.posted.at(-1)).toEqual({ type: "runWorkflow", name: "ship-fix" });
  });

  it("never sends a budget: the panel does not offer to change a money ceiling", () => {
    openCatalog();
    panel.send(catalog());
    panel.byId("wf-list").all("wf-row")[0]?.dispatch("click");
    const sent = panel.posted.at(-1) as Record<string, unknown>;
    expect(Object.hasOwn(sent, "budgetUsd")).toBe(false);
  });

  it("replaces the catalog with the run card, reading the journal's own numbers", () => {
    openCatalog();
    panel.send(run());
    expect(panel.byId("wf").classList.contains("hidden")).toBe(false);
    expect(panel.byId("wf-catalog").classList.contains("hidden")).toBe(true);
    expect(panel.byId("wf-run").classList.contains("hidden")).toBe(false);
    expect(panel.byId("wf-run-text").textContent).toBe("Workflow ship-fix");
    expect(panel.byId("wf-run-meta").textContent).toBe(
      "running · stage 2/3 · 1/4 steps · $1.50 of $15.00",
    );
  });

  it("surfaces an ORG-ASK as a question with a box a person answers", () => {
    panel.send(
      run({ state: "paused", questions: [{ stepId: "3", question: "per-tenant or per-user?" }] }),
    );
    expect(panel.byId("wf-questions").classList.contains("hidden")).toBe(false);
    expect(panel.byId("wf-question-text").textContent).toBe("per-tenant or per-user?");
    expect(panel.byId("wf").classList.contains("wf-waiting")).toBe(true);
  });

  it("lists every question a parallel stage raised, not just the first", () => {
    // A stage pauses, not a step: answering one of three and watching the run
    // pause again is the failure this list exists to prevent.
    panel.send(
      run({
        state: "paused",
        questions: [
          { stepId: "2.1", question: "first?" },
          { stepId: "2.2", question: "second?" },
        ],
      }),
    );
    expect(panel.byId("wf-question-text").textContent).toContain("2.1: first?");
    expect(panel.byId("wf-question-text").textContent).toContain("2.2: second?");
  });

  it("sends the person's own words back verbatim, and clears the box", () => {
    panel.send(
      run({ state: "paused", questions: [{ stepId: "3", question: "per-tenant or per-user?" }] }),
    );
    panel.byId("wf-answer").value = "Per-tenant.\nThe migration is cheaper now.";
    panel.byId("wf-send-answer").dispatch("click");
    expect(panel.posted.at(-1)).toEqual({
      type: "resumeWorkflow",
      runId: "run-1",
      answer: "Per-tenant.\nThe migration is cheaper now.",
    });
    expect(panel.byId("wf-answer").value).toBe("");
  });

  it("sends nothing for an empty answer rather than resuming with silence", () => {
    panel.send(
      run({ state: "paused", questions: [{ stepId: "3", question: "per-tenant or per-user?" }] }),
    );
    panel.byId("wf-answer").value = "   ";
    panel.byId("wf-send-answer").dispatch("click");
    expect(panel.posted.filter((message) => message.type === "resumeWorkflow")).toHaveLength(0);
  });

  it("disables the answer button between a press and the host's next answer", () => {
    panel.send(run({ state: "paused", questions: [{ stepId: "3", question: "q?" }] }));
    panel.byId("wf-answer").value = "yes";
    panel.byId("wf-send-answer").dispatch("click");
    expect(panel.byId("wf-send-answer").disabled).toBe(true);
    panel.send(run({ state: "running" }));
    panel.send(run({ state: "paused", questions: [{ stepId: "4", question: "again?" }] }));
    expect(panel.byId("wf-send-answer").disabled).toBe(false);
  });

  it("shows a refusal the engine gave rather than swallowing it", () => {
    panel.send({
      type: "workflows",
      view: {
        status: "ready",
        workflows: [],
        note: "The engine refused: may only lower that ceiling",
      },
    });
    expect(panel.byId("wf-note").classList.contains("hidden")).toBe(false);
    expect(panel.byId("wf-note").textContent).toContain("may only lower that ceiling");
  });
});
