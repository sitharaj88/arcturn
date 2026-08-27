# test-integrity

A green suite is a claim, and almost nobody checks it.

A test that runs, asserts and passes may be asserting nothing. That test is
**worse than no test** — it occupies the slot a real test would take, and it
reports success from there indefinitely. Coverage cannot see it: a line
executed under an assertion that cannot fail counts exactly the same as a line
executed under a good one.

The only thing that decides it is an oracle: break the behaviour, and watch
whether the test notices.

## Install

```bash
arcturn inspect sitharaj88/arcturn/kits/test-integrity   # read first
arcturn add     sitharaj88/arcturn/kits/test-integrity
```

`arcturn remove test-integrity` uninstalls; `arcturn update test-integrity`
re-fetches.

## The commands

| Command | Answers | Refuses |
|---|---|---|
| `/vacuous-check` | Which tests are most likely incapable of failing, ranked, each with the mutation that would settle it | Saying `BLIND`. It reads, so it produces `SUSPECT` — a reading promoted to a verdict is how the blind test got written |
| `/mutation-probe` | Whether a test can fail, by breaking the code under it: baseline, mutate, re-run, restore — with both exit codes | The word "covered". Reporting a mutation it did not run. Repairing the test it just proved blind |
| `/flake-hunt` | Which tests depend on order, timing, seed or shared state — established across runs, with the **mechanism** named | Reporting a flake from one failure. Adding a retry, quarantining, or skipping |
| `/coverage-truth` | What the number actually measures here, the exclusion list nobody reads, and which files are high-coverage and low-assurance | Recommending a coverage target |

## The pipeline

`/workflow test-audit <module, directory or suite>` — read and rank, then two
disjoint exec-lane branches (can it fail / does it depend on something else),
then a person, then one write-lane stage. Four stages, $30 ceiling.

## Two structural decisions

**The oracle cannot repair what it breaks.** `mutation-oracle` holds `bash`
with neither `write` nor `edit`, so it mutates through the shell inside its own
worktree and restores. A strengthened assertion written by whatever just proved
the old one blind is a change nobody reviewed.

**The author cannot run what it writes.** `test-author` holds `write` and
`edit` but no `bash`. It is the only role here that can change a file, it runs
last, and it is structurally unable to declare its own work verified — which is
the exact failure this pack exists to catch, applied to the pack itself. It
writes the test, names the mutation the test should now fail against, and
prints the command a reader must run.

## The specification for a strengthened test

**It must fail against the mutation that proved the old one blind.** Not "it
passes now" — a test written to pass is worthless, and writing one is the
easiest thing in software. The mutation is in the oracle's report, with its
diff, and that is what the new assertion is written against.

## Where blindness actually lives

Highest yield by a distance: **negative-only assertions**.

```js
expect(stdout).not.toContain(entry.dir)
```

This passes for free the moment the two sides spell the path differently — a
separator, a case, a trailing slash. It is not a weak test; it is a test that
was never capable of failing on the platform it ran on.

Both examples in `mutation-probe/mutations.md` are real, found in this
repository, in a suite of several thousand passing tests:

- A worktree-teardown check that would have gone green **with both worktrees
  still registered**, because Windows spells paths differently than Node does.
- A fork test satisfied by an **empty** transcript — so the feature was broken
  *and* the test could not tell.

Both are the same mutation: return an empty collection. It is pattern 8 in the
catalogue and the first one to try whenever a test contains `not.*`.

## Why the counts are always three numbers

Every command here prints a denominator. `BLIND: 0` over an unstated
denominator reads as a clean suite — which is the same lie the blind test was
telling, one level up.

## Author & Support

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
