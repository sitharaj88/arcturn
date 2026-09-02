/**
 * Conformance: every kit Arcturn ships runs end to end through the real engine.
 *
 * `kits/<kit>/` is what a user installs, and until now nothing proved that a
 * shipped workflow could complete: `web/scripts/hub.test.ts` checks that the
 * registry describes the files honestly, `workflow.test.ts` checks the engine
 * against synthetic pipelines, and the gap between them is exactly where last
 * week's real run died — a role file the parser accepted, a step whose lane
 * refused to dispatch, a stage that produced nothing and was marked done.
 *
 * Two halves. The static half parses every shipped workflow with the real
 * parser and every shipped role with the real loader, and asks the questions
 * the engine asks at dispatch time (does this `@role` exist in this kit, is
 * this `[tag]` a tier, does this role declare tools). The dynamic half then
 * drives every workflow through `runWorkflow` + `createRuntimeRunStep` + the
 * production write lane, over a real git repository, with a model that does
 * the least any step could accept — and asserts the run reaches `done`.
 *
 * The two failure shapes at the end are the ones that happened for real, run
 * against the REAL `kits/rag-blueprint` files rather than a stand-in pipeline.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentText } from "@arcturn/core";
import type { LLMRequest } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentDef, loadAgentDefs } from "./agents.js";
import type { ArcturnRuntime } from "./runtime.js";
import { type FakeLLM, respondingLLM, type ScriptedTurn } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";
import {
  composeTagResolver,
  createRuntimeRunStep,
  createRuntimeWriteLane,
  isWorkflowParseError,
  parseWorkflow,
  roleDispatch,
  runWorkflow,
  type Workflow,
  type WorkflowRunResult,
  type WriteLane,
  type WriteLaneHost,
} from "./workflow.js";
import { createFileRunJournal, type JournalLine, readJournalLines } from "./workflow-run.js";

// ------------------------------------------------------------ the shipped tree

const KITS_DIR = fileURLToPath(new URL("../../../kits", import.meta.url));

/** One `kits/<kit>/workflows/<file>.md`, read once at collection time. */
interface ShippedWorkflow {
  /** The kit directory name, e.g. `rag-blueprint`. */
  readonly kit: string;
  /** The file name, e.g. `rag-setup.md`. */
  readonly file: string;
  /** The workflow name the CLI would derive: the file stem. */
  readonly name: string;
  /** Absolute path. */
  readonly path: string;
  /** Full file contents. */
  readonly raw: string;
  /** `kit/workflows/file`, for assertion messages. */
  readonly label: string;
}

/** Every kit directory, sorted. */
const KITS: readonly string[] = readdirSync(KITS_DIR)
  .filter((entry) => existsSync(join(KITS_DIR, entry, "arcturn.json")))
  .sort();

/** Every kit that ships an `agents/` directory. */
const KITS_WITH_AGENTS: readonly string[] = KITS.filter((kit) =>
  existsSync(join(KITS_DIR, kit, "agents")),
);

/**
 * Every shipped workflow file, discovered synchronously so the dynamic half
 * can register one test per file at collection time.
 */
const WORKFLOWS: readonly ShippedWorkflow[] = KITS.flatMap((kit) => {
  const dir = join(KITS_DIR, kit, "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const path = join(dir, file);
      return {
        kit,
        file,
        name: file.replace(/\.md$/, ""),
        path,
        raw: readFileSync(path, "utf8"),
        label: `${kit}/workflows/${file}`,
      };
    });
});

/** Parse a shipped workflow exactly as the CLI would, or throw with its error. */
function parseShipped(shipped: ShippedWorkflow): Workflow {
  const parsed = parseWorkflow(shipped.raw, { name: shipped.name, source: shipped.path });
  if (isWorkflowParseError(parsed)) throw new Error(`${shipped.label}: ${parsed.error}`);
  return parsed;
}

/**
 * Tools that can fill in part of an existing file without re-emitting all of
 * it. `multiedit` is the same capability in bulk.
 */
const PARTIAL_WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "multiedit"]);

/**
 * True when a role can create a file but has no way to fill one in stages.
 *
 * The failure this names is structural, not stylistic: a document larger than
 * a single tool-call argument comfortably carries has to be built up across
 * calls, and a role holding `write` alone has exactly one call available. It
 * either emits the whole thing or — as four real runs did — emits nothing.
 *
 * @param def - The role, as the loader read it.
 */
function cannotWriteInParts(def: AgentDef): boolean {
  if (def.tools === undefined || !def.tools.includes("write")) return false;
  return !def.tools.some((name) => PARTIAL_WRITE_TOOLS.has(name));
}

/** A kit's roles, loaded by the real loader, keyed by name. */
async function kitRoles(kit: string): Promise<Map<string, AgentDef>> {
  const warnings: string[] = [];
  const defs = await loadAgentDefs([join(KITS_DIR, kit, "agents")], warnings);
  if (warnings.length > 0) throw new Error(`${kit}/agents: ${warnings.join("; ")}`);
  return new Map(defs.map((def) => [def.name, def]));
}

// ---------------------------------------------------------- the static half

describe("every shipped kit, as the engine would read it", () => {
  it("has kits and workflows to check at all", () => {
    expect(KITS.length).toBeGreaterThan(0);
    expect(WORKFLOWS.length).toBeGreaterThan(0);
  });

  it("parses every shipped workflow file with the real parser", () => {
    const failures: string[] = [];
    for (const shipped of WORKFLOWS) {
      const parsed = parseWorkflow(shipped.raw, { name: shipped.name, source: shipped.path });
      if (isWorkflowParseError(parsed)) failures.push(`${shipped.label}: ${parsed.error}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("resolves every @role a step names to a role the SAME kit ships", async () => {
    // The engine validates roles before spending a token (`runWorkflow`'s
    // pre-flight), but only against whatever roots the host loaded. A kit is
    // installed as a unit, so the honest question is whether the kit's own
    // `agents/` directory satisfies its own workflows.
    const missing: string[] = [];
    for (const kit of KITS) {
      const shippedHere = WORKFLOWS.filter((shipped) => shipped.kit === kit);
      if (shippedHere.length === 0) continue;
      const roles = await kitRoles(kit);
      for (const shipped of shippedHere) {
        for (const step of parseShipped(shipped).stages.flatMap((stage) => stage.steps)) {
          if (step.agent !== undefined && !roles.has(step.agent)) {
            missing.push(
              `${shipped.label} step ${step.id}: @${step.agent} is not in ${kit}/agents ` +
                `(which ships: ${[...roles.keys()].join(", ")})`,
            );
          }
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("tags every [tag] step with a tier, never a vendor or model id", () => {
    // Through the parser this time, not a regex over the file: what matters is
    // the tag the engine will hand to `resolveModel`, and a kit that pins
    // `anthropic/…` there returns 401 to everyone without that key.
    const offences: string[] = [];
    for (const shipped of WORKFLOWS) {
      for (const step of parseShipped(shipped).stages.flatMap((stage) => stage.steps)) {
        if (step.modelTag !== undefined && !/^tier:[a-z][a-z0-9-]*$/.test(step.modelTag)) {
          offences.push(`${shipped.label} step ${step.id}: [${step.modelTag}]`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("loads every shipped role with no warnings, declared tools, and a lane", async () => {
    for (const kit of KITS_WITH_AGENTS) {
      const dir = join(KITS_DIR, kit, "agents");
      const files = readdirSync(dir).filter((file) => file.endsWith(".md"));
      const warnings: string[] = [];
      const defs = await loadAgentDefs([dir], warnings);
      expect(warnings, `${kit}/agents: ${warnings.join("; ")}`).toEqual([]);
      // A file the loader silently skipped would not warn either, so count.
      expect(defs.length, `${kit}/agents: ${files.length} files, ${defs.length} roles`).toBe(
        files.length,
      );
      for (const def of defs) {
        const file = `${kit}/agents/${basename(def.source)}`;
        // `roleDispatch` answers "read" for an undeclared tool list, but the
        // engine refuses to dispatch it (`undeclaredToolsError`): silence is
        // not a lane. So a role is only conformant with `tools:` present.
        expect(def.tools, `${file} declares no tools:`).toBeDefined();
        expect(["read", "exec", "write"], file).toContain(roleDispatch(def));
        expect(def.name, `${file} is named after its file`).toBe(basename(def.source, ".md"));
      }
    }
  });

  it("gives every role that can write a way to write in parts", async () => {
    // A role holding `write` and nothing else can only ever replace a file
    // whole, so the one shape that survives a large document — land the
    // headings, then fill one section per `edit` — is unavailable to it. That
    // is not a prompt problem a kit author can fix in prose: four real runs on
    // two models ended with a 30 KB document reasoned out in full and never
    // emitted, because the only call on offer had to carry all of it. The
    // engine states the rule in every lane contract; the tool list has to make
    // it followable.
    const offenders: string[] = [];
    for (const kit of KITS_WITH_AGENTS) {
      for (const def of (await kitRoles(kit)).values()) {
        if (!cannotWriteInParts(def)) continue;
        offenders.push(
          `${kit}/agents/${basename(def.source)} — tools: ${def.tools?.join(", ")} ` +
            "(holds write, no edit)",
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("would catch a write-only role, so the check above is not vacuous", () => {
    // In memory, not by breaking a shipped kit: the assertion above is only
    // worth anything if it can still go red once every kit is conformant.
    const role = (tools: string[] | undefined): AgentDef => ({
      name: "doc-author",
      description: "Writes a long design document.",
      systemPrompt: "Write the ADR.",
      ...(tools === undefined ? {} : { tools }),
      source: "/synthetic/agents/doc-author.md",
    });

    expect(cannotWriteInParts(role(["read", "grep", "write"]))).toBe(true);
    expect(cannotWriteInParts(role(["read", "grep", "write", "edit"]))).toBe(false);
    // `multiedit` is the same capability in bulk, and satisfies the rule too.
    expect(cannotWriteInParts(role(["write", "multiedit"]))).toBe(false);
    // A role that cannot write at all is not implicated — there is no
    // oversized argument for it to fail to emit.
    expect(cannotWriteInParts(role(["read", "grep"]))).toBe(false);
    expect(cannotWriteInParts(role(["read", "bash"]))).toBe(false);
    // An undeclared tool list is refused at dispatch by a different check.
    expect(cannotWriteInParts(role(undefined))).toBe(false);
  });

  /**
   * The roles the write lane's "is this step making progress?" signal has to
   * be right about.
   *
   * FAIL FIRST, and it failed for real: that signal counted `write`, `edit`
   * and `multiedit` tool calls. Every role below holds `bash` as well, and
   * `project-setup/scaffolder`'s headline rule is *never hand-write a file a
   * generator produces* — so each of them can do its entire job through
   * `printf … >> file`, `npm create`, `cp` or `git apply` and register not one
   * counted write. One did: it was told at turns 12 and 24 that it had changed
   * no file while its worktree filled up, was stopped at turn 36 for "writing
   * nothing", had its work captured to a patch and thrown away, and then did
   * the whole thing again on the automatic fresh retry.
   *
   * This list is a tripwire, not decoration: it is written down so that a
   * future change to the signal has to come back here and decide about these
   * six roles by name.
   */
  it("names every shipped write-lane role that can author through the shell", async () => {
    const shellAuthors: string[] = [];
    for (const kit of KITS_WITH_AGENTS) {
      for (const def of (await kitRoles(kit)).values()) {
        if (roleDispatch(def) !== "write") continue;
        if (!(def.tools ?? []).includes("bash")) continue;
        shellAuthors.push(`${kit}/${def.name}`);
      }
    }
    expect(shellAuthors.sort()).toEqual([
      "complexity-guard/optimizer",
      "enterprise-org/developer",
      "enterprise-org/docs-writer",
      "enterprise-org/qa-functional",
      "project-setup/scaffolder",
      "rag-blueprint/rag-builder",
    ]);
    // Nearly half the write lane. A progress signal blind to the shell is
    // blind to six of these thirteen roles.
    const writeRoles: string[] = [];
    for (const kit of KITS_WITH_AGENTS) {
      for (const def of (await kitRoles(kit)).values()) {
        if (roleDispatch(def) === "write") writeRoles.push(`${kit}/${def.name}`);
      }
    }
    expect(writeRoles.length).toBeGreaterThanOrEqual(shellAuthors.length);
    expect(shellAuthors.length / writeRoles.length).toBeGreaterThan(0.25);
  });

  it("declares only finite, positive budgets and deadlines", () => {
    const keys = ["budgetUsd", "budgetTokens", "stepTimeoutMs"] as const;
    for (const shipped of WORKFLOWS) {
      const workflow = parseShipped(shipped);
      for (const key of keys) {
        const value = workflow[key];
        if (value === undefined) continue;
        expect(
          Number.isFinite(value) && value > 0,
          `${shipped.label}: ${key} = ${String(value)}`,
        ).toBe(true);
      }
    }
  });
});

// ------------------------------------------------------ the dynamic half

const execFileAsync = (cmd: string, args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { cwd }, (error) => (error ? reject(error) : resolve()));
  });

const runtimes: ArcturnRuntime[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** These drive a real POSIX shell, real git worktrees and real process groups. */
const itPosix = it.skipIf(process.platform === "win32");

/**
 * A whole shipped pipeline — up to fifteen steps, nine of them on a worktree
 * lane — is more than the suite's 20 s default.
 */
const DYNAMIC_TIMEOUT_MS = 90_000;

/** Does this path exist at all? */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A scratch tree whose project directory is a real git repository. */
async function gitScratch(): Promise<Scratch> {
  const scratch = await makeScratch();
  roots.push(scratch.root);
  const git = (...args: string[]): Promise<void> => execFileAsync("git", args, scratch.cwd);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  await git("config", "core.autocrlf", "false");
  await git("config", "core.eol", "lf");
  await mkdir(scratch.cwd, { recursive: true });
  await writeFile(join(scratch.cwd, "seed.txt"), "seed\n", "utf8");
  await git("add", "-A");
  await git("commit", "-qm", "base");
  return scratch;
}

/** Build a real runtime over `scratch`, holding on to the fake client. */
async function runtimeWith(scratch: Scratch, llm: FakeLLM): Promise<ArcturnRuntime> {
  const runtime = await buildTestRuntime(scratch, [], {
    llm,
    permissionMode: "yolo",
    onPermissionAsk: async (request) => ({
      requestId: request.id,
      behavior: "deny" as const,
      message: "no interactive user in this test",
    }),
  });
  runtimes.push(runtime);
  return runtime;
}

/** The production write lane over a real runtime and a real repository. */
function laneFor(runtime: ArcturnRuntime, runId: string): WriteLane {
  return createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId);
}

/**
 * A run's journal once its terminal `runEnd` has landed.
 *
 * `runWorkflow` appends that one line fire-and-forget, so a read the instant
 * the promise resolves can legitimately miss it.
 */
async function journalOnceEnded(dir: string): Promise<JournalLine[]> {
  for (let i = 0; i < 100; i += 1) {
    const lines = await readJournalLines(dir);
    if (lines.some((line) => line.kind === "runEnd")) return lines;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`journal at ${dir} never recorded a terminal runEnd`);
}

/**
 * The least a model can do and still satisfy any shipped step.
 *
 * - After a tool result: one short line of text, so the step has output (the
 *   read lane is judged on text alone — see `stepProducedNothing`) and so it
 *   carries no `ORG-ASK:` / `ORG-HALT:` marker that would gate the run.
 * - Offered `write`: one call writing a unique file, so a write-lane step has
 *   a diff to capture and `git apply`, and no two steps ever touch one path.
 * - Otherwise (read and exec lanes): the same short line.
 *
 * It never calls `bash`. `serial` counts requests across the run, which is
 * what keeps every written path unique even across parallel branches.
 *
 * @param request - What the agent asked.
 * @param serial - 1-based index of this request within the run.
 */
function minimalTurn(request: LLMRequest, serial: number): ScriptedTurn {
  if (request.messages.at(-1)?.role === "toolResult") {
    return { text: `done: step output ${serial}` };
  }
  if (request.tools?.some((tool) => tool.name === "write")) {
    return {
      toolCalls: [
        {
          id: `call-${serial}`,
          name: "write",
          arguments: { path: `out/${serial}.md`, content: `minimal output ${serial}\n` },
        },
      ],
    };
  }
  return { text: `done: step output ${serial}` };
}

/**
 * The minimal model as a client, with an optional override per request.
 *
 * @param override - Returns a turn to use instead of the minimal one, or
 *   `undefined` to fall through. The request count is `llm.requests.length`.
 */
function minimalResponder(
  override?: (request: LLMRequest, serial: number) => ScriptedTurn | undefined,
): FakeLLM {
  let serial = 0;
  return respondingLLM((request) => {
    serial += 1;
    return override?.(request, serial) ?? minimalTurn(request, serial);
  });
}

/** What a shipped workflow's run left behind. */
interface ConformanceRun {
  readonly result: WorkflowRunResult;
  readonly lines: JournalLine[];
  readonly scratch: Scratch;
}

/**
 * Run one shipped workflow through the real engine over a fresh repository.
 *
 * Everything here is production wiring: the kit's own roles through
 * `loadAgentDefs`, tags and role tiers through `composeTagResolver` over the
 * runtime's router, the write lane through `createRuntimeWriteLane`, a file
 * journal under the scratch home.
 */
async function conformanceRun(
  shipped: ShippedWorkflow,
  llm: FakeLLM,
  tag: string,
): Promise<ConformanceRun> {
  const scratch = await gitScratch();
  const runtime = await runtimeWith(scratch, llm);
  const roles = await kitRoles(shipped.kit);
  const resolveAgent = (name: string): AgentDef | undefined => roles.get(name);
  const agentNames = (): string[] => [...roles.keys()];
  const resolveModel = composeTagResolver(runtime, undefined);
  const workflow = parseShipped(shipped);
  const runId = `conformance-${shipped.kit}-${shipped.name}-${tag}`;
  const journalDir = join(scratch.home, "journals", runId);
  const result = await runWorkflow(workflow, {
    input: "the system under test",
    resolveAgent,
    agentNames,
    ...(resolveModel === undefined ? {} : { resolveModel }),
    journal: createFileRunJournal(journalDir),
    runId,
    runStep: createRuntimeRunStep(runtime, {
      resolveAgent,
      agentNames,
      ...(resolveModel === undefined ? {} : { resolveModel }),
      writeLane: laneFor(runtime, runId),
    }),
  });
  return { result, lines: await journalOnceEnded(journalDir), scratch };
}

/** A run's outcome as one message, for the assertion that it should be `done`. */
function describeRun(result: WorkflowRunResult): string {
  const steps = result.steps
    .map(
      (step) =>
        `${step.id}${step.agent ? ` @${step.agent}` : ""}: ${step.status}` +
        (step.error ? ` — ${step.error}` : ""),
    )
    .join("\n  ");
  return `run ${result.status}${result.error ? `: ${result.error}` : ""}\n  ${steps}`;
}

describe("every shipped workflow completes through the real engine under a minimal model", () => {
  for (const shipped of WORKFLOWS) {
    itPosix(
      `${shipped.label} runs to done`,
      async () => {
        const llm = minimalResponder();
        const { result, lines, scratch } = await conformanceRun(shipped, llm, "min");

        expect(result.status, describeRun(result)).toBe("done");
        expect(result.steps.map((step) => step.status)).toEqual(result.steps.map(() => "done"));
        expect(lines.findLast((line) => line.kind === "runEnd")).toMatchObject({
          status: "done",
        });
        // Every step really was dispatched to the model — a run that "completed"
        // by replay or refusal would have asked fewer questions than it has steps.
        expect(llm.requests.length).toBeGreaterThanOrEqual(result.steps.length);
        // And nothing it was asked ever reached for a shell.
        for (const request of llm.requests) {
          const last = request.messages.at(-1);
          if (last?.role === "toolResult") expect(last.toolName).toBe("write");
        }
        // "Done" is not enough: a write lane whose `git apply` silently failed
        // also reports done with an `empty` record. Every write-lane step that
        // wrote must have landed its patch in the checkout — and since the
        // responder writes a file on every write-lane step, at least one must
        // have, and its file must be in the user's tree, not only a worktree.
        const records = result.steps.flatMap((step) => (step.record ? [step.record] : []));
        for (const record of records) {
          expect(["applied", "discarded"].includes(record.status), record.status).toBe(true);
        }
        if (records.some((record) => record.status === "applied")) {
          expect(await exists(join(scratch.cwd, "out"))).toBe(true);
        }
      },
      DYNAMIC_TIMEOUT_MS,
    );
  }
});

// ------------------------------------------- the failure shapes, on the real kit

/**
 * The write and exec lanes open a role's task with this line — see
 * `buildWriteLanePrompt` in workflow.ts: `Role instructions (<role>):` is the
 * first line of the prompt `driveAgent` hands to `agent.prompt`, so it is the
 * FIRST USER MESSAGE of the lane agent's session, while `request.system` is
 * the runtime's own prompt. (The read lane differs: `createRuntimeRunStep`
 * hands `createSubagent` the role's system prompt directly, so there the role
 * text is in `request.system` with no such prefix.) `@rag-architect` holds
 * `write`, so its steps are write-lane and this marker finds every request of
 * its session — the first, the nudge, the tool-result follow-up.
 */
const RAG_ARCHITECT_MARKER = "Role instructions (rag-architect):";

/** Whether `request` belongs to a session whose role prompt carries `marker`. */
function isRoleSession(request: LLMRequest, marker: string): boolean {
  if (request.system?.includes(marker)) return true;
  const first = request.messages.find((message) => message.role === "user");
  return first !== undefined && contentText(first.content).includes(marker);
}

const RAG_SETUP = WORKFLOWS.find(
  (shipped) => shipped.label === "rag-blueprint/workflows/rag-setup.md",
);

/** A model that answers `silences` rag-architect requests with nothing, then behaves. */
function silentArchitect(silences: number): FakeLLM {
  let left = silences;
  return minimalResponder((request) => {
    if (left > 0 && isRoleSession(request, RAG_ARCHITECT_MARKER)) {
      left -= 1;
      return { text: "" };
    }
    return undefined;
  });
}

describe("rag-blueprint/rag-setup: the architect goes silent, as it did for real", () => {
  const ragSetup = (): ShippedWorkflow => {
    if (RAG_SETUP === undefined)
      throw new Error("kits/rag-blueprint/workflows/rag-setup.md is gone");
    return RAG_SETUP;
  };

  itPosix(
    "recovers one silent turn inside stage 3 at the cost of exactly one extra request",
    async () => {
      // Two runs of the same real pipeline, the only difference being that the
      // second architect ends its first turn with no text and no tool call.
      const quiet = minimalResponder();
      const baseline = await conformanceRun(ragSetup(), quiet, "baseline");
      expect(baseline.result.status, describeRun(baseline.result)).toBe("done");

      const llm = silentArchitect(1);
      const { result, lines } = await conformanceRun(ragSetup(), llm, "silent-once");

      // The loop handed the silent turn back once (`SILENT_TURN_NUDGE`), the
      // architect wrote on the second ask, and nobody was asked anything.
      expect(result.status, describeRun(result)).toBe("done");
      expect(result.steps.map((step) => step.status)).toEqual(result.steps.map(() => "done"));
      expect(lines.some((line) => line.kind === "stepFailAsk")).toBe(false);
      expect(lines.findLast((line) => line.kind === "runEnd")).toMatchObject({ status: "done" });
      // The whole cost of the rescue, measured against the run that never went
      // quiet: one request.
      expect(llm.requests.length).toBe(quiet.requests.length + 1);
      // And the silence really landed on the architect's session, not elsewhere.
      const silent = llm.requests.findIndex((request) =>
        isRoleSession(request, RAG_ARCHITECT_MARKER),
      );
      expect(silent).toBeGreaterThan(-1);
      expect(llm.requests[silent + 1]?.messages.at(-1)?.role).toBe("user");
    },
    DYNAMIC_TIMEOUT_MS * 2,
  );

  itPosix(
    "parks at stage 3 when it goes silent on both attempts, with stages 1-2 kept and no ADR",
    async () => {
      // FOUR silences, not two. Two is one failed attempt — a silence and the
      // nudge answered with a second silence — and the engine now spends one
      // automatic fresh attempt on a void before it will trouble a human, so
      // an architect that recovers on the retry never reaches a park at all
      // (which is the point of the retry, and the test above it). What parks
      // this pipeline is a role that produces nothing on both attempts.
      const llm = silentArchitect(4);
      const { result, lines, scratch } = await conformanceRun(ragSetup(), llm, "silent-twice");

      // The void is caught where it happened: step 3 failed, the run parked
      // for a human, and stages 4-13 were never dispatched.
      expect(result.status, describeRun(result)).toBe("paused");
      const byId = new Map(result.steps.map((step) => [step.id, step]));
      expect(byId.get("1")?.status).toBe("done");
      expect(byId.get("2")?.status).toBe("done");
      expect(byId.get("3")?.status).toBe("failed");
      expect(byId.get("3")?.agent).toBe("rag-architect");
      expect(
        result.steps.filter((step) => !["1", "2", "3"].includes(step.id)).map((s) => s.status),
      ).toEqual(
        result.steps.filter((step) => !["1", "2", "3"].includes(step.id)).map(() => "skipped"),
      );

      const ask = lines.find(
        (line): line is Extract<JournalLine, { kind: "stepFailAsk" }> =>
          line.kind === "stepFailAsk",
      );
      expect(ask).toMatchObject({ stepId: "3", role: "rag-architect", attempts: 2 });
      expect(ask?.cause).toContain("produced nothing");
      // …and the park says the engine already tried again, so nobody answers
      // `retry` believing it is the untried option.
      expect(ask?.cause).toContain("retried automatically once and failed twice");
      expect(lines.findLast((line) => line.kind === "runEnd")).toMatchObject({ status: "paused" });

      // The file the whole pipeline is built on was never written — and the
      // failed step's worktree delivered nothing to the checkout either.
      expect(await exists(join(scratch.cwd, "docs", "adr", "rag-architecture.md"))).toBe(false);
      expect(await exists(join(scratch.cwd, "out"))).toBe(false);
      // Stages 1-2 (read lane) and the architect's two attempts of two
      // silences each: nothing after.
      const architectRequests = llm.requests.filter((request) =>
        isRoleSession(request, RAG_ARCHITECT_MARKER),
      );
      expect(architectRequests).toHaveLength(4);
      expect(llm.requests.at(-1)).toBe(architectRequests[3]);
    },
    DYNAMIC_TIMEOUT_MS,
  );
});
