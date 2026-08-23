import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A mono command and the one line that says what it does. */
export interface CommandListItem {
  command: string;
  body: ReactNode;
}

export interface CommandListProps {
  items: CommandListItem[];
  className?: string;
}

export function CommandList({ items, className }: CommandListProps) {
  return (
    <dl className={cn("divide-y divide-[var(--border)] border-y border-default", className)}>
      {items.map((item) => (
        <div key={item.command} className="py-4">
          <dt className="overflow-x-auto">
            <code className="whitespace-nowrap font-mono text-body-sm font-medium text-text">
              {item.command}
            </code>
          </dt>
          <dd className="mt-2 text-body-sm text-muted">{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}
