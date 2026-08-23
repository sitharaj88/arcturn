import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { cardSurface } from "./Card";
import { StatusPill, type StatusPillProps } from "./StatusPill";

/**
 * What is proven and what isn't, stated plainly. Required on `/open-source`
 * and never softened or collapsed (DESIGN.md §0.4).
 */
export interface StatusRow {
  name: string;
  detail: ReactNode;
  status: StatusPillProps;
}

export interface StatusTableProps {
  rows: StatusRow[];
  className?: string;
}

export function StatusTable({ rows, className }: StatusTableProps) {
  return (
    // Card's `quiet` surface: hairlines only, ground left transparent, so the
    // table reads correctly on the page ground *and* on a raised band.
    <ul
      className={cn(
        "list-none border-y",
        cardSurface({ variant: "quiet", elevated: false }),
        className,
      )}
    >
      {rows.map((row) => (
        <li
          key={row.name}
          className="flex flex-col gap-2 border-b border-default py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
        >
          <div className="min-w-0">
            <p className="text-body-sm font-medium text-text">{row.name}</p>
            <p className="mt-1 text-body-sm text-muted">{row.detail}</p>
          </div>
          <div className="shrink-0">
            <StatusPill {...row.status} />
          </div>
        </li>
      ))}
    </ul>
  );
}
