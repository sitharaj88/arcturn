/**
 * Plain-language readings of transcript lines.
 *
 * DESIGN.md §2.6 hides terminal art from assistive technology, because a
 * screen reader given `● ▸ ls  ~/projects/api` reads punctuation, not meaning.
 * A structured line, though, knows what it is — so it can say so: "Tool call:
 * ls ~/projects/api." These readings back the visually-hidden transcript that
 * sits beside every mock, and double as content-derived React keys.
 */

import {
  chromeFacts,
  doneFacts,
  inputLabel,
  inputText,
  permissionOptions,
  statusLeftFacts,
  statusRightFacts,
  thinkingFacts,
} from "./labels";
import type { TerminalLine, TerminalNoticeLevel } from "./types";

const NOTICE_WORDS: Record<TerminalNoticeLevel, string> = {
  info: "Note",
  warn: "Warning",
  good: "Done",
  bad: "Error",
};

/** Present when it is a non-empty string. */
function has(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** Facts as a spoken clause: commas, not the terminal's `·`. */
function spoken(values: readonly string[]): string {
  return values.join(", ");
}

/**
 * Read one line aloud.
 *
 * @param line - The line to describe.
 * @returns A sentence, or `""` for a line that carries nothing to say.
 */
export function describeTerminalLine(line: TerminalLine): string {
  switch (line.kind) {
    case "chrome": {
      const app = line.app ?? "arcturn";
      const detail = spoken(chromeFacts(line));
      return has(detail) ? `Session header: ${app}, ${detail}.` : `Session header: ${app}.`;
    }
    case "user":
      return `Prompt: ${line.text}`;
    case "tool": {
      const call = has(line.args) ? `${line.name} ${line.args}` : line.name;
      const lead = (line.depth ?? 0) > 0 ? "Sub-agent tool call" : "Tool call";
      if (line.state === "run") return `${lead}: ${call}, running.`;
      if (line.state === "error") return `${lead}: ${call}, failed.`;
      return `${lead}: ${call}.`;
    }
    case "result":
      return line.cont === true ? line.text : `Result: ${line.text}`;
    case "notice":
      return `${NOTICE_WORDS[line.level]}: ${line.text}`;
    case "permission": {
      const chosen = line.selected ?? "once";
      const answers = permissionOptions(line)
        .map((option) => (option.key === chosen ? `${option.label}, selected` : option.label))
        .join("; ");
      const origin = has(line.origin) ? ` Requested by ${line.origin}.` : "";
      const detail = has(line.description) ? ` ${line.description}.` : "";
      return `Permission required for ${line.tool}: ${line.subject}.${detail}${origin} Options: ${answers}.`;
    }
    case "thinking": {
      const verb = line.verb ?? "thinking";
      return `Still ${verb}: ${spoken(thinkingFacts(line))}.`;
    }
    case "done":
      return `Finished: ${spoken(doneFacts(line))}.`;
    case "input":
      return `Prompt input: ${inputText(line)}. Permission mode ${inputLabel(line)}.`;
    case "status": {
      const detail = spoken([...statusLeftFacts(line), ...statusRightFacts(line)]);
      const app = line.app ?? "arcturn";
      return has(detail) ? `Status bar: ${app}, ${detail}.` : `Status bar: ${app}.`;
    }
    case "blank":
      return "";
    default:
      return line.text;
  }
}

/**
 * Whether a script uses any of the structured kinds.
 *
 * A transcript of hand-spaced `{ text }` rows is the noise §2.6 hides; a
 * structured one is a sequence of named steps worth reading out. This is what
 * decides which of the two a given mock gets.
 *
 * @param lines - The script to inspect.
 */
export function isStructuredScript(lines: readonly TerminalLine[]): boolean {
  return lines.some((line) => line.kind !== undefined && line.kind !== "text");
}
