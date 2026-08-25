/**
 * One open session, wired end to end: engine events in, view state out, user
 * actions back through the {@link ProtocolClient}.
 *
 * This is where the pure pieces meet — {@link reduceChat}, {@link reduceCost},
 * {@link PermissionQueue} — and it is deliberately free of `vscode` so the
 * whole surface can be driven in a test against the *real* protocol client
 * over an in-memory socket. What that proves (see `controller.test.ts`) is the
 * part that matters: the handshake, the fan-out, the permission round trip,
 * and that the token appears in none of it.
 *
 * The verbs used are exactly the ones RFC 0004 §1 lists — `prompt`, `steer`,
 * `abort`, `setModel`, `respondToPermission`, `onEvent` — plus
 * `resolveContext`, `permissionState` and `setPermissionMode`, which RFC 0005
 * added to the *engine* first, exactly as §0 prescribes, and nothing else.
 *
 * History is folded in the same way live events are, through {@link reduceChat}
 * and nothing else. That is the whole reason the engine replays `AgentEvent`s
 * rather than a projected message list: a transcript rebuilt from disk and one
 * watched as it happened go through the identical code, so they cannot render
 * differently, and this file needed no new branch to gain the feature.
 */

import type {
  AgentEvent,
  ContextResolution,
  PermissionMode,
  PermissionRequest,
  PermissionState,
  PromptAttachment,
  ProtocolClient,
  SessionHeader,
  SessionHistory,
} from "../serve/engine.js";
import {
  type ChatState,
  type ChatViewModel,
  initialChatState,
  reduceChat,
  toggleBlock,
  toViewModel,
} from "./chat-state.js";
import { type CostState, initialCostState, reduceCost } from "./cost.js";
import { type PermissionAnswer, PermissionQueue } from "./permission-queue.js";
import { chooseSendVerb } from "./picker.js";

/** What the controller needs from its embedder (a webview, or a test). */
export interface ControllerHost {
  /** The transcript changed. Called only when something actually changed. */
  onChat: (view: ChatViewModel) => void;
  /** The session's spend changed. */
  onCost: (cost: CostState) => void;
  /**
   * Show a permission dialog.
   *
   * @param request - The engine's request, unmodified.
   * @param args - The tool's arguments from `toolStart`, when the controller
   *   has seen them. Passed through verbatim for the dialog to render.
   */
  askPermission: (
    request: PermissionRequest,
    args: Record<string, unknown> | undefined,
  ) => Promise<PermissionAnswer>;
  /** Redacted diagnostics. */
  onDiagnostic?: (line: string) => void;
}

/** Construction options for {@link createSessionController}. */
export interface SessionControllerOptions {
  client: ProtocolClient;
  sessionId: string;
  host: ControllerHost;
  /** The session header, when the caller has one (used only for `cwd`). */
  header?: SessionHeader;
  /**
   * The session's stored conversation, folded in before this controller
   * subscribes. Absent for a new session, and for an engine too old to replay
   * one (`ProtocolClient.sessionHistory` resolves `undefined`), in which case
   * the transcript starts empty exactly as it did before.
   */
  history?: SessionHistory;
}

/** One open session. */
export interface SessionController {
  readonly sessionId: string;
  /** The session header this controller was opened with, when known. */
  readonly header: SessionHeader | undefined;
  /** Current transcript state. */
  readonly state: ChatState;
  /** Current spend. */
  readonly cost: CostState;
  /** Model ids the engine announced on this session, oldest first. */
  readonly observedModels: readonly string[];
  /** The permission bridge, exposed for disposal and for tests. */
  readonly permissions: PermissionQueue;
  /**
   * Send a message: `prompt` when idle, `steer` mid-run.
   *
   * Resolves once the frame is on the wire, **not** when the run finishes —
   * see the implementation note. A failure is reported through
   * {@link ControllerHost.onDiagnostic}, never thrown at the caller.
   *
   * `text` is sent **unexpanded**: `@`-mentions are the engine's to resolve, so
   * this panel never reads a file to build a prompt (RFC 0005 §3).
   *
   * @param attachments - What the composer is holding. Carried only by
   *   `prompt`: `steer` has no attachment parameter, and inventing one here
   *   would be a client-side feature the engine never agreed to — so a
   *   mid-run send with chips attached is reported and refused rather than
   *   quietly sent without them.
   */
  send(text: string, attachments?: readonly PromptAttachment[]): Promise<void>;
  /**
   * Ask the engine what a mention would resolve to.
   *
   * Read-only. `undefined` means this engine predates the verb — the panel
   * shows no picker rather than a hopeful one.
   */
  resolveContext(query: string): Promise<ContextResolution | undefined>;
  /** Abort the current run. */
  abort(): Promise<void>;
  /** Switch the session's model. */
  setModel(modelId: string): Promise<void>;
  /**
   * Read the mode this session runs under, and the tools it holds.
   *
   * Read-only. `undefined` means this engine predates the verb — the caller
   * shows no mode chip and no capability line rather than guessing `default`,
   * which is the mode most engines are in and therefore the most convincing
   * wrong answer a panel could give.
   */
  permissionState(): Promise<PermissionState | undefined>;
  /**
   * Ask the session to run under a different mode from the next turn.
   *
   * Deliberately **not** given the `undefined` treatment `permissionState`
   * gets, and the asymmetry is the point (see `ProtocolClient`'s own doc): an
   * engine too old for the verb, or one mid-run, *rejects*, and the caller
   * says so. A resolve here would leave a panel showing `plan` over a session
   * still in `yolo`.
   *
   * @returns The engine's own answer to "what am I now" — read it rather than
   *   assuming the mode you asked for is the mode you got.
   */
  setPermissionMode(mode: PermissionMode): Promise<PermissionState>;
  /** Expand or collapse one transcript block. */
  toggle(blockId: string): void;
  /** Unsubscribe, and deny any permission request still outstanding. */
  dispose(): void;
}

/**
 * Open a session on an established client.
 *
 * @param options - See {@link SessionControllerOptions}.
 */
export function createSessionController(options: SessionControllerOptions): SessionController {
  const { client, sessionId, host } = options;

  let state = seedFromHistory(initialChatState, options.history);
  let cost = initialCostState;
  let disposed = false;
  const observedModels: string[] = [];
  /** `toolCallId` → the arguments the engine sent, for the permission dialog. */
  const toolArgs = new Map<string, Record<string, unknown>>();

  const permissions = new PermissionQueue({
    ask: (request) => host.askPermission(request, toolArgs.get(request.toolCallId)),
    // The scope is named only when there is a rule to scope. RFC 0005 §1.2
    // gives the verb an optional `scope` so "allow once" and "allow for this
    // session" are distinguishable *at the moment of asking* rather than
    // inferred later from whether a rule happened to be attached — and the
    // only scope this wire accepts is the one that dies with the session, so
    // there is nothing here that could persist to a file a person owns.
    respond: (decision) =>
      client.respondToPermission(
        sessionId,
        decision,
        decision.persistRule === undefined ? {} : { scope: "session" },
      ),
    onError: (error, request) => {
      host.onDiagnostic?.(
        `permission ${request.id} (${request.toolName}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });

  const notify = (next: ChatState): void => {
    if (next === state) return;
    state = next;
    try {
      host.onChat(toViewModel(state));
    } catch (error) {
      // One failed render must not stop the next event from being reduced.
      host.onDiagnostic?.(
        `sidebar render failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const handle = (incomingSessionId: string, event: AgentEvent): void => {
    if (disposed || incomingSessionId !== sessionId) return;

    if (event.type === "toolStart") toolArgs.set(event.toolCallId, event.input);
    if (event.type === "messageStream" && event.event.type === "start") {
      const model = event.event.model;
      const last = observedModels.at(-1);
      if (model !== "" && model !== last) {
        // Keep the list de-duplicated by *most recent* position: the picker
        // shows the newest first, and a model re-announced is newly current.
        const previous = observedModels.indexOf(model);
        if (previous !== -1) observedModels.splice(previous, 1);
        observedModels.push(model);
      }
    }
    if (event.type === "permissionRequest") permissions.enqueue(event.request);

    const nextCost = reduceCost(cost, event);
    if (nextCost !== cost) {
      cost = nextCost;
      host.onCost(cost);
    }
    notify(reduceChat(state, event));
  };

  const unsubscribe = client.onEvent(handle);

  return {
    sessionId,
    header: options.header,
    get state(): ChatState {
      return state;
    },
    get cost(): CostState {
      return cost;
    },
    get observedModels(): readonly string[] {
      return observedModels;
    },
    permissions,
    send(text: string, attachments?: readonly PromptAttachment[]): Promise<void> {
      const verb = chooseSendVerb(state.running);
      if (verb === "steer" && attachments !== undefined && attachments.length > 0) {
        // `steer` carries no attachments on the wire. Sending the text without
        // them would drop the user's chips silently, which is the exact failure
        // RFC 0005 §1.1 exists to close — so this says so instead.
        host.onDiagnostic?.(
          "steer carries no attachments; wait for the current run to finish before sending them",
        );
        return Promise.resolve();
      }
      // Neither verb is awaited. `ProtocolClient.prompt` resolves when the
      // *run* ends — `ws-server.ts` awaits `SessionHost.prompt`, which awaits
      // the agent — so awaiting it here would leave the prompt box blocked for
      // the length of the run. The acknowledgement is the inbound `runStart`
      // event, exactly as `arcturn attach` does it; the promise is watched only
      // so a late rejection becomes a diagnostic rather than an unhandled
      // rejection.
      const sent =
        verb === "steer"
          ? client.steer(sessionId, text)
          : client.prompt(
              sessionId,
              text,
              ...(attachments === undefined || attachments.length === 0 ? [] : [attachments]),
            );
      sent.catch((error: unknown) => {
        host.onDiagnostic?.(
          `${verb} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return Promise.resolve();
    },
    resolveContext: (query: string) => client.resolveContext(sessionId, query),
    abort: () => client.abort(sessionId),
    setModel: (modelId: string) => client.setModel(sessionId, modelId),
    permissionState: () => client.permissionState(sessionId),
    setPermissionMode: (mode: PermissionMode) => client.setPermissionMode(sessionId, mode),
    toggle(blockId: string): void {
      notify(toggleBlock(state, blockId));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      permissions.dispose();
      toolArgs.clear();
    },
  };
}

/**
 * Fold a replayed history into transcript state.
 *
 * Truncation is announced *first*, as an ordinary `notice` event pushed
 * through the same reducer, so the panel renders it with the notice styling it
 * already has and the sentence sits above the oldest message that survived.
 * Saying it here rather than on the wire keeps the engine from writing UI
 * copy, and saying it at all is the point: a transcript that quietly starts
 * mid-conversation reads as the whole conversation, which is the exact class
 * of silent wrong answer this panel keeps refusing to give.
 *
 * @param state - Usually {@link initialChatState}.
 * @param history - What `sessionHistory` returned, if anything.
 */
function seedFromHistory(state: ChatState, history: SessionHistory | undefined): ChatState {
  if (history === undefined) return state;
  let next = state;
  if (history.truncated) {
    next = reduceChat(next, {
      type: "notice",
      level: "info",
      text: `Earlier messages are not shown — this session is longer than the panel replays (${String(
        history.droppedEvents,
      )} older events omitted).`,
    });
  }
  for (const event of history.events) next = reduceChat(next, event);
  // A replay describes what was already stored, and nothing stored is still in
  // flight. Live events decide `running` from here on.
  return next.running ? { ...next, running: false } : next;
}
