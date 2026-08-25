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
): Promise<Harness> {
  const runtime = await buildTestRuntime(scratch, turns, { permissionMode: "yolo" });
  runtimes.push(runtime);
  const server = new ArcturnServer({ sessionHost: createServeHost(runtime) });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
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
