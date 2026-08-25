/**
 * `compact` and `exportSession`, exercised end to end: a real
 * {@link ArcturnServer} on a real port, a real `createProtocolClient` over a
 * real `ws` socket, and a real {@link Agent} holding a real conversation.
 *
 * Two assertions carry the file, and neither is "a call returned":
 *
 * - **`compact` shrank the conversation.** The proof is the agent's own
 *   message array — shorter, and headed by a `<compacted-history>` summary —
 *   plus the `compaction` entry the session store now holds. Not the boolean
 *   the verb answered with. The reported token pair is checked against the
 *   `compactionEnd` event the same operation emitted, because the failure
 *   worth catching is the verb and the event disagreeing.
 * - **`exportSession` wrote nothing.** The server's `cwd` is snapshotted
 *   before and after, because the whole reason this verb returns content
 *   rather than a path is that a remote client must not make the engine write
 *   a file on its disk.
 */

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MemorySessionStore } from "@arcturn/core";
import { createProtocolClient, type ProtocolRequestError } from "@arcturn/protocol";
import type { AgentEvent, LLMClient, Message, SessionEntry } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SESSION_EXPORT_MAX_BYTES, type TranscriptExporter } from "./session-export.js";
import { SessionHost, type SessionHostError, type SessionHostOptions } from "./session-host.js";
import {
  createGatedLLM,
  createScriptedLLM,
  TEST_MODEL,
  textTurn,
} from "./test-helpers/fake-llm.js";
import { ArcturnServer } from "./ws-server.js";

const servers: ArcturnServer[] = [];
const clients: { close(): void }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
});

/** A stand-in for `@arcturn/cli`'s real renderer: enough shape to measure. */
function fakeExporter(): TranscriptExporter {
  return {
    render: ({ messages, format }) =>
      format === "html"
        ? `<html><body>${messages.map((m) => `<p>${roleText(m)}</p>`).join("")}</body></html>`
        : messages.map((m) => `## ${m.role}\n\n${roleText(m)}`).join("\n\n"),
    suggestFilename: ({ format }) =>
      `arcturn-session-2026-08-25-1200.${format === "html" ? "html" : "md"}`,
  };
}

function roleText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("");
}

interface Harness {
  client: ReturnType<typeof createProtocolClient>;
  sessionId: string;
  cwd: string;
  store: MemorySessionStore;
  agent: () => Agent;
}

/** A host with a real agent factory, a real store and the fake renderer. */
function buildHost(
  llm: LLMClient,
  extra: Partial<SessionHostOptions> = {},
  store: MemorySessionStore = new MemorySessionStore(),
): SessionHost {
  return new SessionHost({
    agentFactory: (opts) => {
      const agent = new Agent({
        llm,
        model: TEST_MODEL,
        systemPrompt: "You are a test agent.",
        tools: [],
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        sessionStore: store,
        // Small enough that a two-turn conversation has a foldable head.
        compaction: { keepRecentTokens: 10 },
        permissions: { mode: "yolo", rules: [] },
      });
      lastAgent = agent;
      return agent;
    },
    sessionStore: store,
    defaultCwd: tmpdir(),
    transcriptExporter: fakeExporter(),
    ...extra,
  });
}

/** The agent the most recent `buildHost` factory minted, for direct assertions. */
let lastAgent: Agent | undefined;

async function harness(
  llm: LLMClient,
  extra: Partial<SessionHostOptions> = {},
  events?: AgentEvent[],
): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "arcturn-compact-wire-"));
  const store = new MemorySessionStore();
  const host = buildHost(llm, { defaultCwd: cwd, ...extra }, store);
  const server = new ArcturnServer({ sessionHost: host });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
  clients.push(client);
  if (events) client.onEvent((_sessionId, event) => events.push(event));
  const header = await client.createSession({ cwd });
  await client.openSession(header.sessionId);
  return {
    client,
    sessionId: header.sessionId,
    cwd,
    store,
    agent: () => {
      if (!lastAgent) throw new Error("No agent was built");
      return lastAgent;
    },
  };
}

describe("compact — the conversation actually shrinks", () => {
  it("folds the head into a summary and reports the tokens on both sides", async () => {
    const events: AgentEvent[] = [];
    const { client, sessionId, store, agent } = await harness(
      createScriptedLLM([
        // Usage in the same neighbourhood as the text, so `estimatedTokens`
        // describes a real conversation rather than a fifteen-token one.
        textTurn("first answer ".repeat(40), { inputTokens: 200, outputTokens: 200 }),
        textTurn("second answer ".repeat(40), { inputTokens: 500, outputTokens: 200 }),
        textTurn("a summary of everything that came before"),
      ]),
      {},
      events,
    );
    await client.prompt(sessionId, "first question");
    await client.prompt(sessionId, "second question");

    const messagesBefore = agent().messages.length;
    const result = await client.compact(sessionId);

    expect(result.compacted).toBe(true);
    expect(result.sessionId).toBe(sessionId);
    // The report, not "it did something": both numbers, and the shrink.
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    // The conversation itself is shorter, and the summary replaced the head.
    expect(agent().messages.length).toBeLessThan(messagesBefore);
    expect(JSON.stringify(agent().messages[0])).toContain("<compacted-history>");

    // The verb quotes the engine's own event rather than measuring its own
    // pair — a second source for one number is how the notification and the
    // response come to disagree.
    const end = events.find((event) => event.type === "compactionEnd");
    expect(end).toMatchObject({
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    });

    const entries: SessionEntry[] = await store.entries(sessionId);
    const compaction = entries.filter((entry) => entry.kind === "compaction");
    expect(compaction).toHaveLength(1);
  });

  it("says so, with a reason, when there is nothing old enough to fold", async () => {
    const { client, sessionId } = await harness(createScriptedLLM([textTurn("hi")]), {});
    const result = await client.compact(sessionId);
    expect(result.compacted).toBe(false);
    expect(result.tokensAfter).toBe(result.tokensBefore);
    expect(result.reason ?? "").toMatch(/nothing to compact/i);
  });

  it("refuses mid-run with sessionBusy rather than queueing", async () => {
    const llm = createGatedLLM(textTurn("done"));
    const { client, sessionId } = await harness(llm);
    const run = client.prompt(sessionId, "go");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const error = await client.compact(sessionId).catch((e: unknown) => e);
    expect((error as ProtocolRequestError).code).toBe("sessionBusy");

    llm.release();
    await run;
  });
});

describe("exportSession — content comes back, nothing lands on the server's disk", () => {
  it("returns the transcript and writes no file into the served cwd", async () => {
    const { client, sessionId, cwd } = await harness(
      createScriptedLLM([textTurn("the answer is 42")]),
    );
    await client.prompt(sessionId, "what is the answer?");

    const before = (await readdir(cwd)).sort();
    const result = await client.exportSession(sessionId, { format: "markdown" });
    const after = (await readdir(cwd)).sort();

    expect(after).toEqual(before);
    expect(result?.content).toContain("the answer is 42");
    expect(result?.format).toBe("markdown");
    expect(result?.filename).toMatch(/\.md$/);
    expect(result?.messageCount).toBeGreaterThan(0);
    expect(result?.truncated).toBe(false);
  });

  it("serves html when asked for it", async () => {
    const { client, sessionId } = await harness(createScriptedLLM([textTurn("hello html")]));
    await client.prompt(sessionId, "hi");
    const result = await client.exportSession(sessionId, { format: "html" });
    expect(result?.content.startsWith("<html>")).toBe(true);
    expect(result?.filename).toMatch(/\.html$/);
  });

  it("drops the oldest messages to fit the cap and says how many", async () => {
    const { client, sessionId } = await harness(
      createScriptedLLM([textTurn("a".repeat(600)), textTurn("b".repeat(600))]),
      { sessionExportLimits: { maxBytes: 700 } },
    );
    await client.prompt(sessionId, "one");
    await client.prompt(sessionId, "two");

    const result = await client.exportSession(sessionId, { format: "markdown" });
    expect(result?.truncated).toBe(true);
    expect(result?.droppedMessages).toBeGreaterThan(0);
    expect(Buffer.byteLength(result?.content ?? "", "utf8")).toBeLessThanOrEqual(700);
  });

  it("refuses rather than assembling a second, worse renderer when none was wired", async () => {
    const host = buildHost(createScriptedLLM([textTurn("hi")]), {
      transcriptExporter: undefined,
    });
    const header = await host.createSession({});

    // Asserted on the host rather than through the client, because the client
    // collapses this `invalidRequest` into `undefined` — the same collapse
    // `resolveContext` has always had for "no resolver wired", and coherent for
    // the same reason: to a caller, "this engine has no exporter" and "this
    // engine is older than the verb" are one piece of news, and the answer to
    // both is to offer no export. The *sentence* still matters to whoever
    // assembled the host, which is what this pins.
    expect(() => host.exportSession(header.sessionId)).toThrow(/without a transcript exporter/);
    try {
      host.exportSession(header.sessionId);
    } catch (error) {
      expect((error as SessionHostError).code).toBe("invalidRequest");
    }
  });

  it("collapses that refusal to undefined on the wire, like resolveContext does", async () => {
    const { client, sessionId } = await harness(createScriptedLLM([textTurn("hi")]), {
      transcriptExporter: undefined,
    });
    await expect(client.exportSession(sessionId)).resolves.toBeUndefined();
  });

  it("is allowed mid-run, exactly as the terminal's /export is", async () => {
    // A snapshot of a conversation still in progress is a true thing to have,
    // and refusing it would be a restriction the local user does not have.
    const llm = createGatedLLM(textTurn("done"));
    const { client, sessionId } = await harness(llm);
    const run = client.prompt(sessionId, "go");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await client.exportSession(sessionId);
    expect(result?.content).toContain("go");

    llm.release();
    await run;
  });

  it("bounds the payload at the backpressure threshold by default", () => {
    expect(SESSION_EXPORT_MAX_BYTES).toBe(1024 * 1024);
  });
});
