---
name: upgrade-impact
description: Report only the breaking changes in an upgrade that actually occur in this repository, with the compiler's own deprecation output as the evidence.
---
Report what upgrading one dependency, SDK or toolchain would break **in the repository
at $CWD**. What to upgrade, and to what — `<name> <target version>`, or a toolchain such
as `AGP 8.5`, `Xcode 16`, `targetSdk 35`, `React Native 0.75`: $ARGUMENTS

The deliverable is the intersection of two sets: what changed upstream, and what this
repository actually touches. An upstream changelog restated in your own words is not the
deliverable — the caller can read it, it lists the changes that matter to everyone, and
the reason they asked you is that they want the ones that matter here.

## 1. Pin both ends before anything else

The current version is what the **lockfile** says, not what the manifest permits. A
manifest range answers "what would resolve", the lockfile answers "what is in this
build", and only the second one can break.

```bash
grep -n -A2 "PODS:" Podfile.lock
grep -n "<pkg>" Package.resolved package-lock.json yarn.lock pubspec.lock
grep -rn "<coordinate>" gradle/libs.versions.toml */gradle.lockfile
```

Print both versions with the path:line each came from. When the target version is not
named in $ARGUMENTS, ask for it and stop; "the latest" is a moving target and the answer
would be about a version nobody chose.

## 2. Say at the top whether you read the migration guide

The first line of the report states one of:

- `Migration guide: read — <path on disk, or URL fetched this session>`, or
- `Migration guide: NOT READ — <exactly what was tried>`.

A guide on disk beats a page: `node_modules/<pkg>/CHANGELOG.md`, the `-sources.jar` in
the Gradle cache, `~/.pub-cache/hosted/pub.dev/<pkg>-<version>/CHANGELOG.md`, a pod's
own `CHANGELOG.md` under `Pods/`. When the guide was not read, every entry in the report
that would have come from it is absent rather than reconstructed, and the report says how
much that costs — "N breaking changes upstream, unknown; this report is compiler
evidence only" is an honest report, and a plausible list is not.

## 3. Prefer the compiler to any list

The compiler has read every line of this repository against the SDK on this machine.
No changelog has. When a build can be run, its warnings outrank every other source in
this report, and the real command and its real output are quoted:

```bash
./gradlew :app:compileReleaseKotlin --warning-mode all
./gradlew :app:lintRelease
xcodebuild -scheme <Scheme> -destination 'generic/platform=iOS' build 2>&1 | grep -E "deprecated|will be removed"
npx tsc --noEmit
flutter analyze
```

Run these against the **current** versions to collect deprecations the upstream project
has already announced — that is the cheapest and most reliable signal of what the next
version removes. When the target version can be resolved in a scratch checkout, run them
again against it and diff. When no build can be run at all, write
`Compiler evidence: NOT RUN — <why>`; do not describe warnings you did not see.

## 4. Tie every breaking change to an occurrence here

For each candidate change — from the guide, from the deprecation output, from the
release notes — search this repository for a real use:

```bash
grep -rn "<removed symbol>" --include=*.kt --include=*.java --include=*.swift \
     --include=*.m --include=*.ts --include=*.tsx --include=*.dart .
```

- **Occurrences found** → the change is in the report, with every path:line listed.
- **No occurrence** → the change is **dropped**, and the drop count is reported. A reader
  has to be able to tell a filtered list from a short one, and the printed pattern is
  what lets them check that the filter was not the bug.

## 5. Then the parts a grep cannot see

State these as their own section, so nobody mistakes the report's silence for safety:

- Reflection, DI graphs, string-keyed registries, `Class.forName`, `NSClassFromString`,
  Kotlin/Swift KSP or macro output, and anything generated at build time.
- Transitive dependents: run the resolver, not your memory —
  `./gradlew :app:dependencies`, `npm ls <pkg>`, `flutter pub deps`,
  `swift package show-dependencies`. Each dependent is `COMPATIBLE` **only** when a file
  read this session says so — a version range in its manifest, a constraint in its
  podspec. Otherwise it is `UNKNOWN`. There is no third state and no "should be fine".
- Floors the upgrade moves: a library raising `minSdk`, a pod raising the deployment
  target, an AGP release requiring a newer JDK, an Xcode release dropping an OS. These
  break the build without appearing in any call site, and they are read from the
  dependency's own manifest, not recalled.
- Runtime-only behaviour changes: a `targetSdk` bump changes OS behaviour for code that
  compiles unchanged, so its evidence is the platform's behaviour-changes page for that
  level, quoted, with the call sites the change applies to.

## The refusals

- **It never lists a breaking change it cannot tie to an occurrence in this repository.**
  A change with no call site here is dropped and counted, not reported "for awareness".
- **It never marks a dependent compatible from memory.** With no file that states the
  constraint, the status is `UNKNOWN — <the command that would settle it>`.
- **It never reports a compiler result it did not run.** The substitute is
  `Compiler evidence: NOT RUN — <why>`, and the section that would have used it is empty.
- **It never silently reconstructs an unread migration guide.** The top line says
  `NOT READ` and the report stands on compiler evidence alone.
- **It never proposes the migration edit.** It names the call sites and, where a source
  it actually read states the replacement, quotes that statement with its origin. Where
  no source states it, the line is `migration: not stated by any source read — author
  must supply`.

## Output

```
UPGRADE: <name> <current> → <target>
  current pinned at: <lockfile path:line>
  target named by: <caller | file>
Migration guide: read (<source>) | NOT READ (<what was tried>)
Compiler evidence: <command> → <n deprecation warnings> | NOT RUN (<why>)

BREAKS HERE (<n>)
  1. <change> — <n occurrences>
     <path:line>
     <path:line>
     migration: <quoted from <source>> | not stated by any source read — author must supply
  2. …

FLOORS MOVED (<n>)
  <minSdk | deployment target | JDK | Xcode> <old> → <new> — <path:line in the dependency>

DEPENDENTS
  <name> — COMPATIBLE (<path:line>) | UNKNOWN (<command that would settle it>)

DROPPED AS NOT OCCURRING (<n>): <symbol>, <symbol>, …
  patterns searched: <the exact greps>

NOT VISIBLE TO THIS METHOD
  <reflection / DI / generated code / cross-module callers, each with what would find it>
```
