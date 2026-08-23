/**
 * VCR mode — deterministic record / replay of a whole agent session.
 *
 * A *cassette* is one JSONL file holding every side of a session that arcturn does
 * not control: the {@link StreamEvent} list of each LLM turn, and the
 * {@link ToolResult} of each tool call. Recording is a transparent wrapper
 * ({@link recordingClient}, {@link wrapToolsWithRecorder}) that passes calls
 * through to the real provider and real tools while teeing the outcome to disk.
 * Replay ({@link replayingClient}, {@link replayTools}) serves those outcomes
 * back **without ever touching the network or the filesystem** — the underlying
 * tool's `execute` is never invoked at all, so replaying a session that ran
 * `bash rm -rf` deletes nothing.
 *
 * That is what turns a real session into a permanent regression test, and it is
 * the substrate `arcturn bisect` and counterfactual debugging stand on: re-running
 * the same cassette with a patched agent isolates *your* change, because every
 * non-deterministic input is pinned.
 *
 * ## Keys
 *
 * Nothing is matched positionally — a recorded interaction is looked up by a
 * content hash of what caused it, so inserting a turn earlier in a run does not
 * silently shift every later response by one. See {@link requestKey} and
 * {@link toolKey} for exactly which fields participate and why the rest are
 * excluded.
 *
 * ## Repeats
 *
 * The same key legitimately recurs: an agent that reads the same file twice
 * produces the identical {@link toolKey} both times, and the two calls may have
 * different results (the file changed in between). Every entry therefore
 * carries a `seq` that counts occurrences *of that key*: the first recording
 * gets `seq: 0`, the second `seq: 1`, and replay consumes them in that order.
 * A third call with the same key, when only two were recorded, is a miss.
 *
 * ## Determinism rules honoured here
 *
 * - No `Date.now()`, `Math.random()`, environment or path data ever enters key
 *   derivation. A key is a pure function of the request / tool input.
 * - Canonical JSON sorts object keys recursively, so a differently-ordered but
 *   equal input object hashes to the same key.
 * - Volatile message fields (wall-clock timestamps, token accounting) are
 *   stripped before hashing — see {@link requestKey}.
 * - Replay yields the recorded events verbatim, so a replayed run reproduces
 *   the recording's transcript exactly.
 *
 * @example
 * ```ts
 * // record
 * const recorder = createCassetteRecorder(".arcturn/cassettes/run.jsonl");
 * const llm = recordingClient(realClient, recorder);
 * const tools = wrapToolsWithRecorder(baseTools, recorder);
 * // ... run the agent ...
 * await recorder.close();
 *
 * // replay — no provider, no network, no filesystem effects
 * const cassette = await loadCassette(".arcturn/cassettes/run.jsonl");
 * const llm = replayingClient(cassette);
 * const tools = replayTools(baseTools, cassette);
 * ```
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  Message,
  StreamEvent,
  Tool,
  ToolResult,
} from "@arcturn/types";

/** Schema version stamped on every cassette line. */
export const CASSETTE_VERSION = 1;

/** One recorded LLM turn: the complete event list for a single `stream()` call. */
export interface LlmCassetteEntry {
  /** Discriminant. */
  kind: "llm";
  /** Cassette schema version. */
  v: number;
  /** {@link requestKey} of the request that produced these events. */
  key: string;
  /** 0-based occurrence index of this key; see the module docs on repeats. */
  seq: number;
  /** Every event the provider streamed, in order, terminal event included. */
  events: StreamEvent[];
}

/** One recorded tool call: the result the real tool produced. */
export interface ToolCassetteEntry {
  /** Discriminant. */
  kind: "tool";
  /** Cassette schema version. */
  v: number;
  /** {@link toolKey} of the call that produced this result. */
  key: string;
  /** 0-based occurrence index of this key; see the module docs on repeats. */
  seq: number;
  /** Tool name, recorded for human readability and better miss messages. */
  name: string;
  /** The result the real tool returned. */
  result: ToolResult;
}

/** Any line of a cassette file. */
export type CassetteEntry = LlmCassetteEntry | ToolCassetteEntry;

/** Machine-readable failure kinds raised by this module. */
export type CassetteErrorCode = "miss" | "corrupt" | "closed";

/** Error thrown for a cassette miss, a corrupt cassette, or use after close. */
export class CassetteError extends Error {
  /** Machine-readable failure kind. */
  readonly code: CassetteErrorCode;
  /** The key that missed, for `code: "miss"`. */
  readonly key: string | undefined;
  /** Which side missed, for `code: "miss"`. */
  readonly entryKind: "llm" | "tool" | undefined;

  constructor(
    message: string,
    code: CassetteErrorCode,
    details: { key?: string; entryKind?: "llm" | "tool" } = {},
  ) {
    super(message);
    this.name = "CassetteError";
    this.code = code;
    this.key = details.key;
    this.entryKind = details.entryKind;
  }
}

/* -------------------------------------------------------------------------- */
/* Canonical JSON + keys                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Serialize a value to JSON with **object keys sorted recursively**.
 *
 * `JSON.stringify` preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}`
 * would hash differently even though they are the same tool input. Sorting
 * removes that whole class of false cache misses. Arrays keep their order
 * (order is meaning there), `undefined` object properties are dropped exactly
 * as `JSON.stringify` drops them, and `undefined` inside an array becomes
 * `null` — again matching `JSON.stringify`, so the encoding never surprises.
 *
 * @param value - Any JSON-serializable value.
 * @returns A stable string: equal values always produce identical output.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    // Mirror JSON.stringify: an undefined property is absent, not null.
    if (entry === undefined) continue;
    out[key] = canonicalize(entry);
  }
  return out;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Strip the fields of a stored {@link Message} that vary between two runs of
 * the *same* conversation.
 *
 * Removed:
 * - `timestamp` (every role) — wall-clock, different on every run by definition.
 * - `usage` (assistant) — provider token accounting and a `costUsd` derived
 *   from a pricing table that can be updated independently of any behaviour.
 *
 * Everything else is kept, including the assistant's `model`, its `stopReason`,
 * thinking `signature` blobs and tool-result `details`: those are all part of
 * what the next request actually says, and all of them round-trip byte-exactly
 * through a cassette because replay rebuilds history from the recorded events.
 */
function normalizeMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "assistant": {
      const { timestamp: _timestamp, usage: _usage, ...rest } = message;
      return rest;
    }
    default: {
      const { timestamp: _timestamp, ...rest } = message;
      return rest;
    }
  }
}

/**
 * Derive the stable cassette key for an LLM request.
 *
 * **Included** — the three things that determine what a model says next:
 * the model id (`request.model.id`), the system prompt, and the normalized
 * message list (see the normalization notes above).
 *
 * **Excluded, deliberately:**
 * - `tools` — tool *definitions* are rebuilt from config on every start, so a
 *   reworded description or a reordered list would invalidate an entire
 *   cassette while changing nothing about the conversation. A genuinely
 *   different tool set shows up as different assistant output, which changes
 *   the message list, which changes every later key anyway.
 * - `maxOutputTokens`, `temperature`, `thinking` — sampling knobs. A cassette
 *   is a recording of one concrete outcome; re-deriving keys from the knobs
 *   would make an unrelated config tweak throw the recording away.
 * - `signal` — an `AbortSignal` is not data, and is not serializable.
 * - `providerOptions` — a provider-specific escape hatch (routing, beta
 *   headers) that does not describe the conversation.
 *
 * Nothing volatile participates: no clock, no randomness, no cwd, no env.
 *
 * @param request - The request about to be sent (or that was sent).
 * @returns A hex sha256, domain-separated from {@link toolKey}.
 */
export function requestKey(request: LLMRequest): string {
  return sha256(
    canonicalJson({
      kind: "llm",
      v: CASSETTE_VERSION,
      model: request.model.id,
      // `null` rather than omitted so "no system prompt" and an empty one
      // remain distinguishable.
      system: request.system ?? null,
      messages: request.messages.map((message) => normalizeMessage(message)),
    }),
  );
}

/**
 * Derive the stable cassette key for a tool call.
 *
 * Hashes the tool name together with the canonical JSON of its input, so a
 * caller that emits `{path, limit}` and one that emits `{limit, path}` hit the
 * same recording. Nothing else participates — not cwd, not the session id, not
 * the tool-call id (which is provider-assigned and different on every run).
 *
 * @param name - Tool name as it appears in `tool.definition.name`.
 * @param input - The raw input object the model produced.
 * @returns A hex sha256, domain-separated from {@link requestKey}.
 */
export function toolKey(name: string, input: Record<string, unknown>): string {
  return sha256(canonicalJson({ kind: "tool", v: CASSETTE_VERSION, name, input }));
}

/* -------------------------------------------------------------------------- */
/* Recorder                                                                    */
/* -------------------------------------------------------------------------- */

/** Appends interactions to a cassette file. */
export interface CassetteRecorder {
  /** Path of the cassette being written. */
  readonly file: string;
  /**
   * Append one recorded LLM turn.
   *
   * @param key - {@link requestKey} of the originating request.
   * @param events - Every event streamed for that request, in order.
   * @returns Resolves once the line is on disk.
   */
  recordLlm(key: string, events: readonly StreamEvent[]): Promise<void>;
  /**
   * Append one recorded tool result.
   *
   * @param key - {@link toolKey} of the originating call.
   * @param result - The result the real tool returned.
   * @param name - Tool name, stored for readable miss messages.
   */
  recordTool(key: string, result: ToolResult, name?: string): Promise<void>;
  /** Flush every queued append and refuse further writes. Idempotent. */
  close(): Promise<void>;
}

/**
 * Open a cassette for writing.
 *
 * Appends are serialized through **one promise chain**, exactly like
 * {@link JsonlSessionStore.append}: two concurrent `recordTool` calls can never
 * interleave their bytes, and each line reaches the file in a single
 * `appendFile` call. The parent directory is created on first write.
 *
 * `seq` numbers are assigned synchronously at call time, so the value on a line
 * reflects the order the interactions *happened* even if their writes are still
 * in flight.
 *
 * @param file - Path of the `.jsonl` cassette to append to. Created on demand;
 *   an existing file is appended to, never truncated.
 */
export function createCassetteRecorder(file: string): CassetteRecorder {
  const seqs = new Map<string, number>();
  let queue: Promise<void> = Promise.resolve();
  let dirReady: Promise<void> | undefined;
  let closed = false;

  const nextSeq = (kind: "llm" | "tool", key: string): number => {
    const mapKey = `${kind}:${key}`;
    const seq = seqs.get(mapKey) ?? 0;
    seqs.set(mapKey, seq + 1);
    return seq;
  };

  const append = (entry: CassetteEntry): Promise<void> => {
    if (closed) {
      return Promise.reject(
        new CassetteError(`Cassette ${file} is closed; cannot record more interactions`, "closed"),
      );
    }
    const line = `${JSON.stringify(entry)}\n`;
    const next = queue
      // A failed write must not wedge every later append; the failure is
      // surfaced to its own caller through the promise returned below.
      .catch(() => undefined)
      .then(async () => {
        dirReady ??= mkdir(dirname(file), { recursive: true }).then(() => undefined);
        await dirReady;
        await appendFile(file, line, "utf8");
      });
    queue = next;
    return next;
  };

  return {
    file,
    recordLlm(key, events) {
      return append({
        kind: "llm",
        v: CASSETTE_VERSION,
        key,
        seq: nextSeq("llm", key),
        events: [...events],
      });
    },
    recordTool(key, result, name = "") {
      return append({
        kind: "tool",
        v: CASSETTE_VERSION,
        key,
        seq: nextSeq("tool", key),
        name,
        result,
      });
    },
    async close() {
      closed = true;
      await queue.catch(() => undefined);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Cassette (read side)                                                        */
/* -------------------------------------------------------------------------- */

/** A single unconsumed entry, as reported by {@link CassetteStats.unused}. */
export interface UnusedCassetteEntry {
  /** Which side the entry belongs to. */
  kind: "llm" | "tool";
  /** The entry's key. */
  key: string;
  /** The entry's occurrence index. */
  seq: number;
  /** Tool name, for `kind: "tool"` entries. */
  name?: string;
}

/** Coverage report for a loaded cassette. */
export interface CassetteStats {
  /** Recorded LLM turns. */
  llmTotal: number;
  /** Recorded tool calls. */
  toolTotal: number;
  /** LLM turns served so far. */
  llmConsumed: number;
  /** Tool calls served so far. */
  toolConsumed: number;
  /** Lookups that found nothing, across both sides. */
  misses: number;
  /**
   * Entries never served. A non-empty list after a replay means the run
   * diverged from the recording — the prime signal for `arcturn bisect`.
   */
  unused: UnusedCassetteEntry[];
  /** Trailing torn line dropped while loading (0 or 1). */
  skippedLines: number;
}

/** A loaded cassette, consumed as replay proceeds. */
export interface Cassette {
  /** Path the cassette was loaded from. */
  readonly file: string;
  /**
   * Take the next recorded event list for `key`, in `seq` order.
   *
   * @param key - A {@link requestKey}.
   * @returns The recorded events, or `undefined` when nothing (more) is
   *   recorded for that key.
   */
  takeLlm(key: string): StreamEvent[] | undefined;
  /**
   * Take the next recorded result for `key`, in `seq` order.
   *
   * @param key - A {@link toolKey}.
   * @returns The recorded result, or `undefined` on a miss.
   */
  takeTool(key: string): ToolResult | undefined;
  /** Snapshot of consumption so far; safe to call at any time. */
  stats(): CassetteStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one parsed line into a {@link CassetteEntry}, or `undefined`. */
function toEntry(raw: unknown): CassetteEntry | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.key !== "string" || typeof raw.seq !== "number") return undefined;
  const v = typeof raw.v === "number" ? raw.v : CASSETTE_VERSION;
  if (raw.kind === "llm") {
    if (!Array.isArray(raw.events)) return undefined;
    return { kind: "llm", v, key: raw.key, seq: raw.seq, events: raw.events as StreamEvent[] };
  }
  if (raw.kind === "tool") {
    if (!isRecord(raw.result) || !Array.isArray(raw.result.content)) return undefined;
    return {
      kind: "tool",
      v,
      key: raw.key,
      seq: raw.seq,
      name: typeof raw.name === "string" ? raw.name : "",
      result: raw.result as unknown as ToolResult,
    };
  }
  return undefined;
}

function tryParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Read a cassette file into memory.
 *
 * A crash mid-append leaves a partial final line; that line is dropped, exactly
 * as {@link JsonlSessionStore.entries} does, so a killed recording still yields
 * a usable cassette. A malformed line *anywhere else* is a
 * {@link CassetteError} with `code: "corrupt"` — it means something other than
 * a torn write went wrong, and silently skipping it would let replay serve the
 * wrong response to a later call.
 *
 * @param file - Path written by {@link createCassetteRecorder}.
 * @throws CassetteError `corrupt` on a malformed non-final line; the underlying
 *   `ENOENT` propagates when the file does not exist.
 */
export async function loadCassette(file: string): Promise<Cassette> {
  const raw = await readFile(file, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  const llm = new Map<string, LlmCassetteEntry[]>();
  const tool = new Map<string, ToolCassetteEntry[]>();
  let llmTotal = 0;
  let toolTotal = 0;
  let skippedLines = 0;

  for (const [index, line] of lines.entries()) {
    const entry = toEntry(tryParseJson(line));
    if (entry === undefined) {
      if (index === lines.length - 1) {
        skippedLines++;
        continue;
      }
      throw new CassetteError(
        `Cassette ${file} has an unreadable entry on line ${index + 1}`,
        "corrupt",
      );
    }
    if (entry.kind === "llm") {
      const list = llm.get(entry.key);
      if (list) list.push(entry);
      else llm.set(entry.key, [entry]);
      llmTotal++;
    } else {
      const list = tool.get(entry.key);
      if (list) list.push(entry);
      else tool.set(entry.key, [entry]);
      toolTotal++;
    }
  }

  // Sorting makes consumption order depend on `seq` alone, never on the order
  // the lines happened to land in the file.
  for (const list of llm.values()) list.sort((a, b) => a.seq - b.seq);
  for (const list of tool.values()) list.sort((a, b) => a.seq - b.seq);

  const consumed = { llm: new Map<string, number>(), tool: new Map<string, number>() };
  let llmConsumed = 0;
  let toolConsumed = 0;
  let misses = 0;

  const take = <T extends CassetteEntry>(
    store: Map<string, T[]>,
    counters: Map<string, number>,
    key: string,
  ): T | undefined => {
    const list = store.get(key);
    const used = counters.get(key) ?? 0;
    const entry = list?.[used];
    if (entry === undefined) {
      misses++;
      return undefined;
    }
    counters.set(key, used + 1);
    return entry;
  };

  return {
    file,
    takeLlm(key) {
      const entry = take(llm, consumed.llm, key);
      if (entry === undefined) return undefined;
      llmConsumed++;
      return entry.events;
    },
    takeTool(key) {
      const entry = take(tool, consumed.tool, key);
      if (entry === undefined) return undefined;
      toolConsumed++;
      return entry.result;
    },
    stats() {
      const unused: UnusedCassetteEntry[] = [];
      for (const [key, list] of llm) {
        for (const entry of list.slice(consumed.llm.get(key) ?? 0)) {
          unused.push({ kind: "llm", key, seq: entry.seq });
        }
      }
      for (const [key, list] of tool) {
        for (const entry of list.slice(consumed.tool.get(key) ?? 0)) {
          unused.push({ kind: "tool", key, seq: entry.seq, name: entry.name });
        }
      }
      return { llmTotal, toolTotal, llmConsumed, toolConsumed, misses, unused, skippedLines };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* LLM clients                                                                 */
/* -------------------------------------------------------------------------- */

/** Pull the final assistant message out of a stream's terminal event. */
async function completeFromEvents(stream: AsyncIterable<StreamEvent>): Promise<AssistantMessage> {
  for await (const event of stream) {
    if (event.type === "end" || event.type === "error") return event.message;
  }
  throw new CassetteError("Stream ended without a terminal event", "corrupt");
}

/**
 * Wrap a client so every `stream()` call is passed through to `inner` and its
 * complete event list is appended to the cassette.
 *
 * Events are forwarded to the caller as they arrive — recording adds no
 * buffering latency — and the line is written only after the source iterator
 * finishes *normally*. A consumer that breaks out early, or a stream that
 * throws, records nothing: half a turn on the cassette would replay as a
 * truncated response, which is worse than a miss.
 *
 * `complete()` runs through the same recorded `stream()`, so a non-streaming
 * call is captured just like a streaming one.
 *
 * @param inner - The real client (or a failover chain).
 * @param recorder - Where to append; see {@link createCassetteRecorder}.
 */
export function recordingClient(inner: LLMClient, recorder: CassetteRecorder): LLMClient {
  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const key = requestKey(request);
    const events: StreamEvent[] = [];
    for await (const event of inner.stream(request)) {
      events.push(event);
      yield event;
    }
    // Only reached when the source iterator ran to completion: an early
    // `break` in the consumer, or a throw, skips this and records nothing.
    await recorder.recordLlm(key, events);
  }

  return {
    stream,
    complete(request) {
      return completeFromEvents(stream(request));
    },
  };
}

/** Behaviour when a replayed request has no recording. */
export type CassetteMissMode = "throw" | "error-event";

/** Options for {@link replayingClient}. */
export interface ReplayingClientOptions {
  /**
   * What a miss does. `"throw"` (default) raises a {@link CassetteError}
   * naming the key — the right default for a regression test, which should
   * fail loudly. `"error-event"` instead yields a terminal `error` event so the
   * agent loop finishes and you can inspect how far the run got before it
   * diverged.
   */
  onMiss?: CassetteMissMode;
}

/**
 * Build an {@link LLMClient} that answers **only** from a cassette.
 *
 * It holds no provider, opens no socket and reads no credentials: a request is
 * hashed with {@link requestKey} and the recorded events are re-yielded
 * verbatim, so the replayed transcript is identical to the recorded one. Order
 * does not matter — matching is by content hash, with repeats consumed in `seq`
 * order.
 *
 * @param cassette - A cassette from {@link loadCassette}.
 * @param options - Miss handling; see {@link ReplayingClientOptions}.
 * @throws CassetteError `miss` (with `onMiss: "throw"`) naming the missing key.
 */
export function replayingClient(
  cassette: Cassette,
  options: ReplayingClientOptions = {},
): LLMClient {
  const onMiss = options.onMiss ?? "throw";

  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const key = requestKey(request);
    const events = cassette.takeLlm(key);
    if (events === undefined) {
      const message =
        `No recorded LLM response in ${cassette.file} for request key ${key} ` +
        `(model ${request.model.id}, ${request.messages.length} message(s)). ` +
        `The run diverged from the recording.`;
      if (onMiss === "throw") {
        throw new CassetteError(message, "miss", { key, entryKind: "llm" });
      }
      yield {
        type: "error",
        error: { kind: "unknown", message },
        message: missMessage(request, message),
      };
      return;
    }
    for (const event of events) yield event;
  }

  return {
    stream,
    complete(request) {
      return completeFromEvents(stream(request));
    },
  };
}

/**
 * The empty assistant message attached to a miss `error` event.
 *
 * `timestamp` is `0`, not `Date.now()`: a replayed run must be reproducible
 * byte for byte, and the clock is the one thing guaranteed to differ between
 * two replays of the same cassette.
 */
function missMessage(request: LLMRequest, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model: request.model.id,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "error",
    errorMessage: message,
    timestamp: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Wrap every tool so each call runs for real and its result is appended to the
 * cassette.
 *
 * Only successful *returns* are recorded. A tool that rejects violates the
 * {@link Tool} contract (a programming error, not an expected failure) and the
 * rejection propagates unchanged with nothing written — an `isError` result,
 * being a normal outcome, is recorded like any other.
 *
 * @param tools - Tools to wrap; extra surface beyond {@link Tool} (e.g. the
 *   bindable state tools' `bindAgent`) is preserved by spreading.
 * @param recorder - Where to append.
 */
export function wrapToolsWithRecorder(tools: readonly Tool[], recorder: CassetteRecorder): Tool[] {
  return tools.map((tool) => ({
    // Spread first: tools may carry surface beyond the Tool contract that must
    // survive the wrap (see wrapToolsWithHooks).
    ...tool,
    async execute(input, ctx): Promise<ToolResult> {
      const result = await tool.execute(input, ctx);
      await recorder.recordTool(toolKey(tool.definition.name, input), result, tool.definition.name);
      return result;
    },
  }));
}

/** Build the `ToolResult` returned when a replayed call has no recording. */
function missResult(file: string, name: string, key: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `VCR replay miss: no recorded result in ${file} for tool "${name}" ` +
          `(key ${key}). The run diverged from the recording, ` +
          `or the same call was made more times than it was recorded.`,
      },
    ],
    isError: true,
  };
}

/**
 * Wrap every tool so it serves its recorded result and **never runs**.
 *
 * This is the half of VCR that makes replay safe: `tool.execute` is not called,
 * so a replayed session performs no writes, spawns no processes and issues no
 * requests, however destructive the recorded run was. The tool objects are
 * still wrapped rather than replaced so their `definition` (and therefore the
 * schema the model sees) stays exactly what it was.
 *
 * A miss returns an `isError` result naming the tool and the key rather than
 * throwing, so the agent loop keeps going and the transcript shows precisely
 * where the run left the recording.
 *
 * @param tools - Tools whose definitions to keep and whose behaviour to replace.
 * @param cassette - A cassette from {@link loadCassette}.
 */
export function replayTools(tools: readonly Tool[], cassette: Cassette): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    execute(input): Promise<ToolResult> {
      const name = tool.definition.name;
      const key = toolKey(name, input);
      const result = cassette.takeTool(key);
      return Promise.resolve(result ?? missResult(cassette.file, name, key));
    },
  }));
}
