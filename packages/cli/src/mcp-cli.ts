/**
 * `arcturn mcp` — manage MCP server config files from the command line.
 *
 * `add`, `remove`, `get` and `list` edit and read the same two files the
 * runtime loads (`~/.arcturn/mcp.json` and `<cwd>/.arcturn/mcp.json`), so
 * nothing here introduces a second source of truth: the command is sugar over
 * the documented JSON. Files are rewritten pretty-printed; unknown top-level
 * keys in an existing file are preserved.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServerConfig } from "@arcturn/types";
import type { McpCliCommand, McpScope } from "./args.js";
import type { McpOAuthFlowOptions } from "./mcp-auth.js";
import { resolveArcturnPaths } from "./paths.js";

interface McpFile {
  /** Parsed file contents, or an empty skeleton when the file is absent. */
  readonly data: Record<string, unknown>;
  readonly servers: Record<string, McpServerConfig>;
  readonly path: string;
  readonly exists: boolean;
}

/** Options threaded through for tests. */
export interface RunMcpCommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /**
   * Runs the browser authorization for `mcp auth`. Defaults to
   * {@link runMcpOAuthFlow}; tests substitute it, since a live OAuth dance
   * cannot run headlessly.
   */
  readonly authFlow?: (options: McpOAuthFlowOptions) => Promise<void>;
}

/** `${ENV_VAR}` references the runtime expands before connecting. */
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expand `${ENV_VAR}` in a configured URL, the same way `loadMcpConfig` does.
 *
 * `mcp auth` has to reach the real server to discover its authorization
 * server, so it cannot leave the placeholder in place.
 */
function expandEnvVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const resolved = env[varName];
    if (resolved === undefined) {
      throw new Error(`environment variable "${varName}" (referenced as "${match}") is not set`);
    }
    return resolved;
  });
}

/**
 * Execute a parsed `arcturn mcp` command.
 *
 * @returns Process exit code: `0` on success, `2` on a usage or state error.
 */
export async function runMcpCommand(
  command: McpCliCommand,
  options: RunMcpCommandOptions = {},
): Promise<number> {
  const out = options.stdout ?? ((text: string) => process.stdout.write(text));
  const err = options.stderr ?? ((text: string) => process.stderr.write(text));
  const paths = resolveArcturnPaths({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const fileFor = (scope: McpScope) => (scope === "user" ? paths.userMcp : paths.projectMcp);

  try {
    if (command.action === "list") {
      const user = await readMcpFile(paths.userMcp);
      const project = await readMcpFile(paths.projectMcp);
      const names = [...new Set([...Object.keys(user.servers), ...Object.keys(project.servers)])];
      if (names.length === 0) {
        out(
          "No MCP servers configured.\n" +
            `Add one with: arcturn mcp add <name> -- <command> [args...]\n`,
        );
        return 0;
      }
      for (const name of names.sort()) {
        const inProject = name in project.servers;
        const server = inProject ? project.servers[name] : user.servers[name];
        if (server === undefined) continue;
        const scope =
          inProject && name in user.servers
            ? "project (overrides user)"
            : inProject
              ? "project"
              : "user";
        out(`${name}  ${describeServer(server)}  [${scope}]\n`);
      }
      out("\nLive connection status is shown by /mcp inside a session.\n");
      return 0;
    }

    const name = command.name;
    if (name === undefined) throw new Error(`mcp ${command.action} needs a server name`);

    if (command.action === "auth" || command.action === "logout") {
      const { FileMcpOAuthStorage } = await import("./mcp-auth.js");
      const storage = new FileMcpOAuthStorage(paths.auth, name);

      if (command.action === "logout") {
        const removed = await storage.clear();
        out(
          removed
            ? `Removed the stored OAuth credentials for "${name}" (${storage.path}).\n` +
                "The grant still exists on the server's side; revoke it there to kill it fully.\n"
            : `Nothing to do: no OAuth credentials were stored for "${name}".\n`,
        );
        return 0;
      }

      // `mcp auth` needs the server's URL, which may live in either file; the
      // project definition wins, exactly as it does when a session starts.
      const user = await readMcpFile(paths.userMcp);
      const project = await readMcpFile(paths.projectMcp);
      const server = project.servers[name] ?? user.servers[name];
      if (server === undefined) {
        err(`arcturn: no MCP server named "${name}" in ${paths.userMcp} or ${paths.projectMcp}\n`);
        return 2;
      }
      if (server.type !== "http") {
        err(`arcturn: "${name}" is a stdio server; OAuth applies to http servers only\n`);
        return 2;
      }
      if (server.auth !== "oauth") {
        err(
          `arcturn: "${name}" is not configured for OAuth. ` +
            `Add "auth": "oauth" to its entry in ${project.servers[name] ? project.path : user.path}\n`,
        );
        return 2;
      }

      const flow = options.authFlow ?? (await import("./mcp-auth.js")).runMcpOAuthFlow;
      await flow({
        serverName: name,
        serverUrl: expandEnvVars(server.url, options.env ?? process.env),
        storage,
        stdout: out,
      });
      return 0;
    }

    if (command.action === "get") {
      const user = await readMcpFile(paths.userMcp);
      const project = await readMcpFile(paths.projectMcp);
      const hits: Array<{ scope: McpScope; file: McpFile }> = [];
      if (name in user.servers) hits.push({ scope: "user", file: user });
      if (name in project.servers) hits.push({ scope: "project", file: project });
      if (hits.length === 0) {
        err(`arcturn: no MCP server named "${name}" in ${paths.userMcp} or ${paths.projectMcp}\n`);
        return 2;
      }
      for (const hit of hits) {
        out(`// ${hit.scope}: ${hit.file.path}\n`);
        out(`${JSON.stringify(hit.file.servers[name], null, 2)}\n`);
      }
      if (hits.length === 2) out("// The project definition wins when a session starts here.\n");
      return 0;
    }

    if (command.action === "remove") {
      const candidates: McpScope[] = command.scope ? [command.scope] : ["user", "project"];
      const holding: Array<{ scope: McpScope; file: McpFile }> = [];
      for (const scope of candidates) {
        const file = await readMcpFile(fileFor(scope));
        if (name in file.servers) holding.push({ scope, file });
      }
      if (holding.length === 0) {
        const where = command.scope ? `${command.scope} scope` : "either config file";
        err(`arcturn: no MCP server named "${name}" in ${where}\n`);
        return 2;
      }
      if (holding.length > 1) {
        err(
          `arcturn: "${name}" is defined in both user and project files; ` +
            `pass --scope user or --scope project\n`,
        );
        return 2;
      }
      const target = holding[0];
      if (target === undefined) return 2;
      delete target.file.servers[name];
      await writeMcpFile(target.file);
      out(`Removed "${name}" from ${target.file.path}\n`);
      return 0;
    }

    // add
    const server = command.server;
    if (server === undefined) throw new Error("mcp add needs a server definition");
    const scope: McpScope = command.scope ?? "project";
    const file = await readMcpFile(fileFor(scope));
    if (name in file.servers) {
      err(
        `arcturn: "${name}" already exists in ${file.path}. ` +
          `Remove it first (arcturn mcp remove ${name} --scope ${scope}) to replace it.\n`,
      );
      return 2;
    }
    file.servers[name] = server;
    await writeMcpFile(file);
    out(`Added "${name}" (${describeServer(server)}) to ${file.path}\n`);
    out(`Tools will appear as mcp__${name}__<tool>. Check with: arcturn mcp list\n`);
    return 0;
  } catch (error) {
    err(`arcturn: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function readMcpFile(path: string): Promise<McpFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { data: {}, servers: {}, path, exists: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); ` +
        "fix or remove it before editing with arcturn mcp",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const data = parsed as Record<string, unknown>;
  const servers = data.servers;
  if (
    servers !== undefined &&
    (typeof servers !== "object" || servers === null || Array.isArray(servers))
  ) {
    throw new Error(`${path} has a "servers" entry that is not an object`);
  }
  return {
    data,
    servers: (servers as Record<string, McpServerConfig> | undefined) ?? {},
    path,
    exists: true,
  };
}

async function writeMcpFile(file: McpFile): Promise<void> {
  const data = { ...file.data, servers: file.servers };
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function describeServer(server: McpServerConfig): string {
  if (server.type === "stdio") {
    return `stdio: ${[server.command, ...(server.args ?? [])].join(" ")}`;
  }
  return `http: ${server.url}${server.auth === "oauth" ? " (oauth)" : ""}`;
}
