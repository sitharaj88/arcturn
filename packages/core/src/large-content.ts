/**
 * One rule, said once, for writing a file too big to fit in one tool call.
 *
 * Four times in one week a write-lane role reasoned for 35–70K characters,
 * closed its thinking with "Write the file now.", and ended the turn with no
 * text and no tool call — `stopReason: endTurn`, nothing on disk — and did it
 * again when nudged, while the same model on a read lane emitted 23K
 * characters of plain *text* after 38K of reasoning without trouble. What did
 * not survive was a single tool-call argument asked to carry a thirty-kilobyte
 * document after that much thinking; the same step passed the first time the
 * role was told to land a skeleton with `write` and fill one section per
 * `edit` (13 calls of 1.5–5.5 KB, largest reasoning block 65,888 characters).
 */

/**
 * The guidance threshold, in characters, for one tool-call argument.
 *
 * Not enforced anywhere — no tool refuses a larger argument, because a
 * refusal would break the legitimate 8 KB source file. It is the number the
 * prompts, the tool descriptions and their tests all quote, so there is one
 * of it.
 */
export const LARGE_CONTENT_CHARS = 6_000;

/** `6,000` — the threshold as the prompts spell it. */
const THRESHOLD = LARGE_CONTENT_CHARS.toLocaleString("en-US");

/**
 * {@link LARGE_CONTENT_RULE}, pre-split into prompt-width lines.
 *
 * Shaped like `worktreeContractLines` in the CLI's workflow engine so a lane
 * contract can splice it in with a spread and keep its own wrapping.
 */
export const LARGE_CONTENT_LINES: readonly string[] = [
  `Never put more than about ${THRESHOLD} characters — roughly 100 lines — of content into a`,
  "single tool-call argument. To create a file larger than that, make one `write` call carrying",
  "only its title and section headings, then fill one section per `edit` call, replacing that",
  "heading with the heading plus its content (or append one chunk per call where a tool supports",
  "appending). Never hold more than one section in a call. When the last section is in, `read`",
  "the file once and check that every heading has content beneath it. Then report the path and",
  "which sections you filled — the document itself is already on disk.",
];

/**
 * The rule as one paragraph, for a system prompt or a role brief.
 *
 * Same words as {@link LARGE_CONTENT_LINES}, joined — a model that meets it in
 * two places must not meet two different rules.
 */
export const LARGE_CONTENT_RULE: string = LARGE_CONTENT_LINES.join(" ");
