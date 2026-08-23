/**
 * Wraps the `write` and `edit` tools so that, after a successful edit, the
 * model sees language-server diagnostics for the file it just touched.
 *
 * This never turns a successful tool call into a failure: any problem
 * reading the file back or getting diagnostics for it is swallowed and the
 * original result is returned unchanged. Worst case it adds `timeoutMs`
 * (default 3s) of latency to `write`/`edit`.
 */

import { readFile } from "node:fs/promises";
import { resolvePath } from "@arcturn/tools";
import type { Tool, ToolResult } from "@arcturn/types";
import { formatDiagnostics, type LspManager } from "./manager.js";

/** Tool names whose successful result is annotated with diagnostics. */
const WRAPPED_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);

/** Options for {@link wrapToolsWithLsp}. */
export interface WrapToolsWithLspOptions {
  /** Per-file diagnostics budget. Defaults to the manager's own default (3s). */
  timeoutMs?: number;
}

/** Append formatted diagnostics onto a `ToolResult`'s last text block. */
function withDiagnosticsAppended(result: ToolResult, formatted: string): ToolResult {
  const suffix = `\n\nlsp diagnostics:\n${formatted}`;
  const lastTextIndex = result.content.reduce(
    (found, item, index) => (item.type === "text" ? index : found),
    -1,
  );
  if (lastTextIndex === -1) {
    return { ...result, content: [...result.content, { type: "text", text: suffix.trimStart() }] };
  }
  const content = result.content.map((item, index) =>
    index === lastTextIndex && item.type === "text"
      ? { ...item, text: `${item.text}${suffix}` }
      : item,
  );
  return { ...result, content };
}

/**
 * Wrap `write`/`edit` in `tools` so each successful call is followed by an
 * LSP diagnostics lookup on the file it changed. Every other tool passes
 * through unchanged (same object, not a copy).
 *
 * @param tools - The tool set to wrap (e.g. `createDefaultTools().tools`).
 * @param manager - Manager providing `diagnosticsFor`; see {@link createLspManager}.
 */
export function wrapToolsWithLsp(
  tools: readonly Tool[],
  manager: LspManager,
  options: WrapToolsWithLspOptions = {},
): Tool[] {
  const timeoutMs = options.timeoutMs;

  return tools.map((tool) => {
    if (!WRAPPED_TOOL_NAMES.has(tool.definition.name)) return tool;

    // Spread first so extra tool surface (e.g. bindAgent) survives the wrap.
    return {
      ...tool,
      async execute(input, ctx) {
        const result = await tool.execute(input, ctx);
        if (result.isError) return result;

        const rawPath = input.path;
        if (typeof rawPath !== "string" || rawPath.length === 0) return result;

        let absolutePath: string;
        try {
          absolutePath = resolvePath(ctx.cwd, rawPath);
        } catch {
          return result;
        }

        let contents: string;
        try {
          contents = await readFile(absolutePath, "utf8");
        } catch {
          return result;
        }

        let diagnostics: Awaited<ReturnType<LspManager["diagnosticsFor"]>>;
        try {
          diagnostics = await manager.diagnosticsFor(absolutePath, contents, timeoutMs);
        } catch {
          diagnostics = null;
        }
        if (!diagnostics || diagnostics.length === 0) return result;

        return withDiagnosticsAppended(result, formatDiagnostics(diagnostics, rawPath));
      },
    } satisfies Tool;
  });
}
