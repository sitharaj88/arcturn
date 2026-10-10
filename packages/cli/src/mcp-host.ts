/**
 * The CLI's answers to the two requests an MCP server can send *to* the
 * client: elicitation (ask the user something) and sampling (run the user's
 * model).
 *
 * `@arcturn/mcp` validates and narrows both before they arrive here; this
 * module decides what they mean for a session.
 *
 * - **Elicitation** goes to {@link ArcturnRuntime.elicitationPrompt} — the
 *   interactive app's form. A session with nobody to ask (`--print`, serve,
 *   acp) answers `decline`, never an `accept` with invented content, and says
 *   so in a warn notice. Every elicitation, answered or refused, is recorded
 *   in the session's audit trail like a permission prompt, with the field
 *   names asked for and never the values typed.
 * - **Sampling** (only ever reaching here for a server configured
 *   `sampling: true`) runs as one isolated call on the session's own client:
 *   the server's system prompt and nothing else, no tools, no session
 *   history, the server's conversation as untrusted user content. Its usage
 *   is billed to the session's {@link ArcturnRuntime.metrics} — the same
 *   total `/cost` shows and `--max-cost` compares against — and announced in
 *   an info notice. A session already at its ceiling refuses further sampling
 *   outright.
 *
 * @packageDocumentation
 */

import { addUsage, calculateCostUsd, listModelsByProvider } from "@arcturn/ai";
import type {
  McpElicitationRequest,
  McpElicitationResult,
  McpManagerOptions,
  McpSamplingRequest,
  McpSamplingResult,
} from "@arcturn/mcp";
import type { LLMClient, ModelSpec, UserMessage } from "@arcturn/types";
import type { AuditElicitationEntry, AuditLog } from "./audit.js";
import { formatCost, oneLine } from "./format.js";
import { sanitizeForTerminal } from "./project-trust.js";
import type { ArcturnRuntime } from "./runtime.js";

/** The slice of {@link ArcturnRuntime} these handlers read and write. */
export type McpHostRuntime = Pick<
  ArcturnRuntime,
  "model" | "llm" | "directLlm" | "costLimitUsd" | "elicitationPrompt" | "notify"
> & {
  metrics: ArcturnRuntime["metrics"];
  readonly audit: AuditLog | undefined;
};

/**
 * Choose the model a sampling request runs on.
 *
 * Each hint (in the server's order, first match wins) is matched
 * case-insensitively as a substring of a candidate's catalog id, wire model
 * name or display name — the spec's own reading of a hint. Candidates are
 * restricted to the session model's provider *and* endpoint: a server can
 * steer between models the user is already paying the same party for, never
 * move the call (and the user's key) to a different provider or host. No
 * match means the session model. A candidate dearer than the session model
 * (input plus output price), or with no known price, is never chosen.
 *
 * @param hints - `modelPreferences.hints[].name`, in order.
 * @param session - The session's current model.
 * @param candidates - Catalog to match against; defaults to every catalog
 *   model on the session model's provider.
 */
export function selectSamplingModel(
  hints: readonly string[],
  session: ModelSpec,
  candidates: readonly ModelSpec[] = listModelsByProvider(session.provider),
): ModelSpec {
  // Never dearer than the session model: a hint is a request to go sideways or
  // down, not a way to spend the user's key on a model they did not choose.
  // A price that is unknown cannot be shown to be no higher, so it is refused.
  const ceiling = session.cost === undefined ? undefined : session.cost.input + session.cost.output;
  const eligible = candidates.filter(
    (spec) =>
      spec.provider === session.provider &&
      spec.baseUrl === session.baseUrl &&
      (spec.id === session.id ||
        (ceiling !== undefined &&
          spec.cost !== undefined &&
          spec.cost.input + spec.cost.output <= ceiling)),
  );
  for (const hint of hints) {
    const needle = hint.trim().toLowerCase();
    if (needle === "") continue;
    const match = eligible.find((spec) =>
      [spec.id, spec.model, spec.displayName].some((name) => name.toLowerCase().includes(needle)),
    );
    if (match) return match;
  }
  return session;
}

/**
 * Fold the conversation a server wants sampled into ONE user message.
 *
 * Every word of it is the server's, so all of it rides as user content: an
 * `assistant` turn the server wrote is labelled as such rather than sent as
 * the model's own words, which would let a server put a reply in the model's
 * mouth.
 */
function samplingPrompt(request: McpSamplingRequest): UserMessage {
  const single = request.messages.length === 1 && request.messages[0]?.role === "user";
  return {
    role: "user",
    content: request.messages.map((message) => ({
      type: "text" as const,
      text:
        single || message.role === "user"
          ? message.text
          : `[assistant turn, as written by MCP server "${request.server}"]\n${message.text}`,
    })),
    timestamp: Date.now(),
  };
}

/**
 * `config` with `sampling` removed from every server a project's `mcp.json`
 * defines. Sampling spends the user's key on a server's say-so, so only the
 * user's own `~/.arcturn/mcp.json` may grant it: a cloned repository that the
 * user trusted enough to run its server must not also get to run their model.
 * A project entry shadowing a user entry of the same name loses it too, since
 * the project's definition replaced the user's whole.
 *
 * @param config - The merged config; mutated and returned.
 * @param projectServerNames - Names present in the project file.
 */
export function withoutProjectSampling<
  T extends { servers: Record<string, { sampling?: boolean }> },
>(config: T, projectServerNames: readonly string[]): T {
  for (const name of projectServerNames) {
    const server = config.servers[name];
    if (server?.sampling !== undefined) delete server.sampling;
  }
  return config;
}

/**
 * The `elicit`, `onElicitationRefused` and `sample` options for an
 * {@link McpManager} serving `runtime`.
 *
 * @param runtime - The session the servers belong to.
 * @param now - Clock for audit timestamps.
 */
export function mcpHostOptions(
  runtime: McpHostRuntime,
  now: () => number = Date.now,
): Required<Pick<McpManagerOptions, "elicit" | "onElicitationRefused" | "sample">> {
  // Everything a server wrote — field names, its message, a reason built from
  // them — reaches a terminal through `/audit` or a notice, so it is scrubbed
  // of escape sequences before it is recorded or shown.
  const audit = (entry: Omit<AuditElicitationEntry, "kind" | "ts">): void => {
    const scrubbed: Omit<AuditElicitationEntry, "kind" | "ts"> = {
      ...entry,
      server: sanitizeForTerminal(entry.server),
      fields: entry.fields.map((field) => sanitizeForTerminal(field)),
      ...(entry.reason === undefined ? {} : { reason: sanitizeForTerminal(entry.reason) }),
    };
    void runtime.audit
      ?.record({ kind: "elicitation", ts: now(), ...scrubbed })
      .catch(() => undefined);
  };

  return {
    async elicit(request: McpElicitationRequest): Promise<McpElicitationResult> {
      const fields = request.fields.map((field) => field.name);
      const prompt = runtime.elicitationPrompt;
      if (prompt === undefined) {
        const reason = "this session cannot prompt";
        audit({ server: request.server, action: "decline", fields, reason });
        runtime.notify(
          "warn",
          `MCP server "${request.server}" asked for input ` +
            `("${oneLine(sanitizeForTerminal(request.message), 80)}"); declined: ${reason}.`,
        );
        return { action: "decline" };
      }
      let answer: McpElicitationResult;
      try {
        answer = await prompt(request);
      } catch {
        // Fail closed: a prompt that blew up sends the server nothing.
        answer = { action: "cancel" };
      }
      audit({ server: request.server, action: answer.action, fields });
      return answer;
    },

    onElicitationRefused({ server, reason }) {
      audit({ server, action: "refused", fields: [], reason });
      runtime.notify(
        "warn",
        `Refused an input request from MCP server "${sanitizeForTerminal(server)}": ` +
          `${sanitizeForTerminal(reason)}.`,
      );
    },

    async sample(request: McpSamplingRequest): Promise<McpSamplingResult> {
      const limit = runtime.costLimitUsd;
      if (limit > 0 && runtime.metrics.costUsd >= limit) {
        throw new Error(
          `Sampling refused: this session has reached its ${formatCost(limit)} cost limit ` +
            "(--max-cost / /cost limit).",
        );
      }
      const model = selectSamplingModel(request.modelHints, runtime.model);
      const client: LLMClient = runtime.directLlm ?? runtime.llm;
      let maxOutputTokens = Math.max(1, Math.min(request.maxTokens, model.maxOutputTokens));
      if (limit > 0 && model.cost !== undefined) {
        // The call cannot be cut mid-flight, so it is bounded up front: what
        // is left under the ceiling, less a rough price for the input, buys
        // at most this many output tokens.
        const chars =
          (request.systemPrompt?.length ?? 0) +
          request.messages.reduce((sum, message) => sum + message.text.length, 0);
        const inputCost = (Math.ceil(chars / 3) * model.cost.input) / 1_000_000;
        const room = limit - runtime.metrics.costUsd - inputCost;
        const affordable =
          model.cost.output > 0 ? Math.floor((room * 1_000_000) / model.cost.output) : Infinity;
        if (affordable < 1) {
          throw new Error(
            `Sampling refused: too little of the ${formatCost(limit)} cost limit is left ` +
              "(--max-cost / /cost limit) to pay for it.",
          );
        }
        maxOutputTokens = Math.min(maxOutputTokens, affordable);
      }
      const message = await client.complete({
        model,
        // The server's system prompt for this one call, or none — never the
        // session's own, which would hand the server the user's context.
        ...(request.systemPrompt === undefined ? {} : { system: request.systemPrompt }),
        messages: [samplingPrompt(request)],
        maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        signal: request.signal,
      });

      // Billed before anything can fail: tokens a failed call consumed were
      // still spent. `undefined` is not zero — see `SessionMetrics.unpricedTurns`.
      const cost = message.usage.costUsd ?? calculateCostUsd(model, message.usage);
      runtime.metrics = {
        ...runtime.metrics,
        usage: addUsage(runtime.metrics.usage, message.usage),
        costUsd: runtime.metrics.costUsd + (cost ?? 0),
        unpricedTurns: runtime.metrics.unpricedTurns + (cost === undefined ? 1 : 0),
      };
      void runtime.audit
        ?.record({
          kind: "sampling",
          ts: now(),
          server: request.server,
          model: model.id,
          tokens: message.usage.inputTokens + message.usage.outputTokens,
          ...(cost === undefined ? {} : { costUsd: cost }),
        })
        .catch(() => undefined);
      runtime.notify(
        "info",
        `MCP server "${request.server}" sampled ${model.id}: ` +
          `${message.usage.inputTokens} in / ${message.usage.outputTokens} out tokens, ` +
          `${cost === undefined ? "cost unknown" : formatCost(cost)} (billed to this session).`,
      );

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? `Sampling on ${model.id} did not complete.`);
      }
      const text = message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      // `endTurn` and `maxTokens` are spelled as in the spec; anything else
      // (`refusal`, say) passes through as the open string the spec allows.
      return { model: model.id, text, stopReason: message.stopReason };
    },
  };
}
