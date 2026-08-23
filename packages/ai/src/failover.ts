/**
 * Provider failover: a fallback chain of models.
 *
 * Wraps an ordered list of {@link LLMClient}s (optionally each pinned to its own
 * {@link ModelSpec}). When an attempt fails with a *retryable* error — and only
 * while **no real output has streamed yet** — the next link in the chain is
 * tried transparently, so the caller sees one continuous stream even though a
 * different model produced the answer. Because arcturn keeps the conversation state
 * external to the client, failover can happen mid-conversation: each attempt is
 * just another `stream(request)` call over the same messages.
 *
 * ## The streaming invariant (read this)
 *
 * Failover is **only** attempted before any content event has reached the
 * consumer. Once a single `textDelta` / `thinkingDelta` / tool-call event has
 * been yielded, the turn is *committed* to the current model: switching then
 * would splice two half-answers together and corrupt the message. So the moment
 * real output appears, a later error is surfaced to the caller unchanged rather
 * than triggering a fallback — exactly the guarantee {@link streamWithRetry}
 * makes for retries, extended across models.
 *
 * Structural events (`start`, `usage`, `blockEnd`) do **not** count as output.
 * The leading `start` is held back until an attempt commits, and any `usage`
 * seen before commit is buffered, so a failed-over turn leaves nothing behind:
 * exactly one `start` is emitted, carrying the id of the model that actually
 * answers, and pre-commit usage is never misattributed to a different model.
 *
 * @see streamWithRetry — the same "no failover after output" rule, per model.
 */

import type { AIError, LLMClient, LLMRequest, ModelSpec, StreamEvent } from "@arcturn/types";
import { toAIError } from "./errors.js";
import { completeFromStream, MessageAssembler } from "./internal/stream.js";

/**
 * One link in a failover chain.
 *
 * Either a bare {@link LLMClient} — which streams `request.model` unchanged — or
 * a `{ client, model }` pair that overrides the request's model for that
 * attempt. The pair form is what makes this a chain of *models*: a single
 * underlying {@link createClient} instance can serve the whole chain while each
 * link swaps in a different {@link ModelSpec}. Model selection is per-request
 * (the spec rides on `LLMRequest.model`), so overriding `request.model` per
 * attempt is the natural, dispatch-compatible way to fail over across models.
 */
export type FailoverLink = LLMClient | { client: LLMClient; model?: ModelSpec };

/** Tuning knobs for {@link createFailoverClient}. */
export interface FailoverOptions {
  /**
   * Decide whether an error is worth failing over from. Defaults to
   * {@link defaultShouldFailover} (retryable transient errors only). A user
   * abort is *never* failed over regardless of what this returns.
   */
  shouldFailover?: (error: AIError) => boolean;
  /**
   * Observability hook fired just before switching links, after the failing
   * attempt produced no output.
   *
   * @param from - 0-based index of the link that just failed.
   * @param to - 0-based index of the link about to be tried (`from + 1`).
   * @param error - The classified error that triggered the switch.
   */
  onFailover?: (from: number, to: number, error: AIError) => void;
}

/**
 * Default failover policy: fail over on transient, retryable failures only.
 *
 * `true` for `rateLimit`, `overloaded`, and `network`; `false` for `auth`,
 * `invalidRequest`, `aborted`, and `unknown` — a bad request or bad credentials
 * would fail identically on every link, and an abort is the user's intent, so
 * none of them should burn through the chain.
 */
export function defaultShouldFailover(error: AIError): boolean {
  switch (error.kind) {
    case "rateLimit":
    case "overloaded":
    case "network":
      return true;
    default:
      return false;
  }
}

/** True for events that represent real streamed output (never `usage`/`start`). */
function isContentEvent(event: StreamEvent): boolean {
  switch (event.type) {
    case "textStart":
    case "textDelta":
    case "thinkingStart":
    case "thinkingDelta":
    case "toolCallStart":
    case "toolCallDelta":
    case "toolCallEnd":
      return true;
    default:
      return false;
  }
}

/** Normalise a {@link FailoverLink} into an explicit `{ client, model? }`. */
function normalizeLink(link: FailoverLink): { client: LLMClient; model?: ModelSpec } {
  return typeof (link as LLMClient).stream === "function"
    ? { client: link as LLMClient }
    : (link as { client: LLMClient; model?: ModelSpec });
}

/**
 * Stream a request across a failover chain.
 *
 * Attempts each link in order. An attempt that errors *before any content*
 * hands off to the next link (when the error is failover-eligible and a link
 * remains); once content has streamed, or the chain is exhausted, the error is
 * surfaced as the terminal event. Exactly one `start` and one terminal
 * (`end`/`error`) event are emitted across all attempts.
 */
export async function* streamFailover(
  links: readonly FailoverLink[],
  request: LLMRequest,
  options: FailoverOptions = {},
): AsyncIterable<StreamEvent> {
  const shouldFailover = options.shouldFailover ?? defaultShouldFailover;
  const onFailover = options.onFailover;
  // Guarantees exactly one `start` across the whole chain: an attempt that
  // fails over never emits its `start`, so this only flips on the committing
  // (answering or error-surfacing) attempt.
  let startEmitted = false;

  for (let index = 0; index < links.length; index++) {
    const { client, model } = normalizeLink(links[index] as FailoverLink);
    const spec = model ?? request.model;
    const attemptRequest = model ? { ...request, model } : request;

    let produced = false;
    let pendingStart: Extract<StreamEvent, { type: "start" }> | undefined;
    const pendingUsage: Extract<StreamEvent, { type: "usage" }>[] = [];
    let failoverError: AIError | undefined;

    const canFailoverOn = (error: AIError): boolean =>
      !produced &&
      request.signal?.aborted !== true &&
      error.kind !== "aborted" &&
      index < links.length - 1 &&
      shouldFailover(error);

    try {
      loop: for await (const event of client.stream(attemptRequest)) {
        switch (event.type) {
          case "start":
            // Hold the start until this attempt commits; a failed-over attempt
            // must not leak a `start` for a model that never answers.
            if (!startEmitted) pendingStart = event;
            continue loop;
          case "usage":
            // Not real output — buffer until commit so a failed-over turn's
            // token counts are not attributed to the next model.
            if (startEmitted) yield event;
            else pendingUsage.push(event);
            continue loop;
          case "error": {
            if (canFailoverOn(event.error)) {
              failoverError = event.error;
              break loop;
            }
            // Committed: emit the held start (with buffered usage), then surface.
            if (!startEmitted) {
              startEmitted = true;
              yield pendingStart ?? { type: "start", model: spec.id };
              for (const usage of pendingUsage) yield usage;
            }
            yield event;
            return;
          }
          default: {
            // `blockEnd` is structural (see this module's invariant): emitting
            // the held `start` for it would commit the attempt to a model
            // while leaving it failover-eligible, so a later switch would
            // stream model B's turn under a `start` naming model A.
            const commits = event.type === "end" || isContentEvent(event);
            if (commits && !startEmitted) {
              startEmitted = true;
              yield pendingStart ?? { type: "start", model: spec.id };
              for (const usage of pendingUsage) yield usage;
            }
            if (event.type === "end") {
              yield event;
              return;
            }
            if (isContentEvent(event)) produced = true;
            yield event;
          }
        }
      }
    } catch (err) {
      // A conformant client surfaces failures as an `error` event and never
      // throws (see the LLMClient contract). This branch is defensive: it keeps
      // failover working even against a misbehaving client that throws.
      const error = toAIError(err, request.signal);
      if (canFailoverOn(error)) {
        failoverError = error;
      } else {
        if (!startEmitted) {
          startEmitted = true;
          yield pendingStart ?? { type: "start", model: spec.id };
          for (const usage of pendingUsage) yield usage;
        }
        yield {
          type: "error",
          error,
          message: new MessageAssembler(spec).finalize("error", error.message),
        };
        return;
      }
    }

    if (failoverError !== undefined) {
      onFailover?.(index, index + 1, failoverError);
      continue;
    }
    // The stream ended without a terminal event (a misbehaving client). Nothing
    // committed and no link remains to try, so stop rather than hang.
    return;
  }
}

/**
 * Wrap an ordered chain of clients (or `{ client, model }` links) so every
 * `stream`/`complete` call transparently fails over on retryable errors.
 *
 * The chain is tried front to back. Failover happens only before any content
 * streams (see the module invariant); after output begins, or once the chain is
 * exhausted, the **last** error encountered is surfaced to the caller.
 *
 * @param links - Fallback order, primary first. Bare clients stream
 *   `request.model`; `{ client, model }` links override it per attempt.
 * @param options - {@link FailoverOptions}.
 * @throws {TypeError} When `links` is empty.
 *
 * @example
 * ```ts
 * const client = createClient();
 * const failover = createFailoverClient(
 *   [
 *     { client, model: requireModel("anthropic/claude-sonnet-4-5") },
 *     { client, model: requireModel("openai/gpt-4o") },
 *   ],
 *   { onFailover: (from, to, err) => log.warn(`failing over: ${err.kind}`) },
 * );
 * ```
 */
export function createFailoverClient(
  links: readonly FailoverLink[],
  options: FailoverOptions = {},
): LLMClient {
  if (links.length === 0) {
    throw new TypeError("createFailoverClient requires at least one client");
  }
  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return streamFailover(links, request, options);
    },
    complete(request: LLMRequest) {
      return completeFromStream(streamFailover(links, request, options));
    },
  };
}
