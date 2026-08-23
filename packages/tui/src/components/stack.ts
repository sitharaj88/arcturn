/**
 * The `Stack` component: vertical composition of child components.
 *
 * @packageDocumentation
 */

import type { Key } from "../keys.js";
import type { Component, CursorPosition } from "../tui.js";

/** Options for {@link Stack}. */
export interface StackOptions {
  /** Blank rows inserted between children (default `0`). */
  readonly gap?: number;
}

/**
 * Stacks components vertically.
 *
 * Input is offered to each child in order until one consumes it, and the first
 * child reporting a cursor wins, with its row translated into stack coordinates —
 * so a `Stack` can itself be the focused component of a {@link TUI}.
 *
 * @example
 * ```ts
 * const panel = new Stack([header, body, footer], { gap: 1 });
 * ```
 */
export class Stack implements Component {
  private childList: Component[];
  private readonly gap: number;
  private offsets: number[] = [];

  constructor(children: readonly Component[] = [], options: StackOptions = {}) {
    this.childList = [...children];
    this.gap = Math.max(0, options.gap ?? 0);
  }

  /** The child components, top to bottom. */
  get children(): readonly Component[] {
    return this.childList;
  }

  /** Appends a child. */
  add(child: Component): void {
    this.childList.push(child);
  }

  /** Removes a child. Returns `true` when it was present. */
  remove(child: Component): boolean {
    const index = this.childList.indexOf(child);
    if (index === -1) return false;
    this.childList.splice(index, 1);
    return true;
  }

  /** Replaces all children. */
  setChildren(children: readonly Component[]): void {
    this.childList = [...children];
  }

  invalidate(): void {
    for (const child of this.childList) child.invalidate?.();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    this.offsets = [];
    for (let i = 0; i < this.childList.length; i++) {
      if (i > 0) for (let g = 0; g < this.gap; g++) lines.push("");
      this.offsets.push(lines.length);
      lines.push(...this.childList[i]!.render(width));
    }
    return lines;
  }

  handleInput(key: Key): boolean {
    for (const child of this.childList) {
      if (child.handleInput?.(key) === true) return true;
    }
    return false;
  }

  getCursor(): CursorPosition | undefined {
    for (let i = 0; i < this.childList.length; i++) {
      const local = this.childList[i]!.getCursor?.();
      if (local) return { row: (this.offsets[i] ?? 0) + local.row, col: local.col };
    }
    return undefined;
  }
}
