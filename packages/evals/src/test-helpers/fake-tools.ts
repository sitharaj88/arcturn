/**
 * Minimal real-filesystem tools for the harness's own unit tests.
 *
 * These are deliberately not `@arcturn/tools` — the eval harness scripts
 * both sides of the exchange in its own tests, so a tiny tool that actually
 * writes files is enough to prove the runner observes tool calls and grades
 * the resulting workspace correctly, without depending on the real tool
 * package's schema.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";

function resolveInWorkspace(cwd: string, path: string): string {
  const full = isAbsolute(path) ? path : join(cwd, path);
  const rel = relative(cwd, full);
  if (rel.startsWith("..")) {
    throw new Error(`refusing to write outside the workspace: ${path}`);
  }
  return full;
}

/** A fake `write` tool: `{ path, content }` overwrites (creating parents). */
export function createFakeWriteTool(): Tool {
  return {
    definition: {
      name: "write",
      description: "Write a file, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const path = String(input.path ?? "");
      const content = String(input.content ?? "");
      const full = resolveInWorkspace(ctx.cwd, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      return { content: [{ type: "text", text: `wrote ${path}` }] };
    },
  };
}

/** A fake `edit` tool: `{ path, oldText, newText }` replaces the first match. */
export function createFakeEditTool(): Tool {
  return {
    definition: {
      name: "edit",
      description: "Replace the first occurrence of oldText with newText in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const path = String(input.path ?? "");
      const oldText = String(input.oldText ?? "");
      const newText = String(input.newText ?? "");
      const full = resolveInWorkspace(ctx.cwd, path);
      const current = await readFile(full, "utf8");
      if (!current.includes(oldText)) {
        return {
          isError: true,
          content: [{ type: "text", text: `oldText not found in ${path}` }],
        };
      }
      await writeFile(full, current.replace(oldText, newText), "utf8");
      return { content: [{ type: "text", text: `edited ${path}` }] };
    },
  };
}

/** A fake `read` tool: `{ path }` returns the file's content. */
export function createFakeReadTool(): Tool {
  return {
    definition: {
      name: "read",
      description: "Read a file's content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const path = String(input.path ?? "");
      const full = resolveInWorkspace(ctx.cwd, path);
      try {
        const content = await readFile(full, "utf8");
        return { content: [{ type: "text", text: content }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  };
}

/** The fake tool set used by the harness's own runner/suite tests. */
export function createFakeTools(): Tool[] {
  return [createFakeReadTool(), createFakeWriteTool(), createFakeEditTool()];
}
