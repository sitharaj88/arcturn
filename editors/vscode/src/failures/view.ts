/**
 * Watching for commands that failed, and offering to ask about them.
 *
 * `model.ts` owns the judgements — which failures are worth mentioning, how
 * much output to carry, what the prompt says. This owns the subscription, the
 * status bar item, and one deliberately quiet piece of behaviour.
 *
 * ## Quiet on purpose
 *
 * A notification per failed command would be unbearable within a morning, and
 * a feature people mute is a feature that misses the failure that mattered.
 * So a failure lights a **status bar item** and nothing else: visible if you
 * look, silent if you do not, and gone the moment the next command succeeds.
 * The prompt is only built when somebody clicks it.
 *
 * ## The signal is optional, and its absence is not an error
 *
 * `onDidEndTerminalShellExecution` needs shell integration, which the user's
 * shell may not have. `terminal.ts` already documents why the subscription is
 * attempted inside a `try` rather than guarded with `typeof` — a proposed API
 * is present and throws when called. The same care applies here, and the
 * failure mode is losing one convenience rather than breaking activation.
 */

import * as vscode from "vscode";
import {
  type CommandFailure,
  failureLabel,
  failurePrompt,
  isWorthOffering,
  MAX_OUTPUT_CHARS,
} from "./model.js";

/** Command ids this module registers. */
export const FAILURE_COMMANDS = {
  ask: "arcturn.askAboutFailure",
} as const;

/** What this needs from the rest of the extension. */
export interface FailureHost {
  /** Put a question in front of the user, in the chat panel. */
  ask(prompt: string): Promise<void>;
  /** Report that the signal is unavailable, once. */
  warn(message: string): void;
}

/**
 * Watch terminals for failing commands.
 *
 * @returns A disposable that removes the subscription and the status item.
 */
export function activateFailureWatch(
  context: vscode.ExtensionContext,
  host: FailureHost,
): vscode.Disposable {
  let last: CommandFailure | undefined;

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  item.command = FAILURE_COMMANDS.ask;
  item.hide();

  const show = (failure: CommandFailure): void => {
    last = failure;
    item.text = `$(warning) ${failureLabel(failure, 32)}`;
    item.tooltip = `Ask Arcturn about: ${failure.command}`;
    item.show();
  };
  const clear = (): void => {
    last = undefined;
    item.hide();
  };

  const disposables: vscode.Disposable[] = [
    item,
    vscode.commands.registerCommand(FAILURE_COMMANDS.ask, async () => {
      if (last === undefined) {
        void vscode.window.showInformationMessage("No command has failed since the last success.");
        return;
      }
      const failure = last;
      // Cleared before asking, not after: the question is now in the panel and
      // a status item still offering it would invite asking twice.
      clear();
      await host.ask(failurePrompt(failure));
    }),
  ];

  try {
    disposables.push(
      vscode.window.onDidEndTerminalShellExecution(async (event) => {
        const command = event.execution.commandLine.value;
        if (!isWorthOffering({ command, exitCode: event.exitCode })) {
          // A success clears a previous failure. Leaving it up after the user
          // fixed the thing themselves is an offer to explain history.
          if (event.exitCode === 0) clear();
          return;
        }
        show({
          command,
          exitCode: event.exitCode ?? 1,
          ...(event.execution.cwd === undefined ? {} : { cwd: event.execution.cwd.fsPath }),
          output: await readOutput(event.execution),
          at: Date.now(),
        });
      }),
    );
  } catch {
    // Shell integration is unavailable — an older host, a fork, or a shell
    // without it. One convenience is lost and everything else still works,
    // which is why this is a warning rather than a throw. See `terminal.ts`
    // for why a `typeof` guard would not have caught it.
    host.warn(
      "Arcturn: terminal shell integration is unavailable, so failed commands will not be offered.",
    );
  }

  const disposable = new vscode.Disposable(() => {
    for (const entry of disposables.splice(0)) entry.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/**
 * Read what a command printed, if the shell captured it.
 *
 * Bounded while reading rather than after: `read()` is a stream over a pty,
 * and a command that printed a gigabyte should not be assembled in memory
 * first and trimmed second. Everything after the cap is dropped as it arrives,
 * which loses the *start* — and the start is the part `tailOf` would have
 * dropped anyway.
 */
async function readOutput(
  execution: vscode.TerminalShellExecution,
  max = MAX_OUTPUT_CHARS * 2,
): Promise<string> {
  try {
    const chunks: string[] = [];
    let size = 0;
    for await (const chunk of execution.read()) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > max && chunks.length > 1) {
        size -= (chunks.shift() ?? "").length;
      }
    }
    return chunks.join("");
  } catch {
    // A shell that reports exit codes but not output. The prompt says so
    // rather than pretending the command was silent.
    return "";
  }
}
