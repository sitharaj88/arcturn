/**
 * The strings the CLI composes at render time.
 *
 * Both the painted row and its screen-reader description need the same facts —
 * the always-allow rule, the activity line's detail run, the input box's border
 * label — so each one is built exactly once, here. Facts come back as arrays
 * rather than joined text because the two readers punctuate differently: the
 * terminal separates with `·`, and a sentence read aloud separates with a
 * comma.
 */

import { TERMINAL_GLYPHS, TERMINAL_INPUT_PLACEHOLDER, TERMINAL_INTERRUPT_HINT } from "./glyphs";
import type {
  TerminalChromeLine,
  TerminalDoneLine,
  TerminalInputLine,
  TerminalPermissionLine,
  TerminalStatusLine,
  TerminalThinkingLine,
} from "./types";

/** What the terminal puts between two inline facts. */
export const FACT_SEPARATOR = ` ${TERMINAL_GLYPHS.dot} `;

/** Drop absent and empty facts. */
export function facts(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => value !== undefined && value !== "");
}

/** Everything after the brand mark and the product name in the header. */
export function chromeFacts(line: TerminalChromeLine): string[] {
  return facts([line.model, line.cwd]);
}

/** The three answers offered by a permission dialog, in the CLI's order. */
export function permissionOptions(
  line: TerminalPermissionLine,
): readonly { readonly key: "once" | "always" | "deny"; readonly label: string }[] {
  const rule = line.rule !== undefined && line.rule !== "" ? line.rule : line.tool;
  return [
    { key: "once", label: "Allow once" },
    { key: "always", label: `Allow always: ${rule} (project)` },
    { key: "deny", label: "Deny and tell the model why" },
  ];
}

/** `52s`, `465 tokens`, `esc to interrupt` — everything after the working verb. */
export function thinkingFacts(line: TerminalThinkingLine): string[] {
  return facts([
    line.elapsed,
    line.tokens === undefined || line.tokens === "" ? undefined : `${line.tokens} tokens`,
    line.hint ?? TERMINAL_INTERRUPT_HINT,
  ]);
}

/** `1m34s`, `1.3k tokens` — everything after the success mark. */
export function doneFacts(line: TerminalDoneLine): string[] {
  return facts([
    line.elapsed,
    line.tokens === undefined || line.tokens === "" ? undefined : `${line.tokens} tokens`,
    line.text,
  ]);
}

/** What the prompt editor shows: the typed text, or the placeholder. */
export function inputText(line: TerminalInputLine): string {
  if (line.value !== undefined && line.value !== "") return line.value;
  return line.placeholder ?? TERMINAL_INPUT_PLACEHOLDER;
}

/** The label riding the input box's bottom border. */
export function inputLabel(line: TerminalInputLine): string {
  if (line.label !== undefined && line.label !== "") return line.label;
  return line.running === true ? `${TERMINAL_GLYPHS.nested} steering` : "default";
}

/** The status bar's left group, after the brand mark and the product name. */
export function statusLeftFacts(line: TerminalStatusLine): string[] {
  return facts([line.model, line.mode, line.branch]);
}

/** The status bar's right group: spend, then context pressure. */
export function statusRightFacts(line: TerminalStatusLine): string[] {
  return facts([
    line.cost,
    line.ctx === undefined || line.ctx === "" ? undefined : `ctx ${line.ctx}`,
  ]);
}
