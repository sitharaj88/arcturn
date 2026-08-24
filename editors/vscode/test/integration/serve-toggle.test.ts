/**
 * `arcturn.serve.enabled`, flipped in a running window.
 *
 * This was a real bug: the sidebar was started once at activation and the
 * setting was never watched, so turning it on required a window reload and
 * turning it off left a loopback listener holding a live token. The fix is the
 * `onDidChangeConfiguration` listener in `extension.ts`. Its unit test drives a
 * fake `workspace.onDidChangeConfiguration`, which can only prove the listener
 * is wired to the function — not that VS Code delivers the event, that the
 * `when` clauses re-evaluate, or that the six commands actually appear.
 *
 * It runs in its own VS Code launch, against its own workspace, because the
 * claim under test is about what is true *at activation*: the setting has to
 * already be false when `activate()` runs, and a setting cannot be both.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  allCommands,
  describeSpawns,
  extension,
  serveGatedCommands,
  spawnRecords,
  waitUntil,
} from "./helpers.js";

/** Spawns recorded by the previous launch's tests; only new ones matter here. */
let spawnBaseline = 0;

async function registeredServeCommands(): Promise<string[]> {
  const registered = new Set(await allCommands());
  return serveGatedCommands().filter((id) => registered.has(id));
}

async function setServeEnabled(value: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update("arcturn.serve.enabled", value, vscode.ConfigurationTarget.Workspace);
}

describe("arcturn.serve.enabled, flipped live", () => {
  before(async () => {
    spawnBaseline = spawnRecords().length;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  after(async () => {
    await setServeEnabled(false);
  });

  it("starts this window with the setting off", () => {
    assert.equal(
      vscode.workspace.getConfiguration("arcturn").get<boolean>("serve.enabled"),
      false,
      "The workspace this launch opened was supposed to carry arcturn.serve.enabled = false in its " +
        ".vscode/settings.json. Without that, nothing below is testing what it claims to test.",
    );
    assert.ok(
      serveGatedCommands().length > 0,
      "No command in the manifest is gated on config.arcturn.serve.enabled, so this test has nothing " +
        "to look for. The gate moved, or the palette entries were removed.",
    );
  });

  it("registers none of the serve-gated commands when the setting is off at activation", async () => {
    // Same cheap activation as 01-activation: reaches the handler, resolves no
    // CLI, spawns nothing.
    await vscode.commands.executeCommand("arcturn.sendFile");
    await waitUntil(
      "the extension to activate",
      () => extension().isActive,
      () => "the extension is still inactive after a contributed command was invoked.",
      15_000,
    );

    const present = await registeredServeCommands();
    assert.deepEqual(
      present,
      [],
      `With arcturn.serve.enabled off, these sidebar commands are registered anyway: ${present.join(", ")}. ` +
        "The setting is supposed to keep src/sidebar/ from being imported at all, so nothing it owns exists.",
    );

    const registered = new Set(await allCommands());
    assert.ok(
      registered.has("arcturn.open"),
      "Turning the sidebar off also took the terminal integration with it: arcturn.open is not " +
        "registered. Stage 1 is the front-end that always has to work.",
    );
  });

  it("registers them when the setting is turned on, with no window reload", async () => {
    await setServeEnabled(true);
    let lastSeen: string[] = [];
    await waitUntil(
      `all ${serveGatedCommands().length} sidebar commands to appear after arcturn.serve.enabled was turned on`,
      async () => {
        lastSeen = await registeredServeCommands();
        return lastSeen.length === serveGatedCommands().length;
      },
      () =>
        `only ${lastSeen.length} of ${serveGatedCommands().length} appeared (${lastSeen.join(", ") || "none"}). ` +
        "The command palette re-evaluates its `when` clauses the moment the setting changes, so a user " +
        'sees six new entries that all fail with "command not found" until the window is reloaded — ' +
        "which is the bug the onDidChangeConfiguration listener exists to prevent.",
      20_000,
    );
  });

  it("removes them again when the setting is turned back off", async () => {
    await setServeEnabled(false);
    await waitUntil(
      "the sidebar commands to disappear after arcturn.serve.enabled was turned off",
      async () => (await registeredServeCommands()).length === 0,
      () =>
        "the sidebar commands are still registered. Turning the setting off is a request to stop " +
        "running a server; a request honoured only at the next window reload leaves a loopback listener " +
        "holding a live token that the user believes they switched off.",
      20_000,
    );
  });

  it("spawned nothing through any of it", () => {
    const spawnedHere = spawnRecords().slice(spawnBaseline);
    assert.deepEqual(
      spawnedHere,
      [],
      `Toggling the setting executed the arcturn binary: ${describeSpawns()}. Registering the sidebar's ` +
        "commands is not the same as connecting to an engine — the engine starts when the view is " +
        "opened or a command needs it, never before.",
    );
  });
});
