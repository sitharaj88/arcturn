/**
 * A command that failed, and what to ask about it.
 *
 * VS Code's shell integration reports every command a terminal ran and how it
 * exited. The extension already subscribes to that signal for a different
 * reason — telling whether the Arcturn TUI is still alive — and the same
 * stream carries the thing a coding agent is most often asked about: a build
 * that broke, a test run that went red, a deploy that refused.
 *
 * Getting from there to a useful question is three judgements, and all three
 * are here because all three can be wrong in ways a person notices:
 *
 * - **Which failures are worth remembering.** Not the one where they pressed
 *   Ctrl-C, and not the shell complaining that they typed `gti`.
 * - **How much output to carry.** A failing test suite can print megabytes,
 *   and the useful part is the end.
 * - **What the prompt actually says.** A blob of stderr with "fix this" on top
 *   is a worse question than a person would have asked.
 *
 * Pure by construction. `view.ts` owns the subscription and the notification.
 */

/** One command that exited non-zero. */
export interface CommandFailure {
  /** The command line as the shell ran it. */
  readonly command: string;
  /** Exit code. Always non-zero here — a zero exit is not a failure. */
  readonly exitCode: number;
  /** Working directory, when the shell reported one. */
  readonly cwd?: string;
  /** What the command printed, already capped. May be empty. */
  readonly output: string;
  /** When it finished, epoch milliseconds. */
  readonly at: number;
}

/**
 * How much command output to carry into a prompt.
 *
 * The tail, not the head: a failing suite prints its summary last, a compiler
 * prints its error last, and a stack trace is most useful at the point it
 * stopped. Sized so a long failure is still one modest attachment rather than
 * a turn's whole budget.
 */
export const MAX_OUTPUT_CHARS = 8_000;

/**
 * Exit codes that mean "the user did that on purpose".
 *
 * 130 is SIGINT — Ctrl-C. 143 is SIGTERM. Neither is a failure to ask about,
 * and offering to explain the interrupt somebody just typed is the fastest way
 * to make a feature annoying enough to turn off.
 */
const DELIBERATE_EXITS = new Set([130, 143]);

/**
 * Commands that are not worth offering help with.
 *
 * A mistyped command name is a typo, and `cd` into a directory that is not
 * there is a typo. Both exit non-zero and neither wants a model.
 */
const TRIVIAL = [/^\s*cd(\s|$)/, /^\s*ls(\s|$)/, /^\s*clear(\s|$)/, /^\s*exit(\s|$)/];

/**
 * Whether a finished command is worth remembering.
 *
 * Deliberately conservative. The cost of remembering too much is a notification
 * nobody wanted; the cost of remembering too little is a command that was
 * already on screen anyway.
 */
export function isWorthOffering(failure: {
  command: string;
  exitCode: number | undefined;
}): boolean {
  if (failure.exitCode === undefined || failure.exitCode === 0) return false;
  if (DELIBERATE_EXITS.has(failure.exitCode)) return false;
  const command = failure.command.trim();
  if (command === "") return false;
  // An `arcturn` invocation exiting non-zero is Arcturn's own business, and
  // offering to ask Arcturn about it is a loop nobody wants to be in.
  if (/^\s*arcturn(\s|$)/.test(command)) return false;
  return !TRIVIAL.some((pattern) => pattern.test(command));
}

/**
 * Trim output to its useful end.
 *
 * Marked when trimmed, because a model handed a truncated log with no marker
 * will reason about the beginning it cannot see.
 */
export function tailOf(output: string, max = MAX_OUTPUT_CHARS): string {
  const text = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.length <= max) return text.trimEnd();
  // The marker counts against the cap. Adding it on top would let trimming
  // make the output *longer* than the input for anything just over the line,
  // which is the opposite of what a cap is for.
  const marker = "… (earlier output omitted)\n";
  const room = Math.max(0, max - marker.length);
  return `${marker}${text.slice(text.length - room).trimEnd()}`;
}

/**
 * A short label for a failure, for a status bar or a notification.
 *
 * The command, shortened from the *left* if it must be: the interesting part
 * of `pnpm --filter @arcturn/cli test -- --grep auth` is the end, and eliding
 * the front is how a person still recognises it.
 */
export function failureLabel(failure: CommandFailure, max = 48): string {
  const command = failure.command.trim().replace(/\s+/g, " ");
  const short = command.length <= max ? command : `…${command.slice(command.length - max + 1)}`;
  return `${short} (exit ${failure.exitCode})`;
}

/**
 * The prompt that asks about a failure.
 *
 * Written as a question a person would ask, because that is what gets a useful
 * answer: what happened, in this directory, running this. The output is fenced
 * so the model can tell log from instruction, and the ask is explicitly for a
 * diagnosis *first* — an agent that starts editing before it has said what is
 * wrong is one whose work you cannot check.
 */
export function failurePrompt(failure: CommandFailure): string {
  const fence = "```";
  const lines = [
    `This command failed with exit code ${failure.exitCode}:`,
    "",
    `${fence}sh`,
    failure.command.trim(),
    fence,
  ];
  if (failure.cwd !== undefined && failure.cwd !== "") {
    lines.push("", `It ran in ${failure.cwd}.`);
  }
  if (failure.output.trim() !== "") {
    lines.push("", "What it printed:", "", `${fence}`, tailOf(failure.output), fence);
  } else {
    // Said plainly rather than omitted: a model given a command and no output
    // should know the output is missing rather than assume it was silent.
    lines.push("", "Its output was not captured.");
  }
  lines.push(
    "",
    "Say what went wrong before changing anything. Then fix it if the fix is",
    "clear, and tell me what you would need to know if it is not.",
  );
  return lines.join("\n");
}
