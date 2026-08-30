/**
 * `arcturn` — the Arcturn coding agent CLI, and the assembly logic behind it.
 *
 * The binary (`arcturn`) is `dist/main.js`; this module is the programmatic
 * surface, so a server, a test harness or an SDK user can reuse exactly the
 * same wiring the CLI runs on:
 *
 * ```ts
 * import { buildRuntime, runPrint } from "arcturn";
 *
 * const runtime = await buildRuntime({ cwd: process.cwd(), permissionMode: "acceptEdits" });
 * const { text, exitCode } = await runPrint({ runtime, prompt: "summarise src/index.ts" });
 * await runtime.dispose();
 * ```
 *
 * @packageDocumentation
 */

export {
  type CliArgs,
  type CliCommand,
  defaultArgs,
  helpText,
  type OutputFormat,
  type ParseArgsResult,
  parseArgs,
} from "./args.js";
export {
  type CommandContext,
  CommandRegistry,
  type CommandUi,
  createBuiltInCommands,
  createCommandRegistry,
  type DispatchResult,
  PERMISSION_MODE_HELP,
  type SelectOption,
  type SlashCommand,
} from "./commands.js";
export {
  type ArcturnConfig,
  type ArcturnThemeName,
  type ConfiguredProvider,
  type ConfiguredProviderModel,
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  isLocalEndpoint,
  type LoadConfigOptions,
  type LoadedConfig,
  loadConfig,
  mergeConfig,
  type ProviderProtocol,
  parseConfigFile,
  parsePermissionMode,
  permissionModeRank,
  permissionModes,
  persistPermissionRule,
  persistSetting,
} from "./config.js";
export { TranscriptFormatter, type TranscriptOptions } from "./display.js";
export {
  type ArcturnExtension,
  type ArcturnExtensionApi,
  discoverExtensionFiles,
  type ExtensionCommand,
  type ExtensionCommandHandler,
  type ExtensionEventName,
  ExtensionHost,
  type ExtensionLoadResult,
  type LoadExtensionsOptions,
  loadExtensions,
} from "./extensions.js";
export {
  contextPercent,
  formatCost,
  formatDuration,
  formatTodos,
  formatTokens,
  oneLine,
  TODO_MARKS,
  totalTokens,
} from "./format.js";
export {
  type ChoiceHandle,
  createChoice,
  type DialogHandle,
  Dynamic,
  EXIT_PLAN_SUBJECT,
  InteractiveApp,
  type InteractiveAppOptions,
  type PermissionChoice,
  PromptEditor,
  type PromptEditorOptions,
  permissionDialog,
  planDialog,
  renderTodoWidget,
  runInteractive,
  selectDialog,
  suggestRule,
  tailLines,
} from "./interactive/index.js";
export { main } from "./main.js";
export { PRODUCT_NAME, packageInfo, version } from "./meta.js";
export {
  type ArcturnPaths,
  cwdHash,
  type EnvMap,
  type ResolveArcturnPathsOptions,
  resolveArcturnPaths,
} from "./paths.js";
export { type PrintResult, type RunPrintOptions, runPrint } from "./print.js";
export {
  type ConfiguredProviderStatus,
  type ConfirmProvider,
  configuredProviderSpec,
  configuredProviderStatuses,
  declaredProvider,
  declaredProviderHint,
  enabledConfiguredProvider,
  PROVIDER_PERMISSION_TOOL,
  type ProviderConsentRequest,
  providerConsentRule,
  providerConsentSpecifier,
  type RegisterConfiguredProvidersOptions,
  type RegisterConfiguredProvidersResult,
  registerConfiguredProviders,
  resetConfiguredProviders,
  terminalProviderConfirm,
} from "./providers.js";
export {
  ArcturnRuntime,
  type ArcturnRuntimeInit,
  BUILT_IN_TOOL_NAMES,
  type BuildRuntimeOptions,
  buildRuntime,
  type ConnectMcpOptions,
  connectMcp,
  formatModelCatalog,
  formatProviderCatalog,
  ModelResolutionError,
  modelCatalogEntries,
  registerBundledCatalog,
  resolveModelSpec,
  type SessionMetrics,
  subagentSystemPrompt,
} from "./runtime.js";
export {
  buildSystemPrompt,
  type CollectContextOptions,
  collectSystemPromptContext,
  gitSummary,
  MAX_PROJECT_DOC_CHARS,
  PROJECT_DOC_FILENAME,
  readProjectDoc,
  repoRoot,
  type SystemPromptContext,
} from "./system-prompt.js";
