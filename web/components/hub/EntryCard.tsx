import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { commandsFor, disclosureSummary, type HubEntry, orderedKinds } from "@/lib/hub";

/**
 * One listed package, as it appears in the hub grid.
 *
 * Every child is a `<span>`: the whole card is a single `<Link>`, and the
 * grid is the one place on this site where a nested interactive element would
 * be easy to add and impossible to reach with a keyboard.
 *
 * The counts line is derived from the disclosure block, never hand-written, so
 * a card cannot advertise "11 roles" for an entry that discloses ten. The
 * commands are on the card for the same reason the counts are not enough:
 * "4 skills" answers how many, and the reader's question is what they type.
 *
 * Everything that can overflow is capped to one row and counted. A card is a
 * fixed slot in a grid, and one entry with eleven roles should not set the
 * height of the eleven cards beside it — the page is scanned, and a scan wants
 * rows that line up. The full lists are one click away on the entry's page.
 */
const MAX_KINDS = 3;
const MAX_COMMANDS = 3;

export function EntryCard({ entry }: { entry: HubEntry }) {
  const kinds = orderedKinds(entry);
  const commands = commandsFor(entry);

  return (
    <Card href={`/hub/${entry.name}`} className="group flex h-full flex-col gap-2.5">
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words font-mono text-body text-text">{entry.name}</span>
        <ArrowRight
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-faint transition-colors dur-fast ease-out group-hover:text-accent"
        />
      </span>

      <span className="flex flex-wrap items-center gap-1.5">
        {kinds.slice(0, MAX_KINDS).map((kind) => (
          <span
            key={kind}
            className={
              kind === "extensions"
                ? "rounded-full border border-[color-mix(in_oklab,var(--bad)_38%,transparent)] bg-[color-mix(in_oklab,var(--bad)_12%,transparent)] px-2 py-0.5 text-caption text-bad"
                : "rounded-full border border-default px-2 py-0.5 text-caption text-muted"
            }
          >
            {kind}
          </span>
        ))}
        {kinds.length > MAX_KINDS ? (
          <span className="text-caption text-faint">+{kinds.length - MAX_KINDS}</span>
        ) : null}
      </span>

      {/* No `block` here: line-clamp needs display:-webkit-box, and a display
          utility beside it silently wins depending on stylesheet order — which
          is how this shipped once already, clamping nothing. */}
      <span className="line-clamp-2 text-body-sm text-muted">{entry.description}</span>

      {commands.length === 0 ? null : (
        <span className="flex flex-wrap items-center gap-1.5">
          {commands.slice(0, MAX_COMMANDS).map((item) => (
            <span
              key={item.command}
              className="truncate rounded border border-default bg-surface-sunken px-1.5 py-0.5 font-mono text-caption text-muted"
            >
              {item.command}
            </span>
          ))}
          {commands.length > MAX_COMMANDS ? (
            <span className="text-caption text-faint">+{commands.length - MAX_COMMANDS}</span>
          ) : null}
        </span>
      )}

      <span className="mt-auto flex items-center gap-2 pt-1 text-caption text-faint">
        <span className="truncate">{disclosureSummary(entry)}</span>
      </span>
    </Card>
  );
}
