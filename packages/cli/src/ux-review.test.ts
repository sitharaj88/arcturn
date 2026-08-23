/**
 * Adversarial UX/regression review of the newly integrated features
 * (autocomplete, mentions, git-status, completions, print mode, commands).
 *
 * Tests marked with `it.fails` encode CONFIRMED bugs: the assertion states
 * the behavior a user would reasonably expect, and currently fails against
 * the real implementation. Everything else is a regression-locking test for
 * behavior verified to already work correctly.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ColorLevel, setColorLevel, stripAnsi, TestTerminal } from "@arcturn/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";
import { type CommandUi, createCommandRegistry, type SelectOption } from "./commands.js";
import { InteractiveApp } from "./interactive/app.js";
import { runPrint } from "./print.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

beforeAll(() => {
  setColorLevel(ColorLevel.None);
});

/* ------------------------------------------------------------------ */
/* Shared test scaffolding (mirrors commands.test.ts / app.test.ts)   */
/* ------------------------------------------------------------------ */

interface FakeUi extends CommandUi {
  lines: string[];
  notices: { level: string; text: string }[];
}

function fakeUi(answer: unknown = undefined): FakeUi {
  const ui: FakeUi = {
    lines: [],
    notices: [],
    print(content) {
      ui.lines.push(...(typeof content === "string" ? content.split("\n") : content));
    },
    notice(level, text) {
      ui.notices.push({ level, text });
    },
    async select<T>(_title: string, _options: readonly SelectOption<T>[]) {
      return answer as T | undefined;
    },
    setInput() {},
    clear() {},
    exit() {},
  };
  return ui;
}

const ENTER = "\r";
const CTRL_C = "";

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  { timeout = 10_000, label = "condition" }: { timeout?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(5);
  }
  throw new Error(`${label} was never met within ${timeout}ms`);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/* ==================================================================== */
/* 1. Command-registry gaps: /help, /export, /theme, /model refresh,    */
/*    /rewind. Task explicitly calls out these as untested elsewhere —  */
/*    commands.test.ts has zero coverage of any of them.                */
/* ==================================================================== */

describe("commands registry — gap coverage", () => {
  it("/help lists export, theme and rewind with a consistent column width", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const registry = createCommandRegistry();
    const ui = fakeUi();
    await registry.dispatch("/help", { runtime, ui });

    const body = ui.lines.join("\n");
    expect(body).toContain("/export");
    expect(body).toContain("/theme");
    expect(body).toContain("/rewind");

    // Every command row is `  /` + name.padEnd(width) + `  ` + description,
    // so the description must start at the same column on every row.
    const width = registry.list().reduce((max, c) => Math.max(max, c.name.length), 0);
    const descriptionColumn = 3 + width + 2;
    const rows = ui.lines.filter((line) => line.startsWith("  /"));
    expect(rows.length).toBe(registry.list().length);
    for (const row of rows) {
      expect(row.slice(descriptionColumn - 2, descriptionColumn)).toBe("  ");
      expect(row.slice(descriptionColumn, descriptionColumn + 1)).not.toBe(" ");
    }

    await runtime.dispose();
  });

  it("/export in a session with zero messages notices instead of writing a file or throwing", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const registry = createCommandRegistry();
    const ui = fakeUi();

    const result = await registry.dispatch("/export", { runtime, ui });

    expect(result).toEqual({ handled: true, command: "export" });
    expect(ui.notices).toEqual([{ level: "info", text: "Nothing to export yet." }]);
    await runtime.dispose();
  });

  it("/theme with an unknown name notices an error and does not throw or change the theme", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const registry = createCommandRegistry();
    const ui = fakeUi();

    const result = await registry.dispatch("/theme not-a-real-theme", { runtime, ui });

    expect(result).toEqual({ handled: true, command: "theme" });
    expect(ui.notices).toHaveLength(1);
    expect(ui.notices[0]?.level).toBe("error");
    expect(ui.notices[0]?.text).toContain('Unknown theme "not-a-real-theme"');
    await runtime.dispose();
  });

  it("/model refresh with no provider keys notices a warning instead of throwing", async () => {
    // listPresets() (called by the /model refresh handler) reads real
    // process.env, not the runtime's scoped env map — see the standalone
    // "env inconsistency" test below. This test only holds in an
    // environment with none of the live-catalog preset keys set.
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const registry = createCommandRegistry();
    const ui = fakeUi();

    const result = await registry.dispatch("/model refresh", { runtime, ui });

    expect(result).toEqual({ handled: true, command: "model" });
    expect(ui.notices).toEqual([
      { level: "warn", text: "No provider API keys found; nothing to refresh." },
    ]);
    await runtime.dispose();
  });

  it("/rewind with no checkpoints notices instead of throwing", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const registry = createCommandRegistry();
    const ui = fakeUi();

    const result = await registry.dispatch("/rewind", { runtime, ui });

    expect(result).toEqual({ handled: true, command: "rewind" });
    expect(ui.notices).toEqual([
      { level: "info", text: "No checkpoints recorded in this session yet." },
    ]);
    await runtime.dispose();
  });
});

/* ==================================================================== */
/* 2. CONFIRMED BUG: `arcturn -p` with piped stdin and no prompt argument   */
/*    is unreachable. main.ts documents and implements "piped stdin     */
/*    becomes the prompt", but args.ts rejects `--print` with an empty  */
/*    positional prompt before stdin is ever read, so that branch is    */
/*    dead code.                                                        */
/* ==================================================================== */

describe("FIXED: `arcturn -p` takes its prompt from piped stdin", () => {
  it("parseArgs accepts --print with no positional prompt only when stdin is piped", () => {
    // The check cannot fire purely from argv: an empty prompt is legitimate
    // when the prompt is arriving on stdin (`cat q.txt | arcturn -p`). It stays an
    // error for an interactive stdin, where there is nothing to read.
    expect(parseArgs(["-p"], { stdinIsTty: true }).ok).toBe(false);
    const piped = parseArgs(["-p"], { stdinIsTty: false });
    expect(piped.ok).toBe(true);
    if (piped.ok) expect(piped.args.print).toBe(true);
  });

  it("echo '...' | arcturn -p reaches model resolution using the piped text as the prompt", () => {
    const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    if (!existsSync(entry)) throw new Error("run `pnpm --filter arcturn build` first");

    const result = spawnSync(process.execPath, [entry, "-p"], {
      encoding: "utf8",
      input: "please summarize this\n",
      env: { PATH: process.env.PATH ?? "" }, // no ANTHROPIC_API_KEY, isolated-ish
    });

    // Argument parsing succeeds (the pipe supplies the prompt) and the run
    // gets as far as model resolution, which is what fails without a key.
    // Both failures exit 2, so the *message* is what distinguishes them.
    expect(result.stderr).not.toContain("needs a prompt");
    expect(result.stderr).toContain("No API key");
  });
});

/* ==================================================================== */
/* 3. CONFIRMED BUG: print mode (`arcturn -p`) never expands @-mentions.    */
/* The interactive path (InteractiveApp#onSubmit) calls expandMentions   */
/* before agent.prompt(); print.ts's runPrint() calls agent.prompt()    */
/* directly on the raw string, so `arcturn -p "look at @file.txt"` never    */
/* injects the file's contents the way the interactive TUI does.        */
/* ==================================================================== */

describe("FIXED: print mode expands @-mentions", () => {
  it("arcturn -p injects mentioned file content, matching interactive behavior", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch.cwd, "marker.txt"), "UNIQUE_MARKER_CONTENT_12345", "utf8");
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }]);

    const chunks: string[] = [];
    await runPrint({
      runtime,
      prompt: "please check @marker.txt now",
      stdout: (c) => chunks.push(c),
      stderr: () => {},
    });

    const sentMessages = JSON.stringify(runtime.agent.messages);
    // Expected: the file's content was appended to the prompt, as it would
    // be in the interactive app via expandMentions(). Actual: the mention
    // is passed straight through, untouched and unexpanded.
    expect(sentMessages).toContain("UNIQUE_MARKER_CONTENT_12345");

    await runtime.dispose();
  });
});

/* ==================================================================== */
/* 3b. CONFIRMED BUG: pressing Enter right after finishing an exact      */
/* `@mention` does not submit the message. The mention autocomplete      */
/* dropdown stays open even when the typed text is already the dropdown's */
/* only/exact match (unlike the "/" branch, which explicitly closes the  */
/* dropdown in that case — see the comment on that branch in app.ts).    */
/* Because the dropdown is still open, the Editor treats a bare Enter as */
/* "accept the highlighted suggestion", not "submit" (editor.ts's         */
/* handleInput step 2 takes priority over step 3). The user's Enter is   */
/* silently swallowed; they must press it a second time to actually send */
/* their message — a real dead end that reproduces on every message     */
/* that ends with a finished, unambiguous file mention.                  */
/* ==================================================================== */

describe("FIXED: Enter submits right after an exact @mention match", () => {
  it("submits on the first Enter after typing a complete, unambiguous @mention", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch.cwd, "secret.txt"), "top secret", "utf8");
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }]);
    const terminal = new TestTerminal({ columns: 80, rows: 24 });
    const app = new InteractiveApp({ runtime, terminal, streamThrottleMs: 5 });
    const exit = app.run();
    await tick();

    terminal.injectInput("please read @secret.txt");
    await tick();
    // The typed text *is* the only match, so the dropdown closes — leaving
    // Enter to mean "submit" rather than "accept the suggestion".
    expect(app.editor.isAutocompleteOpen).toBe(false);

    terminal.injectInput(ENTER);
    await tick();

    // The first Enter submits: the editor clears and the agent runs. The run
    // starts a tick later than the clear, since submitting now awaits
    // @-mention expansion before handing the prompt to the agent.
    expect(app.editor.text).toBe("");
    await waitFor(() => runtime.agent.messages.length > 0, {
      label: "the submitted prompt to reach the agent",
    });

    // Let the run settle before quitting: the first Ctrl+C interrupts a live
    // run rather than exiting, so a double press mid-run would never exit.
    await waitFor(() => !runtime.agent.isRunning, { label: "run to settle" });
    terminal.injectInput(CTRL_C);
    terminal.injectInput(CTRL_C);
    await exit;
    await runtime.dispose();
  }, 15_000);
});

/* ==================================================================== */
/* 4. Mention expansion errors: verified WORKING — #onSubmit surfaces   */
/*    them as an error notice rather than swallowing them or crashing   */
/*    the app, for both a typed prompt and the `initialPrompt` path.    */
/* ==================================================================== */

describe("interactive app — mention expansion error handling (verified working)", () => {
  // Windows: chmod's mode only toggles the read-only (write) attribute:
  // there is no POSIX owner/group/other bit, so `chmod(path, 0o000)` never
  // blocks a read there — the mention expands successfully and the EACCES
  // notice this test waits for never appears. Skipped rather than weakened;
  // POSIX platforms still assert the real EACCES-handling behavior below.
  it.skipIf(process.platform === "win32")(
    "surfaces an unreadable mentioned file as an error notice instead of crashing or hanging",
    async () => {
      const scratch = await makeScratch();
      await mkdir(scratch.cwd, { recursive: true });
      const secret = join(scratch.cwd, "secret.txt");
      await writeFile(secret, "top secret", "utf8");
      await chmod(secret, 0o000);

      const runtime = await buildTestRuntime(scratch, [{ text: "should not be reached" }]);
      const terminal = new TestTerminal({ columns: 80, rows: 24 });
      const app = new InteractiveApp({ runtime, terminal, streamThrottleMs: 5 });
      const exit = app.run();
      await tick();

      // Trailing words after the mention are important here: they move the
      // caret's current token off the finished "@secret.txt" mention before
      // Enter is pressed, so this test isn't also tripped up by the separate
      // "Enter is swallowed by an open, already-exact autocomplete dropdown"
      // bug confirmed below.
      terminal.injectInput(`please read @secret.txt right now${ENTER}`);
      await waitFor(() => stripAnsi(terminal.output).includes("EACCES"), {
        label: "an EACCES error notice",
      });

      // The agent must never have been asked to run — the error short-circuits
      // before agent.prompt() is called.
      expect(runtime.agent.isRunning).toBe(false);

      await chmod(secret, 0o644);
      terminal.injectInput(CTRL_C);
      terminal.injectInput(CTRL_C);
      await exit;
      await runtime.dispose();
    },
    15_000,
  );

  it("expands mentions in the initialPrompt path exactly like a typed prompt", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch.cwd, "notes.txt"), "INITIAL_PROMPT_MARKER_9876", "utf8");
    const runtime = await buildTestRuntime(scratch, [{ text: "got it" }]);
    const terminal = new TestTerminal({ columns: 80, rows: 24 });
    const app = new InteractiveApp({
      runtime,
      terminal,
      streamThrottleMs: 5,
      initialPrompt: "please read @notes.txt",
    });
    const exit = app.run();

    // Wait for the assistant's reply specifically (not just the user message,
    // which is queued synchronously the instant agent.prompt() starts) so the
    // turn has actually finished and the app is idle before we quit it.
    await waitFor(() => runtime.agent.messages.some((m) => m.role === "assistant"), {
      label: "the run to finish",
    });

    const sent = JSON.stringify(runtime.agent.messages[0]);
    expect(sent).toContain("INITIAL_PROMPT_MARKER_9876");

    // Not exercising the Ctrl+C quit gesture here: `agent.messages` gains its
    // final assistant entry very slightly before `agent.isRunning` clears
    // (a core-agent timing detail, not part of this review's scope), so a
    // Ctrl+C sent immediately after the assertion above can still land on
    // the "abort" branch and re-arm the exit countdown instead of quitting.
    // Tear down directly instead of exercising InteractiveApp#run()'s exit path.
    void exit;
    await runtime.dispose();
  }, 15_000);
});

/* ==================================================================== */
/* 5. CLI surface: completions and --print argument validation          */
/*    (verified WORKING end-to-end against the built dist).             */
/* ==================================================================== */

describe("CLI surface — completions (verified working)", () => {
  const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const hasDist = existsSync(entry);

  it.skipIf(!hasDist)("`arcturn completions bash` prints a script that bash -n accepts", () => {
    const result = spawnSync(process.execPath, [entry, "completions", "bash"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const check = spawnSync("bash", ["-n"], { input: result.stdout, encoding: "utf8" });
    expect(check.status).toBe(0);
  });

  it.skipIf(!hasDist)("`arcturn completions` with no shell errors cleanly with exit code 2", () => {
    const result = spawnSync(process.execPath, [entry, "completions"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("completions needs exactly one shell");
  });
});
