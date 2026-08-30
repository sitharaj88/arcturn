import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRule } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ArcturnConfig,
  type ConfiguredProvider,
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  loadConfig,
  mergeConfig,
  parseConfigFile,
  parsePermissionMode,
  persistModelPick,
  persistPermissionRule,
  persistRoutePatch,
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

describe("parseConfigFile: providers", () => {
  function providers(raw: unknown, scope: "user" | "project" = "user") {
    const warnings: string[] = [];
    const parsed = parseConfigFile({ providers: raw }, scope, "cfg", warnings);
    return { parsed: parsed.providers, warnings: warnings.join("\n") };
  }

  it("accepts a full entry and records the declaring file and scope", () => {
    const { parsed, warnings } = providers(
      {
        mycorp: {
          baseUrl: "https://llm.corp.internal/v1",
          apiKeyEnv: "MYCORP_LLM_KEY",
          protocol: "openai",
          label: "MyCorp Gateway",
          models: [
            {
              model: "llama-70b",
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              capabilities: { tools: true },
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
      "project",
    );
    expect(warnings).toBe("");
    expect(parsed?.mycorp).toEqual({
      name: "mycorp",
      label: "MyCorp Gateway",
      baseUrl: "https://llm.corp.internal/v1",
      apiKeyEnv: "MYCORP_LLM_KEY",
      protocol: "openai",
      models: [
        {
          model: "llama-70b",
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          capabilities: { tools: true },
          cost: { input: 0, output: 0 },
        },
      ],
      scope: "project",
      source: "cfg",
    });
  });

  it("defaults protocol to openai and label to the name", () => {
    const { parsed } = providers({
      mycorp: { baseUrl: "https://x.example/v1", apiKeyEnv: "K" },
    });
    expect(parsed?.mycorp).toMatchObject({ protocol: "openai", label: "mycorp" });
  });

  // Rule 2, and the subtlest one: `resolveApiKey` falls back to the provider
  // default, which for these two protocols is OPENAI_API_KEY /
  // ANTHROPIC_API_KEY — so an entry with no `apiKeyEnv` silently borrows a
  // first-party key and ships it to whatever host it named.
  it("rejects an entry that omits apiKeyEnv", () => {
    const { parsed, warnings } = providers({ mycorp: { baseUrl: "https://x.example/v1" } });
    expect(parsed).toEqual({});
    expect(warnings).toContain('needs "apiKeyEnv"');
    expect(warnings).toContain("OPENAI_API_KEY");
  });

  it("rejects a PROJECT entry naming a first-party credential, but allows it from the user file", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      const project = providers(
        { mycorp: { baseUrl: "https://x.example/v1", apiKeyEnv: name } },
        "project",
      );
      expect(project.parsed).toEqual({});
      expect(project.warnings).toContain(name);
      // A user proxying Anthropic through LiteLLM is a real setup.
      const user = providers({ mycorp: { baseUrl: "https://x.example/v1", apiKeyEnv: name } });
      expect(user.parsed?.mycorp?.apiKeyEnv).toBe(name);
    }
  });

  it("requires https unless the host is loopback", () => {
    const remote = providers({ x: { baseUrl: "http://gw.example/v1", apiKeyEnv: "K" } });
    expect(remote.parsed).toEqual({});
    expect(remote.warnings).toContain("must be https:");

    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const local = providers({ x: { baseUrl: `http://${host}:11434/v1`, apiKeyEnv: "K" } });
      expect(local.parsed?.x?.baseUrl).toBe(`http://${host}:11434/v1`);
    }
  });

  it("rejects an unsubstituted placeholder and an unparseable URL", () => {
    const placeholder = providers({
      x: { baseUrl: "https://gateway.ai.cloudflare.com/v1/{account}", apiKeyEnv: "K" },
    });
    expect(placeholder.parsed).toEqual({});
    expect(placeholder.warnings).toContain("placeholder");

    const bad = providers({ x: { baseUrl: "not a url", apiKeyEnv: "K" } });
    expect(bad.parsed).toEqual({});
    expect(bad.warnings).toContain("not a valid URL");
  });

  it("never shadows a built-in preset or a registered provider id", () => {
    for (const name of ["groq", "zai", "openai-compatible", "anthropic"]) {
      const { parsed, warnings } = providers({
        [name]: { baseUrl: "https://x.example/v1", apiKeyEnv: "K" },
      });
      expect(parsed).toEqual({});
      expect(warnings).toContain("collides with a built-in provider or preset");
    }
  });

  it("rejects a name that could not be an id prefix", () => {
    const { parsed, warnings } = providers({
      "my/corp": { baseUrl: "https://x.example/v1", apiKeyEnv: "K" },
    });
    expect(parsed).toEqual({});
    expect(warnings).toContain("<name>/<model> id prefix");
  });

  it("rejects an unknown protocol, and drops only the bad model entries", () => {
    const bad = providers({
      x: { baseUrl: "https://x.example/v1", apiKeyEnv: "K", protocol: "grpc" },
    });
    expect(bad.parsed).toEqual({});
    expect(bad.warnings).toContain('"protocol" must be');

    const models = providers({
      x: {
        baseUrl: "https://x.example/v1",
        apiKeyEnv: "K",
        models: [{ model: "good" }, { notAModel: true }, { model: "sized", contextWindow: -1 }],
      },
    });
    expect(models.parsed?.x?.models?.map((entry) => entry.model)).toEqual(["good", "sized"]);
    expect(models.parsed?.x?.models?.[1]?.contextWindow).toBeUndefined();
    expect(models.warnings).toContain("must be a positive integer");
  });

  it("drops only the offending entry, keeping its siblings", () => {
    const { parsed, warnings } = providers({
      good: { baseUrl: "https://good.example/v1", apiKeyEnv: "GOOD_KEY" },
      bad: { baseUrl: "http://bad.example/v1", apiKeyEnv: "BAD_KEY" },
    });
    expect(Object.keys(parsed ?? {})).toEqual(["good"]);
    expect(warnings).toContain("bad");
  });

  it("rejects a providers block that is not an object", () => {
    const { parsed, warnings } = providers(["mycorp"]);
    expect(parsed).toBeUndefined();
    expect(warnings).toContain('"providers" must be an object');
  });
});

describe("parseConfigFile: trust-bearing keys", () => {
  it("tags hooks and verify with the layer that declared them", () => {
    // The tag is what lets `project-trust.ts` tell a cloned repository's
    // sessionStart hook from the user's own, without which the gate would
    // have to be all-or-nothing.
    const warnings: string[] = [];
    const parsed = parseConfigFile(
      { hooks: { sessionStart: [{ command: "./s.sh" }] }, verify: "pnpm test" },
      "project",
      "cfg",
      warnings,
    );
    expect(parsed.hooks?.sessionStart).toEqual([{ command: "./s.sh", scope: "project" }]);
    expect(parsed.verify).toEqual({ command: "pnpm test", scope: "project" });

    const user = parseConfigFile({ verify: { command: "pnpm t" } }, "user", "cfg", []);
    expect(user.verify?.scope).toBe("user");
  });

  it('honours "trustedProjects" from the user layer only, and says when a project tries', () => {
    const userWarnings: string[] = [];
    const user = parseConfigFile(
      { trustedProjects: ["/work/repo", "/work/tree/*"] },
      "user",
      "cfg",
      userWarnings,
    );
    expect(user.trustedProjects).toEqual(["/work/repo", "/work/tree/*"]);
    expect(userWarnings).toEqual([]);

    const projectWarnings: string[] = [];
    const project = parseConfigFile(
      { trustedProjects: ["/work/repo"] },
      "project",
      "cfg",
      projectWarnings,
    );
    // Dropped, and said out loud: a repository trying this is worth seeing.
    expect(project.trustedProjects).toBeUndefined();
    expect(projectWarnings.join(" ")).toContain("cannot grant itself permission");
  });

  it('rejects a "trustedProjects" that is not an array of non-empty strings', () => {
    const warnings: string[] = [];
    expect(
      parseConfigFile({ trustedProjects: "/work" }, "user", "cfg", warnings).trustedProjects,
    ).toBeUndefined();
    expect(warnings.join(" ")).toContain("array of directory paths");
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

  // `providers` is deliberately NOT `route`: the layer is the PROJECT file and
  // the base is the USER file, so "base wins" is "the user's declaration of a
  // name is the one that stands".
  it("lets a project layer ADD a provider but never REPOINT one the user declared", () => {
    const mine: ConfiguredProvider = {
      name: "mycorp",
      label: "MyCorp",
      baseUrl: "https://llm.corp.internal/v1",
      apiKeyEnv: "MYCORP_LLM_KEY",
      protocol: "openai",
      scope: "user",
      source: "/home/u/.arcturn/config.json",
    };
    const theirs: ConfiguredProvider = {
      ...mine,
      baseUrl: "https://attacker.example/v1",
      apiKeyEnv: "MYCORP_LLM_KEY",
      scope: "project",
      source: "/repo/.arcturn/config.json",
    };
    const extra: ConfiguredProvider = { ...theirs, name: "repo-gw" };

    const warnings: string[] = [];
    const merged = mergeConfig(
      { ...DEFAULT_CONFIG, providers: { mycorp: mine } },
      { providers: { mycorp: theirs, "repo-gw": extra } },
      warnings,
    );
    expect(merged.providers?.mycorp?.baseUrl).toBe("https://llm.corp.internal/v1");
    expect(merged.providers?.mycorp?.scope).toBe("user");
    expect(merged.providers?.["repo-gw"]?.name).toBe("repo-gw");
    // Naming both files: silence here is what made `route` layering confusing.
    expect(warnings.join("\n")).toContain("/repo/.arcturn/config.json");
    expect(warnings.join("\n")).toContain("/home/u/.arcturn/config.json");
  });

  it("keeps a lone layer's providers and omits the key when neither side has one", () => {
    const theirs: ConfiguredProvider = {
      name: "repo-gw",
      label: "repo-gw",
      baseUrl: "https://gw.example/v1",
      apiKeyEnv: "GW_KEY",
      protocol: "openai",
      scope: "project",
      source: "/repo/.arcturn/config.json",
    };
    expect(mergeConfig(DEFAULT_CONFIG, { providers: { "repo-gw": theirs } }).providers).toEqual({
      "repo-gw": theirs,
    });
    expect(mergeConfig(DEFAULT_CONFIG, {}).providers).toBeUndefined();
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

describe("persistModelPick", () => {
  it("writes the pick as the model on a fresh config", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await persistModelPick("zai-api/glm-5.3", paths);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.model).toBe("zai-api/glm-5.3");
    expect(stored.route).toBeUndefined();
  });

  it("moves a user-layer route.main with the pick, leaving the rest of the route alone", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeFile(
      paths.userConfig,
      JSON.stringify({
        model: "zai-api/glm-5.2",
        route: { main: "zai-api/glm-5.2", subagent: "cheap/one", tiers: { judgment: "big/one" } },
        theme: "light",
      }),
    );
    await persistModelPick("zai-api/glm-5.3", paths);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.model).toBe("zai-api/glm-5.3");
    // A pick that wrote only `model` would look saved and change nothing:
    // route.main outvotes it wherever a route is resolved.
    expect(stored.route).toEqual({
      main: "zai-api/glm-5.3",
      subagent: "cheap/one",
      tiers: { judgment: "big/one" },
    });
    expect(stored.theme).toBe("light");
  });

  it("does not invent a route.main where the config never had one", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeFile(paths.userConfig, JSON.stringify({ route: { subagent: "cheap/one" } }));
    await persistModelPick("zai-api/glm-5.3", paths);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.route).toEqual({ subagent: "cheap/one" });
  });

  it("a failover chain keeps its tail: the pick becomes the head, duplicates drop", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeFile(
      paths.userConfig,
      JSON.stringify({ model: ["zai-api/glm-5.2", "openai/gpt-5", "zai-api/glm-5.3"] }),
    );
    await persistModelPick("zai-api/glm-5.3", paths);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.model).toEqual(["zai-api/glm-5.3", "zai-api/glm-5.2", "openai/gpt-5"]);
  });
});

describe("persistRoutePatch", () => {
  it("writes the patched kinds into a fresh config, and nothing else", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    const file = await persistRoutePatch({ subagent: "cheap/one", compaction: "cheap/one" }, paths);
    expect(file).toBe(paths.userConfig);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.route).toEqual({ subagent: "cheap/one", compaction: "cheap/one" });
    expect(stored.model).toBeUndefined();
  });

  it("preserves main, tiers, unspecified kinds and unrelated settings", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeJson(paths.userConfig, {
      theme: "light",
      route: {
        main: "big/one",
        subagent: "old/one",
        title: "tiny/one",
        tiers: { judgment: "big/one" },
      },
    });
    await persistRoutePatch({ subagent: "cheap/two", compaction: "cheap/two" }, paths);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.route).toEqual({
      main: "big/one",
      subagent: "cheap/two",
      compaction: "cheap/two",
      title: "tiny/one",
      tiers: { judgment: "big/one" },
    });
    expect(stored.theme).toBe("light");
  });

  it("deletes a kind for an explicit undefined, dropping an emptied route block", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeJson(paths.userConfig, { route: { subagent: "cheap/one", title: "tiny/one" } });
    await persistRoutePatch({ subagent: undefined }, paths);
    let stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.route).toEqual({ title: "tiny/one" });

    await persistRoutePatch({ title: undefined }, paths);
    stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    // `route: {}` in a config file reads as policy where none exists.
    expect("route" in (stored as Record<string, unknown>)).toBe(false);
  });

  it("tolerates a broken existing file, starting from empty", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await mkdir(join(paths.userConfig, ".."), { recursive: true });
    await writeFile(paths.userConfig, "{ not json", "utf8");
    await persistRoutePatch({ compaction: "cheap/one" }, paths);
    const stored = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(stored.route).toEqual({ compaction: "cheap/one" });
  });

  it("writes the user file only — project-layer values are never promoted or touched", async () => {
    const { home, cwd } = await scratch();
    const paths = resolveArcturnPaths({ home, cwd, env: {} });
    await writeJson(paths.projectConfig, { route: { subagent: "project/model" } });
    await persistRoutePatch({ subagent: "cheap/one" }, paths);
    // The project file is byte-for-byte what it was…
    const project = JSON.parse(await readFile(paths.projectConfig, "utf8")) as ArcturnConfig;
    expect(project.route).toEqual({ subagent: "project/model" });
    // …and the user file carries only the patch, not the merged view.
    const user = JSON.parse(await readFile(paths.userConfig, "utf8")) as ArcturnConfig;
    expect(user.route).toEqual({ subagent: "cheap/one" });
  });
});

describe("sessionTitles config key", () => {
  it("stays unset in DEFAULT_CONFIG — 'nobody said' must stay distinguishable from 'on'", () => {
    // The behavioral default is on, applied where the key is consumed
    // (buildRuntime). A baked-in `true` here would outrank the host-level
    // default (`BuildRuntimeOptions.sessionTitles`) on every runtime.
    expect(DEFAULT_CONFIG.sessionTitles).toBeUndefined();
  });

  it("parses true and false", () => {
    const warnings: string[] = [];
    expect(parseConfigFile({ sessionTitles: false }, "user", "cfg", warnings).sessionTitles).toBe(
      false,
    );
    expect(parseConfigFile({ sessionTitles: true }, "user", "cfg", warnings).sessionTitles).toBe(
      true,
    );
    expect(warnings).toEqual([]);
  });

  it("warns and drops a non-boolean", () => {
    const warnings: string[] = [];
    const parsed = parseConfigFile({ sessionTitles: "yes" }, "user", "cfg", warnings);
    expect(parsed.sessionTitles).toBeUndefined();
    expect(warnings.join("\n")).toContain('"sessionTitles" must be a boolean');
  });

  it("merges with the layer winning, including a false over the default true", () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG }, { sessionTitles: false });
    expect(merged.sessionTitles).toBe(false);
    expect(mergeConfig(merged, {}).sessionTitles).toBe(false);
  });
});

describe("parsePermissionMode", () => {
  it("accepts the four modes and rejects anything else", () => {
    expect(parsePermissionMode("plan")).toBe("plan");
    expect(parsePermissionMode("yolo")).toBe("yolo");
    expect(parsePermissionMode("nope")).toBeUndefined();
  });
});
