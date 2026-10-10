/**
 * The strict schema grammar: which JSON Schemas a provider will hold a tool
 * input (`strict: true`) or a reply (`output_config.format`) to, and how many
 * fit in one request. Pure, and free of provider imports so every adapter can
 * use it.
 */

import type { JsonSchema } from "@arcturn/types";

/**
 * The per-request ceilings Anthropic applies to strict schemas (`strict: true`
 * tools plus an `output_config.format` schema, combined). A request over any
 * of them is a 400, so an adapter stops marking tools strict before it gets
 * there rather than sending one it knows will be refused.
 *
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
export const ANTHROPIC_STRICT_LIMITS = {
  /** `strict: true` tools per request. */
  strictTools: 20,
  /** Optional properties across every strict schema in the request. */
  optionalParameters: 24,
  /** Properties typed as a union (`anyOf`, or a `type` array) across them. */
  unionParameters: 16,
} as const;

// ---------------------------------------------------------------- strict grammar

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keywords the strict grammar accepts. Anything else — `minimum`,
 * `maxLength`, `oneOf`, `pattern`, `uniqueItems`, `not` — is either refused by
 * the API or not reliably compiled, so a schema carrying one is not strict.
 * `pattern` is deliberately out: the API takes a regex subset and answers a
 * pattern outside it with a 400.
 */
const STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "description",
  "title",
  "default",
  "examples",
  "format",
  "minItems",
]);

const STRICT_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** One schema node against the Anthropic strict grammar. */
function strictNode(node: unknown, requireAllProperties: boolean): boolean {
  if (!isRecord(node)) return false;
  for (const key of Object.keys(node)) if (!STRICT_KEYWORDS.has(key)) return false;
  if (node.format !== undefined && !STRICT_FORMATS.has(String(node.format))) return false;
  if (node.minItems !== undefined && node.minItems !== 0 && node.minItems !== 1) return false;
  if (Array.isArray(node.enum) && node.enum.some((value) => typeof value === "object")) {
    return false;
  }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const isObject = types.includes("object") || node.properties !== undefined;
  if (isObject) {
    if (node.additionalProperties !== false) return false;
    const properties = node.properties ?? {};
    if (!isRecord(properties)) return false;
    const required = Array.isArray(node.required) ? node.required : [];
    for (const [name, child] of Object.entries(properties)) {
      if (requireAllProperties && !required.includes(name)) return false;
      if (!strictNode(child, requireAllProperties)) return false;
    }
  } else if (node.additionalProperties !== undefined) {
    return false;
  }
  if (node.items !== undefined && !strictNode(node.items, requireAllProperties)) return false;
  for (const key of ["anyOf", "allOf"] as const) {
    const branches = node[key];
    if (branches === undefined) continue;
    if (!Array.isArray(branches)) return false;
    if (!branches.every((branch) => strictNode(branch, requireAllProperties))) return false;
  }
  return true;
}

/**
 * Whether a tool's `parameters` (or a response schema) satisfies Anthropic's
 * strict grammar: an object at the top with `additionalProperties: false` on
 * every object, only the supported keywords, string formats from the
 * supported list, `minItems` of 0 or 1, no `oneOf` or numeric/length bounds.
 * Optional properties are fine.
 */
export function isStrictSchema(schema: JsonSchema): boolean {
  if (schema.type !== "object") return false;
  if (schema.anyOf !== undefined || schema.allOf !== undefined) return false;
  return strictNode(schema, false);
}

/**
 * {@link isStrictSchema}, plus OpenAI's own rule: every property of every
 * object is listed in `required` (an optional one is spelled nullable). A
 * schema that misses it is sent without `strict` rather than refused.
 */
export function isOpenAIStrictSchema(schema: JsonSchema): boolean {
  if (schema.type !== "object") return false;
  if (schema.anyOf !== undefined || schema.allOf !== undefined) return false;
  return strictNode(schema, true);
}

/** Optional and union-typed properties a strict schema spends, recursively. */
export interface StrictSchemaCost {
  optional: number;
  unions: number;
}

/** What one schema costs against {@link ANTHROPIC_STRICT_LIMITS}. */
export function strictSchemaCost(schema: unknown): StrictSchemaCost {
  const cost: StrictSchemaCost = { optional: 0, unions: 0 };
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (isRecord(node.properties)) {
      const required = Array.isArray(node.required) ? node.required : [];
      for (const [name, child] of Object.entries(node.properties)) {
        if (!required.includes(name)) cost.optional += 1;
        if (isRecord(child) && (child.anyOf !== undefined || Array.isArray(child.type))) {
          cost.unions += 1;
        }
        walk(child);
      }
    }
    walk(node.items);
    for (const key of ["anyOf", "allOf"] as const) {
      const branches = node[key];
      if (Array.isArray(branches)) for (const branch of branches) walk(branch);
    }
  };
  walk(schema);
  return cost;
}

/**
 * A running tally of one request's strict budget: `admit` answers whether one
 * more strict schema still fits, and spends it when it does.
 */
export function createStrictBudget(): { admit(schema: unknown, isTool: boolean): boolean } {
  let tools = 0;
  let optional = 0;
  let unions = 0;
  return {
    admit(schema, isTool) {
      const cost = strictSchemaCost(schema);
      if (isTool && tools + 1 > ANTHROPIC_STRICT_LIMITS.strictTools) return false;
      if (optional + cost.optional > ANTHROPIC_STRICT_LIMITS.optionalParameters) return false;
      if (unions + cost.unions > ANTHROPIC_STRICT_LIMITS.unionParameters) return false;
      if (isTool) tools += 1;
      optional += cost.optional;
      unions += cost.unions;
      return true;
    },
  };
}

/**
 * A copy of `schema` with every `additionalProperties` removed — for Gemini,
 * whose response-schema dialect does not take the keyword. The contract
 * validator still rejects an undeclared field on the way back, so nothing the
 * schema promised is lost, only where it is enforced.
 */
export function withoutAdditionalProperties(schema: JsonSchema): JsonSchema {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "additionalProperties") continue;
      out[key] =
        key === "properties" && isRecord(value)
          ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, strip(child)]))
          : strip(value);
    }
    return out;
  };
  return strip(schema) as JsonSchema;
}
