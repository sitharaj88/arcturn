# Arcturn for VS Code

Arcturn (✦) is an interactive coding agent. This extension puts it in your
editor — but it is a *client*, never a second copy of the agent. Everything it
can do, the `arcturn` CLI can do, because it is the same engine, the same
`~/.arcturn` config, the same sessions, and the same permission rules. A
session you start in a terminal is the same session the sidebar will resume.

That is deliberate. If a capability is not in the engine, this extension does
not have it either.

## Two doors, one engine

**Extension-first.** Install the extension, open a folder, run **Arcturn:
Open**. If the CLI is not on your machine, you get one notification offering
to install it. Accepting types `npm install -g arcturn` into a visible
terminal — you watch exactly what runs. Nothing installs silently.

**CLI-first.** Already have `arcturn` on your PATH? The extension finds it and
uses it. It never installs over the top of what you have, and it never writes
to your `~/.arcturn` config. If you keep the binary somewhere unusual, point
`arcturn.cliPath` at it.

Either way, the extension launches the TUI by *typing a command into a
terminal*, so you can always read what it ran and re-run it yourself.

## Commands

| Command | ID | Default keybinding | What it does |
| --- | --- | --- | --- |
| Arcturn: Open | `arcturn.open` | `ctrl+alt+a` / `cmd+alt+a` | Launches the TUI in a terminal named **Arcturn**. One per workspace folder; running it again focuses the one you have. |
| Arcturn: Send Selection | `arcturn.sendSelection` | `ctrl+alt+m` / `cmd+alt+m` | Types `@path/to/file.ts:12-34 ` into the Arcturn terminal — and nothing else. No newline: you finish the sentence and press Enter. |
| Arcturn: Send File | `arcturn.sendFile` | — | The same, with no line range. Also on the explorer's right-click menu, so it works with no editor open. |
| Arcturn: Install CLI | `arcturn.installCli` | — | Runs the install in a terminal on demand, for when you dismissed the notification. |
| Fix with Arcturn | `arcturn.fixDiagnostic` | — | A code action on any diagnostic. Sends the file, the range, and the problem reporter's own words. Not marked as the preferred fix, so it never displaces a real quick fix or hijacks fix-on-save. |
| Arcturn: Select Model | `arcturn.selectModel` | — | Quick-pick fed by the engine's model catalog (`listModels`): every registered model with its context window, price per Mtok and whether the engine holds a credential for it, the ones you have keys for first. Plus anything the session announced, `arcturn.defaultModel`, and a free-text entry for an id the catalog does not carry. Switches the model for the live session. |
| Arcturn: Show Sessions | `arcturn.showSessions` | — | Opens the sidebar's own history view — every session for this folder, searchable, newest first, with its id and how long ago it started. Pick one to resume it, or start a new one. The panel's history button opens the same view. |
| Arcturn: New Session | `arcturn.newSession` | — | Starts a new session in the sidebar. |
| Arcturn: Abort Run | `arcturn.abortRun` | — | Stops the turn in flight. |
| Arcturn: Show Cost | `arcturn.showCost` | — | The breakdown behind the status bar figure. |
| Arcturn: Edit Selection | `arcturn.inlineEdit` | `ctrl+alt+k` / `cmd+alt+k` | Select lines, say what should change, see the proposal as a diff, apply or discard. The turn is read-only and the *editor* makes the edit: undo is one entry, declining costs nothing, and the change cannot reach outside the selection. |
| Arcturn: Review My Changes | `arcturn.reviewChanges` | — | The uncommitted diff, reviewed by the engine; findings land in the Problems panel as real diagnostics — clickable, with severity, picked up by *Fix with Arcturn*. |
| Arcturn: Clear Review Findings | `arcturn.clearReview` | — | Empties those diagnostics when you are done with them. |
| Arcturn: Generate Commit Message | `arcturn.generateCommitMessage` | — | The staged diff (or the working tree when nothing is staged), plus your repository's own recent subjects for style. The message lands in the Source Control input box for you to edit; nothing is committed. Also a button in the Source Control view. |
| Arcturn: Ask About the Last Failed Command | `arcturn.askAboutFailure` | — | Puts the command, exit code and output tail of the last non-zero exit into the composer as a ready question. The same thing the quiet status-bar item does when clicked. |
| Arcturn: Review Pending Changes | `arcturn.showDiff` | — | Show what a dry run wants to change, as diffs. |
| Arcturn: Apply Pending Changes | `arcturn.applyChanges` | — | Land those changes in the workspace. |
| Arcturn: Discard Pending Changes | `arcturn.discardChanges` | — | Throw them away. |
| Arcturn: Export Chat | `arcturn.exportChat` | — | The conversation as markdown or HTML, saved where you choose. |
| Arcturn: Rewind to a Checkpoint | `arcturn.checkpoints` | — | Pick a checkpoint, confirm the same modal the panel shows, restore. |
| Arcturn: Scout Approaches | `arcturn.scout.run` | — | Run competing approaches in throwaway worktrees and read each result as side-by-side diffs; hand the winner to the agent as findings. |
| Arcturn: Authorize MCP Server | `arcturn.authorizeMcpServer` | — | OAuth for an MCP server from the editor, including over Remote-SSH, devcontainers and Codespaces. Tokens never leave the engine. |
| Arcturn: Attach MCP Resource | `arcturn.mcp.attachResource` | — | Attach what a server publishes; the engine reads it at prompt time, inside the same byte budget a file gets. |
| Arcturn: Run MCP Prompt Template | `arcturn.mcp.runPrompt` | — | A server's prompt template, through an argument form, into the composer. |
| Arcturn: Start Background Agent | `arcturn.background.start` | — | Fire-and-forget work, watched from the Background Agents tree. |
| Arcturn: Refresh Background Agents | `arcturn.background.refresh` | — | Re-ask the engine what is running. |
| Arcturn: Refresh Hub | `arcturn.hub.refresh` | — | Re-derive each kit's installed/partial/available state from what the engine actually answers to. |
| Arcturn: Reconnect | `arcturn.reconnect` | — | Restarts `arcturn serve` and reattaches after the engine dies. |
| Arcturn: Toggle Active File Context | `arcturn.toggleActiveEditorContext` | — | Turns off — or back on — the panel's habit of including the file you have open with your next message. Same switch as `arcturn.context.activeEditor` and as the chip's own dismiss control. |
| Arcturn: Show Log | `arcturn.showLog` | — | Opens the **Arcturn Sidebar** output channel — everything the engine wrote, redacted, plus which environment the extension resolved. This is where you look when something did not start. |

Everything from *Select Model* down drives the sidebar, so those commands are
hidden from the palette when `arcturn.serve.enabled` is off — with no serve
there is no engine behind them, and a menu of entries that can only fail is
not a menu. Four more commands never appear in the palette at all: *Install
Kit* and *Open on arcturn.dev* live on the Hub tree's rows, *Cancel* and
*Bring Into Chat* on the Background Agents tree's — each acts on the row it
sits on.

The code action becomes available once the extension has activated — that is,
after you have run an Arcturn command or opened the Arcturn view once in this
window. The activation events are deliberately narrow (no `"*"`), and this is
what that costs.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `arcturn.cliPath` | *(empty)* | Path to the `arcturn` executable. Empty means search `PATH`. `~` is expanded. If it points at something that is not runnable, Arcturn tells you so rather than quietly falling back to `PATH` — otherwise you would be running a different engine than the one you named. |
| `arcturn.defaultModel` | *(empty)* | Passed to the engine as `--model` when a terminal is launched from the extension. Empty means the engine's own default. |
| `arcturn.serve.enabled` | `true` | Run `arcturn serve` for the native sidebar. Turn it off for terminal integration only; the Arcturn view goes away with it. |
| `arcturn.serve.port` | `0` | Loopback port for `arcturn serve`. `0` picks an ephemeral port, which is what you want. |
| `arcturn.context.activeEditor` | `true` | Include the file you have open with your next panel message. See below. |
| `arcturn.cli.autoUpdate` | `true` | Install a missing engine without asking, and once a day ask npm whether a newer one exists. Off, every install and upgrade is offered as a question instead. An engine pinned by `arcturn.cliPath` is never auto-installed over — pinned means pinned. |

### The file you have open

The panel watches which file is in front of you and shows it as a chip above
the composer — dashed border, an eye — so "explain this function" is a sentence
you can just type. Select something and the chip names the lines:
`src/auth.ts:12-40`.

It is deliberately not the same chip as the ones you add with `@`. Those stay
where you put them; this one follows your caret, and a row where the two looked
identical would be a row that lies about which of its entries is stable.

**A selection is an ask; an open file is not**, and the chip now says which one
you have:

| what the chip says | what goes with your message |
|---|---|
| `src/auth.ts:12-40 · 29 lines of 4.2 KB` | those 29 lines, as an excerpt. The size is the file's, because that is what the engine measured before it sliced. |
| `src/auth.ts` | one line naming the path. Arcturn reads the file itself, with its `read` tool, if your question turns out to need it. |
| `src/auth.ts · escapes the workspace` | nothing, and the engine's own sentence about why. |

The middle row used to read `4.2 KB`, and used to mean it: an open file was
attached whole. That was the wrong trade. (It then read `path only, contents
not sent` for a while, which was true and still wrong: a disclaimer about
transport, on screen every time the caret moved. The other two rows carry
numbers you can act on; naming a file has none, so that row carries nothing.) `packages/protocol/src/client.ts` is
2,161 lines — about 22,600 input tokens, every single message, whether or not
you asked about it; `packages/cli/src/workflow.ts` is 7,251 lines, about 81,200.
Arcturn has a `read` tool and a path is enough for it to decide, so it now pays
for the file on the turns where the answer is yes instead of on all of them.
Hover the chip and it tells you exactly that, and what it is saving.

If you *want* the whole file in the message, that is what `@` is for — an
explicit attachment is never downgraded, however large it is.

The usual rules hold. The extension never reads the file — the engine does,
from the path, where the permission engine can see the read happen. Every number
on the chip is the engine's answer to `resolveContext`, not a `stat` the panel
did. A file outside the workspace shows the engine's refusal instead of being
quietly dropped. And nothing is attached that you cannot see before you press
send.

Against an **older engine** that does not know how to be told a file is open,
there is simply no chip, and a one-off warning says why. It will not fall back
to sending you the whole file every message because your CLI is out of date;
`@` is still there when you want the file. Upgrade the CLI to get the chip back.

Three ways to turn it off, because some people will not want their editor
watched: the setting, `Arcturn: Toggle Active File Context` in the palette, and
the `×` on the chip itself — which switches the feature off rather than
removing a chip that would be back on your next keystroke.

Default is **on**. The panel's own starter prompts say "the file I have open"
and "the code I have selected"; with nothing watching, those buttons ask the
model about a file it was never told and get a confident answer about nothing.

## Where this actually is

Honest status, because a roadmap written as a feature list is a lie:

- **Stage 1 — the terminal integration: shipped.** CLI provisioning with a
  version check, the Arcturn terminal, `@`-mentions from selection and file,
  and the diagnostic code action are all here and tested.
- **Stage 2 — the native sidebar: shipped.** The chat webview, permission
  requests answered inline in the panel (with a native modal as the fallback
  when the panel cannot be brought into view), live cost in the status bar, the
  model picker, the sessions view and the reconnect path all speak the engine's
  WebSocket protocol — the same `ProtocolClient` verbs any other client gets,
  and nothing beyond them.
- **Stage 3 — the editor as a surface: shipped.** Edit-selection-in-place,
  review-into-Problems, the commit message button, the failed-command
  status-bar item, the Hub and Background Agents trees in the bottom panel,
  scout comparisons in the diff editor, MCP resources, prompt templates and
  in-editor OAuth — and an engine that provisions and updates itself at
  startup, in the background.

None of the stages has been through a long soak in daily use yet. The tests are
real and the demo path in RFC 0004 §4 works; treat the mileage as young.

Two behaviours worth knowing about before they surprise you:

**Some filenames cannot be mentioned.** A mention is typed into a terminal,
and the engine's mention grammar has exactly one quoting form with no escape
for it. So a name containing a control character, a double quote, or the shell
metacharacters `$ ` + "`" + ` \ ; | & < > !` is refused with a message naming the
offending character, rather than stripped down to something quotable — a
stripped name points at a different file, which is a wrong answer delivered
quietly. Spaces, quotes, brackets, braces, `#`, `~`, `*` and `?` are all fine;
so is anything non-ASCII.

**When the engine cannot start, it tells you what the engine said.** If
`arcturn serve` exits before it announces an address — no API key, a binary it
cannot run, a model it cannot resolve — the sidebar shows a card carrying the
engine's own stderr, unedited, with the buttons that are actually useful for
it (*Show Log*, *Choose a Model*, *Set CLI Path*, *Install CLI*, *Retry*). The
same words go to the Output channel, and a sidebar command invoked from the
palette raises one error notification rather than opening an empty picker. The
extension never rewords the engine's explanation: the engine is the part that
knows which credential is missing.

**`arcturn.serve.enabled` applies immediately.** Turning it off shuts the
sidebar and its `arcturn serve` process down there and then, rather than at the
next window reload; a listening socket you believe you switched off is worse
than a lost turn, and the session itself lives in the engine's store and
resumes. Turning it back on starts a fresh one.

The `:12-34` line range in a mention is parsed by the engine and narrows what
gets injected: the model is given those lines, told they are an excerpt, and
told which lines they are, so it does not answer as though it read the file. A
range running past the end of the file is clamped and the clamp is stated; a
range starting past the end is refused rather than quietly becoming the file's
tail, which would be a different selection than the one you named.

## Your shell's environment, and why the extension goes looking for it

On macOS, an app launched from the Dock, Spotlight or Finder is started by
`launchd` and inherits **launchd's** environment — not your shell's. Nothing
exported from `~/.zshrc`, `~/.zprofile` or `~/.bash_profile` is there. A
GUI-launched VS Code on a normal Mac has:

```
PATH=/usr/bin:/bin:/usr/sbin:/sbin        # no /opt/homebrew/bin, no nvm, no pnpm
ANTHROPIC_API_KEY                          # absent
```

Which is why "I installed the CLI and the extension can't find it" and "it says
no API key found" are the same bug. Linux desktop launchers have the same
problem. So, **the first time it actually needs to start the engine** — never at
activation — the extension runs your own login shell, asks it to print its
environment, and uses that for `arcturn serve`, for finding the `arcturn`
binary, and for the `--version` probe.

- **Which shell.** `vscode.env.shell` — the same one the integrated terminal
  opens. bash/zsh/ksh get `-l -i -c`; `sh`/`dash`/`ash` get `-c` only (dash
  rejects `-l`); fish gets `-l -i -c`; nushell gets `-l -c` (never `-i`, which
  opens a REPL); tcsh gets `-i -c` (its `-l` must be the only flag); pwsh gets
  `-Login -Command`. An unrecognised shell is tried as POSIX.
- **Once per window — unless it failed.** A successful read is cached: not once
  per spawn, and *Retry* does not re-run your whole login shell for an answer
  that was already right. Edit your profile and reload the window, the same as
  for anything else VS Code reads at startup. A **failed** probe is different —
  it is the absence of an answer, not an answer — so *Retry* (and
  **Arcturn: Reconnect**) drops it and probes again.
- **Bounded.** Five seconds. A profile that hangs cannot hang the extension —
  it falls back to VS Code's own environment and writes a line to
  **Arcturn: Show Log** saying so and saying what you lose by it. The
  "arcturn not found" notification says it too, so a wrong `PATH` never reads
  as "your install is broken".
- **Unambiguous.** The shell is asked for `env -0`, so every variable is
  separated by a NUL — the one byte a variable's name or value cannot contain.
  A value with a newline in it therefore cannot be misread as declaring a new
  variable, which would otherwise be a way for anything that can set one
  environment variable to set *any* of them, `PATH` included. On a system whose
  `env` does not accept `-0` (some BusyBox images), Arcturn refuses to parse
  rather than guessing, and falls back with the diagnostic above.
- **Nothing is logged.** Your environment contains credentials. The Output
  channel gets a shell path, a variable *count* and a duration — never a name,
  never a value, and never the shell's own output, on the success path or the
  failure path. Values of credential-shaped variables are additionally
  registered with the log's redactor, so one reaching a diagnostic by some
  other route is blanked by value.
- **Your editor still wins.** A variable VS Code already set is kept; the shell
  only fills in what is missing. `PATH` is merged, shell entries first, so
  `arcturn` resolves to the binary your terminal would run. `VSCODE_*`,
  `ELECTRON_*` and `NODE_OPTIONS` are never imported from a profile.

**Not done on Windows**, deliberately: a GUI process there already inherits the
user's environment block and there is no login shell to replicate.

**Still not handled:** an environment that only exists once a shell has entered
your project — a `direnv`/`asdf`/`mise` hook that fires on `cd`, or a key set by
a shell function rather than `export`ed — is invisible to this. The probe reads
what `env` prints, and it deliberately does **not** `cd` into the workspace
first: running your login shell inside a directory whose contents you have just
opened is a bigger door than this fix needs. If your key lives in one of those,
export it from a profile file, or point `arcturn.defaultModel` at a model whose
credential the engine can already see.

## Requirements

- VS Code 1.93 or newer. That floor is load-bearing, not aspirational:
  `onDidEndTerminalShellExecution` is how the extension knows the agent is
  still the thing reading its terminal before it types into one, and that API
  was a proposal until 1.93. The extension previously claimed 1.90 and was
  simply inert there.
- Node.js 20+ on the machine that runs the engine (the extension runs in the
  workspace host, so on a remote or dev container that means *there*, not on
  your laptop).
- The `arcturn` CLI, which the extension will offer to install for you.
- `arcturn` 0.5.9 or newer for the workflow run card's "Raise ceiling…" action
  and its parked-step diagnosis line — both read `capabilities.ceilingRaise`
  off the engine's handshake, so an older CLI still runs everything else, it
  just does not offer either.

Arcturn is disabled in untrusted workspaces and in virtual ones. It runs an
agent that reads, edits and executes in your working tree; that is not
something to offer in a folder you have not trusted.

## Building from source

From the repository root:

```bash
pnpm install
pnpm -C editors/vscode run build      # esbuild -> dist/extension.js
pnpm -C editors/vscode run package    # @vscode/vsce -> arcturn-vscode-0.4.0.vsix
npx vitest run editors/vscode         # the extension's own tests
```

Publishing to the Marketplace is a human's click, never a script's. The VSIX
is the build artifact; what happens to it is a decision.

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). © 2026 Sitharaj Seenivasan.
