/**
 * The webview boundary contract, validated in both directions.
 *
 * RFC 0004 §3: "all messages validated at the boundary". A webview is a
 * separate document with its own script; `postMessage` from it is untrusted
 * input to the extension host, exactly like a socket frame. Every inbound
 * value is therefore re-built field by field — nothing is spread, nothing
 * unknown is forwarded, and every string has a ceiling.
 *
 * The host→webview direction is validated on the other side too, in
 * `webview-client.ts`'s `KNOWN_HOST_MESSAGES` check.
 *
 * Pure, so both directions are testable with no `vscode` and no DOM.
 */

import type { ChatViewModel } from "./chat-state.js";
import {
  CONNECTION_ACTIONS,
  type ConnectionAction,
  type ConnectionActionId,
} from "./connection-card.js";

/** Ceiling on a prompt, mirroring nothing in particular — just not unbounded. */
export const MAX_PROMPT_LENGTH = 100_000;
/** Ceiling on a block id (ids are `kind:seq`, so this is generous). */
const MAX_BLOCK_ID_LENGTH = 200;

/** Commands the webview may ask the host to run. */
export const WEBVIEW_COMMANDS = ["model", "sessions", "newSession"] as const;

/** A command the webview may ask for. */
export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

/** Where the connection stands, as shown by the reconnect card. */
export type ConnectionStatus = "idle" | "starting" | "ready" | "disconnected";

/** Host → webview. */
export type HostMessage =
  | { type: "state"; state: ChatViewModel }
  | {
      type: "connection";
      status: ConnectionStatus;
      /** The extension's own one-line account of the failure. */
      detail?: string;
      /**
       * The engine's own words, verbatim and redacted. Rendered as text, in
       * its own block, so a user reads what `arcturn serve` actually said.
       */
      engineOutput?: string;
      /** Buttons the card offers, most useful first. */
      actions?: ConnectionAction[];
    }
  | { type: "cost"; label: string };

/** Webview → host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "abort" }
  | { type: "toggle"; blockId: string }
  | { type: "action"; id: ConnectionActionId }
  | { type: "command"; command: WebviewCommand };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one message from the webview.
 *
 * @param value - Whatever arrived on `onDidReceiveMessage`.
 * @returns A freshly built message, or `undefined` when the value is not one
 *   of the six the webview is allowed to send. The `action` case is validated
 *   against {@link CONNECTION_ACTIONS} rather than by shape alone.
 */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "abort":
      return { type: "abort" };
    case "action": {
      // The card's buttons are the only thing that sends this, and the host
      // turns an id into a VS Code command. Accepting an arbitrary string here
      // would be handing the webview a command runner.
      const id = value.id;
      if (typeof id !== "string") return undefined;
      if (!(CONNECTION_ACTIONS as readonly string[]).includes(id)) return undefined;
      return { type: "action", id: id as ConnectionActionId };
    }
    case "send": {
      const text = value.text;
      if (typeof text !== "string") return undefined;
      if (text.trim() === "" || text.length > MAX_PROMPT_LENGTH) return undefined;
      return { type: "send", text };
    }
    case "toggle": {
      const blockId = value.blockId;
      if (typeof blockId !== "string") return undefined;
      if (blockId === "" || blockId.length > MAX_BLOCK_ID_LENGTH) return undefined;
      return { type: "toggle", blockId };
    }
    case "command": {
      const command = value.command;
      if (typeof command !== "string") return undefined;
      if (!(WEBVIEW_COMMANDS as readonly string[]).includes(command)) return undefined;
      return { type: "command", command: command as WebviewCommand };
    }
    default:
      return undefined;
  }
}
