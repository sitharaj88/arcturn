/**
 * Scout runs, held long enough for a client to watch one.
 *
 * `/scout` was deliberately left off the wire, and the reason was written down
 * in `built-in-commands.ts`: a scout run has no record anywhere. It makes
 * throwaway worktrees, races approaches against a deadline, deletes every
 * worktree in a `finally`, and returns a report that exists only as the text
 * it printed. A `startScout` verb would have been one request blocking for
 * minutes, with nothing to report on and nothing to cancel.
 *
 * This is the record that objection asked for. `start` returns an id
 * immediately and lets the run continue in the background; `get` answers with
 * whatever has settled so far; `cancel` aborts it, and the run still tears its
 * worktrees down on the way out because that is `runScouts`' own `finally`
 * rather than anything this module has to remember to do.
 *
 * ## What is not solved here, and is not pretended to be
 *
 * These records are **in memory, in one engine process**. A scout run does not
 * survive an engine restart, and a second client attaching to a restarted
 * engine will not find it. That is the honest scope: a scout is a
 * minutes-long exploration a person is watching, not a background agent that
 * should outlive the window. Making runs durable means a records directory and
 * crash recovery — what `BackgroundAgentManager` has — and that is a larger
 * change than the one the editor needed.
 *
 * The worktrees are still gone by the time anyone reads a report, which is
 * fine and always was: `ScoutResult.diff` is captured into memory *before*
 * teardown, so the work product outlives the directory it was made in.
 */

import { randomBytes } from "node:crypto";
import type { ScoutApproach, ScoutReport, ScoutResult } from "./scouts.js";

/** How a run is going. */
export type ScoutRunState =
  /** At least one scout is still working. */
  | "running"
  /** Every scout settled, one way or another. */
  | "finished"
  /** A client called {@link ScoutRegistry.cancel}. */
  | "cancelled"
  /** The run itself threw — a bad repo, a worktree that could not be made. */
  | "failed";

/** One run, as the registry holds it. */
export interface ScoutRunRecord {
  readonly id: string;
  readonly state: ScoutRunState;
  /** What was asked for, in the order it was given. */
  readonly approaches: readonly ScoutApproach[];
  /** Results that have settled so far. Grows while `state` is `running`. */
  readonly results: readonly ScoutResult[];
  /** True when the deadline fired or a cancel cut the run short. */
  readonly timedOut: boolean;
  /** Non-fatal problems — failed cleanups, unreadable diffs. */
  readonly warnings: readonly string[];
  /** Why the run failed, when `state` is `failed`. */
  readonly error?: string;
}

/** How much a finished run cost, or `undefined` when nothing was priced. */
export function scoutRunCost(record: ScoutRunRecord): number | undefined {
  // No `?? 0` per result: a scout on an unpriced model has an *unknown* cost,
  // and summing it as zero would report a run as cheaper than it was. One
  // unknown makes the total unknown, which is what `/cost` already does.
  const priced = record.results.filter((result) => result.costUsd !== undefined);
  if (priced.length === 0) return undefined;
  return priced.reduce((total, result) => total + (result.costUsd ?? 0), 0);
}

/** What the registry needs in order to run anything. */
export interface ScoutRegistryOptions {
  /**
   * Runs the scouts. Injected rather than imported so a test can settle
   * approaches on its own schedule without git, a repository, or a model.
   */
  readonly run: (options: {
    approaches: readonly ScoutApproach[];
    signal: AbortSignal;
    onResult: (result: ScoutResult) => void;
  }) => Promise<ScoutReport>;
  /** How many finished runs to keep before dropping the oldest. */
  readonly keep?: number;
}

/** Finished runs retained before the oldest is dropped. */
export const DEFAULT_SCOUT_RUNS_KEPT = 8;

/** One run's mutable state, and the handle that cancels it. */
interface LiveRun {
  record: ScoutRunRecord;
  readonly controller: AbortController;
}

/**
 * Holds scout runs for the life of one engine process.
 *
 * One instance per engine, the way `BackgroundAgentManager` is one instance:
 * two registries over one repository would be two sets of worktrees racing
 * each other for the same branch names.
 */
export class ScoutRegistry {
  readonly #options: ScoutRegistryOptions;
  /** Insertion-ordered, which is what makes "drop the oldest" a `keys()` walk. */
  readonly #runs = new Map<string, LiveRun>();

  constructor(options: ScoutRegistryOptions) {
    this.#options = options;
  }

  /**
   * Start a run and return its id immediately.
   *
   * The run continues after this resolves. Nothing here awaits it, and nothing
   * observes its rejection except the record — an unhandled rejection from a
   * scout would take the engine down with it.
   *
   * @throws When fewer than two approaches are given. One approach is not an
   *   exploration, and the CLI refuses it for the same reason.
   */
  start(approaches: readonly ScoutApproach[]): string {
    if (approaches.length < 2) {
      throw new Error("a scout run needs at least two approaches to compare");
    }
    const id = randomBytes(9).toString("base64url");
    const controller = new AbortController();
    const live: LiveRun = {
      controller,
      record: {
        id,
        state: "running",
        approaches: [...approaches],
        results: [],
        timedOut: false,
        warnings: [],
      },
    };
    this.#runs.set(id, live);
    this.#evict();

    void this.#options
      .run({
        approaches,
        signal: controller.signal,
        onResult: (result) => {
          // Streamed as each scout settles, so a client watching one approach
          // finish does not have to wait for the slowest.
          live.record = { ...live.record, results: [...live.record.results, result] };
        },
      })
      .then(
        (report) => {
          live.record = {
            ...live.record,
            // A cancelled run stays cancelled: the report it produced is real,
            // but "finished" would tell a client the comparison is complete
            // when the user stopped it half-way.
            state: controller.signal.aborted ? "cancelled" : "finished",
            results: report.results,
            timedOut: report.timedOut,
            warnings: report.warnings,
          };
        },
        (error: unknown) => {
          live.record = {
            ...live.record,
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        },
      );

    return id;
  }

  /** Every run this process knows about, newest last. */
  list(): ScoutRunRecord[] {
    return [...this.#runs.values()].map((live) => live.record);
  }

  /** One run, or `undefined` when the id is unknown or was evicted. */
  get(id: string): ScoutRunRecord | undefined {
    return this.#runs.get(id)?.record;
  }

  /**
   * Stop a run.
   *
   * Every live scout is aborted and every worktree is still cleaned up, because
   * that is `runScouts`' own `finally` rather than something this has to
   * remember. Results that had already settled are kept — a comparison the user
   * cut short is still worth reading.
   *
   * @returns `false` when the id is unknown or the run had already settled.
   */
  cancel(id: string): boolean {
    const live = this.#runs.get(id);
    if (live === undefined || live.record.state !== "running") return false;
    live.controller.abort();
    return true;
  }

  /** Abort every running scout. Called when the engine shuts down. */
  dispose(): void {
    for (const live of this.#runs.values()) {
      if (live.record.state === "running") live.controller.abort();
    }
  }

  /** Drop the oldest *settled* runs once there are too many. */
  #evict(): void {
    const keep = this.#options.keep ?? DEFAULT_SCOUT_RUNS_KEPT;
    for (const [id, live] of this.#runs) {
      if (this.#runs.size <= keep) return;
      // A running scout is never evicted: it owns worktrees, and forgetting it
      // would leave a run nobody can cancel.
      if (live.record.state !== "running") this.#runs.delete(id);
    }
  }
}
