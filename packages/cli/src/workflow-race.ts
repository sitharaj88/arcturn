/**
 * MODEL RACING — run one workflow step on two or three models at once and
 * keep the first answer that is actually good enough.
 *
 * The engine above this module knows nothing about racing: a step has exactly
 * one terminal, one usage figure, one retry classification and one patch. That
 * is the whole design constraint. Everything here exists to turn N concurrent
 * arms back into the ONE outcome the classification/retry layer already knows
 * how to read, while keeping enough of the losers' story to journal it, bill
 * it and learn from it.
 *
 * The rules, in the order they matter:
 *
 * 1. **A winner is the first arm to CLEAR THE GATE**, not the first to
 *    settle. "Cleared" is the caller's {@link StepRaceRequest.judge}: not an
 *    error, not void, and — when the step declares one — a reply that
 *    validates against its contract. A model that fails fast has not won
 *    anything; it has merely gone first.
 * 2. **The moment one clears, every other arm is aborted.** Their work is not
 *    thrown away: on the write lane the caller's arm runner takes the ordinary
 *    cancel path, which captures the diff to a patch file and keeps the
 *    worktree — the patch is on disk, unapplied, forever.
 * 3. **At most one arm's patch is applied**, because at most one arm can hold
 *    the {@link RaceApplyClaim} — and an arm whose patch is refused RELEASES
 *    it, so a sibling that is still running can land instead. The applies
 *    themselves are also serialized per checkout by the engine's
 *    `applyQueues`, so two arms can never both be inside `git apply`.
 * 4. **If nobody clears, the race is a single failure** — the LAST arm to
 *    settle, so the retry policy sees an ordinary failed step with an ordinary
 *    failure kind. The other arms' complaints are handed back for the caller
 *    to fold into that one error string.
 * 5. **Every arm's spend is real money.** Usage is reported progressively per
 *    arm and summed across arms, so the run's budget guard sees the true
 *    burn rate of a 3-way race as it happens rather than a third of it.
 *
 * The module is generic over the outcome type and takes every effect
 * (dispatch, judgement, usage extraction, the clock) as an injection: it has
 * no import from the engine at all, which is what makes "arm B settles first
 * and wins, and arm A's abort signal fired" a test with no LLM in it.
 *
 * @packageDocumentation
 */

import type { Usage } from "@arcturn/types";

/** One arm of a race: a `[race:…]` tag and the model it resolved to. */
export interface RaceArmSpec {
  /** The tag exactly as written in the workflow file. */
  readonly tag: string;
  /** The resolved model id — what the journal, ledger and status all name. */
  readonly model: string;
}

/**
 * Why an arm is not the winner.
 *
 * - `slower` — it cleared the gate too, just not first. The only loser that
 *   produced a usable answer, and the one worth knowing about: it says the
 *   race was a genuine contest rather than a walkover.
 * - `aborted` — the winner appeared while it was still running, so it was cut
 *   off. Nothing it produced was applied.
 * - `failed` — it settled on its own with an error.
 * - `void` — it settled on its own having produced nothing at all.
 */
export type RaceLoserOutcome = "aborted" | "failed" | "void" | "slower";

/** One losing arm, as journalled. */
export interface StepRaceLoser {
  readonly model: string;
  readonly outcome: RaceLoserOutcome;
  readonly durationMs: number;
}

/**
 * What a raced step records about the race itself.
 *
 * Rides on the step's single `stepEnd` line, so `/workflow status` and
 * `/workflow diff` can say "glm-5.3-flash won in 41s · glm-5.3 aborted"
 * without the reader knowing anything about how the race ran.
 */
export interface StepRaceSummary {
  /** Every model that ran, in the order the file wrote them. */
  readonly models: readonly string[];
  /** The model whose outcome the step is. */
  readonly winner: string;
  /** Every other model, in written order. */
  readonly losers: readonly StepRaceLoser[];
}

/** The gate's verdict on one arm's outcome. See {@link StepRaceRequest.judge}. */
export type RaceVerdict = "clears" | "failed" | "void";

/** How one arm ended, whatever it ended as. */
export interface RaceArmRecord<T> {
  readonly arm: RaceArmSpec;
  /** 0-based position in the written race list. */
  readonly index: number;
  /** The arm's outcome, when it settled at all. */
  readonly outcome?: T;
  /** What it threw, when it threw instead of settling. */
  readonly thrown?: unknown;
  /** Wall clock from this arm's dispatch to its settlement (or to the drain). */
  readonly durationMs: number;
  /** True when the race aborted it before it settled on its own. */
  readonly abandoned: boolean;
  /** The gate's reading of {@link outcome}; `failed` for a throw or a no-show. */
  readonly verdict: RaceVerdict;
}

/**
 * The exclusive right to land one raced step's work.
 *
 * Held by at most one arm at a time and released the instant that arm's work
 * does not land, so a race whose first claimant is refused is still a race —
 * see {@link StepRaceRequest.onClaim}.
 */
export interface RaceApplyClaim {
  /**
   * Take the claim for one arm. `false` when another arm already holds it (or
   * already landed), in which case the caller must not write anything.
   */
  take(index: number): boolean;
  /**
   * Report the claim's outcome. `landed: true` means the work is in the user's
   * checkout — irreversible, so every other arm is cut off now. `false`
   * releases the claim for whichever arm is still running.
   *
   * A no-op from an arm that does not hold the claim.
   */
  settle(index: number, landed: boolean): void;
}

/** What {@link runStepRace} is asked to do. */
export interface StepRaceRequest<T> {
  /** Two or three arms, in written order. */
  readonly arms: readonly RaceArmSpec[];
  /** The step's own cancellation signal; every arm's is derived from it. */
  readonly signal: AbortSignal;
  /**
   * Dispatch one arm. Must resolve or reject; must honour `signal` (that is
   * what makes an abandoned arm stop spending). Never called twice for one arm.
   */
  readonly runArm: (
    arm: RaceArmSpec,
    index: number,
    signal: AbortSignal,
    onUsage: (usage: Usage) => void,
  ) => Promise<T>;
  /**
   * Does this outcome clear the gate?
   *
   * The whole quality bar of a race lives here: not an error, not void, and —
   * when the step carries a contract — a reply that validates against it. An
   * arm whose verdict is anything but `clears` cannot win, however fast it was.
   */
  readonly judge: (outcome: T) => RaceVerdict;
  /** Pull the settled spend off an outcome, for the summed race usage. */
  readonly usageOf: (outcome: T) => Usage;
  /** Sum two usage records (the engine's `addUsage`). */
  readonly addUsage: (a: Usage, b: Usage) => Usage;
  /** A zero usage record (the engine's `emptyUsage`). */
  readonly emptyUsage: () => Usage;
  /**
   * Progressive spend across EVERY arm, called on every arm's every turn with
   * the running total. This is what keeps a role budget and the step deadline
   * honest about a race: three arms burn three times the money, and the guard
   * that stops a runaway has to see all of it.
   */
  readonly onUsage?: (total: Usage) => void;
  /**
   * Hand the caller this race's APPLY CLAIM, before any arm starts.
   *
   * The write lane needs one: two arms that both reach `git apply` would land
   * two patches from a step that promises exactly one. So an arm takes the
   * claim ({@link RaceApplyClaim.take}) just before it writes, and reports
   * what happened ({@link RaceApplyClaim.settle}) just after.
   *
   * The claim is *provisional* until it settles, and that is the whole point:
   * an arm whose `git apply` is refused releases it, so a sibling that is
   * still running can take it and win. Only a claim that actually LANDED cuts
   * the other arms off — before that instant nothing is irreversible, and
   * cutting them early is how a race ends with no winner while a perfectly
   * good arm is still in flight. Arms cut off this way are recorded as
   * `aborted`, exactly like the ones the ordinary first-to-clear path cuts.
   */
  readonly onClaim?: (claim: RaceApplyClaim) => void;
  /** Clock injection. */
  readonly now?: () => number;
  /**
   * How long an aborted arm is given to finish tearing down before the race
   * stops waiting for it.
   *
   * A loser's teardown is not free — on the write lane it captures a diff and
   * keeps a worktree — and its record ("aborted, 12s") is worth waiting a
   * moment for. But a model that ignores its abort signal must never hold a
   * *winning* step hostage: the patch is already applied by then, and the
   * step's own wall-clock deadline is minutes away. So the drain is bounded,
   * and an arm that outlasts it is recorded as `aborted` with the time it had
   * burned when the race stopped watching.
   */
  readonly drainMs?: number;
}

/** What a race settled as. */
export interface StepRaceResult<T> {
  /** The arm that cleared the gate first, when any did. */
  readonly winner?: RaceArmRecord<T>;
  /**
   * The record the caller must surface when {@link winner} is absent: the LAST
   * arm to settle, so the engine's retry classifier sees one ordinary failure
   * with one ordinary failure kind rather than a synthetic one.
   */
  readonly fallback: RaceArmRecord<T>;
  /** Every arm, in written order. */
  readonly records: readonly RaceArmRecord<T>[];
  /** The block that rides the step's `stepEnd` line. */
  readonly summary: StepRaceSummary;
  /** Summed spend over every arm — the honest cost of the race. */
  readonly usage: Usage;
}

/** Default grace for a loser's teardown. See {@link StepRaceRequest.drainMs}. */
export const RACE_DRAIN_MS = 20_000;

/** One arm's settlement, as the race's own bookkeeping sees it. */
interface ArmSettlement<T> {
  readonly index: number;
  readonly outcome?: T;
  readonly thrown?: unknown;
  readonly endedAt: number;
  readonly abandoned: boolean;
}

/**
 * Run one step on several models at once and reduce them to one outcome.
 *
 * See this module's own doc comment for the rules; the implementation is a
 * plain "race, judge, abort the rest, drain" loop with no hidden state.
 *
 * @param request - The arms, the dispatcher, the gate and the injections.
 */
export async function runStepRace<T>(request: StepRaceRequest<T>): Promise<StepRaceResult<T>> {
  const now = request.now ?? Date.now;
  const drainMs = request.drainMs ?? RACE_DRAIN_MS;
  const arms = request.arms;
  if (arms.length === 0) throw new Error("a race needs at least one arm");

  const controllers = arms.map(() => new AbortController());
  const onParentAbort = (): void => {
    for (const controller of controllers) controller.abort();
  };
  request.signal.addEventListener("abort", onParentAbort, { once: true });
  if (request.signal.aborted) onParentAbort();

  // Set the instant THIS race cuts an arm off, so a settlement that lands
  // afterwards is recorded as `aborted` rather than as whatever the runner
  // happened to return on its way out.
  const abandoned = arms.map(() => false);
  const startedAt = arms.map(() => now());
  // Last-known spend per arm, so an arm that never settles still contributes
  // the money it burned. Replaced by the settled figure when one arrives.
  const spend = arms.map(() => request.emptyUsage());
  const total = (): Usage =>
    spend.reduce((sum, one) => request.addUsage(sum, one), request.emptyUsage());

  /** Cut every arm but one, marking them abandoned. Idempotent per arm. */
  const abortOthers = (except: number): void => {
    for (const [index, controller] of controllers.entries()) {
      if (index === except) continue;
      abandoned[index] = true;
      controller.abort();
    }
  };
  // THE APPLY CLAIM. Provisional until it settles: a claimant whose work is
  // refused releases it rather than taking the whole race down with it, and
  // only a claim that landed cuts the siblings off. See {@link RaceApplyClaim}.
  let claimant: number | undefined;
  request.onClaim?.({
    take: (index) => {
      if (claimant !== undefined) return false;
      claimant = index;
      return true;
    },
    settle: (index, landed) => {
      if (claimant !== index) return;
      if (landed) abortOthers(index);
      // Nothing landed, so nothing is irreversible and the claim is free
      // again — the next arm to reach its own write can take it.
      else claimant = undefined;
    },
  });

  try {
    const settlements = arms.map(async (arm, index): Promise<ArmSettlement<T>> => {
      const controller = controllers[index];
      if (controller === undefined) throw new Error("missing arm controller");
      try {
        const outcome = await request.runArm(arm, index, controller.signal, (usage) => {
          spend[index] = usage;
          request.onUsage?.(total());
        });
        spend[index] = request.usageOf(outcome);
        return { index, outcome, endedAt: now(), abandoned: abandoned[index] === true };
      } catch (thrown) {
        return { index, thrown, endedAt: now(), abandoned: abandoned[index] === true };
      }
    });

    const pending = new Map<number, Promise<ArmSettlement<T>>>();
    for (const [index, settlement] of settlements.entries()) pending.set(index, settlement);

    const records = new Map<number, RaceArmRecord<T>>();
    let winner: RaceArmRecord<T> | undefined;
    let last: RaceArmRecord<T> | undefined;

    const recordOf = (settled: ArmSettlement<T>): RaceArmRecord<T> => {
      const arm = arms[settled.index];
      if (arm === undefined) throw new Error("missing arm spec");
      const verdict: RaceVerdict =
        settled.outcome === undefined ? "failed" : request.judge(settled.outcome);
      return {
        arm,
        index: settled.index,
        ...(settled.outcome === undefined ? {} : { outcome: settled.outcome }),
        ...(settled.thrown === undefined ? {} : { thrown: settled.thrown }),
        durationMs: Math.max(0, settled.endedAt - (startedAt[settled.index] ?? settled.endedAt)),
        abandoned: settled.abandoned,
        verdict,
      };
    };

    while (pending.size > 0 && winner === undefined) {
      const settled = await Promise.race([...pending.values()]);
      pending.delete(settled.index);
      const record = recordOf(settled);
      records.set(settled.index, record);
      last = record;
      if (record.verdict === "clears") {
        winner = record;
        // Everything else stops NOW: the answer is in hand, and every further
        // turn any other arm takes is money spent on a reply nobody will read.
        abortOthers(settled.index);
      }
    }

    // Drain what is left, bounded — see `drainMs`. An arm that outlasts the
    // grace is recorded from what is known about it rather than waited out.
    if (pending.size > 0) {
      const drained = await Promise.race([
        Promise.all([...pending.values()]).then(() => "drained" as const),
        new Promise<"timeout">((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), drainMs);
          // Never keep a process alive for a loser's teardown.
          timer.unref?.();
        }),
      ]);
      if (drained === "drained") {
        for (const [index, settlement] of pending) {
          const record = recordOf(await settlement);
          records.set(index, record);
          if (winner === undefined) last = record;
        }
      } else {
        for (const index of pending.keys()) {
          const arm = arms[index];
          if (arm === undefined) continue;
          // Its spend keeps updating in the background; what is known now is
          // what the summary carries.
          records.set(index, {
            arm,
            index,
            durationMs: Math.max(0, now() - (startedAt[index] ?? now())),
            abandoned: true,
            verdict: "failed",
          });
        }
      }
    }

    const ordered: RaceArmRecord<T>[] = [];
    for (const [index, arm] of arms.entries()) {
      const record = records.get(index);
      ordered.push(
        record ?? {
          arm,
          index,
          durationMs: 0,
          abandoned: true,
          verdict: "failed",
        },
      );
    }
    const fallback = winner ?? last ?? ordered[ordered.length - 1];
    if (fallback === undefined) throw new Error("a race settled with no arms");

    const champion = winner ?? fallback;
    const summary: StepRaceSummary = {
      models: arms.map((arm) => arm.model),
      winner: champion.arm.model,
      losers: ordered
        .filter((record) => record.index !== champion.index)
        .map((record) => ({
          model: record.arm.model,
          outcome: loserOutcome(record),
          durationMs: record.durationMs,
        })),
    };

    return {
      ...(winner === undefined ? {} : { winner }),
      fallback,
      records: ordered,
      summary,
      usage: total(),
    };
  } finally {
    request.signal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Label one losing arm.
 *
 * An arm this race cut off reads `aborted` whatever it managed to return on
 * the way out — "the winner appeared" is the honest cause, and the outcome it
 * produced under an abort is not evidence of anything about the model. An arm
 * that settled on its own is labelled by what it actually produced, and one
 * that produced a perfectly good answer a moment too late is `slower`, which
 * is the only loser label that says the race was worth running.
 *
 * Exported because the ledger labels a losing arm's own terminal with it:
 * "this model was cut off" and "this model failed on its own" are the same
 * `failed` status and completely different evidence about the model.
 *
 * @param record - The arm's record.
 */
export function loserOutcome<T>(record: RaceArmRecord<T>): RaceLoserOutcome {
  if (record.abandoned) return "aborted";
  if (record.verdict === "clears") return "slower";
  return record.verdict === "void" ? "void" : "failed";
}

/**
 * One line describing how a race resolved, for `/workflow status` and the
 * live notice: `glm-5.3-flash won in 41s · glm-5.3 aborted`.
 *
 * @param summary - The journalled race block.
 * @param winnerMs - How long the winning arm took, when the reader knows it
 *   (the step's own duration, on a status line).
 * @param dot - The separator glyph the caller's renderer uses.
 */
export function describeRace(summary: StepRaceSummary, winnerMs?: number, dot = "·"): string {
  const won =
    winnerMs === undefined
      ? `${summary.winner} won`
      : `${summary.winner} won in ${formatRaceDuration(winnerMs)}`;
  const losers = summary.losers.map((loser) => `${loser.model} ${loser.outcome}`);
  return [won, ...losers].join(` ${dot} `);
}

/**
 * A compact duration for a race line.
 *
 * Deliberately not `format.ts`'s `formatDuration`: this module has no engine
 * imports at all (see the module doc), and a race line wants seconds even for
 * a sub-second arm — "won in 0s" is a fact, "won in 412ms" is noise.
 *
 * @param ms - Milliseconds.
 */
export function formatRaceDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
}

/**
 * Read a `race` block off a journal line without trusting it.
 *
 * Same tolerance rule as every other fold in this codebase: a torn or
 * hand-edited line yields `undefined` rather than a half-built object that a
 * renderer then crashes on.
 *
 * @param value - Whatever the journal line carried.
 */
export function raceSummaryFacts(value: unknown): StepRaceSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<StepRaceSummary>;
  if (typeof raw.winner !== "string" || raw.winner === "") return undefined;
  if (!Array.isArray(raw.models)) return undefined;
  const models = raw.models.filter((model): model is string => typeof model === "string");
  if (models.length === 0) return undefined;
  const losers: StepRaceLoser[] = [];
  for (const loser of Array.isArray(raw.losers) ? raw.losers : []) {
    if (typeof loser !== "object" || loser === null) continue;
    const one = loser as Partial<StepRaceLoser>;
    if (typeof one.model !== "string" || one.model === "") continue;
    const outcome = one.outcome;
    if (outcome !== "aborted" && outcome !== "failed" && outcome !== "void" && outcome !== "slower")
      continue;
    losers.push({
      model: one.model,
      outcome,
      durationMs:
        typeof one.durationMs === "number" && Number.isFinite(one.durationMs) && one.durationMs >= 0
          ? one.durationMs
          : 0,
    });
  }
  return { models, winner: raw.winner, losers };
}
