import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { nodeText, withStableKeys } from "@/lib/keys";

/**
 * Term/definition pairs. A real table from 768px up, a definition list below,
 * because a two-column table cannot stay readable at 360px.
 */
export interface DefinitionRow {
  term: ReactNode;
  definition: ReactNode;
}

export interface DefinitionTableProps {
  rows: DefinitionRow[];
  termHeader?: string;
  defHeader?: string;
  className?: string;
}

export function DefinitionTable({
  rows,
  termHeader = "Name",
  defHeader = "What it does",
  className,
}: DefinitionTableProps) {
  // One key per row, derived from the term, shared by both layouts.
  const keyedRows = withStableKeys(rows, (row) => nodeText(row.term));

  return (
    <div className={cn("w-full", className)}>
      <dl className="border-y border-default md:hidden">
        {keyedRows.map(({ key, item: row }) => (
          <div key={key} className="border-b border-default py-4 last:border-b-0">
            <dt className="text-body-sm font-medium text-text">{row.term}</dt>
            <dd className="mt-1.5 text-body-sm text-muted">{row.definition}</dd>
          </div>
        ))}
      </dl>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              <th
                scope="col"
                className="w-56 border-b border-default py-2.5 pr-6 text-caption font-semibold uppercase tracking-wide text-faint"
              >
                {termHeader}
              </th>
              <th
                scope="col"
                className="border-b border-default py-2.5 text-caption font-semibold uppercase tracking-wide text-faint"
              >
                {defHeader}
              </th>
            </tr>
          </thead>
          <tbody>
            {keyedRows.map(({ key, item: row }) => (
              <tr key={key}>
                <th
                  scope="row"
                  className="border-b border-default py-3.5 pr-6 align-top text-body-sm font-medium text-text"
                >
                  {row.term}
                </th>
                <td className="border-b border-default py-3.5 align-top text-body-sm text-muted">
                  {row.definition}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
