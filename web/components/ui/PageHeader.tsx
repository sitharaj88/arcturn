import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ArcEyebrow } from "./ArcEyebrow";

/** The interior-page `h1` block. One per page (DESIGN.md §2.6). */
export interface PageHeaderProps {
  title: string;
  lede?: ReactNode;
  eyebrow?: string;
  breadcrumb?: ReactNode;
  align?: "start" | "center";
  className?: string;
  children?: ReactNode;
}

export function PageHeader({
  title,
  lede,
  eyebrow,
  breadcrumb,
  align = "start",
  className,
  children,
}: PageHeaderProps) {
  const centered = align === "center";

  return (
    <div className={cn("flex flex-col", centered && "items-center text-center", className)}>
      {breadcrumb ? <div className="mb-5">{breadcrumb}</div> : null}
      {eyebrow ? (
        <p className="flex items-center gap-2 text-eyebrow uppercase text-faint">
          <ArcEyebrow />
          <span>{eyebrow}</span>
        </p>
      ) : null}
      <h1 className={cn("text-display-2 text-balance text-text", eyebrow && "mt-3")}>{title}</h1>
      {lede ? (
        <p className={cn("mt-4 max-w-[60ch] text-lede text-muted", centered && "mx-auto")}>
          {lede}
        </p>
      ) : null}
      {children ? <div className="mt-8">{children}</div> : null}
    </div>
  );
}
