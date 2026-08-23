/**
 * Minimal `Tool` implementations for this package's tests. Excluded from the
 * build by `tsconfig.json` (`src/**\/test-helpers/**`).
 */

import type { Tool } from "@arcturn/types";

/**
 * A tool outside every default permission allow-list, so calling it under
 * the default permission mode always asks — useful for exercising the
 * `permissionRequest` / `permissionDecision` round trip.
 */
export function createGuardedTool(name = "guarded"): Tool {
  return {
    definition: {
      name,
      description: "Test tool that always requires permission.",
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
    async execute(input) {
      return { content: [{ type: "text", text: `ran ${name} with ${JSON.stringify(input)}` }] };
    },
  };
}
