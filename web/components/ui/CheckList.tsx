import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { nodeText, withStableKeys } from "@/lib/keys";

/** A list whose markers are affirmations rather than bullets. */
export interface CheckListProps {
  items: ReactNode[];
  className?: string;
}

export function CheckList({ items, className }: CheckListProps) {
  return (
    <ul className={cn("list-none space-y-3", className)}>
      {withStableKeys(items, nodeText).map(({ key, item }) => (
        <li key={key} className="flex gap-3 text-body-sm text-muted">
          <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent" />
          <span className="min-w-0 wrap-anywhere">{item}</span>
        </li>
      ))}
    </ul>
  );
}
