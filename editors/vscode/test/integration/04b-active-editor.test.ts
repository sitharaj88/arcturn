/**
 * Ambient awareness, watched in a real editor with a real selection.
 *
 * Two claims live here that no unit test can reach, and one that no test can
 * reach at all — said plainly rather than faked.
 *
 * **The activation budget survives the feature.** The panel now subscribes to
 * `onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection` and
 * `onDidCloseTextDocument`, and those subscriptions are registered by
 * `activateSidebar`, which runs during `activate()`. A handler that reached for
 * `withEngine` — the obvious way to write it — would spawn `arcturn serve` the
 * first time anybody opened a file, long before they opened the panel. So this
 * file opens files, drags selections around and closes them, and then reads the
 * stand-in engine's spawn log. It has to run before `05-sidebar-view`, which
 * deliberately spends that budget.
 *
 * **The toggle is real.** `arcturn.toggleActiveEditorContext` writes
 * `arcturn.context.activeEditor` through VS Code's own configuration API, and
 * this reads it back through the same API — the round trip the unit suite can
 * only assert against a fake.
 *
 * What is **not** here: the chip. VS Code gives an extension no way to read a
 * webview's document, so what the panel renders for the file opened below is
 * `webview-render.test.ts`'s claim against a stub DOM, and the `resolveContext`
 * round trip behind it needs a real engine. See TESTING.md.
 */

import * as assert from "node:assert/strict";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  describeSpawns,
  fixtureEnv,
  openInEditor,
  settle,
  spawnRecords,
  waitUntil,
  workspaceRoot,
} from "./helpers.js";

const SETTING = "context.activeEditor";
const PLAIN_NAME = fixtureEnv("ARCTURN_IT_FILE_PLAIN");

/** The fixture file, as a path in the workspace VS Code actually opened. */
function plainFile(): string {
  return join(workspaceRoot(), PLAIN_NAME);
}

/** The setting as VS Code resolves it right now, defaults included. */
function watching(): boolean {
  return vscode.workspace.getConfiguration("arcturn").get<boolean>(SETTING, true);
}

describe("the file the panel is looking at", () => {
  after(async () => {
    // Whatever this file wrote must not reach 05 and 06, which activate the
    // same extension in the same window.
    await vscode.workspace
      .getConfiguration("arcturn")
      .update(SETTING, undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("is on by default, because the panel's own starter prompts assume it", () => {
    // "Explain what the file I have open does" is a button this extension
    // ships. Off by default, it is a button that asks the model about a file
    // it was never told, and gets a confident answer about nothing.
    assert.equal(
      watching(),
      true,
      "arcturn.context.activeEditor resolved false with nothing set. The manifest default is `true`; " +
        "if it is not, the four starter prompts in the panel have no file to be about.",
    );
  });

  it("spawns nothing when a file is opened, selected in, and closed", async () => {
    const before = spawnRecords().length;
    const editor = await openInEditor(plainFile());

    // A real selection, moved twice — the event that fires per keystroke and
    // is therefore the one that would be expensive if it reached the engine.
    editor.selection = new vscode.Selection(0, 0, 0, 3);
    await settle(100);
    editor.selection = new vscode.Selection(0, 0, 2, 0);
    await settle(100);
    // Past the debounce, so the tracker has actually settled rather than
    // merely not fired yet.
    await settle(500);

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await settle(500);

    assert.equal(
      spawnRecords().length,
      before,
      "Opening a file and moving the caret in it executed the arcturn binary. The editor listeners " +
        "must never start the engine — RFC 0004 §3 says nothing spawns until the user opens the " +
        `sidebar or runs a command, and opening a file is neither. Observed: ${describeSpawns()}.`,
    );
  });

  it("is turned off, and back on, by the command that says so", async () => {
    await vscode.commands.executeCommand("arcturn.toggleActiveEditorContext");
    await waitUntil(
      "arcturn.context.activeEditor to read false after the toggle command",
      () => watching() === false,
      () =>
        `the setting still reads ${String(watching())}. The command writes it through ` +
        "WorkspaceConfiguration.update; if the write landed in a scope an existing narrower one " +
        "overrides, the control would visibly do nothing.",
      10_000,
    );

    await vscode.commands.executeCommand("arcturn.toggleActiveEditorContext");
    await waitUntil(
      "arcturn.context.activeEditor to read true again",
      () => watching() === true,
      () => `the setting reads ${String(watching())} after a second toggle.`,
      10_000,
    );
  });

  it("still spawns nothing while the watching is switched off", async () => {
    const before = spawnRecords().length;
    await vscode.commands.executeCommand("arcturn.toggleActiveEditorContext");
    await settle(200);
    const editor = await openInEditor(plainFile());
    editor.selection = new vscode.Selection(0, 0, 1, 0);
    await settle(500);
    assert.equal(
      spawnRecords().length,
      before,
      `Toggling the setting started the engine. Observed: ${describeSpawns()}.`,
    );
  });
});
