/**
 * The hub tree, wired to the editor.
 *
 * Nothing is decided here. `tree.ts` owns every judgement — what counts as
 * installed, which sections a kit shows, what a lane means — and this file
 * turns its nodes into `TreeItem`s and hangs three commands off them. The split
 * exists so the judgements can be tested without an extension host, which is
 * where they were going to be wrong.
 *
 * The catalog is bundled rather than fetched. An editor extension that reaches
 * a website on activation is one a user has to take on trust, and this one has
 * been careful not to need any: the panel reads no file, sends nothing until
 * you press send, and now browses a directory without opening a socket. The
 * cost is staleness between releases, which `tree.test.ts` bounds by failing
 * when the snapshot drifts from `registry/`.
 */

import * as vscode from "vscode";
import catalogJson from "./catalog.json" with { type: "json" };
import {
  type Catalog,
  type CatalogKit,
  type HubNode,
  hubRoots,
  installCommand,
  kitSections,
  kitsInGroup,
  kitUrl,
  laneDescription,
  sectionChildren,
} from "./tree.js";

const catalog = catalogJson as Catalog;

/** The view id, matching `contributes.views`. */
export const HUB_VIEW_ID = "arcturn.hub";

/** Command ids this module registers. */
export const HUB_COMMANDS = {
  install: "arcturn.hub.install",
  openOnWeb: "arcturn.hub.openOnWeb",
  refresh: "arcturn.hub.refresh",
} as const;

/** What the tree needs from the engine. */
export interface HubHost {
  /**
   * Command names this engine would answer to, or `undefined` when it cannot
   * say — not connected, or older than `listCommands`.
   *
   * `undefined` and `[]` are deliberately different: "this engine has no
   * skills" and "I could not ask" are not the same news, and the tree shows
   * every kit as available on the second rather than pretending it knows.
   */
  availableCommands(): Promise<string[] | undefined>;
  /** Run a shell line in the user's terminal — how `arcturn add` is invoked. */
  runInTerminal(command: string): void;
}

/** Turns catalog nodes into tree items. */
class HubTreeProvider implements vscode.TreeDataProvider<HubNode> {
  readonly #changed = new vscode.EventEmitter<HubNode | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #host: HubHost;
  #commands: ReadonlySet<string> = new Set();

  constructor(host: HubHost) {
    this.#host = host;
  }

  /** Re-ask the engine what it can run, then redraw. */
  async refresh(): Promise<void> {
    const names = await this.#host.availableCommands().catch(() => undefined);
    this.#commands = new Set(names ?? []);
    this.#changed.fire(undefined);
  }

  getTreeItem(node: HubNode): vscode.TreeItem {
    return treeItemFor(node);
  }

  getChildren(node?: HubNode): HubNode[] {
    if (node === undefined) return hubRoots(catalog, this.#commands);
    if (node.kind === "group") {
      return kitsInGroup(
        catalog,
        this.#commands,
        node.id === "group:installed" ? "installed" : "available",
      );
    }
    if (node.kind === "kit") return kitSections(node.kit);
    if (node.kind === "section") return sectionChildren(node, this.#commands);
    return [];
  }

  dispose(): void {
    this.#changed.dispose();
  }
}

/** Build the `TreeItem` for one node. */
function treeItemFor(node: HubNode): vscode.TreeItem {
  const expanded = vscode.TreeItemCollapsibleState.Expanded;
  const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
  const leaf = vscode.TreeItemCollapsibleState.None;

  if (node.kind === "group") {
    const item = new vscode.TreeItem(node.label, expanded);
    item.description = String(node.count);
    item.contextValue = "arcturn.hub.group";
    return item;
  }

  if (node.kind === "kit") {
    const item = new vscode.TreeItem(node.kit.name, collapsed);
    item.description =
      node.presence === "installed"
        ? "installed"
        : node.presence === "partial"
          ? "partially installed"
          : undefined;
    item.tooltip = kitTooltip(node.kit, node.presence);
    item.iconPath = new vscode.ThemeIcon(
      node.presence === "installed"
        ? "check"
        : node.presence === "partial"
          ? "warning"
          : "cloud-download",
    );
    // Drives the inline buttons in `contributes.menus.view/item/context`.
    item.contextValue = `arcturn.hub.kit.${node.presence}`;
    return item;
  }

  if (node.kind === "section") {
    const item = new vscode.TreeItem(node.label, collapsed);
    item.contextValue = "arcturn.hub.section";
    return item;
  }

  if (node.kind === "agent") {
    const item = new vscode.TreeItem(node.agent.name, leaf);
    item.description = node.agent.lane;
    item.tooltip = new vscode.MarkdownString(
      `**${node.agent.name}** — ${laneDescription(node.agent.lane)}\n\n` +
        `Tools: \`${node.agent.tools.join("`, `")}\``,
    );
    item.iconPath = new vscode.ThemeIcon(laneIcon(node.agent.lane));
    item.contextValue = "arcturn.hub.agent";
    return item;
  }

  if (node.kind === "workflow") {
    const item = new vscode.TreeItem(`/workflow ${node.workflow.name}`, leaf);
    const budget =
      node.workflow.budgetUsd === undefined ? "" : `, ceiling $${node.workflow.budgetUsd}`;
    item.description = `${node.workflow.stages} stages${budget}`;
    item.tooltip = new vscode.MarkdownString(
      `Runs ${node.workflow.stages} stages${budget}.\n\n` +
        (node.present
          ? "This engine can run it now."
          : `Install with \`${installCommand(node.kit)}\`.`),
    );
    item.iconPath = new vscode.ThemeIcon(node.present ? "run-all" : "circle-outline");
    item.contextValue = "arcturn.hub.workflow";
    return item;
  }

  const item = new vscode.TreeItem(`/${node.skill.name}`, leaf);
  item.description = node.skill.line;
  item.tooltip = new vscode.MarkdownString(
    `${node.skill.line}\n\n` +
      (node.present
        ? "This engine can run it now."
        : `Install with \`${installCommand(node.kit)}\`.`),
  );
  item.iconPath = new vscode.ThemeIcon(node.present ? "symbol-event" : "circle-outline");
  item.contextValue = "arcturn.hub.skill";
  return item;
}

/** One icon per lane, so a write role is visibly not a read one. */
function laneIcon(lane: string): string {
  if (lane === "write") return "edit";
  if (lane === "exec") return "terminal";
  return "eye";
}

/**
 * What a kit's tooltip says.
 *
 * "Installed" is stated as the inference it is. The extension asked the engine
 * which commands it answers to; it did not look at a disk it may not share.
 */
function kitTooltip(kit: CatalogKit, presence: string): vscode.MarkdownString {
  const counts = [
    kit.workflows.length > 0 ? `${kit.workflows.length} workflows` : "",
    kit.skills.length > 0 ? `${kit.skills.length} skills` : "",
    kit.agents.length > 0 ? `${kit.agents.length} roles` : "",
  ].filter(Boolean);
  const status =
    presence === "installed"
      ? "\n\nEvery command it contributes is available on this engine."
      : presence === "partial"
        ? "\n\n**Some of its commands are missing.** The kit may have installed incompletely."
        : `\n\nInstall with \`${installCommand(kit)}\`.`;
  return new vscode.MarkdownString(
    `**${kit.name}** — ${counts.join(", ")}\n\n${kit.description}${status}`,
  );
}

/**
 * Register the hub view and its three commands.
 *
 * @returns A disposable that removes the view, the commands and the emitter.
 */
export function activateHub(context: vscode.ExtensionContext, host: HubHost): vscode.Disposable {
  const provider = new HubTreeProvider(host);
  const view = vscode.window.createTreeView(HUB_VIEW_ID, { treeDataProvider: provider });

  const disposables: vscode.Disposable[] = [
    view,
    { dispose: () => provider.dispose() },
    vscode.commands.registerCommand(HUB_COMMANDS.refresh, () => provider.refresh()),
    vscode.commands.registerCommand(HUB_COMMANDS.install, async (node?: HubNode) => {
      const kit = kitOf(node);
      if (kit === undefined) return;
      // Run in a terminal rather than silently: `arcturn add` writes files into
      // the user's workspace, and they should watch it happen and be able to
      // read what it did. A spinner would hide exactly the part that matters.
      host.runInTerminal(installCommand(kit));
      // The engine only learns about new skills when it restarts, so the tree
      // would otherwise keep saying "available" after a successful install.
      await vscode.window.showInformationMessage(
        `Installing ${kit.name}. Reconnect Arcturn once it finishes, then refresh the hub.`,
      );
    }),
    vscode.commands.registerCommand(HUB_COMMANDS.openOnWeb, async (node?: HubNode) => {
      const kit = kitOf(node);
      if (kit === undefined) return;
      await vscode.env.openExternal(vscode.Uri.parse(kitUrl(kit)));
    }),
  ];

  void provider.refresh();

  const disposable = new vscode.Disposable(() => {
    for (const item of disposables.splice(0)) item.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/** The kit a command was invoked on, whatever kind of node carried it. */
function kitOf(node: HubNode | undefined): CatalogKit | undefined {
  if (node === undefined) return undefined;
  return "kit" in node ? node.kit : undefined;
}
