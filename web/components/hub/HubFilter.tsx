"use client";

import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
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
 * Kind filtering is single-select including an explicit "All". Multi-select
 * reads as a promise of set algebra that a dozen entries cannot pay off, and a
 * filter whose combinations mostly return nothing is worse than no filter.
 *
 * Search runs over a haystack built on the server — name, description and
 * every command the entry adds — because the reader's query is usually the
 * thing they want to *do* ("retry", "accessibility") rather than the package
 * name, and a search that only matched names would miss on exactly those.
 */
export interface HubFilterItem {
  /** Entry name — the React key and the filter's identity. */
  name: string;
  /** The kinds this entry carries, already in taxonomy order. */
  kinds: string[];
  /** Lowercased name + description + commands, for substring search. */
  haystack: string;
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
  /** Cards per page. Pagination only appears when a result set exceeds it. */
  pageSize?: number;
}

const CHIP =
  "inline-flex min-h-11 items-center rounded-full border px-3.5 text-caption font-medium " +
  "transition-[background-color,border-color,color] dur-fast ease-out sm:min-h-9";

const CHIP_OFF = "border-default bg-surface-card text-muted hover:border-strong hover:text-text";

// The same recipe Badge's `accent` variant uses, so a selected chip and an
// accent pill are one visual idea rather than two near-misses.
const CHIP_ON =
  "border-accent-edge bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-accent";

const PAGER =
  "inline-flex size-9 items-center justify-center rounded-md border border-default " +
  "text-muted transition-colors dur-fast ease-out enabled:hover:border-strong " +
  "enabled:hover:text-text disabled:opacity-40";

export function HubFilter({ items, kinds, pageSize = 9 }: HubFilterProps) {
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter(
      (item) =>
        (active === null || item.kinds.includes(active)) &&
        (needle === "" || item.haystack.includes(needle)),
    );
  }, [items, active, query]);

  // Clamped rather than reset: narrowing a filter while on page 3 should land
  // on the last page that exists, not silently on page 1 with no explanation.
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
  const current = Math.min(page, pageCount - 1);
  const paged = visible.slice(current * pageSize, current * pageSize + pageSize);
  const paginated = visible.length > pageSize;

  const narrow = (next: () => void) => {
    next();
    setPage(0);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Filter by kind</legend>
          <button
            type="button"
            onClick={() => narrow(() => setActive(null))}
            aria-pressed={active === null}
            className={cn(CHIP, active === null ? CHIP_ON : CHIP_OFF)}
          >
            All
          </button>
          {kinds.map((kind) => (
            <button
              key={kind.value}
              type="button"
              onClick={() => narrow(() => setActive(kind.value))}
              aria-pressed={active === kind.value}
              className={cn(CHIP, active === kind.value ? CHIP_ON : CHIP_OFF)}
            >
              {kind.label}
            </button>
          ))}
        </fieldset>

        <div className="relative md:w-72">
          <Search
            aria-hidden="true"
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-faint"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => narrow(() => setQuery(event.target.value))}
            placeholder="Search packages and commands"
            aria-label="Search packages and commands"
            className="min-h-11 w-full rounded-full border border-default bg-surface-card pr-9 pl-9 text-body-sm text-text transition-colors dur-fast ease-out placeholder:text-faint focus:border-accent-edge focus:outline-none sm:min-h-9"
          />
          {query === "" ? null : (
            <button
              type="button"
              onClick={() => narrow(() => setQuery(""))}
              aria-label="Clear search"
              className="-translate-y-1/2 absolute top-1/2 right-3 text-faint transition-colors dur-fast ease-out hover:text-text"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Announced, not just shown: the grid changing under a filter press is
          invisible to a screen reader without it. */}
      <p aria-live="polite" className="text-caption text-faint">
        {visible.length === items.length
          ? `${items.length} ${items.length === 1 ? "package" : "packages"}`
          : `${visible.length} of ${items.length} packages`}
        {paginated ? ` · page ${current + 1} of ${pageCount}` : ""}
      </p>

      {paged.length > 0 ? (
        <ul className="grid list-none gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {paged.map((item) => (
            // `min-w-0` on every grid item: a long unbroken name in a card
            // otherwise sets the track's floor and pushes the page past 360px.
            <li key={item.name} className="min-w-0">
              {item.card}
            </li>
          ))}
        </ul>
      ) : (
        <p className="max-w-(--measure-body) text-body-sm text-muted">
          {query.trim() === ""
            ? "Nothing listed under that kind yet. Listing is a pull request — the link below says how."
            : `Nothing matches “${query.trim()}”. Try a command name like retry, or a subject like accessibility.`}
        </p>
      )}

      {paginated ? (
        <nav aria-label="Pagination" className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            aria-label="Previous page"
            className={PAGER}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          {/* Numbered from the page number itself rather than from the map
              index: a page's identity *is* its number, so the key stays stable
              when the count changes and the linter's array-index rule is
              satisfied by something true rather than by a cast. */}
          {pageNumbers.map((page) => (
            <button
              key={`page-${page}`}
              type="button"
              onClick={() => setPage(page - 1)}
              aria-label={`Page ${page}`}
              aria-current={page - 1 === current ? "page" : undefined}
              className={cn(
                "inline-flex size-9 items-center justify-center rounded-md border text-caption font-medium transition-colors dur-fast ease-out",
                page - 1 === current ? CHIP_ON : CHIP_OFF,
              )}
            >
              {page}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPage(current + 1)}
            disabled={current === pageCount - 1}
            aria-label="Next page"
            className={PAGER}
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </nav>
      ) : null}
    </div>
  );
}
