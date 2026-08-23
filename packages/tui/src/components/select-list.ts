/**
 * The `SelectList` component: a scrollable, filterable single-choice list.
 *
 * @packageDocumentation
 */

import type { Key } from "../keys.js";
import { style as themeStyle } from "../theme.js";
import type { Component } from "../tui.js";
import { padToWidth, stringWidth, truncateToWidth } from "../width.js";

/** One row of a {@link SelectList}. */
export interface SelectItem<T = unknown> {
  /** Value used for filtering and identity. */
  readonly value: string;
  /** Text shown to the user (defaults to {@link SelectItem.value}). */
  readonly label?: string;
  /** Secondary text shown in a right-hand column when there is room. */
  readonly description?: string;
  /** Arbitrary payload handed back on selection. */
  readonly data?: T;
  /** Render the row as unavailable and skip it during navigation. */
  readonly disabled?: boolean;
}

/** Options for {@link SelectList}. */
export interface SelectListOptions<T = unknown> {
  /** Initial items. */
  readonly items?: readonly SelectItem<T>[];
  /** Maximum rows shown at once (default `8`). */
  readonly maxVisible?: number;
  /** Marker drawn in front of the selected row (default `"❯ "`). */
  readonly pointer?: string;
  /** Let printable keys edit the filter query (default `false`). */
  readonly filterable?: boolean;
  /** Wrap around when navigating past either end (default `true`). */
  readonly wrap?: boolean;
  /** Custom match predicate; defaults to case-insensitive substring matching. */
  readonly matcher?: (item: SelectItem<T>, query: string) => boolean;
  /** Called when the user confirms a row. */
  readonly onSelect?: (item: SelectItem<T>, index: number) => void;
  /** Called when the user presses Escape. */
  readonly onCancel?: () => void;
  /** Called whenever the highlighted row changes. */
  readonly onHighlight?: (item: SelectItem<T> | undefined, index: number) => void;
}

function defaultMatcher<T>(item: SelectItem<T>, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    item.value.toLowerCase().includes(needle) ||
    (item.label ?? "").toLowerCase().includes(needle) ||
    (item.description ?? "").toLowerCase().includes(needle)
  );
}

/**
 * A keyboard-driven list with a sliding viewport.
 *
 * The highlighted row is kept vertically centred until it reaches either end of the
 * list, and an `n more` indicator appears whenever rows are hidden.
 *
 * @example
 * ```ts
 * const list = new SelectList({
 *   items: [{ value: "read" }, { value: "write" }, { value: "bash" }],
 *   filterable: true,
 *   onSelect: (item) => console.log(item.value),
 * });
 * ```
 */
export class SelectList<T = unknown> implements Component {
  private allItems: SelectItem<T>[];
  private readonly options: SelectListOptions<T>;
  private query = "";
  private index = 0;
  private visible: SelectItem<T>[] = [];

  constructor(options: SelectListOptions<T> = {}) {
    this.options = options;
    this.allItems = [...(options.items ?? [])];
    this.refilter();
  }

  /**
   * Move the pointer to the visible item with this `value`.
   *
   * Used to open a picker on the CURRENT choice (the active theme, the
   * session being resumed) instead of always on the first row. Unknown or
   * filtered-out values leave the pointer where it is.
   *
   * @param value - The item's stable `value`.
   */
  select(value: string): void {
    const index = this.visible.findIndex((item) => item.value === value);
    if (index >= 0) this.index = index;
  }

  /** Every item, unfiltered. */
  get items(): readonly SelectItem<T>[] {
    return this.allItems;
  }

  /** Items matching the current filter. */
  get filteredItems(): readonly SelectItem<T>[] {
    return this.visible;
  }

  /** Index of the highlighted row within {@link SelectList.filteredItems}. */
  get selectedIndex(): number {
    return this.index;
  }

  /** The highlighted item, if any. */
  get selected(): SelectItem<T> | undefined {
    return this.visible[this.index];
  }

  /** The current filter query. */
  get filter(): string {
    return this.query;
  }

  /** Replaces the item list, resetting the highlight. */
  setItems(items: readonly SelectItem<T>[]): void {
    this.allItems = [...items];
    this.index = 0;
    this.refilter();
  }

  /** Sets the filter query and re-runs the match. */
  setFilter(query: string): void {
    this.query = query;
    this.index = 0;
    this.refilter();
  }

  /** Highlights a specific row (clamped to the filtered range). */
  setSelectedIndex(index: number): void {
    if (this.visible.length === 0) {
      this.index = 0;
      return;
    }
    this.index = Math.max(0, Math.min(index, this.visible.length - 1));
    this.options.onHighlight?.(this.selected, this.index);
  }

  /** Moves the highlight down one row. */
  selectNext(): void {
    this.step(1);
  }

  /** Moves the highlight up one row. */
  selectPrevious(): void {
    this.step(-1);
  }

  /** Moves the highlight down one viewport. */
  pageDown(): void {
    this.setSelectedIndex(this.index + this.maxVisible());
  }

  /** Moves the highlight up one viewport. */
  pageUp(): void {
    this.setSelectedIndex(this.index - this.maxVisible());
  }

  /** Confirms the highlighted row, invoking `onSelect`. */
  confirm(): boolean {
    const item = this.selected;
    if (!item || item.disabled) return false;
    this.options.onSelect?.(item, this.index);
    return true;
  }

  handleInput(key: Key): boolean {
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      this.selectPrevious();
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      this.selectNext();
      return true;
    }
    if (key.name === "pageup") {
      this.pageUp();
      return true;
    }
    if (key.name === "pagedown") {
      this.pageDown();
      return true;
    }
    if (key.name === "home") {
      this.setSelectedIndex(0);
      return true;
    }
    if (key.name === "end") {
      this.setSelectedIndex(this.visible.length - 1);
      return true;
    }
    if (key.name === "enter") return this.confirm();
    if (key.name === "escape") {
      this.options.onCancel?.();
      return true;
    }
    if (this.options.filterable) {
      if (key.name === "backspace") {
        if (this.query === "") return false;
        this.setFilter(this.query.slice(0, -1));
        return true;
      }
      if (key.text !== undefined && !key.ctrl && !key.alt) {
        this.setFilter(this.query + key.text);
        return true;
      }
    }
    return false;
  }

  render(width: number): string[] {
    const pointer = this.options.pointer ?? "❯ ";
    const pointerWidth = stringWidth(pointer);
    const blank = " ".repeat(pointerWidth);
    const max = this.maxVisible();

    const lines: string[] = [];
    if (this.options.filterable && this.query !== "") {
      lines.push(themeStyle("muted")(truncateToWidth(`filter: ${this.query}`, width)));
    }

    if (this.visible.length === 0) {
      lines.push(themeStyle("muted")(truncateToWidth("no matches", width)));
      return lines;
    }

    const start = Math.max(
      0,
      Math.min(this.index - Math.floor(max / 2), this.visible.length - max),
    );
    const end = Math.min(start + max, this.visible.length);

    const labelWidth = Math.max(
      ...this.visible.slice(start, end).map((i) => stringWidth(i.label ?? i.value)),
    );
    const hasDescriptions = this.visible.slice(start, end).some((i) => i.description);
    const columnWidth = Math.min(labelWidth + 2, Math.max(8, Math.floor(width * 0.5)));

    for (let i = start; i < end; i++) {
      const item = this.visible[i]!;
      const isSelected = i === this.index;
      const label = item.label ?? item.value;
      const prefix = isSelected ? themeStyle("accent")(pointer) : blank;
      const body = width - pointerWidth;

      let row: string;
      if (hasDescriptions && item.description && body > columnWidth + 8) {
        const main = padToWidth(truncateToWidth(label, columnWidth), columnWidth);
        const desc = truncateToWidth(item.description, body - columnWidth);
        row = styleFor(isSelected, item.disabled)(main) + themeStyle("muted")(desc);
      } else {
        row = styleFor(isSelected, item.disabled)(truncateToWidth(label, body));
      }
      lines.push(prefix + row);
    }

    const hidden = this.visible.length - (end - start);
    if (hidden > 0) {
      lines.push(
        themeStyle("muted")(
          truncateToWidth(`  … ${hidden} more (${this.index + 1}/${this.visible.length})`, width),
        ),
      );
    }
    return lines;
  }

  private maxVisible(): number {
    return Math.max(1, this.options.maxVisible ?? 8);
  }

  private refilter(): void {
    const matcher = this.options.matcher ?? defaultMatcher;
    this.visible =
      this.query === "" ? [...this.allItems] : this.allItems.filter((i) => matcher(i, this.query));
    if (this.index >= this.visible.length) this.index = Math.max(0, this.visible.length - 1);
    this.options.onHighlight?.(this.selected, this.index);
  }

  private step(direction: 1 | -1): void {
    const count = this.visible.length;
    if (count === 0) return;
    const wrap = this.options.wrap ?? true;
    let next = this.index;
    for (let attempts = 0; attempts < count; attempts++) {
      next += direction;
      if (next < 0) {
        if (!wrap) return;
        next = count - 1;
      } else if (next >= count) {
        if (!wrap) return;
        next = 0;
      }
      if (!this.visible[next]?.disabled) break;
    }
    this.index = next;
    this.options.onHighlight?.(this.selected, this.index);
  }
}

function styleFor(selected: boolean, disabled: boolean | undefined) {
  if (disabled) return themeStyle("muted");
  return selected ? themeStyle("selection") : themeStyle("text");
}
