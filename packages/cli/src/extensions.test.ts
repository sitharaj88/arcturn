import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { type ArcturnConfig, DEFAULT_CONFIG } from "./config.js";
import { discoverExtensionFiles, ExtensionHost, loadExtensions } from "./extensions.js";

const config: ArcturnConfig = { ...DEFAULT_CONFIG, permissions: [] };

async function extensionDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-cli-ext-"));
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source, "utf8");
  }
  return dir;
}

async function load(dir: string) {
  return loadExtensions({
    directories: [dir],
    config,
    cwd: dir,
    version: "0.0.0-test",
    reservedToolNames: ["read", "bash"],
  });
}

describe("discoverExtensionFiles", () => {
  it("returns nothing for a missing directory", async () => {
    expect(await discoverExtensionFiles(join(tmpdir(), "arcturn-does-not-exist-42"))).toEqual([]);
  });

  it("finds modules and directory entry points, skipping dotfiles and declarations", async () => {
    const dir = await extensionDir({
      "a.js": "export default () => {};",
      "b.ts": "export default () => {};",
      ".hidden.js": "export default () => {};",
      "_draft.js": "export default () => {};",
      "types.d.ts": "export {};",
      "notes.md": "hello",
      "pack/index.js": "export default () => {};",
    });
    const found = (await discoverExtensionFiles(dir)).map((file) => file.slice(dir.length + 1));
    expect(found.sort()).toEqual(["a.js", "b.ts", join("pack", "index.js")].sort());
  });
});

describe("loadExtensions", () => {
  it("registers tools, commands and listeners from a JavaScript module", async () => {
    const dir = await extensionDir({
      "hello.js": `
        export default function (api) {
          api.registerTool({
            definition: { name: "coin", description: "flip", parameters: { type: "object" } },
            async execute() { return { content: [{ type: "text", text: "heads" }] }; },
          });
          api.registerCommand("/hello", "say hi", (ctx) => ctx.ui.print("hi"));
          api.on("toolStart", () => api.log("tool started"));
          api.log("loaded in " + api.cwd + " v" + api.version + " mode " + api.config.permissionMode);
        }
      `,
    });
    const host = await load(dir);
    expect(host.warnings).toEqual([]);
    expect(host.active).toHaveLength(1);
    expect(host.tools.map((tool) => tool.definition.name)).toEqual(["coin"]);
    expect(host.commands.map((command) => command.name)).toEqual(["hello"]);
    expect(host.listenerCount).toBe(1);
    expect(host.logs[0]).toContain("v0.0.0-test");
    expect(host.logs[0]).toContain("mode default");
  });

  it("loads TypeScript modules through jiti", async () => {
    const dir = await extensionDir({
      "typed.ts": `
        import type { ArcturnExtensionApi } from "../src/extensions.js";
        interface Unused { x: number }
        export default function (api: ArcturnExtensionApi): void {
          api.registerCommand("typed", "a typed command", () => undefined);
        }
      `,
    });
    const host = await load(dir);
    expect(host.warnings).toEqual([]);
    expect(host.commands.map((command) => command.name)).toEqual(["typed"]);
  });

  it("lets an extension import Arcturn's own packages from outside the install", async () => {
    // Extensions live in ~/.arcturn or <cwd>/.arcturn, where a bare "@arcturn/ai"
    // would not resolve; the loader aliases Arcturn's packages to absolute paths.
    const dir = await extensionDir({
      "model.js": `
        import { listModels, registerModel } from "@arcturn/ai";
        export default function (api) {
          registerModel({
            id: "test/echo",
            provider: "openai-compatible",
            model: "echo",
            displayName: "Test echo",
            contextWindow: 8192,
            maxOutputTokens: 1024,
            capabilities: { tools: true, vision: false, thinking: false, caching: false },
            baseUrl: "http://127.0.0.1:9/v1",
          });
          api.log("registered:" + listModels().some((m) => m.id === "test/echo"));
        }
      `,
    });
    const host = await load(dir);
    expect(host.warnings).toEqual([]);
    expect(host.logs).toEqual(["registered:true"]);
  });

  it("isolates a module that throws on load", async () => {
    const dir = await extensionDir({
      "bad.js": "throw new Error('kaboom');",
      "good.js": "export default (api) => api.registerCommand('good', 'ok', () => undefined);",
    });
    const host = await load(dir);
    expect(host.commands.map((command) => command.name)).toEqual(["good"]);
    expect(host.warnings.join("\n")).toContain("kaboom");
    expect(host.loaded.filter((entry) => !entry.ok)).toHaveLength(1);
  });

  it("rejects a module that does not default-export a function", async () => {
    const dir = await extensionDir({ "nope.js": "export const thing = 1;" });
    const host = await load(dir);
    expect(host.warnings.join("\n")).toContain("default export must be a function");
  });

  it("refuses to shadow a reserved tool name", async () => {
    const dir = await extensionDir({
      "clash.js": `
        export default (api) => api.registerTool({
          definition: { name: "bash", description: "no", parameters: {} },
          async execute() { return { content: [] }; },
        });
      `,
    });
    const host = await load(dir);
    expect(host.tools).toEqual([]);
    expect(host.warnings.join("\n")).toContain('tool "bash" is already registered');
  });

  it("validates registration arguments", async () => {
    const dir = await extensionDir({
      "invalid.js": `
        export default (api) => {
          api.registerTool({ definition: {} });
          api.registerCommand("", "no name", () => undefined);
          api.on("toolStart", "not a function");
        };
      `,
    });
    const host = await load(dir);
    expect(host.warnings).toHaveLength(3);
    expect(host.tools).toEqual([]);
    expect(host.commands).toEqual([]);
    expect(host.listenerCount).toBe(0);
  });
});

describe("ExtensionHost.dispatch", () => {
  const event: AgentEvent = { type: "notice", level: "info", text: "hi" };

  it("delivers only matching events, and everything to a wildcard listener", () => {
    const host = new ExtensionHost();
    const notices: string[] = [];
    const all: string[] = [];
    host.addListener("notice", (e) => notices.push(e.type));
    host.addListener("*", (e) => all.push(e.type));

    host.dispatch(event);
    host.dispatch({ type: "turnStart", turnIndex: 0 });

    expect(notices).toEqual(["notice"]);
    expect(all).toEqual(["notice", "turnStart"]);
  });

  it("captures a throwing listener as a warning without breaking the others", () => {
    const host = new ExtensionHost();
    const seen: string[] = [];
    host.addListener("*", () => {
      throw new Error("listener blew up");
    });
    host.addListener("*", (e) => seen.push(e.type));

    host.dispatch(event);

    expect(seen).toEqual(["notice"]);
    expect(host.warnings.join("\n")).toContain("listener blew up");
  });
});
