/**
 * RFC 0004 §3: "no protocol connection, no server spawn, until the user opens
 * the sidebar or runs a command."
 *
 * This file has to run first and it has to run against a cold extension host,
 * because the only way to prove activation costs nothing is to look at a
 * machine where nothing has happened yet. Everything downstream — the terminal,
 * the sidebar, the engine — leaves traces in the same fixture log, so once any
 * of it has run this observation is no longer available.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  allCommands,
  describeSpawns,
  describeTerminals,
  extension,
  manifest,
  spawnRecords,
  waitUntil,
} from "./helpers.js";

describe("activation", () => {
  before(async () => {
    // A restored editor would change what `arcturn.sendFile` does below, and
    // the point of using it is that it reaches the handler and stops there.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("is loaded by VS Code under its published id, and is not active yet", () => {
    const arcturn = extension();
    assert.deepEqual(
      manifest().activationEvents,
      [],
      "activationEvents is supposed to be empty, so that activation is driven by the contributed " +
        "commands and views rather than by a wildcard. It is not empty in the manifest the running " +
        "editor loaded.",
    );
    assert.equal(
      arcturn.isActive,
      false,
      "The extension was already active before any test asked for it. Something in the manifest is " +
        "activating eagerly (a '*' activation event, or a view that is open on a fresh profile), which " +
        "means the activation-cost claim below cannot be observed.",
    );
  });

  it("activates when a contributed command is invoked", async () => {
    // `arcturn.sendFile` with no editor open is the cheapest command in the
    // extension: it reaches the handler, finds nothing to send, tells the user
    // so, and returns without resolving the CLI. Activation is the only side
    // effect, which is exactly what this file needs.
    await vscode.commands.executeCommand("arcturn.sendFile");
    await waitUntil(
      "the extension to become active after a contributed command was invoked",
      () => extension().isActive,
      () =>
        "the command resolved but vscode.extensions.getExtension(...).isActive is still false. With " +
        "activationEvents empty, VS Code activates on the implicit onCommand event for a contributed " +
        "command; if that stopped working, no command in this extension would ever run from a cold start.",
      15_000,
    );
    const commands = await allCommands();
    assert.ok(
      commands.includes("arcturn.open"),
      "The extension reports itself active, but arcturn.open is not registered with the workbench. " +
        "activate() returned without wiring its commands.",
    );
  });

  it("spawns no process merely by activating", () => {
    assert.deepEqual(
      spawnRecords(),
      [],
      "Activating the extension executed the arcturn binary. RFC 0004 §3 says nothing is spawned and " +
        `no socket is opened until the user opens the sidebar or runs a command. Observed: ${describeSpawns()}.`,
    );
  });

  it("opens no terminal merely by activating", () => {
    const arcturnTabs = vscode.window.terminals.filter((terminal) =>
      terminal.name.startsWith("Arcturn"),
    );
    assert.deepEqual(
      arcturnTabs.map((terminal) => terminal.name),
      [],
      `Activation created a terminal. ${describeTerminals()}. The terminal is supposed to appear only ` +
        "when a command that needs it is invoked.",
    );
  });
});
