# Wiring deterministic workflows into the CLI

Integration recipe for `packages/cli/src/workflow.ts` (new file, already in the
tree with `workflow.test.ts`). No existing file was edited — everything below
is an exact instruction for whoever wires it in.

The idea in one line: a **workflow** is a markdown file whose numbered list *is*
the control flow — `/workflow ship-fix <args>` runs those steps in that order,
fanning out where the file nests bullets, piping each step's output into the
next, every single time. `team.ts` lets a model decide the shape of a
multi-agent run; a workflow fixes the shape in the file and lets the model fill
in only the content.

---

## 1. What's already built

`packages/cli/src/workflow.ts` exports:

```ts
// --- the definition ------------------------------------------------------
interface WorkflowStep  { id; stageIndex; branchIndex; modelTag?; prompt }
interface WorkflowStage { index; parallel; label?; steps: readonly WorkflowStep[] }
interface Workflow      { name; description; continueOnError; stages; source }
interface WorkflowParseError { error: string }
function isWorkflowParseError(value: object): value is WorkflowParseError;

function parseWorkflow(
  raw: string,
  defaults?: { name?: string; source?: string },
): Workflow | WorkflowParseError;

function discoverWorkflows(
  roots: readonly string[],
  warnings?: string[],
): Promise<Workflow[]>;

// --- execution -----------------------------------------------------------
type WorkflowStepRunner = (request: WorkflowStepRequest) => Promise<WorkflowStepOutcome>;
type ModelTagResolver   = (tag: string) => ModelSpec | undefined;

interface WorkflowStepRequest { step: WorkflowStep; prompt: string; model?: ModelSpec; signal: AbortSignal }
interface WorkflowStepOutcome { text: string; usage: Usage; isError: boolean; error?: string }

interface WorkflowRunContext {
  runStep: WorkflowStepRunner;          // required — the only injection point
  input?: string;                       // splices into {{input}}
  resolveModel?: ModelTagResolver;      // required only if a step uses "[tag]"
  onEvent?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
  now?: () => number;
}

function runWorkflow(workflow: Workflow, context: WorkflowRunContext): Promise<WorkflowRunResult>;
function expandStepPrompt(template: string, prev: string, input: string): string;

type WorkflowStepStatus = "done" | "failed" | "skipped" | "cancelled";
type WorkflowRunStatus  = "done" | "failed" | "cancelled";
interface WorkflowStepResult { id; stageIndex; branchIndex; modelTag?; prompt; status; text; usage; error?; startedAt?; endedAt? }
interface WorkflowRunResult  { workflow; status; steps; text; usage; error?; startedAt; endedAt }

// --- progress ------------------------------------------------------------
type WorkflowEvent =
  | { type: "workflowStart"; workflow: string; totalSteps: number }
  | { type: "stageStart"; stageIndex: number; parallel: boolean; steps: number }
  | { type: "stepStart"; id: string; stageIndex: number; branchIndex: number; modelTag?: string; prompt: string }
  | { type: "stepEnd"; result: WorkflowStepResult }
  | { type: "stageEnd"; stageIndex: number; status: WorkflowStepStatus; text: string }
  | { type: "workflowEnd"; result: WorkflowRunResult };

function reportWorkflowEvent(event: WorkflowEvent, ui: Pick<CommandUi, "notice">): void;

// --- production bindings -------------------------------------------------
interface WorkflowChildAgent { subscribe; prompt; abort; finalText }   // structural slice of `Agent`
interface WorkflowAgentHost  { createSubagent(task: string, def?: AgentDef): WorkflowChildAgent }
interface WorkflowCommandRuntime extends WorkflowAgentHost { paths: { home: string; project: string } }

const WORKFLOW_STEP_SYSTEM_PROMPT: string;
function createRuntimeRunStep(
  host: WorkflowAgentHost,
  options?: { systemPrompt?: string; tools?: readonly string[] },
): WorkflowStepRunner;

function createWorkflowCommands(options?: {
  resolveModelTag?: ModelTagResolver;
  step?: { systemPrompt?: string; tools?: readonly string[] };
  discover?: (roots: readonly string[], warnings: string[]) => Promise<Workflow[]>;
}): SlashCommand[];   // one command: "workflow"
```

`workflow.ts` imports **no** runtime value: `AgentDef` and the `commands.ts`
types are type-only imports, and the runtime is taken structurally through
`WorkflowAgentHost` / `WorkflowCommandRuntime`. A live `ArcturnRuntime`
satisfies both as-is, so there is nothing to add to `runtime.ts` — unlike
scouts, and for the same reason `background-agents.ts` needs nothing there.

---

## 2. `commands.ts` — the one registration line

`createCommandRegistry()` registers the built-ins and then extension commands.
Add `/workflow` right after `/bg`, and pass a model-tag resolver (see §4):

```ts
// commands.ts
import { resolveModelSpec } from "./runtime.js";      // already imported by runtime consumers
import { createWorkflowCommands } from "./workflow.js";

export function createCommandRegistry(
  extensionCommands: readonly ExtensionCommand[] = [],
  warn?: (message: string) => void,
): CommandRegistry {
  const registry = new CommandRegistry();
  registry.registerAll(createBuiltInCommands());
  registry.registerAll(createBackgroundAgentCommands());
  registry.registerAll(
    createWorkflowCommands({
      // A "[tag]" is just a catalog id or preset name. Unknown ids resolve to
      // `undefined`, which fails the run *before* any step spends a token.
      resolveModelTag: (tag) => {
        try {
          return resolveModelSpec(tag);
        } catch {
          return undefined;
        }
      },
    }),
  );                                                    // <-- add these lines
  for (const command of extensionCommands) {
    /* ... unchanged ... */
  }
  return registry;
}
```

That is the entire required wiring.

| input | effect |
| --- | --- |
| `/workflow` or `/workflow list` | lists discovered workflows: name, stage/step counts, description |
| `/workflow ship-fix the retry test flakes` | runs `ship-fix` with `the retry test flakes` as `{{input}}` |

A workflow named `list` would be unreachable — the same accepted sub-verb
tradeoff `/bg logs|cancel|adopt` already makes. Ctrl+C (`SIGINT`) during a run
aborts it; in-flight steps get an aborted signal, later stages report `skipped`.

**Completions (optional, one line).** If `completions.ts` enumerates argument
candidates per command, feed it `discoverWorkflows` over the same roots as §3.

---

## 3. Where workflow files live

Exactly beside markdown skills and agents, user root first so a project file
shadows a user file of the same name:

```
~/.arcturn/workflows/<name>.md         # user
<cwd>/.arcturn/workflows/<name>.md     # project (wins)
```

The command derives them itself from `runtime.paths`:

```ts
[...new Set([join(paths.home, "workflows"), join(paths.project, "workflows")])]
```

If `runtime.ts` ever grows an eager loader for workflows (the way it eagerly
loads skills and agent defs), mirror the skills block verbatim:

```ts
// runtime.ts — createArcturnRuntime(), right after loadAgentDefs(...)
const workflows = await discoverWorkflows(
  [...new Set([join(paths.home, "workflows"), join(paths.project, "workflows")])],
  warnings,
);
```

This is **not required** — `/workflow` discovers on each invocation, so a file
added mid-session is picked up without a restart. Eager loading only buys you
frontmatter warnings at startup.

### File format (strict, by design)

```md
---
name: ship-fix
description: Reproduce, patch and review one bug report
continueOnError: false
---
Optional prose here is documentation and is ignored.

1. [anthropic/claude-haiku-4-5] Reproduce this bug and quote the failing output: {{input}}
2. Given the repro below, do both halves:
   - Write the minimal patch. Repro: {{prev}}
   - Write a regression test that fails before the patch. Repro: {{prev}}
3. Review the patch and the test for correctness. Work so far: {{prev}}
```

- Top-level numbered items (`1.` / `1)`) are **stages**, run in order, and must
  be numbered consecutively from 1.
- Indented `-` bullets under a numbered item are **parallel branches** of that
  stage. Their outputs are joined with a blank line in **written** order, never
  completion order, so the pipe is reproducible.
- A numbered line may carry a prompt **or** branches, not both — unless it ends
  with `:`, which marks it as a label.
- `[tag]` prefix → model, via the resolver from §2. `{{prev}}` → previous
  stage's combined output. `{{input}}` → the `/workflow` args.
- Everything else is a parse error with a line number: unknown placeholders,
  `{{prev}}` in step 1, top-level bullets, `*` branches, prose after the list
  (one line is one step; there are no continuation lines), a non-boolean
  `continueOnError`.

Step ids are `"2"` for a lone step in stage 2 and `"2.1"`, `"2.2"` for its
branches — that is what `WorkflowStepResult.id` and the notices show.

---

## 4. Model tags and the resolver

`workflow.ts` never touches `@arcturn/ai`'s catalog. Every `[tag]` is resolved
**up front**, before the first step runs:

- resolver missing → the run fails with *"workflow uses model tag "[x]" but no
  model resolver was supplied"*;
- resolver returns `undefined` → *"unknown model tag "[x]" (step 2.1)"*.

Either way `steps` come back all-`skipped` and `usage` is zero: a workflow whose
last step names a dead model must not cost two paid steps first. Wire the
resolver as in §2, or point it at a config map (`config.workflowModels`) if you
prefer symbolic tags (`fast`, `smart`) over catalog ids — the parser accepts
`[A-Za-z0-9._/-]+`, so both spellings work.

## 5. Wiring `runStep` to real agents

`createWorkflowCommands` already calls `createRuntimeRunStep(runtime)`. Anything
driving a workflow outside the slash command (a server route, `--print` mode, a
scheduled run) does the same:

```ts
import { createRuntimeRunStep, discoverWorkflows, runWorkflow } from "./workflow.js";

const [workflow] = await discoverWorkflows([join(paths.home, "workflows")]);
const result = await runWorkflow(workflow, {
  runStep: createRuntimeRunStep(runtime),
  input: argv.args,
  resolveModel: (tag) => { try { return resolveModelSpec(tag); } catch { return undefined; } },
  signal: controller.signal,
});
```

`createRuntimeRunStep` builds **one child `Agent` per step** through
`ArcturnRuntime.createSubagent(prompt, def)`, which is deliberate: the step
inherits the parent's permission mode, its stored rules, hook/checkpoint/canary
tool wrapping and — importantly — the parent's **cost accounting** (a
sub-agent's `turnEnd` is already folded into `runtime.metrics` there), so a
workflow does not need `recordExternalCost` the way `/scout` does.

The `def` it passes:

| field | value |
| --- | --- |
| `name` | `workflow-step-<id>` |
| `description` | `Workflow step <id>` |
| `systemPrompt` | `WORKFLOW_STEP_SYSTEM_PROMPT` ("your whole reply is piped into the next step — no preamble"), overridable via `options.systemPrompt` |
| `model` | the resolved `ModelSpec.id`, omitted when the step had no `[tag]` (then the `subagent` route decides) |
| `tools` | omitted by default (the runtime's own non-`yolo` read-only filter applies); `options.tools` narrows further, and per `runtime.ts` can only ever narrow, never widen |

A step's outcome is `isError: true` whenever the child's `runEnd` reason is not
`"completed"`; the step's text is then dropped rather than piped, so a failed
step never poisons `{{prev}}` with half an answer.

If you prefer background agents' durability over an in-process child, swap the
runner — that is the whole point of the injection point:

```ts
runStep: async ({ prompt, model, signal }) => {
  const manager = getBackgroundAgentManager(runtime);
  const { id } = manager.start({ task: prompt, ...(model ? { model } : {}) });
  signal.addEventListener("abort", () => manager.cancel(id), { once: true });
  const status = await manager.result(id);
  return {
    text: status?.finalText ?? "",
    usage: status?.usage ?? emptyUsage(),
    isError: status?.status !== "done",
    ...(status?.error ? { error: status.error } : {}),
  };
},
```

Note the tradeoff: background agents are durable and survive a restart, but they
queue against the manager's `concurrency` cap (default 3), so a 5-branch stage
serialises into two waves.

---

## 6. Progress → `AgentEvent` for the TUI

`WorkflowEvent` is its own union because stages, branches and skips have no
`AgentEvent` counterpart. The slash command already maps it onto `ui.notice`
via `reportWorkflowEvent`. A host that pushes into the runtime's own event
stream instead maps it to `notice` events:

```ts
import type { AgentEvent } from "@arcturn/types";
import type { WorkflowEvent } from "./workflow.js";

export function workflowNotice(event: WorkflowEvent): AgentEvent | undefined {
  switch (event.type) {
    case "workflowStart":
      return { type: "notice", level: "info", text: `Workflow ${event.workflow}: ${event.totalSteps} step(s).` };
    case "stageStart":
      return event.parallel
        ? { type: "notice", level: "info", text: `Stage ${event.stageIndex}: ${event.steps} branches in parallel…` }
        : undefined;
    case "stepStart":
      return { type: "notice", level: "info", text: `Step ${event.id} started.` };
    case "stepEnd":
      return event.result.status === "done"
        ? { type: "notice", level: "info", text: `Step ${event.result.id} done.` }
        : {
            type: "notice",
            level: event.result.status === "failed" ? "error" : "warn",
            text: `Step ${event.result.id} ${event.result.status}${event.result.error ? `: ${event.result.error}` : ""}`,
          };
    case "workflowEnd":
      return {
        type: "notice",
        level: event.result.status === "done" ? "info" : event.result.status === "failed" ? "error" : "warn",
        text: `Workflow ${event.result.workflow}: ${event.result.status}.`,
      };
    default:
      return undefined;
  }
}
```

Then `onEvent: (event) => { const notice = workflowNotice(event); if (notice) runtime.emit(notice); }`
wherever the host already forwards synthesized events (use `runtime.notify(level, text)`
if that is the only sink available). `stageEnd` is intentionally silent by
default — it carries the stage's full combined text, which belongs in a panel
or the transcript, not in a one-line notice.

Listener errors are caught and swallowed inside `runWorkflow`: a UI bug must
never fail a paid run.

### 6a. Live rows while a step is running

Those notices are the permanent transcript record: one line when a step starts,
one when it ends. In between, a step runs for *minutes*. The main agent is idle
(so the app's spinner never starts) and a role agent is a separate `Agent` whose
events never reach the session's stream — so the screen freezes and a working
pipeline is indistinguishable from a hung one.

Every step therefore republishes its own child's stream onto the session's
stream as `subagentStart` / `subagentEvent` / `subagentEnd`, namespaced by
`workflowStepAgentId(step.id, role)` (`step-2.1:qa` — a parallel stage is
several concurrent rows, and the same role in a later stage is a new one). That
is the exact shape the `subagent` tool publishes, so the app's **existing**
`SubagentTracker` rows (`interactive/activity.ts`, rendered by
`renderSubagentRows`) show the role, its elapsed time, its token count and the
tool it is running right now — with no UI code that knows workflows exist. The
row opens and closes inside `driveAgent`'s `try`/`finally`, so a cancelled,
failed or throwing step can never leave a ghost row behind.

The sink is `RuntimeRunStepOptions.emit`, wired inside `createWorkflowCommands`
from `WorkflowCommandRuntime.emit`. Both are optional: a host with no live
region omits them and pipelines behave exactly as before. **It stays dormant
until `ArcturnRuntime` exposes one public method**, next to `notify` in
`runtime.ts`:

```ts
  /**
   * Publish an event onto this runtime's stream, as though the live agent had
   * emitted it. `notify` is the notice-shaped special case; a host that drives
   * its own agents (`/workflow`) needs the general form to make their activity
   * visible in the session's live region.
   *
   * @param event - The event to publish.
   */
  emit(event: AgentEvent): void {
    this.#onEvent(event);
  }
```

Route it through `#onEvent`, not straight at `#listeners`: that is the one path
extensions, the audit log and the provenance store already see. It cannot
double-count cost — the only top-level events a workflow publishes are the
three `subagent*` ones, and `#onEvent` accounts `turnEnd` at the top level
only, exactly as it already does for the `subagent` tool's children
(`auditObserver` and `provenanceObserver` deliberately do not unwrap
`subagentEvent` either).

---

## 7. Failure and cancellation semantics (the contract to preserve)

- **Parallel branches always run to completion.** A sibling's failure does not
  cancel work already in flight — those tokens are already spent, and the
  partial result may still be useful in the transcript.
- **A failed stage short-circuits every later stage**, which is reported as
  `skipped` (no timestamps, zero usage). `continueOnError: true` disables the
  short-circuit; the run still ends `failed` and `error` still names the first
  failure, so a caller can never mistake it for a clean run.
- **`{{prev}}` carries only what the stage actually produced.** An all-failed
  `continueOnError` stage hands the next stage an empty string rather than
  stale text from two stages back.
- **Abort** marks in-flight steps `cancelled`, the remainder `skipped`, and the
  run `cancelled` — distinct from `failed`, because nothing went wrong.
- **`runWorkflow` never rejects.** A `runStep` that throws becomes a failed step
  carrying `errorText(error)`; every other problem is a non-`"done"`
  `WorkflowRunResult`. This mirrors `Agent.prompt`'s "errors as a terminal
  event, not a rejection" contract.
- **Determinism is the feature.** Output concatenation is written order, ids are
  positional, and nothing in the module reads the clock except through
  `context.now`. Keep it that way when extending it.
