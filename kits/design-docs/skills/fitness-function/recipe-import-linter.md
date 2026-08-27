# Recipe — import-linter (Python)

Layer and independence contracts over a Python import graph, checked by `lint-imports`.

This file is data. Nothing in this folder is executable and nothing runs at install
time; the configuration and commands below are printed for you to put in a repository
and run in a session.

Do not copy a version out of this file. Print `lint-imports --version` in your transcript.

---

## 1. Install

```bash
python -m pip install import-linter
lint-imports --version
```

The package must be importable in the environment you run it from: it builds the graph by
importing modules through `grimp`, so a virtualenv that cannot import your package
produces an error, not an empty result. That error is `NOT-CHECKED`.

## 2. The contracts

`.importlinter` at the repository root (the same content works in `setup.cfg` under
`[importlinter]`, or in `pyproject.toml` under `[tool.importlinter]`):

```ini
[importlinter]
root_packages =
    myapp
include_external_packages = True

[importlinter:contract:layers]
name = Layered architecture
type = layers
layers =
    myapp.web
    myapp.service
    myapp.domain

[importlinter:contract:features-independent]
name = Feature packages do not import each other
type = independence
modules =
    myapp.billing
    myapp.search
    myapp.reporting

[importlinter:contract:orm-confined]
name = The ORM is used only in the repository layer
type = forbidden
source_modules =
    myapp.domain
    myapp.web
forbidden_modules =
    sqlalchemy
```

Three contract types, three different predicates:

- **`layers`** — higher layers may import lower ones, never the reverse, and siblings
  listed on one line (`myapp.a | myapp.b`) may not import each other. The order is the
  rule; the first line is the highest layer.
- **`independence`** — none of the listed modules may import any other, in either
  direction.
- **`forbidden`** — `source_modules` may not import `forbidden_modules`. This is the one
  that reaches third-party packages, and it needs `include_external_packages = True`.

`layers` is transitively strict by construction: it forbids the reverse import however
many hops it takes. That is a real difference from a direct-edge rule in another
ecosystem, and it is worth stating in your output.

## 3. Run, and what the exit code means

```bash
lint-imports
echo "exit: $?"
```

| Exit | Means |
|---|---|
| 0 | Every contract passed. |
| 1 | At least one contract was broken; the report names the contract and prints the import chain. |

The report prints the full chain for each violation — `myapp.domain.order` →
`myapp.infra.db` → `sqlalchemy` — which is the part worth pasting into the transcript,
because it shows *why* the rule fired and not only that it did.

```bash
lint-imports --verbose             # per-contract progress and timing
lint-imports --config .importlinter --contract features-independent
```

## 4. The verify loop

```bash
git status --porcelain                              # must be empty
lint-imports ; echo "exit: $?"                      # expect 0

# plant: one import, at module level, inside the "from" set
printf 'from myapp.infra import db  # planted\n' >> myapp/domain/order.py
git diff --stat
lint-imports ; echo "exit: $?"                      # expect 1, and expect the contract
#   name and the import chain in the output

git checkout -- myapp/domain/order.py
git status --porcelain
lint-imports ; echo "exit: $?"                      # expect 0
```

## 5. The allowlist mechanism

Per contract, `ignore_imports` lists specific edges to exclude:

```ini
[importlinter:contract:layers]
name = Layered architecture
type = layers
layers =
    myapp.web
    myapp.service
    myapp.domain
ignore_imports =
    myapp.domain.legacy -> myapp.infra.db
unmatched_ignore_imports_alerting = error
```

Set `unmatched_ignore_imports_alerting = error`. Without it, an ignore line whose import
no longer exists is silently accepted, so an exception outlives the code it was written
for and nobody finds out. With it, a stale exception fails the run — which is a stale
exception behaving like the debt it is.

An `ignore_imports` entry is a decision. Propose it with an owner and a reason; do not
add one to turn a red run green.

## 6. Blind spots — plant against these, do not assume

import-linter builds its graph from static analysis of the source, and function-level
imports are in the graph. The interesting failures are elsewhere:

| Shape | Likely outcome | How to test it |
|---|---|---|
| `importlib.import_module("myapp.infra.db")` | **not caught** — a string is not an import | plant it and record the green run |
| `__import__("myapp.infra.db")` | not caught | same |
| an entry point resolved from `pyproject.toml` | not caught | same |
| a Django app loaded from `INSTALLED_APPS` | not caught — a settings string | same |
| an import inside a function | caught | plant one to confirm your reading of the version you have |
| `if TYPE_CHECKING:` imports | caught by default | plant one; decide whether you want it, and say so |
| a namespace package with no `__init__.py` | may not be traversed | check the module count in `--verbose` output against the file count |
| a module outside `root_packages` | outside the graph entirely | print `root_packages` in your output |

The last row is the empty-set failure in this ecosystem: a contract naming
`myapp.billing` after the package moved to `myapp.features.billing` does not error, it
just constrains nothing. Rename a module in the contract to something imaginary once and
confirm the run reports it — import-linter fails on a module it cannot find, and knowing
that from your own transcript is worth more than knowing it from this file.
