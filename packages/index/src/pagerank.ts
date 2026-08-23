/**
 * Personalised PageRank over a weighted directed graph — hand-rolled, no
 * dependencies.
 *
 * The repo map needs exactly one graph algorithm, and it is about forty lines
 * of arithmetic. Taking a dependency for it would trade a real install cost
 * and a supply-chain surface for code that fits on one screen, in a package
 * whose whole premise is "no native dependencies, installs everywhere Node
 * does".
 *
 * The formulation is the standard one (and the one NetworkX implements, which
 * is what Aider's repo map uses), with three properties that matter here:
 *
 * - **Personalisation.** The teleport vector is a caller-supplied
 *   distribution rather than the uniform one, so rank concentrates around the
 *   files the conversation is actually about. Uniform teleport describes the
 *   repository; personalised teleport describes *this turn's* repository.
 * - **Dangling mass is redistributed through the teleport vector.** A file
 *   that defines symbols but references none has no out-edges; without
 *   explicit handling its rank simply evaporates and the remaining scores
 *   stop summing to one, which silently rescales every comparison.
 * - **Never divides by zero.** An empty graph, a lone node, a node whose every
 *   edge weight is zero, and a node with only a self-loop are all ordinary
 *   inputs, not edge cases to guard at the call site.
 */

/** One weighted out-edge, addressed by destination node index. */
export interface PageRankEdge {
  /** Destination node index. Out-of-range destinations are ignored. */
  readonly to: number;
  /** Edge weight. Non-finite and non-positive weights are ignored. */
  readonly weight: number;
}

/**
 * Out-edge lists by node index: `adjacency[i]` holds node `i`'s out-edges.
 *
 * Parallel edges (two edges `i → j`, one per identifier) are legal and sum
 * naturally, which is what lets the caller keep per-identifier edges around
 * for rank redistribution instead of pre-aggregating them.
 */
export type PageRankAdjacency = readonly (readonly PageRankEdge[])[];

/** Standard damping factor: the probability of following an edge rather than teleporting. */
export const DEFAULT_DAMPING = 0.85;

/** L1 convergence threshold on the whole rank vector. */
export const DEFAULT_TOLERANCE = 1e-6;

/**
 * Iteration ceiling.
 *
 * Power iteration on a damped chain converges geometrically at rate
 * `damping`, so 0.85^100 ≈ 9e-8 — the cap is a guarantee of termination, not
 * a limit anyone reaches in practice.
 */
export const DEFAULT_MAX_ITERATIONS = 100;

/** Knobs for {@link pageRank}. */
export interface PageRankOptions {
  /** Damping factor in `[0, 1)`. Defaults to {@link DEFAULT_DAMPING}. */
  damping?: number;
  /** L1 convergence threshold. Defaults to {@link DEFAULT_TOLERANCE}. */
  tolerance?: number;
  /** Iteration ceiling. Defaults to {@link DEFAULT_MAX_ITERATIONS}. */
  maxIterations?: number;
  /**
   * Teleport distribution, one entry per node. Need not be normalised — it is
   * rescaled to sum to one. A missing, wrong-length, or all-zero vector means
   * the uniform distribution, i.e. ordinary PageRank.
   */
  personalization?: readonly number[];
}

/** Ranks plus the accounting needed to tell "converged" from "ran out of iterations". */
export interface PageRankResult {
  /** Rank per node index. Sums to 1 (within floating-point error) whenever there is a node. */
  readonly ranks: readonly number[];
  /** Power iterations actually performed. */
  readonly iterations: number;
  /** False when {@link PageRankOptions.maxIterations} stopped the loop first. */
  readonly converged: boolean;
}

/**
 * Rescale a personalisation vector into a probability distribution, falling
 * back to uniform when the caller gave nothing usable.
 */
function normalizeTeleport(
  personalization: readonly number[] | undefined,
  nodeCount: number,
): Float64Array {
  const teleport = new Float64Array(nodeCount);
  let total = 0;
  if (personalization && personalization.length === nodeCount) {
    for (let i = 0; i < nodeCount; i++) {
      const value = personalization[i] ?? 0;
      if (Number.isFinite(value) && value > 0) {
        teleport[i] = value;
        total += value;
      }
    }
  }
  if (total <= 0) {
    teleport.fill(1 / nodeCount);
    return teleport;
  }
  for (let i = 0; i < nodeCount; i++) teleport[i] = (teleport[i] ?? 0) / total;
  return teleport;
}

/**
 * Compute personalised PageRank by power iteration.
 *
 * The update, applied until the L1 change falls below `tolerance`:
 *
 * ```text
 *   r'[j] = (1 − d)·p[j]  +  d·( Σ_{i→j} r[i]·w(i,j)/W(i)  +  D·p[j] )
 *
 *   p = teleport distribution      W(i) = total out-weight of i
 *   D = Σ r[i] over dangling i     d    = damping
 * ```
 *
 * @param adjacency - Out-edge lists by node index. Its length *is* the node count.
 * @returns Ranks summing to one, plus whether the loop converged.
 *
 * @example
 * // A → C, B → C, C → A with uniform teleport and d = 0.85 converges to
 * // A = 343/740, B = 0.05, C = 360/740.
 * pageRank([[{ to: 2, weight: 1 }], [{ to: 2, weight: 1 }], [{ to: 0, weight: 1 }]]);
 */
export function pageRank(
  adjacency: PageRankAdjacency,
  options: PageRankOptions = {},
): PageRankResult {
  const nodeCount = adjacency.length;
  if (nodeCount === 0) return { ranks: [], iterations: 0, converged: true };

  const damping = Math.min(Math.max(options.damping ?? DEFAULT_DAMPING, 0), 1 - Number.EPSILON);
  const tolerance = Math.max(options.tolerance ?? DEFAULT_TOLERANCE, Number.EPSILON);
  const maxIterations = Math.max(1, Math.floor(options.maxIterations ?? DEFAULT_MAX_ITERATIONS));
  const teleport = normalizeTeleport(options.personalization, nodeCount);

  // Total out-weight per node. Zero means dangling — no edges, or none usable.
  const outWeight = new Float64Array(nodeCount);
  for (let from = 0; from < nodeCount; from++) {
    const edges = adjacency[from];
    if (!edges) continue;
    let total = 0;
    for (const edge of edges) {
      if (edge.to < 0 || edge.to >= nodeCount) continue;
      if (!Number.isFinite(edge.weight) || edge.weight <= 0) continue;
      total += edge.weight;
    }
    outWeight[from] = total;
  }

  // Starting from the teleport vector rather than uniform costs nothing and
  // converges in fewer iterations when personalisation is concentrated; the
  // fixed point is the same either way.
  let ranks = Float64Array.from(teleport);
  let next = new Float64Array(nodeCount);
  let iterations = 0;
  let converged = false;

  while (iterations < maxIterations) {
    iterations++;

    let danglingMass = 0;
    for (let i = 0; i < nodeCount; i++) {
      if ((outWeight[i] ?? 0) === 0) danglingMass += ranks[i] ?? 0;
    }

    // Everything that does not arrive along an edge arrives through teleport:
    // the (1 − d) restart mass plus the rank stranded on dangling nodes.
    const teleportMass = 1 - damping + damping * danglingMass;
    for (let j = 0; j < nodeCount; j++) next[j] = teleportMass * (teleport[j] ?? 0);

    for (let from = 0; from < nodeCount; from++) {
      const total = outWeight[from] ?? 0;
      if (total === 0) continue;
      const edges = adjacency[from];
      if (!edges) continue;
      const share = (damping * (ranks[from] ?? 0)) / total;
      if (share === 0) continue;
      for (const edge of edges) {
        if (edge.to < 0 || edge.to >= nodeCount) continue;
        if (!Number.isFinite(edge.weight) || edge.weight <= 0) continue;
        next[edge.to] = (next[edge.to] ?? 0) + share * edge.weight;
      }
    }

    let error = 0;
    for (let i = 0; i < nodeCount; i++) error += Math.abs((next[i] ?? 0) - (ranks[i] ?? 0));

    const previous = ranks;
    ranks = next;
    next = previous;

    if (error < tolerance) {
      converged = true;
      break;
    }
  }

  return { ranks: Array.from(ranks), iterations, converged };
}
