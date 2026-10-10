/**
 * The terminal form for an MCP elicitation — a server asking the user for a
 * few pieces of structured input.
 *
 * One dialog to decide (respond / decline; Esc cancels), then one small
 * dialog per field: a yes/no or option list for booleans and enums, a
 * one-line input for text, numbers and multi-selects (comma-separated). An
 * answer that does not parse re-asks the same field with the reason; Esc on
 * any field cancels the whole request, so nothing half-filled is ever sent.
 *
 * Everything the server wrote — its message, field titles, descriptions and
 * option labels — is untrusted text and goes through
 * {@link sanitizeForTerminal} before it is drawn.
 */

import type {
  McpElicitationField,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationValue,
} from "@arcturn/mcp";
import { Box, type Component, Editor, type Key, Text } from "@arcturn/tui";
import { oneLine } from "../format.js";
import { type GlyphSet, resolveGlyphs } from "../glyphs.js";
import { sanitizeForTerminal } from "../project-trust.js";
import { createChoice, type DialogHandle } from "./dialogs.js";

/** Shows one dialog and resolves with its answer (`undefined` when cancelled). */
export type ElicitationShow = <T>(dialog: DialogHandle<T>) => Promise<T | undefined>;

/** What the opening dialog offers. */
export type ElicitationChoice = "respond" | "decline";

/** Longest slice of a server's message the dialog will draw. */
const MAX_MESSAGE_CHARS = 1200;

function clean(text: string, max = 200): string {
  return oneLine(sanitizeForTerminal(text), max);
}

/** The server's message, sanitized line by line so paragraphs survive. */
function cleanMessage(message: string): string {
  return message
    .slice(0, MAX_MESSAGE_CHARS)
    .split(/\r?\n/)
    .map((line) => sanitizeForTerminal(line).trimEnd())
    .join("\n")
    .trim();
}

function fieldLabel(field: McpElicitationField): string {
  const title = field.title === undefined ? "" : clean(field.title, 60);
  return title === "" || title === field.name
    ? clean(field.name, 60)
    : `${title} (${clean(field.name, 40)})`;
}

function fieldKind(field: McpElicitationField): string {
  switch (field.kind) {
    case "string":
      return field.format === undefined ? "text" : field.format;
    case "number":
      return field.integer ? "whole number" : "number";
    case "boolean":
      return "yes/no";
    case "enum":
      return "one of a list";
    case "multiEnum":
      return "any of a list";
  }
}

/**
 * The opening dialog: which server is asking, what it says, and the fields it
 * wants, with Respond / Decline (Esc cancels).
 *
 * @param request - The validated elicitation.
 * @param width - Terminal width, used to size the lines.
 * @param glyphs - Icon set.
 */
export function elicitationDialog(
  request: McpElicitationRequest,
  width: number,
  glyphs: GlyphSet = resolveGlyphs(),
): DialogHandle<ElicitationChoice> {
  const choice = createChoice<ElicitationChoice>([
    {
      value: "respond",
      label: request.fields.length === 0 ? "Confirm" : "Fill in the form",
      data: "respond",
    },
    { value: "decline", label: "Decline — send nothing", data: "decline" },
  ]);
  const server = new Text(`MCP server "${clean(request.server, Math.max(20, width - 30))}" asks:`, {
    style: "warning",
  });
  const message = new Text(cleanMessage(request.message), { style: "title" });
  const fields =
    request.fields.length === 0
      ? []
      : [
          new Text(""),
          new Text("It wants:", { style: "muted" }),
          ...request.fields.map(
            (field) =>
              new Text(
                `  ${glyphs.dot} ${fieldLabel(field)} — ${fieldKind(field)}` +
                  `${field.required ? ", required" : ""}`,
                { style: "muted" },
              ),
          ),
        ];
  return {
    component: new Box([server, message, ...fields, new Text(""), choice.list, choice.hint], {
      title: `${glyphs.permission} Input requested`,
      border: "round",
      borderStyle: "warning",
      titleStyle: "warning",
      padding: { x: 1, y: 0 },
    }),
    result: choice.result,
  };
}

/** Outcome of {@link parseElicitationText}. */
export type ElicitationParse =
  | { ok: true; value: McpElicitationValue }
  | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseString(
  field: Extract<McpElicitationField, { kind: "string" }>,
  text: string,
): ElicitationParse {
  if (field.minLength !== undefined && text.length < field.minLength) {
    return { ok: false, error: `Needs at least ${field.minLength} characters.` };
  }
  if (field.maxLength !== undefined && text.length > field.maxLength) {
    return { ok: false, error: `At most ${field.maxLength} characters.` };
  }
  if (field.format === "email" && !EMAIL.test(text)) {
    return { ok: false, error: "That is not an email address." };
  }
  if (field.format === "uri" && !URL.canParse(text)) {
    return { ok: false, error: "That is not a URI." };
  }
  if (field.format === "date" && !DATE.test(text)) {
    return { ok: false, error: "Use a date like 2026-01-31." };
  }
  if (field.format === "date-time" && Number.isNaN(Date.parse(text))) {
    return { ok: false, error: "Use a date and time like 2026-01-31T09:00:00Z." };
  }
  return { ok: true, value: text };
}

function matchOption(
  field: { options: readonly { value: string; label: string }[] },
  text: string,
) {
  const needle = text.trim().toLowerCase();
  return field.options.find(
    (option) => option.value.toLowerCase() === needle || option.label.toLowerCase() === needle,
  );
}

/**
 * Parse what the user typed for one field into the value sent to the server.
 *
 * Text is taken verbatim (bounds and `format` checked); numbers must be
 * finite (and whole, for `integer`) within the field's bounds; a multi-select
 * is a comma-separated list of option values or labels.
 *
 * @param field - The field being answered.
 * @param raw - What the user typed. Must be non-empty: an empty answer is
 *   "skip" or "required", decided by the caller.
 */
export function parseElicitationText(field: McpElicitationField, raw: string): ElicitationParse {
  const text = raw.trim();
  switch (field.kind) {
    case "string":
      return parseString(field, raw);
    case "number": {
      const value = Number(text);
      if (text === "" || !Number.isFinite(value)) {
        return {
          ok: false,
          error: `"${clean(text, 40)}" is not a ${field.integer ? "whole number" : "number"}.`,
        };
      }
      if (field.integer && !Number.isInteger(value)) {
        return { ok: false, error: `"${clean(text, 40)}" is not a whole number.` };
      }
      if (field.minimum !== undefined && value < field.minimum) {
        return { ok: false, error: `Must be at least ${field.minimum}.` };
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return { ok: false, error: `Must be at most ${field.maximum}.` };
      }
      return { ok: true, value };
    }
    case "boolean": {
      const lowered = text.toLowerCase();
      if (["y", "yes", "true"].includes(lowered)) return { ok: true, value: true };
      if (["n", "no", "false"].includes(lowered)) return { ok: true, value: false };
      return { ok: false, error: "Answer yes or no." };
    }
    case "enum": {
      const option = matchOption(field, text);
      return option === undefined
        ? { ok: false, error: `"${clean(text, 40)}" is not one of the options.` }
        : { ok: true, value: option.value };
    }
    case "multiEnum": {
      const picked: string[] = [];
      for (const part of text
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "")) {
        const option = matchOption(field, part);
        if (option === undefined) {
          return { ok: false, error: `"${clean(part, 40)}" is not one of the options.` };
        }
        if (!picked.includes(option.value)) picked.push(option.value);
      }
      if (field.minItems !== undefined && picked.length < field.minItems) {
        return { ok: false, error: `Pick at least ${field.minItems}.` };
      }
      if (field.maxItems !== undefined && picked.length > field.maxItems) {
        return { ok: false, error: `Pick at most ${field.maxItems}.` };
      }
      return { ok: true, value: picked };
    }
  }
}

/** One field dialog's answer, before parsing. */
type FieldAnswer =
  | { kind: "value"; value: McpElicitationValue }
  | { kind: "text"; text: string }
  | { kind: "skip" };

/**
 * A text input inside a box, where Enter on an empty line is an answer too
 * (skip, or "required") — the editor alone swallows an empty submit.
 */
class FieldInput implements Component {
  constructor(
    private readonly box: Box,
    private readonly editor: Editor,
    private readonly onEmptyEnter: () => void,
  ) {}

  render(width: number): string[] {
    return this.box.render(width);
  }

  handleInput(key: Key): boolean {
    if (key.name === "enter" && !key.shift && !key.alt && this.editor.text.trim() === "") {
      this.onEmptyEnter();
      return true;
    }
    return this.box.handleInput(key);
  }

  getCursor() {
    return this.box.getCursor();
  }

  invalidate(): void {
    this.box.invalidate?.();
  }
}

interface FieldDialogContext {
  server: string;
  position: string;
  error: string | undefined;
  glyphs: GlyphSet;
}

function fieldHeader(field: McpElicitationField, context: FieldDialogContext): Component[] {
  const lines: Component[] = [
    new Text(`${fieldLabel(field)}${field.required ? "" : " (optional)"}`, { style: "title" }),
  ];
  if (field.description !== undefined && field.description.trim() !== "") {
    lines.push(new Text(clean(field.description, 300), { style: "muted" }));
  }
  if (context.error !== undefined) lines.push(new Text(context.error, { style: "error" }));
  return lines;
}

function fieldBox(children: Component[], context: FieldDialogContext): Box {
  return new Box(children, {
    title: `${context.glyphs.permission} "${clean(context.server, 40)}" ${context.position}`,
    border: "round",
    borderStyle: "warning",
    titleStyle: "warning",
    padding: { x: 1, y: 0 },
  });
}

function choiceFieldDialog(
  field: Extract<McpElicitationField, { kind: "boolean" | "enum" }>,
  context: FieldDialogContext,
): DialogHandle<FieldAnswer> {
  const rows =
    field.kind === "boolean"
      ? [
          { value: "yes", label: "Yes", data: { kind: "value", value: true } as FieldAnswer },
          { value: "no", label: "No", data: { kind: "value", value: false } as FieldAnswer },
        ]
      : field.options.map((option) => ({
          value: option.value,
          label: clean(option.label, 80),
          data: { kind: "value", value: option.value } as FieldAnswer,
        }));
  if (!field.required) {
    rows.push({ value: "\u0000skip", label: "Skip", data: { kind: "skip" } });
  }
  const initial =
    field.default === undefined
      ? undefined
      : field.kind === "boolean"
        ? field.default
          ? "yes"
          : "no"
        : field.default;
  const choice = createChoice<FieldAnswer>(rows, {
    ...(initial === undefined ? {} : { initialValue: initial }),
  });
  return {
    component: fieldBox([...fieldHeader(field, context), choice.list, choice.hint], context),
    result: choice.result,
  };
}

function textFieldDialog(
  field: Extract<McpElicitationField, { kind: "string" | "number" | "multiEnum" }>,
  context: FieldDialogContext,
): DialogHandle<FieldAnswer> {
  let settle: (answer: FieldAnswer | undefined) => void = () => undefined;
  const result = new Promise<FieldAnswer | undefined>((resolve) => {
    settle = resolve;
  });
  const initial =
    field.default === undefined
      ? undefined
      : Array.isArray(field.default)
        ? field.default.join(", ")
        : String(field.default);
  const editor = new Editor({
    // No `@`/`/` completion: this is a form field, not the prompt.
    autocompleteTriggers: [],
    maxVisibleLines: 3,
    ...(initial === undefined ? {} : { initialText: initial }),
    onSubmit: (text) => settle({ kind: "text", text }),
    onCancel: () => settle(undefined),
  });
  const extra: Component[] = [];
  if (field.kind === "multiEnum") {
    extra.push(
      new Text(
        `Options (comma-separated): ${field.options.map((option) => clean(option.value, 40)).join(", ")}`,
        { style: "muted" },
      ),
    );
  }
  const hint = new Text(
    `enter submit${field.required ? "" : " · empty enter skips"} · esc cancel the request`,
    { style: "muted" },
  );
  const box = fieldBox([...fieldHeader(field, context), ...extra, editor, hint], context);
  return {
    component: new FieldInput(box, editor, () =>
      settle(field.required ? { kind: "text", text: "" } : { kind: "skip" }),
    ),
    result,
  };
}

function fieldDialog(
  field: McpElicitationField,
  context: FieldDialogContext,
): DialogHandle<FieldAnswer> {
  return field.kind === "boolean" || field.kind === "enum"
    ? choiceFieldDialog(field, context)
    : textFieldDialog(field, context);
}

/**
 * Walk the user through an elicitation and return the spec's answer.
 *
 * @param request - The validated elicitation.
 * @param show - Puts a dialog on screen and resolves with its answer.
 * @param options - Terminal width and icon set.
 * @returns `accept` with every answered field, `decline`, or `cancel` (Esc,
 *   or the server withdrew the request).
 */
export async function runElicitationForm(
  request: McpElicitationRequest,
  show: ElicitationShow,
  options: { width: number; glyphs?: GlyphSet },
): Promise<McpElicitationResult> {
  const glyphs = options.glyphs ?? resolveGlyphs();
  const first = await show(elicitationDialog(request, options.width, glyphs));
  if (first === undefined || request.signal.aborted) return { action: "cancel" };
  if (first === "decline") return { action: "decline" };

  const content: Record<string, McpElicitationValue> = {};
  const total = request.fields.length;
  for (const [index, field] of request.fields.entries()) {
    let error: string | undefined;
    for (;;) {
      if (request.signal.aborted) return { action: "cancel" };
      const answer = await show(
        fieldDialog(field, {
          server: request.server,
          position: `${index + 1}/${total}`,
          error,
          glyphs,
        }),
      );
      if (answer === undefined) return { action: "cancel" };
      if (answer.kind === "skip") break;
      if (answer.kind === "value") {
        content[field.name] = answer.value;
        break;
      }
      if (answer.text.trim() === "") {
        error = "This one is required.";
        continue;
      }
      const parsed = parseElicitationText(field, answer.text);
      if (parsed.ok) {
        content[field.name] = parsed.value;
        break;
      }
      error = parsed.error;
    }
  }
  return { action: "accept", content };
}
