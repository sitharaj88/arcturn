/**
 * The repo map: a pre-computed, always-on, token-budgeted structural summary
 * of the repository, small enough to sit in every request.
 *
 * ## Why this shape and not an embedding index
 *
 * Two teams shipped a full embedding index for code context and then deleted
 * it — Continue.dev (deprecated 2025-08-28; their CLI's `Search` tool is
 * ripgrep) and Zed (`crates/semantic_index` removed 2025-09-08, −4,041 lines)
 * — both citing the same failure: vector chunks bloat the context with
 * unhelpful noise, and model quality degrades with token count long before the
 * window fills. Building an index and then paying to remove it is stronger
 * evidence than any benchmark.
 *
 * Aider's answer is the third design point and the best cost/benefit structure
 * in the space: not retrieval at all, but a *map* — file-level graph, ranked,
 * rendered to a budget, injected every turn so the model orients without
 * searching. It measured 70.3% correct-file identification on SWE-bench Lite,
 * costs milliseconds to build from an index that already exists, and a few
 * thousand tokens to carry.
 *
 * ## The pipeline
 *
 * ```text
 *   chunks ──► reference graph ──► personalised PageRank ──► rank per file
 *                    │                                            │
 *                    │ nodes are files; an edge runs from a file  │
 *                    │ *referencing* an identifier to each file   │
 *                    │ *defining* it, weighted by how much signal │
 *                    │ that identifier carries                    │
 *                    ▼                                            ▼
 *              redistribute each file's rank across its out-edges,
 *              crediting the definitions those edges point at
 *                    │
 *                    ▼
 *              pack the top definitions into a token budget
 * ```
 *
 * The redistribution step is the one that makes this useful rather than a
 * ranked file list: PageRank scores *files*, but what the model needs to see
 * is *symbols*, and an edge already knows which identifier it was about.
 *
 * ## Cost contract
 *
 * {@link buildRepoMap} is pure and does no I/O — it consumes an
 * {@link IndexSnapshot} that already exists and is safe to call on every turn.
 */

import { type PageRankEdge, pageRank } from "./pagerank.js";
import type { IndexSnapshot } from "./store.js";
import { estimateTokens, splitIdentifier } from "./tokenize.js";
import type { ChunkKind, CodeChunk } from "./types.js";

/**
 * Default render budget.
 *
 * Aider's default is `clamp(context / 8, 1024, 4096)`, i.e. 4096 for any
 * modern model — its docs still quote the long-obsolete 1024. 4000 is that
 * figure with room for the wrapper prose a caller puts around the map.
 */
export const DEFAULT_REPO_MAP_TOKEN_BUDGET = 4000;

/** Accepted shortfall below the budget before the packer keeps searching. */
export const DEFAULT_BUDGET_TOLERANCE = 0.15;

/**
 * Share of teleport mass given to {@link RepoMapOptions.focusFiles}.
 *
 * Not 1.0: personalising *entirely* onto the focus files collapses the map to
 * their immediate neighbourhood, and yields an empty map when the focus files
 * happen to reference nothing. Keeping a uniform remainder means the map still
 * describes the repository, just tilted hard toward what is being worked on.
 */
export const DEFAULT_FOCUS_WEIGHT = 0.8;

/** ×10 when the identifier came up in conversation — the strongest relevance signal available. */
export const MENTIONED_MULTIPLIER = 10;

/**
 * ×10 for a long multi-word identifier.
 *
 * `PermissionEngine` or `parse_tool_call` names one thing in one place;
 * `run`, `id`, `value` name a hundred. Length plus a word boundary is a
 * remarkably good free proxy for "this reference is specific".
 */
export const LONG_IDENTIFIER_MULTIPLIER = 10;

/** Minimum length for the long-identifier boost, alongside a word boundary. */
export const LONG_IDENTIFIER_MIN_LENGTH = 8;

/** ×0.1 for a leading underscore: a private symbol says little about how the repo fits together. */
export const PRIVATE_IDENTIFIER_MULTIPLIER = 0.1;

/** ×0.1 once an identifier is defined in more than {@link COMMON_IDENTIFIER_MAX_DEFINERS} files. */
export const COMMON_IDENTIFIER_MULTIPLIER = 0.1;

/**
 * Above this many defining files an identifier stops discriminating.
 *
 * `execute`, `Options`, `handler` are defined everywhere, so an edge along one
 * says almost nothing about which file matters — and worse, it is duplicated
 * to *every* definer, so without damping the commonest names would dominate
 * the graph by sheer edge count.
 */
export const COMMON_IDENTIFIER_MAX_DEFINERS = 5;

/**
 * Tiny share of a file's own rank spread over its definitions, so a symbol
 * nothing references still has a defensible position rather than a hard zero.
 *
 * Kept three orders of magnitude below any real edge credit: it orders the
 * unreferenced tail by how important their file is, and never reorders
 * anything that a reference actually paid for.
 */
export const UNREFERENCED_RESIDUAL = 0.001;

/** Identifier runs shorter than this are noise (`i`, `x`, `n`) and are never matched. */
const MIN_REFERENCE_LENGTH = 2;

/**
 * Size of the membership sieve used to reject identifier runs before they cost
 * a substring and a hash-map probe.
 *
 * 2¹⁶ bits is 8 KB — small enough to stay resident in L1 while the scanner
 * streams megabytes past it. At this repository's ~4,200 defined names the
 * false-positive rate is ~6%, and a false positive costs only the exact-set
 * lookup it was avoiding.
 */
const SIEVE_BITS = 1 << 16;

/**
 * Kinds that are not symbols and so never become definitions.
 *
 * `file` is the whole-file fallback chunk, whose `name` is the filename stem —
 * making `index`, `types`, and `utils` "definitions" in dozens of files at
 * once. `section` is a Markdown heading. Their *text* still contributes
 * references, because a design doc that names `PermissionEngine` is real
 * evidence about `PermissionEngine`.
 */
/**
 * Kinds excluded from the rendered map.
 *
 * `property` is excluded deliberately: interface fields are among the
 * most-referenced names in a typed codebase, so they dominate a ranked slice
 * — 147 of 258 lines in an early render of this repo — and crowd out the
 * classes and functions a reader actually navigates by. They still contribute
 * their edges to the graph, so the files that own them still rank correctly.
 */
const NON_SYMBOL_KINDS: ReadonlySet<ChunkKind> = new Set<ChunkKind>([
  "file",
  "section",
  "property",
]);

/** A whole identifier, used to reject names the chunker recovered as prose. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Rendered label cap — a map line is a name, not a source line. */
const MAX_LABEL_CHARS = 88;

/** Floor on the render budget, below which no map is meaningful. */
const MIN_TOKEN_BUDGET = 40;

/** One definition the map can show, with the rank redistributed onto it. */
export interface RepoMapDefinition {
  /** Repo-relative POSIX path of the defining file. */
  file: string;
  /** Bare symbol name, without its container. */
  name: string;
  /** Dotted container path (`TokenBucket`, `Outer.Inner`) when nested. */
  container?: string;
  /** What kind of declaration this is. */
  kind: ChunkKind;
  /** The declaration line(s), collapsed and capped by the chunker. */
  signature?: string;
  /** 1-based line of the declaration. */
  startLine: number;
  /** 1-based inclusive last line of the declaration. */
  endLine: number;
  /** Redistributed PageRank. Comparable within one map, meaningless across maps. */
  score: number;
}

/** One weighted graph edge, tagged with the identifier that justified it. */
export interface ReferenceEdge extends PageRankEdge {
  /** The identifier referenced in the source file and defined in the destination file. */
  readonly ident: string;
}

/** The file-level reference graph, before ranking. */
export interface ReferenceGraph {
  /** Node index → repo-relative file path, in the snapshot's (sorted) file order. */
  readonly files: readonly string[];
  /** Out-edges by node index; one edge per (identifier, defining file) pair. */
  readonly adjacency: readonly (readonly ReferenceEdge[])[];
  /** Every definition found, with `score` still zero. */
  readonly definitions: readonly RepoMapDefinition[];
  /** Total edges, i.e. the sum of the adjacency list lengths. */
  readonly edgeCount: number;
}

/** What one {@link buildRepoMap} pass saw. */
export interface RepoMapStats {
  /** Files with at least one chunk. */
  files: number;
  /** Chunks the snapshot held. */
  chunks: number;
  /** Definitions found, before {@link RepoMapOptions.maxDefinitions} capped the list. */
  definitions: number;
  /** Edges in the reference graph. */
  edges: number;
  /** PageRank power iterations performed. */
  iterations: number;
  /** Whether PageRank converged inside its iteration cap. */
  converged: boolean;
}

/**
 * The map itself: a ranked symbol list plus the file ranks behind it.
 *
 * Deliberately carries no timing or other ambient state — the same snapshot
 * and options always produce a deeply equal map, which is what makes it safe
 * to cache and to diff.
 */
export interface RepoMap {
  /** Definitions in descending score order, capped at {@link RepoMapOptions.maxDefinitions}. */
  readonly definitions: readonly RepoMapDefinition[];
  /** PageRank per file, summing to one. Useful on its own for "which files matter". */
  readonly fileRanks: ReadonlyMap<string, number>;
  /** Accounting for the pass. */
  readonly stats: RepoMapStats;
}

/** Knobs for {@link buildRepoMap}. */
export interface RepoMapOptions {
  /**
   * Files to personalise toward — recently read or edited files, files in the
   * conversation, the file an error came from. This is the implicit feedback
   * loop that makes the map sharpen toward the current task.
   */
  focusFiles?: readonly string[];
  /**
   * Identifiers named in the conversation. Every edge along one is worth
   * {@link MENTIONED_MULTIPLIER}× as much.
   */
  mentionedIdentifiers?: readonly string[];
  /** Teleport share for {@link RepoMapOptions.focusFiles}. Defaults to {@link DEFAULT_FOCUS_WEIGHT}. */
  focusWeight?: number;
  /** Cap on the returned definition list. Defaults to 10,000 — far past any renderable budget. */
  maxDefinitions?: number;
}

/** Knobs for {@link renderRepoMap}. */
export interface RenderRepoMapOptions {
  /** Hard token ceiling, never exceeded. Defaults to {@link DEFAULT_REPO_MAP_TOKEN_BUDGET}. */
  tokenBudget?: number;
  /**
   * Fractional shortfall accepted as "full". Defaults to
   * {@link DEFAULT_BUDGET_TOLERANCE} — a render at 87% of budget is not worth
   * more binary-search steps.
   */
  tolerance?: number;
}

/** A rendered map plus the accounting behind it. */
export interface RenderedRepoMap {
  /** The text to inject. */
  text: string;
  /** Files appearing in {@link RenderedRepoMap.text}. */
  files: number;
  /** Definitions rendered. */
  definitions: number;
  /** Definitions the budget left out. */
  omitted: number;
  /** True when {@link RenderedRepoMap.omitted} is non-zero. */
  truncated: boolean;
  /** `chars / 4` estimate of {@link RenderedRepoMap.text}; always ≤ the budget. */
  estimatedTokens: number;
}

/**
 * The membership test {@link countReferences} needs: "is this a name some file
 * defines?". Structural so the caller can pass the definer map itself rather
 * than materialising a second `Set` of its keys.
 */
interface NameLookup {
  has(name: string): boolean;
}

/** ASCII identifier-start test on a char code: `A-Z a-z _ $`. */
function isIdentifierStart(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || code === 36;
}

/** ASCII identifier-continuation test: {@link isIdentifierStart} plus digits. */
function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

/** djb2 over an identifier's char codes. Cheap, and computable while scanning. */
function hashIdentifier(name: string): number {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = (hash * 33 + name.charCodeAt(i)) | 0;
  return hash;
}

/** A bitset of {@link hashIdentifier} values, one bit per defined name. */
function buildSieve(names: Iterable<string>): Uint8Array {
  const sieve = new Uint8Array(SIEVE_BITS >>> 3);
  for (const name of names) {
    const bit = hashIdentifier(name) & (SIEVE_BITS - 1);
    sieve[bit >>> 3] = (sieve[bit >>> 3] ?? 0) | (1 << (bit & 7));
  }
  return sieve;
}

/**
 * The edge-weight multiplier for one identifier, before `sqrt(referenceCount)`.
 *
 * Each factor answers "how much does a reference to this name tell me about
 * which file matters?", and they compose — `_parseToolCall` is both long and
 * private, so it lands back at ×1.
 *
 * @param ident - The referenced identifier.
 * @param mentioned - Identifiers named in the conversation.
 * @param definerCount - How many files define `ident`.
 */
export function edgeMultiplier(
  ident: string,
  mentioned: ReadonlySet<string>,
  definerCount: number,
): number {
  let multiplier = 1;
  // Whatever the conversation is about is what the map should be about.
  if (mentioned.has(ident)) multiplier *= MENTIONED_MULTIPLIER;
  // Long *and* multi-word: `splitIdentifier` gives the word boundary for free,
  // in exactly the same camelCase/snake_case terms the retriever tokenizes with.
  if (ident.length >= LONG_IDENTIFIER_MIN_LENGTH && splitIdentifier(ident).length > 1) {
    multiplier *= LONG_IDENTIFIER_MULTIPLIER;
  }
  // A private symbol describes one file's internals, not the repo's shape.
  if (ident.startsWith("_")) multiplier *= PRIVATE_IDENTIFIER_MULTIPLIER;
  // Defined everywhere ⇒ discriminates nowhere.
  if (definerCount > COMMON_IDENTIFIER_MAX_DEFINERS) multiplier *= COMMON_IDENTIFIER_MULTIPLIER;
  return multiplier;
}

/** Normalise a path to the repo-relative POSIX form the index stores. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Map caller-supplied focus paths onto graph node indices.
 *
 * Tolerant on purpose: callers hand over whatever they have — absolute paths
 * from a `read` tool call, `./`-prefixed paths from a shell, Windows
 * separators — and a focus file silently failing to match would degrade the
 * map with no visible symptom.
 */
function resolveFocusFiles(files: readonly string[], focusFiles: readonly string[]): Set<number> {
  const byPath = new Map<string, number>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file !== undefined) byPath.set(file, i);
  }

  const resolved = new Set<number>();
  for (const raw of focusFiles) {
    const path = normalizePath(raw.trim());
    if (path.length === 0) continue;
    const exact = byPath.get(path);
    if (exact !== undefined) {
      resolved.add(exact);
      continue;
    }
    // An absolute (or otherwise prefixed) path: take the longest indexed file
    // it ends with, so `/repo/src/a.ts` beats a coincidental `a.ts` elsewhere.
    let best = -1;
    let bestLength = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || file.length <= bestLength) continue;
      if (path.endsWith(`/${file}`)) {
        best = i;
        bestLength = file.length;
      }
    }
    if (best >= 0) resolved.add(best);
  }
  return resolved;
}

/** Turn a chunk into a definition record, or null when it names nothing usable. */
function definitionOf(chunk: CodeChunk): RepoMapDefinition | null {
  if (NON_SYMBOL_KINDS.has(chunk.kind)) return null;
  if (!IDENTIFIER.test(chunk.name)) return null;
  return {
    file: chunk.file,
    name: chunk.name,
    container: chunk.container,
    kind: chunk.kind,
    signature: chunk.signature,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    score: 0,
  };
}

/**
 * Count occurrences of known identifiers in one piece of chunk text, into one
 * file's running tally.
 *
 * Hand-rolled rather than `text.match(/…/g)` because this runs over every
 * stored body in the repository — several megabytes, near half a million
 * identifier runs — on every build, and the regex form would allocate an array
 * of all of them first. Counting into a *per-file* map (rather than a global
 * identifier→file→count map) keeps the per-hit cost at one lookup in one small
 * map, which is most of the difference between "cheap enough to call every
 * turn" and "not".
 */
function countReferences(
  text: string,
  known: NameLookup,
  sieve: Uint8Array,
  skip: string,
  counts: Map<string, number>,
): void {
  const length = text.length;
  let i = 0;
  while (i < length) {
    const first = text.charCodeAt(i);
    if (!isIdentifierStart(first)) {
      i++;
      continue;
    }
    const start = i;
    // The hash accumulates during the scan the loop is doing anyway, so the
    // sieve test below is almost free.
    let hash = (5381 * 33 + first) | 0;
    i++;
    while (i < length) {
      const code = text.charCodeAt(i);
      if (!isIdentifierPart(code)) break;
      hash = (hash * 33 + code) | 0;
      i++;
    }
    if (i - start < MIN_REFERENCE_LENGTH) continue;

    const bit = hash & (SIEVE_BITS - 1);
    if (((sieve[bit >>> 3] ?? 0) & (1 << (bit & 7))) === 0) continue;

    const ident = text.slice(start, i);
    // A declaration never counts as referencing itself: `function parse(…)`
    // mentions `parse` only because that is where `parse` lives.
    if (ident === skip) continue;
    if (!known.has(ident)) continue;
    counts.set(ident, (counts.get(ident) ?? 0) + 1);
  }
}

/**
 * Build the file-level reference graph.
 *
 * Nodes are files. An edge runs from a file that *references* an identifier to
 * every file that *defines* it, weighted `edgeMultiplier(ident) *
 * sqrt(referenceCount)`.
 *
 * Two choices worth naming:
 *
 * - **Self-edges are kept.** A file's references to its own symbols are real
 *   usage signal, and the redistribution step needs them: they are what ranks
 *   the symbols *inside* a hot file against each other.
 * - **The square root** keeps one hot identifier referenced 400 times from
 *   swamping four distinct identifiers referenced ten times each. Reference
 *   count is evidence with sharply diminishing returns.
 *
 * @param snapshot - An existing index snapshot. Only `chunks` is read.
 */
export function buildReferenceGraph(
  snapshot: IndexSnapshot,
  options: RepoMapOptions = {},
): ReferenceGraph {
  const files: string[] = [];
  const fileIndexes = new Map<string, number>();
  const definitions: RepoMapDefinition[] = [];
  const definerFiles = new Map<string, Set<number>>();

  const indexOf = (file: string): number => {
    const existing = fileIndexes.get(file);
    if (existing !== undefined) return existing;
    const next = files.length;
    files.push(file);
    fileIndexes.set(file, next);
    return next;
  };

  // Pass 1 — definitions. Both `name` and every segment of `container` count,
  // so a method's enclosing class marks its file as a definer even when the
  // class declaration itself was not chunked.
  for (const chunk of snapshot.chunks) {
    const fileIndex = indexOf(chunk.file);
    const definition = definitionOf(chunk);
    if (!definition) continue;
    definitions.push(definition);

    const names = [chunk.name];
    if (chunk.container) {
      for (const segment of chunk.container.split(".")) {
        if (IDENTIFIER.test(segment)) names.push(segment);
      }
    }
    for (const name of names) {
      if (name.length < MIN_REFERENCE_LENGTH) continue;
      const definers = definerFiles.get(name);
      if (definers) definers.add(fileIndex);
      else definerFiles.set(name, new Set([fileIndex]));
    }
  }

  // Pass 2 — references. Signature, doc and body all count: a type in a
  // signature and a name in a doc comment are both real evidence of coupling.
  const sieve = buildSieve(definerFiles.keys());
  const referencesByFile: Array<Map<string, number>> = files.map(() => new Map());
  for (const chunk of snapshot.chunks) {
    const fileIndex = fileIndexes.get(chunk.file);
    if (fileIndex === undefined) continue;
    const counts = referencesByFile[fileIndex];
    if (!counts) continue;
    const name = chunk.name;
    if (chunk.signature) countReferences(chunk.signature, definerFiles, sieve, name, counts);
    if (chunk.doc) countReferences(chunk.doc, definerFiles, sieve, name, counts);
    if (chunk.body) countReferences(chunk.body, definerFiles, sieve, name, counts);
  }

  // Pass 3 — edges. One per (referencing file, identifier, defining file): an
  // ambiguous name points at every file it might have meant, which is exactly
  // what the many-definers damping above is there to pay for.
  const mentioned = new Set(options.mentionedIdentifiers ?? []);
  const multipliers = new Map<string, number>();
  const adjacency: ReferenceEdge[][] = files.map(() => []);
  let edgeCount = 0;

  for (let from = 0; from < files.length; from++) {
    const counts = referencesByFile[from];
    const edges = adjacency[from];
    if (!counts || !edges) continue;
    for (const [ident, count] of counts) {
      const definers = definerFiles.get(ident);
      if (!definers || definers.size === 0) continue;
      let multiplier = multipliers.get(ident);
      if (multiplier === undefined) {
        multiplier = edgeMultiplier(ident, mentioned, definers.size);
        multipliers.set(ident, multiplier);
      }
      if (multiplier <= 0) continue;
      const weight = multiplier * Math.sqrt(count);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      for (const to of definers) {
        edges.push({ to, weight, ident });
        edgeCount++;
      }
    }
  }

  return { files, adjacency, definitions, edgeCount };
}

/**
 * Build the repo map: rank every file, then push each file's rank down onto
 * the individual definitions its references point at.
 *
 * Pure and I/O-free — it reads an {@link IndexSnapshot} that already exists,
 * so it is safe to call on every turn.
 *
 * @param snapshot - The index to summarise. Only `chunks` is read.
 * @param options - Focus files and mentioned identifiers steer the ranking.
 * @returns Definitions in descending score order plus the file ranks behind them.
 *
 * @example
 * const map = buildRepoMap(store.snapshot(), {
 *   focusFiles: ["packages/core/src/permissions.ts"],
 *   mentionedIdentifiers: ["PermissionEngine"],
 * });
 * const { text } = renderRepoMap(map, { tokenBudget: 4000 });
 */
export function buildRepoMap(snapshot: IndexSnapshot, options: RepoMapOptions = {}): RepoMap {
  const graph = buildReferenceGraph(snapshot, options);
  const { files, adjacency, edgeCount } = graph;
  // Copied so the ranking pass can sort it; the definition objects themselves
  // are shared with the graph, which is what lets the redistribution mutate
  // `score` in place instead of rebuilding every record.
  const definitions = [...graph.definitions];

  const stats: RepoMapStats = {
    files: files.length,
    chunks: snapshot.chunks.length,
    definitions: definitions.length,
    edges: edgeCount,
    iterations: 0,
    converged: true,
  };
  if (files.length === 0) {
    return { definitions: [], fileRanks: new Map(), stats };
  }

  const focus = resolveFocusFiles(files, options.focusFiles ?? []);
  const focusWeight = Math.min(Math.max(options.focusWeight ?? DEFAULT_FOCUS_WEIGHT, 0), 1);
  let personalization: number[] | undefined;
  if (focus.size > 0) {
    const baseline = (1 - focusWeight) / files.length;
    const share = focusWeight / focus.size;
    personalization = files.map((_, index) => baseline + (focus.has(index) ? share : 0));
  }

  const ranked = pageRank(adjacency, personalization ? { personalization } : {});
  stats.iterations = ranked.iterations;
  stats.converged = ranked.converged;

  const fileRanks = new Map<string, number>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file !== undefined) fileRanks.set(file, ranked.ranks[i] ?? 0);
  }

  // Definitions indexed by node index and bare name — the lookup an edge
  // needs to find what it was pointing at, keyed so that resolving one edge is
  // an array index plus a single map lookup.
  const fileIndexes = new Map<string, number>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file !== undefined) fileIndexes.set(file, i);
  }
  const byNodeAndName: Array<Map<string, RepoMapDefinition[]>> = files.map(() => new Map());
  const definitionCounts = new Map<string, number>();
  for (const definition of definitions) {
    const node = fileIndexes.get(definition.file);
    const byName = node === undefined ? undefined : byNodeAndName[node];
    if (byName) {
      const existing = byName.get(definition.name);
      if (existing) existing.push(definition);
      else byName.set(definition.name, [definition]);
    }
    definitionCounts.set(definition.file, (definitionCounts.get(definition.file) ?? 0) + 1);
  }

  // Redistribution: a file's rank flows out along its edges in proportion to
  // their weight, and lands on the definitions each edge named. This is what
  // turns a ranked *file* list into a ranked *symbol* list.
  for (let from = 0; from < files.length; from++) {
    const edges = adjacency[from];
    if (!edges || edges.length === 0) continue;
    const rank = ranked.ranks[from] ?? 0;
    if (rank <= 0) continue;

    let total = 0;
    for (const edge of edges) total += edge.weight;
    if (total <= 0) continue;

    for (const edge of edges) {
      const targets = byNodeAndName[edge.to]?.get(edge.ident);
      if (!targets || targets.length === 0) continue;
      const credit = (rank * edge.weight) / total / targets.length;
      for (const target of targets) target.score += credit;
    }
  }

  // A floor for symbols nothing references, so they are ordered by the
  // importance of their file rather than tied at exactly zero.
  for (const definition of definitions) {
    const count = definitionCounts.get(definition.file) ?? 1;
    definition.score += (UNREFERENCED_RESIDUAL * (fileRanks.get(definition.file) ?? 0)) / count;
  }

  definitions.sort(
    (a, b) =>
      b.score - a.score ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.startLine - b.startLine ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const maxDefinitions = Math.max(0, options.maxDefinitions ?? 10_000);
  const capped =
    definitions.length > maxDefinitions ? definitions.slice(0, maxDefinitions) : definitions;

  return { definitions: capped, fileRanks, stats };
}

/** Trim to `max` characters with an ellipsis, preferring a word boundary. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The identifying label for one definition: its qualified name plus whatever
 * the signature adds after it — a parameter list, a return type, a base class.
 *
 * Mirrors `hitLabel` in `format.ts` (built from the qualified name so the
 * container is never lost, and so `export`/`public` boilerplate before the
 * name is dropped), kept separate because a map line is budgeted differently:
 * shorter, and never carrying a doc comment.
 */
function definitionLabel(definition: RepoMapDefinition): string {
  const qualified = definition.container
    ? `${definition.container}.${definition.name}`
    : definition.name;
  const signature = definition.signature;
  if (!signature) return clip(qualified, MAX_LABEL_CHARS);

  const at = signature.indexOf(definition.name);
  if (at < 0) return clip(signature, MAX_LABEL_CHARS);
  const tail = signature.slice(at + definition.name.length).trim();
  if (tail.length === 0) return clip(qualified, MAX_LABEL_CHARS);
  const glued = /^[(<[?:!]/.test(tail);
  return clip(`${qualified}${glued ? "" : " "}${tail}`, MAX_LABEL_CHARS);
}

/**
 * Render the top `count` definitions, grouped under one line per file.
 *
 * Files appear in the order their best definition ranked; symbols within a
 * file appear in source order, because a map is read as an outline.
 */
function renderEntries(definitions: readonly RepoMapDefinition[], omitted: number): string {
  const groups = new Map<string, RepoMapDefinition[]>();
  for (const definition of definitions) {
    const existing = groups.get(definition.file);
    if (existing) existing.push(definition);
    else groups.set(definition.file, [definition]);
  }

  const lines: string[] = [];
  for (const [file, entries] of groups) {
    entries.sort((a, b) => a.startLine - b.startLine || (a.name < b.name ? -1 : 1));
    lines.push(file);
    for (const entry of entries) lines.push(`  ${entry.kind} ${definitionLabel(entry)}`);
  }
  if (omitted > 0) {
    lines.push(`… ${omitted} more symbol${omitted === 1 ? "" : "s"} not shown (repo map budget).`);
  }
  return lines.join("\n");
}

/**
 * Pack the highest-ranked definitions into a token budget.
 *
 * Binary search over the entry count rather than an incremental append,
 * because grouping is not monotone per entry — adding one definition either
 * costs a line or a line *plus a new file header*, so the cheap running total
 * would drift. The search costs `log₂(n)` renders of a few hundred lines, i.e.
 * nothing, and gives an exact answer.
 *
 * The budget is **hard**: the result never exceeds it. Coming within
 * {@link RenderRepoMapOptions.tolerance} of it ends the search early, since
 * the difference between 87% and 93% of budget is not worth more work.
 *
 * @returns The text to inject plus what it left out. Truncation is always
 *   stated in the text — a map that silently drops symbols teaches the model
 *   that absence means "not there".
 */
export function renderRepoMap(map: RepoMap, options: RenderRepoMapOptions = {}): RenderedRepoMap {
  const budget = Math.max(MIN_TOKEN_BUDGET, options.tokenBudget ?? DEFAULT_REPO_MAP_TOKEN_BUDGET);
  const tolerance = Math.min(Math.max(options.tolerance ?? DEFAULT_BUDGET_TOLERANCE, 0), 1);
  const all = map.definitions;

  if (all.length === 0) {
    return { text: "", files: 0, definitions: 0, omitted: 0, truncated: false, estimatedTokens: 0 };
  }

  let low = 0;
  let high = all.length;
  let bestCount = 0;
  let bestText = "";
  let bestTokens = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const text = renderEntries(all.slice(0, mid), all.length - mid);
    const tokens = estimateTokens(text);
    if (tokens <= budget) {
      if (mid >= bestCount) {
        bestCount = mid;
        bestText = text;
        bestTokens = tokens;
      }
      if (tokens >= budget * (1 - tolerance)) break;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const shown = all.slice(0, bestCount);
  const files = new Set(shown.map((definition) => definition.file)).size;
  const omitted = all.length - bestCount;
  return {
    text: bestText,
    files,
    definitions: bestCount,
    omitted,
    truncated: omitted > 0,
    estimatedTokens: bestTokens,
  };
}
