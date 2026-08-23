"use client";

import { PanelLeft, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { DocNavGroup, DocSection } from "@/lib/docs";
import { DocsNavList } from "./DocsNavList";

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The sub-1024px replacement for the sidebar: a sticky bar under the header
 * showing where you are, which opens the same nav as a drawer. Focus is
 * trapped while it is open, the page behind it is `inert`, Escape closes it
 * and focus returns to the trigger (DESIGN.md §2.6, §3.11).
 */
export interface DocsNavDrawerProps {
  nav: DocNavGroup[];
  activeSlug: string;
  section: DocSection;
  title: string;
  className?: string;
}

export function DocsNavDrawer({ nav, activeSlug, section, title, className }: DocsNavDrawerProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

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

  return (
    <div className={cn("lg:hidden", className)}>
      <div className="sticky top-16 z-[60] -mx-5 border-b border-default bg-surface-raised px-5 sm:-mx-6 sm:px-6">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls="docs-nav-drawer"
          onClick={() => setOpen(true)}
          className="flex min-h-12 w-full items-center gap-3 py-2 text-left text-body-sm text-muted transition-colors dur-fast ease-out hover:text-text"
        >
          <PanelLeft className="size-4 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-faint">{section}</span>
            <span className="mx-1.5 text-faint" aria-hidden="true">
              /
            </span>
            <span className="text-text">{title}</span>
          </span>
          <span className="shrink-0 text-caption text-faint">Browse</span>
        </button>
      </div>

      {open ? (
        <div className="fixed inset-0 z-[78]">
          <button
            type="button"
            // Keyboard users dismiss with Escape or the explicit Close button
            // inside the trapped panel, so the scrim stays out of the tab ring.
            tabIndex={-1}
            aria-label="Close documentation menu"
            onClick={close}
            className="absolute inset-0 block w-full cursor-default bg-[color-mix(in_oklab,var(--surface)_78%,transparent)] backdrop-blur-sm"
          />
          <div
            id="docs-nav-drawer"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Documentation"
            className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] flex-col border-r border-default bg-surface-raised elev-lg"
          >
            <div className="flex items-center justify-between border-b border-default px-4 py-3">
              <p className="text-eyebrow uppercase text-faint">Documentation</p>
              <button
                type="button"
                aria-label="Close documentation menu"
                onClick={close}
                className="inline-flex size-11 items-center justify-center rounded-md border border-default text-muted transition-colors dur-fast ease-out hover:text-text"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain px-2 py-5">
              <DocsNavList nav={nav} activeSlug={activeSlug} onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
