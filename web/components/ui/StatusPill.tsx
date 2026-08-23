import type { LucideIcon } from "lucide-react";
import { CircleCheck, CircleDashed, CircleSlash, Clock } from "lucide-react";
import { Badge, type BadgeVariant } from "./Badge";

/**
 * Status is never signalled by colour alone: every pill carries a colour, an
 * icon and a word (DESIGN.md §2.6).
 */
export type Status = "proven" | "unproven" | "unreached" | "planned";

export interface StatusPillProps {
  status: Status;
  label?: string;
  className?: string;
}

const STATUS: Record<Status, { variant: BadgeVariant; icon: LucideIcon; label: string }> = {
  proven: { variant: "good", icon: CircleCheck, label: "Proven" },
  unproven: { variant: "warn", icon: CircleDashed, label: "Unproven" },
  unreached: { variant: "bad", icon: CircleSlash, label: "Not reached" },
  planned: { variant: "neutral", icon: Clock, label: "Planned" },
};

export function StatusPill({ status, label, className }: StatusPillProps) {
  const { variant, icon: Icon, label: fallback } = STATUS[status];
  return (
    <Badge
      variant={variant}
      className={className}
      icon={<Icon className="size-3.5" aria-hidden="true" />}
    >
      {label ?? fallback}
    </Badge>
  );
}
