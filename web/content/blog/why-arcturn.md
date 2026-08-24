---
title: "Why I built an agent harness you can audit"
description: "Agents can edit your files, run your shell, and spawn more agents. The tooling for deciding whether to let them — and for reconstructing what happened afterwards — never got built. So I built it."
date: 2026-08-20
author: "Sitharaj Seenivasan"
---

## The question changed

In 2024 the interesting question about a coding model was whether it could write the code.
That question is settled enough to be boring. The models write the code.

The question I actually have in 2026 is different, and nobody sold me a tool for it. An
agent now edits files in my working tree, runs shell commands, fetches URLs, and spawns
sub-agents that do all three again with their own budgets. The question is no longer *can
it?* It's **can I let it?** — and then, twenty minutes later when something is wrong,
*what exactly did it do?*

Right now the honest answer to that second question is "check `git diff`." That's it.
That's the entire forensic story. If the agent made forty tool calls, `git diff` shows you
the residue of maybe twelve of them, in a flat pile, with no indication of which turn
produced which hunk or what the agent was reading when it decided to. Everything that
wasn't a tracked file write — the shell commands, the fetches, the sub-agent that ran for
90 seconds and cost more than the rest of the session combined — left no trace you can
reconstruct at all.

That gap is the whole reason arcturn exists.

## Capability raced ahead of accountability

Look at what got built over the last two years and what didn't.

Capability tooling is extraordinary. Tool-calling loops, MCP, sub-agents, streaming,
context compaction, multi-provider routing — all of it works, all of it is a solved
engineering problem, and the agents built on top of it are genuinely good at their job.

Accountability tooling barely exists. Almost nothing records what the agent was *allowed*
to do at the moment it acted, as opposed to what your config file says today. Almost
nothing records what a run cost as it ran, with a ceiling that actually stops it. Almost
nothing records what evidence a given change was based on — which file the agent had just
read, which page it had just fetched. And almost nothing gives you a way back that is
better than `git checkout` plus remembering.

None of that is a criticism of the excellent agents you already use. They optimized for
the thing that was hard in 2024. I just think the thing that's hard now is the other half,
and the other half is mostly unbuilt.

## Treat the session as the artifact

So arcturn starts from a different primary object. The artifact isn't the diff. The
artifact is **the session**, and it lives on disk in a format you can read.

Every session is a `.jsonl` file — a header line, then one JSON line per entry, appended
in order. The structure is a tree, not a flat log: every entry carries a `parentId`, so
appending after an older entry starts a new branch rather than overwriting what came
after. Resuming from three turns ago and trying a different approach is an ordinary
operation, not something that destroys history. Both branches stay walkable afterwards.

Because the session is a real durable object, you can do real things to it:

- **`arcturn replay <session>`** pulls the original prompts back out and re-runs them —
  against the same model, or `-m` another one — emitting NDJSON per turn with the final
  text, the tool calls and the cost, so you can diff two runs mechanically instead of by
  eye.
- **`arcturn bisect <session> --cassette run.jsonl`** binary-searches those prompts for the
  turn where behaviour left a recorded cassette, which is replayed hermetically: no
  provider, no network, and the underlying tool's `execute` is never invoked at all. It's
  `git bisect` for the run — the tool I wanted the first time an agent did something
  reasonable for nine turns and something baffling on the tenth. (Cassettes are recorded
  through the SDK today; there's no CLI flag for it yet.)
- **`arcturn blame <file>`** answers, per line, which turn wrote it and what evidence that
  turn was working from — files read, pages fetched, commands run, with anything from a
  fetch or an MCP server marked untrusted. Not *who* — *which reasoning step*. It's opt-in:
  the recording costs disk, so you turn it on with `"provenance": true`.

Underneath, before a `write` or `edit` touches a file for the first time in a turn,
arcturn snapshots that file's prior content, or records its absence if it didn't exist
yet. Snapshots are content-addressed blobs under `~/.arcturn/checkpoints/<sessionId>/`
with an append-only manifest. `/rewind` then picks a turn, restores the files that changed
after it, and **forks** the conversation rather than deleting it — every branch you rewound
past stays walkable by resuming its own leaf.

I want to be exact here, because the sloppy version of this claim is everywhere. It covers
`write` and `edit`. A shell command that mutates the tree is not checkpointed, so `sed -i`
and `rm` are invisible to `/rewind`. The conversation side is genuinely non-destructive;
the file side is a real disk mutation that overwrites whatever is there now. Pretending
otherwise would be exactly the kind of claim this project is a reaction against.

In front of all of it sits a permission engine, at a single choke point: the runtime's tool
dispatcher checks it and returns a denial before `execute` is ever reached. Rules are allow
/ deny / ask, scoped session over project over user. Read-only tools pass; anything that
reaches the ask step with no permission requester configured resolves to **deny** — not
"assume it's fine." Around that sits a dry-run overlay (`--dry-run` sends file mutations
into a shadow tree; `/diff`, then `/apply` or `/discard`), taint tracking that flags a
mutating call echoing content that arrived from a fetch, canary tokens that catch a
registered secret on its way to an egress tool, and a cost ceiling in `--max-cost` that
aborts the run at the next turn boundary — including spend from sub-agents, which are
otherwise trivially easy to treat as free.

Every one of those has an edge it doesn't cover, and each edge is written down.
`--dry-run` deliberately does not wrap `bash`, `grep` or `glob` — they take commands and
patterns rather than a single path — so a shell command still reads and mutates the real
tree while dry-run is active. Canary matching is exact substring containment, which means
base64 defeats it completely. Those aren't disclosures I was forced into; they're on the
[security page](/security) because a safety feature whose limits you can't see is worse
than no feature, since you'll trust it.

## What I owe you before you trust any of this

arcturn is pre-1.0. It is one person. It has no production users.

I'd rather lead with that than bury it, because the useful thing I can offer instead of
adoption numbers is evidence you can check yourself.

The codebase has been through four waves of adversarial review — parallel reviewers whose
only job was to break the new seams — and the findings are on the security page rather
than quietly patched out. The counts, exactly as the repo's own `PLAN.md` records them:
**nine** defects in the first feature wave, **ten** across the provider seams (seven of
them permission-enforcement bypasses), **seventeen** in the first innovation wave, and
**twenty-four** in the second. I'm listing the waves separately instead of rolling them
into one impressive headline number, because the shape matters more than the sum.

The findings were not cosmetic. `/apply` could write outside the workspace through an
in-workspace symlink. Served sessions and sub-agents escaped the audit trail entirely. The
WebSocket upgrade had no `Origin` check, so any web page could drive a loopback server.
Sharpest of all: two features were *present but unreachable* — the canary guard was
watching a generated token nobody had ever seen, and speculative approval could never
shelter a single byte because tools ran sequentially. Every fix landed with a regression
test verified to fail against the previous behaviour first.

I find that last category clarifying. A security feature that has never been adversarially
poked at is a claim, not a control.

For the rest, run the commands:

```bash
find packages -name "*.test.ts" | wc -l          # 204 test files
grep -rE "^ +(it|test)[.(]" packages | wc -l     # 3,847 test cases
ls -d packages/*/                                 # 11 packages
```

Four of those packages — `types`, `core`, `index` and `protocol`, which are the type
contracts, the permission and session engine, the code index and the wire format — carry
**no external runtime dependencies at all**, only each other. The dependencies that do
exist are where you would expect them and nowhere else: provider SDKs in `ai`, the MCP
SDK in `mcp` and `cli`, a globber in `tools`, a width table and a markdown parser in `tui`.
Nothing in the layer that decides whether a tool call is allowed to run comes from outside
this repository. Apache-2.0, all of it — no commercial-use restriction, no
source-available licence with a catch in clause four.

## What it is, and what it isn't

Today arcturn is a terminal coding agent and the TypeScript SDK it's built on — the same
runtime, the same event stream, just without a terminal in front of it. It talks to
Anthropic, OpenAI, Google, Bedrock, Vertex, Azure, and any OpenAI- or Anthropic-compatible
endpoint by URL. It speaks MCP. It runs sub-agents, hooks, skills, plan mode, background
shell. Forty-three pages of documentation.

What it isn't: proven at scale, battle-tested, or finished. Six provider paths have
completed real multi-turn tool-calling sessions against a live endpoint — first-party
Anthropic, Google, and OpenAI on both its Chat Completions and Responses surfaces, plus
both compatibility adapters. Bedrock, Vertex and Azure have never reached their endpoints
at all. That's written down in the repo too.

One caveat on the compatibility adapters, since it would be easy to overclaim. Each was
verified against a single implementation of its protocol — `openai-compatible` against
Z.AI's GLM endpoints across 170-odd real sessions, `anthropic-compatible` against a
canonical Messages API. That proves the adapter's own request shaping, streaming, tool
assembly and accounting. It does not prove any particular third-party service, which may
deviate from the protocol in its own way.

The live runs are worth being specific about, because each of them found a bug that a
green test suite could not. Anthropic's found a `--print` that read stdin to EOF whenever it
was not a terminal, so an inherited pipe — every CI runner, Makefile and `spawn()` — hung
forever before emitting a single event. Google's found tool calling broken outright: Gemini
signs the tool *call*, not only the thinking that led to it, and rejected every follow-up
turn with a 400 until the signature was carried back; multi-turn tool use had never once
completed. OpenAI's found the Responses adapter registered, documented and unit-tested, with
no catalog entries — so no user could select it.

Three providers, three bugs, all in code with passing tests, two of them in features the
documentation advertised as working. That is the argument for the distinction this site
draws everywhere between *implemented* and *verified against a live endpoint*, and it is why
the three that remain unverified are marked rather than quietly counted.

One thing has changed since I first wrote that distinction down: the install is real now.
`arcturn` and the nine `@arcturn/*` packages behind it are published on npm at 0.1.0, so
`npm install -g arcturn` fetches a tarball rather than asking you to clone the repo and
build it. Publishing is a distribution fact and not a maturity claim — the version number
is honest, the three unreached providers are still unreached, and nothing on the security
page got shorter.

If the agent you're using already tells you what it was allowed to do, what it cost, what
it changed, and how to get back — you genuinely don't need this.

The name is a star in Boötes, and that's the only sentence of astronomy you'll get from
me.

```bash
npm install -g arcturn
```

The interesting part isn't the install, though. It's that everything above is checkable.
Judge it on the code.
