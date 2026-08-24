---
name: api-check
description: Answer whether an API exists in the SDK you build against and whether it runs on the oldest OS you ship to, from files on this machine, never from memory.
---
Answer one question about the repository in $CWD: can this code use the API named below,
and will it run on the oldest OS this app ships to? The API, and any framing the caller
wants to add: $ARGUMENTS

Those are **two** questions and this command always answers both. "It compiles" and "it
runs on the phone your oldest user has" are different facts with different evidence, and
an answer that supplies the first while sounding like the second is how a missing
availability guard reaches the store.

## Evidence, or nothing

Every verdict below cites exactly one of two things:

- a **path:line on this machine** — an SDK interface file, a framework header,
  `api-versions.xml`, a library source in a package cache; or
- a **documentation page fetched in this session**, quoted verbatim, with its URL.

Nothing else counts. Not what you remember about when the API landed, not a plausible
version number, not the pattern the neighbouring APIs follow. A remembered availability
is a guess about a moving SDK, and a wrong "since iOS 17" is indistinguishable from a
right one until a crash report arrives.

**When neither kind of evidence is in hand, the verdict is `UNVERIFIED`, followed by the
exact lookup command that would settle it, and this command stops there.** It does not
fall back to a guess with a hedge attached: "probably iOS 17, verify before shipping" is
a guess wearing a warning label, and the label does not survive being pasted into a pull
request.

`$SKILL_DIR/lookup-map.md` is the table this playbook reads from — where a pinned version
actually lives per ecosystem, where the symbol lives on disk per platform, and which page
is authoritative. Read it before running anything; the commands in it are the ones the
`UNVERIFIED` verdict prints.

## Playbook

### 1. Detect the ecosystem from files, never from the question

```bash
ls Package.resolved Podfile.lock pubspec.lock package.json 2>/dev/null
ls gradle/libs.versions.toml gradle.lockfile */gradle.lockfile 2>/dev/null
```

A repository can be more than one of these, and usually is: a React Native, Flutter or
KMP app **is** an iOS app and an Android app. Detect all of them and answer per platform
that actually ships the symbol. Never decide the platform from the API name.

### 2. Establish the floor before looking up the symbol

Deliberately in this order. The floor is a property of this repository, it is always
readable from a file, and if you look it up second you will be tempted to skip it once
you already have a satisfying answer to the compile question.

| Platform | The floor, and where it is written |
|---|---|
| iOS / macOS app | `IPHONEOS_DEPLOYMENT_TARGET` in `*.xcodeproj/project.pbxproj` or the target's `.xcconfig` |
| Swift package | the `platforms:` array in `Package.swift` |
| CocoaPods | `platform :ios, 'N.N'` in the `Podfile` |
| Android | `minSdk` in the module's `build.gradle(.kts)`, often via `gradle/libs.versions.toml`; the merged manifest under `app/build/intermediates/` is what actually shipped |
| Flutter | both of the above — `ios/Podfile` and `android/app/build.gradle` |

When two files disagree for one platform, the app target's value is the one your users
have. A dependency declaring a *higher* floor than the app is a build problem, not a
runtime one, and it is reported as a separate line rather than folded into the answer.

**If no file states the floor, the floor is `unknown` and every runtime verdict is
`UNVERIFIED`.** Do not substitute the SDK's default, the template's default, or the
version the CI image happens to run.

### 3. Locate the symbol on disk

Per `$SKILL_DIR/lookup-map.md`. For a platform API this is the SDK inside the selected
toolchain, not the internet; for a library it is the resolved artifact in the package
cache at the version the lockfile pins — not the range the manifest allows.

Read the version out of the **lockfile**. A manifest range (`~> 5.2`, `^18.0.0`,
`[1.2, 2.0)`) is a permission, not a fact about this checkout, and answering from it is
the second most common way this question is answered wrongly.

### 4. Read the availability annotation; do not infer it

| Platform | The annotation you must actually read |
|---|---|
| Swift | `@available(iOS 17.0, *)` in the `.swiftinterface` or source |
| Objective-C | `API_AVAILABLE(ios(17.0))`, `NS_AVAILABLE_IOS(...)`, `__IPHONE_OS_VERSION_MIN_REQUIRED` guards in the header |
| Android platform | `since="N"` for that member in `$ANDROID_HOME/platforms/android-<N>/data/api-versions.xml` |
| Android source | `@RequiresApi(N)`, `@RequiresExtension(extension = …, version = …)`, `@ChecksSdkIntAtLeast` |
| Dart / Flutter | there is no availability annotation in Dart — the floor is the plugin's declared platform minimum in its `pubspec.yaml` plus whatever its native side calls, and both must be checked |

When no annotation is present, write `since: not annotated at <path:line>`. That is a
different statement from "available in every version", and only one of them is something
you read.

### 5. Answer both questions

- **Compiles** — does the SDK this project builds against declare the symbol?
  That is `compileSdk` on Android and the selected Xcode's SDK on Apple platforms, not
  the floor and not the newest SDK installed. Cite the path:line.
- **Runs on the floor** — is the introduced version at or below the floor from step 2?
  When it is not, print the guard exactly as the repository would write it:

  ```swift
  if #available(iOS 17.0, *) { … } else { … }
  ```
  ```kotlin
  if (Build.VERSION.SDK_INT >= 34) { … }
  ```

  Name what the fallback branch must supply. Do not write the fallback: choosing what
  the older OS does instead is the caller's product decision, and a plausible-looking
  else-branch invented here will be shipped as if it were considered.

One Android case that changes the answer and is readable from a file: core library
desugaring backports part of `java.time`, `java.util.stream` and friends below their
annotated API level. Check for `coreLibraryDesugaringEnabled` and the
`coreLibraryDesugaring` dependency before reporting a desugarable symbol as unavailable,
and cite the build file line either way.

## The refusals

- **It never answers from memory.** With no path:line and no page fetched this session,
  the verdict is `UNVERIFIED`, the exact lookup command is printed, and the answer ends
  there.
- **It never invents a "since version N".** An introduced version that was not read off
  an annotation or a quoted page is written `since: unknown`, with the command that
  would read it.
- **It never reports AVAILABLE alone.** Both lines are always printed. When the floor is
  unknown the second line reads `UNVERIFIED — floor unknown`, and the answer is still
  two lines, because one line is the shape that gets misread.
- **It never treats a search that found nothing as proof.** An absence is reported with
  the pattern and the root that were searched, so a reader can tell "not there" from
  "not looked for properly".

## Output

One block per platform the repository ships, and nothing before it:

```
API: <symbol as asked>
Platform: <ios | android | flutter | react-native> (detected from <file>)
Pinned: <library> <version> — <lockfile path:line>   (omit for a platform API)
Compiles: YES | NO | UNVERIFIED
  evidence: <path:line> | <URL fetched this session> | none — run: <command>
Introduced: <version> | unknown
  evidence: <path:line> | <URL fetched this session> | none — run: <command>
Floor: <value> — <path:line> | unknown
Runs on the floor: YES | NO — guard required | UNVERIFIED
Guard: <exact code, only when NO>
```

Close with a `Not established` list: every fact the answer needed and did not get, each
with the one command that would get it. If that list is empty, say so — a reader has to
be able to tell a complete answer from a truncated one.
