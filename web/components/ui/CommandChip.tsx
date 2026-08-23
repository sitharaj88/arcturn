"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { CopyButton } from "./CopyButton";

/**
 * A single copyable command on a gold-tinted plate. Used for the clone
 * command on the home page — Arcturn is not on npm yet, so the install is a
 * clone and the caption says so.
 */
export interface CommandChipProps {
  command: string;
  caption?: ReactNode;
  className?: string;
}

export function CommandChip({ command, caption, className }: CommandChipProps) {
  return (
    <div className={cn("w-full max-w-full", className)}>
      <div
        className={cn(
          "flex items-center gap-3 rounded-md border border-accent-edge px-3 py-2",
          "bg-[color-mix(in_oklab,var(--accent)_8%,var(--surface-card))]",
        )}
      >
        <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-caption text-text">
          <span aria-hidden="true" className="mr-2 select-none text-accent-quiet">
            $
          </span>
          {command}
        </span>
        <CopyButton value={command} label={`Copy command: ${command}`} />
      </div>
      {caption ? <p className="mt-2 text-caption text-faint">{caption}</p> : null}
    </div>
  );
}
