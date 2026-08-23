/**
 * Shared helpers. `cn` lives in `./cn` (DESIGN.md §4) and is re-exported here
 * so both `@/lib/cn` and `@/lib/utils` resolve to the same implementation.
 */
export { type ClassValue, cn } from "./cn";

/** Absolute canonical origin for the static export. */
export const SITE_URL = "https://arcturn.dev";

/** The GitHub repository every "on GitHub" link points at. */
export const REPO_URL = "https://github.com/sitharaj88/arcturn";

/** Author & support links (DESIGN.md §5.3) — mandatory, exact, never reordered. */
export const AUTHOR_LINKS = [
  { label: "Website", href: "https://sitharaj.in" },
  { label: "LinkedIn", href: "https://www.linkedin.com/in/sitharaj08" },
  { label: "Buy me a coffee", href: "https://buymeacoffee.com/sitharaj88" },
  { label: "GitHub", href: "https://github.com/sitharaj88" },
] as const;

/** True when a href leaves the site (and therefore needs rel/target hardening). */
export function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//.test(href) || href.startsWith("mailto:");
}

/**
 * Format an ISO date deterministically.
 *
 * Both locale and time zone are pinned: an unpinned format renders differently
 * on the build machine and in the browser and produces a hydration mismatch.
 */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(iso));
}
