---
name: coverage-truth
description: Report what this repository's coverage number actually measures, where it is highest and least meaningful, and what it cannot see at all.
---

Report what the coverage number for `$CWD` actually means. The argument names a
scope, or nothing for the whole repository.

**The premise.** Coverage measures that a line executed. It does not measure
that anything checked what the line did. A file at 100% whose assertions cannot
fail is exactly the shape of the problem — and it reports better than a file at
60% with sharp tests. Any use of this command that ends in "raise coverage to
N%" has made the codebase worse.

## What to establish

1. **Is it measured at all?** Find the config — `vitest.config`, `jest.config`,
   `.nycrc`, `pytest.ini`/`pyproject`, `build.gradle` jacoco, a `-coverprofile`
   flag in CI. Report the tool, the thresholds if any, and which files are
   **excluded**. The exclusion list is the interesting part and nobody reads
   it: a project can carry a proud number that omits the directory where the
   logic lives.
2. **Which kind?** Line, statement, branch, function. Line coverage over code
   full of `&&` and early returns is close to meaningless; branch coverage is
   the one worth quoting. Say which this project reports.
3. **Where is it high and weak?** Cross the coverage report against the
   assertion patterns from `/vacuous-check`. Files with high coverage and
   negative-only assertions are the top of the list — covered, asserting
   nothing, and invisible to every metric the project has.
4. **What is uncovered and consequential?** Rank uncovered lines by what they
   do — an unexercised error path in a payment or permission check outranks a
   whole uncovered logging module. Never rank by file size or percentage.

## What coverage cannot see, and say so explicitly

- Whether an assertion can fail — `/mutation-probe` is the only thing that
  decides this
- Whether the test asserts the effect or just the call
- Anything about behaviour the code does not have — a missing branch is not an
  uncovered branch, it is invisible
- Order dependence and flakiness
- Integration seams that each side covers separately and nobody covers together

## Report

The number, the tool, the kind, the exclusions verbatim, and then the ranked
list of *high-coverage, low-assurance* files — that is the output worth having.

End with a `NOT MEASURED` block naming what this project's setup cannot see at
all, and the check that would see each. Do not recommend a coverage target.

Scope: $ARGUMENTS
