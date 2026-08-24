import type { LucideIcon } from "lucide-react";
import { Eye, Pencil, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { type AgentLane, type HubEntry, LANE_NOTE } from "@/lib/hub";
import { DisclosureTable } from "./DisclosureTable";

/* ------------------------------------------------------------------ *
 * Lanes
 * ------------------------------------------------------------------ */

/**
 * A lane is a capability claim, so it is never signalled by colour alone
 * (DESIGN.md §2.6): every badge carries a colour, an icon and the word.
 *
 * The escalation is real rather than decorative — `read` cannot change
 * anything, `exec` gets a shell in a worktree that is thrown away, `write` has
 * its patch applied to the reader's own checkout. Red is for the last one.
 */
const LANE: Record<AgentLane, { variant: BadgeVariant; icon: LucideIcon }> = {
  read: { variant: "neutral", icon: Eye },
  exec: { variant: "warn", icon: Terminal },
  write: { variant: "bad", icon: Pencil },
};

export function LaneBadge({ lane }: { lane: AgentLane }) {
  const { variant, icon: Icon } = LANE[lane];
  return (
    <Badge variant={variant} icon={<Icon className="size-3.5" aria-hidden="true" />}>
      {lane}
    </Badge>
  );
}

/** A tool name as the engine spells it. */
function Tool({ name }: { name: string }) {
  return (
    <code className="rounded-xs border border-default bg-surface-inset px-1.5 py-0.5 font-mono text-caption text-muted">
      {name}
    </code>
  );
}

/* ------------------------------------------------------------------ *
 * Executable code
 * ------------------------------------------------------------------ */

/**
 * The loud half of the disclosure.
 *
 * Both branches are written, not just the alarming one: "we didn't say" and
 * "no executable code" must not render as the same silence to someone about to
 * grant code execution. The negative branch also names the check that beats
 * this page — `arcturn inspect` reads the package, this page reads a claim.
 */
export function ExecutableNotice({ executable }: { executable: boolean }) {
  if (!executable) {
    return (
      <Card variant="quiet" className="flex gap-3">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-good" />
        <div className="min-w-0">
          <p className="text-body-sm font-medium text-text">No executable code disclosed</p>
          <p className="mt-1 text-body-sm text-muted">
            This entry declares no <code className="font-mono">extensions/</code>. Verify it against
            the package itself with <code className="font-mono text-text">arcturn inspect</code> —
            and note that the installer would confirm-gate executable code either way, whatever a
            listing says.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card variant="limit" className="flex gap-3">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warn" />
      <div className="min-w-0">
        <p className="text-body-sm font-medium text-text">This package ships executable code</p>
        <p className="mt-1 text-body-sm text-muted">
          Its <code className="font-mono">extensions/</code> directory holds JS or TS modules that
          Arcturn would load into your session — arbitrary code execution, with whatever your
          session can reach. The install{" "}
          <strong className="font-medium text-text">fails closed</strong>: nothing is linked until
          you confirm a prompt that names every file, declining installs nothing at all, and a
          non-interactive install of executable code refuses outright. Read the source before you
          confirm.
        </p>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * The blocks
 * ------------------------------------------------------------------ */

function BlockHeading({ children, count }: { children: string; count: number }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="text-h4 text-text">{children}</h3>
      <p className="text-caption text-faint">{count}</p>
    </div>
  );
}

const BLOCK = "mt-10 first:mt-0";

/**
 * Everything the install would add, in `arcturn inspect`'s own vocabulary and
 * order: roles first (they carry the capability), then workflows (they spend
 * money), then skills, then MCP servers.
 */
export function DisclosureBlocks({ entry }: { entry: HubEntry }) {
  const { agents, workflows, skills, mcp } = entry.disclosure;
  const lanesUsed = (["write", "exec", "read"] as const).filter((lane) =>
    agents?.some((agent) => agent.lane === lane),
  );
  const unlabelledSkills = skills?.some((skill) => skill.line === undefined) ?? false;

  return (
    <div>
      {agents && agents.length > 0 ? (
        <section className={BLOCK} aria-labelledby="disclosure-agents">
          <div id="disclosure-agents">
            <BlockHeading count={agents.length}>Agent roles</BlockHeading>
          </div>
          <p className="mt-2 max-w-(--measure-body) text-body-sm text-muted">
            A role&rsquo;s lane is derived from the tools it declares — from what it can do, never
            from what its description claims about itself.
          </p>
          <DisclosureTable
            className="mt-5"
            caption={`Agent roles installed by ${entry.name}, with the lane each runs on`}
            columns={[
              { header: "Role", className: "w-48" },
              { header: "Lane", className: "w-32" },
              { header: "Tools" },
            ]}
            rows={agents.map((agent) => ({
              key: agent.name,
              cells: [
                <span key="name" className="font-mono">
                  {agent.name}
                </span>,
                <LaneBadge key="lane" lane={agent.lane} />,
                <span key="tools" className="flex flex-wrap gap-1.5">
                  {agent.tools.map((tool) => (
                    <Tool key={tool} name={tool} />
                  ))}
                </span>,
              ],
            }))}
          />
          {lanesUsed.length > 0 ? (
            <dl className="mt-5 border-y border-default">
              {lanesUsed.map((lane) => (
                <div
                  key={lane}
                  className="flex flex-col gap-1.5 border-b border-default py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4"
                >
                  <dt className="shrink-0">
                    <LaneBadge lane={lane} />
                  </dt>
                  <dd className="min-w-0 text-body-sm text-muted">{LANE_NOTE[lane]}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>
      ) : null}

      {workflows && workflows.length > 0 ? (
        <section className={BLOCK} aria-labelledby="disclosure-workflows">
          <div id="disclosure-workflows">
            <BlockHeading count={workflows.length}>Workflows</BlockHeading>
          </div>
          <p className="mt-2 max-w-(--measure-body) text-body-sm text-muted">
            A workflow spends money. The budget is the file&rsquo;s own ceiling, enforced by the
            engine — the run aborts when the total reaches it.
          </p>
          <DisclosureTable
            className="mt-5"
            caption={`Workflows installed by ${entry.name}, with their stage counts and budgets`}
            columns={[
              { header: "Workflow", className: "w-56" },
              { header: "Stages", className: "w-24" },
              { header: "Budget" },
            ]}
            rows={workflows.map((workflow) => ({
              key: workflow.name,
              cells: [
                <span key="name" className="font-mono">
                  {workflow.name}
                </span>,
                workflow.stages,
                workflow.budgetUsd === undefined ? "none declared" : `$${workflow.budgetUsd}`,
              ],
            }))}
          />
        </section>
      ) : null}

      {skills && skills.length > 0 ? (
        <section className={BLOCK} aria-labelledby="disclosure-skills">
          <div id="disclosure-skills">
            <BlockHeading count={skills.length}>Skills</BlockHeading>
          </div>
          <DisclosureTable
            className="mt-5"
            caption={`Skills installed by ${entry.name}`}
            columns={[{ header: "Skill", className: "w-56" }, { header: "First line" }]}
            rows={skills.map((skill) => ({
              key: skill.name,
              cells: [
                <span key="name" className="font-mono">
                  {skill.name}
                </span>,
                skill.line ?? <span className="text-faint">not disclosed</span>,
              ],
            }))}
          />
          {unlabelledSkills ? (
            <p className="mt-3 max-w-(--measure-body) text-caption text-faint">
              A skill&rsquo;s first line is read from its file. Where this entry omits one it was
              listed before that file existed, and a line typed by hand here could contradict the
              package. <code className="font-mono">arcturn inspect</code> prints the real one.
            </p>
          ) : null}
        </section>
      ) : null}

      {mcp && mcp.length > 0 ? (
        <section className={BLOCK} aria-labelledby="disclosure-mcp">
          <div id="disclosure-mcp">
            <BlockHeading count={mcp.length}>MCP servers</BlockHeading>
          </div>
          <p className="mt-2 max-w-(--measure-body) text-body-sm text-muted">
            Merged into your <code className="font-mono">mcp.json</code>. Each one is a remote
            capability surface — tools you did not write, reachable from your session.
          </p>
          <DisclosureTable
            className="mt-5"
            caption={`MCP servers added by ${entry.name}`}
            columns={[{ header: "Server", className: "w-56" }, { header: "Transport" }]}
            rows={mcp.map((server) => ({
              key: server.name,
              cells: [
                <span key="name" className="font-mono">
                  {server.name}
                </span>,
                <code key="transport" className="font-mono">
                  {server.transport}
                </code>,
              ],
            }))}
          />
        </section>
      ) : null}

      <div className={cn(BLOCK)}>
        <ExecutableNotice executable={entry.disclosure.executable} />
      </div>
    </div>
  );
}
