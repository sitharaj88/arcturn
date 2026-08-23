import { ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "./Card";

/** A compact card that is entirely a link: title, one line, an arrow. */
export interface LinkCardProps {
  title: string;
  body?: string;
  href: string;
  external?: boolean;
  className?: string;
}

export function LinkCard({ title, body, href, external, className }: LinkCardProps) {
  const Arrow = external ? ArrowUpRight : ArrowRight;
  return (
    <Card href={href} external={external} className={cn("group h-full p-4 sm:p-5", className)}>
      <span className="flex items-start justify-between gap-3">
        <span className="text-h4 text-text">{title}</span>
        <Arrow
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-faint transition-colors dur-fast ease-out group-hover:text-accent"
        />
      </span>
      {body ? <span className="mt-2 block text-body-sm text-muted">{body}</span> : null}
    </Card>
  );
}
