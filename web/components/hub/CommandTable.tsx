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
 * entry does not declare.
 */
export function CommandTable({ entry }: { entry: HubEntry }) {
  const commands = commandsFor(entry);
  if (commands.length === 0) return null;

  return (
    <ul className="divide-y divide-default border-y border-default">
      {commands.map((item) => (
        <li
          key={item.command}
          className="grid gap-1 py-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-4"
        >
          <code className="min-w-0 break-words font-mono text-body-sm text-text">
            {item.command}
          </code>
          <span className="min-w-0 text-body-sm text-muted">
            {item.line === "" ? (
              <span className="text-faint">No description declared.</span>
            ) : (
              item.line
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
