/**
 * The `arcturn.sidebar` webview view, and the first moment the extension is
 * allowed to cost anything.
 *
 * VS Code's stable API has no "which view ids have a provider?" query, so the
 * registration is observed indirectly and the indirection is the interesting
 * part: the workbench synthesises an `<id>.focus` command for every view it
 * knows about, and `SidebarViewProvider.reveal()` in the shipped code depends
 * on that exact command existing. Executing it reveals the view, which makes
 * VS Code call `resolveWebviewView`, which is the one place the engine is
 * started. So the stand-in engine recording an `arcturn serve` invocation is
 * proof that the whole chain — view id, container, provider registration,
 * lazy start — is wired.
 *
 * This file runs last, because it is the file that deliberately spends the
 * activation budget 01-activation asserts is unspent.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  allCommands,
  describeSpawns,
  manifest,
  type SpawnRecord,
  spawnRecords,
  waitFor,
  workspaceRoot,
} from "./helpers.js";

const VIEW_ID = "arcturn.sidebar";
const CONTAINER_ID = "arcturn";

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe("the sidebar view", () => {
  it("contributes arcturn.sidebar as a webview view in its own activity-bar container", () => {
    const views = manifest().contributes.views[CONTAINER_ID] ?? [];
    const sidebar = views.find((view) => view.id === VIEW_ID);
    assert.ok(
      sidebar !== undefined,
      `The running editor's manifest has no view "${VIEW_ID}" in container "${CONTAINER_ID}". ` +
        `It contributes: ${views.map((view) => view.id).join(", ") || "nothing"}.`,
    );
    assert.equal(
      sidebar.type,
      "webview",
      `The view is contributed as type "${String(sidebar.type)}". A tree view would never call the ` +
        "WebviewViewProvider that sidebar/view.ts registers, so the panel would render empty.",
    );
    const containers = manifest().contributes.viewsContainers.activitybar ?? [];
    assert.ok(
      containers.some((container) => container.id === CONTAINER_ID),
      `No activity-bar container "${CONTAINER_ID}" is contributed, so the view has nowhere to live.`,
    );
  });

  it("is known to the workbench by id", async () => {
    const commands = await allCommands();
    assert.ok(
      commands.includes(`${VIEW_ID}.focus`),
      `The workbench has no "${VIEW_ID}.focus" command. VS Code generates one per view it registers, ` +
        "and SidebarViewProvider.reveal() calls it by name — so its absence means both that the view " +
        "is unregistered and that reveal() would throw.",
    );
    assert.ok(
      commands.includes(`workbench.view.extension.${CONTAINER_ID}`),
      `The workbench has no "workbench.view.extension.${CONTAINER_ID}" command, so the activity-bar ` +
        "container was not registered.",
    );
  });

  it("resolves its webview provider when focused, which is what starts the engine", async () => {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await waitFor<SpawnRecord>(
      "the sidebar to start arcturn serve once its view is revealed",
      () => spawnRecords().find((record) => record.argv[0] === "serve"),
      () =>
        `no serve invocation was recorded. Observed: ${describeSpawns()}. Revealing the view is what ` +
        "calls resolveWebviewView, which calls onResolve, which starts the engine session — if the " +
        "provider is not registered for this view id, none of that happens and the panel shows " +
        '"no data provider registered" instead.',
      30_000,
    );
  });

  it("spawns serve on loopback, with an ephemeral port and a generated token", () => {
    const serve = spawnRecords().find((record) => record.argv[0] === "serve");
    assert.ok(
      serve !== undefined,
      `No serve invocation was recorded. Observed: ${describeSpawns()}.`,
    );
    assert.equal(
      flagValue(serve.argv, "--host"),
      "127.0.0.1",
      `serve was told to bind ${String(flagValue(serve.argv, "--host"))}. RFC 0004 §1 says loopback, ` +
        "and anything else exposes a token-authenticated agent to the network.",
    );
    assert.equal(
      flagValue(serve.argv, "--port"),
      "0",
      `serve was given port ${String(flagValue(serve.argv, "--port"))} although arcturn.serve.port is 0. ` +
        "0 asks the OS for an ephemeral port, which is one fewer fixed thing for another local process to find.",
    );
    assert.equal(
      flagValue(serve.argv, "--cwd"),
      workspaceRoot(),
      `serve was pointed at ${String(flagValue(serve.argv, "--cwd"))} rather than the open workspace folder.`,
    );
    const token = flagValue(serve.argv, "--token");
    assert.ok(
      token !== undefined && token.length >= 32,
      `serve was started with token ${JSON.stringify(token)}. An empty or short token is the engine's ` +
        '"authentication off" setting, which any other process on this machine could then attach to.',
    );
  });
});
