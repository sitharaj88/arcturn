/**
 * Typed reply contracts for workflow steps.
 *
 * A step carrying `[contract:<name>]` must end its final reply with one fenced
 * ```json block whose object matches the named contract, declared elsewhere in
 * the same workflow file as a top-level ```contract fence. This module owns
 * everything about that shape that is *pure*: the field grammar the parser
 * shares ({@link parseContractBody}), the reply-side extraction and validation
 * the engine runs ({@link extractContractJson}, {@link validateContract}), the
 * instruction text that goes to the model ({@link contractPromptLines}), and
 * the one-line summary status output prints ({@link describeContractValue}).
 *
 * Why a separate module rather than more of `workflow.ts`: the grammar half is
 * needed at *parse* time and the validator half at *run* time, and keeping the
 * two together with no engine imports means the web mirror can be checked
 * against exactly this text, and the validator can be tested without standing
 * up a run. Nothing here does I/O, and nothing here throws — every failure is
 * a string, in the `line N: message` house style where a file line is known.
 */

/** Contract names live in the same charset as workflow and role names. */
export const CONTRACT_NAME = /^[a-z][a-z0-9-]*$/;
/** Field names are identifier-shaped: they are also `{{contract.<field>}}` keys. */
export const CONTRACT_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** One enum member. Hyphens are allowed so `DO-NOT-SHIP` reads naturally. */
export const CONTRACT_ENUM_VALUE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The scalar and array types a contract field may declare, in written form. */
export const CONTRACT_SCALAR_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "string[]",
  "number[]",
] as const;

export type ContractScalarType = (typeof CONTRACT_SCALAR_TYPES)[number];

/**
 * A field's type: one of the built-in kinds, or a closed set of string values
 * written `A | B | C`.
 */
export type WorkflowContractType =
  | { readonly kind: ContractScalarType }
  | { readonly kind: "enum"; readonly values: readonly string[] };

/** One declared field of a contract. */
export interface WorkflowContractField {
  readonly name: string;
  /** `true` when the field was written `name?: type` — absent is acceptable. */
  readonly optional: boolean;
  readonly type: WorkflowContractType;
}

/** A contract declared by a ```contract fence in a workflow file. */
export interface WorkflowContract {
  readonly name: string;
  /** 1-based file line of the opening fence, for error messages. */
  readonly line: number;
  readonly fields: readonly WorkflowContractField[];
}

/** The failure half of every parse in this module, in the house style. */
export interface ContractParseError {
  readonly error: string;
}

export function isContractParseError(value: object): value is ContractParseError {
  return "error" in value;
}

const SCALARS: ReadonlySet<string> = new Set(CONTRACT_SCALAR_TYPES);

const TYPE_HELP =
  'use string, number, integer, boolean, string[], number[], or an enum like "A | B"';

/**
 * Parse one written type.
 *
 * A type containing `|` is an enum and is held to the enum rules; anything
 * else must be one of the built-in kinds exactly. There is no partial credit:
 * an unrecognised word is rejected rather than treated as a free-form string,
 * because a contract whose type silently degrades validates nothing.
 */
function parseFieldType(raw: string, line: number): WorkflowContractType | ContractParseError {
  if (raw.includes("|")) {
    const values = raw.split("|").map((part) => part.trim());
    if (values.length < 2 || values.some((value) => value.length === 0)) {
      return { error: `line ${line}: unknown type "${raw}"; ${TYPE_HELP}` };
    }
    const seen = new Set<string>();
    for (const value of values) {
      if (!CONTRACT_ENUM_VALUE.test(value)) {
        return {
          error: `line ${line}: enum value "${value}" may only contain letters, digits, "_" and "-", and must start with a letter`,
        };
      }
      if (seen.has(value)) {
        return { error: `line ${line}: enum value "${value}" appears twice` };
      }
      seen.add(value);
    }
    return { kind: "enum", values };
  }
  if (!SCALARS.has(raw)) {
    return { error: `line ${line}: unknown type "${raw}"; ${TYPE_HELP}` };
  }
  return { kind: raw as ContractScalarType };
}

/**
 * Parse the body of a ```contract fence into its fields.
 *
 * One field per line, `name: type` or `name?: type`. Blank lines and `#`
 * comment lines are skipped so a contract can be annotated. Emptiness is NOT
 * decided here — the caller knows the contract's name and reports it against
 * the fence line, not against the (absent) body.
 *
 * @param lines - The lines strictly between the two fences, in order.
 * @param firstLineNumber - 1-based file line of `lines[0]`, so every message
 *   this returns is numbered against the whole file like every other parse
 *   error in the workflow grammar.
 */
export function parseContractBody(
  lines: readonly string[],
  firstLineNumber: number,
): { readonly fields: readonly WorkflowContractField[] } | ContractParseError {
  const fields: WorkflowContractField[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const line = firstLineNumber + index;
    const text = raw.trim();
    if (text.length === 0 || text.startsWith("#")) continue;

    const colon = text.indexOf(":");
    if (colon <= 0) {
      return { error: `line ${line}: expected "<field>: <type>", got "${text}"` };
    }
    let name = text.slice(0, colon).trim();
    let optional = false;
    if (name.endsWith("?")) {
      optional = true;
      name = name.slice(0, -1).trim();
    }
    if (!CONTRACT_FIELD_NAME.test(name)) {
      return {
        error: `line ${line}: contract field "${name}" may only contain letters, digits and "_", and must start with a letter`,
      };
    }
    if (seen.has(name)) {
      return { error: `line ${line}: contract field "${name}" appears twice` };
    }
    const written = text.slice(colon + 1).trim();
    if (written.length === 0) {
      return { error: `line ${line}: expected "<field>: <type>", got "${text}"` };
    }
    const type = parseFieldType(written, line);
    if (isContractParseError(type)) return type;
    seen.add(name);
    fields.push({ name, optional, type });
  }
  return { fields };
}

// ------------------------------------------------------------ reply extraction

const FENCE_OPEN = /^[ \t]*```[ \t]*json[ \t]*$/i;
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/;

/**
 * Pull the object out of the LAST fenced ```json block in a reply.
 *
 * The last block rather than the first: a model that shows its working often
 * quotes an example block before committing to its answer, and the answer is
 * always the one it wrote last. Trailing prose after the fence is tolerated
 * for the same reason — models sign off. An unterminated final fence is read
 * to the end of the reply rather than rejected, because a truncated closing
 * fence is a formatting slip, not a content failure; genuinely unparsable
 * content still fails here with the parser's own message.
 */
export function extractContractJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/);
  let body: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE_OPEN.test(lines[i] ?? "")) continue;
    const collected: string[] = [];
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (FENCE_CLOSE.test(lines[j] ?? "")) {
        end = j;
        break;
      }
      collected.push(lines[j] ?? "");
    }
    body = collected.join("\n");
    i = end;
  }
  if (body === undefined) {
    return { ok: false, error: "the reply has no fenced json block" };
  }
  if (body.trim().length === 0) {
    return { ok: false, error: "the reply's fenced json block is empty" };
  }
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `the fenced json block is not valid json: ${reason}` };
  }
}

// ---------------------------------------------------------------- validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The message half of a type mismatch, so the enum case can name its values. */
function typeMismatch(field: WorkflowContractField, value: unknown): string | undefined {
  const type = field.type;
  if (type.kind === "enum") {
    if (typeof value === "string" && type.values.includes(value)) return undefined;
    return `${field.name}: expected one of ${type.values.join(", ")}, got ${JSON.stringify(value)}`;
  }
  const ok = (() => {
    switch (type.kind) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "string[]":
        return Array.isArray(value) && value.every((item) => typeof item === "string");
      case "number[]":
        return (
          Array.isArray(value) &&
          value.every((item) => typeof item === "number" && Number.isFinite(item))
        );
    }
  })();
  return ok ? undefined : `${field.name}: expected ${type.kind}`;
}

/**
 * Check a parsed reply object against a contract.
 *
 * Contracts are EXACT: a field the contract does not declare is an error, not
 * a tolerated extra. The whole point of the construct is that the next stage
 * can read `{{contract.decision}}` and know what it is holding, and a reply
 * carrying an undeclared `verdict` alongside `decision` is a model answering a
 * different question. Every problem is collected, not just the first, because
 * the message set is handed back to the model as the retry instruction.
 */
export function validateContract(
  contract: WorkflowContract,
  value: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (!isRecord(value)) {
    return { ok: false, errors: ["expected a json object"] };
  }
  const errors: string[] = [];
  const declared = new Set<string>();
  for (const field of contract.fields) {
    declared.add(field.name);
    if (!Object.hasOwn(value, field.name) || value[field.name] === null) {
      if (!field.optional) errors.push(`missing required field ${field.name}`);
      continue;
    }
    const bad = typeMismatch(field, value[field.name]);
    if (bad !== undefined) errors.push(bad);
  }
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) errors.push(`unknown field ${key}`);
  }
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

// -------------------------------------------------------------- presentation

/** The written type, as an instruction a model can follow without guessing. */
function typeInstruction(type: WorkflowContractType): string {
  if (type.kind === "enum") return `exactly one of ${type.values.join(", ")}`;
  switch (type.kind) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "integer":
      return "a whole number";
    case "boolean":
      return "true or false";
    case "string[]":
      return "an array of strings";
    case "number[]":
      return "an array of numbers";
  }
}

/**
 * The lines the engine appends to a contract-carrying step's prompt.
 *
 * Short and literal on purpose: this text is sent to real models, and every
 * word of hedging is a word that invites a preamble the extractor then has to
 * step over. It states the shape, the fields, and the two rules the validator
 * actually enforces (no extra fields, the block goes last).
 */
export function contractPromptLines(contract: WorkflowContract): string[] {
  const lines = ["End your reply with one fenced ```json block containing exactly these fields:"];
  for (const field of contract.fields) {
    const optional = field.optional ? " (optional)" : "";
    lines.push(`- ${field.name}${optional}: ${typeInstruction(field.type)}`);
  }
  lines.push("Add no other fields, and put nothing after the closing fence.");
  return lines;
}

/** A scalar's printed form; arrays are summarised by the caller, not here. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * A one-line summary of a validated contract value, for status output.
 *
 * Scalars and enums only — an array of reasons is the body of the answer, not
 * a headline, and printing it would push the line past a terminal width. When
 * a contract is all arrays there is no headline to print, so the summary falls
 * back to naming its size.
 */
export function describeContractValue(
  contract: WorkflowContract,
  value: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const field of contract.fields) {
    if (!Object.hasOwn(value, field.name)) continue;
    const text = scalarText(value[field.name]);
    if (text === undefined) continue;
    parts.push(`${field.name}=${text}`);
  }
  if (parts.length > 0) return parts.join(" ");
  return `${contract.name}: ${contract.fields.length} field${contract.fields.length === 1 ? "" : "s"}`;
}
