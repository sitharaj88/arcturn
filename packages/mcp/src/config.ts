/** Loads and merges MCP server config files, expanding `${ENV_VAR}` references. */

import { readFile } from "node:fs/promises";
import type { McpConfig, McpServerConfig } from "@arcturn/types";

/** Thrown when an MCP config file is malformed or references an unset environment variable. */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Loads and merges one or more MCP config files shaped `{ servers: { ... } }`.
 *
 * Files are read in the given order; when the same server name appears in more
 * than one file, the later file's definition fully replaces the earlier one.
 * `${ENV_VAR}` references inside `env`, `headers`, and `url` values are
 * expanded from `process.env`, after the merge.
 *
 * @throws {McpConfigError} if a file is not valid JSON, does not match the
 *   expected shape, or references an environment variable that is not set.
 */
export async function loadMcpConfig(paths: string[]): Promise<McpConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const path of paths) {
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new McpConfigError(`Failed to parse MCP config "${path}": ${errorMessage(error)}`);
    }
    const parsedServers = validateConfigShape(parsed, path);
    for (const [name, config] of Object.entries(parsedServers)) {
      servers[name] = config;
    }
  }

  const expanded: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    expanded[name] = expandServerConfig(config, name);
  }
  return { servers: expanded };
}

function validateConfigShape(value: unknown, path: string): Record<string, McpServerConfig> {
  if (!isPlainObject(value)) {
    throw new McpConfigError(`Invalid MCP config "${path}": expected a JSON object.`);
  }
  const servers = value.servers;
  if (!isPlainObject(servers)) {
    throw new McpConfigError(`Invalid MCP config "${path}": missing a "servers" object.`);
  }
  const result: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    result[name] = validateServerConfig(raw, path, name);
  }
  return result;
}

function validateServerConfig(value: unknown, path: string, name: string): McpServerConfig {
  const where = `MCP server "${name}" in "${path}"`;
  if (!isPlainObject(value)) {
    throw new McpConfigError(`Invalid ${where}: expected an object.`);
  }

  if (value.type === "stdio") {
    if (typeof value.command !== "string" || value.command.length === 0) {
      throw new McpConfigError(`Invalid ${where}: "command" must be a non-empty string.`);
    }
    if (value.args !== undefined && !isStringArray(value.args)) {
      throw new McpConfigError(`Invalid ${where}: "args" must be an array of strings.`);
    }
    if (value.env !== undefined && !isStringRecord(value.env)) {
      throw new McpConfigError(`Invalid ${where}: "env" must be an object of string values.`);
    }
    if (value.cwd !== undefined && typeof value.cwd !== "string") {
      throw new McpConfigError(`Invalid ${where}: "cwd" must be a string.`);
    }
    return {
      type: "stdio",
      command: value.command,
      args: value.args as string[] | undefined,
      env: value.env as Record<string, string> | undefined,
      cwd: value.cwd as string | undefined,
    };
  }

  if (value.type === "http") {
    if (typeof value.url !== "string" || value.url.length === 0) {
      throw new McpConfigError(`Invalid ${where}: "url" must be a non-empty string.`);
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      throw new McpConfigError(`Invalid ${where}: "headers" must be an object of string values.`);
    }
    if (value.auth !== undefined && value.auth !== "oauth") {
      throw new McpConfigError(`Invalid ${where}: "auth" must be "oauth".`);
    }
    return {
      type: "http",
      url: value.url,
      headers: value.headers as Record<string, string> | undefined,
      auth: value.auth as "oauth" | undefined,
    };
  }

  throw new McpConfigError(`Invalid ${where}: "type" must be "stdio" or "http".`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function expandServerConfig(config: McpServerConfig, name: string): McpServerConfig {
  if (config.type === "stdio") {
    return {
      ...config,
      env: config.env ? mapRecord(config.env, name) : undefined,
    };
  }
  return {
    ...config,
    url: expandEnvVars(config.url, name),
    headers: config.headers ? mapRecord(config.headers, name) : undefined,
  };
}

function mapRecord(record: Record<string, string>, serverName: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = expandEnvVars(value, serverName);
  }
  return result;
}

function expandEnvVars(value: string, serverName: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const resolved = process.env[varName];
    if (resolved === undefined) {
      throw new McpConfigError(
        `Invalid MCP server "${serverName}": environment variable "${varName}" ` +
          `(referenced as "${match}") is not set.`,
      );
    }
    return resolved;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
