/**
 * The hub, as a tree.
 *
 * Thirteen kits, forty-odd commands, and until now none of it was visible from
 * the editor. A user in the panel had no way to learn that `/stack-choose`
 * exists, let alone what it would do — the whole directory lived on a website
 * and in a CLI they had to already know to run. Discovery, not capability, is
 * the thing that was missing.
 *
 * Everything here is pure: kits and a set of available command names in, tree
 * nodes out. The `vscode` half is `view.ts`, which does nothing but turn these
 * nodes into `TreeItem`s. That split is what lets the interesting decisions —
 * what counts as installed, what a role's lane means, what a node says about
 * itself — be tested without an editor.
 *
 * ## "Installed" is an inference, and is labelled as one
 *
 * The extension cannot look at the engine's disk: the engine may be on another
 * machine entirely. What it can ask is which commands the engine would answer
 * to, which is `listCommands`. So a kit whose skills and workflows all appear
 * there is reported as installed, one with some of them as partial, and one
 * with none as available. That is an observation about commands rather than a
 * claim about files, and the node's tooltip says so rather than implying a
 * filesystem check nobody performed.
 */

/** One role a kit ships, as the registry discloses it. */
export interface CatalogAgent {
  readonly name: string;
  /** `read`, `exec` or `write` — derived by the engine from the role's tools. */
  readonly lane: string;
  readonly tools: readonly string[];
}

/** One workflow a kit ships. */
export interface CatalogWorkflow {
  readonly name: string;
  readonly stages: number;
  readonly budgetUsd?: number;
}

/** One skill a kit ships, with the line the registry uses to describe it. */
export interface CatalogSkill {
  readonly name: string;
  readonly line: string;
}

/** One kit, flattened from its registry entry. */
export interface CatalogKit {
  readonly name: string;
  /** What `arcturn add` is given, e.g. `sitharaj88/arcturn/kits/project-setup`. */
  readonly source: string;
  readonly description: string;
  readonly kinds: readonly string[];
  readonly agents: readonly CatalogAgent[];
  readonly workflows: readonly CatalogWorkflow[];
  readonly skills: readonly CatalogSkill[];
}

/** The bundled snapshot. */
export interface Catalog {
  readonly kits: readonly CatalogKit[];
}

/** How much of a kit this engine can already run. */
export type KitPresence = "installed" | "partial" | "available";

/**
 * What a kit contributes as `/` commands.
 *
 * Skills and workflows both become commands; roles do not — a role is invoked
 * *by* a workflow, never typed. So the presence check counts exactly the things
 * a `listCommands` answer could contain.
 */
export function kitCommandNames(kit: CatalogKit): string[] {
  return [...kit.skills.map((skill) => skill.name), ...kit.workflows.map((flow) => flow.name)];
}

/**
 * Decide how much of `kit` the engine already answers to.
 *
 * A kit that contributes no commands at all — roles only — cannot be detected
 * this way, and is reported `available` rather than guessed at. Claiming an
 * `enterprise-org` is installed because it contributes nothing to look for
 * would be worse than admitting the check does not reach it.
 */
export function kitPresence(kit: CatalogKit, availableCommands: ReadonlySet<string>): KitPresence {
  const names = kitCommandNames(kit);
  if (names.length === 0) return "available";
  const present = names.filter((name) => availableCommands.has(name)).length;
  if (present === 0) return "available";
  return present === names.length ? "installed" : "partial";
}

/** A node in the hub tree. */
export type HubNode =
  | { readonly kind: "group"; readonly id: string; readonly label: string; readonly count: number }
  | {
      readonly kind: "kit";
      readonly id: string;
      readonly kit: CatalogKit;
      readonly presence: KitPresence;
    }
  | {
      readonly kind: "section";
      readonly id: string;
      readonly label: string;
      readonly kit: CatalogKit;
      readonly section: "agents" | "workflows" | "skills";
    }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly agent: CatalogAgent;
      readonly kit: CatalogKit;
    }
  | {
      readonly kind: "workflow";
      readonly id: string;
      readonly workflow: CatalogWorkflow;
      readonly kit: CatalogKit;
      readonly present: boolean;
    }
  | {
      readonly kind: "skill";
      readonly id: string;
      readonly skill: CatalogSkill;
      readonly kit: CatalogKit;
      readonly present: boolean;
    };

/** The two top-level groups, in the order they are shown. */
export function hubRoots(catalog: Catalog, availableCommands: ReadonlySet<string>): HubNode[] {
  const installed = catalog.kits.filter(
    (kit) => kitPresence(kit, availableCommands) !== "available",
  );
  const available = catalog.kits.filter(
    (kit) => kitPresence(kit, availableCommands) === "available",
  );
  const roots: HubNode[] = [];
  // An empty "Installed" group is omitted rather than shown as a zero: a
  // first-run tree should read as a catalog to browse, not as a report of
  // everything the user has failed to install.
  if (installed.length > 0) {
    roots.push({
      kind: "group",
      id: "group:installed",
      label: "Installed",
      count: installed.length,
    });
  }
  roots.push({
    kind: "group",
    id: "group:available",
    label: installed.length > 0 ? "Available" : "Kits",
    count: available.length,
  });
  return roots;
}

/** The kits under one group, sorted by name. */
export function kitsInGroup(
  catalog: Catalog,
  availableCommands: ReadonlySet<string>,
  group: "installed" | "available",
): HubNode[] {
  return catalog.kits
    .filter((kit) => {
      const presence = kitPresence(kit, availableCommands);
      return group === "installed" ? presence !== "available" : presence === "available";
    })
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((kit) => ({
      kind: "kit" as const,
      id: `kit:${kit.name}`,
      kit,
      presence: kitPresence(kit, availableCommands),
    }));
}

/** The sections under one kit, omitting the ones it has nothing in. */
export function kitSections(kit: CatalogKit): HubNode[] {
  const sections: HubNode[] = [];
  const add = (section: "agents" | "workflows" | "skills", label: string, count: number) => {
    if (count === 0) return;
    sections.push({
      kind: "section",
      id: `section:${kit.name}:${section}`,
      label: `${label} (${count})`,
      kit,
      section,
    });
  };
  add("workflows", "Workflows", kit.workflows.length);
  add("skills", "Skills", kit.skills.length);
  add("agents", "Roles", kit.agents.length);
  return sections;
}

/** The leaves under one section. */
export function sectionChildren(
  node: Extract<HubNode, { kind: "section" }>,
  availableCommands: ReadonlySet<string>,
): HubNode[] {
  const { kit } = node;
  if (node.section === "agents") {
    return kit.agents.map((agent) => ({
      kind: "agent" as const,
      id: `agent:${kit.name}:${agent.name}`,
      agent,
      kit,
    }));
  }
  if (node.section === "workflows") {
    return kit.workflows.map((workflow) => ({
      kind: "workflow" as const,
      id: `workflow:${kit.name}:${workflow.name}`,
      workflow,
      kit,
      present: availableCommands.has(workflow.name),
    }));
  }
  return kit.skills.map((skill) => ({
    kind: "skill" as const,
    id: `skill:${kit.name}:${skill.name}`,
    skill,
    kit,
    present: availableCommands.has(skill.name),
  }));
}

/**
 * What a role's lane means, in one line.
 *
 * The lane is not decoration: it is the engine's rule about what a role's
 * worktree is allowed to do with what it produced, and it is derived from the
 * role's tools rather than declared. A reader deciding whether to install a kit
 * should be able to see that a role can write to their files before it does.
 */
export function laneDescription(lane: string): string {
  if (lane === "write") return "writes files — its worktree patch is applied";
  if (lane === "exec") return "runs commands — its worktree is discarded";
  return "reads only — no shell, no writes";
}

/** The hub page for one kit on the website. */
export function kitUrl(kit: CatalogKit): string {
  return `https://arcturn.dev/hub/${kit.name}`;
}

/** The `arcturn add` line that installs a kit. */
export function installCommand(kit: CatalogKit): string {
  return `arcturn add ${kit.source}`;
}
