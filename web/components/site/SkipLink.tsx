/** The first focusable element on every page (DESIGN.md §2.6). */
export function SkipLink() {
  return (
    <a
      href="#content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:inline-flex focus:h-11 focus:items-center focus:rounded-md focus:bg-gold focus:px-4 focus:text-body-sm focus:font-medium focus:text-on-accent"
    >
      Skip to content
    </a>
  );
}
