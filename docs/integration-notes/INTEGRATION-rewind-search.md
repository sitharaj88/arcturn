# Integrating semantic `/rewind`

`packages/cli/src/rewind-search.ts` is complete and tested
(`rewind-search.test.ts`, 23 tests) and **wired into nothing**. Like
`bisect.ts`, it was written as a new file only — `checkpoints.ts`,
`commands.ts` and `runtime.ts` are untouched. This is the hand-off: what the
module gives you, and exactly which (currently unapplied) edit to the
existing `rewind` command in `commands.ts` would turn `/rewind the auth
refactor` into a direct jump instead of a scroll through every checkpoint.

---

## 1. What the module gives you

```ts
import {
  searchTurns,        // (turns, query, options?) -> TurnMatch[]  — every turn, scored, best first
  bestMatch,           // (turns, query, options?) -> TurnMatch | undefined — refuses when ambiguous
  explainMatch,         // (match) -> string — one-line "why", for confirmation/notice text
  stem,                  // (word) -> string — the crude suffix stripper, exported for reuse/testing
  DEFAULT_STOPWORDS,      // ReadonlySet<string>
  MIN_CONFIDENCE_SCORE,    // default confidence bar bestMatch enforces
  MIN_MARGIN_SCORE,         // default runner-up margin bestMatch enforces
  type TurnInfo,             // = CheckpointTurnSummary (checkpoints.ts) — { id, label, timestamp, fileCount }
  type TurnMatch,              // { turn: TurnInfo, score: number, why: string }
  type SearchTurnsOptions,
  type BestMatchOptions,
} from "./rewind-search.js";
```

`TurnInfo` is a type alias for `CheckpointTurnSummary`, so
`await runtime.checkpoints.listTurns()` (see `checkpoints.ts`) can be passed
to `searchTurns`/`bestMatch` with no conversion.

### Scoring, briefly

Every `TurnMatch.score` is the sum of four local, explainable signals — no
embeddings, no network, no ML dependency:

1. **Exact phrase containment** in the label — the query string appears
   verbatim (case-insensitive) inside the label. Strongest signal, guarded
   so a stopword-only query can't trigger it just because the label happens
   to contain "the" or "a".
2. **Word overlap** — the fraction of the query's distinct words present in
   the label, exact or `stem()`-matched, with `DEFAULT_STOPWORDS` down-weighted
   (not zeroed) so filler words neither dominate nor are ignored.
3. **Recency** — a small bonus for turns later in the corpus, by actual
   timestamp value (ties in timestamp get equal fractions, not an arbitrary
   ordering bonus). Its ceiling is far below a single word-overlap point
   swing, so it can only break near-ties, never overturn a real content
   difference — see the "never lets recency outrank…" test.
4. **File count** — an even smaller bonus for turns that actually changed
   files, weakly favoring turns that did something over no-op turns
   (`"(untracked)"` snapshot-only turns, aborted runs, etc.).

`TurnMatch.why` always names whichever of (1)/(2) fired — e.g. `exact phrase
"auth refactor" found in label` or `2/3 query words matched in label (1
exact, 1 stemmed)` — so the confirmation prompt in §2 can show the user
*why* a turn was picked, not just that one was.

### `bestMatch` — the "refuse rather than guess" gate

```ts
const match = bestMatch(turns, "the auth refactor");
// undefined unless the top TurnMatch clears MIN_CONFIDENCE_SCORE (35) AND
// beats the runner-up by MIN_MARGIN_SCORE (15) — including when there is no
// runner-up, so a single weak match still can't sneak through on
// confidence alone without a real content signal.
```

This is deliberately the load-bearing behaviour: rewinding **deletes
files** (`CheckpointStore.restore()` unlinks anything whose earliest record
in the range is "absent" — see `checkpoints.ts`), so a caller must never
follow a merely-plausible match. Two turns with equivalent labels, or a
query too vague to separate them, must come back `undefined` so the caller
falls back to a human decision.

---

## 2. Wiring into `commands.ts`'s `rewind` command

The current command (`commands.ts:449-491`) ignores `args` entirely — it
always shows the full reverse-chronological picker. `CommandContext.args`
already carries "text typed after the command name, trimmed" (`commands.ts`
line 68), so **no change to `args.ts` or the dispatch path is needed** —
this is a self-contained edit to the `rewind` command's `run()` body.

### 2a. Behaviour

- **`/rewind` (no args)** — unchanged: today's full picker, unfiltered,
  reverse-chronological. Nobody typed a query, so there is nothing to score.
- **`/rewind <query>`**:
  1. Call `bestMatch(turns, args)`.
  2. **If defined** — show a confirmation picker (not an instant jump, even
     though the match is confident — see §2c for wording) naming the match
     and its `explainMatch()` reasoning. Only on confirmation does it call
     `restore()`.
  3. **If `undefined`** (no confident match, or ambiguous) — fall back to
     the picker, but reorder it by `searchTurns(turns, args)` (best first)
     instead of reverse-chronological, so the query still narrows down what
     the user has to scroll through even though nothing crossed the
     "jump straight there" bar. Never silently jump on a weak match.

### 2b. Sketch

```ts
{
  name: "rewind",
  description: "Restore files and conversation to an earlier turn",
  source: "built-in",
  async run({ ui, runtime, args }) {
    if (runtime.agent.isRunning) {
      ui.notice("warn", "A run is in progress; press Esc to interrupt it before rewinding.");
      return;
    }
    const turns = await runtime.checkpoints.listTurns();
    if (turns.length === 0) {
      ui.notice("info", "No checkpoints recorded in this session yet.");
      return;
    }

    const query = args.trim();
    let orderedTurns = [...turns].reverse(); // today's default: reverse-chronological
    let confirmationNotice: string | undefined;

    if (query !== "") {
      const match = bestMatch(turns, query);
      if (match) {
        const proceed = await ui.select(
          `Rewind to "${oneLine(match.turn.label, 44)}"?`,
          [
            {
              value: "yes",
              label: "Yes, rewind here",
              description: `${explainMatch(match)} — this restores/deletes files and cannot be undone.`,
              data: true,
            },
            {
              value: "no",
              label: "Cancel",
              description: "Show the full checkpoint list instead",
              data: false,
            },
          ],
        );
        if (proceed === true) {
          await performRewind(match.turn.id); // extracted from the body below
          return;
        }
        if (proceed === undefined) return; // Esc on the confirmation: stop, don't fall back.
        // "Cancel" (proceed === false): fall through to the picker below.
      }
      // No confident match, or the user hit Cancel: order the picker by relevance.
      orderedTurns = searchTurns(turns, query).map((m) => m.turn);
      confirmationNotice = match
        ? undefined
        : `No single checkpoint confidently matches "${query}" — showing the closest matches first.`;
    }

    if (confirmationNotice) ui.notice("info", confirmationNotice);

    const choice = await ui.select(
      "Rewind to the start of…",
      orderedTurns.map((turn) => ({
        value: turn.id,
        label: `${new Date(turn.timestamp).toLocaleTimeString()}  ${oneLine(turn.label, 44)}`,
        description: `${turn.fileCount} file${turn.fileCount === 1 ? "" : "s"} changed after this point`,
        data: turn.id,
      })),
    );
    if (!choice) return;
    await performRewind(choice);

    async function performRewind(turnId: string) {
      const result = await runtime.checkpoints.restore(turnId);
      for (const failure of result.errors) {
        ui.notice("error", `${failure.path}: ${failure.message}`);
      }
      ui.notice(
        "info",
        `Restored ${result.restored.length} file${result.restored.length === 1 ? "" : "s"}, deleted ${result.deleted.length}.`,
      );
      const link = runtime.turnLink(turnId);
      if (link) {
        await runtime.rewindConversationTo(link.sessionId, link.leafId);
        ui.notice("info", "Conversation forked back to that turn.");
      } else {
        ui.notice(
          "warn",
          "Files restored. The conversation link for this turn predates this process, so the transcript was left in place.",
        );
      }
    }
  },
},
```

Plus, at the top of `commands.ts`:

```ts
import { bestMatch, explainMatch, searchTurns } from "./rewind-search.js";
```

and `CommandContext` already exposes `args: string`, so the `run()`
signature only needs `args` added to its destructured parameter list —
every other command already receives it the same way (see `/model`,
`/cost`, etc. elsewhere in the file).

### 2c. Confirmation-prompt wording

Rewinding **deletes files** (anything created after the target turn, per
`CheckpointStore.restore()`'s semantics), so `bestMatch` clearing its
confidence bar is not, by itself, license to skip confirmation — it only
means the tool trusts its own guess enough to *offer* it as the default
choice instead of making the user scroll to find it. The picker in §2b
uses:

- **Title:** `Rewind to "<label, 44 chars>"?` — names the actual turn, not
  just "are you sure", so the user is confirming a specific checkpoint they
  can recognize.
- **Yes option label:** `Yes, rewind here`
  **Yes option description:** `<explainMatch(match)> — this restores/deletes
  files and cannot be undone.` — e.g. `exact phrase "auth refactor" found in
  label; 3 files changed — this restores/deletes files and cannot be
  undone.` This is the one line that has to carry both *why this turn* and
  *what is about to happen*, since `ui.select` has no separate modal/warning
  affordance (`CommandUi` — `commands.ts:38-59` — has no `confirm()`
  primitive, only `select`).
- **No option label:** `Cancel`
  **No option description:** `Show the full checkpoint list instead` — makes
  the escape hatch land somewhere useful (the relevance-ordered picker),
  not just a dead end.
- **Esc / dismiss:** treated as a hard stop (`return`), matching every other
  `ui.select` call in this file (`commands.ts:471`, `:514`, etc., all
  `if (!choice) return;`) — it must *not* fall through to the picker, since
  that would surprise a user who dismissed the whole flow.

When `bestMatch` returns `undefined`, no confirmation is shown at all — there
is nothing to confirm. The command instead prints:

> `No single checkpoint confidently matches "<query>" — showing the closest matches first.`

and opens the ordinary picker, now sorted by `searchTurns()` instead of
recency, so the query still did useful work even when it wasn't decisive
enough to jump straight there.

---

## 3. Test coverage already in place

`rewind-search.test.ts` (23 tests) covers, independent of any wiring:

- Exact phrase beats partial word overlap.
- Word overlap ranks turns sensibly as shared content words increase.
- `stem()` collapses `refactor`/`refactored`/`refactoring`, and `why`
  reports `stemmed` when that's what fired.
- A stopword-only query cannot reach `MIN_CONFIDENCE_SCORE` (both via
  `searchTurns` scores and via `bestMatch` returning `undefined`).
- Two equally-good turns (identical labels, identical timestamps) make
  `bestMatch` return `undefined` — the core ambiguity-refusal behaviour —
  including a near-tie case (different labels, near-equal overlap).
- Recency breaks a genuine score tie (small, bounded gap) but never lets a
  newer weak match outrank an older strong one.
- Empty corpus and empty query are both handled without throwing, and an
  empty query never produces a confident `bestMatch`.
- `explainMatch` names the firing signal and appends file-count context,
  singular/plural correctly.
- `minConfidence`/`minMargin` overrides on `BestMatchOptions` are honored,
  for callers (or future tests of the `commands.ts` wiring) that want a
  stricter or looser bar than the defaults.

---

## 4. Verification run for this hand-off

```bash
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/rewind-search.test.ts   # 23 passed
npx tsc -p packages/cli/tsconfig.json --noEmit           # clean
npx biome check packages/cli/src/rewind-search.ts packages/cli/src/rewind-search.test.ts  # clean
```
