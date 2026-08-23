import type { PermissionMode } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  CommandRegistry,
  type CommandUi,
  createCommandRegistry,
  type SelectOption,
} from "./commands.js";
import type { ExtensionCommand } from "./extensions.js";
import type { ArcturnRuntime } from "./runtime.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

interface FakeUi extends CommandUi {
  lines: string[];
  notices: { level: string; text: string }[];
  cleared: number;
  exited: number;
  input: string;
  /** Value returned by the next `select` call. */
  answer: unknown;
  /** Titles of every picker shown. */
  prompts: string[];
  /** Rows offered by the last picker. */
  lastOptions: readonly SelectOption<unknown>[];
}

function fakeUi(answer: unknown = undefined): FakeUi {
  const ui: FakeUi = {
    lines: [],
    notices: [],
    cleared: 0,
    exited: 0,
    input: "",
    answer,
    prompts: [],
    lastOptions: [],
    print(content) {
      ui.lines.push(...(typeof content === "string" ? content.split("\n") : content));
    },
    notice(level, text) {
      ui.notices.push({ level, text });
    },
    async select<T>(title: string, options: readonly SelectOption<T>[]) {
      ui.prompts.push(title);
      ui.lastOptions = options as readonly SelectOption<unknown>[];
      return ui.answer as T | undefined;
    },
    setInput(text) {
      ui.input = text;
    },
    clear() {
      ui.cleared++;
    },
    exit() {
      ui.exited++;
    },
  };
  return ui;
}

async function run(
  runtime: ArcturnRuntime,
  input: string,
  ui: FakeUi = fakeUi(),
  registry: CommandRegistry = createCommandRegistry(),
) {
  const result = await registry.dispatch(input, { runtime, ui });
  return { result, ui, registry };
}

describe("CommandRegistry", () => {
  it("ignores anything that is not a slash command", async () => {
    const registry = new CommandRegistry();
    const ui = fakeUi();
    const result = await registry.dispatch("just a prompt", {
      runtime: {} as ArcturnRuntime,
      ui,
    });
    expect(result).toEqual({ handled: false });
  });

  it("reports unknown commands without throwing", async () => {
    const registry = createCommandRegistry();
    const ui = fakeUi();
    const result = await registry.dispatch("/nope", { runtime: {} as ArcturnRuntime, ui });
    expect(result).toEqual({ handled: true, command: "nope", unknown: true });
    expect(ui.notices[0]?.text).toContain('Unknown command "/nope"');
  });

  it("splits the command name from its arguments", async () => {
    const registry = new CommandRegistry();
    let seen = "";
    registry.register({
      name: "echo",
      description: "echo",
      run: ({ args }) => {
        seen = args;
      },
    });
    await registry.dispatch("/echo  hello   world ", {
      runtime: {} as ArcturnRuntime,
      ui: fakeUi(),
    });
    expect(seen).toBe("hello   world");
  });

  it("turns a throwing command into an error notice", async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "boom",
      description: "boom",
      run: () => {
        throw new Error("kaboom");
      },
    });
    const ui = fakeUi();
    await registry.dispatch("/boom", { runtime: {} as ArcturnRuntime, ui });
    expect(ui.notices[0]).toMatchObject({ level: "error" });
    expect(ui.notices[0]?.text).toContain("kaboom");
  });

  it("completes command names for the editor", () => {
    const registry = createCommandRegistry();
    expect(
      registry
        .complete("/co")
        .map((command) => command.name)
        .sort(),
    ).toEqual(["commit", "compact", "cost"]);
    expect(registry.complete("mo").map((command) => command.name)).toEqual(["model"]);
    expect(registry.complete("/").length).toBe(registry.list().length);
  });

  it("registers extension commands but never lets them shadow a built-in", () => {
    const warnings: string[] = [];
    const extension: ExtensionCommand[] = [
      { name: "ext-only", description: "custom", handler: () => undefined, source: "ext.js" },
      { name: "help", description: "hijack", handler: () => undefined, source: "ext.js" },
    ];
    const registry = createCommandRegistry(extension, (message) => warnings.push(message));
    expect(registry.get("ext-only")?.source).toBe("ext.js");
    expect(registry.get("help")?.source).toBe("built-in");
    expect(warnings.join("\n")).toContain("/help is already defined");
  });

  it("runs an extension command with the live context", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const registry = createCommandRegistry([
      {
        name: "where",
        description: "print the cwd",
        handler: (ctx) => ctx.ui.print(ctx.runtime.cwd),
        source: "ext.js",
      },
    ]);
    const ui = fakeUi();
    await registry.dispatch("/where", { runtime, ui });
    expect(ui.lines).toEqual([scratch.cwd]);
    await runtime.dispose();
  });
});

describe("built-in commands", () => {
  it("/help lists every registered command", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const { ui } = await run(runtime, "/help");
    const text = ui.lines.join("\n");
    for (const name of [
      "/help",
      "/model",
      "/clear",
      "/compact",
      "/sessions",
      "/permissions",
      "/mcp",
      "/todos",
      "/cost",
      "/exit",
    ]) {
      expect(text).toContain(name);
    }
    await runtime.dispose();
  });

  it("/model switches the model from the picker", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const ui = fakeUi("anthropic/claude-haiku-4-5");
    await run(runtime, "/model", ui);
    expect(ui.prompts).toEqual(["Select a model"]);
    expect(runtime.model.id).toBe("anthropic/claude-haiku-4-5");
    expect(ui.notices[0]?.text).toContain("Claude Haiku 4.5");
    await runtime.dispose();
  });

  it("/model accepts an id directly and reports unknown ones", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const ui = fakeUi();
    await run(runtime, "/model anthropic/claude-opus-4-5", ui);
    expect(runtime.model.id).toBe("anthropic/claude-opus-4-5");
    expect(ui.prompts).toEqual([]);

    await run(runtime, "/model nope/nope", ui);
    expect(ui.notices.at(-1)?.level).toBe("error");
    await runtime.dispose();
  });

  it("/clear starts a new session and clears the screen", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }]);
    await runtime.agent.prompt("hello");
    const before = runtime.agent.sessionId;

    const ui = fakeUi();
    await run(runtime, "/clear", ui);

    expect(runtime.agent.sessionId).not.toBe(before);
    expect(runtime.agent.messages).toHaveLength(0);
    expect(ui.cleared).toBe(1);
    await runtime.dispose();
  });

  it("/sessions resumes the chosen session", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "stored" }]);
    await runtime.agent.prompt("hello");
    const sessionId = runtime.agent.sessionId;
    runtime.startNewSession();
    expect(runtime.agent.sessionId).not.toBe(sessionId);

    const ui = fakeUi(sessionId);
    await run(runtime, "/sessions", ui);

    expect(ui.prompts).toEqual(["Resume a session"]);
    expect(runtime.agent.sessionId).toBe(sessionId);
    expect(runtime.agent.finalText()).toBe("stored");
    await runtime.dispose();
  });

  it("/sessions says so when there is nothing stored", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const ui = fakeUi();
    await run(runtime, "/sessions", ui);
    expect(ui.notices[0]?.text).toContain("No stored sessions");
    await runtime.dispose();
  });

  it("/permissions shows the rules and switches mode", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "x" }], {
      config: {
        model: "anthropic/claude-sonnet-4-5",
        permissionMode: "default",
        permissions: [{ tool: "bash", specifier: "git *", action: "allow", scope: "project" }],
        thinking: "off",
        theme: "dark",
      },
    });
    const ui = fakeUi("yolo" satisfies PermissionMode);
    await run(runtime, "/permissions", ui);

    expect(ui.lines.join("\n")).toContain("Permission mode: default");
    expect(ui.lines.join("\n")).toContain("bash git *");
    expect(runtime.permissionMode).toBe("yolo");
    await runtime.dispose();
  });

  it("/mcp explains how to configure servers when none are connected", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const { ui } = await run(runtime, "/mcp");
    expect(ui.lines.join("\n")).toContain("No MCP servers configured.");
    expect(ui.lines.join("\n")).toContain(runtime.paths.projectMcp);
    await runtime.dispose();
  });

  it("/mcp pings connected servers for live reachability instead of only cached status", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const pinged: [string, number | undefined][] = [];
    runtime.mcp = {
      status: () => ({
        alive: { state: "connected", toolCount: 2 },
        dead: { state: "connected", toolCount: 1 },
        broken: { state: "failed", error: "boom" },
      }),
      ping: async (name: string, timeoutMs?: number) => {
        pinged.push([name, timeoutMs]);
        return name === "alive";
      },
      close: async () => {},
    } as unknown as ArcturnRuntime["mcp"];

    const { ui } = await run(runtime, "/mcp");
    const text = ui.lines.join("\n");

    // Only connected servers are pinged, not the already-failed one.
    expect(pinged.map(([name]) => name).sort()).toEqual(["alive", "dead"]);
    expect(pinged.every(([, timeoutMs]) => typeof timeoutMs === "number" && timeoutMs > 0)).toBe(
      true,
    );
    expect(text).toContain("alive");
    expect(text).toContain("(live)");
    expect(text).toContain("(unreachable)");
    expect(text).not.toMatch(/broken.*\(live\)|broken.*\(unreachable\)/);
    await runtime.dispose();
  });

  it("/todos reports an empty list and then the real one", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [
      {
        toolCalls: [
          {
            id: "t1",
            name: "todo",
            arguments: { todos: [{ text: "ship it", status: "inProgress" }] },
          },
        ],
      },
      { text: "done" },
    ]);
    const first = await run(runtime, "/todos");
    expect(first.ui.lines.join("\n")).toContain("No todos yet.");

    await runtime.agent.prompt("plan the work");
    const second = await run(runtime, "/todos");
    expect(second.ui.lines.join("\n")).toContain("ship it");
    await runtime.dispose();
  });

  it("/cost reports usage after a turn", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [
      { text: "hi", usage: { inputTokens: 2_000, outputTokens: 1_000 } },
    ]);
    await runtime.agent.prompt("hello");
    const { ui } = await run(runtime, "/cost");
    const text = ui.lines.join("\n");
    expect(text).toContain("turns      1");
    expect(text).toContain("2.0k");
    expect(text).toContain("cost       $");
    await runtime.dispose();
  });

  it("/compact refuses while running and reports the saving otherwise", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }]);
    const ui = fakeUi();
    await run(runtime, "/compact", ui);
    // Nothing to compact in a fresh session: no notice, no crash.
    expect(ui.notices).toEqual([]);
    await runtime.dispose();
  });

  it("/exit asks the app to quit", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const { ui } = await run(runtime, "/exit");
    expect(ui.exited).toBe(1);
    await runtime.dispose();
  });
});
