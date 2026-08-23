import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModel, registerModel, unregisterModel } from "@arcturn/ai";
import type { PermissionPrompt, PermissionRequest, PermissionRule } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import { resolveArcturnPaths } from "./paths.js";
import {
  BUILT_IN_TOOL_NAMES,
  buildRuntime,
  compactionOptionsFor,
  connectMcp,
  formatModelCatalog,
  formatProviderCatalog,
  ModelResolutionError,
  registerBundledCatalog,
  resolveModelSpec,
  subagentSystemPrompt,
} from "./runtime.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, writeFileAt } from "./test-helpers/scratch.js";

describe("resolveModelSpec", () => {
  it("resolves a catalog id and a bare wire name", () => {
    const env = { ANTHROPIC_API_KEY: "k" };
    expect(resolveModelSpec("anthropic/claude-sonnet-4-5", env).id).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(resolveModelSpec("claude-sonnet-4-5", env).id).toBe("anthropic/claude-sonnet-4-5");
  });

  it("lists the catalog when the model is unknown", () => {
    let message = "";
    try {
      resolveModelSpec("nope/nope", {});
    } catch (error) {
      expect(error).toBeInstanceOf(ModelResolutionError);
      message = (error as Error).message;
    }
    expect(message).toContain('Unknown model "nope/nope"');
    expect(message).toContain("Available models:");
    expect(message).toContain("anthropic/claude-sonnet-4-5");
  });

  it("names the missing environment variable", () => {
    expect(() => resolveModelSpec("anthropic/claude-sonnet-4-5", {})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("does not demand an API key from an OAuth-only provider", () => {
    // `anthropic-oauth`, `github-copilot` and `openai-codex` authenticate with a
    // stored subscription credential; there is no key to look for.
    registerBundledCatalog();
    registerModel({
      id: "test/oauth-only",
      provider: "anthropic-oauth",
      model: "claude-sonnet-4-5",
      displayName: "Subscription Claude",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, vision: true, thinking: true, caching: true },
    });
    expect(resolveModelSpec("test/oauth-only", {}).provider).toBe("anthropic-oauth");
    unregisterModel("test/oauth-only");
  });
});

describe("formatModelCatalog", () => {
  it("lists every provider with context and pricing", () => {
    const catalog = formatModelCatalog();
    expect(catalog).toContain("anthropic/claude-opus-4-5");
    expect(catalog).toContain("openai/gpt-5.1");
    expect(catalog).toContain("google/gemini-2.5-pro");
    expect(catalog).toContain("per Mtok");
  });
});

describe("formatProviderCatalog", () => {
  it("lists registered providers, presets and the OAuth providers", () => {
    registerBundledCatalog();
    const catalog = formatProviderCatalog({});
    expect(catalog).toContain("Registered providers");
    expect(catalog).toContain("anthropic");
    expect(catalog).toContain("bedrock");
    expect(catalog).toContain("vertex");
    expect(catalog).toContain("azure");
    expect(catalog).toContain("openai-responses");
    expect(catalog).toContain("Provider presets (use --model <preset>/<model>)");
    expect(catalog).toContain("Subscription (OAuth) sign-in");
    expect(catalog).toContain("arcturn auth login <provider>");
    expect(catalog).toContain("UNVERIFIED");
  });

  it("shows each preset's protocol, key variable and whether it is set", () => {
    const catalog = formatProviderCatalog({ GROQ_API_KEY: "set-in-this-env" });
    const groq = catalog.split("\n").find((line) => line.trimStart().startsWith("groq "));
    const deepseek = catalog.split("\n").find((line) => line.trimStart().startsWith("deepseek "));

    expect(groq).toBeDefined();
    expect(groq).toContain("Groq");
    expect(groq).toContain("openai");
    expect(groq).toContain("GROQ_API_KEY");
    expect(groq?.trimEnd().endsWith("✓")).toBe(true);

    expect(deepseek).toBeDefined();
    expect(deepseek).toContain("DEEPSEEK_API_KEY");
    expect(deepseek?.trimEnd().endsWith("✗")).toBe(true);

    // Anthropic-protocol presets are labelled as such.
    const minimax = catalog.split("\n").find((line) => line.trimStart().startsWith("minimax "));
    expect(minimax).toContain("anthropic");

    // The key value itself is never echoed back.
    expect(catalog).not.toContain("set-in-this-env");
    expect(catalog).toContain("(1 of 35)");
  });
});

describe("registerBundledCatalog", () => {
  it("is idempotent", () => {
    registerBundledCatalog();
    expect(registerBundledCatalog()).toBe(false);
    expect(getModel("groq/llama-3.3-70b-versatile")).toBeDefined();
  });
});

describe("compactionOptionsFor", () => {
  const spec = (contextWindow: number) => ({
    id: "x/y",
    provider: "openai-compatible" as const,
    model: "y",
    displayName: "Y",
    contextWindow,
    maxOutputTokens: 1_024,
    capabilities: { tools: true, vision: false, thinking: false, caching: false },
  });

  it("keeps core's defaults for a large context window", () => {
    expect(compactionOptionsFor(spec(200_000))).toEqual({
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
  });

  it("scales below the window for a small model so compaction is not always due", () => {
    const options = compactionOptionsFor(spec(8_192));
    expect(options.reserveTokens).toBeLessThan(8_192);
    expect(options.keepRecentTokens).toBeLessThan(8_192);
    expect(8_192 - (options.reserveTokens ?? 0)).toBeGreaterThan(0);
  });

  it("never returns a degenerate budget", () => {
    const options = compactionOptionsFor(spec(1));
    expect(options.reserveTokens).toBe(1_024);
    expect(options.keepRecentTokens).toBe(2_048);
  });
});

describe("subagentSystemPrompt", () => {
  it("describes the read-only child by default and the full toolset under yolo", () => {
    expect(subagentSystemPrompt("/repo", false)).toContain("read-only tools");
    expect(subagentSystemPrompt("/repo", true)).toContain("full tool set");
  });
});

describe("buildRuntime", () => {
  it("takes the turn ceiling from config, with --max-turns winning", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ maxTurns: 12, subagentMaxTurns: 5 }),
    );
    const fromConfig = await buildTestRuntime(scratch);
    expect(fromConfig.config.maxTurns).toBe(12);
    expect(fromConfig.config.subagentMaxTurns).toBe(5);
    await fromConfig.dispose();

    const overridden = await buildTestRuntime(scratch, [{ text: "hi" }], { maxTurns: 3 });
    // The flag wins over the config key.
    expect(overridden.agent.maxTurns ?? 3).toBe(3);
    await overridden.dispose();
  });

  it("rejects a non-positive turn ceiling instead of silently accepting it", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ maxTurns: 0, subagentMaxTurns: -4 }),
    );
    const runtime = await buildTestRuntime(scratch);
    expect(runtime.config.maxTurns).toBeUndefined();
    expect(runtime.config.subagentMaxTurns).toBeUndefined();
    expect(runtime.warnings.join("\n")).toMatch(/maxTurns/);
    await runtime.dispose();
  });

  // Regression from a live run: with no `.arcturn/agents/` directory the subagent
  // tool still advertised an `agent` parameter, the model passed
  // `agent: "general"`, and the delegation died with an unhelpful message.
  it("does not offer an agent parameter when no markdown agents are defined", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const subagent = runtime.tools.find((tool) => tool.definition.name === "subagent");
    expect(subagent).toBeDefined();
    const properties = subagent?.definition.parameters.properties as Record<string, unknown>;
    expect(properties.agent).toBeUndefined();
    await runtime.dispose();
  });

  it("assembles every built-in tool and a session store under the cwd hash", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const names = runtime.tools.map((tool) => tool.definition.name);
    // `symbols` is reserved so an extension cannot shadow it, but it is only
    // instantiated when `lsp: "on"`, which this runtime does not enable —
    // likewise `tool_search`, which exists only when `deferredTools.enabled`.
    const alwaysOn = BUILT_IN_TOOL_NAMES.filter(
      (name) => name !== "symbols" && name !== "tool_search",
    );
    for (const expected of alwaysOn) expect(names).toContain(expected);
    expect(names).not.toContain("symbols");
    expect(names).not.toContain("tool_search");

    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
    expect(runtime.store.dir).toBe(paths.sessions);
    expect(runtime.cwd).toBe(scratch.cwd);
    await runtime.dispose();
  });

  it("registers the preset models, so a preset id is selectable", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    // Registered by buildRuntime itself, not by an import side effect.
    expect(getModel("groq/llama-3.3-70b-versatile")?.provider).toBe("openai-compatible");
    expect(getModel("minimax/MiniMax-M2")?.provider).toBe("anthropic-compatible");
    expect(formatModelCatalog()).toContain("deepseek/deepseek-reasoner");

    // …and resolving one goes through the same path `--model` uses.
    const switched = runtime.setModel("groq/llama-3.3-70b-versatile");
    expect(switched.id).toBe("groq/llama-3.3-70b-versatile");
    expect(switched.apiKeyEnv).toBe("GROQ_API_KEY");
    await runtime.dispose();
  });

  it("applies config, then the explicit overrides", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
    await writeFileAt(
      paths.projectConfig,
      JSON.stringify({ model: "anthropic/claude-haiku-4-5", permissionMode: "plan" }),
    );

    const fromConfig = await buildTestRuntime(scratch);
    expect(fromConfig.model.id).toBe("anthropic/claude-haiku-4-5");
    expect(fromConfig.permissionMode).toBe("plan");
    await fromConfig.dispose();

    const overridden = await buildTestRuntime(scratch, [{ text: "ok" }], {
      model: "anthropic/claude-opus-4-5",
      permissionMode: "yolo",
    });
    expect(overridden.model.id).toBe("anthropic/claude-opus-4-5");
    expect(overridden.permissionMode).toBe("yolo");
    await overridden.dispose();
  });

  it("puts the cwd and configured append text into the system prompt", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
    await writeFileAt(paths.userConfig, JSON.stringify({ systemPromptAppend: "always be brief" }));
    const runtime = await buildTestRuntime(scratch);
    expect(runtime.systemPrompt).toContain(scratch.cwd);
    expect(runtime.systemPrompt).toContain("always be brief");
    expect(runtime.systemPrompt).toContain("Available tools:");
    await runtime.dispose();
  });

  it("runs a prompt and records usage and cost", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [
      { text: "the answer", usage: { inputTokens: 1_000, outputTokens: 500 } },
    ]);
    await runtime.agent.prompt("question");
    expect(runtime.agent.finalText()).toBe("the answer");
    expect(runtime.metrics.turns).toBe(1);
    expect(runtime.metrics.usage.outputTokens).toBe(500);
    expect(runtime.metrics.costUsd).toBeGreaterThan(0);
    await runtime.dispose();
  });

  it("keeps a stable subscription across a session swap", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "one" }, { text: "two" }]);
    const seen: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "runEnd") seen.push(event.reason);
    });

    await runtime.agent.prompt("first");
    const before = runtime.agent.sessionId;
    runtime.startNewSession();
    expect(runtime.agent.sessionId).not.toBe(before);
    expect(runtime.metrics.turns).toBe(0);
    await runtime.agent.prompt("second");

    expect(seen).toEqual(["completed", "completed"]);
    await runtime.dispose();
  });

  it("resumes a stored session with its history", async () => {
    const scratch = await makeScratch();
    const first = await buildTestRuntime(scratch, [{ text: "remembered" }]);
    await first.agent.prompt("hello");
    const sessionId = first.agent.sessionId;
    await first.dispose();

    const second = await buildTestRuntime(scratch, [{ text: "again" }], { resume: sessionId });
    expect(second.agent.sessionId).toBe(sessionId);
    expect(second.agent.messages.length).toBeGreaterThanOrEqual(2);
    expect(second.agent.finalText()).toBe("remembered");
    await second.dispose();
  });

  it("--continue picks the newest session in this directory", async () => {
    const scratch = await makeScratch();
    const first = await buildTestRuntime(scratch, [{ text: "older" }]);
    await first.agent.prompt("a");
    const sessionId = first.agent.sessionId;
    await first.dispose();

    const resumed = await buildTestRuntime(scratch, [{ text: "x" }], { continueSession: true });
    expect(resumed.agent.sessionId).toBe(sessionId);
    await resumed.dispose();
  });

  it("warns instead of failing when --continue finds nothing", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "x" }], { continueSession: true });
    expect(runtime.warnings.join("\n")).toContain("No previous session");
    await runtime.dispose();
  });

  it("persists an 'allow always' rule to the project config", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "echo hi" } }] },
        { text: "done" },
      ],
      {
        onPermissionAsk: async () => ({
          requestId: "",
          behavior: "allow" as const,
          persistRule: {
            tool: "bash",
            specifier: "echo *",
            action: "allow" as const,
            scope: "project" as const,
          },
        }),
      },
    );

    await runtime.agent.prompt("run echo");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = JSON.parse(await readFile(paths.projectConfig, "utf8")) as {
      permissions: { tool: string; specifier?: string }[];
    };
    expect(stored.permissions[0]).toMatchObject({ tool: "bash", specifier: "echo *" });
    await runtime.dispose();
  });

  it("denies permission asks when no requester is configured", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "echo hi" } }] },
      { text: "gave up" },
    ]);
    await runtime.agent.prompt("run echo");
    const results = runtime.agent.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    await runtime.dispose();
  });

  it("builds a read-only sub-agent unless the parent is in yolo mode", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const child = runtime.createSubagent("go find things");
    const names = child.tools.map((tool) => tool.definition.name).sort();
    expect(names).toEqual(["fetch", "glob", "grep", "ls", "read"]);
    expect(child.sessionId).not.toBe(runtime.agent.sessionId);
    await runtime.dispose();

    const yolo = await buildTestRuntime(scratch, [{ text: "x" }], { permissionMode: "yolo" });
    const powerful = yolo.createSubagent("go fix things");
    const powerfulNames = powerful.tools.map((tool) => tool.definition.name);
    expect(powerfulNames).toContain("bash");
    expect(powerfulNames).toContain("edit");
    expect(powerfulNames).not.toContain("subagent");
    await yolo.dispose();
  });

  it("caps a delegated agent at its own AgentDef.maxTurns, below the default subagent ceiling", async () => {
    const scratch = await makeScratch();
    // A single scripted turn that keeps calling a tool: `fakeLLM` repeats the
    // last turn forever, so nothing but a turn ceiling ever stops this run.
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c0", name: "read", arguments: { path: "does-not-exist.txt" } }] },
    ]);
    const def: AgentDef = {
      name: "capped",
      description: "Loops forever unless capped",
      systemPrompt: "Keep reading the file.",
      source: "<test>",
      maxTurns: 2,
    };
    const child = runtime.createSubagent("loop forever", def);
    const notices: string[] = [];
    child.on("notice", (event) => notices.push(event.text));

    await child.prompt("go");

    // `SUBAGENT_MAX_TURNS` (64) and the unset `config.subagentMaxTurns` would
    // both let this run far past 2 turns; only `def.maxTurns` reaching the
    // child Agent's own `maxTurns` option stops it here.
    expect(notices.some((text) => text.includes("maximum of 2"))).toBe(true);
    await runtime.dispose();
  });

  it("prefers AgentDef.maxTurns over config.subagentMaxTurns when both are set", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ subagentMaxTurns: 9 }),
    );
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c0", name: "read", arguments: { path: "does-not-exist.txt" } }] },
    ]);
    expect(runtime.config.subagentMaxTurns).toBe(9);
    const def: AgentDef = {
      name: "capped",
      description: "Loops forever unless capped",
      systemPrompt: "Keep reading the file.",
      source: "<test>",
      maxTurns: 3,
    };
    const child = runtime.createSubagent("loop forever", def);
    const notices: string[] = [];
    child.on("notice", (event) => notices.push(event.text));

    await child.prompt("go");

    expect(notices.some((text) => text.includes("maximum of 3"))).toBe(true);
    expect(notices.some((text) => text.includes("maximum of 9"))).toBe(false);
    await runtime.dispose();
  });

  it("falls back to config.subagentMaxTurns when the AgentDef sets no maxTurns", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ subagentMaxTurns: 3 }),
    );
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c0", name: "read", arguments: { path: "does-not-exist.txt" } }] },
    ]);
    const child = runtime.createSubagent("loop forever");
    const notices: string[] = [];
    child.on("notice", (event) => notices.push(event.text));

    await child.prompt("go");

    expect(notices.some((text) => text.includes("maximum of 3"))).toBe(true);
    await runtime.dispose();
  });

  it("clamps AgentDef.maxTurns DOWN to config.subagentMaxTurns when the role asks for more", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ subagentMaxTurns: 2 }),
    );
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c0", name: "read", arguments: { path: "does-not-exist.txt" } }] },
    ]);
    const def: AgentDef = {
      name: "greedy",
      description: "Asks for a longer leash than the session allows",
      systemPrompt: "Keep reading the file.",
      source: "<test>",
      maxTurns: 7,
    };
    const child = runtime.createSubagent("loop forever", def);
    const notices: string[] = [];
    child.on("notice", (event) => notices.push(event.text));

    await child.prompt("go");

    // RFC 0001 §8.4 "Roles narrow; nothing widens": a role file (which a
    // cloned repo controls via `.arcturn/agents/**`) must not be able to
    // raise the session's own subagent turn ceiling from 2 to 7.
    expect(notices.some((text) => text.includes("maximum of 2"))).toBe(true);
    expect(notices.some((text) => text.includes("maximum of 7"))).toBe(false);
    await runtime.dispose();
  });

  it("honours buildSessionAgent's maxTurns option, capping the session agent's turns", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c0", name: "read", arguments: { path: "does-not-exist.txt" } }] },
    ]);
    const agent = runtime.buildSessionAgent({ sessionId: "s-1", maxTurns: 2 });
    const notices: string[] = [];
    agent.on("notice", (event) => notices.push(event.text));

    await agent.prompt("go");

    // The write lane (`workflow.ts`) is the only other caller that can run
    // `bash` and mutate the checkout; it builds its child through this same
    // `buildSessionAgent`, so a role's declared budget must reach the built
    // agent from here too, not only from `createSubagent`.
    expect(notices.some((text) => text.includes("maximum of 2"))).toBe(true);
    await runtime.dispose();
  });

  it("clamps buildSessionAgent's maxTurns option DOWN to config.subagentMaxTurns", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ subagentMaxTurns: 2 }),
    );
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c0", name: "read", arguments: { path: "does-not-exist.txt" } }] },
    ]);
    const agent = runtime.buildSessionAgent({ sessionId: "s-2", maxTurns: 7 });
    const notices: string[] = [];
    agent.on("notice", (event) => notices.push(event.text));

    await agent.prompt("go");

    // D4: effective maxTurns = min(requested, config.subagentMaxTurns ?? the
    // built-in floor) in BOTH lanes — the write lane must not be able to buy
    // a longer leash than the read lane's `createSubagent` allows just
    // because it goes through `buildSessionAgent` instead.
    expect(notices.some((text) => text.includes("maximum of 2"))).toBe(true);
    expect(notices.some((text) => text.includes("maximum of 7"))).toBe(false);
    await runtime.dispose();
  });

  it("leaves buildSessionAgent's existing turn budget untouched when maxTurns is omitted", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ maxTurns: 5 }),
    );
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c0", name: "read", arguments: { path: "does-not-exist.txt" } }] },
    ]);
    const agent = runtime.buildSessionAgent({ sessionId: "s-3" });
    const notices: string[] = [];
    agent.on("notice", (event) => notices.push(event.text));

    await agent.prompt("go");

    // Additive means additive: a caller that never passes `maxTurns` (every
    // caller before this option existed — `serve.ts`, `acp/host.ts`,
    // `team.ts`) must keep getting the session's own `config.maxTurns`, not
    // the unrelated `config.subagentMaxTurns` ceiling.
    expect(notices.some((text) => text.includes("maximum of 5"))).toBe(true);
    await runtime.dispose();
  });

  it("applies the subagent ceiling to buildSessionAgent even when the requested maxTurns is undefined", async () => {
    // A write-lane role with no `maxTurns:` of its own still gets forwarded
    // as `maxTurns: def.maxTurns` (RFC 0001's `WriteLaneSpawnRequest` carries
    // `def` straight through, `workflow.ts`) — the KEY is present, its VALUE
    // is `undefined`. That must still opt this session into the subagent
    // ceiling, exactly like an absent `AgentDef.maxTurns` does for
    // `createSubagent`: D4's `min(def.maxTurns ?? ∞, ceiling)` reduces to
    // `ceiling`, not to this session's unrelated top-level turn budget.
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ maxTurns: 40, subagentMaxTurns: 2 }),
    );
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c0", name: "read", arguments: { path: "does-not-exist.txt" } }] },
    ]);
    const agent = runtime.buildSessionAgent({ sessionId: "s-4", maxTurns: undefined });
    const notices: string[] = [];
    agent.on("notice", (event) => notices.push(event.text));

    await agent.prompt("go");

    expect(notices.some((text) => text.includes("maximum of 2"))).toBe(true);
    expect(notices.some((text) => text.includes("maximum of 40"))).toBe(false);
    await runtime.dispose();
  });

  it("switches models at runtime and rejects unknown ones", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const spec = runtime.setModel("anthropic/claude-haiku-4-5");
    expect(spec.id).toBe("anthropic/claude-haiku-4-5");
    expect(runtime.model.id).toBe("anthropic/claude-haiku-4-5");
    expect(() => runtime.setModel("does/not-exist")).toThrow(ModelResolutionError);
    await runtime.dispose();
  });

  it("surfaces extension tools and warnings", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
    await writeFileAt(
      join(paths.projectExtensions, "coin.js"),
      `export default (api) => {
         api.registerTool({
           definition: { name: "coin", description: "flip", parameters: { type: "object" } },
           async execute() { return { content: [{ type: "text", text: "heads" }] }; },
         });
       };`,
    );
    const runtime = await buildRuntime({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
      llm: fakeLLM([{ text: "ok" }]),
      skipRepoLookup: true,
    });
    expect(runtime.tools.map((tool) => tool.definition.name)).toContain("coin");
    await runtime.dispose();
  });
});

describe("live permission rules", () => {
  const gitRule: PermissionRule = {
    tool: "bash",
    specifier: "git *",
    action: "allow",
    scope: "session",
  };

  /** A requester that answers every prompt with "always allow", session scope. */
  const grants = (rule: PermissionRule): PermissionPrompt => {
    return async () => ({ requestId: "", behavior: "allow" as const, persistRule: rule });
  };

  const hasRule = (rules: readonly PermissionRule[], wanted: PermissionRule): boolean =>
    rules.some(
      (rule) =>
        rule.tool === wanted.tool &&
        rule.specifier === wanted.specifier &&
        rule.action === wanted.action &&
        rule.scope === wanted.scope,
    );

  it("hands a mid-session 'always allow' grant to the next sub-agent", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "git status" } }] },
        { text: "done" },
      ],
      { onPermissionAsk: grants(gitRule) },
    );

    await runtime.agent.prompt("check the repo");
    // The grant landed on the parent's own engine (this much already worked).
    expect(hasRule(runtime.agent.permissions.rules, gitRule)).toBe(true);

    // ...and must reach a child spawned AFTERWARDS, or a `/workflow` pipeline
    // re-prompts for the same command once per role, forever.
    const child = runtime.createSubagent("look around");
    expect(hasRule(child.permissions.rules, gitRule)).toBe(true);
    expect(child.permissions.evaluate("bash", "git status")).toBe("allow");
    await runtime.dispose();
  });

  it("hands a mid-session grant to a buildSessionAgent child (the write lane)", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "git status" } }] },
        { text: "done" },
      ],
      { onPermissionAsk: grants(gitRule) },
    );

    await runtime.agent.prompt("check the repo");
    const agent = runtime.buildSessionAgent({ sessionId: "s-write-lane" });
    expect(hasRule(agent.permissions.rules, gitRule)).toBe(true);
    expect(agent.permissions.evaluate("bash", "git status")).toBe("allow");
    await runtime.dispose();
  });

  it("keeps every config deny in the child, and a more specific deny still wins", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({
        permissions: [{ tool: "bash", specifier: "rm -rf *", action: "deny" }],
      }),
    );
    const wideOpen: PermissionRule = {
      tool: "bash",
      specifier: "*",
      action: "allow",
      scope: "session",
    };
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "git status" } }] },
        { text: "done" },
      ],
      { onPermissionAsk: grants(wideOpen) },
    );

    await runtime.agent.prompt("check the repo");
    const child = runtime.createSubagent("look around");

    // Seeding may only ADD: no configured rule may go missing on the way down.
    for (const rule of runtime.config.permissions) {
      expect(hasRule(child.permissions.rules, rule)).toBe(true);
    }
    expect(hasRule(child.permissions.rules, wideOpen)).toBe(true);
    // The session ALLOW is broad; the config DENY is more specific and wins.
    expect(child.permissions.evaluate("bash", "rm -rf /")).toBe("deny");
    expect(child.permissions.evaluate("bash", "git status")).toBe("allow");
    await runtime.dispose();
  });

  it("does not let an inherited allow widen a child past its permission mode", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "x" }], { permissionMode: "plan" });
    const writeAnything: PermissionRule = {
      tool: "write",
      specifier: "*",
      action: "allow",
      scope: "session",
    };
    runtime.agent.addPermissionRule(writeAnything);

    const child = runtime.createSubagent("investigate");
    expect(child.permissionMode).toBe("plan");
    expect(hasRule(child.permissions.rules, writeAnything)).toBe(true);

    // Plan mode is checked before rules: an inherited allow cannot buy a
    // mutating tool that the child's own mode forbids.
    const decision = await child.permissions.check({
      toolName: "write",
      toolCallId: "c1",
      subject: join(scratch.cwd, "x.txt"),
    });
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("Plan mode");
    await runtime.dispose();
  });

  it("shows a grant answered inside one child to the NEXT child of the same run", async () => {
    const scratch = await makeScratch();
    const fetchRule: PermissionRule = {
      tool: "fetch",
      specifier: "https://example.test/*",
      action: "allow",
      scope: "session",
    };
    const runtime = await buildTestRuntime(scratch, [{ text: "x" }], {
      onPermissionAsk: grants(fetchRule),
    });

    const first = runtime.createSubagent("first role");
    const decision = await first.permissions.check({
      toolName: "fetch",
      toolCallId: "c1",
      subject: "https://example.test/spec",
    });
    expect(decision.behavior).toBe("allow");

    // Stage 2 of a pipeline must not re-ask what the user answered in stage 1.
    const second = runtime.createSubagent("second role");
    expect(hasRule(second.permissions.rules, fetchRule)).toBe(true);
    expect(second.permissions.evaluate("fetch", "https://example.test/other")).toBe("allow");
    await runtime.dispose();
  });
});

describe("permission prompt attribution", () => {
  /** A requester that records every request it is handed and denies it. */
  const recorder = (
    seen: PermissionRequest[],
  ): PermissionPrompt & { seen: PermissionRequest[] } => {
    const prompt = async (request: PermissionRequest) => {
      seen.push(request);
      return { requestId: request.id, behavior: "deny" as const };
    };
    return Object.assign(prompt, { seen });
  };

  const askFetch = async (
    agent: { permissions: { check(input: object): Promise<unknown> } },
    id: string,
  ): Promise<void> => {
    await agent.permissions.check({
      toolName: "fetch",
      toolCallId: id,
      subject: "https://example.test/spec",
    });
  };

  it("names the delegating role and step on a read-lane child's prompt", async () => {
    const scratch = await makeScratch();
    const seen: PermissionRequest[] = [];
    const runtime = await buildTestRuntime(scratch, [{ text: "x" }], {
      onPermissionAsk: recorder(seen),
    });

    const child = runtime.createSubagent("design it", undefined, {
      origin: "@architect \u00b7 step 2",
    });
    await askFetch(child, "c1");

    expect(seen[0]?.origin).toBe("@architect \u00b7 step 2");
    await runtime.dispose();
  });

  it("names the delegating role and step on a write-lane session agent's prompt", async () => {
    const scratch = await makeScratch();
    const seen: PermissionRequest[] = [];
    const runtime = await buildTestRuntime(scratch, [{ text: "x" }], {
      onPermissionAsk: recorder(seen),
    });

    const agent = runtime.buildSessionAgent({
      sessionId: "s-write-lane",
      origin: "@developer \u00b7 step 3",
    });
    await askFetch(agent, "c1");

    expect(seen[0]?.origin).toBe("@developer \u00b7 step 3");
    await runtime.dispose();
  });

  it("leaves an undelegated prompt exactly as it was", async () => {
    const scratch = await makeScratch();
    const seen: PermissionRequest[] = [];
    const runtime = await buildTestRuntime(scratch, [{ text: "x" }], {
      onPermissionAsk: recorder(seen),
    });

    // The session's own agent, and a child nobody labelled, are nobody's
    // delegates: neither may grow an attribution line.
    await askFetch(runtime.agent, "c1");
    await askFetch(runtime.createSubagent("look around"), "c2");
    await askFetch(runtime.buildSessionAgent({ sessionId: "s-plain" }), "c3");

    expect(seen).toHaveLength(3);
    for (const request of seen) expect(request).not.toHaveProperty("origin");
    await runtime.dispose();
  });

  it("changes no allow/deny outcome — attribution is legibility only", async () => {
    const scratch = await makeScratch();
    const answers: string[] = [];
    const runtime = await buildTestRuntime(scratch, [{ text: "x" }], {
      onPermissionAsk: async (request) => {
        answers.push(request.origin ?? "<none>");
        return { requestId: request.id, behavior: "allow" as const };
      },
    });

    const labelled = runtime.createSubagent("design it", undefined, {
      origin: "@architect \u00b7 step 2",
    });
    const plain = runtime.createSubagent("look around");
    for (const agent of [labelled, plain]) {
      const decision = await agent.permissions.check({
        toolName: "fetch",
        toolCallId: "c1",
        subject: "https://example.test/spec",
      });
      expect(decision.behavior).toBe("allow");
    }
    expect(answers).toEqual(["@architect \u00b7 step 2", "<none>"]);
    await runtime.dispose();
  });
});

describe("connectMcp", () => {
  it("does nothing when no config file exists", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    expect(await connectMcp(runtime)).toBeUndefined();
    expect(runtime.mcp).toBeUndefined();
    await runtime.dispose();
  });

  it("reports a malformed config as a warning instead of throwing", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
    await writeFileAt(paths.projectMcp, "{ oops");
    const runtime = await buildTestRuntime(scratch);
    expect(await connectMcp(runtime)).toBeUndefined();
    expect(runtime.warnings.join("\n")).toContain("MCP config error");
    await runtime.dispose();
  });

  it("ignores an empty server map", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
    await writeFileAt(paths.projectMcp, JSON.stringify({ servers: {} }));
    const runtime = await buildTestRuntime(scratch);
    expect(await connectMcp(runtime)).toBeUndefined();
    await runtime.dispose();
  });
});
