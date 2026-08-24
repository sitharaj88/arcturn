# Recipe — Deptrac (PHP)

Layer rules over PHP namespaces and directories, checked by `deptrac analyse`.

This file is data. Nothing in this folder is executable and nothing runs at install
time; the configuration and commands below are printed for you to put in a repository
and run in a session.

Do not copy a version out of this file. Print `vendor/bin/deptrac --version` in your
transcript.

---

## 1. Install

```bash
composer require --dev qossmic/deptrac
vendor/bin/deptrac --version
```

## 2. The configuration

`deptrac.yaml` at the repository root:

```yaml
deptrac:
  paths:
    - ./src
  exclude_files:
    - '#.*Test\.php$#'

  layers:
    - name: Controller
      collectors:
        - type: directory
          value: src/Controller/.*
    - name: Domain
      collectors:
        - type: directory
          value: src/Domain/.*
    - name: Infrastructure
      collectors:
        - type: directory
          value: src/Infrastructure/.*
    - name: Doctrine
      collectors:
        - type: className
          value: ^Doctrine\\.*

  ruleset:
    Controller:
      - Domain
    Domain: ~
    Infrastructure:
      - Domain
      - Doctrine
```

`Domain: ~` is the strongest line in the file: the Domain layer may depend on nothing.
Every layer's entry lists exactly what it is allowed to reach, and anything not listed is
a violation.

Collector types worth knowing: `directory` (a path regex), `className` (a
fully-qualified-name regex — the way to make a third-party package a layer, as with
`Doctrine` above), `bool` with `must`/`must_not` for composed conditions, and
`implements`/`extends` for structural membership.

## 3. Make uncovered code fail

**A class that belongs to no layer is invisible to every rule, and Deptrac reports it as
"uncovered" rather than as a violation.** A ruleset over `src/Domain` after somebody adds
`src/NewDomain` constrains nothing there, and the run is green.

```bash
vendor/bin/deptrac analyse --config-file=deptrac.yaml --report-uncovered --fail-on-uncovered
```

`--report-uncovered` prints them; `--fail-on-uncovered` makes them non-zero. Turn both on
and print that you did. This is this tool's version of the empty-set precondition.

## 4. Run, and what the exit code means

```bash
vendor/bin/deptrac analyse --config-file=deptrac.yaml --report-uncovered --fail-on-uncovered
echo "exit: $?"
```

| Exit | Means |
|---|---|
| 0 | No violations, and no uncovered tokens when `--fail-on-uncovered` is set. |
| non-zero | Violations, errors, or uncovered tokens. |

Other formatters, for a report a machine reads:

```bash
vendor/bin/deptrac analyse --formatter=json --output=deptrac.json
vendor/bin/deptrac analyse --formatter=github-actions      # inline PR annotations
```

Deptrac caches its analysis in `.deptrac.cache` by default. If a run comes back
suspiciously fast or unchanged after an edit, `--cache-file` to a fresh path or delete
the cache and re-run — a cached green is not a green.

## 5. The verify loop

```bash
git status --porcelain                               # must be empty
vendor/bin/deptrac analyse --config-file=deptrac.yaml --report-uncovered --fail-on-uncovered
echo "exit: $?"                                      # expect 0

# plant: a real use, not just a `use` statement — a type-hint or a call
#   in src/Domain/Order.php, reference \App\Infrastructure\DoctrineOrderRepository
git diff
vendor/bin/deptrac analyse --config-file=deptrac.yaml --report-uncovered --fail-on-uncovered
echo "exit: $?"                                      # expect non-zero, with Domain →
#   Infrastructure named in the violation list

git checkout -- src/Domain/Order.php
git status --porcelain
vendor/bin/deptrac analyse --config-file=deptrac.yaml --report-uncovered --fail-on-uncovered
echo "exit: $?"                                      # expect 0
```

## 6. The allowlist mechanism

A baseline file records the violations that exist today and fails only on new ones:

```bash
vendor/bin/deptrac analyse --formatter=baseline --output=deptrac.baseline.yaml
```

```yaml
deptrac:
  baseline: deptrac.baseline.yaml
```

That is `HEAD-VIOLATES` written down. Generating it is a decision about this codebase's
history: print how many violations it would freeze and which classes, name the file, and
say that a baseline nobody shrinks is a permanent exception with a filename. Do not
generate one to make a red run green.

`skip_violations` in the config does the same thing per class pair, inline, and has the
same status.

## 7. Blind spots — plant against these, do not assume

| Shape | Likely outcome | How to test it |
|---|---|---|
| `new $className` from a string | **not caught** | plant it and record the green run |
| a service id resolved from a Symfony container config | not caught — the wiring is YAML | plant it |
| `call_user_func`, `$container->get('...')` | not caught | plant it |
| a class in no layer | **uncovered, and green** without `--fail-on-uncovered` | add a file outside every collector and confirm the run now fails |
| a `use` statement with no real reference | depends on the analyser's token handling | plant both shapes and see which fires |
| annotations and attribute arguments | version-dependent | plant a Doctrine attribute referencing an infrastructure class |
| vendor code | outside `paths` | print `paths` in your output |

Row four is the one that decides whether this check survives a refactor. Test it once,
deliberately, when you write the config.
