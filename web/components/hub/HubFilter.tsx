"use client";

import { type ReactNode, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * The hub index's only client code.
 *
 * The cards themselves are server-rendered and handed here as nodes, so the
 * page ships the full catalogue as static HTML — this island decides which of
 * those nodes to mount, and nothing else. A grid that rebuilt its own cards in
 * the browser would put the one thing a crawler and a JS-less reader need
 * behind hydration, for a filter that is a convenience.
 *
 * Filtering is single-select including an explicit "All". Multi-select reads
 * as a promise of set algebra that two entries cannot pay off, and a filter
 * whose combinations mostly return nothing is worse than no filter.
 */
export interface HubFilterItem {
  /** Entry name — the React key and the filter's identity. */
  name: string;
  /** The kinds this entry carries, already in taxonomy order. */
  kinds: string[];
  /** The server-rendered card. */
  card: ReactNode;
}

export interface HubFilterKind {
  value: string;
  label: string;
}

export interface HubFilterProps {
  items: HubFilterItem[];
  kinds: HubFilterKind[];
}

const CHIP =
  "inline-flex min-h-11 items-center rounded-full border px-3.5 text-caption font-medium " +
  "transition-[background-color,border-color,color] dur-fast ease-out sm:min-h-9";

const CHIP_OFF = "border-default bg-surface-card text-muted hover:border-strong hover:text-text";

// The same recipe Badge's `accent` variant uses, so a selected chip and an
// accent pill are one visual idea rather than two near-misses.
const CHIP_ON =
  "border-accent-edge bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-accent";

export function HubFilter({ items, kinds }: HubFilterProps) {
  const [active, setActive] = useState<string | null>(null);
  const visible = active === null ? items : items.filter((item) => item.kinds.includes(active));

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">Filter by kind</legend>
        <button
          type="button"
          onClick={() => setActive(null)}
          aria-pressed={active === null}
          className={cn(CHIP, active === null ? CHIP_ON : CHIP_OFF)}
        >
          All
        </button>
        {kinds.map((kind) => (
          <button
            key={kind.value}
            type="button"
            onClick={() => setActive(kind.value)}
            aria-pressed={active === kind.value}
            className={cn(CHIP, active === kind.value ? CHIP_ON : CHIP_OFF)}
          >
            {kind.label}
          </button>
        ))}
      </fieldset>

      {/* Announced, not just shown: the grid changing under a filter press is
          invisible to a screen reader without it. */}
      <p aria-live="polite" className="text-caption text-faint">
        {visible.length === items.length
          ? `${items.length} ${items.length === 1 ? "package" : "packages"}`
          : `${visible.length} of ${items.length} packages`}
      </p>

      {visible.length > 0 ? (
        <ul className="grid list-none gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            // `min-w-0` on every grid item: a long unbroken name in a card
            // otherwise sets the track's floor and pushes the page past 360px.
            <li key={item.name} className="min-w-0">
              {item.card}
            </li>
          ))}
        </ul>
      ) : (
        <p className="max-w-(--measure-body) text-body-sm text-muted">
          Nothing listed under that kind yet. Listing is a pull request — the link below says how.
        </p>
      )}
    </div>
  );
}
