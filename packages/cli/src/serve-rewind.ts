/**
 * `/rewind` for served sessions: the recording half and the reading half, in
 * one object.
 *
 * The terminal's `/rewind` works because `ArcturnRuntime` holds three things at
 * once — the checkpoint store its `write`/`edit` calls snapshot into, a map
 * from each checkpoint turn to the transcript entry it began at, and the agent
 * whose conversation gets forked. A served session had the first of those and
 * neither of the others: `buildSessionAgent` created a store per session and
 * then dropped the reference, so the manifest was being written and nothing
 * could read it back, and nothing recorded where in the conversation each turn
 * started. This module is what closes both gaps.
 *
 * ## Why the two halves live together
 *
 * `createServeHost` keeps one rule harder than any other: anything one
 * injection serves stays at one injection, with its consumers named. It learned
 * that from the `resolveModel`/`modelCatalog` pair, which was split once and
 * drifted into a real routing bug. Here the same split would be worse. The
 * *recording* half decides which store a session's `write` calls snapshot into;
 * the *reading* half decides which store `listCheckpoints` and `rewindTo` walk.
 * Two stores rooted at the same directory would list turns nobody recorded and
 * restore blobs nobody wrote — and the difference would surface as a rewind
 * that silently did nothing, which is the exact failure the verb's contract
 * says it may not have.
 *
 * So {@link createServeRewind} answers both questions from one map, and
 * `serve.ts` wires it once: `buildServedAgent` asks it for the store, and
 * `SessionHost` asks it for the list and the restore.
 *
 * ## What is reused, and what is decided here
 *
 * Everything dangerous is reused. The manifest walk, the workspace confinement
 * (`restoreRoot`), the content-addressed blobs and the temp-file-plus-rename
 * are `checkpoints.ts`'s, reached through `CheckpointStore.planRestore` and
 * `CheckpointStore.restore` — the same two calls the TUI's `/rewind` makes,
 * with `restore` applying exactly what `planRestore` reported. The conversation
 * fork is `ArcturnRuntime.forkSessionAgent`, which resumes at a `leafId`
 * exactly as `rewindConversationTo` does for the terminal. Nothing here writes
 * a file, unlinks a file, or decides whether a path is inside the workspace.
 *
 * What is decided here is bookkeeping: which store belongs to which session,
 * and which transcript entry each checkpoint turn began at.
 */

import { join } from "node:path";
import type { Agent } from "@arcturn/core";
import type { CheckpointRewindOutcome, CheckpointTurnPreview } from "@arcturn/server";
import type { AgentEvent } from "@arcturn/types";
import { type CheckpointStore, createCheckpointStore } from "./checkpoints.js";

/** How much of a prompt becomes a turn's label, matching the TUI's `/rewind`. */
const LABEL_MAX_CHARS = 60;

/**
 * The slice of `ArcturnRuntime` this module needs.
 *
 * Structural rather than the concrete class, for the reason `ServableRuntime`
 * is: `serve.ts`'s tests drive a cheap stub, and a module that demanded the
 * real runtime would drag config, extension and skill loading into every one
 * of them.
 */
export interface RewindableRuntime {
  /** `~/.arcturn`, under which `checkpoints/<sessionId>` lives. */
  readonly paths: { readonly home: string };
  /** The served workspace, and the default restore root. */
  readonly cwd: string;
  /** See `ArcturnRuntime.forkSessionAgent`. */
  forkSessionAgent(options: {
    sessionId: string;
    leafId: string | null;
    cwd?: string;
    checkpoints: CheckpointStore;
  }): Promise<Agent>;
}

/**
 * One served session's rewind state.
 *
 * `links` is the half a served session never had. `CheckpointStore` records
 * *files*; it has no idea which transcript entry a turn started at, and that is
 * the thing a fork needs. The runtime keeps the same map for its own agent
 * (`#turnLinks`); this keeps one per served session, because two sessions on
 * one engine have two conversations.
 */
interface SessionRewindState {
  store: CheckpointStore;
  /** The session's working directory — its restore root. */
  cwd: string;
  /** Checkpoint turn id → the transcript entry it began at (`null` = before the first). */
  links: Map<string, string | null>;
}

/** What `serve.ts` wires: the store side, the list side and the restore side. */
export interface ServeRewind {
  /**
   * The checkpoint store for one served session, created on first ask.
   *
   * Handed to `buildSessionAgent` so the session's `write`/`edit` calls
   * snapshot into the very store {@link ServeRewind.list} will later read.
   *
   * @param sessionId - The session being built.
   * @param cwd - Its working directory, which becomes the restore root.
   */
  storeFor(sessionId: string, cwd: string): CheckpointStore;
  /**
   * Subscribe an agent so every turn it runs opens a checkpoint and records
   * where in the conversation it began.
   *
   * Called for a session's first agent and again for the forked one, because a
   * fork that stopped recording would make the *next* rewind impossible.
   *
   * @param sessionId - The session the agent serves.
   * @param agent - The agent to watch.
   */
  track(sessionId: string, agent: Agent): void;
  /** See `SessionCheckpoints.list`. */
  list(sessionId: string): Promise<CheckpointTurnPreview[]>;
  /** See `SessionCheckpoints.rewind`. */
  rewind(sessionId: string, turnId: string): Promise<CheckpointRewindOutcome>;
}

/**
 * The head of a prompt, as a checkpoint label.
 *
 * The same projection `ArcturnRuntime.#onEvent` applies for the terminal's own
 * checkpoints — first 60 characters, whitespace collapsed — so a turn recorded
 * by a served session and one recorded by the TUI read the same in a picker.
 * `@arcturn/server` sanitizes it again on the way to the wire; this is only
 * about the two surfaces agreeing on what a label *is*.
 */
function labelFor(event: Extract<AgentEvent, { type: "runStart" }>): string {
  if (event.prompt.role !== "user") return "(empty prompt)";
  const content = event.prompt.content;
  const text =
    typeof content === "string"
      ? content
      : content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
  const label = text.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX_CHARS);
  return label === "" ? "(empty prompt)" : label;
}

/**
 * Build the rewind provider for one served engine.
 *
 * @param runtime - The served runtime, for its home directory and its fork.
 */
export function createServeRewind(runtime: RewindableRuntime): ServeRewind {
  const sessions = new Map<string, SessionRewindState>();

  const stateFor = (sessionId: string, cwd?: string): SessionRewindState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const resolved = cwd ?? runtime.cwd;
    const state: SessionRewindState = {
      // The same directory and the same confinement `buildSessionAgent` would
      // have used on its own — this only differs in that somebody keeps the
      // reference.
      store: createCheckpointStore(join(runtime.paths.home, "checkpoints", sessionId), {
        restoreRoot: resolved,
      }),
      cwd: resolved,
      links: new Map(),
    };
    sessions.set(sessionId, state);
    return state;
  };

  const track = (sessionId: string, agent: Agent): void => {
    const state = stateFor(sessionId);
    agent.subscribe((event) => {
      if (event.type !== "runStart") return;
      // Read synchronously: `runStart` is emitted before the user message is
      // appended, so `leafEntryId` still names the pre-turn branch tip — which
      // is exactly where a rewind forks back to. Reading it after the await
      // below would name the turn's own message and fork to a point *after*
      // the prompt that started it.
      const leafId = agent.leafEntryId;
      void state.store
        .beginTurn(labelFor(event))
        .then((turnId) => {
          state.links.set(turnId, leafId);
        })
        // A checkpoint failure must never break a run — the same rule
        // `wrapToolsWithCheckpoints` keeps. The cost of losing this is one
        // turn that restores files without forking the conversation, and the
        // wire says so (`forksConversation: false`) rather than pretending.
        .catch(() => undefined);
    });
  };

  return {
    storeFor(sessionId: string, cwd: string): CheckpointStore {
      return stateFor(sessionId, cwd).store;
    },
    track,
    async list(sessionId: string): Promise<CheckpointTurnPreview[]> {
      const state = sessions.get(sessionId);
      if (state === undefined) return [];
      const turns = await state.store.listTurns();
      const previews: CheckpointTurnPreview[] = [];
      for (const turn of turns) {
        // The plan comes from the store, which is the same computation
        // `restore` applies — so the cost a picker shows is the cost a rewind
        // charges, including which paths the workspace confinement refuses.
        const plan = await state.store.planRestore(turn.id);
        previews.push({
          id: turn.id,
          label: turn.label,
          timestamp: turn.timestamp,
          restores: plan.steps.filter((step) => step.action === "restore").map((step) => step.path),
          deletes: plan.steps.filter((step) => step.action === "delete").map((step) => step.path),
          // A turn recorded before this process — a session resumed from disk —
          // has snapshots but no record of the entry it began at. The terminal
          // restores the files and says the transcript was left in place rather
          // than guessing a fork point; this reports the same fact so a client
          // can say it before the user commits.
          forksConversation: state.links.has(turn.id),
        });
      }
      return previews;
    },
    async rewind(sessionId: string, turnId: string): Promise<CheckpointRewindOutcome> {
      const state = sessions.get(sessionId);
      if (state === undefined) {
        return { restored: [], deleted: [], failed: [] };
      }
      // The engine's own restorer. Confinement, blobs and atomic writes all
      // happen in here; this module writes nothing.
      const result = await state.store.restore(turnId);
      const outcome: CheckpointRewindOutcome = {
        restored: result.restored,
        deleted: result.deleted,
        failed: result.errors.map((error) => ({ path: error.path, message: error.message })),
      };
      if (!state.links.has(turnId)) return outcome;

      const leafId = state.links.get(turnId) ?? null;
      let forked: Agent;
      try {
        forked = await runtime.forkSessionAgent({
          sessionId,
          leafId,
          cwd: state.cwd,
          checkpoints: state.store,
        });
      } catch {
        // The files have already moved. Letting this throw would answer the
        // client with a failure for an operation that changed their entire
        // workspace — the worst possible version of the "silently did nothing"
        // failure, pointed backwards. So the outcome is returned as it stands
        // and `conversationForked: false` says which half happened; the client
        // already has a sentence for that case, because `forksConversation`
        // produces it too.
        return outcome;
      }
      // The fork keeps recording, or the *next* rewind would have nothing to
      // go back to — a rewind that quietly disabled rewinding.
      track(sessionId, forked);
      // The outgoing agent is not this module's to wind down: `SessionHost`
      // owns session liveness, and `#swapAgent` unsubscribes before it aborts
      // so a run aborted in the gap does not fan a `runEnd` out for a session
      // the host is mid-swap on. Two owners for one agent's lifecycle is how
      // it gets aborted twice, or not at all — which is why `rewind` is not
      // handed the live agent in the first place.
      return { ...outcome, agent: forked };
    },
  };
}
