# project-setup

Everything else in this hub reviews code that exists. This one starts it.

The premise is narrow and it decides the whole kit: **an agent standing up a
project should run the tool the ecosystem already ships, not imitate one.**

A `package.json`, `tsconfig.json`, `vite.config.ts` or `pubspec.yaml` written
from memory is the characteristic failure. It looks right. It carries versions
that were current a year ago, flags that were renamed, and a config shape the
current tool no longer reads — and it fails at the first install with an error
nobody traces back to its cause, *because the file looks hand-checked*.

## Install

```bash
arcturn inspect sitharaj88/arcturn/kits/project-setup   # read first
arcturn add     sitharaj88/arcturn/kits/project-setup
```

## The commands

| Command | Answers | Refuses |
|---|---|---|
| `/stack-choose` | What to build it with, every choice carrying what it **buys, costs and forecloses** | A recommendation listing only benefits. Treating an acronym as one decision — MERN is four, and three are usually habit |
| `/scaffold-run` | Runs the real generator and reports what **landed**: resolved lockfile versions, real exit codes for install/build/test | Hand-writing a file a generator produces. Using a flag it remembered instead of asking `--help`. Falling back to writing files when the generator is unreachable |
| `/architecture-apply` | The layering a generator leaves out — a boundary with a direction, a composition root, a real test, validation at the edges | Applying a template over a tree it did not read. Replacing a decision the generator already made. Claiming a check passes — it has no shell |
| `/boundary-prove` | Whether each architecture rule **actually fails** when broken: plant a violation, run, restore | The word "configured". Proving one rule and reporting an architecture |

## The pipeline

`/workflow app-setup <what you are building, for whom, and the one constraint you care about>`

Four stages, $20 ceiling: choose → scaffold → architect → prove.

## Why the roles are split this way

**Stage 1 cannot write and cannot run.** It is the stage with an opinion, and
an opinion costs nothing to correct before a generator has touched the disk. It
stops at a person whenever two stacks are genuinely defensible — cheap to ask
now, expensive once `node_modules` exists.

**Stage 2 is the only role holding `bash` and `write` together.** That
combination is the write lane, a worktree whose patch is applied — which is
what lets a generator's output survive. An exec-lane role could run the
generator and its work would be discarded unread.

**Stage 3 has no shell, deliberately.** It writes the layering and the boundary
rule, and it is structurally unable to tell you the rule works.

**Stage 4 is a different role, with a shell and no writer.** It decides that by
planting a violation. The one thing this kit exists to prevent is a stage
certifying its own architecture.

## A check that cannot fail is worse than no check

A `dependency-cruiser` config whose glob matches no file passes. A lint rule
scoped to a renamed directory passes. A script never wired into the test
command passes. Each is green forever while the architecture rots — and the
green is read as evidence.

So `boundary-oracle` plants the smallest violation each rule names, runs the
project's own check, and reports `BITES`, `TOOTHLESS` or `NO-ORACLE` **per
rule**. A config with four rules where only the first bites is three-quarters
decoration, and that ratio is the finding.

It also reports where the check is invoked from — read from the manifest or the
CI workflow — and says plainly when the answer is nowhere.

## On MERN, and acronyms generally

There is no `create-mern-app` worth running, and that is a useful fact rather
than a gap. MERN is four decisions and three are usually made by habit:

| The choice | The question actually being answered |
|---|---|
| Mongo | Does this data have joins? A relational store is the default you argue *out* of |
| Express | Against a typed framework — what the untyped edge costs at the boundary |
| React, client-only | Against a meta-framework — SEO, first paint, who renders |
| Node | Usually the one genuine given |

`/stack-choose` takes it apart, or honours the acronym and **says that it is
doing so** rather than quietly re-deciding.

## Author & Support

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
