import type { PermissionDecision, PermissionRequest } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { createPolicyLearner, formatSuggestion, type PolicySuggestion } from "./policy-learn.js";

let nextId = 0;

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  nextId += 1;
  return {
    id: `req-${nextId}`,
    toolName: "bash",
    toolCallId: `call-${nextId}`,
    subject: "git status",
    description: "bash: git status",
    ...overrides,
  };
}

function allow(requestId: string): PermissionDecision {
  return { requestId, behavior: "allow" };
}

function deny(requestId: string, message?: string): PermissionDecision {
  return { requestId, behavior: "deny", ...(message === undefined ? {} : { message }) };
}

describe("createPolicyLearner", () => {
  it("clusters three similar bash denials into one suggestion with the widened specifier", () => {
    const learner = createPolicyLearner();
    const r1 = request({ subject: "git status" });
    const r2 = request({ subject: "git diff" });
    const r3 = request({ subject: "git log --oneline" });
    learner.observe(r1, deny(r1.id));
    learner.observe(r2, deny(r2.id));
    learner.observe(r3, deny(r3.id));

    const suggestions = learner.suggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual<PolicySuggestion>({
      rule: { tool: "bash", specifier: "git *", action: "deny" },
      occurrences: 3,
      examples: ["git status", "git diff", "git log --oneline"],
      direction: "deny",
    });
  });

  it("does not suggest below the threshold", () => {
    const learner = createPolicyLearner();
    const r1 = request({ subject: "git status" });
    const r2 = request({ subject: "git diff" });
    learner.observe(r1, deny(r1.id));
    learner.observe(r2, deny(r2.id));

    expect(learner.suggestions()).toHaveLength(0);
  });

  it("never suggests a cluster with mixed allow/deny decisions, even above threshold", () => {
    const learner = createPolicyLearner();
    const r1 = request({ subject: "git status" });
    const r2 = request({ subject: "git diff" });
    const r3 = request({ subject: "git push" });
    const r4 = request({ subject: "git log" });
    learner.observe(r1, deny(r1.id));
    learner.observe(r2, deny(r2.id));
    // A single allow anywhere in the cluster's history poisons it — a blanket
    // rule (either direction) would contradict a decision the user actually
    // made.
    learner.observe(r3, allow(r3.id));
    learner.observe(r4, deny(r4.id));

    expect(learner.suggestions()).toHaveLength(0);
  });

  it("stays poisoned for a mixed cluster no matter how many more denials pile up", () => {
    const learner = createPolicyLearner({ window: 50 });
    const allowReq = request({ subject: "git push" });
    learner.observe(allowReq, allow(allowReq.id));
    for (let i = 0; i < 10; i++) {
      const r = request({ subject: `git cmd-${i}` });
      learner.observe(r, deny(r.id));
    }

    expect(learner.suggestions()).toHaveLength(0);
  });

  it("tracks allow-clusters and deny-clusters separately", () => {
    const learner = createPolicyLearner();
    const a1 = request({ subject: "npm test" });
    const a2 = request({ subject: "npm run build" });
    const a3 = request({ subject: "npm install" });
    learner.observe(a1, allow(a1.id));
    learner.observe(a2, allow(a2.id));
    learner.observe(a3, allow(a3.id));

    const d1 = request({ subject: "rm -rf tmp" });
    const d2 = request({ subject: "rm -f a" });
    const d3 = request({ subject: "rm b" });
    learner.observe(d1, deny(d1.id));
    learner.observe(d2, deny(d2.id));
    learner.observe(d3, deny(d3.id));

    const suggestions = learner.suggestions();
    expect(suggestions).toHaveLength(2);
    const allowSuggestion = suggestions.find((s) => s.direction === "allow");
    const denySuggestion = suggestions.find((s) => s.direction === "deny");
    expect(allowSuggestion?.rule).toEqual({ tool: "bash", specifier: "npm *", action: "allow" });
    expect(allowSuggestion?.occurrences).toBe(3);
    expect(denySuggestion?.rule).toEqual({ tool: "bash", specifier: "rm *", action: "deny" });
    expect(denySuggestion?.occurrences).toBe(3);
  });

  it("never clusters the same specifier text across different tools", () => {
    const learner = createPolicyLearner();
    // Three bash denials that all widen to "bash git *"...
    for (let i = 0; i < 3; i++) {
      const r = request({ toolName: "bash", subject: `git cmd-${i}` });
      learner.observe(r, deny(r.id));
    }
    // ...and three denials of an unrelated "write" tool whose exact subject
    // happens to collide textually with a bash specifier string.
    for (let i = 0; i < 3; i++) {
      const r = request({
        toolName: "write",
        subject: "git *",
        description: "write: git *",
        suggestedRule: undefined,
      });
      learner.observe(r, deny(r.id));
    }

    const suggestions = learner.suggestions();
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.rule.tool).sort()).toEqual(["bash", "write"]);
  });

  it("ages out old decisions once the window is exceeded", () => {
    const learner = createPolicyLearner({ threshold: 3, window: 3 });
    const r1 = request({ subject: "git status" });
    const r2 = request({ subject: "git diff" });
    const r3 = request({ subject: "git log" });
    learner.observe(r1, deny(r1.id));
    learner.observe(r2, deny(r2.id));
    learner.observe(r3, deny(r3.id));
    expect(learner.suggestions()).toHaveLength(1);

    // A fourth, unrelated decision pushes the window (3) over capacity and
    // evicts the oldest git denial, dropping the git cluster back below
    // threshold.
    const other = request({ toolName: "write", subject: "src/a.ts", suggestedRule: undefined });
    learner.observe(other, allow(other.id));

    expect(learner.suggestions()).toHaveLength(0);
  });

  it("carries the real observed subjects as examples", () => {
    const learner = createPolicyLearner();
    const r1 = request({ subject: "git status --short" });
    const r2 = request({ subject: "git diff HEAD~1" });
    const r3 = request({ subject: "git log -n 5" });
    learner.observe(r1, deny(r1.id));
    learner.observe(r2, deny(r2.id));
    learner.observe(r3, deny(r3.id));

    expect(learner.suggestions()[0]?.examples).toEqual([
      "git status --short",
      "git diff HEAD~1",
      "git log -n 5",
    ]);
  });

  it("falls back to the tool name as the example subject for empty-subject requests", () => {
    const learner = createPolicyLearner();
    for (let i = 0; i < 3; i++) {
      const r = request({ toolName: "todoWrite", subject: "", suggestedRule: undefined });
      learner.observe(r, allow(r.id));
    }

    const suggestions = learner.suggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.examples).toEqual(["todoWrite", "todoWrite", "todoWrite"]);
    expect(suggestions[0]?.rule).toEqual({ tool: "todoWrite", action: "allow" });
  });

  it("clears all state on reset", () => {
    const learner = createPolicyLearner();
    const r1 = request({ subject: "git status" });
    const r2 = request({ subject: "git diff" });
    const r3 = request({ subject: "git log" });
    learner.observe(r1, deny(r1.id));
    learner.observe(r2, deny(r2.id));
    learner.observe(r3, deny(r3.id));
    expect(learner.suggestions()).toHaveLength(1);

    learner.reset();
    expect(learner.suggestions()).toHaveLength(0);

    // The learner keeps working after reset — it's not a one-shot object.
    const r4 = request({ subject: "git status" });
    const r5 = request({ subject: "git diff" });
    const r6 = request({ subject: "git log" });
    learner.observe(r4, deny(r4.id));
    learner.observe(r5, deny(r5.id));
    learner.observe(r6, deny(r6.id));
    expect(learner.suggestions()).toHaveLength(1);
  });
});

describe("formatSuggestion", () => {
  it("phrases a deny suggestion", () => {
    const suggestion: PolicySuggestion = {
      rule: { tool: "bash", specifier: "rm *", action: "deny" },
      occurrences: 3,
      examples: ["rm -rf tmp", "rm -f a", "rm b"],
      direction: "deny",
    };
    expect(formatSuggestion(suggestion)).toBe(
      'You\'ve denied "bash rm *" 3 times. Add a deny rule to your project config?',
    );
  });

  it("phrases an allow suggestion", () => {
    const suggestion: PolicySuggestion = {
      rule: { tool: "bash", specifier: "npm *", action: "allow" },
      occurrences: 4,
      examples: ["npm test", "npm run build", "npm install", "npm ci"],
      direction: "allow",
    };
    expect(formatSuggestion(suggestion)).toBe(
      'You\'ve allowed "bash npm *" 4 times. Add an allow rule to your project config?',
    );
  });

  it("phrases a suggestion for a tool with no specifier", () => {
    const suggestion: PolicySuggestion = {
      rule: { tool: "todoWrite", action: "allow" },
      occurrences: 3,
      examples: ["todoWrite", "todoWrite", "todoWrite"],
      direction: "allow",
    };
    expect(formatSuggestion(suggestion)).toBe(
      'You\'ve allowed "todoWrite" 3 times. Add an allow rule to your project config?',
    );
  });
});
