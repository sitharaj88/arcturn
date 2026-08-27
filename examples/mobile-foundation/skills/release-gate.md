---
name: release-gate
description: Check what a store will actually reject, from the manifests and settings in this tree — never asserting that a build is signed, compliant or ready.
---

Check what would stop `$CWD` reaching a store, reading the tree and reporting
`path:line` for each. Argument names the target — a platform, a track, or
nothing for both.

**What to check, per platform that ships:**

- **Versioning** — `versionCode`/`versionName`, `CFBundleVersion`/
  `CFBundleShortVersionString`, and whether the code has been bumped past the
  last released one. Say which file carries each and whether anything in the
  tree records the last release.
- **Target API level** — Android's store minimum rises every year, and iOS
  requires a current SDK. Report the target found with its `path:line` against
  the requirement, and where you cannot establish the current requirement from
  a file in this tree, write `UNKNOWN — check <the store's policy page>`
  rather than a number from memory. **A store requirement recalled from
  memory is the single most expensive wrong answer this command can give**,
  because it is read as a deadline.
- **Permissions** — every entry in `AndroidManifest.xml` and every
  `NS*UsageDescription` in `Info.plist`, each paired with the call site that
  needs it. A permission with no call site is a rejection risk and a privacy
  finding; a usage description that is boilerplate is a rejection.
- **Privacy declarations** — whether `PrivacyInfo.xcprivacy` and Play Data
  safety inputs exist, and whether linked analytics, ads or attribution SDKs
  contradict them. Contradiction is a blocking question, not a note.
- **Signing configuration** — that a release signing config is *declared* and
  whether its secrets come from the environment or are committed. A committed
  keystore or a hardcoded password is a blocker regardless of anything else.
- **Build hygiene** — debug flags, logging, `usesCleartextTraffic`,
  `NSAllowsArbitraryLoads`, and `applicationIdSuffix`/bundle-id mismatches
  between flavours.

**What this command will not do.** It will not say the app is compliant,
signed, or ready. It reads configuration; it does not build, sign, or submit,
and none of those are things a source read can establish. Write
`CONFIGURED` for what the tree declares and `NOT ESTABLISHED` for everything
that needs an actual build or an actual submission, and never collapse the
two.

End with the blockers ranked by whether they are caught at submission or
after release, and a `NOT ESTABLISHED` block naming the artifact that would
settle each remaining question.

Target: $ARGUMENTS
