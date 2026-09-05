/**
 * RUN RETROSPECTIVES — "self-improving kits".
 *
 * After a workflow run, `arcturn retro <runId>` / `/retro <runId>` reads that
 * run's durable journal (`workflow-run.ts`), the local insights ledger
 * (`insights.ts`) and the CURRENT content of the kit files the run actually
 * exercised — the workflow `.md` and every `@role` agent file a step
 * dispatched to — and asks a small, read-only sub-agent for the prompt or
 * stage fix the run's own evidence argues for.
 *
 * WHY EDIT BLOCKS, NOT A DIFF. The first cut of this asked the model for a
 * unified diff, and a live run against a real kit had every hunk rejected by
 * `git apply --check`. Two causes, both structural: the packet capped each
 * editable file at a few thousand characters, so the model authored hunks
 * against text it had never seen; and a hand-written unified diff is fragile
 * even when the text IS right — one miscounted `@@` line, one drifted context
 * line, and the whole patch is refused. So the model now returns
 * search/replace EDIT BLOCKS (see {@link parseEditBlocks}), which carry no
 * line numbers and no counts at all, and it gets the FULL text of every
 * editable file to copy from. This module resolves each block against the file
 * on disk, applies them in memory, and RENDERS the unified diff itself
 * ({@link renderUnifiedDiff}) — so the diff the operator approves is
 * mechanically derived from before/after texts rather than typed by a model.
 * `git apply --check` survives as a self-check of our own rendering.
 *
 * A block that does not match earns exactly ONE follow-up turn quoting the
 * failing text and the nearest line in the file; a second failure prints the
 * findings (the diagnosis is worth keeping even when the fix is not) and
 * refuses.
 *
 * Nothing here ever leaves the machine, matching every other seam in this
 * codebase: the evidence packet handed to the sub-agent is built from the
 * SAME whitelist the insights ledger already enforces (see
 * {@link buildPacket}) and deliberately never carries a `reasoningTail` — the
 * one field in a `LastTurnShape` that can hold model reasoning.
 *
 * @packageDocumentation
 */

import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentDef } from "./agents.js";
import { loadAgentDefs } from "./agents.js";
import type { CommandContext, SlashCommand } from "./commands.js";
import { formatCost, formatDuration, oneLine } from "./format.js";
import { type InsightsEvent, readInsightsLedger } from "./insights.js";
import { type EnvMap, resolveArcturnPaths } from "./paths.js";
import { type ArcturnRuntime, buildRuntime } from "./runtime.js";
import type { WorkflowRunResult } from "./workflow.js";
import {
  describeActivity,
  describeLastTurn,
  type JournalLine,
  type RunManifest,
  readJournalLines,
  readManifest,
  type StepEndLine,
  type StepFailAskLine,
} from "./workflow-run.js";

const execFileAsync = promisify(execFileCb);

/** Turn ceiling for the retro sub-agent — a read-only report, not a build. */
const RETRO_MAX_TURNS = 15;

/** Soft cap on the WHOLE packet (evidence plus every file's text), characters. */
const PACKET_BUDGET_CHARS = 60_000;

/** Soft cap on the evidence half of the packet, characters. */
const EVIDENCE_BUDGET_CHARS = 12_000;

/** Never leave the files less than this much of the packet, characters. */
const MIN_FILE_BUDGET_CHARS = 24_000;

/** How much of a step's `text`/`finalText` the packet carries, from the tail. */
const STEP_TEXT_TAIL_CHARS = 600;

/** Context lines around each hunk in the diff we render. Git's own default. */
const DIFF_CONTEXT_LINES = 3;

/** How often the "still thinking" progress line repeats while the model works. */
const PROGRESS_TICK_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}

async function safeReadFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * Locating the run
 * ------------------------------------------------------------------ */

/** One run's journal plus its (possibly absent) manifest header. */
export interface RetroRun {
  readonly runId: string;
  readonly manifest?: RunManifest;
  readonly lines: readonly JournalLine[];
}

async function loadRun(home: string, runId: string): Promise<RetroRun | undefined> {
  const dir = join(home, "workflow-runs", runId);
  const lines = await readJournalLines(dir);
  const manifest = await readManifest(dir);
  if (lines.length === 0 && manifest === undefined) return undefined;
  return { runId, manifest, lines };
}

function headerLine(run: RetroRun): Extract<JournalLine, { kind: "run" }> | undefined {
  for (const line of run.lines) if (line.kind === "run") return line;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Locating the kit sources
 * ------------------------------------------------------------------ */

/** One file the retro agent may propose an edit against. */
export interface EditableFile {
  /** Absolute, realpath-resolved path. */
  readonly abs: string;
  /** The tree this file was drawn from: `~/.arcturn` or `<cwd>/.arcturn`. */
  readonly root: string;
  /** Path relative to {@link EditableFile.root} — what the patch header names. */
  readonly rel: string;
  /** What an edit block must name: `rel`, prefixed with `project/` in the project tree. */
  readonly path: string;
  readonly kind: "workflow" | "role";
  /** Workflow name, or role name (without the `@`). */
  readonly name: string;
}

/** The whole editable surface for one run: its workflow file and every role it dispatched. */
export interface EditableSet {
  readonly files: readonly EditableFile[];
  /** The distinct roots the files sit in, in first-seen order. */
  readonly roots: readonly string[];
  /** The installed kit's package name, when the workflow lives under `~/.arcturn/packages/<pkg>`. */
  readonly packageName?: string;
  /** Non-fatal problems: a role file renamed/removed since the run, etc. */
  readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Prefix that distinguishes a project-tree path from a home-tree one. */
const PROJECT_PREFIX = "project/";

/** Home-tree directories a run's kit files may legitimately come from. */
const HOME_SUBTREES: readonly string[] = ["agents", "workflows", "packages"];

/**
 * A root-relative path in POSIX form, whatever the platform's separator is.
 *
 * WHY every internal key is `/`-separated. Two things downstream of the
 * editable set only ever speak POSIX: a unified diff's `--- a/<path>` header
 * (which `git apply` reads back with `/`), and the path a model writes on an
 * `<<<<<<< EDIT` line. On Windows `path.relative` hands back `agents\\x.md`,
 * and every one of those comparisons — the `HOME_SUBTREES` first segment, the
 * `relSet` membership check in {@link validateDiff}, the editable-path lookup
 * in {@link resolveEditBlocks} — then misses. Normalising once, here at the
 * boundary, is what keeps the rest of the module platform-blind.
 *
 * `path.join` accepts `/` on Windows, so a POSIX key is still safe to rejoin
 * with its root when a real filesystem call needs an absolute path.
 */
function toPosixRel(rel: string, separator: string = sep): string {
  return separator === "/" ? rel : rel.split(separator).join("/");
}

/**
 * The `node:path` surface {@link anchorFile} needs, injectable so the Windows
 * semantics can be asserted with `path.win32` from any platform.
 */
export interface AnchorPathOps {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
}

/**
 * Anchor one realpath-resolved file on the tree it came from.
 *
 * WHY not a common prefix. The editable set is drawn from TWO independent
 * trees — `~/.arcturn` (workflows, home roles, installed kit packages) and
 * `<cwd>/.arcturn` (roles a cloned repository ships) — and the moment a run
 * dispatches to one role from each, the longest shared directory prefix of
 * that set climbs above BOTH. In a real install that prefix is `$HOME`; with
 * the checkout on another top level (`/tmp`, `/Volumes`) it is `/`. Every
 * later step is anchored on it: `git apply --check` runs there, and the
 * scratch copy is `mkdir`ed there. Running git plumbing in `$HOME` (often a
 * dotfiles repo) or in `/` is not a place this feature intends to be, and a
 * hostile repository owns one member of the set, so it had partial say over
 * where retro operated.
 *
 * So the root is DECLARED, never derived: a file is either inside one of the
 * home subtrees or inside the project's `.arcturn`, or it is not editable at
 * all.
 *
 * @param abs - Realpath-resolved absolute path.
 * @param paths - The two trees.
 * @param ops - Path semantics; defaults to this platform's.
 * @returns The anchoring, or `undefined` when the file is outside both.
 */
export function anchorFile(
  abs: string,
  paths: { home: string; project: string },
  ops: AnchorPathOps = { sep, isAbsolute, relative },
): { root: string; rel: string; path: string } | undefined {
  const homeRel = toPosixRel(ops.relative(paths.home, abs), ops.sep);
  if (
    homeRel !== "" &&
    !homeRel.startsWith("..") &&
    !ops.isAbsolute(homeRel) &&
    HOME_SUBTREES.includes(homeRel.split("/")[0] as string)
  ) {
    return { root: paths.home, rel: homeRel, path: homeRel };
  }
  const projectRel = toPosixRel(ops.relative(paths.project, abs), ops.sep);
  if (projectRel !== "" && !projectRel.startsWith("..") && !ops.isAbsolute(projectRel)) {
    return {
      root: paths.project,
      rel: projectRel,
      path: `${PROJECT_PREFIX}${projectRel}`,
    };
  }
  return undefined;
}

/** Whether `abs` really is inside `root` — re-checked at apply time, not only at discovery. */
function insideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Every role a step in this run dispatched to. */
function roleNamesOf(run: RetroRun): Set<string> {
  const names = new Set<string>();
  for (const line of run.lines) {
    if ((line.kind === "stepEnd" || line.kind === "stepStart") && line.agent) names.add(line.agent);
  }
  return names;
}

/**
 * Resolve the editable file set for one run: its workflow `.md`, and every
 * `@role` markdown agent a step in it dispatched to.
 *
 * A file that no longer exists (a role renamed since the run, a workflow
 * deleted) is dropped with a warning rather than failing the whole command —
 * the retro can still propose fixes to whatever remains.
 */
async function discoverEditable(
  paths: { home: string; project: string },
  run: RetroRun,
): Promise<EditableSet> {
  const warnings: string[] = [];
  const roleNames = roleNamesOf(run);

  // Both trees are realpath-resolved because every editable file is: on macOS
  // a scratch `/var/...` home resolves to `/private/var/...`, and comparing a
  // resolved file against an unresolved root would place every file "outside"
  // both trees.
  const trees = {
    home: await realpath(paths.home).catch(() => paths.home),
    project: await realpath(paths.project).catch(() => paths.project),
  };

  const agentDefs = await loadAgentDefs(
    [join(paths.home, "agents"), join(paths.project, "agents")],
    warnings,
  );
  const byName = new Map(agentDefs.map((def) => [def.name, def] as const));

  const header = headerLine(run);
  const workflowName = run.manifest?.workflow ?? header?.workflow ?? "workflow";
  const wfSource = run.manifest?.source ?? header?.source;

  const entries: { abs: string; kind: "workflow" | "role"; name: string }[] = [];

  if (wfSource) {
    try {
      entries.push({ abs: await realpath(wfSource), kind: "workflow", name: workflowName });
    } catch {
      warnings.push(`workflow source "${wfSource}" no longer exists on disk`);
    }
  } else {
    warnings.push("this run's journal carries no workflow source path");
  }

  for (const name of [...roleNames].sort()) {
    const def = byName.get(name);
    if (!def) {
      warnings.push(
        `role "@${name}" has no discoverable agent file (renamed or removed since the run)`,
      );
      continue;
    }
    try {
      entries.push({ abs: await realpath(def.source), kind: "role", name });
    } catch {
      warnings.push(`role file "${def.source}" for @${name} no longer exists on disk`);
    }
  }

  const seen = new Set<string>();
  const deduped = entries.filter((entry) => {
    if (seen.has(entry.abs)) return false;
    seen.add(entry.abs);
    return true;
  });

  // Each file is anchored on the tree it came from; one that is in neither is
  // dropped with a warning rather than dragging the whole run's root up to
  // some parent directory nobody chose. See {@link anchorFile}.
  const files: EditableFile[] = [];
  const roots: string[] = [];
  for (const entry of deduped) {
    const anchored = anchorFile(entry.abs, trees);
    if (anchored === undefined) {
      warnings.push(
        `"${entry.abs}" is outside both ${trees.home} and ${trees.project}, so retro will not edit it`,
      );
      continue;
    }
    if (!roots.includes(anchored.root)) roots.push(anchored.root);
    files.push({ ...entry, ...anchored });
  }

  let packageName: string | undefined;
  const wfEntry = deduped.find((entry) => entry.kind === "workflow");
  if (wfEntry) {
    // Anchored on the RESOLVED home, because `wfEntry.abs` is resolved too: a
    // scratch `/var/...` home on macOS and a `\\?\\`-free realpath on Windows
    // both make a raw string prefix test miss.
    const pkgRoot = join(trees.home, "packages");
    const pkgRel = toPosixRel(relative(pkgRoot, wfEntry.abs));
    if (pkgRel !== "" && !pkgRel.startsWith("..") && !isAbsolute(pkgRel)) {
      const pkg = pkgRel.split("/")[0];
      if (pkg) {
        packageName = pkg;
        try {
          const raw = await readFile(join(pkgRoot, pkg, ".arcturn-install.json"), "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed) && typeof parsed.name === "string" && parsed.name !== "") {
            packageName = parsed.name;
          }
        } catch {
          // No install record (a hand-authored package, or one predating it) —
          // the directory name still names the package well enough.
        }
      }
    }
  }

  return { files, roots, ...(packageName === undefined ? {} : { packageName }), warnings };
}

/* ------------------------------------------------------------------ *
 * The evidence packet
 * ------------------------------------------------------------------ */

function latestStepEnds(lines: readonly JournalLine[]): Map<string, StepEndLine> {
  const map = new Map<string, StepEndLine>();
  for (const line of lines) if (line.kind === "stepEnd") map.set(line.id, line);
  return map;
}

function latestStepFailAsks(lines: readonly JournalLine[]): Map<string, StepFailAskLine> {
  const map = new Map<string, StepFailAskLine>();
  for (const line of lines) if (line.kind === "stepFailAsk") map.set(line.stepId, line);
  return map;
}

function parkCauseByStep(events: readonly InsightsEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of events) if (event.kind === "park") map.set(event.stepId, event.causeKind);
  return map;
}

function runHeader(run: RetroRun): { workflow: string; input: string; models: string[] } {
  const header = headerLine(run);
  const workflow = run.manifest?.workflow ?? header?.workflow ?? "?";
  const input = run.manifest?.input ?? header?.input ?? "";
  const models = new Set<string>();
  for (const line of run.lines) {
    if (line.kind === "stepEnd" && line.lastTurn?.model) models.add(line.lastTurn.model);
    else if (line.kind === "stepEnd" && line.modelTag) models.add(line.modelTag);
  }
  return { workflow, input, models: [...models] };
}

/**
 * Build the bounded evidence packet the retro sub-agent reads.
 *
 * EVERY field here comes from the run's own durable journal or the local
 * insights ledger — never from a raw session transcript — and a
 * `LastTurnShape`'s `reasoningTail` is never included: {@link
 * describeLastTurn}'s SECOND line (the only place a tail would appear) is
 * deliberately dropped, keeping only the one-line fact summary.
 */
function buildPacket(run: RetroRun, events: readonly InsightsEvent[]): string {
  const header = runHeader(run);
  const stepEnds = latestStepEnds(run.lines);
  const fails = latestStepFailAsks(run.lines);
  const causes = parkCauseByStep(events);
  const ids = [...stepEnds.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const lines: string[] = [];
  lines.push(`# Run ${run.runId}`);
  lines.push(`workflow: ${header.workflow}`);
  lines.push(`input: ${oneLine(header.input, 300)}`);
  lines.push(`models: ${header.models.join(", ") || "?"}`);
  lines.push("");
  lines.push("## Steps");
  for (const id of ids) {
    const step = stepEnds.get(id);
    if (!step) continue;
    const ask = fails.get(id);
    const cause = causes.get(id);
    const durationMs =
      step.startedAt !== undefined && step.endedAt !== undefined
        ? Math.max(0, step.endedAt - step.startedAt)
        : undefined;
    const cost = step.usage.costUsd !== undefined ? formatCost(step.usage.costUsd) : "unknown";
    lines.push(`### step ${id}${step.agent ? ` @${step.agent}` : ""} — ${step.status}`);
    lines.push(
      `attempts: ${step.attempts} · duration: ${durationMs === undefined ? "?" : formatDuration(durationMs)} · cost: ${cost}`,
    );
    if (ask?.failureKind) lines.push(`failureKind: ${ask.failureKind}`);
    if (cause) lines.push(`park cause: ${cause}`);
    if (ask?.cause) lines.push(`park question: ${oneLine(ask.cause, 300)}`);
    if (step.activity) lines.push(describeActivity(step.activity));
    if (step.lastTurn) {
      // Never the reasoning tail: `describeLastTurn`'s optional second line is
      // the only place one could appear, so only the first line ever reaches
      // the packet.
      lines.push(describeLastTurn(step.lastTurn).split("\n")[0] as string);
    }
    if (step.finalText) {
      lines.push(`finalText (tail): ${JSON.stringify(tail(step.finalText, STEP_TEXT_TAIL_CHARS))}`);
    }
    if (step.text) {
      lines.push(`text (tail): ${JSON.stringify(tail(step.text, STEP_TEXT_TAIL_CHARS))}`);
    }
    lines.push("");
  }
  if (events.length > 0) {
    lines.push("## Insights events for this run");
    for (const event of events) {
      if (event.kind === "silent-turn") {
        lines.push(
          `silent-turn: step ${event.stepId ?? "?"} @${event.role ?? "?"} model ${event.model} nudged=${event.nudged}`,
        );
      } else if (event.kind === "progress-warning") {
        lines.push(
          `progress-warning: step ${event.stepId ?? "?"} @${event.role ?? "?"} turn ${event.turnIndex}`,
        );
      } else if (event.kind === "park") {
        lines.push(`park: step ${event.stepId} @${event.role ?? "?"} cause ${event.causeKind}`);
      }
    }
    lines.push("");
  }
  return tail(lines.join("\n"), EVIDENCE_BUDGET_CHARS);
}

/**
 * Split `budget` characters across files by water-filling: a file shorter than
 * its fair share takes only what it needs and hands the rest back, so one
 * enormous role file cannot squeeze eight small ones down to stubs.
 *
 * @param sizes - Each file's full length in characters.
 * @param budget - Characters available for all of them together.
 * @returns How many characters of each file the packet may carry, in order.
 */
export function allocateFileBudget(sizes: readonly number[], budget: number): number[] {
  const allocated = sizes.map(() => 0);
  let remaining = Math.max(0, budget);
  let open = sizes.map((_, index) => index);
  while (open.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    if (share <= 0) break;
    const stillOpen: number[] = [];
    let used = 0;
    for (const index of open) {
      const size = sizes[index] as number;
      if (size <= share) {
        allocated[index] = size;
        used += size;
      } else {
        stillOpen.push(index);
      }
    }
    if (stillOpen.length === open.length) {
      // Everyone left wants more than its share: hand each exactly the share.
      for (const index of open) allocated[index] = share;
      return allocated;
    }
    remaining -= used;
    open = stillOpen;
  }
  return allocated;
}

/** One editable file plus the text the packet will actually show for it. */
interface PacketFile extends EditableFile {
  readonly content: string;
  readonly shown: string;
  readonly truncated: boolean;
}

/**
 * Decide what text the packet shows for each file: the FULL content whenever
 * it fits, and an explicitly-labelled prefix when it cannot. Truncating in
 * silence is what made the first live retro author edits against text it had
 * never been shown.
 */
function planPacketFiles(
  contents: readonly (EditableFile & { content: string })[],
  evidenceChars: number,
): PacketFile[] {
  const budget = Math.max(MIN_FILE_BUDGET_CHARS, PACKET_BUDGET_CHARS - evidenceChars);
  const allocated = allocateFileBudget(
    contents.map((file) => file.content.length),
    budget,
  );
  return contents.map((file, index) => {
    const cap = allocated[index] as number;
    const truncated = file.content.length > cap;
    return {
      ...file,
      shown: truncated ? file.content.slice(0, cap) : file.content,
      truncated,
    };
  });
}

/** A worked example of the reply format, so the model has a shape to copy. */
const EDIT_BLOCK_EXAMPLE = [
  "<<<<<<< EDIT agents/reviewer.md",
  "You are the reviewer. Read the change and leave comments.",
  "=======",
  "You are the reviewer. Read the change and leave comments.",
  "Write review.md within your first 20 turns; do not keep reading after that.",
  ">>>>>>> END",
].join("\n");

/** Build the full task text: the packet, the file content, and the edit-block contract. */
function buildTask(packet: string, editable: EditableSet, files: readonly PacketFile[]): string {
  const fileList = editable.files
    .map((f) => `- ${f.path} (${f.kind}${f.kind === "role" ? ` @${f.name}` : ""})`)
    .join("\n");

  const fileSections = files
    .map((f) => {
      const note = f.truncated
        ? `\n(TRUNCATED: this is the first ${f.shown.length} of ${f.content.length} characters of ` +
          "this file; the rest was not shown to you. Only propose edits inside the text shown " +
          "above — never quote or edit anything past the cut.)"
        : "";
      return `### ${f.path} (${f.kind}${f.kind === "role" ? ` @${f.name}` : ""})\n\`\`\`\n${f.shown}\n\`\`\`${note}`;
    })
    .join("\n\n");

  return [
    "You are a run retrospective agent for the Arcturn workflow engine.",
    "Below is the evidence from ONE completed workflow run: what each step did, how it",
    "failed or parked, and what the model's last turn looked like. Your job is to find the",
    "prompt or stage defects that evidence argues for, and propose the SMALLEST edits to the",
    "kit files that would fix them for the next run.",
    "",
    `Editable files${editable.packageName ? ` (package "${editable.packageName}")` : ""}, named`,
    `exactly as you must spell them (a \`${PROJECT_PREFIX}\` prefix means the file lives in this`,
    "project's own `.arcturn`; the rest live in the arcturn home):",
    fileList,
    "",
    "You may propose changes to ONLY the files listed above, and nothing else. Never create",
    "or delete a file, never rename one, never touch a binary file.",
    "",
    "=== EVIDENCE ===",
    packet,
    "=== END EVIDENCE ===",
    "",
    "=== EDITABLE FILES: CURRENT CONTENT ===",
    fileSections,
    "=== END CURRENT CONTENT ===",
    "",
    "Reply in EXACTLY this format, nothing before or after it:",
    "",
    "## Findings",
    "- 3 to 6 bullets. Each ties a specific piece of evidence above to a specific prompt or",
    "  stage defect — name the step, the role, the failure kind or the model behavior, and",
    "  the sentence in the file that is the problem.",
    "",
    "## Edits",
    "One or more EDIT BLOCKS, each exactly like this, with no other text between them:",
    "",
    EDIT_BLOCK_EXAMPLE,
    "",
    "Rules for edit blocks — read them twice, they are the whole contract:",
    "- The path on the `<<<<<<< EDIT` line is one of the editable paths listed above,",
    "  spelled exactly as listed. Nothing else is accepted.",
    "- The text between `<<<<<<< EDIT` and `=======` is EXISTING text COPIED VERBATIM from",
    "  the file content shown above: same words, same punctuation, same indentation. Do not",
    "  retype it from memory and do not reformat it.",
    "- That text must appear EXACTLY ONCE in the file. If the line you want is not unique,",
    "  include the lines above and below it until the block is unique. Keep it under about",
    "  12 lines.",
    "- The text between `=======` and `>>>>>>> END` is what those lines become. To insert",
    "  text, repeat the existing lines and add yours; to delete, leave that half empty.",
    "- Write NO line numbers, NO `@@` headers, NO `+`/`-` prefixes. This is not a diff.",
    "- Several blocks may touch the same file; they are applied in the order you write them.",
    "",
    "## Risk",
    "One paragraph: what could go wrong if these edits land, and how confident you are.",
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Edit blocks: parsing
 * ------------------------------------------------------------------ */

/** One search/replace edit the model proposed. */
export interface EditBlock {
  /** 1-based position in the reply, for error messages. */
  readonly index: number;
  /** Path as written on the `<<<<<<< EDIT` line, relative to the editable root. */
  readonly path: string;
  /** Text to find, newlines normalized to LF, no trailing newline. */
  readonly search: string;
  /** Text to put in its place, same normalization. */
  readonly replace: string;
}

const EDIT_OPEN = /^<{7}\s*EDIT\s+(.+?)\s*$/;
const EDIT_SPLIT = /^={7}\s*$/;
const EDIT_CLOSE = /^>{7}\s*END\s*$/;

/**
 * Pull every edit block out of a model reply.
 *
 * Line-based and line-ending agnostic on purpose: a model that emits CRLF (or
 * mixes the two) must not silently produce search text that can never match an
 * LF file. An unterminated block is reported as a warning rather than
 * salvaged — half a block is a guess about what the model meant.
 *
 * @param text - The whole reply.
 * @returns The blocks in reply order, plus `line N: message` warnings.
 */
export function parseEditBlocks(text: string): { blocks: EditBlock[]; warnings: string[] } {
  const lines = text.split(/\r?\n/);
  const blocks: EditBlock[] = [];
  const warnings: string[] = [];
  let index = 0;

  for (let i = 0; i < lines.length; i++) {
    const open = EDIT_OPEN.exec(lines[i] as string);
    if (!open) continue;
    const path = (open[1] as string).trim();
    const openLine = i + 1;
    const search: string[] = [];
    const replace: string[] = [];
    let seenSplit = false;
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j] as string;
      if (EDIT_CLOSE.test(line)) {
        closed = true;
        break;
      }
      if (!seenSplit && EDIT_SPLIT.test(line)) {
        seenSplit = true;
        continue;
      }
      (seenSplit ? replace : search).push(line);
    }
    if (!closed) {
      warnings.push(`line ${openLine}: edit block for "${path}" has no ">>>>>>> END" line`);
      break;
    }
    if (!seenSplit) {
      warnings.push(`line ${openLine}: edit block for "${path}" has no "=======" separator`);
      i = j;
      continue;
    }
    if (path === "") {
      warnings.push(`line ${openLine}: edit block names no file`);
      i = j;
      continue;
    }
    index++;
    blocks.push({ index, path, search: search.join("\n"), replace: replace.join("\n") });
    i = j;
  }
  return { blocks, warnings };
}

/* ------------------------------------------------------------------ *
 * Edit blocks: resolving against the files on disk
 * ------------------------------------------------------------------ */

/** One edit that resolved to exactly one place in its file. */
export interface ResolvedEdit {
  readonly path: string;
  readonly matched: true;
}

/** One edit that did not, and why. */
export interface FailedEdit {
  readonly block: EditBlock;
  readonly reason: string;
}

/** Outcome of {@link resolveEditBlocks}. */
export type ResolveResult =
  | { readonly ok: true; readonly edits: ResolvedEdit[]; readonly after: Map<string, string> }
  | { readonly ok: false; readonly failures: FailedEdit[] };

/** Count occurrences of `needle`, counting overlaps — an ambiguous match must never read as unique. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + 1;
  }
}

function trigrams(text: string): Set<string> {
  const normalized = text.trim().toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i++) set.add(normalized.slice(i, i + 3));
  return set;
}

/** Crude 0..1 similarity, only ever used to pick the line quoted back as a hint. */
function similarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return a.trim() === b.trim() ? 1 : 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / Math.max(left.size, right.size);
}

/**
 * The line in `content` that most resembles the block's first line, quoted
 * back as `nearest text is line N: "…"`.
 *
 * A model that mis-copies text almost always mis-copies it slightly, so
 * showing the real line beside its own attempt is the single most useful thing
 * a retry turn can carry.
 */
function nearestLineHint(content: string, search: string): string {
  const wanted = (search.split("\n").find((line) => line.trim() !== "") ?? "").trim();
  if (wanted === "") return "";
  const lines = content.split("\n");
  let bestScore = 0;
  let bestIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(wanted, lines[i] as string);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex === -1 || bestScore < 0.2) return "";
  return `nearest text is line ${bestIndex + 1}: ${JSON.stringify(oneLine(lines[bestIndex] as string, 200))}`;
}

/** Lines equal once trailing whitespace (a stray space, a stray CR) is ignored. */
function looseEqual(a: string, b: string): boolean {
  return a.replace(/\s+$/, "") === b.replace(/\s+$/, "");
}

/** Every start offset where `search` matches `lines` ignoring trailing whitespace. */
function looseMatches(lines: readonly string[], search: readonly string[]): number[] {
  const hits: number[] = [];
  if (search.length === 0 || search.length > lines.length) return hits;
  for (let i = 0; i + search.length <= lines.length; i++) {
    let all = true;
    for (let k = 0; k < search.length; k++) {
      if (!looseEqual(lines[i + k] as string, search[k] as string)) {
        all = false;
        break;
      }
    }
    if (all) hits.push(i);
  }
  return hits;
}

/**
 * Resolve every block against the current file texts, in order, applying each
 * to the running text so two blocks may touch the same file.
 *
 * All-or-nothing: one unmatched block refuses the whole proposal, and EVERY
 * failing block is reported (a retry turn that fixed one block at a time would
 * burn the single follow-up this feature allows).
 *
 * @param blocks - The parsed blocks, in reply order.
 * @param files - Editable path to its current content on disk.
 */
export function resolveEditBlocks(
  blocks: readonly EditBlock[],
  files: ReadonlyMap<string, string>,
): ResolveResult {
  const working = new Map(files);
  const edits: ResolvedEdit[] = [];
  const failures: FailedEdit[] = [];

  for (const block of blocks) {
    const content = working.get(block.path);
    if (content === undefined) {
      failures.push({ block, reason: `"${block.path}" is not one of this run's editable files` });
      continue;
    }
    if (block.search.trim() === "") {
      failures.push({ block, reason: "the search half of the block is empty" });
      continue;
    }

    // 1. Exact text, LF and CRLF alike — the common case, and the only one
    //    that leaves every byte outside the edit untouched.
    const candidates =
      content.includes("\r\n") && !block.search.includes("\r\n")
        ? [
            {
              search: block.search.replace(/\n/g, "\r\n"),
              replace: block.replace.replace(/\n/g, "\r\n"),
            },
            { search: block.search, replace: block.replace },
          ]
        : [{ search: block.search, replace: block.replace }];
    let exactCount = 0;
    let applied = false;
    for (const candidate of candidates) {
      const count = countOccurrences(content, candidate.search);
      exactCount = Math.max(exactCount, count);
      if (count !== 1) continue;
      const at = content.indexOf(candidate.search);
      working.set(
        block.path,
        content.slice(0, at) + candidate.replace + content.slice(at + candidate.search.length),
      );
      edits.push({ path: block.path, matched: true });
      applied = true;
      break;
    }
    if (applied) continue;
    if (exactCount > 1) {
      failures.push({
        block,
        reason:
          `search text matched ${exactCount} times in ${block.path} (it must match exactly once) — ` +
          "include the lines above and below it so the block is unique",
      });
      continue;
    }

    // 2. Same lines, ignoring trailing whitespace. A model that copies text
    //    faithfully but drops a trailing space should not lose the run.
    const lines = content.split("\n");
    const searchLines = block.search.split("\n");
    const hits = looseMatches(lines, searchLines);
    if (hits.length === 1) {
      const at = hits[0] as number;
      working.set(
        block.path,
        [
          ...lines.slice(0, at),
          ...block.replace.split("\n"),
          ...lines.slice(at + searchLines.length),
        ].join("\n"),
      );
      edits.push({ path: block.path, matched: true });
      continue;
    }
    const hint = nearestLineHint(content, block.search);
    failures.push({
      block,
      reason:
        `search text matched ${hits.length} times in ${block.path} (it must match exactly once)` +
        (hits.length === 0
          ? ` — copy the text verbatim from the file${hint === "" ? "" : `; ${hint}`}`
          : " — include the lines above and below it so the block is unique"),
    });
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, edits, after: working };
}

/* ------------------------------------------------------------------ *
 * Rendering the unified diff ourselves
 * ------------------------------------------------------------------ */

/** Beyond this many LCS cells, fall back to "delete everything, add everything". */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Marks the last line of a text that does NOT end in a newline, so a final
 * line with a newline can never be matched against one without — the case that
 * silently renders an off-by-one diff `git apply` then rejects.
 */
const NO_FINAL_NEWLINE = "arcturn-no-final-newline";

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** Split a file into diffable lines, tagging a missing final newline. */
function splitForDiff(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
    return lines;
  }
  lines[lines.length - 1] = `${lines[lines.length - 1] as string}${NO_FINAL_NEWLINE}`;
  return lines;
}

type DiffOpType = "equal" | "add" | "del";
interface DiffOp {
  readonly type: DiffOpType;
  readonly value: string;
}

/**
 * Line-level diff via a classic LCS dynamic-programming table, with a coarse
 * "delete everything, add everything" fallback once the table would exceed
 * {@link MAX_LCS_CELLS}. Both outputs are correct patches; only the second is
 * ugly.
 */
function diffOps(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((value): DiffOp => ({ type: "del", value })),
      ...newLines.map((value): DiffOp => ({ type: "add", value })),
    ];
  }
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array;
    const next = dp[i + 1] as Uint32Array;
    const oldLine = oldLines[i] as string;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        oldLine === newLines[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = oldLines[i] as string;
    const newLine = newLines[j] as string;
    if (oldLine === newLine) {
      ops.push({ type: "equal", value: oldLine });
      i++;
      j++;
    } else if (
      ((dp[i + 1] as Uint32Array)[j] as number) >= ((dp[i] as Uint32Array)[j + 1] as number)
    ) {
      ops.push({ type: "del", value: oldLine });
      i++;
    } else {
      ops.push({ type: "add", value: newLine });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", value: oldLines[i++] as string });
  while (j < m) ops.push({ type: "add", value: newLines[j++] as string });
  return ops;
}

function emitBody(prefix: string, value: string, out: string[]): void {
  if (value.endsWith(NO_FINAL_NEWLINE)) {
    out.push(`${prefix}${value.slice(0, -NO_FINAL_NEWLINE.length)}`);
    out.push(NO_NEWLINE_MARKER);
    return;
  }
  out.push(`${prefix}${value}`);
}

/** Render `ops` as unified-diff hunks, `@@` headers included. */
function renderHunks(ops: readonly DiffOp[], context: number): string[] {
  const runs: [number, number][] = [];
  let scan = 0;
  while (scan < ops.length) {
    if ((ops[scan] as DiffOp).type === "equal") {
      scan++;
      continue;
    }
    let end = scan;
    while (end < ops.length && (ops[end] as DiffOp).type !== "equal") end++;
    const last = runs[runs.length - 1];
    if (last && scan - last[1] <= context * 2) last[1] = end;
    else runs.push([scan, end]);
    scan = end;
  }
  if (runs.length === 0) return [];

  const oldNo: number[] = new Array(ops.length);
  const newNo: number[] = new Array(ops.length);
  let ol = 1;
  let nl = 1;
  for (let k = 0; k < ops.length; k++) {
    oldNo[k] = ol;
    newNo[k] = nl;
    const op = ops[k] as DiffOp;
    if (op.type !== "add") ol++;
    if (op.type !== "del") nl++;
  }

  const lines: string[] = [];
  for (const [start, end] of runs) {
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length, end + context);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = from; k < to; k++) {
      const op = ops[k] as DiffOp;
      if (op.type === "equal") {
        emitBody(" ", op.value, body);
        oldCount++;
        newCount++;
      } else if (op.type === "del") {
        emitBody("-", op.value, body);
        oldCount++;
      } else {
        emitBody("+", op.value, body);
        newCount++;
      }
    }
    // A zero-length range is anchored at the line BEFORE it, which is how git
    // writes an insertion into an empty file.
    const oldStart =
      oldCount === 0 ? Math.max(0, (oldNo[from] as number) - 1) : (oldNo[from] as number);
    const newStart =
      newCount === 0 ? Math.max(0, (newNo[from] as number) - 1) : (newNo[from] as number);
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
  }
  return lines;
}

/**
 * Render a real unified diff for ONE file from its before and after texts.
 *
 * This is the only place a diff is authored in this module: the model never
 * writes one, so hunk headers, line counts and context are right by
 * construction rather than by luck.
 *
 * @param rel - Path for the `---`/`+++` header, relative to the patch root.
 * @param before - The file exactly as it is on disk.
 * @param after - The file after every resolved edit block.
 * @returns The diff, or `""` when the texts are identical.
 */
export function renderUnifiedDiff(rel: string, before: string, after: string): string {
  if (before === after) return "";
  const body = renderHunks(diffOps(splitForDiff(before), splitForDiff(after)), DIFF_CONTEXT_LINES);
  if (body.length === 0) return "";
  return [`--- a/${rel}`, `+++ b/${rel}`, ...body].join("\n");
}

/** One root's own patch: rendered, checked and applied inside that root and nowhere else. */
export interface RootPatch {
  /** The tree this patch is anchored on. */
  readonly root: string;
  /** The unified diff, whose headers are paths relative to {@link RootPatch.root}. */
  readonly diff: string;
  /** Root-relative paths the diff touches — what `git apply` resolves. */
  readonly files: readonly string[];
  /** The same files as an edit block spells them, in the same order. */
  readonly paths: readonly string[];
}

/**
 * Render ONE patch per root, in editable-set order.
 *
 * Per root because a unified diff has no way to say which directory a header
 * path is relative to: `git apply` resolves it against its own cwd. Two trees
 * therefore mean two patches, each checked and applied inside the tree its
 * headers belong to.
 */
function renderPatch(
  files: readonly EditableFile[],
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): { diff: string; files: string[]; patches: RootPatch[] } {
  const byRoot = new Map<string, { parts: string[]; rels: string[]; paths: string[] }>();
  const touched: string[] = [];
  for (const file of files) {
    const from = before.get(file.path) ?? "";
    const to = after.get(file.path) ?? from;
    const diff = renderUnifiedDiff(file.rel, from, to);
    if (diff === "") continue;
    const bucket = byRoot.get(file.root) ?? { parts: [], rels: [], paths: [] };
    bucket.parts.push(diff);
    bucket.rels.push(file.rel);
    bucket.paths.push(file.path);
    byRoot.set(file.root, bucket);
    touched.push(file.path);
  }
  const patches: RootPatch[] = [...byRoot.entries()].map(([root, bucket]) => ({
    root,
    diff: bucket.parts.join("\n"),
    files: bucket.rels,
    paths: bucket.paths,
  }));
  return { diff: patches.map((patch) => patch.diff).join("\n"), files: touched, patches };
}

/* ------------------------------------------------------------------ *
 * Parsing the agent's reply
 * ------------------------------------------------------------------ */

interface ParsedRetroReply {
  readonly findings: string;
  readonly risk: string;
  readonly blocks: EditBlock[];
  readonly blockWarnings: string[];
}

function parseRetroReply(text: string): ParsedRetroReply {
  const findingsMatch = text.match(
    /##\s*Findings\s*\n([\s\S]*?)(?=\n##\s*(?:Edits|Patch|Risk)\b|\n<{7}\s*EDIT\b|$)/i,
  );
  const riskMatch = text.match(/##\s*Risk\s*\n([\s\S]*?)$/i);
  const { blocks, warnings } = parseEditBlocks(text);
  return {
    findings: (findingsMatch?.[1] ?? text).trim(),
    risk: (riskMatch?.[1] ?? "").trim(),
    blocks,
    blockWarnings: warnings,
  };
}

/**
 * The ONE follow-up turn a failed resolution earns: every failing block quoted
 * back with its reason and the nearest real text, and a demand for the
 * complete corrected set (re-resolving from scratch is far safer than merging
 * a partial correction into a half-applied working copy).
 */
function buildRetryPrompt(failures: readonly FailedEdit[]): string {
  const lines: string[] = [
    `${failures.length} of your edit blocks could not be applied, so NOTHING was applied.`,
    "Each block's search text must appear in the file exactly once, copied verbatim from the",
    "file content in my first message. Here is what went wrong:",
    "",
  ];
  for (const failure of failures) {
    lines.push(`--- block ${failure.block.index} (${failure.block.path}) ---`);
    lines.push(`reason: ${failure.reason}`);
    lines.push("the search text you sent was:");
    lines.push(failure.block.search);
    lines.push("");
  }
  lines.push(
    "Reply with the COMPLETE corrected set of edit blocks — all of them, including any that",
    "did match — in the same `<<<<<<< EDIT path` / `=======` / `>>>>>>> END` format, and",
    "nothing else. Copy the search text character for character from the file content above.",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Validating the rendered patch
 * ------------------------------------------------------------------ */

type DiffParseResult = { ok: true; files: string[] } | { ok: false; reason: string };

/** Parse `--- `/`+++ ` file header pairs out of a unified diff, rejecting anything unsafe. */
function parseDiffFiles(diff: string): DiffParseResult {
  const lines = diff.split(/\r?\n/);
  const files: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^Binary files |^GIT binary patch/.test(line)) {
      return { ok: false, reason: "diff contains a binary patch, which retro refuses" };
    }
    if (!line.startsWith("--- ")) continue;
    const next = lines[i + 1];
    if (next === undefined || !next.startsWith("+++ ")) {
      return { ok: false, reason: `malformed diff: a "---" header has no matching "+++"` };
    }
    const oldRaw = line.slice(4).trim().split("\t")[0] ?? "";
    const newRaw = next.slice(4).trim().split("\t")[0] ?? "";
    if (oldRaw === "/dev/null" || newRaw === "/dev/null") {
      return {
        ok: false,
        reason: "diff creates or deletes a file; retro only edits existing kit files in place",
      };
    }
    const oldPath = oldRaw.replace(/^a\//, "");
    const newPath = newRaw.replace(/^b\//, "");
    if (oldPath !== newPath) {
      return {
        ok: false,
        reason: `diff renames "${oldPath}" to "${newPath}"; retro only edits files in place`,
      };
    }
    if (oldPath === "" || oldPath.split("/").includes("..")) {
      return { ok: false, reason: `diff path "${oldPath}" is empty or escapes its root` };
    }
    files.push(oldPath);
    i++; // the "+++" line is consumed with its "---" pair
  }
  if (files.length === 0) return { ok: false, reason: "diff contains no file headers" };
  return { ok: true, files: [...new Set(files)] };
}

/**
 * Git flags that make `apply` move bytes and nothing else.
 *
 * WHY. Git for Windows ships `core.autocrlf=true` by default, so a plain `git
 * apply` rewrites the line endings of every line it touches — and retro's
 * whole contract is that the file after the patch is the file before it plus
 * the resolved edit blocks, byte for byte. The diff is rendered from the
 * file's own bytes (a CRLF file's lines carry their `\r`), so any EOL filter
 * between the patch and the disk turns a correct patch into a whole-file
 * rewrite, or into a `git apply --check` failure. Pinned per-invocation rather
 * than trusted from the user's config.
 */
export const GIT_LITERAL_BYTES: readonly string[] = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
];

type ValidateResult = { ok: true; files: string[] } | { ok: false; reason: string };

/**
 * Self-check the patch we rendered: every touched path must be one of the
 * run's own editable files, no creation/deletion/rename/binary hunk, and `git
 * apply --check` must accept it against the files exactly as they are on disk
 * right now.
 *
 * Now that the diff is rendered from the real before/after texts, a failure
 * here is a bug in OUR renderer rather than a mis-typed model patch — which is
 * exactly why the check stays: it is the assertion that keeps such a bug from
 * ever reaching a file.
 */
async function validateDiff(patch: RootPatch, editable: EditableSet): Promise<ValidateResult> {
  const parsed = parseDiffFiles(patch.diff);
  if (!parsed.ok) return parsed;
  const relSet = new Set(editable.files.filter((f) => f.root === patch.root).map((f) => f.rel));
  for (const rel of parsed.files) {
    if (!relSet.has(rel)) {
      return {
        ok: false,
        reason: `diff touches "${rel}", which is not one of this run's editable files`,
      };
    }
    // The rel came from our own renderer, but the file it names is what a
    // symlink could have been pointed elsewhere since discovery.
    if (!insideRoot(patch.root, await realpath(join(patch.root, rel)).catch(() => ""))) {
      return { ok: false, reason: `"${rel}" resolves outside ${patch.root}; refusing to patch it` };
    }
  }
  const tmpDir = await mkdtemp(join(tmpdir(), "arcturn-retro-check-"));
  try {
    const patchFile = join(tmpDir, "patch.diff");
    await writeFile(patchFile, patch.diff.endsWith("\n") ? patch.diff : `${patch.diff}\n`, "utf8");
    try {
      await execFileAsync("git", [...GIT_LITERAL_BYTES, "apply", "--check", patchFile], {
        cwd: patch.root,
      });
    } catch (error) {
      const stderr = (error as { stderr?: string } | undefined)?.stderr;
      const detail = stderr && stderr.trim() !== "" ? stderr.trim() : errorMessage(error);
      return { ok: false, reason: `git apply --check failed: ${detail}` };
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  return { ok: true, files: parsed.files };
}

/**
 * Apply one root's already-validated patch, writing each touched file atomically.
 *
 * `git apply` runs against a scratch copy of the touched files nested INSIDE
 * that patch's own root (so it shares its filesystem), and each patched copy
 * is then `rename`d over the real file — an atomic replace, never a partial
 * write a crash could catch mid-way. The root is a tree retro was handed
 * (`~/.arcturn` or `<cwd>/.arcturn`), never a directory derived from where the
 * files happened to sit: see {@link anchorFile}.
 */
async function applyRootPatch(patch: RootPatch): Promise<string[]> {
  const scratch = join(patch.root, `.retro-apply-${process.pid}-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  try {
    for (const rel of patch.files) {
      const target = join(patch.root, rel);
      // Last check before anything is read or written: a file swapped for a
      // symlink out of the tree between validation and now must not be
      // followed by the `rename` below.
      const resolved = await realpath(target).catch(() => "");
      if (!insideRoot(patch.root, resolved)) {
        throw new Error(`"${rel}" resolves outside ${patch.root}; refusing to write it`);
      }
      const dst = join(scratch, rel);
      await mkdir(dirname(dst), { recursive: true });
      await writeFile(dst, await readFile(target, "utf8"), "utf8");
    }
    const patchFile = join(scratch, "__retro__.patch");
    await writeFile(patchFile, patch.diff.endsWith("\n") ? patch.diff : `${patch.diff}\n`, "utf8");
    try {
      await execFileAsync("git", [...GIT_LITERAL_BYTES, "apply", "__retro__.patch"], {
        cwd: scratch,
      });
    } catch (error) {
      const stderr = (error as { stderr?: string } | undefined)?.stderr;
      throw new Error(
        `git apply failed while landing the patch: ${stderr && stderr.trim() !== "" ? stderr.trim() : errorMessage(error)}`,
      );
    }
    const applied: string[] = [];
    for (const rel of patch.files) {
      await rename(join(scratch, rel), join(patch.root, rel));
      applied.push(rel);
    }
    return applied;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Apply every root's patch, one root at a time.
 *
 * @param patches - The per-root patches from a validated {@link RetroResult}.
 * @returns The applied paths, spelled the way the edit blocks named them.
 */
async function applyRetroPatch(patches: readonly RootPatch[]): Promise<string[]> {
  const applied: string[] = [];
  for (const patch of patches) {
    for (const rel of await applyRootPatch(patch)) {
      const at = patch.files.indexOf(rel);
      applied.push(at === -1 ? rel : (patch.paths[at] as string));
    }
  }
  return applied;
}

/** Write `<runId>/retro.md` beside the run's journal, best-effort. */
async function saveRetroNote(
  home: string,
  runId: string,
  result: RetroResult,
  applied: boolean,
): Promise<void> {
  const dir = join(home, "workflow-runs", runId);
  const body = [
    `# Retro — ${runId}`,
    `applied: ${applied ? "yes" : "no"}`,
    `at: ${new Date().toISOString()}`,
    "",
    "## Findings",
    result.findings ?? "",
    "",
    "## Patch",
    "```diff",
    result.diff ?? "",
    "```",
    "",
    "## Risk",
    result.risk ?? "",
    "",
  ].join("\n");
  try {
    const tmp = join(dir, `.retro.md.tmp-${Date.now()}`);
    await writeFile(tmp, body, "utf8");
    await rename(tmp, join(dir, "retro.md"));
  } catch {
    // The note is a convenience; its absence never fails the command.
  }
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/** Outcome of {@link computeRetro}. */
export interface RetroResult {
  readonly status: "unknown-run" | "invalid" | "ok";
  readonly findings?: string;
  /** The unified diff RENDERED here from the resolved edits — never model text. */
  readonly diff?: string;
  readonly risk?: string;
  /**
   * One patch per tree the edits touch, each anchored on that tree — never on
   * a derived common prefix. See {@link anchorFile}.
   */
  readonly patches?: readonly RootPatch[];
  /** The files the patch touches, spelled the way an edit block names them. */
  readonly files?: readonly string[];
  /** One entry per edit block that resolved to exactly one place in its file. */
  readonly edits?: readonly ResolvedEdit[];
  /** Populated when `status` is `"invalid"`. */
  readonly reason?: string;
  readonly editableWarnings?: readonly string[];
}

/** Options for {@link computeRetro}. */
export interface ComputeRetroOptions {
  readonly home: string;
  readonly project: string;
  readonly runId: string;
  /** The runtime whose `createSubagent` drives the read-only retro agent. */
  readonly runtime: ArcturnRuntime;
  /** Model override; `undefined` uses the runtime's own subagent route. */
  readonly model?: string;
  /**
   * Phase reporter. A retro is a single model call that can run for minutes;
   * without this the command prints NOTHING for the whole time and reads as a
   * hang. Never stdout under `--json` — the caller decides where it lands.
   */
  readonly onProgress?: (line: string) => void;
}

const RETRO_SYSTEM_PROMPT =
  "You are a careful, read-only retrospective agent for the Arcturn workflow engine. You " +
  "investigate why one workflow run went wrong — a park, a failure, a silent or thrashing " +
  "step — and propose the smallest edits to its kit files that would fix it for next time. " +
  "You never invent evidence beyond what you are given, you never touch a file outside the " +
  "editable set named in your task, and you express every change as a search/replace edit " +
  "block whose search text is copied verbatim from the file content you were shown — never " +
  "as a diff, and never as a rewrite.";

/** Human name for the model the sub-agent will actually run on, for the progress line. */
function describeModel(runtime: ArcturnRuntime, model: string | undefined): string {
  try {
    if (model === undefined) return runtime.router.specFor("subagent").id;
    if (model.startsWith("tier:")) return runtime.router.specForTier(model.slice(5).trim()).id;
    return model;
  } catch {
    return model ?? "the subagent model";
  }
}

function countFindings(findings: string): number {
  return findings.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

/**
 * Read one run's journal and insights, and ask a read-only sub-agent for the
 * edits its evidence argues for. Never applies anything — see the CLI/slash
 * entry points below for the approval-gated apply step.
 */
export async function computeRetro(options: ComputeRetroOptions): Promise<RetroResult> {
  const progress = options.onProgress ?? ((): void => {});

  const run = await loadRun(options.home, options.runId);
  if (!run) return { status: "unknown-run" };

  const stepCount = latestStepEnds(run.lines).size;
  const roleCount = roleNamesOf(run).size;
  progress(
    `retro: reading run ${options.runId} (${stepCount} step${stepCount === 1 ? "" : "s"}, ` +
      `${roleCount} role${roleCount === 1 ? "" : "s"})`,
  );

  const editable = await discoverEditable({ home: options.home, project: options.project }, run);
  if (editable.files.length === 0) {
    return {
      status: "invalid",
      reason:
        "no editable file could be resolved for this run (its workflow and role sources are missing)",
      editableWarnings: editable.warnings,
    };
  }

  const contents = await Promise.all(
    editable.files.map(async (f) => ({ ...f, content: await safeReadFile(f.abs) })),
  );

  const ledger = await readInsightsLedger(options.home).catch(() => ({
    events: [] as InsightsEvent[],
    skippedLines: 0,
  }));
  const events = ledger.events.filter(
    (event): event is InsightsEvent & { runId: string } =>
      "runId" in event && event.runId === options.runId,
  );

  const packet = buildPacket(run, events);
  const planned = planPacketFiles(contents, packet.length);
  const totalChars = contents.reduce((sum, file) => sum + file.content.length, 0);
  const cut = planned.filter((file) => file.truncated).length;
  progress(
    `retro: ${planned.length} editable file${planned.length === 1 ? "" : "s"}, ` +
      `${Math.max(1, Math.round(totalChars / 1024))} KB of prompts` +
      (cut === 0 ? "" : ` (${cut} truncated to fit the packet)`),
  );

  const task = buildTask(packet, editable, planned);
  const before = new Map(contents.map((file) => [file.path, file.content] as const));

  const def: AgentDef = {
    name: "retro",
    description: "Run retrospective: proposes prompt/stage edits from one workflow run's evidence.",
    systemPrompt: RETRO_SYSTEM_PROMPT,
    tools: ["read", "grep", "glob"],
    source: "<built-in>/retro",
    maxTurns: RETRO_MAX_TURNS,
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  const agent = options.runtime.createSubagent(task, def);

  progress(
    `retro: asking ${describeModel(options.runtime, options.model)} — this usually takes a few minutes`,
  );
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const minutes = Math.round((Date.now() - startedAt) / 60_000);
    progress(`retro: still thinking (${minutes}m)`);
  }, PROGRESS_TICK_MS);
  // A retro must never be the reason a process refuses to exit.
  ticker.unref?.();

  let parsed: ParsedRetroReply;
  let resolution: ResolveResult;
  try {
    await agent.prompt(task);
    parsed = parseRetroReply(agent.finalText());

    if (parsed.blocks.length === 0) {
      return {
        status: "invalid",
        reason:
          parsed.blockWarnings.length > 0
            ? `the retro agent produced no usable edit block (${parsed.blockWarnings.join("; ")})`
            : "the retro agent produced no edit block",
        findings: parsed.findings,
        editableWarnings: editable.warnings,
      };
    }

    resolution = resolveEditBlocks(parsed.blocks, before);

    // ONE correction turn, in the same sub-agent so the file content it was
    // shown is still in its own history.
    if (!resolution.ok) {
      progress(
        `retro: ${resolution.failures.length} edit block${resolution.failures.length === 1 ? "" : "s"} ` +
          "did not match — asking once for a correction",
      );
      await agent.prompt(buildRetryPrompt(resolution.failures));
      const second = parseRetroReply(agent.finalText());
      if (second.blocks.length > 0) {
        // The corrected reply is usually blocks only, so the first turn's
        // diagnosis is kept whenever the second does not restate it.
        resolution = resolveEditBlocks(second.blocks, before);
        parsed = {
          findings: second.findings.startsWith("-") ? second.findings : parsed.findings,
          risk: second.risk === "" ? parsed.risk : second.risk,
          blocks: second.blocks,
          blockWarnings: second.blockWarnings,
        };
      }
    }
  } finally {
    clearInterval(ticker);
  }

  if (!resolution.ok) {
    return {
      status: "invalid",
      reason: `${resolution.failures.length} edit block(s) could not be applied:\n${resolution.failures
        .map((failure) => `  block ${failure.block.index}: ${failure.reason}`)
        .join("\n")}`,
      findings: parsed.findings,
      editableWarnings: editable.warnings,
    };
  }

  const rendered = renderPatch(editable.files, before, resolution.after);
  if (rendered.diff.trim() === "") {
    return {
      status: "invalid",
      reason: "every edit block resolved to text that was already there — nothing to change",
      findings: parsed.findings,
      editableWarnings: editable.warnings,
    };
  }

  for (const patch of rendered.patches) {
    const validation = await validateDiff(patch, editable);
    if (!validation.ok) {
      return {
        status: "invalid",
        reason: validation.reason,
        findings: parsed.findings,
        diff: rendered.diff,
        editableWarnings: editable.warnings,
      };
    }
  }

  progress(
    `retro: ${countFindings(parsed.findings)} findings, ${resolution.edits.length} edits across ` +
      `${rendered.files.length} file${rendered.files.length === 1 ? "" : "s"}`,
  );

  return {
    status: "ok",
    findings: parsed.findings,
    diff: rendered.diff,
    risk: parsed.risk,
    patches: rendered.patches,
    files: rendered.files,
    edits: resolution.edits,
    editableWarnings: editable.warnings,
  };
}

function printPreview(out: (chunk: string) => void, result: RetroResult): void {
  out(`## Findings\n${result.findings ?? ""}\n\n`);
  out(`## Patch\n\`\`\`diff\n${result.diff ?? ""}\n\`\`\`\n\n`);
  out(`## Risk\n${result.risk ?? ""}\n`);
}

/* ------------------------------------------------------------------ *
 * `arcturn retro` (top-level command)
 * ------------------------------------------------------------------ */

/** Options for {@link runRetroCommand}. */
export interface RunRetroCommandOptions {
  readonly runId: string;
  readonly home?: string;
  readonly cwd?: string;
  readonly env?: EnvMap;
  readonly apply?: boolean;
  /** Bypasses the interactive approval gate — required to actually apply, headless. */
  readonly yes?: boolean;
  readonly json?: boolean;
  /** Model override for the retro sub-agent. */
  readonly model?: string;
  /** Inject a pre-built runtime (tests); a real one is built from `home`/`cwd`/`env` otherwise. */
  readonly runtime?: ArcturnRuntime;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

/**
 * `arcturn retro <runId> [--apply] [--yes] [--json]`.
 *
 * Exit codes: `0` preview or a successful apply, `1` unknown run id or a
 * rejected proposal, `3` `--apply` was given without `--yes` (needs a human) —
 * matching `print.ts`'s `PRINT_EXIT.needsHuman` convention for "waiting on
 * you" versus "failed".
 *
 * Progress goes to STDERR, always: `--json`'s stdout stays pure JSON.
 */
export async function runRetroCommand(options: RunRetroCommandOptions): Promise<number> {
  const out = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string) => void process.stderr.write(chunk));
  const env = options.env ?? process.env;
  const paths = resolveArcturnPaths({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    env,
  });

  const runtime =
    options.runtime ??
    (await buildRuntime({
      cwd: paths.cwd,
      home: paths.home,
      env,
      extensions: false,
      skipRepoLookup: true,
      sessionTitles: false,
      permissionMode: "plan",
    }));

  const model =
    options.model ??
    runtime.config.retro?.model ??
    (runtime.config.route?.tiers?.judgment !== undefined ? "tier:judgment" : undefined);

  const result = await computeRetro({
    home: paths.home,
    project: paths.project,
    runId: options.runId,
    runtime,
    ...(model === undefined ? {} : { model }),
    onProgress: (line) => err(`${line}\n`),
  });

  if (result.status === "unknown-run") {
    err(
      `arcturn: no run journal for "${options.runId}". Try arcturn workflow status to list runs.\n`,
    );
    return 1;
  }
  if (result.status === "invalid") {
    if (result.findings) out(`## Findings\n${result.findings}\n\n`);
    err(`arcturn: retro patch rejected: ${result.reason}\n`);
    return 1;
  }

  const applyRequested = options.apply === true;
  if (applyRequested && options.yes !== true) {
    printPreview(out, result);
    err(
      `arcturn: applying a patch needs an explicit --yes in non-interactive use. Run: ` +
        `arcturn retro ${options.runId} --apply --yes\n`,
    );
    return 3;
  }

  let applied = false;
  let appliedFiles: string[] = [];
  if (applyRequested) {
    appliedFiles = await applyRetroPatch(result.patches ?? []);
    applied = true;
    await saveRetroNote(paths.home, options.runId, result, true);
  }

  if (options.json === true) {
    out(
      `${JSON.stringify({
        findings: result.findings,
        diff: result.diff,
        edits: result.edits ?? [],
        files: result.files,
        applied,
      })}\n`,
    );
    return 0;
  }

  printPreview(out, result);
  if (applied) {
    out(
      `\nApplied to ${appliedFiles.length} file(s):\n${appliedFiles.map((f) => `  ${f}`).join("\n")}\n`,
    );
  } else {
    out("\nPreview only. Re-run with --apply --yes to apply this patch.\n");
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * `/retro` (slash command)
 * ------------------------------------------------------------------ */

/** Parse `<runId> [--apply] [--yes] [--json]`. Shared by the slash command only (the top-level verb owns `args.ts`'s own parser). */
function parseRetroSlashArgs(args: string): { runId?: string; apply: boolean; yes: boolean } {
  const tokens = args.split(/\s+/).filter((token) => token.length > 0);
  const runId = tokens.find((token) => !token.startsWith("--"));
  return { runId, apply: tokens.includes("--apply"), yes: tokens.includes("--yes") };
}

/**
 * The `/retro` slash command — the same proposal `arcturn retro` prints, over
 * the live session's runtime. Approval to apply is a modal `ui.select`;
 * under `--print` a picker cannot be shown, so it refuses and the patch is
 * never applied without `--yes`.
 */
export function createRetroCommands(): SlashCommand[] {
  return [
    {
      name: "retro",
      description:
        "Propose edits to this run's kit prompts/stages from its journal: " +
        "/retro <runId> [--apply] [--yes]",
      source: "built-in",
      async run({ ui, runtime, args }: CommandContext) {
        const parsed = parseRetroSlashArgs(args);
        if (!parsed.runId) {
          ui.notice("error", "Usage: /retro <runId> [--apply] [--yes]");
          return;
        }
        const model =
          runtime.config.retro?.model ??
          (runtime.config.route?.tiers?.judgment !== undefined ? "tier:judgment" : undefined);

        const result = await computeRetro({
          home: runtime.paths.home,
          project: runtime.paths.project,
          runId: parsed.runId,
          runtime,
          ...(model === undefined ? {} : { model }),
          onProgress: (line) => ui.notice("info", line),
        });

        if (result.status === "unknown-run") {
          ui.notice("error", `No run journal for "${parsed.runId}". Try /workflow status.`);
          return;
        }
        if (result.status === "invalid") {
          if (result.findings) ui.print(["## Findings", result.findings]);
          ui.notice("error", `Patch rejected: ${result.reason}`);
          return;
        }

        ui.print([
          "## Findings",
          result.findings ?? "",
          "",
          "## Patch",
          "```diff",
          result.diff ?? "",
          "```",
          "",
          "## Risk",
          result.risk ?? "",
        ]);

        if (!parsed.apply) return;

        if (!parsed.yes) {
          const confirmed = await ui.select(
            `Apply this patch to ${result.files?.length ?? 0} file(s)?`,
            [
              { value: "yes", label: "Apply it", data: true },
              { value: "no", label: "Cancel", data: false },
            ],
          );
          if (confirmed !== true) {
            // Under --print, `ui.select` is refused and always returns
            // `undefined` here — a person is needed to approve the patch.
            ui.needsHuman?.();
            ui.notice("info", "Not applied.");
            return;
          }
        }

        const applied = await applyRetroPatch(result.patches ?? []);
        await saveRetroNote(runtime.paths.home, parsed.runId, result, true);
        ui.print([`Applied to ${applied.length} file(s):`, ...applied.map((f) => `  ${f}`)]);
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The auto-offer hint
 * ------------------------------------------------------------------ */

/**
 * The one-line hint `/workflow` prints after a run that had anything worth a
 * retrospective — a park, a failed step, or a step that needed more than one
 * attempt. `undefined` means the run has nothing to point a retro at.
 *
 * Exported rather than wired here: `workflow.ts` is owned by another region
 * of this build, so the orchestrator is the one who calls this — see the
 * report for exactly where.
 *
 * @param result - The finished run's result.
 * @param runId - The run's id, for the printed command.
 */
export function retroHint(result: WorkflowRunResult, runId: string): string | undefined {
  const parks = result.steps.filter((step) => step.status === "paused").length;
  const failed = result.steps.filter((step) => step.status === "failed").length;
  const flapped = result.steps.filter((step) => (step.attempts ?? 1) > 1).length;
  const total = parks + failed + flapped;
  if (total === 0) return undefined;
  const parts = [
    parks > 0 ? `${parks} park${parks === 1 ? "" : "s"}` : undefined,
    failed > 0 ? `${failed} failed step${failed === 1 ? "" : "s"}` : undefined,
    flapped > 0 ? `${flapped} retried step${flapped === 1 ? "" : "s"}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `retro: this run had ${parts.join(", ")} — \`arcturn retro ${runId}\` proposes prompt fixes`;
}
