import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ArcEyebrow } from "./ArcEyebrow";
import { Container, type ContainerSize } from "./Container";

/**
 * The two vertical rhythm tiers (DESIGN.md §2.3.1), exported so `SplitSection`
 * and `CTASection` land on the same beat instead of each picking its own.
 *
 * `default` is deliberately shorter than the `py-20/28/32` it replaced: eight
 * consecutive sections at 128px read as one undifferentiated ribbon, because
 * uniform spacing carries no information. Rhythm comes from the *contrast*
 * between the two tiers and from the band treatment below, not from padding.
 */
export const SECTION_RHYTHM = {
  /** 64 / 80 / 96px — a full beat: a heading, a lede and a body block. */
  default: "py-16 md:py-20 lg:py-24",
  /** 40 / 56 / 64px — an inventory grid or a table that belongs to the beat above it. */
  tight: "py-10 md:py-14 lg:py-16",
} as const;

export type SectionDensity = keyof typeof SECTION_RHYTHM;

/**
 * The alternating band (DESIGN.md §2.3.1). One step of surface plus the two
 * hairlines that make the step deliberate rather than a rendering artefact.
 * Apply it to chosen beats, never to consecutive ones — two touching bands
 * double the hairline and cancel the alternation that gives them meaning.
 */
export const SECTION_BAND = "bg-surface-raised border-y border-default";

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
  /** Vertical rhythm tier. `tight` for grids that continue the beat above. */
  density?: SectionDensity;
  /** Raised ground + hairlines, for alternating bands down a long page. */
  band?: boolean;
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
  density = "default",
  band = false,
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
    <section id={id} className={cn(SECTION_RHYTHM[density], band && SECTION_BAND, className)}>
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
              // One measure for every lede on the site (§2.3.2). The 60ch/62ch
              // split this replaced was two hand-typed numbers for one idea.
              <p
                className={cn(
                  "max-w-(--measure-lede) text-lede text-muted",
                  (title || eyebrow) && "mt-4",
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
