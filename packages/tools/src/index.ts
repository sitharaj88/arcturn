/** @arcturn/tools — the built-in tool set for the Arcturn agent harness. */

import type { Tool } from "@arcturn/types";
import { BackgroundTaskManager, createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createFetchTool } from "./fetch.js";
import { createGlobTool } from "./glob-tool.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import type { BashSandboxMode } from "./sandbox.js";
import { createWebSearchTool } from "./websearch.js";
import { createWriteTool } from "./write.js";

export type {
  BackgroundTaskManagerOptions,
  BackgroundTaskStatus,
  BashToolDetails,
  CreateBashToolOptions,
  KillEnvironment,
} from "./bash.js";
export {
  BACKGROUND_KILL_GRACE_MS,
  BackgroundTaskManager,
  buildTaskkillArgv,
  createBashTool,
  defaultKillEnvironment,
  FOREGROUND_KILL_DRAIN_MS,
  terminateProcessTree,
} from "./bash.js";
export type { EditToolDetails } from "./edit.js";
export { createEditTool } from "./edit.js";
export type { FetchToolDetails } from "./fetch.js";
export { createFetchTool, stripHtml } from "./fetch.js";
export type { GlobToolDetails } from "./glob-tool.js";
export { createGlobTool } from "./glob-tool.js";
export type { GrepToolDetails } from "./grep.js";
export { createGrepTool } from "./grep.js";
export type { LsToolDetails } from "./ls.js";
export { createLsTool } from "./ls.js";
export {
  displayPath,
  resolvePath,
  resolveSubjectPath,
  toPosixSeparators,
} from "./path-utils.js";
export type { ReadToolDetails } from "./read.js";
export { createReadTool } from "./read.js";
export type {
  BashSandboxMode,
  SandboxInvocation,
  SandboxProbe,
  SandboxWritableRoots,
} from "./sandbox.js";
export {
  buildBwrapArgv,
  buildSandboxExecArgv,
  buildSandboxExecProfile,
  commandExistsOnPath,
  defaultSandboxProbe,
  escapeSandboxProfilePath,
  noSandboxBackendNote,
  resolveSandboxInvocation,
  SANDBOX_UNAVAILABLE_NOTE,
} from "./sandbox.js";
export type { ResolvedShell, ShellPolicy, ShellProbe, ShellSpawnOptions } from "./shell.js";
export {
  defaultShellProbe,
  POSIX_DEFAULT_SHELL,
  resolveShell,
  WINDOWS_DEFAULT_SHELL,
  WINDOWS_SHELL_FLAGS,
} from "./shell.js";
export type { WebSearchResultItem, WebSearchToolDetails } from "./websearch.js";
export {
  createWebSearchTool,
  formatResults as formatWebSearchResults,
  parseBraveResponse,
  parseDuckDuckGoHtml,
} from "./websearch.js";
export type { WriteToolDetails } from "./write.js";
export { createWriteTool } from "./write.js";

export interface CreateDefaultToolsOptions {
  /**
   * Default working directory, used as a fallback when a tool call's
   * `ToolExecutionContext.cwd` is not already set by the runtime. Every
   * tool resolves relative paths against `ctx.cwd` at execution time, so
   * this is only a defensive default, not a binding at construction time.
   */
  cwd?: string;
  /**
   * Filesystem sandbox applied to the `bash` tool's foreground commands;
   * forwarded verbatim to {@link createBashTool}. Defaults to `"off"`
   * (unchanged behavior).
   */
  sandbox?: BashSandboxMode;
}

export interface DefaultTools {
  /** All built-in tools, in a stable order. */
  tools: Tool[];
  read: Tool;
  write: Tool;
  edit: Tool;
  bash: Tool;
  grep: Tool;
  glob: Tool;
  ls: Tool;
  fetch: Tool;
  websearch: Tool;
  /** Manages bash commands started with `background: true`. */
  backgroundTasks: BackgroundTaskManager;
}

/**
 * Build a fresh set of the built-in Arcturn tools, each with independent state
 * (in particular, a dedicated {@link BackgroundTaskManager}). Call this once
 * per session/agent instance.
 */
export function createDefaultTools(options: CreateDefaultToolsOptions = {}): DefaultTools {
  const backgroundTasks = new BackgroundTaskManager();

  const read = createReadTool();
  const write = createWriteTool();
  const edit = createEditTool();
  const bash = createBashTool(backgroundTasks, { sandbox: options.sandbox });
  const grep = createGrepTool();
  const glob = createGlobTool();
  const ls = createLsTool();
  const fetch = createFetchTool();
  const websearch = createWebSearchTool();

  return {
    tools: [read, write, edit, bash, grep, glob, ls, fetch, websearch],
    read,
    write,
    edit,
    bash,
    grep,
    glob,
    ls,
    fetch,
    websearch,
    backgroundTasks,
  };
}
