/**
 * The serve path's background agents: the adapter that lets a remote client
 * reach the *same* `BackgroundAgentManager` the terminal's `/bg` drives.
 *
 * This module exists so that the narrowing happens **next to the manager whose
 * defaults are the caps**. `BackgroundAgentManager.start` takes an options
 * object with `tools`, `permissionMode`, `cwd` and `model` on it, because the
 * terminal has callers that legitimately set them. `@arcturn/server`'s
 * {@link BackgroundAgentRegistry} takes a task and nothing else, because the
 * wire has none. This is the one function where those two shapes meet, and it
 * is three lines long on purpose: a reader can see that the only thing crossing
 * is a string.
 *
 * ## What a remotely-started background agent is capped by
 *
 * Everything the manager decides, and the manager decides everything except the
 * task:
 *
 * - **Tools.** With no `tools` override, `start` filters to the read-only set
 *   plus `fetch` for any mode that is not `yolo`, and always removes
 *   `subagent`. A background agent started over this wire therefore cannot
 *   write a file, run a shell command, or fan out into further delegation.
 * - **Permission mode.** The manager's default is `"default"`, never `"yolo"`,
 *   and there is no `onPermissionAsk` wired for an unattended agent — so
 *   anything that would need approval is denied rather than parked. Fail-closed
 *   by construction.
 * - **Working directory.** The manager's, refreshed from the runtime, which is
 *   the served workspace.
 * - **Model.** The manager's, refreshed from the runtime, so a `/model` switch
 *   in the terminal moves what a remote `/bg` runs on too.
 * - **Concurrency.** Three at a time by default; the rest queue FIFO.
 *
 * None of those is a promise this module makes. Each is a default the manager
 * applies to a `start()` that did not override it, and this adapter's whole job
 * is to be a `start()` that cannot.
 *
 * ## One renderer, one sentence
 *
 * `transcript` renders with {@link formatBackgroundTranscript} — the function
 * `/bg logs` prints through — and `adoption` composes with
 * {@link backgroundAdoption}, the function `/bg adopt` injects through. Neither
 * is re-implemented here. A transcript that read one way in a terminal and
 * another over a socket, or an adoption that described the same finished agent
 * in two different sentences, is the divergence RFC 0004 §0 exists to prevent.
 */

import type { BackgroundAgentRecord, BackgroundAgentRegistry } from "@arcturn/server";
import {
  type BackgroundAgentManager,
  backgroundAdoption,
  formatBackgroundTranscript,
} from "./background-agents.js";

/**
 * Wrap one manager as the registry `@arcturn/server` consumes.
 *
 * @param manager - The runtime's own background-agent manager, from
 *   `getBackgroundAgentManager`. The same instance the terminal uses, because
 *   two managers over one records directory is two processes' worth of
 *   crash-recovery running against each other.
 */
export function backgroundAgentRegistry(manager: BackgroundAgentManager): BackgroundAgentRegistry {
  return {
    // `list()` and `get()` are already the manager's own projection
    // (`BackgroundAgentStatus`), which is structurally the record
    // `@arcturn/server` wants minus `usage` — and `usage` is dropped by the
    // server's projection rather than here, so this stays a pass-through and
    // there is only one place deciding what leaves.
    list: (): readonly BackgroundAgentRecord[] => manager.list(),
    get: (id: string): BackgroundAgentRecord | undefined => manager.get(id),
    // The narrowing this module exists for. One string in, and every cap in
    // the module doc above comes from the manager's defaults because there is
    // nothing here to override them with.
    start: (task: string): { id: string; sessionId: string } => manager.start({ task }),
    cancel: (id: string): boolean => manager.cancel(id),
    transcript: async (id: string): Promise<readonly string[] | undefined> => {
      const messages = await manager.transcript(id);
      return messages === undefined ? undefined : formatBackgroundTranscript(messages);
    },
    adoption: (id: string) => {
      const status = manager.get(id);
      return status === undefined ? undefined : backgroundAdoption(status);
    },
  };
}
