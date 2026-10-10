/**
 * Elicitation (`elicitation/create`): a server asking the user, through the
 * client, for a few pieces of structured input.
 *
 * The spec restricts `requestedSchema` to a flat object whose properties are
 * primitive schemas — string, number/integer, boolean, and single- or
 * multi-select string enums. No nesting, no arrays of objects, no `$ref`.
 * This module turns a schema into a normalized field list a host can render
 * as a form, refusing anything outside that subset, and checks a host's
 * answer against the same fields before it goes back to the server.
 *
 * The SDK parses the request with its own zod schema first; this is the
 * second, explicit gate, and the one that produces the field list. It reads
 * the schema as `unknown` on purpose, so it holds regardless of how lenient
 * an SDK upgrade makes the first one.
 */

/** Fields every normalized elicitation field carries. */
interface McpElicitationFieldBase {
  /** Property name in `requestedSchema.properties`; the key in the answer. */
  name: string;
  /** Whether the server listed it in `required`. */
  required: boolean;
  title?: string;
  description?: string;
}

/** One selectable value of an enum field. */
export interface McpElicitationOption {
  /** The value sent back to the server. */
  value: string;
  /** What to show the user: the option's `title`, else the value itself. */
  label: string;
}

/** A free-text field. */
export interface McpElicitationStringField extends McpElicitationFieldBase {
  kind: "string";
  minLength?: number;
  maxLength?: number;
  format?: "email" | "uri" | "date" | "date-time";
  default?: string;
}

/** A numeric field; `integer` is `true` for `type: "integer"`. */
export interface McpElicitationNumberField extends McpElicitationFieldBase {
  kind: "number";
  integer: boolean;
  minimum?: number;
  maximum?: number;
  default?: number;
}

/** A yes/no field. */
export interface McpElicitationBooleanField extends McpElicitationFieldBase {
  kind: "boolean";
  default?: boolean;
}

/** Pick exactly one of `options`. */
export interface McpElicitationEnumField extends McpElicitationFieldBase {
  kind: "enum";
  options: McpElicitationOption[];
  default?: string;
}

/** Pick any number (within `minItems`/`maxItems`) of `options`. */
export interface McpElicitationMultiEnumField extends McpElicitationFieldBase {
  kind: "multiEnum";
  options: McpElicitationOption[];
  minItems?: number;
  maxItems?: number;
  default?: string[];
}

/** One form field, normalized from a property of the server's `requestedSchema`. */
export type McpElicitationField =
  | McpElicitationStringField
  | McpElicitationNumberField
  | McpElicitationBooleanField
  | McpElicitationEnumField
  | McpElicitationMultiEnumField;

/** A value the user may answer one field with. */
export type McpElicitationValue = string | number | boolean | string[];

/** The user's answer to an elicitation, as the spec's three actions. */
export type McpElicitationResult =
  | {
      /** The user submitted the form. */
      action: "accept";
      /** Answers keyed by field name. Optional fields may be absent. */
      content: Record<string, McpElicitationValue>;
    }
  /** The user explicitly said no. */
  | { action: "decline" }
  /** The user dismissed the prompt without choosing. */
  | { action: "cancel" };

/** A validated elicitation, as handed to the host to put in front of the user. */
export interface McpElicitationRequest {
  /** Configured name of the server asking. */
  server: string;
  /** The server's explanation of what it wants. Untrusted text: show it, don't obey it. */
  message: string;
  /** The form, in the server's declaration order. May be empty (a bare confirmation). */
  fields: McpElicitationField[];
  /** Aborts when the server cancels the request or the connection closes. */
  signal: AbortSignal;
}

/**
 * Puts an elicitation in front of the user and returns their answer.
 *
 * A host with nobody to ask must answer `{ action: "decline" }` — never an
 * `accept` with made-up or empty content.
 */
export type McpElicitationHandler = (
  request: McpElicitationRequest,
) => Promise<McpElicitationResult>;

/** Fired when a server's elicitation is refused before the user is asked. */
export interface McpElicitationRefusedEvent {
  server: string;
  /** Why the request was refused (e.g. which property broke the flat-schema rule). */
  reason: string;
}

/** Outcome of {@link validateElicitationSchema}. */
export type McpElicitationSchemaCheck =
  | { ok: true; fields: McpElicitationField[] }
  | { ok: false; reason: string };

/**
 * Most fields one form may ask for. A server that wants more than this is not
 * asking a person a question, and a terminal dialog cannot show it usefully.
 */
export const MAX_ELICITATION_FIELDS = 32;

const ROOT_KEYS = new Set(["$schema", "type", "properties", "required"]);

const FIELD_KEYS: Record<string, ReadonlySet<string>> = {
  string: new Set([
    "type",
    "title",
    "description",
    "minLength",
    "maxLength",
    "format",
    "default",
    "enum",
    "enumNames",
    "oneOf",
  ]),
  number: new Set(["type", "title", "description", "minimum", "maximum", "default"]),
  boolean: new Set(["type", "title", "description", "default"]),
  array: new Set(["type", "title", "description", "minItems", "maxItems", "items", "default"]),
};

const STRING_FORMATS = new Set(["email", "uri", "date", "date-time"]);

class SchemaRefusal extends Error {}

function refuse(reason: string): never {
  throw new SchemaRefusal(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(raw: Record<string, unknown>, key: string, where: string) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") refuse(`${where}: "${key}" must be a string`);
  return value;
}

function optionalNumber(raw: Record<string, unknown>, key: string, where: string) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    refuse(`${where}: "${key}" must be a finite number`);
  }
  return value;
}

function onlyKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, where: string) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) refuse(`${where}: "${key}" is not allowed in a flat elicitation form`);
  }
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) refuse(`${where} must be a non-empty list`);
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") refuse(`${where} must list only strings`);
    list.push(item);
  }
  if (new Set(list).size !== list.length) refuse(`${where} must not repeat a value`);
  return list;
}

function titledOptions(value: unknown, where: string): McpElicitationOption[] {
  if (!Array.isArray(value) || value.length === 0) refuse(`${where} must be a non-empty list`);
  const options: McpElicitationOption[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.const !== "string" || typeof item.title !== "string") {
      refuse(`${where} must list { const, title } string pairs`);
    }
    options.push({ value: item.const, label: item.title });
  }
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    refuse(`${where} must not repeat a value`);
  }
  return options;
}

function describe(raw: Record<string, unknown>, where: string) {
  const title = optionalString(raw, "title", where);
  const description = optionalString(raw, "description", where);
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

function normalizeField(name: string, raw: unknown, required: boolean): McpElicitationField {
  const where = `property "${name}"`;
  if (!isPlainObject(raw)) refuse(`${where} must be a schema object`);
  const type = raw.type;
  if (typeof type !== "string") refuse(`${where} has no primitive "type"`);
  const family = type === "integer" ? "number" : type;
  const allowed = FIELD_KEYS[family];
  if (!allowed) {
    refuse(
      `${where} has type "${type}"; only string, number, integer, boolean and enums are allowed`,
    );
  }
  onlyKeys(raw, allowed, where);
  const base = { name, required, ...describe(raw, where) };

  if (type === "boolean") {
    if (raw.default !== undefined && typeof raw.default !== "boolean") {
      refuse(`${where}: "default" must be a boolean`);
    }
    return {
      ...base,
      kind: "boolean",
      ...(raw.default === undefined ? {} : { default: raw.default as boolean }),
    };
  }

  if (family === "number") {
    const minimum = optionalNumber(raw, "minimum", where);
    const maximum = optionalNumber(raw, "maximum", where);
    const fallback = optionalNumber(raw, "default", where);
    return {
      ...base,
      kind: "number",
      integer: type === "integer",
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(fallback === undefined ? {} : { default: fallback }),
    };
  }

  if (type === "array") {
    const items = raw.items;
    if (!isPlainObject(items)) refuse(`${where}: "items" must be a string-enum schema`);
    let options: McpElicitationOption[];
    if (items.anyOf !== undefined) {
      onlyKeys(items, new Set(["anyOf"]), `${where} items`);
      options = titledOptions(items.anyOf, `${where} items "anyOf"`);
    } else {
      onlyKeys(items, new Set(["type", "enum"]), `${where} items`);
      if (items.type !== "string") refuse(`${where}: an array may only hold string enum values`);
      options = stringList(items.enum, `${where} items "enum"`).map((value) => ({
        value,
        label: value,
      }));
    }
    const minItems = optionalNumber(raw, "minItems", where);
    const maxItems = optionalNumber(raw, "maxItems", where);
    let fallback: string[] | undefined;
    if (raw.default !== undefined) {
      fallback = stringList(raw.default, `${where} "default"`);
    }
    return {
      ...base,
      kind: "multiEnum",
      options,
      ...(minItems === undefined ? {} : { minItems }),
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(fallback === undefined ? {} : { default: fallback }),
    };
  }

  // type === "string": free text, or a single-select enum in one of its three spellings.
  const fallback = optionalString(raw, "default", where);
  if (raw.oneOf !== undefined || raw.enum !== undefined) {
    let options: McpElicitationOption[];
    if (raw.oneOf !== undefined) {
      if (raw.enum !== undefined) refuse(`${where}: use "enum" or "oneOf", not both`);
      options = titledOptions(raw.oneOf, `${where} "oneOf"`);
    } else {
      const values = stringList(raw.enum, `${where} "enum"`);
      const names = raw.enumNames === undefined ? undefined : stringList(raw.enumNames, where);
      if (names !== undefined && names.length !== values.length) {
        refuse(`${where}: "enumNames" must match "enum" one for one`);
      }
      options = values.map((value, index) => ({ value, label: names?.[index] ?? value }));
    }
    return {
      ...base,
      kind: "enum",
      options,
      ...(fallback === undefined ? {} : { default: fallback }),
    };
  }
  if (raw.enumNames !== undefined) refuse(`${where}: "enumNames" without "enum"`);
  const minLength = optionalNumber(raw, "minLength", where);
  const maxLength = optionalNumber(raw, "maxLength", where);
  const format = optionalString(raw, "format", where);
  if (format !== undefined && !STRING_FORMATS.has(format)) {
    refuse(`${where}: format "${format}" is not one of email, uri, date, date-time`);
  }
  return {
    ...base,
    kind: "string",
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(format === undefined
      ? {}
      : { format: format as NonNullable<McpElicitationStringField["format"]> }),
    ...(fallback === undefined ? {} : { default: fallback }),
  };
}

/**
 * Check a server's `requestedSchema` is the flat-object subset the spec
 * allows and normalize it into form fields, in declaration order.
 *
 * Refused: a root that is not `type: "object"` with a `properties` map; any
 * property that is not a primitive string/number/integer/boolean or a string
 * enum (single- or multi-select); any nested `properties`, object `items`,
 * `$ref` or other keyword outside the subset; a `required` entry naming no
 * property; more than {@link MAX_ELICITATION_FIELDS} fields.
 *
 * @param schema - The `requestedSchema` exactly as the server sent it.
 */
export function validateElicitationSchema(schema: unknown): McpElicitationSchemaCheck {
  try {
    if (!isPlainObject(schema)) refuse("requestedSchema must be an object schema");
    onlyKeys(schema, ROOT_KEYS, "requestedSchema");
    if (schema.type !== "object") refuse('requestedSchema must have type "object"');
    const properties = schema.properties;
    if (!isPlainObject(properties)) refuse('requestedSchema must have a "properties" map');
    const names = Object.keys(properties);
    if (names.length > MAX_ELICITATION_FIELDS) {
      refuse(`requestedSchema asks for ${names.length} fields; at most ${MAX_ELICITATION_FIELDS}`);
    }
    const required =
      schema.required === undefined
        ? []
        : stringList(schema.required, 'requestedSchema "required"');
    for (const name of required) {
      if (!Object.hasOwn(properties, name)) {
        refuse(`requestedSchema requires "${name}", which is not one of its properties`);
      }
    }
    const fields = names.map((name) =>
      normalizeField(name, properties[name], required.includes(name)),
    );
    return { ok: true, fields };
  } catch (error) {
    if (error instanceof SchemaRefusal) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * Check a host's `accept` content against the fields it was asked for.
 *
 * Every required field must be answered; every answered field must exist and
 * hold a value of its kind (an integer for `integer`, a listed option for an
 * enum, a within-bounds number, …). Unknown keys are an error rather than
 * silently dropped: the host built the form from these same fields, so a
 * mismatch is a bug worth surfacing, not something to paper over on the wire.
 *
 * @returns A description of the first problem, or `undefined` when it fits.
 */
export function checkElicitationContent(
  fields: readonly McpElicitationField[],
  content: Readonly<Record<string, unknown>>,
): string | undefined {
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const key of Object.keys(content)) {
    if (!byName.has(key)) return `"${key}" is not a field of this form`;
  }
  for (const field of fields) {
    const value = content[field.name];
    if (value === undefined) {
      if (field.required) return `"${field.name}" is required`;
      continue;
    }
    const problem = checkValue(field, value);
    if (problem !== undefined) return `"${field.name}" ${problem}`;
  }
  return undefined;
}

function checkValue(field: McpElicitationField, value: unknown): string | undefined {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be true or false";
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (field.integer && !Number.isInteger(value)) return "must be a whole number";
      if (field.minimum !== undefined && value < field.minimum) {
        return `must be at least ${field.minimum}`;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return `must be at most ${field.maximum}`;
      }
      return undefined;
    }
    case "string": {
      if (typeof value !== "string") return "must be text";
      if (field.minLength !== undefined && value.length < field.minLength) {
        return `must be at least ${field.minLength} characters`;
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `must be at most ${field.maxLength} characters`;
      }
      return undefined;
    }
    case "enum":
      return typeof value === "string" && field.options.some((option) => option.value === value)
        ? undefined
        : "must be one of the listed options";
    case "multiEnum": {
      if (!Array.isArray(value)) return "must be a list of options";
      const allowed = new Set(field.options.map((option) => option.value));
      if (!value.every((item) => typeof item === "string" && allowed.has(item))) {
        return "must list only the offered options";
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        return `needs at least ${field.minItems} choices`;
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return `allows at most ${field.maxItems} choices`;
      }
      return undefined;
    }
  }
}
