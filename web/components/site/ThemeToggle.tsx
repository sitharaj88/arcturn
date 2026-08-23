"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Three-state colour theme control: System / Light / Dark (DESIGN.md §2.7).
 *
 * "System" removes both the `data-theme` attribute and the storage key so
 * `prefers-color-scheme` decides again. The control renders a neutral
 * placeholder until mounted, so the server and client markup agree.
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
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
    setChoice(readStoredChoice());
  }, []);

  useEffect(() => {
    if (!open) return;

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

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const Active = mounted ? OPTIONS.find((o) => o.value === choice)!.icon : Monitor;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Colour theme"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="theme-menu"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-md border border-transparent",
          "text-muted transition-colors dur-base ease-out hover:border-default hover:bg-surface-hover hover:text-text",
        )}
      >
        <Active className="size-[18px] transition-transform dur-base ease-out" aria-hidden="true" />
      </button>

      {open ? (
        <div
          id="theme-menu"
          role="menu"
          aria-label="Colour theme"
          className={cn(
            "absolute right-0 top-full z-50 mt-2 w-40 rounded-lg border border-default",
            "bg-surface-raised p-1 elev-lg",
          )}
        >
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = mounted && option.value === choice;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
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
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
