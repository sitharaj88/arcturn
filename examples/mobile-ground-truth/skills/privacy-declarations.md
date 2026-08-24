---
name: privacy-declarations
description: Draft the privacy-manifest and data-safety inputs a store asks for from what the code evidences, marking everything unevidenced as undeclarable.
---
Draft the data-collection inputs the app stores ask for — Apple's `PrivacyInfo.xcprivacy`
and nutrition-label answers, Google Play's Data safety form — for the repository at
$CWD, from evidence in this repository. The scope, target, or specific question:
$ARGUMENTS

Every line of the draft is one of three things and is labelled as such: **evidenced** by
a call site or a linked SDK's own manifest, **contradicted** by something else in the
tree, or **not evidenced** and therefore not declarable here. There is no fourth
category, and in particular there is no "presumably not collected".

## 1. Enumerate what actually links, before reading any code

A declaration is about the shipped app, and most of what a shipped app collects is
collected by code nobody in this repository wrote.

```bash
# iOS: what is really linked
grep -n -A3 "PODS:" Podfile.lock
grep -n "package\|revision" Package.resolved
ls -d Pods/* 2>/dev/null; ls -d *.xcframework **/*.xcframework 2>/dev/null

# Android: the resolved runtime classpath, not the declarations in one build file
./gradlew :app:dependencies --configuration releaseRuntimeClasspath
grep -rn "uses-permission" app/src/main/AndroidManifest.xml
# what the manifest merger actually produced, including library-injected entries
grep -rn "uses-permission\|<meta-data" app/build/intermediates/merged_manifest/release/AndroidManifest.xml

# React Native / Flutter: both native halves plus the JS or Dart dependency set
grep -n "\"dependencies\"" -A40 package.json
grep -n -A2 "^  [a-z_]*:" pubspec.lock
```

## 2. Read each third-party SDK's own declaration off disk

An SDK that ships an Apple privacy manifest carries it inside the bundle:

```bash
find . -name "PrivacyInfo.xcprivacy" -not -path "./build/*"
```

Quote what each one declares — `NSPrivacyCollectedDataTypes`,
`NSPrivacyTracking`, `NSPrivacyAccessedAPITypes` — with the path it came from. That is
evidence about the SDK. It is **not** evidence about your app's own collection, and the
two are never merged into one unlabelled list.

An SDK that ships **no** manifest and has no call site in your code is not thereby
silent. Its entry is `UNKNOWN — vendor documentation required`, naming the file that
links it. "I could not find what it collects" and "it collects nothing" are the two
answers this command is built to keep apart.

## 3. Find first-party collection at call sites

Search for the things that actually move data or read a restricted API, and print the
patterns you used:

```bash
grep -rn "identifierForVendor\|ASIdentifierManager\|AdvertisingIdClient\|getAdvertisingIdInfo\|AppSetId" --include=*.swift --include=*.m --include=*.kt --include=*.java .
grep -rn "logEvent\|setUserProperty\|setUserId\|track(\|identify(" --include=*.swift --include=*.kt --include=*.ts --include=*.dart .
grep -rn "CLLocationManager\|FusedLocationProvider\|requestWhenInUseAuthorization" --include=*.swift --include=*.kt .
grep -rn "CNContactStore\|PHPhotoLibrary\|HKHealthStore\|READ_CONTACTS\|ACCESS_FINE_LOCATION" .
grep -rn "ATTrackingManager\|requestTrackingAuthorization" --include=*.swift .
```

For Apple's required-reason API categories, the categories themselves are readable from
call sites — file-timestamp APIs, system boot time, disk space, active keyboards,
`UserDefaults`. **The reason code is not.** A code such as the one for "access info from
the app itself" is copied from Apple's documented list of allowed reasons, fetched this
session, or it is written `reason code: unknown — fetch the current list`. A code you
recall is a code you invented, and an invented reason code is a false statement in a
file a store parses.

## 4. Sort every candidate, and keep the bins visible

| Bin | Means | Written as |
|---|---|---|
| `EVIDENCED` | a call site or a quoted SDK manifest supports it | the data type, plus path:line |
| `CONTRADICTION` | two facts in this tree disagree | both facts, plus the blocking question |
| `NOT EVIDENCED` | nothing found | `do not declare from this repository`, plus the patterns searched |

The contradiction that matters most, and the reason this command exists: **an analytics
or advertising SDK on the link list, and a draft that would answer "no data collected".**
That is not a judgment call to be resolved by picking the more likely side. It is written
as `CONTRADICTION`, names the SDK and the file that links it, names who must answer
(the SDK's owner in your team, or its vendor documentation), and is left open.

`NSPrivacyTracking` follows the same rule in the other direction. `YES` needs evidence —
an ATT prompt, an ad SDK, an identifier read joined to third-party data. Failing to find
that evidence produces `UNKNOWN`, never `NO`.

## The refusals

- **It never declares a data type the code does not evidence.** The substitute is
  `NOT EVIDENCED — do not declare from this repository`, in the same column a declaration
  would occupy, with the patterns that were searched printed beside it.
- **It never writes "no data collected" while a linked analytics or advertising SDK
  contradicts it.** The substitute is a `CONTRADICTION` block naming the SDK, the file,
  and who must answer. It does not resolve the contradiction in either direction.
- **It never writes a required-reason code from memory.** The substitute is
  `reason code: unknown — fetch the current list`.
- **It never treats a grep that found nothing as proof of absence.** An absence ships
  with its patterns and its roots, and a search that could not cover generated or
  obfuscated code says so.
- **It never states the app is compliant.** Compliance is a legal conclusion about facts
  outside this repository — what your servers do with what arrives, what your contracts
  and your vendors' contracts say, which jurisdictions your users are in, and what the
  store's current policy text requires. This command reads code.

## Output

```
DRAFT: privacy declarations for <app / target>
Scanned: <what was enumerated — lockfiles, merged manifest, SDK manifests>, at <paths>

EVIDENCED (<n>)
  <data type> — <linked | collected by us> — <path:line> | <SDK manifest path, quoted>
  purpose: <only if a call site or the SDK manifest states it> | not evidenced

CONTRADICTIONS (<n>) — blocking, unresolved
  <what disagrees> — <fact A at path:line> vs <fact B at path:line>
  question for: <owner or vendor>

NOT EVIDENCED — do not declare from this repository (<n>)
  <candidate data type> — searched: <patterns> in <roots>

REQUIRED-REASON APIs (<n>)
  <category> — <path:line> — reason code: <copied from the list fetched this session>
                              | unknown — fetch the current list

TRACKING: YES (<evidence>) | UNKNOWN (<what was searched>)

NOT VISIBLE TO THIS METHOD
  <closed-source SDK behaviour, server-side joins, generated code, anything a grep of
   this repository cannot reach>
```

The last line of every output is this one, verbatim:

> This is a draft of what this repository evidences. Whether it is a correct or complete
> declaration is a legal question about facts outside this repository, and this command
> does not answer it.
