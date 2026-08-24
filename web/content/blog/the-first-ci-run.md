---
title: "The first CI run"
description: "The changelog said Windows was verified in CI. CI had never run. The first real run failed 54 tests on Windows and 1 on macOS — and the honest part isn't the fixes, it's the decomposition."
date: 2026-08-24
author: "Sitharaj Seenivasan"
---

## A claim that predated its own verification

`PLAN.md` and `CHANGELOG.md` both carried this sentence, dated 2026-08-21:

> Linux, macOS and Windows, on Node 20 and 22, each verified in CI rather than assumed.

CI had never run. The repository had never been pushed. I had written
`.github/workflows/ci.yml` — a six-leg matrix, three operating systems across Node 20 and
22 — and then written prose about what it proved. The workflow was real; the verification
was a sentence about a file.

It ran for the first time on 2026-08-23, the day 0.1.0 went to npm. Windows failed 54 tests.
macOS failed 1.

## The decomposition is the work

It would be easy to write "54 Windows failures" and let you assume platform tax. They sorted
into three classes, and only one is a bug in arcturn:

1. **Tests that assumed POSIX.** The suite's problem, not the product's.
2. **Environment artefacts.** Git's `autocrlf` on a Windows runner; `EBUSY` on teardown.
3. **Ten real bugs in shipped code.**

Sorting them costs a day and is the whole difference between "we fixed Windows" and knowing
what was wrong. Here are the ones worth your time.

## The worst was a JSON bug wearing a path costume

`grep` and `glob` spelled their results with the host separator — `relative(ctx.cwd, file)
|| file`. Fine on POSIX. On Windows: `src\new.ts`.

The model hands that path straight back in its next tool call, inside a JSON string. And
`"src\new.ts"` is *valid* JSON. Its value is `src`, a newline, `ew.ts`. No parse error, no
warning, no way for the model to see it happen — every follow-up call corrupted at the JSON
layer, in the most-used tool pair there is.

`displayPath` in `packages/tools/src/path-utils.ts` now renders every model-facing path
`/`-separated everywhere, which Win32 accepts as readily as `\`. It is guarded on the
platform separator rather than applied blindly: a POSIX file genuinely called
`weird\name.ts` still comes back spelled the way it is on disk.

## A wall that refused the commonest redirect there is

Workflow roles run in an isolated git worktree behind a confinement wall in
`packages/cli/src/workflow.ts`, which answers anything outside it with `Refused: … is
outside your worktree.` On Windows, `npm test 2>/dev/null` earned that: a role writes POSIX
shell whatever the host is, and `resolve()` turns `/dev/null` into `C:\dev\null` — nobody's file, but under no toolchain
root either. The
toolchain exemption that should have saved it listed `/usr/`, `/bin/`, `/opt/`, `/etc/` and
friends — strings no Windows path begins with, so the exemption did not exist there at all,
and `C:\Windows\System32\cmd.exe` was likewise outside your worktree.

Both predicates read both spellings now — `isDevicePath` exempting the sinks themselves on a
drive-rooted path and never the subtree, because POSIX has a `/dev` filesystem and Windows
has a great many developers who keep their checkouts in `C:\dev`.

## LSP had never worked on Windows. Not once.

npm installs `typescript-language-server` and `pyright-langserver` as `.cmd` shims.
`CreateProcess` cannot execute those, and Node has refused to spawn them without a shell
since the CVE-2024-27980 fix. The whole feature was unavailable on Windows and no test said
so, because no test had ever run there. It goes through `%ComSpec%` now — the same road the
`bash` tool already takes — via `resolveLspSpawn` in `packages/cli/src/lsp/client.ts`, a
pure function of command, platform and environment, so the Windows decision is testable from
a Mac. Same file, second bug: `dispose()` resolved on signal *delivery* rather than exit,
which on Windows leaves the spawn cwd locked — the `EBUSY` under a cluster of teardown
failures.

## Auditing the boundary found one that was live on macOS

The boundary held: driven through a win32 path alias, the real `PermissionEngine` refused
other drives, UNC shares and case variants alike. Auditing it turned up three holes anyway.

Win32 silently discards a trailing dot from every path component before the filesystem sees
the name, so `.arcturn.\config.json` creates and opens `.arcturn\config.json` — the file
whose `permissions` and `hooks` seed every later session in that checkout. Neither half of
the wall caught it: the zone glob wants a literal `.arcturn` followed by a separator, and
the physical check preserves a not-yet-existing leaf exactly as typed, which is precisely
the write that creates the directory. The wall folds that spelling on every platform now.
The same trick had the extension registry, where
`--name "..."` settles onto the package store's own root.

The third is the one I keep thinking about. Named `.ARCTURN` paths were already refused,
because the permission rules ask the filesystem whether it folds case. But a grep result is
not a named path — nothing rules on the files an expansion reached except the physical
filter, and that filter compared bytes. On any case-folding volume, which is every Windows
volume and a stock macOS, a recursive grep printed the contents of `nested/.ARCTURN/`.

Live on my own machine for as long as the feature had existed. Windows found a macOS bug;
that is the argument for a matrix in one sentence.

## And one fabricated claim

`branchCommitSubjects()` in `packages/cli/src/git.ts` ran `git log <base>..HEAD`. A failed
run came back empty, and empty became this, printed into a real pull request body:

> _No commits ahead of the base branch._

It failed reliably once `defaultBranch()` trusted `init.defaultBranch` without checking the
branch exists — ordinary on Git for Windows, where `git log master..HEAD` in a `main`
repository is a range git rejects outright. So `/pr` said "no commits ahead" about a branch
full of commits.

A command that could not answer, rendered as an answer. Wrong on every platform; Windows
just made it happen often enough to catch. It tells "none" from "could not answer" now. I
have spent this project arguing that a harness should not manufacture confidence it does not
have, and here was my own code doing it, in the artifact a human reads most carefully.

## What it was not

The CRLF failures clustered tightly enough to look like one defect in the write lane: cut a
patch out of a role's worktree, apply it to the user's checkout, mishandle line endings on a
Windows clone. A patch that does not apply is a role's work silently thrown away, so that
would have been the worst finding of the run.

It is not what happened. Capture and apply run in the same repository under the same config,
so git's conversion is symmetric — proved by a test in `packages/cli/src/workflow.test.ts`
called "captures and applies through a CRLF checkout, as a Windows repository is
configured", which sets `core.autocrlf=true` and checks the captured patch is one changed
line rather than the whole file re-ended. Every one of those failures was a byte-exactness
assertion in a test.

Knowing what you did *not* find is part of the audit — the difference between a suite you
trust and one you have merely made green.

## The correction is in the ledger, not laundered

The first fix round took Windows from 54 failures to 1 and turned macOS green. The second
run left two races that round could not have seen; a third found an LSP flake where stderr
delivery raced the assertion reading it. That is what a matrix does. It keeps handing you
things.

One caveat I owe you. Every Windows claim above was reasoned from CI output, the code and
Node's documented behaviour, then checked under a `path.win32` simulation. I develop on
macOS; none of it was executed on Windows by me. The matrix referees what a macOS machine
can only simulate.

`PLAN.md`'s entry is now headed **Cross-platform (2026-08-21, corrected 2026-08-23)**, and
its first move is to say the original claim was false and why. The changelog stopped saying
"verified in CI rather than assumed" and started saying what the matrix found. The commit
that fixed it is titled `windows: fix what the first real CI run proved was never true`.

I could have quietly rewritten that sentence instead. The version of this project I want to
hand you is the one where the correction stays in the record and you can read the diff.

The provider table taught me the same lesson first: *verified* is a word for things that
have actually run. I wrote it about somebody else's endpoints. It applies just as well to my
own CI.
