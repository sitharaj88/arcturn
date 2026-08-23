/**
 * Builds a real {@link Agent} wired to the scripted LLM and fake tools, for
 * the harness's own unit tests. No network, no API keys.
 */

import { Agent } from "@arcturn/core";
import type { StreamEvent } from "@arcturn/types";
import type { CreatedAgent } from "../runner.js";
import { createScriptedLLM, FAKE_MODEL } from "./fake-llm.js";
import { createFakeTools } from "./fake-tools.js";

/**
 * Build a factory (assignable to {@link AgentFactory}) that scripts the same
 * turns for every task (fine for single-task tests) using a fresh scripted
 * LLM per call. The return type is kept as the concrete {@link CreatedAgent}
 * rather than widened to `AgentFactory`, so callers can still reach
 * `.agent`/`.dispose` without a cast.
 *
 * @param script - Turns to replay, in order.
 */
export function scriptedAgentFactory(script: StreamEvent[][]): (cwd: string) => CreatedAgent {
  return (cwd: string): CreatedAgent => {
    const llm = createScriptedLLM(script);
    const agent = new Agent({
      llm,
      model: FAKE_MODEL,
      systemPrompt: "You are a test agent.",
      tools: createFakeTools(),
      cwd,
      permissions: { mode: "yolo" },
    });
    return { agent };
  };
}
