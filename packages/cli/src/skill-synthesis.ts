/**
 * SKILL SYNTHESIS — turn a run that already worked into a reusable skill.
 *
 * `arcturn skill synthesize <runId>` reads one finished workflow run's
 * journal, hands a drafting sub-agent an evidence packet built ONLY from
 * durable facts already on disk (never re-reading the model's reasoning, and
 * never sending anything off the machine — see `RULES.md` §6), and asks it to
 * write a `SKILL.md` that captures the procedure the run actually performed.
 * The draft is shown, approved (`--yes` headless, a picker in the TUI), and
 * saved under the chosen skills root — the same `<root>/skills/<name>/SKILL.md`
 * layout `skills.ts` already loads, so the new skill is a `/<name>` slash
 * command the moment it lands.
 *
 * Nothing here talks to a network on its own behalf. `--share` only ever
 * prints a pre-filled GitHub issue URL, in the exact shape `insights.ts`'s
 * `--share` uses — a human has to open it.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentDef } from "./agents.js";
import type { SlashCommand } from "./commands.js";
import type { EnvMap } from "./paths.js";
import { type ArcturnRuntime, buildRuntime } from "./runtime.js";
import { loadSkills } from "./skills.js";
import {
  isWorkflowParseError,
  parseWorkflow,
  type Workflow,
  type WorkflowRunResult,
  type WorkflowStep,
} from "./workflow.js";
import {
  type JournalLine,
  type RunHeaderLine,
  readJournalLines,
  readManifest,
  type StepActivity,
  type StepEndLine,
} from "./workflow-run.js";

/** Where a skill is saved: the user's own root, or the current project's. */
export type SkillSynthesisScope = "user" | "project";

/** Evidence handed to the drafting sub-agent is capped here, in characters. */
export const EVIDENCE_MAX_CHARS = 12_000;

/** A drafted `SKILL.md` may not exceed this many bytes on disk. */
export const SKILL_MAX_BYTES = 8 * 1024;

/** Where `--share` points — this feature's own copy, never imported private. */
const ISSUE_URL = "https://github.com/sitharaj88/arcturn/issues/new";

/** Hard ceiling on a `--share` URL, mirroring `insights.ts`. */
const SHARE_URL_MAX_BYTES = 8 * 1024;

/** A drafted skill name may be at most this many characters. */
const NAME_MAX_CHARS = 40;

/** The name pattern every saved skill (and every `--name` override) must match. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Control-lane markers a synthesized skill must never carry (RULES.md §5). */
const FORBIDDEN_MARKERS = ["ORG-ASK:", "ORG-HALT:", "ARCTURN-PATCH:"];

/** Whether a string is a legal skill name. */
export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX_CHARS && NAME_PATTERN.test(name);
}

// --------------------------------------------------------------------------
// Evidence packet
// --------------------------------------------------------------------------

/** One step's evidence, as folded from its terminal journal line. */
interface EvidenceStep {
  readonly id: string;
  readonly stage: number;
  readonly role?: string;
  readonly status: string;
  readonly prompt?: string;
  readonly activity?: StepActivity;
  readonly patch?: { status: string; files: number };
  readonly tail?: string;
  readonly endedAt: number;
}

/** The durable facts a run's journal (plus its manifest) carries. */
interface RunFacts {
  readonly runId: string;
  readonly workflow: string;
  readonly source: string;
  readonly input: string;
  readonly lines: readonly JournalLine[];
}

/** Read a run's journal and manifest, tolerating a missing manifest. */
async function loadRunFacts(home: string, runId: string): Promise<RunFacts | undefined> {
  const dir = join(home, "workflow-runs", runId);
  const lines = await readJournalLines(dir);
  if (lines.length === 0) return undefined;
  const manifest = await readManifest(dir);
  const header = lines.find((line): line is RunHeaderLine => line.kind === "run");
  const workflow = manifest?.workflow ?? header?.workflow;
  const source = manifest?.source ?? header?.source;
  if (workflow === undefined || source === undefined) return undefined;
  return { runId, workflow, source, input: manifest?.input ?? header?.input ?? "", lines };
}

/** Why a run is refused for synthesis, or `undefined` when it is clean. */
function gateReason(runId: string, lines: readonly JournalLine[]): string | undefined {
  const runEnd = [...lines].reverse().find((line) => line.kind === "runEnd");
  const failedStage = lines.find((line) => line.kind === "stageEnd" && line.status === "failed");
  if (!runEnd) return `run "${runId}" has not finished (no runEnd in its journal)`;
  if (runEnd.kind === "runEnd" && runEnd.status !== "done") {
    return `run "${runId}" ended with status "${runEnd.status}", not "done"`;
  }
  if (failedStage) return `run "${runId}" had a failed stage`;
  return undefined;
}

/** Cap a value to its last `n` characters, marking the cut when it applies. */
function tail(text: string, n: number): string {
  const trimmed = text.trim();
  return trimmed.length <= n ? trimmed : `…${trimmed.slice(-n)}`;
}

function formatActivity(activity: StepActivity | undefined): string {
  if (!activity) return "(no activity recorded)";
  const tools = Object.entries(activity.toolCalls)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} x${count}`)
    .join(", ");
  return `${activity.turns} turns; tools: ${tools || "none"}; writes: ${activity.writes}`;
}

/**
 * Fold a run's journal into the per-step evidence a drafting agent needs, best
 * effort: a step id the workflow file no longer has (a resume against an
 * edited file, an installed kit that moved on) simply loses its prompt text.
 */
function foldEvidenceSteps(
  lines: readonly JournalLine[],
  stepsById: ReadonlyMap<string, WorkflowStep>,
): EvidenceStep[] {
  const latest = new Map<string, StepEndLine>();
  for (const line of lines) {
    if (line.kind === "stepEnd") latest.set(line.id, line);
  }
  const steps = [...latest.values()].sort((a, b) => a.endedAt - b.endedAt);
  return steps.map((line) => ({
    id: line.id,
    stage: line.stage,
    role: line.agent,
    status: line.status,
    prompt: stepsById.get(line.id)?.prompt,
    activity: line.activity,
    patch:
      line.record === undefined
        ? undefined
        : { status: line.record.status, files: line.record.files },
    tail: line.text.length > 0 ? tail(line.text, 800) : undefined,
    endedAt: line.endedAt,
  }));
}

/** Best-effort parse of the workflow file a run's manifest points at. */
async function loadWorkflowSource(
  source: string,
  name: string,
): Promise<Map<string, WorkflowStep>> {
  const byId = new Map<string, WorkflowStep>();
  try {
    const raw = await readFile(source, "utf8");
    const parsed = parseWorkflow(raw, { name, source });
    if (!isWorkflowParseError(parsed)) {
      for (const stage of parsed.stages) {
        for (const step of stage.steps) byId.set(step.id, step);
      }
    }
  } catch {
    // The workflow file may have moved or been removed since the run; the
    // packet just carries less prompt text, never fails synthesis over it.
  }
  return byId;
}

/** Render the evidence packet handed to the drafting sub-agent, capped. */
function renderEvidencePacket(
  facts: RunFacts,
  workflow: Workflow | undefined,
  steps: readonly EvidenceStep[],
): string {
  const lines: string[] = [
    `# workflow: ${facts.workflow}`,
    workflow?.description ? workflow.description : "(no description)",
    "",
    "## input",
    facts.input.length > 0 ? tail(facts.input, 1000) : "(empty)",
    "",
    "## steps",
  ];
  for (const step of steps) {
    lines.push(
      "",
      `### step ${step.id} (stage ${step.stage})`,
      `role: ${step.role ?? "(none)"}`,
      `status: ${step.status}`,
      "prompt:",
      step.prompt ? tail(step.prompt, 1500) : "(prompt not found in the workflow file)",
      `activity: ${formatActivity(step.activity)}`,
      step.patch ? `patch: status=${step.patch.status} files=${step.patch.files}` : "patch: (none)",
      "output (tail):",
      step.tail ?? "(empty)",
    );
  }
  const packet = lines.join("\n");
  if (packet.length <= EVIDENCE_MAX_CHARS) return packet;
  return `${packet.slice(0, EVIDENCE_MAX_CHARS - 80)}\n\n... (evidence truncated at ${EVIDENCE_MAX_CHARS.toLocaleString("en-US")} chars)\n`;
}

// --------------------------------------------------------------------------
// Drafting
// --------------------------------------------------------------------------

/** System prompt for the drafting sub-agent. */
const SYNTHESIZER_SYSTEM_PROMPT = `You turn a finished Arcturn workflow run into a reusable Arcturn skill.

You are handed an EVIDENCE PACKET: the workflow's name and description, its
input, and a per-step record — the role, its prompt template, its status,
what tools it called, and the last 800 characters of what it produced. You may
use "read", "grep" and "glob" to look at files the evidence names, but you do
not need to and the evidence is usually enough on its own.

Write a SKILL.md file for the arcturn skill format: a markdown file with a
frontmatter block (between two "---" lines) carrying "name:" (kebab-case,
lowercase letters/digits/hyphens only, at most 40 characters) and
"description:" (one line, imperative mood, e.g. "Draft a release changelog
from recent commits"), followed by the body. The body is written for a model
that will run this skill with the SAME tools the evidence shows the run used —
it is a set of instructions FOR that model, not a report about the run. Cover:

1. When to use this skill (one short paragraph).
2. The procedure as numbered steps, phrased as instructions to follow, and
   referencing "$ARGUMENTS" wherever the run's input shaped what it did.
3. Checks to run before considering the work done.
4. Pitfalls actually seen in this run's evidence (a step that thrashed, a
   step that failed and needed a retry, a tool that turned out unnecessary) —
   skip this section if the evidence shows nothing noteworthy.

Do not invent steps the evidence does not support. Do not include secrets,
file contents, or anything the evidence itself did not show. Never write the
literal text "ORG-ASK:", "ORG-HALT:" or "ARCTURN-PATCH:" anywhere in the file.
The body must never contain a triple-backtick fence.

Reply with EXACTLY ONE fenced code block, opened with three backticks and
"md", containing the WHOLE file (frontmatter and body) and nothing else
outside the fence.`;

/** Build the prompt sent to the drafting sub-agent for one run. */
function buildDraftPrompt(evidence: string): string {
  return `${SYNTHESIZER_SYSTEM_PROMPT}\n\n---\n\n${evidence}`;
}

/**
 * Build the one correction turn a rejected draft gets.
 *
 * Quotes every validation error verbatim and restates the exact output
 * contract, so the second attempt is a correction rather than a re-roll —
 * the same shape `retro.ts`'s retry prompt takes for a failed edit block.
 *
 * @param errors - The validation failures, in the words the user would see.
 */
function buildCorrectionPrompt(errors: readonly string[]): string {
  return [
    "Your draft was REJECTED and nothing was saved. What was wrong with it:",
    "",
    ...errors.map((error) => `- ${error}`),
    "",
    "Fix every point above and reply with EXACTLY ONE fenced code block, opened with three",
    'backticks and "md", containing the WHOLE corrected file — the `---` frontmatter block',
    "(with `name:` and `description:`) followed by the body — and nothing outside the fence.",
    "The body itself must not contain a triple-backtick fence, and must never contain the",
    `literal text ${FORBIDDEN_MARKERS.map((marker) => `"${marker}"`).join(", ")}.`,
  ].join("\n");
}

/**
 * Extract the fenced ```md block from a model reply.
 *
 * Greedy on purpose: the instructions ask for exactly ONE fence wrapping the
 * whole file, so this takes everything between the opening fence and the
 * LAST closing fence in the reply — the reading under which a body that
 * (against instructions) contains its own nested ``` fence still comes back
 * whole, so {@link validateDraft}'s own "no code fence" check is the thing
 * that catches it, not a truncated extraction silently hiding it.
 */
function extractFence(raw: string): string | undefined {
  const match = /```(?:md|markdown)?\r?\n([\s\S]*)```/.exec(raw);
  return match?.[1]?.trim();
}

/** A drafted skill's frontmatter, as split (not validated) off its body. */
interface SplitSkillFile {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Split a candidate `SKILL.md` into frontmatter fields and body. Mirrors `skills.ts`'s own parse. */
function splitSkillFile(raw: string): SplitSkillFile | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return undefined;
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
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
    frontmatter[key] = value;
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

/** A drafted, validated skill, ready to be shown and saved. */
export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  /** The exact bytes to write to `SKILL.md`. */
  readonly content: string;
  readonly runId: string;
  readonly generated: string;
}

/** The failure half of drafting: a reason and whether `--force` can skip it. */
export interface SkillSynthesisError {
  readonly ok: false;
  readonly error: string;
  /** `true` when `--force` (or, for a collision, `--name`) can get past this. */
  readonly overridable: boolean;
}

export type SkillDraftResult =
  | { readonly ok: true; readonly draft: SkillDraft }
  | SkillSynthesisError;

function fail(error: string, overridable = false): SkillSynthesisError {
  return { ok: false, error, overridable };
}

/** Validate a candidate draft and reassemble its final on-disk bytes. */
function validateDraft(
  raw: string,
  runId: string,
  nameOverride: string | undefined,
  now: () => number,
): SkillDraftResult | SkillSynthesisError {
  const fenced = extractFence(raw);
  if (fenced === undefined) {
    return fail("the drafting agent did not return a fenced ```md block");
  }
  for (const marker of FORBIDDEN_MARKERS) {
    if (fenced.includes(marker)) {
      return fail(`the drafted skill contains a forbidden marker ("${marker}")`);
    }
  }
  const split = splitSkillFile(fenced);
  if (!split) return fail("the drafted skill has no frontmatter block");
  const draftedName = split.frontmatter.name?.trim() ?? "";
  const name = nameOverride ?? draftedName;
  if (!isValidSkillName(name)) {
    return fail(
      `"${name || "(empty)"}" is not a valid skill name (must match ^[a-z0-9][a-z0-9-]*$, at most ${NAME_MAX_CHARS} characters)`,
    );
  }
  const description = split.frontmatter.description?.trim() ?? "";
  if (description === "") return fail("the drafted skill has no description");
  const body = split.body.trim();
  if (body === "") return fail("the drafted skill has an empty body");
  if (body.includes("```")) return fail("the drafted skill's body contains a code fence");

  const generated = new Date(now()).toISOString();
  const content = `${[
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `source-run: ${runId}`,
    `generated: ${generated}`,
    "---",
    "",
    body,
    "",
  ].join("\n")}`;
  if (Buffer.byteLength(content, "utf8") > SKILL_MAX_BYTES) {
    return fail(
      `the drafted skill is larger than ${SKILL_MAX_BYTES.toLocaleString("en-US")} bytes`,
    );
  }
  return { ok: true, draft: { name, description, body, content, runId, generated } };
}

// --------------------------------------------------------------------------
// The whole draft pipeline
// --------------------------------------------------------------------------

/** What `synthesizeSkill` needs. */
export interface SynthesizeSkillOptions {
  readonly runtime: ArcturnRuntime;
  readonly runId: string;
  readonly name?: string;
  readonly scope: SkillSynthesisScope;
  readonly force?: boolean;
  readonly now?: () => number;
}

/** The two skills roots a collision (and, on save, a verify) is checked against. */
function skillsRoots(runtime: ArcturnRuntime): string[] {
  return [...new Set([join(runtime.paths.home, "skills"), join(runtime.paths.project, "skills")])];
}

/**
 * Read the run, build its evidence packet, draft a `SKILL.md` with a
 * sub-agent, and validate it. Does not save — see {@link saveSkillDraft}.
 */
export async function synthesizeSkill(options: SynthesizeSkillOptions): Promise<SkillDraftResult> {
  const { runtime, runId } = options;
  const now = options.now ?? (() => Date.now());

  const facts = await loadRunFacts(runtime.paths.home, runId);
  if (!facts) return fail(`no run journal found for "${runId}"`);

  if (!options.force) {
    const reason = gateReason(runId, facts.lines);
    if (reason) return fail(reason, true);
  }

  if (options.name !== undefined && !isValidSkillName(options.name)) {
    return fail(
      `--name "${options.name}" is not a valid skill name (must match ^[a-z0-9][a-z0-9-]*$, at most ${NAME_MAX_CHARS} characters)`,
    );
  }

  const stepsById = await loadWorkflowSource(facts.source, facts.workflow);
  let workflow: Workflow | undefined;
  try {
    const raw = await readFile(facts.source, "utf8");
    const parsed = parseWorkflow(raw, { name: facts.workflow, source: facts.source });
    if (!isWorkflowParseError(parsed)) workflow = parsed;
  } catch {
    // Best effort, as above.
  }
  const evidenceSteps = foldEvidenceSteps(facts.lines, stepsById);
  const evidence = renderEvidencePacket(facts, workflow, evidenceSteps);

  const configuredModel = runtime.config.skills?.synthesisModel;
  const fastTierConfigured = runtime.config.route?.tiers?.fast !== undefined;
  const model = configuredModel ?? (fastTierConfigured ? "tier:fast" : undefined);

  const def: AgentDef = {
    name: "skill-synthesizer",
    description: "Drafts a reusable Arcturn skill from a finished workflow run.",
    systemPrompt: SYNTHESIZER_SYSTEM_PROMPT,
    tools: ["read", "grep", "glob"],
    source: "<built-in: skill-synthesis>",
    maxTurns: 10,
    ...(model === undefined ? {} : { model }),
  };
  const prompt = buildDraftPrompt(evidence);
  const agent = runtime.createSubagent(prompt, def, { origin: "skill-synthesis" });
  await agent.prompt(prompt);

  let validated = validateDraft(agent.finalText(), runId, options.name, now);
  // ONE correction turn, in the same sub-agent so the evidence packet it was
  // shown is still in its own history — the same forgiveness `retro.ts` gives
  // its edit blocks. A fast model reaches for an example fence, or drops the
  // frontmatter, often enough that discarding an otherwise good draft on the
  // first format slip wastes the whole (expensive) drafting turn.
  if (!validated.ok) {
    await agent.prompt(buildCorrectionPrompt([validated.error]));
    const second = validateDraft(agent.finalText(), runId, options.name, now);
    // A second failure is reported as itself: the refusal a caller sees names
    // what is wrong with the draft that was actually last produced.
    validated = second;
  }
  if (!validated.ok) return validated;

  const roots = skillsRoots(runtime);
  const warnings: string[] = [];
  const existing = await loadSkills(roots, warnings);
  const collision = existing.find((skill) => skill.name === validated.draft.name);
  if (collision && !options.force) {
    return fail(
      `a skill named "${validated.draft.name}" already exists (${collision.source}); ` +
        "rerun with --force to overwrite it, or --name <other> to save under a different name.",
      true,
    );
  }

  return validated;
}

/** Where a scope's skill file lives. */
export function skillFilePath(
  runtime: ArcturnRuntime,
  scope: SkillSynthesisScope,
  name: string,
): string {
  const root = scope === "project" ? runtime.paths.project : runtime.paths.home;
  return join(root, "skills", name, "SKILL.md");
}

/** Write `data` to `path` via a temp file + rename in the same directory. */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tmp = join(parent, `.skill-synthesis-tmp-${randomUUID()}`);
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/** Result of saving a validated draft. */
export type SaveSkillResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/**
 * Save a validated draft, then verify it by loading it back through
 * {@link loadSkills} — an effect check, not just a write.
 */
export async function saveSkillDraft(
  runtime: ArcturnRuntime,
  draft: SkillDraft,
  scope: SkillSynthesisScope,
): Promise<SaveSkillResult> {
  const path = skillFilePath(runtime, scope, draft.name);
  await writeFileAtomic(path, draft.content);
  const root = scope === "project" ? runtime.paths.project : runtime.paths.home;
  const warnings: string[] = [];
  const loaded = await loadSkills([join(root, "skills")], warnings);
  if (!loaded.some((skill) => skill.name === draft.name)) {
    return { ok: false, error: `saved to ${path} but it did not load back as a skill` };
  }
  return { ok: true, path };
}

// --------------------------------------------------------------------------
// --share
// --------------------------------------------------------------------------

/** The privacy line printed above a shared draft, mirroring `insights.ts`. */
export const SKILL_SHARE_PRIVACY_STATEMENT =
  "Contains the drafted SKILL.md only — the run's prompts and reasoning were never sent anywhere by this command.";

function issueUrl(title: string, body: string): string {
  return `${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/**
 * Render a pre-filled GitHub issue proposing a drafted skill for the hub.
 * Nothing is sent — the URL is printed for a human to open.
 */
export function renderSkillShare(draft: SkillDraft): string[] {
  const title = `skill proposal: ${draft.name}`;
  const fence = "```";
  const markdown = [
    `## Skill proposal: ${draft.name}`,
    "",
    `_${SKILL_SHARE_PRIVACY_STATEMENT}_`,
    "",
    `${fence}md`,
    draft.content,
    fence,
  ].join("\n");

  let body = markdown;
  while (
    Buffer.byteLength(issueUrl(title, body), "utf8") > SHARE_URL_MAX_BYTES &&
    body.length > 0
  ) {
    const keep = Math.max(0, Math.floor(body.length * 0.9) - 32);
    body = `${body.slice(0, keep)}\n... (truncated)\n${fence}`;
    if (keep === 0) break;
  }

  return [
    ...markdown.split("\n"),
    "",
    "Nothing was sent. To propose this, open the pre-filled issue yourself:",
    issueUrl(title, body),
  ];
}

// --------------------------------------------------------------------------
// `arcturn skill synthesize` (top-level CLI)
// --------------------------------------------------------------------------

/** What {@link parseSkillSynthesizeArgs} understood. */
interface ParsedSkillSynthesizeArgs {
  readonly runId?: string;
  readonly name?: string;
  readonly scope: SkillSynthesisScope;
  readonly yes: boolean;
  readonly force: boolean;
  readonly share: boolean;
  readonly json: boolean;
  readonly help: boolean;
  readonly error?: string;
}

/** Usage line shown on a parse error or `--help`. */
export const SKILL_SYNTHESIZE_USAGE =
  "Usage: arcturn skill synthesize <runId> [--name <name>] [--scope user|project] " +
  "[--yes] [--force] [--share] [--json]";

/** Parse `synthesize <runId> [...]` (the tokens after the `skill` word). */
export function parseSkillSynthesizeArgs(rest: readonly string[]): ParsedSkillSynthesizeArgs {
  let runId: string | undefined;
  let name: string | undefined;
  let scope: SkillSynthesisScope = "user";
  let yes = false;
  let force = false;
  let share = false;
  let json = false;
  let help = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--help" || token === "-h") {
      help = true;
    } else if (token === "--yes") {
      yes = true;
    } else if (token === "--force") {
      force = true;
    } else if (token === "--share") {
      share = true;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--name") {
      name = rest[++i];
    } else if (token?.startsWith("--name=")) {
      name = token.slice("--name=".length);
    } else if (token === "--scope" || token?.startsWith("--scope=")) {
      const value = token === "--scope" ? rest[++i] : token.slice("--scope=".length);
      if (value !== "user" && value !== "project") {
        return {
          scope,
          yes,
          force,
          share,
          json,
          help,
          error: '"--scope" must be "user" or "project"',
        };
      }
      scope = value;
    } else if (runId === undefined && !token?.startsWith("-")) {
      runId = token;
    } else {
      return { scope, yes, force, share, json, help, error: `unknown argument "${token}"` };
    }
  }
  return { runId, name, scope, yes, force, share, json, help };
}

/** Options for {@link runSkillSynthesizeCommand}. */
export interface RunSkillSynthesizeOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly home: string;
  readonly env?: EnvMap;
  readonly now?: () => number;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
  /** Inject a runtime (tests only); a real CLI run builds one from disk. */
  readonly runtime?: ArcturnRuntime;
}

/**
 * `arcturn skill synthesize <runId> [...]`.
 *
 * @returns 0 saved (or previewed with `--json`), 1 error, 2 usage, 3 a human
 *   must re-run with `--yes` to save.
 */
export async function runSkillSynthesizeCommand(
  options: RunSkillSynthesizeOptions,
): Promise<number> {
  const out = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string) => void process.stderr.write(chunk));

  const parsed = parseSkillSynthesizeArgs(options.argv);
  if (parsed.help) {
    out(`${SKILL_SYNTHESIZE_USAGE}\n`);
    return 0;
  }
  if (parsed.error) {
    err(`arcturn: ${parsed.error}\n${SKILL_SYNTHESIZE_USAGE}\n`);
    return 2;
  }
  if (!parsed.runId) {
    err(`arcturn: skill synthesize needs a run id.\n${SKILL_SYNTHESIZE_USAGE}\n`);
    return 2;
  }

  const runtime =
    options.runtime ??
    (await buildRuntime({
      cwd: options.cwd,
      home: options.home,
      ...(options.env === undefined ? {} : { env: options.env }),
      extensions: false,
      skipRepoLookup: true,
      sessionTitles: false,
    }));

  const result = await synthesizeSkill({
    runtime,
    runId: parsed.runId,
    scope: parsed.scope,
    force: parsed.force,
    ...(parsed.name === undefined ? {} : { name: parsed.name }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!result.ok) {
    const hint = result.overridable ? " (retry with --force to override)" : "";
    err(`arcturn: ${result.error}${hint}\n`);
    return 1;
  }

  const { draft } = result;
  if (!parsed.yes) {
    // `--share` is about the DRAFT, not about the file: the proposal URL is
    // built from the same bytes either way, so a preview prints it too
    // rather than silently dropping the flag. Saving still needs `--yes`,
    // and the notice below says so in the same breath.
    if (parsed.json) {
      out(
        `${JSON.stringify({
          name: draft.name,
          path: skillFilePath(runtime, parsed.scope, draft.name),
          saved: false,
          content: draft.content,
          ...(parsed.share ? { url: shareUrlOnly(draft) } : {}),
        })}\n`,
      );
    } else {
      out(`${draft.content}\n`);
      if (parsed.share) out(`\n${renderSkillShare(draft).join("\n")}\n`);
    }
    const rerun = [
      "arcturn skill synthesize",
      parsed.runId,
      parsed.name ? `--name ${parsed.name}` : "",
      parsed.scope === "project" ? "--scope project" : "",
      parsed.share ? "--share" : "",
      "--yes",
    ]
      .filter((part) => part !== "")
      .join(" ");
    err(
      `arcturn: this is a preview; the skill was NOT saved${
        parsed.share ? " (the proposal link above is for this unsaved draft)" : ""
      }. Save it: ${rerun}\n`,
    );
    return 3;
  }

  const saved = await saveSkillDraft(runtime, draft, parsed.scope);
  if (!saved.ok) {
    err(`arcturn: ${saved.error}\n`);
    return 1;
  }

  if (parsed.json) {
    out(
      `${JSON.stringify({
        name: draft.name,
        path: saved.path,
        saved: true,
        ...(parsed.share ? { url: shareUrlOnly(draft) } : {}),
      })}\n`,
    );
    return 0;
  }

  out(`Saved "${draft.name}" to ${saved.path}. It is now available as /${draft.name}.\n`);
  if (parsed.share) out(`\n${renderSkillShare(draft).join("\n")}\n`);
  return 0;
}

/** The bare URL out of {@link renderSkillShare}, for `--json`'s `url` field. */
function shareUrlOnly(draft: SkillDraft): string {
  const rendered = renderSkillShare(draft);
  return rendered.at(-1) ?? "";
}

// --------------------------------------------------------------------------
// `/skills synthesize` (slash command)
// --------------------------------------------------------------------------

/**
 * `/skills synthesize <runId> [--name <n>] [--scope user|project] [--force]
 * [--share]` — the interactive twin of `arcturn skill synthesize`. Approval
 * is a picker rather than `--yes`; everything else (the evidence packet, the
 * drafting agent, the validation, `--share`'s printed-not-sent URL) is the
 * same {@link synthesizeSkill}/{@link saveSkillDraft} pipeline the CLI verb
 * uses, so the two can never drift on what counts as a valid draft.
 */
export function createSkillCommands(): SlashCommand[] {
  return [
    {
      name: "skills",
      description:
        "Turn a finished run into a skill: /skills synthesize <runId> " +
        "[--name <n>] [--scope user|project] [--force] [--share]",
      source: "built-in",
      async run({ runtime, ui, args }) {
        const tokens = args.split(/\s+/).filter((token) => token.length > 0);
        if (tokens[0] !== "synthesize") {
          ui.notice(
            "error",
            `Usage: /skills ${SKILL_SYNTHESIZE_USAGE.slice("Usage: arcturn skill ".length)}`,
          );
          return;
        }
        const parsed = parseSkillSynthesizeArgs(tokens.slice(1));
        if (parsed.error) {
          ui.notice("error", parsed.error);
          return;
        }
        if (!parsed.runId) {
          ui.notice(
            "error",
            `Usage: /skills ${SKILL_SYNTHESIZE_USAGE.slice("Usage: arcturn skill ".length)}`,
          );
          return;
        }

        const result = await synthesizeSkill({
          runtime,
          runId: parsed.runId,
          scope: parsed.scope,
          force: parsed.force,
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
        });
        if (!result.ok) {
          ui.notice(
            "error",
            `${result.error}${result.overridable ? " (retry with --force to override)" : ""}`,
          );
          return;
        }

        ui.print(result.draft.content);
        const approved = await ui.select<boolean>(`Save skill "${result.draft.name}"?`, [
          { value: "yes", label: `Save to ${result.draft.name}`, data: true },
          { value: "no", label: "Cancel", data: false },
        ]);
        if (approved !== true) {
          // Under --print, `ui.select` is refused and always returns
          // `undefined` here — a person is needed to approve the save.
          ui.needsHuman?.();
          // `--share` describes the draft, so the link is still worth having
          // even though nothing was written — the same call the top-level
          // verb's preview makes.
          if (parsed.share) ui.print(renderSkillShare(result.draft));
          ui.notice("info", "Cancelled — nothing was saved.");
          return;
        }

        const saved = await saveSkillDraft(runtime, result.draft, parsed.scope);
        if (!saved.ok) {
          ui.notice("error", saved.error);
          return;
        }
        ui.notice(
          "info",
          `Saved "${result.draft.name}" to ${saved.path}. It is now available as /${result.draft.name}.`,
        );
        if (parsed.share) ui.print(renderSkillShare(result.draft));
      },
    },
  ];
}

// --------------------------------------------------------------------------
// Post-run hint
// --------------------------------------------------------------------------

/**
 * A one-liner to show after a workflow run finishes clean, pointing at this
 * command. `undefined` for anything that did not end `"done"` — a paused,
 * failed or cancelled run has nothing yet worth turning into a skill.
 *
 * Exported for `workflow.ts`'s own post-run notice to call (see the
 * synthesis report for exactly where); this module never reaches into that
 * one to wire itself in.
 *
 * @param result - The finished run's result.
 * @param runId - The run's journal id, for the printed command.
 */
export function skillSynthesisHint(result: WorkflowRunResult, runId: string): string | undefined {
  if (result.status !== "done") return undefined;
  return `this run finished clean — \`arcturn skill synthesize ${runId}\` turns it into a reusable skill.`;
}
