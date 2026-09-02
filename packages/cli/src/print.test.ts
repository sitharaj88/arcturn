import type { AgentEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { CommandRegistry, type SlashCommand } from "./commands.js";
import { PRINT_EXIT, runPrint } from "./print.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (chunk: string) => void out.push(chunk),
    stderr: (chunk: string) => void err.push(chunk),
    stdoutText: () => out.join(""),
    stderrText: () => err.join(""),
  };
}

describe("runPrint", () => {
  it("prints only the final assistant text and exits 0", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "42" }]);
    const sink = capture();

    const result = await runPrint({ runtime, prompt: "what is 6*7?", ...sink });

    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe("completed");
    expect(sink.stdoutText()).toBe("42\n");
    expect(sink.stderrText()).toBe("");
    await runtime.dispose();
  });

  it("runs tool calls to completion before printing", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "t1", name: "ls", arguments: { path: "." } }] },
        { text: "the directory is empty" },
      ],
      { permissionMode: "yolo" },
    );
    const sink = capture();

    const result = await runPrint({ runtime, prompt: "look around", ...sink });

    expect(result.exitCode).toBe(0);
    expect(sink.stdoutText()).toBe("the directory is empty\n");
    await runtime.dispose();
  });

  it("emits every event as NDJSON in json mode and nothing else on stdout", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "hi" }]);
    const sink = capture();

    await runPrint({ runtime, prompt: "hello", outputFormat: "json", ...sink });

    const events = sink
      .stdoutText()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AgentEvent);

    expect(events[0]?.type).toBe("runStart");
    expect(events.at(-1)?.type).toBe("runEnd");
    const types = new Set(events.map((event) => event.type));
    expect(types.has("messageStream")).toBe(true);
    expect(types.has("messageEnd")).toBe(true);
    expect(types.has("turnEnd")).toBe(true);
    expect(sink.stdoutText().endsWith("\n")).toBe(true);
    await runtime.dispose();
  });

  it("exits 1 and reports the error when the run fails", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ error: "provider exploded" }]);
    const sink = capture();

    const result = await runPrint({ runtime, prompt: "hello", ...sink });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("error");
    expect(sink.stderrText()).toContain("provider exploded");
    await runtime.dispose();
  });

  it("auto-denies permission asks once per subject, with a hint on stderr", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "t1", name: "bash", arguments: { command: "rm -rf /" } }] },
      { toolCalls: [{ id: "t2", name: "bash", arguments: { command: "rm -rf /" } }] },
      { text: "I could not do that" },
    ]);
    const sink = capture();

    const result = await runPrint({ runtime, prompt: "delete everything", ...sink });

    expect(result.exitCode).toBe(0);
    expect(sink.stderrText()).toContain("denied bash");
    expect(sink.stderrText()).toContain("--permission-mode");
    expect(sink.stderrText().match(/denied bash/g)).toHaveLength(1);

    const toolResults = runtime.agent.messages.filter((message) => message.role === "toolResult");
    expect(toolResults.every((message) => message.isError)).toBe(true);
    await runtime.dispose();
  });

  it("does not auto-deny when the mode already allows the tool", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [
            { id: "t1", name: "write", arguments: { file_path: "note.txt", content: "hi" } },
          ],
        },
        { text: "written" },
      ],
      { permissionMode: "acceptEdits" },
    );
    const sink = capture();

    const result = await runPrint({ runtime, prompt: "write a note", ...sink });

    expect(result.exitCode).toBe(0);
    expect(sink.stderrText()).not.toContain("denied");
    await runtime.dispose();
  });

  it("stops at --max-turns and exits non-zero", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [{ toolCalls: [{ id: "t1", name: "ls", arguments: { path: "." } }] }],
      { permissionMode: "yolo", maxTurns: 2 },
    );
    const sink = capture();

    const result = await runPrint({ runtime, prompt: "loop forever", ...sink });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("error");
    await runtime.dispose();
  });
});

describe("runPrint with a slash command", () => {
  /** A registry holding exactly the scripted commands, nothing built in. */
  function registryOf(...commands: SlashCommand[]): CommandRegistry {
    const registry = new CommandRegistry();
    registry.registerAll(commands);
    return registry;
  }

  it("dispatches a leading-slash prompt as a command, not as a question for the model", async () => {
    const scratch = await makeScratch();
    // The model must never be asked: a scripted turn that would answer.
    const runtime = await buildTestRuntime(scratch, [{ text: "MODEL SPOKE" }]);
    const seen: string[] = [];
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "/echo hello there",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf({
        name: "echo",
        description: "test",
        run({ ui, args }) {
          seen.push(args);
          ui.print(["line one", `args: ${args}`]);
          ui.notice("info", "all good");
        },
      }),
    });
    expect(seen).toEqual(["hello there"]);
    expect(io.stdoutText()).toBe("line one\nargs: hello there\nall good\n");
    expect(io.stderrText()).toBe("");
    expect(io.stdoutText()).not.toContain("MODEL SPOKE");
    expect(result).toMatchObject({ exitCode: PRINT_EXIT.ok, reason: "completed" });
  });

  it("exits 2 for a command that does not exist", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "/nope",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf(),
    });
    expect(result.exitCode).toBe(PRINT_EXIT.unknownCommand);
    expect(io.stderrText()).toContain('Unknown command "/nope"');
  });

  it("exits 1 when the command reports an error, with the error on stderr", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "/boom",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf({
        name: "boom",
        description: "test",
        run({ ui }) {
          ui.notice("error", "it broke");
        },
      }),
    });
    expect(result.exitCode).toBe(PRINT_EXIT.error);
    expect(io.stderrText()).toBe("arcturn: it broke\n");
  });

  it("exits 3 when a workflow stops for a human, and prints the command to run next", async () => {
    // What `/workflow` says when a step parks or a role asks: a warn notice
    // opening with the words `pauseSummary` mints, plus a pre-filled resume
    // command. Neither is an error, and neither is "done" — CI needs its own
    // code for "a person has to decide".
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "/workflowish",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf({
        name: "workflowish",
        description: "test",
        run({ ui }) {
          ui.notice("warn", "Workflow parked at a failed step (3): step 3 (@architect) failed");
          ui.notice("info", "last turn: zai/glm-5.3 · stopped endTurn · no text · no tool call");
          ui.setInput("/workflow resume run-1 ");
        },
      }),
    });
    expect(result.exitCode).toBe(PRINT_EXIT.needsHuman);
    expect(result.reason).toBe("completed");
    expect(io.stderrText()).toContain("arcturn: Workflow parked at a failed step (3)");
    expect(io.stderrText()).toContain('arcturn: next: arcturn -p "/workflow resume run-1"');
    expect(io.stdoutText()).toContain("last turn: zai/glm-5.3");
  });

  it("exits 3, not 1, when a failed step's error notice precedes the park warn", async () => {
    // A step that parks the run is `failed` by design (see workflow.ts's
    // `stepEnd` notice), so the error-level per-step notice always arrives
    // before the warn-level park notice. The park is resumable — that is the
    // whole point — so it must win over the error on the way to it.
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "/parkish",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf({
        name: "parkish",
        description: "test",
        run({ ui }) {
          ui.notice("error", "step 3 (@architect) failed");
          ui.notice("warn", "Workflow parked at a failed step (3): step 3 (@architect) failed");
        },
      }),
    });
    expect(result.exitCode).toBe(PRINT_EXIT.needsHuman);
  });

  it("exits 1, not 3, when a command reports an error with no human-stop notice", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "/boom2",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf({
        name: "boom2",
        description: "test",
        run({ ui }) {
          ui.notice("error", "plain failure, nobody is waiting on anything");
        },
      }),
    });
    expect(result.exitCode).toBe(PRINT_EXIT.error);
  });

  it("stays silent on the picker refusal once a human-stop notice already printed the resume hint", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "/parkpick",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf({
        name: "parkpick",
        description: "test",
        async run({ ui }) {
          ui.notice("warn", "Workflow parked at a failed step (3): step 3 (@architect) failed");
          // The command's own picker call, exactly as `/workflow`'s
          // offerAnswer() makes one — must not add a second, redundant
          // "cannot be shown" notice on top of the park's resume hint.
          await ui.select("Choose an answer", [{ label: "a", value: 1 }]);
        },
      }),
    });
    expect(io.stderrText()).not.toContain("a picker cannot be shown under --print");
    expect(result.exitCode).toBe(PRINT_EXIT.needsHuman);
  });

  it("refuses a picker with a notice instead of hanging, so the command takes its cancel branch", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const io = capture();
    let picked: unknown = "unset";
    const result = await runPrint({
      runtime,
      prompt: "/pick",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf({
        name: "pick",
        description: "test",
        async run({ ui }) {
          picked = await ui.select("Choose a session", [{ label: "a", value: 1 }]);
        },
      }),
    });
    expect(picked).toBeUndefined();
    expect(io.stderrText()).toContain("Choose a session: a picker cannot be shown under --print.");
    expect(result.exitCode).toBe(PRINT_EXIT.ok);
  });

  it("emits every surface as NDJSON under --output-format json", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const io = capture();
    await runPrint({
      runtime,
      prompt: "/j",
      outputFormat: "json",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf({
        name: "j",
        description: "test",
        run({ ui }) {
          ui.print("hello");
          ui.notice("warn", "careful");
          ui.workflowLive?.({ type: "stageStart", stage: 1, parallel: false, steps: 1 } as never);
        },
      }),
    });
    const records = io
      .stdoutText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.type)).toEqual(["print", "notice", "workflow"]);
    expect(io.stderrText()).toBe("");
  });

  it("sends a prompt that merely starts with a path to the model, as before", async () => {
    // `parseCommandLine` accepts "/etc/hosts …" as a malformed command name;
    // the interactive app tolerates that because a person there has a
    // completion menu open. Under --print nobody does, and exiting 2 on a
    // question about a file would be a regression from asking the model.
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "the model answered" }]);
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "/etc/hosts is wrong, fix it",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf(),
    });
    expect(result.exitCode).toBe(0);
    expect(io.stdoutText()).toBe("the model answered\n");
    expect(io.stderrText()).toBe("");
  });

  it("still sends an ordinary prompt to the model", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "from the model" }]);
    const io = capture();
    const result = await runPrint({
      runtime,
      prompt: "not a command, just / a slash inside",
      stdout: io.stdout,
      stderr: io.stderr,
      commands: registryOf(),
    });
    expect(result.exitCode).toBe(0);
    expect(io.stdoutText()).toBe("from the model\n");
  });
});
