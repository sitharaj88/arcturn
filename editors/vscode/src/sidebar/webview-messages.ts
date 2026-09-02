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
 * `resolveContext`, `permissionState`, `setPermissionMode`, `listCommands`,
 * `pendingChanges`, `applyChanges`, `discardChanges`, `listCheckpoints`,
 * `rewindTo`.
 * Every message in the webview→host union
 * below lands on exactly one of those, on a VS Code command the extension
 * already contributes, or on nothing at all (`toggle` is view state; `copy` is
 * the clipboard; `browseForFiles` is a native dialog). No message here invents
 * a verb — the last seven on that list were added to the *engine* first,
 * exactly as §0 prescribes, which is why `deleteSession` below is a wire verb
 * this file forwards rather than an extension-side `fs.unlink`, why
 * `setPermissionMode` is a wire verb rather than a mode the panel enforces on
 * its own, and why `applyChanges` is a wire verb rather than the extension
 * copying a shadow file over a workspace file — an apply the extension
 * performed would be an apply no permission engine and no symlink guard saw. And `setModel` in
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
import {
  MAX_CHANGE_SELECTION,
  MAX_CHECKPOINT_ID_LENGTH,
  MAX_CONTEXT_QUERY_LENGTH,
  MAX_PROMPT_ATTACHMENTS,
  MAX_WORKFLOW_INPUT_LENGTH,
  MAX_WORKFLOW_NAME_LENGTH,
  MAX_WORKFLOW_RUN_ID_LENGTH,
} from "../serve/engine.js";
import { ambientLabel } from "./active-editor.js";
import type { ChatViewModel } from "./chat-state.js";
import {
  CONNECTION_ACTIONS,
  type ConnectionAction,
  type ConnectionActionId,
} from "./connection-card.js";
import type { DryRunView } from "./dry-run.js";
import type { PermissionCard } from "./permission-surface.js";
import { escapeCodicons } from "./picker.js";
import type { RewindView } from "./rewind.js";
import type { CommandOption } from "./webview-commands.js";
import type { ModelOption } from "./webview-models.js";
import { PERMISSION_MODE_IDS } from "./webview-permission.js";
import type { SessionOption } from "./webview-sessions.js";
import type { WorkflowView } from "./workflows.js";

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
 * Ceiling on a permission button's label.
 *
 * The page echoes back the label it was given, and the labels are this
 * extension's own three constants (`dialog.ts`) — the longest is 23
 * characters. 120 is generous room for a label a future request could carry
 * while keeping the field bounded: it reaches `answerFromChoice`, which
 * compares it against those constants and denies anything else, and it reaches
 * nothing else at all.
 */
export const MAX_CHOICE_LENGTH = 120;
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
 * The chip for the file the user is looking at.
 *
 * A `ContextItem` with one extra field, deliberately: it is the *same* row an
 * `@` mention produces — same projection, same `ok`, same bytes, same refusal
 * — so the ambient chip and an explicit one cannot come to disagree about what
 * a file weighs or whether the engine will read it. What is added is the
 * lines, which change what the chip is *called* and nothing else.
 *
 * `selection` is present when a selection is what the label names, and the
 * page uses it for one purpose: to say plainly that the whole file is what
 * goes on the wire. See {@link projectActiveEditorItem}.
 */
export interface ActiveEditorItem extends ContextItem {
  /** The 1-based inclusive lines the label names, when there is a selection. */
  selection?: { startLine: number; endLine: number };
}

/**
 * Project the engine's answer about the active file into the ambient chip.
 *
 * Everything factual comes from {@link projectContextItem} — one projection,
 * so `ok` cannot mean two things on one chip row. The only work here is the
 * label, and the order of operations in it is load-bearing: the *path* is
 * escaped and the range is appended after, because the digits are this
 * module's own and escaping them would put a zero-width space in a line
 * number.
 *
 * `id` stays the path, not the label. Two selections in one file are one
 * attachment, and a chip keyed by its range would let the same file appear
 * twice.
 *
 * @param resolution - One `resolveContext` answer for the active file.
 * @param selection - The 1-based inclusive lines, when something is selected.
 */
export function projectActiveEditorItem(
  resolution: ContextResolution,
  selection?: { startLine: number; endLine: number },
): ActiveEditorItem {
  const item = projectContextItem(resolution);
  if (selection === undefined) return item;
  return {
    ...item,
    label: ambientLabel(item.label, selection),
    selection: { startLine: selection.startLine, endLine: selection.endLine },
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

/**
 * Commands the webview may ask the host to run.
 *
 * Each one is an id the host turns into a VS Code command it already
 * contributes (see `SIDEBAR_COMMANDS` in `index.ts`) — never a string the page
 * gets to choose, which is why this is a closed list and the validator below
 * checks membership rather than shape.
 *
 * `cost` is here because `/cost` in the terminal opens a readout, and the
 * panel already has one: `arcturn.showCost`, driven by the running totals
 * `cost.ts` folds out of the `turnEnd` events this extension is already
 * receiving. No verb was added for it and none should be — a `cost` verb would
 * be a second source for numbers the panel already holds, which is exactly
 * what `@arcturn/server`'s `built-in-commands.ts` refuses.
 */
export const WEBVIEW_COMMANDS = ["model", "sessions", "newSession", "cost"] as const;

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
  /**
   * Put text in the composer, without sending it.
   *
   * For material a person should read and edit before spending a turn on —
   * today that is an MCP prompt template, rendered by a remote server. The
   * page replaces the composer's contents rather than appending, because the
   * caller is offering a whole prompt rather than a fragment.
   */
  | { type: "prefill"; text: string }
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
  | {
      type: "context";
      items: ContextItem[];
      /**
       * The file the user is looking at, when the panel is watching for it.
       *
       * On the *same* message as the explicit chips, not one of its own, for
       * the reason the list is whole rather than deltas: the row the user
       * reads has to be the set the next prompt carries, and two messages can
       * arrive in either order. Absent when `arcturn.context.activeEditor` is
       * off, when no file is open, or when the engine has not answered for it
       * yet — the chip appears only once its byte count is the engine's.
       */
      active?: ActiveEditorItem;
    }
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
  /**
   * The permission request the panel should ask about, or nothing.
   *
   * The message that moved permissions off a native modal and into the dock
   * (RFC 0005 §2, amended). Everything in `request` was projected from the
   * engine's own `permissionRequest` by `permissionCard`, so the card renders
   * the engine's words and never transcript text; the card is drawn into
   * `#permission`, which lives in `#dock` and is a region the transcript never
   * writes into.
   *
   * An absent `request` **withdraws** whatever card is up — the request was
   * answered, escalated to a modal because the panel went out of view, or
   * denied by a disposal. The host is the only thing that puts a card up and
   * the only thing that takes one down.
   */
  | { type: "permissionAsk"; request?: PermissionCard }
  /** What a `/` could invoke here, projected field by field. */
  | { type: "commands"; status: CommandListStatus; commands: CommandOption[] }
  /**
   * What a `--dry-run` session is holding back.
   *
   * A whole-view message rather than a count, for the reason `context` is a
   * whole list rather than deltas: the host owns what the review card acts on,
   * and a card that kept its own tally could offer to apply a set the engine
   * no longer has. `status` carries the three different reasons there might be
   * no card — not asked yet, this engine is not in dry-run mode, this engine
   * has no such verb — because they are three different sentences.
   */
  | { type: "dryRun"; view: DryRunView }
  /**
   * The workflow catalog, and the run the panel is following.
   *
   * A whole-view message rather than a catalog plus progress deltas, for the
   * reason `dryRun` is one: the host owns what the card acts on. A card that
   * tallied its own progress from the narration arriving on the event stream
   * would drift from `/workflow status` in a terminal looking at the same run —
   * the notices are narration, the journal these numbers come from is the
   * record.
   *
   * `status` carries the three different reasons there might be no workflow
   * surface — not asked yet, this workspace defines none, this engine has no
   * such verb — because they are three different sentences.
   */
  | { type: "workflows"; view: WorkflowView }
  /**
   * The turns this session could be rewound to, and what each would cost.
   *
   * A whole-view message rather than a list, for the reason `dryRun` is one:
   * the host owns what the picker acts on, and a picker holding its own copy
   * could offer a rewind whose price the engine no longer agrees with — which
   * is precisely what the engine's echoed confirmation refuses. `status`
   * carries the four different reasons there might be no picker (not asked
   * yet, this engine keeps no checkpoints, this engine has no such verb, or a
   * refusal to report) because they are four different sentences.
   */
  | { type: "rewind"; view: RewindView }
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
   * Stop watching the active editor.
   *
   * What the ambient chip's dismiss control sends, and the reason it carries
   * no payload: it turns `arcturn.context.activeEditor` **off** and can do
   * nothing else. A boolean here would let a page turn the watching back on
   * for somebody who had switched it off in their settings, which is the one
   * direction this control must not be able to move.
   *
   * Deliberately not a per-message dismissal. The chip is a render of where
   * the caret is; removing it for one prompt would put it back on the next
   * keystroke, and a control that undoes itself is worse than no control.
   */
  | { type: "disableActiveEditorContext" }
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
  /**
   * Answer the permission card: which button was pressed, on which request.
   *
   * The page names a **label**, not a decision. What the label means is
   * `answerFromChoice`'s call — the same function the native modal's answer
   * goes through — and it denies everything that is not one of the two allow
   * labels, so a page cannot express "allow" by inventing a word. It cannot
   * express a rule at all: "allow for this session" persists the rule the
   * *engine* attached to the request, re-derived on the host, and a request
   * with no suggested rule allows once no matter which label comes back.
   *
   * `requestId` is the engine's own id, echoed from the card. The host drops
   * an answer that does not name the request it is currently showing, so a
   * reloaded page holding a stale card cannot answer for a live request.
   */
  | { type: "permissionDecision"; requestId: string; choice: string }
  /** Ask the session to run under a different mode from the next turn. */
  | { type: "setPermissionMode"; mode: PermissionMode }
  /** Ask for the `/` menu's contents. */
  | { type: "requestCommands" }
  /** Ask what the dry run is holding back. Read-only; nothing is applied. */
  | { type: "requestDryRun" }
  /**
   * Open the change for review.
   *
   * The host answers by opening **VS Code's own diff editor** — the workspace
   * file against the pending content — not by rendering a patch in this page.
   * That is the whole reason this loop belongs in an editor, and it is also
   * why the page never receives the file's bytes: it has nothing to render.
   *
   * `path` names one change; omitted, the host opens the first one and, when
   * there are several, offers the list.
   */
  | { type: "showDiff"; path?: string }
  /**
   * Land pending changes on the user's real files.
   *
   * The host asks the **engine** to write them — this extension never writes a
   * workspace file itself (RFC 0004 §0), which is also the only version that
   * inherits the engine's symlink refusal and its mid-run `sessionBusy`.
   *
   * `paths` selects a subset; omitted, everything the engine is holding.
   */
  | { type: "applyChanges"; paths?: string[] }
  /**
   * Throw pending changes away. **Irreversible.**
   *
   * The host confirms with a native modal naming the files before anything
   * happens — `dialog.ts`'s discipline for `deleteSession`, applied to the
   * other destructive control on this surface. A webview button is not a
   * confirmation.
   */
  | { type: "discardChanges" }
  /** Ask which turns this session could be rewound to. Read-only. */
  | { type: "requestCheckpoints" }
  /** Ask for the workflow catalog. Read-only; nothing is started. */
  | { type: "requestWorkflows" }
  /**
   * Start a workflow run. **Spends real money, and a write-lane role's patch
   * lands in the user's checkout when its step succeeds.**
   *
   * The host confirms with a native modal naming the spend ceiling and every
   * role that can act before anything starts — `dialog.ts`'s discipline for
   * `deleteSession` and `dry-run.ts`'s for `discardChanges`, applied to the one
   * control on this surface that spends money. A webview button is not a
   * confirmation.
   *
   * The panel deliberately carries **no budget**: the engine accepts one only
   * to *lower* the workflow file's own ceiling, and a number typed into a
   * webview is not a decision a person made about money. The file's ceiling is
   * shown in the modal and enforced by the engine; a box for it in the panel
   * would mostly be an offer to raise it, which the engine then refuses.
   */
  | { type: "runWorkflow"; name: string; input?: string }
  /**
   * Re-enter an interrupted run, carrying the answer to its `ORG-ASK:`.
   *
   * The answer is the person's own words, forwarded verbatim — the panel never
   * summarises a question and never answers one. Sent with no `answer` it asks
   * the engine to re-surface the question instead, which is what the terminal's
   * bare `/workflow resume <runId>` does.
   */
  | { type: "resumeWorkflow"; runId: string; answer?: string }
  /**
   * Ask the host to prompt for a new ceiling and resume the run with it.
   *
   * The page never collects the number itself — a webview has no
   * `showInputBox`, and this is the one control on the workflow surface that
   * spends the *operator's own* money or turns, so the same native-modal
   * discipline `runWorkflow`'s confirmation follows applies here: the host
   * asks, validates (a positive integer greater than the pending park's own
   * `current`, when known), and only then sends `resumeWorkflow` with
   * `answer: "raise <n>"` — reusing that verb rather than adding a second one,
   * because a raise is exactly an answer to the park in question. Offered by
   * the page only when the engine's `capabilities.ceilingRaise` is `true`
   * *and* the run's pending question carries a `raise` shape — this message
   * makes neither claim itself, so the host does not have to trust it.
   */
  | { type: "raiseCeiling"; runId: string }
  /**
   * Restore files to a checkpoint and fork the conversation. **Irreversible.**
   *
   * The host confirms with a native modal naming the file count and the files
   * before anything happens — `dialog.ts`'s discipline for `deleteSession` and
   * `dry-run.ts`'s for `discardChanges`, applied to the one control on this
   * surface that both overwrites and unlinks a person's files. A webview
   * button is not a confirmation.
   *
   * The restore itself is the engine's `rewindTo` verb: this extension never
   * writes a workspace file and never unlinks one (RFC 0004 §0), which is also
   * the only version that inherits the engine's workspace confinement and its
   * mid-run `sessionBusy`.
   *
   * `confirmation` is carried back verbatim from the row the page rendered, so
   * the engine can refuse a rewind whose cost has changed since — the page is
   * a courier for it, never an author of one.
   */
  | { type: "rewindTo"; checkpointId: string; confirmation: string }
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
    case "requestDryRun":
      return { type: "requestDryRun" };
    case "requestCheckpoints":
      return { type: "requestCheckpoints" };
    case "requestWorkflows":
      return { type: "requestWorkflows" };
    case "runWorkflow": {
      // The name is identity — it is what `runWorkflow` is sent — so it gets
      // the shape rules `setModel`'s id gets: bounded, and no control
      // character, because it reaches a native modal and the Output channel.
      // Whether it names a workflow this engine has is the engine's answer to
      // give, and it gives it by naming the ones it does have.
      const raw = value.name;
      if (typeof raw !== "string") return undefined;
      const name = raw.trim();
      if (name === "" || name.length > MAX_WORKFLOW_NAME_LENGTH) return undefined;
      if (hasControlCharacter(name)) return undefined;
      const input = value.input;
      if (input === undefined) return { type: "runWorkflow", name };
      // `{{input}}` is prose a person typed into the composer, so newlines are
      // legal here in a way they are not for an id — a pasted PR description is
      // exactly what this field is for. Bounded on the engine's own terms.
      if (typeof input !== "string") return undefined;
      if (input.length > MAX_WORKFLOW_INPUT_LENGTH) return undefined;
      return { type: "runWorkflow", name, input };
    }
    case "resumeWorkflow": {
      const rawId = value.runId;
      if (typeof rawId !== "string") return undefined;
      const runId = rawId.trim();
      if (runId === "" || runId.length > MAX_WORKFLOW_RUN_ID_LENGTH) return undefined;
      if (hasControlCharacter(runId)) return undefined;
      const answer = value.answer;
      if (answer === undefined) return { type: "resumeWorkflow", runId };
      // A human's answer to a design question. Multi-line on purpose, and
      // never trimmed to a single line: the engine splices it in place of the
      // asking step's output, and truncating it here would put words in a
      // person's mouth.
      if (typeof answer !== "string") return undefined;
      if (answer.length > MAX_WORKFLOW_INPUT_LENGTH) return undefined;
      return { type: "resumeWorkflow", runId, answer };
    }
    case "raiseCeiling": {
      const rawId = value.runId;
      if (typeof rawId !== "string") return undefined;
      const runId = rawId.trim();
      if (runId === "" || runId.length > MAX_WORKFLOW_RUN_ID_LENGTH) return undefined;
      if (hasControlCharacter(runId)) return undefined;
      return { type: "raiseCeiling", runId };
    }
    case "discardChanges":
      // No payload: the *whole* pending set, which is what the card's Discard
      // offers. The host names the files in a modal before anything happens.
      return { type: "discardChanges" };
    case "browseForFiles":
      return { type: "browseForFiles" };
    case "disableActiveEditorContext":
      // No payload read at all, deliberately: whatever else the page put on
      // this message is dropped, so the only thing it can express is "off".
      return { type: "disableActiveEditorContext" };
    case "permissionDecision": {
      // Two rebuilt strings and nothing else: whatever else the page put on
      // this message — a behavior, a rule, a scope — is dropped here rather
      // than trusted downstream. The id gets `openSession`'s shape rules
      // because it reaches the Output channel; the label is bounded and
      // control-free for the same reason, and is then handed to
      // `answerFromChoice` rather than checked against a list, because a label
      // this extension does not recognise must DENY rather than vanish.
      const rawId = value.requestId;
      const rawChoice = value.choice;
      if (typeof rawId !== "string" || typeof rawChoice !== "string") return undefined;
      const requestId = rawId.trim();
      if (requestId === "" || requestId.length > MAX_SESSION_ID_LENGTH) return undefined;
      if (hasControlCharacter(requestId)) return undefined;
      if (rawChoice === "" || rawChoice.length > MAX_CHOICE_LENGTH) return undefined;
      if (hasControlCharacter(rawChoice)) return undefined;
      return { type: "permissionDecision", requestId, choice: rawChoice };
    }
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
    case "showDiff": {
      // Optional, and rebuilt: an absent path means "open the review", a
      // present one names a row. Bounded and control-character-free like every
      // other path on this boundary, because it reaches a diff editor's tab
      // title and the Output channel. Whether it names a pending change is the
      // engine's answer to give, and `pendingChanges` gives it.
      const raw = value.path;
      if (raw === undefined) return { type: "showDiff" };
      if (typeof raw !== "string") return undefined;
      if (raw === "" || raw.length > MAX_CONTEXT_QUERY_LENGTH) return undefined;
      if (hasControlCharacter(raw)) return undefined;
      return { type: "showDiff", path: raw };
    }
    case "applyChanges": {
      // The one message on this boundary that ends in somebody's files being
      // written, so it is rebuilt element by element with a ceiling — and an
      // **empty array is refused** rather than passed through, because on the
      // wire an omitted selection means "everything" and an empty one would
      // silently become the same request. The engine refuses it too; this
      // stops it a round trip earlier and at the boundary that owns shape.
      const raw = value.paths;
      if (raw === undefined) return { type: "applyChanges" };
      if (!Array.isArray(raw)) return undefined;
      if (raw.length === 0 || raw.length > MAX_CHANGE_SELECTION) return undefined;
      const paths: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== "string") return undefined;
        if (entry === "" || entry.length > MAX_CONTEXT_QUERY_LENGTH) return undefined;
        if (hasControlCharacter(entry)) return undefined;
        paths.push(entry);
      }
      return { type: "applyChanges", paths };
    }
    case "rewindTo": {
      // The one message on this boundary that ends in somebody's files being
      // **deleted**, so both fields are rebuilt with a ceiling and neither is
      // optional. `confirmation` in particular is required rather than
      // defaulted: it is the page's proof that it rendered the cost the engine
      // computed, and a message that could arrive without one would make "the
      // user was shown this" indistinguishable from "the page did not bother".
      // Whether either value names anything real is the engine's answer to
      // give, and `rewindTo` gives it.
      const id = value.checkpointId;
      const confirmation = value.confirmation;
      if (typeof id !== "string" || typeof confirmation !== "string") return undefined;
      if (id === "" || id.length > MAX_CHECKPOINT_ID_LENGTH) return undefined;
      if (confirmation === "" || confirmation.length > MAX_CHECKPOINT_ID_LENGTH) return undefined;
      if (hasControlCharacter(id) || hasControlCharacter(confirmation)) return undefined;
      return { type: "rewindTo", checkpointId: id, confirmation };
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
