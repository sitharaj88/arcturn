import type { ElementType, ReactNode } from "react";

/**
 * Content for assistive technology only. Used to caption terminal art, which
 * is `aria-hidden` because the ANSI-style layout is noise when read aloud.
 */
export interface VisuallyHiddenProps {
  as?: ElementType;
  children: ReactNode;
}

export function VisuallyHidden({ as, children }: VisuallyHiddenProps) {
  const Tag = (as ?? "span") as ElementType;
  return <Tag className="sr-only">{children}</Tag>;
}
