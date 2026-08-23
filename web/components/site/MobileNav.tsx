"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { FEATURE_GROUPS, isActiveRoute, PRIMARY_NAV, REPO } from "./nav-data";

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The sub-1024px drawer. Traps focus while open, locks body scroll, marks the
 * backgrounded page `inert`, closes on Escape and restores focus to the
 * hamburger (DESIGN.md §2.6).
 */
export function MobileNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastPathname = useRef(pathname);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // A completed navigation dismisses the drawer. Comparing against the last
  // path keeps `pathname` a read dependency rather than a bare trigger, and
  // stops the effect from firing on mount.
  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    // Background the page content, but never the drawer itself.
    const backgrounded = Array.from(
      document.querySelectorAll<HTMLElement>("#content, footer[data-site-footer]"),
    );
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    for (const node of backgrounded) node.setAttribute("inert", "");

    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const node of backgrounded) node.removeAttribute("inert");
    };
  }, [open, close]);

  const itemClass =
    "flex min-h-11 items-center rounded-md px-3 text-body-sm transition-colors dur-fast ease-out hover:bg-surface-hover";

  return (
    <div className={cn("lg:hidden", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => setOpen(true)}
        className="inline-flex size-11 items-center justify-center rounded-md border border-transparent text-muted transition-colors dur-fast ease-out hover:border-default hover:bg-surface-hover hover:text-text"
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-[80]">
          <button
            type="button"
            // Keyboard users dismiss with Escape or the explicit Close button
            // inside the trapped panel, so the scrim stays out of the tab ring.
            tabIndex={-1}
            aria-label="Close menu"
            onClick={close}
            className="absolute inset-0 block w-full cursor-default bg-[color-mix(in_oklab,var(--surface)_78%,transparent)] backdrop-blur-sm"
          />
          <div
            id="mobile-nav"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
            className={cn(
              "absolute inset-x-0 top-0 max-h-dvh overflow-y-auto border-b border-default",
              "bg-surface-raised px-5 pb-8 pt-4 elev-lg",
            )}
          >
            <div className="flex items-center justify-between">
              <p className="text-eyebrow uppercase text-faint">Menu</p>
              <button
                type="button"
                aria-label="Close menu"
                onClick={close}
                className="inline-flex size-11 items-center justify-center rounded-md border border-default text-muted hover:text-text"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>

            <nav aria-label="Mobile" className="mt-4">
              {FEATURE_GROUPS.map((group) => (
                <div key={group.label} className="mb-5">
                  <p className="px-3 text-eyebrow uppercase text-faint">{group.label}</p>
                  <ul className="mt-1 list-none">
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={pathname === item.href ? "page" : undefined}
                          className={cn(
                            itemClass,
                            pathname === item.href ? "text-accent" : "text-text",
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              <div className="mb-5 border-t border-default pt-4">
                <ul className="list-none">
                  {PRIMARY_NAV.map((item) => {
                    const active = isActiveRoute(pathname, item.href);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(itemClass, active ? "text-accent" : "text-text")}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                  <li>
                    <a
                      href={REPO}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(itemClass, "text-text")}
                    >
                      GitHub
                    </a>
                  </li>
                </ul>
              </div>

              <Button href="/docs/getting-started" size="lg" className="w-full">
                Get started
              </Button>
            </nav>
          </div>
        </div>
      ) : null}
    </div>
  );
}
