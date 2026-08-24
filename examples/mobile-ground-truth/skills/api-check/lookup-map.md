# Lookup map

Reference data for `/api-check`. Three tables and a command set: where a version is
really pinned, where a symbol really lives on this machine, and which page is
authoritative when nothing on disk answers.

This file is data. Nothing here runs at install time and nothing in this folder is
executable — the commands are printed for a human or an agent to run in a session,
which is what makes them evidence.

**Every command below reads.** None of them resolves, updates or regenerates a lockfile.
A lookup that rewrites `Podfile.lock` or `pubspec.lock` has changed the thing you were
asking about, and the answer you get back is about a checkout that did not exist when
you asked the question.

---

## 1. Where the pinned version lives

The lockfile is the pin of record. The manifest states a range, and a range is a
permission rather than a fact about this checkout.

| Ecosystem | Pin of record | Range, not a pin | What the pin identifies |
|---|---|---|---|
| Swift Package Manager | `Package.resolved` (in `.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/` for an app project) | `Package.swift` `.package(url:from:)` | exact version + revision SHA per package |
| CocoaPods | `Podfile.lock` | `Podfile`, `*.podspec` | resolved pod versions, plus a checksum per podspec |
| Gradle version catalog | `gradle/libs.versions.toml` | a `+` or range in a `build.gradle(.kts)` | the coordinate a module resolves through |
| Gradle dependency locking | `gradle.lockfile`, `<module>/gradle.lockfile` | anything unlocked | the fully resolved graph per configuration |
| npm / Yarn / pnpm (React Native) | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` | `package.json` `dependencies` | exact versions + integrity hashes |
| Dart / Flutter | `pubspec.lock` | `pubspec.yaml` | exact versions of direct and transitive packages |
| Android Gradle Plugin / Gradle | `gradle/wrapper/gradle-wrapper.properties`, the AGP entry in the catalog | anything else | the toolchain the build actually uses |
| Xcode / Swift toolchain | `xcode-select -p` plus the build log's `Xcode <version> Build version <n>` | a README | the SDK you compiled against |

A React Native or Flutter repository has **three or more** of these at once, and they
answer different questions. The JS lockfile does not tell you the Android floor.

---

## 2. Where the symbol lives on disk

| Platform | Root | What to open |
|---|---|---|
| iOS / macOS system framework (Swift) | `$(xcrun --show-sdk-path --sdk iphoneos)` | `System/Library/Frameworks/<F>.framework/Modules/<F>.swiftmodule/*.swiftinterface` |
| iOS / macOS system framework (Objective-C) | same SDK root | `System/Library/Frameworks/<F>.framework/Headers/*.h` |
| Android platform API | `$ANDROID_HOME/platforms/android-<compileSdk>/` | `data/api-versions.xml` for `since=`, `android.jar` for existence |
| Android AndroidX / library source | `~/.gradle/caches/modules-2/files-2.1/<group>/<artifact>/<version>/` | the `-sources.jar`, or the AAR's `classes.jar` |
| Swift package source | `<DerivedData>/<Project>-*/SourcePackages/checkouts/<pkg>/` | `Sources/**` |
| CocoaPods source | `Pods/<Pod>/` in the repository | the pod's headers and sources as vendored |
| React Native package | `node_modules/<pkg>/` | `lib/`, `src/`, and the `*.d.ts` for the TypeScript surface |
| React Native native module | `node_modules/<pkg>/android/src/main/java/**`, `node_modules/<pkg>/ios/**` | the native side, which has its own floor |
| Dart / Flutter package | `~/.pub-cache/hosted/pub.dev/<pkg>-<version>/` | `lib/**`, and `pubspec.yaml` for the platform minimums |

`$ANDROID_HOME/platforms/android-<N>/data/api-versions.xml` is the strongest oracle in
this table: it carries a `since` attribute for classes, methods and fields, on this
machine, for the exact platform you compile against. Prefer it over any web page.

---

## 3. Where the floor is written

| Target | File | Key |
|---|---|---|
| iOS app target | `*.xcodeproj/project.pbxproj` or the target `.xcconfig` | `IPHONEOS_DEPLOYMENT_TARGET` |
| Swift package | `Package.swift` | `platforms: [.iOS(…)]` |
| CocoaPods | `Podfile` | `platform :ios, 'N.N'` |
| Android module | `app/build.gradle(.kts)` (values often via `gradle/libs.versions.toml`) | `minSdk`, `targetSdk`, `compileSdk` |
| Android, as actually merged | `app/build/intermediates/merged_manifest/<variant>/AndroidManifest.xml` | `<uses-sdk android:minSdkVersion>` |
| Flutter (iOS half) | `ios/Podfile`, `ios/Flutter/AppFrameworkInfo.plist` | `platform :ios`, `MinimumOSVersion` |
| Flutter (Android half) | `android/app/build.gradle` | `minSdk` |
| Android desugaring | `app/build.gradle(.kts)` | `coreLibraryDesugaringEnabled`, `coreLibraryDesugaring` |

---

## 4. Read-only lookup commands

Apple platforms:

```bash
xcodebuild -showBuildSettings -scheme <Scheme> | grep -E 'IPHONEOS_DEPLOYMENT_TARGET|SDKROOT'
grep -rn "IPHONEOS_DEPLOYMENT_TARGET" *.xcodeproj/project.pbxproj Config/*.xcconfig
SDK=$(xcrun --show-sdk-path --sdk iphoneos)
grep -rn "func <symbol>" "$SDK/System/Library/Frameworks/<F>.framework/Modules"
grep -rn -B3 "<symbol>" "$SDK/System/Library/Frameworks/<F>.framework/Headers"
grep -n "<package>" *.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
grep -n -A2 "PODS:" Podfile.lock
```

Android:

```bash
grep -rn "minSdk\|compileSdk\|targetSdk" app/build.gradle.kts gradle/libs.versions.toml
grep -n "<Class>\|<method>" "$ANDROID_HOME/platforms/android-34/data/api-versions.xml"
unzip -l "$ANDROID_HOME/platforms/android-34/android.jar" | grep "<Class>"
grep -rn "@RequiresApi\|@RequiresExtension" ~/.gradle/caches/modules-2/files-2.1/<group>
./gradlew :app:dependencies --configuration releaseRuntimeClasspath
```

React Native:

```bash
node -e "console.log(require('./node_modules/<pkg>/package.json').version)"
grep -n "\"<pkg>\"" package-lock.json
grep -rn "<symbol>" node_modules/<pkg>/lib node_modules/<pkg>/src
grep -rn "minSdkVersion\|compileSdkVersion" android/build.gradle android/app/build.gradle
```

Flutter:

```bash
grep -n -A2 "name: <pkg>" pubspec.lock
grep -rn "<symbol>" ~/.pub-cache/hosted/pub.dev/<pkg>-<version>/lib
grep -rn "minSdk" android/app/build.gradle
grep -rn "platform :ios\|MinimumOSVersion" ios/Podfile ios/Flutter/AppFrameworkInfo.plist
```

---

## 5. Authoritative documentation, per platform

A page counts as evidence only when it was **fetched in this session** and the sentence
that carries the version is quoted verbatim with its URL. A remembered page is memory
with a citation attached, which is worse than memory without one.

| Platform | Authoritative for | Where |
|---|---|---|
| Apple | availability, required-reason APIs, deprecations | `developer.apple.com/documentation` — the Availability block on the symbol's own page |
| Apple | what changed in an SDK | the release notes for that Xcode / OS version |
| Android | `since` API level, behaviour changes | `developer.android.com/reference` for the symbol; the behaviour-changes page for that API level |
| Android | SDK extensions | the `SdkExtensions` reference plus the extension's own page |
| AndroidX | library-level minSdk and deprecations | `developer.android.com/jetpack/androidx/releases/<artifact>` |
| React Native | version-to-version API surface | the upgrade helper diff and the release notes for the exact versions |
| Flutter / Dart | package API and platform minimums | `pub.dev/documentation/<pkg>/<version>` and the package's own `pubspec.yaml` |

When the on-disk answer and a fetched page disagree, report both and prefer the disk:
the SDK on this machine is what the compiler will read, and the page may describe a
version this project does not have.
