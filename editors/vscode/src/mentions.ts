/**
 * Building the text an `@`-mention becomes on its way into the Arcturn
 * terminal.
 *
 * Every rule here exists because the mention is not decoration. The engine
 * re-reads it as a path (`packages/cli/src/mentions.ts`), a terminal treats a
 * newline as "submit", and — if the TUI is not the thing currently reading
 * that terminal — a shell reads whatever we type. Getting any of those wrong
 * turns a helpful gesture into someone else's command.
 *
 * ## Why an allow-list, and why refusal rather than repair
 *
 * The obvious fix for a hostile filename is to quote it. It does not work,
 * for two independent reasons, both verified rather than assumed:
 *
 * 1. The engine's mention grammar understands exactly one quoting form,
 *    `@"..."`, and has **no escape mechanism**. A path containing `"` cannot
 *    be represented in it at all — quoting such a path closes the quote early
 *    and hands the remainder to whatever is reading.
 * 2. Double quotes are not inert in a shell. `"$(cmd)"` still runs `cmd`, and
 *    the same goes for backticks and (interactively) `!`.
 *
 * So there is no encoding that is simultaneously parseable by the engine and
 * safe at a shell prompt. What is left is to decide, per character, whether it
 * can be carried at all — an allow-list, where an unfamiliar character is
 * refused by default rather than by omission from a list of known-bad ones.
 *
 * Paths are **refused**, not repaired. Stripping a character produces a
 * mention that names a *different* file, which is a silent wrong answer;
 * saying "this name cannot be mentioned" is a loud right one. Diagnostic
 * *messages* take the opposite treatment for the opposite reason — see
 * {@link buildDiagnosticPrompt}.
 *
 * {@link buildMentionInput} is the single choke point: `toWorkspaceRelative`
 * does path arithmetic and nothing else, so there is one place to audit.
 */

import { posix as posixPath, win32 as win32Path } from "node:path";

/** A 1-based, inclusive line range, as VS Code counts lines for humans. */
export interface MentionRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Either the exact keystrokes to type, or why there are none.
 *
 * A result type rather than a thrown error or an empty string: the caller has
 * to say something to the user, and it needs the reason to do it.
 */
export type MentionInput =
  | { readonly ok: true; readonly input: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Characters with no meaning to a shell inside a word that already begins
 * with `@`, so they need no quoting.
 *
 * `~` is absent deliberately: it is only special at the start of a word, and
 * ours starts with `@`, but quoting it costs nothing and removes the need to
 * re-derive that argument later. `%` is likewise only special as a job spec at
 * word start.
 */
const BARE_SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./+,=@%:";

/**
 * Characters that are special to a shell bare but genuinely inert inside
 * double quotes: no globbing, no brace expansion, no subshell, no comment.
 *
 * These are the ones that actually turn up in real trees — `foo (1).ts`,
 * `app/[id]/page.tsx`, `#scratch.ts` — so refusing them would break ordinary
 * work to fix a problem quoting does solve here.
 */
const QUOTE_SAFE = " '()[]{}#~*?";

/** C0, DEL and C1. A terminal acts on these; no quoting form neutralizes them. */
function isControlCharacter(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/** Name a control character without putting one in a notification. */
function nameControlCharacter(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

type Verdict =
  | { readonly kind: "bare" }
  | { readonly kind: "quoted" }
  | { readonly kind: "reject"; readonly offenders: string[] };

/**
 * Decide how — or whether — a path can be carried in a mention.
 *
 * Iterating with `for...of` walks code points, so an astral character arrives
 * whole rather than as two surrogates that would each fail the range check.
 */
function classify(path: string): Verdict {
  const offenders = new Set<string>();
  let needsQuotes = false;
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (isControlCharacter(code)) {
      offenders.add(nameControlCharacter(code));
      continue;
    }
    // Everything outside ASCII is a letter in someone's alphabet, not shell
    // syntax. Refusing it would make the extension unusable in half the world.
    if (code >= 0xa0) continue;
    if (BARE_SAFE.includes(character)) continue;
    if (QUOTE_SAFE.includes(character)) {
      needsQuotes = true;
      continue;
    }
    offenders.add(character);
  }
  if (offenders.size > 0) return { kind: "reject", offenders: [...offenders] };
  return needsQuotes ? { kind: "quoted" } : { kind: "bare" };
}

function describeRejection(offenders: string[]): string {
  const list = offenders.map((offender) => `"${offender}"`).join(", ");
  return `that file's name contains ${list}, which a mention cannot carry safely. Refusing rather than renaming it: a stripped name would point at a different file.`;
}

function toSlashes(value: string): string {
  return value.split("\\").join("/");
}

/**
 * Express `filePath` the way the engine will resolve it: relative to the
 * workspace root, forward-slashed.
 *
 * Two deliberate fallbacks. A file outside the root gets its absolute path
 * rather than a `../` climb, because the engine refuses mentions that escape
 * the workspace and drops them silently — an absolute path at least names
 * what the user picked. The root itself gets its own absolute path, because
 * an empty relative path would produce a bare `@ ` that means nothing.
 *
 * This function does not sanitize. {@link buildMentionInput} does, so that
 * there is exactly one place where the decision lives.
 */
export function toWorkspaceRelative(
  root: string | undefined,
  filePath: string,
  platform: NodeJS.Platform,
): string {
  if (root === undefined) return toSlashes(filePath);
  const path = platform === "win32" ? win32Path : posixPath;
  const relative = path.relative(root, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return toSlashes(filePath);
  }
  return toSlashes(relative);
}

/**
 * The exact keystrokes sent to the terminal for a mention: the token and one
 * space — or a refusal.
 *
 * No newline, ever. That is now enforced rather than asserted: a newline is a
 * control character, and control characters are refused above. The user is
 * mid-thought; the extension supplies the part that is tedious to type and
 * leaves the sentence — and the Enter key — to them.
 */
export function buildMentionInput(relPath: string, range?: MentionRange): MentionInput {
  if (relPath === "") {
    return { ok: false, reason: "there is no path to mention." };
  }
  const verdict = classify(relPath);
  if (verdict.kind === "reject") {
    return { ok: false, reason: describeRejection(verdict.offenders) };
  }
  // Safe because `"` is refused above: the quote we open is the only one in
  // the token, so it is also the one that closes it.
  const token = verdict.kind === "quoted" ? `"${relPath}"` : relPath;
  if (range === undefined) return { ok: true, input: `@${token} ` };
  const low = Math.min(range.startLine, range.endLine);
  const high = Math.max(range.startLine, range.endLine);
  const suffix = low === high ? `:${low}` : `:${low}-${high}`;
  return { ok: true, input: `@${token}${suffix} ` };
}

/** Replace control characters with spaces, keeping words from fusing together. */
function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += isControlCharacter(code) ? " " : character;
  }
  return out;
}

/**
 * The line "Fix with Arcturn" types: the mention, then the diagnostic in the
 * problem-report's own words.
 *
 * Control characters are **stripped** here, where a path would be refused.
 * The asymmetry is deliberate: a message with a character removed is still a
 * useful message, whereas a path with a character removed names the wrong
 * file. The message matters because diagnostics routinely quote source text
 * back — a hostile string literal in the file reaches this line through the
 * language server, escape sequences and all.
 *
 * The flattening that follows is why a multi-line diagnostic cannot submit
 * the prompt at its first newline.
 */
export function buildDiagnosticPrompt(mentionInput: string, message: string): string {
  const flattened = stripControlCharacters(message).replace(/\s+/g, " ").trim();
  if (flattened === "") return mentionInput;
  return `${mentionInput}Fix this problem: ${flattened} `;
}

/** The 0-based, half-open shape VS Code's `Selection` and `Range` both satisfy. */
export interface SelectionLike {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

/**
 * Convert a VS Code selection into the 1-based inclusive range a human reads
 * in the gutter.
 *
 * The `character === 0` case is the one that bites: a triple-click, or a
 * shift-down drag, ends at column 0 of the *next* line. Counting that line as
 * selected sends the model a line the user never highlighted, and for a
 * one-line selection it doubles the range.
 */
export function rangeFromSelection(selection: SelectionLike): MentionRange {
  const startLine = selection.start.line + 1;
  const touchesOnly = selection.end.character === 0 && selection.end.line > selection.start.line;
  const endLine = touchesOnly ? selection.end.line : selection.end.line + 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
}
