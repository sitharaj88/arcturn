/**
 * `arcturn bisect` — binary-search a long agent session to find the exact turn
 * where behaviour diverged from a known-good run.
 *
 * The search itself ({@link bisectTurns}) is a pure, generic binary search:
 * it knows nothing about sessions, cassettes or turns, only that it is given
 * an ordered list of `T` and a `probe(upTo)` function that judges the prefix
 * ending at index `upTo` as {@link BisectVerdict}. That keeps it trivially
 * unit-testable (see `bisect.test.ts`) and reusable for any other kind of
 * "which prefix of N steps is where it broke" question.
 *
 * {@link cassetteProbe} is the one piece that plugs the search into VCR mode
 * (`packages/cli/src/vcr.ts`): it turns a cassette file and a prompt list
 * into a `probe` function, classifying each candidate turn by replaying the
 * recorded session against a **freshly loaded** cassette (cassette
 * consumption is stateful — see `INTEGRATION-vcr.md` — so every probe needs
 * its own {@link Cassette}) and reading `stats()` / catching
 * {@link CassetteError} afterwards.
 *
 * ## The monotonicity assumption
 *
 * Binary search over "good"/"bad" only works if badness is monotonic: once a
 * turn is bad, every turn after it is bad too (the classic `git bisect`
 * assumption). A run that flips good/bad/good/bad — flaky infrastructure, a
 * probe with side effects that heal themselves, a race — silently produces a
 * *wrong* answer from an unqualified binary search, because the search only
 * ever looks at `O(log n)` of the `n` turns and never notices the flip
 * happened outside its path. {@link bisectTurns}'s `verify` option re-probes
 * the two turns straddling the discovered boundary and sets
 * {@link BisectResult.confident} to `false` when either contradicts
 * monotonicity, so a caller knows to distrust the result rather than silently
 * act on a wrong turn number. See `INTEGRATION-bisect.md` for what to do when
 * that happens (bisect over a smaller/cleaner reproduction, or fall back to a
 * linear scan).
 *
 * @example
 * ```ts
 * const turns = await checkpointStore.listTurns();
 * const prompts = extractPrompts(sessionEntries);
 * const probe = cassetteProbe(cassetteFile, prompts, async (cassette, slice) => {
 *   const runtime = await buildRuntime({
 *     llm: replayingClient(cassette, { onMiss: "throw" }),
 *     wrapAgentTools: (tools) => replayTools(tools, cassette),
 *   });
 *   await replaySession({ prompts: slice, runtime });
 * });
 * const result = await bisectTurns(turns, probe, { verify: true });
 * console.log(formatBisectResult(result));
 * ```
 */

import type { Cassette } from "./vcr.js";
import { CassetteError, loadCassette as loadCassetteFromFile } from "./vcr.js";

/* -------------------------------------------------------------------------- */
/* Core search                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Outcome of probing one candidate index.
 *
 * - `"good"` — behaviour up to and including this turn matched the recording
 *   (or whatever "correct" means for this probe).
 * - `"bad"` — behaviour diverged by this turn.
 * - `"skip"` — the probe could not decide (e.g. a corrupt cassette, a probe
 *   that itself errored for an unrelated reason). {@link bisectTurns} steps
 *   outward to the nearest decidable neighbour rather than guessing.
 */
export type BisectVerdict = "good" | "bad" | "skip";

/** One row of the probe log: which index was probed, and what it returned. */
export interface BisectProbeLogEntry {
  /** Index into the `turns` array that was probed. */
  index: number;
  /** What the probe returned for that index. */
  verdict: BisectVerdict;
}

/** Options for {@link bisectTurns}. */
export interface BisectOptions {
  /**
   * Upper bound on the number of `probe()` calls, including any spent
   * stepping outward past a `"skip"` and any spent by `verify`. Search stops
   * early once the budget is spent, and the result comes back with
   * `confident: false`. Defaults to `64`, comfortably above `O(log n)` for
   * any session a human would plausibly bisect by hand.
   */
  maxProbes?: number;
  /**
   * When `true`, after the search concludes, re-probe the two turns
   * straddling the discovered boundary (the one just before it, expected
   * `"good"`, and the one just after it, expected to stay `"bad"`) to catch a
   * non-monotonic sequence that the `O(log n)` search path never looked at
   * directly. A contradiction sets {@link BisectResult.confident} to `false`.
   * Off by default because it costs up to two extra probes for a check that
   * only matters when you don't already trust the run to be monotonic.
   */
  verify?: boolean;
}

/** Result of {@link bisectTurns}. */
export interface BisectResult<T> {
  /**
   * Index of the first turn judged `"bad"`, or `undefined` when every
   * decidable turn was `"good"` (no divergence found).
   */
  firstBadIndex: number | undefined;
  /** `turns[firstBadIndex]`, or `undefined` alongside a missing index. */
  item: T | undefined;
  /** Every probe issued, in call order (verification probes included). */
  probes: BisectProbeLogEntry[];
  /**
   * `false` when the search could not fully trust its own answer: the probe
   * budget ran out, every probe near a needed boundary returned `"skip"`, or
   * `verify` caught a contradiction with the monotonicity assumption.
   * `firstBadIndex` may still be the best available answer — it is just not
   * guaranteed correct.
   */
  confident: boolean;
  /** Human-readable explanation of the result, for logs and `formatBisectResult`. */
  reason: string;
}

const DEFAULT_MAX_PROBES = 64;

/** Sentinel distinguishing "budget ran out" from an actual verdict inside `resolve`. */
const BUDGET_EXHAUSTED = Symbol("bisect-budget-exhausted");

/**
 * Binary-search an ordered list of turns for the first one a `probe` judges
 * `"bad"`, assuming badness is monotonic (see the module docs).
 *
 * This is a textbook "find the leftmost `true`" binary search over the
 * boolean sequence `probe(0) === "bad", probe(1) === "bad", ...`, generalised
 * with two things a real agent-run probe needs:
 *
 * - **`"skip"` handling** — a probe result of `"skip"` carries no
 *   information. Rather than let it silently count as `"good"` (which would
 *   search past a real divergence) or `"bad"` (which would report a false
 *   positive), the search steps outward from the undecidable index — first
 *   the neighbour toward the far end of the current search window, then the
 *   neighbour toward the near end, then two away, and so on — until it finds
 *   a decidable verdict to act on, or exhausts the window (in which case the
 *   search stops with `confident: false`). Note that only a `"good"` found by
 *   stepping *toward the high end* or a `"bad"` found by stepping *toward the
 *   low end* is fully safe under monotonicity without further checking; the
 *   other two directions can leave residual uncertainty about the skipped
 *   index itself, which is exactly what a non-`confident` result signals.
 * - **A probe budget** — `options.maxProbes` bounds the total `probe()`
 *   calls (search plus outward-stepping plus `verify`). Real probes can be
 *   expensive (spinning up a runtime, replaying a cassette); an open-ended
 *   search is not acceptable.
 *
 * @param turns - The ordered items to bisect over (turn boundaries,
 *   checkpoints, whatever the caller's unit of "step" is).
 * @param probe - Judges the prefix `turns[0..upTo]` (inclusive). Must be
 *   deterministic for a given `upTo` under the monotonicity assumption — see
 *   the module docs for what happens when it isn't.
 * @param options - See {@link BisectOptions}.
 * @returns The first bad index (if any), the probe log, and a confidence
 *   verdict. See {@link BisectResult}.
 */
export async function bisectTurns<T>(
  turns: readonly T[],
  probe: (upTo: number) => Promise<BisectVerdict>,
  options: BisectOptions = {},
): Promise<BisectResult<T>> {
  const maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES;
  const n = turns.length;
  const log: BisectProbeLogEntry[] = [];
  const cache = new Map<number, BisectVerdict>();
  let budgetExhausted = false;

  if (n === 0) {
    return {
      firstBadIndex: undefined,
      item: undefined,
      probes: [],
      confident: true,
      reason: "no turns to bisect",
    };
  }

  /** Call `probe`, honouring the cache and the budget; logs every fresh call. */
  const callProbe = async (
    index: number,
    bypassCache: boolean,
  ): Promise<BisectVerdict | typeof BUDGET_EXHAUSTED> => {
    if (!bypassCache) {
      const cached = cache.get(index);
      if (cached !== undefined) return cached;
    }
    if (log.length >= maxProbes) {
      budgetExhausted = true;
      return BUDGET_EXHAUSTED;
    }
    const verdict = await probe(index);
    log.push({ index, verdict });
    cache.set(index, verdict);
    return verdict;
  };

  /**
   * Resolve `start` to a decidable verdict, stepping outward within
   * `[lo, hi]` when it is `"skip"`. Returns `undefined` when every reachable
   * index in the window is `"skip"` or the budget ran out.
   */
  const resolve = async (
    start: number,
    lo: number,
    hi: number,
  ): Promise<{ index: number; verdict: "good" | "bad" } | undefined> => {
    const first = await callProbe(start, false);
    if (first === BUDGET_EXHAUSTED) return undefined;
    if (first !== "skip") return { index: start, verdict: first };

    for (let offset = 1; start - offset >= lo || start + offset <= hi; offset++) {
      const right = start + offset;
      if (right <= hi) {
        const verdict = await callProbe(right, false);
        if (verdict === BUDGET_EXHAUSTED) return undefined;
        if (verdict !== "skip") return { index: right, verdict };
      }
      const left = start - offset;
      if (left >= lo) {
        const verdict = await callProbe(left, false);
        if (verdict === BUDGET_EXHAUSTED) return undefined;
        if (verdict !== "skip") return { index: left, verdict };
      }
    }
    return undefined;
  };

  let lo = 0;
  let hi = n - 1;
  let firstBad: number | undefined;
  let unresolvedWindow = false;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const decided = await resolve(mid, lo, hi);
    if (decided === undefined) {
      unresolvedWindow = !budgetExhausted;
      break;
    }
    if (decided.verdict === "bad") {
      firstBad = decided.index;
      hi = decided.index - 1;
    } else {
      lo = decided.index + 1;
    }
  }

  const reasons: string[] = [];
  let confident = true;

  if (budgetExhausted) {
    confident = false;
    reasons.push(`probe budget of ${maxProbes} exhausted before the search concluded`);
  } else if (unresolvedWindow) {
    confident = false;
    reasons.push('every probe near the remaining search window returned "skip"');
  }

  if (options.verify === true && firstBad !== undefined && !budgetExhausted) {
    if (firstBad > 0) {
      const verdict = await callProbe(firstBad - 1, true);
      if (verdict === BUDGET_EXHAUSTED) {
        confident = false;
        reasons.push("probe budget exhausted during verification");
      } else if (verdict === "bad") {
        confident = false;
        reasons.push(
          `verification failed: turn ${firstBad - 1} re-probed "bad" but the search treated it as ` +
            "good — the run is not monotonically bad",
        );
      }
    }
    if (firstBad < n - 1) {
      const verdict = await callProbe(firstBad + 1, true);
      if (verdict === BUDGET_EXHAUSTED) {
        confident = false;
        reasons.push("probe budget exhausted during verification");
      } else if (verdict === "good") {
        confident = false;
        reasons.push(
          `verification failed: turn ${firstBad + 1} re-probed "good" right after the first bad turn — ` +
            "the run is not monotonically bad",
        );
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push(
      firstBad === undefined
        ? "every probed turn was good; no divergence found"
        : `first divergence at turn ${firstBad}`,
    );
  }

  return {
    firstBadIndex: firstBad,
    item: firstBad === undefined ? undefined : turns[firstBad],
    probes: log,
    confident,
    reason: reasons.join("; "),
  };
}

/* -------------------------------------------------------------------------- */
/* Cassette-backed probe                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Replays `prompts` (or a prefix of them) against a freshly loaded cassette.
 * Implementations are expected to build a runtime wired to
 * `replayingClient(cassette, { onMiss: "throw" })` and `replayTools(tools,
 * cassette)` (see `INTEGRATION-vcr.md` §5) and drive it with
 * `replaySession()`. Throwing a {@link CassetteError} is a normal, expected
 * outcome — {@link cassetteProbe} classifies it, not an error the caller must
 * guard against.
 *
 * @param cassette - A fresh {@link Cassette} for this probe alone; never
 *   shared across probes, since consumption is stateful.
 * @param prompts - The prompt prefix to replay, in order.
 */
export type CassetteRunProbe = (cassette: Cassette, prompts: readonly string[]) => Promise<void>;

/** Options for {@link cassetteProbe}. */
export interface CassetteProbeOptions {
  /**
   * Loads a cassette from a file path. Defaults to `loadCassette` from
   * `./vcr.js`. Overridable so `cassetteProbe` can be unit-tested with a fake
   * cassette store and no filesystem — see `bisect.test.ts`.
   */
  loadCassette?: (file: string) => Promise<Cassette>;
}

/**
 * Build a {@link bisectTurns} `probe` function backed by a VCR cassette.
 *
 * For each candidate index `upTo`, this:
 *
 * 1. Loads a **fresh** cassette via `options.loadCassette` (default:
 *    {@link loadCassette} from `./vcr.js`). Cassette consumption is stateful
 *    (`takeLlm`/`takeTool` remove entries as they're served), so reusing one
 *    `Cassette` across probes would make every probe after the first see an
 *    already-partially-consumed recording — see `INTEGRATION-vcr.md`.
 * 2. Runs `runProbe(cassette, prompts.slice(0, upTo + 1))`.
 * 3. Classifies the outcome:
 *    - `runProbe` throws `CassetteError` with `code: "miss"` → `"bad"` —
 *      the agent asked for something the recording never produced, which is
 *      the turn-level signature of "behaviour diverged here".
 *    - `runProbe` throws `CassetteError` with `code: "corrupt"`, or loading
 *      the cassette itself throws that → `"skip"` — this candidate can't be
 *      judged at all, not that it's good or bad.
 *    - `runProbe` returns normally and `cassette.stats().misses === 0` →
 *      `"good"` — the recorded prompts replayed cleanly through this prefix.
 *    - `runProbe` returns normally but `stats().misses > 0` (e.g. the caller
 *      used `onMiss: "error-event"` instead of the default `"throw"`, so a
 *      miss ends the run instead of throwing) → `"bad"`, for the same reason
 *      as the thrown case.
 *
 * Any other thrown error (not a {@link CassetteError}) propagates — it is not
 * this function's job to decide whether an unrelated bug counts as a
 * divergence.
 *
 * @param cassetteFile - Path to the cassette to replay against.
 * @param prompts - The full recorded prompt sequence, in order (typically
 *   `extractPrompts(sessionEntries)`).
 * @param runProbe - Drives one replay; see {@link CassetteRunProbe}.
 * @param options - See {@link CassetteProbeOptions}.
 */
export function cassetteProbe(
  cassetteFile: string,
  prompts: readonly string[],
  runProbe: CassetteRunProbe,
  options: CassetteProbeOptions = {},
): (upTo: number) => Promise<BisectVerdict> {
  const load = options.loadCassette ?? loadCassetteFromFile;

  return async (upTo: number): Promise<BisectVerdict> => {
    let cassette: Cassette;
    try {
      cassette = await load(cassetteFile);
    } catch (error) {
      if (error instanceof CassetteError && error.code === "corrupt") return "skip";
      throw error;
    }

    const slice = prompts.slice(0, Math.min(upTo + 1, prompts.length));
    try {
      await runProbe(cassette, slice);
    } catch (error) {
      if (error instanceof CassetteError) {
        if (error.code === "miss") return "bad";
        if (error.code === "corrupt") return "skip";
      }
      throw error;
    }
    return cassette.stats().misses === 0 ? "good" : "bad";
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

/** Options for {@link formatBisectResult}. */
export interface FormatBisectResultOptions<T> {
  /**
   * Renders one turn as a short human label (e.g. a prompt's first ~60
   * chars). Defaults to: the string itself when `T` is a `string`, the
   * `label` field when the item has one (matching
   * `CheckpointTurnSummary.label` from `checkpoints.ts`), else a JSON
   * fallback.
   */
  label?: (item: T, index: number) => string;
}

function defaultLabel<T>(item: T): string {
  if (typeof item === "string") return item;
  if (
    typeof item === "object" &&
    item !== null &&
    "label" in item &&
    typeof (item as { label: unknown }).label === "string"
  ) {
    return (item as { label: string }).label;
  }
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

/**
 * Render a {@link BisectResult} as human-readable text: the first divergent
 * turn (naming it by index and label), whether the search trusts its own
 * answer, and the full probe trail.
 *
 * @param result - Result from {@link bisectTurns}.
 * @param options - See {@link FormatBisectResultOptions}.
 */
export function formatBisectResult<T>(
  result: BisectResult<T>,
  options: FormatBisectResultOptions<T> = {},
): string {
  const labelOf = options.label ?? defaultLabel<T>;
  const lines: string[] = [];

  if (result.firstBadIndex === undefined) {
    lines.push("arcturn bisect: no divergence found — every probed turn matched the recording.");
  } else {
    const label = result.item === undefined ? "" : labelOf(result.item, result.firstBadIndex);
    lines.push(
      `arcturn bisect: behaviour first diverges at turn ${result.firstBadIndex}` +
        (label.length > 0 ? ` — ${label}` : "") +
        ".",
    );
  }

  lines.push(`confident: ${result.confident ? "yes" : "no"} (${result.reason})`);
  lines.push("");
  lines.push(`Probe trail (${result.probes.length} probe(s)):`);
  for (const { index, verdict } of result.probes) {
    lines.push(`  turn ${index}: ${verdict}`);
  }

  return lines.join("\n");
}
