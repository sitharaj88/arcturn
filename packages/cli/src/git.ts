/**
 * Git-native workflow commands: `/commit`, `/pr` and `/review`.
 *
 * Every mutation (`git add`, `git commit`, `git checkout -b`, `git push`,
 * `gh pr create`) is gated behind a {@link CommandUi.select} confirmation, and
 * every subprocess is spawned with an argument array (never a shell string),
 * since commit messages, branch names and PR titles are attacker-influenceable
 * text. `git` and `gh` are both reached through the same injectable
 * {@link ExecFn} so tests can run real `git` in a throwaway repository while
 * stubbing only the `gh` calls that would otherwise touch the network. See
 * `git-status.ts` for the sibling status-bar spawner this mirrors.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderMarkdown, style } from "@arcturn/tui";
import type { SlashCommand } from "./commands.js";
import { oneLine } from "./format.js";
import type { ArcturnRuntime } from "./runtime.js";

const execFileAsync = promisify(execFile);

/** Result shape an {@link ExecFn} resolves with, matching `child_process.execFile`. */
export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Injectable process-spawning function used for both `git` and `gh`
 * invocations. Tests supply a fake that runs real `git` (in a throwaway
 * `fs.mkdtemp` repository) while intercepting only `command === "gh"`, so no
 * GitHub call is ever made.
 */
export type ExecFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<ExecResult>;

/** `git` subprocess timeout. Local, so this can stay tight. */
const GIT_TIMEOUT_MS = 15_000;
/** `gh` subprocess timeout. Talks to the network, so it gets more room. */
const GH_TIMEOUT_MS = 30_000;
/** Generous enough for a large diff without letting a runaway process hang a command. */
const MAX_BUFFER = 8 * 1024 * 1024;

const defaultExecFn: ExecFn = (command, args, options) =>
  execFileAsync(command, [...args], {
    cwd: options.cwd,
    timeout: command === "gh" ? GH_TIMEOUT_MS : GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });

/** Outcome of one `git`/`gh` invocation, with stderr surfaced on failure. */
interface Outcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function stringField(error: unknown, key: "stdout" | "stderr" | "message"): string {
  if (typeof error === "object" && error !== null) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Extract the best available error text: stderr first, falling back to the message. */
function stderrOf(error: unknown): string {
  const stderr = stringField(error, "stderr").trim();
  if (stderr !== "") return stderr;
  const message = stringField(error, "message").trim();
  return message !== "" ? message : String(error);
}

function stdoutOf(error: unknown): string {
  return stringField(error, "stdout").trim();
}

async function run(
  exec: ExecFn,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<Outcome> {
  try {
    const { stdout, stderr } = await exec(command, args, { cwd });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: stdoutOf(error), stderr: stderrOf(error) };
  }
}

function git(exec: ExecFn, cwd: string, args: readonly string[]): Promise<Outcome> {
  return run(exec, "git", args, cwd);
}

function gh(exec: ExecFn, cwd: string, args: readonly string[]): Promise<Outcome> {
  return run(exec, "gh", args, cwd);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/* Repository helpers -------------------------------------------------------- */

async function isGitRepo(exec: ExecFn, cwd: string): Promise<boolean> {
  const result = await git(exec, cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

async function hasHead(exec: ExecFn, cwd: string): Promise<boolean> {
  const result = await git(exec, cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  return result.ok;
}

/** Short branch name, or `undefined` on a detached HEAD. Works on an unborn branch too. */
async function currentBranch(exec: ExecFn, cwd: string): Promise<string | undefined> {
  const result = await git(exec, cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = result.stdout.trim();
  return result.ok && branch !== "" ? branch : undefined;
}

/**
 * Best-effort default branch: the local `origin/HEAD` pointer, then
 * `init.defaultBranch`, then `"main"`. Never touches the network.
 */
async function defaultBranch(exec: ExecFn, cwd: string): Promise<string> {
  const originHead = await git(exec, cwd, [
    "symbolic-ref",
    "--short",
    "-q",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead.ok) {
    const ref = originHead.stdout.trim();
    const slash = ref.indexOf("/");
    if (slash !== -1) return ref.slice(slash + 1);
  }
  const configured = await git(exec, cwd, ["config", "--get", "init.defaultBranch"]);
  if (configured.ok && configured.stdout.trim() !== "") return configured.stdout.trim();
  return "main";
}

async function remoteUrl(exec: ExecFn, cwd: string, name = "origin"): Promise<string | undefined> {
  const result = await git(exec, cwd, ["remote", "get-url", name]);
  return result.ok ? result.stdout.trim() : undefined;
}

const NOT_A_GIT_REPO = "Not a git repository (or any of the parent directories).";

/* Diff stats, shown the same way display.ts renders a diff's +/- header ----- */

interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

function diffStats(diff: string): DiffStat {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { files, insertions, deletions };
}

/** Mirrors `TranscriptFormatter#diff`'s header: `style("success")`/`style("error")` counts. */
function formatDiffStat(stats: DiffStat): string {
  const counts = [
    stats.insertions > 0 ? style("success")(`+${stats.insertions}`) : "",
    stats.deletions > 0 ? style("error")(`-${stats.deletions}`) : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  const label = `${stats.files} file${stats.files === 1 ? "" : "s"} changed`;
  return counts === "" ? label : `${label}  ${counts}`;
}

/** Cap a diff's character length before it goes to the model. */
function capDiff(
  diff: string,
  limit: number,
): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = diff.length;
  if (originalChars <= limit) return { text: diff, truncated: false, originalChars };
  return { text: diff.slice(0, limit), truncated: true, originalChars };
}

/* Model calls ----------------------------------------------------------------- */

async function askModel(runtime: ArcturnRuntime, system: string, prompt: string): Promise<string> {
  const message = await runtime.llm.complete({
    model: runtime.model,
    system,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  });
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

/* /commit ----------------------------------------------------------------- */

/** Diff size sent to the model for commit-message generation. */
export const COMMIT_DIFF_CHAR_LIMIT = 20_000;

const COMMIT_SYSTEM_PROMPT = [
  "You write git commit messages that follow the Conventional Commits specification",
  "(type(scope): subject, then an optional blank line and body). Given a staged diff, output",
  "ONLY the commit message text: no markdown code fences, no explanation, no surrounding quotes.",
].join(" ");

interface StagedInfo {
  files: string[];
  diff: string;
  stat: string;
}

async function stagedInfo(exec: ExecFn, cwd: string): Promise<StagedInfo> {
  const [names, diff, stat] = await Promise.all([
    git(exec, cwd, ["diff", "--staged", "--name-only"]),
    git(exec, cwd, ["diff", "--staged"]),
    git(exec, cwd, ["diff", "--staged", "--stat"]),
  ]);
  return { files: nonEmptyLines(names.stdout), diff: diff.stdout, stat: stat.stdout };
}

function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = (fence[1] ?? "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

async function generateCommitMessage(runtime: ArcturnRuntime, info: StagedInfo): Promise<string> {
  const { text, truncated } = capDiff(info.diff, COMMIT_DIFF_CHAR_LIMIT);
  const prompt = [
    `${info.files.length} file(s) staged:`,
    ...info.files.map((file) => `  ${file}`),
    "",
    "Staged diff:",
    "```diff",
    text,
    truncated ? "… (diff truncated)" : "",
    "```",
  ].join("\n");
  const raw = await askModel(runtime, COMMIT_SYSTEM_PROMPT, prompt);
  const message = cleanCommitMessage(raw);
  return message === "" ? "chore: update files" : message;
}

function createCommitCommand(exec: ExecFn): SlashCommand {
  return {
    name: "commit",
    description: "Commit staged changes: /commit [message] (generated from the diff if omitted)",
    source: "built-in",
    async run({ runtime, ui, args }) {
      const cwd = runtime.cwd;
      if (!(await isGitRepo(exec, cwd))) {
        ui.notice("error", NOT_A_GIT_REPO);
        return;
      }

      let info = await stagedInfo(exec, cwd);
      if (info.files.length === 0) {
        const stage = await ui.select("Nothing is staged. Stage all tracked modifications?", [
          { value: "stage", label: "Stage tracked modifications (git add -u)", data: true },
          { value: "cancel", label: "Cancel", data: false },
        ]);
        if (stage !== true) {
          ui.notice("info", "Commit cancelled.");
          return;
        }
        const added = await git(exec, cwd, ["add", "-u"]);
        if (!added.ok) {
          ui.notice("error", `git add -u failed:\n${added.stderr}`);
          return;
        }
        info = await stagedInfo(exec, cwd);
        if (info.files.length === 0) {
          ui.notice("info", "Nothing to commit; the working tree is clean.");
          return;
        }
      }

      let message = args.trim();
      if (message === "") {
        ui.notice("info", "Generating a commit message from the staged diff…");
        try {
          message = await generateCommitMessage(runtime, info);
        } catch (error) {
          ui.notice(
            "error",
            `Could not generate a commit message: ${errorMessage(error)}. ` +
              'Retry with "/commit <message>" to supply one directly.',
          );
          return;
        }
      }

      ui.print([
        "Proposed commit",
        ...message.split("\n").map((line) => `  ${line}`),
        "",
        style("muted")(formatDiffStat(diffStats(info.diff))),
        ...nonEmptyLines(info.stat).map((line) => `  ${line}`),
      ]);

      const confirmed = await ui.select(`Commit ${info.files.length} file(s)?`, [
        { value: "commit", label: `Commit "${oneLine(message, 60)}"`, data: true },
        { value: "cancel", label: "Cancel", data: false },
      ]);
      if (confirmed !== true) {
        ui.notice("info", "Commit cancelled.");
        return;
      }

      const result = await git(exec, cwd, ["commit", "-m", message]);
      if (!result.ok) {
        const output = [result.stderr, result.stdout].filter((part) => part !== "").join("\n");
        ui.notice("error", `git commit failed:\n${output || "(no output)"}`);
        return;
      }
      ui.notice("info", `Committed ${info.files.length} file(s): ${oneLine(message, 72)}`);
    },
  };
}

/* /pr ----------------------------------------------------------------------- */

const GH_MISSING =
  'The GitHub CLI ("gh") was not found. Install it from https://cli.github.com, then run "gh auth login".';
const GH_UNAUTHENTICATED = '"gh" is installed but not signed in. Run "gh auth login", then retry.';

async function ghReadiness(exec: ExecFn, cwd: string): Promise<string | undefined> {
  const version = await gh(exec, cwd, ["--version"]);
  if (!version.ok) return GH_MISSING;
  const auth = await gh(exec, cwd, ["auth", "status"]);
  if (!auth.ok) return GH_UNAUTHENTICATED;
  return undefined;
}

interface ExistingPr {
  url: string;
  number?: number;
  state?: string;
}

async function findExistingPr(
  exec: ExecFn,
  cwd: string,
  branch: string,
): Promise<ExistingPr | undefined> {
  const result = await gh(exec, cwd, ["pr", "view", branch, "--json", "url,number,state"]);
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as {
      url?: unknown;
      number?: unknown;
      state?: unknown;
    };
    if (typeof parsed.url !== "string") return undefined;
    return {
      url: parsed.url,
      ...(typeof parsed.number === "number" ? { number: parsed.number } : {}),
      ...(typeof parsed.state === "string" ? { state: parsed.state } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Turn free text into a branch-safe slug, e.g. `"Add login flow!"` → `"add-login-flow"`. */
export function slugifyBranchName(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? `arcturn/${Date.now()}` : slug;
}

async function branchCommitSubjects(exec: ExecFn, cwd: string, base: string): Promise<string[]> {
  const result = await git(exec, cwd, ["log", `${base}..HEAD`, "--pretty=format:%s"]);
  return result.ok ? nonEmptyLines(result.stdout) : [];
}

/** `gh pr create` prints the new PR's URL, usually as the last line of stdout. */
function extractPrUrl(stdout: string): string {
  const lines = nonEmptyLines(stdout);
  const urlLine = [...lines].reverse().find((line) => /^https?:\/\//.test(line));
  return urlLine ?? lines.at(-1) ?? stdout.trim();
}

function createPrCommand(exec: ExecFn): SlashCommand {
  return {
    name: "pr",
    description: "Push this branch and open a pull request: /pr [title]",
    source: "built-in",
    async run({ runtime, ui, args }) {
      const cwd = runtime.cwd;
      if (!(await isGitRepo(exec, cwd))) {
        ui.notice("error", NOT_A_GIT_REPO);
        return;
      }

      if (!(await remoteUrl(exec, cwd))) {
        ui.notice(
          "error",
          'No "origin" remote is configured. Add one with "git remote add origin <url>".',
        );
        return;
      }

      const readiness = await ghReadiness(exec, cwd);
      if (readiness) {
        ui.notice("error", readiness);
        return;
      }

      let branch = await currentBranch(exec, cwd);
      if (!branch) {
        ui.notice("error", "Cannot open a PR from a detached HEAD; check out a branch first.");
        return;
      }

      const base = await defaultBranch(exec, cwd);
      if (branch === base) {
        const title = args.trim();
        if (title === "") {
          ui.notice(
            "error",
            `Refusing to open a PR from "${base}", the default branch. Run "/pr <title>" to ` +
              "create a new branch named after it, or check one out yourself first.",
          );
          return;
        }
        const newBranch = slugifyBranchName(title);
        const create = await ui.select(
          `You're on "${base}". Create and switch to branch "${newBranch}" for this PR?`,
          [
            { value: "yes", label: `Create "${newBranch}" and continue`, data: true },
            { value: "no", label: "Cancel", data: false },
          ],
        );
        if (create !== true) {
          ui.notice("info", "PR cancelled.");
          return;
        }
        const checkout = await git(exec, cwd, ["checkout", "-b", newBranch]);
        if (!checkout.ok) {
          ui.notice("error", `git checkout -b ${newBranch} failed:\n${checkout.stderr}`);
          return;
        }
        branch = newBranch;
      }

      const existing = await findExistingPr(exec, cwd, branch);
      if (existing) {
        ui.notice("info", `A pull request already exists for "${branch}": ${existing.url}`);
        return;
      }

      const confirmed = await ui.select(`Push "${branch}" to origin and open a pull request?`, [
        { value: "yes", label: "Push and open PR", data: true },
        { value: "no", label: "Cancel", data: false },
      ]);
      if (confirmed !== true) {
        ui.notice("info", "PR cancelled.");
        return;
      }

      const push = await git(exec, cwd, ["push", "-u", "origin", branch]);
      if (!push.ok) {
        ui.notice("error", `git push failed:\n${push.stderr}`);
        return;
      }

      const subjects = await branchCommitSubjects(exec, cwd, base);
      const title = args.trim() || subjects[0] || branch;
      const body =
        subjects.length === 0
          ? "_No commits ahead of the base branch._"
          : ["## Commits", "", ...subjects.map((subject) => `- ${subject}`)].join("\n");

      const created = await gh(exec, cwd, [
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--head",
        branch,
      ]);
      if (!created.ok) {
        ui.notice("error", `gh pr create failed:\n${created.stderr}`);
        return;
      }
      ui.notice("info", `Opened pull request: ${extractPrUrl(created.stdout)}`);
    },
  };
}

/* /review --------------------------------------------------------------------- */

/** Diff size sent to the model for a review. Beyond this, the tail is dropped with a notice. */
export const REVIEW_DIFF_CHAR_LIMIT = 20_000;

const REVIEW_SYSTEM_PROMPT = [
  "You are a meticulous code reviewer. Review the given diff for REAL defects only:",
  "correctness bugs, security vulnerabilities, and missed edge cases. Do not comment on style,",
  "formatting, or naming unless it causes an actual bug. For each finding, name the file and",
  "explain the risk in one or two sentences. If you find nothing worth flagging, say so plainly",
  "instead of inventing issues.",
].join(" ");

/** A `/review` target, parsed from the raw argument text. */
export type ReviewTarget =
  | { kind: "working" }
  | { kind: "staged" }
  | { kind: "range"; range: string }
  | { kind: "branch"; name: string }
  | { kind: "pr"; number: string };

/**
 * Parse `/review`'s argument into one of five shapes: empty (working tree),
 * `"staged"`, a PR number (`"123"` or `"#123"`), a commit range containing
 * `".."` (`"main..HEAD"`), or a bare branch name.
 *
 * @param raw - Text typed after `/review`.
 */
export function parseReviewTarget(raw: string): ReviewTarget {
  const target = raw.trim();
  if (target === "") return { kind: "working" };
  if (target === "staged") return { kind: "staged" };
  const pr = /^#?(\d+)$/.exec(target);
  if (pr) return { kind: "pr", number: pr[1] ?? target };
  if (target.includes("..")) return { kind: "range", range: target };
  return { kind: "branch", name: target };
}

function targetLabel(target: ReviewTarget): string {
  switch (target.kind) {
    case "working":
      return "the working tree";
    case "staged":
      return "the staged changes";
    case "range":
      return `the range ${target.range}`;
    case "branch":
      return `${target.name}...HEAD`;
    case "pr":
      return `PR #${target.number}`;
  }
}

type DiffOutcome = { ok: true; diff: string } | { ok: false; error: string };

async function diffForTarget(
  exec: ExecFn,
  cwd: string,
  target: ReviewTarget,
): Promise<DiffOutcome> {
  switch (target.kind) {
    case "staged": {
      const result = await git(exec, cwd, ["diff", "--staged"]);
      return result.ok
        ? { ok: true, diff: result.stdout }
        : { ok: false, error: `git diff --staged failed:\n${result.stderr}` };
    }
    case "working": {
      const args = (await hasHead(exec, cwd)) ? ["diff", "HEAD"] : ["diff", "--staged"];
      const result = await git(exec, cwd, args);
      return result.ok
        ? { ok: true, diff: result.stdout }
        : { ok: false, error: `git ${args.join(" ")} failed:\n${result.stderr}` };
    }
    case "range": {
      const result = await git(exec, cwd, ["diff", target.range]);
      return result.ok
        ? { ok: true, diff: result.stdout }
        : { ok: false, error: `git diff ${target.range} failed:\n${result.stderr}` };
    }
    case "branch": {
      const spec = `${target.name}...HEAD`;
      const result = await git(exec, cwd, ["diff", spec]);
      return result.ok
        ? { ok: true, diff: result.stdout }
        : { ok: false, error: `git diff ${spec} failed:\n${result.stderr}` };
    }
    case "pr": {
      const result = await gh(exec, cwd, ["pr", "diff", target.number]);
      return result.ok
        ? { ok: true, diff: result.stdout }
        : { ok: false, error: `gh pr diff ${target.number} failed:\n${result.stderr}` };
    }
  }
}

function createReviewCommand(exec: ExecFn): SlashCommand {
  return {
    name: "review",
    description: "Review a diff: /review [staged|<branch>|<range>|<PR#>]",
    source: "built-in",
    async run({ runtime, ui, args }) {
      const cwd = runtime.cwd;
      if (!(await isGitRepo(exec, cwd))) {
        ui.notice("error", NOT_A_GIT_REPO);
        return;
      }

      const target = parseReviewTarget(args);
      const diffResult = await diffForTarget(exec, cwd, target);
      if (!diffResult.ok) {
        ui.notice("error", diffResult.error);
        return;
      }
      if (diffResult.diff.trim() === "") {
        ui.notice("info", `No changes to review in ${targetLabel(target)}.`);
        return;
      }

      const { text, truncated, originalChars } = capDiff(diffResult.diff, REVIEW_DIFF_CHAR_LIMIT);
      if (truncated) {
        ui.notice(
          "warn",
          `Diff truncated to ${REVIEW_DIFF_CHAR_LIMIT.toLocaleString()} of ` +
            `${originalChars.toLocaleString()} characters for review.`,
        );
      }

      ui.notice(
        "info",
        `Reviewing ${targetLabel(target)} — ${style("muted")(formatDiffStat(diffStats(diffResult.diff)))}`,
      );

      let findings: string;
      try {
        findings = await askModel(
          runtime,
          REVIEW_SYSTEM_PROMPT,
          `Review target: ${targetLabel(target)}\n\n\`\`\`diff\n${text}\n\`\`\``,
        );
      } catch (error) {
        ui.notice("error", `Review failed: ${errorMessage(error)}`);
        return;
      }
      ui.print(renderMarkdown(findings === "" ? "No issues found." : findings, 80));
    },
  };
}

/* Factory --------------------------------------------------------------------- */

/** Options for {@link createGitCommands}. */
export interface CreateGitCommandsOptions {
  /**
   * Injectable spawner for both `git` and `gh`. Defaults to a real `execFile`
   * wrapper; tests inject a fake that runs real `git` in a throwaway
   * repository while stubbing `gh` so no GitHub call ever happens.
   */
  exec?: ExecFn;
}

/**
 * Build the git-native workflow commands: `/commit`, `/pr` and `/review`.
 *
 * Every mutating step (staging, committing, branching, pushing, opening a PR)
 * is gated behind a {@link CommandUi.select} confirmation and nothing is ever
 * pushed automatically — `/commit` never pushes, and `/pr` pushes only after
 * an explicit "yes".
 *
 * @param options - See {@link CreateGitCommandsOptions}.
 */
export function createGitCommands(options: CreateGitCommandsOptions = {}): SlashCommand[] {
  const exec = options.exec ?? defaultExecFn;
  return [createCommitCommand(exec), createPrCommand(exec), createReviewCommand(exec)];
}
