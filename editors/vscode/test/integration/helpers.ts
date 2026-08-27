/**
 * Shared machinery for the integration suite.
 *
 * Two rules this file exists to enforce.
 *
 * First: nothing here mocks `vscode`. Every helper is a thin read of the real
 * API or of the fixture tree that `test/support/fixtures.mjs` laid down before
 * the editor launched. If a claim cannot be observed through one of those two,
 * it is not tested — it is written down in `TESTING.md` instead.
 *
 * Second: a failure has to say what broke, not just which two values differ.
 * A red integration test is read by someone who was not here when it was
 * written, on a machine that may be slow, mid-release. So the waiters take a
 * sentence describing the claim, and report what they saw instead.
 */

import { readFileSync } from "node:fs";
import * as vscode from "vscode";

/** `publisher.name` from the manifest — the id VS Code files the extension under. */
export const EXTENSION_ID = "arcturn.arcturn-vscode";

/** The terminal name `terminal.ts` chooses for a single-root workspace. */
export const SINGLE_ROOT_TERMINAL_NAME = "Arcturn";

/** The shape of the bits of `package.json` the suite reads back. */
export interface ArcturnManifest {
  readonly activationEvents: string[];
  readonly contributes: {
    readonly commands: { command: string; title: string; category?: string }[];
    readonly menus: { commandPalette?: { command: string; when?: string }[] };
    readonly views: Record<string, { id: string; name: string; type?: string; when?: string }[]>;
    readonly viewsContainers: Record<string, { id: string; title: string }[]>;
  };
}

/** The extension, as VS Code knows it. Fails loudly rather than returning undefined. */
export function extension(): vscode.Extension<unknown> {
  const found = vscode.extensions.getExtension(EXTENSION_ID);
  if (found === undefined) {
    const ids = vscode.extensions.all.map((entry) => entry.id).join(", ");
    throw new Error(
      `VS Code has no extension registered as "${EXTENSION_ID}". The extension host loaded: ${ids}. ` +
        "Either the publisher/name in package.json changed, or --extensionDevelopmentPath pointed somewhere else.",
    );
  }
  return found;
}

/**
 * The manifest as the *running editor* parsed it.
 *
 * Read from `Extension.packageJSON` rather than from disk on purpose: that is
 * the copy VS Code actually contributed from, so a test asserting "the
 * manifest and the runtime agree" is comparing the runtime against itself
 * rather than against a file that may not be the one loaded.
 */
export function manifest(): ArcturnManifest {
  return extension().packageJSON as ArcturnManifest;
}

/** Every command id in `contributes.commands`. */
export function contributedCommands(): string[] {
  return manifest().contributes.commands.map((entry) => entry.command);
}

/**
 * The six commands the sidebar owns, derived rather than copied.
 *
 * `menus.commandPalette` gates exactly these behind
 * `config.arcturn.serve.enabled`, which is the same condition
 * `extension.ts` uses to decide whether to register them. Deriving the list
 * from the manifest means the test cannot drift from the thing it is testing.
 */
export function serveGatedCommands(): string[] {
  const palette = manifest().contributes.menus.commandPalette ?? [];
  return palette
    .filter((entry) => entry.when === "config.arcturn.serve.enabled")
    .map((entry) => entry.command);
}

/** A value handed over by the launcher (a path, or a fixture filename). */
export function fixtureEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set in the extension host. The integration tests are meant to be run through ` +
        "`pnpm -C editors/vscode run test:integration`, which builds the fixtures and passes their paths in.",
    );
  }
  return value;
}

/** Read a fixture log, treating "not created yet" as "empty". */
export function readLog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** One recorded invocation of the stand-in engine. */
export interface SpawnRecord {
  readonly at: number;
  readonly argv: string[];
}

/** Every time the stand-in `arcturn` binary has been executed, in order. */
export function spawnRecords(): SpawnRecord[] {
  return readLog(fixtureEnv("ARCTURN_IT_SPAWN_LOG"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SpawnRecord);
}

/** A one-line summary of what the engine has been asked to do so far. */
export function describeSpawns(): string {
  const records = spawnRecords();
  if (records.length === 0) return "the arcturn binary has not been executed at all";
  return records.map((record) => `arcturn ${record.argv.join(" ")}`).join(" | ");
}

/** Every byte the extension has typed into the Arcturn terminal so far. */
export function terminalBytes(): string {
  return readLog(fixtureEnv("ARCTURN_IT_TTY_LOG"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `check` returns something truthy, or explain the timeout.
 *
 * @param claim - The thing being waited for, phrased as the claim under test
 *   ("the extension activates", "the Arcturn terminal receives the mention").
 * @param check - Returns a value when the claim holds, `undefined` otherwise.
 * @param describeFailure - Called on timeout to say what was observed instead.
 */
export async function waitFor<T>(
  claim: string,
  check: () => T | undefined | Promise<T | undefined>,
  describeFailure: () => string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for: ${claim}.\nWhat was observed instead: ${describeFailure()}`,
      );
    }
    await sleep(100);
  }
}

/** Wait for a plain boolean claim. */
export async function waitUntil(
  claim: string,
  check: () => boolean | Promise<boolean>,
  describeFailure: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitFor(
    claim,
    async () => ((await check()) ? true : undefined),
    describeFailure,
    timeoutMs,
  );
}

/** Every command the workbench currently knows, including internal ones. */
export function allCommands(): Thenable<string[]> {
  return vscode.commands.getCommands(true);
}

/** The Arcturn terminals VS Code says are open right now. */
export function arcturnTerminals(): readonly vscode.Terminal[] {
  return vscode.window.terminals.filter((terminal) => terminal.name.startsWith("Arcturn"));
}

/** A description of the open terminals, for a failure message. */
export function describeTerminals(): string {
  const names = vscode.window.terminals.map((terminal) => `"${terminal.name}"`);
  return names.length === 0 ? "no terminals are open" : `open terminals: ${names.join(", ")}`;
}

/**
 * Bring up the Arcturn terminal and wait until the stand-in TUI is reading it.
 *
 * Idempotent, so each test file can call it without depending on the file
 * before it having run. "Reading it" is observed, not assumed: the stand-in
 * engine records its own launch, and until that record exists anything typed
 * would land in a shell instead of the thing under test.
 */
export async function ensureTerminalReady(): Promise<vscode.Terminal> {
  await vscode.commands.executeCommand("arcturn.open");
  await waitUntil(
    "the stand-in engine to start in the Arcturn terminal",
    () => spawnRecords().some((record) => record.argv.length === 0),
    () =>
      `${describeSpawns()}; ${describeTerminals()}. The launch line is typed into the terminal, so this ` +
      "fails when the shell could not run the resolved arcturn path at all.",
  );
  const terminal = arcturnTerminals()[0];
  if (terminal === undefined) {
    throw new Error(
      `The stand-in engine started, but VS Code reports no terminal named "Arcturn" (${describeTerminals()}).`,
    );
  }
  return terminal;
}

/** Open a file in the editor and make it the active one. */
export async function openInEditor(filePath: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  return vscode.window.showTextDocument(document, { preview: false });
}

/** Wait a fixed time. Used only where the claim is that *nothing* happens. */
export function settle(ms: number): Promise<void> {
  return sleep(ms);
}

/** The folder VS Code opened, as the extension sees it. */
export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error(
      "VS Code opened no workspace folder. The launcher passes one via `workspaceFolder` in " +
        ".vscode-test.mjs; without it the mention tests have no root to be relative to.",
    );
  }
  return folder.uri.fsPath;
}
