import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

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
          className="rounded-md border border-default border-l-2 border-l-warn bg-surface-card p-4"
        >
          <p className="text-body-sm font-medium text-text">{row.control}</p>
          <p className="mt-1.5 text-body-sm text-muted">{row.limit}</p>
        </li>
      ))}
    </ul>
  );
}
