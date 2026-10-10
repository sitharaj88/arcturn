/**
 * The CLI's half of append-only history: the config keys that choose the
 * shapes, `arcturn doctor`'s account of them, and the transcript surfaces a
 * `system` message, a compaction block or a server-tool block must not break.
 */

import { getModel } from "@arcturn/ai";
import type { AssistantMessage, Message } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { contextEditingFor, DEFAULT_CONFIG, mergeConfig, parseConfigFile } from "./config.js";
import { historyShapeEntries } from "./doctor.js";
import { exportHtml, exportMarkdown } from "./export.js";
import { registerBundledCatalog } from "./runtime.js";

function parse(raw: unknown, scope: "user" | "project" = "user") {
  const warnings: string[] = [];
  const parsed = parseConfigFile(raw, scope, "cfg", warnings);
  return { parsed, warnings: warnings.join("\n") };
}

describe("config: compaction.shape, contextEditing.mode, thinkingBinding", () => {
  it("reads each shape and mode, and the binding beside fallbacks", () => {
    for (const shape of ["keep-tail", "simple", "server"]) {
      expect(parse({ compaction: { shape } }).parsed.compaction).toEqual({ shape });
    }
    for (const mode of ["local", "server", "auto"]) {
      expect(parse({ contextEditing: { mode } }).parsed.contextEditing).toEqual({ mode });
    }
    expect(parse({ contextEditing: { minCharsPerPass: 1234 } }).parsed.contextEditing).toEqual({
      minCharsPerPass: 1234,
    });
    for (const thinkingBinding of ["error", "drop_block"]) {
      const { parsed, warnings } = parse({ providers: { anthropic: { thinkingBinding } } });
      expect(parsed.anthropicThinkingBinding).toBe(thinkingBinding);
      expect(parsed.providers).toBeUndefined();
      expect(warnings).toBe("");
    }
  });

  it("warns about, and drops, anything else", () => {
    const shape = parse({ compaction: { shape: "summarize", extra: 1 } });
    expect(shape.parsed.compaction).toEqual({});
    expect(shape.warnings).toContain(
      '"compaction.shape" must be one of "keep-tail", "simple", "server"',
    );
    expect(shape.warnings).toContain('unknown "compaction" key "extra"');
    const mode = parse({ contextEditing: { mode: "remote" } });
    expect(mode.parsed.contextEditing).toEqual({});
    expect(mode.warnings).toContain(
      '"contextEditing.mode" must be one of "local", "server", "auto"',
    );
    const binding = parse({ providers: { anthropic: { thinkingBinding: "drop" } } });
    expect(binding.parsed.anthropicThinkingBinding).toBeUndefined();
    expect(binding.warnings).toContain('must be "error" or "drop_block"');
    expect(parse({ compaction: "simple" }).warnings).toContain('"compaction" must be an object');
  });

  it("merges layer-wise, and the binding turns context editing to auto unless a mode was chosen", () => {
    const user = parse({ compaction: { shape: "keep-tail" } }).parsed;
    const project = parse(
      { providers: { anthropic: { thinkingBinding: "drop_block" } } },
      "project",
    ).parsed;
    const merged = mergeConfig(mergeConfig(DEFAULT_CONFIG, user), project);
    expect(merged.compaction).toEqual({ shape: "keep-tail" });
    expect(merged.anthropicThinkingBinding).toBe("drop_block");
    expect(contextEditingFor(merged)).toEqual({ contextEditing: { mode: "auto" } });
    expect(
      contextEditingFor({ ...merged, contextEditing: { mode: "local", keepRecentTurns: 2 } }),
    ).toEqual({ contextEditing: { mode: "local", keepRecentTurns: 2 } });
    expect(contextEditingFor(DEFAULT_CONFIG)).toEqual({});
  });
});

describe("arcturn doctor: the history shape a session will use", () => {
  registerBundledCatalog();
  const opus = getModel("anthropic/claude-opus-5-5")!;
  const gpt = getModel("openai/gpt-5")!;

  it("says simple compaction and local editing on adaptive Claude by default, and why", () => {
    const rows = Object.fromEntries(historyShapeEntries({}, opus));
    expect(rows.compaction).toMatch(/^simple — default for Claude with adaptive thinking/);
    expect(rows["context editing"]).toMatch(/^local — default/);
    expect(rows["thinking binding"]).toBeUndefined();
  });

  it("follows the binding to server-side clearing, and warns where server cannot run", () => {
    const bound = Object.fromEntries(
      historyShapeEntries({ anthropicThinkingBinding: "error" }, opus),
    );
    expect(bound["context editing"]).toMatch(/^server — contextEditing.mode auto/);
    expect(bound["thinking binding"]).toBe("error — providers.anthropic.thinkingBinding");
    const elsewhere = Object.fromEntries(
      historyShapeEntries({ compaction: { shape: "server" } }, gpt),
    );
    expect(elsewhere.compaction).toContain("warning: openai/gpt-5 has no server-side compaction");
    expect(Object.fromEntries(historyShapeEntries({}, gpt)).compaction).toMatch(/^keep-tail/);
  });
});

const operator: Message = {
  role: "system",
  content: [{ type: "text", text: "Turn budget: 2 of 10 turns remain." }],
  timestamp: 2,
};

const serverTurn: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "compaction", summary: "what came before", encryptedContent: "enc" },
    {
      type: "serverTool",
      provider: "anthropic",
      block: { type: "server_tool_use", id: "s", name: "tool_search_tool_bm25", input: {} },
    },
    { type: "text", text: "carrying on" },
  ],
  model: "anthropic/claude-opus-5-5",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: "endTurn",
  timestamp: 3,
};

const conversation: Message[] = [
  { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
  operator,
  serverTurn,
];

describe("transcripts with operator messages and server blocks", () => {
  it("exports Markdown with an Operator section and a note for each server block", () => {
    const markdown = exportMarkdown(conversation);
    expect(markdown).toContain("## Operator\n\nTurn budget: 2 of 10 turns remain.");
    expect(markdown).toContain("_The provider compacted the conversation here._");
    expect(markdown).toContain("what came before");
    expect(markdown).toContain("_Server tool: tool_search_tool_bm25_");
    expect(markdown).toContain("carrying on");
  });

  it("exports HTML the same way, escaped", () => {
    const html = exportHtml([
      ...conversation,
      { ...operator, content: [{ type: "text", text: "<b>not markup</b>" }] },
    ]);
    expect(html).toContain('<section class="turn operator"><h2>Operator</h2>');
    expect(html).toContain("&lt;b&gt;not markup&lt;/b&gt;");
    expect(html).toContain("Server tool: tool_search_tool_bm25");
  });
});
