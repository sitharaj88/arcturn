/**
 * Task budgets for workflow steps (`[budget:<tokens>]`, a role's
 * `taskBudgetTokens:`): the parse-time rules, kept pure and import-free of the
 * engine so the web builder's mirror can be checked against exactly this text.
 *
 * A task budget is Anthropic's `output_config.task_budget` (beta
 * `task-budgets-2026-03-13`): the server shows the model a countdown of what
 * it generated and the tool results it read, and the model paces itself to
 * finish inside it. It is advisory — the turn ceiling stays the hard stop.
 */

/** The smallest budget the API accepts. */
export const TASK_BUDGET_MIN = 20_000;

/**
 * A Claude model a tag names, spelled the way the catalog spells it —
 * `claude-<family>-<major>[-<minor>]` — anywhere in the tag, so a provider
 * prefix (`anthropic/…`), a Bedrock profile or a Vertex `@` snapshot do not
 * hide it. The minor is a single digit not followed by another, so a dated id
 * (`claude-sonnet-4-20250514`) reads as 4.0.
 */
const CLAUDE_MODEL = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/i;

/**
 * Whether a family and generation (major × 100 + minor) has task budgets:
 * Opus 4.7 and later, Fable and Mythos 5 and later, Sonnet and Haiku 5.5 and
 * later. Sonnet 5 is the one current model without them.
 */
function hasTaskBudgets(family: string, generation: number): boolean {
  switch (family) {
    case "opus":
      return generation >= 407;
    case "fable":
    case "mythos":
      return generation >= 500;
    case "sonnet":
    case "haiku":
      return generation >= 505;
    default:
      return false;
  }
}

/**
 * The Claude model a tag names when that model cannot take a task budget —
 * `"claude-sonnet-5"` for `[anthropic/claude-sonnet-5]` — or `undefined` when
 * the tag names one that can, or names no Claude model at all (a tier, an
 * alias, another provider), which only the run can resolve.
 *
 * @param tag - A `[tag]` or one of a `[race:…]`'s tags.
 */
export function taskBudgetUnsupportedModel(tag: string): string | undefined {
  const match = CLAUDE_MODEL.exec(tag);
  if (!match) return undefined;
  const family = (match[1] ?? "").toLowerCase();
  const generation = Number(match[2]) * 100 + Number(match[3] ?? 0);
  if (hasTaskBudgets(family, generation)) return undefined;
  return match[0].toLowerCase();
}

/**
 * Validate a `[budget:…]` value: a whole number of tokens, at least
 * {@link TASK_BUDGET_MIN}. Returns the number or the house-style message
 * (without its `line N:` prefix).
 */
export function parseTaskBudget(value: string): number | { error: string } {
  if (/^\d+$/.test(value)) {
    const tokens = Number(value);
    if (Number.isSafeInteger(tokens) && tokens >= TASK_BUDGET_MIN) return tokens;
  }
  return {
    error: `budget must be a whole number of tokens, at least ${TASK_BUDGET_MIN}, got "${value}"`,
  };
}

/** The parse error for a budget on a step whose tag names a model without task budgets. */
export function taskBudgetModelError(tag: string, model: string): string {
  return (
    `budget needs a model with task budgets, and "${tag}" names ${model}, which has none — ` +
    "use Opus 4.7 or later, Fable 5 or later, Sonnet 5.5 or Haiku 5.5, or drop the budget"
  );
}
