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
  /** Opt in to the corner tick — §2.4 gives it to feature cards, not every card. */
  corner?: boolean;
  className?: string;
  children: ReactNode;
}

/** Ground + hairline per variant. Geometry (radius, padding) is the caller's. */
const SURFACE: Record<CardVariant, string> = {
  default: "bg-surface-card border-default",
  quiet: "bg-transparent border-default",
  accent: "bg-[color-mix(in_oklab,var(--accent)_7%,var(--surface-card))] border-accent-edge",
  limit: "bg-surface-card border-default border-l-2 border-l-warn",
};

/** The light theme's warm shadow. `quiet` is a hairline on the page ground. */
const ELEVATION: Record<CardVariant, string> = {
  default: "elev-sm",
  quiet: "",
  accent: "elev-sm",
  limit: "elev-sm",
};

export interface CardSurfaceOptions {
  variant?: CardVariant;
  /** §2.3.4 lifts cards off the page; blocks *inside* a section stay flat. */
  elevated?: boolean;
}

/**
 * The surface recipe without Card's geometry.
 *
 * Blocks that are card-shaped but not cards — a `<nav>`, an `<li>`, a `<ul>`
 * of hairline rules — compose this instead of retyping `border-default
 * bg-surface-card`, so a palette change to Card reaches them too. `<Card>` is
 * exactly this plus its own radius, padding and transition.
 */
export function cardSurface({ variant = "default", elevated = true }: CardSurfaceOptions = {}) {
  return cn(SURFACE[variant], elevated && ELEVATION[variant]);
}

const INTERACTIVE =
  "hover:bg-surface-hover hover:border-strong lg:hover:-translate-y-0.5 lg:hover:elev-md";

export function Card({
  variant = "default",
  href,
  external,
  corner = false,
  className,
  children,
}: CardProps) {
  const classes = cn(
    "relative rounded-lg border p-5 sm:p-6 transition-[background-color,border-color,box-shadow,transform] dur-fast ease-out",
    cardSurface({ variant }),
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
