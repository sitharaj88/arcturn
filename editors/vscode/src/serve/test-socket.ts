/**
 * An in-memory {@link WebSocketLike} for tests. Never imported by shipping
 * code, so it is not in the esbuild bundle.
 *
 * Modelled on `@arcturn/protocol`'s own `client.test.ts` fake, and it
 * `implements WebSocketLike` on purpose: that is the proof the extension is
 * driving the *real* `ProtocolClient` over a faithful stand-in, not a mock of
 * the client. The protocol package's structural typing is what makes this
 * dependency-free — no `ws`, no sockets, no ports.
 */

import type { WebSocketLike } from "./engine.js";

type AnyListener = (...args: unknown[]) => void;

/** One decoded client request frame. */
export interface SentFrame {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** In-memory socket driven by the test rather than a network. */
export class FakeSocket implements WebSocketLike {
  /** Raw text frames handed to `send`, in order. */
  readonly sent: string[] = [];
  closeCalls = 0;
  readyState: number | undefined;
  /**
   * Answer outbound requests automatically, on a microtask. `true` answers
   * everything with an empty success result; a function lets a test script one
   * result per method and return `undefined` to leave a frame unanswered.
   * Stands in for a server, which is what a test about *client* behaviour
   * wants.
   */
  autoRespond: boolean | ((frame: SentFrame) => unknown);
  readonly #handlers = new Map<string, AnyListener[]>();

  constructor(
    options: { readyState?: number; autoRespond?: boolean | ((frame: SentFrame) => unknown) } = {},
  ) {
    this.readyState = options.readyState;
    this.autoRespond = options.autoRespond ?? false;
  }

  send(data: string): void {
    this.sent.push(data);
    if (this.autoRespond === false) return;
    const frame = JSON.parse(data) as SentFrame;
    const result = this.autoRespond === true ? {} : this.autoRespond(frame);
    if (result === undefined) return;
    queueMicrotask(() => this.emit({ kind: "response", id: frame.id, result }));
  }

  close(): void {
    this.closeCalls += 1;
  }

  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: string, listener: unknown): this {
    const existing = this.#handlers.get(event);
    if (existing) existing.push(listener as AnyListener);
    else this.#handlers.set(event, [listener as AnyListener]);
    return this;
  }

  /** Deliver an inbound message; objects are JSON-encoded, strings sent raw. */
  emit(payload: unknown): void {
    this.#fire("message", typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  emitOpen(): void {
    this.readyState = 1;
    this.#fire("open");
  }

  emitClose(code?: number): void {
    this.readyState = 3;
    this.#fire("close", code);
  }

  emitError(error: unknown): void {
    this.#fire("error", error);
  }

  /** Every frame sent so far, parsed. */
  frames(): SentFrame[] {
    return this.sent.map((text) => JSON.parse(text) as SentFrame);
  }

  /** One sent frame by index. */
  frame(index: number): SentFrame {
    const frame = this.frames()[index];
    if (!frame) throw new Error(`No frame at index ${index} (sent ${String(this.sent.length)})`);
    return frame;
  }

  /** The most recent frame for `method`, or `undefined`. */
  lastFrame(method: string): SentFrame | undefined {
    return [...this.frames()].reverse().find((frame) => frame.method === method);
  }

  /** Answer the frame at `index` with a success response. */
  respondOk(index: number, result: unknown = {}): void {
    this.emit({ kind: "response", id: this.frame(index).id, result });
  }

  /** Answer every unanswered frame with an empty success response. */
  respondAll(result: unknown = {}): void {
    for (const frame of this.frames()) {
      this.emit({ kind: "response", id: frame.id, result });
    }
  }

  /** Push a session event, as `ws-server.ts` does. */
  emitEvent(sessionId: string, event: unknown): void {
    this.emit({ kind: "event", sessionId, event });
  }

  #fire(event: string, ...args: unknown[]): void {
    for (const listener of this.#handlers.get(event) ?? []) listener(...args);
  }
}

/** Let queued microtasks (and 0ms timers) run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
