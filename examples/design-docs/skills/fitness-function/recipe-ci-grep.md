# Recipe — the CI grep fallback (any stack)

When no import-graph tool exists for the stack, or you cannot add a dependency, the
check is a script that searches for the forbidden shape and exits non-zero when it finds
one. This is the weakest recipe in the folder and it is here because "no tool available"
must not mean "no check".

This file is data. Nothing in this folder is executable and nothing runs at install time.
The script below is printed for you to create in your own repository, where it can be
reviewed in a diff like any other code.

---

## 1. What this can and cannot be

A grep sees text. It does not resolve imports, it does not follow aliases, and it has no
idea what a module is. Everything it reports is a lexical match, so:

- **It cannot see transitive dependencies.** `domain → shared → infra` is invisible; only
  the literal text in `domain` is searched.
- **It cannot resolve an alias.** If the repository imports infrastructure as
  `@app/infra` or `github.com/org/repo/internal/infra`, both spellings have to be in the
  pattern, and a new spelling defeats it silently.
- **It matches comments and strings.** A doc comment mentioning the forbidden package is
  a false positive, and somebody will "fix" it by loosening the pattern.

State all three in `Scope of this check`. A grep check that is described as enforcing a
boundary is a stronger claim than the tool can carry.

What it does well: it is a real predicate, it runs anywhere, it has no install step, and
its failure output is the violating line itself. For a rule about a *literal* — a banned
API, a forbidden package name, a deprecated import path — it is close to as good as a
graph tool, because the predicate really is lexical.

## 2. The script

```bash
#!/usr/bin/env bash
# tools/arch-check.sh — architectural rules as searches. Exit 1 on violation.
# Every rule prints a PASS line with the pattern and the root it searched, so a rule
# that matches nothing because the directory moved is visible rather than silent.
set -uo pipefail

fail=0

# check <name> <root> <pattern> [<include glob> ...]
check() {
  local name=$1 root=$2 pattern=$3
  shift 3
  local includes=()
  for g in "$@"; do includes+=(--include="$g"); done
  # bash 3.2 (the macOS default) errors on "${empty[@]}" under `set -u`.
  [ ${#includes[@]} -eq 0 ] && includes=(--include='*')

  if [ ! -d "$root" ]; then
    printf 'ERROR %s: search root %s does not exist\n' "$name" "$root"
    fail=1
    return
  fi

  local files hits
  files=$(grep -rl "" "$root" "${includes[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$files" = "0" ]; then
    printf 'ERROR %s: no files matched under %s\n' "$name" "$root"
    fail=1
    return
  fi

  hits=$(grep -rnE "$pattern" "$root" "${includes[@]}" || true)
  if [ -n "$hits" ]; then
    printf 'FAIL %s (%s files searched under %s)\n%s\n' "$name" "$files" "$root" "$hits"
    fail=1
  else
    printf 'PASS %s (%s files searched under %s, 0 hits for %s)\n' \
      "$name" "$files" "$root" "$pattern"
  fi
}

check "domain-does-not-import-infra" src/domain \
      '^[[:space:]]*(import|from).*(\.\./infra/|@app/infra)' '*.ts' '*.tsx'

check "no-orm-outside-repositories" src \
      '^[[:space:]]*import .*sqlalchemy' '*.py'

exit $fail
```

Three details in there are the entire difference between a check and a decoration:

- **`|| true` after `grep`.** `grep` exits 1 when it finds nothing. Under `set -e`, or
  read straight from `$?`, that turns "clean" into "failed" — and the usual fix is to
  invert the test, which turns "clean" into "passed" *and* "violation" into "passed" the
  first time the pattern stops matching. Capture the output, test the string.
- **The empty-root guard.** A rule whose directory was renamed searches nothing and finds
  nothing, which reads exactly like compliance. `ERROR: no files matched` is the empty-set
  precondition made mechanical, and it is why this script counts files before it searches.
- **`PASS` prints the pattern, the root and the file count.** A green line that names what
  it searched can be audited from a CI log by somebody who was not there.

## 3. Run, and what the exit code means

```bash
bash tools/arch-check.sh
echo "exit: $?"
```

| Exit | Means |
|---|---|
| 0 | Every rule printed PASS with a non-zero file count. |
| 1 | At least one FAIL, or a rule whose root was missing or empty. |

## 4. The verify loop

```bash
git status --porcelain                       # must be empty
bash tools/arch-check.sh ; echo "exit: $?"   # expect 0

# plant
printf '\nimport { pool } from "../infra/db";\n' >> src/domain/order.ts
bash tools/arch-check.sh ; echo "exit: $?"   # expect 1, with the file and line printed

git checkout -- src/domain/order.ts
git status --porcelain
bash tools/arch-check.sh ; echo "exit: $?"   # expect 0
```

Then plant the shapes this check is blind to and record what happens, because the point
of using the weakest tool is knowing exactly how weak:

```bash
# an aliased spelling of the same import
printf '\nimport { pool } from "@app/infra/db";\n' >> src/domain/order.ts   # caught only
#   if the alias is in the pattern
# a transitive edge
printf '\nimport { pool } from "../shared/db-reexport";\n' >> src/domain/order.ts  # not caught
```

Both results go in `Scope of this check`, with the exit code you saw.

## 5. The allowlist mechanism

There is none, which is a feature: an exception is a `grep -v` line or a narrower root, in
the script, in a diff, with a comment naming the owner:

```bash
# Exception: src/domain/legacy predates ADR-0007. Owner: <name>. Removed when <condition>.
hits=$(printf '%s\n' "$hits" | grep -v '^src/domain/legacy/' || true)
```

Write the owner and the condition. An unexplained `grep -v` in a check script is
indistinguishable from a typo, and it will be copied.

## 6. CI wiring

```yaml
# .github/workflows/architecture.yml
name: architecture
on: [push, pull_request]
jobs:
  fitness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash tools/arch-check.sh
```

`ADVISORY-ONLY` until this job is a required status check on the protected branch. Nothing
in the file above makes it one.

## 7. When to replace this

The moment a real tool for the stack becomes available, this becomes a stopgap with a
worse predicate. `$SKILL_DIR/recipe-dependency-cruiser.md`,
`$SKILL_DIR/recipe-archunit.md`, `$SKILL_DIR/recipe-import-linter.md`,
`$SKILL_DIR/recipe-deptrac.md` and `$SKILL_DIR/recipe-go-arch-lint.md` all resolve the
graph properly and all catch shapes this cannot. Migrating is a change of check, so it
needs its own planted violation and its own pair of transcripts.
