/**
 * Loads the browser client's script text into the test process, and supplies
 * the minimal fake DOM the mounter needs.
 *
 * The point is that tests run the **shipped** source: `MODEL_SCRIPT` and
 * `APP_SCRIPT` are evaluated exactly as the page evaluates them, into a
 * sandbox object standing in for `globalThis`, with `window`/`document` left
 * undefined so neither script boots itself. Nothing is re-implemented here, so
 * nothing can drift from what a browser is served.
 *
 * Excluded from the build (see `tsconfig.json`'s `src/** /test-helpers/**`),
 * so none of this ships.
 */

import type { AgentEvent, PermissionRequest, SessionHeader } from "@arcturn/types";
import { APP_SCRIPT } from "../script/app.js";
import { MODEL_SCRIPT } from "../script/model.js";

/** A rendered node description — the only thing the model layer produces. */
export interface VNode {
  tag: string;
  cls: string;
  text?: string;
  key?: string;
  rev?: number;
  attrs?: Record<string, string>;
  children: VNode[];
}

/** The reducer's accumulated view of one session. */
export interface ViewState {
  blocks: Record<string, unknown>[];
  todos: unknown[];
  permissions: PermissionRequest[];
  running: boolean;
  streaming: boolean;
  streamText: string;
  tokens: number;
  [key: string]: unknown;
}

/** The pure half of the client (`script/model.ts`). */
export interface WebClientModel {
  createState(): ViewState;
  applyEvent(state: ViewState, event: AgentEvent, now?: number): ViewState;
  transcriptNodes(state: ViewState): VNode[];
  liveNodes(state: ViewState): VNode[];
  todoNodes(state: ViewState): VNode[];
  sessionNodes(sessions: readonly SessionHeader[], currentId: string): VNode[];
  permissionNodes(request: unknown): VNode[];
  markdownNodes(source: string): VNode[];
  parseDiff(raw: string): { kind: string; lineNo: number | null; text: string }[] | null;
  subjectOf(input: unknown): string;
  suggestRule(request: unknown): { tool: string; specifier?: string; action: string };
  approvalGate(view: { scrollable: boolean; atBottom: boolean }): boolean;
  backoffDelay(
    attempt: number,
    options?: { baseMs?: number; maxMs?: number; jitter?: number },
    random?: () => number,
  ): number;
  activityText(state: ViewState, now?: number): string;
  formatDuration(ms: number): string;
  formatTokens(tokens: number): string;
}

/** The socket surface the client drives — a browser `WebSocket`, or a fake. */
export interface ClientSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Construction options for {@link WebClientApp.createClient}. */
export interface ClientOptions {
  url: string;
  token?: string;
  socketFactory: (url: string) => ClientSocket;
  timers?: {
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  };
  random?: () => number;
  backoff?: { baseMs?: number; maxMs?: number; jitter?: number };
  probeIntervalMs?: number;
  requestTimeoutMs?: number;
  onEvent?: (sessionId: string, event: AgentEvent) => void;
  onSessions?: (sessions: SessionHeader[]) => void;
  onStatus?: (status: string, detail?: unknown) => void;
  onReady?: () => void;
  onProtocolError?: (message: string) => void;
}

/** A rejection from {@link WebClient.request}. */
export interface ClientRejection {
  code: string;
  message: string;
}

/** The reconnecting protocol client. */
export interface WebClient {
  connect(): void;
  close(): void;
  request(method: string, params?: unknown, settings?: { timeoutMs?: number }): Promise<unknown>;
  retryNow(): void;
  forceReconnect(): void;
  getStatus(): string;
  getAttempt(): number;
}

/** The impure half of the client (`script/app.ts`). */
export interface WebClientApp {
  createClient(options: ClientOptions): WebClient;
  createElement(doc: FakeDocument, vnode: VNode): FakeElement;
  mount(doc: FakeDocument, container: FakeElement, nodes: readonly VNode[]): void;
  resolveWsUrl(win: unknown, config: unknown): string;
  takeTokenFromLocation(win: unknown): string | null;
  /** Wire the page's static shell to a live session. Browser (or fake DOM) only. */
  boot(doc: unknown, win: unknown): { client: WebClient; render(): void; getState(): ViewState };
}

/** Everything the page defines on `globalThis`. */
export interface WebClientApi {
  model: WebClientModel;
  app: WebClientApp;
}

/**
 * Evaluate both client scripts in a fresh sandbox.
 *
 * @returns The `ArcturnWeb` namespace the page would have defined.
 */
export function loadWebClient(): WebClientApi {
  const sandbox: Record<string, unknown> = {};
  const load = new Function(
    "globalThis",
    "window",
    "document",
    `${MODEL_SCRIPT}\n${APP_SCRIPT}\nreturn globalThis.ArcturnWeb;`,
  ) as (global: unknown, win: unknown, doc: unknown) => WebClientApi;
  return load(sandbox, undefined, undefined);
}

/**
 * A DOM node stand-in exposing only what the mounter is allowed to touch.
 *
 * Assigning `innerHTML` (or any other markup-parsing sink) throws, so a
 * regression that starts building HTML from server text fails loudly instead
 * of silently becoming an injection.
 */
export class FakeElement {
  readonly tag: string;
  readonly attributes = new Map<string, string>();
  readonly childNodes: FakeElement[] = [];
  textContent = "";

  constructor(tag: string) {
    this.tag = tag;
  }

  set innerHTML(_value: string) {
    throw new Error("innerHTML is forbidden in the arcturn web client");
  }

  set outerHTML(_value: string) {
    throw new Error("outerHTML is forbidden in the arcturn web client");
  }

  insertAdjacentHTML(): never {
    throw new Error("insertAdjacentHTML is forbidden in the arcturn web client");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    this.childNodes.push(child);
    return child;
  }

  replaceChild(next: FakeElement, previous: FakeElement): void {
    const index = this.childNodes.indexOf(previous);
    if (index >= 0) this.childNodes[index] = next;
    else this.childNodes.push(next);
  }

  removeChild(child: FakeElement): void {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
  }
}

/** The `document` stand-in: it can only ever create elements. */
export class FakeDocument {
  readonly created: FakeElement[] = [];

  createElement(tag: string): FakeElement {
    const element = new FakeElement(tag);
    this.created.push(element);
    return element;
  }
}

/** All text carried by an element tree, in document order. */
export function textOf(element: FakeElement): string {
  const own = element.textContent;
  const children = element.childNodes.map((child) => textOf(child)).join("");
  return own + children;
}

/** Every tag name in an element tree, including the root's. */
export function tagsOf(element: FakeElement): string[] {
  return [element.tag, ...element.childNodes.flatMap((child) => tagsOf(child))];
}

/** All text carried by a vnode tree, in document order. */
export function vnodeText(vnode: VNode): string {
  return (vnode.text ?? "") + vnode.children.map((child) => vnodeText(child)).join("");
}

/** Every tag name in a vnode tree. */
export function vnodeTags(vnode: VNode): string[] {
  return [vnode.tag, ...vnode.children.flatMap((child) => vnodeTags(child))];
}

/** A scripted in-memory socket implementing {@link ClientSocket}. */
export class FakeSocket implements ClientSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Every frame the client sent, as parsed JSON. */
  readonly sent: Record<string, unknown>[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulate the handshake completing. */
  open(): void {
    this.onopen?.();
  }

  /** Deliver one server message. */
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Simulate the peer (or the network) closing the connection. */
  drop(code = 1006): void {
    this.closed = true;
    this.onclose?.({ code });
  }

  /** The last frame sent, or `undefined`. */
  get last(): Record<string, unknown> | undefined {
    return this.sent[this.sent.length - 1];
  }
}
