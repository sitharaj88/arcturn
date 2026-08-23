import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isExternalHref } from "@/lib/utils";

/**
 * The surface. Dark elevates with surface + hairline, light with a warm
 * shadow (DESIGN.md §2.3.4). When `href` is set the whole card becomes a
 * single link — never nest another interactive element inside it.
 */
export type CardVariant = "default" | "quiet" | "accent" | "limit";

export interface CardProps {
  variant?: CardVariant;
  href?: string;
  external?: boolean;
  /** Set false to drop the corner tick (e.g. dense list rows). */
  corner?: boolean;
  className?: string;
  children: ReactNode;
}

const VARIANTS: Record<CardVariant, string> = {
  default: "bg-surface-card border-default elev-sm",
  quiet: "bg-transparent border-default",
  accent:
    "bg-[color-mix(in_oklab,var(--accent)_7%,var(--surface-card))] border-accent-edge elev-sm",
  limit: "bg-surface-card border-default border-l-2 border-l-warn elev-sm",
};

const INTERACTIVE =
  "hover:bg-surface-hover hover:border-strong lg:hover:-translate-y-0.5 lg:hover:elev-md";

export function Card({
  variant = "default",
  href,
  external,
  corner = true,
  className,
  children,
}: CardProps) {
  const classes = cn(
    "relative rounded-lg border p-5 sm:p-6 transition-[background-color,border-color,box-shadow,transform] dur-fast ease-out",
    VARIANTS[variant],
    corner && "arc-corner",
    href && INTERACTIVE,
    className,
  );

  if (!href) {
    return <div className={classes}>{children}</div>;
  }

  if (external || isExternalHref(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cn(classes, "block")}>
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={cn(classes, "block")}>
      {children}
    </Link>
  );
}
