/**
 * Background agents, in the sidebar.
 *
 * `model.ts` owns every judgement; this is the tree, the polling loop and four
 * commands. The split is the one `hub/` and `scout/` keep.
 *
 * ## Why a notification and not just a list
 *
 * Fire-and-forget only pays off if you find out it finished. A list you have
 * to remember to look at is a list you will not look at, so the loop that
 * refreshes the tree also watches for agents that stopped running since the
 * last look and says so once — with the one action worth offering, which is to
 * fold the findings back into the conversation you were having.
 *
 * The loop stops as soon as nothing is running. A background feature that
 * polled forever would have a foreground cost.
 */

import * as vscode from "vscode";
import {
  type AgentState,
  type AgentSummary,
  actionsFor,
  agentDescription,
  agentDetail,
  anyLive,
  formatElapsed,
  newlyFinished,
  stateIcon,
  stateSnapshot,
} from "./model.js";

/** The view id, matching `contributes.views`. */
export const BACKGROUND_VIEW_ID = "arcturn.background";

/** Command ids this module registers. */
export const BACKGROUND_COMMANDS = {
  start: "arcturn.background.start",
  cancel: "arcturn.background.cancel",
  adopt: "arcturn.background.adopt",
  refresh: "arcturn.background.refresh",
} as const;

/** What the tree needs from the engine. */
export interface BackgroundHost {
  /**
   * Every background agent the engine knows about, or `undefined` when it
   * cannot say — not connected, or older than the verb.
   *
   * `undefined` and `[]` are different, and the tree shows a different empty
   * state for each: "nothing has been started" and "I could not ask" are not
   * the same news.
   */
  list(): Promise<AgentSummary[] | undefined>;
  /** Start one. The engine decides its caps; there is nothing to pass but a task. */
  start(task: string): Promise<{ id: string } | undefined>;
  cancel(id: string): Promise<boolean>;
  /** Fold an agent's findings into the open conversation. */
  adopt(id: string): Promise<void>;
}

/** How often a tree with something running re-reads. */
const POLL_INTERVAL_MS = 3_000;

/** A node in the tree. */
type Node = { readonly kind: "agent"; readonly agent: AgentSummary };

class BackgroundTree implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #host: BackgroundHost;
  readonly #onFinished: (agents: readonly AgentSummary[]) => void;
  #agents: AgentSummary[] = [];
  #known: Map<string, AgentState> = new Map();
  #reachable = true;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(host: BackgroundHost, onFinished: (agents: readonly AgentSummary[]) => void) {
    this.#host = host;
    this.#onFinished = onFinished;
  }

  /** Re-read once, announce anything that finished, and schedule the next look. */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    const listing = await this.#host.list().catch(() => undefined);
    this.#reachable = listing !== undefined;
    const agents = listing ?? [];

    const finished = newlyFinished(this.#known, agents);
    this.#known = stateSnapshot(agents);
    this.#agents = agents;
    this.#changed.fire(undefined);
    if (finished.length > 0) this.#onFinished(finished);

    this.#reschedule();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const { agent } = node;
    const item = new vscode.TreeItem(agent.task, vscode.TreeItemCollapsibleState.None);
    item.description = agentDescription(agent);
    // Plain text. A task is what the user typed and findings are what a model
    // wrote, and neither is markup this view should render.
    item.tooltip = [
      agent.task,
      "",
      `${agent.status} · ${formatElapsed(agent.elapsedMs)} · ${agent.modelId}`,
      agentDetail(agent),
    ].join("\n");
    item.iconPath = new vscode.ThemeIcon(stateIcon(agent.status));
    const actions = actionsFor(agent);
    // Drives the inline buttons; the `when` clauses in the manifest read this.
    item.contextValue = `arcturn.background.${actions.cancel ? "live" : actions.adopt ? "adoptable" : "settled"}`;
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (node !== undefined) return [];
    return this.#agents.map((agent) => ({ kind: "agent" as const, agent }));
  }

  /** Whether the engine could be asked at all — drives the empty message. */
  get reachable(): boolean {
    return this.#reachable;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#changed.dispose();
  }

  /** Poll only while something is running. */
  #reschedule(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed || !anyLive(this.#agents)) return;
    this.#timer = setTimeout(() => void this.refresh(), POLL_INTERVAL_MS);
    this.#timer.unref?.();
  }
}

/**
 * Register the background-agent view and its four commands.
 *
 * @returns A disposable that removes the view, the commands and the poll timer.
 */
export function activateBackground(
  context: vscode.ExtensionContext,
  host: BackgroundHost,
): vscode.Disposable {
  const tree: BackgroundTree = new BackgroundTree(host, (finished) => {
    void announce(host, finished, () => void tree.refresh());
  });
  const view = vscode.window.createTreeView(BACKGROUND_VIEW_ID, { treeDataProvider: tree });

  const disposables: vscode.Disposable[] = [
    view,
    { dispose: () => tree.dispose() },
    vscode.commands.registerCommand(BACKGROUND_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(BACKGROUND_COMMANDS.start, async () => {
      const task = await vscode.window.showInputBox({
        title: "Start a background agent",
        prompt: "What should it work on while you do something else?",
        placeHolder: "audit every route for missing authorization",
      });
      if (task === undefined || task.trim() === "") return;
      const started = await host.start(task.trim());
      if (started === undefined) {
        void vscode.window.showWarningMessage(
          "This engine cannot start background agents; use /bg in the terminal instead.",
        );
        return;
      }
      // Refreshed rather than optimistically inserted: the engine queues
      // behind a concurrency limit, so an agent may be `queued` rather than
      // running and a row this side invented would say the wrong thing.
      // Refreshed and then focused, rather than revealed: `reveal` wants a
      // node the provider actually returned, and building a synthetic one to
      // pass it would be a call that quietly does nothing.
      await tree.refresh();
      await vscode.commands.executeCommand(`${BACKGROUND_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand(BACKGROUND_COMMANDS.cancel, async (node?: Node) => {
      if (node === undefined) return;
      const stopped = await host.cancel(node.agent.id);
      if (!stopped) {
        // Not an error: an agent that finished between the render and the
        // click is a race, and the refresh below shows what actually happened.
        void vscode.window.showInformationMessage("That agent had already finished.");
      }
      await tree.refresh();
    }),
    vscode.commands.registerCommand(BACKGROUND_COMMANDS.adopt, async (node?: Node) => {
      if (node === undefined) return;
      await adopt(host, node.agent);
      await tree.refresh();
    }),
  ];

  void tree.refresh();

  const disposable = new vscode.Disposable(() => {
    for (const item of disposables.splice(0)) item.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/**
 * Say that agents finished, once, with the action worth offering.
 *
 * One notification for several, because two agents finishing in the same
 * three-second window should not produce two toasts — the toast storm the
 * reconnect card exists to avoid.
 */
async function announce(
  host: BackgroundHost,
  finished: readonly AgentSummary[],
  refresh: () => void,
): Promise<void> {
  const first = finished[0];
  if (first === undefined) return;
  const message =
    finished.length === 1
      ? `Background agent ${first.status}: ${first.task}`
      : `${finished.length} background agents finished.`;

  const adoptable = finished.filter((agent) => actionsFor(agent).adopt);
  const choice =
    adoptable.length === 1
      ? await vscode.window.showInformationMessage(message, "Bring it into the chat")
      : await vscode.window.showInformationMessage(message, "Show");

  if (choice === "Show") {
    await vscode.commands.executeCommand(`${BACKGROUND_VIEW_ID}.focus`);
    return;
  }
  if (choice === "Bring it into the chat" && adoptable[0] !== undefined) {
    await adopt(host, adoptable[0]);
    refresh();
  }
}

/** Fold one agent's findings into the conversation, and say if that failed. */
async function adopt(host: BackgroundHost, agent: AgentSummary): Promise<void> {
  try {
    await host.adopt(agent.id);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not bring that agent into the chat: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
