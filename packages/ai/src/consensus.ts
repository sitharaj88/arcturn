/**
 * Consensus / divergence detection: model **disagreement** as the uncertainty
 * signal.
 *
 * Asking a model "are you sure?" is close to worthless — the same weights that
 * produced the answer produce the confidence report, so the two are correlated
 * by construction. Running the *same turn* on two or three independently
 * trained models is not: where they agree, the turn is probably fine; where
 * they diverge — especially where they choose **different tool calls** — is
 * precisely where a human should look. Multi-provider support is normally
 * treated as redundancy (failover). This module treats it as epistemics.
 *
 * ## Advisory, never a gate
 *
 * The primary link (`links[0]`) streams through to the consumer **verbatim**:
 * the same {@link StreamEvent} objects, in the same order, with no added
 * latency to the first token. The secondaries run concurrently, buffered to
 * completion, and the {@link ConsensusVerdict} is delivered out-of-band through
 * `options.onVerdict` *after* the primary's stream ends.
 *
 * This is deliberate. Gating the turn on agreement would mean holding every
 * token until the slowest model finishes, turning a fast turn into a slow one
 * and making the harness's behaviour depend on a heuristic text-similarity
 * score. Consensus is a *signal for a human*, not a correctness oracle: it
 * says "look here", not "this is wrong". Callers that genuinely want a gate can
 * build one on top — pause before executing a tool call when the verdict says
 * `"divergent"` — but that policy belongs to the caller, not to the client.
 *
 * Because the verdict arrives out-of-band, `onVerdict` may fire *after* the
 * consumer's `for await` loop has already finished. It is fired at most once
 * per `stream()` call, and never before the primary's terminal event.
 *
 * ## Cost: this multiplies token spend by N
 *
 * A three-model panel bills roughly three times the input tokens and three
 * times the output tokens of a normal turn, every turn. That is the whole
 * price of the signal and it should be stated plainly rather than buried:
 *
 * - {@link ConsensusOptions.sampleRate} runs the panel on only a fraction of
 *   turns (`0.1` ≈ one turn in ten). Sampled-out turns cost exactly one model
 *   and produce **no** verdict — absence of a verdict is not agreement.
 * - Secondaries are skipped entirely when no `onVerdict` callback is supplied:
 *   a verdict nobody reads is not worth paying for.
 * - Only the *primary's* usage is reported through the stream's `usage` events.
 *   Secondary spend is real but invisible to the normal accounting path, so a
 *   host that enables consensus should surface it separately.
 * - Secondaries are aborted if the consumer abandons the primary's stream
 *   before it terminates, so a cancelled turn does not keep paying.
 *
 * ## What is compared
 *
 * Diffing three live token streams against each other is intractable — models
 * phrase the same answer at different speeds and in different orders. So
 * comparison happens once, on the **final assembled message** (see
 * {@link compareMessages}), which is exactly the artefact the rest of the
 * harness acts on.
 *
 * @see createFailoverClient — the same "N clients, one stream" shape used for
 *   *redundancy*. The two compose: each consensus link may itself be a failover
 *   chain, so a model being down degrades the panel instead of breaking it.
 */

import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  ModelSpec,
  StopReason,
  StreamEvent,
  Usage,
} from "@arcturn/types";
import { toAIError } from "./errors.js";
import { completeFromStream } from "./internal/stream.js";

/**
 * One member of a consensus panel.
 *
 * Either a bare {@link LLMClient} — which streams `request.model` unchanged —
 * or a `{ client, model }` pair overriding the model for that member. This is
 * the same shape as `FailoverLink` on purpose: a link may itself be a failover
 * chain built with `createFailoverClient`, so a panel of three models is really
 * a panel of three *chains*.
 */
export type ConsensusLink = LLMClient | { client: LLMClient; model?: ModelSpec };

/** How strongly two models agreed on a turn. */
export type AgreementLevel =
  /** Same actions and substantially the same words. Proceed. */
  | "full"
  /**
   * Same actions, materially different wording — or nothing to compare
   * against, because every secondary was unavailable. Worth a glance, not an
   * alarm.
   */
  | "partial"
  /** Different tool calls: the models chose different *actions*. Look here. */
  | "divergent";

/**
 * The out-of-band result of running one turn across a panel.
 *
 * `textSimilarity` and `toolCallsMatch` are the *worst* case across all
 * available secondaries: one dissenter is the signal, and averaging it away
 * with agreeing models would hide exactly what this exists to find.
 */
export interface ConsensusVerdict {
  /** Overall classification; see {@link AgreementLevel}. */
  agreement: AgreementLevel;
  /**
   * True when every available secondary made the same tool calls, in the same
   * order, with the same arguments (ignoring provider-assigned call ids and
   * JSON key order). The highest-signal field: `false` means the models chose
   * different *actions*, not merely different words.
   *
   * Also `true` when no secondary was available — nothing contradicted the
   * primary — which is why `agreement` and not this flag is the field to
   * branch on.
   */
  toolCallsMatch: boolean;
  /**
   * Lowest text similarity (0..1) between the primary and any available
   * secondary; see {@link textSimilarity}. `0` when no comparison was possible.
   */
  textSimilarity: number;
  /**
   * Human-readable specifics, each prefixed with the model that differed.
   * **Empty means the models were indistinguishable** on every axis compared.
   */
  details: string[];
  /** Model ids in the panel, primary first, including unavailable members. */
  models: string[];
  /**
   * Token usage per member that actually answered, keyed by model id.
   *
   * Only the primary's usage reaches the consumer's stream, so this is the
   * caller's only way to price a panel correctly — without it a cross-check
   * on a cheap model gets billed at the primary's rate.
   */
  usageByModel?: Record<string, Usage>;
}

/** The per-pair comparison behind a {@link ConsensusVerdict}. */
export interface MessageDivergence {
  /**
   * True when the two messages' tool calls differ in count, name, order, or
   * arguments. Note the polarity: this is a *divergence* record, so `true` is
   * the interesting case (the verdict flips it into `toolCallsMatch`).
   */
  toolCallsDiffer: boolean;
  /** Jaccard word overlap of the normalised text, 0..1; see {@link textSimilarity}. */
  textSimilarity: number;
  /** True when the two messages ended for different reasons. */
  stopReasonDiffers: boolean;
  /** Human-readable specifics; empty when nothing differed. */
  details: string[];
}

/** Tuning knobs for {@link createConsensusClient}. */
export interface ConsensusOptions {
  /**
   * Where the verdict goes. Fired at most once per `stream()` call, after the
   * primary's terminal event and after every secondary has settled.
   *
   * **Omitting this disables consensus entirely** — the secondaries are never
   * called, because their only product is the verdict. Errors thrown by this
   * callback are swallowed: an observability hook must not be able to break a
   * turn that has already completed.
   */
  onVerdict?: (verdict: ConsensusVerdict) => void;
  /**
   * Minimum {@link textSimilarity} for `"full"` agreement when the tool calls
   * already match. Defaults to {@link DEFAULT_SIMILARITY_THRESHOLD}.
   *
   * The right value is task-dependent: terse tool-calling turns share few
   * words and score low even when they agree, while prose answers score high.
   * Tune it to your noise tolerance rather than trusting the default.
   */
  similarityThreshold?: number;
  /**
   * Fraction of turns (0..1) that run the panel. `1` (default) checks every
   * turn at N× cost; `0` disables the panel without unwiring it; `0.1` samples
   * one turn in ten. Sampled-out turns emit no verdict at all.
   */
  sampleRate?: number;
  /** Randomness source for `sampleRate`, injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Default {@link ConsensusOptions.similarityThreshold}.
 *
 * Chosen low on purpose: two models answering the same question correctly
 * routinely share only 60–70% of their word set, so a stricter bar would flag
 * agreement as disagreement on every turn and train the reader to ignore it.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

/** Cap on a single quoted value inside {@link ConsensusVerdict.details}. */
const DETAIL_VALUE_LIMIT = 160;

/** Normalise a {@link ConsensusLink} into an explicit `{ client, model? }`. */
function normalizeLink(link: ConsensusLink): { client: LLMClient; model?: ModelSpec } {
  return typeof (link as LLMClient).stream === "function"
    ? { client: link as LLMClient }
    : (link as { client: LLMClient; model?: ModelSpec });
}

/**
 * Serialise a value to JSON with object keys sorted recursively.
 *
 * Two models that request `{"path":"a","limit":10}` and `{"limit":10,"path":"a"}`
 * have made the *same* tool call; JSON key order is an artefact of how each
 * provider serialises arguments and carries no meaning. Canonicalising before
 * comparison is what keeps that from reading as divergence.
 *
 * Array order *is* preserved — argument arrays are ordered data, not sets.
 * Object properties whose value is `undefined` are dropped, matching
 * `JSON.stringify`. Inputs are assumed acyclic (tool arguments are parsed from
 * JSON, so they always are).
 *
 * @param value - Any JSON-compatible value.
 * @returns Deterministic JSON text for `value`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // `undefined`, functions, and symbols stringify to `undefined`; NaN and
    // Infinity to "null". Normalise the former so the result is always JSON.
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Lowercase text and collapse all whitespace runs to single spaces.
 *
 * The cheapest possible defence against "identical answer, different line
 * wrapping" reading as disagreement.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Word tokens of `text`, punctuation stripped, for overlap scoring. */
function tokenize(text: string): Set<string> {
  const matches = normalizeText(text).match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu);
  return new Set(matches ?? []);
}

/**
 * Cheap 0..1 similarity between two texts: Jaccard overlap of their word sets.
 *
 * This is deliberately *not* semantic. An embedding model or an LLM judge
 * would score paraphrase better, but each would add a network call, a cost, and
 * a second opaque judgement to the very pipeline whose opacity this module
 * exists to reduce. Word overlap is transparent, free, and deterministic — and
 * it is only ever used to separate "said roughly the same thing" from "said
 * something else", never to grade an answer.
 *
 * Known and accepted limitations: word *order* is ignored ("A calls B" scores
 * 1.0 against "B calls A"), and short texts are high-variance. The high-signal
 * comparison is tool calls; this is the low-signal companion.
 *
 * @returns `1` when both texts are empty (silence agrees with silence), `0`
 *   when exactly one is empty.
 */
export function textSimilarity(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

/** All text blocks of a message, joined; thinking blocks are excluded. */
function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** `{ name, arguments }` for each tool call, in order. Call ids are dropped. */
function toolCallsOf(message: AssistantMessage): { name: string; args: string }[] {
  return message.content
    .filter(
      (block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
    )
    .map((block) => ({ name: block.name, args: canonicalJson(block.arguments) }));
}

/** Shorten a value for a detail line without hiding that it was shortened. */
function truncate(value: string): string {
  return value.length <= DETAIL_VALUE_LIMIT ? value : `${value.slice(0, DETAIL_VALUE_LIMIT)}…`;
}

/**
 * Compare two assembled assistant messages and describe how they differ.
 *
 * Three axes, in descending order of signal:
 *
 * 1. **Tool calls** — same names in the same order with the same arguments?
 *    This is the one that matters: a differing tool call means the two models
 *    chose to *do different things*, which no amount of similar prose makes
 *    safe. Provider-assigned call ids are ignored (they never match across
 *    providers) and arguments are compared as canonical JSON, so key order is
 *    not divergence.
 * 2. **Text** — {@link textSimilarity} over the concatenated text blocks.
 *    Thinking blocks are excluded: reasoning traces are provider-shaped,
 *    optional, and often absent on one side, so comparing them produces noise
 *    rather than signal.
 * 3. **Stop reason** — one model finishing its turn while the other hit
 *    `maxTokens` is worth knowing even when the visible prefixes match.
 *
 * The comparison is symmetric in substance; only the wording of the detail
 * lines (`a vs b`) depends on argument order.
 *
 * @param a - Typically the primary's message.
 * @param b - The secondary's message.
 */
export function compareMessages(a: AssistantMessage, b: AssistantMessage): MessageDivergence {
  const details: string[] = [];

  const callsA = toolCallsOf(a);
  const callsB = toolCallsOf(b);
  let toolCallsDiffer = false;

  if (callsA.length !== callsB.length) {
    toolCallsDiffer = true;
    details.push(
      `tool call count differs: ${callsA.length} (${callsA.map((c) => c.name).join(", ") || "none"}) vs ${callsB.length} (${callsB.map((c) => c.name).join(", ") || "none"})`,
    );
  }
  for (let index = 0; index < Math.min(callsA.length, callsB.length); index++) {
    const left = callsA[index];
    const right = callsB[index];
    if (!left || !right) continue;
    if (left.name !== right.name) {
      toolCallsDiffer = true;
      details.push(`tool call ${index}: name differs (${left.name} vs ${right.name})`);
      // Arguments of two different tools are not comparable; the name is the
      // finding.
      continue;
    }
    if (left.args !== right.args) {
      toolCallsDiffer = true;
      details.push(
        `tool call ${index} (${left.name}): arguments differ (${truncate(left.args)} vs ${truncate(right.args)})`,
      );
    }
  }

  const similarity = textSimilarity(textOf(a), textOf(b));
  if (similarity < 1) {
    details.push(`text similarity ${similarity.toFixed(2)}`);
  }

  const stopReasonDiffers = a.stopReason !== b.stopReason;
  if (stopReasonDiffers) {
    details.push(`stop reason differs: ${a.stopReason} vs ${b.stopReason}`);
  }

  return { toolCallsDiffer, textSimilarity: similarity, stopReasonDiffers, details };
}

/** What one secondary produced, or why it could not be compared. */
type SecondaryOutcome =
  | { kind: "message"; modelId: string; message: AssistantMessage }
  | { kind: "unavailable"; modelId: string; reason: string };

/**
 * Run one secondary to completion, converting *every* failure mode into an
 * outcome. This promise never rejects: a secondary is an optional observer and
 * must never be able to affect the turn the user is actually having.
 */
async function runSecondary(
  link: { client: LLMClient; model?: ModelSpec },
  request: LLMRequest,
  signal: AbortSignal,
): Promise<SecondaryOutcome> {
  const spec = link.model ?? request.model;
  try {
    const message = await completeFromStream(
      link.client.stream({ ...request, model: spec, signal }),
    );
    if (message.stopReason === "error") {
      return {
        kind: "unavailable",
        modelId: spec.id,
        reason: message.errorMessage ?? "stream ended with an error",
      };
    }
    if (message.stopReason === "aborted") {
      return { kind: "unavailable", modelId: spec.id, reason: "aborted" };
    }
    return { kind: "message", modelId: spec.id, message };
  } catch (err) {
    // Covers a client that throws instead of emitting an `error` event, and a
    // stream that ends with no terminal event at all.
    return { kind: "unavailable", modelId: spec.id, reason: toAIError(err, signal).message };
  }
}

/** Fold the primary's message and every secondary outcome into a verdict. */
function buildVerdict(
  primaryModelId: string,
  primaryMessage: AssistantMessage,
  outcomes: readonly SecondaryOutcome[],
  threshold: number,
): ConsensusVerdict {
  const models = [primaryModelId, ...outcomes.map((outcome) => outcome.modelId)];
  // Only the primary's usage reaches the consumer's stream, so the caller
  // needs each member's usage to price the panel at each member's own rate.
  const usageByModel: Record<string, Usage> = { [primaryModelId]: primaryMessage.usage };
  for (const outcome of outcomes) {
    if (outcome.kind === "message") usageByModel[outcome.modelId] = outcome.message.usage;
  }
  const details: string[] = [];
  let toolCallsMatch = true;
  let lowestSimilarity = 1;
  let compared = 0;

  for (const outcome of outcomes) {
    if (outcome.kind === "unavailable") {
      details.push(`${outcome.modelId}: unavailable (${outcome.reason})`);
      continue;
    }
    compared++;
    const divergence = compareMessages(primaryMessage, outcome.message);
    if (divergence.toolCallsDiffer) toolCallsMatch = false;
    lowestSimilarity = Math.min(lowestSimilarity, divergence.textSimilarity);
    for (const detail of divergence.details) details.push(`${outcome.modelId}: ${detail}`);
  }

  if (compared === 0) {
    // Nothing corroborated the primary, so this is reported as "partial" and
    // never "full": an unchecked turn must not look like a checked one.
    details.push("no secondary produced a comparable message; consensus unconfirmed");
    return {
      agreement: "partial",
      toolCallsMatch: true,
      textSimilarity: 0,
      details,
      models,
      usageByModel,
    };
  }

  const agreement: AgreementLevel = !toolCallsMatch
    ? "divergent"
    : lowestSimilarity >= threshold
      ? "full"
      : "partial";
  return {
    agreement,
    toolCallsMatch,
    textSimilarity: lowestSimilarity,
    details,
    models,
    usageByModel,
  };
}

/** Decide whether this turn is one of the sampled ones. */
function shouldSample(options: ConsensusOptions): boolean {
  const rate = options.sampleRate;
  if (rate === undefined || !Number.isFinite(rate) || rate >= 1) return true;
  if (rate <= 0) return false;
  return (options.random ?? Math.random)() < rate;
}

/**
 * A child abort signal that follows `parent` and can also be aborted alone, so
 * abandoning the primary's stream stops the secondaries from burning tokens.
 */
function linkSignal(parent: AbortSignal | undefined): {
  signal: AbortSignal;
  abort: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (parent === undefined) {
    return { signal: controller.signal, abort: () => controller.abort(), dispose: () => {} };
  }
  const forward = (): void => controller.abort(parent.reason);
  if (parent.aborted) forward();
  else parent.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => parent.removeEventListener("abort", forward),
  };
}

/**
 * Stream a request across a consensus panel.
 *
 * The primary (`links[0]`) is streamed through verbatim — every event object is
 * re-yielded unchanged, so a consumer cannot tell consensus is on by looking at
 * the stream. Secondaries run concurrently and are folded into a verdict handed
 * to `options.onVerdict` after the primary terminates.
 *
 * No verdict is produced when: the panel was sampled out, there are no
 * secondaries, no `onVerdict` was supplied, the consumer abandoned the stream
 * early, or the primary itself errored or was aborted (a failed turn is its own
 * signal and there is nothing to compare).
 *
 * @param links - Panel members, primary first.
 * @param request - The turn to run on every member.
 * @param options - {@link ConsensusOptions}.
 */
export async function* streamConsensus(
  links: readonly ConsensusLink[],
  request: LLMRequest,
  options: ConsensusOptions = {},
): AsyncIterable<StreamEvent> {
  const panel = links.map(normalizeLink);
  const primary = panel[0];
  if (!primary) throw new TypeError("streamConsensus requires at least one client");

  const primarySpec = primary.model ?? request.model;
  const primaryRequest = primary.model ? { ...request, model: primary.model } : request;
  const secondaries = panel.slice(1);
  const onVerdict = options.onVerdict;

  // Skip the panel when it cannot pay for itself: nothing to compare against,
  // nowhere to send the verdict, or this turn was sampled out.
  if (secondaries.length === 0 || onVerdict === undefined || !shouldSample(options)) {
    yield* primary.client.stream(primaryRequest);
    return;
  }

  const { signal, abort, dispose } = linkSignal(request.signal);
  // Launched before the primary is drained so the panel runs concurrently, and
  // `runSecondary` never rejects, so these are always handled.
  const pending = secondaries.map((link) => runSecondary(link, request, signal));

  let finalMessage: AssistantMessage | undefined;
  try {
    for await (const event of primary.client.stream(primaryRequest)) {
      // An aborted turn is the user's decision, not a disagreement; an `error`
      // terminal leaves nothing to compare. Neither arms the verdict.
      if (event.type === "end" && event.message.stopReason !== "aborted") {
        finalMessage = event.message;
      }
      yield event;
    }
  } finally {
    if (finalMessage === undefined) {
      // The primary threw, errored, aborted, or the consumer walked away.
      abort();
      dispose();
    } else {
      // Deliberately not awaited: blocking the generator's completion on the
      // slowest model would give consensus the very latency cost this design
      // avoids. The verdict lands whenever the panel settles.
      const message = finalMessage;
      const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
      void Promise.all(pending)
        .then((outcomes) => {
          onVerdict(buildVerdict(primarySpec.id, message, outcomes, threshold));
        })
        .catch(() => {
          // `runSecondary` cannot reject, so this only catches a throwing
          // `onVerdict`. An observability hook must not surface as an unhandled
          // rejection on a turn that already succeeded.
        })
        .finally(dispose);
    }
  }
}

/**
 * Wrap a panel of clients so every turn is cross-checked against the other
 * members, with disagreement reported as a {@link ConsensusVerdict}.
 *
 * The returned client is a drop-in {@link LLMClient}: `stream()` re-yields the
 * primary's events verbatim and `complete()` resolves to the primary's message.
 * The panel is advisory and out-of-band — read the module documentation for the
 * reasoning behind that, and for the N× cost this incurs.
 *
 * @param links - Panel members, primary first. The primary is the one whose
 *   output the user actually receives, so put your best model there.
 * @param options - {@link ConsensusOptions}. Without `onVerdict` this is a
 *   pass-through to the primary and the secondaries are never called.
 * @throws {TypeError} When `links` is empty.
 *
 * @example
 * ```ts
 * const client = createClient();
 * const panel = createConsensusClient(
 *   [
 *     { client, model: requireModel("anthropic/claude-sonnet-4-5") },
 *     { client, model: requireModel("openai/gpt-4o") },
 *   ],
 *   {
 *     sampleRate: 0.2, // one turn in five; consensus costs 2x on those turns
 *     onVerdict: (v) => {
 *       if (v.agreement === "divergent") log.warn(`models disagree: ${v.details.join("; ")}`);
 *     },
 *   },
 * );
 * ```
 */
export function createConsensusClient(
  links: readonly ConsensusLink[],
  options: ConsensusOptions = {},
): LLMClient {
  if (links.length === 0) {
    throw new TypeError("createConsensusClient requires at least one client");
  }
  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return streamConsensus(links, request, options);
    },
    complete(request: LLMRequest) {
      return completeFromStream(streamConsensus(links, request, options));
    },
  };
}

/**
 * One-line rendering of a verdict, for a status bar or a log line.
 *
 * @example `"divergent: openai/gpt-4o: tool call 0: name differs (read vs write)"`
 */
export function formatVerdict(verdict: ConsensusVerdict): string {
  const summary =
    verdict.details.length === 0
      ? `${verdict.models.length} models agree`
      : verdict.details.join("; ");
  return `${verdict.agreement}: ${summary}`;
}

/** Stop reasons that leave a message worth comparing. Exported for hosts. */
export const COMPARABLE_STOP_REASONS: readonly StopReason[] = ["endTurn", "toolCalls", "maxTokens"];
