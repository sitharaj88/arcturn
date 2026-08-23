"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { FEATURE_GROUPS, isActiveRoute, PRIMARY_NAV } from "./nav-data";

/**
 * Desktop navigation including the Features dropdown. The panel closes on
 * Escape, on outside click and on route change, and returns focus to its
 * trigger (DESIGN.md §2.6).
 *
 * It is a disclosure over two lists of links, not a menu, and says so: no
 * `aria-haspopup`, which would promise the APG menu keyboard contract that
 * link lists neither have nor need. `aria-expanded` + `aria-controls` is the
 * whole contract, and Tab is the whole interaction.
 */
export function NavMenu({ className }: { className?: string }) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastPathname = useRef(pathname);

  // A completed navigation dismisses the panel. Comparing against the last
  // path keeps `pathname` a read dependency rather than a bare trigger, and
  // stops the effect from firing on mount.
  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onFocusIn(event: FocusEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onMouseLeave() {
      setOpen(false);
    }

    const wrap = wrapRef.current;
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    wrap?.addEventListener("mouseleave", onMouseLeave);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      wrap?.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [open]);

  const featuresActive = isActiveRoute(pathname, "/features");
  const linkBase =
    "inline-flex h-9 items-center rounded-md px-3 text-body-sm transition-colors dur-fast ease-out hover:text-text";

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <div ref={wrapRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls="features-panel"
          onClick={() => setOpen((value) => !value)}
          onMouseEnter={() => setOpen(true)}
          className={cn(linkBase, "gap-1", featuresActive ? "text-text" : "text-muted")}
        >
          Features
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 transition-transform dur-base ease-out", open && "rotate-180")}
          />
        </button>

        {/*
          Hidden with `visibility`, not with `hidden`: `display: none` gave the
          entrance transition no start value to leave, so the panel snapped in.
          Hidden visibility keeps the links out of the tab order and the a11y
          tree just as thoroughly, and reduced motion collapses the durations
          through the kill switch in `globals.css` onto the same end states.
        */}
        <div
          id="features-panel"
          className={cn(
            "absolute left-0 top-full z-50 w-[34rem] pt-2",
            open ? "visible opacity-100 translate-y-0" : "invisible opacity-0 -translate-y-1",
            // `translate`, not `transform`: Tailwind v4 compiles
            // `-translate-y-*` to the individual property, so naming
            // `transform` here transitioned nothing.
            "transition-[opacity,translate] dur-slow ease-out",
          )}
        >
          <div className="grid grid-cols-2 gap-6 rounded-lg border border-default bg-surface-raised p-5 elev-lg">
            {FEATURE_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="px-2 text-eyebrow uppercase text-faint">{group.label}</p>
                <ul className="mt-2 list-none">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={pathname === item.href ? "page" : undefined}
                        className="group block rounded-md px-2 py-2 transition-colors dur-fast ease-out hover:bg-surface-hover"
                      >
                        <span className="block text-body-sm font-medium text-text">
                          {item.label}
                        </span>
                        {item.description ? (
                          <span className="mt-0.5 block text-caption text-faint transition-colors dur-fast ease-out group-hover:text-muted">
                            {item.description}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      {PRIMARY_NAV.map((item) => {
        const active = isActiveRoute(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(linkBase, active ? "text-text" : "text-muted")}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
