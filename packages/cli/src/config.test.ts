import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRule } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ArcturnConfig,
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  loadConfig,
  mergeConfig,
  parseConfigFile,
  parsePermissionMode,
  persistPermissionRule,
  persistSetting,
} from "./config.js";
import { resolveArcturnPaths } from "./paths.js";

const roots: string[] = [];

async function scratch(): Promise<{ home: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "arcturn-cli-config-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { home, cwd };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

afterEach(() => {
  roots.length = 0;
});

describe("parseConfigFile", () => {
  it("accepts a full document", () => {
    const warnings: string[] = [];
    const parsed = parseConfigFile(
      {
        model: "openai/gpt-5",
        permissionMode: "acceptEdits",
        thinking: "high",
        theme: "light",
        systemPromptAppend: "be terse",
        permissions: [{ tool: "bash", specifier: "git *", action: "allow" }],
      },
      "user",
      "cfg",
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(parsed.model).toBe("openai/gpt-5");
    expect(parsed.permissionMode).toBe("acceptEdits");
    expect(parsed.thinking).toBe("high");
    expect(parsed.theme).toBe("light");
    expect(parsed.systemPromptAppend).toBe("be terse");
    expect(parsed.permissions).toEqual([
      { tool: "bash", specifier: "git *", action: "allow", scope: "user" },
    ]);
  });

  it("warns about bad values and unknown keys instead of throwing", () => {
    const warnings: string[] = [];
    const parsed = parseConfigFile(
      { model: 42, permissionMode: "nope", theme: "  ", nonsense: true, permissions: "no" },
      "project",
      "cfg",
      warnings,
    );
    expect(parsed).toEqual({});
    expect(warnings.join("\n")).toContain('unknown config key "nonsense"');
    expect(warnings.join("\n")).toContain('"model" must be a non-empty string');
    expect(warnings.join("\n")).toContain('"permissionMode" must be one of');
    expect(warnings.join("\n")).toContain('"theme" must be a non-empty string');
    expect(warnings.join("\n")).toContain('"permissions" must be an array');
  });

  it("accepts requestStallTimeoutMs as a non-negative integer, including 0 (disable)", () => {
    const warnings: string[] = [];
    expect(
      parseConfigFile({ requestStallTimeoutMs: 90_000 }, "project", "cfg", warnings)
        .requestStallTimeoutMs,
    ).toBe(90_000);
    expect(
      parseConfigFile({ requestStallTimeoutMs: 0 }, "project", "cfg", warnings)
        .requestStallTimeoutMs,
    ).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  it("rejects a negative or fractional requestStallTimeoutMs", () => {
    const warnings: string[] = [];
    expect(
      parseConfigFile({ requestStallTimeoutMs: -1 }, "project", "cfg", warnings)
        .requestStallTimeoutMs,
    ).toBeUndefined();
    expect(
      parseConfigFile({ requestStallTimeoutMs: 1.5 }, "project", "cfg", warnings)
        .requestStallTimeoutMs,
    ).toBeUndefined();
    expect(warnings.join("\n")).toContain('"requestStallTimeoutMs" must be a non-negative integer');
  });

  it("drops invalid rules but keeps valid ones", () => {
    const warnings: string[] = [];
    const parsed = parseConfigFile(
      { permissions: [{ tool: "bash" }, { tool: "write", action: "deny" }] },
      "project",
      "cfg",
      warnings,
    );
    expect(parsed.permissions).toEqual([{ tool: "write", action: "deny", scope: "project" }]);
    expect(warnings).toHaveLength(1);
  });

  it("accepts a route block with a tiers map alongside the four fixed kinds", () => {
    const warnings: string[] = [];
    const parsed = parseConfigFile(
      {
        route: {
          subagent: "zai/glm-4.7",
          tiers: { judgment: "zai/glm-5.3", build: "zai/glm-4.7", cheap: "zai/glm-4.6" },
        },
      },
      "project",
      "cfg",
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(parsed.route).toEqual({
      subagent: "zai/glm-4.7",
      tiers: { judgment: "zai/glm-5.3", build: "zai/glm-4.7", cheap: "zai/glm-4.6" },
    });
  });

  it("accepts a route block with no tiers key at all (tiers stays unset)", () => {
    const warnings: string[] = [];
    const parsed = parseConfigFile(
      { route: { main: "anthropic/claude-opus-5" } },
      "project",
      "cfg",
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(parsed.route).toEqual({ main: "anthropic/claude-opus-5" });
    expect(parsed.route?.tiers).toBeUndefined();
  });

  it("rejects a non-string tier id, dropping only that entry", () => {
    const warnings: string[] = [];
    const parsed = parseConfigFile(
      { route: { tiers: { judgment: "zai/glm-5.3", build: 42 } } },
      "project",
      "cfg",
      warnings,
    );
    expect(parsed.route?.tiers).toEqual({ judgment: "zai/glm-5.3" });
    expect(warnings.join("\n")).toContain('"route.tiers.build" must be a non-empty string');
  });

  it("rejects a route.tiers that is not an object, without dropping the rest of route", () => {
    const warnings: string[] = [];
    const parsed = parseConfigFile(
      { route: { subagent: "zai/glm-4.7", tiers: "nope" } },
      "project",
      "cfg",
      warnings,
    );
    expect(parsed.route?.subagent).toBe("zai/glm-4.7");
    expect(parsed.route?.tiers).toBeUndefined();
    expect(warnings.join("\n")).toContain('"route.tiers" must be an object of model ids');
  });
});

describe("mergeConfig", () => {
  it("lets the later layer win and concatenates rules", () => {
    const base: ArcturnConfig = {
      ...DEFAULT_CONFIG,
      model: "a",
      permissions: [{ tool: "read", action: "allow", scope: "user" }],
      hooks: {
        preToolUse: [{ command: "./base.sh" }],
        postToolUse: [],
        sessionStart: [],
        runEnd: [],
      },
    };
    const merged = mergeConfig(base, {
      model: "b",
      permissions: [{ tool: "bash", action: "deny", scope: "project" }],
      hooks: {
        preToolUse: [{ command: "./layer.sh" }],
        postToolUse: [],
        sessionStart: [],
        runEnd: [],
      },
    });
    expect(merged.model).toBe("b");
    expect(merged.permissionMode).toBe("default");
    expect(merged.permissions.map((rule) => rule.tool)).toEqual(["read", "bash"]);
    // Hooks accumulate across layers, like permissions.
    expect(merged.hooks.preToolUse.map((hook) => hook.command)).toEqual([
      "./base.sh",
      "./layer.sh",
    ]);
  });

  it("lets a layer's requestStallTimeoutMs of 0 win over the base (not treated as unset)", () => {
    const base: ArcturnConfig = { ...DEFAULT_CONFIG, requestStallTimeoutMs: 90_000 };
    expect(mergeConfig(base, { requestStallTimeoutMs: 0 }).requestStallTimeoutMs).toBe(0);
    // An absent layer value keeps the base.
    expect(mergeConfig(base, {}).requestStallTimeoutMs).toBe(90_000);
  });

  it("carries a layer's route (including tiers) forward instead of dropping it", () => {
    const base: ArcturnConfig = { ...DEFAULT_CONFIG };
    const merged = mergeConfig(base, {
      route: { subagent: "zai/glm-4.7", tiers: { judgment: "zai/glm-5.3" } },
    });
    expect(merged.route).toEqual({
      subagent: "zai/glm-4.7",
      tiers: { judgment: "zai/glm-5.3" },
    });
  });

  it("keeps the base's route when the layer sets none", () => {
    const base: ArcturnConfig = {
      ...DEFAULT_CONFIG,
      route: { tiers: { judgment: "zai/glm-5.3" } },
    };
    expect(mergeConfig(base, {}).route).toEqual({ tiers: { judgment: "zai/glm-5.3" } });
  });

  it("lets a layer's route replace the base's wholesale, not merge field-by-field", () => {
    const base: ArcturnConfig = {
      ...DEFAULT_CONFIG,
      route: { subagent: "zai/glm-4.7", tiers: { judgment: "zai/glm-5.3", build: "zai/glm-4.7" } },
    };
    // The layer only sets `main` — a field-by-field merge would keep the
    // base's `subagent`/`tiers` too; wholesale replace does not.
    const merged = mergeConfig(base, { route: { main: "anthropic/claude-opus-5" } });
    expect(merged.route).toEqual({ main: "anthropic/claude-opus-5" });
  });
});

describe("loadConfig", () => {
  it("returns defaults when nothing is on disk", async () => {
    const { home, cwd } = await scratch();
    const loaded = await loadConfig({ home, cwd, env: {} });
    expect(loaded.config.model).toBe(DEFAULT_MODEL);
    expect(loaded.config.permissionMode).toBe("default");
    expect(loaded.sources).toEqual([]);
    expect(loaded.warnings).toEqual([]);
  });

  it("layers project over user and tags rule scopes by file", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeJson(paths.userConfig, {
      model: "openai/gpt-5",
      theme: "light",
      permissions: [{ tool: "read", action: "allow" }],
    });
    await writeJson(paths.projectConfig, {
      model: "anthropic/claude-opus-4-5",
      permissions: [{ tool: "bash", specifier: "git *", action: "allow" }],
    });

    const loaded = await loadConfig({ home, cwd, env: {} });
    expect(loaded.config.model).toBe("anthropic/claude-opus-4-5");
    expect(loaded.config.theme).toBe("light");
    expect(loaded.config.permissions).toEqual([
      { tool: "read", action: "allow", scope: "user" },
      { tool: "bash", specifier: "git *", action: "allow", scope: "project" },
    ]);
    expect(loaded.sources).toEqual([paths.userConfig, paths.projectConfig]);
  });

  it("lets ARCTURN_MODEL override every file", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeJson(paths.projectConfig, { model: "openai/gpt-5" });
    const loaded = await loadConfig({ home, cwd, env: { ARCTURN_MODEL: "google/gemini-2.5-pro" } });
    expect(loaded.config.model).toBe("google/gemini-2.5-pro");
  });

  it("warns about malformed JSON and still returns a usable config", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await mkdir(join(paths.projectConfig, ".."), { recursive: true });
    await writeFile(paths.projectConfig, "{ not json", "utf8");
    const loaded = await loadConfig({ home, cwd, env: {} });
    expect(loaded.config.model).toBe(DEFAULT_MODEL);
    expect(loaded.warnings.join("\n")).toContain("invalid JSON");
  });

  it("reads the shared file only once when the project layer aliases the user layer", async () => {
    const { cwd } = await scratch();
    const home = join(cwd, ".arcturn");
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    expect(paths.projectConfig).toBe(paths.userConfig);
    await writeJson(paths.userConfig, {
      permissions: [{ tool: "bash", specifier: "git *", action: "allow" }],
    });
    const loaded = await loadConfig({ home, cwd, env: {} });
    expect(loaded.sources).toEqual([paths.userConfig]);
    expect(loaded.config.permissions).toHaveLength(1);
    expect(loaded.warnings).toEqual([]);
  });

  it("honours ARCTURN_HOME", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ cwd, env: { ARCTURN_HOME: home } });
    expect(paths.userConfig).toBe(join(home, "config.json"));
    await writeJson(paths.userConfig, { thinking: "medium" });
    const loaded = await loadConfig({ cwd, env: { ARCTURN_HOME: home } });
    expect(loaded.config.thinking).toBe("medium");
  });

  it("surfaces route.tiers from a project config file end to end", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeJson(paths.projectConfig, {
      route: { tiers: { judgment: "zai/glm-5.3", build: "zai/glm-4.7", cheap: "zai/glm-4.6" } },
    });
    const loaded = await loadConfig({ home, cwd, env: {} });
    expect(loaded.config.route?.tiers).toEqual({
      judgment: "zai/glm-5.3",
      build: "zai/glm-4.7",
      cheap: "zai/glm-4.6",
    });
    expect(loaded.warnings).toEqual([]);
  });
});

describe("persistPermissionRule", () => {
  it("writes project rules to the project file", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    const rule: PermissionRule = {
      tool: "bash",
      specifier: "git *",
      action: "allow",
      scope: "project",
    };
    const file = await persistPermissionRule(rule, paths);
    expect(file).toBe(paths.projectConfig);
    const stored: unknown = JSON.parse(await readFile(paths.projectConfig, "utf8"));
    expect(stored).toEqual({ permissions: [rule] });
  });

  it("writes user rules to the user file and does not duplicate", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    const rule: PermissionRule = { tool: "write", action: "allow", scope: "user" };
    await persistPermissionRule(rule, paths);
    await persistPermissionRule(rule, paths);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as {
      permissions: unknown[];
    };
    expect(stored.permissions).toHaveLength(1);
  });

  it("keeps session rules out of every file", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    const written = await persistPermissionRule(
      { tool: "bash", action: "allow", scope: "session" },
      paths,
    );
    expect(written).toBeUndefined();
    await expect(readFile(paths.projectConfig, "utf8")).rejects.toThrow();
    await expect(readFile(paths.userConfig, "utf8")).rejects.toThrow();
  });

  it("stores a project rule as user scope when cwd's .arcturn is the user root", async () => {
    // Running arcturn from `~` makes `<cwd>/.arcturn/config.json` the user file itself;
    // a stored "project" scope would then warn (and be downgraded) on every
    // subsequent launch.
    const { cwd } = await scratch();
    const home = join(cwd, ".arcturn");
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    const file = await persistPermissionRule(
      { tool: "bash", specifier: "npm *", action: "allow", scope: "project" },
      paths,
    );
    expect(file).toBe(paths.userConfig);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as {
      permissions: PermissionRule[];
    };
    expect(stored.permissions).toEqual([
      { tool: "bash", specifier: "npm *", action: "allow", scope: "user" },
    ]);
    // Round trip: the rule loads back cleanly, with no scope warning.
    const loaded = await loadConfig({ home, cwd, env: {} });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.permissions).toHaveLength(1);
  });

  it("preserves unrelated settings when appending a rule", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeJson(paths.projectConfig, { model: "openai/gpt-5" });
    await persistPermissionRule({ tool: "edit", action: "allow", scope: "project" }, paths);
    const stored = JSON.parse(await readFile(paths.projectConfig, "utf8")) as ArcturnConfig;
    expect(stored.model).toBe("openai/gpt-5");
    expect(stored.permissions).toHaveLength(1);
  });
});

describe("persistSetting", () => {
  it("writes a single key into the requested scope", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await persistSetting("model", "openai/gpt-5-mini", "user", paths);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.model).toBe("openai/gpt-5-mini");
  });
});

describe("parsePermissionMode", () => {
  it("accepts the four modes and rejects anything else", () => {
    expect(parsePermissionMode("plan")).toBe("plan");
    expect(parsePermissionMode("yolo")).toBe("yolo");
    expect(parsePermissionMode("nope")).toBeUndefined();
  });
});
