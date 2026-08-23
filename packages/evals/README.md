# @arcturn/evals

A **task-level eval harness** for the [Arcturn](../../README.md) agent. Arcturn's other ~1255 tests prove
the plumbing works — the event loop, the tool contracts, the permission engine. None of them ask
the question that actually matters: *does the agent complete a real coding task?* This package
answers that, with a real driven agent and programmatic, non-LLM-judged grading.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @arcturn/evals build
node packages/evals/dist/main.js run
```

---

## Be honest about what this measures

- **Scores depend on the model.** A pass rate is only meaningful next to the model id it was run
  against (`--model`, recorded in every JSON report). Comparing runs across different models with
  `arcturn-evals compare` is comparing two different things, not a regression check — it is honest as
  "model A got 12/18, model B got 15/18", not as "the harness got worse."
- **The suite is still small.** Eighteen tasks is enough to show a real difficulty spread and to
  catch gross regressions, not enough to be a serious capability benchmark. It is deliberately built
  so a strong model is expected to fail several of the harder tasks — a perfect score is a signal
  worth double-checking (did the agent actually solve it, or did a hidden verifier bug let it
  through?), not proof the model "can code." Treat any single number as a rough signal, not a grade.
- **Grading is programmatic on purpose.** Every assertion is a file check, a regex, or a real
  command's exit code — never an LLM judging another LLM's work. This is stricter and more honest,
  but it also means a task can only test what you can articulate as code. Some real capabilities
  (taste, judgment, communication) are outside what this harness can grade.
- **Non-determinism is real.** The same task against the same model can pass one run and fail the
  next. Do not trust a single run; look at trends across several, and read `finalText` and
  `workspaceDir` (kept on failure) before concluding the model "can't" do something.

---

## How it works

1. **`EvalTask`** (`src/task.ts`) — a prompt, a `setup(dir)` that materializes a fixture into an
   empty temp directory, and a list of `Assertion`s that grade the result.
2. **`runTask`** (`src/runner.ts`) — creates an isolated temp workspace, runs `setup`, builds a
   real agent via an injected `agentFactory`, drives it to completion (or until `timeoutMs`
   elapses), then grades every assertion. Captures per-task pass/fail, turns, tool calls (by
   name), token usage, cost, wall time and the final assistant text. The workspace is deleted on
   success and **kept on failure** — inspect `result.workspaceDir` to see exactly what the agent
   left behind.
3. **`runSuite`** (`src/suite.ts`) — runs a list of tasks under a concurrency cap and aggregates
   pass rate, cost and tokens into a `SuiteResult`.
4. **`renderTable` / `writeReport` / `compare`** (`src/report.ts`) — a readable terminal table, a
   diffable JSON artifact, and a diff between two JSON runs that calls out **regressions**: a task
   that passed before and fails now.
5. **The task suite** (`src/tasks/`) — eighteen small, self-contained fixtures: the original six
   warm-up tasks plus a harder expansion set (see below).
6. **`arcturn-evals` CLI** (`src/main.ts`) — `run` drives a real agent; `compare` diffs two reports.

### The starter suite

Every fixture is plain Node (`.mjs`, no `npm install` required) and ships a hidden
`.eval/verify.mjs` the prompt never mentions — an independent functional check, so a task can't be
gamed by an agent that writes a matching-but-shallow test or deletes an inconvenient one. These six
are deliberately small — a competent agent should pass essentially all of them.

| Task id | Tags | Measures |
| --- | --- | --- |
| `fix-failing-sum-test` | `fix-bug`, `small`, `easy` | Fix a one-line bug (wrong operator) in a failing test suite, without touching the tests. |
| `clamp-edge-cases` | `implement`, `edge-case`, `small`, `easy` | Implement a function correctly, including a real edge case (inverted `min`/`max` bounds). |
| `rename-compute-total` | `rename`, `multi-file`, `easy` | Rename a symbol and every call site across multiple files; a pre-written test forces the rename to actually happen. |
| `fix-binary-search-bug` | `fix-bug`, `find-bug`, `easy` | Find and fix an *unhinted* off-by-one bug with no clue where it is. |
| `handle-invalid-config` | `error-handling`, `easy` | Replace uncaught exceptions with a proper error-result shape. |
| `catch-discount-bug` | `write-test`, `fix-bug`, `easy` | Write a regression test that reproduces a real bug, then fix the bug — tests both test-writing and debugging. |

### The expansion suite

Twelve harder tasks, added to give the suite a real difficulty spread — several of these are
expected to trip up even a strong model. Same rules as the starter suite: plain Node, no installs,
a hidden `.eval/verify.mjs` the prompt never mentions. Several also encode a *trap*: an obvious or
"looks right" fix that a hidden check catches (deleting caching, patching only the symptom,
scrambling order while fixing data, writing a test that doesn't actually reproduce the bug).

| Task id | Tags | Measures |
| --- | --- | --- |
| `multifile-library-loan-return` | `multi-file`, `state-management`, `hard` | Implement a feature (`returnBook`) whose correct behavior requires reading and editing three files consistently — the state in the other two is private, so the fix can't be faked by reaching into internals. |
| `debug-stale-price-cache` | `debugging`, `trap`, `multi-file`, `hard` | The failing test points at `store.mjs`; the real bug is a missing cache invalidation in a different file. The obvious fix (delete the cache) passes the visible test but fails a hidden check that the cache is still doing its job. |
| `trap-dedupe-keep-first` | `trap`, `edge-case`, `hard` | Fix a "last write wins" bug without breaking the documented order-preservation invariant — the natural "iterate in reverse" fix keeps the right data but scrambles order. |
| `async-concurrent-task-pool` | `async`, `concurrency`, `hard` | Fix a race in a concurrency-limited promise pool that collects results by completion order (`push`) instead of input order. |
| `compat-duration-format` | `backwards-compat`, `api-design`, `medium` | Add an optional compact mode to an existing function while keeping every existing call byte-identical to before. |
| `perf-quadratic-duplicates` | `perf`, `hard` | Replace an accidentally-quadratic implementation with a near-linear one; graded by a runtime bound generous enough to be stable on any machine but tight enough to fail unfixed O(n²) code. |
| `edge-truncate-unicode` | `edge-case`, `unicode`, `medium` | Truncate a string by Unicode code point, not UTF-16 code unit — never split a surrogate pair — plus non-positive and very large length edge cases. |
| `async-single-flight-memoize` | `write-test`, `async`, `debugging`, `hard` | Write a test that reproduces a stale-forever async memoization bug, then fix it. The hidden verifier re-runs the agent's own test against the original buggy code and requires it to fail there, catching a shallow test that would pass either way. |
| `debug-shared-range-helper` | `debugging`, `multi-file`, `find-bug`, `hard` | Two unrelated-looking test failures in two different files trace back to one off-by-one bug in a shared helper; patching either symptom locally leaves the other (and the helper) still broken. |
| `edge-sum-dollars-precision` | `edge-case`, `numeric`, `medium` | Fix floating-point drift in a money summation so it stays exact to the cent, verified at both small and very large (a million-item) scale. |
| `edge-csv-row-parser` | `edge-case`, `parsing`, `hard` | Implement CSV-line parsing (quoted fields, doubled-quote escaping, empty fields) correctly, not just a naive comma split. |
| `edge-word-frequency-unicode` | `edge-case`, `unicode`, `medium` | Fix a word-frequency counter that only recognizes ASCII word characters, so accented and non-Latin words get mis-split. |

Task ids are prefixed by kind (`multifile-`, `debug-`, `async-`, `compat-`, `perf-`, `edge-`,
`trap-`) so `--tasks "debug-*"` (etc.) already works today, since the CLI's `--tasks` matches task
ids. Every task also carries richer `tags` (including a difficulty tag: `easy`, `medium` or `hard`)
for any tool or script that filters on `EvalTask.tags` directly — the CLI itself does not currently
glob on tags, only on ids.

### Adding a task

Add a file to `src/tasks/`, export an `EvalTask`, and list it in `src/tasks/index.ts`'s
`ALL_TASKS`. Keep it small and self-contained (plain Node, no package installs), write a hidden
`.eval/verify.mjs` that checks the real behavior independently of anything the agent might write
itself, and prefer `commandSucceeds` / `fileContains` / `custom` over anything that requires
another LLM call to grade. Then add a row to `src/tasks/tasks.test.ts` that proves the task is
honest: assertions fail against the unsolved fixture, and pass once you apply the correct fix by
hand.

```ts
import { commandSucceeds } from "../task.js";
import type { EvalTask } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

export const myTask: EvalTask = {
  id: "my-task",
  description: "one line describing what this measures",
  prompt: "the exact prompt handed to the agent",
  setup: (dir) => writeFixtureFiles(dir, { "file.mjs": "...", ".eval/verify.mjs": "..." }),
  assertions: [commandSucceeds("node --test"), commandSucceeds("node .eval/verify.mjs")],
  timeoutMs: 3 * 60_000,
  tags: ["fix-bug"],
};
```

---

## CLI

```
arcturn-evals run [options]
arcturn-evals compare <a.json> <b.json>
```

| `run` option | Description |
| --- | --- |
| `--model <id>` | Model id to drive the agent with (default: `anthropic/claude-sonnet-4-5`). |
| `--tasks <glob>` | Only run tasks whose id matches this glob, e.g. `--tasks "fix-*"`. |
| `--concurrency <n>` | Maximum tasks run at once (default `4`). |
| `--json <path>` | Also write the full JSON report to this path. |

```bash
# Run the whole suite against the default model.
export ANTHROPIC_API_KEY=sk-ant-...
node packages/evals/dist/main.js run --json runs/sonnet.json

# Run just the harder debugging tasks against a different model.
node packages/evals/dist/main.js run --model openai/gpt-5.1 --tasks "debug-*" --json runs/gpt51.json

# Diff two runs and flag regressions (exit code 1 if any).
node packages/evals/dist/main.js compare runs/sonnet.json runs/gpt51.json
```

`run` needs a real API key and network access — that is expected and correct for this tool. There
is no honest way to measure whether an agent completes a task without actually running one; it
fails fast with a clear message (exit code `2`) when no key is configured, before touching the
network. Each task gets its own agent, built the exact same way the `arcturn` binary itself is (via
`arcturn`'s `buildRuntime`, in `permissionMode: "yolo"` since there is no user to answer a
prompt), under a throwaway `ARCTURN_HOME` so a suite run never touches your real `~/.arcturn` session or
checkpoint state. `run` exits `1` if any task failed; `compare` exits `1` if any task regressed.

### Programmatic use

```ts
import { ALL_TASKS, runSuite, renderTable, writeReport } from "@arcturn/evals";
import { buildRuntime } from "arcturn";

const suite = await runSuite(ALL_TASKS, {
  model: "anthropic/claude-sonnet-4-5",
  concurrency: 4,
  agentFactory: async (cwd) => {
    const runtime = await buildRuntime({ cwd, model: "anthropic/claude-sonnet-4-5", permissionMode: "yolo" });
    return { agent: runtime.agent, dispose: () => runtime.dispose() };
  },
});

console.log(renderTable(suite, { color: true }));
await writeReport(suite, "run.json");
```

---

## Development

```bash
pnpm --filter @arcturn/evals build
pnpm --filter @arcturn/evals typecheck
npx vitest run packages/evals/src
```

Every unit test runs with no network and no API key: a scripted, deterministic fake `LLMClient`
(`src/test-helpers/fake-llm.ts`) drives a real `@arcturn/core` `Agent` through a small set of
real-filesystem fake tools (`src/test-helpers/fake-tools.ts`), so the runner, suite aggregation and
reporting are all exercised against real tool calls and real workspace files — only the model call
itself is faked. `src/tasks/tasks.test.ts` proves every fixture in the suite (starter and
expansion) is honest by grading it unsolved (expects at least one failing assertion) and again
after applying the correct fix by hand (expects every assertion to pass) — with no agent involved.
Several of the harder tasks get an extra case proving the hidden verifier specifically catches the
task's obvious cheap cheat (e.g. removing a cache, patching only the visible symptom, a test that
doesn't actually reproduce the bug) even when that cheat happens to pass the visible tests. A final
`describe("ALL_TASKS invariants", ...)` block asserts suite-wide properties: every task id is
unique, every prompt and description is non-empty, every task has at least one assertion, and no
prompt leaks the hidden verifier's existence or path.

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
