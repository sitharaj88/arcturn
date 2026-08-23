import Link from "next/link";
import { cn } from "@/lib/cn";
import { AUTHOR_LINKS } from "@/lib/utils";
import { Logo } from "./Logo";
import { FOOTER_COLUMNS } from "./nav-data";

/**
 * The site footer (DESIGN.md §5.2, §5.3).
 *
 * The Author & support row is mandatory on every page: those four links must
 * not be removed, reordered away, or hidden behind a disclosure.
 */
export function SiteFooter({ className }: { className?: string }) {
  const year = new Date().getFullYear();

  return (
    <footer
      data-site-footer
      className={cn("mt-24 border-t border-default bg-surface-raised", className)}
    >
      <div className="container-wide grid grid-cols-2 gap-x-6 gap-y-10 py-14 md:grid-cols-[1.6fr_1fr_1fr_1fr] md:gap-8">
        <div className="col-span-2 md:col-span-1">
          <Logo />
          <p className="mt-4 max-w-xs text-body-sm text-muted">
            An open-source coding agent you can actually audit — every turn checkpointed, priced and
            replayable.
          </p>
          <p className="mt-3 max-w-xs text-body-sm text-faint">
            Named for Arcturus, the star you steer by. Navigation, not autocomplete.
          </p>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.label} aria-label={column.label}>
            <h2 className="text-eyebrow uppercase text-faint">{column.label}</h2>
            <ul className="mt-3 list-none space-y-0 md:space-y-2">
              {column.items.map((item) => (
                <li key={`${column.label}-${item.href}`}>
                  {item.external ? (
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center text-body-sm text-muted transition-colors dur-fast ease-out hover:text-text md:min-h-0"
                    >
                      {item.label}
                    </a>
                  ) : (
                    <Link
                      href={item.href}
                      className="inline-flex min-h-11 items-center text-body-sm text-muted transition-colors dur-fast ease-out hover:text-text md:min-h-0"
                    >
                      {item.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="border-t border-default">
        <div className="container-wide py-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-8">
            <h2 className="text-eyebrow uppercase text-faint">Author &amp; support</h2>
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-0 text-body-sm">
              {AUTHOR_LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center text-muted transition-colors dur-fast ease-out hover:text-text sm:min-h-0"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 flex flex-col gap-2 text-caption text-faint sm:flex-row sm:items-center sm:justify-between">
            <p>&copy; {year} Arcturn. Licensed under Apache-2.0.</p>
            <p>
              Built by{" "}
              <a
                href="https://sitharaj.in"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-muted hover:text-text"
              >
                Sitharaj Seenivasan
              </a>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
