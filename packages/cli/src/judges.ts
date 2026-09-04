/**
 * JUDGE DISAGREEMENT — running one step several times and arbitrating the split.
 *
 * A step written `[judges:2] [contract:verdict] @reviewer …` is not run once.
 * It is run N times, concurrently, by N independent subagents given the same
 * prompt and no sight of each other, and the engine then compares one field of
 * their contract replies. Agreement is the cheap case and the common one: the
 * first judge's answer stands. Disagreement is the expensive case and the
 * interesting one — it is the engine noticing that a question a pipeline was
 * about to act on does not have a stable answer — and it is settled by an
 * ARBITER: one more run of the same role, shown both replies in full and told
 * to decide rather than average.
 *
 * Why this module owns none of the running: the panel is *policy* (how many,
 * which field, who wins, what the arbiter is told) and the engine is
 * *mechanism* (a step request, a retry loop, a worktree, a budget). Keeping
 * them apart means the whole decision procedure can be tested against a
 * three-line fake and no LLM, and means `workflow.ts` gains one call rather
 * than a second scheduler. {@link runJudgePanel} is therefore generic over
 * whatever the engine wants to carry back for each run — it never looks
 * inside.
 *
 * Nothing here does I/O, and nothing here throws: a caller's `run` rejecting
 * is the caller's to handle, and every refusal this module owns is a string in
 * the `step <id>: …` house style, raised at PRE-FLIGHT (before a token is
 * spent) exactly like an unknown model tag.
 */

import type { WorkflowContract, WorkflowContractField } from "./contracts.js";

/**
 * What a judged step recorded, for the journal, the ledger and status output.
 *
 * `verdicts` are the compared field's values in JUDGE ORDER, so a reader can
 * see the split itself rather than only that there was one. Values, not
 * reasons: an enum member is a word from a closed set the workflow file
 * declared, which is why it is the one part of a contract this record carries.
 */
export interface JudgesRecord {
  /** How many judges ran — the step's `[judges:N]`. */
  readonly count: number;
  /** The compared field's value from each judge that produced a valid reply. */
  readonly verdicts: readonly string[];
  /** True when every valid judge said the same thing. */
  readonly agreed: boolean;
  /** True when an arbiter ran, which is exactly when `agreed` is false. */
  readonly arbitrated: boolean;
  /** The arbiter's own verdict, when one ran and produced a valid reply. */
  readonly arbiterVerdict?: string;
}

/** Field names a contract may use for its verdict when it declares no enum. */
const VERDICT_FIELD_NAMES = ["decision", "verdict"] as const;

/**
 * The field a panel compares.
 *
 * An ENUM field first, and the first one written: a closed set of values is
 * the only kind of field two judges can meaningfully agree or disagree *on* —
 * comparing free text would call two identical verdicts a split because one of
 * them added a comma. A field literally named `decision` or `verdict` is the
 * fallback, because a contract that declares one has already said which field
 * carries the answer. Anything else has no comparable field, and the caller
 * refuses the run rather than picking one.
 *
 * @param contract - The step's declared contract.
 */
export function judgeCompareField(contract: WorkflowContract): WorkflowContractField | undefined {
  const enumField = contract.fields.find((field) => field.type.kind === "enum");
  if (enumField !== undefined) return enumField;
  return contract.fields.find((field) =>
    (VERDICT_FIELD_NAMES as readonly string[]).includes(field.name),
  );
}

/** Pre-flight refusal: a judged step whose role could change the checkout. */
export function judgesWriteLaneError(stepId: string, role: string): string {
  return `step ${stepId}: judges requires a read-only role; "${role}" can write`;
}

/** Pre-flight refusal: a judged step whose contract has nothing to compare. */
export function judgesNoEnumFieldError(stepId: string): string {
  return `step ${stepId}: judges needs a contract with an enum field to compare`;
}

/**
 * The note appended to a contract-failing step's prompt on its one retry.
 *
 * Shared with the ordinary (unjudged) contract retry so a model is told the
 * same thing whichever construct it failed under. The errors are the
 * validator's own, unedited — they name the field and what was expected, which
 * is the whole of what a second attempt needs.
 *
 * @param prompt - The prompt as it was dispatched the first time.
 * @param errors - Every message {@link import("./contracts.js").validateContract} collected.
 */
export function contractRetryPrompt(prompt: string, errors: readonly string[]): string {
  return [
    prompt,
    "",
    "```",
    `Your previous reply did not satisfy the contract: ${errors.join("; ")}.`,
    "Reply again and end with a valid json block.",
    "```",
  ].join("\n");
}

/** How many judges disagreed, in words, for the arbiter's opening line. */
function judgeCountWord(count: number): string {
  return count === 2 ? "Two" : count === 3 ? "Three" : String(count);
}

/**
 * The arbiter's prompt: the original brief, then both replies, then the job.
 *
 * The replies go in WHOLE and fenced. A summary would hand the arbiter the
 * disagreement pre-digested by the very engine that cannot tell which side is
 * right, and fencing them keeps a judge's own fenced json block from reading
 * as the arbiter's answer. "Do not average" is there because the failure mode
 * of a model shown two verdicts is to invent a third one between them, which
 * is not a decision — it is a refusal to make one.
 *
 * @param prompt - The step's dispatched prompt, verbatim.
 * @param replies - Each disagreeing judge's full reply, in judge order.
 */
export function arbiterPrompt(prompt: string, replies: readonly string[]): string {
  const parts = [
    prompt,
    "",
    // One reply reaches an arbiter when the rest of the panel never produced a
    // usable one. It is not a disagreement, and saying it was would tell the
    // arbiter to weigh evidence it has not been shown.
    replies.length === 1
      ? "Only one of the independent judges produced a usable reply:"
      : `${judgeCountWord(replies.length)} independent judges disagreed:`,
  ];
  for (const [index, reply] of replies.entries()) {
    parts.push("", `Judge ${index + 1}:`, "```", reply, "```");
  }
  parts.push(
    "",
    replies.length === 1
      ? "Decide for yourself; do not simply defer to it. End with the contract json block."
      : "Decide. Weigh the evidence in each; do not average. End with the contract json block.",
  );
  return parts.join("\n");
}

/** The one-line live notice a split raises, before the arbiter starts. */
export function judgesDisagreementNotice(stepId: string, verdicts: readonly string[]): string {
  return `judges disagreed on step ${stepId} (${verdicts.join(" vs ")}) — arbitrating`;
}

/**
 * The `judges: …` line `/workflow status` prints under a judged step.
 *
 * @param record - What the step's terminal recorded.
 * @param dot - The separator glyph the surrounding view uses.
 */
export function describeJudges(record: JudgesRecord, dot = "·"): string {
  const parts = [String(record.count)];
  if (record.verdicts.length > 0) parts.push(record.verdicts.join(" / "));
  if (record.arbiterVerdict !== undefined) parts.push(`arbiter: ${record.arbiterVerdict}`);
  else if (record.arbitrated) parts.push("arbiter: no verdict");
  return `judges: ${parts.join(` ${dot} `)}`;
}

/** One run of a judged step, as the engine reports it back to the panel. */
export interface JudgeOutcome<T> {
  /** Whatever the engine needs to keep for this run — never inspected here. */
  readonly carrier: T;
  /** The validated contract object, absent when this run produced none. */
  readonly value?: Record<string, unknown>;
  /** The run's final reply, verbatim — what an arbiter is shown. */
  readonly text: string;
}

/** Which seat a run is being asked to fill. */
export type JudgeSeat = "judge" | "arbiter";

/** What {@link runJudgePanel} asks the engine to run. */
export interface JudgeRequest {
  /**
   * 0-based seat index, unique across the whole panel — the arbiter takes the
   * seat after the last judge. The engine folds it into the step's attempt
   * marker so two seats never share a worktree slug or a live row.
   */
  readonly index: number;
  /** The prompt for this seat: the step's own, or the arbiter's. */
  readonly prompt: string;
  readonly seat: JudgeSeat;
}

/** Everything a panel needs beyond the engine's runner. */
export interface JudgePanelOptions<T> {
  /** `[judges:N]` — 2 or 3, already validated by the grammar. */
  readonly count: number;
  /** The contract field whose values are compared. */
  readonly field: string;
  /** The step's dispatched prompt; every judge gets exactly this. */
  readonly prompt: string;
  /** Runs one seat. Called concurrently for the judges, then once for an arbiter. */
  readonly run: (request: JudgeRequest) => Promise<JudgeOutcome<T>>;
  /** Called once, before the arbiter starts, when the judges split. */
  readonly onDisagreement?: (verdicts: readonly string[]) => void;
}

/** What a panel came back with. */
export interface JudgePanelResult<T> {
  /** Every run the panel made, judges first, in seat order. */
  readonly runs: readonly JudgeOutcome<T>[];
  /**
   * The run whose answer IS the step's answer: the first agreeing judge, or
   * the arbiter. Absent when nothing valid came back at all — the caller then
   * fails the step on its contract, which is what actually happened.
   */
  readonly winner?: JudgeOutcome<T>;
  /** The record for the journal, the ledger and status output. */
  readonly record: JudgesRecord;
}

/** The compared field's value as a string, when the object carries one. */
function verdictOf(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Run a judged step: N judges concurrently, then an arbiter if they split.
 *
 * The judges run under `Promise.all` for the same reason a parallel stage's
 * branches do — they are independent by construction, and running them in
 * sequence would multiply the wall clock of the one construct a person reaches
 * for when the answer matters. Only the *valid* replies are compared: a judge
 * whose reply never satisfied the contract (after its own retry) has not voted,
 * and counting its silence as a disagreement would send every flaky panel to an
 * arbiter. Two valid judges that agree end the step with the FIRST one's
 * answer, not a merged one — the pipeline downstream reads one reply, and
 * inventing a synthetic one nobody wrote is exactly what the arbiter exists to
 * avoid doing.
 *
 * @param options - The panel's shape and the engine's runner.
 */
export async function runJudgePanel<T>(
  options: JudgePanelOptions<T>,
): Promise<JudgePanelResult<T>> {
  const { count, field, prompt, run } = options;
  const judges = await Promise.all(
    Array.from({ length: count }, (_unused, index) =>
      run({ index, prompt, seat: "judge" as const }),
    ),
  );
  const valid = judges.filter(
    (outcome): outcome is JudgeOutcome<T> & { value: Record<string, unknown> } =>
      outcome.value !== undefined && verdictOf(outcome.value, field) !== undefined,
  );
  const verdicts = valid.map((outcome) => verdictOf(outcome.value, field) as string);
  // Nobody produced a usable verdict. The panel says so and returns no winner;
  // the engine fails the step exactly as it fails any contract violation,
  // because that is the failure that happened N times over.
  if (valid.length === 0) {
    return {
      runs: judges,
      record: { count, verdicts: [], agreed: false, arbitrated: false },
    };
  }
  // AGREEMENT NEEDS TWO. One valid reply is not a panel agreeing with itself:
  // `judges: 2 · SHIP` reads as "two judges agreed" and would have been one
  // judge's answer with the other's silence rounded up. A single vote is
  // therefore treated as a split — the arbiter is shown what there is and
  // decides, which is the same escalation any other unresolved panel gets.
  const agreed = valid.length >= 2 && verdicts.every((verdict) => verdict === verdicts[0]);
  if (agreed) {
    return {
      runs: judges,
      winner: valid[0],
      record: { count, verdicts, agreed: true, arbitrated: false },
    };
  }
  options.onDisagreement?.(verdicts);
  const arbiter = await run({
    index: count,
    prompt: arbiterPrompt(
      prompt,
      valid.map((outcome) => outcome.text),
    ),
    seat: "arbiter",
  });
  const arbiterVerdict = arbiter.value === undefined ? undefined : verdictOf(arbiter.value, field);
  return {
    runs: [...judges, arbiter],
    // An arbiter that failed its own contract leaves the step with no answer:
    // the split is real and unresolved, and picking a judge at that point would
    // be the engine casting the deciding vote. An arbiter whose object is
    // valid but carries no COMPARED FIELD is the same thing — reachable when
    // that field is `optional` — and used to win the step while status printed
    // "arbiter: no verdict" beside it.
    ...(arbiterVerdict === undefined ? {} : { winner: arbiter }),
    record: {
      count,
      verdicts,
      agreed: false,
      arbitrated: true,
      ...(arbiterVerdict === undefined ? {} : { arbiterVerdict }),
    },
  };
}
