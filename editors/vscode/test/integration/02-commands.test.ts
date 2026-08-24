/**
 * The runtime half of `manifest.test.ts`.
 *
 * The unit test compares the manifest against a fake `vscode` whose
 * `registerCommand` is a `Map.set`. This one compares the manifest against the
 * workbench's own command registry, after a real activation — which is the
 * only version of the check that can catch a command that is contributed but
 * whose registration never ran, or one that registers under a typo'd id.
 */

import * as assert from "node:assert/strict";
import { allCommands, contributedCommands, extension, manifest } from "./helpers.js";

/** View ids VS Code synthesises `<id>.focus`-style commands for. */
function contributedViewIds(): string[] {
  return Object.values(manifest().contributes.views).flatMap((views) =>
    views.map((view) => view.id),
  );
}

describe("command registration", () => {
  before(async () => {
    await extension().activate();
  });

  it("registers every command the manifest contributes", async () => {
    const registered = new Set(await allCommands());
    const missing = contributedCommands().filter((id) => !registered.has(id));
    assert.deepEqual(
      missing,
      [],
      `These commands are in contributes.commands but are not in the workbench's registry after ` +
        `activation: ${missing.join(", ")}. Each of them appears in the command palette and fails ` +
        `with "command not found" when invoked.`,
    );
  });

  it("registers no arcturn command the manifest does not contribute", async () => {
    const contributed = new Set(contributedCommands());
    const viewPrefixes = contributedViewIds().map((id) => `${id}.`);
    const stray = (await allCommands()).filter(
      (id) =>
        id.startsWith("arcturn.") &&
        !contributed.has(id) &&
        // VS Code synthesises commands per contributed view id
        // (`arcturn.sidebar.focus` and friends). Those are the workbench's,
        // not ours, and are asserted for separately in 05-sidebar-view.
        !viewPrefixes.some((prefix) => id.startsWith(prefix)),
    );
    assert.deepEqual(
      stray,
      [],
      `These arcturn.* commands are registered at runtime but are missing from contributes.commands: ` +
        `${stray.join(", ")}. A command that is registered but not contributed works from the sidebar ` +
        `and is invisible in the command palette, which RFC 0004 §3's accessibility rule forbids.`,
    );
  });

  it("contributes every command with a category, so the palette groups them", () => {
    const uncategorised = manifest()
      .contributes.commands.filter((entry) => entry.category !== "Arcturn")
      .map((entry) => entry.command);
    assert.deepEqual(
      uncategorised,
      [],
      `These contributed commands do not carry the "Arcturn" category, so they appear in the palette ` +
        `without the prefix a user searches for: ${uncategorised.join(", ")}.`,
    );
  });
});
