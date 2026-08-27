# Per-stack accessibility checks

Reference for `/a11y-sweep`. Detect the stack from the files named under each
heading, then run that stack's checks. A Flutter, React Native or KMP
repository is an Android repository **and** an iOS repository — run both
native sections.

## Thresholds

| Property | Android | iOS | Source |
|---|---|---|---|
| Minimum touch target | 48dp × 48dp | 44pt × 44pt | Material / Apple HIG |
| Text scaling to support | up to 200% | up to the largest Dynamic Type size | Both platform guidelines |
| Text contrast (normal) | 4.5:1 | 4.5:1 | WCAG 2.2 AA |
| Text contrast (large ≥18pt) | 3:1 | 3:1 | WCAG 2.2 AA |
| Non-text contrast | 3:1 | 3:1 | WCAG 2.2 AA |

Contrast is listed for reference only. It is a property of rendered pixels
across themes and states; a source read cannot decide it, and this command
does not claim to.

## Flutter — `pubspec.yaml`

The dynamic audit, which runs in CI with no device and which almost no
repository has:

```dart
testWidgets('meets accessibility guidelines', (tester) async {
  final handle = tester.ensureSemantics();
  await tester.pumpWidget(const MyApp());
  await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
  await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
  await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  await expectLater(tester, meetsGuideline(textContrastGuideline));
  handle.dispose();
});
```

Run: `flutter test`. If no test calls `meetsGuideline`, report
`NO DYNAMIC AUDIT` and print the block above as the fix.

Static sweep:

- `GestureDetector`, `InkWell`, `IconButton` with no enclosing `Semantics`
  and no `semanticLabel`
- `Image(` and `Icon(` with no `semanticLabel`
- `TextStyle(fontSize:` with a literal, outside a theme — defeats text scaling
- `MediaQuery.of(context).textScaleFactor` clamped or ignored
- `ExcludeSemantics` and `BlockSemantics` — each needs a reason beside it

## Android — `build.gradle[.kts]`, `AndroidManifest.xml`

Dynamic audit, inside instrumentation tests:

```kotlin
@Before fun enableA11yChecks() {
  AccessibilityChecks.enable().setRunChecksFromRootView(true)
}
```

Run: `./gradlew connectedAndroidTest` (needs a device or emulator), and
`./gradlew lint` for the static accessibility rules. **Check whether
instrumentation tests exist at all** — the audit runs inside them, so no
tests means no dynamic coverage no matter what lint reports.

Static sweep:

- `contentDescription` absent on `ImageView`, `ImageButton`, `Icon`
- Compose: `Icon(`/`Image(` with no `contentDescription`, `Modifier.clickable`
  with no `Modifier.semantics`
- `Modifier.size(` under `48.dp` on anything clickable
- `android:importantForAccessibility="no"` — needs a reason beside it
- `.sp` literals outside a typography theme; `android:textSize` in dp rather
  than sp, which defeats font scaling outright
- `android:contentDescription="@null"` on a non-decorative element

## iOS — `*.xcodeproj`, `Info.plist`

Dynamic audit, iOS 17+ only:

```swift
func testAccessibility() throws {
  let app = XCUIApplication(); app.launch()
  try app.performAccessibilityAudit()
}
```

Run: `xcodebuild test -scheme <scheme> -destination '<sim>'`. Read
`IPHONEOS_DEPLOYMENT_TARGET` first — below 17 this API does not exist and the
honest answer is that no automated dynamic audit is available.

Static sweep:

- UIKit: `UIButton`/`UIImageView` with no `accessibilityLabel`
- SwiftUI: `Image(` with no `.accessibilityLabel`, `.onTapGesture` on a view
  with no `.accessibilityAddTraits(.isButton)`
- `.accessibilityHidden(true)` and `isAccessibilityElement = false` — each
  needs a reason beside it
- `UIFont.systemFont(ofSize:)` without `UIFontMetrics(...).scaledFont(for:)`,
  and `.font(.system(size:))` in SwiftUI — both defeat Dynamic Type
- Frames under 44pt on tappable views

## React Native — `package.json` with `react-native`

`eslint-plugin-react-native-a11y` if configured; run the project's lint task
and paste it. RN renders native views, so the Android and iOS sections above
are the real audits — run them too.

Static sweep:

- `TouchableOpacity`, `Pressable`, `TouchableHighlight` with no
  `accessibilityLabel`
- `accessible={false}` on an interactive element
- `fontSize:` literals in styles — check whether `allowFontScaling` is
  disabled anywhere, which switches off text scaling entirely
- `hitSlop` used to reach the target size rather than the view being sized —
  correct for the touch target, invisible to a screen reader's element bounds

## Cross-stack, source cannot decide these

Put every one of these in `NOT ESTABLISHED` unless something you ran decided
it:

- **Focus order** — a property of the rendered accessibility tree, not of
  source order. Needs a device with the screen reader on, or a UI test that
  walks the tree.
- **Label meaningfulness** — "Button" passes every static check and helps
  nobody.
- **Contrast as shipped** — across themes, states, disabled variants,
  dark mode, and over imagery.
- **Announcement quality** — whether a change is announced at all, whether it
  interrupts, whether it repeats.
- **Gesture alternatives** — whether a swipe, long-press or drag has a
  reachable non-gesture path.
- **Reduce Motion / Reduce Transparency** — whether the setting is honoured.
