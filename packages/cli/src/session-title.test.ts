import type { AgentEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  createTitleGenerator,
  TITLE_INPUT_CAP_CHARS,
  TITLE_MAX_CHARS,
  type TitleGeneratorDeps,
  titleRequestPrompt,
} from "./session-title.js";

function runStart(sessionId: string, prompt: string): AgentEvent {
  return {
    type: "runStart",
    sessionId,
    prompt: { role: "user", content: [{ type: "text", text: prompt }], timestamp: 0 },
  };
}

function messageEnd(text: string): AgentEvent {
  return {
    type: "messageEnd",
    message: {
      role: "assistant",
      content: text === "" ? [] : [{ type: "text", text }],
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn",
      timestamp: 0,
    },
  };
}

function runEnd(reason: "completed" | "aborted" | "error"): AgentEvent {
  return { type: "runEnd", reason };
}

/** Drain the generator's fire-and-forget chain (a few microtask hops). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

interface Recorded {
  deps: TitleGeneratorDeps;
  generated: { prompt: string; reply: string }[];
  titles: { sessionId: string; title: string }[];
}

function recordedDeps(overrides: Partial<TitleGeneratorDeps> = {}): Recorded {
  const generated: { prompt: string; reply: string }[] = [];
  const titles: { sessionId: string; title: string }[] = [];
  const deps: TitleGeneratorDeps = {
    shouldTitle: () => true,
    generate: async (prompt, reply) => {
      generated.push({ prompt, reply });
      return "Fixing the login bug";
    },
    setTitle: async (sessionId, title) => {
      titles.push({ sessionId, title });
    },
    ...overrides,
  };
  return { deps, generated, titles };
}

describe("cleanTitle", () => {
  it("passes a plain title through", () => {
    expect(cleanTitle("Fixing the login bug")).toBe("Fixing the login bug");
  });

  it("strips a code fence", () => {
    expect(cleanTitle("```\nFixing the login bug\n```")).toBe("Fixing the login bug");
    expect(cleanTitle("```text\nFixing the login bug\n```")).toBe("Fixing the login bug");
  });

  it("strips wrapping quotes", () => {
    expect(cleanTitle('"Fixing the login bug"')).toBe("Fixing the login bug");
    expect(cleanTitle("'Fixing the login bug'")).toBe("Fixing the login bug");
  });

  it("collapses a multi-line answer onto one line", () => {
    expect(cleanTitle("Fixing the\n  login   bug\n")).toBe("Fixing the login bug");
  });

  it("caps an overlong title at a word boundary with an ellipsis", () => {
    const long =
      "A very long meandering session title that a model produced despite every instruction";
    const cleaned = cleanTitle(long);
    expect(cleaned.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(cleaned.endsWith("…")).toBe(true);
    // Cut on a word boundary: the char before the ellipsis is not a space,
    // and the truncation did not slice a word in half.
    expect(long.startsWith(cleaned.slice(0, -1))).toBe(true);
    expect(long[cleaned.length - 1]).toBe(" ");
  });

  it("returns empty for unusable output", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle('""')).toBe("");
    expect(cleanTitle("```\n```")).toBe("");
  });
});

describe("titleRequestPrompt", () => {
  it("carries both sides, omitting an empty reply block", () => {
    const both = titleRequestPrompt("fix the bug", "done");
    expect(both).toContain("fix the bug");
    expect(both).toContain("done");
    const promptOnly = titleRequestPrompt("fix the bug", "");
    expect(promptOnly).toContain("fix the bug");
    expect(promptOnly).not.toContain("assistant answered");
  });
});

describe("createTitleGenerator", () => {
  it("fires once, on the first completed runEnd, with the captured exchange", async () => {
    const { deps, generated, titles } = recordedDeps();
    const generator = createTitleGenerator(deps);

    generator.onEvent(runStart("s1", "please fix the login bug"));
    generator.onEvent(messageEnd("I fixed it."));
    generator.onEvent(runEnd("completed"));
    await flush();

    expect(generated).toEqual([{ prompt: "please fix the login bug", reply: "I fixed it." }]);
    expect(titles).toEqual([{ sessionId: "s1", title: "Fixing the login bug" }]);

    // A second completed run in the same session never retries.
    generator.onEvent(runStart("s1", "and the logout bug"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toHaveLength(1);
  });

  it("keeps the FIRST prompt but the LAST non-empty reply", async () => {
    const { deps, generated } = recordedDeps();
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "first prompt"));
    generator.onEvent(messageEnd("thinking about tools"));
    generator.onEvent(messageEnd(""));
    generator.onEvent(messageEnd("final answer"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(generated).toEqual([{ prompt: "first prompt", reply: "final answer" }]);
  });

  it("stays armed across an error or aborted run, titling the first completed one", async () => {
    const { deps, titles } = recordedDeps();
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "try something"));
    generator.onEvent(runEnd("error"));
    generator.onEvent(runStart("s1", "try again"));
    generator.onEvent(runEnd("aborted"));
    await flush();
    expect(titles).toHaveLength(0);

    generator.onEvent(runStart("s1", "third time"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toEqual([{ sessionId: "s1", title: "Fixing the login bug" }]);
  });

  it("asks shouldTitle at trigger time and does nothing when it says no", async () => {
    const { deps, generated, titles } = recordedDeps({ shouldTitle: () => false });
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "hello"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(generated).toHaveLength(0);
    expect(titles).toHaveLength(0);
  });

  it("swallows a failing generate — a title must never break a run", async () => {
    const { deps, titles } = recordedDeps({
      generate: async () => {
        throw new Error("provider down");
      },
    });
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "hello"));
    expect(() => generator.onEvent(runEnd("completed"))).not.toThrow();
    await flush();
    expect(titles).toHaveLength(0);
  });

  it("reports a failing setTitle instead of dropping it on the floor", async () => {
    // The Windows shape: the model answered, the header rewrite did not land.
    // Swallowing this is what let a user's titles never work with nothing in
    // any log to say why.
    const refused: NodeJS.ErrnoException = new Error("EPERM: operation not permitted, rename");
    refused.code = "EPERM";
    const reported: unknown[] = [];
    const { deps } = recordedDeps({
      setTitle: async () => {
        throw refused;
      },
      onError: (error) => reported.push(error),
    });
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "hello"));
    expect(() => generator.onEvent(runEnd("completed"))).not.toThrow();

    // ...and the run still does not learn about it.
    await expect(generator.settled()).resolves.toBeUndefined();
    expect(reported).toEqual([refused]);
  });

  it("settles for a caller whether the attempt worked, was declined, or never ran", async () => {
    const idle = createTitleGenerator(recordedDeps().deps);
    // Nothing triggered: a caller must not be left waiting on a run that was
    // never going to be titled.
    await expect(idle.settled()).resolves.toBeUndefined();

    const declined = createTitleGenerator(recordedDeps({ shouldTitle: () => false }).deps);
    declined.onEvent(runStart("s1", "hello"));
    declined.onEvent(runEnd("completed"));
    await expect(declined.settled()).resolves.toBeUndefined();

    const worked = recordedDeps();
    const generator = createTitleGenerator(worked.deps);
    generator.onEvent(runStart("s1", "hello"));
    generator.onEvent(runEnd("completed"));
    // The attempt is scheduled synchronously from `runEnd`, so awaiting this
    // once is enough — no flush, no deadline.
    await generator.settled();
    expect(worked.titles).toEqual([{ sessionId: "s1", title: "Fixing the login bug" }]);
  });

  it("skips a run with no user text, staying armed for the first that has some", async () => {
    const { deps, titles } = recordedDeps();
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", ""));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toHaveLength(0);

    generator.onEvent(runStart("s1", "now with words"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toHaveLength(1);
  });

  it("reset re-arms for a new session", async () => {
    const { deps, titles } = recordedDeps();
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "first session"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toHaveLength(1);

    generator.reset();
    generator.onEvent(runStart("s2", "second session"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toHaveLength(2);
    expect(titles[1]?.sessionId).toBe("s2");
  });

  it("re-arms by itself when a runStart names a different session (a /clear swap)", async () => {
    const { deps, generated, titles } = recordedDeps();
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "old session"));
    generator.onEvent(runEnd("completed"));
    await flush();

    // No reset() call: the new session id alone drops the stale capture.
    generator.onEvent(runStart("s2", "new session"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toHaveLength(2);
    expect(generated[1]).toEqual({ prompt: "new session", reply: "" });
  });

  it("stops reading message text after its one attempt", async () => {
    const { deps, generated } = recordedDeps();
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "hello"));
    generator.onEvent(messageEnd("first answer"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(generated).toHaveLength(1);

    // The attempt is spent: no later message's text can ever be used in this
    // session, so the generator must not even read it. The trap flips the
    // moment `content` is touched.
    let read = false;
    const trapped = {
      type: "messageEnd",
      message: Object.defineProperty(
        {
          role: "assistant",
          model: "test/model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "endTurn",
          timestamp: 0,
        },
        "content",
        {
          get() {
            read = true;
            return [];
          },
        },
      ),
    } as unknown as AgentEvent;
    generator.onEvent(trapped);
    expect(read).toBe(false);

    // The early return must not outlive the session: a runStart carrying a
    // NEW session id still re-arms, and the next exchange is read again.
    generator.onEvent(runStart("s2", "second session"));
    generator.onEvent(messageEnd("second answer"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(generated[1]).toEqual({ prompt: "second session", reply: "second answer" });
  });

  it("caps the text handed to generate on both sides", async () => {
    const { deps, generated } = recordedDeps();
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "p".repeat(10_000)));
    generator.onEvent(messageEnd("r".repeat(10_000)));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(generated[0]?.prompt).toHaveLength(TITLE_INPUT_CAP_CHARS);
    expect(generated[0]?.reply).toHaveLength(TITLE_INPUT_CAP_CHARS);
  });

  it("cleans what generate returns before writing it", async () => {
    const { deps, titles } = recordedDeps({
      generate: async () => '```\n"A fenced, quoted\ntitle"\n```',
    });
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "hello"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toEqual([{ sessionId: "s1", title: "A fenced, quoted title" }]);
  });

  it("never writes an empty title", async () => {
    const { deps, titles } = recordedDeps({ generate: async () => "```\n```" });
    const generator = createTitleGenerator(deps);
    generator.onEvent(runStart("s1", "hello"));
    generator.onEvent(runEnd("completed"));
    await flush();
    expect(titles).toHaveLength(0);
  });
});
