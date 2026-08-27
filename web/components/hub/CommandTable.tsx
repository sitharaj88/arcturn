import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { commandsFor, type HubEntry } from "@/lib/hub";

/**
 * What a reader would type once this package is installed.
 *
 * The disclosure block below it answers "what lands on my machine" in the
 * installer's vocabulary — lanes, declared tools, stage counts. That is the
 * right answer to a different question, and it is the only answer this page
 * used to give. Somebody deciding whether to install wants to know what they
 * would *do* with it, and the shortest true form of that is the command.
 *
 * Derived from the same disclosure block, so it cannot advertise a command the
 * entry does not declare. Each row links to the command's own page, where the
 * prompt or the pipeline is shown in full — a one-line description is enough to
 * choose between four commands and not enough to decide to run one.
 */
export function CommandTable({ entry }: { entry: HubEntry }) {
  const commands = commandsFor(entry);
  if (commands.length === 0) return null;

  return (
    <ul className="divide-y divide-default border-y border-default">
      {commands.map((item) => (
        <li key={item.command}>
          <Link
            href={`/hub/${entry.name}/${item.slug}`}
            className="group grid gap-1 py-3 transition-colors dur-fast ease-out hover:bg-surface-sunken sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-4"
          >
            <span className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 break-words font-mono text-body-sm text-text">
                {item.command}
              </code>
              <ArrowRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-faint transition-colors dur-fast ease-out group-hover:text-accent"
              />
            </span>
            <span className="min-w-0 text-body-sm text-muted">
              {item.line === "" ? (
                <span className="text-faint">No description declared.</span>
              ) : (
                item.line
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
