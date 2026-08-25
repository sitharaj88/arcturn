/**
 * Rendering a session's conversation as a document the **client** saves.
 *
 * The terminal's `/export` writes a file next to the person who ran it. Over
 * this wire that same behaviour would put a file on the *engine's* disk — the
 * wrong machine for the person asking, and, for anyone holding the serve
 * token, an arbitrary-write primitive dressed up as a convenience. So the
 * engine renders and the client saves: `exportSession` answers with the
 * content and a suggested filename and touches nothing. That is RFC 0005
 * §1.2's "nothing persists to disk from a remote client", pointed at
 * transcripts.
 *
 * ## What lives here, and what does not
 *
 * The *renderers* do not live here. `exportMarkdown` and `exportHtml` are
 * `@arcturn/cli`'s, they are what `/export` already calls, and this package
 * does not depend on that one — so they arrive through an injected
 * {@link TranscriptExporter}, exactly as the model catalog, the context
 * resolver and the command list do. One renderer, two front-ends; a second
 * one would be a second answer to "what does my transcript look like".
 *
 * What lives here is the part the *wire* is responsible for: the byte budget,
 * and an honest account of what had to be dropped to meet it.
 */

import type { Message, SessionExport, TranscriptFormat } from "@arcturn/types";

/**
 * Byte budget for one rendered export.
 *
 * 1 MiB, and the same 1 MiB `session-history.ts` uses, for the reason stated
 * there: it is `ws-server.ts`'s own `DEFAULT_BACKPRESSURE_THRESHOLD_BYTES` —
 * the point at which this server already considers a connection to be in
 * trouble — and a quarter of `DEFAULT_MAX_PAYLOAD_BYTES` (4 MiB), the frame
 * size above which `ws` closes the connection with 1009. An export is
 * *essential* traffic: it answers the client's own request, so the
 * backpressure policy never drops it, which is precisely why it must not be
 * the frame that wedges the socket.
 *
 * Measured on the rendered document, not on the envelope, which adds a
 * hundred-odd bytes of JSON — far inside the headroom to the frame cap.
 */
export const SESSION_EXPORT_MAX_BYTES = 1024 * 1024;

/**
 * Bounds applied by {@link buildSessionExport}.
 *
 * Deliberately **one** bound, where `SessionHistoryLimits` has two. History is
 * capped on element count as well as bytes because a client folds every event
 * through a reducer and pays per element; an export is a string the client
 * writes to a file, so bytes are the only cost it has and a second bound would
 * cut a document for a reason nobody could point at.
 */
export interface SessionExportLimits {
  /** See {@link SESSION_EXPORT_MAX_BYTES}. */
  maxBytes?: number;
}

/** What {@link TranscriptExporter.render} is asked to produce. */
export interface TranscriptRenderRequest {
  /** The conversation to render, oldest first. */
  messages: readonly Message[];
  /** Which document to produce. */
  format: TranscriptFormat;
  /** Whether `thinking` blocks are included. The terminal's `--thinking`. */
  includeThinking: boolean;
  /** Display name of the model the session is running, for the header. */
  model: string;
  /**
   * ISO-8601 timestamp for the header and the filename.
   *
   * Passed in rather than read inside the renderer so a render is a pure
   * function of its inputs — the rule `@arcturn/cli`'s `export.ts` already
   * keeps, and the reason {@link buildSessionExport} can re-render a
   * conversation several times while trimming it to fit without the two
   * attempts disagreeing about what time it is.
   */
  exportedAt: string;
}

/**
 * The renderer pair, injected because it lives in `@arcturn/cli`.
 *
 * Both halves in one object, and deliberately: the document and the name it is
 * offered under are one feature, and `createServeHost`'s
 * `resolveModel`/`modelCatalog` comment records what happens when two halves
 * of one feature are wired separately — they were, once, and drifted into a
 * real routing bug. A client shown `arcturn-session-….md` holding HTML would
 * be the same class of mistake, cheaper only because nobody's credential is
 * involved.
 */
export interface TranscriptExporter {
  /** Render the document. Must be a pure function of the request. */
  render(request: TranscriptRenderRequest): string;
  /** The filename to offer in a save dialog. A bare name, never a path. */
  suggestFilename(request: { format: TranscriptFormat; exportedAt: string }): string;
}

/** UTF-8 length, which is what the socket actually pays for. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Render one export, trimmed to fit the byte budget, with what was dropped
 * reported rather than inferred.
 *
 * ## Why the oldest messages go first
 *
 * Same reason `session-history.ts` drops from the front: the recent end of a
 * conversation is the part a person is looking for, and a transcript that
 * stops early is worse than one that starts late. What is different here is
 * *how* the cut is made — history slices a list of already-serialized events,
 * but an export is a document, so the messages are dropped and the document is
 * **re-rendered** from what is left. A byte-count cut on the rendered string
 * would hand a client HTML sliced through a tag, or markdown ending inside a
 * fenced block; every document this returns is well-formed.
 *
 * The loop converges because each pass drops at least one message and an empty
 * conversation renders to a header alone. It is a loop rather than arithmetic
 * because only the renderer knows what a message costs — a tool result is
 * line-truncated, a thinking block may be omitted entirely — so the size of a
 * document is not a sum this module could compute.
 *
 * @param sessionId - Session being exported, echoed into the result.
 * @param messages - The conversation, oldest first.
 * @param exporter - The injected renderer pair.
 * @param request - Format, thinking, model name and timestamp.
 * @param limits - Byte budget; defaults to {@link SESSION_EXPORT_MAX_BYTES}.
 */
export function buildSessionExport(
  sessionId: string,
  messages: readonly Message[],
  exporter: TranscriptExporter,
  request: Omit<TranscriptRenderRequest, "messages">,
  limits: SessionExportLimits = {},
): SessionExport {
  const maxBytes = limits.maxBytes ?? SESSION_EXPORT_MAX_BYTES;

  let kept = messages;
  let dropped = 0;
  let content = exporter.render({ ...request, messages: kept });

  while (byteLength(content) > maxBytes && kept.length > 0) {
    // Aim straight at the budget rather than shaving one message at a time: a
    // thousand-turn conversation would otherwise re-render a thousand times.
    // The ratio is an estimate (messages are not equal sizes), so this is
    // still a loop — it just usually finishes in two passes.
    const ratio = maxBytes / byteLength(content);
    const target = Math.floor(kept.length * ratio);
    const drop = Math.max(1, kept.length - target);
    kept = kept.slice(drop);
    dropped += drop;
    content = exporter.render({ ...request, messages: kept });
  }

  return {
    sessionId,
    format: request.format,
    filename: exporter.suggestFilename({
      format: request.format,
      exportedAt: request.exportedAt,
    }),
    content,
    messageCount: kept.length,
    truncated: dropped > 0,
    droppedMessages: dropped,
  };
}
