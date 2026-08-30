/**
 * The builder's shared field chrome — one recipe per control shape, so the
 * frontmatter panel, the stage cards and the import pane cannot drift. The
 * input recipe is `HubFilter`'s (accent border on focus instead of the global
 * outline), the icon-button recipe is its pager's.
 */

export const FIELD_LABEL = "text-caption font-medium text-muted";

export const FIELD_INPUT =
  "min-h-11 w-full rounded-md border border-default bg-surface-inset px-3 text-body-sm " +
  "text-text transition-colors dur-fast ease-out placeholder:text-faint " +
  "focus:border-accent-edge focus:outline-none sm:min-h-9";

export const FIELD_TEXTAREA =
  "w-full resize-y rounded-md border border-default bg-surface-inset px-3 py-2 font-mono " +
  "text-code-block text-text transition-colors dur-fast ease-out placeholder:text-faint " +
  "focus:border-accent-edge focus:outline-none";

export const ICON_BUTTON =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-default " +
  "bg-surface-card text-muted transition-colors dur-fast ease-out enabled:hover:border-strong " +
  "enabled:hover:text-text disabled:opacity-40";

/** Inline validation notes under a field. */
export const NOTE_ERROR = "text-caption text-bad";
export const NOTE_WARN = "text-caption text-warn";
