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
 * `createSession`, `openSession`, `sessionHistory`, `deleteSession`,
 * `resolveContext`, `permissionState`, `setPermissionMode`, `listCommands`.
 * Every message in the webview→host union
 * below lands on exactly one of those, on a VS Code command the extension
 * already contributes, or on nothing at all (`toggle` is view state; `copy` is
 * the clipboard; `browseForFiles` is a native dialog). No message here invents
 * a verb — the last seven on that list were added to the *engine* first,
 * exactly as §0 prescribes, which is why `deleteSession` below is a wire verb
 * this file forwards rather than an extension-side `fs.unlink`, and why
 * `setPermissionMode` is a wire verb rather than a mode the panel enforces on
 * its own. And `setModel` in
 * particular is validated as a *string with a ceiling*, not against a
 * catalog: the catalog is the server's and the server validates the id, which
 * is where that check belongs and where `picker.ts`'s free-text row has always
 * left it. `setPermissionMode` is the deliberate exception — it *is* checked
 * against a fixed set, because it is the one message here that changes what
 * the agent is allowed to do.
 *
 * Pure, so both directions are testable with no `vscode` and no DOM.
 */

import type {
  CommandDescriptor,
  ContextKind,
  ContextResolution,
  ModelCatalogEntry,
  PermissionMode,
  SessionHeader,
} from "../serve/engine.js";
import { MAX_CONTEXT_QUERY_LENGTH, MAX_PROMPT_ATTACHMENTS } from "../serve/engine.js";
import type { ChatViewModel } from "./chat-state.js";
import {
  CONNECTION_ACTIONS,
  type ConnectionAction,
  type ConnectionActionId,
} from "./connection-card.js";
import { escapeCodicons } from "./picker.js";
import type { CommandOption } from "./webview-commands.js";
import type { ModelOption } from "./webview-models.js";
import { PERMISSION_MODE_IDS } from "./webview-permission.js";
import type { SessionOption } from "./webview-sessions.js";

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
/**
 * Ceiling on a session id.
 *
 * The engine mints ULIDs — 26 characters — but the id is the engine's to
 * choose, so this is the same generous-but-bounded ceiling a model id gets
 * rather than a length assertion about a format this extension does not own.
 */
export const MAX_SESSION_ID_LENGTH = 200;
/**
 * Ceiling on the base64 of one pasted image.
 *
 * ~6.8 MB of base64, so ~5 MB of pixels — comfortably above a full-screen
 * retina screenshot and well below "a paste can hand the host an unbounded
 * string". The engine caps the whole attachment budget on its own side too;
 * this is the ceiling on what crosses the *webview* boundary, which is the one
 * this file is responsible for.
 */
export const MAX_IMAGE_DATA_LENGTH = 6_800_000;

/**
 * Image types the engine will actually take, mirroring `validate.ts`'s
 * `IMAGE_MIME_TYPES` on purpose.
 *
 * Checked here rather than left to the round trip because the point of the
 * chip is to say what will happen *before* a turn is spent (RFC 0005 §4). A
 * paste of an SVG is refused at this boundary with the chip never appearing,
 * rather than accepted, shown, and then rejected by the engine when the user
 * presses Enter. `image/svg+xml` is not on the list for a second reason worth
 * naming: an SVG is a document that can carry script, not a bitmap.
 */
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** Standard base64, padding included, and nothing else. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * One thing the composer is holding, or one candidate the picker is offering.
 *
 * `path` and `label` are deliberately two fields carrying nearly the same
 * string. `path` is **identity**: it is what `detach` quotes back, what the
 * host dedupes on, and what the engine is sent as a `PromptAttachment`. `label`
 * is **display**, and so is escaped on the way out — the engine chose that
 * string (it is a filename on the user's disk), and an engine-supplied string
 * reaching a rendered field without escaping is a finding this codebase has
 * already had once. See `picker.ts`'s `escapeCodicons`.
 */
export interface ContextItem {
  /** Stable id for `detach`. The workspace-relative path, or the absolute one when outside. */
  id: string;
  /** The path as the engine resolved it, unescaped — identity, not display. */
  path: string;
  /** What to show. Escaped. */
  label: string;
  /** Size in bytes; `0` when nothing was measured. */
  bytes: number;
  /** What the engine found there. */
  kind: ContextKind;
  /**
   * Whether this can actually be attached and sent.
   *
   * The whole point of the `resolveContext` round trip: a chip that cannot be
   * sent says so before the user presses enter, rather than turning into a
   * refused prompt. RFC 0005 §1.1 — "what makes a file picker honest rather
   * than hopeful".
   */
  ok: boolean;
  /** Why not, when `ok` is `false`. Escaped. */
  reason?: string;
}

/**
 * Project one engine resolution into a panel row.
 *
 * Rebuilt field by field for the reason {@link projectModelOption} gives, and
 * with one judgement of its own: `ok` is computed *here*, from the engine's
 * facts, rather than sent by the engine. The engine reports what is true
 * (`inWorkspace`, `exists`, `kind`); whether that adds up to "attachable" is
 * the panel's question, and keeping it on this side means the answer cannot
 * drift from the chip that renders it.
 *
 * @param resolution - One `resolveContext` answer.
 */
export function projectContextItem(resolution: ContextResolution): ContextItem {
  const path = resolution.inWorkspace ? resolution.relativePath : resolution.path;
  const ok =
    resolution.inWorkspace &&
    resolution.exists &&
    (resolution.kind === "file" || resolution.kind === "image");
  return {
    id: path,
    path,
    label: escapeCodicons(path),
    bytes: Number.isFinite(resolution.bytes) ? resolution.bytes : 0,
    kind: resolution.kind,
    ok,
    ...(resolution.reason === undefined ? {} : { reason: escapeCodicons(resolution.reason) }),
  };
}

/**
 * Project one `listCommands` entry into a menu row.
 *
 * Rebuilt field by field for the reason {@link projectModelOption} gives, and
 * with one thing this projection does that the model one does not: it
 * **escapes**. A skill's `description` is frontmatter from a markdown file
 * under `<cwd>/.arcturn/skills`, which is to say content a cloned repository
 * controls; `source` is a path on the user's disk. Both reach a rendered field
 * — the menu here, and a `showErrorMessage` on the failure path in `index.ts`,
 * where VS Code's `IconLabel` expands `$(name)` into a real glyph. A skill
 * described as `$(verified) Trusted by Arcturn` would otherwise render with a
 * badge the engine never gave it. See `picker.ts`'s `escapeCodicons`, and
 * `ContextItem`, which had exactly this finding once already.
 *
 * @param descriptor - One row of `listCommands`.
 */
export function projectCommandOption(descriptor: CommandDescriptor): CommandOption {
  return {
    name: descriptor.name,
    description: escapeCodicons(descriptor.description),
    kind: descriptor.kind === "builtin" ? "builtin" : "skill",
    ...(descriptor.source === undefined ? {} : { source: escapeCodicons(descriptor.source) }),
  };
}

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

/**
 * Where the session list stands.
 *
 * Four states rather than three, because "cannot show you a list" has two
 * different causes and they call for two different sentences: the engine is
 * not connected (fix it with the card the panel is still showing), or the
 * engine is connected and `listSessions` failed (the Output channel has the
 * reason). Collapsing them would make the panel tell one of those two groups
 * of users something untrue — and a user with fifty sessions being told this
 * workspace has none is exactly the silent wrong answer this codebase keeps
 * refusing to give.
 */
export type SessionListStatus = "loading" | "ready" | "disconnected" | "failed";

/**
 * Where the session's permission state stands.
 *
 * `"unavailable"` is the honest answer for an engine older than
 * `permissionState` (`ProtocolClient.permissionState` resolves `undefined`),
 * and it is a *different* thing from `"default"`: the panel does not know the
 * mode, so it says so and offers no chip that claims one. RFC 0005 §3 — a
 * capability is never implied by an affordance, and neither is a restriction.
 */
export type PermissionStateStatus = "loading" | "ready" | "unavailable";

/**
 * Where the command list stands.
 *
 * `"unavailable"` is an engine older than `listCommands`. The `/` menu then
 * shows nothing at all rather than an empty list of skills, because "this
 * workspace has no skills" and "this engine cannot tell me" are not the same
 * news — the same distinction {@link SessionListStatus} draws, for the same
 * reason.
 */
export type CommandListStatus = "loading" | "ready" | "unavailable";

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
      type: "sessions";
      status: SessionListStatus;
      /** This workspace's sessions, projected field by field. Empty unless `status` is `"ready"`. */
      sessions: SessionOption[];
      /** The session the panel is attached to, so its row can say so. */
      current?: string;
      /** The folder a new session would be started in. */
      cwd?: string;
    }
  /**
   * Open the in-panel history view.
   *
   * The panel's header button and `arcturn.showSessions` are two doors to one
   * surface, and this is what makes them one: the palette command reveals the
   * view and posts this, rather than opening a second, native list of its own.
   */
  | { type: "showSessions" }
  /**
   * What the composer is holding right now, in full.
   *
   * A whole-list message rather than add/remove deltas: the host owns the set
   * (it is what `send` actually attaches), and a panel that rebuilt it from
   * deltas could disagree with what the next prompt carries — which is the one
   * thing a chip row must never do.
   */
  | { type: "context"; items: ContextItem[] }
  /**
   * The answer to one `resolveContext`, echoing the query it answers.
   *
   * `status` is the difference between "the workspace has no file like that"
   * and "this engine has no `resolveContext`, so nothing here can be
   * answered honestly" — and they are not the same news. On `"unavailable"`
   * the panel closes the picker rather than showing an empty one, which is
   * the same choice the `/` menu makes for an engine with no `listCommands`.
   */
  | {
      type: "contextCandidates";
      query: string;
      items: ContextItem[];
      status?: "ready" | "unavailable";
    }
  /**
   * The session's permission regime, as the engine last reported it.
   *
   * `mode` is present only when `status` is `"ready"`, and the page treats its
   * absence as "unknown" rather than as `"default"` — see
   * `webview-permission.ts` for why that distinction is the whole point of
   * this message.
   */
  | {
      type: "permission";
      status: PermissionStateStatus;
      /** The mode in force. Absent when the engine did not say. */
      mode?: string;
      /** The names of the tools this session holds, for the capability line. */
      tools: string[];
      /**
       * Why the last `setPermissionMode` did not take, when it did not.
       *
       * Carried on the *same* message as the mode so the two cannot disagree:
       * a refusal arrives with the mode still in force, and the chip snaps
       * back to it in the same paint that shows the sentence. Rendered as
       * text; escaped by the host before it gets here.
       */
      note?: string;
    }
  /** What a `/` could invoke here, projected field by field. */
  | { type: "commands"; status: CommandListStatus; commands: CommandOption[] }
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
  | { type: "requestSessions" }
  | { type: "openSession"; sessionId: string }
  /**
   * Delete a session, permanently.
   *
   * The host confirms with a native modal before anything happens, and the
   * deletion itself is the engine's `deleteSession` verb — this extension
   * never unlinks a session file itself. The shape is fixed: the panel's
   * delete control sends exactly this.
   */
  | { type: "deleteSession"; sessionId: string }
  /**
   * Ask what a mention would resolve to. The host answers with
   * `contextCandidates`; nothing is attached and no turn is started.
   */
  | { type: "resolveContext"; query: string }
  /**
   * Attach one or more paths.
   *
   * The **host** resolves and validates them — the panel never reads a file to
   * build a prompt (RFC 0005 §3) and never decides for itself whether a path is
   * attachable. The answer is a `context` message carrying the whole set.
   */
  | { type: "attach"; paths: string[] }
  /** Drop one chip, by the `id` the host gave it. */
  | { type: "detach"; id: string }
  /**
   * Attach an image that has no path — a paste, or a drop from outside the
   * filesystem. The only inbound message carrying bytes rather than a
   * reference, and the only kind of attachment for which the engine accepts
   * inline data at all (RFC 0005 §1.1); a file that exists on disk is read by
   * the engine from its path, where the permission engine can see it.
   */
  | { type: "attachImage"; data: string; mimeType: string }
  /**
   * Open the host's native file dialog and attach whatever comes back.
   *
   * The dialog is the *host's* — `vscode.window.showOpenDialog` — because a
   * webview cannot read a path off a `File` object and a picker that could not
   * name what it picked would be a picker that attached nothing.
   */
  | { type: "browseForFiles" }
  /** Ask for the session's permission mode and tool set. */
  | { type: "requestPermission" }
  /** Ask the session to run under a different mode from the next turn. */
  | { type: "setPermissionMode"; mode: PermissionMode }
  /** Ask for the `/` menu's contents. */
  | { type: "requestCommands" }
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

/** Trailing separators make two spellings of one directory. */
function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  return trimmed === "" ? cwd : trimmed;
}

/**
 * Project `listSessions` into the rows the panel is given.
 *
 * `listSessions` returns every session the server knows about, across working
 * directories; RFC 0004 §1 asks for "`listSessions` for this cwd", so the
 * filter is here — the page is never told a cwd because every row it shows
 * shares one. Ordering is deliberately *not* here: the page sorts, in
 * `webview-sessions.ts`, and one sort in one place cannot drift from another.
 *
 * Rebuilt field by field for the reason {@link projectModelOption} gives:
 * `SessionHeader` is engine input, and `version` is protocol bookkeeping the
 * panel does not render.
 *
 * @param headers - Everything `listSessions` returned.
 * @param cwd - The workspace folder to keep.
 */
export function projectSessions(headers: readonly SessionHeader[], cwd: string): SessionOption[] {
  const wanted = normalizeCwd(cwd);
  const rows: SessionOption[] = [];
  for (const header of headers) {
    if (typeof header.sessionId !== "string" || header.sessionId === "") continue;
    if (normalizeCwd(header.cwd) !== wanted) continue;
    rows.push({
      sessionId: header.sessionId,
      title: typeof header.title === "string" ? header.title : "",
      // A header with no usable timestamp is not a session from 1970; the page
      // prints nothing for a zero rather than a date nobody chose.
      createdAt: Number.isFinite(header.createdAt) ? header.createdAt : 0,
    });
  }
  return rows;
}

/**
 * Validate one message from the webview.
 *
 * @param value - Whatever arrived on `onDidReceiveMessage`.
 * @returns A freshly built message, or `undefined` when the value is not one
 *   of the ones the webview is allowed to send. The `action` case is validated
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
    case "requestSessions":
      return { type: "requestSessions" };
    case "requestPermission":
      return { type: "requestPermission" };
    case "requestCommands":
      return { type: "requestCommands" };
    case "browseForFiles":
      return { type: "browseForFiles" };
    case "setPermissionMode": {
      // Against the engine's own four names, not a shape check: this is the
      // one message on this boundary that changes what the agent is allowed to
      // do, and a mode the engine does not recognise must not reach it as a
      // string it might interpret. `PERMISSION_MODE_IDS` is typed
      // `PermissionMode[]`, so a fifth mode added to the engine is a compile
      // error here rather than a mode the panel silently cannot offer.
      const mode = value.mode;
      if (typeof mode !== "string") return undefined;
      if (!(PERMISSION_MODE_IDS as readonly string[]).includes(mode)) return undefined;
      return { type: "setPermissionMode", mode: mode as PermissionMode };
    }
    case "attachImage": {
      // The only message that carries bytes. Three checks, each closing a
      // different hole: the alphabet (so nothing but base64 reaches `atob` on
      // the engine's side), the ceiling (so a paste is bounded), and the mime
      // type against the engine's own allowlist (so a chip never appears for
      // an image the turn would be refused for).
      const data = value.data;
      const mimeType = value.mimeType;
      if (typeof data !== "string" || typeof mimeType !== "string") return undefined;
      if (data === "" || data.length > MAX_IMAGE_DATA_LENGTH) return undefined;
      if (!BASE64.test(data)) return undefined;
      if (!(IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return undefined;
      return { type: "attachImage", data, mimeType };
    }
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
    case "openSession": {
      // Same shape check as `setModel`, for the same reason: the id reaches
      // the Output channel and an error notification, so a newline in it would
      // forge a log line. Whether it names a session the server has is the
      // server's answer to give, and `openSession` gives it.
      const raw = value.sessionId;
      if (typeof raw !== "string") return undefined;
      const sessionId = raw.trim();
      if (sessionId === "" || sessionId.length > MAX_SESSION_ID_LENGTH) return undefined;
      if (hasControlCharacter(sessionId)) return undefined;
      return { type: "openSession", sessionId };
    }
    case "deleteSession": {
      // Validated exactly like `openSession` — a rebuilt field, a ceiling and
      // no control characters — and for the same reason: the id reaches the
      // Output channel and a modal. That this one is destructive changes
      // nothing here; the confirmation and the refusal to touch files both
      // live past this boundary, in the host and in the engine respectively.
      const raw = value.sessionId;
      if (typeof raw !== "string") return undefined;
      const sessionId = raw.trim();
      if (sessionId === "" || sessionId.length > MAX_SESSION_ID_LENGTH) return undefined;
      if (hasControlCharacter(sessionId)) return undefined;
      return { type: "deleteSession", sessionId };
    }
    case "resolveContext": {
      // A path, with the same shape rules `setModel` gets: bounded, and no
      // control character, because the query is echoed back into a rendered
      // field and reaches the Output channel on failure. Whether it names
      // anything is the engine's answer to give, and `resolveContext` gives it.
      const raw = value.query;
      if (typeof raw !== "string") return undefined;
      if (raw.length > MAX_CONTEXT_QUERY_LENGTH) return undefined;
      if (hasControlCharacter(raw)) return undefined;
      return { type: "resolveContext", query: raw };
    }
    case "attach": {
      const raw = value.paths;
      if (!Array.isArray(raw)) return undefined;
      if (raw.length === 0 || raw.length > MAX_PROMPT_ATTACHMENTS) return undefined;
      const paths: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== "string") return undefined;
        if (entry === "" || entry.length > MAX_CONTEXT_QUERY_LENGTH) return undefined;
        if (hasControlCharacter(entry)) return undefined;
        paths.push(entry);
      }
      return { type: "attach", paths };
    }
    case "detach": {
      const raw = value.id;
      if (typeof raw !== "string") return undefined;
      if (raw === "" || raw.length > MAX_CONTEXT_QUERY_LENGTH) return undefined;
      if (hasControlCharacter(raw)) return undefined;
      return { type: "detach", id: raw };
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
