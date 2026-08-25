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
 * `webview-client.ts`'s `KNOWN_HOST_MESSAGES` check, and each branch there
 * rebuilds the fields it reads rather than trusting the object's shape —
 * including `models`, which is the one host message carrying a list.
 *
 * ## The protocol boundary, restated
 *
 * RFC 0004 §0 freezes what a client may drive: `prompt`, `steer`, `abort`,
 * `setModel`, `respondToPermission`, `listModels`, `listSessions`,
 * `createSession`, `openSession`. Every message in the webview→host union
 * below lands on exactly one of those, on a VS Code command the extension
 * already contributes, or on nothing at all (`toggle` is view state; `copy` is
 * the clipboard). No message here invents a verb, and `setModel` in
 * particular is validated as a *string with a ceiling*, not against a
 * catalog: the catalog is the server's and the server validates the id, which
 * is where that check belongs and where `picker.ts`'s free-text row has always
 * left it.
 *
 * Pure, so both directions are testable with no `vscode` and no DOM.
 */

import type { ModelCatalogEntry } from "../serve/engine.js";
import type { ChatViewModel } from "./chat-state.js";
import {
  CONNECTION_ACTIONS,
  type ConnectionAction,
  type ConnectionActionId,
} from "./connection-card.js";
import type { ModelOption } from "./webview-models.js";

/** Ceiling on a prompt, mirroring nothing in particular — just not unbounded. */
export const MAX_PROMPT_LENGTH = 100_000;
/** Ceiling on a block id (ids are `kind:seq`, so this is generous). */
const MAX_BLOCK_ID_LENGTH = 200;
/**
 * Ceiling on a model id.
 *
 * Catalog ids are `provider/name`; the longest in the engine's own catalog is
 * well under 60 characters. 200 leaves room for an extension-registered id
 * without leaving the field unbounded.
 */
export const MAX_MODEL_ID_LENGTH = 200;
/**
 * Ceiling on text the page asks the host to put on the clipboard.
 *
 * A code block is capped at `MAX_RESULT_CHARS` on the way into the transcript,
 * so this is the transcript's own ceiling with room to spare — not a limit the
 * user can reach by copying something they can see.
 */
export const MAX_COPY_LENGTH = 100_000;

/** Commands the webview may ask the host to run. */
export const WEBVIEW_COMMANDS = ["model", "sessions", "newSession"] as const;

/** A command the webview may ask for. */
export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

/** Where the connection stands, as shown by the reconnect card. */
export type ConnectionStatus = "idle" | "starting" | "ready" | "disconnected";

/**
 * Where the model catalog stands.
 *
 * `"unavailable"` is the honest answer for an engine older than `listModels`
 * (`ProtocolClient.listModels` resolves `undefined`), and the panel says so
 * and still offers free text — the same degradation `picker.ts` has always
 * done. It is never reported as an empty catalog, which would read as "this
 * server has no models".
 */
export type ModelListStatus = "loading" | "ready" | "unavailable";

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
  | { type: "cost"; label: string }
  | {
      type: "models";
      status: ModelListStatus;
      /** The catalog, projected field by field. Empty unless `status` is `"ready"`. */
      models: ModelOption[];
      /** The model the chip should show: the last successful `setModel`, the
       * id the stream announced, or `arcturn.defaultModel`. */
      current?: string;
    }
  | {
      type: "session";
      sessionId?: string;
      /** The session's title, as the engine stored it. Rendered as text. */
      title?: string;
      cwd?: string;
    };

/** Webview → host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "abort" }
  | { type: "toggle"; blockId: string }
  | { type: "action"; id: ConnectionActionId }
  | { type: "command"; command: WebviewCommand }
  | { type: "requestModels" }
  | { type: "setModel"; modelId: string }
  | { type: "copy"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a string carries a control character.
 *
 * A model id ends up in the Output channel, in an error notification and on
 * the composer's chip. A newline in it would forge a second log line; an
 * escape sequence would be interpreted by a terminal reading that log. Checked
 * by code point rather than by a regex because a regex holding control
 * characters is itself the thing linters warn about.
 *
 * @param text - Candidate id.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Project one catalog entry into what the panel is given.
 *
 * Rebuilt field by field rather than forwarded: `ModelCatalogEntry` is engine
 * input, and a field the engine adds tomorrow must not reach the page without
 * somebody deciding it should. `maxOutputTokens` is dropped because the list
 * does not render it; `apiKeyEnv` is carried because the *name* of a variable
 * is what tells a user what to set, and the wire never carries its value.
 *
 * @param entry - One row of `listModels`.
 */
export function projectModelOption(entry: ModelCatalogEntry): ModelOption {
  return {
    id: entry.id,
    displayName: entry.displayName === "" ? entry.id : entry.displayName,
    provider: entry.provider,
    contextWindow: Number.isFinite(entry.contextWindow) ? entry.contextWindow : 0,
    ...(entry.cost === undefined
      ? {}
      : { cost: { input: entry.cost.input, output: entry.cost.output } }),
    ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
    credentials: entry.credentials,
  };
}

/**
 * Validate one message from the webview.
 *
 * @param value - Whatever arrived on `onDidReceiveMessage`.
 * @returns A freshly built message, or `undefined` when the value is not one
 *   of the nine the webview is allowed to send. The `action` case is validated
 *   against {@link CONNECTION_ACTIONS} rather than by shape alone.
 */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "abort":
      return { type: "abort" };
    case "requestModels":
      return { type: "requestModels" };
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
    case "setModel": {
      // Trimmed here rather than server-side so the id that reaches `setModel`
      // is the id the user meant. The *shape* check is what keeps a control
      // character out of the Output channel and out of a status bar; whether
      // the id names a real model is the engine's call, and it makes it.
      const raw = value.modelId;
      if (typeof raw !== "string") return undefined;
      const modelId = raw.trim();
      if (modelId === "" || modelId.length > MAX_MODEL_ID_LENGTH) return undefined;
      if (hasControlCharacter(modelId)) return undefined;
      return { type: "setModel", modelId };
    }
    case "copy": {
      const text = value.text;
      if (typeof text !== "string") return undefined;
      if (text === "" || text.length > MAX_COPY_LENGTH) return undefined;
      return { type: "copy", text };
    }
    default:
      return undefined;
  }
}
