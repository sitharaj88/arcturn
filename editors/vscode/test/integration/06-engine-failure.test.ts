/**
 * The failure a user actually hits, followed all the way to something they can
 * read.
 *
 * On a GUI-launched macOS or Linux editor the extension inherits `launchd`'s
 * (or the desktop session's) environment, not the user's shell — so
 * `arcturn serve` starts with no `ANTHROPIC_API_KEY`, resolves its model,
 * refuses, prints two lines to stderr and exits before it binds anything. The
 * extension used to answer that with silence: a model picker that never
 * opened, a sidebar card that said only "The Arcturn engine stopped", and an
 * Output channel nobody was told about. The user's report was "I can't select
 * a model".
 *
 * The stand-in engine in `test/support/fixtures.mjs` reproduces exactly that
 * shape — two stderr lines, a non-zero exit, no address. Simulating the
 * *failure* is honest in a way that simulating the protocol would not be:
 * nothing here fakes a wire message, and the extension is running its real
 * supervisor against a real child process that really does die.
 *
 * ## What is observable, and what is not
 *
 * VS Code's stable API offers no way to read a webview view's DOM from another
 * extension, and no way to read back a notification. So the *card* and the
 * *toast* are covered by unit tests (`sidebar/connection-card.test.ts`,
 * `sidebar/index.test.ts`) and are not asserted here.
 *
 * What is observable is the Output channel: showing one opens a document with
 * the `output:` scheme, and `vscode.workspace.textDocuments` carries it with
 * its text. That is the surface the card's *Show Log* button and the
 * `Arcturn: Show Log` command both point at, so following the engine's words
 * into it is following them to a place a user genuinely reaches — and it is
 * where the two security claims can be checked against a real run rather than
 * a fake.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { fixtureEnv, spawnRecords, waitFor } from "./helpers.js";

/** The Arcturn output channel, once `Arcturn: Show Log` has opened it. */
function logDocument(): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === "output" && document.uri.path.includes("Arcturn Sidebar"),
  );
}

function describeDocuments(): string {
  const seen = vscode.workspace.textDocuments.map((document) => document.uri.toString());
  return seen.length === 0 ? "no documents are open" : seen.join(", ");
}

/** Everything the extension has written to its Output channel so far. */
async function logText(): Promise<string> {
  await vscode.commands.executeCommand("arcturn.showLog");
  const document = await waitFor(
    "the Arcturn Sidebar output channel to open",
    () => logDocument(),
    () =>
      `no document with the output: scheme and "Arcturn Sidebar" in its path. Open documents: ` +
      `${describeDocuments()}. Showing an OutputChannel is what materialises it as a document, so ` +
      "this fails when arcturn.showLog is not registered or does not call show().",
    20_000,
  );
  return document.getText();
}

describe("the engine refusing to start", () => {
  let log = "";

  before(async () => {
    // 05 already revealed the view, which is what started the engine. If it
    // has not run, reveal it here so this file stands on its own.
    await vscode.commands.executeCommand("arcturn.sidebar.focus");
    await waitFor(
      "the sidebar to have tried to start arcturn serve",
      () => spawnRecords().find((record) => record.argv[0] === "serve"),
      () => "no serve invocation was recorded at all, so there is no failure to surface.",
      30_000,
    );
    log = await waitFor(
      "the engine's refusal to reach the Arcturn Sidebar output channel",
      async () => {
        const text = await logText();
        return text.includes("could not start") ? text : undefined;
      },
      () => "the output channel never carried the failure.",
      30_000,
    );
  });

  it("carries the engine's own words into the log, verbatim and complete", () => {
    // Both lines, not just the first: the extension has to move a block of the
    // child's stderr, and a one-line summary would drop the half that tells
    // the user what to do about it.
    for (const line of fixtureEnv("ARCTURN_IT_SERVE_STDERR").split("\n")) {
      assert.ok(
        log.includes(line),
        `The Arcturn log does not contain the line the engine actually wrote:\n  ${line}\n` +
          `What the log says instead:\n${log}`,
      );
    }
  });

  it("says the engine could not start, and names the exit status", () => {
    const code = fixtureEnv("ARCTURN_IT_SERVE_EXIT_CODE");
    assert.match(
      log,
      /could not start/i,
      `The log never says the engine could not start. A user reading it has to infer that from a ` +
        `bare stderr line. What it says:\n${log}`,
    );
    assert.ok(
      log.includes(`code ${code}`),
      `The log does not name the exit status (${code}), which is the only thing distinguishing "the ` +
        `engine refused" from "the engine was killed". What it says:\n${log}`,
    );
  });

  it("never writes the token it generated, not even in the failure", () => {
    const serve = spawnRecords().find((record) => record.argv[0] === "serve");
    assert.ok(serve !== undefined, "no serve invocation was recorded.");
    const token = serve.argv[serve.argv.indexOf("--token") + 1];
    assert.ok(
      typeof token === "string" && token.length >= 32,
      `serve was started with token ${JSON.stringify(token)}; there is nothing to check for.`,
    );
    assert.ok(
      !log.includes(token),
      "The Arcturn log contains the token handed to arcturn serve. Holding that token is holding a " +
        "shell as this user, and an Output channel is a thing people paste into bug reports.",
    );
  });

  it("says which environment it resolved, and puts no variable value in the log", () => {
    assert.match(
      log,
      /^environment: /m,
      `The log never says where the engine's environment came from. On a GUI-launched editor that ` +
        `line is the difference between "your key is missing" and "the extension could not see your ` +
        `key". What it says:\n${log}`,
    );
    // The extension resolves the *developer's* real login shell in this run,
    // so this window's own secrets are the sharpest possible check on the rule
    // that no value from that environment is ever written down.
    const leaked = Object.entries(process.env)
      .filter(
        ([name, value]) =>
          /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
          typeof value === "string" &&
          value.length >= 12 &&
          !/\s/.test(value) &&
          !value.startsWith("/"),
      )
      .filter(([, value]) => log.includes(value as string))
      .map(([name]) => name);
    assert.deepEqual(
      leaked,
      [],
      `The Arcturn log contains the value of ${leaked.join(", ")}. Reading the login shell's ` +
        "environment means reading the user's credentials; none of them may be written to a channel " +
        "people copy into issues.",
    );
  });
});
