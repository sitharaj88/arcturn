/**
 * The in-panel session list: ordering, searching, and the words on each row.
 *
 * RFC 0004 §1 asks for "`listSessions` for this cwd", and until now the only
 * surface for it was a command-palette quick-pick — a native dropdown that
 * opens at the top of the *window*, detached from the panel it was launched
 * from. Claude's extension, Copilot Chat and Codex all put history inside the
 * panel, and so does this: the header's history button opens a searchable list
 * where the transcript was, and `arcturn.showSessions` opens the same one.
 *
 * This module is the sibling of `webview-models.ts` and is deliberately shaped
 * like it: pure functions over plain data, shipped as source, driven directly
 * by `webview-sessions.test.ts` with no DOM. Where the two lists differ, they
 * differ for a reason:
 *
 * - **The page sorts; the host filters.** `listSessions` returns every session
 *   the server knows about across every working directory, so the *cwd* filter
 *   has to happen where the cwd is known — the host, in `projectSessions`
 *   (`webview-messages.ts`). Ordering is the renderer's business, so it is
 *   here, and it is here *only*: two sorts kept in step by hand is how two
 *   surfaces for one list start disagreeing.
 * - **No codicon escaping.** A session title is model-influenceable and
 *   `picker.ts` escapes it on its way into a `QuickPickItem`, because VS Code's
 *   `IconLabel` expands `$(name)` into a real glyph — a session called
 *   `$(check) Trusted session` would otherwise render as system-blessed. This
 *   page has no such renderer: every field goes through `textContent`, where
 *   `$(check)` is already six characters. Escaping here would *add* a
 *   backslash the engine never sent, which is a different way of lying about
 *   what the title is. `webview-render.test.ts` pins that.
 */

/**
 * One session as the panel sees it.
 *
 * A rebuilt projection of `SessionHeader` — the host copies field by field on
 * the way out (see `projectSessions` in `webview-messages.ts`), so nothing the
 * engine happens to add to a header reaches the page unreviewed. `cwd` is not
 * carried because the host has already filtered by it and every row on screen
 * shares it.
 */
export interface SessionOption {
  /** The id `openSession` takes. */
  sessionId: string;
  /** The title the engine stored. `""` when it stored none. */
  title: string;
  /** Epoch milliseconds; `0` when the header carried no usable timestamp. */
  createdAt: number;
}

/**
 * JavaScript source defining the list's pure functions:
 * `orderSessions`, `filterSessions`, `sessionLabel`, `formatAge`,
 * `sessionMeta`.
 */
export const SESSION_LIST_SOURCE = String.raw`
/**
 * Newest first — the session a user was last in is the one they are most
 * likely to be coming back for. Ties break on the id so that the order is a
 * property of the data rather than of whatever order the engine listed it in.
 */
function orderSessions(sessions) {
  var copy = sessions.slice();
  copy.sort(function (a, b) {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return b.sessionId.localeCompare(a.sessionId);
  });
  return copy;
}

/**
 * Every token has to match somewhere, in the title or in the id. Substring,
 * not fuzzy, for the reason 'filterModels' gives: a list of ids that all share
 * the same alphabet is exactly where fuzzy matching stops being able to say no.
 */
function filterSessions(sessions, query) {
  var tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return sessions.slice();
  return sessions.filter(function (session) {
    var haystack = (session.title + " " + session.sessionId).toLowerCase();
    for (var i = 0; i < tokens.length; i += 1) {
      if (haystack.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  });
}

/**
 * The row's headline. A session with no title says so rather than repeating
 * the id that is already on the line below it.
 */
function sessionLabel(session) {
  var title = String(session.title || "").trim();
  return title === "" ? "Untitled session" : title;
}

var AGE_MINUTE = 60000;
var AGE_HOUR = 60 * AGE_MINUTE;
var AGE_DAY = 24 * AGE_HOUR;

/**
 * How long ago, in the coarsest unit that still says something.
 *
 * An absent timestamp prints nothing at all: a header with no 'createdAt' is
 * not a session started in 1970, and saying so would be the silent wrong
 * answer. A timestamp in the future is a clock disagreement between this
 * machine and whatever wrote the header, not a session that has not happened
 * yet, so it reads as 'just now'.
 */
function formatAge(createdAt, now) {
  if (typeof createdAt !== "number" || !isFinite(createdAt) || createdAt <= 0) return "";
  var delta = now - createdAt;
  if (delta < AGE_MINUTE) return "just now";
  if (delta < AGE_HOUR) return String(Math.floor(delta / AGE_MINUTE)) + "m ago";
  if (delta < AGE_DAY) return String(Math.floor(delta / AGE_HOUR)) + "h ago";
  if (delta < 7 * AGE_DAY) return String(Math.floor(delta / AGE_DAY)) + "d ago";
  if (delta < 30 * AGE_DAY) return String(Math.floor(delta / (7 * AGE_DAY))) + "w ago";
  if (delta < 365 * AGE_DAY) return String(Math.floor(delta / (30 * AGE_DAY))) + "mo ago";
  return String(Math.floor(delta / (365 * AGE_DAY))) + "y ago";
}

/** The row's second line: the id 'openSession' takes, and how old it is. */
function sessionMeta(session, now) {
  var age = formatAge(session.createdAt, now);
  return age === "" ? session.sessionId : session.sessionId + " · " + age;
}
`;
