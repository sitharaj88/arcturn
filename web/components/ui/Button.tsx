import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one button. Renders a `<Link>` for internal hrefs, a hardened `<a>` for
 * external ones, and a `<button>` otherwise — so a caller never has to choose
 * an element to get the right styling.
 */
export type ButtonVariant = "primary" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
  external?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  type?: "button" | "submit" | "reset";
  children?: ReactNode;
}

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium " +
  "whitespace-nowrap transition-[background-color,border-color,color,box-shadow] " +
  "dur-fast ease-out disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  // The gold fill is #f2af48 in both themes: the primary CTA is identical
  // everywhere and never darkens on light (DESIGN.md §2.1.2).
  primary: "bg-gold text-on-accent border border-transparent hover:bg-gold-hover elev-glow",
  ghost:
    "border border-strong text-text bg-transparent hover:bg-surface-hover hover:border-accent-edge",
  quiet: "border border-transparent text-muted hover:text-text hover:bg-surface-hover",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-body-sm",
  md: "h-11 px-5 text-body-sm",
  lg: "h-12 px-6 text-body",
};

export function Button({
  variant = "primary",
  size = "md",
  href,
  external,
  iconLeft,
  iconRight,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = cn(BASE, VARIANTS[variant], SIZES[size], className);

  const inner = (
    <>
      {iconLeft}
      <span>{children}</span>
      {iconRight}
      {external ? <ArrowUpRight aria-hidden="true" className="size-4" /> : null}
    </>
  );

  if (href && external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={classes}
        {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {inner}
      </a>
    );
  }

  if (href) {
    return (
      <Link
        href={href}
        className={classes}
        {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {inner}
      </Link>
    );
  }

  return (
    <button type={type} className={classes} {...rest}>
      {inner}
    </button>
  );
}
