---
name: fitness-function
description: Turn an architectural rule into a check and prove it bites — FAIL on a planted violation, PASS on HEAD, both transcripts, or the output is UNPROVEN CHECK.
---
Turn one architectural rule into a check that runs in CI, then find out whether it
actually catches a violation. The rule, in whatever words the caller has it in:
$ARGUMENTS

If $ARGUMENTS is empty, say so and stop, and ask for the rule as a sentence about what
must not happen.

The literature on architectural fitness functions tells you to write the rule down. It
does not tell you how to find out whether the thing you wrote notices when the rule is
broken, and that is where these checks fail: a rule scoped to a package that no longer
exists, a severity that does not affect the exit code, a linter reading a config it
never found, a CI job that is not a required check. Each of those is green forever, and
green forever is indistinguishable from working.

So this command's product is not the check. It is the pair of transcripts that prove the
check bites.

## The verdict vocabulary

Four values. The output is headed with exactly one of them.

| Verdict | Means |
|---|---|
| `ENFORCING` | The check FAILED on a deliberate violation and PASSES on HEAD. Both transcripts are in the output. |
| `UNPROVEN CHECK` | The check exists and ran, and the proof is missing or came back wrong — it stayed green through the planted violation, or the violation could not be planted at all. |
| `HEAD-VIOLATES` | The check runs and fails on HEAD as it stands. The violating paths are listed. The rule is not weakened. |
| `NOT-CHECKED` | The check could not be run: the tool is absent, the config would not load, the build failed for an unrelated reason. The command and its exit code are printed, and nothing is concluded. |

`ENFORCING` is the only verdict that may be described as enforcement anywhere in the
output, and it costs two transcripts. There is no fifth value and no "probably fine".

## 1. State the rule as a predicate over the tree

Rewrite the caller's sentence as something that is true or false about a set of files,
and that a tool could evaluate:

| Their words | The predicate |
|---|---|
| "the domain should be pure" | no file under `src/domain/**` imports from `src/infra/**` |
| "features shouldn't depend on each other" | no file under `src/features/<A>/**` imports from `src/features/<B>/**`, for any A ≠ B |
| "don't use the ORM outside the repository layer" | no file outside `src/repo/**` imports the ORM package |
| "keep the layering" | **not a predicate** — which layers, in which order, defined where? |

**The first refusal.** A rule you cannot state as a predicate does not become a check
with a plausible config. Write:

```
NOT STATABLE AS A PREDICATE
  The rule as given: <their sentence>
  What is missing: <the set, the direction, or the boundary that is undefined>
  The question that would fix it: <one question>
```

and stop. A config written against an undefined rule is the exact artefact that goes
green because it matches nothing.

Two properties the predicate needs before you go on:

- **The sets are non-empty.** Both sides of the rule must currently match at least one
  file. Print the counts. A rule over a directory that does not exist passes trivially
  and forever, and this is the single most common way these checks die: someone renames
  `src/domain` and the rule about it keeps reporting success.
- **The direction is explicit.** "A must not depend on B" and "B must not depend on A"
  are different checks and both are worth having; write down which one you built.

## 2. Detect the stack and take the recipe from disk

```bash
ls package.json tsconfig.json pyproject.toml setup.cfg go.mod composer.json 2>/dev/null
ls build.gradle build.gradle.kts pom.xml settings.gradle settings.gradle.kts 2>/dev/null
```

| Stack | Recipe |
|---|---|
| JavaScript / TypeScript | `$SKILL_DIR/recipe-dependency-cruiser.md` |
| JVM — Java, Kotlin, Scala | `$SKILL_DIR/recipe-archunit.md` |
| Python | `$SKILL_DIR/recipe-import-linter.md` |
| PHP | `$SKILL_DIR/recipe-deptrac.md` |
| Go | `$SKILL_DIR/recipe-go-arch-lint.md` |
| Anything else, or no tool available | `$SKILL_DIR/recipe-ci-grep.md` |

Read the recipe before you write a line of config. Each one carries the configuration
pattern, the exact run command, **what the tool's exit codes mean**, the allowlist
mechanism it ships, and the blind spots to plant against — because the way each of these
tools goes quietly green is specific to the tool.

A repository can be several of these at once. Build the check for the stack the rule's
files are actually written in, and say which files told you.

**Prefer the tool that already exists in the repo.** If `dependency-cruiser` is already a
devDependency with a config, add a rule to it rather than introducing ArchUnit. A second
architecture linter is a second thing to keep configured, and the one nobody wired into
CI is the one that reports green.

Before running anything, prove the tool is really there:

```bash
<tool> --version
```

Print that output. A tool name you did not see respond is `NOT-CHECKED`, never an
assumption, and you do not invent its version, its rule ids or its config keys. If it
must be installed, name the exact install command and let the caller run it — and say in
the output that a dependency was added, because that is a change to their manifest.

## 3. Write the check

Follow the recipe. Three rules that hold across all of them:

- **The rule fails the build.** Warn-level findings that leave the exit code at zero are
  not checks. Every recipe names the setting that controls this; set it, and print the
  setting you set.
- **The rule names what it forbids, not what it allows**, wherever the tool supports
  both. An allow-list of permitted edges silently permits every edge somebody adds to
  the list; a deny rule fails loudly when someone crosses it.
- **One rule, one predicate.** A config with four rules whose combined exit code you
  proved once has proven one of them. Prove each rule you add, or report the unproven
  ones as `UNPROVEN CHECK` by name.

## 4. Run it on HEAD

```bash
git rev-parse --short HEAD
git status --porcelain
<the run command from the recipe>
echo "exit: $?"
```

Print the command, its output, and its exit code, verbatim. Three outcomes:

**Exit 0 — the rule holds on HEAD.** Go to section 5. This is the only path to
`ENFORCING`.

**Non-zero because the rule is violated — this is a finding, not a problem with the
check.**

```
HEAD-VIOLATES — <rule as a predicate>
  Violating paths (<N>), verbatim from the tool:
    src/domain/order.ts:4  →  src/infra/db.ts
    …
```

**The second refusal, and it is the one that matters most.** You do not weaken the rule
to make it green. Not by narrowing the glob until the violations fall outside it, not by
dropping the severity, not by excluding the offending directory, and not by adding the
violating paths to an allowlist yourself. Every one of those turns a finding into a
passing check, which is worse than having no check at all, because now there is a green
badge over it.

What you write instead is the allowlist **as a proposal a person accepts or rejects**:

```
Proposed allowlist — NOT APPLIED. Each entry is a decision, not a formatting fix.

  path: src/domain/order.ts
  why it is there: <what you could determine, or `unknown — author must supply`>
  permanent exception or debt: <blank — a person fills this in>
  owner: <blank>
```

with the exact config snippet below it and the sentence naming what happens if it is
applied: the check goes green with these violations in the tree, and it stops noticing
new ones only in these paths. Then stop at `HEAD-VIOLATES`. Whether the existing
violations are acceptable is a judgment about this codebase's history that this command
does not have the standing to make.

**Non-zero for another reason** — tool crashed, config would not parse, compilation
failed, no files matched. That is `NOT-CHECKED`, with the command, the exit code and the
error output. It is never reported as a pass, and it is never reported as a violation.

## 5. Prove it bites

A check that has only ever been run against a passing tree has been observed doing
nothing. This section is what separates this command from writing a config file.

**The precondition, and the third refusal.** Planting a violation edits files in the
caller's checkout. This is a skill: it runs in your session, with your tools, in your
working tree — there is no worktree here whose diff gets discarded. So:

```bash
git status --porcelain
```

If that prints anything, **you do not plant.** Write:

```
UNPROVEN CHECK — working tree not clean, refused to plant a violation
  Uncommitted changes: <N files>
  What to do: commit or stash, then re-run. The proof step edits a file and reverts it,
  and it will not do that on top of work it cannot cleanly restore.
```

That is a real refusal with a real substitute, and it is not paranoia: the revert step
below is a `git checkout --` of a specific path, and on a dirty file that discards
someone's work.

With a clean tree, plant the smallest edit that makes the predicate false — one import,
one line — in a file that is inside the rule's scope:

```bash
git rev-parse --short HEAD                 # print it again; the transcript is dated
<edit one file — one line — print the diff>
git diff --stat
<the run command>
echo "exit: $?"
git checkout -- <the file you touched>
git status --porcelain                     # must be empty again
<the run command>
echo "exit: $?"
```

Print all three runs. Two outcomes:

**The check failed on the planted violation and passes again after the revert.** That is
`ENFORCING`. The output carries the planted diff, the failing transcript with the rule
name in it, and the restored transcript. Note which rule name appeared in the failure —
a failure caused by some *other* rule in the same config proves that other rule, not
this one.

**The check stayed green.** That is `UNPROVEN CHECK`, and it is the useful result:

```
UNPROVEN CHECK — the check ran and did not notice the violation
  Violation planted: <the exact diff>
  Run: <command>   exit: 0
  What this means: the check does not measure the rule as stated.
  Candidate causes, in the order worth testing: <from the recipe's blind-spot list>
```

Do not fix and re-report in one pass without saying so. If you adjust the config and
re-prove, print both attempts — the first configuration and why it did not bite is the
most useful paragraph in the whole output, and it is the one a reader needs in order to
not rebuild the same broken check next quarter.

**Plant a second violation of a different shape** when the rule has more than one way to
be broken — a transitive import as well as a direct one, a type-only import as well as a
value import, a dynamic require as well as a static one. `ENFORCING` is always a claim
about the violations you planted; the output says which they were, so a reader can
disagree with your choice.

Leave the tree exactly as you found it. The last thing printed in this section is a
`git status --porcelain` that is empty.

## 6. Wire it into CI, and say what wiring it does not do

A check that runs on a developer's laptop is a suggestion. Give the exact job snippet,
and name the two things that are outside the file:

```yaml
# .github/workflows/architecture.yml
name: architecture
on: [push, pull_request]
jobs:
  fitness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - <the setup steps for this stack>
      - run: <the run command from the recipe>
```

```
ADVISORY-ONLY until both of these are true, and neither is in this file:
  1. the job is a required status check on the protected branch
  2. nobody can merge with it red — administrators included, if that is what you meant
```

Say that plainly. A green job that does not block a merge is a dashboard, and this
command will not describe it as a gate.

## 7. Name what the check does not cover

Every check has a scope smaller than the rule a human said out loud. Close with it:

```
Scope of this check
  Sees: <the statement forms and file types the tool parses>
  Does not see: <from the recipe — dynamic wiring, reflection, DI, generated code,
                 cross-process calls, whatever this tool structurally cannot follow>
  Untested shapes: <violations you did not plant and why>
```

A reader who knows the check is blind to the DI container can decide whether that
matters. A reader who thinks the rule is enforced cannot.

## The refusals

- **It will not report a check as enforcing without both transcripts.** No planted-failure
  run and no restored-pass run means the output is headed `UNPROVEN CHECK`, naming which
  transcript is missing.
- **It will not weaken the rule to go green.** A HEAD that violates the rule is
  `HEAD-VIOLATES` with the violating paths listed verbatim from the tool, and the
  allowlist is written out as a proposal with an empty owner field for a person to fill.
- **It will not plant a violation in a dirty tree.** It writes
  `UNPROVEN CHECK — working tree not clean, refused to plant` and tells you to commit or
  stash first.
- **It will not report a tool it did not see run.** No `--version` output means
  `NOT-CHECKED`, and no rule id, config key or version number is written that was not
  read from real output or from the recipe.
- **It will not call a non-required CI job a gate.** The wiring section says
  `ADVISORY-ONLY` until the job is required on the protected branch.

## Output

```
FITNESS FUNCTION — <the rule, as a predicate>
STATUS: ENFORCING | UNPROVEN CHECK | HEAD-VIOLATES | NOT-CHECKED
Stack: <detected> — <the file that said so>
Tool: <name> <version, from --version output>
Check: <path of the config or test file you wrote>
Scope: <N> files match the "from" set · <M> files match the "to" set
Tree @ <sha> (clean)
```

Then, in this order:

1. **The check** — the config or test, complete, as it should land in the repo.
2. **Run on HEAD** — command, output, exit code.
3. **Planted violation** — the diff, the command, the output, the exit code.
4. **Restored** — the revert, the command, the exit code, and an empty
   `git status --porcelain`.
5. **CI wiring** — the job snippet and the `ADVISORY-ONLY` conditions.
6. **Scope of this check** — sees, does not see, untested shapes.
7. **Not established** — anything the proof needed and did not get, each with the one
   command that would get it. Say so explicitly when this list is empty.

For `HEAD-VIOLATES`, sections 3 and 4 are replaced by the violating-path list and the
proposed allowlist, and the status line stays `HEAD-VIOLATES` — a check whose bite has
not been demonstrated is not upgraded by the fact that it is currently red.
