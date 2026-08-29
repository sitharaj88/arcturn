---
name: arch-map
description: Map a codebase from resolved imports at file:line — no node and no edge without ledger evidence, and every unresolvable wiring listed rather than drawn.
---
Map the module structure of the repository in $CWD from what its imports actually
resolve to. The scope — a directory, a module, a package, or empty for the whole tree —
and any framing the caller wants to add: $ARGUMENTS

With no argument, map the repository root. With a path that does not exist, say which
and stop.

Every diagram of a system is read as a statement about how the system works, and almost
every diagram is a statement about how somebody remembers it working. The difference
between the two is an import statement you can open. This command produces the first
kind, and it is deliberately worse-looking than the second: real import graphs have
edges nobody wants and gaps nobody can close, and both are in the output.

## The ledger rule

**A node or an edge reaches the diagram only if the ledger backs it with a resolved
import at `path:line`.** The ledger is built first and the picture is drawn from it.
Nothing is added to the picture afterwards because the shape looked incomplete.

An edge is one row:

| From (node) | To (node) | Statement, verbatim | Site | Resolves to |
|---|---|---|---|---|
| `src/domain` | `src/infra` | `import { Pool } from "../infra/db";` | `src/domain/order.ts:4` | `src/infra/db.ts` |

Three columns are the evidence: the statement as written, the site you read it at, and
the file on disk the specifier resolved to. An import whose specifier you could not
resolve to a file or to a declared package **is not an edge**. It goes to section 4.

## 1. Establish the commit and the roots

```bash
git rev-parse --short HEAD
git status --porcelain | head
```

Print both. A map of a dirty tree is a map of something that is not in the history, and
the reader has to know which they are holding.

Then list what you will scan and what you will not:

```bash
find . -name node_modules -prune -o -name .git -prune -o -type d -print | head -60
```

Exclusions are part of the result, not housekeeping. Vendored directories, generated
output, build artefacts, test fixtures and third-party trees are each named in the recall
bound with the reason they were skipped. A map that quietly omits `generated/` reports a
tree with no dependency on its own schema.

## 2. Define the module boundary from something the tree names

The nodes are whatever the repository itself already declares as a unit:

| Signal | The node it defines |
|---|---|
| a package manifest — `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`, `composer.json`, `build.gradle(.kts)`, `Package.swift` | one module per manifest |
| a workspace member list — pnpm/yarn/npm workspaces, Cargo workspace, Gradle `settings.gradle` | one module per member |
| a source-set root the build declares — `src/main/java`, `internal/`, `lib/` | the directories directly under it |
| nothing declares anything | the top two directory levels under each source root, named verbatim |

**A layer name is not a node unless the tree writes it.** `src/domain` is a node because
that directory exists. "The domain layer", "the service tier" and "the anti-corruption
layer" are vocabulary from somewhere else, and using them turns a map of directories
into a map of an architecture the reader will assume was enforced. Where the repository
does name layers — a Deptrac config, an ArchUnit test, an import-linter contract, a
`dependency-cruiser` ruleset — cite that file and use its names, which is a different
and much stronger statement.

State the boundary rule you used in one line, with the file that justified it.

## 3. Resolve, per ecosystem

Resolution is the whole difference between this map and a plausible one. Each ecosystem
resolves differently and each fails differently:

| Ecosystem | Statement | Resolved when |
|---|---|---|
| TypeScript / JavaScript | `import … from "x"`, `require("x")`, `export … from "x"` | a relative specifier lands on a file after extension and `index` resolution, or a `tsconfig` path alias maps it; a bare specifier appears in the manifest's dependencies **and** resolves to a workspace member or an installed package |
| Python | `import a.b`, `from a.b import c` | `a/b.py` or `a/b/__init__.py` exists under a root you listed; a relative `from .b import c` resolves against the containing package |
| Java / Kotlin | `import a.b.C` | a source file declaring `package a.b` and type `C` exists in a source set you scanned; otherwise it is an external dependency, resolved against the build file's coordinates |
| Go | a path in the import block | the path is inside this `go.mod`'s module, or is a required module in `go.mod` |
| Rust | `use crate::a::b`, `mod a;` | the module file or directory exists; `use other_crate::…` resolves against `Cargo.toml` |
| C# | `using N;` | weak — a namespace is not a file. Resolve project-to-project edges from `<ProjectReference>` in the `.csproj` and say that file-level edges within a project are not visible |
| PHP | `use A\B;` | the PSR-4 autoload map in `composer.json` maps the prefix to a directory and the file exists |
| Swift | `import Module` | a target with that name exists in `Package.swift` or the project file. **There are no file-level imports in Swift**, so edges inside a module are invisible to this method — say so in the recall bound rather than inferring them |

Two rules that hold everywhere:

- **Read the specifier, do not pattern-match the name.** `import { x } from "@app/core"`
  is an edge to whatever the alias or the workspace resolves `@app/core` to, which is
  sometimes not the directory called `core`.
- **Type-only imports are edges** in the source graph and often are not in the compiled
  graph. Whichever you count, say which, and count it the same way everywhere.

## 4. Edges you could not resolve statically

This section is the honest half of the output, and it is written before the diagram, not
after it. Anything that wires two modules together at runtime through a mechanism a
reader of the source cannot follow lands here — with its site, and with the endpoint
named when it can be named at all.

Patterns worth searching for explicitly, by mechanism:

```bash
grep -rn "import(\|require(\s*[a-zA-Z_$]" --include='*.ts' --include='*.js' .
grep -rn "importlib.import_module\|__import__\|getattr(" --include='*.py' .
grep -rn "Class.forName\|ServiceLoader.load\|@Component\|@Autowired\|@Bean\|@Provides\|@Module" --include='*.java' --include='*.kt' .
grep -rn "reflect\.\|plugin\.Open" --include='*.go' .
grep -rn "services.Add\|GetService\|Activator.CreateInstance" --include='*.cs' .
grep -rln "META-INF/services\|entry_points\|\[project.entry-points\]" .
```

| Mechanism | What it hides | How it is recorded |
|---|---|---|
| dynamic import / `require` on a variable | the target, often chosen from config | `unresolved` — site, and the variable's origin if you traced it |
| dependency injection containers | the whole wiring graph | `unverified` — the binding site (`@Bean`, `@Provides`, `services.AddScoped`), and the interface being bound |
| reflection, `Class.forName`, service loaders | the implementation chosen at runtime | `unverified` — the loader site and the service interface |
| string-keyed registries, plugin directories, command tables | every registered participant | `unverified` — the registry's definition site and the registration sites you found |
| config-driven wiring (a YAML naming a class path) | the edge entirely | `unresolved` — the config file and the key |
| code generation, annotation processors, `go:generate` | the generated module's edges | `unresolved` — the generator's declaration, and whether the output was in scope |
| HTTP, gRPC, queue and event calls between modules | that this is a dependency at all | **not an edge in this map.** It is a network call between processes. Record it under section 6 and say what it would take to establish it |

Dashed and labelled `unverified` means: the reader is told there is wiring here and told
that it was not followed. Absent means you could not even name an endpoint, and the site
is still listed. Both beat a solid line drawn on the strength of a decorator's name.

## 5. Cycles

Report each cycle as its full hop path with one `path:line` per hop:

```
CYCLE (3): src/order → src/billing (src/order/pay.ts:9)
         → src/notify  (src/billing/charge.ts:22)
         → src/order   (src/notify/send.ts:14)
```

**You will not report a cycle you did not trace.** A cycle inferred from two edges
pointing the same way, or from a tool's summary count you did not expand, is not
reported — it becomes a line in the recall bound saying the cycle detection was not run
to completion and the command that would run it.

## 6. Runtime and deployment topology: not from source

**The second refusal.** You do not draw a runtime or deployment topology from source
alone — no processes, no replicas, no load balancers, no queues between boxes, no
regions, no "the API gateway sits in front". Source tells you what compiles together. It
does not tell you what runs where, how many of it there are, or what talks to what over
a network at three in the morning.

Write instead:

```
Runtime topology: NOT DERIVABLE FROM SOURCE
  What would show it: <the artefacts, each checked for and each reported present or absent>
```

Check for the artefacts and report what you found, clearly separated from the map:

```bash
ls docker-compose*.y*ml Dockerfile* Procfile 2>/dev/null
find . -path ./node_modules -prune -o \( -name '*.tf' -o -name 'k8s' -o -name 'helm' -o -name 'serverless.y*ml' \) -print 2>/dev/null | head -20
ls .github/workflows .gitlab-ci.yml 2>/dev/null
```

Anything you find is reported as **declared intent**, with its `path:line`, under the
heading `Declared deployment (not observed)`. A Kubernetes manifest states what somebody
asked for. What is running is a fact about a cluster, and this command cannot reach one.

## 7. State the recall bound

The map ends with the number that tells a reader how much of the graph it saw:

```
Recall bound
  Tree @ <sha> (clean | dirty)
  Files scanned: <N>   globs: <the ones you used>
  Excluded: <dir> (<reason>), <dir> (<reason>)
  Import statements found: <M>
  Resolved to a node in this map: <R>
  Resolved to an external dependency: <E>
  Unresolved: <U> — every one listed in section 4
  Invisible to this method: <mechanism> (<count>, e.g. src/app/wire.ts:31), <mechanism> (<count>)
  Not attempted: <what you did not try to resolve, and why>
```

`R / M` is the number. Print it as a fraction of statements, never as a percentage of
"the architecture", which is not a measurable denominator. When the fraction is below
what a reader should trust — a DI-heavy Spring or .NET tree routinely lands there — say
so in one sentence rather than leaving it to be worked out from the arithmetic.

## The refusals

- **No node and no edge without a ledger row.** A module you believe exists but never
  saw imported goes under `Nodes with no resolved edge`, not into the diagram.
- **No line for wiring you could not follow.** Dynamic imports, DI, reflection and
  string-keyed registries go to `Edges I could not resolve statically`, dashed and
  labelled `unverified`, or absent with their site listed.
- **No runtime or deployment topology from source.** The substitute is
  `Runtime topology: NOT DERIVABLE FROM SOURCE` plus what would show it, and any infra
  files found are `Declared deployment (not observed)`.
- **No layer name the tree does not write.** Directory names verbatim, or the names in
  the repository's own architecture-rule file with that file cited.
- **No cycle that was not traced hop by hop**, and no completeness claim: the recall
  bound is printed whether or not anybody asked for it.

## Output

```
ARCH MAP — <scope> · tree @ <sha> (clean | dirty)
Boundary rule: <what defines a node here> — <the file that justified it>
Nodes: <N>   Edges (resolved): <R>   Unresolved sites: <U>
```

**Nodes**

| Node | Defined by | Files | Fan-in | Fan-out |
|---|---|---|---|---|

**Diagram** — a mermaid `flowchart`, solid for resolved edges, dashed for the ones you
could name but not resolve:

```
flowchart LR
  domain["src/domain"]
  infra["src/infra"]
  domain --> infra
  app -.->|unverified: DI| infra
```

Only nodes and edges the ledger backs. Nothing else.

**Edge ledger** — one row per module-to-module edge, with a representative site and the
count of statements behind it:

| From | To | Statements | Representative site | Resolves to |
|---|---|---|---|---|
| `src/domain` | `src/infra` | 7 | `src/domain/order.ts:4` | `src/infra/db.ts` |

When the full statement-level ledger is too large to print, print the module-level table
and the exact command that regenerates the full one, so the summary is reproducible
rather than a summary the reader has to take on faith.

**Edges I could not resolve statically** — mechanism, site, endpoint if nameable.

**Nodes with no resolved edge** — with the search that found nothing.

**Cycles** — full hop paths, or `none found by the traversal described above`.

**Runtime topology** — the refusal block, and `Declared deployment (not observed)` when
infra files exist.

**Recall bound** — as specified in section 7.

## Where it goes

**The map is a file, not a chat message.** Write it to `docs/design/arch-map.md` —
create `docs/design/` if it does not exist — and overwrite the previous one: a map is a
reading of the tree as it stands, git history keeps the old readings, and two maps of
different commits side by side answer no question either answers alone. In the chat,
print only the path and the recall bound; `/hld-draft` and `/workflow design-review`
consume the file, not the scrollback.
