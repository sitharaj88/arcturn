/**
 * A tiny, dependency-free JSON Schema validator covering the subset of
 * draft 2020-12 that tool `parameters` realistically use:
 * `type`, `required`, `properties`, `additionalProperties`, `items`,
 * `enum`, `const`, numeric/string/array bounds and `anyOf` / `oneOf` / `allOf`.
 *
 * It is intentionally lenient: unknown keywords are ignored rather than
 * rejected, so tools written against a fuller dialect still work.
 */

import type { JsonSchema } from "@arcturn/types";

/** A single validation failure. */
export interface SchemaError {
  /** JSON-pointer-ish path of the offending value, e.g. `"/todos/0/status"`. */
  path: string;
  /** Human-readable explanation. */
  message: string;
}

/** Outcome of {@link validateSchema}. */
export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaError[];
}

type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    default:
      return "object";
  }
}

function matchesType(value: unknown, expected: JsonType): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "object") return isPlainObject(value);
  return actual === expected;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

function describe(value: unknown): string {
  const kind = typeOf(value);
  if (kind === "string") return `string ${JSON.stringify(value)}`;
  if (kind === "object" || kind === "array") return kind;
  return `${kind} ${String(value)}`;
}

function asSchema(value: unknown): JsonSchema | undefined {
  return isPlainObject(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function validateNode(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: SchemaError[],
): void {
  // type
  const rawType = schema.type;
  const expectedTypes: JsonType[] =
    typeof rawType === "string"
      ? [rawType as JsonType]
      : Array.isArray(rawType)
        ? (rawType.filter((item) => typeof item === "string") as JsonType[])
        : [];
  if (expectedTypes.length > 0 && !expectedTypes.some((t) => matchesType(value, t))) {
    errors.push({
      path,
      message: `expected ${expectedTypes.join(" | ")} but received ${describe(value)}`,
    });
    return;
  }

  // const / enum
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum)) {
    const options = schema.enum;
    if (!options.some((option) => deepEqual(option, value))) {
      errors.push({
        path,
        message: `must be one of ${options.map((o) => JSON.stringify(o)).join(", ")}`,
      });
    }
  }

  if (typeof value === "string") validateString(schema, value, path, errors);
  if (typeof value === "number") validateNumber(schema, value, path, errors);
  if (Array.isArray(value)) validateArray(schema, value, path, errors);
  if (isPlainObject(value)) validateObject(schema, value, path, errors);

  validateCombinators(schema, value, path, errors);
}

function validateString(
  schema: JsonSchema,
  value: string,
  path: string,
  errors: SchemaError[],
): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push({ path, message: `must be at least ${schema.minLength} characters` });
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }
  if (typeof schema.pattern === "string") {
    let regex: RegExp | undefined;
    try {
      regex = new RegExp(schema.pattern);
    } catch {
      regex = undefined;
    }
    if (regex && !regex.test(value)) {
      errors.push({ path, message: `must match pattern ${schema.pattern}` });
    }
  }
}

function validateNumber(
  schema: JsonSchema,
  value: number,
  path: string,
  errors: SchemaError[],
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push({ path, message: `must be >= ${schema.minimum}` });
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    errors.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    errors.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
  }
}

function validateArray(
  schema: JsonSchema,
  value: unknown[],
  path: string,
  errors: SchemaError[],
): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push({ path, message: `must contain at least ${schema.minItems} items` });
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push({ path, message: `must contain at most ${schema.maxItems} items` });
  }
  const items = asSchema(schema.items);
  if (items) {
    for (const [index, item] of value.entries()) {
      validateNode(items, item, `${path}/${index}`, errors);
    }
  }
}

function validateObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  errors: SchemaError[],
): void {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const key of asStringArray(schema.required)) {
    if (!(key in value) || value[key] === undefined) {
      errors.push({ path: `${path}/${key}`, message: `is required` });
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const propertySchema = asSchema(properties[key]);
    if (propertySchema) {
      validateNode(propertySchema, child, `${path}/${key}`, errors);
      continue;
    }
    if (schema.additionalProperties === false) {
      errors.push({ path: `${path}/${key}`, message: "is not an allowed property" });
      continue;
    }
    const additional = asSchema(schema.additionalProperties);
    if (additional) validateNode(additional, child, `${path}/${key}`, errors);
  }
}

function validateCombinators(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: SchemaError[],
): void {
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  for (const branch of allOf) {
    const sub = asSchema(branch);
    if (sub) validateNode(sub, value, path, errors);
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (anyOf && anyOf.length > 0) {
    const passes = anyOf.some((branch) => {
      const sub = asSchema(branch);
      if (!sub) return true;
      const local: SchemaError[] = [];
      validateNode(sub, value, path, local);
      return local.length === 0;
    });
    if (!passes) errors.push({ path, message: "does not match any allowed schema" });
  }

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (oneOf && oneOf.length > 0) {
    let matched = 0;
    for (const branch of oneOf) {
      const sub = asSchema(branch);
      if (!sub) {
        matched++;
        continue;
      }
      const local: SchemaError[] = [];
      validateNode(sub, value, path, local);
      if (local.length === 0) matched++;
    }
    if (matched !== 1) {
      errors.push({ path, message: `must match exactly one allowed schema (matched ${matched})` });
    }
  }
}

/**
 * Validate a value against a JSON schema subset.
 *
 * @param schema - The schema to validate against.
 * @param value - The value under test.
 * @returns Validity plus every collected error.
 */
export function validateSchema(schema: JsonSchema, value: unknown): SchemaValidationResult {
  const errors: SchemaError[] = [];
  validateNode(schema, value, "", errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate tool call arguments against a tool's `parameters` schema.
 *
 * Object schemas are the norm, so a non-object argument bag is reported as a
 * top-level type error rather than silently passing.
 *
 * @param schema - The tool's `parameters` schema.
 * @param input - Arguments produced by the model.
 */
export function validateToolInput(
  schema: JsonSchema,
  input: Record<string, unknown>,
): SchemaValidationResult {
  return validateSchema(schema, input);
}

/**
 * Render validation errors as a single line suitable for feeding back to a model.
 *
 * @param errors - Errors from {@link validateSchema}.
 */
export function formatSchemaErrors(errors: readonly SchemaError[]): string {
  return errors.map((e) => `${e.path === "" ? "(root)" : e.path} ${e.message}`).join("; ");
}
