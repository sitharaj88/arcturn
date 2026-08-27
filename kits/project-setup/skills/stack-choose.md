---
name: stack-choose
description: Choose a stack against a brief and this machine, with what every choice costs named. Recommends; never decides what only a person can.
---

Choose what `$ARGUMENTS` should be built with, against `$CWD`.

**A recommendation that lists only benefits has not been made.** For every
choice: what it buys, **what it costs**, and what it forecloses. If you cannot
name a cost you have not thought about the choice yet.

## Take the acronym apart

**MERN is not one decision.** It is four, and three are usually habit:

| The choice | The question actually being answered |
|---|---|
| Mongo | Does this data have joins? Say so out loud. A relational store is the default that has to be argued *out* of, not into |
| Express | Against a typed framework — what does the untyped edge cost you at the boundary |
| React, client-only | Against a meta-framework — SEO, first paint, and who renders |
| Node | Usually the one genuine given, if the team is JavaScript |

Same for "full stack": name the rendering model, the data layer, the auth
story and the deployment target separately. Each is a decision somebody will
live with, and bundling them under one word is how three of them get made by
nobody.

If the reader asked for the acronym and means it, honour it — and say plainly
that you are, rather than quietly re-deciding.

## The trade-offs worth stating

- **Meta-framework** — buys routing, data loading, a deployment story; costs a
  server to run, a rendering model to learn, and real lock-in.
- **SPA** — buys simplicity and static hosting; costs SEO, first paint, and
  every fetch decided by hand.
- **Monorepo** — buys shared types across client and server; costs tooling
  every new contributor learns before they can run anything.
- **Typed DB client** — buys compile-time safety; costs a generation step in
  the loop and a migration story you now own.
- **React Native / Flutter** — buys one codebase; costs two release processes
  anyway, and a native escape hatch you will need eventually.
- **Server components / islands** — buys less shipped JavaScript; costs a
  client/server boundary that is invisible until it bites.

## Read the machine, mark what you cannot

`.tool-versions`, `.nvmrc`, `engines`, a `Brewfile`, an existing lockfile, a CI
workflow — report what the tree says, with a `path:line`. Anything you cannot
settle is `UNKNOWN — <the command that would settle it>`.

**If a repository already exists, read it first.** A stack recommendation for a
directory that already contains an answer is a rewrite proposal, and it has to
say so in those words.

## Stop where a person should decide

Where two stacks are genuinely defensible on this evidence, say so and put the
choice to them with the costs on the table. It is cheap to ask before a
generator has run and expensive after.

End with the stack as named choices each carrying its cost, the exact generator
command to run next, and an `UNKNOWN` block.

Brief: $ARGUMENTS
