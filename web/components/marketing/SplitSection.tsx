import type { ReactNode } from "react";
import { ArcEyebrow } from "@/components/ui/ArcEyebrow";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { SECTION_BAND, SECTION_RHYTHM } from "@/components/ui/Section";
import { cn } from "@/lib/cn";

/**
 * A landing-page beat: copy on one side, a piece of evidence (terminal art, a
 * code sample) on the other. `reverse` mirrors the pair on desktop so
 * consecutive beats alternate instead of marching down one edge.
 */
export interface SplitSectionProps {
  id?: string;
  eyebrow: string;
  title: ReactNode;
  media: ReactNode;
  reverse?: boolean;
  /** Raised ground + hairlines, for alternating bands down a long page. */
  band?: boolean;
  className?: string;
  children: ReactNode;
}

export function SplitSection({
  id,
  eyebrow,
  title,
  media,
  reverse = false,
  band = false,
  className,
  children,
}: SplitSectionProps) {
  return (
    // One rhythm for every landing beat, owned by <Section> (DESIGN.md §2.3.1).
    <section id={id} className={cn(SECTION_RHYTHM.default, band && SECTION_BAND, className)}>
      <Container>
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
          <Reveal className={cn("min-w-0", reverse && "lg:order-2")}>
            <p className="flex items-center gap-2 text-eyebrow uppercase text-faint">
              <ArcEyebrow />
              <span>{eyebrow}</span>
            </p>
            <h2 className="mt-3 text-h2 text-balance text-text">{title}</h2>
            <div className="mt-5 flex max-w-(--measure-body) flex-col gap-5 lg:max-w-none">
              {children}
            </div>
          </Reveal>
          <Reveal delay={0.06} className={cn("min-w-0", reverse && "lg:order-1")}>
            {media}
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
