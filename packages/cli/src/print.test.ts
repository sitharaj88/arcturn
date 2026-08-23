import type { AgentEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { runPrint } from "./print.js";
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
