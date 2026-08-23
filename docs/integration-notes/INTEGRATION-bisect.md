# Integrating `arcturn bisect`

`packages/cli/src/bisect.ts` is complete, tested (`bisect.test.ts`, 25 tests)
and **wired into nothing**. Like `vcr.ts`, it was written as new files only —
no existing file was touched. This is the hand-off: what the module gives
you, how it composes with `vcr.ts` and `replay.ts`, and exactly which edits
would turn it into `arcturn bisect <session> --cassette <file>`.

---

## 1. What the module gives you

```ts
import {
  bisectTurns,       // <T>(turns, probe, options?) -> Promise<BisectResult<T>>
  cassetteProbe,      // (cassetteFile, prompts, runProbe, options?) -> probe fn
  formatBisectResult,  // (result, options?) -> string
  type BisectVerdict,   // "good" | "bad" | "skip"
  type BisectOptions,    // { maxProbes?, verify? }
  type BisectResult,      // { firstBadIndex, item, probes, confident, reason }
  type BisectProbeLogEntry,
  type CassetteRunProbe,
  type CassetteProbeOptions,
  type FormatBisectResultOptions,
} from "./bisect.js";
```

`bisectTurns` is a pure, generic binary search: it knows nothing about
sessions, cassettes, or turns — only that it has an ordered `T[]` and a
`probe(upTo: number) => Promise<BisectVerdict>` that judges the prefix
`turns[0..upTo]`. `cassetteProbe` is the one piece that plugs it into VCR
mode. That split is what makes the search itself trivially unit-testable
(no runtime, no filesystem, no network in `bisect.test.ts`) while still being
the real engine behind a cassette-backed `arcturn bisect`.

### The search

```ts
const result = await bisectTurns(turns, probe, { verify: true, maxProbes: 40 });
// result.firstBadIndex : number | undefined
// result.item          : turns[firstBadIndex] | undefined
// result.probes         : { index, verdict }[]   (full trail, in call order)
// result.confident       : boolean
// result.reason           : string
```

Classic "find the leftmost bad" binary search, `O(log n)` probes, with two
things a real probe needs that a textbook version doesn't:

- **`"skip"` handling.** A probe that can't decide (corrupt cassette, an
  unrelated error) doesn't get silently coerced into `"good"` or `"bad"` —
  the search steps outward from the undecidable index to the nearest
  decidable neighbour and uses that instead. If every reachable index in the
  current window is `"skip"`, the search stops with `confident: false`
  rather than guessing.
- **A probe budget.** `options.maxProbes` (default 64) caps total `probe()`
  calls — search path, outward-stepping, and `verify` combined. A real probe
  means replaying a cassette through a runtime; unbounded search is not
  acceptable.

### The monotonicity assumption — read this before trusting a result

`bisectTurns` assumes badness is monotonic: once a turn is bad, every turn
after it is bad too (the `git bisect` assumption). This is what lets
`O(log n)` probes stand in for `O(n)`. **It is not always true for agent
runs** — a probe with side effects that "heal" (e.g. a flaky tool, a race
between two sub-agents, a cassette whose miss behaviour depends on timing)
can go good → bad → good → bad, and an unqualified binary search only ever
looks at `O(log n)` of the `n` turns, so it can walk straight past the flip
and report a confident-looking but *wrong* turn number.

`options.verify: true` buys a partial check for `$O(1)` extra probes: after
the search concludes, it re-probes the turn immediately before the reported
boundary (expected `"good"`) and the turn immediately after it (expected to
stay `"bad"`). A contradiction sets `result.confident = false` and explains
why in `result.reason`. This catches the case where the flip straddles the
reported boundary — it does **not** prove the sequence is monotonic
everywhere; a flip far from the boundary that the search path never visited
is undetectable by construction.

**When you get `confident: false`:** don't trust `firstBadIndex` as-is.
Either (a) bisect over a narrower or cleaner reproduction where the
non-determinism is less likely, or (b) fall back to a linear scan
(`for (let i = 0; i < turns.length; i++) probe(i)`) over the region
`result.probes` covered, which costs `O(n)` probes but is immune to the
monotonicity assumption. `formatBisectResult` always prints the confidence
line and the full probe trail so a human can see exactly which indices were
(and weren't) checked before deciding which of these to do.

### `cassetteProbe` — the VCR-backed probe factory

```ts
const prompts = extractPrompts(sessionEntries); // replay.ts
const probe = cassetteProbe(cassetteFile, prompts, async (cassette, slice) => {
  const runtime = await buildRuntime({
    ...baseOpts,
    llm: replayingClient(cassette, { onMiss: "throw" }),
    wrapAgentTools: (tools) => replayTools(tools, cassette),
  });
  try {
    await replaySession({ prompts: slice, runtime });
  } finally {
    await runtime.dispose();
  }
});

const result = await bisectTurns(prompts, probe, { verify: true });
console.log(formatBisectResult(result));
```

For each candidate index `upTo`, `cassetteProbe`:

1. Calls `options.loadCassette(cassetteFile)` — **a fresh `Cassette` every
   time**, default `loadCassette` from `vcr.js`. This is not optional:
   `takeLlm`/`takeTool` consume the cassette as they're served, so reusing
   one `Cassette` object across probes would make every probe after the
   first replay against an already-partially-consumed recording and misreport
   misses that are really just "already served to an earlier probe." See
   `INTEGRATION-vcr.md` §1 ("Repeats") for why consumption is stateful.
2. Runs `runProbe(cassette, prompts.slice(0, upTo + 1))` — the caller-supplied
   function that builds a runtime and drives the replay. This is injected
   specifically so `cassetteProbe` itself needs no runtime to unit-test (see
   `bisect.test.ts`, which fakes both `loadCassette` and `runProbe`).
3. Classifies the outcome:

   | What happened | Verdict | Why |
   | --- | --- | --- |
   | Clean finish, `cassette.stats().misses === 0` | `"good"` | The recorded prompts replayed exactly as recorded through this prefix. |
   | `runProbe` throws `CassetteError { code: "miss" }` | `"bad"` | The agent asked for something the recording never produced — the precise turn-level signature of a divergence. This is `replayingClient`'s **default** `onMiss: "throw"` behaviour. |
   | Clean finish but `stats().misses > 0` | `"bad"` | Same signal, for the case where the caller used `onMiss: "error-event"` instead — the run *completes* (useful for capturing how far it got) but still left a miss behind. |
   | `runProbe` throws `CassetteError { code: "corrupt" }`, or loading the cassette itself does | `"skip"` | This candidate can't be judged at all — not "matched", not "diverged". |
   | Any other thrown error | (propagates) | Not this function's call to make; an unrelated bug isn't a cassette divergence. |

   Any other thrown error is not caught — it is not `cassetteProbe`'s job to
   decide whether an unrelated exception counts as a divergence.

### `formatBisectResult`

```
arcturn bisect: behaviour first diverges at turn 4 — refactor the auth module.
confident: yes (first divergence at turn 4)

Probe trail (4 probe(s)):
  turn 7: good
  turn 4: bad
  turn 2: good
  turn 3: bad
```

Names the first divergent turn by index, resolves a label for it (a custom
`options.label` function, else the item itself when it's a `string`, else a
`.label` field when present — matching `CheckpointTurnSummary.label` from
`checkpoints.ts` — else a JSON fallback), reports the confidence line
verbatim from `result.reason`, and lists every probe in call order so a human
can audit exactly what the search checked.

---

## 2. CLI sketch — `packages/cli/src/args.ts`

Mirrors `replay`/`audit` exactly (see those branches, args.ts:441-459).

### 2a. Command type + name constant

Alongside `ReplayCommand` and `REPLAY_COMMAND_NAME`:

```ts
/** A parsed `bisect <session> --cassette <file>` command. */
export interface BisectCommand {
  /** Command family. */
  readonly kind: "bisect";
  /** Session id, or a path to a session JSONL file, to bisect. */
  readonly target: string;
}

/** First positional that switches into bisect-command parsing. */
export const BISECT_COMMAND_NAME = "bisect";
```

...and add `BisectCommand` to the `CliCommand` union.

### 2b. Positional parsing

Placed with the other command branches, mirroring the `replay` branch
exactly (args.ts:451-459) — `bisect` needs a target and a `--cassette` flag,
which `VALUE_FLAGS`/`args.cassette` already provide (added for `arcturn record`/
`arcturn replay --cassette` per `INTEGRATION-vcr.md` §2):

```ts
if (positional[0] === BISECT_COMMAND_NAME && commandCandidates > 0) {
  const target = positional[1];
  if (target === undefined || positional.length > 2) {
    return { ok: false, error: "bisect needs exactly one session id or file path" };
  }
  if (args.cassette === undefined) {
    return { ok: false, error: "bisect needs --cassette <file>" };
  }
  args.command = { kind: "bisect", target };
  args.prompt = "";
  return { ok: true, args };
}
```

Add to `helpText()`:

```
  bisect <session> --cassette <file>   Binary-search a session for the turn behaviour diverged at.
```

Optional flags worth adding to `VALUE_FLAGS` if the CLI wants them exposed
(not required for a first cut — `bisectTurns`' defaults are reasonable):
`--max-probes <n>` → `BisectOptions.maxProbes`, `--verify` (boolean, no
value) → `BisectOptions.verify`.

### 2c. Dispatch — `packages/cli/src/main.ts`

Next to the existing `replay` branch:

```ts
if (args.command?.kind === "bisect") {
  return runBisectCommand(args.command.target, args.cassette!, args);
}
```

`runBisectCommand` is the one piece of glue this doc can describe but not
write (it needs `buildRuntime`, which `bisect.ts` deliberately does not
import — the probe is injected precisely so the search has no runtime
dependency):

```ts
async function runBisectCommand(target: string, cassetteFile: string, args: CliArgs) {
  const store = /* open the session store, load `target`'s entries — same
                   resolution `runReplayCommand` already does for a session
                   id vs. a file path */;
  const entries = await store.entries(target);
  const prompts = extractPrompts(entries);

  const probe = cassetteProbe(cassetteFile, prompts, async (cassette, slice) => {
    const runtime = await buildRuntime({
      cwd: args.cwd,
      llm: replayingClient(cassette, { onMiss: "throw" }),
      wrapAgentTools: (tools) => replayTools(tools, cassette),
    });
    try {
      await replaySession({ prompts: slice, runtime });
    } finally {
      await runtime.dispose();
    }
  });

  const result = await bisectTurns(prompts, probe, { verify: true });
  console.log(formatBisectResult(result, { label: (prompt) => prompt.slice(0, 60) }));
}
```

Note `bisectTurns(prompts, probe, ...)` — bisecting directly over the prompt
list is the simplest wiring (each `T` is a prompt string, and
`formatBisectResult`'s default label handles a `string` item for free). If
the CLI wants to report against `checkpoints.ts` turn boundaries instead
(`CheckpointStore.listTurns()`), bisect over that array instead and pass
`upTo` through to whichever prompt index the turn corresponds to — the two
aren't necessarily 1:1 (a turn can span zero or more prompts depending on how
checkpoints are keyed), so pick whichever unit of "step" the caller actually
wants named in the report.

`wrapAgentTools` on `BuildRuntimeOptions` does not exist yet — it's the
proposed (not yet applied) edit described in `INTEGRATION-vcr.md` §3, owned
by whoever wires up `vcr.ts` itself. `arcturn bisect` needs it for exactly the
same reason `arcturn replay --cassette` does: `replayTools` must sit outermost so
a replayed probe touches no filesystem, no process, no network, however
destructive the original run was.

---

## 3. How this composes with `replay.ts` and `vcr.ts`

Three tools now share the same three-word question — "what changed?" — with
three different answers:

| | `replay.ts` (`arcturn replay <session>`) | VCR (`arcturn replay --cassette <file>`) | `bisect.ts` (`arcturn bisect <session> --cassette <file>`) |
| --- | --- | --- | --- |
| Varies | The model / config | Nothing — pinned by construction | The **prefix length** of a pinned cassette replay |
| Holds fixed | The code | Everything the cassette recorded | Everything the cassette recorded |
| Answers | "Does model B behave like model A on these prompts?" | "Did my code change alter this exact run?" | "**Which turn** did my code change alter this exact run at?" |
| Cost | Real dollars | Zero | Zero — `O(log n)` cassette replays instead of one |
| Failure signal | `diffReplays()` | A cassette miss / non-empty `stats().unused` | `BisectResult.firstBadIndex`, with a probe trail |

Concretely: `bisectTurns` + `cassetteProbe` turn the single miss signal VCR
already gives you ("the run diverged from the recording *somewhere*") into a
turn-numbered answer, by replaying successively longer prefixes of the same
cassette against whatever code is currently checked out. Because replay
touches no network and no filesystem (`replayTools` never calls the
underlying tool — see `vcr.ts`'s module docs), the whole `O(log n)` sweep
runs in seconds, on a dirty working tree, with no provider key — which is
also exactly what makes `arcturn bisect` safe to run against destructive
recorded sessions (`bash rm -rf` in the cassette deletes nothing on replay).

**Honest caveat, restated:** this only tells you *where in the turn sequence*
the recorded prompts stop replaying cleanly against the currently-checked-out
code. It assumes the badness is monotonic in turn order (see §1 above) and it
tells you *that* a turn diverged, not *why* — for "why", read the miss's key
and the surrounding transcript (`result.probes` names which prefix lengths
were tried; re-run the failing prefix once more with `onMiss: "error-event"`
instead of `"throw"` to get the full divergent transcript rather than just
the first miss). Counterfactual debugging — hand-editing one cassette entry
and re-bisecting — is the natural next step and needs no new code: it's the
same `cassetteProbe` over an edited file.
