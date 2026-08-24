import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { type HubEntry, type HubKind, kindLabel, orderedKinds } from "@/lib/hub";

/**
 * An entry's kinds, in taxonomy order rather than the order the JSON happened
 * to list them — so two entries carrying the same kinds always read the same.
 *
 * `extensions` is the one kind that changes colour. Every other kind is
 * content; that one is executable code, and a reader scanning a grid of cards
 * should not have to open the page to find out which is which.
 */
export function KindBadges({ entry, className }: { entry: HubEntry; className?: string }) {
  return (
    <span className={cn("flex flex-wrap gap-1.5", className)}>
      {orderedKinds(entry).map((kind) => (
        <Badge key={kind} variant={kind === "extensions" ? "bad" : "neutral"}>
          {kindLabel(kind as HubKind)}
        </Badge>
      ))}
    </span>
  );
}
