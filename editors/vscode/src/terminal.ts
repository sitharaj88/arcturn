/**
 * The Arcturn terminal: one per workspace folder, launched by typing a
 * command the user can read.
 *
 * The RFC's rule is "one engine, two front-ends" — this is front-end one, and
 * it is deliberately dumb. It does not parse the TUI's output, does not keep a
 * side-channel, and does not hold session state. Everything it knows is which
 * terminal belongs to which folder, and whether the engine is still the thing
 * reading it.
 *
 * ## Knowing whether the engine is still there
 *
 * This used to be assumed, and the assumption was a vulnerability: quit the
 * TUI with `q`, and the terminal stays open on a bare shell prompt while the
 * hub still hands it back as "the Arcturn terminal". Everything typed into it
 * then goes to a shell.
 *
 * VS Code offers two signals, and it is worth being exact about what each one
 * does *not* cover:
 *
 * - `Terminal.exitStatus` is set when the **shell** exits. It says nothing
 *   about the TUI: quitting Arcturn back to a prompt leaves it `undefined`.
 *   Where it does fire, the tab is unusable and must be abandoned.
 * - `window.onDidEndTerminalShellExecution` fires when a **command** the shell
 *   ran finishes — which is precisely "the TUI exited". This is the signal
 *   that closes the hole. It needs shell integration active in that terminal,
 *   so it is absent on VS Code before 1.93 (the extension supports back to
 *   1.90) and in shells VS Code cannot instrument. It is feature-detected.
 *
 * When neither signal is available we do not guess, and we do not need to:
 * `mentions.ts` guarantees the text is inert whatever ends up reading it, so
 * the worst case degrades from command execution to a useless line at a
 * prompt. Defence in depth, with the depth stated rather than implied.
 */

import * as vscode from "vscode";
import type { CliLocation } from "./cli-resolve.js";
import { buildLaunchCommand, launchArgs } from "./launch.js";

/**
 * How long to wait after typing the launch line before typing anything else.
 *
 * The launch line has reached the shell but the TUI has not yet put the tty
 * into raw mode. Text typed into that gap is read by the shell instead — it
 * either vanishes or is echoed back as noise once Arcturn redraws. This is a
 * heuristic, and an honest one: there is no readiness signal to wait on
 * without inventing a side-channel, which RFC 0004 §0 forbids.
 */
const LAUNCH_SETTLE_MS = 700;

/**
 * The slice of `window` that only newer hosts have.
 *
 * `@types/vscode` is resolved at the latest version while `engines.vscode` is
 * `^1.90.0`, so the compiler will happily let us call an API that does not
 * exist at runtime. Restating it as optional is what forces the check.
 */
interface ShellIntegrationWindow {
  onDidEndTerminalShellExecution?: (
    listener: (event: { readonly terminal: vscode.Terminal }) => void,
  ) => vscode.Disposable;
}

/** Knobs the tests need to control; production uses the defaults. */
export interface TerminalHubOptions {
  readonly platform?: NodeJS.Platform;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The terminals this window owns. */
export interface TerminalHub {
  /** Focus this folder's Arcturn terminal, launching the engine if it is not up. */
  open(folder: vscode.WorkspaceFolder | undefined, cli: CliLocation): vscode.Terminal;
  /** Type `text` into this folder's terminal, launching and settling first if needed. */
  sendInput(
    folder: vscode.WorkspaceFolder | undefined,
    cli: CliLocation,
    text: string,
  ): Promise<void>;
  dispose(): void;
}

/**
 * What the terminal is called.
 *
 * The RFC asks for "Arcturn", and in the single-root case that is exactly
 * right. A multi-root workspace gets the folder appended, because two tabs
 * both called "Arcturn" running in different repositories is a mistake
 * waiting to happen.
 */
export function terminalName(folderName: string | undefined, multiRoot: boolean): string {
  return multiRoot && folderName !== undefined ? `Arcturn — ${folderName}` : "Arcturn";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyFor(folder: vscode.WorkspaceFolder | undefined): string {
  // A window with no folder open still gets exactly one terminal. The leading
  // space cannot collide with a real uri.
  return folder === undefined ? " no-folder" : folder.uri.toString();
}

/** A terminal we opened, and whether the engine is still the thing reading it. */
interface TerminalEntry {
  readonly terminal: vscode.Terminal;
  engineRunning: boolean;
}

export function createTerminalHub(options: TerminalHubOptions = {}): TerminalHub {
  const platform = options.platform ?? process.platform;
  const sleep = options.sleep ?? defaultSleep;
  const entries = new Map<string, TerminalEntry>();

  const closeSubscription = vscode.window.onDidCloseTerminal((closed) => {
    for (const [key, entry] of entries) {
      if (entry.terminal === closed) entries.delete(key);
    }
  });

  // Feature-detected: see ShellIntegrationWindow. Called through the window
  // object so the event keeps its `this`.
  const host = vscode.window as ShellIntegrationWindow;
  const shellSubscription =
    typeof host.onDidEndTerminalShellExecution === "function"
      ? host.onDidEndTerminalShellExecution((event) => {
          for (const entry of entries.values()) {
            // The command that finished is the engine, or something the user
            // ran after it. Either way the engine is no longer in front.
            if (entry.terminal === event.terminal) entry.engineRunning = false;
          }
        })
      : undefined;

  function createTerminal(folder: vscode.WorkspaceFolder | undefined): vscode.Terminal {
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return vscode.window.createTerminal({
      name: terminalName(folder?.name, multiRoot),
      iconPath: new vscode.ThemeIcon("sparkle"),
      cwd: folder?.uri,
    });
  }

  function launchInto(terminal: vscode.Terminal, cli: CliLocation): void {
    const model = vscode.workspace.getConfiguration("arcturn").get<string>("defaultModel");
    terminal.show();
    terminal.sendText(buildLaunchCommand(cli.command, launchArgs(model), platform), true);
  }

  /**
   * Hand back a terminal with the engine running in it, and say whether we had
   * to start it.
   *
   * `launched` drives the settle delay, and it is true for a re-launch as well
   * as a first launch: a terminal that has just been handed the launch line is
   * equally unsettled whichever way it got there.
   */
  function acquire(
    folder: vscode.WorkspaceFolder | undefined,
    cli: CliLocation,
  ): { terminal: vscode.Terminal; launched: boolean } {
    const key = keyFor(folder);
    const existing = entries.get(key);
    // The shell itself died: the tab is a corpse, not a terminal.
    if (existing !== undefined && existing.terminal.exitStatus !== undefined) {
      entries.delete(key);
    }

    const live = entries.get(key);
    if (live?.engineRunning) {
      live.terminal.show();
      return { terminal: live.terminal, launched: false };
    }

    // Either there is no terminal, or there is one sitting at a shell prompt
    // because the engine exited. Re-use the tab in the second case so the
    // user does not accumulate one per mention, but re-launch into it.
    const entry: TerminalEntry = live ?? { terminal: createTerminal(folder), engineRunning: false };
    entry.engineRunning = true;
    entries.set(key, entry);
    launchInto(entry.terminal, cli);
    return { terminal: entry.terminal, launched: true };
  }

  return {
    open(folder, cli) {
      return acquire(folder, cli).terminal;
    },
    async sendInput(folder, cli, text) {
      const { terminal, launched } = acquire(folder, cli);
      if (launched) await sleep(LAUNCH_SETTLE_MS);
      terminal.show();
      // `addNewLine: false` is the whole contract: the extension supplies the
      // tedious part of the prompt and leaves the Enter key to the human.
      terminal.sendText(text, false);
    },
    dispose() {
      closeSubscription.dispose();
      shellSubscription?.dispose();
      entries.clear();
    },
  };
}
