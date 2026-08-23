import { cn } from "@/lib/cn";
import { STAR_PATH } from "./StarMark";

/**
 * The Turn Arc at scale 2 (DESIGN.md §2.4): the 90° top-right quadrant of the
 * arc plus the star. This is the site's bullet character and is used only
 * before a section eyebrow, so it stays meaningful.
 */
export interface ArcEyebrowProps {
  className?: string;
}

export function ArcEyebrow({ className }: ArcEyebrowProps) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="-50 -50 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0 text-accent-quiet", className)}
    >
      <path
        d="M 0 -32 A 32 32 0 0 1 31.51 -5.56"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path d={STAR_PATH} transform="translate(22.63 -22.63) scale(0.5)" fill="currentColor" />
    </svg>
  );
}
