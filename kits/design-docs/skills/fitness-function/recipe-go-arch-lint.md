# Recipe — go-arch-lint, and the `go list` fallback (Go)

Component rules over Go package imports, plus a dependency-free fallback that needs
nothing but the toolchain you already have.

This file is data. Nothing in this folder is executable and nothing runs at install
time; the configuration and commands below are printed for you to put in a repository
and run in a session.

Do not copy a version out of this file. Print `go-arch-lint version` in your transcript.

---

## 1. Install

```bash
go install github.com/fe3dback/go-arch-lint@latest
go-arch-lint version
```

An `@latest` install is not reproducible across machines. For CI, pin the version in the
job and print what it resolved to; for the local proof, print the version you ran.

## 2. The configuration

`.go-arch-lint.yml` at the module root:

```yaml
version: 3
workdir: .

components:
  domain:  { in: internal/domain/** }
  service: { in: internal/service/** }
  infra:   { in: internal/infra/** }
  api:     { in: internal/api/** }

deps:
  domain:
    mayDependOn: []
  service:
    mayDependOn:
      - domain
  infra:
    mayDependOn:
      - domain
  api:
    mayDependOn:
      - service
      - domain

excludeFiles:
  - "^.*_test\\.go$"
```

`mayDependOn: []` is the load-bearing line: `domain` may import nothing else in this
module. Every component's allowed set is explicit, and anything outside it is a
violation.

Two settings that change the scope of the whole check, and both belong in your output:

- **`allowDependOnAnyVendor`** — when true, third-party imports are unconstrained. If
  your rule is about a third-party package (an ORM, a cloud SDK) you need it false and a
  `vendors:` block naming the package.
- **`deepScan`** — the deeper analysis mode; it catches more shapes and costs more time.
  Say which mode produced your transcripts.

Any Go file under `workdir` that no component matches is not covered by any rule.
`go-arch-lint check` reports those; read that section of the output rather than skipping
to the verdict.

## 3. Run, and what the exit code means

```bash
go-arch-lint check
echo "exit: $?"
```

| Exit | Means |
|---|---|
| 0 | No violation, config valid. |
| non-zero | Violations, or a config that would not load. |

```bash
go-arch-lint check --output-type json > arch.json
go-arch-lint mapping                # which files landed in which component — read this
```

`go-arch-lint mapping` is the empty-set check for this tool: it prints the file-to-
component mapping, so a component matching nothing is visible as an empty list rather
than as a rule that passes. Run it once when you write the config and paste the counts.

## 4. The verify loop

```bash
git status --porcelain                       # must be empty
go-arch-lint check ; echo "exit: $?"         # expect 0

# plant: one import, used, in a file inside the "from" component
#   Go will not compile an unused import, so the reference must be real.
git diff
go-arch-lint check ; echo "exit: $?"         # expect non-zero, naming domain → infra
go build ./...                               # confirm the violation actually compiles

git checkout -- internal/domain/order.go
git status --porcelain
go-arch-lint check ; echo "exit: $?"         # expect 0
```

Go's unused-import compile error is useful here: it forces the planted violation to be a
real reference rather than a decorative import line, which is the trap the JVM recipe has
to warn about.

## 5. The `go list` fallback

When you cannot add a tool, the toolchain answers the same question. This is a real
check, not a placeholder:

```bash
#!/usr/bin/env bash
# arch-check.sh — no dependencies beyond the Go toolchain. Exit 1 on violation.
set -uo pipefail

MODULE=$(go list -m)
fail=0

# check <name> <package-pattern> <forbidden-import-substring>
check() {
  local name=$1 pkgs=$2 forbidden=$3 hits
  hits=$(go list -deps -f '{{.ImportPath}}' "$pkgs" 2>/dev/null | grep -F "$forbidden" || true)
  if [ -n "$hits" ]; then
    printf 'FAIL %s\n  reachable: %s\n  direct importers:\n' "$name" "$(echo "$hits" | tr '\n' ' ')"
    # Empty here means the edge is transitive only; `go mod why -m` or
    # `go list -deps` on each package names the chain.
    go list -f '{{.ImportPath}}{{range .Imports}} {{.}}{{end}}' "$pkgs" \
      | grep -F "$forbidden" | sed 's/^/    /' || true
    fail=1
  else
    printf 'PASS %s (no dependency on %s from %s)\n' "$name" "$forbidden" "$pkgs"
  fi
}

check "domain-does-not-depend-on-infra" ./internal/domain/... "$MODULE/internal/infra"
check "domain-does-not-depend-on-sql"   ./internal/domain/... "database/sql"

exit $fail
```

`go list -deps` is transitive, so this catches the edge through an intermediate package
as well as the direct one — a stronger predicate than most direct-edge rules, and worth
saying so. The `|| true` on the `grep` is deliberate: `grep` exits 1 when it finds
nothing, and without it `set -e` or a bare `$?` turns "no violations" into a failure.
That inversion is the classic way a shell-based check reports backwards, and it is why
the fallback prints an explicit `PASS` line with the count rather than relying on
silence.

Put the script in the repository, not in this package: nothing in a skill folder is
executable, and this file is printed for you to create the script yourself.

## 6. The allowlist mechanism

go-arch-lint has no baseline file. An exception is a change to `deps` or a narrower `in:`
glob, which means every exception is visible in the config and reviewable in a diff. That
is a genuine advantage over a generated baseline, and it means there is no way to
"record" existing violations — a `HEAD-VIOLATES` result in Go has to be fixed or
explicitly written into the rules with a comment naming the owner.

For the `go list` fallback, the equivalent is a `grep -v` exclusion line, which should
carry the same comment.

## 7. Blind spots — plant against these, do not assume

| Shape | Likely outcome | How to test it |
|---|---|---|
| `reflect`-driven construction | **not caught** — no import edge | plant it and record the green run |
| a plugin loaded with `plugin.Open` | not caught | same |
| an interface satisfied implicitly across components | **not an import** — Go interfaces are structural, so a dependency inversion leaves no edge at all | plant it; this is the shape most worth documenting in `Scope of this check` |
| generated code (`*.pb.go`, mocks) | in scope unless excluded | check `excludeFiles` |
| test files | excluded by the config above | decide deliberately; a test importing infra from domain may be fine |
| build tags (`//go:build`) | `go list` respects the current tags | run under the tags CI uses, and say which |
| a second module in the repo | outside `go list ./...` from this root | run per module |

The structural-interface row is the honest limit of import-graph checking in Go: the
pattern the rule is usually meant to encourage — the domain defining an interface that
infrastructure implements — is invisible to the graph in both directions. The check
proves the absence of an import, which is the predicate you stated, and not the presence
of a design.
