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
  | { type: "connection"; status: ConnectionStatus; detail?: string }
  | { type: "cost"; label: string };

/** Webview → host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "abort" }
  | { type: "reconnect" }
  | { type: "toggle"; blockId: string }
  | { type: "command"; command: WebviewCommand };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one message from the webview.
 *
 * @param value - Whatever arrived on `onDidReceiveMessage`.
 * @returns A freshly built message, or `undefined` when the value is not one
 *   of the six the webview is allowed to send.
 */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "abort":
      return { type: "abort" };
    case "reconnect":
      return { type: "reconnect" };
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
