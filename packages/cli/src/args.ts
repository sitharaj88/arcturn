/**
 * A small hand-rolled argument parser.
 *
 * No dependency, no magic: long flags may be written `--flag value` or
 * `--flag=value`, boolean flags accept a `--no-` prefix, `-p` is the only
 * short alias with an argument, and everything after `--` (or any non-flag
 * token) is treated as prompt text.
 *
 * *Positional commands* exist alongside the flags: when the first word before
 * `--` is `completions`, `replay`, `audit`, `blame`, `bisect`, `serve`, `acp`,
 * `doctor` or `attach`, the whole invocation is that command rather than a
 * prompt.
 * Quoting still wins — `arcturn "replay explained"` is a single positional and
 * stays a prompt — and anything after `--` is always prompt text.
 *
 * Two families own their *entire* argument list instead, and are dispatched
 * before the flag loop below ever runs: `mcp`, whose `add` takes a launch
 * command verbatim after `--`, and the registry verbs (`add`, `remove`,
 * `packages`, `update`, `inspect`, `new`). The registry verbs are here for the
 * same reason `mcp` is: `--name`, `--skills-only`, `--yes`, `--json` and
 * `--user` are flags of *those* commands, not of a session, and the global loop
 * would reject every one of them as an unknown option. Keeping the argument
 * list whole also means `registry.ts` and `scaffold.ts` each hold the single
 * parser for their own flags — the same one their `/add`-family slash commands
 * use — so `arcturn add` and `/add` cannot drift apart.
 */

import type { McpServerConfig, PermissionMode } from "@arcturn/types";
import { parsePermissionMode, permissionModes } from "./config.js";
import { PRODUCT_NAME } from "./meta.js";

/** Output encoding for `--print` runs. */
export type OutputFormat = "text" | "json";

/** A parsed `completions <shell>` command. */
export interface CompletionsCommand {
  /** Command family. */
  readonly kind: "completions";
  /** Shell the script is for; validated by the runner, not the parser. */
  readonly shell: string;
}

/** A parsed `replay <sessionId|path>` command. */
export interface ReplayCommand {
  /** Command family. */
  readonly kind: "replay";
  /** Session id, or a path to a session JSONL file. */
  readonly target: string;
}

/** Any positional command the CLI recognises. */
/** A parsed `audit <sessionId>` command. */
export interface AuditCommand {
  /** Command family. */
  readonly kind: "audit";
  /** Session id whose trail to render; omitted means the newest. */
  readonly sessionId?: string;
}

/** Any positional command the CLI recognises. */
/** A parsed `attach <url>` command. */
export interface AttachCommand {
  /** Command family. */
  readonly kind: "attach";
  /** WebSocket URL of a `arcturn serve` instance. */
  readonly url: string;
}

/** A parsed `bisect <session>` command. */
export interface BisectCommand {
  /** Command family. */
  readonly kind: "bisect";
  /** Session whose prompts are replayed against the cassette. */
  readonly target: string;
}

/** A parsed `blame <file>` command. */
export interface BlameCommand {
  /** Command family. */
  readonly kind: "blame";
  /** File to explain. */
  readonly file: string;
  /** Session to read provenance from; newest when omitted. */
  readonly sessionId?: string;
}

/** A parsed `acp` command. */
export interface AcpCommand {
  /** Command family. */
  readonly kind: "acp";
}

/** A parsed `doctor [preset]` command. */
export interface DoctorCommand {
  /** Command family. */
  readonly kind: "doctor";
  /** Probe only this preset; every configured endpoint when omitted. */
  readonly preset?: string;
}

/** A parsed `serve` command. */
export interface ServeCommand {
  /** Command family. */
  readonly kind: "serve";
}

/**
 * The package-registry and authoring verbs `arcturn` exposes at the top level.
 *
 * `packages`, not `list`: a bare `arcturn list` would read as "list what?", and
 * the noun is what the RFC 0002 hub calls these things too.
 */
export type RegistryVerb = "add" | "remove" | "packages" | "update" | "inspect" | "new";

/** Every registry verb, in help-text order. */
export const REGISTRY_VERBS: readonly RegistryVerb[] = [
  "add",
  "inspect",
  "packages",
  "update",
  "remove",
  "new",
];

/**
 * A parsed registry command. The verb owns everything after it, unparsed —
 * `registry.ts` and `scaffold.ts` hold the parsers for their own flags.
 */
export interface RegistryCliCommand {
  /** Command family. */
  readonly kind: "registry";
  /** Which verb was requested. */
  readonly verb: RegistryVerb;
  /** Every argument after the verb, verbatim. */
  readonly argv: readonly string[];
}

/** Config file an `mcp add` / `mcp remove` targets. */
export type McpScope = "user" | "project";

/** Sub-commands of `arcturn mcp`, in help-text order. */
export type McpAction = "add" | "remove" | "list" | "get" | "auth" | "logout";

/** A parsed `mcp <action>` command. */
export interface McpCliCommand {
  /** Command family. */
  readonly kind: "mcp";
  /** Which sub-command was requested. */
  readonly action: McpAction;
  /** Server name; present for `add`, `remove` and `get`. */
  readonly name?: string;
  /** Target file. `add` defaults to project; `remove` defaults to wherever the name is. */
  readonly scope?: McpScope;
  /** Server definition to write; present for `add`. */
  readonly server?: McpServerConfig;
}

/** Any positional command the CLI recognises. */
export type CliCommand =
  | CompletionsCommand
  | ReplayCommand
  | AuditCommand
  | ServeCommand
  | AcpCommand
  | AttachCommand
  | BlameCommand
  | BisectCommand
  | DoctorCommand
  | McpCliCommand
  | RegistryCliCommand;

/** Environment facts that change how arguments validate. */
export interface ParseArgsOptions {
  /**
   * Whether stdin is an interactive terminal. `false` (piped) lets `--print`
   * take its prompt from stdin. Defaults to `process.stdin.isTTY`.
   */
  readonly stdinIsTty?: boolean;
}

/** Everything the CLI accepts on the command line. */
export interface CliArgs {
  /** Positional words joined with spaces; the initial prompt. */
  prompt: string;
  /** `-p` / `--print`: run headlessly and exit. */
  print: boolean;
  /** `--output-format`: `text` prints the final message, `json` emits NDJSON events. */
  outputFormat: OutputFormat;
  /** `--max-cost`: abort the run past this many USD. */
  maxCostUsd?: number;
  /** `--dry-run`: send file mutations to a shadow tree for review. */
  dryRun?: boolean;
  /** `--trace`: write one JSON line per finished telemetry span to stderr. */
  trace?: boolean;
  /** `--host`: interface for `arcturn serve`. */
  host?: string;
  /** `--port`: port for `arcturn serve`. */
  port?: number;
  /** `--token`: shared secret for `arcturn serve`. */
  token?: string;
  /** `--web`: also serve the browser client alongside `arcturn serve`. */
  web?: boolean;
  /** `--web-port`: port for the browser client (0 or omitted picks one). */
  webPort?: number;
  /** `--web-origin`: extra browser origins allowed to open a socket, repeatable. */
  webOrigins?: string[];
  /** `--cassette`: VCR recording used by `arcturn bisect`. */
  cassette?: string;
  /** `--record`: write this run's model and tool calls to a cassette file. */
  record?: string;
  /** `--model`: catalog model id. */
  model?: string;
  /** `--continue`: resume the newest session for this directory. */
  continueSession: boolean;
  /** `--resume <id>`: resume a specific session. */
  resume?: string;
  /** `--permission-mode`. */
  permissionMode?: PermissionMode;
  /** `--cwd`: working directory for tools, config and sessions. */
  cwd?: string;
  /** `--no-mcp` disables MCP servers entirely. */
  mcp: boolean;
  /** `--max-turns`: safety valve on loop iterations. */
  maxTurns?: number;
  /** `--help`. */
  help: boolean;
  /** `--version`. */
  version: boolean;
  /** `--list-models`. */
  listModels: boolean;
  /** `--list-providers`. */
  listProviders: boolean;
  /**
   * `--no-providers` registers nothing from a config `providers` block; the
   * entries still parse and still list, marked "declared (not enabled)".
   */
  configProviders: boolean;
  /**
   * `--trust-providers` enables a PROJECT-declared provider endpoint without
   * asking — for CI that already trusts the repository it checked out. Never
   * persisted: a per-invocation trust decision must not become a standing
   * grant in the user's config.
   */
  trustProviders: boolean;
  /** A positional command (`arcturn replay …`), when one was given instead of a prompt. */
  command?: CliCommand;
}

/** Successful or failed parse. */
export type ParseArgsResult = { ok: true; args: CliArgs } | { ok: false; error: string };

/** Defaults applied before any flag is seen. */
export function defaultArgs(): CliArgs {
  return {
    prompt: "",
    print: false,
    outputFormat: "text",
    continueSession: false,
    mcp: true,
    help: false,
    version: false,
    listModels: false,
    listProviders: false,
    configProviders: true,
    trustProviders: false,
  };
}

/** First positional that switches into completions-command parsing. */
export const COMPLETIONS_COMMAND_NAME = "completions";

/** First positional that switches into replay-command parsing. */
export const REPLAY_COMMAND_NAME = "replay";

/** First positional that switches into audit-command parsing. */
export const AUDIT_COMMAND_NAME = "audit";

/** First positional that switches into serve-command parsing. */
export const SERVE_COMMAND_NAME = "serve";

/** First positional that switches into ACP (editor bridge) mode. */
export const ACP_COMMAND_NAME = "acp";

/** First positional that switches into blame-command parsing. */
export const BLAME_COMMAND_NAME = "blame";

/** First positional that switches into bisect-command parsing. */
export const BISECT_COMMAND_NAME = "bisect";

/** First positional that switches into attach-command parsing. */
export const ATTACH_COMMAND_NAME = "attach";

/** First positional that switches into doctor-command parsing. */
export const DOCTOR_COMMAND_NAME = "doctor";

/** Narrow an arbitrary word to a {@link RegistryVerb}. */
export function isRegistryVerb(value: string): value is RegistryVerb {
  return (REGISTRY_VERBS as readonly string[]).includes(value);
}

const MCP_ACTIONS: readonly McpAction[] = ["add", "remove", "list", "get", "auth", "logout"];

/** Server names must survive the `mcp__<server>__<tool>` bridge encoding. */
const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ParsedMcpCommand {
  readonly command: McpCliCommand;
  readonly cwd?: string;
}

/**
 * Parse everything after the leading `mcp` word.
 *
 * Unlike the other positional commands, `mcp` owns its whole argument list:
 * it has flags of its own (`--scope`, `--transport`, `--env`, `--header`),
 * and for `add` everything after `--` is the server's launch command
 * verbatim, so none of it may fall through to the global flag loop.
 */
function parseMcpCommand(
  argv: readonly string[],
): { ok: true; parsed: ParsedMcpCommand } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const positional: string[] = [];
  const commandParts: string[] = [];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let scope: McpScope | undefined;
  let transport: "stdio" | "http" | undefined;
  let auth: "oauth" | undefined;
  let cwd: string | undefined;
  let sawEnv = false;
  let sawHeader = false;
  let afterDashes = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (afterDashes) {
      commandParts.push(token);
      continue;
    }
    if (token === "--") {
      afterDashes = true;
      continue;
    }
    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined) return fail(`${flag} needs a value`);
    switch (flag) {
      case "--scope":
        if (value !== "user" && value !== "project") {
          return fail('--scope must be "user" or "project"');
        }
        scope = value;
        break;
      case "--transport":
        if (value !== "stdio" && value !== "http") {
          return fail('--transport must be "stdio" or "http"');
        }
        transport = value;
        break;
      case "--auth":
        if (value !== "oauth") return fail('--auth must be "oauth"');
        auth = value;
        break;
      case "--env": {
        const sep = value.indexOf("=");
        const key = sep === -1 ? value : value.slice(0, sep);
        if (sep === -1 || !ENV_KEY_PATTERN.test(key)) {
          return fail(`--env expects KEY=VALUE, got "${value}"`);
        }
        env[key] = value.slice(sep + 1);
        sawEnv = true;
        break;
      }
      case "--header": {
        const sep = value.indexOf(":");
        const key = sep === -1 ? "" : value.slice(0, sep).trim();
        if (key.length === 0) {
          return fail(`--header expects "Name: value", got "${value}"`);
        }
        headers[key] = value.slice(sep + 1).trim();
        sawHeader = true;
        break;
      }
      case "--cwd":
        cwd = value;
        break;
      default:
        return fail(
          `Unknown mcp option: ${flag}. Flags for the server itself go after "--" ` +
            `(arcturn mcp add <name> -- <command> [args...]).`,
        );
    }
  }

  const action = positional[0];
  if (action === undefined) {
    return fail(`mcp needs a subcommand: ${MCP_ACTIONS.join(", ")}`);
  }
  if (!MCP_ACTIONS.includes(action as McpAction)) {
    return fail(`Unknown mcp subcommand "${action}". Expected one of: ${MCP_ACTIONS.join(", ")}`);
  }

  const done = (command: McpCliCommand) => ({
    ok: true as const,
    parsed: { command, ...(cwd === undefined ? {} : { cwd }) },
  });

  if (action === "list") {
    if (
      positional.length > 1 ||
      commandParts.length > 0 ||
      scope ||
      transport ||
      auth ||
      sawEnv ||
      sawHeader
    ) {
      return fail("mcp list takes no arguments");
    }
    return done({ kind: "mcp", action: "list" });
  }

  const name = positional[1];
  if (name === undefined) return fail(`mcp ${action} needs a server name`);
  if (!MCP_NAME_PATTERN.test(name)) {
    return fail(`Server name "${name}" must contain only letters, digits, "-" and "_".`);
  }

  if (action === "auth" || action === "logout") {
    // Credentials live in one place (`~/.arcturn/auth`), so there is nothing
    // for --scope to choose between; the server itself may be defined in either
    // config file and is looked up in both.
    if (
      positional.length > 2 ||
      commandParts.length > 0 ||
      transport ||
      auth ||
      sawEnv ||
      sawHeader
    ) {
      return fail(`mcp ${action} takes one server name`);
    }
    if (scope) return fail(`mcp ${action} takes no --scope; credentials are stored per user`);
    return done({ kind: "mcp", action, name });
  }

  if (action === "get" || action === "remove") {
    if (
      positional.length > 2 ||
      commandParts.length > 0 ||
      transport ||
      auth ||
      sawEnv ||
      sawHeader
    ) {
      return fail(
        `mcp ${action} takes one server name${action === "remove" ? " (and optionally --scope)" : ""}`,
      );
    }
    if (action === "get" && scope)
      return fail("mcp get takes no --scope; it reports where the server is defined");
    return done({ kind: "mcp", action, name, ...(scope === undefined ? {} : { scope }) });
  }

  // add
  if (transport === "http") {
    const url = positional[2];
    if (url === undefined || positional.length > 3 || commandParts.length > 0) {
      return fail(
        "mcp add --transport http needs exactly one URL (arcturn mcp add --transport http <name> <url>)",
      );
    }
    if (sawEnv) return fail("http servers take --header, not --env");
    const server: McpServerConfig = {
      type: "http",
      url,
      ...(sawHeader ? { headers } : {}),
      ...(auth === undefined ? {} : { auth }),
    };
    return done({
      kind: "mcp",
      action: "add",
      name,
      server,
      ...(scope === undefined ? {} : { scope }),
    });
  }

  const launch = [...positional.slice(2), ...commandParts];
  const command = launch[0];
  if (command === undefined) {
    return fail(
      "mcp add needs the server's launch command (arcturn mcp add <name> -- <command> [args...])",
    );
  }
  if (sawHeader) return fail("stdio servers take --env, not --header");
  if (auth) return fail("--auth applies to http servers only (--transport http)");
  const server: McpServerConfig = {
    type: "stdio",
    command,
    ...(launch.length > 1 ? { args: launch.slice(1) } : {}),
    ...(sawEnv ? { env } : {}),
  };
  return done({
    kind: "mcp",
    action: "add",
    name,
    server,
    ...(scope === undefined ? {} : { scope }),
  });
}

const VALUE_FLAGS = new Set([
  "--model",
  "--resume",
  "--permission-mode",
  "--cwd",
  "--max-turns",
  "--max-cost",
  "--host",
  "--port",
  "--token",
  "--cassette",
  "--record",
  "--output-format",
  "--web-port",
  "--web-origin",
]);

/**
 * Parse `process.argv.slice(2)`.
 *
 * @param argv - Raw argument list, without the node binary and script path.
 */
export function parseArgs(
  argv: readonly string[],
  options: ParseArgsOptions = {},
): ParseArgsResult {
  const args = defaultArgs();

  // `mcp` owns its whole argument list (its own flags, plus a verbatim launch
  // command after `--`), so it is dispatched before the global flag loop.
  if (argv[0] === "mcp") {
    const rest = argv.slice(1);
    if (rest.includes("--help") || rest.includes("-h")) {
      args.help = true;
      return { ok: true, args };
    }
    const parsed = parseMcpCommand(rest);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    args.command = parsed.parsed.command;
    if (parsed.parsed.cwd !== undefined) args.cwd = parsed.parsed.cwd;
    args.prompt = "";
    return { ok: true, args };
  }

  // The registry verbs own their argument lists too — see the module doc. The
  // collision with a prompt that opens on one of these words is the same one
  // `serve` and `blame` already accept, and it has the same escape:
  // quoting makes it one positional, so `arcturn "add logging to server.ts"` is
  // still a prompt.
  const verb = argv[0];
  if (verb !== undefined && isRegistryVerb(verb)) {
    const rest = argv.slice(1);
    if (rest.includes("--help") || rest.includes("-h")) {
      args.help = true;
      return { ok: true, args };
    }
    args.command = { kind: "registry", verb, argv: rest };
    args.prompt = "";
    return { ok: true, args };
  }

  const positional: string[] = [];
  // Tracks how many positionals were seen before `--`; only those can form a
  // command, so `arcturn -- replay abc` stays prompt text.
  let commandCandidates = 0;
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (onlyPositional || token === "-" || !token.startsWith("-")) {
      positional.push(token);
      if (!onlyPositional) commandCandidates++;
      continue;
    }
    if (token === "--") {
      onlyPositional = true;
      continue;
    }

    // Normalise `--flag=value` and the short aliases into (name, inline value).
    let name = token;
    let inline: string | undefined;
    const equals = token.indexOf("=");
    if (token.startsWith("--") && equals !== -1) {
      name = token.slice(0, equals);
      inline = token.slice(equals + 1);
    }
    if (name === "-p") name = "--print";
    if (name === "-h") name = "--help";
    if (name === "-v") name = "--version";
    if (name === "-c") name = "--continue";
    if (name === "-r") name = "--resume";
    if (name === "-m") name = "--model";

    const needsValue = VALUE_FLAGS.has(name);
    let value = inline;
    if (needsValue && value === undefined) {
      const next = argv[i + 1];
      if (next === undefined) return { ok: false, error: `${name} requires a value` };
      value = next;
      i++;
    }
    if (!needsValue && inline !== undefined && !name.startsWith("--no-")) {
      // Allow `--print=false` style negation for the boolean flags.
      if (inline !== "true" && inline !== "false") {
        return { ok: false, error: `${name} does not take a value` };
      }
    }
    const boolValue = inline === undefined ? true : inline === "true";

    switch (name) {
      case "--print":
        args.print = boolValue;
        break;
      case "--help":
        args.help = boolValue;
        break;
      case "--version":
        args.version = boolValue;
        break;
      case "--list-models":
        args.listModels = boolValue;
        break;
      case "--list-providers":
        args.listProviders = boolValue;
        break;
      case "--continue":
        args.continueSession = boolValue;
        break;
      case "--mcp":
        args.mcp = boolValue;
        break;
      case "--no-mcp":
        args.mcp = false;
        break;
      case "--providers":
        args.configProviders = boolValue;
        break;
      case "--no-providers":
        args.configProviders = false;
        break;
      case "--trust-providers":
        args.trustProviders = boolValue;
        break;
      case "--model":
        args.model = value;
        break;
      case "--resume":
        args.resume = value;
        break;
      case "--cwd":
        args.cwd = value;
        break;
      case "--output-format": {
        if (value !== "text" && value !== "json") {
          return { ok: false, error: `--output-format must be "text" or "json"` };
        }
        args.outputFormat = value;
        break;
      }
      case "--permission-mode": {
        const mode = parsePermissionMode(value ?? "");
        if (!mode) {
          return {
            ok: false,
            error: `--permission-mode must be one of ${permissionModes().join(", ")}`,
          };
        }
        args.permissionMode = mode;
        break;
      }
      case "--host":
        args.host = value;
        break;
      case "--token":
        args.token = value;
        break;
      case "--cassette":
        args.cassette = value;
        break;
      case "--record":
        if (value === undefined || value === "") {
          return { ok: false, error: "--record needs a file path for the cassette" };
        }
        args.record = value;
        break;
      case "--port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          return { ok: false, error: "--port must be an integer between 0 and 65535" };
        }
        args.port = port;
        break;
      }
      case "--web":
        args.web = true;
        break;
      case "--web-port": {
        const webPort = Number(value);
        if (!Number.isInteger(webPort) || webPort < 0 || webPort > 65_535) {
          return { ok: false, error: "--web-port must be an integer between 0 and 65535" };
        }
        args.webPort = webPort;
        break;
      }
      case "--web-origin": {
        // Repeatable: a tunnel and a LAN address can both be allowed.
        if (value === undefined || value === "") {
          return { ok: false, error: "--web-origin needs an origin (e.g. https://host)" };
        }
        args.webOrigins = [...(args.webOrigins ?? []), value];
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--no-dry-run":
        args.dryRun = false;
        break;
      case "--trace":
        args.trace = true;
        break;
      case "--no-trace":
        args.trace = false;
        break;
      case "--max-cost": {
        const usd = Number(value);
        if (!Number.isFinite(usd) || usd <= 0) {
          return { ok: false, error: "--max-cost must be a positive number of dollars" };
        }
        args.maxCostUsd = usd;
        break;
      }
      case "--max-turns": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return { ok: false, error: "--max-turns must be a positive integer" };
        }
        args.maxTurns = parsed;
        break;
      }
      default:
        return { ok: false, error: `Unknown option: ${token}` };
    }
  }

  if (positional[0] === BISECT_COMMAND_NAME && commandCandidates > 0) {
    const target = positional[1];
    if (target === undefined || positional.length > 2) {
      return {
        ok: false,
        error: "bisect needs one session id (arcturn bisect <session> --cassette <file>)",
      };
    }
    args.command = { kind: "bisect", target };
    args.prompt = "";
    return { ok: true, args };
  }

  if (positional[0] === BLAME_COMMAND_NAME && commandCandidates > 0) {
    const file = positional[1];
    if (file === undefined || positional.length > 3) {
      return { ok: false, error: "blame needs a file (arcturn blame <file> [session])" };
    }
    const sessionId = positional[2];
    args.command = { kind: "blame", file, ...(sessionId === undefined ? {} : { sessionId }) };
    args.prompt = "";
    return { ok: true, args };
  }

  if (positional[0] === ATTACH_COMMAND_NAME && commandCandidates > 0) {
    const url = positional[1];
    if (url === undefined || positional.length > 2) {
      return {
        ok: false,
        error: "attach needs exactly one server URL (arcturn attach ws://host:port)",
      };
    }
    args.command = { kind: "attach", url };
    args.prompt = "";
    return { ok: true, args };
  }

  if (positional[0] === ACP_COMMAND_NAME && commandCandidates > 0) {
    if (positional.length > 1) {
      return { ok: false, error: "acp takes no positional arguments" };
    }
    args.command = { kind: "acp" };
    args.prompt = "";
    return { ok: true, args };
  }

  if (positional[0] === DOCTOR_COMMAND_NAME && commandCandidates > 0) {
    if (positional.length > 2) {
      return {
        ok: false,
        error:
          "doctor takes at most one preset name (arcturn doctor [preset]). " +
          'To send this as a prompt instead, quote it: arcturn "doctor ..."',
      };
    }
    const preset = positional[1];
    args.command = { kind: "doctor", ...(preset === undefined ? {} : { preset }) };
    args.prompt = "";
    return { ok: true, args };
  }

  if (positional[0] === SERVE_COMMAND_NAME && commandCandidates > 0) {
    if (positional.length > 1) {
      return {
        ok: false,
        error: "serve takes no positional arguments (use --host/--port/--token)",
      };
    }
    args.command = { kind: "serve" };
    args.prompt = "";
    return { ok: true, args };
  }

  if (positional[0] === AUDIT_COMMAND_NAME && commandCandidates > 0) {
    if (positional.length > 2) {
      return { ok: false, error: "audit takes at most one session id" };
    }
    const sessionId = positional[1];
    args.command = { kind: "audit", ...(sessionId === undefined ? {} : { sessionId }) };
    args.prompt = "";
    return { ok: true, args };
  }

  if (positional[0] === REPLAY_COMMAND_NAME && commandCandidates > 0) {
    const target = positional[1];
    if (target === undefined || positional.length > 2) {
      return { ok: false, error: "replay needs exactly one session id or file path" };
    }
    args.command = { kind: "replay", target };
    args.prompt = "";
    return { ok: true, args };
  }

  if (positional[0] === COMPLETIONS_COMMAND_NAME && commandCandidates > 0) {
    const shell = positional[1];
    if (shell === undefined || positional.length > 2 || commandCandidates < positional.length) {
      return { ok: false, error: "completions needs exactly one shell: bash, zsh or fish" };
    }
    args.command = { kind: "completions", shell };
    args.prompt = "";
    return { ok: true, args };
  }

  args.prompt = positional.join(" ");

  if (args.outputFormat === "json" && !args.print) {
    return { ok: false, error: "--output-format json requires --print" };
  }
  if (args.resume !== undefined && args.continueSession) {
    return { ok: false, error: "--resume and --continue are mutually exclusive" };
  }
  // An empty prompt is fine when stdin is piped: main reads it as the prompt
  // (`cat question.txt | arcturn -p`). Only an interactive stdin has nothing to
  // read, so only that case is an error here.
  // `process.stdin.isTTY` is `undefined` (not `false`) when stdin is piped,
  // so compare explicitly rather than defaulting the absent case to `true`.
  const stdinIsTty = options.stdinIsTty ?? process.stdin.isTTY === true;
  if (args.print && args.prompt === "" && stdinIsTty) {
    return {
      ok: false,
      error: '--print needs a prompt (arcturn -p "your question", or pipe one on stdin)',
    };
  }

  return { ok: true, args };
}

/** The `--help` text. */
export function helpText(): string {
  return `${PRODUCT_NAME} — the Arcturn coding agent

Usage
  ${PRODUCT_NAME} [options] [prompt...]         start the interactive TUI
  ${PRODUCT_NAME} -p "prompt" [options]         run once, print the answer, exit

Commands
  completions <shell>           Print a bash, zsh or fish completion script.
  replay <session|file>         Re-run a session's prompts, optionally on another model.
  audit [session]               Print the audit trail for a session.
  blame <file> [session]        Explain which turn and evidence wrote each line.
  bisect <session>              Find the turn where behaviour left a recording.
  serve                         Host sessions over WebSocket for remote attach.
  acp                           Speak the Agent Client Protocol on stdio (for editors).
  attach <url>                  Drive a session hosted by another arcturn serve.
  doctor [preset]               Probe each configured provider endpoint with its
                                real key and print a verdict per endpoint.
  mcp list                      Show configured MCP servers and where they're defined.
  mcp get <name>                Print one server's configuration.
  mcp add <name> -- <cmd> [...] Add a stdio MCP server; --scope user|project
                                (default project), --env KEY=VALUE repeatable.
  mcp add --transport http <name> <url>
                                Add an HTTP MCP server; --header "Name: value",
                                --auth oauth for OAuth 2.1 sign-in.
  mcp remove <name>             Remove a server (--scope if defined in both files).
  mcp auth <name>               Authorize an OAuth HTTP server in the browser.
  mcp logout <name>             Delete the stored OAuth credentials for a server.
  add <source>                  Install a package — skills, agent roles, workflows,
                                themes, MCP servers, extensions — from a git URL, an
                                "owner/repo[/subdir][@ref]" shorthand, or a local path.
                                --name <name>, --skills-only, --yes.
  inspect <source>              Stage a source and print what installing it WOULD add
                                (roles with their lanes, workflows with their budgets,
                                skills, MCP servers, executable code). Installs
                                nothing. --json for the machine-readable form.
  packages                      List installed packages and what each one provides.
  update [name]                 Re-fetch one package, or every unpinned one.
  remove <name>                 Uninstall a package and unlink everything it added.
  new <kind> <name>             Scaffold a skill, agent or workflow file into
                                <cwd>/.arcturn; --user writes to ~/.arcturn instead.

Options
  -p, --print                   Non-interactive: run to completion and print the
                                final assistant message to stdout.
      --output-format <fmt>     With --print: "text" (default) or "json" (NDJSON
                                of every agent event).
  -m, --model <id>              Model to use (see --list-models).
  -c, --continue                Resume the most recent session in this directory.
  -r, --resume <sessionId>      Resume a specific session.
      --permission-mode <mode>  ${permissionModes().join(" | ")}
      --cwd <dir>               Working directory for tools, config and sessions.
      --no-mcp                  Do not start any configured MCP servers.
      --max-turns <n>           Stop a run after n model turns.
      --max-cost <usd>          Abort the run once it has cost this much.
      --dry-run                 Send file edits to a shadow copy; review with /diff.
      --trace                   Write one JSON line per finished telemetry span to stderr.
      --host <iface>            With serve: interface to bind (default 127.0.0.1).
      --port <n>                With serve: port to bind (default 7717).
      --token <secret>          With serve: shared auth token (generated if omitted).
      --cassette <file>         With bisect: the VCR recording to compare against.
      --record <file>           Record this run's model and tool calls to a cassette,
                                so "arcturn bisect --cassette <file>" has one to read.
      --trust-providers         Enable provider endpoints declared by THIS PROJECT's
                                config without asking. For CI that already trusts the
                                repository; not saved to your config.
      --no-providers            Register nothing from a config "providers" block.
                                Entries still parse and still list.
      --list-models             Print the model catalog and exit.
      --list-providers          Print every provider and preset endpoint, and exit.
  -h, --help                    Show this help.
  -v, --version                 Print the version.

Exit codes
  0   Success. The run completed, or --help/--version/a listing printed.
      A tool the model asked for may still have been refused: a non-interactive
      run cannot ask, so it denies, tells the model, and says so on stderr.
  1   The run started but did not complete — a provider error, an interrupted
      run, or a ceiling (--max-turns, --max-cost) stopping it early.
  2   Nothing ran. A bad flag, an unknown model, a --cwd that is not there, a
      session that could not be read, a port already in use, or a command that
      needs a terminal and did not get one.

Configuration
  ~/.arcturn/config.json            User settings and permission rules.
  <cwd>/.arcturn/config.json        Project settings, merged over the user file.
  ~/.arcturn/mcp.json               MCP servers, merged with <cwd>/.arcturn/mcp.json.
  ~/.arcturn/skills/                Markdown skills, plus <cwd>/.arcturn/skills/.
  ~/.arcturn/agents/                Agent roles, plus <cwd>/.arcturn/agents/.
  ~/.arcturn/workflows/             Workflows, plus <cwd>/.arcturn/workflows/.
  ~/.arcturn/packages/              Packages installed by "arcturn add", linked into the above.
  ~/.arcturn/extensions/            Extension modules (.ts/.js), plus <cwd>/.arcturn/extensions/.
  ~/.arcturn/auth/                  OAuth credentials written by "arcturn mcp auth".
  ARCTURN_MODEL                     Overrides the configured model.
  ARCTURN_HOME                      Overrides ~/.arcturn.

In the TUI
  Enter submits, Shift+Enter inserts a newline, / opens the command palette,
  Esc aborts the running turn, Ctrl+C twice or Ctrl+D exits.
`;
}
