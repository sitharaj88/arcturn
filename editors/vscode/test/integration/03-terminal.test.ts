/**
 * RFC 0004 §1: "`Arcturn: Open` launches the TUI in a dedicated terminal
 * (icon, name "Arcturn"). One terminal per workspace folder; re-invoking
 * focuses the existing one."
 *
 * The unit tests assert this against a fake `window.createTerminal` that
 * returns an object literal. Here the terminal is a real pty with a real
 * shell in it, and "the engine launched" is observed from the other end: the
 * stand-in binary records that it was executed. That distinction matters —
 * the launch is typed as a *shell command*, so quoting, cwd and PATH all have
 * to be right for it to happen at all, and none of that is exercised by a
 * fake.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  arcturnTerminals,
  describeSpawns,
  describeTerminals,
  ensureTerminalReady,
  SINGLE_ROOT_TERMINAL_NAME,
  spawnRecords,
  workspaceRoot,
} from "./helpers.js";

describe("terminal integration", () => {
  it("opens one terminal and actually launches the engine in it", async () => {
    const terminal = await ensureTerminalReady();
    assert.equal(
      terminal.name,
      SINGLE_ROOT_TERMINAL_NAME,
      `The Arcturn terminal is named "${terminal.name}". A single-root workspace is supposed to get ` +
        `exactly "${SINGLE_ROOT_TERMINAL_NAME}" — the folder suffix is only for multi-root windows.`,
    );
    assert.equal(
      arcturnTerminals().length,
      1,
      `arcturn.open produced ${arcturnTerminals().length} Arcturn terminals for one folder. ${describeTerminals()}.`,
    );
  });

  it("resolves the engine through arcturn.cliPath and version-probes it exactly once", () => {
    const probes = spawnRecords().filter((record) => record.argv[0] === "--version");
    assert.equal(
      probes.length,
      1,
      `The engine was version-probed ${probes.length} times in one window. cli.ts caches the resolution ` +
        `in \`pending\` precisely so this is one; more than one means the cache stopped working and every ` +
        `mention now pays for a child process. Observed: ${describeSpawns()}.`,
    );
  });

  it("types the launch line with no arguments when arcturn.defaultModel is unset", () => {
    const launches = spawnRecords().filter((record) => record.argv[0] !== "--version");
    assert.ok(
      launches.length >= 1,
      `The engine was never launched as a TUI. Observed: ${describeSpawns()}.`,
    );
    assert.deepEqual(
      launches[0]?.argv,
      [],
      `The TUI was launched as \`arcturn ${launches[0]?.argv.join(" ")}\`. With arcturn.defaultModel ` +
        `empty, launchArgs() is supposed to add nothing at all so the engine uses its own ~/.arcturn default.`,
    );
  });

  it("does not create a second terminal when Arcturn: Open is invoked again", async () => {
    const before = arcturnTerminals().length;
    await vscode.commands.executeCommand("arcturn.open");
    await vscode.commands.executeCommand("arcturn.open");
    assert.equal(
      arcturnTerminals().length,
      before,
      `Invoking arcturn.open three times left ${arcturnTerminals().length} Arcturn terminals open. ` +
        `The hub keys terminals by workspace folder and is supposed to focus the existing tab. ` +
        `${describeTerminals()}.`,
    );
  });

  it("runs the terminal in the workspace folder", async () => {
    const terminal = await ensureTerminalReady();
    const cwd = (terminal.creationOptions as vscode.TerminalOptions).cwd;
    const asPath = typeof cwd === "string" ? cwd : cwd?.fsPath;
    assert.equal(
      asPath,
      workspaceRoot(),
      `The Arcturn terminal was created with cwd ${String(asPath)}, not the workspace folder ` +
        `${workspaceRoot()}. The engine resolves mentions relative to its cwd, so a wrong cwd makes ` +
        `every relative mention point at a file that is not there.`,
    );
  });
});
