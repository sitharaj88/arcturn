/**
 * The integration suite's launcher: a real VS Code, a real extension host, a
 * generated workspace, and no `vscode` mock anywhere.
 *
 * Two runs, because one of the claims under test is about what is true *at
 * activation*. `arcturn.serve.enabled` cannot be false-at-activation and
 * true-at-activation in the same window, so the toggle test gets its own
 * workspace, its own profile, and its own launch.
 *
 * Isolation is not left to the defaults. Every run gets a `--user-data-dir`
 * and `--extensions-dir` under `.vscode-test/`, so nothing the suite does can
 * reach the VS Code the developer is reading this in.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";
import { buildFixtures } from "./test/support/fixtures.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const fixtures = buildFixtures(extensionRoot);

/**
 * Where to find a VS Code to run against.
 *
 * Reusing the installed copy is the honest thing to do — it is the editor the
 * extension is actually shipped into, and it costs no download. When there is
 * no local install (CI, a fresh machine), fall back to a **pinned** version
 * rather than `stable`: a suite whose subject silently changes underneath it
 * is not a suite.
 *
 * The pin is 1.93.0, which is now exactly the floor declared in
 * `engines.vscode`. It did not start out that way: the manifest claimed
 * `^1.90.0` while `terminal.ts` called `window.onDidEndTerminalShellExecution`,
 * which exists as a property on 1.90 but throws because the proposal was not
 * finalised until 1.93 — and the throw happened while `activate()` was still
 * building its dependencies, so not one command was registered. This suite is
 * what found that. It has since been fixed on both sides (floor raised, call
 * wrapped); see TESTING.md. Below the floor VS Code now declines to load the
 * extension at all, which is the platform doing its job:
 *
 *     ARCTURN_VSCODE_VERSION=1.90.0 pnpm run test:integration
 */
const LOCAL_INSTALLS = [
  process.env.ARCTURN_VSCODE_EXECUTABLE,
  // Current releases name the macOS binary `Code`; builds old enough to still
  // be called `Electron` are what `@vscode/test-electron` downloads, so both
  // spellings have to be probed or a perfectly good local install is missed.
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  "/usr/share/code/code",
  "C:\\Program Files\\Microsoft VS Code\\Code.exe",
].filter((candidate) => typeof candidate === "string" && candidate !== "");

const PINNED_VSCODE_VERSION = "1.93.0";

/** Force a downloaded host of a specific version, ignoring anything installed. */
const forcedVersion = process.env.ARCTURN_VSCODE_VERSION;

const localInstall =
  forcedVersion === undefined
    ? LOCAL_INSTALLS.find((candidate) => existsSync(candidate))
    : undefined;
const installation =
  localInstall === undefined
    ? { version: forcedVersion ?? PINNED_VSCODE_VERSION }
    : { useInstallation: { fromPath: localInstall } };

console.log(
  localInstall === undefined
    ? `[arcturn] downloading VS Code ${forcedVersion ?? PINNED_VSCODE_VERSION}` +
        (forcedVersion === undefined ? " (pinned fallback; no local install found)" : " (forced)")
    : `[arcturn] reusing local VS Code at ${localInstall}`,
);

/** Launch flags shared by both runs, plus the per-run profile directories. */
function launchArgs(label) {
  const profile = fixtures.profileDir(label);
  return [
    `--user-data-dir=${join(profile, "user-data")}`,
    `--extensions-dir=${join(profile, "extensions")}`,
    // The extension under development still loads; everything else is off, so
    // no third-party extension can register a command and confuse the
    // "nothing arcturn.* is registered that isn't contributed" assertion.
    "--disable-extensions",
  ];
}

const mocha = {
  ui: "bdd",
  // Real windows, real terminals, real ptys: a 2s default would only measure
  // how busy the machine is.
  timeout: 60_000,
  slow: 5_000,
};

/**
 * Order is load-bearing, so the files are listed rather than globbed.
 *
 * `01-activation` has to observe a *cold* extension host — it asserts that
 * activating spawned nothing — so anything that touches the engine must come
 * after it. `05-sidebar-view` deliberately resolves the webview, which starts
 * the engine, `06-engine-failure` reads what the extension made of the engine
 * dying, and `07-sidebar-visibility` hides and reveals the view (spending more
 * spawns to prove the page is not retained), so those three come last and in
 * that order.
 */
const orderedFiles = [
  "out/integration/01-activation.test.js",
  "out/integration/02-commands.test.js",
  "out/integration/03-terminal.test.js",
  "out/integration/04-mention-injection.test.js",
  // Opens real editors and moves real selections, and then asserts that none
  // of it cost a spawn. That observation is only available before
  // `05-sidebar-view` deliberately spends the budget.
  "out/integration/04b-active-editor.test.js",
  // Browsing the hub must cost nothing, and that claim is only worth making
  // while the budget 01-activation asserts is unspent is still unspent — so it
  // goes here, ahead of the file that deliberately spends it.
  "out/integration/08-hub-view.test.js",
  "out/integration/05-sidebar-view.test.js",
  "out/integration/06-engine-failure.test.js",
  // Deliberately hides and reveals the view, which costs more spawns — so it
  // comes after 06, which reads the account of the first one.
  "out/integration/07-sidebar-visibility.test.js",
];

export default defineConfig([
  {
    label: "default",
    files: orderedFiles,
    workspaceFolder: fixtures.defaultWorkspace,
    launchArgs: launchArgs("default"),
    env: fixtures.env,
    mocha,
    ...installation,
  },
  {
    label: "serve-disabled",
    files: ["out/integration/serve-toggle.test.js"],
    workspaceFolder: fixtures.serveDisabledWorkspace,
    launchArgs: launchArgs("serve-disabled"),
    env: fixtures.env,
    mocha,
    ...installation,
  },
]);
