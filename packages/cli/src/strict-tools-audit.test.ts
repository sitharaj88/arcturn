/**
 * The `strict: true` audit over every tool arcturn ships.
 *
 * A strict tool is one whose input the provider guarantees matches its
 * schema — which it can only do for a schema inside the strict grammar
 * (`additionalProperties: false` on every object, no `oneOf`, no numeric or
 * length bounds). Marking a tool strict whose schema misses that is a 400 on
 * every request; leaving a fitting one unmarked gives up a guarantee for
 * nothing. Both directions are checked here, against the one grammar the
 * adapters use, and an MCP-bridged tool — whose schema is a stranger's — is
 * never strict.
 */

import { isOpenAIStrictSchema, isStrictSchema } from "@arcturn/ai";
import {
  createDeferredToolset,
  createPlanTool,
  createSubagentTool,
  createTodoTool,
} from "@arcturn/core";
import {
  createFindReferencesTool,
  createFindSymbolTool,
  createSearchCodeTool,
} from "@arcturn/index";
import { McpToolBridge } from "@arcturn/mcp";
import { createDefaultTools } from "@arcturn/tools";
import type { Tool } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { createBrainTool } from "./brain.js";
import { createSymbolsTool } from "./lsp/symbols.js";
import { createMemoryTool } from "./memory.js";
import { createSkillTool } from "./skill-tool.js";

/** Tools whose schema misses the grammar on purpose, and why. */
const NOT_STRICT: Readonly<Record<string, string>> = {
  glob: "`pattern` is a oneOf string-or-array",
  search_code: "`kind` is a oneOf string-or-array",
  find_symbol: "`kind` is a oneOf string-or-array",
};

function shipped(): Tool[] {
  const defaults = createDefaultTools();
  const toolset = createDeferredToolset({ tools: [...defaults.tools] });
  return [
    ...defaults.tools,
    createTodoTool(),
    createPlanTool(),
    createSubagentTool({ factory: () => undefined as never, agentNames: ["reviewer"] }),
    toolset.searchTool(),
    createBrainTool({ dir: "/brain" }),
    createMemoryTool({ dir: "/memory" }),
    createSkillTool({ registry: () => [] }),
    createSymbolsTool({} as Parameters<typeof createSymbolsTool>[0]),
    createSearchCodeTool(),
    createFindSymbolTool(),
    createFindReferencesTool(),
  ];
}

describe("strict: true on the shipped tools", () => {
  const tools = shipped();

  it.each(tools.map((tool) => [tool.definition.name, tool] as const))(
    "%s is strict exactly when its schema fits the grammar",
    (name, tool) => {
      const fits = isStrictSchema(tool.definition.parameters);
      if (tool.definition.strict === true) {
        expect(fits, `${name} is marked strict but its schema is outside the grammar`).toBe(true);
      } else {
        expect(
          NOT_STRICT[name],
          `${name} fits the strict grammar; mark it strict or list why not`,
        ).toBeDefined();
        expect(fits).toBe(false);
      }
    },
  );

  it("todo keeps its optional id: strict for Anthropic, plain where every property must be required", () => {
    const todo = tools.find((tool) => tool.definition.name === "todo");
    expect(todo?.definition.strict).toBe(true);
    expect(isOpenAIStrictSchema(todo?.definition.parameters ?? { type: "object" })).toBe(false);
  });

  it("streams eagerly only the tools that carry a file body", () => {
    const eager = tools.filter((tool) => tool.definition.eagerInputStreaming === true);
    expect(eager.map((tool) => tool.definition.name).sort()).toEqual(["edit", "write"]);
  });

  it("never marks an MCP-bridged tool strict, whatever its schema", () => {
    const bridge = new McpToolBridge("srv", {} as ConstructorParameters<typeof McpToolBridge>[1]);
    bridge.setMcpTools([
      {
        name: "lookup",
        description: "d",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
          additionalProperties: false,
        },
      },
    ]);
    const [bridged] = bridge.tools();
    if (bridged === undefined) throw new Error("no bridged tool");
    expect(bridged.definition.strict).toBeUndefined();
    expect(bridged.definition.eagerInputStreaming).toBeUndefined();
  });
});
