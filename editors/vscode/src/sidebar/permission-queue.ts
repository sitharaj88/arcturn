/**
 * The permission bridge: engine `permissionRequest` → a native VS Code modal →
 * `respondToPermission`.
 *
 * RFC 0004 §1 Stage 2 is exact about the contract: "The dialog renders what
 * the engine sent — it never re-derives or paraphrases the request." So
 * {@link describePermissionRequest} quotes `PermissionRequest.description`,
 * `.toolName`, `.subject` and `.origin` verbatim and adds only labels; the
 * only rule offered for persistence is the one the engine itself suggested.
 *
 * The queue exists because a run can raise several requests and a modal is
 * exclusive: they are answered one at a time, in arrival order. And because a
 * sidebar can be disposed while the engine is blocked on an answer, disposal
 * *denies* — the agent gets a decision and unblocks, rather than waiting
 * forever on a dialog nobody will ever see.
 *
 * `ask` and `respond` are injected, so none of this needs `vscode` to be
 * tested.
 */

import type { PermissionDecision, PermissionRequest, PermissionRule } from "../serve/engine.js";

/** Cap on the rendered argument JSON, so a modal stays a modal. */
const MAX_DETAIL_ARGS = 2_000;

/** What the user chose. */
export interface PermissionAnswer {
  behavior: "allow" | "deny";
  /** Rule to persist, when the user asked to remember the choice. */
  persistRule?: PermissionRule;
  /** Explanation fed back to the model on a denial. */
  message?: string;
}

/** Construction options for {@link PermissionQueue}. */
export interface PermissionQueueOptions {
  /** Show the dialog. Rejecting is treated as a denial. */
  ask: (request: PermissionRequest) => Promise<PermissionAnswer>;
  /** Send the decision, i.e. `client.respondToPermission(sessionId, decision)`. */
  respond: (decision: PermissionDecision) => Promise<void>;
  /** Diagnostics for a failed dialog or a failed response. */
  onError?: (error: unknown, request: PermissionRequest) => void;
  /** Denial message used when the sidebar is disposed with work outstanding. */
  disposedMessage?: string;
}

const DEFAULT_DISPOSED_MESSAGE = "Denied: the Arcturn sidebar was closed before this was answered.";

/**
 * Serialises permission requests through one dialog at a time.
 *
 * Requests are de-duplicated by `PermissionRequest.id`: the engine assigns it,
 * and a redelivered event must not raise a second modal.
 */
export class PermissionQueue {
  readonly #options: PermissionQueueOptions;
  readonly #pending: PermissionRequest[] = [];
  readonly #seen = new Set<string>();
  readonly #answered = new Set<string>();
  /**
   * In-flight `respond` calls. Tracked separately from the dialog chain
   * because a dialog may never settle — a modal the user leaves open, or a
   * disposed sidebar's — while the decision it belongs to must still land.
   */
  readonly #sends = new Set<Promise<void>>();
  #running = false;
  #inFlight: PermissionRequest | undefined;
  #disposed = false;

  constructor(options: PermissionQueueOptions) {
    this.#options = options;
  }

  /** Requests waiting for (or currently showing) a dialog. */
  get size(): number {
    return this.#pending.length + (this.#inFlight === undefined ? 0 : 1);
  }

  /** Whether {@link PermissionQueue.dispose} has been called. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Accept one request from the event stream.
   *
   * @param request - The engine's request, unmodified.
   */
  enqueue(request: PermissionRequest): void {
    if (this.#seen.has(request.id)) return;
    this.#seen.add(request.id);
    if (this.#disposed) {
      void this.#deny(request);
      return;
    }
    this.#pending.push(request);
    this.#pump();
  }

  /**
   * Wait for every queued request to be answered. Test-facing; production code
   * fires and forgets.
   *
   * @throws When the queue is still busy after `maxTicks` — a hang must fail a
   *   test rather than pass it quietly.
   */
  async drain(maxTicks = 1_000): Promise<void> {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      if (this.#sends.size > 0) {
        await Promise.all([...this.#sends]);
        continue;
      }
      if (this.size === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("PermissionQueue.drain: still busy");
  }

  /**
   * Stop asking and deny everything still outstanding.
   *
   * A disposed sidebar denies rather than hangs: the engine is blocked on a
   * decision it will otherwise never receive. The denials are sent
   * immediately rather than queued behind the open dialog — that dialog may
   * never resolve, and the engine cannot wait for it.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const outstanding = [
      ...(this.#inFlight === undefined ? [] : [this.#inFlight]),
      ...this.#pending,
    ];
    this.#pending.length = 0;
    this.#inFlight = undefined;
    this.#running = false;
    for (const request of outstanding) void this.#deny(request);
  }

  #pump(): void {
    if (this.#running || this.#disposed) return;
    const next = this.#pending.shift();
    if (next === undefined) return;
    this.#running = true;
    this.#inFlight = next;
    void this.#handle(next).then(() => {
      this.#running = false;
      this.#inFlight = undefined;
      this.#pump();
    });
  }

  async #handle(request: PermissionRequest): Promise<void> {
    let answer: PermissionAnswer;
    try {
      answer = await this.#options.ask(request);
    } catch (error) {
      this.#options.onError?.(error, request);
      answer = { behavior: "deny", message: "Denied: the Arcturn permission dialog failed." };
    }
    // A dispose() that landed while the dialog was open has already answered.
    if (this.#answered.has(request.id)) return;
    await this.#send(request, {
      requestId: request.id,
      behavior: answer.behavior,
      ...(answer.persistRule === undefined ? {} : { persistRule: answer.persistRule }),
      ...(answer.message === undefined ? {} : { message: answer.message }),
    });
  }

  async #deny(request: PermissionRequest): Promise<void> {
    if (this.#answered.has(request.id)) return;
    await this.#send(request, {
      requestId: request.id,
      behavior: "deny",
      message: this.#options.disposedMessage ?? DEFAULT_DISPOSED_MESSAGE,
    });
  }

  async #send(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.#answered.add(request.id);
    const work = (async () => {
      try {
        await this.#options.respond(decision);
      } catch (error) {
        // A dead socket must not wedge the queue: the next request still gets
        // its dialog, and the reconnect card explains the outage.
        this.#options.onError?.(error, request);
      }
    })();
    // Registered synchronously so `dispose()` followed by `drain()` observes
    // the denial in flight rather than an empty queue.
    this.#sends.add(work);
    void work.finally(() => this.#sends.delete(work));
    await work;
  }
}

/** A request rendered for a modal. Every value comes from the engine. */
export interface DescribedPermission {
  /** The modal's main text — `PermissionRequest.description`, verbatim. */
  message: string;
  /** Tool name, subject, arguments and origin, labelled but never reworded. */
  detail: string;
  /** The engine's suggested rule, scoped to the session. */
  suggestedRule: PermissionRule | undefined;
}

/**
 * Render a request for `vscode.window.showWarningMessage`.
 *
 * Unlike the quick-pick builders in `picker.ts`, engine strings here are
 * **not** run through `escapeCodicons`, and that asymmetry is deliberate. A
 * modal dialog sets its message and detail as plain text rather than through
 * VS Code's `IconLabel`, so `$(name)` is not glyph syntax on this path; adding
 * the escape would put a visible backslash in front of it and break RFC 0004
 * §1's requirement that "the dialog renders what the engine sent — it never
 * re-derives or paraphrases the request". Escaping is faithful in a field that
 * parses codicons and unfaithful in one that does not.
 *
 * @param request - The engine's request.
 * @param args - The tool's arguments as the engine sent them on `toolStart`,
 *   when they are known. Serialised, never summarised.
 */
export function describePermissionRequest(
  request: PermissionRequest,
  args?: Record<string, unknown>,
): DescribedPermission {
  const lines = [`Tool: ${request.toolName}`, request.subject];
  if (args !== undefined && Object.keys(args).length > 0) {
    lines.push("", "Arguments:", truncateArgs(args));
  }
  if (request.origin !== undefined) lines.push("", `Requested by ${request.origin}`);
  return {
    message: request.description,
    detail: lines.join("\n"),
    suggestedRule:
      request.suggestedRule === undefined
        ? undefined
        : { ...request.suggestedRule, scope: "session" },
  };
}

function truncateArgs(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    text = "[arguments could not be rendered]";
  }
  if (text.length <= MAX_DETAIL_ARGS) return text;
  return `${text.slice(0, MAX_DETAIL_ARGS)}\n… truncated (${String(text.length - MAX_DETAIL_ARGS)} more characters)`;
}
