# Integrating VCR mode

`packages/cli/src/vcr.ts` is complete, tested (`vcr.test.ts`, 36 tests) and **wired
into nothing**. It was written as new files only — no existing file was touched.
This document is the hand-off: exactly which edits turn it into `arcturn record` /
`arcturn replay --cassette`, and how it relates to the live replay that already
exists.

---

## 1. What the module gives you

```ts
import {
  createCassetteRecorder,   // (file) -> { recordLlm, recordTool, close }
  loadCassette,             // (file) -> Promise<Cassette>  { takeLlm, takeTool, stats }
  recordingClient,          // (inner: LLMClient, recorder) -> LLMClient
  replayingClient,          // (cassette, { onMiss?: "throw" | "error-event" }) -> LLMClient
  wrapToolsWithRecorder,    // (tools, recorder) -> Tool[]   (runs the real tool, tees the result)
  replayTools,              // (tools, cassette) -> Tool[]   (NEVER runs the real tool)
  requestKey, toolKey, canonicalJson,
  CassetteError,            // code: "miss" | "corrupt" | "closed"
} from "./vcr.js";
```

A cassette is one JSONL file, one interaction per line:

```json
{"kind":"llm","v":1,"key":"<sha256>","seq":0,"events":[ …StreamEvent… ]}
{"kind":"tool","v":1,"key":"<sha256>","seq":0,"name":"read","result":{"content":[…]}}
```

### Key derivation (the part that decides whether this works)

`requestKey(request)` = sha256 of canonical JSON over **model id + system prompt +
normalized message list**, domain-separated with `kind:"llm"`.

Excluded on purpose:

| Excluded | Why |
| --- | --- |
| `tools` | Tool definitions are rebuilt from config on every start. A reworded description or a reordered list would invalidate a whole cassette while changing nothing about the conversation. A genuinely different tool set changes the assistant's output, which changes the message list, which changes every later key anyway. |
| `maxOutputTokens`, `temperature`, `thinking` | Sampling knobs. A cassette records one concrete outcome; keying on the knobs would let an unrelated config tweak throw the recording away. |
| `signal` | An `AbortSignal` is not data and is not serializable. |
| `providerOptions` | Provider routing / beta headers — not a description of the conversation. |
| `Message.timestamp` (all roles) | Wall clock: different on every run by construction. |
| `AssistantMessage.usage` | Provider token accounting plus a `costUsd` derived from a pricing table that is updated independently of behaviour. |

Kept, deliberately: the assistant's `model`, `stopReason`, `errorMessage`,
thinking `signature` blobs, and tool-result `details`. All of them are part of
what the next request literally says, and all of them round-trip byte-exactly
because replay rebuilds history from the recorded events.

`toolKey(name, input)` = sha256 of canonical JSON over `{ name, input }`. cwd,
session id and the provider-assigned tool-call id are **not** in the hash — the
tool-call id differs on every run and would make every key a miss.

`canonicalJson` sorts object keys recursively, so `{path, limit}` and
`{limit, path}` hash identically. Arrays keep their order. Nothing in key
derivation reads the clock, the RNG, the environment or the filesystem.

### Repeats and `seq`

The same key recurs legitimately (the agent reads the same file twice). Each
entry carries a `seq` counting occurrences *of that key*: first recording gets
`seq: 0`, second `seq: 1`. `takeLlm`/`takeTool` consume in `seq` order, so the
second read gets the second recorded result. A third call when only two were
recorded is a miss. Matching is by content hash, never by position, so inserting
a turn earlier in a run does not shift every later response by one.

### Failure behaviour

- **LLM miss** → `CassetteError { code: "miss", key, entryKind: "llm" }`, message
  names the key and the model. With `onMiss: "error-event"` it instead yields one
  terminal `error` event (assistant message `timestamp: 0`, because a replay must
  be reproducible byte for byte) so the loop finishes and you can see how far the
  run got before diverging.
- **Tool miss** → an `isError` `ToolResult` whose text names the tool and the key.
  It does not throw: the loop keeps going and the transcript shows exactly where
  the run left the recording. The real tool still does not run.
- **Torn last line** (crash mid-append) → dropped, counted in
  `stats().skippedLines`. A malformed line *anywhere else* is
  `CassetteError { code: "corrupt" }`, because silently skipping it would let
  replay serve the wrong response to a later call.

### Writing discipline

Appends are serialized through one promise chain, mirroring
`JsonlSessionStore.append`: concurrent `recordTool` calls can never interleave
their bytes, each line reaches the file in a single `appendFile`, and `seq` is
assigned synchronously at call time so it reflects the order interactions
*happened* even while their writes are in flight. `close()` flushes and refuses
further writes.

---

## 2. CLI sketch — `packages/cli/src/args.ts`

Mirrors the existing positional-command shape (`replay`, `serve`, `audit`) exactly.

### 2a. New command type + name constant

Alongside `ReplayCommand` (args.ts:48-54) and `REPLAY_COMMAND_NAME` (args.ts:174):

```ts
/** A parsed `record <prompt>` command. */
export interface RecordCommand {
  /** Command family. */
  readonly kind: "record";
  /** Prompt to run while recording. */
  readonly prompt: string;
}

/** First positional that switches into record-command parsing. */
export const RECORD_COMMAND_NAME = "record";
```

…and add `RecordCommand` to the `CliCommand` union (args.ts:87-94).

### 2b. `--cassette` flag

Add `"--cassette"` to `VALUE_FLAGS` (args.ts:240-251), a field on `CliArgs`:

```ts
  /** `--cassette <file>`: cassette to write (record) or read (replay). */
  cassette?: string;
```

and a case in the flag switch:

```ts
      case "--cassette":
        args.cassette = value;
        break;
```

### 2c. Positional parsing

`record` gets its own branch, placed with the others (before the final
`args.prompt = positional.join(" ")` at args.ts:481). It takes the remaining
positionals as prompt text, exactly like a bare invocation does:

```ts
  if (positional[0] === RECORD_COMMAND_NAME && commandCandidates > 0) {
    const prompt = positional.slice(1).join(" ");
    if (prompt === "") {
      return { ok: false, error: 'record needs a prompt (arcturn record "your question")' };
    }
    if (args.cassette === undefined) {
      return { ok: false, error: "record needs --cassette <file>" };
    }
    args.command = { kind: "record", prompt };
    args.prompt = "";
    return { ok: true, args };
  }
```

The existing `replay` branch (args.ts:451-459) relaxes its positional to allow
the cassette form, keeping the live form unchanged:

```ts
  if (positional[0] === REPLAY_COMMAND_NAME && commandCandidates > 0) {
    const target = positional[1];
    if (positional.length > 2) {
      return { ok: false, error: "replay needs exactly one session id or file path" };
    }
    if (target === undefined && args.cassette === undefined) {
      return {
        ok: false,
        error: "replay needs a session id, a file path, or --cassette <file>",
      };
    }
    args.command = { kind: "replay", ...(target === undefined ? {} : { target }) };
    args.prompt = "";
    return { ok: true, args };
  }
```

(`ReplayCommand.target` becomes `readonly target?: string`.)

### 2d. Help text

In `helpText()` (args.ts:506-561):

```
  record <prompt>               Run a prompt and record it to a cassette (--cassette).
  replay <session|file>         Re-run a session's prompts LIVE, optionally on another model.
  replay --cassette <file>      Re-run a recorded session offline: no provider, no side effects.
```

and under Options:

```
      --cassette <file>         VCR cassette to record into or replay from.
```

### 2e. Dispatch — `packages/cli/src/main.ts`

Next to the existing `replay` branch (main.ts:123-125):

```ts
  if (args.command?.kind === "record") {
    return runRecordCommand(args.command.prompt, args);
  }

  if (args.command?.kind === "replay") {
    return args.cassette === undefined
      ? runReplayCommand(args.command.target!, args.cwd, args.model)
      : runCassetteReplayCommand(args.cassette, args);
  }
```

Both new runners build a runtime, drive it through the existing headless
`runPrint`/`agent.prompt` path, and — for record — `await recorder.close()`
before `runtime.dispose()`. `runCassetteReplayCommand` should print
`cassette.stats()` at the end: a non-empty `unused` list is the "the run diverged
from the recording" signal, and `misses` is its count.

---

## 3. Where `buildRuntime` wraps

`buildRuntime` (runtime.ts:939) already accepts `options.llm`, so the **LLM half
needs no runtime change at all**:

```ts
// record
const recorder = createCassetteRecorder(cassetteFile);
const runtime = await buildRuntime({ ...opts, llm: recordingClient(realClient, recorder) });

// replay — pass a client that never opens a socket
const cassette = await loadCassette(cassetteFile);
const runtime = await buildRuntime({ ...opts, llm: replayingClient(cassette) });
```

Note the ordering that gives you for free: `options.llm` is consumed at
runtime.ts:1007-1009 as `baseClient`, *before* the failover chain is built at
runtime.ts:1012-1026. So on a multi-model config the recorder sits **inside**
failover and records whichever link actually answered — which is what you want,
since the cassette is a recording of what happened, not of what was attempted.
On replay the failover wrapper is inert: `replayingClient` never emits a
retryable error.

The **tool half needs one small addition**, because `BuildRuntimeOptions`
(runtime.ts:897-928) has no tools hook. The proposed edit — deliberately not made
here, since another agent owns runtime.ts:

```ts
  /** Wrap the final tool list handed to every agent (VCR record/replay). */
  wrapAgentTools?: (tools: Tool[]) => Tool[];
```

applied at the **outermost** layer, i.e. to the list that reaches
`agent.setTools(...)`. Concretely that is three call sites, all of which build
`wrapToolsWithHooks(wrapToolsWithCheckpoints([...preHookTools, ...mcpToolsRaw]), hookRunner)`:
`attachMcpTools` (runtime.ts:571-576), the sub-agent path (runtime.ts:760), and
the initial `baseTools: hookedTools` (runtime.ts:1119, 1151).

Outermost is not an aesthetic choice, it is the whole point:

- **Recording** outermost captures what the agent actually saw — after LSP
  diagnostics were appended, after `verify` ran, after the overlay redirected a
  write, after a `preToolUse` hook denied a call. Replaying an inner-layer
  recording would replay a result the model never received.
- **Replaying** outermost means every inner layer is bypassed, and every inner
  layer has side effects: `wrapToolsWithCheckpoints` snapshots git,
  `wrapToolsWithOverlay` writes a shadow tree, `wrapToolsWithVerify` shells out,
  hooks spawn processes. `replayTools` never calls `tool.execute`, so with the
  wrap outermost a replayed session that recorded `bash rm -rf` performs no
  filesystem operation whatsoever. That is the guarantee the tests assert
  (a spy proves the underlying tool is never invoked).

MCP tools land in the same final list, so they are recorded and replayed like any
other tool with no extra work.

Then the runners read:

```ts
// record
buildRuntime({ ...opts,
  llm: recordingClient(baseClient, recorder),
  wrapAgentTools: (tools) => wrapToolsWithRecorder(tools, recorder) });

// replay
buildRuntime({ ...opts,
  llm: replayingClient(cassette),
  wrapAgentTools: (tools) => replayTools(tools, cassette) });
```

One caveat to document for users: a replayed run must start from the same
conversation state as the recording. `arcturn replay --cassette` should therefore
start a **fresh** session (no `--continue` / `--resume`) and use the model the
cassette was recorded with — a different `--model` changes `request.model.id`,
which changes the very first `requestKey`, which misses immediately. That is
correct and loud, not a bug.

---

## 4. How this differs from `packages/cli/src/replay.ts`

They share a word and nothing else.

| | `replay.ts` (`arcturn replay <session>`) | VCR (`arcturn replay --cassette <file>`) |
| --- | --- | --- |
| What is stored | The session JSONL: prompts and outcomes | A cassette: every LLM event list and tool result |
| What is re-run | The **prompts**, sent LIVE to a real provider | The **responses**, served from disk |
| Network | Yes — real API calls | None. `replayingClient` holds no provider |
| Side effects | Yes — tools really run | None. `replayTools` never calls `execute` |
| Cost | Real dollars (`ReplayResult.totalCostUsd`) | Zero |
| Determinism | None — that is the point; it measures drift | Total — byte-identical transcript |
| Answers | "Does model B behave like model A on these prompts?" | "Did *my code change* alter this exact run?" |
| Failure signal | `diffReplays()` — tool-call mismatches, text divergence, cost delta | A cassette miss / non-empty `stats().unused` |

`replay.ts` varies the model and holds the code fixed. VCR holds the model
*fixed by construction* and varies the code. They are complements, and they
compose directly: run `replaySession()` with a `recordingClient` + recorder and
the live replay writes a cassette as a by-product, so one paid run becomes a
permanent free regression test.

Concretely, the intended pipeline:

1. `arcturn record "fix the flaky test" --cassette fixtures/flaky.jsonl` — one paid run.
2. Commit the cassette. It is now a regression test: `arcturn replay --cassette
   fixtures/flaky.jsonl` is free, offline, and reproducible on any machine.
3. In CI, a miss means the agent's behaviour changed. `diffReplays` still applies
   if you want a softer signal than a hard miss.

## 5. How `arcturn bisect` uses it

Bisect needs one thing the live replay cannot provide: a run whose *only* variable
is the code. VCR provides exactly that.

```
arcturn bisect --cassette fixtures/flaky.jsonl --good <rev> --bad <rev>
```

For each candidate revision: check it out, `loadCassette(file)` (a fresh
`Cassette` per revision — consumption is stateful), build the runtime with
`replayingClient` + `replayTools`, run the recorded prompt, and classify:

- **Clean finish, `stats().misses === 0`, `unused` empty** → the run followed the
  recording exactly. Good revision.
- **A `CassetteError { code: "miss", key }`, or a non-empty `unused` list** → the
  agent asked for something the recorded agent never asked for. The revision
  changed behaviour, and the *first* miss is the precise point of divergence:
  the key names the request whose message list no longer matches, so you get a
  turn-level, not just a run-level, answer.

Because replay costs nothing and touches nothing, the bisect can run the full
`O(log n)` sweep in seconds, in parallel, on a dirty working tree, without a
provider key. `onMiss: "error-event"` is the useful mode here: the run completes
instead of throwing, so bisect can capture the whole divergent transcript for the
report rather than just the first bad key.

Counterfactual debugging is the same machinery with one entry hand-edited: change
one recorded tool result in the cassette, replay, and observe what the agent does
differently — with every *other* input still pinned.
