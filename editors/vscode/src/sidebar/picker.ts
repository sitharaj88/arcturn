/**
 * The two quick-picks — sessions and models — as pure item builders.
 *
 * ### Sessions
 *
 * `listSessions` returns every session the server knows about, across working
 * directories; RFC 0004 §1 asks for "`listSessions` for this cwd", so the
 * filter is here. "Open, resume, or start new" collapses to two outcomes for a
 * client: attach to an existing `sessionId` (`openSession`) or create one
 * (`createSession`) — the engine exposes no third verb, and per RFC §0 the
 * extension does not invent one.
 *
 * ### Models
 *
 * RFC 0004 §1 describes the model picker as a "quick-pick fed by the session's
 * catalog". **The protocol has no catalog verb.** `ProtocolClient` is
 * `authenticate`, `listSessions`, `createSession`, `openSession`, `prompt`,
 * `steer`, `abort`, `setModel`, `respondToPermission`, `onEvent`, `close` —
 * and §0 is explicit that a sidebar feature needing a verb this list lacks is
 * an engine RFC, not an extension hack. So the picker is fed from what the
 * client can honestly know: model ids the engine itself announced on this
 * session's stream, the workspace's configured default, and a free-text entry
 * for anything else. `setModel` then validates the id server-side, which is
 * where that validation belongs anyway.
 *
 * ### Why labels are escaped
 *
 * A `vscode.QuickPickItem`'s `label`, `description` and `detail` are rendered
 * through VS Code's `IconLabel` with `supportIcons` on, which turns `$(name)`
 * into a real glyph. Session titles, session ids and model ids all arrive from
 * the engine — and a session title is model-influenceable — so a session named
 * `$(check) Trusted session` would render with an actual checkmark and read as
 * system-blessed. Every engine-supplied string is therefore passed through
 * {@link escapeCodicons} on its way into a rendered field. The extension's own
 * `$(add)` / `$(edit)` affordances are literals in this file, not engine input,
 * and stay live.
 */

import type { SessionHeader } from "../serve/engine.js";

/**
 * One row of the sessions quick-pick.
 *
 * The discriminant is `action`, not `kind`: `vscode.QuickPickItem` already
 * defines `kind` as its separator enum, and these items are handed straight to
 * `showQuickPick`.
 */
export interface SessionPickItem {
  /** `"session"` to open an existing one, `"new"` to create one. */
  action: "session" | "new";
  label: string;
  description?: string;
  detail?: string;
  /** Present only on a `"session"` row. */
  sessionId?: string;
}

/** Options for {@link sessionPickItems}. */
export interface SessionPickOptions {
  /** Workspace folder to filter by. */
  cwd: string;
  /** The session already open in the sidebar, if any. */
  activeSessionId?: string;
}

/**
 * Codicon syntax as VS Code's own `iconLabels.ts` matches it: `$(name)` with an
 * optional `~modifier`, and an optional leading backslash marking a sequence
 * that is already escaped.
 */
const CODICON = /(\\)?\$\([A-Za-z0-9-]+(?:~[A-Za-z]+)?\)/g;

/**
 * Neutralise codicon syntax in a string that is about to be rendered.
 *
 * Mirrors VS Code's `escapeIcons`: an unescaped `$(name)` gets a backslash in
 * front of it, which is exactly the escape the renderer's own parser honours,
 * so the user sees the characters the engine actually sent instead of a glyph.
 * A sequence that is already escaped is left alone rather than double-escaped.
 *
 * This is sanitization, not paraphrasing — nothing is dropped, reordered or
 * reworded, and it is applied only to *rendered* fields. The `sessionId` and
 * `modelId` that go back to the engine are never touched.
 *
 * @param text - An engine-supplied string bound for a rendered field.
 */
export function escapeCodicons(text: string): string {
  return text.replace(CODICON, (match: string, escaped: string | undefined) =>
    escaped === undefined ? `\\${match}` : match,
  );
}

/** Trailing separators make two spellings of one directory. */
function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  return trimmed === "" ? cwd : trimmed;
}

/**
 * Build the sessions quick-pick.
 *
 * @param headers - Everything `listSessions` returned.
 * @param options - See {@link SessionPickOptions}.
 * @returns Newest session first, always ending with a "new session" row.
 */
export function sessionPickItems(
  headers: readonly SessionHeader[],
  options: SessionPickOptions,
): SessionPickItem[] {
  const cwd = normalizeCwd(options.cwd);
  const mine = headers
    .filter((header) => normalizeCwd(header.cwd) === cwd)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  const items: SessionPickItem[] = mine.map((header) => ({
    action: "session" as const,
    label: escapeCodicons(header.title ?? header.sessionId),
    sessionId: header.sessionId,
    ...(header.sessionId === options.activeSessionId ? { description: "current" } : {}),
    detail: `${escapeCodicons(header.sessionId)} · ${new Date(header.createdAt).toLocaleString()}`,
  }));

  items.push({
    action: "new",
    label: "$(add) New session",
    detail: `Start a new Arcturn session in ${escapeCodicons(options.cwd)}`,
  });
  return items;
}

/** One row of the model quick-pick. See {@link SessionPickItem} on `action`. */
export interface ModelPickItem {
  /** `"model"` to switch to `modelId`, `"other"` to prompt for one. */
  action: "model" | "other";
  label: string;
  description?: string;
  /** Present only on a `"model"` row. */
  modelId?: string;
}

/** Options for {@link modelPickItems}. */
export interface ModelPickOptions {
  /** Model ids seen on this session's stream, oldest first. */
  observed: readonly string[];
  /** `arcturn.defaultModel`, when the workspace sets one. */
  configured?: string;
  /** The model currently in use. */
  current?: string;
}

/**
 * Build the model quick-pick.
 *
 * @param options - See {@link ModelPickOptions}.
 * @returns Most recently seen first, always ending with a free-text row.
 */
export function modelPickItems(options: ModelPickOptions): ModelPickItem[] {
  const ids: string[] = [];
  const push = (id: string | undefined): void => {
    if (id === undefined || id === "" || ids.includes(id)) return;
    ids.push(id);
  };
  for (const id of [...options.observed].reverse()) push(id);
  push(options.configured);
  push(options.current);

  const items: ModelPickItem[] = ids.map((id) => ({
    action: "model" as const,
    label: escapeCodicons(id),
    modelId: id,
    ...(id === options.current ? { description: "current" } : {}),
  }));
  items.push({ action: "other", label: "$(edit) Enter a model id…" });
  return items;
}

/**
 * Which verb a message typed into the prompt box becomes.
 *
 * RFC 0004 §1: "Prompt box supports mid-turn steering (`steer`) and abort."
 * A message sent while a run is in flight is a steer; anything else starts a
 * run.
 *
 * @param running - Whether a run is in flight.
 */
export function chooseSendVerb(running: boolean): "prompt" | "steer" {
  return running ? "steer" : "prompt";
}
