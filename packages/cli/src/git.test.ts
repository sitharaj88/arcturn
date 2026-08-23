import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ColorLevel, setColorLevel } from "@arcturn/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CommandRegistry, type CommandUi, type SelectOption } from "./commands.js";
import {
  createGitCommands,
  type ExecFn,
  type ExecResult,
  parseReviewTarget,
  REVIEW_DIFF_CHAR_LIMIT,
  slugifyBranchName,
} from "./git.js";
import type { FakeLLM, ScriptedTurn } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

const execFileAsync = promisify(execFile);

beforeAll(() => {
  // Deterministic, colour-free output so assertions can match plain text.
  setColorLevel(ColorLevel.None);
});

/* Cleanup ------------------------------------------------------------------- */

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/* Fake UI --------------------------------------------------------------------- */

interface FakeUi extends CommandUi {
  lines: string[];
  notices: { level: string; text: string }[];
  selects: { title: string; options: readonly SelectOption<unknown>[] }[];
}

/** A `CommandUi` whose `select()` answers a queue in order, `undefined` once exhausted. */
function fakeUi(answers: readonly unknown[] = []): FakeUi {
  const queue = [...answers];
  const ui: FakeUi = {
    lines: [],
    notices: [],
    selects: [],
    print(content) {
      ui.lines.push(...(typeof content === "string" ? content.split("\n") : content));
    },
    notice(level, text) {
      ui.notices.push({ level, text });
    },
    async select<T>(title: string, options: readonly SelectOption<T>[]) {
      ui.selects.push({ title, options: options as readonly SelectOption<unknown>[] });
      return (queue.length > 0 ? queue.shift() : undefined) as T | undefined;
    },
    setInput() {},
    clear() {},
    exit() {},
  };
  return ui;
}

/* Fake git/gh exec ------------------------------------------------------------ */

interface ExecCall {
  command: string;
  args: string[];
}

type GhHandler = (args: string[], cwd: string) => Promise<ExecResult> | ExecResult;

/**
 * Build an {@link ExecFn} that runs REAL `git` (against whatever repo the test
 * set up under a throwaway directory) while routing every `gh` call through a
 * caller-supplied fake, so no test ever reaches the network or a real
 * GitHub CLI installation.
 */
function makeExec(ghHandler?: GhHandler): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args: [...args] });
    if (command === "gh") {
      if (!ghHandler) {
        throw Object.assign(new Error("gh: unexpected call"), { stderr: "gh: unexpected call" });
      }
      return await ghHandler([...args], options.cwd);
    }
    if (command !== "git") throw new Error(`unexpected command "${command}"`);
    return execFileAsync("git", [...args], { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 });
  };
  return { exec, calls };
}

function ghFail(message: string): never {
  throw Object.assign(new Error(message), { stderr: message });
}

/** `gh --version` and `gh auth status` both succeed; everything else fails loudly. */
function readyGh(extra: GhHandler): GhHandler {
  return (args, cwd) => {
    const key = args.join(" ");
    if (key === "--version") return { stdout: "gh version 2.50.0 (2024-01-01)", stderr: "" };
    if (key === "auth status") return { stdout: "Logged in to github.com", stderr: "" };
    return extra(args, cwd);
  };
}

function calledWith(calls: ExecCall[], command: string, ...prefix: string[]): boolean {
  return calls.some(
    (call) =>
      call.command === command && prefix.every((token, index) => call.args[index] === token),
  );
}

/* Real-repo helpers ------------------------------------------------------------ */

async function initRepo(dir: string, branch = "main"): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", branch], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
}

async function writeIn(dir: string, name: string, content: string): Promise<void> {
  await writeFile(join(dir, name), content, "utf8");
}

async function stage(dir: string, ...paths: string[]): Promise<void> {
  await execFileAsync("git", ["add", ...paths], { cwd: dir });
}

async function commitAll(dir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

async function headSha(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function lastCommitMessage(dir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%B"], { cwd: dir });
  return stdout.replace(/\n+$/, "");
}

async function addOrigin(dir: string, url: string): Promise<void> {
  await execFileAsync("git", ["remote", "add", "origin", url], { cwd: dir });
}

/** A local bare repo used as a real (network-free) push target for `/pr`. */
async function createBareOrigin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-git-origin-"));
  cleanupDirs.push(dir);
  await execFileAsync("git", ["init", "--bare", "-q"], { cwd: dir });
  return dir;
}

async function remoteBranches(bareDir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["for-each-ref", "refs/heads"], { cwd: bareDir });
  return stdout;
}

/** Registry with only the git commands, run against a scripted-LLM runtime. */
async function setup(
  turns: readonly ScriptedTurn[] = [{ text: "done" }],
): Promise<{ runtime: Awaited<ReturnType<typeof buildTestRuntime>>; cwd: string }> {
  const scratch = await makeScratch();
  cleanupDirs.push(scratch.root);
  const runtime = await buildTestRuntime(scratch, turns);
  return { runtime, cwd: scratch.cwd };
}

function registryFor(exec: ExecFn): CommandRegistry {
  const registry = new CommandRegistry();
  registry.registerAll(createGitCommands({ exec }));
  return registry;
}

/* Non-git-repo handling -------------------------------------------------------- */

describe("outside a git repository", () => {
  it("/commit reports a clear error and never prompts", async () => {
    const { runtime, cwd } = await setup();
    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/commit", { runtime, ui });
    expect(ui.notices).toEqual([
      { level: "error", text: expect.stringContaining("Not a git repository") },
    ]);
    expect(ui.selects).toHaveLength(0);
    void cwd;
    await runtime.dispose();
  });

  it("/pr reports a clear error and never prompts", async () => {
    const { runtime } = await setup();
    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/pr", { runtime, ui });
    expect(ui.notices[0]).toMatchObject({ level: "error" });
    expect(ui.notices[0]?.text).toContain("Not a git repository");
    expect(ui.selects).toHaveLength(0);
    await runtime.dispose();
  });

  it("/review reports a clear error and never prompts", async () => {
    const { runtime } = await setup();
    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/review", { runtime, ui });
    expect(ui.notices[0]).toMatchObject({ level: "error" });
    expect(ui.notices[0]?.text).toContain("Not a git repository");
    await runtime.dispose();
  });
});

/* /commit ----------------------------------------------------------------------- */

describe("/commit", () => {
  it("generates a Conventional Commits message from a scripted fake model", async () => {
    const { runtime, cwd } = await setup([
      { text: "feat: greet the user\n\nAdds a friendlier greeting message." },
    ]);
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await writeIn(cwd, "a.txt", "hello, world\n");
    await stage(cwd, "a.txt");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([true]);
    await registry.dispatch("/commit", { runtime, ui });

    expect(ui.notices.some((n) => n.text.includes("Generating a commit message"))).toBe(true);
    expect(ui.notices.at(-1)?.text).toContain("feat: greet the user");
    expect(await lastCommitMessage(cwd)).toBe(
      "feat: greet the user\n\nAdds a friendlier greeting message.",
    );

    const requests = (runtime.llm as FakeLLM).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.system).toContain("Conventional Commits");
    const sentText = requests[0]?.messages
      .flatMap((message) => (message.role === "user" ? message.content : []))
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(sentText).toContain("a.txt");

    await runtime.dispose();
  });

  it("falls back to a generic message when the model returns nothing usable", async () => {
    const { runtime, cwd } = await setup([{ text: "   " }]);
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await stage(cwd, "a.txt");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([true]);
    await registry.dispatch("/commit", { runtime, ui });

    expect(await lastCommitMessage(cwd)).toBe("chore: update files");
    await runtime.dispose();
  });

  it("uses the supplied message verbatim, including shell metacharacters", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await stage(cwd, "a.txt");

    const dangerous = 'fix: handle "$HOME"; `id`; rm -rf /tmp/should-not-run && echo pwned';
    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([true]);
    await registry.dispatch(`/commit ${dangerous}`, { runtime, ui });

    expect(await lastCommitMessage(cwd)).toBe(dangerous);
    // No fake LLM call should have happened: a message was supplied directly.
    expect((runtime.llm as FakeLLM).requests).toHaveLength(0);
    await runtime.dispose();
  });

  it("offers to stage tracked modifications when nothing is staged", async () => {
    const { runtime, cwd } = await setup([{ text: "fix: update a" }]);
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await writeIn(cwd, "a.txt", "hello, dirty\n");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([true, true]);
    await registry.dispatch("/commit", { runtime, ui });

    expect(ui.selects[0]?.title).toContain("Nothing is staged");
    expect(await lastCommitMessage(cwd)).toBe("fix: update a");
    await runtime.dispose();
  });

  it("reports a clean tree when there is nothing to stage or commit", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");

    const { exec, calls } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([true]);
    await registry.dispatch("/commit", { runtime, ui });

    expect(ui.notices.at(-1)?.text).toContain("working tree is clean");
    expect(calledWith(calls, "git", "commit")).toBe(false);
    await runtime.dispose();
  });

  it("cancels without staging when the user declines", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await writeIn(cwd, "a.txt", "hello, dirty\n");
    const before = await headSha(cwd);

    const { exec, calls } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([false]);
    await registry.dispatch("/commit", { runtime, ui });

    expect(ui.notices.at(-1)?.text).toBe("Commit cancelled.");
    expect(calledWith(calls, "git", "add")).toBe(false);
    expect(calledWith(calls, "git", "commit")).toBe(false);
    expect(await headSha(cwd)).toBe(before);
    await runtime.dispose();
  });

  it("cancels at the final confirmation without committing", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await stage(cwd, "a.txt");
    const before = await headSha(cwd); // undefined: unborn branch

    const { exec, calls } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([false]);
    await registry.dispatch("/commit a message that is never used", { runtime, ui });

    expect(ui.notices.at(-1)?.text).toBe("Commit cancelled.");
    expect(calledWith(calls, "git", "commit")).toBe(false);
    expect(await headSha(cwd)).toBe(before);
    await runtime.dispose();
  });

  it("commits on an empty repository with no HEAD yet", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await stage(cwd, "a.txt");
    expect(await headSha(cwd)).toBeUndefined();

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([true]);
    await registry.dispatch("/commit init: first commit", { runtime, ui });

    expect(await headSha(cwd)).toBeDefined();
    expect(await lastCommitMessage(cwd)).toBe("init: first commit");
    await runtime.dispose();
  });

  it("surfaces a failing pre-commit hook's output and leaves HEAD untouched", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    const before = await headSha(cwd);

    await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
    await writeFile(
      join(cwd, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho 'lint: found 2 problems' >&2\nexit 1\n",
      "utf8",
    );
    await chmod(join(cwd, ".git", "hooks", "pre-commit"), 0o755);

    await writeIn(cwd, "a.txt", "hello, dirty\n");
    await stage(cwd, "a.txt");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi([true]);
    await registry.dispatch("/commit chore: will be blocked", { runtime, ui });

    const failure = ui.notices.at(-1);
    expect(failure?.level).toBe("error");
    expect(failure?.text).toContain("git commit failed");
    expect(failure?.text).toContain("lint: found 2 problems");
    expect(await headSha(cwd)).toBe(before);
    await runtime.dispose();
  });
});

/* /pr ------------------------------------------------------------------------- */

describe("/pr", () => {
  it("refuses on the default branch with no title and never prompts", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "main");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    const origin = await createBareOrigin();
    await addOrigin(cwd, origin);

    const { exec, calls } = makeExec(readyGh(() => ghFail("should not be reached")));
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/pr", { runtime, ui });

    expect(ui.notices[0]).toMatchObject({ level: "error" });
    expect(ui.notices[0]?.text).toContain('Refusing to open a PR from "main"');
    expect(ui.selects).toHaveLength(0);
    expect(calledWith(calls, "git", "push")).toBe(false);
    await runtime.dispose();
  });

  it("offers to create a branch when on the default branch with a title, then pushes and opens a PR", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "main");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await writeIn(cwd, "b.txt", "feature\n");
    await commitAll(cwd, "add feature b");
    const origin = await createBareOrigin();
    await addOrigin(cwd, origin);

    const { exec, calls } = makeExec(
      readyGh((args) => {
        const key = args.join(" ");
        if (key.startsWith("pr view ")) ghFail("no pull requests found for branch");
        if (key.startsWith("pr create ")) {
          return { stdout: "https://github.com/acme/repo/pull/42\n", stderr: "" };
        }
        return ghFail(`unhandled: ${key}`);
      }),
    );
    const registry = registryFor(exec);
    const ui = fakeUi([true, true]);
    await registry.dispatch("/pr Add feature B", { runtime, ui });

    expect(ui.selects[0]?.title).toContain('You\'re on "main"');
    expect(ui.notices.at(-1)?.text).toContain("https://github.com/acme/repo/pull/42");

    const newBranch = slugifyBranchName("Add feature B");
    const { stdout: branchName } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd,
      },
    );
    expect(branchName.trim()).toBe(newBranch);
    expect((await remoteBranches(origin)).trim()).toContain(newBranch);

    const created = calls.find((call) => call.args[0] === "pr" && call.args[1] === "create");
    expect(created?.args).toContain("--title");
    expect(created?.args).toContain("Add feature B");
    // The branch was created from `main` in this same run, so it is not yet
    // ahead of its own base — the body must say so rather than inventing history.
    const bodyIndex = created?.args.indexOf("--body") ?? -1;
    expect(created?.args[bodyIndex + 1]).toContain("No commits ahead of the base branch");
    await runtime.dispose();
  });

  it("summarises the branch's actual commits in the PR body", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "main");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    const origin = await createBareOrigin();
    await addOrigin(cwd, origin);
    await execFileAsync("git", ["checkout", "-q", "-b", "feature-x"], { cwd });
    await writeIn(cwd, "b.txt", "one\n");
    await commitAll(cwd, "add one");
    await writeIn(cwd, "c.txt", "two\n");
    await commitAll(cwd, "add two");

    const { exec, calls } = makeExec(
      readyGh((args) => {
        const key = args.join(" ");
        if (key.startsWith("pr view ")) ghFail("no pull requests found for branch");
        if (key.startsWith("pr create ")) {
          return { stdout: "https://github.com/acme/repo/pull/43\n", stderr: "" };
        }
        return ghFail(`unhandled: ${key}`);
      }),
    );
    const registry = registryFor(exec);
    const ui = fakeUi([true]);
    await registry.dispatch("/pr", { runtime, ui });

    const created = calls.find((call) => call.args[0] === "pr" && call.args[1] === "create");
    const bodyIndex = created?.args.indexOf("--body") ?? -1;
    const body = created?.args[bodyIndex + 1] ?? "";
    expect(body).toContain("add one");
    expect(body).toContain("add two");
    // Falls back to the latest commit subject as the title when none was given.
    expect(created?.args).toContain("add two");
    await runtime.dispose();
  });

  it("reads the base branch off the repository, not off init.defaultBranch", async () => {
    // The machine says branches are called "master"; this repository's is
    // called "main". Git for Windows and every developer who ever ran
    // `git config --global init.defaultBranch master` is in this state, and
    // taking the config's word for it produced `git log master..HEAD` — a
    // range git rejects — so a branch full of commits was reported as empty.
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "main");
    await execFileAsync("git", ["config", "init.defaultBranch", "master"], { cwd });
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await addOrigin(cwd, await createBareOrigin());
    await execFileAsync("git", ["checkout", "-q", "-b", "feature-x"], { cwd });
    await writeIn(cwd, "b.txt", "one\n");
    await commitAll(cwd, "add one");

    const { exec, calls } = makeExec(
      readyGh((args) => {
        const key = args.join(" ");
        if (key.startsWith("pr view ")) ghFail("no pull requests found for branch");
        if (key.startsWith("pr create ")) return { stdout: "https://x/pull/1\n", stderr: "" };
        return ghFail(`unhandled: ${key}`);
      }),
    );
    const registry = registryFor(exec);
    await registry.dispatch("/pr", { runtime, ui: fakeUi([true]) });

    const created = calls.find((call) => call.args[0] === "pr" && call.args[1] === "create");
    const body = created?.args[(created?.args.indexOf("--body") ?? -1) + 1] ?? "";
    expect(body).toContain("add one");
    expect(body).not.toContain("No commits ahead");
    await runtime.dispose();
  });

  it("still refuses a PR from the default branch when the machine names branches differently", async () => {
    // The same disagreement, on the guard rather than the body: with the base
    // taken from config, `branch === base` was false on the default branch
    // itself, and the refusal that keeps a PR from being opened from `main`
    // silently stopped firing.
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "main");
    await execFileAsync("git", ["config", "init.defaultBranch", "master"], { cwd });
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await addOrigin(cwd, await createBareOrigin());

    const { exec, calls } = makeExec(readyGh(() => ghFail("should not be reached")));
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/pr", { runtime, ui });

    expect(ui.notices[0]).toMatchObject({ level: "error" });
    expect(ui.notices[0]?.text).toContain('Refusing to open a PR from "main"');
    expect(calledWith(calls, "git", "push")).toBe(false);
    await runtime.dispose();
  });

  it("says the range was unanswerable rather than claiming there were no commits", async () => {
    // A repository whose only branch is named something else entirely: there
    // is no base to diff against, and "no commits ahead of the base branch"
    // would be a claim nobody checked.
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "release/2026.1");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "only commit");
    await addOrigin(cwd, await createBareOrigin());

    const { exec, calls } = makeExec(
      readyGh((args) => {
        const key = args.join(" ");
        if (key.startsWith("pr view ")) ghFail("no pull requests found for branch");
        if (key.startsWith("pr create ")) return { stdout: "https://x/pull/2\n", stderr: "" };
        return ghFail(`unhandled: ${key}`);
      }),
    );
    const registry = registryFor(exec);
    await registry.dispatch("/pr", { runtime, ui: fakeUi([true]) });

    const created = calls.find((call) => call.args[0] === "pr" && call.args[1] === "create");
    const body = created?.args[(created?.args.indexOf("--body") ?? -1) + 1] ?? "";
    expect(body).toContain("Could not list");
    expect(body).not.toContain("No commits ahead");
    await runtime.dispose();
  });

  it('detects "no origin remote" before ever calling gh', async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "feature-x");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");

    const { exec, calls } = makeExec(() => ghFail("gh must not be called"));
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/pr", { runtime, ui });

    expect(ui.notices[0]?.text).toContain('No "origin" remote is configured');
    expect(calls.some((call) => call.command === "gh")).toBe(false);
    await runtime.dispose();
  });

  it("explains how to install gh when it is missing", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "feature-x");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await addOrigin(cwd, await createBareOrigin());

    const { exec, calls } = makeExec(() => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    });
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/pr", { runtime, ui });

    expect(ui.notices[0]?.text).toContain("cli.github.com");
    expect(calledWith(calls, "git", "push")).toBe(false);
    await runtime.dispose();
  });

  it("explains how to authenticate when gh is installed but signed out", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "feature-x");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await addOrigin(cwd, await createBareOrigin());

    const { exec, calls } = makeExec((args) => {
      const key = args.join(" ");
      if (key === "--version") return { stdout: "gh version 2.50.0", stderr: "" };
      return ghFail("not logged in to any GitHub hosts");
    });
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/pr", { runtime, ui });

    expect(ui.notices[0]?.text).toContain("gh auth login");
    expect(calledWith(calls, "git", "push")).toBe(false);
    await runtime.dispose();
  });

  it("prints the existing PR's URL instead of erroring, and never pushes again", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "feature-x");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    const origin = await createBareOrigin();
    await addOrigin(cwd, origin);

    const { exec, calls } = makeExec(
      readyGh((args) => {
        const key = args.join(" ");
        if (key.startsWith("pr view ")) {
          return {
            stdout: JSON.stringify({ url: "https://github.com/acme/repo/pull/7", number: 7 }),
            stderr: "",
          };
        }
        return ghFail(`unhandled: ${key}`);
      }),
    );
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/pr", { runtime, ui });

    expect(ui.notices.at(-1)?.text).toContain("https://github.com/acme/repo/pull/7");
    expect(ui.selects).toHaveLength(0);
    expect(calledWith(calls, "git", "push")).toBe(false);
    expect(calls.some((call) => call.args[0] === "pr" && call.args[1] === "create")).toBe(false);
    await runtime.dispose();
  });

  it("cancels before pushing when the user declines, leaving the remote untouched", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd, "feature-x");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    const origin = await createBareOrigin();
    await addOrigin(cwd, origin);

    const { exec, calls } = makeExec(
      readyGh((args) => {
        if (args.join(" ").startsWith("pr view ")) ghFail("no pull requests found");
        return ghFail("must not be reached");
      }),
    );
    const registry = registryFor(exec);
    const ui = fakeUi([false]);
    await registry.dispatch("/pr", { runtime, ui });

    expect(ui.notices.at(-1)?.text).toBe("PR cancelled.");
    expect(calledWith(calls, "git", "push")).toBe(false);
    expect((await remoteBranches(origin)).trim()).toBe("");
    await runtime.dispose();
  });
});

/* /review ----------------------------------------------------------------------- */

describe("parseReviewTarget", () => {
  it("empty text means the working tree", () => {
    expect(parseReviewTarget("")).toEqual({ kind: "working" });
    expect(parseReviewTarget("   ")).toEqual({ kind: "working" });
  });

  it('"staged" means the staged changes', () => {
    expect(parseReviewTarget("staged")).toEqual({ kind: "staged" });
  });

  it("a bare or hashed number means a PR", () => {
    expect(parseReviewTarget("123")).toEqual({ kind: "pr", number: "123" });
    expect(parseReviewTarget("#123")).toEqual({ kind: "pr", number: "123" });
  });

  it("text containing .. means a commit range", () => {
    expect(parseReviewTarget("main..HEAD")).toEqual({ kind: "range", range: "main..HEAD" });
    expect(parseReviewTarget("v1.0...v2.0")).toEqual({
      kind: "range",
      range: "v1.0...v2.0",
    });
  });

  it("anything else means a branch name", () => {
    expect(parseReviewTarget("feature/login")).toEqual({ kind: "branch", name: "feature/login" });
    expect(parseReviewTarget("develop")).toEqual({ kind: "branch", name: "develop" });
  });
});

describe("/review", () => {
  it("reviews the staged changes and renders the model's findings", async () => {
    const { runtime, cwd } = await setup([
      { text: "- **bug**: off-by-one error in the loop bound." },
    ]);
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await writeIn(cwd, "a.txt", "hello, world\n");
    await stage(cwd, "a.txt");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/review staged", { runtime, ui });

    expect(ui.lines.join("\n")).toContain("off-by-one error");
    const requests = (runtime.llm as FakeLLM).requests;
    expect(requests[0]?.system).toContain("REAL defects");
    await runtime.dispose();
  });

  it("reviews the working tree (unstaged + staged) against HEAD", async () => {
    const { runtime, cwd } = await setup([{ text: "Looks fine." }]);
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await writeIn(cwd, "a.txt", "hello, unstaged\n");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/review", { runtime, ui });

    const sentText = (runtime.llm as FakeLLM).requests[0]?.messages
      .flatMap((message) => (message.role === "user" ? message.content : []))
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(sentText).toContain("hello, unstaged");
    await runtime.dispose();
  });

  it("reviews a branch as branch...HEAD", async () => {
    const { runtime, cwd } = await setup([{ text: "Looks fine." }]);
    await initRepo(cwd, "main");
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");
    await execFileAsync("git", ["checkout", "-q", "-b", "feature"], { cwd });
    await writeIn(cwd, "b.txt", "new feature code\n");
    await commitAll(cwd, "add feature");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/review main", { runtime, ui });

    const sentText = (runtime.llm as FakeLLM).requests[0]?.messages
      .flatMap((message) => (message.role === "user" ? message.content : []))
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(sentText).toContain("new feature code");
    await runtime.dispose();
  });

  it("fetches a PR's diff via gh and never touches local git diffing for it", async () => {
    const { runtime, cwd } = await setup([{ text: "Looks fine." }]);
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");

    const { exec } = makeExec((args) => {
      if (args.join(" ") === "pr diff 55") {
        return { stdout: "diff --git a/x.ts b/x.ts\n+const risky = eval(input);\n", stderr: "" };
      }
      return ghFail("unexpected gh call");
    });
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/review 55", { runtime, ui });

    const sentText = (runtime.llm as FakeLLM).requests[0]?.messages
      .flatMap((message) => (message.role === "user" ? message.content : []))
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(sentText).toContain("eval(input)");
    await runtime.dispose();
  });

  it("reports when there is nothing to review", async () => {
    const { runtime, cwd } = await setup();
    await initRepo(cwd);
    await writeIn(cwd, "a.txt", "hello\n");
    await commitAll(cwd, "init");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/review staged", { runtime, ui });

    expect(ui.notices[0]?.text).toContain("No changes to review");
    expect((runtime.llm as FakeLLM).requests).toHaveLength(0);
    await runtime.dispose();
  });

  it("truncates an oversized diff with a clear notice, and caps what reaches the model", async () => {
    const { runtime, cwd } = await setup([{ text: "Looks fine." }]);
    await initRepo(cwd);
    // A staged diff comfortably larger than REVIEW_DIFF_CHAR_LIMIT.
    const big = Array.from({ length: 1200 }, (_, i) => `line ${i} of filler content here`).join(
      "\n",
    );
    await writeIn(cwd, "big.txt", `${big}\n`);
    await stage(cwd, "big.txt");

    const { exec } = makeExec();
    const registry = registryFor(exec);
    const ui = fakeUi();
    await registry.dispatch("/review staged", { runtime, ui });

    const warning = ui.notices.find((n) => n.level === "warn");
    expect(warning?.text).toContain("Diff truncated");
    expect(warning?.text).toContain(REVIEW_DIFF_CHAR_LIMIT.toLocaleString());

    const sentText = (runtime.llm as FakeLLM).requests[0]?.messages
      .flatMap((message) => (message.role === "user" ? message.content : []))
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    // The prompt's diff body must not exceed the cap by more than a small
    // fixed wrapper overhead (the surrounding "Review target:"/fence text).
    expect(sentText.length).toBeLessThan(REVIEW_DIFF_CHAR_LIMIT + 200);
    await runtime.dispose();
  });
});
