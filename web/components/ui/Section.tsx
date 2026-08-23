import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ArcEyebrow } from "./ArcEyebrow";
import { Container, type ContainerSize } from "./Container";

/**
 * The landing-section wrapper: vertical rhythm, the arc eyebrow, and the
 * heading/lede stack at the spacing fixed in DESIGN.md §2.3.1.
 */
export interface SectionProps {
  eyebrow?: string;
  title?: ReactNode;
  lede?: ReactNode;
  align?: "start" | "center";
  size?: ContainerSize;
  /** Heading level for `title`. Interior pages sometimes need h3. */
  headingLevel?: 2 | 3;
  id?: string;
  className?: string;
  /** Extra classes for the inner content wrapper below the heading block. */
  bodyClassName?: string;
  children?: ReactNode;
}

export function Section({
  eyebrow,
  title,
  lede,
  align = "start",
  size = "content",
  headingLevel = 2,
  id,
  className,
  bodyClassName,
  children,
}: SectionProps) {
  const Heading = `h${headingLevel}` as ElementType;
  const centered = align === "center";
  const hasHead = Boolean(eyebrow || title || lede);

  return (
    <section id={id} className={cn("py-20 md:py-28 lg:py-32", className)}>
      <Container size={size}>
        {hasHead ? (
          <div className={cn("flex flex-col", centered && "items-center text-center")}>
            {eyebrow ? (
              <p className="flex items-center gap-2 text-eyebrow uppercase text-faint">
                <ArcEyebrow />
                <span>{eyebrow}</span>
              </p>
            ) : null}
            {title ? (
              <Heading className={cn("text-h2 text-balance text-text", eyebrow && "mt-3")}>
                {title}
              </Heading>
            ) : null}
            {lede ? (
              <p
                className={cn(
                  "text-lede text-muted",
                  (title || eyebrow) && "mt-4",
                  centered ? "max-w-[60ch]" : "max-w-[62ch]",
                )}
              >
                {lede}
              </p>
            ) : null}
          </div>
        ) : null}
        {children ? (
          <div className={cn(hasHead && "mt-8 md:mt-12", bodyClassName)}>{children}</div>
        ) : null}
      </Container>
    </section>
  );
}
