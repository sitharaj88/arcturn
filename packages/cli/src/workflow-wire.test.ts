/**
 * `/workflow` end to end on the real serve path.
 *
 * A real {@link ArcturnRuntime} over a scripted LLM, a real
 * {@link createServeHost}, a real {@link ArcturnServer} on a real port, a real
 * {@link createProtocolClient}, and **real workflow files and role files on
 * disk** under a scratch home.
 *
 * ## What these assertions are on
 *
 * **The run journal, not the response.** A `runWorkflow` that answered with a
 * plausible-looking handle while nothing ran is precisely the failure this
 * verb's degradation rule exists to prevent, so nothing here is satisfied by a
 * call returning: every claim about a run is read back through
 * `workflowStatus`, which folds the append-only journal the engine wrote — the
 * same file `/workflow status` prints from.
 *
 * **The lane is derived.** The catalog's headline guarantee is that a role's
 * lane comes from `roleDispatch` over the role file's declared `tools:`, never
 * from what the file's prose claims. The fixtures below therefore include a
 * role whose description says one thing and whose tools say another.
 *
 * **The ceilings bind.** Two of them, over the wire: the workflow file's own
 * `budgetUsd:` aborts a run that crosses it, and a request to *raise* it is
 * refused rather than clamped.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProtocolClient } from "@arcturn/protocol";
import { ArcturnServer } from "@arcturn/server";
import type { AgentEvent } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AgentDef } from "./agents.js";
import type { ArcturnRuntime } from "./runtime.js";
import { createServeHost } from "./serve.js";
import { deriveRoleLane, resolveRunBudget, stricterMode } from "./serve-workflows.js";
import type { ScriptedTurn } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";

const servers: ArcturnServer[] = [];
const closers: (() => void)[] = [];
const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0)) await server.stop();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

interface Harness {
  runtime: ArcturnRuntime;
  client: ReturnType<typeof createProtocolClient>;
  sessionId: string;
  events: AgentEvent[];
  /** Every `notice` text the run published, in arrival order. */
  notices: () => string[];
}

/** Write a workflow file into the scratch home's user-scope workflow root. */
async function writeWorkflow(scratch: Scratch, name: string, body: string): Promise<void> {
  const dir = join(scratch.home, "workflows");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body, "utf8");
}

/** Write a markdown role file into the scratch home's agent root. */
async function writeRole(scratch: Scratch, name: string, body: string): Promise<void> {
  const dir = join(scratch.home, "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body, "utf8");
}

/** Real runtime → real serve host → real server → real connected client. */
async function serve(
  scratch: Scratch,
  turns: readonly ScriptedTurn[] = [{ text: "step output" }],
  options: { allowCeilingRaise?: boolean; token?: string } = {},
): Promise<Harness> {
  const runtime = await buildTestRuntime(scratch, turns, { permissionMode: "yolo" });
  runtimes.push(runtime);
  const server = new ArcturnServer({
    sessionHost: createServeHost(runtime, {
      allowCeilingRaise: options.allowCeilingRaise === true,
    }),
    ...(options.token === undefined ? {} : { token: options.token }),
    capabilities: { ceilingRaise: options.allowCeilingRaise === true },
  });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`), {
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  closers.push(() => client.close());
  const events: AgentEvent[] = [];
  client.onEvent((_id, event) => events.push(event));
  const header = await client.createSession({ cwd: runtime.cwd });
  await client.openSession(header.sessionId);
  return {
    runtime,
    client,
    sessionId: header.sessionId,
    events,
    notices: () =>
      events
        .filter(
          (event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice",
        )
        .map((event) => event.text),
  };
}

/** States a run does not leave on its own. */
const TERMINAL = new Set(["done", "failed", "cancelled", "paused"]);

/**
 * Poll `workflowStatus` until the journal shows a terminal state.
 *
 * Polling the *journal* rather than awaiting the `runWorkflow` response is the
 * point: the verb answers on acceptance, so the only honest way to ask "did it
 * actually run" is to read the record the engine wrote.
 */
async function settled(
  client: ReturnType<typeof createProtocolClient>,
  runId: string,
  // A resumed run's journal still shows the *previous* terminal state until the
  // continuation lands, so a caller that resumed says which state it is waiting
  // for rather than accepting the stale one.
  want: (state: string) => boolean = (state) => TERMINAL.has(state),
  attempts = 200,
): Promise<NonNullable<Awaited<ReturnType<typeof client.workflowStatus>>>["runs"][number]> {
  let last = "(never journalled)";
  for (let i = 0; i < attempts; i += 1) {
    const answer = await client.workflowStatus(runId);
    const run = answer?.runs[0];
    if (run) {
      last = run.state;
      if (want(run.state)) return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never reached the wanted state (last: ${last})`);
}

describe("listWorkflows over the wire", () => {
  it("reports each pipeline's shape, its ceilings, and the lane the engine DERIVES for every role", async () => {
    const scratch = await makeScratch();
    // Four roles, one per lane the classifier can reach, plus one the file
    // names and nobody defines.
    await writeRole(
      scratch,
      "auditor",
      "---\nname: auditor\ndescription: Reads only\ntools: read, grep\n---\nAudit.\n",
    );
    await writeRole(
      scratch,
      "runner",
      "---\nname: runner\ndescription: Runs the suite\ntools: read, bash\n---\nRun it.\n",
    );
    await writeRole(
      scratch,
      // The whole point of deriving rather than quoting: this file *says* it
      // only reads, and its `tools:` say it can write. The catalog must report
      // what the dispatcher will do, not what the prose claims.
      "editor",
      "---\nname: editor\ndescription: A harmless read-only reviewer\ntools: read, edit\n---\nEdit.\n",
    );
    await writeRole(
      scratch,
      "silent",
      "---\nname: silent\ndescription: Declares no tools at all\n---\nSilent.\n",
    );
    await writeWorkflow(
      scratch,
      "lanes",
      [
        "---",
        "name: lanes",
        "description: One step per lane",
        "budgetUsd: 12.5",
        "stepTimeoutMs: 90000",
        "---",
        "1. @auditor Audit: {{input}}",
        "2. @runner Run: {{prev}}",
        "3. @editor Edit: {{prev}}",
        "4. @silent Nothing: {{prev}}",
        "5. @ghost Missing: {{prev}}",
        "",
      ].join("\n"),
    );

    const harness = await serve(scratch);
    const catalog = await harness.client.listWorkflows();

    expect(catalog).toBeDefined();
    const lanes = catalog?.workflows.find((workflow) => workflow.name === "lanes");
    expect(lanes).toMatchObject({
      name: "lanes",
      description: "One step per lane",
      stages: 5,
      steps: 5,
      budgetUsd: 12.5,
      stepTimeoutMs: 90_000,
    });
    expect(lanes?.source).toContain(join("workflows", "lanes.md"));
    // The derived value, in written order, deduplicated.
    expect(lanes?.roles).toEqual([
      { name: "auditor", lane: "read" },
      { name: "runner", lane: "exec" },
      // Declared `edit`, described itself as a read-only reviewer. The wire
      // reports the tools.
      { name: "editor", lane: "write" },
      // Loaded, but declares no `tools:` — dispatch refuses it, so the catalog
      // says so rather than rounding down to "read".
      { name: "silent", lane: "undeclared" },
      // Named by the file and defined nowhere: the run fails pre-flight.
      { name: "ghost", lane: "unknown" },
    ]);
  });

  it("carries no budget field for a workflow that declares none", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(scratch, "plain", "---\nname: plain\n---\n1. Do a thing: {{input}}\n");
    const harness = await serve(scratch);
    const catalog = await harness.client.listWorkflows();
    const plain = catalog?.workflows.find((workflow) => workflow.name === "plain");
    expect(plain?.budgetUsd).toBeUndefined();
    expect(plain?.roles).toEqual([]);
  });
});

describe("runWorkflow over the wire", () => {
  it("actually runs the pipeline — the journal, not the response, says so", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "two-stage",
      [
        "---",
        "name: two-stage",
        "description: Two ordinary steps",
        "---",
        "1. First: {{input}}",
        "2. Second: {{prev}}",
        "",
      ].join("\n"),
    );
    const harness = await serve(scratch, [{ text: "stage said something" }]);

    const handle = await harness.client.runWorkflow(harness.sessionId, "two-stage", {
      input: "the retry test flakes",
    });
    expect(handle).toMatchObject({
      workflow: "two-stage",
      sessionId: harness.sessionId,
      stages: 2,
      steps: 2,
      resumed: false,
    });
    expect(handle.runId).not.toBe("");

    const run = await settled(harness.client, handle.runId);
    // The run journal the engine wrote — the same file `/workflow status` reads.
    expect(run.state).toBe("done");
    expect(run.workflow).toBe("two-stage");
    expect(run.stepsTotal).toBe(2);
    expect(run.stepsDone).toBe(2);
    expect(run.steps?.map((step) => [step.id, step.status])).toEqual([
      ["1", "done"],
      ["2", "done"],
    ]);
    // And the run narrated onto the session stream this client was already
    // subscribed to — no second channel was opened.
    const notices = harness.notices();
    expect(notices.some((line) => line.includes("Workflow two-stage: 2 step(s)"))).toBe(true);
    expect(notices.some((line) => line.startsWith("Step 1"))).toBe(true);
    expect(notices.some((line) => line.startsWith("Step 2"))).toBe(true);
    expect(notices.some((line) => line.includes("stage said something"))).toBe(true);
  });

  it("refuses a workflow this engine does not have, and names the ones it does", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(scratch, "known", "---\nname: known\n---\n1. Do: {{input}}\n");
    const harness = await serve(scratch);
    await expect(harness.client.runWorkflow(harness.sessionId, "nope")).rejects.toThrow(/known/);
  });
});

describe("the run budget binds over the wire", () => {
  it("aborts a run that crosses the workflow file's OWN budgetUsd, and skips every later stage", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "spendy",
      [
        "---",
        "name: spendy",
        "description: Crosses its own ceiling on stage 1",
        "budgetUsd: 0.01",
        "---",
        "1. First: {{input}}",
        "2. Second: {{prev}}",
        "3. Third: {{prev}}",
        "",
      ].join("\n"),
    );
    // One dollar a turn against a one-cent ceiling.
    const harness = await serve(scratch, [{ text: "expensive", usage: { costUsd: 1 } }]);

    const handle = await harness.client.runWorkflow(harness.sessionId, "spendy", { input: "go" });
    expect(handle.budgetUsd).toBe(0.01);

    const run = await settled(harness.client, handle.runId);
    expect(run.state).toBe("failed");
    // Stage 1 ran and the ceiling tripped. Stages 2 and 3 never started, so the
    // journal has no row for them at all — a stronger fact than "skipped": the
    // engine did not merely mark them, it never reached them.
    expect(run.steps?.map((step) => [step.id, step.status])).toEqual([["1", "done"]]);
    expect(run.spentUsd ?? 0).toBeGreaterThanOrEqual(1);
    expect(harness.notices().some((line) => line.includes("exceeded its $0.01 run budget"))).toBe(
      true,
    );
    // …and every later stage is reported skipped on the run's own report.
    expect(harness.notices().some((line) => line.includes("Workflow spendy: failed"))).toBe(true);
  });

  it("refuses a wire budget that would RAISE the file's ceiling, naming both numbers", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "capped",
      "---\nname: capped\nbudgetUsd: 5\n---\n1. Do: {{input}}\n",
    );
    const harness = await serve(scratch);

    await expect(
      harness.client.runWorkflow(harness.sessionId, "capped", { budgetUsd: 500 }),
    ).rejects.toThrow(/may only lower that ceiling/);
    await expect(
      harness.client.runWorkflow(harness.sessionId, "capped", { budgetUsd: 500 }),
    ).rejects.toThrow(/5\.00/);

    // Nothing was started by the refusal — no journal, and the session is not
    // left wedged as "already running a workflow".
    const runs = await harness.client.workflowStatus();
    expect(runs?.runs ?? []).toEqual([]);
  });

  it("honours a LOWER wire budget, and that lowered ceiling is what actually aborts the run", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "generous",
      [
        "---",
        "name: generous",
        "budgetUsd: 100",
        "---",
        "1. First: {{input}}",
        "2. Second: {{prev}}",
        "",
      ].join("\n"),
    );
    const harness = await serve(scratch, [{ text: "expensive", usage: { costUsd: 1 } }]);

    const handle = await harness.client.runWorkflow(harness.sessionId, "generous", {
      budgetUsd: 0.02,
    });
    // The handle reports the ceiling in force, not the one the file declares.
    expect(handle.budgetUsd).toBe(0.02);

    const run = await settled(harness.client, handle.runId);
    expect(run.state).toBe("failed");
    // Stage 2 never started: the caller's own ceiling stopped the run, on a
    // file whose declared ceiling ($100) would have let it continue.
    expect(run.steps?.map((step) => step.id)).toEqual(["1"]);
    expect(harness.notices().some((line) => line.includes("$0.02 run budget"))).toBe(true);
  });

  it("refuses a non-positive budget at the wire boundary — 0 disables the guard", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(scratch, "any", "---\nname: any\nbudgetUsd: 3\n---\n1. Do: {{input}}\n");
    const harness = await serve(scratch);
    await expect(
      harness.client.runWorkflow(harness.sessionId, "any", { budgetUsd: 0 }),
    ).rejects.toThrow(/positive number/);
  });
});

describe("workflowStatus over the wire", () => {
  it("lists runs without their step rows, and one run with them", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(scratch, "one", "---\nname: one\n---\n1. Do: {{input}}\n");
    const harness = await serve(scratch);
    const handle = await harness.client.runWorkflow(harness.sessionId, "one", { input: "x" });
    await settled(harness.client, handle.runId);

    const listing = await harness.client.workflowStatus();
    expect(listing?.runs).toHaveLength(1);
    expect(listing?.runs[0]?.steps).toBeUndefined();
    expect(listing?.runs[0]?.runId).toBe(handle.runId);

    const detail = await harness.client.workflowStatus(handle.runId);
    expect(detail?.runs[0]?.steps).toHaveLength(1);
  });

  it("answers an unknown run id with zero rows rather than an error a client would misread", async () => {
    const scratch = await makeScratch();
    const harness = await serve(scratch);
    // Zero rows, not an error: on this wire an error from a read is read as
    // "this engine is too old" and collapsed to `undefined`, which would make
    // "no such run" and "no such verb" the same news.
    const missing = await harness.client.workflowStatus("no-such-run");
    expect(missing).toBeDefined();
    expect(missing?.runs).toEqual([]);
    expect((await harness.client.workflowStatus())?.runs).toEqual([]);
  });
});

describe("the ORG-ASK gate over the wire", () => {
  it("pauses the run, publishes the question, reports it in status, and resumes with the answer", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "gated",
      [
        "---",
        "name: gated",
        "description: Stage 1 asks a human",
        "---",
        "1. Ask: {{input}}",
        "2. Decide: {{prev}}",
        "",
      ].join("\n"),
    );
    // Stage 1's agent emits an ORG-ASK line; every later turn answers plainly.
    const harness = await serve(scratch, [
      { text: "ORG-ASK: per-tenant or per-user sessions?" },
      { text: "decided: per-tenant" },
    ]);

    const handle = await harness.client.runWorkflow(harness.sessionId, "gated", { input: "go" });
    const paused = await settled(harness.client, handle.runId);

    expect(paused.state).toBe("paused");
    expect(paused.questions).toEqual([
      { stepId: "1", question: "per-tenant or per-user sessions?" },
    ]);
    expect(harness.notices().some((line) => line.includes("paused for a human answer"))).toBe(true);

    // Resuming with no answer is refused, and re-surfaces the question rather
    // than guessing at one.
    await expect(harness.client.resumeWorkflow(harness.sessionId, handle.runId)).rejects.toThrow(
      /needs an answer/,
    );

    const resumed = await harness.client.resumeWorkflow(
      harness.sessionId,
      handle.runId,
      "per-tenant",
    );
    expect(resumed).toMatchObject({ runId: handle.runId, workflow: "gated", resumed: true });

    const done = await settled(harness.client, handle.runId, (state) => state === "done");
    expect(done.questions).toEqual([]);
    // Stage 2 ran on the resumed pass; stage 1 settled from the human's answer
    // rather than being executed a second time.
    expect(done.steps?.find((step) => step.id === "2")?.status).toBe("done");
  });

  it("refuses to resume a run that already finished", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(scratch, "quick", "---\nname: quick\n---\n1. Do: {{input}}\n");
    const harness = await serve(scratch);
    const handle = await harness.client.runWorkflow(harness.sessionId, "quick", { input: "x" });
    await settled(harness.client, handle.runId);
    await expect(harness.client.resumeWorkflow(harness.sessionId, handle.runId)).rejects.toThrow(
      /already finished/,
    );
  });
});

describe("the step-failure park over the wire", () => {
  /** A read-lane role with a two-turn ceiling, and a workflow that uses it. */
  async function ragFixture(scratch: Scratch): Promise<void> {
    await writeRole(
      scratch,
      "indexer",
      "---\nname: indexer\ndescription: Builds indexes\ntools: read, grep\nmaxTurns: 2\n---\nIndex.\n",
    );
    await writeWorkflow(
      scratch,
      "rag",
      ["---", "name: rag", "---", "1. First: {{input}}", "2. @indexer Index: {{prev}}", ""].join(
        "\n",
      ),
    );
  }

  /** The model turn that keeps a role asking for another turn, forever. */
  const looping = { toolCalls: [{ id: "c", name: "grep", arguments: { pattern: "x" } }] };

  it("parks on a turn ceiling, refuses a wire raise and a nudge, and accepts retry", async () => {
    const scratch = await makeScratch();
    await ragFixture(scratch);
    // Stage 1 lands in one turn; stage 2's role then loops until its two-turn
    // ceiling — the ceiling is the only thing that can end it, which is the
    // condition this park exists for. The fourth turn is the retry's, and it
    // lands the plane.
    const harness = await serve(scratch, [
      { text: "the survey" },
      looping,
      looping,
      { text: "indexed" },
    ]);

    const handle = await harness.client.runWorkflow(harness.sessionId, "rag", { input: "go" });
    const parked = await settled(harness.client, handle.runId);
    // FAIL-FIRST: pre-change stage 2's ceiling wrote `runEnd{failed}` and this
    // read "failed" — a corpse both resume verbs refuse forever, with stage 1
    // already paid for. Parked, it is a resumable question.
    expect(parked.state).toBe("paused");
    expect(parked.questions).toHaveLength(1);
    expect(parked.questions[0]?.stepId).toBe("2");
    expect(parked.questions[0]?.question).toContain("ran out of turns");
    // The diagnosis and raise metadata land on the wire regardless of whether
    // this server allows a raise — only the ANSWER is gated by the flag. A
    // client with no ceiling-raise capability still gets to render "what did
    // the model do" and "there is a ceiling here", it just has nothing to
    // offer for the second one.
    expect(parked.questions[0]?.diagnosis).toContain("tool calls: grep");
    expect(parked.questions[0]?.diagnosis).toContain("no text");
    expect(parked.questions[0]?.raise).toEqual({ kind: "turns", current: 2 });
    // The wire is never told to send the one reply it will only be refused for.
    expect(parked.questions[0]?.question).not.toContain("raise <n>");
    expect(parked.questions[0]?.question).toContain('Reply "retry"');
    expect(parked.questions[0]?.question).toContain("the wire cannot raise a turn ceiling");

    // THE CONTRACT: nothing on the wire may lift a ceiling — a dollar one, a
    // token one, or a turn one. `answer: "raise 99"` is refused, not threaded
    // through and not clamped, and nothing starts.
    await expect(
      harness.client.resumeWorkflow(harness.sessionId, handle.runId, "raise 99"),
    ).rejects.toThrow(/turn ceiling cannot be raised over the wire/);
    expect((await harness.client.workflowStatus(handle.runId))?.runs[0]?.state).toBe("paused");

    // A *bare* resume is a nudge, and a retry is money: refused too.
    await expect(harness.client.resumeWorkflow(harness.sessionId, handle.runId)).rejects.toThrow(
      /needs an answer, not a nudge/,
    );
    expect((await harness.client.workflowStatus(handle.runId))?.runs[0]?.state).toBe("paused");

    // `retry` IS answerable over the wire, and it re-runs only the broken step.
    const retried = await harness.client.resumeWorkflow(harness.sessionId, handle.runId, "retry");
    expect(retried).toMatchObject({ runId: handle.runId, resumed: true });
    const finished = await settled(harness.client, handle.runId, (state) => state === "done");
    expect(finished.state).toBe("done");
    const steps = (await harness.client.workflowStatus(handle.runId, { steps: true }))?.runs[0]
      ?.steps;
    expect(steps?.find((step) => step.id === "1")?.status).toBe("done");
    expect(steps?.find((step) => step.id === "2")?.status).toBe("done");
    // Stage 1 was reused, not redone — and the proof is the script: the retry
    // consumed the FOURTH scripted turn ("indexed"). A re-executed stage 1
    // would have eaten that turn itself and left stage 2 looping into its
    // ceiling again, which is a `paused`, not the `done` asserted above.
    // (`orchestration-effects.test.ts` counts the requests directly.)
  });

  it("ends the run failed on abandon, and it is then genuinely unresumable", async () => {
    const scratch = await makeScratch();
    await ragFixture(scratch);
    const harness = await serve(scratch, [{ text: "the survey" }, looping]);

    const handle = await harness.client.runWorkflow(harness.sessionId, "rag", { input: "go" });
    expect((await settled(harness.client, handle.runId)).state).toBe("paused");

    // The tombstone, chosen rather than imposed.
    await harness.client.resumeWorkflow(harness.sessionId, handle.runId, "abandon");
    const dead = await settled(harness.client, handle.runId, (state) => state === "failed");
    expect(dead.state).toBe("failed");
    // The `stop` label the ceiling earned, written where the run really stops.
    expect(dead.stopReason).toBe("turn-ceiling");
    await expect(
      harness.client.resumeWorkflow(harness.sessionId, handle.runId, "retry"),
    ).rejects.toThrow(/already finished \(failed\); nothing to resume/);
  });
});

describe("the stage-boundary budget ask over the wire", () => {
  it("parks before the hard stop, refuses a wire raise, and runs on to the hard ceiling once acknowledged", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "asky",
      [
        "---",
        "name: asky",
        "budgetUsd: 1",
        "---",
        "1. First: {{input}}",
        "2. Second: {{prev}}",
        "",
      ].join("\n"),
    );
    // Each stage costs $0.90: stage 1 lands the run at 90% of its ceiling
    // with a stage remaining, and stage 2 would cross it.
    const harness = await serve(scratch, [{ text: "pricey output", usage: { costUsd: 0.9 } }]);

    const handle = await harness.client.runWorkflow(harness.sessionId, "asky", { input: "go" });
    const parked = await settled(harness.client, handle.runId);
    // FAIL-FIRST: pre-change this run executed stage 2, crossed $1.00 and
    // read "failed" here — a `runEnd{failed}` both resume verbs refuse
    // permanently. Parked, it is a resumable question instead of a corpse.
    expect(parked.state).toBe("paused");
    expect(parked.questions).toHaveLength(1);
    expect(parked.questions[0]?.stepId).toBe("budget");
    expect(parked.questions[0]?.question).toContain("$0.90 of its $1.00 run budget");
    // A budget ask has no "last turn" of its own — it fires at a stage
    // boundary, not on a step's failure — so it carries no `diagnosis`, only
    // the `raise` shape a client needs to know a raise would apply here.
    expect(parked.questions[0]?.diagnosis).toBeUndefined();
    expect(parked.questions[0]?.raise).toEqual({ kind: "budget", current: 1 });
    // FAIL-FIRST: the question told every reader to `raise <new-limit>` — the
    // one reply this origin is forbidden to send. An automation that followed
    // its own question's instructions looped on refusals forever.
    expect(parked.questions[0]?.question).not.toContain("raise <new-limit>");
    expect(parked.questions[0]?.question).toContain('Reply "continue"');
    expect(parked.questions[0]?.question).toContain("the wire cannot raise a ceiling");

    // THE CONTRACT: nothing on the wire may raise a ceiling. `answer:
    // "raise 999"` on the pending budget ask is refused, naming the contract —
    // not threaded through, not clamped, and nothing starts.
    await expect(
      harness.client.resumeWorkflow(harness.sessionId, handle.runId, "raise 999"),
    ).rejects.toThrow(/cannot be raised over the wire/);
    const still = await harness.client.workflowStatus(handle.runId);
    expect(still?.runs[0]?.state).toBe("paused");

    // FAIL-FIRST: a *bare* resume used to write the durable acknowledgement
    // the engine calls the operator's consent on record. It is a nudge, and
    // the run stays exactly where it was — the same line the role-pause gate
    // holds three functions up.
    await expect(harness.client.resumeWorkflow(harness.sessionId, handle.runId)).rejects.toThrow(
      /needs an answer, not a nudge/,
    );
    expect((await harness.client.workflowStatus(handle.runId))?.runs[0]?.state).toBe("paused");

    // The acknowledgement IS answerable over the wire. The run continues, and
    // the ceiling that stops it is the file's own $1.00 — not 999 — which is
    // the proof no raise landed.
    const resumed = await harness.client.resumeWorkflow(
      harness.sessionId,
      handle.runId,
      "continue",
    );
    expect(resumed).toMatchObject({ runId: handle.runId, resumed: true });
    const done = await settled(harness.client, handle.runId, (state) => state === "failed");
    expect(done.state).toBe("failed");
    expect(done.stopReason).toBe("cost-ceiling");
    expect(harness.notices().some((line) => line.includes("exceeded its $1.00 run budget"))).toBe(
      true,
    );
  });

  it("keeps the ceiling the CLIENT lowered to, across the resume its own ask invites", async () => {
    // FAIL-FIRST — and this is the hole the acknowledged resume opened. A
    // wire run is enforced against a bounded *copy* of the parsed workflow
    // (`{...workflow, budgetUsd: requested}`), which lives only in memory;
    // `resume` rediscovers the workflow from disk and got the file's FULL
    // ceiling back. So: file $1.00, client lowers to $0.50, the run parks at
    // its ask, the client sends the acknowledgement the refusal text itself
    // recommends — and the run continued under $1.00, twice the cap the wire
    // had just been told it could not raise. Pre-change this run reported
    // "done" at $0.90; the lowered ceiling has to bind here.
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "capped",
      [
        "---",
        "name: capped",
        "budgetUsd: 1",
        "---",
        "1. First: {{input}}",
        "2. Second: {{prev}}",
        "",
      ].join("\n"),
    );
    // $0.45 a stage: 90% of the client's $0.50 after stage 1, and $0.90 after
    // stage 2 — over $0.50, comfortably under the file's $1.00.
    const harness = await serve(scratch, [{ text: "output", usage: { costUsd: 0.45 } }]);

    const handle = await harness.client.runWorkflow(harness.sessionId, "capped", {
      input: "go",
      budgetUsd: 0.5,
    });
    expect(handle.budgetUsd).toBe(0.5);
    const parked = await settled(harness.client, handle.runId);
    expect(parked.state).toBe("paused");
    // The question is stated against the ceiling actually in force.
    expect(parked.questions[0]?.question).toContain("$0.45 of its $0.50 run budget");

    const resumed = await harness.client.resumeWorkflow(
      harness.sessionId,
      handle.runId,
      "continue",
    );
    // The resumed run reports the ceiling it will actually enforce, not the
    // file's — a client that renders this must not be shown $1.00.
    expect(resumed.budgetUsd).toBe(0.5);
    const done = await settled(harness.client, handle.runId, (state) => state === "failed");
    expect(done.state).toBe("failed");
    expect(done.stopReason).toBe("cost-ceiling");
    expect(harness.notices().some((line) => line.includes("exceeded its $0.50 run budget"))).toBe(
      true,
    );
    expect(harness.notices().some((line) => line.includes("$1.00 run budget"))).toBe(false);
  });
});

describe("--allow-ceiling-raise: the host may let the wire raise a ceiling", () => {
  /** A read-lane role with a two-turn ceiling, and a workflow that uses it. */
  async function ragFixture(scratch: Scratch): Promise<void> {
    await writeRole(
      scratch,
      "indexer",
      "---\nname: indexer\ndescription: Builds indexes\ntools: read, grep\nmaxTurns: 2\n---\nIndex.\n",
    );
    await writeWorkflow(
      scratch,
      "rag",
      ["---", "name: rag", "---", "1. First: {{input}}", "2. @indexer Index: {{prev}}", ""].join(
        "\n",
      ),
    );
  }

  const looping = { toolCalls: [{ id: "c", name: "grep", arguments: { pattern: "x" } }] };

  it("honours raise <n> on a turn-ceiling park, and retries the step under the new ceiling", async () => {
    const scratch = await makeScratch();
    await ragFixture(scratch);
    // Same script as the terminal-only "accepts retry" test — the fourth turn
    // is what proves the raise itself continued the step rather than merely
    // being accepted and then doing nothing.
    const harness = await serve(
      scratch,
      [{ text: "the survey" }, looping, looping, { text: "indexed" }],
      { allowCeilingRaise: true },
    );

    const handle = await harness.client.runWorkflow(harness.sessionId, "rag", { input: "go" });
    const parked = await settled(harness.client, handle.runId);
    expect(parked.state).toBe("paused");
    expect(parked.questions[0]?.raise).toEqual({ kind: "turns", current: 2 });

    // Where the default-off wire refuses this outright, a server started with
    // the flag threads it to the ENGINE — the exact parser and the exact
    // validation a terminal `raise <n>` gets (`parseBudgetRaiseAnswer`, the
    // "must exceed the ceiling that just tripped" check, and so on).
    const raised = await harness.client.resumeWorkflow(harness.sessionId, handle.runId, "raise 5");
    expect(raised).toMatchObject({ runId: handle.runId, resumed: true });

    const finished = await settled(harness.client, handle.runId, (state) => state === "done");
    expect(finished.state).toBe("done");
    const steps = (await harness.client.workflowStatus(handle.runId, { steps: true }))?.runs[0]
      ?.steps;
    expect(steps?.find((step) => step.id === "1")?.status).toBe("done");
    expect(steps?.find((step) => step.id === "2")?.status).toBe("done");
  });

  it("still refuses a raise that does not exceed the ceiling that tripped, naming the number", async () => {
    const scratch = await makeScratch();
    await ragFixture(scratch);
    const harness = await serve(scratch, [{ text: "the survey" }, looping, looping], {
      allowCeilingRaise: true,
    });
    const handle = await harness.client.runWorkflow(harness.sessionId, "rag", { input: "go" });
    await settled(harness.client, handle.runId);

    // The engine's own validation still applies — allowing the wire to raise
    // does not mean allowing it to raise to anything. The reply is ACCEPTED
    // (the resume is not rejected — nothing on this wire is refused just for
    // being raise-shaped once the flag is on), but nothing is spent and
    // nothing advances: the engine re-parks on the same durable ask, exactly
    // as an insufficient `raise <n>` re-parks a terminal run.
    const reparked = await harness.client.resumeWorkflow(
      harness.sessionId,
      handle.runId,
      "raise 2",
    );
    expect(reparked).toMatchObject({ runId: handle.runId, resumed: true });
    const still = await settled(harness.client, handle.runId);
    expect(still.state).toBe("paused");
    expect(still.questions[0]?.stepId).toBe("2");
    expect(still.questions[0]?.raise).toEqual({ kind: "turns", current: 2 });
  });

  it("honours raise <n> on a stage-boundary budget ask, and the raised ceiling is what actually binds", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "asky2",
      [
        "---",
        "name: asky2",
        "budgetUsd: 1",
        "---",
        "1. First: {{input}}",
        "2. Second: {{prev}}",
        "",
      ].join("\n"),
    );
    const harness = await serve(scratch, [{ text: "pricey output", usage: { costUsd: 0.9 } }], {
      allowCeilingRaise: true,
    });

    const handle = await harness.client.runWorkflow(harness.sessionId, "asky2", { input: "go" });
    const parked = await settled(harness.client, handle.runId);
    expect(parked.state).toBe("paused");
    expect(parked.questions[0]?.raise).toEqual({ kind: "budget", current: 1 });

    const raised = await harness.client.resumeWorkflow(harness.sessionId, handle.runId, "raise 5");
    expect(raised).toMatchObject({ runId: handle.runId, resumed: true });

    // Stage 2 spends another $0.90 — $1.80 total, over the FILE's original
    // $1.00 but comfortably under the $5.00 the wire just raised it to.
    const done = await settled(harness.client, handle.runId, (state) => state === "done");
    expect(done.state).toBe("done");
    expect(harness.notices().some((line) => line.includes("exceeded its"))).toBe(false);
  });

  it("advertises the capability on the authenticate handshake, on and off", async () => {
    const scratch = await makeScratch();
    const allowed = await serve(scratch, undefined, { allowCeilingRaise: true, token: "t" });
    await allowed.client.authenticate();
    expect(allowed.client.capabilities()).toEqual({ ceilingRaise: true });

    const refused = await serve(scratch, undefined, { allowCeilingRaise: false, token: "t2" });
    await refused.client.authenticate();
    expect(refused.client.capabilities()).toEqual({ ceilingRaise: false });
  });
});

describe("what a remote caller may not do", () => {
  it("cannot start a second pipeline on a session already running one", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "slow",
      "---\nname: slow\n---\n1. First: {{input}}\n2. Second: {{prev}}\n",
    );
    // A delay long enough that the second request lands mid-run.
    const harness = await serve(scratch, [{ text: "slow output", delayMs: 300 }]);
    const handle = await harness.client.runWorkflow(harness.sessionId, "slow", { input: "x" });
    await expect(harness.client.runWorkflow(harness.sessionId, "slow")).rejects.toThrow(
      /already running a workflow/,
    );
    await settled(harness.client, handle.runId);
  });

  it("cannot delete a session out from under a running pipeline", async () => {
    const scratch = await makeScratch();
    await writeWorkflow(
      scratch,
      "slow2",
      "---\nname: slow2\n---\n1. First: {{input}}\n2. Second: {{prev}}\n",
    );
    const harness = await serve(scratch, [{ text: "slow output", delayMs: 300 }]);
    const handle = await harness.client.runWorkflow(harness.sessionId, "slow2", { input: "x" });
    await expect(harness.client.deleteSession(harness.sessionId)).rejects.toThrow(
      /running a workflow/,
    );
    await settled(harness.client, handle.runId);
  });
});

describe("a run id is a path segment, and is treated as one", () => {
  it("refuses to resume an id this engine could never have minted", async () => {
    // `join(runsRoot, runId)` is what a run id becomes. A token holder already
    // has a shell, so this is not the wall that keeps them out — but a verb
    // that joins a client string onto a root without checking it is how a later
    // caller with less authority inherits a traversal.
    const scratch = await makeScratch();
    const harness = await serve(scratch);
    for (const bad of ["../../etc", "..", ".", "a/b", "a\\b"]) {
      await expect(harness.client.resumeWorkflow(harness.sessionId, bad)).rejects.toThrow(
        /could have minted|non-empty string|at most/,
      );
    }
  });

  it("answers such an id with zero rows on the read verb rather than reading it", async () => {
    const scratch = await makeScratch();
    const harness = await serve(scratch);
    // Zero rows, not a refusal: this verb degrades, so an in-band error would be
    // read by a client as "this engine is too old".
    expect((await harness.client.workflowStatus("../../etc"))?.runs).toEqual([]);
  });
});

describe("stricterMode composes downward and never up", () => {
  it("takes the stricter of the two, in both argument orders", () => {
    expect(stricterMode("yolo", "plan")).toBe("plan");
    expect(stricterMode("plan", "yolo")).toBe("plan");
    expect(stricterMode("acceptEdits", "default")).toBe("default");
    expect(stricterMode("default", "acceptEdits")).toBe("default");
    expect(stricterMode("yolo", "yolo")).toBe("yolo");
  });

  it("never answers with a mode looser than either input", () => {
    // The property the composition exists for: a remote caller can set their
    // session's mode but not the engine's, so composing must only ever narrow.
    const modes = ["plan", "default", "acceptEdits", "yolo"] as const;
    const rank = (mode: string): number => modes.indexOf(mode as (typeof modes)[number]);
    for (const a of modes) {
      for (const b of modes) {
        expect(rank(stricterMode(a, b))).toBeLessThanOrEqual(Math.min(rank(a), rank(b)));
      }
    }
  });
});

describe("resolveRunBudget", () => {
  const wf = (budgetUsd?: number): Parameters<typeof resolveRunBudget>[0] =>
    ({
      name: "x",
      source: "/ws/x.md",
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
    }) as Parameters<typeof resolveRunBudget>[0];

  it("uses the file's ceiling when the caller asks for none", () => {
    expect(resolveRunBudget(wf(15), undefined)).toEqual({ ok: true, value: 15 });
    expect(resolveRunBudget(wf(), undefined)).toEqual({ ok: true, value: undefined });
  });

  it("takes a lower request, and refuses a higher one naming both numbers", () => {
    expect(resolveRunBudget(wf(15), 5)).toEqual({ ok: true, value: 5 });
    const refused = resolveRunBudget(wf(15), 500);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain("15.00");
    expect(refused.ok === false && refused.error).toContain("500.00");
    expect(refused.ok === false && refused.error).toContain("/ws/x.md");
  });

  it("accepts any positive request against a file with no ceiling — bounding is narrowing", () => {
    expect(resolveRunBudget(wf(), 500)).toEqual({ ok: true, value: 500 });
  });

  it("refuses a non-positive request, because 0 disables the guard", () => {
    expect(resolveRunBudget(wf(15), 0).ok).toBe(false);
    expect(resolveRunBudget(wf(15), -1).ok).toBe(false);
    expect(resolveRunBudget(wf(15), Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});

describe("deriveRoleLane", () => {
  const def = (tools?: string[]): AgentDef =>
    ({
      name: "r",
      description: "",
      systemPrompt: "",
      source: "/ws/r.md",
      ...(tools === undefined ? {} : { tools }),
    }) as AgentDef;

  it("reads the three real lanes off the declared tools", () => {
    expect(deriveRoleLane("r", () => def(["read", "grep"]))).toBe("read");
    expect(deriveRoleLane("r", () => def(["read", "bash"]))).toBe("exec");
    expect(deriveRoleLane("r", () => def(["read", "edit"]))).toBe("write");
    // `multiedit` is a reserved name no package registers, and declaring it is
    // still the write lane — the classifier reads names, not capabilities.
    expect(deriveRoleLane("r", () => def(["read", "multiedit"]))).toBe("write");
  });

  it("says unknown for a role nobody defined and undeclared for one with no tools", () => {
    // Both fail the run before it spends anything. Reporting either as "read"
    // would describe a pipeline that cannot run as one that runs harmlessly.
    expect(deriveRoleLane("ghost", () => undefined)).toBe("unknown");
    expect(deriveRoleLane("r", () => def())).toBe("undeclared");
  });
});
