/**
 * System-prompt assembly.
 *
 * {@link buildSystemPrompt} is pure so it can be unit-tested; everything that
 * touches the filesystem or spawns `git` lives in
 * {@link collectSystemPromptContext} and degrades to `undefined` on failure.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Filename read from the project root and inlined into the prompt. */
export const PROJECT_DOC_FILENAME = "ARCTURN.md";

/** Maximum characters of `ARCTURN.md` inlined into the prompt. */
export const MAX_PROJECT_DOC_CHARS = 16_000;

/** Everything the prompt template needs. All fields are plain data. */
export interface SystemPromptContext {
  /** Absolute working directory. */
  cwd: string;
  /** `process.platform`-style OS name. */
  platform: string;
  /** Today's date, already formatted. */
  date: string;
  /** One-line git summary, when the directory is a repository. */
  git?: string;
  /** Contents of `ARCTURN.md`, when present. */
  projectDoc?: string;
  /** `systemPromptAppend` from the config. */
  append?: string;
  /** Tool names available this session, used for a short inventory line. */
  toolNames?: readonly string[];
  /** Named markdown sub-agents the `subagent` tool can delegate to. */
  agents?: readonly { name: string; description: string }[];
  /** Durable project notes, pre-rendered by `formatMemoriesForPrompt`. */
  memories?: string;
}

/**
 * Build the fixed instruction block, inserting tool-conditional guidance where
 * the corresponding tools are actually available this session.
 *
 * @param toolNames - Tool names available this session, used to gate lines that
 *   only make sense when both tools they compare exist.
 */
function buildCoreInstructions(toolNames?: readonly string[]): string {
  const editWriteNudge =
    toolNames?.includes("edit") && toolNames?.includes("write")
      ? "\n- When modifying an existing file, use edit's targeted replacement — never" +
        " re-emit the whole file through write to change part of it; that is slower," +
        " costs more and shows the user nothing while it streams. write is for" +
        " creating new files."
      : "";

  return `You are arcturn, an autonomous coding agent running in the user's terminal.

Working style
- Do the work. Read files, run commands and make the edits rather than describing
  what the user could do. Stop and ask only when a choice is genuinely ambiguous
  or destructive.
- Prefer evidence over assumption: read a file before editing it, and check the
  result of a command before relying on it.
- Keep going until the task is actually finished, then stop. Do not narrate every
  step or restate what the tool output already shows.

Tool use
- Batch independent reads and searches; they are cheap. Prefer grep/glob over
  shell pipelines for searching, and read for viewing files.
- edit requires the exact current text of the file, so read it first. Never write
  a file you have not read unless you are creating it.${editWriteNudge}
- bash runs in the working directory. Use background: true for long-running
  processes (servers, watchers) instead of blocking a turn on them.
- Use the todo tool for multi-step work so the user can follow along: send the
  whole list every time, and keep at most one item in progress.
- Use the plan tool to present an approach before large or risky changes; in plan
  mode it is the only way to start making edits.
- Delegate wide, self-contained searches to the subagent tool when you do not need
  to see the intermediate output.

Answering
- Answer in plain prose with GitHub-flavoured markdown. Keep it short: this is a
  terminal, not a document. Reference files as \`path/to/file.ts:42\`.
- Never invent file contents, command output, APIs or test results.`;
}

/**
 * Render the system prompt.
 *
 * @param context - Environment facts and configuration to weave in.
 */
export function buildSystemPrompt(context: SystemPromptContext): string {
  const sections: string[] = [buildCoreInstructions(context.toolNames)];

  const env: string[] = [
    `Working directory: ${context.cwd}`,
    `Platform: ${context.platform}`,
    `Today's date: ${context.date}`,
  ];
  if (context.git) env.push(`Git: ${context.git}`);
  if (context.toolNames && context.toolNames.length > 0) {
    env.push(`Available tools: ${[...context.toolNames].join(", ")}`);
  }
  sections.push(`# Environment\n${env.join("\n")}`);

  if (context.memories && context.memories.trim().length > 0) {
    sections.push(
      `# Project memory\nNotes you recorded in earlier sessions (write more with the ` +
        `memory tool):\n${context.memories.trim()}`,
    );
  }

  if (context.agents && context.agents.length > 0) {
    const lines = context.agents.map(
      (agent) => `- ${agent.name}${agent.description === "" ? "" : `: ${agent.description}`}`,
    );
    sections.push(
      `# Specialized agents\nPass one of these names as the \`agent\` argument to the ` +
        `subagent tool to delegate with that agent's instructions and tools:\n${lines.join("\n")}`,
    );
  }

  if (context.projectDoc && context.projectDoc.trim().length > 0) {
    sections.push(
      `# Project instructions (${PROJECT_DOC_FILENAME})\n` +
        "The user placed these instructions in the repository. Follow them.\n\n" +
        context.projectDoc.trim(),
    );
  }

  if (context.append && context.append.trim().length > 0) {
    sections.push(`# User instructions\n${context.append.trim()}`);
  }

  return sections.join("\n\n");
}

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 2_000, windowsHide: true });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Summarise the repository in one line, e.g. `branch main, 3 uncommitted files`.
 *
 * @param cwd - Directory to inspect.
 * @returns `undefined` when `cwd` is not inside a git work tree.
 */
export async function gitSummary(cwd: string): Promise<string | undefined> {
  const status = await git(["status", "--porcelain=v1", "-b", "--short"], cwd);
  if (status === undefined) return undefined;
  const lines = status.split("\n").filter((line) => line.length > 0);
  const header = lines[0] ?? "";
  const branchMatch = /^##\s+([^.\s]+(?:\.[^.\s]+)*)/.exec(header);
  const branch = branchMatch?.[1] ?? "detached HEAD";
  const changed = lines.length - (header.startsWith("##") ? 1 : 0);
  return changed === 0
    ? `branch ${branch}, clean`
    : `branch ${branch}, ${changed} uncommitted file${changed === 1 ? "" : "s"}`;
}

/**
 * Locate the repository root, falling back to `cwd` outside a repository.
 *
 * @param cwd - Directory to start from.
 */
export async function repoRoot(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"], cwd)) ?? cwd;
}

/** Options for {@link collectSystemPromptContext}. */
export interface CollectContextOptions {
  /** Working directory. */
  cwd: string;
  /** `systemPromptAppend` from the config. */
  append?: string;
  /** Names of the tools registered this session. */
  toolNames?: readonly string[];
  /** Skip `git` and `ARCTURN.md` lookups (used by tests and `--print` fast paths). */
  skipRepoLookup?: boolean;
  /** Clock injection point. */
  now?: Date;
}

/**
 * Gather environment facts for the system prompt.
 *
 * Every lookup is best-effort: a missing `git`, a non-repository directory or an
 * unreadable `ARCTURN.md` simply leaves the corresponding section out.
 *
 * @param options - Working directory and configuration.
 */
export async function collectSystemPromptContext(
  options: CollectContextOptions,
): Promise<SystemPromptContext> {
  const now = options.now ?? new Date();
  const context: SystemPromptContext = {
    cwd: options.cwd,
    platform: process.platform,
    date: now.toISOString().slice(0, 10),
    ...(options.append ? { append: options.append } : {}),
    ...(options.toolNames ? { toolNames: options.toolNames } : {}),
  };
  if (options.skipRepoLookup) return context;

  const [summary, root] = await Promise.all([gitSummary(options.cwd), repoRoot(options.cwd)]);
  const doc = await readProjectDoc(root, options.cwd);
  return {
    ...context,
    ...(summary ? { git: summary } : {}),
    ...(doc ? { projectDoc: doc } : {}),
  };
}

/**
 * Read `ARCTURN.md` from the repository root, falling back to the working directory.
 *
 * @param root - Repository root.
 * @param cwd - Working directory.
 */
export async function readProjectDoc(root: string, cwd: string): Promise<string | undefined> {
  const candidates = root === cwd ? [root] : [root, cwd];
  for (const dir of candidates) {
    try {
      const raw = await readFile(join(dir, PROJECT_DOC_FILENAME), "utf8");
      return raw.length > MAX_PROJECT_DOC_CHARS
        ? `${raw.slice(0, MAX_PROJECT_DOC_CHARS)}\n…(truncated)`
        : raw;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
