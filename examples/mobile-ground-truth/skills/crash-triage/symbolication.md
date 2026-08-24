# Symbolication and identity, per platform

Reference data for `/crash-triage`: for each platform, the artifact that turns addresses
into names, the command that applies it, and the command that proves the artifact
belongs to the build that crashed.

This file is data. Nothing here runs at install time and nothing in this folder is
executable — these are commands for a human or an agent to run in a session, which is
what makes their output evidence.

The identity command is not optional. Symbolication does not fail loudly when the symbol
file is wrong: `atos` and `retrace` will resolve every address against the layout they
were given and hand back names that read exactly like correct ones.

---

## iOS and macOS — dSYM

**The artifact.** `MyApp.app.dSYM`, produced by the build that shipped, matched per
architecture by UUID. Reports from iOS 15 and later are `.ips` files — a JSON header
line followed by a JSON body carrying `usedImages` (each with `base`, `uuid`, `name`)
and per-frame `imageIndex` + `imageOffset`. Older `.crash` files carry the same facts
under `Binary Images:`.

```bash
# 1. The identity the report demands, for the crashing image
grep -A20 "Binary Images:" MyApp.crash              # .crash, iOS 14 and earlier
tail -n +2 MyApp.ips | jq '.usedImages[] | {name, uuid, base}'   # .ips: line 1 is the header

# 2. The identity of the dSYM you are about to use
dwarfdump --uuid MyApp.app.dSYM/Contents/Resources/DWARF/MyApp

# 3. Find the right dSYM by UUID instead of by folder name
mdfind "com_apple_xcode_dsym_uuids == <UUID-UPPERCASE-DASHED>"

# 4. Resolve one frame: -l is the image's load address, the last argument is the
#    absolute address (base + imageOffset for a .ips frame)
atos -o MyApp.app.dSYM/Contents/Resources/DWARF/MyApp -arch arm64 \
     -l 0x1024f4000 0x1025a31c8
```

Notes a senior would already know and a report will not tell you:

- The UUID is **per architecture**. A dSYM containing arm64 and arm64e has two, and only
  the one matching the report's image is evidence.
- System frames resolve only against the OS symbols for that exact build, cached under
  `~/Library/Developer/Xcode/iOS DeviceSupport/<version> (<build>)/Symbols`. Without
  them, your frames symbolicate and Apple's do not — which is a partial trace, not a
  failed one, and should be labelled as such.
- `symbolicatecrash` still exists inside Xcode and its path moves between releases
  (`find /Applications/Xcode.app -name symbolicatecrash`); it needs `DEVELOPER_DIR`
  exported. `atos` per frame is the version that tells you when it failed.
- If the build was uploaded with bitcode (Xcode 13 and earlier), the binary Apple
  distributed is not the binary you built: the local dSYM is the wrong artifact and the
  matching one comes from the Xcode Organizer or App Store Connect.

---

## Android, JVM side — R8 `mapping.txt`

**The artifact.** The `mapping.txt` archived for **that exact `versionCode`**, at
`app/build/outputs/mapping/<variant>/mapping.txt` in the build that produced the
release.

```bash
# Retrace, from the SDK command-line tools
$ANDROID_HOME/cmdline-tools/latest/bin/retrace mapping.txt stacktrace.txt

# or straight from R8
java -cp r8.jar com.android.tools.r8.retrace.Retrace mapping.txt stacktrace.txt

# The map's own identity header
head -8 mapping.txt
# compiler: R8
# compiler_version: <x.y.z>
# min_api: <n>
# pg_map_id: <short hash>
# pg_map_hash: SHA-256 <hash>
```

The identity rule for this platform, stated plainly because it is the one people get
wrong: **a rebuilt `mapping.txt` is not the shipped one.** R8's renaming is a function of
the whole program, its version, and every dependency version; a rebuild after any of
those moved produces a map that retraces the same trace into different, plausible names.
The evidence is the archived artifact for that `versionCode` — from the CI run, the
release bundle's `BUNDLE-METADATA`, or the copy uploaded to the console — never a fresh
`assembleRelease`.

When the trace's `SourceFile` values carry a map id (R8 can stamp `pg_map_id` there), it
must equal the `# pg_map_id` line of the map you used. Retrace itself does not refuse a
mismatch; it is your check, not the tool's.

---

## Android, native side — unstripped `.so` plus Build ID

**The artifact.** The unstripped shared objects from that build, under
`app/build/intermediates/merged_native_libs/<variant>/**/lib/<abi>/` (the exact path
moves between AGP versions — locate it rather than typing it from memory).

```bash
# Whole tombstone or logcat dump
ndk-stack -sym app/build/intermediates/merged_native_libs/release/out/lib/arm64-v8a \
          -dump tombstone_00

# One address
$ANDROID_NDK/toolchains/llvm/prebuilt/<host>/bin/llvm-symbolizer \
    --obj=libnative.so 0x000000000004a1c8

# Identity: the tombstone prints a Build ID per mapped library
grep -i "build id" tombstone_00
readelf -n libnative.so | grep -A2 "Build ID"
```

A stripped `.so` with a matching Build ID is still the wrong artifact for
symbolication — matching identity proves *which* library, not that symbols are present.
Report `IDENTITY-PROVEN, SYMBOLS-ABSENT` rather than treating the match as sufficient.

---

## React Native — Hermes source maps

**The artifact.** The source map emitted by the same release build as the shipped
bundle. Android: `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`.
iOS: the `main.jsbundle.map` written when the bundle build phase sets `SOURCEMAP_FILE`.

```bash
# Symbolicate a JS stack (reads the stack on stdin)
npx metro-symbolicate index.android.bundle.map < stacktrace.txt

# Hermes bytecode frames need the composed map: the Metro map composed with the
# .hbc map hermesc emits under -output-source-map
node node_modules/react-native/scripts/compose-source-maps.js \
     index.android.bundle.map index.android.bundle.hbc.map \
     -o index.android.bundle.composed.map

# Identity: hash the bundle that actually shipped against the one the map was built with
unzip -p app-release.apk assets/index.android.bundle | shasum -a 256
unzip -p MyApp.ipa 'Payload/*/main.jsbundle' | shasum -a 256
```

Two facts that decide whether this path applies at all:

- A **native** crash in a React Native app (a `SIGSEGV`, an ANR, an OOM) is an Android or
  iOS crash and takes the corresponding section above. The JS map contributes nothing,
  and reaching for it is how a native memory bug gets triaged as a JS bug.
- If the release build did not emit a map, there is no artifact to match. The trace is
  not diagnosable and the remedy is a build-configuration change for the next release,
  not a closer reading of this one.

---

## Flutter — `--split-debug-info` symbols

**The artifact.** The `.symbols` file for that ABI, produced by the shipping build with
`--split-debug-info=<dir>` (and required, not optional, when `--obfuscate` was used).

```bash
flutter symbolize -i crash.txt -d out/android/app.android-arm64.symbols

# Identity: the crash header carries the build id the symbols must match
grep -E "build_id|os:|arch:" crash.txt
```

- `flutter symbolize` resolves against the symbols you hand it; a `build_id` that does
  not match is `IDENTITY-UNPROVEN`, and reading Dart source at `HEAD` instead is exactly
  the substitution this command refuses.
- An uncaught **Dart** exception with a readable stack is already symbolic unless the
  build was obfuscated — check before assuming work is needed.
- A crash inside `libflutter.so` is an **engine** crash: it takes the Android native
  path, and the symbols are the engine's own for the engine revision that shipped
  (`flutter --version` prints it). Your app's `.symbols` file will not resolve it.

---

## When the artifact was never archived

There is no recovery path here, and it is worth saying rather than working around: if
the dSYM, the `mapping.txt`, the source map or the `.symbols` file for a shipped build
was not kept, that build's crashes are not diagnosable from the trace. The finding is a
build-pipeline finding — archive symbols per build, keyed by version — and the honest
triage output is `UNSYMBOLICATED — artifact not retained`, with no hypothesis attached.
