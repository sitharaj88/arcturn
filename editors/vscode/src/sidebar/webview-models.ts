/**
 * The in-panel model list: ordering, searching, and the words on each row.
 *
 * RFC 0004 §1 has always described a model picker "fed by the session's
 * catalog"; until now the only surface for it was a command-palette quick-pick
 * (`picker.ts`), which is why choosing a model looked, from the panel, like a
 * feature that did not exist. This module is the same catalog rendered *in*
 * the panel — a chip on the composer that opens a searchable list.
 *
 * The two are deliberately not one implementation. `picker.ts` builds
 * `vscode.QuickPickItem`s for a renderer that expands `$(codicon)` syntax and
 * does its own fuzzy matching; this builds plain data for a webview that
 * renders through `textContent` and has no matcher of its own. What they share
 * is the *wording* — `200k ctx`, `pricing unknown`, `ANTHROPIC_API_KEY set` —
 * because a user who reads one and then the other must not have to work out
 * whether they mean the same thing. Where a sentence is repeated here it is
 * repeated on purpose.
 *
 * Shipped as source for the reason `webview-markdown.ts` explains, and tested
 * the same way: pure functions over plain data, driven from
 * `webview-models.test.ts` with no DOM.
 */

/**
 * One model as the panel sees it.
 *
 * A rebuilt projection of `ModelCatalogEntry` — the host copies field by field
 * on the way out (see `webview-messages.ts`), so nothing the engine happens to
 * add to the catalog reaches the page unreviewed.
 */
export interface ModelOption {
  /** Catalog id, as `setModel` accepts it. */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Provider segment of the id, e.g. `"anthropic"`. */
  provider: string;
  /** Total context window in tokens; `0` when the catalog did not say. */
  contextWindow: number;
  /** USD per million tokens. **Absent means unknown, not free.** */
  cost?: { input: number; output: number };
  /** Name — never value — of the variable this model authenticates with. */
  apiKeyEnv?: string;
  /** Whether the server holds that credential. */
  credentials: "present" | "absent" | "unknown";
}

/** Which band a row sorts into. `"ready"` is the one a user can use today. */
export type ModelGroup = "current" | "ready" | "unknown" | "absent";

/**
 * JavaScript source defining the list's pure functions:
 * `orderModels`, `filterModels`, `modelGroup`, `modelMeta`, `modelChipLabel`.
 */
export const MODEL_LIST_SOURCE = String.raw`
function modelGroup(model, currentId) {
  if (model.id === currentId) return "current";
  if (model.credentials === "present") return "ready";
  if (model.credentials === "unknown") return "unknown";
  return "absent";
}

var MODEL_GROUP_RANK = { current: 0, ready: 1, unknown: 2, absent: 3 };

/**
 * Order for a list a user scrolls: the model in use, then the models this
 * server actually holds a credential for, then the ones it cannot tell about,
 * then the ones it knows are unusable. Alphabetical inside each band, by the
 * name that is on screen.
 */
function orderModels(models, currentId) {
  var copy = models.slice();
  copy.sort(function (a, b) {
    var rank = MODEL_GROUP_RANK[modelGroup(a, currentId)] - MODEL_GROUP_RANK[modelGroup(b, currentId)];
    if (rank !== 0) return rank;
    var byName = a.displayName.localeCompare(b.displayName);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
  return copy;
}

/**
 * Every token has to match somewhere. Substring, not fuzzy: a 135-row catalog
 * of ids that all contain the same letters is exactly where fuzzy matching
 * stops being able to say no.
 */
function filterModels(models, query) {
  var tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return models.slice();
  return models.filter(function (model) {
    var haystack = (model.id + " " + model.displayName + " " + model.provider + " " + (model.apiKeyEnv || "")).toLowerCase();
    for (var i = 0; i < tokens.length; i += 1) {
      if (haystack.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  });
}

/** '200k ctx', the same rounding 'arcturn --list-models' prints. */
function formatContext(tokens) {
  if (!tokens || tokens <= 0) return "";
  return String(Math.round(tokens / 1000)) + "k ctx";
}

/**
 * Price per million tokens, or the honest absence of one. No 'cost' means
 * nobody published a rate, which is not the same as free.
 */
function formatPrice(model) {
  if (!model.cost) return "pricing unknown";
  return "$" + model.cost.input + "/$" + model.cost.output + " per Mtok";
}

/**
 * What the server knows about this model's credential. 'unknown' is reported
 * as 'credentials unknown', never as 'not set': telling a user they cannot use
 * a model they can is worse than saying nothing.
 */
function formatCredentials(model) {
  var name = model.apiKeyEnv;
  if (model.credentials === "present") return name ? name + " set" : "credentials found";
  if (model.credentials === "absent") return name ? name + " not set" : "no credentials found";
  return name ? name + ": credentials unknown" : "credentials unknown";
}

/** The row's second line: context window, price, credential. */
function modelMeta(model) {
  var parts = [];
  var context = formatContext(model.contextWindow);
  if (context) parts.push(context);
  parts.push(formatPrice(model));
  parts.push(formatCredentials(model));
  return parts.join(" · ");
}

/**
 * The composer chip. The catalog's display name when it has one, the raw id
 * when it does not (an extension-registered model, or an engine with no
 * catalog verb), and an invitation when no model is known at all.
 */
function modelChipLabel(models, currentId) {
  if (!currentId) return "Select model";
  for (var i = 0; i < models.length; i += 1) {
    if (models[i].id === currentId) return models[i].displayName;
  }
  return currentId;
}
`;
