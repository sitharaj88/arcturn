import clsx, { type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Tailwind v4 is CSS-first, so tailwind-merge cannot see our `@theme` tokens.
 * Without this extension it cannot tell `text-h2` (a font size) from
 * `text-muted` (a colour) and silently drops one of them when both appear in
 * the same `cn()` call. Both scales are declared explicitly instead.
 */
const FONT_SIZES = [
  "display-1",
  "display-2",
  "h2",
  "h3",
  "h4",
  "lede",
  "body",
  "body-sm",
  "caption",
  "eyebrow",
  "code-block",
] as const;

const TEXT_COLORS = [
  "surface",
  "surface-raised",
  "surface-card",
  "surface-inset",
  "surface-hover",
  "default",
  "strong",
  "accent-edge",
  "text",
  "muted",
  "faint",
  "inverse",
  "accent",
  "accent-hover",
  "accent-quiet",
  "on-accent",
  "good",
  "warn",
  "bad",
  "focus",
  "gold",
  "gold-hover",
  "star",
  "ember",
  "ember-deep",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...FONT_SIZES] }],
      "text-color": [{ text: [...TEXT_COLORS] }],
    },
  },
});

/**
 * Merge class names with Tailwind conflict resolution.
 *
 * Every component that accepts a `className` prop composes its own classes
 * through `cn` so a caller's utility always wins over the default.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
