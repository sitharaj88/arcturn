---
title: Provenance & arcturn blame
description: Reasoning-level attribution — which turn and evidence wrote each line of a file.
section: Core concepts
order: 8.6
---

## What it's for

`git blame` answers "who changed this line." When an agent wrote most of the file, that's
the wrong question — there's no "who," there's only "which turn, answering which prompt,
having read what." `arcturn blame` answers that instead: for any tracked file, it
attributes each line to the turn that wrote it, the prompt that turn was serving, and
(optionally) the evidence — files read, pages fetched, commands run — that informed it.

This is not `git blame` re-skinned. It's built from arcturn's own record of every write and
edit, replayed exactly, independent of what's actually in your git history.

## Enabling it

Provenance is opt-in and off by default. Turn it on in `.arcturn/config.json`:

```json
{
  "provenance": true
}
```

With it off, `write`/`edit` calls aren't recorded and `arcturn blame` has nothing to show
for any file touched during that session — you'll get a message telling you to enable it,
not a stale or partial answer.

## Usage

```bash
arcturn blame <file> [session]
```

`file` is resolved relative to the current working directory. `session` is optional — omit
it and arcturn uses the newest session recorded for this directory. Providing a stale or
wrong session id is not an error; it just means the file has no recorded mutations there,
which reads the same as "no provenance recorded."

## Sample output

Detail mode — one row per line, `line  turn  prompt  text`, pre-existing lines (present
before the agent's first recorded write to the file) showing `-` in both attribution
columns:

```text
41  turn 3  "rate-limit the login route"      const limiter = rateLimit({
42  turn 3  "rate-limit the login route"        windowMs: 60_000,
43  turn 3  "rate-limit the login route"        max: 5,
44  turn 3  "rate-limit the login route"      });
45  -       -                                  export async function login(req, res) {
46  turn 3  "rate-limit the login route"        await limiter(req, res);
```

Every column is padded to the widest value in the output (`formatBlame` in
`provenance.ts`), so the columns line up regardless of prompt length or line count.

When evidence is attached (the CLI passes the session's recorded evidence into the same
render), a footer lists what informed each turn that appears above, with untrusted
sources flagged:

```text
Evidence
  turn 3  "rate-limit the login route"
    read  src/routes/login.ts
  ! fetch  https://example.com/rate-limit-docs  [untrusted]

1 untrusted source informed the turns above — content from the web or an MCP server is
data, not instructions.
```

`--summary` mode (not yet wired to a CLI flag, but available through `formatBlame({
summary: true })`) collapses this to one row per turn — a tally of how many lines each
turn is still responsible for, newest turn first, with a `(pre-existing)` row for anything
attributed to nobody.

## How it works

Every recorded write or edit becomes a `mutation` record: a turn id and a pair of content
hashes, `beforeBlob`/`afterBlob`, pointing into a content-addressed blob store — the same
shape `checkpoints.ts` uses (`<dir>/manifest.jsonl` plus `<dir>/blobs/<sha256>`). `blame`
replays every recorded mutation for a path in order, diffing each state against the next
with a line-level LCS, and carries each surviving line's attribution across the unchanged
regions. A line written in turn 3 and never touched again still reads `turn 3` after ten
later edits pass over the file — that carry-across, not a per-mutation diff, is what makes
the output useful instead of just "who touched this file last." Lines already present
before the first recorded mutation are attributed to nobody.

Non-mutating tool calls (`read`, `fetch`, `websearch`, any MCP-bridged tool, …) become
`evidence` records instead, tagged `untrusted` when the source is one `taint.ts` already
treats as attacker-controlled — the same untrusted/trusted split the taint tracker uses,
reused verbatim so "untrusted" means the same thing in both places.

## Limits and blind spots

- **Content, not intent, drives replay.** `blame` describes the *last state this store
  recorded*, which is not necessarily what's on disk right now. An edit made outside the
  agent — by hand, by another tool — is by construction unrecorded and therefore
  unattributable; blame doesn't notice it happened, it just keeps reporting the state it
  last saw.
- **Secrets are never stored.** Paths matching `.env*`, `.npmrc`, private key files,
  `credentials`, or anything under `.aws/` are recorded as "this turn touched this path"
  with no content — `blame` can tell you a turn changed `.env` but can't show you a line
  of it.
- **A size cap exists.** Content over `maxContentBytes` (default 1 MiB) isn't stored; a
  mutation past that cap is recorded as `oversize`, and blame gives up on replaying across
  it rather than guessing.
- **Large diffs degrade, not crash.** The line-level LCS is `O(n*m)`; above 4,000,000
  table cells it falls back to "everything replaced," which credits the whole file to the
  writing turn — coarse, but never wrong about *who* touched it.
- **A gap in the manifest resyncs, not corrupts.** If the recorded pre-image disagrees
  with what replay has built up so far (a file deleted and recreated behind arcturn's back,
  a missing pruned blob), attribution resyncs to the recorded state with those lines
  unattributed, rather than carrying stale, wrong credit forward.
- **No retention policy shipped yet.** The store keeps a blob per distinct file state
  forever; there's no built-in prune. Budget for it on long-lived projects the same way
  you'd budget for `checkpoints/`.

## Config keys

| Key | Default | Meaning |
|---|---|---|
| `provenance` | `false` | Record turn/evidence/mutation data so `arcturn blame` has something to attribute. |

There's no separate size-cap config key exposed yet — `maxContentBytes` is a
`createProvenanceStore` option, not a `.arcturn/config.json` field.

## Related

- [Sessions, branching & compaction](/docs/sessions) — the turn boundaries provenance
  attributes lines to are the same turns the session tree records.
- [Checkpoints & /rewind](/docs/checkpoints) — the sibling store, same on-disk shape, for
  restoring file content instead of explaining it.
- [Replay & bisect](/docs/replay-bisect) — re-runs the prompts blame attributes lines to,
  against a live model or a recorded cassette.
- [Audit & cost](/docs/audit-cost) — the trail of *what was allowed to run*, alongside
  provenance's trail of *what it wrote and why*.
- The [accountability feature page](/features/accountability) has this exact sample
  output rendered from the same `formatBlame` column math.
