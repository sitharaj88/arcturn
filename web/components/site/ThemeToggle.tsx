"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Three-state colour theme control: System / Light / Dark (DESIGN.md §2.7).
 *
 * "System" removes both the `data-theme` attribute and the storage key so
 * `prefers-color-scheme` decides again. The control renders a neutral
 * placeholder until mounted, so the server and client markup agree.
 *
 * The panel is a disclosure over three toggle buttons, not a menu. It used to
 * claim `role="menu"` + `menuitemradio` + `aria-haspopup="menu"`, which is a
 * promise of the APG menu keyboard contract — arrow-key roving focus, Home /
 * End, type-ahead — that this never implemented; NVDA and JAWS switch to
 * application mode on that role and swallow the arrows, so the options became
 * unreachable. `role="group"` of `aria-pressed` buttons promises only Tab and
 * Enter, which is exactly what is here.
 */
export const THEME_STORAGE_KEY = "arcturn-theme";

type ThemeChoice = "system" | "light" | "dark";

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function readStoredChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  try {
    if (choice === "system") {
      delete root.dataset.theme;
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      root.dataset.theme = choice;
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    }
  } catch {
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLFieldSetElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
    setChoice(readStoredChoice());
  }, []);

  useEffect(() => {
    if (!open) return;

    // Opening moves focus into the panel, the same way MobileNav seeds its
    // drawer — without it the options sit after the trigger in the tab order
    // but a screen reader is given no reason to go there.
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    // Tabbing past the last option leaves the panel; it should not linger.
    function onFocusIn(event: FocusEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  const Active = mounted ? OPTIONS.find((o) => o.value === choice)!.icon : Monitor;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Colour theme"
        aria-expanded={open}
        aria-controls="theme-panel"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-md border border-transparent",
          "text-muted transition-colors dur-base ease-out hover:border-default hover:bg-surface-hover hover:text-text",
        )}
      >
        <Active className="size-[18px] transition-transform dur-base ease-out" aria-hidden="true" />
      </button>

      {/*
        Kept mounted and hidden with `visibility`, not unmounted and not
        `hidden`: `display: none` gives the entrance transition no start value
        to leave, so the panel used to appear with no motion at all. Hidden
        visibility takes the options out of the tab order and the a11y tree
        just as thoroughly. Reduced motion collapses the durations through the
        kill switch in `globals.css`, which lands on the same two end states.
      */}
      <fieldset
        id="theme-panel"
        ref={panelRef}
        aria-label="Colour theme"
        className={cn(
          // `min-w-0` overrides the UA's `min-inline-size: min-content` on a
          // fieldset, which would otherwise fight `w-40`.
          "absolute right-0 top-full z-50 mt-2 w-40 min-w-0 rounded-lg border border-default",
          "bg-surface-raised p-1 elev-lg",
          // `translate`, not `transform`: Tailwind v4 compiles `-translate-y-*`
          // to the individual property, so naming `transform` transitions
          // nothing.
          "transition-[opacity,translate] dur-base ease-out",
          open ? "visible translate-y-0 opacity-100" : "invisible -translate-y-1 opacity-0",
        )}
      >
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = mounted && option.value === choice;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setChoice(option.value);
                applyChoice(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-body-sm",
                "transition-colors dur-fast ease-out hover:bg-surface-hover",
                selected ? "text-accent" : "text-muted",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {option.label}
              {/* Never colour alone (DESIGN.md §2.6): the tick is what survives
                  forced-colours mode, where `text-accent` is overridden. */}
              {selected ? <Check className="ml-auto size-4" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}
