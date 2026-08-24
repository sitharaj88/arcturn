import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProvisioner } from "./cli.js";
import { activateWith } from "./extension.js";
import { SIDEBAR_COMMANDS, SIDEBAR_VIEW_ID } from "./sidebar/index.js";
import type { TerminalHub } from "./terminal.js";
import { fake, resetFake } from "./test-vscode.js";

vi.mock("vscode", async () => (await import("./test-vscode.js")).createFakeVscode());

// The real module, minus the one function that would start a server. Builder
// B's `SIDEBAR_COMMANDS` is the point of this file: reading the ids from their
// source rather than copying them is what makes the check load-bearing.
vi.mock("./sidebar/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidebar/index.js")>();
  return { ...actual, activateSidebar: () => ({ dispose: () => {} }) };
});

interface ManifestCommand {
  command: string;
  title: string;
  category?: string;
}

interface MenuItem {
  command: string;
  when?: string;
}

interface Manifest {
  activationEvents: string[];
  contributes: {
    commands: ManifestCommand[];
    menus: { commandPalette?: MenuItem[] };
    views: Record<string, { id: string; when?: string }[]>;
    configuration: { properties: Record<string, unknown> };
  };
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as Manifest;

const contributed = manifest.contributes.commands.map((entry) => entry.command);
const palette = manifest.contributes.menus.commandPalette ?? [];
const viewIds = Object.values(manifest.contributes.views).flatMap((views) =>
  views.map((view) => view.id),
);

/** Activate the extension against stubs and report what it registered. */
async function registeredByBuilderA(): Promise<string[]> {
  const provisioner: CliProvisioner = {
    resolveCli: async () => undefined,
    runInstall: () => {},
    settled: async () => {},
    dispose: () => {},
  };
  const hub: TerminalHub = {
    open: () => ({}) as never,
    sendInput: async () => {},
    dispose: () => {},
  };
  await activateWith({ subscriptions: [] } as never, { provisioner, hub, platform: "darwin" });
  return [...fake.commands.keys()];
}

beforeEach(() => {
  resetFake();
});

describe("the manifest and the code agree about commands", () => {
  it("declares every command Builder B registers", async () => {
    // A command registered but not contributed works from the sidebar and is
    // invisible in the palette — RFC 0004 §3 asks for every command to be
    // reachable there.
    for (const id of Object.values(SIDEBAR_COMMANDS)) {
      expect(contributed).toContain(id);
    }
  });

  it("contributes nothing neither builder actually registers", async () => {
    // The other direction: a contributed id with no handler is a palette entry
    // that fails with "command not found" when someone picks it.
    const live = new Set([...(await registeredByBuilderA()), ...Object.values(SIDEBAR_COMMANDS)]);
    expect([...contributed].sort()).toEqual([...live].sort());
  });

  it("gives every command a title under the Arcturn category", async () => {
    for (const entry of manifest.contributes.commands) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.category).toBe("Arcturn");
    }
  });

  it("hides the sidebar's commands when the sidebar itself is turned off", async () => {
    // `arcturn.serve.enabled: false` means no serve, no sidebar, and so no
    // engine behind any of these. Leaving them in the palette offers six
    // entries that can only fail.
    for (const id of Object.values(SIDEBAR_COMMANDS)) {
      const entry = palette.find((item) => item.command === id);
      expect(entry?.when).toBe("config.arcturn.serve.enabled");
    }
  });

  it("names the same view the sidebar registers, and no other", async () => {
    // The id is agreed across a builder boundary and appears in three places:
    // this manifest, B's `registerWebviewViewProvider` call, and the
    // `onView:` activation event VS Code generates from the manifest. Drift in
    // any one of them yields a view container that opens to nothing and an
    // extension that never activates — with no error anywhere to explain it.
    //
    // `toEqual` covers both directions at once: the seam's id must be here,
    // and nothing that is not the seam's id may be.
    expect(viewIds).toEqual([SIDEBAR_VIEW_ID]);
  });

  it("hides only the one command that cannot be invoked without arguments", async () => {
    const hidden = palette.filter((item) => item.when === "false").map((item) => item.command);
    expect(hidden).toEqual(["arcturn.fixDiagnostic"]);
  });
});

describe("activation stays narrow", () => {
  it("never uses the wildcard", async () => {
    expect(manifest.activationEvents).not.toContain("*");
  });

  it("relies on contributes rather than a hand-written list that can drift", async () => {
    // VS Code 1.74+ generates `onCommand:` for every contributed command and
    // `onView:` for every contributed view. Spelling them out again adds a
    // second list to keep in sync and buys nothing.
    expect(manifest.activationEvents).toEqual([]);
    expect(viewIds).toContain(SIDEBAR_VIEW_ID);
  });
});
