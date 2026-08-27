import { Boxes, FileTerminal, GitBranch, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { type HubKind, KIND_NOTE, kindLabel } from "@/lib/hub";

/**
 * What the badges on a card actually mean.
 *
 * The hub's badges are the project's own vocabulary — skills, agents,
 * workflows, org-kit — which is precisely the vocabulary somebody arriving for
 * the first time does not have. Without this, a card reads as four unexplained
 * words above a paragraph that assumes all four.
 *
 * Four kinds, not seven: `mcp`, `themes` and `extensions` appear on individual
 * entries and are explained where they appear. These are the ones every card
 * carries, and a primer nobody finishes reading explains nothing.
 */
const PRIMED: { kind: HubKind; icon: ReactNode; typed: string }[] = [
  {
    kind: "skills",
    icon: <FileTerminal aria-hidden="true" className="size-4" />,
    typed: "/review",
  },
  {
    kind: "workflows",
    icon: <GitBranch aria-hidden="true" className="size-4" />,
    typed: "/workflow name",
  },
  { kind: "agents", icon: <Users aria-hidden="true" className="size-4" />, typed: "@role" },
  { kind: "org-kit", icon: <Boxes aria-hidden="true" className="size-4" />, typed: "" },
];

export function KindPrimer() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {PRIMED.map(({ kind, icon, typed }) => (
        <Card key={kind} variant="quiet" className="h-full">
          <span className="flex items-center gap-2 text-accent">{icon}</span>
          <h3 className="mt-2 font-mono text-body-sm text-text">{kindLabel(kind)}</h3>
          <p className="mt-1.5 text-body-sm text-muted">{KIND_NOTE[kind]}</p>
          {typed === "" ? null : (
            <p className="mt-2 text-caption text-faint">
              You type <code className="font-mono text-text">{typed}</code>
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
