# Testing the Arcturn VS Code extension

Two suites, two different claims.

| | Unit (`vitest`) | Integration (`@vscode/test-cli`) |
| --- | --- | --- |
| Where | `src/**/*.test.ts` | `test/integration/**` |
| `vscode` module | mocked (`src/test-vscode.ts`) | **the real one**, in a real extension host |
| Speed | ~seconds, hermetic | ~40s, launches an editor |
| Runs by default | yes | no — invoked explicitly |

The unit suite proves the extension's *logic* is right. The integration suite
proves the extension *exists* as far as VS Code is concerned: that it
activates, that its commands are registered with the workbench, that its view
id resolves a provider, and that the bytes it types into a terminal are the
bytes it meant to type.

## The sidebar webview, which is neither

The chat panel is a third thing, and it needs saying because it is the part
that looks least testable and is not.

The page's script ships as a **string** (`src/sidebar/webview-client.ts`
explains why: a webview has no module loader, and inlining under a nonce is
what lets the CSP grant `script-src 'nonce-…'` and nothing else). A string of
JavaScript is invisible to `tsc`, which is exactly the shape of code that
rots. So it is split into pieces that are each driven directly:

| Module | Ships as | Driven by |
| --- | --- | --- |
| `webview-markdown.ts` | `MARKDOWN_SOURCE` | `webview-markdown.test.ts` |
| `webview-models.ts` | `MODEL_LIST_SOURCE` | `webview-models.test.ts` |
| `webview-sessions.ts` | `SESSION_LIST_SOURCE` | `webview-sessions.test.ts` |
| `webview-transcript.ts` | `TRANSCRIPT_SOURCE` | `webview-transcript.test.ts` |
| the page itself | `SIDEBAR_SCRIPT` | `webview-render.test.ts` |

The four pure modules are compiled with `new Function(SOURCE)` and called, so
the tests exercise **the bytes that ship** rather than a second copy of the
algorithm kept in step by hand. Each returns plain data — the markdown parser
returns a *tree of objects*, never a string of HTML — so none of them needs a
DOM, and `environment: "node"` stays.

`webview-render.test.ts` goes one step further and runs the whole page script
against ~150 lines of stub DOM declared in that file. That settles
**structure**: which elements are built, with which classes and text, in
response to which host message, and which messages go back — including the
claims that matter most, that a `<script>` in model output becomes characters
and that a repaint reuses the elements it already built. It settles **nothing
about appearance**; see "does not cover" below. It is deliberately strict
(`appendChild(undefined)` throws, as a browser would) so that a passing test is
a statement about the script and not about the stub.

## Running them

```sh
# Unit — from the repo root; the extension's tests are part of the monorepo suite.
npx vitest run

# Integration — builds the bundle, builds the tests, launches VS Code.
pnpm -C editors/vscode run test:integration
```

Integration is deliberately kept out of the default `vitest` run. It needs a
windowing system, it takes tens of seconds, and it is not hermetic. It is a
gate you invoke, not a tax on every edit.

Useful knobs:

```sh
# Run one of the two launches.
npx vscode-test --label default
npx vscode-test --label serve-disabled

# Run against a specific downloaded host instead of the installed one.
ARCTURN_VSCODE_VERSION=1.93.0 pnpm run test:integration

# Run against a VS Code somewhere else.
ARCTURN_VSCODE_EXECUTABLE=/path/to/Code pnpm run test:integration
```

### Which VS Code, and where it writes

`.vscode-test.mjs` reuses the VS Code installed on this machine when it can
find one (`/Applications/Visual Studio Code.app/Contents/MacOS/Code` on macOS,
and the older `Electron` spelling, and the usual Linux/Windows locations).
Failing that it downloads a **pinned** 1.93.0 — pinned rather than `stable`,
because a suite whose subject changes underneath it is not a suite.

Every launch gets its own `--user-data-dir` and `--extensions-dir`, plus
`--disable-extensions`. Nothing the suite does can reach your own VS Code
profile or your installed extensions. Profiles live under
`/tmp/arcturn-vscode-it/` rather than beside the fixtures, because VS Code
puts a unix domain socket inside the user-data dir and those cannot exceed 103
characters — a deep checkout blows that budget on its own and Electron reports
it as an opaque `ENOTSOCK`.

### The stand-in engine

There is no `arcturn` binary on a CI machine, and requiring one would make the
suite untestable in the place it matters most. `test/support/fixtures.mjs`
writes a small program in its place and points `arcturn.cliPath` at it. It is
**not** a mock of the `vscode` API — it is a process on the far end of a real
pty. It does three things:

- `--version` → prints `0.2.0`, so the provisioner resolves and does not nag.
- `serve …` → records its argument vector, writes two lines to stderr and
  exits `2` without announcing an address. The message is shaped like the real
  failure (`No API key found for …` / `Set ANTHROPIC_API_KEY …`) because the
  claim `06-engine-failure` makes is about carrying a *block* of the engine's
  own output through to something a user reads.
- no arguments → the TUI. Puts the tty in raw mode and appends **every byte it
  receives** to a log.

That log is the only reason the injection test can make a claim at all: VS
Code's stable API gives an extension no way to read back what
`Terminal.sendText` sent, so the observation has to happen at the other end of
the terminal.

## What integration covers

30 tests across two launches.

**Launch 1 — `default`** (workspace with `arcturn.serve.enabled: true`)

- **Activation** (`01-activation`) — the extension is registered under
  `sitharaj88.arcturn-vscode`; `activationEvents` is `[]`; it is *inactive*
  until a contributed command is invoked, and active afterwards. Then the
  RFC 0004 §3 activation-cost rule, observed rather than argued: after
  activation the stand-in engine has been executed **zero** times and no
  terminal exists.
- **Command registration** (`02-commands`) — every id in
  `contributes.commands` is in `vscode.commands.getCommands(true)`, and no
  `arcturn.*` command is registered that the manifest does not contribute
  (excluding the `arcturn.sidebar.*` commands VS Code synthesises per view).
  This is the runtime version of `src/manifest.test.ts`.
- **Terminal integration** (`03-terminal`) — `arcturn.open` creates exactly one
  terminal named `Arcturn`, in the workspace folder, and the launch line it
  types actually starts the engine (observed from the engine's side, so
  quoting, `cwd` and `PATH` are all under test). Invoking it again does not
  create a second. The engine is version-probed exactly once per window.
- **Mentions and the injection refusal** (`04-mention-injection`) — a plain
  filename arrives as `@probe-target.ts `; a shell-special but legal one
  arrives *quoted* as `@"probe (1).ts" `; a selection arrives as
  `@probe-target.ts:2-3 `. Then the security fix: a file named
  `ev"il;touch pwned;#.ts` is opened in the editor and `arcturn.sendFile` is
  run, and **nothing** reaches the terminal — no `"`, no `;`, no `touch`, and
  no `pwned` file on disk. The three positive controls come first on purpose:
  "the log contains no injection" is worthless until a benign mention has been
  seen arriving through the same channel. A final test sends a normal mention
  again, because a refusal that wedges the extension is not a fix.
- **The sidebar view** (`05-sidebar-view`) — `arcturn.sidebar` is contributed
  as a `webview` view in the `arcturn` activity-bar container; the workbench
  has synthesised `arcturn.sidebar.focus` (which the shipped
  `SidebarViewProvider.reveal()` calls by name) and
  `workbench.view.extension.arcturn`. Executing the focus command reveals the
  view, VS Code calls `resolveWebviewView`, and the engine starts — observed as
  a recorded `arcturn serve` invocation, with `--host 127.0.0.1`, `--port 0`,
  `--cwd` the workspace folder, and a 64-character token.
- **The engine refusing to start** (`06-engine-failure`) — the stand-in engine
  dies the way the real one does on a machine with no API key, and the suite
  follows what the extension made of it into the Output channel: **both** of
  the engine's stderr lines are there verbatim, the extension says the engine
  *could not start* and names the exit status, the generated token is **not**
  there, and no value of any credential-shaped variable in this window's own
  environment is either. That last one is a real check rather than a
  formality: the extension resolves the developer's actual login shell during
  this run, so the environment it read is full of live secrets.

  The Output channel is observable because showing one materialises a document
  with the `output:` scheme in `vscode.workspace.textDocuments`. The **card**
  and the **notification** on that same path are not observable at all (see
  "does not cover" below) and are covered by unit tests instead.

**Launch 2 — `serve-disabled`** (workspace with `arcturn.serve.enabled: false`)

- **`serve.enabled` toggled live** (`serve-toggle`) — with the setting false at
  activation, none of the six serve-gated commands are registered, while
  `arcturn.open` still is. Flipping the setting to `true` makes all six appear
  with no window reload; flipping it back removes them again. Nothing is
  spawned by any of it. This is the bug the `onDidChangeConfiguration`
  listener in `extension.ts` was added to fix, watched happening.

## Defect this suite found — fixed

Kept as history, because the shape of the mistake is more useful than the
mistake. **The extension did not work on VS Code 1.90–1.92, which
`engines.vscode` claimed to support.** `src/terminal.ts` feature-detected the
shell-integration API with `typeof window.onDidEndTerminalShellExecution ===
"function"`. On 1.90 that property *exists* — the check passes — but calling
it throws:

```
Extension 'sitharaj88.arcturn-vscode' CANNOT use API proposal: terminalShellIntegration.
Its package.json#enabledApiProposals-property declares: [] but NOT terminalShellIntegration.
```

The call happens in `createTerminalHub()`, which `activate()` runs while
building its dependencies — *before* a single command is registered. So the
whole extension failed to activate and every command reported "command not
found". Measured then: 1.90.0 → 5 passing / 10 failing; 1.93.0 → 26/26.

The suggested remedy was "either `engines.vscode` should become `^1.93.0`, or
the detection needs to survive a throwing call". Both were done, because they
answer different questions:

- **`engines.vscode` is now `^1.93.0`** (and `@types/vscode` with it). That is
  what the extension actually requires: the shell-execution signal is the
  load-bearing half of the terminal-liveness fix, and claiming support for a
  host where the extension is inert is a false promise, not a small one.
- **The subscription is wrapped in `try`/`catch` anyway.** Forks (Cursor,
  Windsurf, VSCodium) and future proposal churn can reproduce the same
  present-but-gated shape, and total activation failure is the worst available
  response to losing an *optional* signal. On the degraded path the hub treats
  a reused terminal as not-known-live — it re-launches and settles before
  typing — rather than falling back to the "assume live" behaviour the signal
  existed to remove.

`src/test-vscode.ts` grew the missing third host state (`shellIntegration:
"available" | "absent" | "proposal-gated"`), so the unit suite can now express
this: `terminal.test.ts` and `extension.test.ts` both fail against the old
code and pass against the new.

Running below the declared floor is now the platform refusing a version it was
told not to load, rather than a crash inside activation:

```sh
ARCTURN_VSCODE_VERSION=1.90.0 pnpm -C editors/vscode run test:integration
# [.../editors/vscode]: Extension is not compatible with Code 1.90.0. Extension requires: ^1.93.0.
```

The suite still reports failures on that run, because its assertions all
presuppose an activated extension. That is a harness gap, not a defect: a run
below `engines.vscode` should arguably skip with one clear line instead. Left
alone deliberately — changing it is a decision about the evidence harness, not
part of fixing the bug it caught.

## What integration does **not** cover

Written down rather than faked. Each of these is a claim in RFC 0004 that this
suite does not settle.

**Needs a real `arcturn` binary.** Everything past the spawn: the `arcturn
serve` startup handshake, the loopback WebSocket connection, `authenticate`,
`createSession`/`openSession`, streamed assistant text, tool-call rows, todos,
mid-turn `steer`, `abort`. The suite proves the extension *asks* for a server
with the right arguments; it does not prove the two ends talk. RFC 0004 §4's
Stage 2 demo ("sidebar chat streams a tool call, a permission modal answers
it, the status bar ticks real dollars") is untested end to end.

**Needs a real model.** Cost accounting against live usage events, and
anything about answer quality.

**Needs a real engine, for the model list specifically.** The panel's model
selector is driven end to end in the unit suite against a catalog fixture:
ordering, filtering, the credential dot, the free-text row, the keyboard path,
and that picking one posts `setModel`. What no suite covers is the round trip
against a live `arcturn serve` — that `listModels` answers with the shape the
projection expects, that `setModel` accepts the id that was clicked, and that
the next run announces it. `packages/protocol` tests the wire; nothing tests
the two ends together.

**Needs a real engine, for the session list too.** History moved out of a
command-palette quick-pick and into the panel, and the same gap applies to it:
the unit suite drives the view against a fixture — ordering, searching, the
relative timestamp, the current-session badge, the empty / disconnected /
failed states, the keyboard path, and that picking a row posts `openSession` —
but nothing exercises the round trip. Specifically unverified: that
`listSessions` returns headers whose `cwd` matches `workspaceCwd()` byte for
byte on every platform (the filter in `projectSessions` is the whole list on a
mismatch, and it would fail silently as "no sessions in this workspace"), that
`openSession` on a row's id actually re-attaches the stream, and that a title
the engine stored is the title a row shows. One more, specific to switching:
attaching a controller repaints the transcript from that controller's own
state, so the panel cannot go on showing the previous conversation — but
whether the engine *replays* the opened session's history into it, or leaves
the panel correctly empty, is the engine's behaviour and is unobserved here.

Deleting has the same shape and one more gap. The panel's half is covered: the
row's button and the keyboard paths post `{ type: "deleteSession", sessionId }`
and then deliberately do *nothing* — no confirmation of its own, no optimistic
removal — so the row stays on screen until a refreshed list arrives without it.
What no suite covers is that the round trip closes: that the host's native
modal is what answers, that a cancelled or failed delete leaves the session
listed, and that the engine actually removes it. The failure mode the "leaves
the row on screen" test exists to prevent is the one that cannot be caught
downstream — a panel claiming a session is gone while the user is still looking
at the dialog asking whether to delete it.

**Needs a real engine, for the composer's four new surfaces.** RFC 0005 §2
landed the `@` picker, the `/` menu, the mode chip and the capability line. The
unit suite drives all four end to end against fixtures — `webview-render.test.ts`
runs the shipped script for the picker's rows, the chip row, the menu's grouping
and insertion, the mode chip and the capability line; `webview-context.test.ts`,
`webview-commands.test.ts` and `webview-permission.test.ts` drive the scoring,
the grouping and the wording directly. What no suite covers is the round trip:

- That `resolveContext` answers with the byte count a `stat` would give, so a
  chip reading `4.2 KB` is the size the model actually receives. Every number
  in the picker and on every chip is the engine's; none of them has been
  compared against a real file.
- That the paths `workspace.findFiles` returns resolve, byte for byte, against
  the *session's* `cwd`. The extension makes them workspace-relative and the
  engine resolves them against its own root; if those two roots ever disagree
  the picker reports every file as outside the workspace, which would look like
  a broken engine rather than a mismatch.
- That a prompt carrying `attachments` reaches the model with the file's
  contents in it — the acceptance test RFC 0005 §4 asks for ("attach a file
  with `@`, send, and see the model answer about the file's contents").
- That a pasted image arrives as a vision block, **and** that pasting one into
  a model with no vision is refused with a reason before the turn is spent.
  The panel's half is covered: the boundary validates base64 and the mime type
  against the engine's own allowlist, and a chip appears with the size. The
  engine's refusal is unobserved. Related and also unobserved: that detaching a
  pasted chip actually drops its bytes host-side — the page is never sent them,
  so nothing on the page can prove it; only `pendingAttachments` against a live
  engine can.
- That `setPermissionMode` takes effect on the *next turn* — RFC 0005 §4's
  "switch to `plan` and watch a write get refused". The panel proves it posts
  the verb and that the chip moves only on the engine's answer; whether the
  agent then behaves differently is the engine's claim.
- That `permissionState.tools` names the tools this build actually holds, which
  is the whole basis of the capability line. If an engine reported `fetch` it
  did not have, the panel would say it can browse the web, truthfully repeating
  a false answer.
- That `listCommands` returns the skills a workspace really has. The menu's
  filter (`runnableCommands`) is covered against fixtures including a built-in
  the panel has no surface for; that the engine's own list matches what
  `loadSkills` found on disk is untested here.

**Drag and drop, specifically.** A drop into the webview is read as
`text/uri-list` and the URIs are forwarded to the host verbatim, which turns
them into paths with `vscode.Uri`. The unit suite drives the page's half
against a stub `dataTransfer`. What nobody has watched: that VS Code's own
explorer actually puts `text/uri-list` on the drag into a webview, that a drop
from Finder / Explorer does too, and that a Windows drive-letter URI
round-trips to the path the engine expects. If the first of those is false the
feature silently does nothing, and no test in this repository would notice.

**Markdown the parser does not implement.** Tables, reference links, setext
headings, HTML blocks (deliberately — raw HTML renders as text, and there is a
test for that), and nested emphasis of three or more markers. A model that
emits a table gets its pipes and dashes as prose. This is a known gap, not an
unverified claim.

**Needs a human looking at pixels.** The extension host can prove a provider
was registered and resolved; it cannot read the page. `webview-render.test.ts`
now covers the panel's *structure* (see above), and `webview-html.test.ts`
covers its CSP, its accessibility roles and the claim that every id the script
reaches for exists in the skeleton. What is left is genuinely visual, and none
of it is asserted anywhere:

- **How any of it looks.** The stub DOM has no layout, no cascade, no computed
  style, no font metrics. That the panel is legible, that spacing and
  alignment read as deliberate, that the composer's grid/`attr()` mirror
  actually grows the textarea, that a long tool summary ellipsises instead of
  pushing the status badge off the row, that the model popover lands over the
  composer rather than behind it — all unverified.
- **Themes.** Every colour is a `--vscode-*` token and a unit test asserts
  there are no literal ones, which is not the same as saying light, dark and
  high-contrast all resolve to something with usable contrast. Nobody has
  looked at high-contrast at all.
- **Motion.** Eight animations now say something about state, and the unit
  suite asserts only the *mechanism* — which class the script puts on which
  element, in response to which state change, and which it withholds. What it
  cannot see is whether any of it reads as intended. Specifically unverified:
  that a submitted prompt settles rather than snaps; that the working
  indicator's breathing sparkle and staggered dots read as "the model is
  working" rather than as a generic spinner; that the caret keeps up with the
  stream and, in particular, that it goes *solid* while tokens land and blinks
  only in a pause (that behaviour falls out of the reconciler rebuilding the
  markdown subtree per delta, and it has never been watched); that a long
  answer does not strobe; that a tool badge's pop is a punctuation mark and
  not a twitch; that the end-of-turn hairline is noticeable when glanced at
  and invisible when not. Also unverified: that none of it costs measurable
  CPU while the panel sits idle — the claim is that `display: none` on the
  working row and the absence of `.streaming` between runs leave nothing
  animating, and nobody has watched a profiler to confirm it.
- **`prefers-reduced-motion`, in a real browser.** The stylesheet's override is
  universal and `webview-html.test.ts` asserts its shape, which is not the same
  as having set the OS switch and looked. Two things need eyes there: that
  every animation lands on its *end* state rather than disappearing (a
  fill-mode entrance has to stay visible), and that the panel is fully usable
  and not merely still — the caret is expected to become a static block, and
  the running-tool spinner a static circle whose "Running" label carries the
  state instead.
- **Code packaging at 300px.** The fold threshold (14 lines), the language
  pill, the filename row, the "writing…" header on an unclosed fence, the fade
  over folded code and the copy button's hover reveal were all *reasoned* at a
  300px panel, not seen at one. What needs a narrow sidebar and a real
  Chromium: that a `code-head` with a long language and a long basename
  ellipsises the filename rather than pushing the copy button off the row;
  that a 200-character line scrolls inside its own box and never widens the
  panel; that `overflow-y: hidden` on a folded block reads as folded rather
  than as broken; that the fade sits exactly over the cut; and that a
  paragraph followed by its code block reads as one unit at that width.
- **The composer at 300px, which is the width it was designed for.** The bar
  now carries two icon buttons, a model chip, a mode chip and send; the hint
  is dropped below 380px by a viewport media query (the webview's viewport
  *is* the sidebar, so that query is a container query). Reasoned, not seen.
  What needs a narrow sidebar and a real Chromium: that the model chip
  ellipsises before the mode chip does rather than the other way round; that
  three attached chips wrap to a second row instead of widening the panel;
  that a chip's right-to-left ellipsis actually keeps the basename visible;
  that the `@` popover lands *over* the composer and not behind it; and that
  the whole thing still reads as one control rather than five.
- **That the hint stays in the accessibility tree when it is `display: none`.**
  The claim is that accname includes a node referenced by `aria-describedby`
  whether or not it is rendered, so a screen-reader user at 300px still hears
  "Enter to send". That is what the specification says; nobody has put a screen
  reader on a 300px sidebar and listened.
- **The mode chip's tint.** `yolo` is warning-coloured and `plan` is link-
  coloured, on top of the word itself — colour is never the only carrier. That
  the two read as *more* and *less* permissive at a glance, in light, dark and
  high-contrast, is a human claim.
- **That the picker feels like a picker.** The 90ms debounce, whether twelve
  rows is the right number at 300px, whether the fuzzy ranking puts the file
  somebody meant in the first row often enough to trust — all of it was
  reasoned against a scoring function with unit tests, and none of it has been
  used to find a file in a real repository.
- **That the three kinds of code are actually distinguishable.** Inline code is
  a bordered chip, a fence is a titled card, tool output is a rule-marked pre.
  The rules are written; whether they separate at a glance in light, dark and
  high-contrast is a human claim.
- **The delete affordance's reveal.** That a 0-opacity button is discoverable
  on hover, that `:focus-within` brings it up when a keyboard user tabs into
  the row, that `.session-row.active + .session-delete` brings it up under the
  arrow-key selection, and that `forced-colors: active` shows it permanently.
  The *behaviour* is asserted (it posts `deleteSession`, it does not open the
  session, it does not remove the row, and Delete / Shift+Delete on the search
  box and Delete on a focused row all reach it); the reveal is CSS.
- **Real focus behaviour.** The tab order, that `:focus-visible` rings are
  visible against every theme, and that a screen reader announces streamed
  text once rather than re-reading the log. The *roles and properties* are
  asserted; what an assistive technology does with them is not.
- **`color-mix` and `:where`.** Both are used with fallbacks and both need a
  Chromium newer than the one `engines.vscode: ^1.93.0` guarantees at its
  floor. The fallbacks are written; they have not been observed degrading.
- **The copy button actually copying.** The unit suite proves the panel posts
  `{ type: "copy" }` and that the host calls `vscode.env.clipboard.writeText`
  with it. That the clipboard then holds it is untested.

**Notifications.** There is no stable API to read what is on screen, so
`showInformationMessage` / `showWarningMessage` / `showErrorMessage` /
`showQuickPick` are invisible to the suite. One of those is now smaller than it
was: the sessions quick-pick is gone entirely, so the only unobservable
session-related surface left is the error notification raised when
`openSession` is refused — including the `escapeCodicons` call that keeps an
engine-supplied id from rendering as a glyph in it. The in-panel list that
replaced the quick-pick *is* observable, in `webview-render.test.ts`. Concretely: the injection test
proves nothing was typed, but *not* that the user was told why. The same goes
for the missing-CLI notification, its "Install" / "Set path…" buttons, the
version-upgrade nag, and the one error notification a palette command raises
when the engine could not start — all of RFC 0004 §1's provisioning UX is
unobserved. `06-engine-failure` gets as close as the API allows by following
the same words into the Output channel, and `src/sidebar/index.test.ts` covers
the notification itself against a fake `vscode`.
`arcturn.installCli` itself is never invoked: it types `npm install -g
arcturn` into a terminal, and a test suite should not do that to the machine
it runs on.

**Keybindings.** `ctrl+alt+a` / `cmd+alt+m` are contributed but never pressed;
an extension host cannot synthesise a keystroke. Only the manifest declaration
is checked, by the unit suite.

**Menu placement and `when` clauses.** That `arcturn.sendFile` appears in the
explorer context menu for a file and not a folder, that `arcturn.fixDiagnostic`
is hidden from the palette — the workbench exposes no query for menu contents.
The `serve-toggle` launch tests the *effect* of one `when` clause
(`config.arcturn.serve.enabled`) via command registration, which is the only
one with an observable consequence.

**Multi-root workspaces.** `terminalName()` appends the folder name when more
than one root is open, and one terminal is meant to exist per folder. Testing
it needs a third launch against a `.code-workspace` file; not built.

**Engine-exited terminal reuse.** `terminal.ts` re-launches into an existing
tab when the TUI has quit, driven by `onDidEndTerminalShellExecution`. Killing
the stand-in TUI and watching the relaunch is possible in principle and is not
done here.

**Other platforms.** Everything above was observed on macOS only. The Windows
quoting path in `launch.ts` (the PowerShell call operator) and the `.cmd`
shim ordering in `cli-resolve.ts` have unit tests and no integration coverage.

**The login-shell probe, per shell.** `src/shell-env.ts` picks different flags
for zsh/bash, sh/dash, fish, nushell, tcsh and pwsh. The integration run only
ever exercises whichever shell `vscode.env.shell` reports on the machine it
runs on — one of them. The flag table and the parser have unit tests
(`src/shell-env.test.ts`) that inject the runner, deliberately, so that no test
in this repository depends on the developer's own shell.

That isolation was itself a blind spot once: injecting the runner meant the
parser only ever saw output a test author *imagined* `env(1)` producing, and a
value containing a newline — which `env` prints raw — could be read as a new
assignment. `src/shell-env.shell.test.ts` closes it by running the real
`shellProbeCommand()` against `/bin/bash` with `HOME` pointed at a temporary
directory holding a crafted `.bash_profile`, so a real `env` writes the bytes.
It skips where `/bin/bash` does not exist. The zsh, sh and tcsh recipes were
additionally checked by hand against the real binaries on macOS.
**fish, nushell and pwsh are derived from their documented flags and have not
been run.** A shell whose recipe is wrong fails the probe, which falls back to
the extension host's environment and says so in the Output channel — bounded,
visible, and not a crash.

**An `env` without `-0`.** The probe asks for NUL-separated output, which BSD
`env` (macOS) and GNU coreutils `env` both support. BusyBox's may not; that
path is covered by a unit test (an empty body is refused, never parsed) but has
not been run on a BusyBox image.

**The hostile filename is macOS-legal.** `ev"il;touch pwned;#.ts` is created
successfully on APFS, so nothing was skipped here — but a filesystem that
rejects `"` (any Windows one) would make that test vacuous. The test asserts
the file exists before it asserts anything else, so it fails loudly rather
than passing for the wrong reason.

## Adding a test

`test/integration/*.test.ts`, bundled to CJS by `pnpm run build:integration`,
run by mocha inside the extension host. Two rules:

1. **Do not import `src/`.** The point of the suite is the *bundle* VS Code
   loaded. Read the manifest back from `Extension.packageJSON`, and read
   command ids from the workbench.
2. **Say what broke.** Every assertion message in this suite is a sentence
   explaining the claim and what was seen instead, because a red integration
   test is read by someone who was not here when it was written. `waitFor` and
   `waitUntil` in `helpers.ts` take that sentence as an argument.

File order in `.vscode-test.mjs` is load-bearing: `01-activation` has to run
against a cold extension host, and `05-sidebar-view` deliberately spends the
activation budget that `01` asserts is unspent.
