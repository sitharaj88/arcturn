/**
 * Background agents, as rows.
 *
 * `/bg` starts an agent that keeps working while you do something else, under
 * caps the engine decides and a caller cannot widen: read-only tools plus
 * `fetch`, permission mode `default` and never `yolo`, no `subagent` so it
 * cannot fan out, queued behind a concurrency limit. Four wire verbs have
 * carried all of that for two releases and no editor surface used one.
 *
 * Fire-and-forget only pays off if you find out it finished, which is the
 * whole reason this is a tree with a notification rather than a command that
 * prints. `adoptBackgroundAgent` is the other half: an agent's findings fold
 * back into the conversation you were having, so the work rejoins the thread
 * it left.
 *
 * Pure by construction, like `hub/tree.ts` and `scout/patch.ts`. The
 * judgements worth checking — what a row says, which actions apply to which
 * state, when polling should stop — do not need an extension host.
 */

/** How a background agent ended, or that it has not. */
export type AgentState = "running" | "done" | "failed" | "cancelled" | "interrupted";

/** One agent, as the wire delivers it. */
export interface AgentSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly task: string;
  readonly modelId: string;
  readonly status: AgentState;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly elapsedMs: number;
  readonly costUsd: number;
  readonly finalText?: string;
  readonly error?: string;
}

/** Whether a state means the agent is still working. */
export function isLive(status: AgentState): boolean {
  return status === "running";
}

/**
 * Whether any agent in a list is still working.
 *
 * What decides whether to keep polling. A tree that polled forever would be a
 * background feature with a foreground cost.
 */
export function anyLive(agents: readonly AgentSummary[]): boolean {
  return agents.some((agent) => isLive(agent.status));
}

/**
 * The codicon for a state.
 *
 * `interrupted` gets its own, and deliberately not the failure icon: the agent
 * did not fail, the process holding it went away. Those are different things
 * to a person deciding whether to start it again.
 */
export function stateIcon(status: AgentState): string {
  if (status === "running") return "loading~spin";
  if (status === "done") return "pass";
  if (status === "failed") return "error";
  if (status === "cancelled") return "circle-slash";
  return "debug-disconnect";
}

/**
 * How long an agent has been going, or how long it took.
 *
 * Whole units only. A background agent measured to the millisecond invites a
 * precision nobody asked for, and the useful question is "seconds or minutes".
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The line beside an agent's name.
 *
 * Cost is shown only once there is some, because `$0.00` on a job that has not
 * reached a priced turn reads as "this was free" rather than "nothing has been
 * counted yet" — the distinction `/cost` keeps everywhere else.
 */
export function agentDescription(agent: AgentSummary): string {
  const parts = [agent.status, formatElapsed(agent.elapsedMs)].filter((part) => part !== "");
  if (agent.costUsd > 0) parts.push(`$${agent.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

/**
 * The one line under an agent's name.
 *
 * A failure's reason wins over its findings: somebody reading a red row wants
 * to know what went wrong, not what the agent had managed to say first.
 */
export function agentDetail(agent: AgentSummary): string {
  if (agent.error !== undefined && agent.error !== "") return agent.error;
  if (agent.finalText !== undefined && agent.finalText !== "") return firstLine(agent.finalText);
  return agent.task;
}

/** What a row offers to do. */
export interface AgentActions {
  /** Stop it. Only while it is running. */
  readonly cancel: boolean;
  /**
   * Fold its findings into the open conversation.
   *
   * Offered for anything that produced text, including a failure or an
   * interruption: partial findings from an agent that died are still findings,
   * and refusing to hand them over would make the user copy them by hand.
   */
  readonly adopt: boolean;
}

/** Which actions apply to an agent in this state. */
export function actionsFor(agent: AgentSummary): AgentActions {
  return {
    cancel: isLive(agent.status),
    adopt: !isLive(agent.status) && (agent.finalText ?? "") !== "",
  };
}

/**
 * Which agents finished since the last look.
 *
 * By id and by state together, not by count: an agent evicted from the
 * listing would make a count-based comparison report a completion that never
 * happened, and two agents finishing between polls would report one.
 */
export function newlyFinished(
  before: ReadonlyMap<string, AgentState>,
  after: readonly AgentSummary[],
): AgentSummary[] {
  return after.filter((agent) => {
    if (isLive(agent.status)) return false;
    const was = before.get(agent.id);
    // Unknown means this listing is the first one, and announcing every
    // already-finished agent on the first poll would be a notification storm
    // about work the user has already seen.
    return was !== undefined && isLive(was);
  });
}

/** A snapshot of what each agent's state was, for the next comparison. */
export function stateSnapshot(agents: readonly AgentSummary[]): Map<string, AgentState> {
  return new Map(agents.map((agent) => [agent.id, agent.status]));
}

/** Trim to the first line, for a one-line row. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
