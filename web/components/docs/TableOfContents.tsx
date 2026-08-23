"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import type { DocHeading } from "@/lib/docs";

/**
 * The right-hand "on this page" rail.
 *
 * The list itself is plain server-rendered markup — without JavaScript it is
 * still a working set of anchors. The only thing the client adds is the
 * highlight: one `IntersectionObserver` whose bottom margin pulls the
 * detection line up to 30% of the viewport, so the active entry is the
 * heading you are actually reading rather than the one about to leave.
 */
export interface TableOfContentsProps {
  headings: DocHeading[];
  className?: string;
}

export function TableOfContents({ headings, className }: TableOfContentsProps) {
  const [active, setActive] = useState<string | undefined>(undefined);
  // The observer's only real input is the set of heading ids. Joining them
  // into one string gives that set a stable identity, so a re-render with an
  // equal-but-new `headings` array does not tear the observer down.
  const idKey = headings.map((heading) => heading.id).join("|");

  useEffect(() => {
    const ids = idKey ? idKey.split("|") : [];
    if (ids.length === 0) return;
    if (typeof IntersectionObserver === "undefined") return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );

    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [idKey]);

  if (headings.length === 0) return null;

  return (
    <nav
      aria-label="On this page"
      className={cn(
        "sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain py-10",
        className,
      )}
    >
      <p className="text-eyebrow uppercase text-faint">On this page</p>
      <ul className="mt-3 list-none border-l border-default">
        {headings.map((heading) => {
          const isActive = heading.id === active;
          return (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                aria-current={isActive ? "location" : undefined}
                className={cn(
                  "-ml-px block border-l py-1.5 pr-2 text-body-sm transition-colors dur-fast ease-out",
                  heading.depth === 3 ? "pl-6" : "pl-3",
                  isActive
                    ? "border-l-accent text-text"
                    : "border-l-transparent text-muted hover:text-text",
                )}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
