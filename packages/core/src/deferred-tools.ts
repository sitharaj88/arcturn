/**
 * Progressive tool disclosure: keep most tool schemas out of the request.
 *
 * Every tool schema sent to the model costs context on *every* turn, whether
 * or not the model needs it. A {@link DeferredToolset} splits a tool list in
 * two: a small always-active core (read/edit/bash/...) whose schemas are sent
 * as usual, and a deferred remainder the model only knows by one line of
 * `name — description`. That index lives inside the description of a built-in
 * `tool_search` tool, so nothing outside this module has to change — no
 * system-prompt edit, no new event type.
 *
 * When the model needs a deferred tool it calls `tool_search`; the matches are
 * activated on this instance and their full schemas appear in every subsequent
 * request. Activation is per-instance (i.e. per run/session) and survives
 * process restarts through {@link DeferredToolset.snapshot} /
 * {@link DeferredToolset.restore}.
 *
 * The loop needs no special support: it already calls `LoopRuntime.getTools()`
 * once per turn, so pointing that at {@link DeferredToolset.activeTools} is the
 * whole integration.
 */

import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { text } from "./util/content.js";

/**
 * Tools that stay active by default: the ones an agent reaches for on almost
 * every task, where a search round-trip would cost more than the schema does.
 */
export const DEFAULT_ALWAYS_ACTIVE_TOOLS: readonly string[] = [
  "read",
  "write",
  "edit",
  "multi_edit",
  "bash",
  "glob",
  "grep",
  "ls",
  "todo",
  "plan",
];

/** Default name of the built-in search tool. */
export const DEFAULT_SEARCH_TOOL_NAME = "tool_search";

/** Options for {@link createDeferredToolset} / the {@link DeferredToolset} constructor. */
export interface DeferredToolsetOptions {
  /** Every tool the host would otherwise pass to the agent. */
  tools: readonly Tool[];
  /**
   * Names never deferred. Defaults to {@link DEFAULT_ALWAYS_ACTIVE_TOOLS};
   * names that match no tool are ignored.
   */
  alwaysActive?: readonly string[];
  /** Called with the newly activated names each time activation changes. */
  onActivate?: (names: string[]) => void;
  /** Name of the search tool exposed to the model. Defaults to `"tool_search"`. */
  searchToolName?: string;
  /** Maximum tools one query may activate. Defaults to `10`. */
  maxResults?: number;
}

/** Outcome of an activation request; never throws, unknown names are data. */
export interface ActivationReport {
  /** Names activated by this call, in deterministic order. */
  activated: string[];
  /** Names that were already active (no-ops). */
  alreadyActive: string[];
  /** Names that match no known tool. */
  unknown: string[];
}

/** Serializable activation state for session persistence. */
export interface DeferredToolsetSnapshot {
  /** Names activated beyond the always-active core, sorted. */
  activated: string[];
}

const MAX_INDEX_DESCRIPTION_CHARS = 160;

function firstLine(value: string): string {
  const line = value.split("\n", 1)[0] ?? "";
  return line.trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function stringArray(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return undefined;
    const trimmed = item.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** Score one deferred tool against a query; `0` means "no match". */
function scoreTool(tool: Tool, query: string, tokens: readonly string[]): number {
  const name = tool.definition.name.toLowerCase();
  const description = tool.definition.description.toLowerCase();
  const nameTokens = new Set(tokenize(name));
  let score = 0;

  if (query.length > 0) {
    if (name === query) score += 100;
    else if (name.includes(query)) score += 40;
    if (description.includes(query)) score += 15;
  }

  for (const token of tokens) {
    if (name === token) score += 25;
    else if (nameTokens.has(token)) score += 14;
    else if (name.includes(token)) score += 8;
    if (description.includes(token)) score += 4;
  }
  return score;
}

/**
 * A tool list split into an active core plus deferred tools the model can
 * activate on demand through the built-in `tool_search` tool.
 */
export class DeferredToolset {
  readonly #tools: Tool[] = [];
  readonly #byName = new Map<string, Tool>();
  readonly #alwaysActive = new Set<string>();
  readonly #activated = new Set<string>();
  readonly #onActivate: ((names: string[]) => void) | undefined;
  readonly #searchToolName: string;
  readonly #maxResults: number;
  #searchTool: Tool | undefined;
  #cachedDefinition: Tool["definition"] | undefined;
  #version = 0;

  /**
   * @param options - Tool list plus optional always-active names and hooks.
   */
  constructor(options: DeferredToolsetOptions) {
    this.#searchToolName = options.searchToolName ?? DEFAULT_SEARCH_TOOL_NAME;
    this.#maxResults = Math.max(1, Math.trunc(options.maxResults ?? 10));
    this.#onActivate = options.onActivate;

    for (const tool of options.tools) {
      const name = tool.definition.name;
      // Duplicate names would be ambiguous to the model; first registration wins.
      if (this.#byName.has(name) || name === this.#searchToolName) continue;
      this.#byName.set(name, tool);
      this.#tools.push(tool);
    }

    const always = options.alwaysActive ?? DEFAULT_ALWAYS_ACTIVE_TOOLS;
    for (const name of always) {
      if (this.#byName.has(name)) this.#alwaysActive.add(name);
    }
  }

  /** Name the search tool is exposed under. */
  get searchToolName(): string {
    return this.#searchToolName;
  }

  /** Every tool handed to the constructor, in registration order. */
  allTools(): Tool[] {
    return [...this.#tools];
  }

  /**
   * Tools whose full schema should go into the next request: the active core,
   * everything activated so far, and the `tool_search` tool itself.
   *
   * The search tool is always included — even once nothing is deferred — so a
   * search issued in the same turn as the last activation still resolves.
   */
  activeTools(): Tool[] {
    const active = this.#tools.filter((tool) => this.isActive(tool.definition.name));
    active.push(this.searchTool());
    return active;
  }

  /** Tools currently withheld from the request, in registration order. */
  deferredTools(): Tool[] {
    return this.#tools.filter((tool) => !this.isActive(tool.definition.name));
  }

  /**
   * Whether a tool's full schema is currently being sent.
   *
   * @param name - Tool name.
   */
  isActive(name: string): boolean {
    if (name === this.#searchToolName) return true;
    if (!this.#byName.has(name)) return false;
    return this.#alwaysActive.has(name) || this.#activated.has(name);
  }

  /**
   * Activate tools by exact name. Unknown names are reported, never thrown;
   * re-activating an active tool is a no-op.
   *
   * @param names - Exact tool names.
   */
  activate(names: readonly string[]): ActivationReport {
    const report: ActivationReport = { activated: [], alreadyActive: [], unknown: [] };
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!this.#byName.has(name) && name !== this.#searchToolName) {
        report.unknown.push(name);
      } else if (this.isActive(name)) {
        report.alreadyActive.push(name);
      } else {
        this.#activated.add(name);
        report.activated.push(name);
      }
    }
    if (report.activated.length > 0) {
      this.#version++;
      this.#onActivate?.([...report.activated]);
    }
    return report;
  }

  /**
   * One line per deferred tool (`name — description`), for injection into the
   * search tool's own description. Empty string when nothing is deferred.
   */
  renderDeferredIndex(): string {
    return this.deferredTools()
      .map(
        (tool) =>
          `${tool.definition.name} — ${truncate(
            firstLine(tool.definition.description),
            MAX_INDEX_DESCRIPTION_CHARS,
          )}`,
      )
      .join("\n");
  }

  /**
   * The built-in search tool. The same object is returned every time; its
   * `definition` is recomputed whenever activation changes, so the embedded
   * index stays current without the caller re-fetching it.
   */
  searchTool(): Tool {
    if (!this.#searchTool) {
      const self = this;
      let definitionVersion = -1;
      this.#searchTool = {
        get definition(): Tool["definition"] {
          if (!self.#cachedDefinition || definitionVersion !== self.#version) {
            self.#cachedDefinition = self.#buildDefinition();
            definitionVersion = self.#version;
          }
          return self.#cachedDefinition;
        },
        annotations: { title: "Tool search", readOnlyHint: true, openWorldHint: false },
        execute: (input, ctx) => this.#execute(input, ctx),
      };
    }
    return this.#searchTool;
  }

  /** Serializable activation state; safe to persist alongside a session. */
  snapshot(): DeferredToolsetSnapshot {
    return { activated: [...this.#activated].sort() };
  }

  /**
   * Restore a previously captured activation state. Names that no longer match
   * a known tool are dropped. `onActivate` is not fired: this is rehydration,
   * not a new decision by the model.
   *
   * @param snapshot - A value produced by {@link DeferredToolset.snapshot}.
   */
  restore(snapshot: DeferredToolsetSnapshot): void {
    this.#activated.clear();
    for (const name of snapshot.activated) {
      if (this.#byName.has(name) && !this.#alwaysActive.has(name)) this.#activated.add(name);
    }
    this.#version++;
  }

  #buildDefinition(): Tool["definition"] {
    const index = this.renderDeferredIndex();
    const preamble =
      "Load the full parameter schemas of tools that are currently deferred. " +
      "Deferred tools are real and callable, but their schemas are withheld to " +
      "save context, so you must activate one here before you can call it. " +
      "Pass `query` describing what you need, and/or `select` with exact tool " +
      "names. Activated tools stay available for the rest of the session.";
    const body =
      index.length > 0
        ? `\n\nDeferred tools (name — description):\n${index}`
        : "\n\nNo tools are deferred right now: every tool's schema is already available.";
    return {
      name: this.#searchToolName,
      description: `${preamble}${body}`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What you need a tool for, in a few words. Matched against deferred tool names and descriptions.",
          },
          select: {
            type: "array",
            description: "Exact deferred tool names to activate, taken from the list above.",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    };
  }

  #search(query: string): Tool[] {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return [];
    const tokens = tokenize(normalized);
    const scored: Array<{ tool: Tool; score: number }> = [];
    for (const tool of this.deferredTools()) {
      const score = scoreTool(tool, normalized, tokens);
      if (score > 0) scored.push({ tool, score });
    }
    scored.sort((a, b) =>
      b.score === a.score
        ? a.tool.definition.name.localeCompare(b.tool.definition.name)
        : b.score - a.score,
    );
    return scored.slice(0, this.#maxResults).map((entry) => entry.tool);
  }

  async #execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    if (ctx.signal.aborted) {
      return { content: [text("Tool search aborted.")], isError: true };
    }

    const rawQuery = input.query;
    if (rawQuery !== undefined && rawQuery !== null && typeof rawQuery !== "string") {
      return { content: [text("query must be a string")], isError: true };
    }
    const select = stringArray(input.select);
    if (!select) {
      return { content: [text("select must be an array of strings")], isError: true };
    }
    const query = typeof rawQuery === "string" ? rawQuery : "";

    if (query.trim().length === 0 && select.length === 0) {
      return {
        content: [text(`Provide a query or select.\n\n${this.#indexOrNone()}`)],
        isError: true,
        details: { activated: [], alreadyActive: [], unknown: [], deferred: this.#deferredNames() },
      };
    }

    const matched = this.#search(query).map((tool) => tool.definition.name);
    const report = this.activate([...select, ...matched]);

    if (report.activated.length === 0 && report.alreadyActive.length === 0) {
      const detail =
        report.unknown.length > 0 ? ` Unknown names: ${report.unknown.join(", ")}.` : "";
      return {
        content: [
          text(
            `No deferred tool matched${query.trim().length > 0 ? ` "${query.trim()}"` : ""}.${detail}\n\n${this.#indexOrNone()}`,
          ),
        ],
        isError: true,
        details: { ...report, deferred: this.#deferredNames() },
      };
    }

    return {
      content: [text(this.#renderActivation(report))],
      details: { ...report, deferred: this.#deferredNames() },
    };
  }

  #renderActivation(report: ActivationReport): string {
    const parts: string[] = [];
    if (report.activated.length > 0) {
      parts.push(
        `Activated ${report.activated.length} tool${report.activated.length === 1 ? "" : "s"}. ` +
          "Their schemas are available from your next turn; call them directly.",
      );
      for (const name of report.activated) {
        const tool = this.#byName.get(name);
        if (!tool) continue;
        parts.push(
          `## ${name}\n${tool.definition.description}\nParameters:\n${JSON.stringify(
            tool.definition.parameters,
            null,
            2,
          )}`,
        );
      }
    }
    if (report.alreadyActive.length > 0) {
      parts.push(`Already active (call them directly): ${report.alreadyActive.join(", ")}.`);
    }
    if (report.unknown.length > 0) {
      parts.push(`No such tool, ignored: ${report.unknown.join(", ")}.`);
    }
    const remaining = this.#deferredNames();
    parts.push(
      remaining.length > 0
        ? `Still deferred: ${remaining.join(", ")}.`
        : "No tools remain deferred.",
    );
    return parts.join("\n\n");
  }

  #deferredNames(): string[] {
    return this.deferredTools().map((tool) => tool.definition.name);
  }

  #indexOrNone(): string {
    const index = this.renderDeferredIndex();
    return index.length > 0 ? `Deferred tools:\n${index}` : "No tools are deferred.";
  }
}

/**
 * Create a {@link DeferredToolset}.
 *
 * @param options - Tool list plus optional always-active names and hooks.
 */
export function createDeferredToolset(options: DeferredToolsetOptions): DeferredToolset {
  return new DeferredToolset(options);
}
