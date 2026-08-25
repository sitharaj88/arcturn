import { describe, expect, it } from "vitest";
import { createCoalescer } from "./coalesce.js";
import {
  ALLOW,
  ALLOW_ALWAYS,
  answerFromChoice,
  confirmsSessionDeletion,
  DELETE_SESSION,
  DENY,
  describeSessionDeletion,
  permissionChoices,
} from "./dialog.js";
import { describePermissionRequest } from "./permission-queue.js";

const request = {
  id: "req-1",
  toolName: "bash",
  toolCallId: "c",
  subject: "rm -rf build",
  description: "Run a shell command",
};

describe("permissionChoices", () => {
  it("offers allow and deny", () => {
    expect(permissionChoices(describePermissionRequest(request))).toEqual([ALLOW, DENY]);
  });

  it("offers to remember only when the engine suggested a rule", () => {
    const described = describePermissionRequest({
      ...request,
      suggestedRule: { tool: "bash", specifier: "rm *", action: "allow" },
    });
    expect(permissionChoices(described)).toEqual([ALLOW, ALLOW_ALWAYS, DENY]);
  });
});

describe("answerFromChoice", () => {
  const described = describePermissionRequest({
    ...request,
    suggestedRule: { tool: "bash", specifier: "rm *", action: "allow" },
  });

  it("allows", () => {
    expect(answerFromChoice(ALLOW, described)).toEqual({ behavior: "allow" });
  });

  it("allows and persists the engine's own rule", () => {
    expect(answerFromChoice(ALLOW_ALWAYS, described)).toEqual({
      behavior: "allow",
      persistRule: { tool: "bash", specifier: "rm *", action: "allow", scope: "session" },
    });
  });

  it("denies", () => {
    expect(answerFromChoice(DENY, described).behavior).toBe("deny");
  });

  it("treats a dismissed modal as a denial, and says so to the model", () => {
    const answer = answerFromChoice(undefined, described);
    expect(answer.behavior).toBe("deny");
    expect(answer.message).toMatch(/dismiss/i);
  });

  it("treats an unknown button as a denial rather than guessing", () => {
    expect(answerFromChoice("Maybe", described).behavior).toBe("deny");
  });

  it("never persists a rule the engine did not suggest", () => {
    const bare = describePermissionRequest(request);
    expect(answerFromChoice(ALLOW_ALWAYS, bare)).toEqual({ behavior: "allow" });
  });
});

describe("createCoalescer", () => {
  it("collapses a burst of updates into one call", async () => {
    const calls: number[] = [];
    const coalescer = createCoalescer((value: number) => calls.push(value), 1);
    coalescer.push(1);
    coalescer.push(2);
    coalescer.push(3);
    expect(calls).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([3]);
  });

  it("flushes on demand", () => {
    const calls: number[] = [];
    const coalescer = createCoalescer((value: number) => calls.push(value), 1_000);
    coalescer.push(7);
    coalescer.flush();
    expect(calls).toEqual([7]);
    coalescer.flush();
    expect(calls).toEqual([7]);
  });

  it("drops a pending update after disposal", async () => {
    const calls: number[] = [];
    const coalescer = createCoalescer((value: number) => calls.push(value), 1);
    coalescer.push(1);
    coalescer.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    coalescer.push(2);
    coalescer.flush();
    expect(calls).toEqual([]);
  });
});

describe("describeSessionDeletion", () => {
  it("names the session being deleted, so a stray click is answerable", () => {
    const prompt = describeSessionDeletion("Fix the parser");
    expect(prompt.message).toContain("Fix the parser");
    expect(prompt.confirmLabel).toBe(DELETE_SESSION);
  });

  it("says the deletion is permanent and not local to this panel", () => {
    const prompt = describeSessionDeletion("01JABC");
    expect(prompt.detail).toMatch(/permanently/i);
    expect(prompt.detail).toMatch(/cannot be undone/i);
  });
});

describe("confirmsSessionDeletion", () => {
  const prompt = describeSessionDeletion("01JABC");

  it("confirms only on the exact confirmation button", () => {
    expect(confirmsSessionDeletion(DELETE_SESSION, prompt)).toBe(true);
  });

  it("treats every other answer as a refusal, dismissal included", () => {
    // A destructive action may not read "no answer" as consent.
    expect(confirmsSessionDeletion(undefined, prompt)).toBe(false);
    expect(confirmsSessionDeletion("Cancel", prompt)).toBe(false);
    expect(confirmsSessionDeletion("", prompt)).toBe(false);
    expect(confirmsSessionDeletion("delete", prompt)).toBe(false);
    expect(confirmsSessionDeletion("Allow", prompt)).toBe(false);
  });
});
