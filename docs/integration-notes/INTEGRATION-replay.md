# Session replay — integration plan

This documents how `arcturn replay <sessionId|file> [--model X]` wires into the
existing CLI. Per the task's hard rules, **no existing file was edited** to
build this feature — `packages/cli/src/replay.ts` and
`packages/cli/src/replay.test.ts` are new, self-contained, and export
everything a `replay` subcommand needs. This document specifies the (not yet
applied) changes to `args.ts` and `main.ts` that would wire it in, mirroring
the existing `auth` and `completions` positional-command pattern exactly.

## What already exists (`packages/cli/src/replay.ts`)

- `extractPrompts(entries: readonly SessionEntry[]): string[]` — pulls the
  original user prompts out of a session's stored `SessionEntry[]` (as
  returned by `JsonlSessionStore.entries` / `.branch`), in chronological
  order, text-only. It skips assistant messages, tool results, and
  steering messages injected mid-run (identified structurally: a steering
  message's parent entry is a `toolResult` message, which no prompt
  submitted while the agent was idle can ever have — a run only ends on an
  `assistant` entry).
- `replaySession(options: { prompts: string[]; runtime: ArcturnRuntime; onTurn?
  }): Promise<ReplayResult>` — feeds each prompt to `runtime.agent.prompt()`
  in sequence via `runtime.subscribe()` (collecting `toolStart` tool names)
  and `runtime.metrics.costUsd` deltas (turnEnd cost, already summed by
  `ArcturnRuntime`). A turn that errors or aborts is recorded with `error` set
  and replay continues with the next prompt.
- `diffReplays(a: ReplayResult, b: ReplayResult): string` — a per-turn
  structural comparison (tool-call sequence match, final-text length
  divergence >20%, cost delta) plus a summary line, returned as
  human-readable text.

## New types needed only by the CLI wiring (not part of replay.ts)

These belong in `args.ts` alongside `AuthCommand` / `CompletionsCommand`
(`packages/cli/src/args.ts:31-49`):

```ts
/** A parsed `replay <sessionId|file> [--model X]` command. */
export interface ReplayCommand {
  readonly kind: "replay";
  /** A stored session id, or a path to a `.jsonl` session file. */
  readonly target: string;
  /** `--model` override for the replay run; omitted replays on the recorded model. */
  readonly model?: string;
}

export type CliCommand = AuthCommand | CompletionsCommand | ReplayCommand;

/** First positional that switches into replay-command parsing. */
export const REPLAY_COMMAND_NAME = "replay";
```

### Parsing (`args.ts`)

`parseArgs` already recognizes `--model` as a `VALUE_FLAGS` entry
(`packages/cli/src/args.ts:170-177`) and reads it into `args.model` before
positionals are inspected, exactly like `--cwd`/`--permission-mode`. The
`replay` command reuses that same `args.model` — no new flag parsing is
needed, only a new branch where `completions`/`auth` are currently checked
(`packages/cli/src/args.ts:305-320`):

```ts
if (positional[0] === COMPLETIONS_COMMAND_NAME && commandCandidates > 0) {
  // ...existing...
}

if (positional[0] === AUTH_COMMAND_NAME && commandCandidates > 0) {
  // ...existing...
}

if (positional[0] === REPLAY_COMMAND_NAME && commandCandidates > 0) {
  const target = positional[1];
  if (target === undefined || positional.length > 2 || commandCandidates < positional.length) {
    return { ok: false, error: "replay needs exactly one session id or file path" };
  }
  args.command = { kind: "replay", target, ...(args.model === undefined ? {} : { model: args.model }) };
  return { ok: true, args };
}
```

This mirrors `completions <shell>` (`args.ts:305-311`) exactly: one required
positional, reject extras, `commandCandidates < positional.length` guards
against tokens that arrived after `--` (which must stay prompt text, same
rule the `auth`/`completions` branches already enforce).

`helpText()` (`packages/cli/src/args.ts:356-362`) gains one line next to the
existing `auth`/`completions` entries:

```
  ${PRODUCT_NAME} replay <sessionId|file> [--model X]   replay a session's prompts
```

### Dispatch (`main.ts`)

`main()` already special-cases `args.command?.kind` before building a
runtime for an interactive/print run (`packages/cli/src/main.ts:88-104`). A
third branch follows the same shape:

```ts
if (args.command?.kind === "replay") {
  return runReplayCommand({
    command: args.command,
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
  });
}
```

`runReplayCommand` would live in a new `packages/cli/src/replay-command.ts`
(kept separate from `replay.ts` so the pure, unit-tested core has no CLI/IO
concerns — the same separation `print.ts` keeps from `runtime.ts`). Sketch:

```ts
export async function runReplayCommand(options: {
  command: ReplayCommand;
  cwd?: string;
}): Promise<number> {
  const { target, model } = options.command;

  // 1. Load the session's entries, from the store or a raw file.
  //    JsonlSessionStore derives its file path as `<dir>/<sessionId>.jsonl`,
  //    so a bare filename argument is handled by pointing a throwaway store
  //    at its parent directory — no new file-parsing code needed, and the
  //    real session store (packages/core/src/session/jsonl-store.ts) is
  //    reused either way instead of hand-rolling JSONL parsing again.
  const isPath = target.endsWith(".jsonl") || target.includes("/");
  const store = isPath
    ? new JsonlSessionStore({ dir: dirname(target) })
    : (await buildRuntime({ ...(options.cwd ? { cwd: options.cwd } : {}) })).store;
  const sessionId = isPath ? basename(target, ".jsonl") : target;
  const entries = await store.entries(sessionId);

  // 2. Extract prompts (pure, from replay.ts).
  const prompts = extractPrompts(entries);
  if (prompts.length === 0) {
    process.stderr.write(`arcturn: no user prompts found in ${target}\n`);
    return 1;
  }

  // 3. Build a fresh runtime — a new session id, optionally on a different
  //    model — and replay every prompt through it via runPrint's plumbing
  //    idea, minus the UI: runtime.setPermissionRequester(...) to auto-deny
  //    like print mode (packages/cli/src/print.ts:64-84), since a replay is
  //    non-interactive by construction.
  const runtime = await buildRuntime({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(model ? { model } : {}),
  });
  runtime.setPermissionRequester(undefined); // deny-by-default, same as print mode's fallback
  const replayed = await replaySession({
    prompts,
    runtime,
    onTurn: (index, prompt) =>
      process.stderr.write(`arcturn: replayed turn ${index + 1}/${prompts.length}: ${prompt.slice(0, 60)}\n`),
  });
  await runtime.dispose();

  // 4. If the source session recorded its own assistant outputs, build an
  //    "original" ReplayResult from those stored entries (no re-run: walk
  //    each prompt-to-next-prompt span, collect toolCall names from
  //    assistant `message` entries and text from the last assistant text
  //    block, cost from summed `usage.costUsd`) and print diffReplays(...).
  const original = resultFromRecordedEntries(entries, prompts); // new helper, not in replay.ts
  if (original) {
    process.stdout.write(`${diffReplays(original, replayed)}\n`);
  } else {
    for (const turn of replayed.turns) process.stdout.write(`${turn.finalText}\n`);
  }
  return replayed.turns.some((turn) => turn.error !== undefined) ? 1 : 0;
}
```

`resultFromRecordedEntries` is the one piece of new logic this wiring would
need beyond what `replay.ts` exports — it turns a session's *already
recorded* entries into a `ReplayResult` shape (same fields, no LLM call), so
`diffReplays` can compare "what actually happened" against "what happens
now, possibly on a different model". It was left out of `replay.ts` itself
because it is CLI-presentation logic (deciding what counts as "did the
original session record real outputs"), not something the task's pure,
synthetic-entry-tested core needed to own.

## Example usage

```sh
# Replay a stored session's prompts against a different model, diffing
# against what the session actually recorded.
arcturn replay 2026-08-18T10-22-01-abc123 --model anthropic/claude-opus-4-1

# Replay directly from a .jsonl file (e.g. one shared by a teammate),
# on the recorded model.
arcturn replay ./bug-report-session.jsonl
```

## Verification

- `npx vitest run packages/cli/src/replay.test.ts` — 12 tests, all passing
  (`extractPrompts` ordering/skip rules, `replaySession` sequencing/error
  handling/cost accounting, `diffReplays` match/diverge/count-mismatch
  cases).
- `npx tsc -p packages/cli/tsconfig.json --noEmit` — clean (test files are
  excluded from that project by `packages/cli/tsconfig.json`'s existing
  `exclude`, matching every other `*.test.ts` in the package; `replay.ts`
  and `replay.test.ts` were additionally typechecked together directly
  against `tsconfig.base.json`'s strict settings with no errors).
- `npx biome check packages/cli/src/replay.ts packages/cli/src/replay.test.ts`
  — clean, no findings.
- No new dependencies: `replay.ts` imports only `@arcturn/types` (already
  a `packages/cli` dependency) and the package's own `runtime.ts`.
