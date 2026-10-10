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
 * once per turn, so pointing that at {@link DeferredToolset.toolsFor} is the
 * whole integration.
 *
 * ## Two paths, one record
 *
 * On first-party Anthropic with Claude 4.5 or later, {@link DeferredToolset.toolsFor}
 * takes the **native** path: every tool goes out from the first request, the
 * deferred ones flagged `deferLoading` (`defer_loading: true` on the wire),
 * beside the server's own BM25 search tool, and arcturn's `tool_search` is
 * not sent at all. Activation then happens server-side and never changes the
 * request's tool set — which is what keeps the prompt cache, and every
 * replayed thinking block, valid. {@link DeferredToolset.observe} reads the
 * server's `tool_search_tool_result` blocks back into this instance, so the
 * activation record stays true for a snapshot, a resume, or a later switch to
 * a model on the other path.
 *
 * Everywhere else the original mechanism runs: activation grows the next
 * request's tool set and rewrites the search tool's index. That resets the
 * prompt cache from the top of the conversation; the agent says so the first
 * time it happens on an adaptive Claude model, and stops replaying the
 * thinking the change invalidated.
 */

import type {
  AssistantMessage,
  Message,
  ModelSpec,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@arcturn/types";
import { hasNativeToolSearch } from "./model-traits.js";
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
  /**
   * The subset of `activated` found only by the provider's native tool search,
   * sorted. They stay `deferLoading` on the native path, so the tool set it
   * sends is the same before and after the restore. Absent on older snapshots,
   * which read as "every activation came from arcturn's `tool_search`".
   */
  native?: string[];
}

/**
 * Tool names the provider's native search surfaced in an assistant message —
 * the `tool_reference`s inside its `tool_search_tool_result` blocks.
 *
 * @param message - An assistant message.
 */
export function nativeToolSearchMatches(message: AssistantMessage): string[] {
  const names: string[] = [];
  for (const block of message.content) {
    if (block.type !== "serverTool" || block.block.type !== "tool_search_tool_result") continue;
    const content = block.block.content as { tool_references?: unknown } | undefined;
    const references = content?.tool_references;
    if (!Array.isArray(references)) continue;
    for (const reference of references) {
      const name = (reference as { tool_name?: unknown } | null)?.tool_name;
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return names;
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
  /** Activations only the provider's native search made; stay deferred there. */
  readonly #nativeOnly = new Set<string>();
  /** Stable `deferLoading` wrappers, one per tool, so requests stay byte-identical. */
  readonly #deferredViews = new Map<string, Tool>();
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

  /**
   * The tools to send to `model`, and to execute its calls against.
   *
   * With native tool search ({@link hasNativeToolSearch}) that is every tool,
   * in registration order: the always-active core and anything arcturn's own
   * search activated as ordinary tools, the rest flagged `deferLoading` — and
   * no `tool_search`, since the server's search tool replaces it. Nothing in
   * that list moves when the server activates a tool, so the request's tool
   * set is the same on every turn. Every other model gets
   * {@link DeferredToolset.activeTools}.
   *
   * @param model - The model the next request goes to.
   */
  toolsFor(model: ModelSpec): Tool[] {
    if (!hasNativeToolSearch(model)) return this.activeTools();
    return this.#tools.map((tool) => {
      const name = tool.definition.name;
      const loaded =
        this.#alwaysActive.has(name) || (this.#activated.has(name) && !this.#nativeOnly.has(name));
      return loaded ? tool : this.#deferredView(tool);
    });
  }

  /**
   * Record the activations a provider's native tool search made in `message`
   * (its `tool_search_tool_result` blocks), so snapshots, resumes and a later
   * switch to a model on arcturn's own path know about them. Fires
   * `onActivate` for names that are new. Other messages are ignored.
   *
   * @param message - Any message; typically each `messageEnd`'s.
   * @returns The names newly activated.
   */
  observe(message: Message): string[] {
    if (message.role !== "assistant") return [];
    const fresh = this.#activateNative(nativeToolSearchMatches(message));
    if (fresh.length > 0) this.#onActivate?.([...fresh]);
    return fresh;
  }

  /**
   * Rebuild the activation record from a transcript — arcturn's own
   * `tool_search` results and the provider's native search results alike —
   * so a resumed session sends the tool set it ended with. Like
   * {@link DeferredToolset.restore}, it does not fire `onActivate`.
   *
   * @param messages - The resumed conversation, oldest first.
   */
  replay(messages: readonly Message[]): void {
    for (const message of messages) {
      if (message.role === "assistant") {
        this.#activateNative(nativeToolSearchMatches(message));
        continue;
      }
      if (message.role !== "toolResult" || message.toolName !== this.#searchToolName) continue;
      const activated = message.details?.activated;
      if (!Array.isArray(activated)) continue;
      for (const name of activated) {
        if (typeof name !== "string" || !this.#byName.has(name)) continue;
        if (this.#alwaysActive.has(name)) continue;
        this.#activated.add(name);
        this.#nativeOnly.delete(name);
      }
    }
    this.#version++;
  }

  #activateNative(names: readonly string[]): string[] {
    const fresh: string[] = [];
    for (const name of names) {
      if (!this.#byName.has(name) || this.#alwaysActive.has(name) || this.#activated.has(name)) {
        continue;
      }
      this.#activated.add(name);
      this.#nativeOnly.add(name);
      fresh.push(name);
    }
    if (fresh.length > 0) this.#version++;
    return fresh;
  }

  #deferredView(tool: Tool): Tool {
    const name = tool.definition.name;
    let view = this.#deferredViews.get(name);
    if (!view) {
      view = {
        get definition(): Tool["definition"] {
          return { ...tool.definition, deferLoading: true };
        },
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        execute: (input, ctx) => tool.execute(input, ctx),
      };
      this.#deferredViews.set(name, view);
    }
    return view;
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
      // Activated through arcturn's own search: an ordinary tool from now on,
      // on every path.
      if (this.#byName.has(name)) this.#nativeOnly.delete(name);
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
    const native = [...this.#nativeOnly].sort();
    return {
      activated: [...this.#activated].sort(),
      ...(native.length > 0 ? { native } : {}),
    };
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
    this.#nativeOnly.clear();
    const native = new Set(snapshot.native ?? []);
    for (const name of snapshot.activated) {
      if (this.#byName.has(name) && !this.#alwaysActive.has(name)) {
        this.#activated.add(name);
        if (native.has(name)) this.#nativeOnly.add(name);
      }
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
