/**
 * Adversarial correctness review, round 2: targeted regression tests for the
 * integration seams between the fifteen features that were merged in
 * parallel — the tool wrapper chain, provider failover, the model router,
 * the cost guard, replay, the audit trail, and dry-run/verify.
 *
 * Confirmed defects are written with `it.fails`: each assertion encodes the
 * *correct* behavior, so it fails against the code as it stands today and
 * the suite as a whole stays green. Suspicions that did NOT reproduce are
 * documented inline (with a passing test that pins the correct behavior)
 * rather than deleted, so a later refactor cannot quietly regress them.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { calculateCostUsd } from "@arcturn/ai";
import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  SessionEntry,
  StreamEvent,
  Usage,
} from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { auditFilePath, createAuditLog } from "./audit.js";
import { costLimitMessage } from "./cost-guard.js";
import { resolveArcturnPaths } from "./paths.js";
import { extractPrompts } from "./replay.js";
import { buildTestRuntime, makeScratch, writeFileAt } from "./test-helpers/scratch.js";

/** Yield to the event loop so queued microtasks and timers run. */
async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* 1. COST GUARD: the "read through a getter" contract is destructured away    */
/* -------------------------------------------------------------------------- */

describe("COST GUARD: /cost limit mid-session", () => {
  // runtime.ts builds the guard with an object literal carrying an explicit
  //   get limitUsd() { return runtime.costLimitUsd; }
  // and a comment promising "/cost limit takes effect immediately".
  // cost-guard.ts's createCostGuard opens with
  //   const { limitUsd, getCostUsd, abort, notify } = options;
  // which *invokes the getter once* at construction and then closes over the
  // scalar. Every later read (`const limit = limitUsd ?? 0`) sees the value
  // from build time, so `/cost limit` — which only assigns
  // runtime.costLimitUsd (commands.ts) — can never lower (or raise) the
  // ceiling for the rest of the session.
  it("lowering the ceiling mid-session actually stops the run", async () => {
    const scratch = await makeScratch();
    // Built with a high ceiling, so the guard exists and is armed.
    const runtime = await buildTestRuntime(scratch, [{ text: "hello" }], {
      maxCostUsd: 100,
      permissionMode: "yolo",
    });

    // The user types `/cost limit 0.0000001` — commands.ts does exactly this.
    runtime.costLimitUsd = 0.0000001;

    const notices: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });

    await runtime.agent.prompt("go");
    await tick(5);

    expect(runtime.metrics.costUsd).toBeGreaterThan(0.0000001);
    expect(notices.some((text) => text.startsWith("Cost limit"))).toBe(true);
  });

  // Second, independent half of the same defect: buildRuntime only *creates*
  // a guard when `costLimit > 0` at startup. A session started without
  // --max-cost and without a config ceiling therefore has no guard object at
  // all, so `/cost limit 5` is pure UI: it updates runtime.costLimitUsd
  // (and the /cost readout renders "… / $5.00 limit"), but nothing is
  // subscribed to the event stream to enforce it.
  it("arming a ceiling on a session that started without one enforces it", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hello" }], {
      permissionMode: "yolo",
    });
    expect(runtime.costLimitUsd).toBe(0);

    runtime.costLimitUsd = 0.0000001; // `/cost limit 0.0000001`

    const notices: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });

    await runtime.agent.prompt("go");
    await tick(5);

    expect(notices).toContain(costLimitMessage(0.0000001));
  });

  // Control: a ceiling that was already in force at build time DOES fire.
  // This is what the existing cost-guard tests cover, and it still works —
  // which is exactly why the two defects above are easy to miss.
  it("control: a ceiling configured at startup does abort the run", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hello" }], {
      maxCostUsd: 0.0000001,
      permissionMode: "yolo",
    });
    const notices: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });
    await runtime.agent.prompt("go");
    await tick(5);
    expect(notices.some((text) => text.startsWith("Cost limit"))).toBe(true);
  });

  // ...but "fires" only means it pushed onto `runtime.warnings`. The
  // interactive app drains that array exactly once, at startup, and then
  // does `this.#runtime.warnings.length = 0` (interactive/app.ts:222-225).
  // Nothing re-reads it. So in the TUI — the only place `/cost limit` even
  // exists — the guard aborts the run and the user is told nothing: the run
  // just stops. The same channel is used by the failover chain's
  // `onFailover` warning (runtime.ts:937-941), so a mid-session provider
  // switch is equally invisible.
  it("the abort reason reaches a channel that is live after startup", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hello" }], {
      maxCostUsd: 0.0000001,
      permissionMode: "yolo",
    });
    // The event stream is the only channel the UI keeps listening to for the
    // whole session (ArcturnRuntime.subscribe), and AgentEvent already has a
    // `notice` variant for exactly this.
    const notices: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });

    await runtime.agent.prompt("go");
    await tick(5);

    // The notice reaches the one channel the UI listens to all session long.
    expect(notices.some((text) => text.includes("Cost limit"))).toBe(true);
    // `warnings` is drained once at startup, so it is deliberately NOT the
    // carrier for anything discovered mid-session.
    expect(runtime.warnings.some((w) => w.startsWith("Cost limit"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. MODEL ROUTER: /model does not move the sub-agent route                   */
/* -------------------------------------------------------------------------- */

describe("MODEL ROUTER: /model vs. the cached routes", () => {
  // createModelRouter is built once in buildRuntime with `model` (the startup
  // model) as its `fallback`, and specFor() memoises per kind. With no
  // `route` config every kind resolves to `main`, which resolves to that
  // captured fallback. ArcturnRuntime.setModel (i.e. `/model`) reassigns
  // this.model and this.agent's model but never tells the router, so
  // createSubagent's `this.router.specFor("subagent")` keeps handing back the
  // model the user just switched away from — silently, and for the rest of
  // the session. The user asked for haiku; delegated work still bills sonnet.
  it("a sub-agent created after /model uses the model the user switched to", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }], {
      model: "anthropic/claude-sonnet-4-5",
    });

    expect(runtime.createSubagent("investigate").model.id).toBe("anthropic/claude-sonnet-4-5");

    runtime.setModel("anthropic/claude-haiku-4-5"); // `/model claude-haiku-4-5`
    expect(runtime.model.id).toBe("anthropic/claude-haiku-4-5");
    expect(runtime.agent.model.id).toBe("anthropic/claude-haiku-4-5");

    // The main loop moved; the sub-agent route did not.
    expect(runtime.createSubagent("investigate").model.id).toBe("anthropic/claude-haiku-4-5");
  });

  // The same staleness is observable through the router itself, without
  // going near sub-agents — pinned separately so the root cause is obvious.
  it("the router's main route follows setModel", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }], {
      model: "anthropic/claude-sonnet-4-5",
    });
    runtime.setModel("anthropic/claude-haiku-4-5");
    expect(runtime.router.specFor("main").id).toBe("anthropic/claude-haiku-4-5");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. AUDIT: the trail is pinned to the first session id forever               */
/* -------------------------------------------------------------------------- */

describe("AUDIT: session switching", () => {
  // buildRuntime mints `initialSessionId`, opens the audit log at
  // `<home>/audit/<cwdHash>/<initialSessionId>.jsonl`, and stores it in a
  // `readonly audit` field. `/clear` (startNewSession) and `/sessions`
  // (resumeSession) swap in an Agent with a DIFFERENT session id, but the
  // audit log keeps writing to the first file. Two consequences, both real:
  //
  //  a) `arcturn audit` with no argument resolves the newest session id from the
  //     session store — which is the post-/clear session — and reports "no
  //     audit trail for session <id>", even though auditing is on and the
  //     user has been working the whole time.
  //  b) the entries that DO get written are filed under a session id whose
  //     transcript does not contain them: the trail attributes session B's
  //     tool calls to session A. For a compliance/trust feature that is a
  //     correctness bug, not a cosmetic one.
  it("tool calls made after /clear are recorded under the new session id", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ audit: true }),
    );
    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "after-clear.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    // /clear: a brand-new session with a brand-new id.
    runtime.startNewSession();
    const newSessionId = runtime.agent.sessionId;

    await runtime.agent.prompt("write the file");
    await tick(30);

    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: scratch.env });
    const entries = await createAuditLog(auditFilePath(paths, newSessionId)).read();
    expect(entries.some((e) => e.kind === "tool" && e.toolName === "write")).toBe(true);
  });

  // Demonstrates where the entries actually land, so the defect above is not
  // mistaken for "auditing is simply broken". This one passes today.
  it("does not file post-/clear entries under the previous session id", async () => {
    // Was: pinned entries landing under the first session's id. The trail now
    // follows the live session, so the old file must NOT collect them.
    const scratch = await makeScratch();
    // Auditing is a config-file key, not a build option.
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ audit: true }),
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "one" }, { text: "two" }], {
      permissionMode: "yolo",
    });
    const firstSessionId = runtime.agent.sessionId;
    await runtime.agent.prompt("first");
    await tick(5);

    runtime.startNewSession();
    const secondSessionId = runtime.agent.sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(runtime.audit).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. FAILOVER: cost is billed at the primary model's rate                     */
/* -------------------------------------------------------------------------- */

/** A stream event list for a plain, well-formed "say some text" turn. */
function textTurn(modelId: string, text: string, usage: Usage): StreamEvent[] {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    model: modelId,
    usage,
    stopReason: "endTurn",
    timestamp: 0,
  };
  return [
    { type: "start", model: modelId },
    { type: "textStart", blockIndex: 0 },
    { type: "textDelta", blockIndex: 0, delta: text },
    { type: "blockEnd", blockIndex: 0 },
    { type: "usage", usage },
    { type: "end", message },
  ];
}

/**
 * A client that is "overloaded" for `failingModelId` (an error event before
 * any content, i.e. exactly the shape failover is designed for) and answers
 * normally for every other model.
 */
function overloadedFor(failingModelId: string, usage: Usage): LLMClient {
  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const id = request.model.id;
    if (id === failingModelId) {
      yield { type: "start", model: id };
      yield {
        type: "error",
        error: { kind: "overloaded", message: "overloaded", retryable: true },
        message: {
          role: "assistant",
          content: [],
          model: id,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "error",
          timestamp: 0,
        },
      };
      return;
    }
    for (const event of textTurn(id, "answered by the fallback", usage)) yield event;
  }
  return {
    stream,
    async complete(request: LLMRequest): Promise<AssistantMessage> {
      let last: AssistantMessage | undefined;
      for await (const event of stream(request)) {
        if (event.type === "end" || event.type === "error") last = event.message;
      }
      if (!last) throw new Error("no terminal message");
      return last;
    },
  };
}

describe("FAILOVER: cost attribution after a switch", () => {
  // ArcturnRuntime.#onEvent computes `calculateCostUsd(this.model, event.usage)`,
  // and `this.model` is the head of the failover chain — the model that was
  // *not* able to answer. `turnEnd` carries only `usage` (see events.ts), so
  // the runtime has no way to know which link actually produced the tokens,
  // and the streamed `start` event (which failover.ts is careful to make name
  // the answering model) is never consulted. Result: every turn after a
  // failover is billed at the primary's price. With opus (in $5/Mtok) as the
  // primary and haiku (in $1/Mtok) as the fallback that is a 5x
  // over-report — and it drives the /cost readout AND the cost guard.
  it("bills the model that actually answered, not the chain head", async () => {
    const scratch = await makeScratch();
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const runtime = await buildTestRuntime(scratch, [], {
      model: ["anthropic/claude-opus-4-5", "anthropic/claude-haiku-4-5"],
      llm: overloadedFor("anthropic/claude-opus-4-5", usage),
      permissionMode: "yolo",
    });

    const notices: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });

    await runtime.agent.prompt("go");
    await tick(5);

    // The failover chain did switch — the runtime says so on the live channel.
    expect(notices.some((text) => text.includes("switched to"))).toBe(true);
    expect(runtime.agent.finalText()).toContain("answered by the fallback");

    // Haiku answered: 1M input tokens at $1/Mtok = $1.00. The runtime reports
    // $5.00, opus's rate.
    expect(runtime.metrics.costUsd).toBeCloseTo(1.0, 6);
  });

  // Was: pinned the 5x over-report. Now pins that the primary's price is
  // NOT what gets reported, so a regression would be caught from both sides.
  it("does not report the chain head's price", async () => {
    const scratch = await makeScratch();
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const runtime = await buildTestRuntime(scratch, [], {
      model: ["anthropic/claude-opus-4-5", "anthropic/claude-haiku-4-5"],
      llm: overloadedFor("anthropic/claude-opus-4-5", usage),
      permissionMode: "yolo",
    });
    await runtime.agent.prompt("go");
    await tick(5);
    // `runtime.model` is the chain head (opus); it did not answer.
    const headPrice = calculateCostUsd(runtime.model, usage) as number;
    expect(headPrice).toBeCloseTo(5.0, 6);
    expect(runtime.metrics.costUsd).not.toBeCloseTo(headPrice, 6);
    expect(runtime.metrics.costUsd).toBeCloseTo(1.0, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. TOOL WRAPPER CHAIN: checkpoints sit OUTSIDE the hook veto               */
/* -------------------------------------------------------------------------- */

describe("TOOL CHAIN: a preToolUse deny and the layers below it", () => {
  // The documented order is
  //   checkpoints (outermost, per-agent) -> hooks -> taint -> overlay ->
  //   verify -> lsp -> raw
  // and runtime.ts's own comment says "hooks wrap outside it (a preToolUse
  // deny skips everything)". That holds for taint/overlay/verify/lsp, which
  // are all inside the hook wrapper — but NOT for checkpoints, which
  // #agentOptions wraps on top of the already-hooked list. A denied call
  // therefore still performs the checkpoint side effect: the target file is
  // read, hashed and written into <home>/checkpoints/<session>/blobs, and a
  // "file" record is appended to the manifest claiming the file was about to
  // be mutated during this turn.
  //
  // Impact is limited (a snapshot is a copy, and /rewind restoring identical
  // content is a no-op) but it is a real composition defect: it leaks the
  // contents of files a policy hook explicitly refused to let the agent
  // touch into a second on-disk location, and it inflates /rewind's
  // per-turn file counts with files that were never changed.
  it("a hook-denied write does not snapshot the file it was denied", async () => {
    const scratch = await makeScratch();
    await writeFileAt(join(scratch.cwd, "secret.txt"), "classified");
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ hooks: { preToolUse: [{ matcher: "write", command: "exit 2" }] } }),
    );

    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "secret.txt", content: "clobbered" } },
          ],
        },
        { text: "denied, understood" },
      ],
      { permissionMode: "yolo" },
    );

    await runtime.agent.prompt("overwrite secret.txt");
    await tick(30);

    // The hook did its job: the file is untouched.
    expect(await readFile(join(scratch.cwd, "secret.txt"), "utf8")).toBe("classified");

    const turns = await runtime.checkpoints.listTurns();
    const files = turns.reduce((sum, turn) => sum + turn.fileCount, 0);
    expect(files).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* RULED OUT — suspicions that did not reproduce                              */
/* -------------------------------------------------------------------------- */

describe("RULED OUT: dry-run disables verify on both the flag and the config path", () => {
  // buildRuntime does `const dryRun = options.dryRun ?? config.dryRun` and
  // only THEN reads `config.verify && !overlay`, so the ordering is right for
  // both entry points. args.ts leaves `dryRun` undefined unless --dry-run or
  // --no-dry-run is present, and main.ts spreads it conditionally, so a bare
  // invocation cannot shadow a config-file `dryRun: true` with `false`.
  it("config dryRun:true disables verify and creates the overlay", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ dryRun: true, verify: "exit 1" }),
    );
    const runtime = await buildTestRuntime(scratch);
    expect(runtime.overlay).toBeDefined();
    expect(runtime.verifier).toBeUndefined();
    expect(runtime.warnings.some((w) => w.includes("verify command is disabled"))).toBe(true);
  });

  it("the --dry-run flag path behaves identically", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ verify: "exit 1" }),
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }], { dryRun: true });
    expect(runtime.overlay).toBeDefined();
    expect(runtime.verifier).toBeUndefined();
  });

  it("--no-dry-run (dryRun:false) does not shadow a config verify command", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ dryRun: true, verify: "exit 1" }),
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }], { dryRun: false });
    expect(runtime.overlay).toBeUndefined();
    expect(runtime.verifier).toBeDefined();
  });
});

describe("RULED OUT: dry-run keeps mutations out of the real tree end to end", () => {
  // The suspicion was that overlay's path rewriting confuses the outer
  // checkpoint wrapper (which resolves the REAL path) or the inner verify
  // wrapper (which runs against the real tree). It does not: checkpoints
  // snapshot the real file's pre-image (harmless, and correct for /rewind),
  // verify is disabled whenever an overlay exists, and the write lands in
  // the shadow tree only.
  it("a write under dry-run leaves the real file alone and shows up in the overlay diff", async () => {
    const scratch = await makeScratch();
    await writeFileAt(join(scratch.cwd, "app.ts"), "before\n");
    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "app.ts", content: "after\n" } },
          ],
        },
        { text: "done" },
      ],
      { dryRun: true, permissionMode: "yolo" },
    );

    await runtime.agent.prompt("edit app.ts");
    await tick(30);

    expect(await readFile(join(scratch.cwd, "app.ts"), "utf8")).toBe("before\n");
    const changes = await runtime.overlay?.changes();
    expect(changes?.map((c) => c.after)).toEqual(["after\n"]);
  });
});

describe("RULED OUT: attachMcpTools' shorter wrapper chain has no observable effect", () => {
  // attachMcpTools applies only taint + hooks (+ checkpoints via setTools),
  // skipping overlay, verify and lsp — a real asymmetry with buildRuntime.
  // It is inert in practice because all three of those wrappers dispatch on
  // an exact tool name ("write"/"edit"/"read"), while every bridged MCP tool
  // is named `mcp__<server>__<tool>` (packages/mcp/src/bridge.ts), so they
  // would each pass the tool through untouched anyway. Taint, which is the
  // layer MCP output actually needs, IS applied — and it matches on the
  // "mcp" name prefix, so it fires.
  it("MCP tools are taint- and hook-wrapped, and the skipped layers are name-keyed no-ops", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }], { dryRun: true });
    let ran = 0;
    runtime.attachMcpTools([
      {
        definition: { name: "mcp__srv__fetch_page", description: "x", inputSchema: {} },
        async execute() {
          ran++;
          return { content: [{ type: "text", text: "hi" }] };
        },
      },
    ]);
    const bridged = runtime.tools.find((t) => t.definition.name === "mcp__srv__fetch_page");
    expect(bridged).toBeDefined();
    // The wrapper chain is present (execute is not the raw function) and the
    // call still reaches the underlying tool.
    await bridged?.execute(
      {},
      {
        cwd: scratch.cwd,
        signal: new AbortController().signal,
        requestPermission: async () => ({ behavior: "allow" }),
        onUpdate: () => {},
        sessionId: runtime.agent.sessionId,
        toolCallId: "t1",
      },
    );
    expect(ran).toBe(1);
  });
});

describe("RULED OUT: replay does not append to the session it replays", () => {
  // runReplayCommand reads the target session's entries with one
  // JsonlSessionStore and then calls buildRuntime(), which mints a FRESH
  // session id for its agent. The replay's turns are appended to that new
  // session file; the original is only ever read.
  it("replaying a session leaves the original file byte-identical", async () => {
    const scratch = await makeScratch();
    const original = await buildTestRuntime(scratch, [{ text: "first answer" }], {
      permissionMode: "yolo",
    });
    await original.agent.prompt("what is 2+2?");
    await tick(20);
    const originalId = original.agent.sessionId;

    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: scratch.env });
    const file = join(paths.sessions, `${originalId}.jsonl`);
    const before = await readFile(file, "utf8");

    const replayRuntime = await buildTestRuntime(scratch, [{ text: "replayed answer" }], {
      permissionMode: "yolo",
    });
    expect(replayRuntime.agent.sessionId).not.toBe(originalId);
    await replayRuntime.agent.prompt("what is 2+2?");
    await tick(20);

    expect(await readFile(file, "utf8")).toBe(before);
  });

  // extractPrompts' structural steering filter, checked against a session
  // produced by a real run rather than hand-built entries: a message steered
  // in while a tool batch was in flight is parented by the toolResult entry
  // and is correctly dropped, while the two genuine prompts survive.
  it("skips a mid-run steering message in a real recorded session", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [{ id: "c1", name: "ls", arguments: { path: "." } }],
          delayMs: 60,
        },
        { text: "all done" },
      ],
      { permissionMode: "yolo" },
    );

    const first = runtime.agent.prompt("original prompt one");
    await tick(20);
    runtime.agent.steer("steered mid-run, not an original prompt");
    await first;
    await tick(20);

    const entries = (await runtime.store.entries(runtime.agent.sessionId)) as SessionEntry[];
    const prompts = extractPrompts(entries);
    expect(prompts).toContain("original prompt one");
    expect(prompts).not.toContain("steered mid-run, not an original prompt");
  });
});

describe("RULED OUT: failover holds back `start` and `usage` correctly", () => {
  // The invariant "never fail over after content has streamed" survives the
  // attacks in the brief: a `usage` event before any content is buffered and
  // discarded with the failed attempt (isContentEvent excludes it), and a
  // tool-call block that has begun streaming sets `produced`, pinning the
  // turn to the current model. The single `start` that reaches the consumer
  // names the model that answers.
  it("a usage event before content does not commit the turn, and start names the answerer", async () => {
    const scratch = await makeScratch();
    const seenStarts: string[] = [];
    const usage: Usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const base: LLMClient = {
      async *stream(request: LLMRequest) {
        const id = request.model.id;
        if (id === "anthropic/claude-opus-4-5") {
          yield { type: "start", model: id } as StreamEvent;
          // Usage BEFORE any content: must not count as output.
          yield { type: "usage", usage } as StreamEvent;
          yield {
            type: "error",
            error: { kind: "overloaded", message: "busy", retryable: true },
            message: {
              role: "assistant",
              content: [],
              model: id,
              usage,
              stopReason: "error",
              timestamp: 0,
            },
          } as StreamEvent;
          return;
        }
        for (const event of textTurn(id, "fallback answered", usage)) yield event;
      },
      async complete() {
        throw new Error("unused");
      },
    };

    const runtime = await buildTestRuntime(scratch, [], {
      model: ["anthropic/claude-opus-4-5", "anthropic/claude-haiku-4-5"],
      llm: {
        stream(request) {
          const inner = base.stream(request);
          return (async function* () {
            for await (const event of inner) {
              if (event.type === "start") seenStarts.push(event.model);
              yield event;
            }
          })();
        },
        complete: base.complete,
      },
      permissionMode: "yolo",
    });

    await runtime.agent.prompt("go");
    await tick(5);
    expect(runtime.agent.finalText()).toContain("fallback answered");
    // Both links emitted a `start` internally; only the answering model's
    // reaches the agent (failover.ts holds the first one back).
    expect(seenStarts).toEqual(["anthropic/claude-opus-4-5", "anthropic/claude-haiku-4-5"]);
    const last = runtime.agent.messages.at(-1) as AssistantMessage;
    expect(last.model).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("RULED OUT: createSubagent inherits the full wrapper chain", () => {
  // createSubagent filters `this.#baseTools`, which buildRuntime already set
  // to the fully-wrapped list (lsp -> verify -> overlay -> taint -> hooks),
  // and then adds the parent's checkpoint store on top — the same shape the
  // parent agent's tools have. A preToolUse hook therefore vetoes a
  // sub-agent's write exactly as it vetoes the parent's.
  it("a preToolUse deny configured for the parent also blocks a sub-agent's write", async () => {
    const scratch = await makeScratch();
    await writeFileAt(join(scratch.cwd, "child.txt"), "original");
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ hooks: { preToolUse: [{ matcher: "write", command: "exit 2" }] } }),
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "ok" }], {
      permissionMode: "yolo",
    });

    const child = runtime.createSubagent("mutate child.txt");
    const writeTool = child.tools.find((t) => t.definition.name === "write");
    expect(writeTool).toBeDefined();
    const result = await writeTool?.execute(
      { path: join(scratch.cwd, "child.txt"), content: "clobbered" },
      {
        cwd: scratch.cwd,
        signal: new AbortController().signal,
        requestPermission: async () => ({ behavior: "allow" }),
        onUpdate: () => {},
        sessionId: child.sessionId,
        toolCallId: "t1",
      },
    );
    expect(result?.isError).toBe(true);
    expect(await readFile(join(scratch.cwd, "child.txt"), "utf8")).toBe("original");
  });
});
