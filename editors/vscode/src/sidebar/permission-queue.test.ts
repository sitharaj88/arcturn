import { describe, expect, it, vi } from "vitest";
import type { PermissionDecision, PermissionRequest } from "../serve/engine.js";
import {
  describePermissionRequest,
  type PermissionAnswer,
  PermissionQueue,
} from "./permission-queue.js";

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "req-1",
    toolName: "bash",
    toolCallId: "call-1",
    subject: "rm -rf build",
    description: "Run a shell command",
    ...over,
  };
}

interface Harness {
  queue: PermissionQueue;
  decisions: PermissionDecision[];
  asked: PermissionRequest[];
}

function harness(
  answer: (request: PermissionRequest) => Promise<PermissionAnswer>,
  extra: Record<string, unknown> = {},
): Harness {
  const decisions: PermissionDecision[] = [];
  const asked: PermissionRequest[] = [];
  const queue = new PermissionQueue({
    ask: (r) => {
      asked.push(r);
      return answer(r);
    },
    respond: async (decision) => {
      decisions.push(decision);
    },
    ...extra,
  });
  return { queue, decisions, asked };
}

describe("PermissionQueue", () => {
  it("answers a request through respondToPermission with the engine's request id", async () => {
    const h = harness(async () => ({ behavior: "allow" }));
    h.queue.enqueue(request());
    await h.queue.drain();
    expect(h.decisions).toEqual([{ requestId: "req-1", behavior: "allow" }]);
  });

  it("carries a persisted rule when the user chose to remember it", async () => {
    const h = harness(async () => ({
      behavior: "allow",
      persistRule: { tool: "bash", specifier: "rm *", action: "allow", scope: "session" },
    }));
    h.queue.enqueue(request());
    await h.queue.drain();
    expect(h.decisions[0]?.persistRule).toEqual({
      tool: "bash",
      specifier: "rm *",
      action: "allow",
      scope: "session",
    });
  });

  it("asks one at a time and answers every queued request in order", async () => {
    const order: string[] = [];
    let inFlight = 0;
    const h = harness(async (r) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      order.push(r.id);
      return { behavior: "allow" };
    });
    h.queue.enqueue(request({ id: "a" }));
    h.queue.enqueue(request({ id: "b" }));
    h.queue.enqueue(request({ id: "c" }));
    await h.queue.drain();
    expect(order).toEqual(["a", "b", "c"]);
    expect(h.decisions.map((d) => d.requestId)).toEqual(["a", "b", "c"]);
  });

  it("ignores a request id it has already seen", async () => {
    const h = harness(async () => ({ behavior: "allow" }));
    h.queue.enqueue(request({ id: "a" }));
    h.queue.enqueue(request({ id: "a" }));
    await h.queue.drain();
    expect(h.asked).toHaveLength(1);
  });

  it("denies rather than hangs when the sidebar is disposed with work queued", async () => {
    const h = harness(async () => new Promise<PermissionAnswer>(() => {}));
    h.queue.enqueue(request({ id: "a" }));
    h.queue.enqueue(request({ id: "b" }));
    h.queue.dispose();
    await h.queue.drain();
    expect(h.decisions.map((d) => ({ id: d.requestId, behavior: d.behavior }))).toEqual([
      { id: "a", behavior: "deny" },
      { id: "b", behavior: "deny" },
    ]);
    expect(h.decisions[0]?.message).toMatch(/sidebar/i);
  });

  it("denies immediately once disposed, without ever showing a dialog", async () => {
    const h = harness(async () => ({ behavior: "allow" }));
    h.queue.dispose();
    h.queue.enqueue(request());
    await h.queue.drain();
    expect(h.asked).toHaveLength(0);
    expect(h.decisions[0]?.behavior).toBe("deny");
  });

  it("denies when the dialog is dismissed", async () => {
    const h = harness(async () => ({ behavior: "deny", message: "Dismissed in VS Code" }));
    h.queue.enqueue(request());
    await h.queue.drain();
    expect(h.decisions[0]).toMatchObject({ behavior: "deny", message: "Dismissed in VS Code" });
  });

  it("denies, and keeps going, when the dialog itself throws", async () => {
    const onError = vi.fn();
    const h = harness(
      async (r) => {
        if (r.id === "a") throw new Error("window unavailable");
        return { behavior: "allow" };
      },
      { onError },
    );
    h.queue.enqueue(request({ id: "a" }));
    h.queue.enqueue(request({ id: "b" }));
    await h.queue.drain();
    expect(h.decisions.map((d) => [d.requestId, d.behavior])).toEqual([
      ["a", "deny"],
      ["b", "allow"],
    ]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps going when responding fails — a dead socket must not wedge the queue", async () => {
    const onError = vi.fn();
    const asked: string[] = [];
    const queue = new PermissionQueue({
      ask: async (r) => {
        asked.push(r.id);
        return { behavior: "allow" };
      },
      respond: async () => {
        throw new Error("connection closed");
      },
      onError,
    });
    queue.enqueue(request({ id: "a" }));
    queue.enqueue(request({ id: "b" }));
    await queue.drain();
    expect(asked).toEqual(["a", "b"]);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("reports how many requests are outstanding", async () => {
    const h = harness(async () => new Promise<PermissionAnswer>(() => {}));
    expect(h.queue.size).toBe(0);
    h.queue.enqueue(request({ id: "a" }));
    h.queue.enqueue(request({ id: "b" }));
    expect(h.queue.size).toBe(2);
    h.queue.dispose();
    await h.queue.drain();
    expect(h.queue.size).toBe(0);
  });
});

describe("describePermissionRequest", () => {
  it("uses the engine's own description as the modal's message", () => {
    const described = describePermissionRequest(request());
    expect(described.message).toBe("Run a shell command");
  });

  it("names the tool and quotes the subject exactly as the engine sent it", () => {
    const described = describePermissionRequest(request({ subject: "rm -rf build --no-preserve" }));
    expect(described.detail).toContain("bash");
    expect(described.detail).toContain("rm -rf build --no-preserve");
  });

  it("renders the engine's arguments verbatim when they are known", () => {
    const described = describePermissionRequest(request(), { command: "rm -rf build", timeout: 5 });
    expect(described.detail).toContain('"command": "rm -rf build"');
    expect(described.detail).toContain('"timeout": 5');
  });

  it("attributes a delegated request, and renders nothing when it is not delegated", () => {
    expect(describePermissionRequest(request({ origin: "@qa · step 3" })).detail).toContain(
      "@qa · step 3",
    );
    expect(describePermissionRequest(request()).detail).not.toMatch(/requested by/i);
  });

  it("truncates arguments too large for a modal, and says that it did", () => {
    const described = describePermissionRequest(request(), { blob: "x".repeat(50_000) });
    expect(described.detail.length).toBeLessThan(5_000);
    expect(described.detail).toMatch(/truncated/i);
  });

  it("offers to remember only the rule the engine itself suggested", () => {
    expect(describePermissionRequest(request()).suggestedRule).toBeUndefined();
    const withRule = describePermissionRequest(
      request({ suggestedRule: { tool: "bash", specifier: "rm *", action: "allow" } }),
    );
    expect(withRule.suggestedRule).toEqual({
      tool: "bash",
      specifier: "rm *",
      action: "allow",
      scope: "session",
    });
  });
});
