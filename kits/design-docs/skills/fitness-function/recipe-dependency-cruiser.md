# Recipe — dependency-cruiser (JavaScript / TypeScript)

Module-boundary rules for a JS or TS repository, evaluated over the real resolution
graph rather than over path strings.

This file is data. Nothing in this folder is executable and nothing runs at install
time; the configuration and commands below are printed for you to put in a repository
and run in a session, which is what makes their output evidence.

Do not copy a version number out of this file. Read the version the repository resolves
and print `npx depcruise --version` in your transcript.

---

## 1. Install and initialise

```bash
npm install --save-dev dependency-cruiser
npx depcruise --init          # writes .dependency-cruiser.js with a commented ruleset
npx depcruise --version
```

`--init` asks a few questions and writes a starting config. Keep what it wrote and add
your rule to `forbidden`; the defaults it generates (orphans, circular, dev-dep leakage)
are worth having and each one still needs its own proof.

## 2. The rule

```js
// .dependency-cruiser.js
module.exports = {
  forbidden: [
    {
      name: "no-domain-to-infra",
      comment: "Domain code must not import infrastructure. ADR-0007.",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { path: "^src/infra/" },
    },
    {
      name: "no-feature-to-feature",
      comment: "Feature packages are independent of each other.",
      severity: "error",
      from: { path: "^src/features/([^/]+)/" },
      to: { path: "^src/features/([^/]+)/", pathNot: "^src/features/$1/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    exclude: { path: "\\.(test|spec)\\.[jt]sx?$" },
  },
};
```

Three settings in `options` change what the check can see, and each one is worth stating
in your output:

- **`tsConfig`** — without it, `paths` aliases (`@app/core`) do not resolve, and an
  aliased import of infrastructure is invisible to the rule.
- **`tsPreCompilationDeps: true`** — without it, type-only imports
  (`import type { Db } from "../infra/db"`) are not in the graph. Whether you want them
  counted is a real choice; state which you chose.
- **`exclude`** — every path you exclude is a path the rule does not cover. Tests are a
  defensible exclusion; `src/legacy` is an allowlist wearing different clothes.

The `$1` backreference in the second rule is dependency-cruiser's own group-capture
syntax: `from.path` captures the feature name and `to.pathNot` re-uses it, so each
feature is forbidden from every feature except itself. Prove that one by planting an
import across two features, not by reading the regex.

## 3. Run, and what the exit code means

```bash
npx depcruise src --config .dependency-cruiser.js
echo "exit: $?"
```

| Exit | Means |
|---|---|
| 0 | No `error`-severity violation. |
| non-zero | At least one `error`-severity violation; the count is the exit code. |

**`severity: "warn"` and `severity: "info"` do not affect the exit code.** A rule at
`warn` prints in the report, goes green in CI, and is the most common way a
dependency-cruiser ruleset stops biting. If you want the rule to fail the build it is
`severity: "error"`, and your output says so.

For a machine-readable report:

```bash
npx depcruise src --config .dependency-cruiser.js --output-type err-long
npx depcruise src --config .dependency-cruiser.js --output-type json > depcruise.json
```

## 4. The verify loop

```bash
git status --porcelain                       # must be empty before planting
npx depcruise src --config .dependency-cruiser.js ; echo "exit: $?"   # expect 0

# plant: one import, inside the "from" set, of something in the "to" set
printf '\nimport { pool } from "../infra/db";\nvoid pool;\n' >> src/domain/order.ts
git diff --stat
npx depcruise src --config .dependency-cruiser.js ; echo "exit: $?"   # expect non-zero
#   and expect the string "no-domain-to-infra" in the output

git checkout -- src/domain/order.ts
git status --porcelain                       # must be empty again
npx depcruise src --config .dependency-cruiser.js ; echo "exit: $?"   # expect 0
```

Check the rule *name* in the failing output. A non-zero exit produced by `no-circular`
proves `no-circular`, not the rule you are trying to establish.

## 5. The allowlist mechanism

There is no baseline file. Exceptions are expressed in the rule itself — `pathNot` on
either side, or a narrower `from.path`:

```js
{
  name: "no-domain-to-infra",
  severity: "error",
  from: { path: "^src/domain/", pathNot: "^src/domain/legacy/" },
  to: { path: "^src/infra/" },
}
```

That is a decision: `src/domain/legacy` is now permanently outside the rule, and nothing
will tell you when new files appear there. Propose it with an owner and a reason; do not
apply it to make a red check green.

`--known-violations` and `depcruise --output-type baseline` exist in recent versions and
generate a `.dependency-cruiser-known-violations.json`. Same rule: a baseline is a
recorded list of accepted violations, which is a decision about this codebase's history.
Propose it, print what it would freeze, and let a person accept it.

## 6. Blind spots — plant against these, do not assume

Test each one that matters for your rule and record the result in `Scope of this check`:

| Shape | Likely outcome | How to test it |
|---|---|---|
| `const m = await import("../infra/db")` with a literal | usually resolved | plant it and look |
| `await import(pathFromConfig)` with a variable | not resolvable | plant it; a green run is the expected, recordable result |
| `require(name)` where `name` is computed | not resolvable | same |
| type-only import | depends on `tsPreCompilationDeps` | plant `import type` specifically |
| path alias (`@app/infra`) | needs `tsConfig` | plant via the alias, not the relative path |
| a transitive edge (`domain → shared → infra`) | **not caught** by a direct `from`/`to` rule | plant it; if you need it caught, add a `reachable` rule and prove that one separately |
| generated code under `src/generated` | in graph unless excluded | check your `exclude` |
| a monorepo package boundary | needs the workspace root in scope | run from the root, not from a package |

The transitive case is the one people expect and do not get. `to: { path: … }` matches
direct dependencies. Reachability is a different rule type:

```js
{
  name: "no-domain-reaching-infra",
  severity: "error",
  from: { path: "^src/domain/" },
  to: { path: "^src/infra/", reachable: true },
}
```

It costs more to run and it catches the edge through `shared`. It is a separate rule,
so it needs its own planted violation.
