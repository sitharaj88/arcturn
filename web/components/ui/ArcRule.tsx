import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * The Turn Arc at scale 4 (DESIGN.md §2.4): the section divider. Reads as a
 * hairline; on a second look it is bowed, because it belongs to a circle
 * bigger than the page.
 */
export interface ArcRuleProps {
  className?: string;
}

export function ArcRule({ className }: ArcRuleProps) {
  const id = useId();
  const gradientId = `arc-rule-${id}`;

  return (
    // `.container`, not `.container-wide`: a divider that is 10rem wider than
    // the sections it divides reads as a stray line rather than a break in the
    // column, and its faded ends land 80px outside the text they belong to.
    <div className={cn("container", className)} aria-hidden="true">
      <svg
        aria-hidden="true"
        viewBox="0 0 1200 16"
        preserveAspectRatio="none"
        fill="none"
        focusable="false"
        className="h-4 w-full"
      >
        <defs>
          <linearGradient
            id={gradientId}
            x1="0"
            y1="0"
            x2="1200"
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="var(--border-strong)" stopOpacity="0" />
            <stop offset="0.18" stopColor="var(--border-strong)" />
            <stop offset="0.5" stopColor="var(--accent-quiet)" />
            <stop offset="0.82" stopColor="var(--border-strong)" />
            <stop offset="1" stopColor="var(--border-strong)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M0 8 Q 600 -6 1200 8"
          stroke={`url(#${gradientId})`}
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
