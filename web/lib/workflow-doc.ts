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
  prompt: string;
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
 * The engine's placeholder rule for one prompt in one stage (1-based).
 * `{{prev}}` and `{{journal}}` have no value in stage 1.
 */
export function placeholderError(prompt: string, stageIndex: number): string | undefined {
  PLACEHOLDER.lastIndex = 0;
  for (const match of prompt.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? "").trim();
    if (name !== "prev" && name !== "input" && name !== "journal") {
      return `unknown placeholder "${match[0]}"; only {{prev}}, {{input}} and {{journal}} exist`;
    }
    if ((name === "prev" || name === "journal") && stageIndex === 1) {
      return `{{${name}}} has no value in the first step`;
    }
  }
  return undefined;
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
  prompt: string;
}

/** Mirror of the engine's `parseStepLine`, error strings included. */
function parseStepLine(text: string, line: number): ParsedStepLine | WorkflowDocError {
  let rest = text;
  let modelTag: string | undefined;

  const tagged = MODEL_TAG.exec(rest);
  if (tagged) {
    const tag = (tagged[1] ?? "").trim();
    if (tag.length === 0) {
      return {
        error: `line ${line}: model tag is empty; write "[tier:cheap] prompt…" or drop the brackets`,
      };
    }
    if (!VALID_TAG.test(tag)) {
      return {
        error: `line ${line}: model tag "${tag}" may only contain letters, digits, ".", "_", "/", ":" and "-"`,
      };
    }
    rest = (tagged[2] ?? "").trim();
    if (rest.length === 0) {
      return { error: `line ${line}: step has a model tag but no prompt` };
    }
    modelTag = tag;
  }

  const roled = ROLE_TAG.exec(rest);
  if (roled) {
    const raw = (roled[1] ?? "").trim();
    if (raw.length === 0) {
      return {
        error: `line ${line}: role name is empty; write "@architect prompt…" or drop the "@"`,
      };
    }
    const role = raw.toLowerCase();
    if (!VALID_ROLE.test(role)) {
      return {
        error: `line ${line}: role name "${raw}" may only contain letters, digits and "-", and must start with a letter or digit`,
      };
    }
    const prompt = (roled[2] ?? "").trim();
    if (prompt.length === 0) {
      return { error: `line ${line}: step names role "@${role}" but has no prompt` };
    }
    if (modelTag === undefined) {
      const stray = MODEL_TAG.exec(prompt);
      const strayTag = (stray?.[1] ?? "").trim();
      if (strayTag.length > 0 && VALID_TAG.test(strayTag)) {
        return {
          error: `line ${line}: a model tag must come before the role — write "[${strayTag}] @${role} prompt…"; if "[${strayTag}]" is part of the prompt, move it later in the line`,
        };
      }
    }
    return { ...(modelTag === undefined ? {} : { modelTag }), role, prompt };
  }

  if (rest.length === 0) {
    return { error: `line ${line}: step has an empty prompt` };
  }
  return { ...(modelTag === undefined ? {} : { modelTag }), prompt: rest };
}

/** Placeholder validation with the engine's line-prefixed error text. */
function placeholderLineError(
  prompt: string,
  stageIndex: number,
  line: number,
): WorkflowDocError | undefined {
  const message = placeholderError(prompt, stageIndex);
  return message === undefined ? undefined : { error: `line ${line}: ${message}` };
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
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = offset + i + 1;
    if (rawLine.trim().length === 0) {
      if (drafts.length === 0) preambleLines.push(rawLine);
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
        const bad = placeholderLineError(parsed.prompt, draft.index, branch.line);
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
    const bad = placeholderLineError(parsed.prompt, draft.index, draft.line);
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

  return { doc: { frontmatter, preamble: preambleLines.join("\n"), stages }, warnings };
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
export function stepReparseIssues(step: DocStep): string[] {
  const tag = inline(step.modelTag ?? "");
  const role = inline(step.role ?? "").toLowerCase();
  const prompt = inline(step.prompt);
  if (prompt.length === 0) return [];
  if (modelTagError(tag) !== undefined || roleError(role) !== undefined) return [];

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
      if (inline(step.prompt).length === 0) {
        at(spot, "step has an empty prompt");
      } else {
        const placeholderBad = placeholderError(step.prompt, index);
        if (placeholderBad !== undefined) at(spot, placeholderBad);
        for (const message of stepReparseIssues(step)) at(spot, message);
      }
    });
  });

  return issues;
}
