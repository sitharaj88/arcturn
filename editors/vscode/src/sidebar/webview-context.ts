/**
 * The `@` picker's decisions: what opens it, how candidates rank, and what one
 * chip says about itself.
 *
 * A sibling of `webview-models.ts` and `webview-sessions.ts` in every way that
 * matters — pure functions over plain data, shipped as source, driven directly
 * by `webview-context.test.ts` with no DOM — and it differs from them in
 * exactly one decision, deliberately.
 *
 * **This list matches fuzzily; those two match on substrings.** The reason is
 * the shape of what is being searched. A model catalog is 135 ids that all
 * share the same alphabet (`anthropic/claude-…`, `openai/gpt-…`), which is
 * precisely where fuzzy matching stops being able to say *no* — everything
 * matches everything and the ranking is the only thing left doing work. A
 * workspace file list is the opposite: paths are long, deeply nested, and a
 * user types four letters of a basename they half remember. `sath` for
 * `src/auth.ts` is the query a file picker exists to answer, and a substring
 * matcher answers it with nothing.
 *
 * ## What the picker is honest about
 *
 * Every row carries the engine's own `bytes` and its own refusal, because the
 * candidates were resolved through `resolveContext` before they were shown
 * (see `index.ts`). RFC 0005 §1.1 — "what makes a file picker honest rather
 * than hopeful". Nothing here estimates a size, and nothing here decides for
 * itself whether a path is attachable; `ContextItem.ok` was computed from the
 * engine's facts in `projectContextItem` and this module only renders it.
 *
 * ## The trigger, and why picking a file deletes what you typed
 *
 * {@link CONTEXT_SOURCE}'s `triggerAt` is shared by the `@` picker and the `/`
 * menu — one function, because "is the caret inside a token that starts with
 * this marker" is one question and two copies of it would drift.
 *
 * `applyTrigger` is what the page calls once a row is chosen, and for `@` the
 * insertion is the **empty string**: the typed `@src/au` is removed and a chip
 * appears instead. That is not a stylistic choice. The engine expands
 * `@`-mentions on the serve path *and* injects `attachments`, so a panel that
 * left the mention in the box and attached the file would inject the same file
 * twice — and the chip row would no longer be the whole truth about what the
 * next prompt carries, which is the one invariant `index.ts` holds the
 * attachment set to. The `@` is a way to open the picker, not text that
 * survives it. For `/` the insertion is the command, because there the text
 * *is* the execution (RFC 0005 §1.3).
 */

/**
 * How many candidates one keystroke is allowed to cost.
 *
 * Every row shown is a `resolveContext` round trip — that is what makes the
 * sizes real rather than a `fs.stat` the extension did behind the permission
 * engine's back — so this is a budget in *engine calls*, not in pixels. Twelve
 * is more rows than fit in the popover at 300px and few enough that a fast
 * typist never has a hundred requests in flight.
 */
export const MAX_CONTEXT_CANDIDATES = 12;

/** A glob longer than this is a query that stopped being a filename. */
const MAX_GLOB_QUERY = 48;

/**
 * The workspace glob that finds what a query might mean.
 *
 * The fuzzy matching happens **in VS Code's file index**, not here: `auth`
 * becomes `**{@}/*a*u*t*h*`, which is a subsequence match expressed as a
 * pattern, and `workspace.findFiles` answers it against the same index (and
 * the same `files.exclude` / `search.exclude`) that the editor's own Quick
 * Open uses. A `node_modules` the user has excluded stays excluded, without
 * this file having to know what an exclude list is.
 *
 * A `/` in the query stays a separator, so `src/auth` is two segments and
 * matches `src/auth.ts` rather than anything containing those eight letters in
 * order.
 *
 * Glob syntax the user typed is **removed**, not escaped and not forwarded. A
 * `*` after an `@` is a character somebody meant literally; forwarding it
 * would let whatever is in the composer author a pattern that walks the
 * workspace in ways the picker never intended, and escaping it would make the
 * picker answer nothing for a query that looks perfectly reasonable.
 *
 * @param query - The mention text, as typed, without its `@`.
 */
export function contextGlob(query: string): string {
  const cleaned = query.replace(/[*?[\]{}!(),]/g, "").slice(0, MAX_GLOB_QUERY);
  if (cleaned === "") return "**/*";
  let pattern = "";
  for (const character of cleaned) pattern += character === "/" ? "*/" : `*${character}`;
  const built = `**/${pattern}*`;
  // A query of nothing but punctuation reduces to the everything pattern
  // rather than to `**//*`, which matches nothing and would read as "no files".
  return built.includes("//") ? "**/*" : built;
}

/**
 * Which of the matching paths are worth a round trip.
 *
 * A truncation rule, deliberately *not* a ranking: the display order is the
 * page's, computed by `rankContext` in {@link CONTEXT_SOURCE}, and there is
 * exactly one scorer in this codebase for that job. What this decides is only
 * which candidates survive the budget when the index matched more than
 * {@link MAX_CONTEXT_CANDIDATES} of them, and shortest-path-first is the
 * honest answer to that: `src/auth.ts` is a better guess than
 * `node_modules/@scope/pkg/dist/auth.js`, and depth is the cheapest signal
 * that says so without duplicating the scorer.
 *
 * Ties break lexicographically so the same query twice is the same list twice,
 * and duplicates are dropped so no file costs two round trips.
 *
 * @param paths - Workspace-relative paths, as the index returned them.
 * @param limit - Round-trip budget. Defaults to {@link MAX_CONTEXT_CANDIDATES}.
 */
export function narrowCandidates(
  paths: readonly string[],
  limit: number = MAX_CONTEXT_CANDIDATES,
): string[] {
  const unique = [...new Set(paths)];
  unique.sort((a, b) => (a.length === b.length ? a.localeCompare(b) : a.length - b.length));
  return unique.slice(0, Math.max(0, limit));
}

/**
 * JavaScript source defining the picker's pure functions:
 * `formatBytes`, `contextMeta`, `contextScore`, `rankContext`, `triggerAt`,
 * `applyTrigger`.
 */
export const CONTEXT_SOURCE = String.raw`
/**
 * A size a person reads, from the engine's own byte count.
 *
 * Zero prints nothing at all rather than '0 B': 'bytes: 0' is what the engine
 * reports for a path it never looked at (outside the workspace, or missing),
 * and an empty file and an unread one must not read the same.
 */
function formatBytes(bytes) {
  if (typeof bytes !== "number" || !isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return String(Math.round(bytes)) + " B";
  var kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB";
  return (kb / 1024).toFixed(1) + " MB";
}

/**
 * The second line of a chip or a picker row: what will actually be injected,
 * or the engine's own sentence about why nothing will be.
 *
 * A refusal with no reason still says something — 'cannot be attached' is
 * thin, but a chip that showed a blank line next to a file that will silently
 * not be sent is the failure this whole surface exists to remove.
 */
function contextMeta(item) {
  if (item.ok !== true) {
    var reason = String(item.reason || "");
    return reason === "" ? "cannot be attached" : reason;
  }
  var size = formatBytes(item.bytes);
  if (item.kind === "image") return size === "" ? "image" : "image · " + size;
  return size;
}

/**
 * The cost of matching every letter of 'needle' inside 'text', in order, or -1.
 *
 * Greedy leftmost subsequence with two biases, each of which is a thing a
 * person actually means when they type four letters into a file picker:
 * consecutive letters are free ('auth' landing as a run beats the same four
 * scattered through 'a-u-t-h'), and a letter that starts a word is cheap —
 * '/', '-', '_', '.' and a lowercase-to-uppercase step all begin one, and a
 * word start is what somebody is aiming at.
 */
function subsequenceCost(text, needle) {
  var lower = text.toLowerCase();
  var cost = 0;
  var at = 0;
  var previous = -2;
  for (var i = 0; i < needle.length; i += 1) {
    var found = lower.indexOf(needle.charAt(i), at);
    if (found === -1) return -1;
    if (found !== previous + 1) {
      var before = found === 0 ? "" : text.charAt(found - 1);
      var boundary =
        found === 0 ||
        before === "/" || before === "-" || before === "_" || before === "." ||
        (before === before.toLowerCase() &&
          text.charAt(found) !== text.charAt(found).toLowerCase());
      cost += boundary ? 1 : 3;
    }
    previous = found;
    at = found + 1;
  }
  return cost;
}

/**
 * What a path scores against a query. Lower is better; -1 is no match at all.
 *
 * The basename is tried first and, when the whole query fits inside it, that
 * is the answer — which is the one bias that makes this usable on a real
 * repository. A greedy matcher run over the full path finds the 'a' in
 * 'packages/' before the one in 'authenticate.ts' and scores a good answer
 * badly; asking the last segment first sidesteps that entirely, and costs one
 * extra pass over a string that is a few dozen characters long.
 *
 * A match that needed the directory part is still a match — 'sath' for
 * 'src/auth.ts' is a query somebody means — and pays a flat penalty so that it
 * sorts below anything the basename could answer.
 *
 * An empty query scores every path the same, which is what lets a bare '@'
 * open a browsable list rather than an empty one.
 */
var DIRECTORY_PENALTY = 8;

function contextScore(path, query) {
  var needle = String(query || "").toLowerCase();
  if (needle === "") return 0;
  var hay = String(path || "");
  var slash = hay.lastIndexOf("/");
  var inBase = subsequenceCost(hay.slice(slash + 1), needle);
  if (inBase >= 0) return inBase;
  var whole = subsequenceCost(hay, needle);
  return whole < 0 ? -1 : whole + DIRECTORY_PENALTY;
}

/**
 * The rows to show, best first.
 *
 * An empty query leaves the host's own order alone: the candidates came from
 * the workspace's file index in the order it holds them, and re-sorting a list
 * nobody has narrowed yet would only shuffle it.
 *
 * A candidate the engine refused is kept, not dropped. The picker's job is to
 * say what would happen, and 'this one is outside the workspace' is an answer;
 * hiding it would leave a user typing the same path again.
 */
function rankContext(items, query) {
  var needle = String(query || "");
  if (needle === "") return items.slice();
  var scored = [];
  for (var i = 0; i < items.length; i += 1) {
    var score = contextScore(items[i].path, needle);
    if (score < 0) continue;
    scored.push({ item: items[i], score: score, at: i });
  }
  scored.sort(function (a, b) {
    if (a.score !== b.score) return a.score - b.score;
    var byLength = a.item.path.length - b.item.path.length;
    if (byLength !== 0) return byLength;
    return a.at - b.at;
  });
  var out = [];
  for (var j = 0; j < scored.length; j += 1) out.push(scored[j].item);
  return out;
}

/**
 * The rows the picker shows, in the order it shows them.
 *
 * Ranking, and deliberately *not* a second filter. The host already decided
 * which candidates are worth showing — it always includes the path the user
 * actually typed, which is what makes '@../../etc/passwd' answerable with the
 * engine's refusal rather than with an empty list — so a page that dropped
 * everything 'rankContext' could not score would throw away exactly the row
 * that had something to say.
 *
 * So: the ones that match, best first, and then everything else in the order
 * the host sent it.
 */
function orderCandidates(items, query) {
  var ranked = rankContext(items, query);
  if (ranked.length === items.length) return ranked;
  var seen = {};
  for (var i = 0; i < ranked.length; i += 1) seen[ranked[i].id] = 1;
  var out = ranked.slice();
  for (var j = 0; j < items.length; j += 1) {
    if (!Object.prototype.hasOwnProperty.call(seen, items[j].id)) out.push(items[j]);
  }
  return out;
}

/** A query longer than this is prose, not a path or a command name. */
var MAX_TRIGGER_QUERY = 200;

/**
 * The token the caret is sitting in, when it is one a menu answers.
 *
 * '@' opens anywhere a mention can go — the start of the message, or after
 * whitespace — so 'me@example.com' is left alone, which is the case that
 * decides whether this feature is helpful or infuriating.
 *
 * '/' opens only at position 0. A command is the whole message's verb, and the
 * alternative (open on any '/') would put a command menu in front of every
 * path anybody typed.
 *
 * Whitespace closes both: once a space is typed the token is finished and
 * whatever follows is prose.
 */
function triggerAt(text, caret) {
  var body = String(text || "");
  var at = typeof caret === "number" && caret >= 0 ? Math.min(caret, body.length) : body.length;
  var head = body.slice(0, at);
  for (var i = head.length - 1; i >= 0; i -= 1) {
    var ch = head.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return undefined;
    // A '/' that is not at position 0 is part of a path, so the scan walks
    // straight past it — otherwise '@src/a' would be read as a command menu
    // that then refused to open, and the mention behind it would be lost.
    if (ch === "/" && i === 0) return marked(ch, head, i, at);
    if (ch !== "@") continue;
    if (i !== 0) {
      var before = head.charAt(i - 1);
      if (before !== " " && before !== "\t" && before !== "\n" && before !== "\r") return undefined;
    }
    return marked(ch, head, i, at);
  }
  return undefined;
}

function marked(marker, head, start, end) {
  var query = head.slice(start + 1);
  if (query.length > MAX_TRIGGER_QUERY) return undefined;
  return { marker: marker, query: query, start: start, end: end };
}

/**
 * Replace the trigger with whatever was chosen, and say where the caret goes.
 *
 * The caller sets both: a textarea whose value changed but whose caret did not
 * move puts the user back at the end of the box, several words from where they
 * were typing.
 */
function applyTrigger(text, trigger, insert) {
  var body = String(text || "");
  var added = String(insert === undefined || insert === null ? "" : insert);
  return {
    text: body.slice(0, trigger.start) + added + body.slice(trigger.end),
    caret: trigger.start + added.length
  };
}
`;
