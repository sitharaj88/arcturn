"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * How far through the article you are, as a 2px rule under the sticky header.
 *
 * Three properties keep it inside the rules in DESIGN.md §2.5:
 *
 * - **No layout shift.** The bar is `fixed`, so it occupies no space in flow
 *   and cannot move a single line of the post when it appears.
 * - **Reduced-motion safe by construction.** It has no transition and no
 *   keyframes; its only movement is the reader's own scrolling, already in
 *   progress. There is nothing for the `prefers-reduced-motion` kill switch
 *   to switch off, and nothing that moves when the reader is still.
 * - **No new dependency and no server cost.** One `useEffect`, a passive
 *   scroll listener coalesced onto `requestAnimationFrame`, and a ref. The
 *   markup ships at `scaleX(0)`, so without JavaScript the page has an
 *   invisible 2px strip and nothing else.
 *
 * The width is written as an inline `transform`, deliberately not Tailwind's
 * `scale-x-*`: v4 compiles that to the `scale` property, which composes with
 * `transform` instead of being replaced by it — the bar would multiply by the
 * class's 0 and never appear.
 */
export interface ReadingProgressProps {
  /** Id of the element whose scroll-through is reported. */
  targetId: string;
  className?: string;
}

export function ReadingProgress({ targetId, className }: ReadingProgressProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = ref.current;
    const target = document.getElementById(targetId);
    if (!bar || !target) return;

    let frame = 0;

    const measure = () => {
      frame = 0;
      const { top, height } = target.getBoundingClientRect();
      // The scrollable span of the article: from its first line at the top of
      // the viewport to its last line clearing the bottom. An article shorter
      // than the viewport has no span at all, so it is either not started (0)
      // or entirely on screen and therefore finished (1).
      const span = height - window.innerHeight;
      const progress = span <= 0 ? (top <= 0 ? 1 : 0) : Math.min(Math.max(-top / span, 0), 1);
      bar.style.transform = `scaleX(${progress})`;
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [targetId]);

  return (
    <div
      aria-hidden="true"
      // Below the header's own layer, so it reads as part of the chrome the
      // header sits on rather than something floating over it.
      className={cn(
        "pointer-events-none fixed inset-x-0 top-16 z-(--z-sticky) h-0.5",
        "print:hidden",
        className,
      )}
    >
      <div ref={ref} className="h-full origin-left bg-accent" style={{ transform: "scaleX(0)" }} />
    </div>
  );
}
