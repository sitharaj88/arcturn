/**
 * A commit message written from the diff, into the Source Control input box.
 *
 * The engine has had this since the git commands landed: `/commit` generates a
 * Conventional Commits message from the staged diff. But it lives in the
 * terminal, and the place people actually commit from in an editor is the
 * Source Control view — where every modern assistant puts a button beside the
 * message box. This is that button, running through the same engine.
 *
 * The prompt keeps the engine's contract (`COMMIT_SYSTEM_PROMPT` in
 * `git.ts`): Conventional Commits, message text only, no fences and no
 * explanation. It adds one thing the terminal version does not have — the
 * repository's own recent subjects — because the strongest signal for how this
 * project writes messages is how this project has been writing them, and the
 * git extension hands the log over for free.
 *
 * The message lands in the input box and nothing is committed. Generating is
 * cheap and committing is permanent, and the box exists precisely so a person
 * edits before they commit.
 */

/** What the prompt is built from. */
export interface CommitContext {
  /** The diff to describe. Staged when anything is, the working tree otherwise. */
  readonly diff: string;
  /** Whether `diff` is the staged half. Changes one sentence of the prompt. */
  readonly staged: boolean;
  /** Recent commit subjects, newest first. May be empty. */
  readonly recentSubjects: readonly string[];
}

/** Cap for the diff carried in the prompt. Head kept — see `review/model.ts`. */
export const MAX_COMMIT_DIFF_CHARS = 40_000;

/** The prompt for one commit message. */
export function commitPrompt(context: CommitContext): string {
  const fence = "```";
  const lines = [
    "Write a git commit message for this diff, following the Conventional",
    "Commits specification: type(scope): subject, then an optional blank line",
    "and body. Output ONLY the commit message text — no markdown fences, no",
    "explanation, no surrounding quotes. Do not use any tool.",
  ];
  if (context.recentSubjects.length > 0) {
    lines.push(
      "",
      "Recent commit subjects from this repository, for style — match their",
      "tone and conventions:",
      ...context.recentSubjects.slice(0, 10).map((subject) => `  ${firstLine(subject)}`),
    );
  }
  lines.push(
    "",
    context.staged ? "The staged diff:" : "The working tree diff (nothing is staged):",
    "",
    `${fence}diff`,
    capped(context.diff),
    fence,
  );
  return lines.join("\n");
}

/** Cap keeping the head; the marker counts against the cap. */
function capped(diff: string, max = MAX_COMMIT_DIFF_CHARS): string {
  if (diff.length <= max) return diff;
  const marker = "\n… (diff truncated)";
  return `${diff.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

/**
 * Clean a model's answer into a commit message.
 *
 * The same repairs the engine's `cleanCommitMessage` makes — fences and
 * wrapping quotes stripped — because models add both despite being told not
 * to, and a message committed with a stray backtick fence in it is permanent.
 *
 * @returns The message, or `undefined` when nothing usable came back.
 */
export function cleanMessage(answer: string): string | undefined {
  let text = answer.trim();
  // A fenced answer: take the inside.
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  // Wrapping quotes, straight or curly.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("“") && text.endsWith("”"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text === "" ? undefined : text;
}

/** The first line, for showing subjects in a prompt. */
function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}
