/**
 * Wave 3 in the workflow engine: native structured output for
 * `[contract:<name>]` steps, and task budgets (`[budget:<tokens>]`, a role's
 * `taskBudgetTokens:`).
 *
 * Every assertion is on an effect: what the child agent was configured with,
 * how many times a step ran, what reached the journal, what the next stage
 * spliced, what a parse refused.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@arcturn/ai";
import type { AgentEvent, ModelSpec, ResponseFormat, Usage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { loadAgentDefs } from "./agents.js";
import { contractToJsonSchema, parseContractBody, type WorkflowContract } from "./contracts.js";
import { parseTaskBudget, taskBudgetUnsupportedModel } from "./task-budget.js";
import {
  createRuntimeRunStep,
  isWorkflowParseError,
  parseWorkflow,
  runWorkflow,
  type Workflow,
  type WorkflowChildAgent,
  type WorkflowStepRequest,
} from "./workflow.js";
import { buildResumeState, type JournalLine, type StepEndLine } from "./workflow-run.js";
import { foldJournal, formatRunDetail } from "./workflow-status.js";

const FENCE = "```";
const NL = "\n";
const FRONT = ["---", "name: demo", "---"].join("\n");

function usage(): Usage {
  return { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function parseOk(raw: string): Workflow {
  const parsed = parseWorkflow(raw, { name: "demo" });
  if (isWorkflowParseError(parsed)) throw new Error(parsed.error);
  return parsed;
}

function contract(lines: string[]): WorkflowContract {
  const parsed = parseContractBody(lines, 2);
  if ("error" in parsed) throw new Error(parsed.error);
  return { name: "c", line: 1, fields: parsed.fields };
}

const VERDICT = [`${FENCE}contract verdict`, "decision: SHIP | HOLD", "confidence: number", FENCE];
const TWO_STAGES = parseOk(
  [
    FRONT,
    "1. [contract:verdict] review {{input}}",
    "2. act on {{contract.decision}}",
    "",
    ...VERDICT,
  ].join("\n"),
);

function journal(): { lines: JournalLine[]; sink: { append(line: JournalLine): Promise<void> } } {
  const lines: JournalLine[] = [];
  return {
    lines,
    sink: {
      append: async (line) => {
        lines.push(line);
      },
    },
  };
}

describe("contractToJsonSchema", () => {
  it.each<[string, string[], Record<string, unknown>]>([
    ["string", ["a: string"], { a: { type: "string" } }],
    ["number", ["a: number"], { a: { type: "number" } }],
    ["integer", ["a: integer"], { a: { type: "integer" } }],
    ["boolean", ["a: boolean"], { a: { type: "boolean" } }],
    ["string[]", ["a: string[]"], { a: { type: "array", items: { type: "string" } } }],
    ["number[]", ["a: number[]"], { a: { type: "array", items: { type: "number" } } }],
    ["enum", ["a: SHIP | DO-NOT-SHIP"], { a: { enum: ["SHIP", "DO-NOT-SHIP"] } }],
  ])("maps %s", (_label, lines, properties) => {
    expect(contractToJsonSchema(contract(lines))).toEqual({
      type: "object",
      properties,
      required: ["a"],
      additionalProperties: false,
    });
  });

  it("leaves an optional field out of required, and always closes the object", () => {
    expect(contractToJsonSchema(contract(["a: string", "b?: integer"]))).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" } },
      required: ["a"],
      additionalProperties: false,
    });
  });
});

describe("contract steps on the native path", () => {
  it("offers the contract's schema to the runner", async () => {
    const seen: (ResponseFormat | undefined)[] = [];
    await runWorkflow(TWO_STAGES, {
      input: "IN",
      runStep: async (request) => {
        seen.push(request.responseFormat);
        return {
          text: '{"decision":"SHIP","confidence":1}',
          usage: usage(),
          isError: false,
          contractMode: "native",
        };
      },
    });
    expect(seen[0]).toEqual({
      name: "verdict",
      schema: {
        type: "object",
        properties: { decision: { enum: ["SHIP", "HOLD"] }, confidence: { type: "number" } },
        required: ["decision", "confidence"],
        additionalProperties: false,
      },
    });
    // The step with no contract is offered nothing.
    expect(seen[1]).toBeUndefined();
  });

  it("reads the whole reply as the JSON, skips the retry, and splices from the validated object", async () => {
    const calls: string[] = [];
    let second = "";
    const mem = journal();
    const result = await runWorkflow(TWO_STAGES, {
      input: "IN",
      runId: "RID",
      journal: mem.sink,
      runStep: async (request) => {
        calls.push(request.step.id);
        if (request.step.id === "2") second = request.prompt;
        return request.step.id === "1"
          ? {
              text: '{"decision":"HOLD","confidence":0.4}',
              usage: usage(),
              isError: false,
              contractMode: "native",
            }
          : { text: "ok", usage: usage(), isError: false };
      },
    });
    expect(result.status).toBe("done");
    expect(calls).toEqual(["1", "2"]);
    expect(second).toContain("act on HOLD");
    expect(result.steps[0]?.contract).toEqual({ decision: "HOLD", confidence: 0.4 });
    const end = mem.lines.find(
      (line): line is StepEndLine => line.kind === "stepEnd" && line.id === "1",
    );
    expect(end?.contractMode).toBe("native");
    const detail = formatRunDetail(foldJournal("RID", mem.lines), Date.now()).join("\n");
    expect(detail).toContain("contract (native): decision=HOLD confidence=0.4");
  });

  it("does not hunt for a fence in a native reply", async () => {
    let calls = 0;
    const fenced = `Here it is.\n${FENCE}json\n{"decision":"SHIP","confidence":1}\n${FENCE}`;
    const result = await runWorkflow(TWO_STAGES, {
      runStep: async (request) => {
        if (request.step.id === "1") calls += 1;
        return { text: fenced, usage: usage(), isError: false, contractMode: "native" };
      },
    });
    // Prose around the JSON is a shape miss on the native path: one retry, then a fail.
    expect(calls).toBe(2);
    expect(result.steps[0]?.status).toBe("failed");
  });

  it("still gets exactly one retry when the provider returns non-conforming JSON", async () => {
    const prompts: string[] = [];
    const replies = ['{"decision":"MAYBE","confidence":1}', '{"decision":"SHIP","confidence":1}'];
    const result = await runWorkflow(TWO_STAGES, {
      runStep: async (request) => {
        if (request.step.id !== "1") return { text: "ok", usage: usage(), isError: false };
        prompts.push(request.prompt);
        return {
          text: replies[prompts.length - 1] ?? "",
          usage: usage(),
          isError: false,
          contractMode: "native",
        };
      },
    });
    expect(prompts).toHaveLength(2);
    // The retry carries the validator's words; the provider's schema was not trusted.
    expect(prompts[1]).toContain("decision: expected one of SHIP, HOLD");
    expect(result.status).toBe("done");
    expect(result.steps[0]?.contract).toEqual({ decision: "SHIP", confidence: 1 });
  });

  it("journals the fenced path too, and re-splices a native step on resume without re-running it", async () => {
    const round1 = journal();
    const controller = new AbortController();
    await runWorkflow(TWO_STAGES, {
      journal: round1.sink,
      signal: controller.signal,
      runStep: async (request) => {
        if (request.step.id === "1") {
          return {
            text: '{"decision":"SHIP","confidence":0.9}',
            usage: usage(),
            isError: false,
            contractMode: "native",
          };
        }
        controller.abort();
        return { text: "", usage: usage(), isError: true, error: "cancelled" };
      },
    });
    const calls: string[] = [];
    let second = "";
    const resumed = await runWorkflow(TWO_STAGES, {
      resumeFrom: buildResumeState(round1.lines),
      runStep: async (request) => {
        calls.push(request.step.id);
        second = request.prompt;
        return { text: "ok", usage: usage(), isError: false };
      },
    });
    expect(resumed.status).toBe("done");
    expect(calls).toEqual(["2"]);
    expect(second).toContain("act on SHIP");

    const fenced = journal();
    await runWorkflow(TWO_STAGES, {
      journal: fenced.sink,
      runStep: async () => ({
        text: `${FENCE}json\n{"decision":"SHIP","confidence":1}\n${FENCE}`,
        usage: usage(),
        isError: false,
      }),
    });
    const end = fenced.lines.find(
      (line): line is StepEndLine => line.kind === "stepEnd" && line.id === "1",
    );
    expect(end?.contractMode).toBe("fenced");
  });
});

const subscribers = new WeakMap<WorkflowChildAgent, Set<(event: AgentEvent) => void>>();
function listenersOf(agent: WorkflowChildAgent): Set<(event: AgentEvent) => void> {
  return subscribers.get(agent) ?? new Set();
}

/** A child agent that records how the runner configured it. */
function configurableAgent(model: ModelSpec | undefined, text = "{}") {
  const listeners = new Set<(event: AgentEvent) => void>();
  const configured: { format?: ResponseFormat; budget?: { total: number } } = {};
  const agent: WorkflowChildAgent = {
    ...(model === undefined ? {} : { model }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const listener of listeners) listener({ type: "runEnd", reason: "completed" });
    },
    abort() {},
    finalText: () => text,
    setResponseFormat(format) {
      if (format !== undefined) configured.format = format;
    },
    setTaskBudget(budget) {
      if (budget !== undefined) configured.budget = budget;
    },
  };
  subscribers.set(agent, listeners);
  return { agent, configured };
}

function spec(id: string): ModelSpec {
  const found = getModel(id);
  if (!found) throw new Error(`catalog lacks ${id}`);
  return found;
}

describe("the runtime runner configures the child", () => {
  const format: ResponseFormat = { name: "verdict", schema: { type: "object" } };
  const step = TWO_STAGES.stages[0]!.steps[0]!;
  const request = (extra: Partial<WorkflowStepRequest> = {}): WorkflowStepRequest => ({
    step,
    prompt: "p",
    signal: new AbortController().signal,
    ...extra,
  });

  it("sends the schema natively to a model that has structured output", async () => {
    const { agent, configured } = configurableAgent(spec("anthropic/claude-opus-5-5"));
    const outcome = await createRuntimeRunStep({ createSubagent: () => agent })(
      request({ responseFormat: format }),
    );
    expect(configured.format).toEqual(format);
    expect(outcome.contractMode).toBe("native");
  });

  it("falls back to the fence on a model without it", async () => {
    const gateway = { ...spec("anthropic/claude-opus-5-5"), provider: "openai-compatible" };
    const { agent, configured } = configurableAgent(gateway);
    const outcome = await createRuntimeRunStep({ createSubagent: () => agent })(
      request({ responseFormat: format }),
    );
    expect(configured.format).toBeUndefined();
    expect(outcome.contractMode).toBe("fenced");
  });

  it("journals the path of the model that ANSWERED, not the one asked", async () => {
    const answerBy = (wire: string) => {
      const made = configurableAgent(spec("anthropic/claude-opus-5-5"), "plain prose");
      const original = made.agent.prompt.bind(made.agent);
      made.agent.prompt = async (text) => {
        for (const listener of listenersOf(made.agent)) {
          listener({
            type: "messageEnd",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "plain prose" }],
              model: wire,
              usage: usage(),
              stopReason: "endTurn",
              timestamp: 1,
            },
          });
        }
        return original(text);
      };
      return made.agent;
    };
    // Asked natively of Opus 5.5, answered by a failover link with no structured output.
    const failedOver = await createRuntimeRunStep({
      createSubagent: () => answerBy("some-gateway-model"),
    })(request({ responseFormat: format }));
    expect(failedOver.contractMode).toBe("fenced");
    // Answered by the model that was asked: still native.
    const same = await createRuntimeRunStep({
      createSubagent: () => answerBy(spec("anthropic/claude-opus-5-5").model),
    })(request({ responseFormat: format }));
    expect(same.contractMode).toBe("native");
  });

  it("sets the task budget on a model that paces itself, the stage's over the role's", async () => {
    const { agent, configured } = configurableAgent(spec("anthropic/claude-opus-5-5"));
    const roleDef = {
      name: "lead",
      description: "",
      systemPrompt: "x",
      tools: ["read"],
      taskBudgetTokens: 30_000,
      source: "/lead.md",
    };
    const roled = parseOk([FRONT, "1. [budget:50000] @lead go"].join("\n")).stages[0]!.steps[0]!;
    await createRuntimeRunStep(
      { createSubagent: () => agent },
      { resolveAgent: () => roleDef },
    )({ step: roled, prompt: "go", signal: new AbortController().signal, taskBudget: 50_000 });
    expect(configured.budget).toEqual({ total: 50_000 });

    const other = configurableAgent(spec("anthropic/claude-opus-5-5"));
    await createRuntimeRunStep(
      { createSubagent: () => other.agent },
      { resolveAgent: () => roleDef },
    )({ step: roled, prompt: "go", signal: new AbortController().signal });
    expect(other.configured.budget).toEqual({ total: 30_000 });
  });

  it("says once that a model without task budgets runs on the turn ceiling alone", async () => {
    const events: AgentEvent[] = [];
    const { agent, configured } = configurableAgent(spec("anthropic/claude-sonnet-5"));
    await createRuntimeRunStep(
      { createSubagent: () => agent },
      { emit: (event) => events.push(event) },
    )(request({ taskBudget: 40_000 }));
    expect(configured.budget).toBeUndefined();
    const notices = events.flatMap((event) =>
      event.type === "subagentEvent" && event.event.type === "notice" ? [event.event.text] : [],
    );
    expect(notices).toEqual([
      "Task budget of 40,000 tokens not sent: anthropic/claude-sonnet-5 does not support " +
        "pacing, so the turn ceiling is the only limit.",
    ]);
  });
});

describe("[budget:<tokens>] and taskBudgetTokens:", () => {
  it("parses onto the step", () => {
    const wf = parseOk([FRONT, "1. [anthropic/claude-opus-5-5] [budget:50000] go"].join("\n"));
    expect(wf.stages[0]?.steps[0]?.budget).toBe(50_000);
  });

  it("refuses a budget on Sonnet 5 at parse time, naming the model", () => {
    const parsed = parseWorkflow(
      [FRONT, "1. [budget:50000] [anthropic/claude-sonnet-5] go"].join("\n"),
      { name: "demo" },
    );
    expect(isWorkflowParseError(parsed) && parsed.error).toBe(
      'line 4: budget needs a model with task budgets, and "anthropic/claude-sonnet-5" names ' +
        "claude-sonnet-5, which has none — use Opus 4.7 or later, Fable 5 or later, Sonnet 5.5 " +
        "or Haiku 5.5, or drop the budget",
    );
    // A race arm on Sonnet 5 is refused the same way; a tier resolves at run time.
    expect(
      isWorkflowParseError(
        parseWorkflow(
          [FRONT, "1. [budget:50000] [race:claude-opus-5-5|claude-sonnet-5] go"].join("\n"),
          {
            name: "demo",
          },
        ),
      ),
    ).toBe(true);
    expect(
      isWorkflowParseError(
        parseWorkflow([FRONT, "1. [budget:50000] [tier:cheap] go"].join("\n"), { name: "demo" }),
      ),
    ).toBe(false);
  });

  it("refuses a budget below the API's minimum or not a whole number", () => {
    for (const value of ["19999", "5e4", "-1", "lots"]) {
      const parsed = parseWorkflow([FRONT, `1. [budget:${value}] go`].join("\n"), { name: "d" });
      expect(isWorkflowParseError(parsed) && parsed.error).toBe(
        `line 4: budget must be a whole number of tokens, at least 20000, got "${value}"`,
      );
    }
    expect(parseTaskBudget("20000")).toBe(20_000);
  });

  it("names exactly the Claude models without task budgets", () => {
    expect(taskBudgetUnsupportedModel("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(taskBudgetUnsupportedModel("claude-opus-4-6")).toBe("claude-opus-4-6");
    for (const ok of [
      "claude-sonnet-5-5",
      "claude-opus-4-7",
      "claude-fable-5-1",
      "claude-haiku-5-5",
    ]) {
      expect(taskBudgetUnsupportedModel(ok)).toBeUndefined();
    }
    expect(taskBudgetUnsupportedModel("tier:judgment")).toBeUndefined();
  });

  it("reads taskBudgetTokens from a role file, refusing a value under the minimum", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcturn-roles-"));
    try {
      await writeFile(
        join(dir, "lead.md"),
        ["---", "name: lead", "taskBudgetTokens: 64000", "---", "You lead."].join(NL),
      );
      await writeFile(
        join(dir, "low.md"),
        ["---", "name: low", "taskBudgetTokens: 100", "---", "You follow."].join(NL),
      );
      const warnings: string[] = [];
      const defs = await loadAgentDefs([dir], warnings);
      expect(defs.find((def) => def.name === "lead")?.taskBudgetTokens).toBe(64_000);
      expect(defs.find((def) => def.name === "low")?.taskBudgetTokens).toBeUndefined();
      expect(warnings.join(NL)).toContain(
        '"taskBudgetTokens" must be a whole number of at least 20000',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
