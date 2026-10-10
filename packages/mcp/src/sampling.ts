/**
 * Sampling (`sampling/createMessage`): a server asking the client to run the
 * user's model on a prompt the server wrote.
 *
 * That is spend on the user's key and a prompt nobody on the user's side
 * authored, so it is opt-in per server (`sampling: true` in the server's
 * config) and narrowed here before a host ever sees it: text only, no tools,
 * no context from other servers, and a `maxTokens` the server can lower but
 * never raise past the client's ceiling.
 */

/**
 * Ceiling on one sampling request's output, in tokens. A server's own
 * `maxTokens` can only lower it — a server that asks for a million gets this.
 */
export const DEFAULT_MCP_SAMPLING_MAX_TOKENS = 4096;

/** One turn of the server's sampling conversation, reduced to its text. */
export interface McpSamplingMessage {
  /** The role the server gave this turn. Untrusted, like the text. */
  role: "user" | "assistant";
  text: string;
}

/** A sampling request, validated and narrowed, as handed to the host. */
export interface McpSamplingRequest {
  /** Configured name of the server asking. */
  server: string;
  /**
   * The server's conversation, in order. Every word of it was written by the
   * server: a host must present it to the model as untrusted user content,
   * never as its own system or operator text.
   */
  messages: McpSamplingMessage[];
  /**
   * The server's requested system prompt, if any. Meant for this one isolated
   * call only — never merged with the host's own system prompt.
   */
  systemPrompt?: string;
  /** Output ceiling: the smaller of the server's `maxTokens` and the client's. */
  maxTokens: number;
  temperature?: number;
  /**
   * `modelPreferences.hints[].name`, in the server's order of preference —
   * substrings of a model name per the spec. Advisory; the host decides.
   */
  modelHints: string[];
  /** Aborts when the server cancels the request or the connection closes. */
  signal: AbortSignal;
}

/** What the host generated for a {@link McpSamplingRequest}. */
export interface McpSamplingResult {
  /** The model that actually answered (a catalog id). */
  model: string;
  /** The generated text. */
  text: string;
  /** Why generation stopped, in the spec's vocabulary where it has one. */
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | (string & {});
}

/** Runs a sampling request on the host's model. Throw to answer with an error. */
export type McpSamplingHandler = (request: McpSamplingRequest) => Promise<McpSamplingResult>;

/** The slice of the SDK's parsed `CreateMessageRequest` params this module reads. */
export interface RawSamplingParams {
  messages: readonly { role: string; content: unknown }[];
  systemPrompt?: string | undefined;
  maxTokens: number;
  temperature?: number | undefined;
  modelPreferences?: { hints?: readonly { name?: string | undefined }[] | undefined } | undefined;
  tools?: unknown;
  toolChoice?: unknown;
}

/** Outcome of {@link narrowSamplingRequest}. */
export type SamplingNarrowing =
  | { ok: true; request: Omit<McpSamplingRequest, "server" | "signal"> }
  | { ok: false; reason: string };

function textOf(content: unknown): string | undefined {
  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const block of blocks) {
    if (
      typeof block !== "object" ||
      block === null ||
      (block as { type?: unknown }).type !== "text" ||
      typeof (block as { text?: unknown }).text !== "string"
    ) {
      return undefined;
    }
    parts.push((block as { text: string }).text);
  }
  return parts.join("\n");
}

/**
 * Reduce the server's request to what a host may act on, or say why not.
 *
 * Refused: `tools` or `toolChoice` (the client does not declare
 * `sampling.tools`, and the spec says such a request MUST be an error); any
 * content block that is not text; an empty conversation; a role other than
 * `user`/`assistant`. `includeContext` is ignored — the client does not
 * declare `sampling.context`, so "none" is the only answer it gives.
 *
 * @param params - The parsed request params.
 * @param ceiling - The client's output ceiling, in tokens.
 */
export function narrowSamplingRequest(
  params: RawSamplingParams,
  ceiling: number,
): SamplingNarrowing {
  if (params.tools !== undefined || params.toolChoice !== undefined) {
    return { ok: false, reason: "this client does not support tool use in sampling" };
  }
  if (params.messages.length === 0) {
    return { ok: false, reason: "a sampling request needs at least one message" };
  }
  const messages: McpSamplingMessage[] = [];
  for (const [index, message] of params.messages.entries()) {
    if (message.role !== "user" && message.role !== "assistant") {
      return { ok: false, reason: `message ${index} has role "${message.role}"` };
    }
    const text = textOf(message.content);
    if (text === undefined) {
      return { ok: false, reason: `message ${index} is not text; only text sampling is supported` };
    }
    messages.push({ role: message.role, text });
  }
  const requested = Number.isFinite(params.maxTokens) ? Math.floor(params.maxTokens) : ceiling;
  const maxTokens = Math.max(1, Math.min(requested, ceiling));
  const modelHints = (params.modelPreferences?.hints ?? [])
    .map((hint) => hint.name?.trim() ?? "")
    .filter((name) => name !== "");
  return {
    ok: true,
    request: {
      messages,
      ...(params.systemPrompt === undefined || params.systemPrompt === ""
        ? {}
        : { systemPrompt: params.systemPrompt }),
      maxTokens,
      ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
      modelHints,
    },
  };
}
