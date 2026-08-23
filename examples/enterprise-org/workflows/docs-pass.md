---
name: docs-pass
description: API inventory in dependency order, human-prioritised gaps, two disjoint writing lanes, an executable oracle, and a newcomer-read gate. Agent context files are excluded by design.
stepTimeoutMs: 1800000
continueOnError: false
budgetUsd: 12
---
Run it as `/workflow docs-pass <the surface to document, e.g. the public API of
packages/core>`.

Two things make this pipeline different from asking a model to write docs.

The first is stage 4: documentation examples are executed and their real output
is pasted. An example that does not run is a bug report the writer filed
against themselves, and it is the only mechanical oracle documentation has.

The second is stage 5: the adversarial reviewer reads the result as a genuine
newcomer and reports what it still cannot do. That list, not the prose quality,
is the artifact that tells you whether the pass worked.

Agent-facing context files are excluded from this pipeline entirely. Generated
AGENTS.md-class files reduced task success in five of eight measured settings
and added twenty to twenty-three percent inference cost, so the docs writer may
propose a diff to one and a human merges it, or nobody does.

Stage 3 parallelises reference documentation and narrative documentation
because they have disjoint file scopes. If your repository keeps both in one
file, run the lanes sequentially instead by deleting one branch.

`docs-writer` carries `write`/`edit` on top of `bash`, so every `@docs-writer`
step below — including stage 1's inventory, which only reports — dispatches
on the **write lane**, each in its own detached worktree seeded with every
patch this run has already applied. Stage 1 is expected to come back with an
`ARCTURN-PATCH` trailer of `status=empty`: an inventory that changes nothing
is correct, and the empty diff is the mechanical proof of that — appended by
the engine itself, not a claim the role's own text can make. Stage 3's two
branches each get their own worktree even though they share a role, so the
disjoint scopes never collide. `qa-adversarial` carries `bash` alone, with
neither `write` nor `edit`, so stage 5 dispatches on the **exec lane**
instead: the identical worktree isolation so it can actually re-run whatever
it needs to check, but with a stronger guarantee than "expected to come back
empty" — nothing it does in that worktree is ever captured or eligible to
apply, full stop, and the engine's trailer there reads `status=discarded`.
`pm` and `tech-lead` are the only roles in this pipeline with no mutating
tool at all, and are the only two that run on the fresh-context **read
lane** — no worktree, no execution, structurally incapable of either. In
plan mode stage 1 fails immediately, before a token is spent — there is no
write lane to run it on.

1. [anthropic/claude-haiku-4-5] @docs-writer Inventory the documentation surface for this scope: {{input}} — list every public symbol, command and configuration key in topological dependency order so that everything a symbol depends on is listed before it, mark each one documented, stale or undocumented with the file and line where its documentation lives or should live, and emit ARTIFACT: DOCREC restricted to the inventory. Read the code to decide staleness; never infer it from the age of a file.
2. @pm Rank the documentation gaps below by reader cost — how many readers hit this gap, how badly they are blocked when they do, and how cheaply it closes — and produce a prioritised list of at most ten gaps with a one-line justification each. Prioritisation under conflict is a human judgment call, so mark the top three as HUMAN-CONFIRM rather than treating your ranking as settled, and list explicitly the gaps you are recommending be left open. Inventory: {{prev}}
3. Two disjoint documentation lanes — reference and narrative never share a file:
   - @docs-writer Close the reference and API-surface gaps from the ranked list below in topological dependency order, writing only what you read in the code and marking anything inferred as inferred, and emit ARTIFACT: DOCREC for the reference lane. Ranked gaps: {{prev}}
   - @docs-writer Close the narrative and onboarding gaps from the ranked list below — the getting-started path, the mental model, the why — touching only prose files and never a reference page owned by the other lane, and emit ARTIFACT: DOCREC for the narrative lane. Ranked gaps: {{prev}}
4. [anthropic/claude-haiku-4-5] Run the documentation oracle over the changes below and report only facts with commands attached: execute every code sample and command in the changed documentation and paste its real output and exit code, resolve every relative link and anchor and list the broken ones with their source file and line, recompute the documented-symbol percentage against the inventory and state the delta, and emit ARTIFACT: DOCREC-VERIFY. If a sample cannot be executed at all, say why rather than declaring it fine. Documentation changes: {{prev}}
5. @qa-adversarial Switch to Newcomer mode, then read the documentation below as an engineer who has never seen this repository: follow it literally and in order, record the first point at which you are genuinely stuck and exactly what you are stuck on, and emit ARTIFACT: FINDINGS listing what a newcomer still cannot do. A confirmed finding here is a documented step you followed that did not work, with its command and output; everything else is an annotation. Verified documentation: {{prev}}
6. [anthropic/claude-sonnet-5] @tech-lead Run in Mode EVIDENCE and assemble the packet from the newcomer findings below, listing the executed-example transcripts, the link-check results, the coverage delta, the newcomer blockers referenced by id rather than paraphrased, the ARCTURN-PATCH trailers from stages 1, 3 and 5 (expect `status=empty` from 1, real patches from 3, and `status=discarded` from 5, since stage 5 runs on the exec lane and nothing it does there is ever eligible to apply), and any proposed agent-context-file diff kept explicitly unapplied and flagged as requiring a human merge. End with the DECISION-REQUEST block. If any input carries an ORG-HALT line, reproduce it verbatim at the top. Newcomer findings: {{prev}}
