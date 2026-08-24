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
 * `abort`, `setModel`, `respondToPermission`, `onEvent` — and nothing else.
 */

import type {
  AgentEvent,
  PermissionRequest,
  ProtocolClient,
  SessionHeader,
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
   */
  send(text: string): Promise<void>;
  /** Abort the current run. */
  abort(): Promise<void>;
  /** Switch the session's model. */
  setModel(modelId: string): Promise<void>;
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

  let state = initialChatState;
  let cost = initialCostState;
  let disposed = false;
  const observedModels: string[] = [];
  /** `toolCallId` → the arguments the engine sent, for the permission dialog. */
  const toolArgs = new Map<string, Record<string, unknown>>();

  const permissions = new PermissionQueue({
    ask: (request) => host.askPermission(request, toolArgs.get(request.toolCallId)),
    respond: (decision) => client.respondToPermission(sessionId, decision),
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
    send(text: string): Promise<void> {
      const verb = chooseSendVerb(state.running);
      // Neither verb is awaited. `ProtocolClient.prompt` resolves when the
      // *run* ends — `ws-server.ts` awaits `SessionHost.prompt`, which awaits
      // the agent — so awaiting it here would leave the prompt box blocked for
      // the length of the run. The acknowledgement is the inbound `runStart`
      // event, exactly as `arcturn attach` does it; the promise is watched only
      // so a late rejection becomes a diagnostic rather than an unhandled
      // rejection.
      const sent =
        verb === "steer" ? client.steer(sessionId, text) : client.prompt(sessionId, text);
      sent.catch((error: unknown) => {
        host.onDiagnostic?.(
          `${verb} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return Promise.resolve();
    },
    abort: () => client.abort(sessionId),
    setModel: (modelId: string) => client.setModel(sessionId, modelId),
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
