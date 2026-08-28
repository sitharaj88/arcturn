/**
 * The hub tree, and the snapshot it renders.
 *
 * Two kinds of claim here. The first is about the model: what "installed"
 * means when the extension cannot see the engine's disk, and what the tree
 * refuses to guess. The second is about the snapshot: a bundled catalog is a
 * copy, and a copy that drifts from `registry/*.json` is a directory that
 * quietly lies about what the hub contains.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../../scripts/build-catalog.mjs";
import catalog from "./catalog.json" with { type: "json" };
import {
  type Catalog,
  type CatalogKit,
  hubRoots,
  installCommand,
  kitCommandNames,
  kitPresence,
  kitSections,
  kitsInGroup,
  kitUrl,
  laneDescription,
  sectionChildren,
} from "./tree.js";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = join(here, "..", "..", "..", "..", "registry");
const shipped = catalog as Catalog;

function kit(name: string): CatalogKit {
  const found = shipped.kits.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no kit "${name}" in the catalog`);
  return found;
}

describe("the bundled catalog", () => {
  it("matches what the registry says today", () => {
    // A snapshot is only as good as the thing that notices it went stale. This
    // regenerates from `registry/*.json` and compares, so a kit added, renamed
    // or re-scoped fails here rather than shipping a directory missing an entry.
    expect(shipped).toEqual(buildCatalog(registryDir));
  });

  it("has an entry for every registry file", () => {
    const files = readdirSync(registryDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""))
      .sort();
    expect(shipped.kits.map((entry) => entry.name).sort()).toEqual(files);
  });

  it("carries no field the registry did not disclose", () => {
    // The snapshot copies by name. This is the check that a future registry
    // field cannot ride into an editor surface without somebody deciding it
    // should — the rule `mcpStatus` keeps on the wire, for the same reason.
    for (const entry of shipped.kits) {
      expect(Object.keys(entry).sort()).toEqual([
        "agents",
        "description",
        "kinds",
        "name",
        "skills",
        "source",
        "workflows",
      ]);
    }
  });

  it("names an install source that agrees with the registry file", () => {
    for (const entry of shipped.kits) {
      const raw = JSON.parse(readFileSync(join(registryDir, `${entry.name}.json`), "utf8"));
      expect(installCommand(entry)).toBe(`arcturn add ${raw.source}`);
      expect(kitUrl(entry)).toBe(`https://arcturn.dev/hub/${entry.name}`);
    }
  });
});

describe("deciding what is already installed", () => {
  const setup = kit("project-setup");

  it("counts skills and workflows, because those are what become commands", () => {
    // Roles are invoked *by* a workflow, never typed, so they can never appear
    // in `listCommands` and must not be counted against a kit's presence.
    const names = kitCommandNames(setup);
    expect(names).toContain("app-setup");
    expect(names).toContain("stack-choose");
    for (const role of setup.agents) expect(names).not.toContain(role.name);
  });

  it("is installed only when every one of its commands is there", () => {
    const all = new Set(kitCommandNames(setup));
    expect(kitPresence(setup, all)).toBe("installed");
  });

  it("is partial when some are missing, which is what a broken install looks like", () => {
    // `enterprise-org` shipped for two releases with a manifest naming files
    // that were not there, and installed as an empty directory. "Partial" is
    // the state that would have made that visible from the editor.
    const some = new Set(kitCommandNames(setup).slice(0, 2));
    expect(kitPresence(setup, some)).toBe("partial");
  });

  it("is available when none are", () => {
    expect(kitPresence(setup, new Set())).toBe("available");
  });

  it("refuses to guess about a kit that contributes no commands at all", () => {
    // Nothing to look for is not the same as everything being present, and a
    // roles-only kit reported "installed" would be a claim nobody checked.
    const rolesOnly: CatalogKit = { ...setup, skills: [], workflows: [] };
    expect(kitPresence(rolesOnly, new Set(kitCommandNames(setup)))).toBe("available");
  });
});

describe("the shape of the tree", () => {
  it("shows one group on a first run, not an empty Installed", () => {
    const roots = hubRoots(shipped, new Set());
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ label: "Kits", count: shipped.kits.length });
  });

  it("splits into two once something is installed", () => {
    const roots = hubRoots(shipped, new Set(kitCommandNames(kit("project-setup"))));
    expect(roots.map((node) => ("label" in node ? node.label : ""))).toEqual([
      "Installed",
      "Available",
    ]);
    expect(roots[0]).toMatchObject({ count: 1 });
  });

  it("puts a partially installed kit under Installed, where it can be seen", () => {
    const partial = new Set(kitCommandNames(kit("project-setup")).slice(0, 1));
    const installed = kitsInGroup(shipped, partial, "installed");
    expect(installed.map((node) => node.id)).toContain("kit:project-setup");
    expect(installed[0]).toMatchObject({ presence: "partial" });
  });

  it("sorts kits by name so the list does not reshuffle between reads", () => {
    const names = kitsInGroup(shipped, new Set(), "available").map((node) =>
      "kit" in node ? node.kit.name : "",
    );
    expect(names).toEqual([...names].sort());
  });

  it("omits a section a kit has nothing in", () => {
    const noWorkflows: CatalogKit = { ...kit("project-setup"), workflows: [] };
    const labels = kitSections(noWorkflows).map((node) => ("label" in node ? node.label : ""));
    expect(labels.some((label) => label.startsWith("Workflows"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Skills"))).toBe(true);
  });

  it("marks each command leaf with whether this engine can run it", () => {
    const sections = kitSections(kit("project-setup"));
    const skills = sections.find((node) => "section" in node && node.section === "skills");
    if (skills === undefined || skills.kind !== "section") throw new Error("no skills section");
    const children = sectionChildren(skills, new Set(["stack-choose"]));
    const present = children.filter((node) => "present" in node && node.present);
    expect(present).toHaveLength(1);
    expect(present[0]).toMatchObject({ id: "skill:project-setup:stack-choose" });
  });
});

describe("what a role's lane says", () => {
  it("says a write role will touch the user's files", () => {
    // The lane is the engine's rule about what a role's worktree does with
    // what it produced. Someone deciding whether to install a kit should see
    // that before a role writes to their repository, not after.
    expect(laneDescription("write")).toMatch(/writes files/);
    expect(laneDescription("exec")).toMatch(/discarded/);
    expect(laneDescription("read")).toMatch(/reads only/);
  });

  it("describes every lane the catalog actually contains", () => {
    const lanes = new Set(shipped.kits.flatMap((entry) => entry.agents.map((role) => role.lane)));
    expect(lanes.size).toBeGreaterThan(0);
    for (const lane of lanes) {
      expect(laneDescription(lane), `lane "${lane}"`).not.toBe("");
    }
  });
});
