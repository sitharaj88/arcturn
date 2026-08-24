/**
 * The HIGH-severity fix, watched running in a real editor.
 *
 * `mentions.ts` refuses to build a mention for a filename whose characters a
 * terminal would act on, rather than quoting or stripping them. That rule has
 * unit tests, but every one of them calls `buildMentionInput` directly — none
 * of them watches the extension decline to type into an actual terminal.
 *
 * The observation channel is the awkward part and is worth stating plainly:
 * VS Code's stable API offers an extension no way to read back what
 * `Terminal.sendText` sent. So the stand-in engine is a program that puts the
 * tty in raw mode and appends every byte it receives to a file, and the test
 * reads that file. That is a real pty, a real shell, and the real
 * `sendText` path — the only thing standing in for the engine is the process
 * on the far end.
 *
 * The two positive controls come first on purpose. "The log contains no
 * injection" is worthless if the log is broken; it becomes evidence only once
 * a benign mention has been seen arriving through the same channel.
 */

import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  ensureTerminalReady,
  fixtureEnv,
  openInEditor,
  settle,
  terminalBytes,
  waitUntil,
  workspaceRoot,
} from "./helpers.js";

/** How long a send that *should* land is given before it counts as lost. */
const SEND_TIMEOUT_MS = 20_000;

/**
 * How long a send that should *not* happen is watched for.
 *
 * Generous on purpose: the failure this guards against is bytes arriving
 * late, which a short window would call a pass.
 */
const REFUSAL_WATCH_MS = 5_000;

const PLAIN = fixtureEnv("ARCTURN_IT_FILE_PLAIN");
const QUOTED = fixtureEnv("ARCTURN_IT_FILE_QUOTED");
const HOSTILE = fixtureEnv("ARCTURN_IT_FILE_HOSTILE");
const MARKER = fixtureEnv("ARCTURN_IT_INJECTION_MARKER");

function quoteForMessage(value: string): string {
  return JSON.stringify(value);
}

describe("mentions typed into a real terminal", () => {
  before(async () => {
    await ensureTerminalReady();
  });

  it("types a plain mention into the terminal (and proves the terminal can be read back)", async () => {
    await openInEditor(join(workspaceRoot(), PLAIN));
    await vscode.commands.executeCommand("arcturn.sendFile");
    const expected = `@${PLAIN} `;
    await waitUntil(
      `the Arcturn terminal to receive ${quoteForMessage(expected)}`,
      () => terminalBytes().includes(expected),
      () =>
        `the engine's stdin has received ${quoteForMessage(terminalBytes())} so far. If this is empty, ` +
        "nothing in this file can be trusted: the observation channel itself is broken, and the refusal " +
        "test below would pass for the wrong reason.",
      SEND_TIMEOUT_MS,
    );
  });

  it("quotes a shell-special but legal filename rather than refusing it", async () => {
    await openInEditor(join(workspaceRoot(), QUOTED));
    await vscode.commands.executeCommand("arcturn.sendFile");
    const expected = `@"${QUOTED}" `;
    await waitUntil(
      `the Arcturn terminal to receive ${quoteForMessage(expected)}`,
      () => terminalBytes().includes(expected),
      () =>
        `the engine's stdin has received ${quoteForMessage(terminalBytes())}. A name containing a space ` +
        "and parentheses is inert inside double quotes, so mentions.ts is supposed to quote it — " +
        "refusing it would break ordinary filenames, and sending it bare would let the shell glob it.",
      SEND_TIMEOUT_MS,
    );
  });

  it("carries the selected line range", async () => {
    const editor = await openInEditor(join(workspaceRoot(), PLAIN));
    editor.selection = new vscode.Selection(1, 0, 2, 5);
    await vscode.commands.executeCommand("arcturn.sendSelection");
    const expected = `@${PLAIN}:2-3 `;
    await waitUntil(
      `the Arcturn terminal to receive ${quoteForMessage(expected)}`,
      () => terminalBytes().includes(expected),
      () =>
        `the engine's stdin has received ${quoteForMessage(terminalBytes())}. A selection from line 2 ` +
        "col 0 to line 3 col 5 is lines 2-3 as a human counts them.",
      SEND_TIMEOUT_MS,
    );
  });

  it("refuses to type anything for a filename built to inject a shell command", async () => {
    const hostilePath = join(workspaceRoot(), HOSTILE);
    assert.ok(
      existsSync(hostilePath),
      `The fixture file named ${quoteForMessage(HOSTILE)} is not on disk, so this test proved nothing. ` +
        "The filesystem may have refused the name; see TESTING.md.",
    );
    const markerPath = join(workspaceRoot(), MARKER);
    const before = terminalBytes();

    await openInEditor(hostilePath);
    await vscode.commands.executeCommand("arcturn.sendFile");
    await settle(REFUSAL_WATCH_MS);

    const delta = terminalBytes().slice(before.length);
    const offenders = ['"', ";"].filter((character) => delta.includes(character));
    assert.deepEqual(
      offenders,
      [],
      `Arcturn typed ${offenders.join(" and ")} into the terminal after being asked to mention a file ` +
        `named ${quoteForMessage(HOSTILE)}. Those characters end a quoted word and end a shell ` +
        `statement; if the engine is not the thing reading that terminal, the rest of the filename runs ` +
        `as a command. What arrived: ${quoteForMessage(delta)}.`,
    );
    assert.equal(
      delta.includes("touch"),
      false,
      `The payload embedded in the filename reached the terminal: ${quoteForMessage(delta)}.`,
    );
    assert.equal(
      existsSync(markerPath),
      false,
      `${markerPath} exists, which means the command embedded in the filename actually executed. ` +
        "This is the exact HIGH-severity bug mentions.ts was written to close.",
    );
  });

  it("is still working after the refusal", async () => {
    // A refusal that wedges the extension is not a fix. The same command that
    // worked at the top of this file has to still work at the bottom of it.
    await openInEditor(join(workspaceRoot(), PLAIN));
    const before = terminalBytes();
    await vscode.commands.executeCommand("arcturn.sendFile");
    await waitUntil(
      "a normal mention to work again after a hostile filename was refused",
      () => terminalBytes().slice(before.length).includes(`@${PLAIN} `),
      () =>
        "nothing new reached the terminal. The refusal path is supposed to warn and return, leaving the " +
        "terminal and the provisioner untouched.",
      SEND_TIMEOUT_MS,
    );
  });
});
