import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A pill: caption type, hairline border, 12% tint fill (DESIGN.md §4). */
export type BadgeVariant = "neutral" | "accent" | "good" | "warn" | "bad";

export interface BadgeProps {
  variant?: BadgeVariant;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: "border-default bg-surface-card text-muted",
  accent: "border-accent-edge bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-accent",
  good: "border-[color-mix(in_oklab,var(--good)_38%,transparent)] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
  warn: "border-[color-mix(in_oklab,var(--warn)_38%,transparent)] bg-[color-mix(in_oklab,var(--warn)_12%,transparent)] text-warn",
  bad: "border-[color-mix(in_oklab,var(--bad)_38%,transparent)] bg-[color-mix(in_oklab,var(--bad)_12%,transparent)] text-bad",
};

export function Badge({ variant = "neutral", icon, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-caption font-medium",
        VARIANTS[variant],
        className,
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
