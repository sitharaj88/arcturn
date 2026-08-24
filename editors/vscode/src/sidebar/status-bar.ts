/**
 * The cost status-bar item.
 *
 * A thin adapter: every decision about *what* to show is in `cost.ts`, which
 * mirrors the engine's own honesty rules (`$0.42`, `$0.42+`, `n/a`). This file
 * only owns the VS Code object's lifecycle.
 */

import * as vscode from "vscode";
import { type CostState, costLabel, costTooltip, initialCostState } from "./cost.js";

/** The live spend indicator. */
export class CostStatusBar {
  readonly #item: vscode.StatusBarItem;
  #state: CostState = initialCostState;

  /**
   * @param command - Command run when the item is clicked (the breakdown).
   */
  constructor(command: string) {
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.#item.command = command;
    this.#item.name = "Arcturn cost";
    this.update(initialCostState);
  }

  /** The totals currently displayed. */
  get state(): CostState {
    return this.#state;
  }

  /**
   * Repaint from new totals.
   *
   * @param state - Current spend.
   */
  update(state: CostState): void {
    this.#state = state;
    this.#item.text = `$(credit-card) ${costLabel(state)}`;
    this.#item.tooltip = costTooltip(state);
  }

  /** Show the item (once a session exists). */
  show(): void {
    this.#item.show();
  }

  /** Hide the item (no session). */
  hide(): void {
    this.#item.hide();
  }

  dispose(): void {
    this.#item.dispose();
  }
}
