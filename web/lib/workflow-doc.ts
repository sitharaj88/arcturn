/**
 * The workflow-file grammar, as an editable document model.
 *
 * `packages/cli/src/workflow.ts` is the single source of truth for what a
 * workflow file means; this module mirrors its `parseWorkflow` line for line —
 * same regexes, same strictness, same error strings — but keeps what that
 * parser throws away (the preamble prose, the raw frontmatter values) so the
 * builder page can round-trip a file instead of merely validating it.
 *
 * Two deliberate differences from the engine's parser:
 *
 * - It returns a *document* (frontmatter as raw strings, preamble verbatim,
 *   stages as editable steps) rather than an executable `Workflow`, because an
 *   editor needs to show what the file says, not what the engine resolved.
 * - It collects non-fatal `warnings` (an unknown frontmatter key the engine
 *   would silently drop, a name the engine would silently normalise) — the
 *   engine stays silent about both, and an editor should not.
 *
 * No imports and no React: `web/scripts/workflow-doc.test.ts` loads this
 * module from the monorepo vitest suite, which resolves neither `@/` paths
 * nor JSX — the same constraint `lib/kits.ts` documents.
 */

// Regexes copied verbatim from packages/cli/src/workflow.ts — the grammar.
const NAME_STRIP = /[^a-z0-9-]/g;
const NUMBERED_LINE = /^(\d+)[.)](?:[ \t]+(.*))?$/;
const BULLET_LINE = /^([ \t]+)([-*+])(?:[ \t]+(.*))?$/;
const TOP_LEVEL_BULLET = /^[-*+][ \t]/;
const MODEL_TAG = /^\[([^\]]*)\][ \t]*(.*)$/;
const VALID_TAG = /^[A-Za-z0-9._/:-]+$/;
const ROLE_TAG = /^@(\S*)(?:[ \t]+(.*))?$/;
const VALID_ROLE = /^[a-z0-9][a-z0-9-]*$/;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const OPTION_KEYS: ReadonlySet<string> = new Set(["contract", "judges", "race"]);
const CONTRACT_FENCE = /^```contract(?:[ \t]+(.*))?$/;
const CONTRACT_FENCE_CLOSE = /^```[ \t]*$/;
const CONTRACT_PLACEHOLDER_PREFIX = "contract.";
// Copied verbatim from packages/cli/src/contracts.ts — the contract grammar.
const CONTRACT_NAME = /^[a-z][a-z0-9-]*$/;
const CONTRACT_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const CONTRACT_ENUM_VALUE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CONTRACT_SCALAR_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "string[]",
  "number[]",
] as const;
const SCALARS: ReadonlySet<string> = new Set(CONTRACT_SCALAR_TYPES);
const TYPE_HELP =
  'use string, number, integer, boolean, string[], number[], or an enum like "A | B"';

/** The frontmatter keys the engine recognises, in canonical serialisation order. */
export const FRONTMATTER_KEYS = [
  "name",
  "description",
  "continueOnError",
  "stepTimeoutMs",
  "maxStepRetries",
  "budgetUsd",
  "budgetTokens",
] as const;

export type FrontmatterKey = (typeof FRONTMATTER_KEYS)[number];

/**
 * Raw frontmatter values, exactly as the file carries them (quotes already
 * stripped). Raw strings, not parsed numbers, so an editor shows what was
 * written and validation messages can quote it back.
 */
export type DocFrontmatter = Partial<Record<FrontmatterKey, string>>;

/** One step: the `[tag] @role prompt` triple, prefixes optional. */
export interface DocStep {
  modelTag?: string;
  role?: string;
  /** The `[contract:<name>]` option — the reply shape this step must produce. */
  contract?: string;
  /** The `[judges:N]` option: 2 or 3. */
  judges?: number;
  /** The `[race:a|b]` option: the model tags, in written order. */
  race?: string[];
  prompt: string;
}

export type DocContractType =
  | { kind: (typeof CONTRACT_SCALAR_TYPES)[number] }
  | { kind: "enum"; values: string[] };

export interface DocContractField {
  name: string;
  optional: boolean;
  type: DocContractType;
}

/** One ```contract block, as the file declared it. */
export interface DocContract {
  name: string;
  fields: DocContractField[];
}

/**
 * One numbered stage. `parallel: false` means exactly one step on the `N.`
 * line itself; `parallel: true` means the steps are `-` branches and `label`
 * (kept with its trailing `:`, as the engine stores it) is the optional
 * heading on the parent line.
 */
export interface DocStage {
  parallel: boolean;
  label?: string;
  steps: DocStep[];
}

/** A workflow file as an editable document. Stage numbers are positional. */
export interface WorkflowDoc {
  frontmatter: DocFrontmatter;
  /** Prose between the frontmatter and the first numbered line, verbatim. */
  preamble: string;
  stages: DocStage[];
  /**
   * The file's ```contract declarations, in written order. Optional so a
   * hand-built document (the builder island's `toDoc`) stays valid without
   * one, and so that a file declaring no contract parses deep-equal to the
   * document an editor would have produced for it.
   */
  contracts?: DocContract[];
}

export interface WorkflowDocError {
  error: string;
}

export function isWorkflowDocError(value: unknown): value is WorkflowDocError {
  return typeof value === "object" && value !== null && "error" in value;
}

export interface ParsedWorkflowDoc {
  doc: WorkflowDoc;
  /** Non-fatal notes the engine would swallow silently. */
  warnings: string[];
}

/** A problem `validateWorkflowDoc` found, addressed to a place in the editor. */
export interface DocIssue {
  severity: "error" | "warning";
  location: string;
  message: string;
}

// ------------------------------------------------------------------- helpers

/** `parseWorkflow`'s name normalisation, verbatim. */
export function normalizeWorkflowName(raw: string): string {
  return raw.toLowerCase().replace(NAME_STRIP, "");
}

/**
 * The warning an editor should show where the engine silently normalises:
 * what the user typed is not the name the registry will use.
 */
export function nameNormalizationWarning(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = normalizeWorkflowName(trimmed);
  if (normalized === trimmed) return undefined;
  if (normalized.length === 0) {
    return `name "${trimmed}" normalises to nothing; use lowercase letters, digits and "-"`;
  }
  return `name "${trimmed}" will be installed as "${normalized}"`;
}

/**
 * Validate one frontmatter value with the engine's own rule and error text
 * (no line prefix — the caller adds one when it knows the line).
 */
export function frontmatterValueError(key: FrontmatterKey, value: string): string | undefined {
  if (key === "name" || key === "description") return undefined;
  if (key === "continueOnError") {
    const flag = value.trim().toLowerCase();
    if (flag !== "true" && flag !== "false") {
      return `continueOnError must be "true" or "false", got "${value}"`;
    }
    return undefined;
  }
  const parsed = Number(value.trim());
  if (key === "stepTimeoutMs") {
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      return `stepTimeoutMs must be a positive whole number of milliseconds, got "${value}"`;
    }
    return undefined;
  }
  if (key === "maxStepRetries") {
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return `maxStepRetries must be a non-negative whole number, got "${value}"`;
    }
    return undefined;
  }
  if (key === "budgetUsd") {
    if (!Number.isFinite(parsed) || parsed < 0) {
      return `budgetUsd must be a non-negative number of US dollars, got "${value}"`;
    }
    return undefined;
  }
  // budgetTokens
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return `budgetTokens must be a non-negative whole number of tokens, got "${value}"`;
  }
  return undefined;
}

/** The engine's model-tag rule, as a message or nothing. Empty means "no tag". */
export function modelTagError(tag: string): string | undefined {
  const trimmed = tag.trim();
  if (trimmed.length === 0) return undefined;
  if (!VALID_TAG.test(trimmed)) {
    return `model tag "${trimmed}" may only contain letters, digits, ".", "_", "/", ":" and "-"`;
  }
  return undefined;
}

/** The engine's role rule, as a message or nothing. Empty means "no role". */
export function roleError(role: string): string | undefined {
  const trimmed = role.trim();
  if (trimmed.length === 0) return undefined;
  if (!VALID_ROLE.test(trimmed.toLowerCase())) {
    return `role name "${trimmed}" may only contain letters, digits and "-", and must start with a letter or digit`;
  }
  return undefined;
}

/**
 * What `{{contract}}` needs to know about its surroundings: the stage before
 * this one, and the file's declarations. Omitted by callers that only want the
 * shape rules (the builder's per-field notes), which then skip the checks that
 * depend on a neighbour.
 */
export interface PlaceholderContext {
  prev?: DocStage;
  contracts?: DocContract[];
}

/**
 * The engine's placeholder rule for one prompt in one stage (1-based).
 * `{{prev}}` and `{{journal}}` have no value in stage 1, and neither does
 * `{{contract}}`, which additionally needs the previous stage to have carried
 * one.
 */
export function placeholderError(
  prompt: string,
  stageIndex: number,
  context?: PlaceholderContext,
): string | undefined {
  PLACEHOLDER.lastIndex = 0;
  for (const match of prompt.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? "").trim();
    const isContract = name === "contract" || name.startsWith(CONTRACT_PLACEHOLDER_PREFIX);
    const field = name.startsWith(CONTRACT_PLACEHOLDER_PREFIX)
      ? name.slice(CONTRACT_PLACEHOLDER_PREFIX.length)
      : undefined;
    if (
      (name !== "prev" && name !== "input" && name !== "journal" && !isContract) ||
      (field !== undefined && !CONTRACT_FIELD_NAME.test(field))
    ) {
      return `unknown placeholder "${match[0]}"; only {{prev}}, {{input}}, {{journal}}, {{contract}} and {{contract.<field>}} exist`;
    }
    if ((name === "prev" || name === "journal" || isContract) && stageIndex === 1) {
      return `{{${name}}} has no value in the first step`;
    }
    if (!isContract || context === undefined) continue;

    const prev = context.prev;
    const carriers = (prev?.steps ?? []).filter((step) => step.contract !== undefined);
    if (carriers.length === 0) {
      return `{{${name}}} needs a step with a contract in stage ${stageIndex - 1}`;
    }
    if (field === undefined) continue;
    if (prev?.parallel === true) {
      return `{{${name}}} needs a single-step stage; stage ${stageIndex - 1} runs in parallel`;
    }
    const carrier = carriers[0]?.contract ?? "";
    const declared = (context.contracts ?? []).find((entry) => entry.name === carrier);
    if (!declared?.fields.some((entry) => entry.name === field)) {
      return `{{${name}}} names no field of contract "${carrier}"`;
    }
  }
  return undefined;
}

// -------------------------------------------------------- contract declarations

/** Mirror of `contracts.ts`'s `parseFieldType`, error strings included. */
function parseFieldType(raw: string, line: number): DocContractType | WorkflowDocError {
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
      if (seen.has(value)) return { error: `line ${line}: enum value "${value}" appears twice` };
      seen.add(value);
    }
    return { kind: "enum", values };
  }
  if (!SCALARS.has(raw)) return { error: `line ${line}: unknown type "${raw}"; ${TYPE_HELP}` };
  return { kind: raw as (typeof CONTRACT_SCALAR_TYPES)[number] };
}

/** Mirror of `contracts.ts`'s `parseContractBody`, error strings included. */
export function parseContractBody(
  lines: readonly string[],
  firstLineNumber: number,
): { fields: DocContractField[] } | WorkflowDocError {
  const fields: DocContractField[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const line = firstLineNumber + index;
    const text = raw.trim();
    if (text.length === 0 || text.startsWith("#")) continue;

    const colon = text.indexOf(":");
    if (colon <= 0) return { error: `line ${line}: expected "<field>: <type>", got "${text}"` };
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
    if (seen.has(name)) return { error: `line ${line}: contract field "${name}" appears twice` };
    const written = text.slice(colon + 1).trim();
    if (written.length === 0) {
      return { error: `line ${line}: expected "<field>: <type>", got "${text}"` };
    }
    const type = parseFieldType(written, line);
    if (isWorkflowDocError(type)) return type;
    seen.add(name);
    fields.push({ name, optional, type });
  }
  return { fields };
}

/** A field's written form, for round-tripping a declaration back to markdown. */
export function contractFieldLine(field: DocContractField): string {
  const type = field.type.kind === "enum" ? field.type.values.join(" | ") : field.type.kind;
  return `${field.name}${field.optional ? "?" : ""}: ${type}`;
}

// ------------------------------------------------------------------- parsing

interface RawFrontmatter {
  values: DocFrontmatter;
  body: string;
  /** Lines consumed by the fence, so body errors carry 1-based file lines. */
  offset: number;
  keyLines: Map<FrontmatterKey, number>;
  warnings: string[];
}

const KEY_SET: ReadonlySet<string> = new Set(FRONTMATTER_KEYS);

/**
 * Mirror of the engine's `parseFrontmatter`: line 1 must be `---` trimmed,
 * scan to the next trimmed `---`, an unterminated fence means no frontmatter,
 * split each line on the FIRST `:`, trim both halves, strip one matched pair
 * of quotes. The engine drops unknown keys silently; here they become
 * warnings, because an editor that eats a line should say so.
 */
function parseRawFrontmatter(raw: string): RawFrontmatter {
  const lines = raw.split(/\r?\n/);
  const none: RawFrontmatter = {
    values: {},
    body: raw,
    offset: 0,
    keyLines: new Map(),
    warnings: [],
  };
  if ((lines[0] ?? "").trim() !== "---") return none;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return none;

  const values: DocFrontmatter = {};
  const keyLines = new Map<FrontmatterKey, number>();
  const warnings: string[] = [];
  for (const [i, line] of lines.slice(1, end).entries()) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!KEY_SET.has(key)) {
      warnings.push(`line ${i + 2}: frontmatter key "${key}" is not recognised and was dropped`);
      continue;
    }
    const known = key as FrontmatterKey;
    values[known] = value;
    // Line 1 is the opening fence, so slice index 0 is file line 2.
    keyLines.set(known, i + 2);
  }
  return { values, body: lines.slice(end + 1).join("\n"), offset: end + 1, keyLines, warnings };
}

interface ParsedStepLine {
  modelTag?: string;
  role?: string;
  contract?: string;
  judges?: number;
  race?: string[];
  prompt: string;
}

type BracketGroup = { kind: "tag"; tag: string } | { kind: "option"; key: string; value: string };

/** Mirror of the engine's `classifyBracket`. */
function classifyBracket(group: string): BracketGroup {
  const colon = group.indexOf(":");
  if (colon > 0) {
    const key = group.slice(0, colon).trim();
    if (OPTION_KEYS.has(key)) {
      return { kind: "option", key, value: group.slice(colon + 1).trim() };
    }
  }
  return { kind: "tag", tag: group };
}

type OptionValue =
  | { kind: "contract"; value: string }
  | { kind: "judges"; value: number }
  | { kind: "race"; value: string[] };

/** Mirror of the engine's `readOption`, error strings included. */
function readOption(
  key: string,
  value: string,
  line: number,
  accept: (parsed: OptionValue) => void,
): WorkflowDocError | undefined {
  if (key === "contract") {
    if (!CONTRACT_NAME.test(value)) {
      return {
        error: `line ${line}: contract name "${value}" may only contain lowercase letters, digits and "-", and must start with a letter`,
      };
    }
    accept({ kind: "contract", value });
    return undefined;
  }
  if (key === "judges") {
    if (value !== "2" && value !== "3") {
      return { error: `line ${line}: judges must be 2 or 3, got "${value}"` };
    }
    accept({ kind: "judges", value: Number(value) });
    return undefined;
  }
  const tags = value.split("|").map((tag) => tag.trim());
  if (tags.length < 2 || tags.length > 3) {
    return {
      error: `line ${line}: race must list 2 or 3 model tags separated by "|", got "${value}"`,
    };
  }
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag.length === 0 || !VALID_TAG.test(tag)) {
      return {
        error: `line ${line}: race model tag "${tag}" may only contain letters, digits, ".", "_", "/", ":" and "-"`,
      };
    }
    if (seen.has(tag)) return { error: `line ${line}: race lists model tag "${tag}" twice` };
    seen.add(tag);
  }
  accept({ kind: "race", value: tags });
  return undefined;
}

/** Mirror of the engine's `parseStepLine`, error strings included. */
function parseStepLine(text: string, line: number): ParsedStepLine | WorkflowDocError {
  let rest = text;
  let modelTag: string | undefined;
  let contract: string | undefined;
  let judges: number | undefined;
  let race: string[] | undefined;
  const seenOptions = new Set<string>();

  for (;;) {
    const bracket = MODEL_TAG.exec(rest);
    if (!bracket) break;
    const group = (bracket[1] ?? "").trim();
    if (group.length === 0) {
      return {
        error: `line ${line}: model tag is empty; write "[tier:cheap] prompt…" or drop the brackets`,
      };
    }
    const classified = classifyBracket(group);
    if (classified.kind === "tag") {
      // A second model tag ends the prefix and stays in the prompt, exactly as
      // the one-tag grammar left it. See the engine's note.
      if (modelTag !== undefined) break;
      if (!VALID_TAG.test(classified.tag)) {
        return {
          error: `line ${line}: model tag "${classified.tag}" may only contain letters, digits, ".", "_", "/", ":" and "-"`,
        };
      }
      modelTag = classified.tag;
    } else {
      if (seenOptions.has(classified.key)) {
        return { error: `line ${line}: option "${classified.key}" appears twice` };
      }
      seenOptions.add(classified.key);
      const bad = readOption(classified.key, classified.value, line, (parsed) => {
        if (parsed.kind === "contract") contract = parsed.value;
        else if (parsed.kind === "judges") judges = parsed.value;
        else race = parsed.value;
      });
      if (bad) return bad;
    }
    rest = (bracket[2] ?? "").trim();
    if (rest.length === 0) {
      return {
        error:
          seenOptions.size === 0
            ? `line ${line}: step has a model tag but no prompt`
            : `line ${line}: step has bracket options but no prompt`,
      };
    }
  }

  if (race !== undefined && modelTag !== undefined) {
    return { error: `line ${line}: race replaces the model tag` };
  }
  if (race !== undefined && judges !== undefined) {
    return { error: `line ${line}: judges and race cannot be combined` };
  }

  const roled = ROLE_TAG.exec(rest);
  let role: string | undefined;
  let prompt: string;
  if (roled) {
    const raw = (roled[1] ?? "").trim();
    if (raw.length === 0) {
      return {
        error: `line ${line}: role name is empty; write "@architect prompt…" or drop the "@"`,
      };
    }
    role = raw.toLowerCase();
    if (!VALID_ROLE.test(role)) {
      return {
        error: `line ${line}: role name "${raw}" may only contain letters, digits and "-", and must start with a letter or digit`,
      };
    }
    prompt = (roled[2] ?? "").trim();
    if (prompt.length === 0) {
      return { error: `line ${line}: step names role "@${role}" but has no prompt` };
    }
    const stray = MODEL_TAG.exec(prompt);
    const strayGroup = (stray?.[1] ?? "").trim();
    if (strayGroup.length > 0 && classifyBracket(strayGroup).kind === "option") {
      return {
        error: `line ${line}: an option must come before the role — write "[${strayGroup}] @${role} prompt…"`,
      };
    }
    if (modelTag === undefined && race === undefined) {
      if (strayGroup.length > 0 && VALID_TAG.test(strayGroup)) {
        return {
          error: `line ${line}: a model tag must come before the role — write "[${strayGroup}] @${role} prompt…"; if "[${strayGroup}]" is part of the prompt, move it later in the line`,
        };
      }
    }
  } else {
    if (rest.length === 0) {
      return { error: `line ${line}: step has an empty prompt` };
    }
    prompt = rest;
  }

  if (judges !== undefined) {
    if (role === undefined) return { error: `line ${line}: judges requires a role` };
    if (contract === undefined) return { error: `line ${line}: judges requires a contract` };
  }

  return {
    ...(modelTag === undefined ? {} : { modelTag }),
    ...(role === undefined ? {} : { role }),
    ...(contract === undefined ? {} : { contract }),
    ...(judges === undefined ? {} : { judges }),
    ...(race === undefined ? {} : { race }),
    prompt,
  };
}

/** Placeholder validation with the engine's line-prefixed error text. */
function placeholderLineError(
  prompt: string,
  stageIndex: number,
  line: number,
  context?: PlaceholderContext,
): WorkflowDocError | undefined {
  const message = placeholderError(prompt, stageIndex, context);
  return message === undefined ? undefined : { error: `line ${line}: ${message}` };
}

/** Mirror of the engine's `readContractBlock`, error strings included. */
function readContractBlock(
  nameText: string,
  lines: readonly string[],
  open: number,
  offset: number,
  into: DocContract[],
): { next: number } | WorkflowDocError {
  const line = offset + open + 1;
  const name = nameText.trim();
  if (name.length === 0) {
    return { error: `line ${line}: contract block has no name; write "\`\`\`contract <name>"` };
  }
  if (!CONTRACT_NAME.test(name)) {
    return {
      error: `line ${line}: contract name "${name}" may only contain lowercase letters, digits and "-", and must start with a letter`,
    };
  }
  if (into.some((entry) => entry.name === name)) {
    return { error: `line ${line}: contract "${name}" is already defined` };
  }
  let close = -1;
  const bodyLines: string[] = [];
  for (let j = open + 1; j < lines.length; j++) {
    if (CONTRACT_FENCE_CLOSE.test(lines[j] ?? "")) {
      close = j;
      break;
    }
    bodyLines.push(lines[j] ?? "");
  }
  if (close === -1) {
    return { error: `line ${line}: contract "${name}" is missing its closing "\`\`\`" fence` };
  }
  const parsed = parseContractBody(bodyLines, offset + open + 2);
  if (isWorkflowDocError(parsed)) return parsed;
  if (parsed.fields.length === 0) {
    return { error: `line ${line}: contract "${name}" declares no fields` };
  }
  into.push({ name, fields: parsed.fields });
  return { next: close };
}

interface StageDraft {
  index: number;
  line: number;
  text: string;
  branches: { line: number; text: string }[];
}

/**
 * Parse a workflow file into an editable document.
 *
 * Strict, like the engine: the first problem is returned as `{ error }` with
 * the engine's own line-numbered message, and nothing partially succeeds. On
 * success the result also carries `warnings` — dropped unknown keys, a name
 * the engine would normalise, a name borrowed from `defaults.name` (the
 * engine's filename-stem fallback, which an importer passes explicitly).
 */
export function parseWorkflowDoc(
  raw: string,
  defaults: { name?: string } = {},
): ParsedWorkflowDoc | WorkflowDocError {
  const { values, body, offset, keyLines, warnings } = parseRawFrontmatter(raw);
  const frontmatter: DocFrontmatter = { ...values };

  // Name: the engine falls back to the filename stem; an editor has no file,
  // so the fallback is explicit and recorded in the document when used.
  const rawName =
    frontmatter.name !== undefined && frontmatter.name.trim().length > 0
      ? frontmatter.name
      : (defaults.name ?? "");
  if (normalizeWorkflowName(rawName.trim()).length === 0) {
    return { error: 'workflow has no usable name; set "name:" in the frontmatter' };
  }
  if (frontmatter.name === undefined || frontmatter.name.trim().length === 0) {
    frontmatter.name = rawName;
    warnings.push(`workflow name taken from the file name: "${rawName}"`);
  }
  const nameNote = nameNormalizationWarning(frontmatter.name);
  if (nameNote !== undefined) warnings.push(nameNote);

  // Value validation, with the engine's exact messages. `continueOnError`
  // carries no line prefix in the engine; the numeric keys do.
  const flagError =
    frontmatter.continueOnError === undefined
      ? undefined
      : frontmatterValueError("continueOnError", frontmatter.continueOnError);
  if (flagError !== undefined) return { error: flagError };
  for (const key of ["stepTimeoutMs", "maxStepRetries", "budgetUsd", "budgetTokens"] as const) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    const message = frontmatterValueError(key, value);
    if (message !== undefined) {
      const line = keyLines.get(key);
      return { error: line === undefined ? message : `line ${line}: ${message}` };
    }
  }

  // --- scan the body: preamble prose, then stage drafts -------------------
  const drafts: StageDraft[] = [];
  const preambleLines: string[] = [];
  const contracts: DocContract[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = offset + i + 1;
    if (rawLine.trim().length === 0) {
      if (drafts.length === 0) preambleLines.push(rawLine);
      continue;
    }

    // A ```contract fence is consumed whole, before the preamble/continuation
    // rules can see its body — exactly as the engine's scanner does it.
    const fence = CONTRACT_FENCE.exec(rawLine);
    if (fence) {
      const consumed = readContractBlock(fence[1] ?? "", lines, i, offset, contracts);
      if (isWorkflowDocError(consumed)) return consumed;
      i = consumed.next;
      continue;
    }

    const numbered = NUMBERED_LINE.exec(rawLine);
    if (numbered) {
      const index = Number(numbered[1]);
      if (index !== drafts.length + 1) {
        return {
          error: `line ${line}: steps must be numbered consecutively from 1; expected ${drafts.length + 1}, got ${index}`,
        };
      }
      drafts.push({ index, line, text: (numbered[2] ?? "").trim(), branches: [] });
      continue;
    }

    const bullet = BULLET_LINE.exec(rawLine);
    if (bullet) {
      const current = drafts[drafts.length - 1];
      if (!current) {
        return { error: `line ${line}: parallel branch appears before any numbered step` };
      }
      if (bullet[2] !== "-") {
        return { error: `line ${line}: use "-" for a parallel branch, not "${bullet[2]}"` };
      }
      const text = (bullet[3] ?? "").trim();
      if (text.length === 0) {
        return { error: `line ${line}: parallel branch has an empty prompt` };
      }
      current.branches.push({ line, text });
      continue;
    }

    if (TOP_LEVEL_BULLET.test(rawLine)) {
      return {
        error: `line ${line}: a top-level bullet is not a step; use a numbered item, or indent it to make it a parallel branch`,
      };
    }
    if (drafts.length > 0) {
      return {
        error: `line ${line}: unexpected text after the step list; a step is exactly one line (no continuations)`,
      };
    }
    // Prose before the first numbered item is the preamble — kept, not eaten.
    preambleLines.push(rawLine);
  }

  if (drafts.length === 0) {
    return { error: "workflow has no steps; write a numbered list of them" };
  }

  // --- turn drafts into editable stages -----------------------------------
  const stages: DocStage[] = [];
  const context = (index: number): PlaceholderContext => ({
    ...(index <= 1 ? {} : { prev: stages[index - 2] }),
    contracts,
  });
  const contractDeclared = (parsed: ParsedStepLine, line: number): WorkflowDocError | undefined =>
    parsed.contract !== undefined && !contracts.some((entry) => entry.name === parsed.contract)
      ? { error: `line ${line}: no contract named "${parsed.contract}" is declared in this file` }
      : undefined;
  for (const draft of drafts) {
    if (draft.branches.length > 0) {
      if (draft.text.length > 0 && !draft.text.endsWith(":")) {
        return {
          error: `line ${draft.line}: step ${draft.index} has both a prompt and parallel branches; end the line with ":" to make it a label, or move the prompt into a branch`,
        };
      }
      const steps: DocStep[] = [];
      for (const branch of draft.branches) {
        const parsed = parseStepLine(branch.text, branch.line);
        if (isWorkflowDocError(parsed)) return parsed;
        const undeclared = contractDeclared(parsed, branch.line);
        if (undeclared) return undeclared;
        const bad = placeholderLineError(
          parsed.prompt,
          draft.index,
          branch.line,
          context(draft.index),
        );
        if (bad) return bad;
        steps.push(parsed);
      }
      stages.push({
        parallel: true,
        ...(draft.text.length === 0 ? {} : { label: draft.text }),
        steps,
      });
      continue;
    }

    if (draft.text.length === 0) {
      return {
        error: `line ${draft.line}: step ${draft.index} has neither a prompt nor any parallel branches`,
      };
    }
    const parsed = parseStepLine(draft.text, draft.line);
    if (isWorkflowDocError(parsed)) return parsed;
    const undeclared = contractDeclared(parsed, draft.line);
    if (undeclared) return undeclared;
    const bad = placeholderLineError(parsed.prompt, draft.index, draft.line, context(draft.index));
    if (bad) return bad;
    stages.push({ parallel: false, steps: [parsed] });
  }

  // Boundary blank lines are layout, not content; interior lines are verbatim.
  while (preambleLines.length > 0 && (preambleLines[0] ?? "").trim().length === 0) {
    preambleLines.shift();
  }
  while (
    preambleLines.length > 0 &&
    (preambleLines[preambleLines.length - 1] ?? "").trim().length === 0
  ) {
    preambleLines.pop();
  }

  // Omitted rather than empty when the file declared none, so a parsed
  // document is deep-equal to the hand-built one an editor would produce.
  return {
    doc: {
      frontmatter,
      preamble: preambleLines.join("\n"),
      stages,
      ...(contracts.length === 0 ? {} : { contracts }),
    },
    warnings,
  };
}

// -------------------------------------------------------------- serialisation

/** A step is one physical line, always: newlines inside a field become spaces. */
function inline(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * A frontmatter value that begins and ends with the same quote would lose
 * that pair on re-parse; wrapping it in the other quote preserves it.
 */
function frontmatterValue(value: string): string {
  const clean = inline(value);
  if (clean.length >= 2 && clean.startsWith('"') && clean.endsWith('"')) return `'${clean}'`;
  if (clean.length >= 2 && clean.startsWith("'") && clean.endsWith("'")) return `"${clean}"`;
  return clean;
}

function stepLine(step: DocStep): string {
  const parts: string[] = [];
  const tag = inline(step.modelTag ?? "");
  if (tag.length > 0) parts.push(`[${tag}]`);
  // Canonical option order — the grammar accepts any order, so serialisation
  // picks one and keeps it: race (which stands in for the model tag) first,
  // then the contract it produces, then how many judges vote on it.
  const race = (step.race ?? []).map((entry) => inline(entry)).filter((entry) => entry.length > 0);
  if (race.length > 0) parts.push(`[race:${race.join("|")}]`);
  const contract = inline(step.contract ?? "");
  if (contract.length > 0) parts.push(`[contract:${contract}]`);
  if (step.judges !== undefined) parts.push(`[judges:${step.judges}]`);
  const role = inline(step.role ?? "").toLowerCase();
  if (role.length > 0) parts.push(`@${role}`);
  const prompt = inline(step.prompt);
  if (prompt.length > 0) parts.push(prompt);
  return parts.join(" ");
}

/**
 * Serialise a document back to workflow markdown.
 *
 * Canonical form: frontmatter keys in `FRONTMATTER_KEYS` order, stages
 * renumbered consecutively from 1 with `N. `, branches as `   - `, the
 * preamble verbatim between the fence and the first stage. Serialising the
 * result of `parseWorkflowDoc` and parsing it again reaches a fixed point.
 * A hand-built document can break that property — the grammar has no
 * escaping, so a prompt beginning with a `[tag]`/`@role` shape re-parses as
 * the prefix it resembles; `stepReparseIssues` (via `validateWorkflowDoc`)
 * flags exactly those documents.
 */
export function serializeWorkflowDoc(doc: WorkflowDoc): string {
  const out: string[] = [];

  const keys = FRONTMATTER_KEYS.filter((key) => doc.frontmatter[key] !== undefined);
  if (keys.length > 0) {
    out.push("---");
    for (const key of keys) {
      const value = frontmatterValue(doc.frontmatter[key] ?? "");
      out.push(value.length === 0 ? `${key}:` : `${key}: ${value}`);
    }
    out.push("---");
  }

  if (doc.preamble.trim().length > 0) {
    out.push(doc.preamble.replace(/\r\n/g, "\n"));
    out.push("");
  }

  doc.stages.forEach((stage, position) => {
    const index = position + 1;
    if (stage.parallel) {
      const label = inline(stage.label ?? "");
      const headed = label.length > 0 && !label.endsWith(":") ? `${label}:` : label;
      out.push(headed.length === 0 ? `${index}.` : `${index}. ${headed}`);
      for (const step of stage.steps) {
        const text = stepLine(step);
        out.push(text.length === 0 ? "   -" : `   - ${text}`);
      }
      return;
    }
    const text = stepLine(stage.steps[0] ?? { prompt: "" });
    out.push(text.length === 0 ? `${index}.` : `${index}. ${text}`);
  });

  // Contract declarations go after the step list: they are reference material,
  // and putting them there keeps the pipeline the first thing a reader sees.
  // The engine accepts a fence anywhere in the body, so the position is ours
  // to choose and a re-parse finds the same declarations either way.
  for (const contract of doc.contracts ?? []) {
    out.push("");
    out.push(`\`\`\`contract ${contract.name}`);
    for (const field of contract.fields) out.push(contractFieldLine(field));
    out.push("```");
  }

  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------- validation

/**
 * The grammar has no escaping: `stepLine` writes the prompt verbatim after the
 * optional `[tag]` / `@role` prefixes, so a prompt that *begins* with a prefix
 * shape means something else to the engine when the serialised line is read
 * back — `@word …` with an empty role field re-parses as a role, `[valid-tag]
 * …` with an empty tag field re-parses as a model tag (or, after a set role,
 * hard-errors as a misplaced one), and an invalid bracketed tag is rejected
 * outright rather than read as prose. Rather than approximate those rules,
 * this re-parses the exact line `serializeWorkflowDoc` would emit with the
 * mirrored `parseStepLine` and compares the result with what the fields say.
 * An empty array means the line round-trips; each divergence is one actionable
 * message.
 *
 * A field that already fails its own rule (`modelTagError`, `roleError`, an
 * empty prompt) is skipped here — its own issue covers it.
 */
export function stepOptionErrors(step: DocStep, contracts?: DocContract[]): string[] {
  const issues: string[] = [];
  const contract = inline(step.contract ?? "");
  if (contract.length > 0 && !CONTRACT_NAME.test(contract)) {
    issues.push(
      `contract name "${contract}" may only contain lowercase letters, digits and "-", and must start with a letter`,
    );
  } else if (
    contract.length > 0 &&
    contracts !== undefined &&
    !contracts.some((entry) => entry.name === contract)
  ) {
    issues.push(`no contract named "${contract}" is declared in this file`);
  }

  const race = (step.race ?? []).map((entry) => inline(entry));
  if (race.length > 0) {
    if (race.length < 2 || race.length > 3) {
      issues.push(`race must list 2 or 3 model tags separated by "|", got "${race.join("|")}"`);
    }
    const seen = new Set<string>();
    for (const tag of race) {
      if (tag.length === 0 || !VALID_TAG.test(tag)) {
        issues.push(
          `race model tag "${tag}" may only contain letters, digits, ".", "_", "/", ":" and "-"`,
        );
      } else if (seen.has(tag)) {
        issues.push(`race lists model tag "${tag}" twice`);
      }
      seen.add(tag);
    }
    if (inline(step.modelTag ?? "").length > 0) issues.push("race replaces the model tag");
    if (step.judges !== undefined) issues.push("judges and race cannot be combined");
  }

  if (step.judges !== undefined) {
    if (step.judges !== 2 && step.judges !== 3) {
      issues.push(`judges must be 2 or 3, got "${step.judges}"`);
    }
    if (inline(step.role ?? "").length === 0) issues.push("judges requires a role");
    if (contract.length === 0) issues.push("judges requires a contract");
  }
  return issues;
}

/**
 * Every problem in one contract declaration, in the engine's words minus the
 * line prefix (an editor addresses a contract by name, not by file line).
 */
export function contractIssues(contract: DocContract): string[] {
  const issues: string[] = [];
  if (!CONTRACT_NAME.test(contract.name)) {
    issues.push(
      `contract name "${contract.name}" may only contain lowercase letters, digits and "-", and must start with a letter`,
    );
  }
  if (contract.fields.length === 0) {
    issues.push(`contract "${contract.name}" declares no fields`);
  }
  const seen = new Set<string>();
  for (const field of contract.fields) {
    if (!CONTRACT_FIELD_NAME.test(field.name)) {
      issues.push(
        `contract field "${field.name}" may only contain letters, digits and "_", and must start with a letter`,
      );
    } else if (seen.has(field.name)) {
      issues.push(`contract field "${field.name}" appears twice`);
    }
    seen.add(field.name);
    if (field.type.kind === "enum" && field.type.values.length < 2) {
      issues.push(`unknown type "${field.type.values.join(" | ")}"; ${TYPE_HELP}`);
    }
  }
  return issues;
}

export function stepReparseIssues(step: DocStep): string[] {
  const tag = inline(step.modelTag ?? "");
  const role = inline(step.role ?? "").toLowerCase();
  const prompt = inline(step.prompt);
  if (prompt.length === 0) return [];
  if (modelTagError(tag) !== undefined || roleError(role) !== undefined) return [];
  // An option that is invalid on its own face would make the serialised line
  // unparsable for a reason this function is not about; its own issue covers it.
  if (stepOptionErrors(step).length > 0) return [];

  // Line 0 is a sentinel (real lines are 1-based): the caller addresses the
  // issue to a stage and branch, not a file line, so the prefix is stripped.
  const reparsed = parseStepLine(stepLine(step), 0);
  if (isWorkflowDocError(reparsed)) {
    const reason = reparsed.error.replace(/^line 0: /, "");
    return [
      `the engine re-reads the start of this prompt as a "[tag]" or "@role" prefix and rejects the line: ${reason}`,
    ];
  }

  const issues: string[] = [];
  const readRole = reparsed.role ?? "";
  if (readRole !== role) {
    issues.push(
      `the engine will read "@${readRole}" as this step's role, not prompt text — reword the prompt so it doesn't start with "@", or put "${readRole}" in the role field`,
    );
  }
  const readTag = reparsed.modelTag ?? "";
  if (readTag !== tag) {
    issues.push(
      `the engine will read "[${readTag}]" as this step's model tag, not prompt text — move it later in the prompt, or put "${readTag}" in the model tag field`,
    );
  }
  if (issues.length === 0 && reparsed.prompt !== prompt) {
    // Unreachable while the prefixes are the only rewriting the serialised
    // line can undergo, but a divergence with no named cause must still block
    // the "Valid" claim.
    issues.push("the engine reads a different prompt from this line; reword its beginning");
  }
  return issues;
}

/**
 * Every problem the engine's parser would raise against this document, plus
 * the warnings it would swallow — for inline display while editing. Unlike
 * `parseWorkflowDoc` this does not stop at the first problem.
 */
export function validateWorkflowDoc(doc: WorkflowDoc): DocIssue[] {
  const issues: DocIssue[] = [];
  const at = (location: string, message: string, severity: "error" | "warning" = "error") => {
    issues.push({ severity, location, message });
  };

  const name = doc.frontmatter.name ?? "";
  if (normalizeWorkflowName(name.trim()).length === 0) {
    at("frontmatter", 'workflow has no usable name; set "name:" in the frontmatter');
  } else {
    const note = nameNormalizationWarning(name);
    if (note !== undefined) at("frontmatter", note, "warning");
  }
  for (const key of FRONTMATTER_KEYS) {
    const value = doc.frontmatter[key];
    if (value === undefined) continue;
    const message = frontmatterValueError(key, value);
    if (message !== undefined) at("frontmatter", message);
  }

  // A preamble line the parser would read as a stage, branch or fence would
  // change meaning on the next import — flag it rather than mangle it.
  doc.preamble.split(/\r?\n/).forEach((line, index) => {
    if (NUMBERED_LINE.test(line) || BULLET_LINE.test(line) || TOP_LEVEL_BULLET.test(line)) {
      at(
        `preamble line ${index + 1}`,
        "reads as a step or branch line; reword it or move it into a stage",
        "warning",
      );
    }
  });

  if (doc.stages.length === 0) {
    at("pipeline", "workflow has no steps; write a numbered list of them");
  }

  const contracts = doc.contracts ?? [];
  const declared = new Set<string>();
  for (const contract of contracts) {
    const where = `contract ${contract.name}`;
    if (declared.has(contract.name)) at(where, `contract "${contract.name}" is already defined`);
    declared.add(contract.name);
    for (const message of contractIssues(contract)) at(where, message);
  }
  // A contract nothing references is fine; the engine keeps it too. Say so
  // quietly rather than silently, since it costs nothing at run time.
  for (const contract of contracts) {
    const used = doc.stages.some((stage) => stage.steps.some((s) => s.contract === contract.name));
    if (!used) at(`contract ${contract.name}`, "no step references this contract", "warning");
  }

  doc.stages.forEach((stage, position) => {
    const index = position + 1;
    const where = `stage ${index}`;
    if (stage.steps.length === 0) {
      at(where, `step ${index} has neither a prompt nor any parallel branches`);
    }
    stage.steps.forEach((step, branch) => {
      const spot = stage.parallel ? `${where} · branch ${branch + 1}` : where;
      const tagBad = modelTagError(step.modelTag ?? "");
      if (tagBad !== undefined) at(spot, tagBad);
      const roleBad = roleError(step.role ?? "");
      if (roleBad !== undefined) at(spot, roleBad);
      for (const message of stepOptionErrors(step, contracts)) at(spot, message);
      if (inline(step.prompt).length === 0) {
        at(spot, "step has an empty prompt");
      } else {
        const placeholderBad = placeholderError(step.prompt, index, {
          ...(position === 0 ? {} : { prev: doc.stages[position - 1] }),
          contracts,
        });
        if (placeholderBad !== undefined) at(spot, placeholderBad);
        for (const message of stepReparseIssues(step)) at(spot, message);
      }
    });
  });

  return issues;
}
