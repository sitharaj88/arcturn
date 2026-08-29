import { join } from "node:path";
import { registerModel, unregisterModel } from "@arcturn/ai";
import {
  ColorLevel,
  darkTheme,
  lightTheme,
  setColorLevel,
  setTheme,
  stripAnsi,
  TestTerminal,
  type Theme,
  type ThemeToken,
} from "@arcturn/tui";
import type { LLMClient, LLMRequest, StreamEvent, Usage } from "@arcturn/types";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ArcturnRuntime } from "../runtime.js";
import { buildTestRuntime, makeScratch, writeFileAt } from "../test-helpers/scratch.js";
import { InteractiveApp } from "./app.js";

beforeAll(() => {
  setColorLevel(ColorLevel.None);
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const ESCAPE = "\u001b";
const ENTER = "\r";
const DOWN = "\u001b[B";
const CTRL_A = "\u0001";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

/** Yield to the event loop so queued microtasks and timers run. */
async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `predicate` holds.
 *
 * The budget is generous because the whole suite runs these UI tests in
 * parallel with everything else; a tight deadline flakes under load rather
 * than catching real regressions.
 */
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

interface Harness {
  app: InteractiveApp;
  terminal: TestTerminal;
  runtime: ArcturnRuntime;
  exit: Promise<number>;
  text: () => string;
}

async function harness(
  turns: Parameters<typeof buildTestRuntime>[1] = [{ text: "hello there" }],
  overrides: Parameters<typeof buildTestRuntime>[2] = {},
  ui: "inline" | "screen" = "inline",
): Promise<Harness> {
  const scratch = await makeScratch();
  // Most of this suite pins the classic inline renderer's behavior; the
  // screen-mode describe block below opts into the full-screen app instead.
  await writeFileAt(join(scratch.cwd, ".arcturn", "config.json"), JSON.stringify({ ui }));
  const runtime = await buildTestRuntime(scratch, turns, overrides);
  const terminal = new TestTerminal({ columns: 80, rows: 24 });
  const app = new InteractiveApp({ runtime, terminal, streamThrottleMs: 5 });
  const exit = app.run();
  await tick();
  cleanups.push(async () => {
    // The first Ctrl+C interrupts a run, so wait for the agent to go idle
    // before using a double press to quit.
    await waitFor(() => !runtime.agent.isRunning, { timeout: 12_000 }).catch(() => undefined);
    terminal.injectInput(CTRL_C);
    terminal.injectInput(CTRL_C);
    await exit;
  });
  return { app, terminal, runtime, exit, text: () => stripAnsi(terminal.output) };
}

describe("InteractiveApp", () => {
  it("prints a bannered welcome card with the model, mode and working directory", async () => {
    const h = await harness();
    const text = h.text();
    // The card is a rounded box, so its border corners must be present.
    expect(text).toContain("╭");
    expect(text).toContain("╰");
    // The hero banner carries the block-art ✦ mark and the cursor wordmark.
    expect(text).toContain("█");
    expect(text).toContain("▀"); // pixel wordmark rows
    expect(text).toContain("every turn counts");
    expect(text).toContain("Claude Sonnet 4.5");
    expect(text).toContain("default"); // the mode row
    // The working directory is shown (its head survives any width clipping).
    expect(text).toContain(h.runtime.cwd.slice(0, 12));
    expect(text).toContain("commands");
  });

  it("keeps the banner out of the live region so a resize can never smear it", async () => {
    const h = await harness();
    // The banner was printed once, into scrollback — not into the repainted
    // block. A live banner gets rewrapped by the terminal on resize; once its
    // top rows slip into scrollback they are unreachable, and every resize
    // would leave a stale copy behind.
    expect(h.text()).toContain("every turn counts");
    expect(stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"))).not.toContain(
      "every turn counts",
    );

    // Resizing repaints only the small live block; the banner is not painted
    // again at the new width.
    const before = h.text().split("every turn counts").length;
    h.terminal.resize(48, 24);
    await tick();
    h.terminal.resize(100, 30);
    await tick();
    expect(h.text().split("every turn counts").length).toBe(before);
  });

  it("prints the banner above the first transcript lines", async () => {
    const h = await harness([{ text: "hi there" }]);
    h.terminal.injectInput(`hello${ENTER}`);
    await waitFor(() => h.text().includes("hi there"));
    const text = h.text();
    // Scrollback order: banner first, transcript below, exactly one banner.
    expect(text.indexOf("every turn counts")).toBeLessThan(text.indexOf("hi there"));
    expect(text.split("every turn counts").length).toBe(2);
  });

  it("renders the bordered editor box and the status bar", async () => {
    const h = await harness();
    const text = h.text();
    expect(text).toContain("Ask arcturn anything");
    expect(text).toContain("ctx 0%");
    expect(text).toContain("$0.00");
    // The prompt editor is wrapped in a bordered box, with the mode in the footer.
    const frame = stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"));
    expect(frame).toContain("╭");
    expect(frame).toContain("╰");
    expect(frame).toMatch(/default\s*[─-]*╯/);
  });

  it("switches the input box footer from the mode to a steering hint while running", async () => {
    const h = await harness([{ text: "slow", delayMs: 500 }]);
    const idle = stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"));
    // Idle: the bottom border carries the permission mode.
    expect(idle).toMatch(/default\s*[─-]*╯/);
    expect(idle).not.toContain("steering");

    h.terminal.injectInput(`go${ENTER}`);
    await waitFor(() => h.runtime.agent.isRunning);
    const running = stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"));
    // Running: the footer swaps to the steering hint so the box reads "busy".
    expect(running).toContain("steering");
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });
  });

  it("runs a submitted prompt and prints the answer to scrollback", async () => {
    const h = await harness([{ text: "the answer is 42" }]);
    h.terminal.injectInput(`what is the answer?${ENTER}`);
    await waitFor(() => h.text().includes("the answer is 42"));

    const text = h.text();
    expect(text).toContain("▌ what is the answer?");
    expect(text).toContain("the answer is 42");
    expect(h.runtime.agent.finalText()).toBe("the answer is 42");
  });

  it("closes a completed run with a faint duration-and-tokens summary line", async () => {
    const h = await harness([{ text: "done deal" }]);
    h.terminal.injectInput(`go${ENTER}`);
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });
    await waitFor(() => /✓ \d+s · [\d.]+k? tokens/.test(h.text()), {
      label: "run summary line",
    });
  });

  it("shows tool activity as compact transcript blocks", async () => {
    const h = await harness(
      [
        { toolCalls: [{ id: "t1", name: "ls", arguments: { path: "." } }] },
        { text: "nothing here" },
      ],
      { permissionMode: "yolo" },
    );
    h.terminal.injectInput(`look around${ENTER}`);
    await waitFor(() => h.text().includes("nothing here"));
    expect(h.text()).toContain("ls");
  });

  it("dispatches slash commands typed into the editor", async () => {
    const h = await harness();
    h.terminal.injectInput(`/help${ENTER}`);
    await waitFor(() => h.text().includes("/compact"));
    expect(h.text()).toContain("Commands");
    expect(h.text()).toContain("/sessions");
  });

  it("reports unknown slash commands", async () => {
    const h = await harness();
    h.terminal.injectInput(`/definitelynot${ENTER}`);
    await waitFor(() => h.text().includes("Unknown command"));
  });

  it("offers command completions while typing a slash", async () => {
    const h = await harness();
    h.terminal.injectInput("/co");
    await waitFor(() => h.app.editor.isAutocompleteOpen);
    expect(h.app.editor.suggestions.map((entry) => entry.value).sort()).toEqual([
      "/commit",
      "/compact",
      "/cost",
    ]);
  });

  it("turns a submission during a run into a steering message", async () => {
    const h = await harness([{ text: "slow answer", delayMs: 250 }, { text: "second" }]);
    h.terminal.injectInput(`start${ENTER}`);
    await waitFor(() => h.runtime.agent.isRunning);
    h.terminal.injectInput(`also do this${ENTER}`);
    await waitFor(() => h.text().includes("steering the run"));
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });
  });

  it("aborts the run on escape", async () => {
    const h = await harness([{ text: "slow", delayMs: 1_000 }]);
    h.terminal.injectInput(`start${ENTER}`);
    await waitFor(() => h.runtime.agent.isRunning);
    h.terminal.injectInput(ESCAPE);
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });
    expect(h.text()).toContain("Interrupted");
  });

  it("interrupts a run on the first Ctrl+C and exits on a double press when idle", async () => {
    const h = await harness([{ text: "slow", delayMs: 500 }]);
    h.terminal.injectInput(`start${ENTER}`);
    await waitFor(() => h.runtime.agent.isRunning);
    h.terminal.injectInput(CTRL_C);
    expect(h.text()).toContain("Interrupting");
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });

    h.terminal.injectInput(CTRL_C);
    await waitFor(() => h.text().includes("Press Ctrl+C again"));
    h.terminal.injectInput(CTRL_C);
    expect(await h.exit).toBe(0);
    cleanups.length = 0;
  });

  it("exits on Ctrl+D with an empty buffer", async () => {
    const h = await harness();
    h.terminal.injectInput(CTRL_D);
    expect(await h.exit).toBe(0);
    cleanups.length = 0;
  });

  it("keeps Ctrl+D as forward-delete when the buffer is not empty", async () => {
    const h = await harness();
    h.terminal.injectInput("abc");
    h.terminal.injectInput(CTRL_A); // Ctrl+A: move to line start
    h.terminal.injectInput(CTRL_D);
    await tick();
    expect(h.app.editor.text).toBe("bc");
  });

  it("shows a permission dialog and runs the tool once allowed", async () => {
    const h = await harness([
      { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "echo hi" } }] },
      { text: "it printed hi" },
    ]);
    h.terminal.injectInput(`echo something${ENTER}`);
    await waitFor(() => h.app.tui.overlay !== null);
    expect(h.text()).toContain("Permission");
    expect(h.text()).toContain("Allow once");
    expect(h.text()).toContain("echo hi");

    h.terminal.injectInput(ENTER); // "Allow once" is highlighted first
    await waitFor(() => h.text().includes("it printed hi"), { timeout: 12_000 });
    expect(h.app.tui.overlay).toBeNull();
  });

  it("persists a project rule when the user picks 'allow always'", async () => {
    const h = await harness([
      { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "echo hi" } }] },
      { text: "done" },
    ]);
    h.terminal.injectInput(`echo something${ENTER}`);
    await waitFor(() => h.app.tui.overlay !== null);
    h.terminal.injectInput(DOWN); // down to "Allow always"
    h.terminal.injectInput(ENTER);
    await waitFor(() => h.text().includes("done"), { timeout: 12_000 });
    await waitFor(() =>
      h.runtime.agent.permissions.rules.some(
        (rule) => rule.tool === "bash" && rule.specifier === "echo *",
      ),
    );
  });

  it("denies the tool and tells the model why", async () => {
    const h = await harness([
      { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "rm -rf /" } }] },
      { text: "understood" },
    ]);
    h.terminal.injectInput(`delete everything${ENTER}`);
    await waitFor(() => h.app.tui.overlay !== null);
    h.terminal.injectInput(DOWN);
    h.terminal.injectInput(DOWN); // down twice to "Deny"
    h.terminal.injectInput(ENTER);
    await waitFor(() => h.text().includes("understood"), { timeout: 12_000 });

    const results = h.runtime.agent.messages.filter((message) => message.role === "toolResult");
    expect(results[0]?.isError).toBe(true);
  });

  it("shows the plan-approval dialog in plan mode and leaves plan mode on approval", async () => {
    const h = await harness(
      [
        {
          toolCalls: [
            { id: "t1", name: "plan", arguments: { plan: "# Step one\n\nDo the thing." } },
          ],
        },
        { text: "starting" },
      ],
      { permissionMode: "plan" },
    );
    h.terminal.injectInput(`plan the work${ENTER}`);
    await waitFor(() => h.app.tui.overlay !== null);
    expect(h.text()).toContain("Plan ready");
    expect(h.text()).toContain("Step one");

    h.terminal.injectInput(ENTER); // "Approve"
    await waitFor(() => h.text().includes("starting"), { timeout: 12_000 });
    expect(h.runtime.permissionMode).toBe("default");
  });

  it("renders the todo checklist in the live region", async () => {
    const h = await harness([
      {
        toolCalls: [
          {
            id: "t1",
            name: "todo",
            arguments: {
              todos: [
                { text: "read the code", status: "done" },
                { text: "write the code", status: "inProgress" },
              ],
            },
          },
        ],
      },
      { text: "on it" },
    ]);
    h.terminal.injectInput(`get to work${ENTER}`);
    await waitFor(() => h.text().includes("on it"), { timeout: 12_000 });
    const frame = stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"));
    expect(frame).toContain("Todos ▰▱ 1/2");
    expect(frame).toContain("write the code");
  });

  it("counts sub-agent tokens in the run receipt", async () => {
    // The parent delegates, the child does the expensive work, the parent
    // wraps up. All three turns come off the same script, in that order.
    const h = await harness(
      [
        {
          toolCalls: [{ id: "s1", name: "subagent", arguments: { task: "do the heavy lifting" } }],
          usage: { outputTokens: 100 },
        },
        { text: "child is done", usage: { outputTokens: 5_000 } },
        { text: "all wrapped up", usage: { outputTokens: 200 } },
      ],
      { permissionMode: "yolo" },
    );
    h.terminal.injectInput(`delegate this${ENTER}`);
    await waitFor(() => h.text().includes("all wrapped up"), { timeout: 12_000 });
    await waitFor(() => /✓ .*tokens/.test(h.text()), { label: "run receipt", timeout: 12_000 });
    // Before the fix the receipt counted only the parent's 300 and reported
    // "300 tokens", hiding everything the sub-agent spent.
    expect(h.text()).toContain("5.3k tokens");
  });

  it("updates the status bar after a turn", async () => {
    const h = await harness([{ text: "hi", usage: { inputTokens: 5_000, outputTokens: 1_000 } }]);
    h.terminal.injectInput(`hello${ENTER}`);
    await waitFor(() => h.text().includes("hi"));
    const frame = stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"));
    expect(frame).toContain("arcturn");
    expect(frame).toContain("Claude Sonnet 4.5");
    expect(frame).toMatch(/ctx \d+%/);
  });

  it("never shows $0.00 in the footer for a model with no published pricing", async () => {
    // The reported bug: a session on an unpriced model sat at "$0.00" for its
    // whole life, which reads as "this is free" rather than "arcturn cannot
    // price this". Nothing about the spend is known, so the footer says so.
    registerModel({
      id: "test/unpriced-footer",
      provider: "openai-compatible",
      model: "unpriced-1",
      displayName: "Unpriced Test Model",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
    });
    const h = await harness([{ text: "hi", usage: { inputTokens: 5_000, outputTokens: 1_000 } }], {
      model: "test/unpriced-footer",
    });
    h.terminal.injectInput(`hello${ENTER}`);
    await waitFor(() => h.runtime.metrics.turns > 0, { label: "the turn to be recorded" });
    await waitFor(
      () => stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n")).includes("cost n/a"),
      { label: "an honest cost segment" },
    );
    expect(stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"))).not.toContain("$0.00");
    unregisterModel("test/unpriced-footer");
  });

  it("clears the transcript and starts a new session on /clear", async () => {
    const h = await harness([{ text: "first" }, { text: "second" }]);
    h.terminal.injectInput(`hello${ENTER}`);
    await waitFor(() => h.text().includes("first"));
    // /clear refuses to start a new session while a run is in flight, and the
    // assistant's text reaches the transcript before the run settles, so wait
    // for idle rather than for the text alone.
    await waitFor(() => !h.runtime.agent.isRunning, { label: "run to settle" });
    const sessionId = h.runtime.agent.sessionId;

    h.terminal.injectInput(`/clear${ENTER}`);
    await waitFor(() => h.runtime.agent.sessionId !== sessionId);
    expect(h.runtime.agent.messages).toHaveLength(0);
  });
});

describe("InteractiveApp in screen mode", () => {
  async function screenHarness(
    turns: Parameters<typeof buildTestRuntime>[1] = [{ text: "hello there" }],
  ): Promise<Harness> {
    return harness(turns, {}, "screen");
  }

  it("hands the mouse back on a drag, and re-takes it on the next keystroke", async () => {
    // The grab exists for wheel scrolling; a drag is the gesture that wanted
    // the terminal's own selection instead. First drag = handover (with a
    // one-time hint), next drag selects natively, any keystroke re-grabs.
    const h = await screenHarness();
    expect(h.terminal.isMouseEnabled).toBe(true);

    h.terminal.injectInput("\u001b[<0;10;5M\u001b[<0;30;5m");
    await tick();
    expect(h.terminal.isMouseEnabled).toBe(false);
    expect(h.text()).toContain("Mouse handed back to the terminal");

    h.terminal.injectInput("a");
    await tick();
    expect(h.terminal.isMouseEnabled).toBe(true);
  });

  it("keeps the handover through PgUp/PgDn, so older screens can be selected", async () => {
    // The alternate screen has no scrollback for the terminal to select from:
    // paging the viewport is the only way to put older content under the
    // mouse. If paging re-took the wheel, only the bottom screenful would
    // ever be selectable — the exact complaint this exists to fix.
    const h = await screenHarness();
    h.terminal.injectInput("\u001b[<0;10;5M\u001b[<0;30;5m");
    await tick();
    expect(h.terminal.isMouseEnabled).toBe(false);

    h.terminal.injectInput("\u001b[5~"); // PgUp
    await tick();
    expect(h.terminal.isMouseEnabled).toBe(false);
    h.terminal.injectInput("\u001b[6~"); // PgDn
    await tick();
    expect(h.terminal.isMouseEnabled).toBe(false);

    h.terminal.injectInput("a");
    await tick();
    expect(h.terminal.isMouseEnabled).toBe(true);
  });

  it("keeps the mouse on a plain click, and releases it on a double-click", async () => {
    const h = await screenHarness();

    // One click, same cell down and up: focus, not selection.
    h.terminal.injectInput("\u001b[<0;10;5M\u001b[<0;10;5m");
    await tick();
    expect(h.terminal.isMouseEnabled).toBe(true);

    // The second press of a double-click: the word-select gesture.
    h.terminal.injectInput("\u001b[<0;10;5M");
    await tick();
    expect(h.terminal.isMouseEnabled).toBe(false);
  });

  it("enters the alternate screen and shows the banner in the viewport", async () => {
    const h = await screenHarness();
    expect(h.terminal.output).toContain("\u001b[?1049h");
    const text = h.text();
    expect(text).toContain("every turn counts");
    expect(text).toContain("Ask arcturn anything");
  });

  it("paints full frames: exactly one input box at any size", async () => {
    const h = await screenHarness();
    for (const [cols, rows] of [
      [100, 30],
      [46, 14],
      [130, 50],
      [60, 20],
    ] as const) {
      h.terminal.resize(cols, rows);
      await tick();
      const frame = stripAnsi(h.app.tui.buildFrame(cols, rows).lines.join("\n"));
      expect(frame.split("Ask arcturn anything").length).toBe(2);
      // The frame never exceeds the viewport: nothing can spill into history.
      expect(h.app.tui.buildFrame(cols, rows).lines.length).toBeLessThanOrEqual(rows);
    }
  });

  it("keeps the transcript and answer inside the scrolling viewport", async () => {
    const h = await screenHarness([{ text: "the answer is 42" }]);
    h.terminal.injectInput(`what is the answer?${ENTER}`);
    await waitFor(() => h.text().includes("the answer is 42"));
    const frame = stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"));
    expect(frame).toContain("the answer is 42");
    expect(frame).toContain("Ask arcturn anything");
  });

  it("leaves the shell untouched on exit — no transcript reprint", async () => {
    // Exiting the alternate screen must restore the shell exactly as it was,
    // the way other alt-screen apps behave. The session is durable in the
    // store (`--resume`) and exportable (`/export`); reprinting it here would
    // also paint theme-inked text straight onto the terminal's own ground,
    // where a light theme's dark ink is unreadable on a dark terminal.
    const h = await screenHarness([{ text: "persisted answer" }]);
    h.terminal.injectInput(`go${ENTER}`);
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });
    await waitFor(() => /✓ \d+s/.test(h.text()), { label: "run summary" });
    h.terminal.injectInput(CTRL_D);
    await h.exit;
    const output = h.terminal.output;
    const leave = output.lastIndexOf("\u001b[?1049l");
    expect(leave).toBeGreaterThan(-1);
    // Nothing of the session may follow the alternate-screen pop.
    const after = stripAnsi(output.slice(leave));
    expect(after).not.toContain("persisted answer");
    expect(after).not.toContain("every turn counts");
    expect(after.trim()).toBe("");
  });
});

describe("terminal background sync (OSC 11)", () => {
  const OSC_SET = (color: string) => `\u001b]11;${color}\u0007`;

  it("sets the theme ground on start, re-syncs on switch, restores on exit", async () => {
    setColorLevel(ColorLevel.TrueColor);
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ ui: "screen" }),
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }]);
    const terminal = new TestTerminal({ columns: 80, rows: 24 });
    const app = new InteractiveApp({
      runtime,
      terminal,
      streamThrottleMs: 5,
      queryTerminalBackground: async () => "rgb:2a2a/2a2a/2a2a",
    });
    const exit = app.run();
    await waitFor(() => terminal.output.includes(OSC_SET("#0c0a07")), { label: "dark ground set" });

    setTheme(lightTheme);
    await waitFor(() => terminal.output.includes(OSC_SET("#faf6ef")), {
      label: "light ground set",
    });

    terminal.injectInput(CTRL_C);
    terminal.injectInput(CTRL_C);
    await exit;
    // The user's terminal is restored verbatim, after the last themed set.
    const restored = terminal.output.lastIndexOf(OSC_SET("rgb:2a2a/2a2a/2a2a"));
    expect(restored).toBeGreaterThan(terminal.output.lastIndexOf(OSC_SET("#faf6ef")));
    setTheme(darkTheme);
    setColorLevel(ColorLevel.None);
  });

  it("hands the ground to the terminal once the OSC sync is live", async () => {
    setColorLevel(ColorLevel.TrueColor);
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ ui: "screen" }),
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }]);
    const terminal = new TestTerminal({ columns: 80, rows: 24 });
    const app = new InteractiveApp({
      runtime,
      terminal,
      streamThrottleMs: 5,
      queryTerminalBackground: async () => "rgb:2a2a/2a2a/2a2a",
    });
    const exit = app.run();
    await waitFor(() => terminal.output.includes(OSC_SET("#0c0a07")), { label: "ground synced" });
    await tick(10);
    // With the terminal's default background carrying the theme ground, no
    // cell may paint it — mixing opaque cells with the terminal's composited
    // default shows the same colour in two shades under background blur.
    expect(terminal.output).not.toContain("\u001b[48;2;12;10;7m");
    terminal.injectInput(CTRL_C);
    terminal.injectInput(CTRL_C);
    await exit;
    setTheme(darkTheme);
    setColorLevel(ColorLevel.None);
  });

  it("never touches the terminal background when the original is unknown", async () => {
    setColorLevel(ColorLevel.TrueColor);
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ ui: "screen" }),
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }]);
    const terminal = new TestTerminal({ columns: 80, rows: 24 });
    const app = new InteractiveApp({
      runtime,
      terminal,
      streamThrottleMs: 5,
      queryTerminalBackground: async () => undefined,
    });
    const exit = app.run();
    await tick(10);
    expect(terminal.output).not.toContain("\u001b]11;");
    terminal.injectInput(CTRL_C);
    terminal.injectInput(CTRL_C);
    await exit;
    expect(terminal.output).not.toContain("\u001b]11;");
    setTheme(darkTheme);
    setColorLevel(ColorLevel.None);
  });
});

describe("screen-mode hero responsiveness", () => {
  it("re-lays the banner out at the current width on resize", async () => {
    const h = await harness([{ text: "hi" }], {}, "screen");
    // The launch ignition sweeps the wordmark alight over ~500ms.
    await waitFor(() => stripAnsi(h.app.tui.buildFrame(120, 40).lines.join("\n")).includes("█"), {
      label: "wordmark ignition",
    });
    const wide = stripAnsi(h.app.tui.buildFrame(120, 40).lines.join("\n"));
    expect(wide).toContain("every turn counts");

    // Narrow below the wordmark: the hero swaps to the framed card, and no
    // row of the frame exceeds the new width — nothing wraps into garbage.
    h.terminal.resize(48, 24);
    await tick();
    const frame = h.app.tui.buildFrame(48, 24).lines;
    const text = stripAnsi(frame.join("\n"));
    expect(text).not.toContain("█");
    expect(text).toContain("arcturn");
    for (const line of frame) expect(stripAnsi(line).length).toBeLessThanOrEqual(48);

    // And back: the pixel wordmark returns at full width.
    h.terminal.resize(120, 40);
    await tick();
    expect(stripAnsi(h.app.tui.buildFrame(120, 40).lines.join("\n"))).toContain("█");
  });
});

/** A client whose first turn dictates one tool call's arguments slowly. */
function argStreamLLM(
  chunks: readonly string[],
  call: { id: string; name: string; arguments: Record<string, unknown> },
  stepMs = 20,
): { llm: LLMClient; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const usage: Usage = {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let turn = 0;

  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const model = request.model.id;
    yield { type: "start", model };

    if (turn++ > 0) {
      yield { type: "textStart", blockIndex: 0 };
      yield { type: "textDelta", blockIndex: 0, delta: "all written" };
      yield { type: "blockEnd", blockIndex: 0 };
      yield { type: "usage", usage };
      yield {
        type: "end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "all written" }],
          model,
          usage,
          stopReason: "endTurn",
          timestamp: Date.now(),
        },
      };
      return;
    }

    yield { type: "toolCallStart", blockIndex: 0, id: call.id, name: call.name };
    for (const chunk of chunks) {
      await tick(stepMs);
      if (request.signal?.aborted) break;
      yield { type: "toolCallDelta", blockIndex: 0, argumentsDelta: chunk };
    }
    // Hold the turn open with the arguments still in flight, exactly like a
    // model part-way through dictating a large file.
    while (!request.signal?.aborted) {
      const settled = await Promise.race([gate.then(() => true), tick(10).then(() => false)]);
      if (settled) break;
    }

    // An interrupt tears the stream down mid-arguments: no `toolCallEnd`, no
    // `end`, nothing that would tidy the progress line on its way out.
    if (request.signal?.aborted) return;

    yield {
      type: "toolCallEnd",
      blockIndex: 0,
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    };
    yield { type: "blockEnd", blockIndex: 0 };
    yield { type: "usage", usage };
    yield {
      type: "end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments }],
        model,
        usage,
        stopReason: "toolCalls",
        timestamp: Date.now(),
      },
    };
  }

  return {
    llm: {
      stream,
      async complete(): Promise<never> {
        throw new Error("unused");
      },
    },
    release,
  };
}

/** Every "… chars" figure the live region has painted, in order. */
function charFigures(text: string): string[] {
  return [...text.matchAll(/([\d.]+k?) chars/g)].map((match) => match[1] ?? "");
}

describe("tool-call argument streaming", () => {
  const chunk = "x".repeat(2_000);

  it("shows a live progress line whose character count grows as arguments stream", async () => {
    const stub = argStreamLLM([chunk, chunk, chunk, chunk, chunk], {
      id: "w1",
      name: "write",
      arguments: { path: "out.html", content: "<html/>" },
    });
    const h = await harness([], { llm: stub.llm, permissionMode: "yolo" });
    h.terminal.injectInput(`rewrite the page${ENTER}`);

    await waitFor(() => charFigures(h.text()).length >= 2, {
      label: "tool-call progress line",
    });
    const text = h.text();
    expect(text).toContain("write");
    const figures = charFigures(text);
    // The figure must move: a frozen count is the silent-spinner bug again.
    expect(new Set(figures).size).toBeGreaterThan(1);
    expect(figures.at(-1)).not.toBe(figures[0]);

    stub.release();
    await waitFor(() => h.text().includes("all written"), { timeout: 12_000 });
  });

  it("clears the progress line once the tool starts running and the turn ends", async () => {
    const stub = argStreamLLM([chunk, chunk], {
      id: "w2",
      name: "write",
      arguments: { path: "out.txt", content: "hello" },
    });
    const h = await harness([], { llm: stub.llm, permissionMode: "yolo" });
    h.terminal.injectInput(`write it${ENTER}`);
    await waitFor(() => charFigures(h.text()).length >= 1, { label: "progress line" });
    stub.release();

    await waitFor(() => h.text().includes("all written"), { timeout: 12_000 });
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });
    const frame = stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"));
    expect(frame).not.toMatch(/chars/);
  });

  it("leaves no ghost progress line after an interrupt", async () => {
    const stub = argStreamLLM([chunk, chunk, chunk, chunk, chunk, chunk], {
      id: "w3",
      name: "write",
      arguments: { path: "out.txt", content: "hello" },
    });
    const h = await harness([], { llm: stub.llm, permissionMode: "yolo" });
    h.terminal.injectInput(`write it${ENTER}`);
    await waitFor(() => charFigures(h.text()).length >= 1, { label: "progress line" });

    h.terminal.injectInput(ESCAPE);
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });
    await tick(20);
    const frame = stripAnsi(h.app.tui.buildFrame(80, 24).lines.join("\n"));
    expect(frame).not.toMatch(/chars/);
    stub.release();
  });
});

/**
 * The escape sequence a token opens with under the active colour level.
 *
 * Comparing raw sequences is the only way to prove a *re-paint*: the text of a
 * re-themed line is identical, only its ANSI changes.
 */
function open(theme: Theme, token: ThemeToken): string {
  const painted = theme.styles[token]("x");
  return painted.slice(0, painted.indexOf("x"));
}

describe("theme switching", () => {
  beforeEach(() => {
    // Every assertion here compares escape sequences, so this block needs real
    // colour where the rest of the suite runs plain.
    setColorLevel(ColorLevel.TrueColor);
  });

  afterEach(() => {
    setTheme(darkTheme);
    setColorLevel(ColorLevel.None);
  });

  /** A run that leaves a tool card and a markdown table in the transcript. */
  const cardAndTable = [
    { toolCalls: [{ id: "t1", name: "ls", arguments: { path: "." } }] },
    { text: "| col | val |\n| --- | --- |\n| a | 1 |" },
  ];

  it("re-paints the whole screen-mode transcript in the new palette", async () => {
    const h = await harness(cardAndTable, { permissionMode: "yolo" }, "screen");
    h.terminal.injectInput(`list it${ENTER}`);
    await waitFor(() => h.text().includes("col"), { label: "assistant table" });
    await waitFor(() => !h.runtime.agent.isRunning, { timeout: 12_000 });

    const before = h.app.tui.buildFrame(80, 24).lines.join("\n");
    expect(stripAnsi(before)).toContain("ls");
    expect(before).toContain(open(darkTheme, "accent"));
    expect(before).toContain(open(darkTheme, "tableBorder"));

    setTheme(lightTheme);
    await tick(30);

    const after = h.app.tui.buildFrame(80, 24).lines.join("\n");
    // The same old content is still on screen …
    expect(stripAnsi(after)).toContain("ls");
    expect(stripAnsi(after)).toContain("col");
    // … wearing the new palette, with none of the old one left anywhere.
    expect(after).toContain(open(lightTheme, "accent"));
    expect(after).toContain(open(lightTheme, "tableBorder"));
    expect(after).not.toContain(open(darkTheme, "accent"));
    expect(after).not.toContain(open(darkTheme, "tableBorder"));
  });

  it("re-styles the cached banner and status-bar zones", async () => {
    const h = await harness([{ text: "hi" }], {}, "screen");
    await waitFor(
      () => h.app.tui.buildFrame(80, 24).lines.join("\n").includes(open(darkTheme, "hr")),
      {
        label: "status rule",
      },
    );

    setTheme(lightTheme);
    await tick(30);

    const after = h.app.tui.buildFrame(80, 24).lines.join("\n");
    // The status rule is a CachedDynamic whose own version never changes, and
    // the banner is memoized per width: both bake ANSI.
    expect(after).toContain(open(lightTheme, "hr"));
    expect(after).not.toContain(open(darkTheme, "hr"));
    expect(stripAnsi(after)).toContain("every turn counts");
    expect(after).not.toContain(open(darkTheme, "accent"));
  });

  /** Wait until the app has stopped writing, so the next byte is ours to explain. */
  async function settle(terminal: TestTerminal): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      const before = terminal.output.length;
      await tick(25);
      if (terminal.output.length === before) return;
    }
  }

  it("re-styles the inline live region immediately", async () => {
    const h = await harness([{ text: "hi" }], {}, "inline");
    await settle(h.terminal);
    const mark = h.terminal.output.length;

    setTheme(lightTheme);
    await tick(30);

    // Inline scrollback cannot be restyled, but the live block is repainted
    // the moment the theme changes — no keystroke required.
    const painted = h.terminal.output.slice(mark);
    expect(painted).toContain(open(lightTheme, "accent"));
  });

  it("stops listening once the app exits, so instances never pile up", async () => {
    const first = await harness([{ text: "hi" }], {}, "inline");
    first.terminal.injectInput(CTRL_D);
    await first.exit;

    // A second app in the same process: its constructor re-installs the dark
    // theme, and only it may react to the switch.
    const second = await harness([{ text: "hi" }], {}, "inline");
    await settle(second.terminal);
    const frozen = first.terminal.output.length;
    const mark = second.terminal.output.length;

    setTheme(lightTheme);
    await tick(30);

    expect(second.terminal.output.slice(mark)).toContain(open(lightTheme, "accent"));
    // The exited app kept no listener: nothing repaints its dead terminal.
    expect(first.terminal.output.length).toBe(frozen);
  });
});
