import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { commandsFor, disclosureSummary, type HubEntry } from "@/lib/hub";
import { KindBadges } from "./KindBadges";

/**
 * One listed package, as it appears in the hub grid.
 *
 * Every child is a `<span>`: the whole card is a single `<Link>`, and the
 * grid is the one place on this site where a nested interactive element would
 * be easy to add and impossible to reach with a keyboard.
 *
 * The counts line is derived from the disclosure block, never hand-written, so
 * a card cannot advertise "11 roles" for an entry that discloses ten.
 *
 * The commands are on the card for the same reason the counts are not enough:
 * "4 skills" says how many, and the reader's question is what they would type.
 */
/**
 * How many commands a card shows before it counts the rest.
 *
 * Four keeps every card the same height in a grid and still shows the shape of
 * the package. The remainder is counted rather than dropped, because a card
 * that silently truncates reads as a package with four commands.
 */
const MAX_SHOWN = 4;

export function EntryCard({ entry }: { entry: HubEntry }) {
  const commands = commandsFor(entry);
  return (
    <Card href={`/hub/${entry.name}`} className="group h-full">
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words font-mono text-h4 text-text">{entry.name}</span>
        <ArrowRight
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-faint transition-colors dur-fast ease-out group-hover:text-accent"
        />
      </span>

      <KindBadges entry={entry} className="mt-3" />

      <span className="mt-3 block text-body-sm text-muted">{entry.description}</span>

      {commands.length === 0 ? null : (
        <span className="mt-3 flex flex-wrap gap-1.5">
          {commands.slice(0, MAX_SHOWN).map((entryCommand) => (
            <span
              key={entryCommand.command}
              className="rounded border border-default bg-surface-sunken px-1.5 py-0.5 font-mono text-caption text-muted"
            >
              {entryCommand.command}
            </span>
          ))}
          {commands.length > MAX_SHOWN ? (
            <span className="px-1 py-0.5 text-caption text-faint">
              +{commands.length - MAX_SHOWN} more
            </span>
          ) : null}
        </span>
      )}

      <span className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-faint">
        <span>{disclosureSummary(entry)}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 break-words">{entry.maintainer.name}</span>
      </span>
    </Card>
  );
}
