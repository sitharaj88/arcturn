/**
 * The agent loop: stream a turn, run the tools it asked for, inject any
 * queued steering, repeat until the model stops calling tools.
 *
 * Failures are data. The loop never throws for a runtime problem; it returns a
 * {@link LoopResult} and records the corresponding messages so the session and
 * the event stream stay consistent.
 */

import type {
  AgentEvent,
  AssistantMessage,
  LLMClient,
  LLMRequest,
  Message,
  ModelSpec,
  StreamEvent,
  ThinkingLevel,
  Tool,
  ToolCallContent,
  ToolExecutionContext,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@arcturn/types";
import type { AgentHooks, ToolCallInfo } from "./hooks.js";
import { defaultSubject, type PermissionEngine } from "./permissions.js";
import { formatSchemaErrors, validateToolInput } from "./schema.js";
import {
  emptyUsage,
  errorText,
  errorToolResult,
  toolCallsOf,
  toolResultMessage,
} from "./util/content.js";

/** Everything {@link runLoop} needs from the owning {@link Agent}. */
export interface LoopRuntime {
  llm: LLMClient;
  /** Mutable conversation, shared with the agent (compaction rewrites it). */
  messages: Message[];
  getModel(): ModelSpec;
  getSystemPrompt(): string;
  getTools(): Tool[];
  getThinking(): ThinkingLevel;
  /** Append to the conversation and persist a session entry. */
  appendMessage(message: Message): Promise<void>;
  emit(event: AgentEvent): void;
  permissions: PermissionEngine;
  hooks: AgentHooks | undefined;
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  maxTurns: number;
  /** Run tool calls from one turn concurrently instead of in order. */
  parallelTools: boolean;
  /** Drain the steering queue; returns messages to inject. */
  takeSteering(): UserMessage[];
  /** Runs before every LLM call; the agent uses it to auto-compact. */
  beforeTurn(): Promise<void>;
  /** Shapes the outgoing message list (context editing). Must not mutate history. */
  prepareMessages(messages: readonly Message[]): Message[];
}

/** Why the loop stopped. */
export interface LoopResult {
  reason: "completed" | "aborted" | "error";
  errorMessage?: string;
}

interface PartialBlock {
  kind: "text" | "thinking" | "toolCall";
  value: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  /** Provider signature over the call, replayed verbatim on the next request. */
  signature?: string;
  complete?: boolean;
}

/** Rebuilds an assistant message from stream deltas, for aborted streams. */
class StreamAccumulator {
  readonly #blocks = new Map<number, PartialBlock>();
  #usage: Usage = emptyUsage();
  #model: string;

  constructor(model: string) {
    this.#model = model;
  }

  /** Fold one stream event into the partial message. */
  push(event: StreamEvent): void {
    switch (event.type) {
      case "start":
        this.#model = event.model;
        break;
      case "textStart":
        this.#blocks.set(event.blockIndex, { kind: "text", value: "" });
        break;
      case "textDelta":
        this.#at(event.blockIndex, "text").value += event.delta;
        break;
      case "thinkingStart":
        this.#blocks.set(event.blockIndex, { kind: "thinking", value: "" });
        break;
      case "thinkingDelta":
        this.#at(event.blockIndex, "thinking").value += event.delta;
        break;
      case "toolCallStart":
        this.#blocks.set(event.blockIndex, {
          kind: "toolCall",
          value: "",
          id: event.id,
          name: event.name,
        });
        break;
      case "toolCallDelta":
        this.#at(event.blockIndex, "toolCall").value += event.argumentsDelta;
        break;
      case "toolCallEnd": {
        const block = this.#at(event.blockIndex, "toolCall");
        block.id = event.id;
        block.name = event.name;
        block.args = event.arguments;
        // Carried, never read: a provider that signs its tool calls rejects the
        // next turn when the signature does not come back (Gemini 3 answers
        // `400 INVALID_ARGUMENT`), so losing it here breaks the loop one turn
        // later, far from the cause.
        block.signature = event.signature;
        block.complete = true;
        break;
      }
      case "usage":
        this.#usage = event.usage;
        break;
      default:
        break;
    }
  }

  /**
   * Build a best-effort assistant message from what has streamed so far.
   *
   * Incomplete tool calls are dropped: replaying a half-parsed call would
   * produce an invalid request on the next turn.
   *
   * @param stopReason - Stop reason to stamp on the message.
   * @param errorMessage - Populated when `stopReason` is `"error"`.
   */
  toMessage(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
    const indices = [...this.#blocks.keys()].sort((a, b) => a - b);
    const content: AssistantMessage["content"] = [];
    for (const index of indices) {
      const block = this.#blocks.get(index)!;
      if (block.kind === "text" && block.value.length > 0) {
        content.push({ type: "text", text: block.value });
      } else if (block.kind === "thinking" && block.value.length > 0) {
        content.push({ type: "thinking", thinking: block.value });
      } else if (block.kind === "toolCall" && block.complete && block.id && block.name) {
        content.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.args ?? {},
          ...(block.signature === undefined ? {} : { signature: block.signature }),
        });
      }
    }
    return {
      role: "assistant",
      content,
      model: this.#model,
      usage: this.#usage,
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      timestamp: Date.now(),
    };
  }

  #at(index: number, kind: PartialBlock["kind"]): PartialBlock {
    let block = this.#blocks.get(index);
    if (!block) {
      block = { kind, value: "" };
      this.#blocks.set(index, block);
    }
    return block;
  }
}

interface TurnOutcome {
  message: AssistantMessage;
  /** Set when the stream failed outright rather than finishing a turn. */
  failure?: string;
}

async function streamTurn(rt: LoopRuntime, request: LLMRequest): Promise<TurnOutcome> {
  const accumulator = new StreamAccumulator(request.model.model);
  let final: AssistantMessage | undefined;
  let failure: string | undefined;

  try {
    for await (const event of rt.llm.stream(request)) {
      accumulator.push(event);
      rt.emit({ type: "messageStream", event });
      if (event.type === "end") {
        final = event.message;
      } else if (event.type === "error") {
        final = event.message;
        failure = event.error.message;
        if (event.error.kind === "aborted") failure = undefined;
      }
    }
  } catch (error) {
    const aborted = rt.signal.aborted;
    failure = aborted ? undefined : errorText(error);
    return {
      message: accumulator.toMessage(aborted ? "aborted" : "error", failure),
      ...(failure === undefined ? {} : { failure }),
    };
  }

  if (!final) {
    const aborted = rt.signal.aborted;
    failure = aborted ? undefined : "The model stream ended without a final message";
    return {
      message: accumulator.toMessage(aborted ? "aborted" : "error", failure),
      ...(failure === undefined ? {} : { failure }),
    };
  }
  return { message: final, ...(failure === undefined ? {} : { failure }) };
}

async function runHookBefore(
  hooks: AgentHooks | undefined,
  call: ToolCallInfo,
): Promise<{
  input: Record<string, unknown>;
  blocked?: { reason: string; details?: Record<string, unknown> };
}> {
  if (!hooks?.beforeToolCall) return { input: call.input };
  const outcome = await hooks.beforeToolCall(call);
  if (!outcome) return { input: call.input };
  if (outcome.action === "block") {
    return {
      input: call.input,
      blocked: {
        reason: outcome.reason,
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
      },
    };
  }
  return { input: outcome.input ?? call.input };
}

async function runHookAfter(
  hooks: AgentHooks | undefined,
  call: ToolCallInfo,
  result: ToolResultMessage,
): Promise<ToolResultMessage> {
  if (!hooks?.afterToolCall) return result;
  const replacement = await hooks.afterToolCall(call, result);
  return replacement ?? result;
}

async function executeToolCall(rt: LoopRuntime, call: ToolCallContent): Promise<ToolResultMessage> {
  const tools = rt.getTools();
  const tool = tools.find((candidate) => candidate.definition.name === call.name);

  const hook = await runHookBefore(rt.hooks, {
    toolCallId: call.id,
    toolName: call.name,
    input: call.arguments,
  });
  const input = hook.input;
  const info: ToolCallInfo = { toolCallId: call.id, toolName: call.name, input };

  rt.emit({ type: "toolStart", toolCallId: call.id, toolName: call.name, input });

  const finish = async (result: ToolResultMessage): Promise<ToolResultMessage> => {
    const final = await runHookAfter(rt.hooks, info, result);
    rt.permissions.clearCallCache(call.id);
    rt.emit({ type: "toolEnd", toolCallId: call.id, result: final });
    return final;
  };

  if (hook.blocked) {
    return finish(
      errorToolResult(call.id, call.name, `Blocked by hook: ${hook.blocked.reason}`, {
        blocked: true,
        ...(hook.blocked.details ?? {}),
      }),
    );
  }

  if (!tool) {
    const known = tools.map((candidate) => candidate.definition.name).join(", ");
    return finish(
      errorToolResult(
        call.id,
        call.name,
        `Unknown tool "${call.name}". Available tools: ${known || "(none)"}.`,
      ),
    );
  }

  const validation = validateToolInput(tool.definition.parameters, input);
  if (!validation.valid) {
    return finish(
      errorToolResult(
        call.id,
        call.name,
        `Invalid arguments for "${call.name}": ${formatSchemaErrors(validation.errors)}`,
        { validationErrors: validation.errors },
      ),
    );
  }

  if (rt.signal.aborted) {
    return finish(errorToolResult(call.id, call.name, "Aborted before the tool ran."));
  }

  const subject = defaultSubject(call.name, input, rt.cwd);
  const decision = await rt.permissions.check({
    toolName: call.name,
    toolCallId: call.id,
    subject,
    description: subject
      ? `${call.name}: ${subject}`
      : `${call.name} ${JSON.stringify(input).slice(0, 200)}`,
    ...(subject
      ? { suggestedRule: { tool: call.name, specifier: subject, action: "allow" as const } }
      : {}),
  });
  if (decision.behavior === "deny") {
    return finish(
      errorToolResult(
        call.id,
        call.name,
        decision.message ?? `Permission denied for "${call.name}".`,
        { permissionDenied: true },
      ),
    );
  }

  const ctx: ToolExecutionContext = {
    cwd: rt.cwd,
    signal: rt.signal,
    requestPermission: rt.permissions.requesterFor(call.id),
    onUpdate: (update) => rt.emit({ type: "toolUpdate", toolCallId: call.id, update }),
    sessionId: rt.sessionId,
    toolCallId: call.id,
  };

  try {
    const result = await tool.execute(input, ctx);
    return finish(
      toolResultMessage(
        call.id,
        call.name,
        result.content,
        result.isError ?? false,
        result.details,
        result.structuredContent,
      ),
    );
  } catch (error) {
    if (rt.signal.aborted) {
      return finish(errorToolResult(call.id, call.name, "Aborted by the user.", { aborted: true }));
    }
    return finish(
      errorToolResult(call.id, call.name, `Tool "${call.name}" failed: ${errorText(error)}`),
    );
  }
}

async function runToolBatch(
  rt: LoopRuntime,
  calls: readonly ToolCallContent[],
): Promise<ToolResultMessage[]> {
  if (rt.parallelTools) {
    return Promise.all(calls.map((call) => executeToolCall(rt, call)));
  }
  const results: ToolResultMessage[] = [];
  for (const call of calls) {
    if (rt.signal.aborted && results.length > 0) {
      results.push(errorToolResult(call.id, call.name, "Aborted by the user.", { aborted: true }));
      continue;
    }
    results.push(await executeToolCall(rt, call));
  }
  return results;
}

/** Append synthetic results so an aborted turn leaves no dangling tool calls. */
async function settleDanglingCalls(
  rt: LoopRuntime,
  calls: readonly ToolCallContent[],
  answered: ReadonlySet<string>,
): Promise<void> {
  for (const call of calls) {
    if (answered.has(call.id)) continue;
    await rt.appendMessage(
      errorToolResult(call.id, call.name, "Aborted by the user.", { aborted: true }),
    );
  }
}

/**
 * Drive the agent until the model stops requesting tools, the run is aborted,
 * or something fails.
 *
 * @param rt - Runtime bindings supplied by the {@link Agent}.
 */
export async function runLoop(rt: LoopRuntime): Promise<LoopResult> {
  let turnIndex = 0;

  while (true) {
    if (rt.signal.aborted) return { reason: "aborted" };
    if (turnIndex >= rt.maxTurns) {
      // The session is intact, so this is a pause, not a dead end: another
      // prompt continues with full context. Say so, or it reads as a crash.
      // But this loop also drives role agents inside a pipeline, where there
      // is no one to "send another message" to — so also say how to raise a
      // delegated agent's own budget, or the message is silently wrong there.
      const message =
        `Reached the maximum of ${rt.maxTurns} turns. Send another message to ` +
        "continue, or raise the ceiling: --max-turns for this session, or " +
        "maxTurns: in the role file (subagentMaxTurns in config) for a " +
        "delegated agent.";
      rt.emit({ type: "notice", level: "warn", text: message });
      return { reason: "error", errorMessage: message };
    }

    await rt.beforeTurn();
    if (rt.signal.aborted) return { reason: "aborted" };

    rt.emit({ type: "turnStart", turnIndex });

    const model = rt.getModel();
    const thinking = rt.getThinking();
    const tools = rt.getTools();
    const request: LLMRequest = {
      model,
      system: rt.getSystemPrompt(),
      messages: rt.prepareMessages(rt.messages),
      ...(tools.length > 0 ? { tools: tools.map((tool) => tool.definition) } : {}),
      maxOutputTokens: model.maxOutputTokens,
      ...(thinking === "off" ? {} : { thinking }),
      signal: rt.signal,
    };

    const outcome = await streamTurn(rt, request);
    const assistant = outcome.message;
    const hasContent = assistant.content.length > 0;
    if (hasContent) await rt.appendMessage(assistant);
    rt.emit({ type: "messageEnd", message: assistant });

    const calls = toolCallsOf(assistant);
    const endTurn = () => rt.emit({ type: "turnEnd", turnIndex, usage: assistant.usage });

    if (outcome.failure !== undefined) {
      if (hasContent) await settleDanglingCalls(rt, calls, new Set());
      endTurn();
      return { reason: "error", errorMessage: outcome.failure };
    }
    if (rt.signal.aborted || assistant.stopReason === "aborted") {
      if (hasContent) await settleDanglingCalls(rt, calls, new Set());
      endTurn();
      return { reason: "aborted" };
    }

    // Arguments cut off by the output limit may still parse — a truncated
    // object is completed on the way in — so the call would run with silently
    // missing fields. Fail the batch instead and let the model retry.
    if (calls.length > 0 && assistant.stopReason === "maxTokens") {
      for (const call of calls) {
        await rt.appendMessage(
          errorToolResult(
            call.id,
            call.name,
            "The model hit its output limit before finishing this tool call, so its " +
              "arguments may be incomplete. The call was not run — reissue it.",
            { truncatedArguments: true },
          ),
        );
      }
      rt.emit({
        type: "notice",
        level: "warn",
        text: "Response hit the output token limit mid tool call; the call was not executed.",
      });
      endTurn();
      turnIndex++;
      continue;
    }

    if (calls.length > 0) {
      const results = await runToolBatch(rt, calls);
      for (const result of results) await rt.appendMessage(result);

      const steering = rt.takeSteering();
      for (const message of steering) await rt.appendMessage(message);

      endTurn();
      if (rt.signal.aborted) return { reason: "aborted" };
      turnIndex++;
      continue;
    }

    const steering = rt.takeSteering();
    if (steering.length > 0) {
      for (const message of steering) await rt.appendMessage(message);
      endTurn();
      turnIndex++;
      continue;
    }

    endTurn();
    return { reason: "completed" };
  }
}
