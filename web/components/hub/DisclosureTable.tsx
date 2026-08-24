import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The disclosure block's one table shape.
 *
 * A real `<table>` from 768px up and a stack of labelled blocks below it —
 * the split `DefinitionTable` already uses, for the same reason: three or four
 * columns cannot stay readable at 360px, and a table that only survives inside
 * a horizontal scroller hides the column a reader came for.
 *
 * The first cell of every row is the row's subject (the role, the workflow,
 * the skill), which is why it becomes the `<th scope="row">` in the table and
 * the heading of the block on narrow screens.
 */
export interface DisclosureColumn {
  header: string;
  /** Extra classes for this column's cells — column widths live at call sites. */
  className?: string;
}

export interface DisclosureRow {
  /** Stable key — the subject's name. */
  key: string;
  cells: ReactNode[];
}

export interface DisclosureTableProps {
  caption: string;
  columns: DisclosureColumn[];
  rows: DisclosureRow[];
  className?: string;
}

export function DisclosureTable({ caption, columns, rows, className }: DisclosureTableProps) {
  return (
    <div className={cn("w-full", className)}>
      <ul className="list-none border-y border-default md:hidden">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 border-b border-default py-4 last:border-b-0">
            <p className="min-w-0 break-words text-body-sm font-medium text-text">{row.cells[0]}</p>
            {row.cells.slice(1).map((cell, index) => (
              <p
                key={columns[index + 1].header}
                className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1"
              >
                <span className="text-caption uppercase tracking-wide text-faint">
                  {columns[index + 1].header}
                </span>
                <span className="min-w-0 text-body-sm text-muted">{cell}</span>
              </p>
            ))}
          </li>
        ))}
      </ul>

      {/* Wide content owns its own scroller (DESIGN.md §2.3.5) — `body` never
          scrolls sideways because a tools list ran long. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.header}
                  scope="col"
                  className={cn(
                    "border-b border-default py-2.5 pr-6 text-caption font-semibold uppercase tracking-wide text-faint last:pr-0",
                    column.className,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th
                  scope="row"
                  className={cn(
                    "border-b border-default py-3.5 pr-6 align-top text-body-sm font-medium text-text",
                    columns[0].className,
                  )}
                >
                  {row.cells[0]}
                </th>
                {row.cells.slice(1).map((cell, index) => (
                  <td
                    key={columns[index + 1].header}
                    className={cn(
                      "border-b border-default py-3.5 pr-6 align-top text-body-sm text-muted last:pr-0",
                      columns[index + 1].className,
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
