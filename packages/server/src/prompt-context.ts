/**
 * The contract between a served session and whatever knows how to turn a
 * client's `@`-mentions and attachments into content a model can read.
 *
 * ## Why this is an interface and not an implementation
 *
 * `expandMentions` lives in `@arcturn/cli`, because that is where the TUI and
 * `--print` already call it. RFC 0005 §1.1 requires the served path to expand
 * mentions **exactly as the TUI does**, which means calling the same function,
 * not writing a second one that agrees with it until the day it does not. This
 * package cannot depend on the CLI, so the resolver is *injected* — the same
 * shape, and for the same reason, as {@link SessionHostOptions.resolveModel}
 * and {@link SessionHostOptions.modelCatalog}: the knowledge lives upstack, the
 * policy lives here.
 *
 * ## The two failure modes, kept apart
 *
 * A refusal is either fatal to the prompt or it is not, and conflating the two
 * is how a prompt gets silently degraded:
 *
 * - **An attachment** the engine cannot honour is fatal. The client named that
 *   file explicitly; running the turn without it is precisely the "silently
 *   dropped" outcome RFC 0005 §1.1 forbids. A resolver signals it by throwing
 *   {@link ContextRefusedError}, and no turn is spent.
 * - **A mention** the engine cannot honour is not. It is one token inside prose
 *   a person typed, the token itself survives in the text the model reads, and
 *   the TUI has always carried on. A resolver reports it in
 *   {@link ResolvedPrompt.refusals} and `SessionHost` turns each one into a
 *   `notice` event before the run starts — so a remote user is *told*, which is
 *   the part the served path was missing.
 */

import type {
  ContextResolution,
  ImageContent,
  LineRange,
  ModelSpec,
  PromptAttachment,
} from "@arcturn/types";

/**
 * Total byte budget for one prompt's attachments, across all of them.
 *
 * 1 MiB — deliberately the same number `session-history.ts` budgets against,
 * and taken from the same place: `ws-server.ts`'s
 * `DEFAULT_BACKPRESSURE_THRESHOLD_BYTES`, the point at which this server
 * already declares a connection to be in trouble. `sessionHistory` used it for
 * an outbound frame that must never be the one that wedges the socket; this is
 * the inbound mirror of that argument, and it binds in two places at once:
 *
 * 1. **On the wire.** An `image` attachment may carry inline base64, so the
 *    budget is what stands between a `prompt` frame and
 *    `DEFAULT_MAX_PAYLOAD_BYTES` (4 MiB), above which `ws` closes the
 *    connection with 1009 and the client learns nothing about why. 1 MiB of
 *    attachment bytes is ~1.37 MiB of base64, leaving most of the frame cap as
 *    headroom for the prompt text and the envelope — so a request that respects
 *    this budget cannot be the request that kills the socket.
 * 2. **Off the wire.** A `file` attachment carries only a path, so its bytes
 *    never cross the wire at all; the same number then bounds what the engine
 *    will read off disk and hand to a model on one turn. Two costs, one
 *    ceiling, because a client should not have to know which of them it is
 *    paying.
 *
 * Not a per-attachment cap: ten files of 200 KiB is the same load as one of
 * 2 MiB, and a per-item limit that sums to anything is not a limit.
 */
export const PROMPT_ATTACHMENT_MAX_BYTES = 1024 * 1024;

/** Thrown by a {@link ContextResolver} when a prompt cannot be honoured as asked. */
export class ContextRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextRefusedError";
  }
}

/** One image block, with enough provenance to decide what to do when it cannot be sent. */
export interface ResolvedImage {
  /** The block itself, ready for `Agent.prompt`. */
  content: ImageContent;
  /**
   * Where it came from. Decides the vision refusal: an `"attachment"` to a
   * text-only model refuses the prompt, a `"mention"` degrades with a notice.
   * See this module's doc.
   */
  source: "mention" | "attachment";
  /** How to name it in a refusal or a notice — a relative path, or `"pasted image"`. */
  label: string;
}

/** Something the engine would not read, and why. Never fatal — see the module doc. */
export interface ContextRefusal {
  /** The mention as the client wrote it. */
  what: string;
  /** One sentence a person can act on. */
  reason: string;
}

/** What a {@link ContextResolver} makes of one prompt. */
export interface ResolvedPrompt {
  /** The prompt text with mention and file-attachment content folded in. */
  text: string;
  /** Vision blocks, tagged with where each came from. */
  images: ResolvedImage[];
  /** Mentions that were refused. Empty when everything resolved. */
  refusals: ContextRefusal[];
}

/** One prompt's raw inputs, as they arrived from the wire. */
export interface PromptContextRequest {
  /** The session's working directory — the confinement root. */
  cwd: string;
  /** The prompt text, mentions unexpanded. */
  text: string;
  /** Whatever the client attached. Possibly empty. */
  attachments: readonly PromptAttachment[];
}

/** One `resolveContext` query. */
export interface ContextQueryRequest {
  /** The session's working directory — the confinement root. */
  cwd: string;
  /** The mention text, as typed, without its `@`. */
  query: string;
  /**
   * The selection the client asked about, when it asked about one.
   *
   * A resolver must **echo it back** on {@link ContextResolution.range} and
   * must not read the file to check it — this verb stats and never reads. The
   * echo exists so a client can tell an engine that understands ranges from
   * one that silently drops them; see `ContextResolution.range` for why that
   * distinction is worth a field.
   */
  range?: LineRange;
}

/**
 * Turns a client's text and attachments into what a model is handed.
 *
 * Injected into {@link SessionHost}; `@arcturn/cli`'s `createContextResolver`
 * is the real one. See this module's doc for why it is not implemented here.
 */
export interface ContextResolver {
  /**
   * Expand one prompt.
   *
   * @throws {ContextRefusedError} When an **attachment** cannot be honoured —
   *   outside the workspace, missing, not a file, over
   *   {@link PROMPT_ATTACHMENT_MAX_BYTES}, an image type this engine cannot
   *   send, or a `range` whose `start` is past the end of the file. Nothing is
   *   appended to the session and no turn is spent.
   */
  buildPrompt(request: PromptContextRequest): Promise<ResolvedPrompt>;
  /**
   * Answer what one mention would resolve to. Read-only, no side effects, and
   * no filesystem call at all for a path that fails confinement.
   */
  resolve(request: ContextQueryRequest): Promise<ContextResolution>;
}

/**
 * The sentence a client is refused with when it sends an image to a model that
 * cannot see one.
 *
 * Written here rather than at the throw site so the wire refusal and the
 * degradation notice cannot drift into describing the same fact two ways.
 *
 * @param model - The session's current model.
 * @param labels - What could not be sent, most useful first.
 */
export function visionRefusalMessage(model: ModelSpec, labels: readonly string[]): string {
  const what = labels.length === 1 ? labels[0] : `${String(labels.length)} images`;
  return (
    `${model.displayName} cannot see images, so ${what} cannot be sent to it. ` +
    "Switch this session to a vision-capable model with setModel and send it again — " +
    "nothing was sent and no turn was spent."
  );
}
