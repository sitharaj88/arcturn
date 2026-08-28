/**
 * The hub tree, in a real workbench.
 *
 * `tree.test.ts` proves the model: what counts as installed, which sections a
 * kit shows, what a lane means. None of that establishes that VS Code knows
 * the view exists, which is a different kind of claim and one only an editor
 * can answer — a view id that does not match the manifest yields a container
 * that opens to nothing, with no error anywhere to explain it.
 *
 * The other claim here is about cost. The catalog is bundled precisely so the
 * hub can be browsed without an engine or a network, and this is where that
 * gets checked rather than asserted: revealing the tree must not spawn
 * `arcturn serve`, and must not reach a host.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { allCommands, describeSpawns, manifest, spawnRecords } from "./helpers.js";

describe("the sidebar's trees", () => {
  it("is contributed as a view the workbench knows by id", async () => {
    const views = manifest().contributes.views.arcturn ?? [];
    assert.ok(
      views.some((view) => view.id === "arcturn.hub"),
      "the manifest does not contribute arcturn.hub",
    );
    // The workbench synthesises `<id>.focus` for every view it has registered,
    // which is the only stable way to ask "do you know this view?".
    const commands = await allCommands();
    assert.ok(
      commands.includes("arcturn.hub.focus"),
      "the workbench has no focus command for arcturn.hub",
    );
  });

  it("registers its three commands", async () => {
    const commands = await allCommands();
    for (const id of ["arcturn.hub.refresh", "arcturn.hub.install", "arcturn.hub.openOnWeb"]) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });

  it("opens without starting an engine, because the catalog is bundled", async () => {
    const before = spawnRecords().length;
    await vscode.commands.executeCommand("arcturn.hub.focus");
    await vscode.commands.executeCommand("arcturn.hub.refresh");

    const spawned = spawnRecords().slice(before);
    assert.deepEqual(spawned, [], `browsing the hub spawned something: ${describeSpawns()}`);
  });

  it("contributes the background view and its four commands", async () => {
    const views = manifest().contributes.views.arcturn ?? [];
    assert.ok(
      views.some((view) => view.id === "arcturn.background"),
      "the manifest does not contribute arcturn.background",
    );
    const commands = await allCommands();
    assert.ok(commands.includes("arcturn.background.focus"), "the workbench has no focus command");
    for (const id of [
      "arcturn.background.start",
      "arcturn.background.cancel",
      "arcturn.background.adopt",
      "arcturn.background.refresh",
    ]) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });

  it("lists background agents without starting an engine to ask", async () => {
    // The regression this exists to prevent, and one only a real workbench
    // could have shown: the background tree refreshes at activation, and a
    // refresh that reached for the engine would spend the activation budget
    // `01-activation` asserts is unspent. `undefined` — "I could not ask" — is
    // the right answer before anything is connected.
    const before = spawnRecords().length;
    await vscode.commands.executeCommand("arcturn.background.focus");
    await vscode.commands.executeCommand("arcturn.background.refresh");

    const spawned = spawnRecords().slice(before);
    assert.deepEqual(
      spawned,
      [],
      `listing background agents spawned something: ${describeSpawns()}`,
    );
  });
});
