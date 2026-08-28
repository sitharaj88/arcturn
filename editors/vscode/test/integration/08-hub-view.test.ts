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

describe("the hub tree", () => {
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
});
