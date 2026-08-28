/**
 * Editing a selection in place.
 *
 * Everything Arcturn does went through the panel or the terminal: you describe
 * a change, the agent finds the file, reads it, and writes it back through the
 * permission engine. That is right for work that spans files and wrong for the
 * commonest edit there is — "rewrite this bit", with the bit already selected.
 *
 * ## The agent proposes text; the editor makes the edit
 *
 * The run is deliberately **read-only**. The instruction asks for the
 * replacement as a fenced block and nothing else, and the extension applies it
 * as a `WorkspaceEdit` — the user's own undoable edit, in their own editor,
 * after they have seen it. Three things fall out of that, and each is why it
 * is built this way rather than by letting the agent call `write`:
 *
 * - **Undo works.** A `WorkspaceEdit` is one entry in the editor's undo stack.
 *   A file rewritten underneath the editor is not.
 * - **Reject is free.** Nothing was written, so declining costs a discarded
 *   string rather than a revert.
 * - **The range is honoured.** An agent told to change lines 40-60 may decide
 *   lines 12 and 88 also need it. Sometimes it is right, and that is what the
 *   panel is for; an inline edit that silently reached outside the selection
 *   would be the one thing this gesture must not do.
 *
 * Pure by construction, like every `model.ts` here. Parsing a model's answer is
 * where this can be wrong, and it should be checkable without an editor.
 */

/** Where an inline edit applies. */
export interface EditTarget {
  /** Workspace-relative path, as the engine spells it. */
  readonly path: string;
  /** 1-based inclusive line range, matching `LineRange`. */
  readonly start: number;
  readonly end: number;
  /** The exact text currently in that range. */
  readonly text: string;
  /** The document's language id, so the fence can be labelled. */
  readonly languageId: string;
}

/**
 * The instruction sent to the engine.
 *
 * Three things it has to do. Say what to change, in the user's words. Say what
 * to answer with, because a model that explains its reasoning produces an
 * answer this cannot apply. And say what *not* to do — reach outside the
 * selection, or call a tool to write the file itself, which would take the
 * edit out of the editor's undo stack and out of the user's review.
 *
 * The selected text is included inline rather than attached. It is small by
 * definition, and an attachment would arrive as a whole-file context block
 * with the selection somewhere inside it — which is exactly the ambiguity
 * about *which* lines to change that this gesture exists to remove.
 */
export function editInstruction(target: EditTarget, request: string): string {
  const fence = "```";
  return [
    `Rewrite the selected lines of ${target.path} (lines ${target.start}-${target.end}).`,
    "",
    `What to do: ${request}`,
    "",
    "The current text of those lines:",
    "",
    `${fence}${target.languageId}`,
    target.text,
    fence,
    "",
    "Answer with the replacement for those lines and nothing else, in a single",
    "fenced code block. No explanation before or after it, and no diff markers.",
    "Do not use any tool: do not read other files and do not write this one —",
    "the editor applies your answer, so that the change lands in the undo stack",
    "and the person can decline it.",
    "Change only what was asked for. If other parts of the file also need",
    "changing, say so in a comment inside the block rather than editing them,",
    "because only these lines will be replaced.",
  ].join("\n");
}

/**
 * Pull the replacement out of a model's answer.
 *
 * Fenced first, because that is what was asked for. Bare text is accepted as a
 * fallback rather than refused: a model that answered with exactly the code
 * and no fence has done the right thing in the wrong shape, and failing there
 * would be pedantry the user pays for.
 *
 * @returns The replacement, or `undefined` when there is nothing usable — an
 *   empty answer, or an answer that is only prose.
 */
export function extractReplacement(answer: string): string | undefined {
  const fenced = firstFencedBlock(answer);
  if (fenced !== undefined) return fenced;

  const trimmed = answer.trim();
  if (trimmed === "") return undefined;
  // Prose gives itself away by ending in a sentence rather than in code. This
  // is a heuristic and is meant to be: the cost of being wrong is a diff the
  // user declines, and the cost of refusing everything unfenced is a gesture
  // that fails for a model that was trying to help.
  if (/^[A-Z][^\n]*[.?!]$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The first fenced block in a string.
 *
 * Written by hand rather than with a regular expression because the closing
 * fence has to be found *by line*: a fence-looking sequence inside a nested
 * block or inside a string literal must not end the block early, and only
 * anchoring to line starts gets that right.
 */
function firstFencedBlock(answer: string): string | undefined {
  const lines = answer.split("\n");
  let open = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trimStart().startsWith("```")) {
      open = index;
      break;
    }
  }
  if (open < 0) return undefined;
  for (let index = open + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trimStart().startsWith("```")) {
      return lines.slice(open + 1, index).join("\n");
    }
  }
  // An unterminated fence is a truncated answer. Everything after the opening
  // fence is what the model managed to produce, and showing it as a diff the
  // user can decline beats discarding a nearly-complete edit.
  return lines.slice(open + 1).join("\n");
}

/**
 * Whether a replacement is worth showing.
 *
 * An answer identical to the selection means the model decided nothing needed
 * changing. That is a legitimate outcome and deserves a sentence, not a diff
 * editor with no diff in it.
 */
export function isNoChange(target: EditTarget, replacement: string): boolean {
  return normalizeEnds(replacement) === normalizeEnds(target.text);
}

/**
 * Match the selection's trailing-newline convention.
 *
 * A selection that ended without a newline and a replacement that ends with
 * one would silently add a blank line; the reverse would join two lines. The
 * user selected a range and expects a range back, so the boundary is preserved
 * rather than whatever the model happened to emit.
 */
export function fitToSelection(target: EditTarget, replacement: string): string {
  const hadTrailingNewline = target.text.endsWith("\n");
  const stripped = replacement.replace(/\n+$/, "");
  return hadTrailingNewline ? `${stripped}\n` : stripped;
}

/** Normalize line endings for comparison only. */
function normalizeEnds(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/** A one-line summary of what an edit would do, for the confirmation. */
export function describeEdit(target: EditTarget, replacement: string): string {
  const before = target.text.split("\n").length;
  const after = replacement.split("\n").length;
  const lines =
    target.start === target.end ? `line ${target.start}` : `lines ${target.start}-${target.end}`;
  if (before === after) return `Replace ${lines} of ${target.path}`;
  const delta = after - before;
  return `Replace ${lines} of ${target.path} (${delta > 0 ? "+" : ""}${delta} lines)`;
}
