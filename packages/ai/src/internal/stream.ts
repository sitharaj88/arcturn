/**
 * Provider-agnostic stream assembly.
 *
 * Provider adapters emit {@link ProviderStreamEvent}s; this module turns them
 * into the public `StreamEvent` sequence and guarantees the contract from
 * `@arcturn/types`: a single leading `start` and exactly one terminal `end`
 * or `error`, never a thrown exception.
 */

import type {
  AIError,
  AssistantContent,
  AssistantMessage,
  ModelSpec,
  StopReason,
  StreamEvent,
  Usage,
} from "@arcturn/types";
import { calculateCostUsd, emptyUsage } from "../cost.js";
import { toAIError } from "../errors.js";

/** Public stream events a provider adapter is allowed to emit directly. */
export type EmittedStreamEvent = Exclude<
  StreamEvent,
  { type: "start" } | { type: "end" } | { type: "error" }
>;

/**
 * Events exchanged between a provider adapter and {@link assembleStream}.
 *
 * Two internal variants exist because the frozen `StreamEvent` union has no
 * way to carry a thinking signature or a stop reason (see NOTES.md).
 */
export type ProviderStreamEvent =
  | EmittedStreamEvent
  /** Round-trips the opaque reasoning signature; never surfaced to consumers. */
  | { type: "thinkingSignature"; blockIndex: number; signature: string; replace?: boolean }
  /** Declares how the turn ended; folded into the terminal message. */
  | { type: "stop"; stopReason: StopReason; errorMessage?: string };

interface TextSlot {
  kind: "text";
  text: string;
}
interface ThinkingSlot {
  kind: "thinking";
  thinking: string;
  signature: string;
}
interface ToolSlot {
  kind: "toolCall";
  id: string;
  name: string;
  raw: string;
  args?: Record<string, unknown>;
  /** Provider signature over the call, carried verbatim — see {@link ToolCallContent.signature}. */
  signature?: string;
}
type Slot = TextSlot | ThinkingSlot | ToolSlot;

/**
 * Accumulates stream events into an `AssistantMessage`.
 *
 * Blocks are tracked by the provider-assigned `blockIndex` but rendered in
 * first-seen order, so adapters may use any monotonic index scheme.
 */
export class MessageAssembler {
  private readonly slots = new Map<number, Slot>();
  private readonly order: number[] = [];
  private usage: Usage = emptyUsage();
  private stopReason: StopReason = "endTurn";
  private errorMessage: string | undefined;

  constructor(private readonly spec: ModelSpec) {}

  /** True once any content block has been opened. */
  get hasContent(): boolean {
    return this.order.length > 0;
  }

  private slot(index: number): Slot | undefined {
    return this.slots.get(index);
  }

  private put(index: number, slot: Slot): void {
    if (!this.slots.has(index)) this.order.push(index);
    this.slots.set(index, slot);
  }

  /** Apply one adapter event to the in-progress message. */
  apply(event: ProviderStreamEvent): void {
    switch (event.type) {
      case "textStart":
        this.put(event.blockIndex, { kind: "text", text: "" });
        break;
      case "textDelta": {
        const slot = this.slot(event.blockIndex);
        if (slot?.kind === "text") slot.text += event.delta;
        else this.put(event.blockIndex, { kind: "text", text: event.delta });
        break;
      }
      case "thinkingStart":
        this.put(event.blockIndex, { kind: "thinking", thinking: "", signature: "" });
        break;
      case "thinkingDelta": {
        const slot = this.slot(event.blockIndex);
        if (slot?.kind === "thinking") slot.thinking += event.delta;
        else this.put(event.blockIndex, { kind: "thinking", thinking: event.delta, signature: "" });
        break;
      }
      case "thinkingSignature": {
        const slot = this.slot(event.blockIndex);
        if (event.signature === "") break;
        // Signature deltas may arrive chunked, so they append by default.
        // `ToolCallContent` has no signature field, so signatures attached to
        // function-call parts (Google) are dropped — see NOTES.md.
        if (slot?.kind === "thinking") {
          slot.signature = event.replace ? event.signature : slot.signature + event.signature;
        }
        break;
      }
      case "toolCallStart":
        this.put(event.blockIndex, {
          kind: "toolCall",
          id: event.id,
          name: event.name,
          raw: "",
        });
        break;
      case "toolCallDelta": {
        const slot = this.slot(event.blockIndex);
        if (slot?.kind === "toolCall") slot.raw += event.argumentsDelta;
        break;
      }
      case "toolCallEnd": {
        const slot = this.slot(event.blockIndex);
        if (slot?.kind === "toolCall") {
          slot.id = event.id;
          slot.name = event.name;
          slot.args = event.arguments;
          slot.signature = event.signature;
        } else {
          this.put(event.blockIndex, {
            kind: "toolCall",
            id: event.id,
            name: event.name,
            raw: "",
            args: event.arguments,
            ...(event.signature === undefined ? {} : { signature: event.signature }),
          });
        }
        break;
      }
      case "usage":
        this.setUsage(event.usage);
        break;
      case "blockEnd":
        break;
      case "stop":
        this.stopReason = event.stopReason;
        this.errorMessage = event.errorMessage;
        break;
    }
  }

  /** Replace the running usage totals (providers report cumulative values). */
  setUsage(usage: Usage): void {
    this.usage = { ...usage };
  }

  /** Usage with the cost estimate applied, ready for a `usage` event. */
  pricedUsage(): Usage {
    const cost = calculateCostUsd(this.spec, this.usage);
    return cost === undefined ? { ...this.usage } : { ...this.usage, costUsd: cost };
  }

  /** Materialise the content blocks recorded so far. */
  content(): AssistantContent[] {
    const out: AssistantContent[] = [];
    for (const index of this.order) {
      const slot = this.slots.get(index);
      if (!slot) continue;
      if (slot.kind === "text") {
        if (slot.text.length > 0) out.push({ type: "text", text: slot.text });
      } else if (slot.kind === "thinking") {
        if (slot.thinking.length === 0 && slot.signature.length === 0) continue;
        out.push(
          slot.signature.length > 0
            ? { type: "thinking", thinking: slot.thinking, signature: slot.signature }
            : { type: "thinking", thinking: slot.thinking },
        );
      } else {
        out.push({
          type: "toolCall",
          id: slot.id,
          name: slot.name,
          arguments: slot.args ?? {},
          ...(slot.signature === undefined ? {} : { signature: slot.signature }),
        });
      }
    }
    return out;
  }

  /**
   * Build the terminal `AssistantMessage`.
   *
   * @param override - Forces a stop reason (used for abort and error paths).
   * @param errorMessage - Human-readable failure detail.
   */
  finalize(override?: StopReason, errorMessage?: string): AssistantMessage {
    const content = this.content();
    let stopReason = override ?? this.stopReason;
    // No provider reliably reports "tool calls" alongside a natural stop.
    if (stopReason === "endTurn" && content.some((block) => block.type === "toolCall")) {
      stopReason = "toolCalls";
    }
    const message: AssistantMessage = {
      role: "assistant",
      content,
      model: this.spec.id,
      usage: this.pricedUsage(),
      stopReason,
      timestamp: Date.now(),
    };
    const detail = errorMessage ?? this.errorMessage;
    if (detail !== undefined && stopReason === "error") message.errorMessage = detail;
    return message;
  }
}

/**
 * Wrap a provider adapter generator so it satisfies the public streaming
 * contract.
 *
 * Emits `start` first, forwards adapter events, and always finishes with a
 * single `end` (including for aborts, whose stop reason is `"aborted"`) or a
 * single `error` carrying the partial message.
 *
 * @param spec - The model being invoked; used for ids and cost estimation.
 * @param signal - The caller's abort signal, if any.
 * @param source - Factory producing the adapter's event stream.
 */
export async function* assembleStream(
  spec: ModelSpec,
  signal: AbortSignal | undefined,
  source: () => AsyncIterable<ProviderStreamEvent>,
): AsyncIterable<StreamEvent> {
  const assembler = new MessageAssembler(spec);
  yield { type: "start", model: spec.id };

  if (signal?.aborted) {
    yield { type: "end", message: assembler.finalize("aborted") };
    return;
  }

  try {
    for await (const event of source()) {
      assembler.apply(event);
      if (event.type === "stop" || event.type === "thinkingSignature") continue;
      if (event.type === "usage") {
        yield { type: "usage", usage: assembler.pricedUsage() };
        continue;
      }
      yield event;
    }
    yield { type: "end", message: assembler.finalize() };
  } catch (err) {
    const error: AIError = toAIError(err, signal);
    if (error.kind === "aborted") {
      yield { type: "end", message: assembler.finalize("aborted") };
      return;
    }
    yield { type: "error", error, message: assembler.finalize("error", error.message) };
  }
}

/** Drain a stream and return the terminal assistant message. */
export async function completeFromStream(
  stream: AsyncIterable<StreamEvent>,
): Promise<AssistantMessage> {
  let last: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "end" || event.type === "error") last = event.message;
  }
  if (!last) {
    throw new Error("Stream ended without a terminal event");
  }
  return last;
}

/**
 * Defers building a provider event stream until iteration begins.
 *
 * Lets an adapter whose SDK is imported lazily keep a synchronous `stream()`
 * body: the returned iterable awaits the factory (and therefore the SDK
 * import) only when the caller starts consuming events.
 *
 * @param make - Builds the underlying event stream, typically after awaiting
 *   a dynamically imported SDK client.
 */
export async function* deferredEvents<T>(make: () => Promise<AsyncIterable<T>>): AsyncIterable<T> {
  yield* await make();
}
