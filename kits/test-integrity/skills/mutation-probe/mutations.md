# Mutation catalogue

Reference for `/mutation-probe`. Apply one at a time, smallest first, and
always to the **source** — never to the test.

## The mutations, roughly by yield

| # | Mutation | Catches |
|---|---|---|
| 1 | Invert a comparison — `<` → `<=`, `===` → `!==` | Off-by-one and boundary tests that only use the middle of a range |
| 2 | Return the input unchanged | Transform tests that assert the shape and never the transformation |
| 3 | No-op the function body | Tests asserting only that a call happened |
| 4 | Delete one branch of a conditional | Tests exercising a single path with a fixture that never reaches the other |
| 5 | Change a constant — a limit, a timeout, a threshold | Tests that never approach the bound |
| 6 | Swap two arguments of the same type | Tests where both arguments are the same value in the fixture |
| 7 | Remove an `await` | Tests that pass because the assertion runs before the effect |
| 8 | Return an empty collection instead of the result | **Negative-only and absence-only assertions — highest yield** |
| 9 | Return a different-but-plausible error | Tests asserting *that* it threw and never *what* |
| 10 | Skip a side effect — the write, the emit, the log | Tests asserting the return value while the point was the effect |

**Start with 8** when the test contains any `not.*` assertion. Emptying the
result is what exposes the entire class of "the wrong thing is absent" tests
that were never capable of noticing the right thing was absent too.

## Applying one without a write tool

Inside your own worktree, through the shell:

```bash
cp src/target.ts /tmp/probe-backup.ts          # keep the original
sed -i.bak 's/i < times/i <= times/' src/target.ts
<the test command>                             # record the exit code
cp /tmp/probe-backup.ts src/target.ts          # restore
<the test command>                             # confirm green returned
```

Paste the `sed` (or the diff) verbatim. A mutation described but not shown is
a mutation the reader cannot check.

## Running one test alone, by runner

| Runner | Single file | Single test | Repeat | Shuffle |
|---|---|---|---|---|
| Vitest | `npx vitest run path` | `-t "name"` | `--repeats N` | `--sequence.shuffle` |
| Jest | `npx jest path` | `-t "name"` | — | `--randomize` |
| node:test | `node --test path` | `--test-name-pattern` | — | — |
| pytest | `pytest path` | `-k "name"` | `--count N` (plugin) | `-p no:randomly` to disable |
| Go | `go test ./pkg` | `-run '^Name$'` | `-count=N` | `-shuffle=on` |
| JUnit/Gradle | `./gradlew test --tests` | `--tests 'Cls.method'` | — | — |
| XCTest | `xcodebuild test -only-testing:` | same | `-test-iterations N` | `-test-timeouts-enabled` |

Always run the **narrowest** scope that includes the test. A whole-suite run
takes long enough that it gets cut short, and a cut-short run reports nothing.

## When there is no reachable mutation

Some code genuinely cannot be mutated meaningfully — a constant table, a pure
re-export, a type-only module. That is `NO-ORACLE`, and it is an honest
answer. It is *not* an argument that the test is fine: say which it is.

## What a real find looks like

From this repository's own history, both found exactly this way:

```
expect(stdout).not.toContain(entry.dir)
```

Passed whenever the two sides spelled the path differently — which on Windows
is always. It would have gone green with both worktrees still registered. The
fix was to count worktrees instead, and the count was verified by asserting a
deliberately wrong number.

```
expect(transcript).not.toContain(abandonedBranch)
```

Satisfied by an empty transcript. The fork case was broken *and* the test
could not tell. The fix was to assert the kept branch was present as well as
the abandoned one absent.

Both are pattern 8. Both sat in a suite of thousands of passing tests.
