import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_COMMANDS, BACKGROUND_VIEW_ID } from "./background/view.js";
import type { CliProvisioner } from "./cli.js";
import { activateWith } from "./extension.js";
import { HUB_COMMANDS, HUB_VIEW_ID } from "./hub/view.js";
import { MCP_COMMANDS } from "./mcp/view.js";
import { SCOUT_COMMANDS } from "./scout/view.js";
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

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
  media: { markdown?: string; image?: string; svg?: string };
  completionEvents?: string[];
}

interface Manifest {
  activationEvents: string[];
  contributes: {
    commands: ManifestCommand[];
    menus: { commandPalette?: MenuItem[] };
    views: Record<string, { id: string; when?: string }[]>;
    configuration: { properties: Record<string, unknown> };
    walkthroughs?: { id: string; title: string; steps: WalkthroughStep[] }[];
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
    for (const id of [
      ...Object.values(SIDEBAR_COMMANDS),
      ...Object.values(HUB_COMMANDS),
      ...Object.values(SCOUT_COMMANDS),
      ...Object.values(MCP_COMMANDS),
      ...Object.values(BACKGROUND_COMMANDS),
    ]) {
      expect(contributed).toContain(id);
    }
  });

  it("contributes nothing neither builder actually registers", async () => {
    // The other direction: a contributed id with no handler is a palette entry
    // that fails with "command not found" when someone picks it.
    // The hub's three are registered by `activateHub`, which `activateSidebar`
    // calls — the same builder, one module further down.
    const live = new Set([
      ...(await registeredByBuilderA()),
      ...Object.values(SIDEBAR_COMMANDS),
      ...Object.values(HUB_COMMANDS),
      ...Object.values(SCOUT_COMMANDS),
      ...Object.values(MCP_COMMANDS),
      ...Object.values(BACKGROUND_COMMANDS),
    ]);
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
    // `refresh` is the only hub command that means anything without a node to
    // act on, so it is the only one gated this way rather than hidden outright.
    expect(palette.find((item) => item.command === HUB_COMMANDS.refresh)?.when).toBe(
      "config.arcturn.serve.enabled",
    );
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
    expect(viewIds).toEqual([SIDEBAR_VIEW_ID, HUB_VIEW_ID, BACKGROUND_VIEW_ID]);
  });

  it("hides exactly the commands that cannot be invoked without arguments", async () => {
    // A palette entry that needs a node it can never be given is an entry that
    // can only fail. `fixDiagnostic` needs a diagnostic; the hub's install and
    // open-on-web need a kit row; background cancel and adopt need an agent
    // row. Their siblings that *can* stand alone — start, refresh — are gated
    // on the setting instead, not hidden.
    const hidden = palette.filter((item) => item.when === "false").map((item) => item.command);
    expect(hidden.sort()).toEqual(
      [
        "arcturn.fixDiagnostic",
        HUB_COMMANDS.install,
        HUB_COMMANDS.openOnWeb,
        BACKGROUND_COMMANDS.cancel,
        BACKGROUND_COMMANDS.adopt,
      ].sort(),
    );
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

/**
 * The walkthrough is the only part of the extension that can be completely
 * broken while every test passes and the code typechecks: its steps are data,
 * its links are strings, and its prose lives in files the bundler never looks
 * at. Three ways it silently rots, one test each.
 */
describe("the getting-started walkthrough", () => {
  const walkthrough = () => {
    const found = manifest.contributes.walkthroughs?.[0];
    if (found === undefined) throw new Error("no walkthrough is contributed");
    return found;
  };

  it("points every step at a file that is actually there", () => {
    // A missing markdown file does not fail to load — it renders as a step
    // with a title and nothing under it, which reads as a broken extension
    // to the one person who most needs it to work.
    for (const step of walkthrough().steps) {
      const media = step.media.markdown ?? step.media.image ?? step.media.svg;
      expect(media, `step "${step.id}" names no media`).toBeDefined();
      const path = fileURLToPath(new URL(`../${media}`, import.meta.url));
      expect(() => readFileSync(path, "utf8"), `step "${step.id}" → ${media}`).not.toThrow();
    }
  });

  it("links only to commands the manifest contributes", () => {
    // `command:arcturn.typo` renders as a button that does nothing at all.
    const contributedIds = new Set(manifest.contributes.commands.map((entry) => entry.command));
    for (const step of walkthrough().steps) {
      for (const match of step.description.matchAll(/command:([\w.]+)/g)) {
        expect(contributedIds, `step "${step.id}" links ${match[1]}`).toContain(match[1]);
      }
      for (const event of step.completionEvents ?? []) {
        if (!event.startsWith("onCommand:")) continue;
        expect(contributedIds, `step "${step.id}" completes on ${event}`).toContain(
          event.slice("onCommand:".length),
        );
      }
    }
  });

  it("ships its prose in the VSIX", () => {
    // `.vscodeignore` is an allowlist: everything is excluded and the shipped
    // files are named. A walkthrough added without a matching `!` line
    // packages as five empty steps, and only a published install would show it.
    const ignore = readFileSync(
      fileURLToPath(new URL("../.vscodeignore", import.meta.url)),
      "utf8",
    );
    const allowed = ignore
      .split("\n")
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1).trim());
    for (const step of walkthrough().steps) {
      const media = step.media.markdown ?? step.media.image ?? step.media.svg ?? "";
      const covered = allowed.some(
        (rule) =>
          rule === media ||
          (rule.endsWith("*") && media.startsWith(rule.slice(0, -1))) ||
          (rule.includes("*") && new RegExp(`^${rule.replace(/\*/g, "[^/]*")}$`).test(media)),
      );
      expect(covered, `${media} is not allowlisted in .vscodeignore`).toBe(true);
    }
  });
});
