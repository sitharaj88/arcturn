import { describe, expect, it, vi } from "vitest";
import type { PermissionDecision, PermissionRequest } from "../serve/engine.js";
import { ALLOW, ALLOW_SESSION, DENY } from "./dialog.js";
import {
  describePermissionRequest,
  type PermissionAnswer,
  PermissionQueue,
} from "./permission-queue.js";
import {
  type PermissionCard,
  PermissionSurface,
  type PermissionSurfaceHost,
  permissionCard,
} from "./permission-surface.js";

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm-1",
    toolName: "bash",
    toolCallId: "call-1",
    subject: "rm -rf build",
    description: "Run rm -rf build in /repo/arcturn",
    ...over,
  };
}

interface Harness {
  surface: PermissionSurface;
  host: PermissionSurfaceHost;
  cards: (PermissionCard | undefined)[];
  modals: string[];
  /** Resolve the modal that is currently open. */
  answerModal: (choice: string | undefined) => void;
  diagnostics: string[];
  visible: { value: boolean };
}

function harness(over: Partial<PermissionSurfaceHost> = {}): Harness {
  const cards: (PermissionCard | undefined)[] = [];
  const modals: string[] = [];
  const diagnostics: string[] = [];
  const visible = { value: true };
  let settleModal: ((choice: string | undefined) => void) | undefined;
  const host: PermissionSurfaceHost = {
    reveal: async () => visible.value,
    postCard: (card) => cards.push(card),
    askModal: async (described) => {
      modals.push(described.message);
      return await new Promise<string | undefined>((resolve) => {
        settleModal = resolve;
      });
    },
    onDiagnostic: (line) => diagnostics.push(line),
    ...over,
  };
  return {
    surface: new PermissionSurface(host),
    host,
    cards,
    modals,
    diagnostics,
    visible,
    answerModal: (choice) => {
      const resolve = settleModal;
      settleModal = undefined;
      resolve?.(choice);
    },
  };
}

/** Let the surface's own `await`s run. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

describe("permissionCard", () => {
  it("quotes the engine and adds nothing of its own", () => {
    const raised = request({ origin: "@qa-functional · step 3" });
    const described = describePermissionRequest(raised, { command: "rm -rf build" });
    const card = permissionCard(raised, described);
    expect(card.id).toBe("perm-1");
    expect(card.description).toBe("Run rm -rf build in /repo/arcturn");
    expect(card.tool).toBe("bash");
    expect(card.subject).toBe("rm -rf build");
    expect(card.origin).toBe("@qa-functional · step 3");
  });

  it("renders the arguments byte for byte the way the modal renders them", () => {
    // The two surfaces must not be able to disagree about what was asked.
    const raised = request();
    const args = { command: "rm -rf build", timeout: 30 };
    const described = describePermissionRequest(raised, args);
    const card = permissionCard(raised, described, args);
    expect(card.args).toBeDefined();
    expect(described.detail).toContain(card.args as string);
  });

  it("carries no arguments when the engine never sent any", () => {
    const raised = request();
    const card = permissionCard(raised, describePermissionRequest(raised));
    expect(card.args).toBeUndefined();
  });

  it("carries no origin when the request was not delegated", () => {
    const raised = request();
    const card = permissionCard(raised, describePermissionRequest(raised));
    expect(card.origin).toBeUndefined();
  });

  it("offers deny first and allow last, with the engine's own labels", () => {
    const raised = request({ suggestedRule: { tool: "bash", action: "allow" } });
    const card = permissionCard(raised, describePermissionRequest(raised));
    expect(card.choices).toEqual([
      { id: "deny", label: DENY },
      { id: "allowSession", label: ALLOW_SESSION },
      { id: "allow", label: ALLOW },
    ]);
  });

  it("offers no session button when the engine attached no rule", () => {
    const raised = request();
    const card = permissionCard(raised, describePermissionRequest(raised));
    expect(card.choices).toEqual([
      { id: "deny", label: DENY },
      { id: "allow", label: ALLOW },
    ]);
  });
});

describe("PermissionSurface, on a panel that can be seen", () => {
  it("reveals the panel before it puts a card in it", async () => {
    const order: string[] = [];
    const test = harness({
      reveal: async () => {
        order.push("reveal");
        return true;
      },
      postCard: () => order.push("card"),
    });
    void test.surface.ask(request());
    await settle();
    expect(order).toEqual(["reveal", "card"]);
  });

  it("puts the card in the panel and raises no modal", async () => {
    const test = harness();
    void test.surface.ask(request());
    await settle();
    expect(test.cards.at(-1)?.id).toBe("perm-1");
    expect(test.modals).toEqual([]);
  });

  it("allows once when Allow is pressed", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.answer("perm-1", ALLOW);
    expect(await answer).toEqual({ behavior: "allow" });
    expect(test.cards.at(-1)).toBeUndefined();
  });

  it("persists only the rule the engine suggested, scoped to the session", async () => {
    const test = harness();
    const answer = test.surface.ask(
      request({ suggestedRule: { tool: "bash", specifier: "rm *", action: "allow" } }),
    );
    await settle();
    test.surface.answer("perm-1", ALLOW_SESSION);
    expect(await answer).toEqual({
      behavior: "allow",
      persistRule: { tool: "bash", specifier: "rm *", action: "allow", scope: "session" },
    });
  });

  it("never invents a rule when the page asks for one the engine did not offer", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.answer("perm-1", ALLOW_SESSION);
    expect(await answer).toEqual({ behavior: "allow" });
  });

  it("denies when Deny is pressed", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.answer("perm-1", DENY);
    expect(await answer).toEqual({
      behavior: "deny",
      message: "Denied by the user in VS Code.",
    });
  });

  it("denies a label it does not recognise", async () => {
    // The page sends a string. Anything that is not an explicit allow is a
    // denial, which is what makes the round trip safe to make at all.
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.answer("perm-1", "Yes obviously");
    expect((await answer).behavior).toBe("deny");
  });

  it("ignores an answer to a request it is not showing", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.answer("perm-9", ALLOW);
    let resolved = false;
    void answer.then(() => {
      resolved = true;
    });
    await settle();
    expect(resolved).toBe(false);
    // …and the card it *is* showing still answers.
    test.surface.answer("perm-1", DENY);
    expect((await answer).behavior).toBe("deny");
  });

  it("takes only the first answer", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.answer("perm-1", DENY);
    test.surface.answer("perm-1", ALLOW);
    expect((await answer).behavior).toBe("deny");
  });
});

describe("PermissionSurface, when the panel cannot be seen", () => {
  it("falls back to the native modal rather than asking where nobody is looking", async () => {
    const test = harness();
    test.visible.value = false;
    const answer = test.surface.ask(request());
    await settle();
    expect(test.cards).toEqual([]);
    expect(test.modals).toEqual(["Run rm -rf build in /repo/arcturn"]);
    test.answerModal(ALLOW);
    expect(await answer).toEqual({ behavior: "allow" });
  });

  it("denies a dismissed modal", async () => {
    const test = harness();
    test.visible.value = false;
    const answer = test.surface.ask(request());
    await settle();
    test.answerModal(undefined);
    expect(await answer).toEqual({
      behavior: "deny",
      message: "Denied: the permission dialog was dismissed in VS Code.",
    });
  });

  it("denies when the modal itself fails", async () => {
    const test = harness({
      reveal: async () => false,
      askModal: async () => {
        throw new Error("no window");
      },
    });
    const answer = test.surface.ask(request());
    await settle();
    expect((await answer).behavior).toBe("deny");
    expect(test.diagnostics.join("\n")).toContain("no window");
  });

  it("escalates to the modal when the panel is hidden with a card still up", async () => {
    // The edge a modal never had: an inline prompt on a hidden panel is a run
    // blocked on something nobody can see.
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    expect(test.cards.at(-1)?.id).toBe("perm-1");
    test.surface.setVisible(false);
    await settle();
    // The card is withdrawn in the same breath: one live surface per request.
    expect(test.cards.at(-1)).toBeUndefined();
    expect(test.modals).toEqual(["Run rm -rf build in /repo/arcturn"]);
    test.answerModal(DENY);
    expect((await answer).behavior).toBe("deny");
  });

  it("stops taking card answers once the modal owns the request", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.setVisible(false);
    await settle();
    test.surface.answer("perm-1", ALLOW);
    let resolved = false;
    void answer.then(() => {
      resolved = true;
    });
    await settle();
    expect(resolved).toBe(false);
    test.answerModal(DENY);
    expect((await answer).behavior).toBe("deny");
  });

  it("does not raise a second modal when the panel is hidden twice", async () => {
    const test = harness();
    void test.surface.ask(request());
    await settle();
    test.surface.setVisible(false);
    test.surface.setVisible(false);
    await settle();
    expect(test.modals).toHaveLength(1);
  });

  it("leaves the modal in charge when the panel comes back", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.setVisible(false);
    await settle();
    const seen = test.cards.length;
    test.surface.setVisible(true);
    await settle();
    // No second card: the question is already on screen somewhere else, and
    // two surfaces for one request is the one thing this must not do.
    expect(test.cards).toHaveLength(seen);
    test.answerModal(ALLOW);
    expect((await answer).behavior).toBe("allow");
  });

  it("does nothing on a visibility change with nothing pending", async () => {
    const test = harness();
    test.surface.setVisible(false);
    await settle();
    expect(test.modals).toEqual([]);
    expect(test.cards).toEqual([]);
  });
});

describe("PermissionSurface, when something else answers first", () => {
  it("takes the card down and denies when a decision goes on the wire elsewhere", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.settle("perm-1");
    expect(test.cards.at(-1)).toBeUndefined();
    expect((await answer).behavior).toBe("deny");
  });

  it("ignores a settle for a request it is not showing", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.settle("perm-9");
    expect(test.cards.at(-1)?.id).toBe("perm-1");
    test.surface.answer("perm-1", ALLOW);
    expect((await answer).behavior).toBe("allow");
  });

  it("denies what is pending when it is disposed", async () => {
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.dispose();
    expect(test.cards.at(-1)).toBeUndefined();
    expect((await answer).behavior).toBe("deny");
  });

  it("denies a request that arrives after disposal instead of showing a card", async () => {
    const test = harness();
    test.surface.dispose();
    const answer = test.surface.ask(request());
    expect((await answer).behavior).toBe("deny");
    await settle();
    expect(test.cards).toEqual([]);
    expect(test.modals).toEqual([]);
  });

  it("shows no card for a request disposed while the panel was still revealing", async () => {
    let release: (() => void) | undefined;
    const test = harness({
      reveal: () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    });
    const answer = test.surface.ask(request());
    test.surface.dispose();
    release?.();
    await settle();
    expect(test.cards).toEqual([]);
    expect((await answer).behavior).toBe("deny");
  });
});

describe("PermissionSurface behind the queue", () => {
  it("shows several requests in arrival order and answers them in that order", async () => {
    const test = harness();
    const decisions: PermissionDecision[] = [];
    const queue = new PermissionQueue({
      ask: (raised) => test.surface.ask(raised, undefined) as Promise<PermissionAnswer>,
      respond: async (decision) => {
        decisions.push(decision);
      },
      onDecision: (decision) => test.surface.settle(decision.requestId),
    });

    queue.enqueue(request({ id: "a", subject: "one" }));
    queue.enqueue(request({ id: "b", subject: "two" }));
    queue.enqueue(request({ id: "c", subject: "three" }));

    for (const [id, choice] of [
      ["a", ALLOW],
      ["b", DENY],
      ["c", ALLOW],
    ] as const) {
      await settle();
      expect(test.cards.at(-1)?.id).toBe(id);
      test.surface.answer(id, choice);
      await settle();
    }
    await queue.drain();

    expect(decisions.map((decision) => [decision.requestId, decision.behavior])).toEqual([
      ["a", "allow"],
      ["b", "deny"],
      ["c", "allow"],
    ]);
    // Nothing is left on screen once the last one is answered.
    expect(test.cards.at(-1)).toBeUndefined();
  });

  it("denies what is on the card when the queue is disposed", async () => {
    const test = harness();
    const decisions: PermissionDecision[] = [];
    const queue = new PermissionQueue({
      ask: (raised) => test.surface.ask(raised, undefined) as Promise<PermissionAnswer>,
      respond: async (decision) => {
        decisions.push(decision);
      },
      onDecision: (decision) => test.surface.settle(decision.requestId),
    });
    queue.enqueue(request({ id: "a" }));
    queue.enqueue(request({ id: "b" }));
    await settle();
    expect(test.cards.at(-1)?.id).toBe("a");

    queue.dispose();
    await queue.drain();

    expect(decisions.map((decision) => [decision.requestId, decision.behavior])).toEqual([
      ["a", "deny"],
      ["b", "deny"],
    ]);
    // And the card came down with them: no control on screen for a request
    // the engine has already been told about.
    expect(test.cards.at(-1)).toBeUndefined();
  });

  it("reports a reveal that threw rather than swallowing it", async () => {
    const test = harness({
      reveal: async () => {
        throw new Error("no view");
      },
    });
    const answer = test.surface.ask(request());
    await settle();
    expect(test.diagnostics.join("\n")).toContain("no view");
    // A reveal that failed is a panel that cannot be seen, so the modal takes
    // it — the request is never left with no surface at all.
    expect(test.modals).toHaveLength(1);
    test.answerModal(DENY);
    expect((await answer).behavior).toBe("deny");
  });

  it("denies the one it was already showing if a second ask somehow arrives", async () => {
    // `PermissionQueue` serialises, so this cannot happen through the shipped
    // wiring. It is guarded anyway because the failure it would otherwise
    // produce is the invisible one: a request whose promise nothing ever
    // resolves, and an engine waiting on it forever.
    const test = harness();
    const first = test.surface.ask(request({ id: "a" }));
    await settle();
    const second = test.surface.ask(request({ id: "b" }));
    await settle();
    expect((await first).behavior).toBe("deny");
    expect(test.cards.at(-1)?.id).toBe("b");
    test.surface.answer("b", ALLOW);
    expect((await second).behavior).toBe("allow");
  });

  it("denies rather than throwing when the modal cannot even be raised", async () => {
    // A synchronous throw, not a rejection: `showWarningMessage` is a Thenable
    // from another process, and a host that blows up before returning one must
    // still produce a decision.
    const test = harness({
      reveal: async () => false,
      askModal: (() => {
        throw new Error("host gone");
      }) as PermissionSurfaceHost["askModal"],
    });
    const answer = test.surface.ask(request());
    await settle();
    expect((await answer).behavior).toBe("deny");
    expect(test.diagnostics.join("\n")).toContain("host gone");
  });

  it("does not leave a request unanswered when the card is never touched", async () => {
    // The property the whole file exists for: every path out of `ask` settles.
    const test = harness();
    const answer = test.surface.ask(request());
    await settle();
    test.surface.dispose();
    await expect(answer).resolves.toMatchObject({ behavior: "deny" });
  });
});

describe("PermissionSurface diagnostics", () => {
  it("says nothing when no sink was given", async () => {
    const surface = new PermissionSurface({
      reveal: async () => {
        throw new Error("boom");
      },
      postCard: () => {},
      askModal: async () => DENY,
    });
    const answer = surface.ask(request());
    expect((await answer).behavior).toBe("deny");
  });

  it("does not call postCard for a request the modal took", async () => {
    const postCard = vi.fn();
    const surface = new PermissionSurface({
      reveal: async () => false,
      postCard,
      askModal: async () => ALLOW,
    });
    expect((await surface.ask(request())).behavior).toBe("allow");
    expect(postCard).not.toHaveBeenCalled();
  });
});
