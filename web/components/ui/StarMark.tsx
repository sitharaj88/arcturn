import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * The Turn Arc at scale 1 (DESIGN.md §2.4): a 270° orbital arc with a
 * four-point star at its open end — a turn, and the star you steer by.
 *
 * Purely decorative: the adjacent text always carries the name.
 */
export interface StarMarkProps {
  size?: number;
  className?: string;
}

/** Fixed geometry, reused at every scale of the device. */
export const ARC_PATH = "M 31.51 -5.56 A 32 32 0 1 1 5.56 -31.51";
export const STAR_PATH =
  "M0 -40C3 -11 11 -3 40 0C11 3 3 11 0 40C-3 11 -11 3 -40 0C-11 -3 -3 -11 0 -40Z";

export function StarMark({ size = 28, className }: StarMarkProps) {
  const id = useId();
  const gradientId = `star-mark-${id}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="-50 -50 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="-30"
          y1="30"
          x2="30"
          y2="-30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--color-ember)" />
          <stop offset="1" stopColor="var(--color-gold)" />
        </linearGradient>
      </defs>
      <path d={ARC_PATH} stroke={`url(#${gradientId})`} strokeWidth="7" strokeLinecap="round" />
      <path
        d={STAR_PATH}
        transform="translate(22.63 -22.63) scale(0.42)"
        fill="var(--color-star)"
      />
    </svg>
  );
}
