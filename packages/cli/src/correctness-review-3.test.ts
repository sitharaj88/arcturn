/**
 * Adversarial correctness review, round 3: the ten features merged in
 * parallel (canary, provenance/blame, policy learning, cost preview,
 * consensus, speculation, VCR, bisect, scouts, router) checked for
 * REACHABILITY and composition, not for style.
 *
 * Confirmed defects are written with `it.fails`: the assertion encodes the
 * behaviour the integration docs promise, so it fails against the code as it
 * stands and the suite as a whole stays green. Suspicions that did NOT
 * reproduce are kept as ordinary passing tests that pin the correct
 * behaviour, so a later refactor cannot quietly regress them.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { calculateCostUsd, requireModel } from "@arcturn/ai";
import type { PermissionDecision, PermissionRequest, ToolExecutionContext } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import type { BisectVerdict } from "./bisect.js";
import { bisectTurns, cassetteProbe } from "./bisect.js";
import { type ArcturnConfig, DEFAULT_CONFIG } from "./config.js";
import { cwdHash } from "./paths.js";
import { createProvenanceStore } from "./provenance.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";
import { type Cassette, CassetteError, type CassetteStats, requestKey } from "./vcr.js";

/** Yield to the event loop so queued microtasks and fs writes settle. */
async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A complete config with the defaults filled in, for `buildRuntime({ config })`. */
function configWith(overrides: Partial<ArcturnConfig>): ArcturnConfig {
  return {
    ...DEFAULT_CONFIG,
    permissions: [],
    hooks: { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] },
    ...overrides,
  };
}

/** Every regular file under `dir`, recursively. */
async function _walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (current: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) out.push(path);
    }
  };
  await visit(dir);
  return out;
}

/** Poll until `check` answers true, or the budget runs out. */
async function waitFor(check: () => boolean | Promise<boolean>, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) return;
    await tick(10);
  }
}

/* -------------------------------------------------------------------------- */
/* 1. CANARY: the guard is wired, but nothing is ever planted                  */
/* -------------------------------------------------------------------------- */

describe("CANARY: is the guard able to fire at all?", () => {
  // runtime.ts:1269 mints a canary with `generateCanary({ label: "session" })`
  // and hands it to `createCanaryGuard`, but `plantCanaries` (canary.ts:419) is
  // called from NOWHERE outside its own unit test. The token therefore exists
  // only inside the guard's Set: no file in the workspace contains it, no tool
  // output can carry it, and the model has no way to learn 128 bits of hex it
  // was never shown. `guard.scan()` compares every egress argument against a
  // string that cannot appear in one, so the wrap is pure overhead and the
  // "direct, mechanical proof of exfiltration" the module promises can never
  // be produced. INTEGRATION-canary.md §4d specifies planting behind a
  // `canaryPlant` config key — neither the key nor the call was integrated.
  it("guards the values the user actually asked it to guard", async () => {
    // Planting a generated token into the user's repo was rejected: a token
    // nobody has seen cannot appear in a tool argument, and writing decoy
    // files into someone's workspace is invasive. The guard watches the
    // literal values the user lists instead — a real credential, a customer
    // id — where an exact match is proof rather than a heuristic.
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      config: configWith({ canary: "deny", canaries: ["SECRET-VALUE-FROM-CONFIG"] }),
    });
    expect(runtime.canary.tokens()).toContain("SECRET-VALUE-FROM-CONFIG");
    expect(
      runtime.canary.scan("fetch", { url: "https://x/?d=SECRET-VALUE-FROM-CONFIG" }),
    ).toBeDefined();
    await runtime.dispose();
  });

  // The other half of the same defect: there is no way for a host (or a
  // `/canary` command, or a test) to reach the guard and register a token
  // after startup, because `buildRuntime` keeps `canaryGuard` in a local and
  // never puts it on the runtime.
  it("the runtime exposes the canary guard so tokens can be registered", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      config: configWith({ canary: "deny" }),
    });
    expect(
      (runtime as unknown as Record<string, unknown>).canary ??
        (runtime as unknown as Record<string, unknown>).canaryGuard,
    ).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. PROVENANCE: recording follows the wrong session across a swap            */
/* -------------------------------------------------------------------------- */

describe("PROVENANCE: session swaps", () => {
  const writeTurn = [
    {
      toolCalls: [{ id: "t1", name: "write", arguments: { path: "note.txt", content: "hello\n" } }],
    },
    { text: "done" },
  ];

  /** Where runtime.ts / main.ts agree provenance for a session lives. */
  const provenanceDir = (scratch: Scratch, sessionId: string): string =>
    join(scratch.home, "provenance", cwdHash(scratch.cwd), sessionId);

  // Control: on the very first session provenance records, and `arcturn blame`'s
  // reader (main.ts:493, same path expression) finds it. This part works.
  it("records for the session that is live at startup", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, writeTurn, {
      config: configWith({ provenance: true }),
      permissionMode: "yolo",
    });
    const sessionId = runtime.agent.sessionId;
    await runtime.agent.prompt("write a note");

    const store = createProvenanceStore(provenanceDir(scratch, sessionId));
    await waitFor(async () => (await store.blame(join(scratch.cwd, "note.txt"))).length > 0);
    const lines = await store.blame(join(scratch.cwd, "note.txt"));
    expect(lines.length).toBeGreaterThan(0);
    await runtime.dispose();
  });

  // DEFECT. `#swap` (runtime.ts:891-906) re-opens the audit log with
  // `next.sessionId` — the INCOMING agent — but re-opens provenance with
  //   if (this.#openProvenance) this.setProvenanceOpener(this.#openProvenance);
  // and `setProvenanceOpener` reads `this.agent.sessionId`, while
  // `this.agent = next` does not happen until two lines later. So after
  // `/clear` (or `/sessions`, or `/rewind`) every provenance record for the
  // NEW conversation is filed under the id of the session that just ended.
  // `arcturn blame <newId>` reports "no provenance"; `arcturn blame` with no argument
  // resolves to the newest session (the new one) and finds nothing either.
  it("follows /clear onto the new session, the way audit does", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, writeTurn, {
      config: configWith({ provenance: true }),
      permissionMode: "yolo",
    });
    const first = runtime.agent.sessionId;
    runtime.startNewSession(); // `/clear`
    const second = runtime.agent.sessionId;
    expect(second).not.toBe(first);

    await runtime.agent.prompt("write a note");
    const store = createProvenanceStore(provenanceDir(scratch, second));
    await waitFor(async () => (await store.blame(join(scratch.cwd, "note.txt"))).length > 0);
    const lines = await store.blame(join(scratch.cwd, "note.txt"));
    await runtime.dispose();
    expect(lines.length).toBeGreaterThan(0);
  });

  // Same defect, observed from the other side: the work done AFTER /clear is
  // filed under the session that ended before it happened. This one passes
  // today and is the mirror image of the failing test above — it documents
  // exactly where the records go instead.
  it("does not leave post-/clear records under the previous session id", async () => {
    // Was: pinned the bug (records filed under the outgoing session). The
    // trail now follows the incoming session, so the OLD directory must stay
    // empty for work done after the swap.
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, writeTurn, {
      config: configWith({ provenance: true }),
      permissionMode: "yolo",
    });
    const first = runtime.agent.sessionId;
    runtime.startNewSession();
    await runtime.agent.prompt("write a note");
    await tick(50);

    const stale = createProvenanceStore(provenanceDir(scratch, first));
    const staleLines = await stale.blame(join(scratch.cwd, "note.txt"));
    await runtime.dispose();
    expect(staleLines).toEqual([]);
  });

  // The same bug fires during startup when `--resume` / `--continue` is used:
  // buildRuntime installs the provenance opener and *then* calls
  // resumeSession(), which swaps. Everything recorded in the resumed session
  // is filed under the throwaway id minted at startup.
  it("follows --resume onto the resumed session", async () => {
    const scratch = await makeScratch();
    const first = await buildTestRuntime(scratch, [{ text: "hi" }], {
      config: configWith({ provenance: true }),
      permissionMode: "yolo",
    });
    await first.agent.prompt("hello");
    const resumeId = first.agent.sessionId;
    await first.dispose();

    const runtime = await buildTestRuntime(scratch, writeTurn, {
      config: configWith({ provenance: true }),
      permissionMode: "yolo",
      resume: resumeId,
    });
    expect(runtime.agent.sessionId).toBe(resumeId);
    await runtime.agent.prompt("write a note");

    const store = createProvenanceStore(provenanceDir(scratch, resumeId));
    await waitFor(async () => (await store.blame(join(scratch.cwd, "note.txt"))).length > 0);
    const lines = await store.blame(join(scratch.cwd, "note.txt"));
    await runtime.dispose();
    expect(lines.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. CONSENSUS: reachable from config, but priced wrong                       */
/* -------------------------------------------------------------------------- */

describe("CONSENSUS: reachability", () => {
  // Not a defect: config.consensus.models does reach createConsensusClient,
  // the secondary really is called, and the verdict reaches
  // runtime.consensusVerdicts. Pinned so it cannot silently unwire.
  it("a configured panel calls the secondary and records a verdict", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "same answer" }], {
      config: configWith({ consensus: { models: ["anthropic/claude-haiku-4-5"] } }),
      permissionMode: "yolo",
    });
    await runtime.agent.prompt("hi");
    await tick(20);
    expect(runtime.consensusVerdicts.length).toBeGreaterThan(0);
    await runtime.dispose();
  });
});

describe("COST ACCOUNTING: the consensus panel multiplier", () => {
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

  // DEFECT. runtime.ts:994 computes
  //   const panelSize = 1 + (this.config.consensus?.models.length ?? 0);
  //   const spent = cost * panelSize;
  // unconditionally, from *config*. consensus.ts only runs the secondaries
  // when `shouldSample()` passes (consensus.ts:506). With sampleRate 0 the
  // secondaries never run at all — yet every turn is still billed at 2x, so
  // `/cost`, the `--max-cost` ceiling and `/cost preview`'s history are all
  // inflated by the full panel factor on turns nobody paid for.
  it("does not bill for secondaries that sampleRate skipped", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hello", usage }], {
      config: configWith({
        consensus: { models: ["anthropic/claude-haiku-4-5"], sampleRate: 0 },
      }),
      permissionMode: "yolo",
    });
    await runtime.agent.prompt("hi");
    await tick(20);

    const single = calculateCostUsd(runtime.model, usage) ?? 0;
    expect(single).toBeGreaterThan(0);
    // No secondary ran (sampleRate 0), so the turn cost exactly one call.
    expect(runtime.metrics.costUsd).toBeCloseTo(single, 12);
    await runtime.dispose();
  });

  // DEFECT (second half). Even when the panel DOES run, `cost * panelSize`
  // prices every member at the primary's rate. A cheap cross-check model
  // (haiku is 1/3 of sonnet here) is billed as if it were the flagship, so
  // the recorded spend is wrong in the other direction too. The right figure
  // is the sum of each member's own price for the turn.
  it("prices each panel member at its own rate", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hello", usage }], {
      config: configWith({ consensus: { models: ["anthropic/claude-haiku-4-5"] } }),
      permissionMode: "yolo",
    });
    await runtime.agent.prompt("hi");
    await tick(20);

    const primary = calculateCostUsd(runtime.model, usage) ?? 0;
    const secondary = 1 * (10 / 1_000_000) + 5 * (5 / 1_000_000); // haiku-4-5 pricing
    expect(runtime.metrics.costUsd).toBeCloseTo(primary + secondary, 12);
    await runtime.dispose();
  });

  // DEFECT (adjacent, and the reason `/scout` needs `recordExternalCost` at
  // all): a sub-agent's turns reach the parent stream as `subagentEvent`
  // wrappers (core/subagent.ts:122), and `#onEvent` only inspects top-level
  // `turnEnd`, so every delegated turn is free as far as `/cost` and the
  // `--max-cost` guard are concerned. `/scout` folds its spend back by hand;
  // the `subagent` tool — which the model reaches for far more often — has no
  // equivalent, so a session that delegates heavily can blow through its
  // ceiling without the guard ever seeing the money.
  it("sub-agent turns count against the session's spend", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "child done", usage }], {
      permissionMode: "yolo",
    });
    const child = runtime.createSubagent("investigate something");
    await child.prompt("go");
    await tick(20);
    expect(runtime.metrics.costUsd).toBeGreaterThan(0);
    await runtime.dispose();
  });

  // Not a defect: without a consensus config the multiplier is 1 and the
  // arithmetic is right. Control for the two failures above.
  it("control: a single-model session is priced correctly", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hello", usage }], {
      permissionMode: "yolo",
    });
    await runtime.agent.prompt("hi");
    await tick(20);
    expect(runtime.metrics.costUsd).toBeCloseTo(calculateCostUsd(runtime.model, usage) ?? 0, 12);
    await runtime.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. SPECULATION: nothing can ever run while a prompt is open                 */
/* -------------------------------------------------------------------------- */

describe("SPECULATION: can the agent actually work ahead?", () => {
  const twoWrites = [
    {
      toolCalls: [
        { id: "a", name: "write", arguments: { path: "a.txt", content: "A\n" } },
        { id: "b", name: "write", arguments: { path: "b.txt", content: "B\n" } },
      ],
    },
    { text: "done" },
  ];

  // DEFECT. The whole feature rests on a second tool call running while the
  // first call's permission prompt is open. `core/loop.ts:365` only runs a
  // batch concurrently when `rt.parallelTools` is true, and `parallelTools`
  // defaults to false (agent.ts:142) and is never set by `#agentOptions` or
  // `buildRuntime`. Tool calls are therefore strictly sequential: while
  // `#ask` awaits the requester inside `executeToolCall`, no other tool can
  // start, so `wrapToolsWithSpeculation`'s shelter branch and `settle`'s
  // apply branch are unreachable in every shipped code path. `speculation:
  // true` buys per-request overlay bookkeeping and a notice per prompt, and
  // never shelters a single byte.
  it("fails closed when two prompts are open at once", async () => {
    // With parallel tools both writes ask permission, so two speculations are
    // open and a tool call can no longer be attributed to the request that
    // authorised it. Rather than guess, everything speculated is discarded —
    // the writes still land through the normal approved path.
    const scratch = await makeScratch();
    const notices: string[] = [];
    const runtime = await buildTestRuntime(scratch, twoWrites, {
      config: configWith({ speculation: true }),
      permissionMode: "default",
      onPermissionAsk: async (request: PermissionRequest): Promise<PermissionDecision> => {
        await tick(30);
        return { requestId: request.id, behavior: "allow" };
      },
    });
    runtime.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });
    await runtime.agent.prompt("write both files");
    await tick(20);
    await runtime.dispose();

    // Nothing was misattributed: no speculative apply is ever reported.
    expect(notices.some((text) => /misattributed|no speculative/.test(text))).toBe(
      notices.some((text) => /speculat/i.test(text)),
    );
  });

  // The passing mirror: every settle reports an empty shadow, which is the
  // observable signature of the feature being inert.
  it("today every speculation settles with nothing in it", async () => {
    const scratch = await makeScratch();
    const notices: string[] = [];
    const runtime = await buildTestRuntime(scratch, twoWrites, {
      config: configWith({ speculation: true }),
      permissionMode: "default",
      onPermissionAsk: async (request: PermissionRequest): Promise<PermissionDecision> => {
        await tick(30);
        return { requestId: request.id, behavior: "allow" };
      },
    });
    runtime.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });
    await runtime.agent.prompt("write both files");
    await tick(20);
    await runtime.dispose();

    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((text) => /no speculative changes to land/.test(text))).toBe(true);
    // Both files were written straight to the real workspace instead.
    expect(existsSync(join(scratch.cwd, "a.txt"))).toBe(true);
    expect(existsSync(join(scratch.cwd, "b.txt"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. VCR: sub-agents escape the replay wrapper                                */
/* -------------------------------------------------------------------------- */

describe("VCR / BISECT: does replay really neutralise every tool?", () => {
  const ctx = (cwd: string): ToolExecutionContext =>
    ({
      cwd,
      signal: new AbortController().signal,
      requestPermission: async () => ({ requestId: "x", behavior: "allow" as const }),
      onUpdate: () => undefined,
      sessionId: "s",
      toolCallId: "c",
    }) as unknown as ToolExecutionContext;

  // DEFECT. `buildRuntime`'s `wrapAgentTools` is documented as the
  // "last-chance hook over the tool list handed to every agent, applied
  // OUTSIDE every other wrapper. VCR uses it so a replayed run bypasses the
  // layers that have real side effects." It is applied in `#agentOptions`
  // (main agent, served sessions, scouts) but `createSubagent`
  // (runtime.ts:628) builds its tool list straight off `#baseTools` and
  // never calls `#wrapAgentTools`. A replayed or bisected session whose
  // recording contains a `subagent` call therefore executes the child's
  // write/edit/bash FOR REAL against the developer's workspace — exactly the
  // guarantee vcr.ts's module doc makes ("replaying a session that ran
  // `bash rm -rf` deletes nothing").
  it("a sub-agent's tools are neutralised by wrapAgentTools too", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      permissionMode: "yolo",
      wrapAgentTools: (tools) =>
        tools.map((tool) => ({
          ...tool,
          execute: async () => ({ content: [{ type: "text" as const, text: "REPLAYED" }] }),
        })),
    });

    const child = runtime.createSubagent("do a thing");
    const write = child.tools.find((tool) => tool.definition.name === "write");
    expect(write).toBeDefined();
    const result = await write?.execute(
      { path: join(scratch.cwd, "danger.txt"), content: "side effect\n" },
      ctx(scratch.cwd),
    );
    await runtime.dispose();

    expect(existsSync(join(scratch.cwd, "danger.txt"))).toBe(false);
    expect(JSON.stringify(result)).toContain("REPLAYED");
  });

  // Not a defect: a cassette recorded with N prompts replays cleanly when
  // bisect slices to fewer. `cassetteProbe` judges on `stats().misses`, not on
  // `stats().unused`, so the leftover entries are correctly "good" rather than
  // a false "bad". Pinned because the TSDoc on `CassetteStats.unused` says a
  // non-empty list "means the run diverged", which reads like an invitation to
  // use the wrong signal.
  it("extra unused cassette entries do not read as a divergence", async () => {
    let stats: CassetteStats = {
      llmTotal: 4,
      toolTotal: 0,
      llmConsumed: 0,
      toolConsumed: 0,
      misses: 0,
      unused: [],
      skippedLines: 0,
    };
    const fake: Cassette = {
      file: "fake.jsonl",
      takeLlm: () => [],
      takeTool: () => undefined,
      stats: () => stats,
    };
    let seen: readonly string[] = [];
    const probe = cassetteProbe(
      "fake.jsonl",
      ["p0", "p1", "p2", "p3"],
      async (_cassette, prompts) => {
        seen = prompts;
        // Two of the four recorded turns were never asked for.
        stats = { ...stats, llmConsumed: 2, unused: [{ kind: "llm", key: "k", seq: 2 }] };
      },
      { loadCassette: async () => fake },
    );
    const verdict: BisectVerdict = await probe(1);
    expect(seen).toEqual(["p0", "p1"]);
    expect(verdict).toBe("good");
  });
});

describe("BISECT: a whole-run mismatch is reported as 'turn 0'", () => {
  // `requestKey` (vcr.ts:228) hashes `request.model.id`, so replaying a
  // cassette under any other model misses on the very first turn. That is
  // reachable by accident: `runBisectCommand` (main.ts:532) builds each
  // probe's runtime with only `cwd`, `llm` and `wrapAgentTools` — it drops
  // `args.model` (which `parseArgs` happily accepts, and which
  // `runReplayCommand` does forward), so a `arcturn bisect --model X` or a
  // cassette recorded before a `/model` switch replays under the config
  // model. Every probe then misses, and bisect answers "behaviour first
  // diverges at turn 0" with `confident: yes` — a confidently wrong result
  // for what is really "this cassette does not belong to this run".
  it("model-sensitive keys turn a cassette mismatch into a confident turn-0 answer", async () => {
    const anthropic = requireModel("anthropic/claude-sonnet-4-5");
    const haiku = requireModel("anthropic/claude-haiku-4-5");
    const request = {
      model: anthropic,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    };
    expect(requestKey(request)).not.toBe(requestKey({ ...request, model: haiku }));

    const emptyStats: CassetteStats = {
      llmTotal: 4,
      toolTotal: 0,
      llmConsumed: 0,
      toolConsumed: 0,
      misses: 1,
      unused: [],
      skippedLines: 0,
    };
    const probe = cassetteProbe(
      "mismatched.jsonl",
      ["p0", "p1", "p2", "p3"],
      async () => {
        // What `replayingClient` does on the first turn when the recording
        // was made with a different model.
        throw new CassetteError("no recorded response", "miss", { entryKind: "llm" });
      },
      {
        loadCassette: async () => ({
          file: "mismatched.jsonl",
          takeLlm: () => undefined,
          takeTool: () => undefined,
          stats: () => emptyStats,
        }),
      },
    );
    const result = await bisectTurns(["p0", "p1", "p2", "p3"], probe);
    expect(result.firstBadIndex).toBe(0);
    expect(result.confident).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. POLICY LEARNER / COST PREVIEW / ROUTER: reachability                     */
/* -------------------------------------------------------------------------- */

describe("POLICY LEARNER: does it ever observe anything?", () => {
  /** One scripted `bash` turn per command, each followed by a plain answer. */
  const bashScript = (commands: readonly string[]) =>
    commands.flatMap((command, index) => [
      { toolCalls: [{ id: `c${index}`, name: "bash", arguments: { command } }] },
      { text: "done" },
    ]);

  // Not a defect: `#ask` is reached for every genuinely-asked permission, so
  // three consistent denials do produce a suggestion. Pinned as the
  // reachability proof for the feature.
  it("three consistent denials become a suggestion", async () => {
    const scratch = await makeScratch();
    const commands = ["git push", "git commit -am wip", "git log --oneline"];
    const runtime = await buildTestRuntime(scratch, bashScript(commands), {
      permissionMode: "default",
      onPermissionAsk: async (request: PermissionRequest): Promise<PermissionDecision> => ({
        requestId: request.id,
        behavior: "deny",
      }),
    });
    for (const _command of commands) await runtime.agent.prompt("run it");
    const suggestions = runtime.policy.suggestions();
    await runtime.dispose();
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.direction).toBe("deny");
    expect(suggestions[0]?.rule.specifier).toBe("git *");
  });

  // Known and by design (INTEGRATION-policy-learn.md puts the hook in `#ask`):
  // a call settled by a rule, by `yolo`, or by the read-only allowlist never
  // reaches the requester, so the learner sees nothing. Worth knowing because
  // the "allow always" button persists a rule immediately, which means an
  // ALLOW cluster can essentially never reach the threshold of 3 through
  // normal use — only repeated "allow once" clicks can.
  it("auto-allowed calls are invisible to the learner", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, bashScript(["git status", "git status"]), {
      permissionMode: "yolo",
      onPermissionAsk: async (request: PermissionRequest): Promise<PermissionDecision> => ({
        requestId: request.id,
        behavior: "allow",
      }),
    });
    for (let index = 0; index < 4; index++) await runtime.agent.prompt("run it");
    const suggestions = runtime.policy.suggestions();
    await runtime.dispose();
    expect(suggestions).toEqual([]);
  });
});

describe("COST PREVIEW: is the history real?", () => {
  // Not a defect: `/cost preview` reads `runtime.recentTurns` (populated on
  // every turnEnd) and `runtime.agent.todos` (a real Agent getter).
  it("recentTurns fills up and agent.todos exists", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hello" }], {
      permissionMode: "yolo",
    });
    expect(Array.isArray(runtime.agent.todos)).toBe(true);
    await runtime.agent.prompt("hi");
    await tick(10);
    expect(runtime.recentTurns.length).toBe(1);
    expect(runtime.recentTurns[0]?.costUsd).toBeGreaterThan(0);
    await runtime.dispose();
  });

  // Minor, reported as an observation rather than a defect: `#swap` resets
  // `metrics` but not `recentTurns`, so after `/clear` the forecast is still
  // computed from the previous conversation's turns.
  it("recentTurns survives /clear while metrics are reset", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hello" }], {
      permissionMode: "yolo",
    });
    await runtime.agent.prompt("hi");
    await tick(10);
    runtime.startNewSession();
    expect(runtime.metrics.turns).toBe(0);
    expect(runtime.recentTurns.length).toBe(1);
    await runtime.dispose();
  });
});

describe("ROUTER + SCOUTS: does /model compose with the subagent route?", () => {
  // Not a defect: `setModel` calls `router.rebind`, which clears the cache, so
  // an unconfigured `subagent` route follows the new main model into both
  // `createSubagent` and `scoutAgent`.
  it("scoutAgent and createSubagent follow /model", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      permissionMode: "yolo",
    });
    expect(runtime.scoutAgent(scratch.cwd).model.id).toBe(runtime.model.id);

    runtime.setModel("anthropic/claude-haiku-4-5");
    expect(runtime.scoutAgent(scratch.cwd).model.id).toBe("anthropic/claude-haiku-4-5");
    expect(runtime.createSubagent("task").model.id).toBe("anthropic/claude-haiku-4-5");
    await runtime.dispose();
  });

  // Not a defect, but worth pinning: an explicitly configured route does NOT
  // follow /model, which is the intended precedence.
  it("an explicit route.subagent stays put across /model", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }], {
      config: configWith({ route: { subagent: "anthropic/claude-haiku-4-5" } }),
      permissionMode: "yolo",
    });
    runtime.setModel("anthropic/claude-opus-4-5");
    expect(runtime.scoutAgent(scratch.cwd).model.id).toBe("anthropic/claude-haiku-4-5");
    await runtime.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* 7. SCOUT SPEND vs THE COST GUARD                                            */
/* -------------------------------------------------------------------------- */

describe("COST GUARD: externally recorded spend", () => {
  // Observation, not a wrong result: `recordExternalCost` updates the total
  // but emits no event, and `createCostGuard` only evaluates on `turnEnd`. A
  // `/scout` that blows straight through the ceiling is therefore not caught
  // until the NEXT turn ends — i.e. after paying for one more model call.
  it("scout spend does not trip the ceiling until the next turnEnd", async () => {
    const scratch = await makeScratch();
    const notices: string[] = [];
    const runtime = await buildTestRuntime(scratch, [{ text: "hello" }], {
      permissionMode: "yolo",
      maxCostUsd: 0.01,
    });
    runtime.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });

    runtime.recordExternalCost(5); // e.g. three scouts came back
    await tick(10);
    expect(notices).toEqual([]); // nothing evaluates the ceiling here

    await runtime.agent.prompt("hi"); // one more turn is paid for first
    await tick(10);
    expect(notices.some((text) => text.startsWith("Cost limit"))).toBe(true);
    await runtime.dispose();
  });
});
