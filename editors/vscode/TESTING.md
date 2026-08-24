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

**Needs a real model.** Cost accounting against live usage events, the model
picker's catalog contents, and anything about answer quality.

**Needs a human looking at pixels.** The webview's rendered DOM. The extension
host can prove a provider was registered and resolved; it cannot read the
page. Theme-awareness, keyboard-only operation, "the reconnect card looks like
a card and not a stack trace", and the card's action buttons
(*Show Log* / *Choose a Model* / *Retry*) actually rendering are all unverified
here. What the card is *told* to render is covered by
`src/sidebar/connection-card.test.ts` and `src/sidebar/view.ts`'s tests. The webview's CSP
and message validation are covered by unit tests against the HTML string, not
against a rendered page.

**Notifications.** There is no stable API to read what is on screen, so
`showInformationMessage` / `showWarningMessage` / `showErrorMessage` /
`showQuickPick` are invisible to the suite. Concretely: the injection test
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
