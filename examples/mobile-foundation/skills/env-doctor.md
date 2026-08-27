---
name: env-doctor
description: Report whether this machine can build this repository, from real commands with real exit codes, comparing what is installed against what the repo pins.
---

Answer one question about `$CWD`: can this machine build this repository right
now, and if not, exactly what is missing.

**Detect first, and cite the file.** Establish which platforms ship before
running anything — `pubspec.yaml`, `package.json` with `react-native`,
`build.gradle[.kts]`, `*.xcodeproj` — and say which file proved each. A
Flutter, React Native or KMP repository is an Android repository *and* an iOS
repository; check both halves.

**Then run the doctors, and paste them.** For each platform detected:
`flutter doctor -v`, `npx react-native doctor`, `./gradlew --version`,
`java -version`, `xcodebuild -version`, `pod --version`, `node --version`.
Every version claim carries the command and its real exit code. "Flutter
appears to be installed" is not evidence and must not appear.

**Compare against the pin, never against the newest.** Read the pins the
repository actually declares — `gradle/libs.versions.toml`,
`gradle-wrapper.properties`, `.tool-versions`, `.nvmrc`, `.ruby-version`,
`Gemfile.lock`, `.xcode-version` — and report each as
`PINNED <x> / INSTALLED <y>` naming the file that carries the pin. A machine
running a newer Gradle than the wrapper pins is a mismatch, not an upgrade,
and it is why a build passes in CI and fails here.

**Change nothing.** Do not install, do not edit a config to make a check pass,
do not run a full build. The finding is the product; a mismatch you quietly
repaired is one the reader meets again on the next machine.

Report every missing tool as `MISSING <tool> — <install command>` and keep
going to the end of the list rather than stopping at the first blocker.

End with `BUILDABLE: yes | no | unproven` and one line of reason. `unproven`
is the honest verdict whenever a doctor could not run, and the absence of an
error never upgrades it to `yes`.

Scope: $ARGUMENTS
