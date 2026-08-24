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
 *   that closes the hole, and it is why `engines.vscode` is `^1.93.0`: the
 *   API was a *proposal* before that.
 *
 * ## `typeof` is not a capability check on VS Code
 *
 * A proposed API is not missing. On 1.90-1.92 `onDidEndTerminalShellExecution`
 * is present on `window`, `typeof` reports `"function"`, and **calling** it
 * throws `CANNOT use API proposal: terminalShellIntegration` unless the
 * manifest opted in. A `typeof` guard sails straight past that, and because
 * this hub is constructed while `activate()` is still assembling its
 * dependencies — before a single `registerCommand` — the throw did not
 * degrade one feature, it made the entire extension inert.
 *
 * So the subscription is attempted inside a `try`. The engine floor is now
 * 1.93 and that is the real fix, but forks (Cursor, Windsurf, VSCodium) and
 * future proposal churn can reproduce exactly this present-but-gated shape,
 * and total activation failure is the worst available response to losing an
 * *optional* signal.
 *
 * ## What we do when the signal is missing
 *
 * We do not fall back to "assume the engine is live" — that is precisely the
 * assumption the signal was added to remove. Liveness becomes `"unknown"`,
 * and the two operations are treated differently because their risks differ:
 *
 * - `open` only focuses a terminal. It types nothing, so it has nothing to
 *   prove, and re-launching there would submit a junk prompt to a live TUI
 *   every time the keybinding is pressed.
 * - `sendInput` types. That is the operation that was exploitable, so it
 *   re-launches and settles first, and never types into a terminal it cannot
 *   vouch for. On a signal-less host that costs one junk prompt per mention
 *   if the engine was in fact still running — loud, visible, and cheap next
 *   to typing at a shell prompt.
 *
 * `mentions.ts` independently guarantees the text is inert whatever reads it.
 * That is the second layer, not the excuse for skipping this one.
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
 * The slice of `window` a host may not honour.
 *
 * `@types/vscode` resolves to the latest version regardless of what
 * `engines.vscode` promises, so the compiler will happily let us call an API
 * the running editor refuses. Restating it as optional is what forces a
 * guard; the `try` around the call is what makes the guard sufficient.
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

/**
 * What we know about whether the engine is still reading a terminal.
 *
 * `"unknown"` is a first-class answer, not a synonym for `"running"`. It is
 * what an honest hub reports on a host that gives it no signal.
 */
type EngineLiveness = "running" | "exited" | "unknown";

/** A terminal we opened, and what we know about the engine inside it. */
interface TerminalEntry {
  readonly terminal: vscode.Terminal;
  liveness: EngineLiveness;
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

  // Called through the window object so the event keeps its `this`, and
  // inside a `try` because `typeof` cannot tell a live API from a gated one.
  const host = vscode.window as ShellIntegrationWindow;
  let shellSubscription: vscode.Disposable | undefined;
  let livenessObservable = false;
  if (typeof host.onDidEndTerminalShellExecution === "function") {
    try {
      shellSubscription = host.onDidEndTerminalShellExecution((event) => {
        for (const entry of entries.values()) {
          // The command that finished is the engine, or something the user
          // ran after it. Either way the engine is no longer in front.
          if (entry.terminal === event.terminal) entry.liveness = "exited";
        }
      });
      livenessObservable = true;
    } catch {
      // A host that has the property but refuses the call. Losing the signal
      // is survivable; failing to activate is not. `sendInput` compensates by
      // never trusting a terminal it did not just launch.
      shellSubscription = undefined;
      livenessObservable = false;
    }
  }

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
   * Hand back a terminal for this folder, and say whether we had to launch the
   * engine into it.
   *
   * `launched` drives the settle delay, and it is true for a re-launch as well
   * as a first launch: a terminal that has just been handed the launch line is
   * equally unsettled whichever way it got there.
   *
   * @param mustBeLive - True when the caller is about to type into it. An
   *   `"unknown"` terminal is good enough to focus and not good enough to
   *   type into; see the module doc.
   */
  function acquire(
    folder: vscode.WorkspaceFolder | undefined,
    cli: CliLocation,
    mustBeLive: boolean,
  ): { terminal: vscode.Terminal; launched: boolean } {
    const key = keyFor(folder);
    const existing = entries.get(key);
    // The shell itself died: the tab is a corpse, not a terminal.
    if (existing !== undefined && existing.terminal.exitStatus !== undefined) {
      entries.delete(key);
    }

    const live = entries.get(key);
    const reusable =
      live !== undefined &&
      (live.liveness === "running" || (live.liveness === "unknown" && !mustBeLive));
    if (reusable && live !== undefined) {
      live.terminal.show();
      return { terminal: live.terminal, launched: false };
    }

    // Either there is no terminal, or there is one we cannot vouch for. Re-use
    // the tab in the second case so the user does not accumulate one per
    // mention, but re-launch into it.
    const entry: TerminalEntry = live ?? { terminal: createTerminal(folder), liveness: "unknown" };
    // Only claim "running" where something could tell us otherwise later.
    entry.liveness = livenessObservable ? "running" : "unknown";
    entries.set(key, entry);
    launchInto(entry.terminal, cli);
    return { terminal: entry.terminal, launched: true };
  }

  return {
    open(folder, cli) {
      return acquire(folder, cli, false).terminal;
    },
    async sendInput(folder, cli, text) {
      const { terminal, launched } = acquire(folder, cli, true);
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
