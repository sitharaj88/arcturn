import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The measure. Every page section sits inside one of four widths
 * (DESIGN.md §2.3.2); nothing hard-codes a max-width.
 */
export type ContainerSize = "prose" | "content" | "wide" | "shell";

export interface ContainerProps extends ComponentPropsWithoutRef<"div"> {
  size?: ContainerSize;
  as?: ElementType;
  children?: ReactNode;
}

const SIZES: Record<ContainerSize, string> = {
  prose: "container-prose",
  content: "container",
  wide: "container-wide",
  shell: "container-shell",
};

export function Container({ size = "content", as, className, children, ...rest }: ContainerProps) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag className={cn(SIZES[size], className)} {...rest}>
      {children}
    </Tag>
  );
}
