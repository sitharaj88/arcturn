"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Scroll reveal, as progressive enhancement (DESIGN.md §2.5).
 *
 * The critical property is that the SERVER-RENDERED markup is fully visible:
 * the animation is armed by JS after mount, never in the HTML. An earlier
 * version rendered `opacity: 0` into the static export and relied on
 * hydration plus an intersection observer to undo it, which left whole
 * sections blank for anyone without JS, for crawlers, and for the window
 * between paint and hydration.
 *
 * Only content BELOW the fold is armed, so nothing already on screen can
 * flash. `prefers-reduced-motion` opts out entirely.
 */
export interface RevealProps {
  /** Stagger delay in seconds. */
  delay?: number;
  className?: string;
  children: ReactNode;
}

export function Reveal({ delay = 0, className, children }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Already on screen: leave it exactly as the server drew it.
    if (element.getBoundingClientRect().top < window.innerHeight - 80) return;

    element.dataset.reveal = "armed";
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          element.dataset.reveal = "in";
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -80px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn(className)}
      // `--reveal-delay` inherits, so a nested Reveal that omitted its own
      // would animate on its ancestor's stagger. Always declare it.
      style={{ "--reveal-delay": `${Math.round(delay * 1000)}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}
