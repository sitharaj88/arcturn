/**
 * Semantic rewind: find a checkpoint turn by describing it ("the auth
 * refactor") instead of scrolling a timestamp list.
 *
 * `/rewind` (see `commands.ts`) already restores files to the state before a
 * given turn, and `CheckpointStore.listTurns()` (see `checkpoints.ts`)
 * already returns `{ id, label, timestamp, fileCount }` rows where `label`
 * is the first ~60 characters of the user's prompt. This module adds a
 * scoring layer on top of that list so a natural-language query can locate
 * the right turn directly.
 *
 * Everything here is pure, local, and explainable: no embeddings, no
 * network calls, no ML dependency. Every score decomposes into a handful
 * of named signals (exact phrase, word overlap, crude stemming, recency,
 * file count), and {@link TurnMatch.why} always names whichever signal
 * dominated. See `INTEGRATION-rewind-search.md` at the repo root for how
 * `commands.ts`'s `rewind` command is expected to call this.
 *
 * @packageDocumentation
 */

import type { CheckpointTurnSummary } from "./checkpoints.js";

/**
 * A turn summary to search over. Structurally identical to
 * {@link CheckpointTurnSummary} — the type `CheckpointStore.listTurns()`
 * already returns — re-exported under the name this module's design uses.
 */
export type TurnInfo = CheckpointTurnSummary;

/** One scored candidate returned by {@link searchTurns}. */
export interface TurnMatch {
  /** The turn this score belongs to. */
  readonly turn: TurnInfo;
  /**
   * Combined score. Not normalized to any fixed range — only meaningful
   * relative to other {@link TurnMatch} scores from the same
   * {@link searchTurns} call.
   */
  readonly score: number;
  /**
   * Human-readable explanation of the strongest signal that produced this
   * score, e.g. `exact phrase "auth refactor" found in label` or
   * `2/3 query words matched in label (1 exact, 1 stemmed)`.
   */
  readonly why: string;
}

/** Tuning knobs shared by {@link searchTurns} and {@link bestMatch}. */
export interface SearchTurnsOptions {
  /**
   * Stopwords to down-weight in word-overlap scoring. Defaults to
   * {@link DEFAULT_STOPWORDS}. Exposed mainly for testing/tuning; callers
   * should not normally need to override it.
   */
  readonly stopwords?: ReadonlySet<string>;
}

/** Tuning knobs specific to {@link bestMatch}'s confidence gate. */
export interface BestMatchOptions extends SearchTurnsOptions {
  /**
   * Minimum {@link TurnMatch.score} the top result must clear before
   * {@link bestMatch} will trust it. Defaults to {@link MIN_CONFIDENCE_SCORE}.
   */
  readonly minConfidence?: number;
  /**
   * Minimum score gap the top result must have over the runner-up before
   * {@link bestMatch} will trust it — this is what makes ambiguous queries
   * return `undefined` instead of guessing. Defaults to
   * {@link MIN_MARGIN_SCORE}.
   */
  readonly minMargin?: number;
}

/**
 * Small, deliberately short list of low-content English words. Present in a
 * query, they still count toward word-overlap matching (a query shouldn't
 * be *penalized* for containing them) but at a fraction of a content word's
 * weight, so a query made up mostly or entirely of stopwords can never
 * reach {@link MIN_CONFIDENCE_SCORE} on overlap alone.
 *
 * This is intentionally not a general-purpose NLP stopword list — just
 * enough common filler/verb words to keep short imperative queries like
 * "fix the auth bug" or "make login work" scoring on their content words.
 */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "my",
  "our",
  "your",
  "this",
  "that",
  "is",
  "was",
  "be",
  "it",
  "with",
  "fix",
  "fixed",
  "fixing",
  "make",
  "makes",
  "please",
  "just",
]);

/** Weight given to a stopword hit, relative to a content word's `1`. */
const STOPWORD_WEIGHT = 0.25;

/** Score contributed by an exact-phrase containment match — the strongest signal. */
const EXACT_PHRASE_SCORE = 100;
/** Maximum score contributed by word overlap (at fraction === 1). */
const WORD_OVERLAP_WEIGHT = 70;
/** A stemmed (non-exact) word match counts for this fraction of its word's weight. */
const STEM_MATCH_DISCOUNT = 0.8;
/** Maximum score contributed by recency (the single most recent turn in the corpus). */
const RECENCY_WEIGHT = 4;
/** Maximum score contributed by file count. */
const FILE_COUNT_WEIGHT = 0.5;
/** File counts above this stop adding to the file-count signal. */
const FILE_COUNT_CAP = 6;

/**
 * Default minimum {@link TurnMatch.score} {@link bestMatch} requires from
 * the top result. Calibrated so that a stopword-only query, or a query
 * sharing only a word or two with a label, cannot clear it — see
 * `rewind-search.test.ts` for the scenarios this boundary was picked
 * against.
 */
export const MIN_CONFIDENCE_SCORE = 35;

/**
 * Default minimum score gap {@link bestMatch} requires between the top
 * result and the runner-up. Recency (max {@link RECENCY_WEIGHT}) and file
 * count (max `FILE_COUNT_CAP * FILE_COUNT_WEIGHT`) are both well under this,
 * so neither signal alone can turn a near-tie into a confident pick — only
 * a genuine difference in phrase/word-overlap matching can.
 */
export const MIN_MARGIN_SCORE = 15;

/** Lowercase, strip to alphanumerics, and split into non-empty words. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * Deliberately crude suffix stripper: strips one of `ing`, `ed`, `es`, `s`
 * when doing so leaves at least 3 characters. This is not a real stemmer
 * (no Porter algorithm, no vowel/consonant rules) — it exists only so that
 * "refactor", "refactored", and "refactoring" collapse to the same form for
 * matching purposes. Longer/more specific suffixes are checked first so
 * "refactoring" strips to "refactor" rather than stopping at "refactorin".
 */
export function stem(word: string): string {
  const suffixes = ["ing", "ed", "es", "s"];
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

/** How one query word matched (or didn't) against a label's words. */
type WordMatchKind = "exact" | "stem" | "none";

function matchWord(
  queryWord: string,
  labelWords: ReadonlySet<string>,
  labelStems: ReadonlySet<string>,
): WordMatchKind {
  if (labelWords.has(queryWord)) return "exact";
  if (labelStems.has(stem(queryWord))) return "stem";
  return "none";
}

/** Per-turn scoring breakdown, before recency/file-count are folded in. */
interface ContentScore {
  score: number;
  why: string;
}

/**
 * Score how well `query` matches `label` on phrase containment and
 * word overlap alone (no recency, no file count — those are corpus-relative
 * and applied by the caller).
 */
function scoreContent(query: string, label: string, stopwords: ReadonlySet<string>): ContentScore {
  const trimmedQuery = query.trim();
  const queryWords = [...new Set(tokenize(trimmedQuery))];
  const hasContentWord = queryWords.some((word) => !stopwords.has(word));

  // Exact phrase containment — the strongest, most explainable signal.
  // Guarded on having at least one non-stopword query word so a query like
  // "the" can't "exact match" its way into every label that contains it.
  if (trimmedQuery.length > 0 && hasContentWord) {
    const normalizedLabel = label.toLowerCase();
    const normalizedQuery = trimmedQuery.toLowerCase();
    if (normalizedLabel.includes(normalizedQuery)) {
      return { score: EXACT_PHRASE_SCORE, why: `exact phrase "${trimmedQuery}" found in label` };
    }
  }

  if (queryWords.length === 0) {
    return { score: 0, why: "empty query" };
  }

  const labelWordList = tokenize(label);
  const labelWords = new Set(labelWordList);
  const labelStems = new Set(labelWordList.map(stem));

  let matchedWeight = 0;
  let exactCount = 0;
  let stemCount = 0;
  let matchedCount = 0;
  for (const word of queryWords) {
    const weight = stopwords.has(word) ? STOPWORD_WEIGHT : 1;
    const kind = matchWord(word, labelWords, labelStems);
    if (kind === "exact") {
      matchedWeight += weight;
      exactCount += 1;
      matchedCount += 1;
    } else if (kind === "stem") {
      matchedWeight += weight * STEM_MATCH_DISCOUNT;
      stemCount += 1;
      matchedCount += 1;
    }
  }

  if (matchedCount === 0) {
    return { score: 0, why: "no query words matched the label" };
  }

  // Divide by the raw word count (not the weighted total) so a query made
  // entirely of stopwords can't reach a high fraction just because all of
  // its (low-weight) words happened to match.
  const fraction = matchedWeight / queryWords.length;
  const score = fraction * WORD_OVERLAP_WEIGHT;

  const parts: string[] = [];
  if (exactCount > 0) parts.push(`${exactCount} exact`);
  if (stemCount > 0) parts.push(`${stemCount} stemmed`);
  const why = `${matchedCount}/${queryWords.length} query word${queryWords.length === 1 ? "" : "s"} matched in label (${parts.join(", ")})`;

  return { score, why };
}

/** Recency rank (0 = oldest, 1 = most recent) for each turn's timestamp within the corpus. */
function recencyFractions(turns: readonly TurnInfo[]): ReadonlyMap<string, number> {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const turn of turns) {
    if (turn.timestamp < min) min = turn.timestamp;
    if (turn.timestamp > max) max = turn.timestamp;
  }
  // Normalized by actual timestamp value (not rank), so turns sharing the
  // same timestamp always get the same fraction — ranking by array position
  // instead would fabricate a recency gap between turns that are not
  // actually more or less recent than each other.
  const denom = Math.max(max - min, 1);
  const fractions = new Map<string, number>();
  for (const turn of turns) {
    fractions.set(turn.id, (turn.timestamp - min) / denom);
  }
  return fractions;
}

/**
 * Score and rank every turn against `query`, best match first.
 *
 * Scoring combines, in order of strength:
 *
 * 1. **Exact phrase containment** in the label (strongest single signal).
 * 2. **Word overlap** — the fraction of the query's distinct words present
 *    in the label (exact or {@link stem}-matched), with
 *    {@link DEFAULT_STOPWORDS} down-weighted so filler words can't carry a
 *    match on their own.
 * 3. **Recency** — a small bonus for turns later in the corpus, used only
 *    to break near-ties. Its maximum contribution ({@link RECENCY_WEIGHT})
 *    is well below a single word-overlap point difference, so it can never
 *    make a weak content match outrank a strong one.
 * 4. **File count** — a small bonus for turns that actually changed files,
 *    capped and weighted even more lightly than recency.
 *
 * An empty `turns` array or an empty/whitespace-only `query` is handled
 * without error: the former returns `[]`, the latter falls back to
 * ranking by recency/file-count alone (all matches will score below
 * {@link MIN_CONFIDENCE_SCORE}, so {@link bestMatch} will refuse them).
 *
 * @param turns - Turns to search, typically `await store.listTurns()`.
 * @param query - Natural-language description of the turn to find.
 * @param options - See {@link SearchTurnsOptions}.
 */
export function searchTurns(
  turns: readonly TurnInfo[],
  query: string,
  options: SearchTurnsOptions = {},
): TurnMatch[] {
  if (turns.length === 0) return [];
  const stopwords = options.stopwords ?? DEFAULT_STOPWORDS;
  const recency = recencyFractions(turns);

  const matches = turns.map((turn): TurnMatch => {
    const content = scoreContent(query, turn.label, stopwords);
    const recencyScore = (recency.get(turn.id) ?? 0) * RECENCY_WEIGHT;
    const fileCountScore = Math.min(turn.fileCount, FILE_COUNT_CAP) * FILE_COUNT_WEIGHT;
    const score = content.score + recencyScore + fileCountScore;
    return { turn, score, why: content.why };
  });

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

/**
 * Find the single turn `query` most confidently refers to, or `undefined`
 * when no turn clears the confidence bar or the top two candidates are too
 * close to call.
 *
 * This is the "refuse rather than guess" entry point: rewinding deletes
 * files, so a caller (see `INTEGRATION-rewind-search.md`) should only ever
 * jump straight to a turn when this returns a match, and should fall back
 * to the existing picker — ideally ordered by {@link searchTurns} — for
 * everything else, including `undefined`.
 *
 * Two gates must both pass:
 *
 * - The top match's score must be at least `options.minConfidence`
 *   (default {@link MIN_CONFIDENCE_SCORE}).
 * - The top match's score must exceed the runner-up's by at least
 *   `options.minMargin` (default {@link MIN_MARGIN_SCORE}) — including
 *   when there is no runner-up because the top score must still stand on
 *   its own above that margin. A tie or near-tie between two turns (e.g.
 *   two turns with equivalent labels) always yields `undefined`.
 *
 * @param turns - Turns to search, typically `await store.listTurns()`.
 * @param query - Natural-language description of the turn to find.
 * @param options - See {@link BestMatchOptions}.
 */
export function bestMatch(
  turns: readonly TurnInfo[],
  query: string,
  options: BestMatchOptions = {},
): TurnMatch | undefined {
  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE_SCORE;
  const minMargin = options.minMargin ?? MIN_MARGIN_SCORE;
  const ranked = searchTurns(turns, query, options);
  const top = ranked[0];
  if (!top) return undefined;
  if (top.score < minConfidence) return undefined;
  const runnerUp = ranked[1];
  const margin = top.score - (runnerUp?.score ?? 0);
  if (margin < minMargin) return undefined;
  return top;
}

/**
 * Render a {@link TurnMatch} as a one-line explanation suitable for
 * confirming a jump with the user, e.g.:
 *
 * `exact phrase "auth refactor" found in label; 3 files changed`
 *
 * @param match - A match returned by {@link searchTurns} or {@link bestMatch}.
 */
export function explainMatch(match: TurnMatch): string {
  const { fileCount } = match.turn;
  const filesPart = `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
  return `${match.why}; ${filesPart}`;
}
