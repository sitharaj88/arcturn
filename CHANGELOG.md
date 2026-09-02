# Changelog

All notable changes to Arcturn are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Every package in this workspace is released together under one version number.
A change is listed once, under the surface it actually changes for you — the
CLI, the SDK, or the wire protocol.

## [Unreleased]

### Added

- **GLM-5.3 Flash, and the rest of the GLM lineup on both Z.AI endpoints.**
  `glm-5.3-flash` — a 1M-context, tool-calling, thinking model that Z.AI
  gives three times the coding-plan quota of GLM-5.3 — is now a curated model
  under `zai`, `zai-cn` and `zai-api`, so it is reachable by name whichever
  way you are billed. Alongside it: `glm-4.7-flash` and the `glm-4.6v` /
  `glm-4.6v-flash` vision pair join the coding-plan lineup (previously the
  plan offered no image-capable model at all), `glm-4.7-flashx` joins the
  general API, and `zai-cn` — which listed *no* models despite being the same
  subscription as `zai` behind a China host — now mirrors the full list.
  Twelve curated Z.AI models become twenty-eight.

  Every fact came off the endpoints rather than a guess: the `/models`
  listing, a one-token completion per id to prove the plan actually covers it,
  and a deliberately over-large `max_tokens` per id so each ceiling is quoted
  back by the API's own range error. That last probe corrected every GLM
  entry's `maxOutputTokens` from 128,000 to the real 131,072 (32,768 for the
  vision pair), and it is what keeps `glm-4.7-flashx` off the coding plan —
  it answers there with a billing error, not a completion. GLM-5.3-Flash is
  priced at Z.AI's **list** rate, not the half-price launch promotion that
  ends 2026-09-09: a promo baked into the catalog would leave every install
  under-reporting spend the day it lapsed, and a budget ceiling that reads
  low is one that fails to trip.

- **`arcturn search`, and `arcturn add <name>` for anything the hub lists.**
  The site now exports the registry as one JSON file,
  `https://arcturn.dev/hub/index.json`, built from the same `registry/*.json`
  the hub pages render — and the CLI reads it. `arcturn search review` lists
  every listed package whose name, kinds or description carries the word,
  each with the `arcturn add <name>` that installs it; `arcturn add
  starter-skills` and `arcturn inspect starter-skills` look a bare name up in
  that file, print `resolving "starter-skills" via the hub → …`, and then run
  exactly as if you had typed the source they found. Listing a package is a
  pull request to `registry/` and a site deploy; no CLI release is involved,
  which is what RFC 0002 meant by "the file is the API".

  The index is data, never instructions. A bare name can only ever resolve
  to the `owner/repo[/subdir][@ref]` GitHub shorthand a listing is allowed to
  carry — an index naming a local path or an arbitrary git URL is refused
  whole — and the string it resolves to goes through the same resolver, the
  same executable-code confirmation and the same `--yes` semantics as a
  typed source. Nothing installs that was not printed first. A listing may
  now pin a `ref`; when it does, the hub page's command and the bare-name
  install both carry it. The index is read over https only (plain http on
  localhost, for a local site build), `ARCTURN_HUB_URL` points a CLI at
  another copy, and an unreachable hub is one line on stderr naming the
  reason, the explicit source as the way around it, and exit 1.

- **A parked step says what the model emitted on the turn it failed on.**
  The park used to name the step, the role and a one-line cause. For a step
  that produced nothing, that cause was the whole story: "no file was changed
  and no text was returned", and the hour of work that followed — opening
  the session JSONL, finding the last assistant message, measuring it — lived
  in an engineer's head. The failed step's last turn is now recorded as a
  *shape* on its `stepEnd` line and on the `stepFailAsk` park: the model id,
  the stop reason, each block's kind and size, and — only when the turn was
  reasoning alone — the last sentence of that reasoning. `/workflow status`,
  the live park notice and the resume restatement print it as one line:
  `last turn: zai/glm-5.3 · stopped endTurn · thinking 65,215 chars · no text
  · no tool call`, then `reasoning ended: "…Write the file now."`. That line
  is what turns a void into a diagnosis with a specific fix. Reasoning is
  never journalled for a turn that delivered something.

- **`arcturn -p "/workflow …"` runs the workflow.** A leading slash under
  `--print` used to be handed to the model as a question — so there was no
  way to run a pipeline from CI, a script or cron at all. Print mode now
  dispatches a `/command` through the same registry the interactive app
  uses, with a headless surface behind it: the transcript is stdout, notices
  are stderr, a pre-filled follow-up is printed as the command to run next,
  and a picker is refused with a notice naming the argument to pass instead.
  The exit code tells a CI job how it ended without grepping: `0` finished,
  `1` an error, `2` no such command, `3` the workflow stopped for a person.
  Under `--output-format json` every notice and workflow event is NDJSON.

- **Every shipped workflow is now proven to run.** A conformance suite parses
  all eighteen kit workflows with the real parser, resolves every `@role` in
  its own kit, refuses any model tag that is not a `tier:`, loads every role
  file clean, and then runs each workflow end to end through the real engine
  — lanes, worktrees, journal — under a fake model that answers each step
  minimally, asserting it completes. Two failure shapes from real runs are
  replayed against the shipped `rag-setup` files: one silent turn recovers
  inside the step at the cost of one request; two park the run with the step
  named. Fourteen seconds, in CI, on every change.

- **`progressCheck`: tell an agent it is off track while it still has budget.**
  A write-lane builder spent all 80 of its turns reading — 77 `bash` calls, 17
  `read` calls, zero writes, 23.6 minutes, 330K tokens — and hit its ceiling
  having never started the file it was sent to write. The ceiling caught it,
  but only once the money was gone, and all it could say afterwards was "hit
  its 80-turn ceiling" rather than "never wrote anything". A new `AgentOptions`
  callback runs at the top of every turn after the first, is handed the run's
  turn index, its ceiling and a histogram of the tool calls it has made so far
  by name, and may return one sentence to send the model. That sentence rides
  the next request without spending a turn — exactly as the turn-budget warning
  does — surfaces as a `warn` notice and a new `progressWarning` event, and is
  never sent twice in one run, so a check may return it unconditionally for as
  long as its condition holds. The loop supplies the evidence and the delivery;
  only the caller knows what the step was *for*. No callback, no change.

- **`arcturn insights`: a local ledger of what keeps going wrong, and the
  command that reads it.** Every serious defect found here this week was found
  by a person opening session JSONL by hand — which model went quiet, on which
  step, how often, whether the nudge recovered it, what a run cost before it
  parked. The engine knew all of it and kept none of it, so the second
  occurrence of a fault cost exactly what the first did. It now appends a
  failure-shaped ledger to `~/.arcturn/insights/events.jsonl` — a silent turn
  (with the model, whether it was nudged, and the workflow, run, step and role
  it belonged to), every step terminal, every park with its cause bucketed,
  every budget checkpoint, every progress warning and every run's end — and
  `arcturn insights` / `/insights` folds it into five answers: how runs end and
  what they cost, which step of which pipeline keeps parking and why, which
  models go quiet and how often the nudge recovers them, which failure kinds
  and roles dominate, and where the wall-clock time goes. `--since 7d|30d|all`,
  `--workflow <name>`, `--json`.

  The ledger holds names and numbers and nothing else: workflow names, run
  ids, step ids, role names, model ids, statuses, durations, token counts,
  tool-call counts. No prompt text, no reasoning, no file contents, no paths,
  no session ids — enforced by rebuilding every line field by field from a
  fixed whitelist rather than by a rule somebody has to remember, which is
  also how the run journal's `reasoningTail` is dropped on the way in. It
  rotates at 5 MB keeping one generation, a write that fails is one warning
  rather than a failed run, and `"insights": false` writes nothing at all.
  `--share` prints the report as markdown with a one-line statement of its
  contents and a pre-filled issue URL; nothing is ever sent for you.

- **A step now records what it spent its turns *on*, not just how many.** The
  eighty-turn builder above was, in every record the run kept, indistinguishable
  from a step that ran out of rope halfway through real work. Each step's
  terminal — and the park it may become — now carries the turn count, the
  per-tool call counts and how many of those calls authored a file, rendered
  wherever the last turn already was: `activity: 80 turns · bash 77 · read 17 ·
  no file written`. Counts and tool names only. And the write lane wires the
  new `progressCheck` to that same evidence — as a schedule that ends in a
  stop, because a notice a model can acknowledge and ignore is not a guard
  rail. A role that has changed no file is told so at **12 turns** (or half its
  ceiling, whichever is sooner), told again at **24** in a message that names
  the consequence, and **stopped at 36**: the child is aborted, the step fails
  as the new `no-progress` kind, and the run parks with what it did instead —
  `step 8 (@rag-builder) was stopped after 36 turns without changing a file —
  it read 114 files and ran 75 shell commands and wrote nothing`. Every
  threshold is a turn count, never a fraction of the ceiling, so a `raise 1000`
  answered at a park defers none of them. Read and exec lanes are never warned
  and never stopped — their diff is discarded unread, so writing nothing is
  their contract, not their fault.

  The step is not handed to a person first. A `no-progress` stall and the void
  (a step that changed no file and said no word) each buy **one automatic fresh
  attempt** — new worktree, new child agent, same prompt — before any park.
  That is the shape of every recovery on the runs behind this: a builder that
  stalled twice went on to finish in 82 turns with 30 writes on a fresh try,
  and an architect that went silent twice wrote its ADR on the next attempt,
  while the steps nobody retried burned ninety minutes each and then asked a
  human for the one thing the engine could have done itself. It is the only
  non-transient class that retries: a turn ceiling, a refused patch and a
  config error are still settled on the first attempt, and `maxStepRetries:`
  neither grants nor withholds this one. If the second attempt fails the same
  way the run parks as before, with `attempts: 2` and a cause naming what each
  attempt did, so nobody is steered at a `retry` that has already been tried.

- **`arcturn serve --allow-ceiling-raise`, and a parked run's diagnosis on the
  wire.** A `raise <n>` reply used to be refused outright over the wire, no
  matter how the run was started — the seam's contract, but also a dead end
  for anyone driving a parked run from an editor rather than a terminal.
  With the flag, a served host opts a `resumeWorkflow` answer of `raise <n>`
  into the exact parser and validation an interactive `raise <n>` gets
  (`parseBudgetRaiseAnswer`, one grammar, two origins) — off by default,
  because a raise spends the operator's own money or turns. The `authenticate`
  handshake now advertises `capabilities.ceilingRaise` so a client knows
  whether offering the affordance is meaningful before it tries, and every
  pending question on `workflowStatus` carries an optional `raise: { kind,
  current }` naming which parks a raise even applies to, plus — for a step
  parked on a failure — the same `diagnosis` line a terminal park prints:
  `describeLastTurn()`'s first sentence, capped at 240 characters, so a
  client shows *why* a step is parked without a person reading session
  JSONL. The VS Code extension (0.4.0) renders the diagnosis under the
  question and offers a "Raise ceiling…" action when both the capability and
  the park support it.

### Fixed

- **A `raise <n>` at a parked step no longer re-budgets every later step of
  that role.** The run-scoped grant was keyed by the step's `@role` when it had
  one, on the theory that a person who granted `@rag-builder` more turns had
  said something about the role. They had not: they had answered one question
  about one step. On a nine-stage pipeline a single `raise 1000` answered at
  step 5's park silently became the ceiling of steps 6, 7 and 8 as well —
  none of which anybody had been asked about — and steps 7 and 8 then ran 204
  and 185 turns with the 90-minute step deadline as their only remaining
  backstop. The grant is now keyed by step id: the step that was asked about
  gets the rope, and a later step of the same role runs under its role file's
  own number and parks with its own question if that is not enough, which is
  the explicit gesture the park exists to require. The role still rides the
  journal line, for the person reading it.

- **Scrolling the transcript is smooth, and stays smooth on a slow
  terminal.** Three measured causes, on the shipped binary under a
  pseudo-terminal. A one-row scroll changed every row of the frame, so the
  row diff — exactly right for a keystroke — degenerated into a 6.8 KB
  full-screen repaint for the smallest possible change; at 60 fps that was
  410 KB/s to move one line. A trackpad flick lands many wheel reports in
  one stdin chunk; all were applied and then painted once, so a 30-notch
  flick was one 30-row jump. And backpressure never engaged: stdout's
  high-water mark is 64 KB, about ten frames, so on a slow terminal the
  composer queued stale frames instead of dropping them — a 160 ms flick
  took 3.7 s to finish painting, and a keystroke typed during it took 3.7 s
  to echo.

  A pure vertical scroll is now handed to the terminal: the composer finds
  the band of rows that moved, scrolls it with a DECSTBM region and SU/SD,
  and repaints only the rows the move exposed — 273 bytes for one row
  instead of 6,814, and any frame that is not a pure shift takes the full
  diff exactly as before (`ARCTURN_NO_SCROLL_REGION=1` disables it).
  Wheel motion is metered: notches accumulate and are paid out a bounded
  number of rows per frame, so a flick is a run of small frames rather than
  a jump, and no notch is ever lost — the final position is the sum of the
  input. And the terminal now counts bytes in flight from its own write
  callbacks, so latest-wins frame dropping engages the moment the terminal
  falls behind: on a 20 KB/s drain the same flick finishes in 178 ms and a
  mid-flick keystroke echoes in 140 ms.

  Also fixed on the way: the footer's `End/G to follow` was a promise
  nothing kept — the editor bound End unconditionally, so the transcript
  never saw it. While the view is scrolled up, Home and End now go to the
  transcript; sending a prompt returns to the live tail.

- **A team member that produced nothing is `failed`, not `done`.** The same
  hole the workflow engine closed for steps, in the team supervisor: a member
  whose agent returned no text and changed no file was recorded `done`, then
  folded into `empty` at merge, and the team read as merged-and-complete
  while the member's work never existed. It is now `failed` with a cause in
  the same words as the step's, `merge()` reports it as a failure, and the
  team cannot read complete over it. A member that said something and
  changed nothing is still the honest `empty`.

- **A turn that returns nothing is handed back once, instead of ending the
  run.** A model can reason at length, close its thinking with "Now write.",
  and then end the turn emitting nothing at all — no text, no tool call,
  `stopReason: endTurn`. Not truncation, not the turn ceiling: it simply skips
  the act it just decided on. Observed twice in a row on one step of a real
  run, whose reasoning ran to 69,786 characters before going silent. The loop
  read that silence as a finished answer and returned `completed`, so the step
  reported success having produced literally nothing. Such a turn is now
  handed straight back with a prompt that reports the fact and supplies no
  content of its own — the model had already decided what to do, it only
  failed to do it. One nudge per silence: a model that answers with a second
  silence is finished or stuck, and the run stops rather than spending its
  budget to hear the same nothing. A turn that produced anything re-arms it,
  so a later void in a long run is caught too.

  This is the layer beneath the empty-step guard below. That guard stops a
  void from poisoning the seven stages after it; this stops most voids from
  happening. In the pipeline test drawn from the original run, the same
  failure now costs one extra request rather than a parked run and a human.

- **A step that produced nothing is no longer reported `done`.** A stage
  whose whole job was "write the ADR to `docs/adr/rag-architecture.md`" came
  back having written no file and said no word — `record{status:"empty",
  files:0}`, zero characters of text — and the engine called it a success.
  Seven later stages then cited an ADR that was never written, each
  re-deriving the architecture from an empty `{{prev}}` and disagreeing with
  the last; the run parked three times on ceilings that were never the real
  problem and burned hours before anyone looked back at the void. A step
  that changed no file *and* returned no text now fails, which on the park
  machinery means the run stops and asks: `retry` gives the role a second
  attempt, `abandon` ends it. Any non-empty text still counts — a read-lane
  reviewer that changes nothing is the common case, not a fault — and so
  does any changed file, for a builder that reports through its diff.
  `continueOnError: true` continues past it exactly as it does past any
  other failed step.


### Changed

- **`rag-blueprint`'s architect writes the ADR in sections, never in one
  call.** Two real runs on two different models ended the same way: the
  architect planned all eleven sections in its reasoning — 65,000 characters
  of it — closed with "Write the file now.", and ended its turn without
  making the `write` call; nudged, it did the same again, and the run parked
  with nothing on disk. A read-lane role on the same model wrote 23,000
  characters of *text* after 38,000 of reasoning without trouble; what does
  not survive is a single tool call asked to carry a thirty-kilobyte
  argument after that much thinking. The role now holds `edit` beside
  `write` and is told exactly how to use them: land the file with its
  headings first, fill one section per `edit`, read it back once. Its step
  output becomes a short handoff — path, headings, the five numbers the
  builder needs first — since every later role reads the file from disk
  anyway. The registry disclosure and the editor's bundled catalog follow.

- **Every model now hears that rule, in every lane — no kit author has to
  rediscover it at $40 a run.** The bullet above fixed one role file; the
  failure was never that role's. So the rule moves into the engine as one
  paragraph (`LARGE_CONTENT_RULE`, beside the threshold it quotes,
  `LARGE_CONTENT_CHARS` = 6,000 characters, about 100 lines) and is spliced,
  verbatim and identically, into the CLI system prompt, the brief every
  `subagent` child receives, both worktree lane contracts, and the `write` and
  `edit` tool descriptions the model reads immediately before making the call
  that fails. The silent-turn nudge names it too: a turn that went quiet is
  most often a turn that meant to hand a whole document to one call, and
  handing it back without saying so gets the same silence again. Nothing
  refuses a large argument — an 8 KB source file in one `write` is
  legitimate — the rule is advice, said everywhere it is needed. And because
  advice is useless to a role that holds `write` and nothing else, the kit
  conformance suite now fails any shipped role that can create a file but not
  fill one in stages: `design-author`, `resilience-author`, `baseline-author`
  and `scaffolder` gain `edit`, with the registry disclosures and the editor's
  bundled catalog following.

- **A build stage that took three tries to pass is now three steps that
  pass once.** `rag-blueprint`'s `rag-setup` scoped each of its three build
  slices — ingestion, retrieval, observability — as one agent step spanning
  an entire subsystem, and stage four failed three real runs: once on the
  40-minute deadline, twice on the turn ceiling, 24 files written and still
  not done. Each slice is now cut into two or three named sequential steps
  (rag-setup grows from nine stages to thirteen), each sized to finish well
  inside its ceiling, and the build roles' `maxTurns` rises from 50 to 80 so
  the session's 64-turn clamp — not a tighter role cap — is the only wall.
  The tests still run, but once: a step writes them beside the code and
  reports real pass/fail counts and exit codes, instead of paying a separate
  run-to-red then run-to-green round trip for every assertion.


## [0.5.8] — 2026-08-30

A run that ran out of rope now asks for more, instead of dying.

### Added

- **A failed step is a question, not a tombstone.** A step that exhausted
  its retries used to write `runEnd{failed}`, and a failed run is
  permanently unresumable — a nine-stage pipeline that got through four
  paid stages and then hit a turn ceiling on stage five could only be
  *re-bought*, survey, threat model, ADR and all. It now parks the run
  `paused` at a durable, answerable cut point, on the same machinery the
  stage-boundary budget ask rides. The step is still `failed` in
  `/workflow status`, in `--print` and in CI; the run is a question.
  `continueOnError: true` keeps its old meaning and never parks.
- **Three replies, all words.** `/workflow resume <id> retry` re-runs that
  step and continues — finished stages are replayed from the journal, never
  paid for twice. `abandon` ends the run `failed`, which is what it used to
  do by itself. `raise <n>` lifts a turn ceiling for that run only and
  retries. A bare resume re-states the question and spends nothing: a retry
  is money, and a script that nudges every stalled run must not be able to
  buy one. A second failure parks again with the attempt count.
- **A run-scoped turn raise lifts both halves of the ceiling.** A child's
  `maxTurns` is `min(role maxTurns, subagentMaxTurns)`, so editing the role
  file alone left a 64-turn wall exactly where it was — a trap that has
  already cost a real run. `raise <n>` lifts both, applies to the role so a
  later stage dispatching it inherits the rope, is journalled, and rewrites
  no file: the next fresh run starts from the role file's own number.
- **The turn ceiling finally has a human-facing alert.** The budget
  checkpoint watches dollars and tokens, so a run killed by *turns* at 5%
  of its token budget correctly never triggered it, and the wrap-up warning
  near a ceiling goes to the model — which can ignore it. The park says, to
  a person, that a turn ceiling and not a crash stopped the step, and that
  `raise <n>` is available.
- **Nothing on the wire lifts a ceiling — turns included.**
  `resumeWorkflow` accepts `retry` and `abandon`, refuses a bare resume as a
  nudge, and refuses `raise <n>` outright, naming the contract. The question
  a wire client is shown never advertises the reply it would only be
  refused for.

### Fixed

- **A retried worktree-lane step no longer collides with the worktree its
  failure kept.** A failed write- or exec-lane step preserves its worktree
  for forensics, and the worktree slug is keyed on the attempt index —
  which restarted at 0 on every resume, so a retry died with "a worktree
  already exists". The index now continues across resumes.

## [0.5.7] — 2026-08-30

The repository you cloned gets asked first.

### Added

- **A repository you cloned no longer runs its own code because you `cd`'d
  into it.** `<repo>/.arcturn` can declare lifecycle hooks, a `verify`
  command, extensions and stdio MCP servers — all of which run as you, and
  a `sessionStart` hook ran inside startup before you had typed anything.
  `arcturn --list-models`, a command whose whole job is printing a menu,
  imported every file in the repository's extension directory. Arcturn now
  asks once, in a prompt naming every command and file grouped by the file
  that declared it, and refuses by default. One decision covers all four,
  because they are the same decision: a `sessionStart` hook can write the
  extensions directory, `mcp.json` and your own config, so approving any
  one grants the rest anyway.
- **The approval covers what the project *is*, not where it lives.**
  Extension files are hashed recursively — an `index.ts` importing a
  changed `helpers.ts` re-asks — while hooks, `verify` and MCP servers are
  pinned by declaration. Editing `src/`, a README, a skill or your model
  choice never re-asks; adding a hook, touching any file under
  `extensions/`, or declaring a server does. A gate that re-asks for
  nothing is a gate that gets clicked through.
- **Off a terminal the answer is no, and the run still finishes.**
  `--print`, CI, `serve`, `acp`, `mcp-serve`, background agents and evals
  have nobody to ask, so project code stays off — never a hard exit, which
  would turn "your repo has a hook" into "arcturn no longer starts in CI".
  The warning is loud and unconditional, because a disabled project hook
  may have been a *protective* `preToolUse` guard. `arcturn serve` printed
  no startup warnings at all before this, and now prints them.
- **`arcturn trust` and `/trust`.** `--list` prints exactly what would run;
  `--allow`/`--deny`/`--revoke` record a decision in `~/.arcturn/trust.json`
  — user-scope, with deliberately no project spelling for a repository to
  write. Every verb says when the change takes effect in the same breath as
  saying it was saved.
- **`--trust-project` (`ARCTURN_TRUST_PROJECT=1`) for a pipeline that
  already trusts its checkout**, never persisted; `--no-project-code` to
  parse and list everything and run none of it; `trustedProjects` in your
  *user* config for paths you always trust, documented as the weaker,
  non-content-addressed thing it is and ignored outright from a project
  file.

### Fixed

- **A repository you cloned could switch off your permission prompts with
  four words of JSON.** `<repo>/.arcturn/config.json` saying
  `{"permissionMode": "yolo"}` outranked your own setting for that
  directory — no hook, no extension, no code execution, just data — and
  every tool you had not written an explicit `deny` for was auto-approved:
  bash, write, fetch, all of it. It did not even need the project-code
  gate's consent: a repository whose code you *declined* still got its
  mode. A project layer may now only *narrow* the mode, never widen it.
  Ordered by how much they let through, the modes run `plan` → `default` →
  `acceptEdits` → `yolo`; a repo asking for `plan` is honoured, one asking
  for `yolo` is ignored with a warning naming the file, the mode it wanted,
  the mode still in force, and the two deliberate ways to opt in. This is
  the rule permission *rules* have always followed — "a project allow
  cannot cancel a user deny" — finally applied to the mode.
  `--permission-mode` is you speaking and still wins in either direction.
- **A cloned repository's `mcp.json` could point Arcturn at a host of its
  choosing, ungated.** The project-code gate covered `stdio` servers and
  skipped `http` ones, inheriting `arcturn add`'s reasoning that an http
  server is "egress to a URL the disclosure already prints". Nobody reads a
  cloned repo's `mcp.json`, and the consequence is worse than egress:
  connecting hands the model tool names and descriptions *that host wrote*
  — a prompt-injection surface with no filter in front of it — and sends it
  every argument the model passes them, your conversation included.
  Project-declared `http` servers now sit in the same one decision as
  everything else, shown with their URL and the headers they would send,
  verbatim and unexpanded so `Bearer ${GITHUB_TOKEN}` reads as the
  disclosure it is. Flipping a trusted `stdio` entry to `http` at the same
  name re-asks; a grant you already gave a stdio-only project still stands.

- **`arcturn serve` now shuts down in bounded time.** A client that stopped
  answering — a wedged editor panel, a suspended laptop, or a bare TCP
  connection that never sends a byte — could hold the server open for
  thirty seconds or, in the un-upgraded case, indefinitely, so Ctrl+C
  printed "shutting down" and hung. Connections are now closed politely and
  then destroyed after a two-second grace period, and `stop()` is
  idempotent.

- **Background agents ignored your permission rules entirely.** A `/bg`
  agent was built with an empty rule list, so a `deny read "**/.env"` in
  your own config did not bind it — and a deny is the one decision no
  mode, `yolo` included, may override. The read-only toolset hid most of
  it, and hid none of it from a `yolo` background agent, which got the
  full tool set with no rules at all. A background agent now runs under
  the session's own rules, read fresh at each launch so a grant you made
  an hour in still reaches it. Your `allow` rules apply too, which is the
  other half of honouring what you wrote down; everything no rule covers
  is still denied outright, because a background agent has nobody to ask.
- **"Allow always" answered inside a sub-agent did not reach the
  conversation you were having.** The grant was recorded for future
  children and written to your config, but never applied to the live
  agent — so the main conversation asked again for the identical thing on
  its next turn, and `/permissions` did not list it. One helper now puts a
  rule into force in all three places at once: the live engine, the
  session list every child is seeded from, and the config file.
- **`/permissions suggest` said "Saved" and changed nothing about the
  running session.** Nothing re-reads a config file mid-run, so the rule
  you had just approved took effect on the *next* launch while Arcturn
  went on prompting for it. It now applies immediately and persists, and
  the notice says both.
- **A permission rule that could not be written vanished without a word.**
  An unwritable `~/.arcturn` meant "Allow always" worked all session and
  was gone on relaunch, with nothing said. Saving stays best-effort — the
  rule still holds for the rest of the run — but a failed write now names
  the rule and tells you it will not outlive the session.

### Added

- **Point Arcturn at your own endpoint from configuration, not from code.**
  A `providers` block declares a gateway — LiteLLM, a vLLM cluster, an
  internal proxy, Ollama on another host — as the same
  `{ baseUrl, apiKeyEnv, protocol }` triple the built-in presets are, and it
  builds its specs through the same function, so ids namespace
  `<name>/<model>` and the entry appears in `--list-models`,
  `--list-providers`, `/model` and `arcturn doctor` exactly as a preset
  does. Shipping an extension that calls `openaiCompatible(...)` was the
  only way to do this before, and for a company with a gateway that is not
  a plugin problem — it is a config line. Registering from code still
  works and still wins: config is applied before extensions load.
- **A project config cannot point your credential at a host you did not
  choose.** Project config outranks user config by design, so a cloned
  repository could otherwise declare an endpoint, name it as the model,
  and put a real key on its socket with the first message you typed. A
  declaration in your own `~/.arcturn/config.json` is trusted. One in a
  project's config parses, validates, and lists as *declared (not
  enabled)* — never registered, never resolved, never contacted until you
  approve it once. `--model x/y` fails naming the file that declared it,
  and `arcturn doctor` reports it `not enabled` and sends nothing, because
  doctor probes with your real key by design and must not be the thing
  that delivers it. Approving writes a per-(origin, name, variable)
  `provider` rule to your user file, so approving in one clone does not
  approve a same-named entry in another, and re-pointing an approved URL
  at a different credential asks again. Off a TTY the answer is always no.
  The gate is defence in depth against a repository that declares an
  endpoint in *data*; it is not a boundary against one that can execute
  code, since project hooks and project extensions still run ungated —
  [Permissions](/docs/permissions) says so plainly.
- **`--trust-providers` and `--no-providers`**, mirroring `arcturn add`'s
  `--yes` and `--skills-only`: the first enables project-declared
  endpoints without asking, for CI that already trusts the repository it
  checked out (and deliberately saves nothing); the second registers
  nothing from any `providers` block, user layer included, while
  everything still parses and still lists.

### Changed

- **A declared provider is sent the variable it names, and nothing else.**
  `resolveApiKey` treats a spec's `apiKeyEnv` as the first name in a
  chain, falling back to the provider default — so a declared endpoint
  naming a variable you do not have set would have been handed your real
  `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, and the consent prompt would
  have named the variable you lack while the wire carried the one you
  have. A config-declared spec now resolves its named variable
  exclusively: no provider default, no alternates, no client-level
  override. If that variable is unset the session refuses and says which
  variable and which file. Only a loopback endpoint may omit `apiKeyEnv`,
  and omitting it means no credential at all — the local-runtime case.
- **`providers` merges with the user layer winning**, unlike `route`. A
  project file may add a name you never declared (still gated) but may
  never repoint one you did; the dropped entry warns, quoting both files.
- **A declared `baseUrl` is stored and shown normalised**, and one
  containing a control character is refused — that URL is printed in the
  prompt asking whether to trust it, and an escape sequence there can
  repaint the prompt to say anything.

### Fixed

- **Pasting into the prompt could interrupt the session and mangle the
  line.** Arcturn has always asked for bracketed paste and always
  understood the markers — but an unfinished paste was parked in the same
  buffer as an unfinished escape sequence, and that buffer has a 30ms
  resolver behind it. Terminals pace a long paste in chunks, so any lull
  past 30ms handed the paste to the resolver, which read the marker's
  leading `ESC` as the escape key and everything after it as typing: an
  interrupt, a literal `[200~` in the buffer, and a `/workflow …` line
  that could no longer dispatch. Pasted bytes now accumulate on their own,
  where neither timer reaches them; a marker split across chunks is
  reassembled at either end; and an `ESC[201~` that never arrives is given
  two seconds before what did arrive is delivered as text — never as key
  presses. The decoder is no longer quadratic in the size of a paste
  either: a few hundred kilobytes used to cost half a second of pure
  string search before one byte reached the editor.

## [0.5.6] — 2026-08-30

A ceiling that stops you dead is a worse ceiling than one that asks — and
a release that refused to go out until we read what it was telling us.

### Fixed

- **Session entries could be silently lost when two writers shared one
  session file** — a served session beside a terminal one, a background
  agent beside its parent. Three defects compounded: the write queue was
  per-store rather than per-file, so two stores never serialized against
  each other; `appendFile` splits above 512 KiB, so large entries could be
  spliced into one another; and crash recovery truncated any tail that did
  not end in a newline — which is equally a writer that has not *finished*
  writing, so a healthy line was waited for and then deleted, with no
  throw and no trace. Appends are now serialized per file across the
  process, written as one `write`, and a damaged tail is repaired only
  once it is proven dead. This is the "flaky test" that failed two release
  matrices; it was never flaky, and it was losing data.
- **Session titling could fail permanently and silently on Windows**,
  where the header rewrite's `rename` loses to an antivirus scanner or the
  search indexer holding the target. The rewrite now retries `EPERM`,
  `EACCES` and `EBUSY` with a short backoff.

### Changed

- **A session damaged by an interrupted write now says so once**, instead
  of quietly returning one entry fewer. `JsonlSessionStoreOptions.onWarning`
  (core) carries it; the CLI surfaces it as a warning notice.
- **A title that cannot be written now reports a warning notice** instead
  of vanishing. Titling stays best-effort — it never breaks, slows or
  retries a run — but a failure is now something you can see.
  `ArcturnRuntime.sessionTitleSettled()` lets a host wait for the attempt.

### Added

- **A budget checkpoint you can answer, instead of a corpse with a patch.**
  A run that crossed `budgetUsd:`/`budgetTokens:` used to die: the ceiling
  stop writes `runEnd{failed}`, and a failed run can never be resumed. Now,
  at the first stage boundary where either ceiling is 80% consumed and
  stages remain, the run parks itself resumably and asks. Reply `continue`
  to run on to the hard stop, or `raise <new-limit>` to lift the ceiling —
  for that run only, never written back to the workflow file. It asks once
  per ceiling; a raise re-arms it against the new limit. Consent has to be
  spoken: a bare `/workflow resume <id>` re-surfaces the question rather
  than acknowledging it, so a script that routinely resumes stalled runs
  cannot spend your budget on your behalf. Raises are terminal-only — the
  wire refuses them, and a run started under a client-lowered ceiling keeps
  that ceiling through every resume.
- **The turn ceiling is announced before it bites.** A run used to learn
  about `maxTurns` only by hitting it — an agent at turn 50 of 50, still
  polishing work it never got to report, failing with the work done but
  undelivered. When remaining turns first drop to
  `turnWarningThreshold(maxTurns)` (now exported from `@arcturn/core`), the
  loop injects one message telling the model to finish and deliver, riding
  the next request without spending a turn of its own. A run that finishes
  well under budget never hears about the ceiling, and a tight leash of one
  or two turns is left alone entirely.

### Changed

- **A step that runs out of turns says so.** Turn exhaustion used to reach
  the workflow as the same anonymous error a dead socket produces: the step
  failed, its text was discarded, and the run's stop reason was `error`.
  Now the failure names the cause and the fix (`raise maxTurns in the role
  file or narrow the step`), the run records `stop: turn-ceiling` — the
  reason the vocabulary declared and nothing had ever written — and the
  agent's last words are kept on the step record instead of thrown away.
  `@arcturn/core` exports `isTurnCeilingError(message)` so a host can tell
  "ran out of rope" from "broke".

## [0.5.5] — 2026-08-30

Four features from one bad afternoon: the endpoint that lied about its
balance, the budget that could never fire, the workflow file you had to
write blind, and the routes you could not see.

### Added

- **`arcturn doctor` — ask every endpoint before a session has to.** It sends
  each configured provider endpoint a one-token completion with your real key,
  retries off, and prints a verdict per endpoint: ok with latency, auth failed
  naming the variable, rate limited, network — and **no balance**, the verdict
  that motivated it. A coding-plan key pointed at Z.AI's general endpoint
  answers "429 Insufficient balance" (code 1113), which reads as billing when
  the actual problem is the base URL; doctor calls it what it is and names the
  sibling preset the key may belong to. The default run covers everything your
  config references — the failover chain, every route and tier, consensus
  models — flags a `route.main` that outvotes `model`, reports which variable
  really supplied each key, and skips what has no key set.
  `arcturn doctor <preset>` probes one endpoint; `--model <id>` picks the wire
  model. Exit 0 when everything answers, 1 when something failed, 2 for a
  usage error. No key material is ever printed.
- **`budgetTokens:` — a workflow run ceiling that works when pricing doesn't.**
  A workflow's `budgetUsd:` compares the run's spend against its ceiling, and
  on a model that publishes no pricing (a coding-plan endpoint, Ollama, vLLM)
  that spend is never computed — the ceiling silently never fires. The new
  `budgetTokens:` frontmatter key caps the run by total tokens consumed
  instead — input, output and both cache buckets, the numbers every model
  reports — and halts the run with a `token-ceiling` stop the moment the total
  exceeds it, skipping every later stage. `0` and absent both disable it, like
  `budgetUsd:`; when one stage crosses both ceilings, the run reports
  `cost-ceiling`, deterministically. `/workflow status` now shows every run's
  token total beside its spend. Frontmatter-only in this first version: not
  settable over the wire, and no per-stage or per-role token caps. The
  rag-blueprint kit's `rag-setup` now carries one.
- **A visual workflow builder on the site** (`arcturn.dev/builder`): assemble
  stages, parallel branches, model tags, roles and the seven frontmatter keys
  in the browser and take away the markdown file the CLI runs — or paste an
  existing workflow in and edit it. The page is fully static: one client
  island over a parser that mirrors the engine's grammar line for line,
  validating inline with the engine's own error messages — including the
  warning the engine never gives, that a name it would silently normalise is
  not the name you typed. The example picker loads the real kit workflows,
  read from disk at export time, and a round-trip through the builder reaches
  a fixed point. Nothing is uploaded and nothing is stored.
- **`/model route` — routing you can see and change without opening a config
  file.** Bare, it prints where `main`, `subagent`, `compaction` and `title`
  actually resolve, warnings included. `--auto` finds the cheapest
  same-vendor (same id namespace — the `provider` field alone cannot tell
  openai-protocol vendors apart), tool-capable model with published pricing
  that undercuts a priced main, and routes sub-agents and compaction to
  it — live at once, saved to your user config
  (the project layer is never written, and the command says so when a project
  `route` will outrank the save). It refuses to "optimise" your bill upward,
  and `<kind> <id>` / `clear [kind]` manage single routes by hand. `main`
  still belongs to `/model <id>`.
- **Interactive sessions name themselves.** After the first completed run, one
  small call on the `title` route writes a generated title onto the session —
  `/sessions` and the startup splash show "Fixing the login redirect" instead
  of a bare id. One attempt per session, failures swallowed, and a session
  that already has a title is never re-titled — an untitled session from
  before this feature picks one up the next time it completes a run;
  `--print` and serve streams stay byte-for-byte contractual.
  `sessionTitles: false` turns it off.

### Changed

- **The `compaction` route is now consumed.** When a `compaction` route is
  explicitly configured — in config, or via `/model route` — every agent's
  compaction summarizer uses it, read live at compact time, so a mid-session
  `/model route --auto` governs the very next compaction. Unrouted agents
  keep compacting with their own model, and a standing `route.main`
  deliberately does not count: a sub-agent on the cheap route is never
  silently upgraded to the flagship.

## [0.5.4] — 2026-08-30

One complaint, chased to both of its roots: a model you picked should be the
model you get — everywhere, and still tomorrow.

### Changed

- **A `/model` pick now sticks, in the CLI too.** Switching models persists
  the choice to `~/.arcturn/config.json` as the new default — the extension's
  picker has worked this way since 0.2.0, and the terminal now keeps the same
  promise. A user-layer `route.main` moves with the pick, because a pick that
  only wrote `model` would look saved and change nothing: `route.main`
  outvotes it wherever a route is resolved. The other route keys and `tiers`
  are policy, not the pick, and stay put; so does a project-layer config,
  which outranks the user layer on purpose. A `model` failover chain keeps
  its tail — the pick becomes the head, the fallbacks stay behind it. If the
  write fails, the session still switches and says why the save did not.

### Fixed

- **An in-session model switch now governs routed calls.** With `route.main`
  set in config, `/model` changed what the chat spoke while sub-agents, tier
  fallbacks and workflow stages quietly kept resolving — and billing — the
  configured model. `rebind` now clears the `main` override: an explicit
  switch is a choice of main model everywhere. Per-kind overrides
  (`subagent`, `compaction`, `title`) and `tiers` survive, as deliberate
  policy should.

## [0.5.3] — 2026-08-29

A session's worth of field reports from real use, and the terminal work they
turned into: text selection that behaves like a modern application, scrolling
that is smooth, permission modes that change when you need them to, files that
attach from anywhere, and a retrieval-system kit for the thing everyone is
trying to build.

### Added

- **A RAG blueprint kit** (`kits/rag-blueprint`, and in the Hub): eight roles,
  two pipelines and three skills for building and auditing retrieval systems
  on your own stack. `rag-setup` surveys what exists, threat-models before it
  designs, writes an ADR to a file, builds ingestion, retrieval and
  observability in serialized slices, then gates shipping on red-team drills
  and an evaluation suite whose author holds no shell to run it.
  `rag-review` points the same discipline at a system you already have. It
  designs against the failures that actually sink these systems — chunking
  checked against the embedder's context window, the retrieve-k → rerank-n
  cascade with its per-candidate cost, entitlement filtering with its recall
  cost measured for a low-entitlement identity, a semantic cache keyed to
  include entitlement (one keyed on the query alone leaks past a correct
  filter), orphan chunks, and the dual-index migration an embedding-model
  change requires. No model verdict blocks; the drills refuse to run without
  a confirmed scratch index.

- **Attach files from anywhere — drag and drop, both front-ends.** The rule,
  stated once and enforced in one place: *an absolute path attaches from
  anywhere; a relative path stays inside the workspace.* Writing `/` — or
  dragging a file in, which always produces an absolute path — is an explicit
  gesture at a known location; the covert escape (`src/../../secrets`, a
  symlink inside the tree pointing out) stays refused exactly as before. In
  the **VS Code panel**, dropping a file from Finder or picking one in the
  Attach dialog now works for any file on disk. In the **terminal**, a drop
  arrives as a pasted path — the composer recognises it (Finder's escaped
  spaces, quoted paths, multi-file drops included) and rewrites it into
  `@`-mentions on the spot; prose and code paste untouched. `resolveContext`
  answers honestly for an outside file (`inWorkspace: false`, real size and
  kind) while a refused relative escape stays a blind wall — no filesystem
  oracle.

- **Change the permission mode and model mid-run, in both front-ends.** The
  engine now applies `setPermissionMode` while a run is in flight — the mode
  lands on the very next permission evaluation, which is exactly when "stop
  asking, accept edits" is worth saying; a prompt already on screen settles
  under the answer you give it, and a stored `deny` rule still outranks
  every mode. The VS Code panel's mode chip therefore works during a run
  (older engines still refuse politely, and the chip explains). In the
  terminal, **Shift+Tab cycles default → acceptEdits → plan** any time —
  idle, mid-run, even with a permission prompt up (`yolo` stays out of the
  cycle; a bypass should never be one accidental keystroke away). `/model`
  mid-run says honestly that it applies from the next request.

- **Double-click selects the word, triple-click the row** — copied
  immediately, highlight left up as the receipt. A word is the contiguous
  non-whitespace run, so file paths, URLs and identifiers come out whole.
  The copy receipt lives in the status bar's centre slot ("✓ Copied 214
  chars"), not the transcript, so nothing shifts under a pointer that is
  mid-gesture.

- **The clipboard follows you home over SSH.** OSC 52 joins the copy chain
  (tmux passthrough included): over SSH it goes first — a remote `pbcopy`
  writes the remote clipboard, never the one you mean — and locally it is
  the fallback behind the native pipes. It refuses to truncate oversized
  payloads rather than copy half a selection silently.

- **A daily one-line update notice.** Once a day the CLI asks npm whether a
  newer `arcturn` exists and says so in one muted line at startup — never an
  install. `updateCheck: false` silences it.

- **A run that finishes behind your back says so.** Focus reporting tells
  the app whether the window is watched; a run ending unfocused rings the
  terminal's notification channel (OSC 9 plus BEL — a banner in iTerm2 and
  kitty, a badge in VS Code). A watched run and an interrupt ring nothing;
  `notify: false` turns it off.

- **Clickable paths and links (OSC 8).** Markdown links are real hyperlinks,
  and a tool card's file path links to its `file://` location — `src/cart.ts`
  opens in the editor straight from the transcript in emulators that render
  hyperlinks; the rest show the label and lose nothing.

- **Shift+Enter works in terminals that can say it.** The kitty keyboard
  protocol's disambiguate tier is negotiated with the screen, so modified
  Enter and a clean ESC arrive unambiguously in kitty, WezTerm, foot and
  ghostty; older terminals ignore the request.

- **The code highlighter knows which language it is reading**: per-language
  keyword sets over the shared core (SQL's `select` stops lighting up in
  TypeScript; Rust gets `fn` and `mut`, Python gets `elif` and `lambda`),
  fence-tag aliases, and value-like words — `true`, `nil`, `None` — painted
  as values.

- **`/ui` switches the renderer without editing a config file.** The
  full-screen app stays the default — it owns the whole history, repaints
  cleanly on resize, and restores your shell untouched on exit. `/ui inline`
  (picker on bare `/ui`) persists the terminal-native alternative, where the
  transcript flows into the terminal's own scrollback and selection,
  scrolling and copy are the terminal's own gestures. Honest about timing: a
  renderer is chosen at launch, so the switch lands next launch. `ARCTURN_UI`
  and the `ui` config field still pin it per project.

- **`/copy` puts the last answer on the clipboard** — `/copy all` the whole
  conversation as markdown. The alternate screen caps mouse selection at one
  visible frame, so an answer longer than the screen could never be selected
  at all; this is the copy that needs no selection. It pipes to the
  platform's own tool (`pbcopy`, `clip`, `wl-copy`/`xclip`/`xsel`, in that
  order on Linux so a Wayland session lands on the clipboard its apps read),
  falls through tools that are missing *or* broken, and names what it tried
  when nothing worked instead of pretending.

### Fixed

- **Scrolling is smooth now.** Two causes, both fixed in the renderer: every
  stdin chunk used to paint its own full frame, so a wheel flick sheared at
  chunk rate — a ~60fps frame governor now collapses request floods into
  steady trailing frames (the first paint after quiet stays immediate, so a
  lone keystroke never waits); and each wheel event jumped three rows while
  modern emulators already multiply a physical notch into several events, so
  scrolling was chunky *and* 3× overspeed — one row per event now. Typing at
  the composer's right edge also wraps properly: the caret used to render
  one column past a full row and get truncated into an ellipsis; it now
  drops to a fresh continuation line the way a terminal wraps.

- **Selecting text is one gesture: drag, release, it's on the clipboard.**
  The full-screen app owns selection now instead of negotiating with the
  terminal for it. The mouse grab uses cell-motion reporting, so a drag
  arrives as it happens: the transcript highlights the span live (reverse
  video, column-precise through colours, wide glyphs and wrapped lines),
  riding the top or bottom edge auto-scrolls so a selection can grow across
  any number of screenfuls — the thing terminal-side selection in an
  alternate screen can never do — and on release the text is piped straight
  to the system clipboard, plain and trimmed, with a one-line `✓ Copied N
  chars` receipt. A click selects nothing, the wheel never stops working,
  and nothing is a mode. Shift-drag still reaches the terminal's own
  selection, and `/copy` / `/export` still cover whole answers and whole
  conversations without any mouse at all.

## [0.5.2] — 2026-08-29

Three small fixes from the first real user session, each of a shape the suite
could not have found on its own: a person following the docs on a fresh
machine hit all three inside an hour.

### Fixed

- **A fresh repository is refused with its fix, not with git's riddle.** The
  very first step of the setup playbook — `mkdir`, `git init`,
  `/workflow app-setup` — died with `invalid reference: HEAD`, because a
  freshly initialized repository's HEAD points at a branch with no commit and
  a worktree needs one to branch from. Worktree creation now probes for the
  unborn HEAD up front and refuses with the next command in the message:
  `git commit --allow-empty -m "chore: init"`. Workflows, scouts and teams
  all go through the same gate; a caller that pins a concrete ref skips the
  probe, having already decided what to branch from.

- **`/help` answers the most-asked question there is.** The TUI holds the
  mouse for wheel scrolling, which silently disables the terminal's own
  click-drag selection — so "why can't I copy?" had a ten-second answer that
  lived nowhere. The keybindings line now names the bypass (Shift-drag in
  VS Code and most terminals, Option on iTerm2, Fn on Apple Terminal) and
  points at `/export` for the whole conversation.

- **The status bar's number stops living in the last column.** `ctx 41%` was
  rendered flush against the terminal's final cell, and two kinds of emulator
  disagree with the renderer about that cell: those that draw East-Asian-
  ambiguous glyphs wide (the ✦ brand mark is one, counted as a single cell by
  the width tracker) shift the whole line a column right, and some mishandle
  the final column outright. The right group now ends one cell in from the
  edge — a margin that absorbs both failure modes — while the bar's
  background still fills the full width.

### Kits

- `/hld-draft` and `/arch-map` (design-docs, fetched from GitHub rather than
  npm) now end with a **Where it goes** contract: `docs/design/hld-<topic>.md`
  and `docs/design/arch-map.md`, with chat carrying only the path and the
  summary line. The design-review workflow reads the record from disk, and a
  design that lives in terminal scrollback is gone when the session is.


## [0.5.1] — 2026-08-29

A patch with one job: make the hub's kits and the published engine speak the
same language again. The kits on GitHub now name models by *tier* —
`tier:judgment`, `tier:build`, `tier:fast` — and 0.5.0's resolvers, which
predate the wiring, refuse those tags as unknown ids. Anyone on 0.5.0 who
runs `arcturn add` today gets kits their engine cannot run.

### Fixed

- **`tier:` tags resolve.** The router and the workflow grammar have carried
  symbolic tiers since before 0.5.0, documented as the way a kit stays
  portable across providers — and no resolution seam ever consulted them, so
  a tier tag fell through to the model catalog and failed as an unknown id.
  All three seams are wired now: the terminal's workflow commands, the serve
  path a panel's runs go through, and the `subagent` tool resolving a role's
  own `model:`. A tier the config never named falls back to the user's main
  model inside `specForTier`, so a tier-authored kit runs on whatever the
  user configured with no `route.tiers` block required — which is the whole
  point. Deployments that want, say, a stronger model for judgment roles set
  `route.tiers` once.

- **A team could report itself merged while one member's work never
  existed.** Pinned at last, after three sessions on the suspect list: on a
  loaded CI mac, `git worktree add` for one member was killed by the 15-second
  per-git timeout — its entire recorded error was "Preparing worktree…", the
  progress line of a process that was killed rather than one that failed — and
  the member landed as failed with an empty diff. `merge()` then folded that
  into "no changes": one file applied, zero conflicts, `complete: true`, the
  record flipped to `merged`. Two fixes, each mutation-tested. `worktree add`
  now gets its own timeout (four times the quick-op budget, floored at a
  minute) because it performs a full checkout and scales with the repository
  while every other git call here is metadata — and a kill now says it timed
  out instead of quoting a progress line. And a failed member is a `failed`
  merge outcome that keeps `complete` false and the team out of `merged`:
  "changed nothing" and "never got to work" are different news.

- **A timed-out foreground command's process tree is killed twice, on
  purpose.** A SIGKILL to a process group enumerates its members at delivery,
  and a fork in flight on another CPU slips the enumeration — the child is
  born a moment after its group was killed and survives, which for a shape
  like `npm run dev` means the server the timeout was supposed to stop keeps
  running. A loaded CI runner caught the race in the act. The group is now
  killed once more after the drain delay; anything born in the gap has long
  finished forking by then.

- **Why this exists at all:** every role in nine hub kits used to pin a
  concrete provider model (`anthropic/claude-opus-5` and siblings, plus two
  `zai/glm-5.3` step tags), which made every workflow in the hub answer 401
  to anyone whose key for that one provider was missing or dead — while the
  model they actually configured sat unused. The kits were rewritten to tiers
  in the same change, and a hub test now walks every role's `model:` line and
  every step's `[tag]` and refuses any concrete id, so a kit can never pin a
  billing account again.


## [0.5.0] — 2026-08-29

The minor bump is the wire protocol again: eleven additive verbs, one new
attachment kind, and no change to anything an existing client sends. The
theme is one sentence — the engine had whole capabilities no client could
reach — and every entry below is a seam that already worked in the terminal
becoming reachable over a socket.

### Added

- **MCP OAuth can be brokered by the client** (`mcpAuthBegin`,
  `mcpAuthComplete`, `mcpAuthCancel`). The engine's own loopback redirect is
  correct on a laptop and wrong wherever the browser and the engine are
  different machines — an editor over Remote-SSH, a devcontainer, a Codespace.
  A client now brings a redirect URI it can actually catch; discovery, dynamic
  client registration, PKCE and the tokens never leave the engine, and `state`
  is the engine's to issue and verify. The redirect listener behind
  `arcturn mcp auth` became an injectable seam to make this possible; loopback
  is still the default and the terminal flow is unchanged.

- **The other two thirds of MCP** (`mcpResources`, `mcpReadResource`,
  `mcpPrompts`, `mcpGetPrompt`, and the `mcpResource` prompt-attachment kind).
  A server publishes tools, resources and prompt templates; only tools ever
  crossed this wire. A client can now list what a server offers, preview it,
  and attach a resource *by name* — the engine reads it at prompt time, inside
  the same byte budget a file gets, so a remote server's bytes are counted
  where every other read is counted. Every description a server wrote is
  sanitized on the way to a menu exactly as a skill's frontmatter is; resource
  contents are deliberately not, and the wire type marks them untrusted.
  Prompt templates also appear in `listCommands` as `kind: "mcpPrompt"`,
  named `server:name`, because a template's name is unique only per server.
  `McpManager` gained `listResourceTemplates`, the half of the listing it was
  missing.

- **Scout runs have a record** (`startScout`, `scoutRun`, `cancelScout`).
  `/scout` was deliberately off the wire, and the recorded reason was honest: a
  run left nothing behind to report on or cancel. `ScoutRegistry` is that
  record — `startScout` answers with an id immediately, results stream into
  `scoutRun` as each approach settles, and a cancel aborts the survivors while
  keeping what finished. Worktrees are still torn down in the engine's own
  `finally`; each approach's diff is captured into memory first, which is why
  a client can render a comparison at all. Records are per-process and do not
  survive an engine restart — the honest limit, written on the type.

- **`exportSession`, `listCheckpoints` and `rewindTo` unchanged but newly
  consumed** — listed here only because the VS Code extension 0.2.0 releasing
  alongside is their first caller outside the terminal.

### Fixed

- **A background agent whose owner's pid was reused could stay `running`
  forever.** The `ownerPid` lease added in 0.4.0 answers "is that process
  alive", which is not quite the question: an operating system reuses pid
  numbers, so a crashed manager's number could be adopted by something
  unrelated and the liveness check would answer yes for good, with no way for
  anyone to clear the record. The lease grew its missing half — a heartbeat
  renewed while the agent actually runs, stale after a minute. A record with
  no heartbeat was written by an older build and falls back to the pid check
  alone, because declaring a live agent from last week's build dead is the
  exact failure the mechanism exists to prevent. Both halves are
  mutation-tested: dropping the staleness check fails the pid-reuse test, and
  dropping the renewal fails the test that watches the stamp move on disk.


## [0.4.0] — 2026-08-27

### Fixed

- **Reopening a session from history gave you an empty panel and an agent with
  no memory of it.** Picking an earlier conversation out of the history list
  listed the session, drew its title, and then showed nothing — and the half
  that did not announce itself was worse: the agent behind it had been built
  fresh, so the next thing you said was answered with no knowledge of anything
  above it. Two probes, one replaying the transcript and one capturing the
  outgoing request to a stub provider, put numbers on both halves: three events
  replayed in-process and zero after a restart, and the model's request
  containing the earlier turn before and not after.

  The cause was a type rather than a policy. `serve` built every session
  through a synchronous agent factory, and rebuilding a stored branch means
  reading the session file — which is asynchronous. A synchronous factory can
  only ever start a conversation over, so the note in the code promising that
  the factory resumed described something that was never reachable from it.

  The factory may now return a promise and is told whether it is opening or
  creating. Opening a session that is **already live** rebuilds nothing: that
  agent may be mid-turn, holding steering text, a pending permission ask, or
  messages not yet written, and re-resuming from disk would discard all of it
  on behalf of whoever attached second. Opens in flight share one promise, so
  two attaches in the same tick cannot leave two agents appending to one file.
  The stored model is read **before** the agent is built, because an agent
  fixes its compaction budget from the model's context window at construction
  — adopting a model afterwards would compact to one model's budget while
  talking to another.

- **The file you merely had *open* was injected in full, on every turn.** The
  VS Code panel's ambient chip attached the active editor as
  `{ kind: "file", path }`, and the engine read it whole — so every message you
  sent carried the entire file whether or not the question touched it, for a
  file you never asked for. Measured on this repo at `zai-api/glm-5.2` input
  rates: `packages/protocol/src/client.ts` (2,161 lines) cost about 22,600
  tokens a turn, $0.63 over twenty turns; `packages/cli/src/workflow.ts` (7,251
  lines) about 81,200 a turn, $2.27. Nothing caught it because nothing about it
  failed: the prompt resolved, the run completed, and only the bill said
  otherwise.

  An open file with **nothing selected** now travels as a *reference* — the new
  `kind: "fileReference"`, which names the path and sends none of the bytes.
  What the model sees is one line: `src/session.ts (referenced file — the client
  named this path as relevant context; its contents were not read and are not
  included here. Use the read tool to open it if this turn needs it.)`. No
  fenced block and no `(attached file)` heading, because those are what a block
  *with* content looks like. The agent has a `read` tool, so it pays for the
  file on the turns where it matters instead of all of them.

  **A selection is unchanged, and so is `@`.** Highlighted lines still travel as
  `{ kind: "file", range }` and arrive as the excerpt: the user pointed at
  something, and the excerpt is small, precise and unambiguously it. An explicit
  `@` attachment still carries contents at any size — quietly downgrading a file
  somebody asked for is the same dishonesty pointed the other way. "Too big"
  keeps the answers it already had, all of which report themselves: truncation
  with a marker at 2000 lines / 200 KiB, a refusal with both numbers at the
  2 MiB per-file ceiling, and a refusal naming the attachment that did not fit
  at the 1 MiB total budget.

  **The chip says what will happen**, which is its whole design principle, so
  its wording moved with the wire: with a selection it still reads
  `29 lines of 4.2 KB`; without one it read `4.2 KB` and now reads `path only,
  contents not sent`, with the hover explaining that Arcturn reads the file
  itself if the question needs it — and naming the size as what is *not* being
  spent per turn.

  **The degradation was designed to fail the safe way.** Had this been
  `{ kind: "file", mode: "reference" }`, an older engine would drop the unknown
  field and inject the whole file — the exact bug, silently, at the user's
  expense. As a *kind*, an older engine's own validator refuses the frame and no
  turn is spent. `resolveContext` additionally reports `attachmentKinds`, so
  `ProtocolClient.prompt` refuses locally with a sentence a person can act on
  rather than a complaint about a wire enum, and the panel shows no chip at all
  — the rule it already applied to an engine with no `resolveContext`, since a
  chip whose file could never be sent is worse than none. The refusal is
  per-kind: plain attachments, ranges and `@` mentions keep working against that
  engine. What nothing does is fall back to sending the file.

- **A dry-run permission prompt named a file you have never heard of.** The
  overlay rewrites a tool's `path` to the shadow copy before the tool runs, and
  `write` builds its own permission ask from the path it was handed — so under
  `--dry-run` the dialog read `Overwrite file
  /Users/…/.arcturn/overlays/01H…/src/app.ts`, and the "always allow" it offered
  would have persisted a rule scoped to a directory `/discard` deletes: a grant
  the user was told they made and did not. The ask is now restated in workspace
  terms — subject, description and suggested rule — on its way to the permission
  engine. Rule *enforcement* was never affected: the agent loop checks
  permissions against the raw path before any redirect, which is why a denied
  write never becomes a pending change.

- **`@`-mentions were never expanded on the serve path.** `expandMentions` ran
  in `--print` and the TUI and nowhere else, so a prompt arriving over
  `arcturn serve` was handed to the model verbatim: `@src/auth.ts` reached it as
  six words about a file rather than the file. Every remote client — the VS Code
  panel, `arcturn attach`, the browser page — was silently degraded, and nothing
  caught it because the returned promise resolved and the run completed; only
  the *content* was missing. The served agent now expands mentions against the
  session's `cwd` by calling the same function the TUI calls, not a second one.
  A mention that resolves outside the workspace — lexically, or through a
  symlink that leaves it — is refused rather than read, and the server now emits
  a `notice` saying so, because over the wire a mention that quietly did nothing
  was indistinguishable from one that worked.

- **A skill's arguments could name its substitution tokens.** `$ARGUMENTS` was
  substituted before `$SKILL_DIR` and `$CWD`, and the result was then scanned
  again — so an argument of `$SKILL_DIR/../../etc/passwd` came back with the
  skill folder's real absolute path spliced into it. Harmless enough while the
  only caller was a person typing into their own terminal; RFC 0005 §1.3 makes
  arguments remote-caller text, and remote text that can name substitution
  tokens is an injection channel that also discloses where the skill library
  lives. Expansion is now a single pass: a template's own tokens expand, and
  what they expand to is final. Affects `/name` in the terminal, the
  model-invoked `skill` tool and the serve path alike, since all three share one
  expander.

### Changed

- **VS Code: the transcript says who spoke by shape, and says when it
  finished.** Every message carried a `YOU` or `ARCTURN` caption in uppercase,
  above both halves of every exchange — chrome the eye stepped over on the way
  to the content, twice per exchange, and in a 380px sidebar a label column the
  answer could not spare. Your prompt now sits in a card and the answer runs
  full width; the name moved to `aria-label` on the turn, so a screen reader
  still announces it and a sighted reader is not charged for it.

  An expanded `edit` showed the JSON that requested it — both versions of the
  code on one line with every newline as a literal `\n`. It is now drawn as a
  diff: removed lines above added ones, tinted from the theme's own pass and
  fail colours and **signed in the gutter as well as the tint**, so it still
  reads in high contrast, to a colour-blind reader, and in a screenshot. Only
  complete arguments are drawn — half a `newText` is a change nobody is making
  — and every key the diff did not consume is still shown, because an edit
  reviewed with `replaceAll` hidden is worse than the raw JSON was.

  A finished turn closes off with how long it took and a button to copy the
  answer. The time is only ever the interval this panel measured between the
  two edges it saw: a turn replayed from history gets no footer at all, and a
  turn that was **already in flight when the panel attached** says "Done"
  without a number rather than timing the moment of attach.

  Smaller: a green `Done` on every tool became a mark, so a run of six greps
  stops shouting while every state a reader has to act on keeps its word;
  inline code dropped to a half-strength fill, so a path mentioned in passing
  stops outranking the send button; and the session ULID gave up the header
  line to the folder the session is working in.

- **VS Code: permission requests are answered in the chat panel, not in a
  modal in the middle of the screen.** A request now appears as a card in the
  panel's dock — the reserved region beside the composer that already holds the
  plan and the dry-run review card — showing the engine's own description, the
  tool, the subject and the arguments, with Deny / Allow for this session /
  Allow. Focus lands on **Deny**, never on Allow.

  The rule it replaces (RFC 0005 §2, "permission requests stay native modals")
  was written down as "a security decision" without ever naming the threat. The
  threat was spoofing — model output imitating a permission card so somebody
  clicks a forged Allow — and it does not reach this panel: the webview builds
  every node with `createElement` and `textContent`, has no `innerHTML`
  anywhere (there is a test asserting it), and a model therefore cannot create a
  button. The card is rendered into a region the transcript never writes into,
  so a permission control and model text can never share a container. RFC 0005
  §2.1 now states all of that instead of asserting the conclusion.

  Nothing about the *decision* moved. The page sends a button **label**; the
  host runs it through the same `answerFromChoice` the modal's answer went
  through, which denies anything it does not recognise. "Allow for this session"
  is still offered only where the engine attached a rule, the rule persisted is
  the engine's own scoped to `session`, and every outcome that is not an
  explicit allow — a dismissal, a prompt that could not be shown, a disposal, a
  session switch, a dropped connection — is still a denial.

  **A modal is visible wherever you are looking and a panel is not**, so the
  panel is revealed (without stealing focus) before each request; if it cannot
  be brought into view the request falls back to a native modal; the activity
  bar carries a badge while the engine is waiting; and a panel hidden with a
  request outstanding withdraws the card and re-asks it natively, because
  hiding the view destroys the page the card was drawn on. One live surface per
  request, always.

### Added

- **VS Code: the panel can read a markdown table.** The panel parses its own
  markdown — it has to, because the CSP forbids `innerHTML` and every node is
  built by hand — and that parser knew paragraphs, headings, code, quotes,
  lists and rules. It did not know tables, so a GFM table fell through to the
  paragraph branch and reached you as its own source: rows of pipes, a line of
  dashes and the cell text run together. The terminal has rendered tables all
  along, so the same answer was readable in one surface and not the other.

  Alignment comes from the delimiter row and is carried down every cell of its
  column as a class, since this panel never writes an inline style. Cells are
  parsed as inline markdown, so bold, links and code spans inside them work and
  a tag inside one is still characters.

  Three guards keep prose out, because a pipe is ordinary punctuation. The
  delimiter row must carry a pipe of its own — without that, a sentence ending
  in a pipe swallows the horizontal rule beneath it. Its cell count must match
  the header's, as GFM requires. And nothing is drawn until the delimiter row
  has arrived, so a table streaming in does not rebuild itself column by column
  on every delta. A ragged body row is padded or truncated to the header rather
  than dropped, which is the same shape seen mid-stream.

- **A file attachment can carry a line range, so a client can send a
  *selection*.** A panel that knows the user has lines 12–40 highlighted had no
  way to say so: `PromptAttachment` was `{ kind: "file", path }` and nothing
  else, so the only option was to send the whole file and hope. For an 800-line
  file that is mostly noise, and "explain this function" quietly became "explain
  this file". A `file` attachment now takes an optional
  `range: { start, end }` — **1-based, inclusive at both ends**, deliberately
  the convention `@src/auth.ts:12-34` speaks and the one an editor's gutter
  shows, so a 0-based client adds one to each end and the whole conversion is
  one documented step rather than a guess.

  **Only the coordinates travel.** RFC 0005 §3 keeps every read inside the
  engine, so the extension still never opens the file: the engine confines the
  path exactly as it does for a mention, reads it with the one reader
  attachments and mentions already share, and slices. An excerpt therefore
  inherits the same size caps and the same truncation marker a whole file has,
  and is charged against the total attachment budget for what was actually
  read — three lines of a 300 KiB file cost three lines. A range on an image is
  refused rather than ignored, because an image has no lines.

  **The block says it is an excerpt**, so the model does not answer as though it
  had seen the file: `src/auth.ts (attached file) — excerpt, lines 12-14 of 60;
  the rest of the file was not read`. An `end` past the last line is *clamped
  and the clamp reported*, naming the range that was asked for — a
  select-to-end, or a file edited since the selection was taken, produces one
  routinely. A `start` past the last line is **refused**, not clamped: the only
  thing to clamp to would be the file's tail, and substituting a different
  selection for the one the client named is the exact failure a range exists to
  prevent. On the wire, only ranges that cannot mean anything are rejected —
  `start` below 1, `end` before `start`, a bound that is not a whole number.
  There is no ceiling on `end`, because there is nothing to bound: the engine
  never reads more of a file than the file.

  **`@src/auth.ts:12-34` is the same feature in the text grammar, and now
  works.** `findMentionTokens` used to take the whole run as a path, so the
  suffix did not narrow a mention — it defeated it, and the file was never
  injected at all. It now parses on both spellings (`@"my notes.md":12-34`
  included), means the same 1-based inclusive range, and goes through the same
  reader. A file genuinely named `notes:12-34` still resolves, because the
  literal reading is retried when the stripped one finds nothing.

  **An engine that predates ranges is detected, not trusted.** A `range` is a
  new field on an existing parameter, so an older engine validates the
  attachment, drops the field and sends the model the whole file while answering
  `ok`. `resolveContext` now takes and echoes a `range`, and the probe
  `ProtocolClient.prompt` already ran once per session before sending any
  attachment carries one — so a ranged attachment to an engine that would drop
  it is rejected locally, with nothing sent, and at no extra round trip.

- **`/workflow` reaches a remote client in full, budget ceiling and human gate
  included.** A markdown workflow is one of Arcturn's signature features — a
  numbered list that is real control flow, an `@role` per step with its own
  tools and its own lane, `budgetUsd` capping the run and `ORG-ASK:` stopping it
  for a person — and none of it was reachable from a socket. A panel attached to
  an engine full of pipelines could not see that they existed. Four verbs now
  match the terminal's four subverbs one for one: `listWorkflows`,
  `runWorkflow`, `workflowStatus` and `resumeWorkflow`, all answered by the same
  engine `/workflow` drives, with no second parser, no second lane classifier
  and no second run journal.

  **The catalog reports the lane the engine derives**, from each role's declared
  `tools:` and never from what the role's prose claims — a reviewer that
  describes itself as read-only and declares `edit` is reported `write`, because
  `write` is what will happen. A role the engine has not loaded is `unknown` and
  one with no `tools:` line is `undeclared`; both fail the run before it spends
  anything, and rounding either down to `read` would tell a person a pipeline is
  harmless when the truth is that nobody can say.

  **A wire budget may only lower the file's ceiling.** `runWorkflow` takes an
  optional `budgetUsd` that must be smaller than the workflow's own; a larger
  one is refused, naming both numbers, rather than silently clamped — the
  catalog already published the file's figure, so the refusal is actionable, and
  a client told "fine" that got a different ceiling would render a number the
  engine is not enforcing. Nothing else can be raised and nothing else has a
  parameter: `stepTimeoutMs`, each role's `maxTurns`, each role's `tools:` and
  the permission engine all bind exactly as they do at the terminal, and a run
  gets the *stricter* of the engine's permission mode and the calling session's.

  **A run is followed on the session's own event stream**, which the client is
  already subscribed to. `runWorkflow` answers as soon as the run is accepted —
  a pipeline outlives every sane request deadline, so a verb shaped like
  `prompt` would hand a default-configured client a timeout for a run that is
  spending money happily — and progress arrives as the same `notice` events the
  terminal prints, from the same function, plus each step's child agent
  republished as a sub-agent. No second event channel was invented, and the
  durable half is `workflowStatus` reading the journal `/workflow status`
  already reads.

  The two reads degrade to `undefined` on the `listModels` precedent; the two
  that start work do **not**, because a client told "started" by an engine that
  ignored it would report a verdict nobody produced, and an `ORG-ASK` answer
  that silently went nowhere would leave a run paused forever.

  One capping difference is recorded rather than papered over: a step's
  permission asks go to the served runtime's requester, and `arcturn serve`
  installs none, so an ask raised by a step fails closed and denies. A write- or
  exec-lane role therefore reaches its tools over the wire only on an engine
  already in `yolo` — the same behaviour a `--print` run gets, and strictly
  narrower than a terminal run.

- **The VS Code panel runs workflows.** `/` now offers `/workflow`, which opens
  a catalog pane listing each pipeline with its spend ceiling and a chip per
  role carrying the derived lane — `@developer write` is the sentence a person
  needs before they press Run, not after. Choosing one raises a native modal
  naming the ceiling and every role that can act (and every role whose lane
  cannot be derived, because that pipeline will not run at all); the composer's
  text becomes the workflow's `{{input}}`. A run card then shows live stage
  progress, read from the run journal rather than counted off the notices
  scrolling past, and an `ORG-ASK:` surfaces there as the question plus a box —
  every question a parallel stage raised, not just the first — whose text is
  forwarded verbatim to `resumeWorkflow`. Stop cancels the pipeline as well as
  the turn.

- **`/bg` reaches a remote client in full, and cannot be talked into more than
  a `/bg` at the terminal gets.** A background agent is a whole child
  conversation running off-thread with a durable record on disk; none of it
  rides a session's event stream, so a panel attached to a busy engine could not
  tell that four agents were running, what they had cost, or what they had said.
  Four verbs now match the terminal's four subverbs one for one:
  `backgroundAgents` (the listing, and one agent's rendered transcript),
  `startBackgroundAgent`, `cancelBackgroundAgent` and `adoptBackgroundAgent`.

  The start verb spends money, and its whole containment is that **it carries
  nothing but the task** — no `tools`, no `permissionMode`, no `cwd`, no
  `model`, in the request type, in the validator, or in the interface the engine
  hands its manager. So a remotely-started agent runs under the manager's own
  defaults, which are the terminal's: permission mode `default` (never `yolo`),
  the read-only tool set plus `fetch`, `subagent` removed so it cannot fan out,
  rooted at the served workspace, queued behind the concurrency cap. In
  practice it cannot write a file or run a shell command, and the test that says
  so asserts it on the filesystem rather than on a returned status.

  `adoptBackgroundAgent` delivers a finished agent's answer into a live session
  — steering it into a run in flight, or prompting it when idle — and delivers
  it **unexpanded**. A background agent's final text is written by a model, so
  expanding `@`-mentions in it would let a child that wrote `@.env` in its
  answer make the parent read that file on the strength of somebody clicking
  "adopt". The terminal does not expand it either; matching that is the point.

  One manager, not two: the engine hands these verbs the same instance a `/bg`
  in the same process reaches.

- **`/org memory` reaches a remote client — everything except approving.** The
  per-role lessons that get appended to a role's system prompt on later runs are
  now readable (`orgMemory`), proposable (`proposeOrgMemory`) and retractable
  (`revokeOrgMemory`, which demotes an active entry or deletes it outright).

  **There is no verb that makes an entry active, and there will not be.** An
  `active` entry is standing instruction text the model reads every run with no
  user action at all, which is why "a proposed entry is inert until a person
  approves it" is the gate this feature is built around — approving is "not
  something a model should be able to grant itself". The argument for keeping
  that gate off the wire is not that a remote caller is untrustworthy (one
  holding the serve token already has full tool execution as you); it is that an
  engine cannot tell a frame a person clicked from a frame an agent sent, and
  `/org memory add` is live precisely *because* a person typed it at their own
  keyboard. It is the same answer `permissionDecision`'s `scope` already gives to
  rules that would outlive their session. Proposing, revoking and deleting are
  allowed because of their direction: each can only reduce what a later run is
  told. A remotely-proposed entry is tagged `origin: "remote"`, so whoever
  approves it can see it arrived over a socket.

  Four independent gates hold that line — the request type has no `status` field,
  the validator copies two fields by name, the engine's call site writes
  `"proposed"` literally, and the response validator refuses an entry that came
  back `active`. The decisive test is none of those: it proposes over a real
  socket and then asks `loadOrgMemoryInjector`, the function that actually builds
  a role's system prompt, what that role would be told. Nothing, until a person
  approves.

- **`/team` and `/scout` are deliberately still unreachable**, and the reasons
  are recorded rather than left to be rediscovered. Reading a team's status is
  not read-only today: constructing a `TeamManager` rewrites every record still
  `running` to `interrupted`, so a status verb would declare another live
  process's team dead on its first call — and `merge` and `discard` write to your
  checkout with no mid-run guard for a `sessionBusy` to hang off. A scout run
  leaves nothing behind at all: worktrees destroyed in a `finally`, a report that
  is printed text, so there is nothing to list and nothing to cancel. Both need
  an engine change before a verb could be truthful. See
  [Teams](/docs/teams#from-a-remote-client).

- **`/rewind` reaches a remote client, carefully.** Before a `write` or `edit`
  touches a file for the first time in a turn, Arcturn snapshots that file's
  content — or its absence — and `/rewind` restores those snapshots and forks
  the conversation back to the same point. None of it was addressable over
  `arcturn serve`. It was, in fact, *the* documented example of a command the
  protocol would not list: "a menu offering `/rewind` to a client with no rewind
  verb is a menu that lies."

  **`listCheckpoints`** answers what a picker needs before it offers anything:
  each turn's label and time, and **what rewinding to it would cost** — how many
  files, which ones, and how many of them get **deleted** rather than rewritten.
  That is not a count of what happened during a turn; it is the plan a restore
  would apply, the union of the earliest snapshot per path from that turn to the
  end of the manifest, which is a number no client could compute for itself.
  Deletions are reported separately because "3 files changed" and "3 files
  deleted" are not the same sentence, and a modal that folded them would let
  somebody approve the second while reading the first. A turn whose conversation
  link predates the engine's process reports `forksConversation: false`, so a
  client can say *before* the click that only the files will move.

  **`rewindTo`** does it, through the engine's own checkpoint store — the same
  object the terminal's `/rewind` drives, with the same workspace confinement, the
  same content-addressed blobs and the same atomic writes. There is no second
  restorer, and the extension never writes or unlinks one of your files.

  **It is the one verb on this wire that echoes a confirmation, and the reason is
  precise.** `deleteSession` and `discardChanges` deliberately have none: a
  confirmation belongs in a native modal where a person can read what they are
  losing, not in a two-phase token an engine keeps state for. Both still true —
  and `rewindTo` differs in the way that matters, because *its parameters do not
  name what it destroys*. A delete names its session; a discard names its files.
  A rewind names an opaque turn id, and the files it deletes come from a manifest
  that grows every turn — so a client that displayed "this deletes 2 files", let a
  run append three more, and then sent the id would rewind something nobody was
  shown. The confirmation is therefore a digest of the plan itself, copied from
  the row the client rendered: no server state, no expiry, nothing to evict, and
  a client cannot rewind to a cost it never displayed. If the plan has moved, the
  engine refuses and says to re-list.

  **Refused mid-run** with `sessionBusy`, on `deleteSession`'s wider check rather
  than `setPermissionMode`'s narrower one — a prompt accepted but still resolving
  its context has not started the agent yet, and a restore landing there would
  rewrite files the run is about to read *and* fork the conversation it is about
  to append to. The terminal already refuses this; now the wire does too.
  **Not degradable**: an older engine's refusal rejects rather than resolving,
  because a rewind reported as done that did not happen tells a user their files
  went back to a state they never returned to, and they carry on building on code
  they believe they discarded.

  In the **VS Code panel**, `/rewind` opens an in-panel picker listing each turn
  with what it would change — deletions coloured, because that is the half that
  loses work — and a **native modal** naming the file count and the files before
  anything happens, which is the discipline the session delete and the discard
  already keep. The list has no Enter action on purpose: rows are clicked, because
  a picker whose default key deletes files is a picker that fires while somebody
  is still reading it. After a rewind the transcript is re-read through
  `sessionHistory`, which now replays the branch the live agent is on rather than
  the newest entry in the file — the one place that could have shown a user a
  pre-rewind conversation and called it their transcript.

- **The dry-run review loop reaches a remote client, and the VS Code panel makes
  it the best thing the product does.** `--dry-run` sends every file edit to a
  shadow copy of the workspace and leaves your real files alone until a person
  has read the change; in a terminal that is `/diff`, then `/apply` or
  `/discard`. None of it was addressable over `arcturn serve`, so a remote client
  attached to a dry-run engine watched an agent that appeared to do nothing at
  all — and the panel's `/` menu could not honestly offer the three commands,
  because no verb carried them.

  **`pendingChanges`** lists what is waiting: per file, its workspace-relative
  path, whether it is added or modified, and its size before and after. The list
  carries **no content**; naming one file fetches the bytes an apply would write.
  That split is a payload decision taken against the 1 MiB bound `sessionHistory`
  established — a hundred-file refactor's patches are megabytes, its listing is
  about twenty kilobytes, and a review response must never be the frame that
  wedges the socket exactly when a reviewer needs it. A single file too large for
  the budget comes back marked `contentOmitted` rather than truncated: half a file
  in a diff editor is a false account of the change, and a reviewer would approve
  it. Read `dryRun` before you read the list — an engine that is not in dry-run
  mode answers `dryRun: false`, which is the opposite news from "nothing pending
  yet" and must not render as the same sentence.

  **`applyChanges`** lands them, and the selection is real: omit the paths to
  apply everything, or name a subset to land three files out of forty. That
  selectivity is a filter on the engine's own list, not a second write path —
  `Overlay.apply` gained an optional path argument and is still the one applier
  the terminal's `/apply` drives, with the same per-file symlink resolution that
  refuses a destination outside the workspace and the same temp-file-plus-rename
  that survives an interrupt. A path the engine did not just list refuses the
  **whole** request rather than applying the rest, which is also the entire
  confinement story for a selection: no client string ever becomes a write
  destination. Applying is not a way around a deny rule either — permissions are
  checked against the tool call's raw path before the overlay redirects anything,
  so a denied write never becomes a pending change.

  **`discardChanges`** throws them away. Irreversible: the shadow tree is the only
  record of that work. It carries no wire-level confirmation, matching
  `deleteSession` — a confirmation belongs where a person can read what they are
  losing, which is a native modal in the client naming the files.

  Both writes are **refused mid-run** with `sessionBusy`, and the check is wider
  than one session on purpose: `--dry-run` is a flag on the served process, so one
  `arcturn serve` has one shadow tree that every session it hosts writes into, and
  a run in flight anywhere on the engine blocks an apply asked for anywhere on it.
  Reading the list is not refused — `/diff` has never had a busy check, and a
  change set you can watch grow is useful rather than dangerous.

  `PROTOCOL_VERSION` stays `1`. `pendingChanges` degrades like `listModels` — it
  reads, so an older engine's refusal costs a client a view and nothing else — and
  the other two reject like `deleteSession`, which is the sharpest case in the
  batch: an apply reported as done that did not happen tells a reviewer their
  change landed while the file says otherwise, and a discard reported as done that
  did not happen leaves them certain their work is gone until the next apply lands
  it.

  **In VS Code**, a card above the composer appears the moment anything is
  pending — on screen rather than behind a command, because a pending change you
  have to remember to look for is one that gets applied unread. Clicking a file
  opens **VS Code's own diff editor**: your workspace file on the left, the
  pending content on the right, read-only. Apply and Discard are explicit buttons,
  discard raises a native modal naming what will be lost, and `/diff`, `/apply`
  and `/discard` now appear in the panel's `/` menu and the command palette,
  running the same controls. The extension never writes a workspace file itself —
  it asks the engine, which is the only version that inherits the symlink refusal
  and the mid-run guard.

- **`/compact`, `/export`, `/mcp` and `/cost` reach a remote client.** The
  terminal has twenty-one slash commands; the wire exposed four, so the VS Code
  panel's `/` menu was almost empty. That was correct — RFC 0005 §1.3 lists only
  what a client can actually run, because a menu offering `/rewind` to a client
  with no rewind verb is a menu that lies — so this makes four more of them
  real rather than listing them anyway.

  **`compact`** drives `Agent.compact()`, the same method the terminal's
  `/compact` and the run loop's automatic threshold call. There is one
  compactor. It answers with a report rather than an acknowledgement — the token
  estimate before and after, and whether anything was folded at all — because a
  client that cannot say how much context it freed cannot tell a compaction that
  worked from one that found nothing old enough. Those two numbers are *quoted
  from the engine's own `compactionEnd` event*, not measured again, so the
  notification and the response that caused it cannot disagree. It is **refused
  mid-run** with `sessionBusy`: compaction rewrites the message array the run
  loop is iterating, so queueing would only move the hazard behind a promise and
  would race the loop's own automatic compaction. Abort, or wait for `runEnd`.

  **`exportSession`** renders the conversation as markdown or HTML and hands it
  back — **the engine writes nothing**. The terminal's `/export` drops a file
  next to the person who ran it; over a socket that would put the document on
  the engine's disk, which is the wrong machine for the person asking and an
  arbitrary-write primitive for anyone holding the serve token. The client
  saves it, and the suggested `filename` is a bare name the protocol client
  refuses if it carries a separator or `..`. Both renderers are the terminal's
  own, injected rather than reimplemented. The payload is bounded at 1 MiB —
  the wire's own backpressure threshold, the same budget `sessionHistory` uses
  — and over the cap the oldest messages are dropped and the document is
  **re-rendered**, so what arrives is a well-formed document rather than one cut
  through a tag, with `truncated` and `droppedMessages` saying so explicitly.

  **`mcpStatus`** reports the configured MCP servers: name, transport, whether
  each is connected, and its tool count. **Names and status only.** An MCP
  config is where a workspace keeps its secrets — a stdio server's `env` and
  `args`, an HTTP server's `url` and `Authorization` header, an OAuth bearer
  token — and none of it is on this wire; nor is a failed server's own error
  text, which is prose an MCP server wrote landing in a menu a person reads. The
  payload is four fields, built by naming them next to the config in
  `@arcturn/cli` and re-validated field by field on the way out of
  `@arcturn/server`, so a field added to the config tomorrow is absent by
  default rather than present until somebody notices.

  **`/cost` gets no verb, and that is the point.** Every figure it shows already
  rides the event stream a client subscribed to with `openSession` — `turnEnd`
  carries the usage and the price — so a verb would be a second, drifting source
  for numbers the client already holds. It is listed as a built-in because the
  question is "can a client carry this out", and one folding `turnEnd` can; in
  the VS Code panel it opens the cost breakdown that was already there.
  `/todos` stayed out: its data is equally reachable, but no client has a
  surface for it to *open* — todos are rendered continuously rather than
  summoned — and a menu row that does nothing when chosen is the thing this list
  exists to prevent.

  `PROTOCOL_VERSION` stays at `1`. `exportSession` and `mcpStatus` degrade like
  `listModels`: both read, so an older server's `invalidRequest` becomes
  `undefined` and a client shows nothing rather than something false. `compact`
  gets `deleteSession`'s treatment instead and **rejects** — a client told
  "fine" by a server that ignored it would report freed context that was never
  freed, keep filling the window, and hit the wall it had just asked to have
  moved.

- **Attachments and `resolveContext` on the wire protocol.** `prompt` takes an
  optional `attachments` array: a `file` becomes a context block headed with its
  path, an `image` becomes a vision block. A `file` is always named by path and
  never carries bytes — a file read by a client is a file the permission engine
  never saw — while inline data is accepted for an `image`, and only an image,
  because a pasted screenshot has no path and was never a workspace file. Every
  path attachment goes through the same workspace confinement a mention does,
  but a refused attachment is fatal rather than advisory: the client named that
  file, so running the turn without it would be the silent drop the feature
  exists to prevent. Total attachment bytes are capped at 1 MiB — the wire's own
  backpressure threshold, a quarter of the frame size above which `ws` closes
  the connection, and the same number `sessionHistory` budgets against.

  A prompt carrying an **image for a model without vision** is refused with the
  reason **before the turn is spent**, checked server-side at prompt time rather
  than trusted to a client that may be hostile, may be old, or may simply be
  looking at a stale catalog. An image *mention* on such a model degrades with a
  notice instead, exactly as the TUI has always degraded one.

  `resolveContext` answers what a mention would resolve to — path, byte count,
  whether it exists, whether it is inside the workspace — so a file picker can
  be honest rather than hopeful. It is read-only, and a query that fails
  confinement is answered without touching the filesystem at all, so it cannot
  become an oracle for the paths confinement exists to hide.

  `PROTOCOL_VERSION` stays at `1`. `resolveContext` degrades like `listModels`:
  an older server's `invalidRequest` becomes `undefined`, which is safe because
  the verb only reads. `prompt`'s `attachments` gets `deleteSession`'s treatment
  instead — an older server would recognise `prompt`, drop the field, and answer
  `ok`, spending the turn and telling the client everything was fine — so
  `ProtocolClient.prompt()` probes `resolveContext` once per session and refuses
  locally rather than sending attachments that would be dropped.

- **Permission state and permission mode on the wire protocol.**
  `permissionState` answers with the session's mode, the rules in force, and
  **the names of the tools the session holds** — the last being the whole of
  RFC 0005 §1.4: there is no verb for "can this engine reach the web", because
  the question is really "is `fetch` in the tool set", and a panel that renders
  a browse button without checking is implying a capability it never confirmed.
  Names only, never a tool's description or schema, and the full set the session
  was built with rather than the subset progressive disclosure is showing the
  model this turn.

  `setPermissionMode` switches between `default`, `acceptEdits`, `plan` and
  `yolo`, and answers with the resulting state so a client reads what the engine
  *is* rather than assuming it got what it asked for. **A mode is a request, not
  a grant:** a stored `deny` rule still wins over `yolo` set from here, exactly
  as it does for a local user, and this verb never edits a rule. It is refused
  mid-run with `sessionBusy` — a mode that changed halfway through a turn would
  not govern the ask already sitting in the client's modal, and `abort` is the
  better verb for stopping an agent now.

  `permissionDecision` grows an optional `scope`, so "allow once" and "allow for
  this session" are distinguishable at the moment of asking. **Nothing persists
  to disk from a remote client:** `"project"` and `"user"` are refused, and so is
  a client-authored `persistRule` carrying either, at three independent seams —
  a client's outbound validation, a server's inbound validation, and
  `SessionHost` itself, which an SDK embedder may reach through another
  transport entirely. A `"session"` allow makes the **engine** mint the rule from
  the `suggestedRule` it already offered, so a client chooses how long and never
  what. `arcturn attach` and the browser client now offer "allow for this
  session" on those terms; previously both sent a `project`-scoped rule that the
  server wrote into the user's own config file. The local TUI is unchanged.

  `PROTOCOL_VERSION` stays at `1`. `permissionState` degrades like `listModels`
  — it reads, so `undefined` costs a client a mode chip and nothing else.
  `setPermissionMode` gets `deleteSession`'s treatment and rejects instead: a
  client told "fine" by a server that ignored it would show a `plan` chip over
  an engine still in `yolo`, and a user who believes they restricted an agent
  they did not restrict is the one outcome a permission control may not produce.
  `permissionDecision`'s `scope` is a field, not a verb — an older server drops
  it and the allow lands as an allow-*once*, which narrows rather than widens.
- **`listCommands` on the wire protocol.** A client can now discover what a `/`
  could invoke: every markdown skill the workspace holds — name, sanitized
  description, and the absolute path it came from — plus the built-ins the wire
  can **actually** carry out. A menu offering `/rewind` to a client with no
  rewind verb is a menu that lies, so the built-ins are enumerated deliberately:
  `model`, `permissions`, `sessions` and `clear` are in because verbs back each
  of them; `rewind`, `compact`, `diff`/`apply`/`discard`, `export`, `theme`,
  `mcp`, `todos`, `cost`, `scout`, `help` and `exit` are out because none do.
  The list lives beside the server's dispatch table, which is what makes an
  entry true. Descriptions are sanitized with the same function that sanitizes
  them on the way to the model, because `<cwd>/.arcturn/skills` is a directory a
  cloned repository controls and those strings now reach a UI as well as a
  prompt. Execution stays `prompt` — a skill is prompt text, and a second
  execution path would give one skill two behaviours — and `prompt` now really
  runs one; see "a leading `/name`" below. Optional and additive:
  `PROTOCOL_VERSION` stays at `1`, and an older server's `invalidRequest`
  becomes `undefined`.
- **A leading `/name` runs the skill, on `prompt` and on `steer`.** `listCommands`
  told a client which skills exist, but the serve path did not expand the command
  it offered: a client that sent `/review` reached a model holding seven literal
  characters, which it might notice and pick up through the model-invoked `skill`
  tool, or might not. A menu whose entries mostly do nothing is the menu RFC 0005
  §3 forbids. A prompt beginning with `/name [args]` is now replaced by that
  skill's body before the model sees anything, substituted by the very same
  `Skill.buildPrompt` the terminal's `/name` and the `skill` tool already use.

  It follows the terminal's rules, including where they say "leave this alone":
  only a *leading* `/name` counts, and a skill body's own `@mentions` are **not**
  expanded — mention expansion is for the text a person typed, and a skill in
  `<cwd>/.arcturn/skills` is a file a cloned repository controls, which would
  otherwise be able to pull `@.env` into a prompt on the strength of someone
  running `/review`. An unrecognised `/name` is **refused** with the nearest
  names suggested and no turn spent, rather than forwarded as prose: a model
  reading `/reviw the auth module` answers *something*, and a user cannot tell
  that from a command that ran. A built-in is refused the same way, naming the
  verb that runs it. One deliberate divergence from the terminal, which treats
  every leading slash as a command: a name here must look like a name
  (`[A-Za-z0-9-]+`), so `/etc/hosts has the wrong entry` is sent as the prose it
  is. A skill is addressed by name against what the engine discovered, never by
  path, so nothing on this route reaches the filesystem.

  `steer` expands identically, and became `Promise<void>` on `SessionHost` to do
  it (the wire has always awaited it, so nothing about the protocol changed);
  steers are chained per session so that the newly-async expansion cannot queue
  two of them in the order their filesystem reads finished rather than the order
  they were sent.
  The terminal steers the *expanded* body when a run is in flight, and a command
  that meant one thing on an idle session and another on a busy one would be the
  same menu lying at a harder moment to notice. That also closes the other half
  of the mention bug below: `@auth.ts` in a steer was never expanded either.
- **`sessionHistory` on the wire protocol.** A client can now ask a server for a
  session's stored conversation, so a panel that attaches to a session it never
  watched can render it. `openSession` subscribes to *future* events and replays
  nothing — that gap is why opening a session from the VS Code history list
  showed an empty chat. The result replays the same `AgentEvent`s the live
  stream carries, deliberately rather than a projected message list: a client
  folds history through the *same* reducer it already runs on live events, so a
  transcript rebuilt from disk and one watched as it happened cannot drift.
  Only the active branch is replayed, so a rewound session never shows a
  conversation the agent will not continue. The payload is bounded — 1 MiB of
  events or 1000 events, whichever binds first, keeping the newest and cutting
  at a turn boundary — and reports `truncated`/`droppedEvents` explicitly, so a
  client says "earlier messages are not shown" instead of quietly starting
  mid-conversation. Additive and optional: `PROTOCOL_VERSION` stays at `1`, and
  `ProtocolClient.sessionHistory()` turns an older server's `invalidRequest`
  into `undefined`.
- **`deleteSession` on the wire protocol.** A client can now permanently delete
  a session. The **engine** performs the deletion — a client unlinking the file
  itself could not see a session still live in the server's memory, nor know
  whether a run was in flight. A session running a turn is refused with
  `sessionBusy`; a live but idle one is deleted and evicted in the same
  operation, and every connection observing it is sent a final `notice` event
  saying so before its subscription is dropped. The store is deleted from
  before the eviction, so a store failure leaves the session intact rather than
  telling clients it was deleted. Unlike `listModels`, an older server's
  `invalidRequest` is **not** translated into success — nothing was deleted —
  and `isUnsupportedMethodError` is exported so a client can say "this engine
  is too old" rather than quoting `Unknown method`.
- **`SessionStore.delete(sessionId)`.** A new *optional* method on the store
  contract, implemented by `JsonlSessionStore` and `MemorySessionStore`.
  Optional so an existing third-party store keeps compiling; a host wired with
  one that lacks it refuses to delete rather than guessing which files to
  unlink.
- **The VS Code panel shows a session's past conversation.** Attaching to a
  session now fetches its history and folds it through the existing transcript
  reducer, so opening one from the history list renders what was said instead
  of an empty chat. A truncated replay is announced in the transcript rather
  than silently omitted. Against an engine without `sessionHistory` the panel
  behaves exactly as it did before.
- **The VS Code panel can delete a session.** Confirmed first by a native modal
  naming the session and saying the deletion cannot be undone; the deletion
  itself goes through the engine's `deleteSession` verb, and the extension never
  touches a session file. Deleting the session on screen opens a fresh one, so
  the composer still goes somewhere real.
- **The VS Code composer is a composer.** The panel exposed a model chip and
  nothing else; it now surfaces the verbs above it, and reads as one control
  rather than a text box with buttons bolted on — attach and context on the
  left, model and mode as chips, send and stop on the right, judged at 300px.

  **`@` opens a context picker.** Typing `@` fuzzy-matches workspace files
  through VS Code's own index (so your `files.exclude` is respected without the
  extension owning a second exclude list), and every row shown has been through
  `resolveContext` — so the size on it is the engine's byte count, not a guess,
  and a path the engine will refuse says why before you press enter. Picking one
  turns it into a removable chip above the composer and **takes the `@…` back
  out of the box**: the engine expands mentions *and* injects attachments, so
  leaving the text in would send the same file twice and the chip row would stop
  being the whole truth about what the prompt carries. Drag-and-drop from the
  explorer or the OS, a native Attach dialog, and pasting an image all land in
  that same set — the one the next `prompt` actually sends. A pasted image
  travels as bytes, because a paste has no path; the panel checks its type
  against the engine's own allowlist first, so a chip that appears is a chip
  that will send.

  **`/` opens the command menu** from `listCommands`: the workspace's skills
  first, each with its description and the file it came from, then the
  built-ins. Enter inserts a skill and leaves you to add an argument —
  execution stays `prompt`, per RFC 0005 §1.3 — while a built-in opens the
  panel surface that already runs it, so `/model` opens the model list rather
  than sending the model a message about wanting a different model. A built-in
  this panel has no surface for is not listed at all, which is RFC 0005 §3's
  rule applied a second time on the client's own terms.

  **A permission mode chip** shows `default` / `acceptEdits` / `plan` / `yolo`
  with one line saying what each grants, `yolo`'s included — that a deny rule in
  your config still wins. The chip **never moves on your click**: it moves when
  the engine's answer says the mode changed, so a refusal cannot leave the panel
  claiming a restriction that is not in force. An engine too old for
  `setPermissionMode` says exactly that instead of degrading, and a mode change
  attempted mid-run says the run is in flight rather than failing silently.

  **The empty state names what this engine can do**, built from
  `permissionState.tools` — including whether it can reach the web. If `fetch`
  and `websearch` are both absent the panel says nothing about browsing and
  shows no button for it; no capability is implied by an affordance.

  **Permission requests stay native modals**, which is a security property and
  not a style choice, and the "allow always" button is now **"Allow for this
  session"** — the only scope this wire has ever accepted. It said "always" and
  meant "until this session ends".

## [0.3.0] — 2026-08-25

### Added

- **`listModels` on the wire protocol.** A client can now ask a server for its
  model catalog — the same models `arcturn --list-models` prints, from the same
  source — instead of guessing from the ids one session happened to announce.
  The response carries, per model, its id, display name, provider, context
  window, max output tokens, pricing, the *name* of the environment variable it
  authenticates with, and whether that credential is present. Two distinctions
  are preserved on the wire rather than papered over: a model with no published
  price has no `cost` field at all (`$0` is reserved for models that really are
  free), and `credentials` is `"present" | "absent" | "unknown"`, where
  `"unknown"` means the server genuinely cannot tell — ambient AWS or Google
  credentials, or a local OpenAI-compatible endpoint that needs no key. **The
  key value itself is never sent.** The verb is additive and optional:
  `PROTOCOL_VERSION` stays at `1`, an older server rejects the call with an
  ordinary `invalidRequest`, and `ProtocolClient.listModels()` turns that one
  rejection into `undefined` so a newer client degrades instead of failing.
- **The VS Code model picker is populated.** It now lists the engine's whole
  catalog with context window, price and credential status per row, models you
  hold a key for first, the model in use pinned to the top — and still keeps
  `arcturn.defaultModel`, the ids the session announced, and the free-text
  entry. Against an engine without `listModels` it silently behaves exactly as
  it did before.

### Changed

- **One mark, every surface.** The favicon and PWA icons, the apple-touch
  icon, the VS Code extension and activity-bar icons, and the CLI's
  terminal-art mark now all draw the Turn Arc — the orbital arc with the
  four-point star at its open end that the website already wears — at an icon
  weight tuned to stay legible at 16px. The old star-over-arc mark is retired
  everywhere it appeared.

### Removed

- **Subscription (OAuth) sign-in — `arcturn auth login`, `auth logout` and
  `auth status` — along with the `anthropic`, `openai-codex` and
  `github-copilot` OAuth provider configurations.** They never worked. A
  sign-in needs an OAuth client id the provider issues to the application
  making the request; Arcturn has none, and the ids that shipped belonged to
  other vendors' tools. No endpoint, scope or token format in that file had
  ever been checked against a live provider, so the feature could not be fixed
  by correcting a URL — it needed a credential no one had issued. Set the
  provider's API key environment variable instead; `arcturn --list-providers`
  names the variable for every provider and preset. The
  `anthropic-oauth`, `github-copilot` and `openai-codex` provider ids are gone
  with it, as are `~/.arcturn/auth/<provider>.json` credential files (delete
  any left behind; nothing reads them) and the `ARCTURN_OAUTH_*` environment
  overrides.
- **From `@arcturn/ai`'s `oauth` namespace**: `beginLogin`, `logout`,
  `createAccessTokenResolver`, the provider registry (`listOAuthProviders`,
  `getOAuthProviderConfig`, `requireOAuthProviderConfig`,
  `registerOAuthProvider`, `configureOAuthProvider`, `resetOAuthProviders`,
  `applyOAuthEnvOverrides`, `OAUTH_CONSTANTS`), the token stores
  (`FileOAuthTokenStore`, `MemoryOAuthTokenStore`, `BaseOAuthTokenStore`), the
  token exchange (`exchangeAuthorizationCode`, `refreshAccessToken`,
  `postOAuthRequest`), the device flow, and the provider factories
  `registerOAuthProviderFactories` and `registerAnthropicOAuthProvider`. What
  remains is the provider-agnostic half — PKCE and the loopback redirect
  listener. From `@arcturn/cli`: `runAuthCommand`, `createAuthStore`,
  `collectAuthStatus`, `formatAuthStatus`, `formatExpiry`, `AuthCommand` and
  `AUTH_ACTIONS`.

**MCP OAuth is unaffected and continues to work.** `arcturn mcp auth <name>`
and `arcturn mcp logout <name>` are a different mechanism: the server's
authorization server is discovered at runtime (RFC 8414) and a client is
registered dynamically (RFC 7591), so there is no hardcoded endpoint and no
borrowed client id. It keeps using `oauth.createStateToken` and
`oauth.startLoopbackServer`, and `~/.arcturn/auth/mcp-<server>.json` is
untouched.

### Fixed

- **Switching models over the wire sent the next request to the wrong
  provider.** Reported from the VS Code extension: picking `zai-api/glm-5.3`
  came back `401 authentication_error` — in Anthropic's error shape, for a
  model that is not Anthropic's. Every `setModel` a server received behaved
  this way, whichever id was asked for, and switching back to the model the
  session started on did not undo it.

  `arcturn serve` handed its `SessionHost` a model catalog, so a remote picker
  saw the real list, but never handed it the resolver that turns a chosen id
  into a provider, an endpoint and a credential. The `setModel` verb carries
  only a bare id, so without a resolver the server built a stand-in spec from
  the id alone — and that stand-in named Anthropic. The id on screen was
  always correct; only the routing was wrong. The user who found this had a
  dead `ANTHROPIC_API_KEY`, which is the only reason it surfaced as a 401
  rather than as prompts and a key quietly going to a provider they had not
  chosen.

  `arcturn serve` now resolves a `setModel` id through the same catalog and
  the same environment `--list-models` and the `listModels` verb read, so what
  a picker offers and what a pick does are one thing. And a server built
  without a resolver no longer invents one: `setModel` is refused with an
  error the client can read. An id that cannot be resolved — an unknown model,
  or one whose API key is not set — is reported as an `invalidRequest` naming
  the reason, and the session stays on the model it was already using.

  `arcturn attach` and the browser client never sent `setModel`, and starting
  a session with `--model` always resolved properly; neither was affected.

## [0.2.0] — 2026-08-24

### The package ecosystem

- **`arcturn add`, `inspect`, `packages`, `update` and `remove`** manage
  packages of skills, agent roles, workflows, themes and MCP servers from a
  git URL, an `owner/repo[/subdir][@ref]` shorthand, or a local path. Installs
  are staged, commit-pinned, and linked file by file; `remove` unlinks exactly
  what `add` added. Executable code never links without a per-install
  confirmation that names the files, and off a TTY it declines rather than
  assuming consent.
- **`arcturn inspect` is disclosure before trust**: the same resolver as
  `add` with the linking taken out. It prints the agent lanes the engine
  would derive, workflow budgets, skills and executable files an install
  would add — and adds none of them. `--json` emits the machine-readable
  disclosure the hub is built from.
- **`arcturn new skill|agent|workflow`** scaffolds an asset file that
  round-trips through the real parsers, so the frontmatter is right on the
  first save.
- **A curated pack catalog** ships in the repository under `kits/` and is
  published at arcturn.dev/hub — seven packs, thirty-two assets, each built
  around a refusal that was watched firing against real fixtures before it
  shipped.

### Fixed

- **The VS Code extension could not see your shell's environment, and did not
  say so when that killed the engine.** Two defects, one user report ("I can't
  select a model; it says no API key found"), reproduced against a real
  GUI-launched editor.

  A macOS or Linux app started from the Dock, Spotlight or a desktop launcher
  inherits `launchd`'s (or the session's) environment, not the user's login
  shell — so `PATH` has no `/opt/homebrew/bin` and `ANTHROPIC_API_KEY` does not
  exist. `arcturn serve` then resolved its model, found no credential, printed
  two lines to stderr and exited before announcing an address. The extension
  captured that stderr and threw it away short of the screen: the sidebar card
  said only "The Arcturn engine stopped" with a *Reconnect* button that could
  only fail again, and a sidebar command invoked from the palette returned
  silently, which looked like an empty model picker.

  - **The failure is now visible, in the engine's own words.** `serve`'s exit
    carries a structured failure (reason, exit status, redacted stderr) that
    becomes a card with the engine's stderr quoted verbatim and the buttons
    that are actually useful for it — *Show Log*, *Choose a Model*, *Set CLI
    Path*, *Install CLI*, *Retry*. The same text goes to the Output channel,
    reachable from the new **Arcturn: Show Log** command, and a palette command
    that cannot run raises exactly one error notification instead of nothing.
    The token stays redacted everywhere, including in the structured failure.
  - **The extension now resolves your real environment.** On first engine start
    — never at activation — it runs `vscode.env.shell` as an interactive login
    shell, reads its environment, and uses it for `arcturn serve`, for finding
    the `arcturn` binary on `PATH`, and for the `--version` probe. Per-shell
    flags for zsh/bash, sh/dash, fish, nushell, tcsh and pwsh; five-second
    deadline; a successful read cached for the window, a *failed* one dropped
    and re-attempted when you reconnect; falls back to VS Code's own
    environment with a diagnostic that says what you lose. The shell is asked
    for `env -0`, so variables are NUL-separated: a newline inside a value
    cannot be misread as declaring a new variable, which would otherwise let
    anything able to set one environment variable set any of them — `PATH`
    included, and `PATH` decides which `arcturn` binary runs. An `env` that
    does not accept `-0` makes the probe refuse rather than guess.
    VS Code's own variables always win, and
    `PATH` is merged with the shell's entries first. Nothing from that
    environment is ever logged — the diagnostic carries a shell path, a count
    and a duration, and credential-shaped values are registered with the log's
    redactor as a second line of defence. Skipped on Windows, where a GUI
    process already inherits the user's environment.

- **`grep` handed a file path answered "No matches found"** — the walker
  swallowed `ENOTDIR` and searched nothing, a silent false negative a model
  reads as evidence of absence. A file root now searches that file. Found by
  a live validation run, not by the 4,300-test suite — recorded accordingly.
- **Unknown cost rendered as `$0.00`.** Model entries with no published
  pricing folded to zero at every accumulation point, so the footer and
  `/cost` claimed a session was free when the truth was "unpriced". The
  session now counts unpriced turns; totals render as `$1.24` only when
  complete, `$1.24+` when partly priced, and `n/a` when nothing was — in the
  footer, `/cost`, `/team` and scout reports. `--max-cost` enforcement is
  unchanged: the cap still counts every dollar it can observe, and `/cost`
  now says so.
- **Z.AI general-API models are priced** from the provider's published rate
  card, quoted in the source with its retrieval date. The coding-plan presets
  stay unpriced on purpose — they are subscriptions, and a per-token price is
  not a number that exists; `/cost` says which plan covers them instead.

## [0.1.0] — 2026-08-23

The first public release. Arcturn is a coding agent you run in a terminal and
the TypeScript harness it is built on, and both are in this release: everything
the CLI does, an embedder can do through `@arcturn/core` and `@arcturn/ai`.

### The agent runtime

- **Event-driven agent loop** with mid-turn steering, structured todos, and plan
  mode. Every event an embedder needs is streamed, not just the final message —
  `agent.subscribe()` sees tool calls, thinking, and partial text as they happen.
- **Tree-structured sessions** persisted as JSONL. A session is a tree, not a
  list, so `/rewind` restores files *and* forks the conversation back to any
  earlier turn instead of destroying what came after.
- **Checkpoints** taken before every file edit, which is what makes that rewind
  safe to reach for.
- **Sub-agents** with their own tools, model and turn ceiling; their events
  stream back into the parent session and their cost folds into its accounting.
- **Compaction and context editing**, plus tool-output offloading and deferred
  tool schemas loaded on demand through `tool_search`, so a long session stays
  inside the window without silently dropping what mattered.
- **Background processes** — long-running shell tasks with streamed output,
  reaped with the step that started them.

### Permissions and safety

- **Rule-based permission engine** with allow/deny/ask decisions resolved across
  session, project and user scopes, and four modes: `default`, `plan`,
  `acceptEdits` and `yolo`. Deny beats `yolo`, always — that ordering is what
  lets a workflow confine a role to its worktree.
- **Case-insensitive path matching on case-insensitive filesystems**, probed at
  runtime rather than assumed from the platform. Without it, `.ENV` walks past a
  `**/.env` deny rule on macOS and Windows.
- **Lifecycle hooks** — shell commands at tool and session boundaries, able to
  veto a `preToolUse` call before it executes.
- **Opt-in OS sandbox** confining `bash` writes to the workspace.

### Workflows and agent organizations

- **Markdown workflows.** A numbered list is a pipeline: top-level items are
  stages run in order, indented bullets are branches run in parallel, `{{input}}`
  and `{{prev}}` thread text through, and `[tag]` selects the model per step. The
  grammar is strict — every malformed line is a parse error naming its number.
- **Named roles.** `@role` dispatches a step to a markdown agent with its own
  system prompt, tools, model and `maxTurns`, resolved in a pre-flight pass over
  the whole file so a typo in stage 6 fails before stage 1 spends a token.
- **Three dispatch lanes**, decided by what a role's tools imply rather than by
  what its description claims: `read` (no worktree), `exec` (an isolated worktree
  whose diff is *always* discarded) and `write` (an isolated worktree whose diff
  is captured and applied). A reviewer structurally cannot land code.
- **Seeded worktrees.** A later stage's worktree is built from the run's starting
  commit with every patch the run has already applied replayed into it, so a
  reviewer reads what the pipeline actually produced rather than untouched HEAD.
- **Resumable runs.** Each step's outcome is journalled before the run moves on.
  `/workflow status` reads an interrupted run back — stage reached, turns, spend,
  and why it stopped — and `/workflow resume` re-enters it there, replaying
  completed steps from the journal and probing every recorded patch with
  `git apply --check --reverse` so nothing lands twice.
- **Human-in-the-loop gates.** A role that hits a real ambiguity emits `ORG-ASK:`
  and the run pauses instead of guessing; `/workflow resume <run-id> <answer>`
  continues from that step with the answer in context. `ORG-HALT:` remains the
  fatal form, for what no answer can fix.
- **Bounded runs.** `stepTimeoutMs:` caps a single step, `budgetUsd:` caps a
  whole run's cumulative spend, and a role's `maxTurns:` is enforced as a hard
  ceiling clamped to the session's own.
- **A runnable enterprise kit** in `kits/enterprise-org/` — ten roles and six
  pipelines that parse cleanly through the real parsers, documented alongside an
  honest account of what is enforced and what is still convention.

### Models and providers

- **Multi-provider AI**: Anthropic, OpenAI (Chat Completions *and* the Responses
  API), Google Gemini, every OpenAI-compatible endpoint, plus Bedrock, Vertex,
  Azure and any Anthropic-Messages endpoint — with streaming, tool calls,
  thinking, prompt caching and cost tracking across all of them.
- **Six of those are verified against live endpoints**, not merely unit-tested:
  Anthropic, Google, OpenAI on both surfaces, and both compatibility adapters.
  Each run covered streaming, a tool call whose result is fed back and answered
  on a second turn, and cost accounting checked against published rates. The
  compatibility adapters were each verified against one implementation of their
  protocol — Z.AI for `openai-compatible`, a canonical Messages API for
  `anthropic-compatible` — which proves the adapter rather than any particular
  third-party service. Bedrock, Vertex and Azure are implemented but have never
  reached a live endpoint; the provider table marks which is which rather than
  presenting one undifferentiated list.
- **Model routing** with tiers and per-route fallback, and a live catalog:
  `/model refresh` queries each provider's own model list and merges newly
  released models in without touching curated entries.
- **A per-event idle timeout** rather than a total duration cap, so a slow but
  progressing stream is never killed while a genuinely stalled one is — and a
  stall is classified as a network fault, so it retries and fails over.

### Tools and editing

- **Built-in tools**: read, write, edit, bash (with background execution), grep,
  glob, ls, fetch and websearch (Brave or DuckDuckGo).
- **Code index** — a BM25 index over the workspace behind a `search_code` tool,
  so relevant code is found by meaning without shipping the repository to an
  embedding service.
- **LSP diagnostics** appended to every write and edit, for TypeScript, Python,
  Go and Rust.
- **@-mentions and images** — fuzzy `@file` completion injects file content or
  attaches images as vision blocks, scoped to the workspace.
- **Markdown skills** — a markdown file in `.arcturn/skills` is a slash command:
  frontmatter, `$ARGUMENTS`, `$SKILL_DIR`, no build step. Skill descriptions from
  the project are sanitized before they reach a prompt.

### Interoperability

- **MCP client built in** — stdio and HTTP Model Context Protocol servers, with
  OAuth 2.1 for remote HTTP servers; their tools, resources and prompts just work.
- **Server mode** — a WebSocket server over an NDJSON wire protocol, exposing
  agent sessions to remote clients.

### Terminal UI

- **Differential rendering** with a frame composer, so a busy run stays
  responsive instead of blocking on TTY writes.
- **Full light and dark theming**, including the terminal canvas itself via
  OSC 11 — the background is owned by the theme rather than inherited from
  whatever the emulator happened to be set to.
- **Live tool-call progress**, streamed while arguments are still arriving.

### Platform support

Linux, macOS and Windows, on Node 20 and 22, with a six-leg CI matrix building
and testing all of them. That matrix earned its keep before this release ever
shipped: its first real run failed 54 tests on Windows and surfaced ten genuine
platform bugs the POSIX suites could not see — model-facing paths carrying the
host separator, a `/dev/null` redirect refused as a workspace escape, language
servers unspawnable because npm ships them as `.cmd` shims. All fixed, with the
matrix as referee. Shell resolution, path handling and case sensitivity are
resolved per platform at runtime.

[Unreleased]: https://github.com/sitharaj88/arcturn/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/sitharaj88/arcturn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sitharaj88/arcturn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sitharaj88/arcturn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sitharaj88/arcturn/releases/tag/v0.1.0
