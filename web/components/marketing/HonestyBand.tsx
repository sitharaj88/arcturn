import { Info } from "lucide-react";
import Link from "next/link";
import { Container } from "@/components/ui/Container";

/**
 * DESIGN.md §3.1 — required, and required to stay above the fold of its own
 * band: pre-1.0, one maintainer, no users. The limits are content, not fine
 * print, so this must never be softened or collapsed behind a disclosure.
 */
export function HonestyBand() {
  return (
    <aside aria-label="Project status" className="border-y border-default bg-surface-raised py-5">
      <Container>
        <p className="flex items-start gap-3 text-caption text-muted">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
          <span className="min-w-0">
            Arcturn is pre-1.0, built by one person, with no users yet. What’s proven, what isn’t,
            and every known limit of every safety feature are written down —{" "}
            <Link
              href="/open-source"
              className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-current"
            >
              see the status page
            </Link>{" "}
            and{" "}
            <Link
              href="/security"
              className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-current"
            >
              the security limits
            </Link>
            .
          </span>
        </p>
      </Container>
    </aside>
  );
}
