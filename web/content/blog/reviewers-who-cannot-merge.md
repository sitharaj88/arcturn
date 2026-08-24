---
title: "Reviewers who cannot merge"
description: "Ask a model to review the diff and you get a review by the context that wrote the code, holding the ability to quietly fix what it finds. The fix is not a better prompt. It is deriving a role's authority from its tools."
date: 2026-08-24
author: "Sitharaj Seenivasan"
---

## The review that is not one

Standard practice, and mine for months: finish a change, then ask the model to review the
diff. What comes back is shaped like a review. It is not one, for two reasons that have
nothing to do with how good the model is.

The first is context. The reviewer is the same context that wrote the code, so it carries
every blind spot that produced the bug. It decided that approach was reasonable fifteen
minutes ago. Asking it again mostly re-runs the decision.

The second is worse and gets discussed less. The reviewer can write. So when it does find
something, the cheapest route to a clean-looking answer is to fix it and report success —
and "here is a bug I found" becomes "here is a bug I found and silently patched", with the
patch already in your working tree before you reach the sentence describing it.

Neither is fixable by asking nicely. Both are fixable by removing the ability.

## bash is a write primitive wearing a read costume

The design came out of a failure, not a whiteboard.

The first cut of Arcturn's agent organizations had two dispatch lanes: a role either got a
worktree and had its diff applied, or it did not. Reviewers need to *run* things — a repro,
a test, a scanner — so the reviewer roles declared `bash`. Declaring `bash` put them on the
lane with the worktree. The lane with the worktree is the lane whose diff comes back.

Four roles in that run declared `writes: none` in their own frontmatter, said in their own
prompts that they never modify a file, and had their diffs captured and replayed into the
real checkout with `git apply`, unreviewed. The frontmatter key was documentation. The
prompt was a promise. Neither was a boundary, and `bash` is a write primitive wearing a
read costume.

That is the incident that produced the third lane.

## Three lanes, read off the tools

A role is a markdown file in `.arcturn/agents/`: a system prompt with frontmatter naming
its model, its turn ceiling and its `tools:`. A workflow step dispatches to one with
`@role`, and the lane is computed from that `tools:` list and nothing else:

| Lane | When | Worktree | Its changes |
|---|---|---|---|
| `read` | no `bash`, no `write`/`edit` | none | nothing to apply |
| `exec` | `bash`, no `write`/`edit` | isolated | **always discarded**, success and failure alike |
| `write` | has `write` or `edit` | isolated | captured as a patch, applied on success |

The `exec` lane is the whole point: can run anything, can change nothing of yours. A
reviewer gets a real worktree and can genuinely execute the repro its brief asks for, and
that worktree's diff is never captured on any path. A clean run tears it down; a failed one
keeps it for forensics, labelled inspect-only, and even that copy is never replayed. So a
finding has nowhere to go except the report you read.

None of that is derived from what a role's description says about itself. A role that
declares no `tools:` at all is refused at dispatch rather than defaulted to anything,
because an omitted list is an authority grant nobody wrote down.

## Reviewing what actually happened

The second failure in the same area was quieter. Both worktree lanes are **seeded**:
created from the run's starting commit with every patch the run has already applied
replayed into them in order. Before that they were bare, so a reviewer in a later stage
opened a worktree at untouched `HEAD` and verified code that did not contain the change.
Reviewer quality is irrelevant to that one. The reviewer was reading the wrong tree, and
nothing in its prompt could have told it so.

## Pausing instead of guessing

Some questions a model should not answer alone. Single-tenant or multi-tenant. Which of two
readings of a requirement is the real one. Guessing produces a confidently wrong pipeline;
failing throws away five stages that already worked.

A role emits a line beginning `ORG-ASK:` and the run pauses. `/workflow status` prints the
question and the exact command that answers it, and the answer arrives as that step's
output. A *stage* pauses, not a step — if both branches of a parallel stage ask something,
one reply settles both, because you had one conversation. Resuming replays completed steps
from a durable journal instead of re-running them, and probes every recorded patch with
`git apply --check --reverse` before it could ever be applied twice. `ORG-HALT:` is the
fatal form, for what no answer can fix.

## The part I would rather you read sceptically

There is an honest-limits table in the kit's README, and it is not an appendix.

`writes:` and `reads:` globs in a role's frontmatter are still documentation, not rules the
engine compiles. A write-lane patch applies the instant the step succeeds, with no
confirmation between "finished" and "landed". The `retro` role may *propose* a role-file
edit that widens another role — the engine guarantees no proposal is auto-applied, and it
does not read the diff for you. And the worktree's `bash` guard refuses the ordinary
escapes by pattern-matching a command string, which means a path assembled at runtime walks
straight through it. It is a wall against a wandering role, not a sandbox against a hostile
one. The `write`/`edit` confinement beside it *is* a real wall, because the permission
engine sees a resolved path and rules on it, and a rule-level deny resolves above every
mode including `yolo`.

I would rather write that down than have you find it.

## What two adversarial rounds found

Two rounds of adversarial review attacked this design, and both found real seams. Not in
either feature. In the gap between two features built in parallel, each assuming the other's
guarantee held.

Org memory — the per-role notes appended to a role's prompt on later runs — has two locks.
The store lives under `~/.arcturn/org-memory/` and not in your repository, so a clone cannot
put standing instructions into your prompts. And a new entry is `proposed` and inert until a
person approves it.

`arcturn mcp-serve`, which lets a foreign process drive Arcturn over MCP, landed in the same
tree. Run with `--permission-mode acceptEdits`, it gave that peer an unconfined `write`. So
the peer wrote the store file directly, with `status: "active"` already set — defeating both
locks at once, and putting text into every future run of a role that the role is told an
operator approved. One tool call.

The second round found the same shape one level up: `<cwd>/.arcturn` is inside `--cwd`, but
it is not repository content — it holds the file that *decides a role's lane*. "A `retro`
proposal is never auto-applied, and that is not a policy, it is the lane." The lane is a
line in a file the peer could edit.

Both are fixed, and both are in the tree as tests rather than in a changelog entry:
`packages/cli/src/wave2.review.test.ts` and
`packages/cli/src/wave2-reaudit-seam.review.test.ts`. They are labelled `FINDING:` for a
defect the tree still had and `CLOSED:` for a route someone tried that was genuinely shut,
so the next reviewer does not spend an afternoon on a locked door.

## The point

Multi-agent systems do not fail inside a component. They fail at the seams between
guarantees, where one feature's assumption meets another feature's exception, and the only
defence that has worked here is the same one twice: derive a role's authority from what it
can **do** — its tools, its lane, its worktree — never from what it says about itself, then
run an adversary at the result and keep the findings where you can see them.

No pipeline in the shipped kit merges, tags, pushes, publishes or deploys. Not because a
prompt asks it not to — because no role has a step with that authority. They end at an
evidence packet, and the merge gate is you reading it.

Eleven roles and six pipelines, runnable today, in
[`examples/enterprise-org/`](https://github.com/sitharaj88/arcturn/tree/main/examples/enterprise-org).
Copy them into `.arcturn/`, run `/workflow bug-fix` against a real bug, and read what comes
back. The [agent organizations](/docs/agent-organizations) page has the rest.
