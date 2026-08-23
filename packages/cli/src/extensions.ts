/**
 * Extension loading.
 *
 * Arcturn loads every module found in `~/.arcturn/extensions/` and
 * `<cwd>/.arcturn/extensions/` (user first, then project) through
 * [jiti](https://github.com/unjs/jiti), so plain `.js` and TypeScript `.ts`
 * files both work with no build step. A directory is treated as an extension
 * when it contains an `index.ts`/`index.js`.
 *
 * Each module **default-exports a single function** that receives a
 * {@link ArcturnExtensionApi}:
 *
 * ```ts
 * // ~/.arcturn/extensions/hello.ts
 * import type { ArcturnExtensionApi } from "arcturn";
 *
 * export default function (api: ArcturnExtensionApi): void {
 *   // 1. Add a tool the model can call.
 *   api.registerTool({
 *     definition: {
 *       name: "coin_flip",
 *       description: "Flip a fair coin.",
 *       parameters: { type: "object", properties: {}, additionalProperties: false },
 *     },
 *     async execute() {
 *       const side = Math.random() < 0.5 ? "heads" : "tails";
 *       return { content: [{ type: "text", text: side }] };
 *     },
 *   });
 *
 *   // 2. Add a slash command.
 *   api.registerCommand("/hello", "Say hello", (ctx) => {
 *     ctx.ui.print(`Hello from ${ctx.runtime.cwd}`);
 *   });
 *
 *   // 3. Observe the agent event stream ("*" receives every event).
 *   api.on("toolStart", (event) => {
 *     if (event.type === "toolStart" && event.toolName === "bash") {
 *       api.log(`running: ${String(event.input.command)}`);
 *     }
 *   });
 *
 *   // 4. Read the resolved configuration.
 *   if (api.config.permissionMode === "yolo") api.log("living dangerously");
 * }
 * ```
 *
 * Extensions are isolated: a module that throws on import or on invocation is
 * reported as a warning and skipped, and a listener that throws never breaks a
 * run.
 */

import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AgentEvent, Tool } from "@arcturn/types";
import { createJiti } from "jiti";
import type { CommandContext } from "./commands.js";
import type { ArcturnConfig } from "./config.js";

/** Event names an extension can subscribe to, plus `"*"` for everything. */
export type ExtensionEventName = AgentEvent["type"] | "*";

/** Handler for a command registered by an extension. */
export type ExtensionCommandHandler = (context: CommandContext) => void | Promise<void>;

/** The surface handed to every extension's default export. */
export interface ArcturnExtensionApi {
  /** The merged configuration Arcturn is running with. */
  readonly config: Readonly<ArcturnConfig>;
  /** Absolute working directory. */
  readonly cwd: string;
  /** CLI version, for compatibility checks. */
  readonly version: string;
  /** Absolute path of the extension module being loaded. */
  readonly file: string;
  /**
   * Register a tool the model can call. Names must be unique; a clash with a
   * built-in tool is reported and the registration is dropped.
   */
  registerTool(tool: Tool): void;
  /**
   * Register a slash command. A leading `/` is optional.
   *
   * @param name - Command name, e.g. `"review"` or `"/review"`.
   * @param description - One-line help text.
   * @param handler - Invoked with the live {@link CommandContext}.
   */
  registerCommand(name: string, description: string, handler: ExtensionCommandHandler): void;
  /**
   * Subscribe to agent events.
   *
   * @param event - An `AgentEvent["type"]`, or `"*"` for every event.
   * @param listener - Called for each matching event; exceptions are swallowed.
   */
  on(event: ExtensionEventName, listener: (event: AgentEvent) => void): void;
  /** Emit an informational line into the transcript. */
  log(message: string): void;
}

/** An extension's default export. */
export type ArcturnExtension = (api: ArcturnExtensionApi) => void | Promise<void>;

/** A slash command contributed by an extension. */
export interface ExtensionCommand {
  /** Command name without the leading slash. */
  name: string;
  /** One-line help text. */
  description: string;
  /** The handler to run. */
  handler: ExtensionCommandHandler;
  /** Module that registered it. */
  source: string;
}

/** Outcome of loading one extension module. */
export interface ExtensionLoadResult {
  /** Absolute module path. */
  file: string;
  /** Whether the module loaded and ran without throwing. */
  ok: boolean;
  /** Failure reason when `ok` is `false`. */
  error?: string;
}

const MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** Packages an extension may import by name regardless of where it lives. */
const SHARED_PACKAGES = [
  "arcturn",
  "@arcturn/types",
  "@arcturn/ai",
  "@arcturn/core",
  "@arcturn/tools",
  "@arcturn/mcp",
  "@arcturn/tui",
];

let aliasCache: Record<string, string> | undefined;

/**
 * Map Arcturn's own packages to absolute paths.
 *
 * Extensions live outside the Arcturn install, so a bare `@arcturn/ai` import
 * would not resolve from their directory. Aliasing them to the very files the
 * CLI already loaded also guarantees a single module instance, so an extension
 * calling `registerModel()` mutates the same catalog the CLI reads.
 */
function arcturnPackageAliases(): Record<string, string> {
  if (aliasCache) return aliasCache;
  const resolver = createRequire(import.meta.url);
  const alias: Record<string, string> = {};
  for (const name of SHARED_PACKAGES) {
    try {
      alias[name] = resolver.resolve(name);
    } catch {
      // Not installed alongside this build; leave it to normal resolution.
    }
  }
  aliasCache = alias;
  return alias;
}

/** Options for {@link loadExtensions}. */
export interface LoadExtensionsOptions {
  /** Directories scanned in order (user scope first). */
  directories: readonly string[];
  /** Configuration exposed to extensions. */
  config: ArcturnConfig;
  /** Working directory exposed to extensions. */
  cwd: string;
  /** CLI version exposed to extensions. */
  version: string;
  /** Tool names already taken (built-ins, MCP tools); registrations that clash are dropped. */
  reservedToolNames?: Iterable<string>;
  /** Sink for `api.log` calls. Defaults to collecting into {@link ExtensionHost.logs}. */
  onLog?: (message: string, file: string) => void;
}

/**
 * Everything the loaded extensions contributed.
 *
 * The host also fans agent events out to extension listeners; call
 * {@link ExtensionHost.dispatch} from an `Agent.subscribe` callback.
 */
export class ExtensionHost {
  readonly tools: Tool[] = [];
  readonly commands: ExtensionCommand[] = [];
  readonly loaded: ExtensionLoadResult[] = [];
  readonly warnings: string[] = [];
  readonly logs: string[] = [];
  readonly #listeners: { event: ExtensionEventName; listener: (event: AgentEvent) => void }[] = [];

  /** Files that loaded successfully. */
  get active(): string[] {
    return this.loaded.filter((entry) => entry.ok).map((entry) => entry.file);
  }

  /** Register a listener directly (used by the loader and by tests). */
  addListener(event: ExtensionEventName, listener: (event: AgentEvent) => void): void {
    this.#listeners.push({ event, listener });
  }

  /** Number of registered event listeners. */
  get listenerCount(): number {
    return this.#listeners.length;
  }

  /**
   * Fan one agent event out to every matching extension listener.
   *
   * Listener exceptions are captured as warnings and never propagate.
   *
   * @param event - The event to deliver.
   */
  dispatch(event: AgentEvent): void {
    for (const entry of this.#listeners) {
      if (entry.event !== "*" && entry.event !== event.type) continue;
      try {
        entry.listener(event);
      } catch (error) {
        this.warnings.push(`extension listener failed: ${messageOf(error)}`);
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * List candidate extension modules in a directory.
 *
 * Dotfiles, `_`-prefixed files and `.d.ts` declarations are skipped; a
 * subdirectory contributes its `index.*` entry point.
 *
 * @param dir - Directory to scan.
 */
export async function discoverExtensionFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const full = join(dir, entry);
    if (entry.endsWith(".d.ts")) continue;
    if (MODULE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      files.push(full);
      continue;
    }
    try {
      const info = await stat(full);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    for (const ext of MODULE_EXTENSIONS) {
      const index = join(full, `index${ext}`);
      try {
        await stat(index);
        files.push(index);
        break;
      } catch {
        // Try the next extension.
      }
    }
  }
  return files;
}

/**
 * Load every extension found in the given directories.
 *
 * @param options - Directories to scan plus the API surface handed to modules.
 * @returns A host holding the contributed tools, commands and listeners.
 */
export async function loadExtensions(options: LoadExtensionsOptions): Promise<ExtensionHost> {
  const host = new ExtensionHost();
  const files: string[] = [];
  for (const dir of options.directories) files.push(...(await discoverExtensionFiles(dir)));
  if (files.length === 0) return host;

  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    fsCache: false,
    alias: arcturnPackageAliases(),
  });

  const toolNames = new Set(options.reservedToolNames ?? []);

  for (const file of files) {
    try {
      const loaded = await jiti.import<unknown>(file, { default: true });
      if (typeof loaded !== "function") {
        throw new Error("default export must be a function taking the extension api");
      }
      const api = createApi(host, options, file, toolNames);
      await (loaded as ArcturnExtension)(api);
      host.loaded.push({ file, ok: true });
    } catch (error) {
      host.loaded.push({ file, ok: false, error: messageOf(error) });
      host.warnings.push(`extension ${file} failed to load: ${messageOf(error)}`);
    }
  }
  return host;
}

function createApi(
  host: ExtensionHost,
  options: LoadExtensionsOptions,
  file: string,
  toolNames: Set<string>,
): ArcturnExtensionApi {
  return {
    config: options.config,
    cwd: options.cwd,
    version: options.version,
    file,
    registerTool(tool: Tool): void {
      const name = tool?.definition?.name;
      if (typeof name !== "string" || name.length === 0) {
        host.warnings.push(`extension ${file}: registerTool needs definition.name`);
        return;
      }
      if (toolNames.has(name)) {
        host.warnings.push(`extension ${file}: tool "${name}" is already registered (ignored)`);
        return;
      }
      toolNames.add(name);
      host.tools.push(tool);
    },
    registerCommand(name: string, description: string, handler: ExtensionCommandHandler): void {
      const clean = name.startsWith("/") ? name.slice(1) : name;
      if (clean.length === 0 || typeof handler !== "function") {
        host.warnings.push(`extension ${file}: registerCommand needs a name and a handler`);
        return;
      }
      host.commands.push({ name: clean, description, handler, source: file });
    },
    on(event: ExtensionEventName, listener: (agentEvent: AgentEvent) => void): void {
      if (typeof listener !== "function") {
        host.warnings.push(`extension ${file}: on("${event}") needs a listener function`);
        return;
      }
      host.addListener(event, listener);
    },
    log(message: string): void {
      host.logs.push(message);
      options.onLog?.(message, file);
    },
  };
}
