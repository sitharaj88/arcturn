/**
 * The model quick-pick, as a pure item builder.
 *
 * ### Where the sessions picker went
 *
 * This file used to build a second quick-pick, for sessions. It does not any
 * more: history is a list *in the panel* now
 * (`webview-sessions.ts`), opened from the header button and from
 * `arcturn.showSessions` alike. The quick-pick was deleted rather than kept as
 * a fallback, because two builders for one surface is precisely how the model
 * chip and the palette nearly ended up disagreeing about which model was in
 * use. There is one session list, and one place its rows are decided.
 *
 * The model picker stays a quick-pick, and that asymmetry is deliberate — see
 * the note at the top of `webview-sessions.ts` on why an unbounded list that
 * *replaces* the transcript wants the whole panel while a fixed catalog that
 * leaves it in place does not.
 *
 * ### Models
 *
 * RFC 0004 §1 describes the model picker as a "quick-pick fed by the session's
 * catalog". The protocol had no catalog verb when this file was first written,
 * so the picker ran on ids the engine happened to announce plus free text —
 * on a fresh session, nearly nothing. §0's rule ("a sidebar feature needing a
 * verb this list lacks is an engine RFC, not an extension hack") was followed
 * rather than routed around: `listModels` was added to the wire, and the
 * picker now renders the engine's real catalog — the same models
 * `arcturn --list-models` prints, with context window, price and whether the
 * server holds a credential for them.
 *
 * Three things survive from the old design, and all three still earn their
 * place:
 *
 * - **The free-text row.** The catalog lists what is *registered*; an
 *   extension may register more, and `setModel` validates the id server-side
 *   anyway, which is where that validation belongs.
 * - **`arcturn.defaultModel` and the ids seen on this session's stream.** A
 *   model the session is actually using belongs in the list whether or not
 *   the catalog carries it.
 * - **Working with no catalog at all.** `listModels` is an optional verb: an
 *   older engine rejects it and `ProtocolClient.listModels` resolves
 *   `undefined`, at which point this builder degrades silently to exactly the
 *   behaviour it had before — observed ids, the configured default, free text.
 *
 * Pricing is reported the way the engine reports it: an entry with no `cost`
 * has an *unknown* price, which is not `$0`. Printing a free-looking zero for
 * a model nobody has published a rate for is the silent wrong answer this
 * codebase keeps refusing to give, so those rows say "pricing unknown".
 *
 * ### Why labels are escaped
 *
 * A `vscode.QuickPickItem`'s `label`, `description` and `detail` are rendered
 * through VS Code's `IconLabel` with `supportIcons` on, which turns `$(name)`
 * into a real glyph — and so is a notification's message. Model ids, display
 * names and session ids all arrive from the engine, and a model's display name
 * is as model-influenceable as a session title was: a model called
 * `$(check) Recommended` would render with an actual checkmark and read as
 * system-blessed. Every engine-supplied string is therefore passed through
 * {@link escapeCodicons} on its way into a rendered field — here, and in
 * `index.ts` where an id reaches a notification. The extension's own `$(edit)`
 * affordance is a literal in this file, not engine input, and stays live.
 *
 * The panel does **not** escape: it renders through `textContent`, which has no
 * `$(name)` syntax to expand, and adding a backslash there would show the user
 * a character the engine never sent. See `webview-sessions.ts`.
 */

import type { ModelCatalogEntry } from "../serve/engine.js";

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

/** One row of the model quick-pick. */
export interface ModelPickItem {
  /**
   * `"model"` to switch to `modelId`, `"other"` to prompt for one. The
   * discriminant is `action`, not `kind`: `vscode.QuickPickItem` already
   * defines `kind` as its separator enum, and these items are handed straight
   * to `showQuickPick`.
   */
  action: "model" | "other";
  label: string;
  description?: string;
  detail?: string;
  /** Present only on a `"model"` row. */
  modelId?: string;
}

/** Options for {@link modelPickItems}. */
export interface ModelPickOptions {
  /**
   * The engine's catalog, from `listModels`. Absent when the engine predates
   * the verb — the picker then behaves exactly as it did before it existed.
   */
  catalog?: readonly ModelCatalogEntry[];
  /** Model ids seen on this session's stream, oldest first. */
  observed: readonly string[];
  /** `arcturn.defaultModel`, when the workspace sets one. */
  configured?: string;
  /** The model currently in use. */
  current?: string;
}

/** `1000k ctx` — the same rounding `arcturn --list-models` prints. */
function formatContext(tokens: number): string {
  return `${Math.round(tokens / 1000)}k ctx`;
}

/**
 * Price per million tokens, or the honest absence of one.
 *
 * `cost: undefined` is "nobody published a rate", not "free"; a genuinely free
 * model reports `{ input: 0, output: 0 }` and prints as `$0/$0`.
 */
function formatCost(entry: ModelCatalogEntry): string {
  return entry.cost === undefined
    ? "pricing unknown"
    : `$${entry.cost.input}/$${entry.cost.output} per Mtok`;
}

/**
 * What the engine knows about this model's credential.
 *
 * `"unknown"` is reported as "credentials unknown", never as "not set": the
 * engine says it cannot tell (ambient AWS/Google credentials, or a local
 * endpoint that needs no key), and turning that into a warning would tell the
 * user they cannot use a model they can.
 */
function formatCredentials(entry: ModelCatalogEntry): string {
  const name = entry.apiKeyEnv === undefined ? undefined : escapeCodicons(entry.apiKeyEnv);
  switch (entry.credentials) {
    case "present":
      return name === undefined ? "credentials found" : `${name} set`;
    case "absent":
      return name === undefined ? "no credentials found" : `${name} not set`;
    default:
      // The variable name belongs here too: it is what a user types to find the
      // models that need it, and every real "unknown" entry in the catalog
      // (the openai-compatible providers) names one.
      return name === undefined ? "credentials unknown" : `${name}: credentials unknown`;
  }
}

/** Build one catalogued row. Every engine-supplied string is escaped on the way in. */
function catalogItem(entry: ModelCatalogEntry, current: string | undefined): ModelPickItem {
  const id = escapeCodicons(entry.id);
  return {
    action: "model",
    label: escapeCodicons(entry.displayName),
    description: entry.id === current ? `${id} · current` : id,
    detail: `${formatContext(entry.contextWindow)} · ${formatCost(entry)} · ${formatCredentials(entry)}`,
    modelId: entry.id,
  };
}

/**
 * Build the model quick-pick.
 *
 * Order is what makes a 135-row catalog usable: the model in use first, then
 * the models this server actually holds a credential for, then the rest of the
 * catalog, then any id the session or the workspace config named that the
 * catalog does not carry. A free-text row always ends the list.
 *
 * @param options - See {@link ModelPickOptions}.
 * @returns Rows in that order, always ending with a free-text row.
 */
export function modelPickItems(options: ModelPickOptions): ModelPickItem[] {
  const catalog = options.catalog ?? [];
  const current = options.current === "" ? undefined : options.current;

  const inCatalog = new Set(catalog.map((entry) => entry.id));
  const currentEntry = catalog.find((entry) => entry.id === current);
  const rest = catalog.filter((entry) => entry.id !== current);

  const items: ModelPickItem[] = [];
  if (currentEntry) items.push(catalogItem(currentEntry, current));
  else if (current !== undefined) {
    // In use but not in the catalog (an extension-registered model, or an
    // engine with no catalog verb at all): still the first row, still marked.
    items.push({
      action: "model",
      label: escapeCodicons(current),
      description: "current",
      modelId: current,
    });
  }
  for (const entry of rest) {
    if (entry.credentials === "present") items.push(catalogItem(entry, current));
  }
  for (const entry of rest) {
    if (entry.credentials !== "present") items.push(catalogItem(entry, current));
  }

  // Ids the catalog does not carry: what the engine announced on this
  // session's stream (most recent first) and the configured default. The
  // model in use is already the first row, catalogued or not. Without a
  // catalog these are the whole list — the behaviour this picker had before
  // `listModels` existed.
  const seen = new Set(inCatalog);
  if (current !== undefined) seen.add(current);
  const push = (id: string | undefined): void => {
    if (id === undefined || id === "" || seen.has(id)) return;
    seen.add(id);
    items.push({ action: "model", label: escapeCodicons(id), modelId: id });
  };
  for (const id of [...options.observed].reverse()) push(id);
  push(options.configured);

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

/**
 * Where a model pick should be saved.
 *
 * The pick is persisted through `arcturn.defaultModel`, and the scope matters:
 * updating Global while a workspace override exists would leave the override
 * winning and the write looking lost — the user picks, reloads, and sees the
 * old model again, which is the exact complaint persistence exists to fix. So
 * the workspace wins when the workspace already has an opinion, and the user's
 * own settings win otherwise, because a model choice is a preference of the
 * person, not a property of one folder.
 */
export function modelPersistScope(
  inspected: { workspaceValue?: unknown } | undefined,
): "workspace" | "global" {
  return inspected?.workspaceValue !== undefined ? "workspace" : "global";
}
