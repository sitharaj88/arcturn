/**
 * The per-turn progress check.
 *
 * Observed on a live run: a write-lane builder spent all 80 of its turns
 * reading — 77 `bash` calls, 17 `read` calls, zero writes, 23.6 minutes,
 * 330K tokens — and hit its ceiling having never started the file it was sent
 * to write. The turn ceiling caught it, but only once the budget was gone, and
 * the diagnosis it produced was "hit its 80-turn ceiling" rather than "never
 * wrote anything". The loop cannot judge that on its own — only the host knows
 * what the step was for — so the loop supplies the evidence (a per-run tool
 * histogram) and the delivery (a user message that rides the next request),
 * and the host supplies the judgement.
 */

import type { AgentEvent, Message, StreamEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent.js";
import type { TurnProgress } from "./loop.js";
import {
  createScriptedLLM,
  type ScriptedLLM,
  TEST_MODEL,
  textTurn,
  toolCallTurn,
} from "./test-helpers/fake-llm.js";
import { contentText } from "./util/content.js";

/** A tool that does nothing but be counted. */
function noopTool(name: string) {
  return {
    definition: {
      name,
      description: `The ${name} tool.`,
      parameters: { type: "object" as const, properties: {} },
    },
    async execute() {
      return { content: [{ type: "text" as const, text: `${name} ran` }] };
    },
  };
}

/** One turn that calls `name` once, with a unique call id. */
function callTurn(name: string, id: string): StreamEvent[] {
  return toolCallTurn([{ id, name, arguments: {} }]);
}

interface Harness {
  agent: Agent;
  llm: ScriptedLLM;
  events: AgentEvent[];
}

function harness(script: StreamEvent[][], options: Partial<AgentOptions> = {}): Harness {
  const llm = createScriptedLLM(script);
  const agent = new Agent({
    llm,
    model: TEST_MODEL,
    systemPrompt: "You are Arcturn.",
    tools: [noopTool("bash"), noopTool("read"), noopTool("write")],
    cwd: "/work",
    permissions: { mode: "yolo" },
    ...options,
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return { agent, llm, events };
}

/** Every user-message text in a request, in order. */
function userTexts(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => contentText(message.content));
}

const NUDGE = "You have made no write call. Start the file now.";

describe("progressCheck", () => {
  it("sends its warning once, on the request for the turn that raised it", async () => {
    // Six tool-calling turns, then a text turn that ends the run.
    const script = [
      callTurn("bash", "c0"),
      callTurn("bash", "c1"),
      callTurn("bash", "c2"),
      callTurn("bash", "c3"),
      callTurn("bash", "c4"),
      callTurn("bash", "c5"),
      textTurn("done"),
    ];
    const seen: number[] = [];
    const { agent, llm, events } = harness(script, {
      progressCheck: ({ turnIndex }) => {
        seen.push(turnIndex);
        // A real check fires on a standing condition, so it keeps returning
        // the same string for as long as the condition holds. The loop, not
        // the host, is what must stop that becoming six copies.
        return turnIndex >= 3 ? NUDGE : undefined;
      },
    });

    await agent.prompt("build the thing");

    // Turn 3's check runs *before* turn 3's request, which is the fourth.
    expect(userTexts(llm.requests[3]?.messages ?? []).at(-1)).toBe(NUDGE);
    // Turns 4, 5 and 6 asked again and were refused: still exactly one copy.
    expect(seen.filter((index) => index >= 3).length).toBeGreaterThan(1);
    expect(userTexts(llm.requests.at(-1)?.messages ?? []).filter((t) => t === NUDGE)).toEqual([
      NUDGE,
    ]);
    expect(
      agent.messages.filter((m) => m.role === "user" && contentText(m.content) === NUDGE),
    ).toHaveLength(1);

    // Once as a warn notice, once as the structured event a host can report on.
    expect(events.filter((e) => e.type === "notice" && e.text === NUDGE)).toHaveLength(1);
    expect(events.filter((e) => e.type === "progressWarning")).toEqual([
      { type: "progressWarning", turnIndex: 3, text: NUDGE },
    ]);
  });

  it("counts tool calls by name, attempts and all, across the whole run", async () => {
    const script = [
      toolCallTurn([
        { id: "a", name: "bash", arguments: {} },
        { id: "b", name: "bash", arguments: {} },
        { id: "c", name: "read", arguments: {} },
      ]),
      callTurn("read", "d"),
      textTurn("done"),
    ];
    const observed: TurnProgress[] = [];
    const { agent } = harness(script, {
      progressCheck: (progress) => {
        observed.push(progress);
        return undefined;
      },
    });

    await agent.prompt("go");

    // Turn 1 sees turn 0's three calls; turn 2 sees turn 1's fourth as well.
    expect(observed.map((p) => p.toolCalls)).toEqual([
      { bash: 2, read: 1 },
      { bash: 2, read: 2 },
    ]);
    expect(observed.map((p) => p.turnIndex)).toEqual([1, 2]);
    expect(observed[0]?.maxTurns).toBe(200);
  });

  it("hands out a snapshot, not the loop's live counter", async () => {
    // A host that stashes the object to compare against the next turn must not
    // find that both references have silently become the same later reading.
    const script = [callTurn("bash", "a"), callTurn("bash", "b"), textTurn("done")];
    const observed: TurnProgress[] = [];
    const { agent } = harness(script, {
      progressCheck: (progress) => {
        observed.push(progress);
        return undefined;
      },
    });

    await agent.prompt("go");

    expect(observed[0]?.toolCalls).toEqual({ bash: 1 });
    expect(observed[1]?.toolCalls).toEqual({ bash: 2 });
  });

  it("is never called before turn 1 — there is no history to judge yet", async () => {
    const seen: number[] = [];
    const { agent } = harness([textTurn("answered immediately")], {
      progressCheck: ({ turnIndex }) => {
        seen.push(turnIndex);
        return undefined;
      },
    });

    await agent.prompt("go");

    // A one-turn run never gets a check at all: the first request is the model's
    // first sight of the prompt, and warning it there is warning it about nothing.
    expect(seen).toEqual([]);
  });

  it("changes nothing at all when it is absent, or when it never fires", async () => {
    const script = () => [callTurn("bash", "a"), callTurn("read", "b"), textTurn("done")];
    const without = harness(script());
    const inert = harness(script(), { progressCheck: () => undefined });

    await without.agent.prompt("go");
    await inert.agent.prompt("go");

    expect(without.llm.requests.length).toBe(inert.llm.requests.length);
    for (const [index, request] of without.llm.requests.entries()) {
      expect(userTexts(request.messages)).toEqual(
        userTexts(inert.llm.requests[index]?.messages ?? []),
      );
    }
    // The prompt, and nothing else the loop invented.
    expect(userTexts(without.llm.requests.at(-1)?.messages ?? [])).toEqual(["go"]);
    expect(without.events.some((e) => e.type === "progressWarning")).toBe(false);
    expect(inert.events.some((e) => e.type === "progressWarning")).toBe(false);
    expect(without.events.some((e) => e.type === "notice")).toBe(false);
  });

  it("ignores a blank return, which is not a warning", async () => {
    const { agent, events } = harness(
      [callTurn("bash", "a"), callTurn("bash", "b"), textTurn("done")],
      { progressCheck: () => "   \n " },
    );

    await agent.prompt("go");

    expect(events.some((e) => e.type === "progressWarning")).toBe(false);
    expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });
});
