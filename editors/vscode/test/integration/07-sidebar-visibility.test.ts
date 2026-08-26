/**
 * What actually happens to the panel when nobody is looking at it — and why
 * that is a permission question rather than a rendering one.
 *
 * RFC 0005 §2.1 moved permission prompts out of a native modal and into a card
 * in the panel's dock. A modal is visible wherever the user is looking; a panel
 * is not. So the design rests on one claim about the editor, and this file is
 * where that claim is checked against a real editor rather than against a
 * mock:
 *
 * **`retainContextWhenHidden` is off (RFC 0004 §3), so hiding the view
 * destroys its page — and a permission card drawn on that page goes with it.**
 *
 * That is why `permission-surface.ts` escalates to a native modal when the
 * view reports itself hidden with a request outstanding, instead of leaving a
 * blocked run waiting on a control nobody can see or answer.
 *
 * ## How it is observed, since a webview's DOM is unreadable
 *
 * VS Code's stable API gives one extension no way to read another's webview,
 * so "the card is gone" is not directly assertable (see TESTING.md). What *is*
 * assertable is the consequence one layer down: a destroyed page reloads when
 * the view is revealed, the reloaded page announces itself with `ready`, and
 * the host answers a `ready` by starting the engine. The stand-in engine
 * records every invocation, so **a further `arcturn serve` after a hide and a
 * reveal is the editor telling us the page was thrown away and rebuilt.**
 *
 * It takes *two* cycles to make that claim, and the second test is not
 * padding. Flipping `retainContextWhenHidden` to `true` and running this file
 * leaves the first cycle green — the workbench resolves the view once more
 * regardless — and turns the second red. One reload is ambiguous; two is the
 * page genuinely not surviving a hide. If VS Code ever started retaining the
 * context, or if the extension turned retention on, that second test goes red,
 * which is exactly when the escalation rule would need revisiting.
 *
 * ## What this file does not cover
 *
 * It does not drive a permission request. The stand-in engine never serves, so
 * there is no session, no `permissionRequest` event, and nothing honest to
 * assert about which surface a request would get. The routing itself — reveal,
 * fall back to a modal, escalate when the view goes hidden, one live surface
 * per request — is driven directly in `sidebar/permission-surface.test.ts`,
 * where the four host functions are injected and every branch is reachable.
 *
 * Runs last, after `06-engine-failure`, because it deliberately spends more
 * spawns and 06 reads the account of the first one.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { allCommands, describeSpawns, spawnRecords, waitFor } from "./helpers.js";

const VIEW_ID = "arcturn.sidebar";

/** How many times the stand-in engine has been asked to serve. */
function serveCount(): number {
  return spawnRecords().filter((record) => record.argv[0] === "serve").length;
}

describe("the panel when it is not on screen", () => {
  before(async () => {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await waitFor(
      "the sidebar to start arcturn serve at least once",
      () => (serveCount() > 0 ? serveCount() : undefined),
      () =>
        `no serve invocation was recorded. Observed: ${describeSpawns()}. Without one there is no ` +
        "resolved view to hide, and nothing here can make a claim.",
      30_000,
    );
  });

  it("offers the gesture that hides it, so the state the fallback exists for is reachable", async () => {
    const commands = await allCommands();
    assert.ok(
      commands.includes("workbench.action.closeSidebar"),
      "The workbench has no workbench.action.closeSidebar. A user can close the sidebar from the " +
        "UI regardless, so its absence here means this file cannot reproduce the state — not that " +
        "the state cannot happen.",
    );
  });

  it("reloads the page when the view is hidden and revealed", async () => {
    const before = serveCount();
    // Close the whole sidebar: the strongest form of "the Arcturn view is not
    // visible" a workbench can be put into from a command.
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await waitFor(
      "the revealed view to reload its page and announce itself again",
      () => (serveCount() > before ? serveCount() : undefined),
      () =>
        `the sidebar was hidden and revealed and no further serve invocation followed (still ` +
        `${String(serveCount())}). Observed: ${describeSpawns()}. Either the page was retained ` +
        "across the hide — in which case retainContextWhenHidden is on, contradicting RFC 0004 §3 " +
        "and the resolveWebviewView options — or a reloaded page no longer posts `ready`. The " +
        "permission card's escalation to a native modal is built on the page NOT surviving, so " +
        "this failing means that rule needs rewriting, not deleting.",
      30_000,
    );
  });

  it("reloads it again on a second cycle, which is what rules out a one-off resolve", async () => {
    // The test that actually carries the claim. With `retainContextWhenHidden`
    // on, the first cycle above still passes and this one fails: the workbench
    // resolves a view once more either way, so only a repeat distinguishes
    // "the page was destroyed" from "the view happened to resolve again".
    // It also covers the other half — that hiding is recoverable. If revealing
    // after a hide left the view unresolvable, a native modal would be the only
    // surface a permission request ever got.
    const before = serveCount();
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await waitFor(
      "a second hide-and-reveal cycle to reload the page again",
      () => (serveCount() > before ? serveCount() : undefined),
      () =>
        `a second hide/reveal produced no further serve invocation (still ${String(serveCount())}). ` +
        `Observed: ${describeSpawns()}. One reload could be a coincidence of ordering; two is the ` +
        "view genuinely resolving each time it is revealed.",
      30_000,
    );
  });
});
