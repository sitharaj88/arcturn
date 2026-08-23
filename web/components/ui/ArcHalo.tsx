import { type CSSProperties, useId } from "react";
import { cn } from "@/lib/cn";
import { ARC_PATH, STAR_PATH } from "./StarMark";

/**
 * The Turn Arc at scale 3 (DESIGN.md §2.4): the hero halo. A single SVG with a
 * radial glow behind it that rotates once every 240 seconds — imperceptible
 * frame to frame, alive if you stare. Static under reduced motion (the
 * animation is CSS, so the global reduce block neutralises it).
 *
 * Always decorative; position it with the `className` from the caller.
 *
 * The halo is deliberately wider than a phone viewport (`min(440px, 118vw)`),
 * so **the caller's positioned ancestor must clip it** — `relative
 * overflow-hidden` on the section, not on anything inside this component. The
 * component cannot enforce that itself: a clipper around the `<svg>` would be
 * the very box that overflows, and one at this component's root would clip
 * against whatever the caller made `relative`, which on the home hero is the
 * terminal column — erasing the deliberate `-top-56 right-[-18%]` bleed.
 */
export interface ArcHaloProps {
  /** Rendered edge length in px at >=768px. Below that it scales down. */
  size?: number;
  /** Base opacity in dark mode. Light mode is scaled down automatically. */
  opacity?: number;
  className?: string;
}

export function ArcHalo({ size = 760, opacity = 0.5, className }: ArcHaloProps) {
  const id = useId();
  const strokeId = `arc-halo-stroke-${id}`;
  const glowId = `arc-halo-glow-${id}`;

  return (
    <div
      aria-hidden="true"
      className={cn("arc-halo", className)}
      style={
        {
          "--halo-size": `${size}px`,
          "--halo-opacity": String(opacity),
        } as CSSProperties
      }
    >
      <svg
        aria-hidden="true"
        viewBox="-50 -50 100 100"
        fill="none"
        focusable="false"
        className="arc-halo-svg h-full w-full"
      >
        <defs>
          <linearGradient
            id={strokeId}
            x1="-30"
            y1="30"
            x2="30"
            y2="-30"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="var(--color-ember)" stopOpacity="0.15" />
            <stop offset="0.55" stopColor="var(--color-gold)" stopOpacity="0.75" />
            <stop offset="1" stopColor="var(--color-star)" />
          </linearGradient>
          <radialGradient id={glowId}>
            <stop stopColor="var(--glow)" />
            <stop offset="1" stopColor="var(--glow)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="0" cy="0" r="46" fill={`url(#${glowId})`} />
        <g className="arc-halo-spin origin-center">
          <path d={ARC_PATH} stroke={`url(#${strokeId})`} strokeWidth="0.9" strokeLinecap="round" />
          <path
            d={STAR_PATH}
            transform="translate(22.63 -22.63) scale(0.16)"
            fill="var(--color-star)"
          />
        </g>
      </svg>
    </div>
  );
}
