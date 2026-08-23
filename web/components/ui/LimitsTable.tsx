import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { cardSurface } from "./Card";

/**
 * Every known limit of every safety control. Warn-toned, not red: these are
 * documented boundaries, not failures (DESIGN.md §0.4, §3.8).
 */
export interface LimitRow {
  control: string;
  limit: ReactNode;
}

export interface LimitsTableProps {
  rows: LimitRow[];
  className?: string;
}

export function LimitsTable({ rows, className }: LimitsTableProps) {
  return (
    <ul className={cn("list-none space-y-3", className)}>
      {rows.map((row) => (
        <li
          key={row.control}
          // Card's `limit` surface — the warn edge is defined once, there.
          className={cn(
            "rounded-md border p-4",
            cardSurface({ variant: "limit", elevated: false }),
          )}
        >
          <p className="text-body-sm font-medium text-text">{row.control}</p>
          <p className="mt-1.5 text-body-sm text-muted">{row.limit}</p>
        </li>
      ))}
    </ul>
  );
}
