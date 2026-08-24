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
| Arcturn: Select Model | `arcturn.selectModel` | — | Quick-pick fed by the session's own catalog; switches the model for the live session. |
| Arcturn: Show Sessions | `arcturn.showSessions` | — | Sessions for this folder — open one, resume it, or start fresh. |
| Arcturn: New Session | `arcturn.newSession` | — | Starts a new session in the sidebar. |
| Arcturn: Abort Run | `arcturn.abortRun` | — | Stops the turn in flight. |
| Arcturn: Show Cost | `arcturn.showCost` | — | The breakdown behind the status bar figure. |
| Arcturn: Reconnect | `arcturn.reconnect` | — | Restarts `arcturn serve` and reattaches after the engine dies. |

The last six drive the sidebar, so they are hidden from the palette when
`arcturn.serve.enabled` is off — with no serve there is no engine behind them,
and six entries that can only fail is not a menu.

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

## Where this actually is

Honest status, because a roadmap written as a feature list is a lie:

- **Stage 1 — the terminal integration: shipped.** CLI provisioning with a
  version check, the Arcturn terminal, `@`-mentions from selection and file,
  and the diagnostic code action are all here and tested.
- **Stage 2 — the native sidebar: shipped.** The chat webview, permission
  modals, live cost in the status bar, the model picker, the sessions view and
  the reconnect path all speak the engine's WebSocket protocol — the same
  `ProtocolClient` verbs any other client gets, and nothing beyond them.

Neither stage has been through a long soak in daily use yet. The tests are
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

**`arcturn.serve.enabled` applies immediately.** Turning it off shuts the
sidebar and its `arcturn serve` process down there and then, rather than at the
next window reload; a listening socket you believe you switched off is worse
than a lost turn, and the session itself lives in the engine's store and
resumes. Turning it back on starts a fresh one.

One known sharp edge worth stating plainly: the `:12-34` line range in a
mention is context for the model to read, not an instruction the engine's
mention expander parses today — it inlines whole files, not ranges. The range
tells the agent where to look; it does not yet narrow what gets injected.

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

Arcturn is disabled in untrusted workspaces and in virtual ones. It runs an
agent that reads, edits and executes in your working tree; that is not
something to offer in a folder you have not trusted.

## Building from source

From the repository root:

```bash
pnpm install
pnpm -C editors/vscode run build      # esbuild -> dist/extension.js
pnpm -C editors/vscode run package    # @vscode/vsce -> arcturn-vscode-0.2.0.vsix
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
