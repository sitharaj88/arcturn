# Integrating structured outputs, strict tools and task budgets

Until the 2026-10-10 "the engine uses the API it has" wave, a workflow
`[contract: …]` step asked the model for JSON in prose, hunted for the last
fenced ` ```json ` block in the reply, and validated it. Every API Arcturn talks
to can constrain a reply to a schema; the engine did not ask. This note records
the seams that changed. Nothing here is a wiring recipe still to apply — the code
is in the tree, and the reasoning below is why it has this shape.

Three features share the plumbing, so they share a note: a response format for
the reply text, `strict` on tool schemas, and a token budget the model paces
itself against.

## Public surface

```ts
// @arcturn/types
interface ResponseFormat { name: string; schema: JsonSchema; strict?: boolean }
interface TaskBudget     { total: number; remaining?: number }
LLMRequest.responseFormat?: ResponseFormat;
LLMRequest.taskBudget?: TaskBudget;
ModelCapabilities.structuredOutput?: boolean;   // inferred when absent
ModelCapabilities.taskBudget?: boolean;         // inferred when absent
ToolDefinition.strict?: boolean;
ToolDefinition.eagerInputStreaming?: boolean;
ToolCallContent.malformedArguments?: string;    // raw text that was not JSON

// @arcturn/ai
supportsStructuredOutput(spec): boolean;  supportsTaskBudget(spec): boolean;
TASK_BUDGET_MIN_TOKENS;  ANTHROPIC_TASK_BUDGET_BETA;
anthropicStructuredOutputModel, anthropicTaskBudgetModel, geminiVersion;
isStrictSchema, isOpenAIStrictSchema, strictSchemaCost, createStrictBudget,
ANTHROPIC_STRICT_LIMITS, withoutAdditionalProperties,
openAIStructuredOutputs, openAISchemaName;

// @arcturn/core
AgentOptions.responseFormat / .taskBudget;  Agent.setResponseFormat() / .setTaskBudget();

// @arcturn/cli (internal; packages/cli/src/contracts.ts, task-budget.ts)
contractToJsonSchema(contract); type ContractMode = "native" | "fenced";
checkContractReply(contract, text, mode);
```

## Which models are native

`supportsStructuredOutput` is inferred from the model id unless the spec declares
`capabilities.structuredOutput`:

- Anthropic, Bedrock-Claude, Vertex-Claude: Claude 4.5 and later, and Opus 4.1.
- OpenAI, Azure and OpenAI Responses: every model.
- Gemini 2.5 and later.
- A compatible endpoint, and Bedrock Converse: only when the spec says so. An
  unknown gateway is not assumed to implement `json_schema`.

A model that is not on the list gets the fenced path unchanged. There is no
flag; the choice is the capability.

## The wire, per provider

| Provider | Sent |
|---|---|
| Anthropic | `output_config.format: {type: "json_schema", schema}`. No `name`: the SDK type has none. The deprecated top-level `output_format` is never sent. |
| OpenAI Chat | `response_format: {type: "json_schema", json_schema: {name, schema, strict}}` |
| OpenAI Responses | `text.format` |
| Gemini | `responseMimeType: "application/json"` and `responseJsonSchema`, with `additionalProperties` stripped. Not `responseSchema`, which wants the OpenAPI Type dialect. |

OpenAI `strict` is downgraded to `false` when any property is optional, because
OpenAI's grammar needs every property required; sending `true` there is a 400.

## Contracts

`contractToJsonSchema` writes properties in the contract's written order, leaves
optional fields out of `required`, and puts `additionalProperties: false` on the
object. The workflow runner goes native only when
`supportsStructuredOutput(agent.model)`; it sets `agent.setResponseFormat(...)`
for the step, parses the **whole reply** as JSON (`checkContractReply(contract,
text, "native")`), and clears it afterwards.

Three things stay the same on purpose:

- **`validateContract` is the one judge on both paths.** A schema guarantees
  shape; it says nothing about a number being in range or an enum value being the
  one the workflow meant. The same validator runs on the parsed object, and the
  same single retry (the validator's messages appended) fires on a miss.
- **The hashed prompt carries the field list on both paths.** The prompt the
  engine records and hashes does not depend on which model ran the step, so a
  resume on a different model still matches.
- **Placeholders see only the validated object**, whichever path produced it.

`contractMode` is journalled: `WorkflowStepOutcome.contractMode`,
`WorkflowStepResult.contractMode`, the `StepEndLine` and the insights
`StepEndRecord`. `/workflow status` prints `contract (native): …` for a native
step. The mode is decided once, by `configureChild`, from the child agent's model when
the step starts, and `setResponseFormat` is applied only if
`supportsStructuredOutput(model)` holds; a step with no contract records none.
A failover mid-step to a model of the other kind is handled after the fact:
`answeredContractMode` re-derives the mode from the final assistant message's model
(an unknown wire name counts as fenced), so the reply is checked the way it was
produced and the journal records the mode that was actually in force, not the one
chosen at the start.

## Strict tools

`strict: true` is set on `read`, `write`, `edit`, `bash`, `grep`, `ls`, `fetch`,
`websearch`, `plan`, `subagent`, `tool_search`, `brain`, `memory`, `symbols`,
`skill` and `find_references`. Not on `glob`, `search_code` and `find_symbol`
(nested `oneOf`) or `todo` (its items lack `additionalProperties: false`), and
never on an MCP tool, whose schema is the server's. `strict-tools-audit.test.ts`
lists each exclusion with its reason, so a new tool must either qualify or say why
not.

Anthropic sends `strict` only if all three hold: the model has the grammar
(`anthropicStructuredOutputModel`), the schema satisfies it (`isStrictSchema`),
and the request's strict budget has room (`createStrictBudget`, against
`ANTHROPIC_STRICT_LIMITS`: 20 strict tools, 24 optional properties, 16
union-typed properties). A tool that does not fit is sent without `strict`, not
refused; the request still works. `strict` is also withheld on a tool that is
eager-streamed. OpenAI gets it only for an all-required schema; Google ignores it.

## Eager streaming, and what a malformed input does

`eager_input_streaming` goes on `write` and `edit` only, and only to first-party
Anthropic (no custom `baseUrl`, not Bedrock, not Vertex). **This is narrower than
before**: it used to go on every tool of every Anthropic-family request,
including Bedrock, where an older deployment answers 400.

With the field on, the API validates nothing, so the adapters accumulate
`partial_json` and, when it does not parse, set `malformedArguments` on the
`ToolCallContent` (and on the `toolCallEnd` event) instead of throwing or
guessing. The loop answers a call so marked before hooks, permissions or
dispatch: an error result with an explanation and
`JSON.stringify({INVALID_JSON: raw})` (raw capped at 2000 characters) and
`details.malformedArguments: true`. A call cut off by `max_tokens` is refused the
same way, never thrown. In the TUI, a `write`'s content and an `edit`'s new text
stream under the progress line.

## Task budgets

`[budget:<tokens>]` on a stage line, or `taskBudgetTokens:` in a role file,
becomes `agent.setTaskBudget({total})` for the step. The stage wins. Parsing
(`parseTaskBudget`, `taskBudgetModelError` in `task-budget.ts`) is mirrored
verbatim by `web/lib/workflow-doc.ts`, error strings included, and the parity
test covers it; the builder UI has no budget field.

- A whole number, at least 20,000 (`TASK_BUDGET_MIN`), or `line N: budget must be
  a whole number of tokens, at least 20000, got "<v>"`.
- A `[tag]` or race arm naming a Claude model without task budgets is refused
  at parse time. Supported: Opus 4.7 and later, Fable and Mythos 5 and later,
  Sonnet 5.5, Haiku 5.5, first-party Anthropic only — **not Sonnet 5**. A model
  only known at run time gets an info notice, `Task budget of N tokens not sent:
  <model> does not support pacing, so the turn ceiling is the only limit.`
- Wire: beta `task-budgets-2026-03-13` and `output_config.task_budget: {type:
  "tokens", total, remaining?}`.
- `remaining` is sent **only after a local compaction**, as `total` minus (the
  folded messages' assistant output tokens + their tool-result characters ÷ 4).
  Before any compaction the server derives the spend from the history it sees,
  and a client-computed `remaining` would double-count; on the server compaction
  shape the server owns the history, so nothing is sent.
- The turn-ceiling warning and the task budget are separate: one counts turns,
  the other tokens.

## Not verified live

All of this runs against fakes that reproduce the documented shapes. Not run
against a real endpoint: `output_config.format` and its 400s (the strict limits
included); `strict` together with `defer_loading`; `eager_input_streaming` and
its interplay with `strict`; whether the estimated `remaining` matches the
server's countdown; OpenAI Responses `text.format`; Gemini `responseJsonSchema`.
