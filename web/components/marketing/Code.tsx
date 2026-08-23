import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Inline code inside marketing copy (DESIGN.md §2.2.4). `.prose-arc` styles
 * `<code>` for rendered markdown; marketing sections are hand-written JSX, so
 * they need the same chip explicitly. Colour is `--text`, never accent —
 * coloured code beside coloured links is unreadable.
 */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "rounded-xs border border-default bg-surface-inset px-[0.36em] py-[0.12em]",
        "font-mono text-[0.875em] font-medium text-text",
        className,
      )}
    >
      {children}
    </code>
  );
}
