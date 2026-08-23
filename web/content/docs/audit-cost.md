---
title: Audit trail & cost accounting
description: The append-only permission/tool trail, live spend tracking, cost ceilings, and pre-run estimates.
section: Core concepts
order: 8.8
---

## Audit: what the agent was allowed to do

`arcturn audit` answers a different question than `arcturn blame` — not "why is this line
here" but "what happened in this session, and who (or what) approved it." It's the
enterprise/trust trail: every completed tool call, every permission decision, every hook
verdict, recorded as the run happens, not reconstructed afterwards.

### Enabling it

Off by default, same shape as provenance:

```json
{
  "audit": true
}
```

With it off, `arcturn audit <session>` finds nothing to print and says so, pointing you at
the config key rather than failing silently.

### Usage

```bash
arcturn audit [session]
```

`session` is optional — omitted, arcturn uses the newest session for the current directory.

### Sample output

```text
14:03:12  tool  bash  git status  ✓
14:03:20  perm  write  src/auth.ts  ask-allow
14:03:21  tool  write  src/auth.ts  ✓
14:03:44  perm  bash  rm -rf dist  ask-deny
14:04:02  hook  preToolUse  deny: no writes under infra/
14:04:19  tool  edit  src/auth.test.ts  ✗

4 tool calls, 1 denied, 1 hook veto
```

Three record kinds, one line each, timestamped in UTC `HH:MM:SS`:

- **`tool`** — a completed call: name, best-effort subject (path/command/url, when
  known), and `✓`/`✗` for whether the result was an error.
- **`permission`** — a decision a human was actually asked to make. Only the
  interactive-ask path (`ask-allow`/`ask-deny`) is recorded here; a decision resolved
  automatically by a rule or the permission mode never reaches this log, because the
  engine only emits a `permissionRequest` event at the ask step — there's no `toolName`/
  `subject` to attribute an auto-resolved decision to. The tool call itself is still
  captured via its `tool` entry either way.
- **`hook`** — a `preToolUse`/`postToolUse`/`sessionStart`/`runEnd` verdict, with its
  reason when the hook gave one.

The trailing tally (tool calls, denials, hook vetoes) is there so a clean run is obvious
at a glance without reading every line.

### How it works

`auditObserver` maps the live `AgentEvent` stream into `tool`/`permission` entries;
`auditedHookRunner` wraps the `HookRunner` so every verdict it produces is recorded as it's
decided, without touching `hooks.ts` itself. Both write through `createAuditLog`, which
mirrors `JsonlSessionStore`'s discipline: one promise-queue per log so concurrent
`record()` calls can't interleave into a torn line, directory created lazily on first
write. Storage is `<home>/audit/<cwdHash(cwd)>/<sessionId>.jsonl` — same directory-bucketing
scheme sessions use, one file per session.

### Limits

- **Sub-agent events aren't double-counted, but they also aren't unwrapped from the
  parent's stream** — the runtime subscribes each sub-agent's own event stream directly,
  so a delegated call is recorded once, from its own agent's perspective, not folded into
  the parent's line-by-line trail.
- **Auto-resolved permission decisions are invisible to the `permission` log** by design
  (see above) — if you need to know every rule-resolved allow/deny, that's in
  [Permissions](/docs/permissions)'s rule list, not here.
- Turning `audit` on has no retroactive effect — a session recorded before you enabled it
  has nothing to show.

## Cost: priced while it runs

Cost accounting has no opt-in — it's always on. `/cost`, `--max-cost`, and `/cost limit`
all read from the same live `runtime.metrics`, updated after every turn.

### `/cost` — current spend

```text
Session 019c4a2f
  model      Claude Sonnet 4.5 (anthropic/claude-sonnet-4-5)
  turns      14
  input      182.4k
  output     11.3k
  cache      96.0k read · 12.1k write
  total      301.8k
  cost       $1.84 / $5.00 limit
  context    48.2k / 200.0k
```

The `/ $5.00 limit` suffix only appears once a ceiling is set for the session; with no
limit configured, the `cost` row is just the dollar figure.

### `--max-cost` and `/cost limit` — the ceiling

```bash
arcturn --max-cost 5           # abort the run once cumulative spend hits $5
```

```text
/cost limit 5      # same ceiling, set (or changed) mid-session
/cost limit 0      # remove the ceiling
```

The guard checks cumulative cost against the limit after every `turnEnd` event and calls
`abort()` the moment spend reaches (not merely exceeds) the ceiling — it fires *once* per
run (`runStart` re-arms it, so a fresh run or a resumed session gets its own chance to
trip it) and prints:

```text
Cost limit $5.00 reached; run aborted. Raise it with --max-cost or /cost limit.
```

A limit of `0`, or leaving it unset, disables the guard entirely — no ceiling, no abort,
ever, no matter the spend. This is an enforcement mechanism, not a warning: the run is
aborted, not flagged after the fact.

### `/cost preview` — before you commit

```bash
/cost preview          # estimate against the current todo list's step count
/cost preview 12       # estimate for an explicit step count
```

```text
~12-36 turns · $1.80-$5.40 (based on 12 recent turns)
```

This is a **forecast**, deliberately separate from the ceiling — approving a budget up
front is a different act than approving a plan, and arcturn doesn't conflate them. Two
estimators feed the same output shape:

- **From history** (`estimateFromHistory`) — the primary path. Uses the *median*
  cost-per-turn and tokens-per-turn from the session's own recent turns (median, not
  mean, so one unusually expensive read or compaction doesn't skew the range), multiplied
  by an estimated turn count (`steps` for the low end, `steps × 3` by default for the
  high end).
- **From model pricing** (`estimateFromModel`) — the fallback when there's no history
  yet: the model's published per-token pricing times an assumed 4000 input / 800 output
  tokens per turn.

If the model publishes no pricing at all (common for self-hosted or OpenAI-compatible
endpoints), the estimate comes back `basis: "unpriced"` — turn-count range only, no dollar
figures, because guessing a price is worse than admitting it's unknown:

```text
~12-36 turns · price unknown for local-llama
```

The estimate always says which basis it used and, for history-based estimates, how many
samples backed it — confidence is `"medium"` at 8+ samples, `"low"` below that. It's
always a range, never a point: a single confidently-wrong number is worse than an honest
spread.

## Config keys

| Key | Default | Meaning |
|---|---|---|
| `audit` | `false` | Record the append-only tool/permission/hook trail. |
| `maxCostUsd` | unset | USD ceiling for cumulative run cost; `0`/unset disables the guard. Overridden per-run by `--max-cost`, per-session by `/cost limit`. |

## Related

- [Sessions, branching & compaction](/docs/sessions) — audit and cost both key off the
  same session id and directory-bucketing scheme.
- [Provenance & arcturn blame](/docs/provenance) — the reasoning trail; audit is the
  permission trail. Different questions, same "recorded as it happens" philosophy.
- [Replay & bisect](/docs/replay-bisect) — a replay reports cost per turn using the same
  accounting `/cost` shows live.
- [Permissions](/docs/permissions) — the rule engine whose ask-path decisions the audit
  log's `permission` entries capture.
- The [accountability feature page](/features/accountability) has this exact `/cost` and
  `arcturn audit` output alongside the other accountability commands.
