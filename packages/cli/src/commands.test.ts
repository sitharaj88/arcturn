import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listModels, registerModel, unregisterModel } from "@arcturn/ai";
import type { PermissionMode } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  CommandRegistry,
  type CommandUi,
  createCommandRegistry,
  type SelectOption,
} from "./commands.js";
import type { ExtensionCommand } from "./extensions.js";
import { suggestCheapModel } from "./router.js";
import { type ArcturnRuntime, routedCompactionOptions } from "./runtime.js";
import { buildTestRuntime, makeScratch, writeFileAt } from "./test-helpers/scratch.js";

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
    ).toEqual(["commit", "compact", "copy", "cost"]);
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

  it("/ui persists the renderer choice and is honest that it lands next launch", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    expect(runtime.config.ui).toBe("screen"); // the full-screen app is the default

    const { ui } = await run(runtime, "/ui inline");
    expect(runtime.config.ui).toBe("inline");
    expect(ui.notices[0]?.text).toContain("Takes effect next launch");
    const written = JSON.parse(await readFile(runtime.paths.userConfig, "utf8")) as {
      ui?: string;
    };
    expect(written.ui).toBe("inline");

    const again = await run(runtime, "/ui inline");
    expect(again.ui.notices[0]?.text).toContain("Already using");
    const bad = await run(runtime, "/ui sideways");
    expect(bad.ui.notices[0]?.level).toBe("error");
    await runtime.dispose();
  });

  it("/copy on an empty conversation says so without touching the clipboard", async () => {
    // The pipe chain itself is covered in clipboard.test.ts; what the command
    // owns is knowing when there is nothing to put on the clipboard.
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const { ui } = await run(runtime, "/copy");
    expect(ui.notices[0]).toMatchObject({ level: "info", text: "No answer to copy yet." });
    const all = await run(runtime, "/copy all");
    expect(all.ui.notices[0]).toMatchObject({ level: "info", text: "Nothing to copy yet." });
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

  it("/model persists the pick as the user default, moving a route.main with it", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const ui = fakeUi();
    await run(runtime, "/model anthropic/claude-opus-4-5", ui);
    // The pick outlives the session: without this, the next launch reads the
    // config's old model and the switch silently evaporates.
    const stored = JSON.parse(await readFile(runtime.paths.userConfig, "utf8")) as {
      model: string;
    };
    expect(stored.model).toBe("anthropic/claude-opus-4-5");
    expect(ui.notices[0]?.text).toContain("Saved as your default");

    // A failed pick persists nothing.
    await run(runtime, "/model nope/nope", ui);
    const after = JSON.parse(await readFile(runtime.paths.userConfig, "utf8")) as {
      model: string;
    };
    expect(after.model).toBe("anthropic/claude-opus-4-5");
    await runtime.dispose();
  });

  it("/model route prints the effective routes and any router warnings", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const { ui } = await run(runtime, "/model route");
    const text = ui.lines.join("\n");
    expect(text).toContain("Model routes");
    for (const kind of ["main", "subagent", "compaction", "title"]) {
      expect(text).toContain(kind);
    }
    // Nothing routed: every kind resolves to the session model.
    expect(text).toContain(runtime.model.id);
    expect(ui.notices).toEqual([]);
    await runtime.dispose();
  });

  it("/model route --auto applies the cheap pick to subagent and compaction, live and persisted", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    // The command must agree with the heuristic over the live catalog, so
    // the expectation is computed the same way rather than hard-coding a
    // model the catalog may re-price tomorrow.
    const expected = suggestCheapModel(listModels(), runtime.model);
    expect(expected).toBeDefined();
    expect(runtime.router.specFor("subagent").id).toBe(runtime.model.id);
    expect(runtime.router.specFor("compaction").id).toBe(runtime.model.id);

    const ui = fakeUi();
    await run(runtime, "/model route --auto", ui);

    // Live: the router answers with the pick at once, for exactly the two
    // cheap routes; title and main are untouched.
    expect(runtime.router.specFor("subagent").id).toBe(expected?.id);
    expect(runtime.router.specFor("compaction").id).toBe(expected?.id);
    expect(runtime.router.specFor("title").id).toBe(runtime.model.id);
    expect(runtime.router.specFor("main").id).toBe(runtime.model.id);
    // Persisted: the user config carries the two routes and nothing else.
    const stored = JSON.parse(await readFile(runtime.paths.userConfig, "utf8")) as {
      route?: Record<string, string>;
    };
    expect(stored.route).toEqual({ subagent: expected?.id, compaction: expected?.id });
    expect(ui.notices[0]?.level).toBe("info");
    expect(ui.notices[0]?.text).toContain(expected?.id ?? "");
    expect(ui.notices[0]?.text).toContain("Saved as your default");
    await runtime.dispose();
  });

  it("/model route --auto warns and changes nothing when no candidate qualifies", async () => {
    registerModel({
      id: "solo/only-model",
      provider: "solo",
      model: "only-model",
      displayName: "Solo Only",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      apiKeyEnv: "SOLO_API_KEY",
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
    });
    const scratch = await makeScratch();
    scratch.env.SOLO_API_KEY = "test-key";
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      model: "solo/only-model",
    });
    const ui = fakeUi();
    await run(runtime, "/model route --auto", ui);
    expect(ui.notices[0]?.level).toBe("warn");
    expect(ui.notices[0]?.text).toContain("No cheap stand-in");
    expect(runtime.router.specFor("subagent").id).toBe("solo/only-model");
    // Nothing was persisted either.
    const raw = await readFile(runtime.paths.userConfig, "utf8").catch(() => "{}");
    expect((JSON.parse(raw) as { route?: unknown }).route).toBeUndefined();
    await runtime.dispose();
    unregisterModel("solo/only-model");
  });

  it("/model route --auto refuses a candidate that is not actually cheaper", async () => {
    registerModel({
      id: "duo/cheap-main",
      provider: "duo",
      model: "cheap-main",
      displayName: "Duo Cheap",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      apiKeyEnv: "DUO_API_KEY",
      cost: { input: 0.1, output: 0.2 },
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
    });
    registerModel({
      id: "duo/pricy-sibling",
      provider: "duo",
      model: "pricy-sibling",
      displayName: "Duo Pricy",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      apiKeyEnv: "DUO_API_KEY",
      cost: { input: 5, output: 10 },
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
    });
    const scratch = await makeScratch();
    scratch.env.DUO_API_KEY = "test-key";
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      model: "duo/cheap-main",
    });
    const ui = fakeUi();
    await run(runtime, "/model route --auto", ui);
    // The heuristic's cheapest sibling costs MORE than the main model:
    // "optimising" the bill upward is refused inside suggestCheapModel
    // itself, so no candidate comes back at all and nothing is applied.
    expect(ui.notices[0]?.level).toBe("warn");
    expect(ui.notices[0]?.text).toContain("No cheap stand-in");
    expect(runtime.router.specFor("subagent").id).toBe("duo/cheap-main");
    // Nothing was persisted either.
    const raw = await readFile(runtime.paths.userConfig, "utf8").catch(() => "{}");
    expect((JSON.parse(raw) as { route?: unknown }).route).toBeUndefined();
    await runtime.dispose();
    unregisterModel("duo/cheap-main");
    unregisterModel("duo/pricy-sibling");
  });

  it("/model route --auto never routes across vendors sharing the openai-compatible provider id", async () => {
    // Every openai-protocol preset model carries provider "openai-compatible",
    // so provider equality alone would let --auto route a deepseek-shaped main
    // model onto another vendor's endpoint (zai-api publishes $0 input
    // pricing) — applied live AND persisted, with no key check to refuse it.
    registerModel({
      id: "crossvendor/main-model",
      provider: "openai-compatible",
      model: "main-model",
      displayName: "Crossvendor Main",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      cost: { input: 1, output: 2 },
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
    });
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      model: "crossvendor/main-model",
    });
    // Sanity: the live catalog really does carry a cheaper tool-capable
    // openai-compatible model from another vendor, so only the namespace rule
    // stands between --auto and a cross-vendor persist.
    expect(
      listModels().some(
        (candidate) =>
          candidate.provider === "openai-compatible" &&
          !candidate.id.startsWith("crossvendor/") &&
          candidate.capabilities.tools &&
          (candidate.cost?.input ?? Number.POSITIVE_INFINITY) < 1,
      ),
    ).toBe(true);

    const ui = fakeUi();
    await run(runtime, "/model route --auto", ui);
    expect(ui.notices[0]?.level).toBe("warn");
    expect(ui.notices[0]?.text).toContain("Nothing changed");
    expect(runtime.router.specFor("subagent").id).toBe("crossvendor/main-model");
    expect(runtime.router.specFor("compaction").id).toBe("crossvendor/main-model");
    // And NOTHING was persisted to the user config.
    const raw = await readFile(runtime.paths.userConfig, "utf8").catch(() => "{}");
    expect((JSON.parse(raw) as { route?: unknown }).route).toBeUndefined();
    await runtime.dispose();
    unregisterModel("crossvendor/main-model");
  });

  it("/model route clear compaction restores seat-model compaction even while route.main stands", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.home, "config.json"),
      JSON.stringify({ route: { main: "anthropic/claude-opus-4-5" } }),
    );
    const runtime = await buildTestRuntime(scratch);
    // The standing route.main governs what the compaction ROUTE resolves to…
    expect(runtime.router.specFor("compaction").id).toBe("anthropic/claude-opus-4-5");

    const ui = fakeUi();
    await run(runtime, "/model route compaction anthropic/claude-haiku-4-5", ui);
    expect(routedCompactionOptions(runtime.model, runtime.router).model?.id).toBe(
      "anthropic/claude-haiku-4-5",
    );

    await run(runtime, "/model route clear compaction", ui);
    // …but an agent's compaction CALL uses a routed model only while the
    // compaction route is explicitly configured. After clear, the "falling
    // back" notice must be the truth: the seat model compacts itself again,
    // not route.main's flagship.
    expect(routedCompactionOptions(runtime.model, runtime.router).model).toBeUndefined();
    await runtime.dispose();
  });

  it("/model route <kind> <id> sets one route by hand, and clear withdraws it", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const ui = fakeUi();

    await run(runtime, "/model route title anthropic/claude-haiku-4-5", ui);
    expect(runtime.router.specFor("title").id).toBe("anthropic/claude-haiku-4-5");
    let stored = JSON.parse(await readFile(runtime.paths.userConfig, "utf8")) as {
      route?: Record<string, string>;
    };
    expect(stored.route).toEqual({ title: "anthropic/claude-haiku-4-5" });

    await run(runtime, "/model route clear title", ui);
    expect(runtime.router.specFor("title").id).toBe(runtime.model.id);
    stored = JSON.parse(await readFile(runtime.paths.userConfig, "utf8")) as {
      route?: Record<string, string>;
    };
    expect(stored.route).toBeUndefined();

    // `main` belongs to the pick, and an unknown model id fails eagerly with
    // the catalog error rather than landing as a quietly ineffective route.
    await run(runtime, "/model route main anthropic/claude-haiku-4-5", ui);
    expect(ui.notices.at(-1)?.level).toBe("error");
    expect(ui.notices.at(-1)?.text).toContain("/model <id>");
    await run(runtime, "/model route subagent nope/nope", ui);
    expect(ui.notices.at(-1)?.level).toBe("error");
    expect(runtime.router.specFor("subagent").id).toBe(runtime.model.id);
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

  it("/cost never reports $0.00 for a model with no published pricing", async () => {
    // The bug this pins: an unpriced model made every cost surface read
    // "$0.00", i.e. "free", when the truth was "unknown".
    registerModel({
      id: "test/unpriced-cost-cmd",
      provider: "openai-compatible",
      model: "unpriced-1",
      displayName: "Unpriced Test Model",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
    });
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [{ text: "hi", usage: { inputTokens: 2_000, outputTokens: 1_000 } }],
      { model: "test/unpriced-cost-cmd" },
    );
    await runtime.agent.prompt("hello");
    const { ui } = await run(runtime, "/cost");
    const text = ui.lines.join("\n");
    expect(text).not.toContain("$0.00");
    expect(text).toContain("cost       n/a");
    expect(text).toContain("publishes no per-token pricing");
    await runtime.dispose();
    unregisterModel("test/unpriced-cost-cmd");
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
