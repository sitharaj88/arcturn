/**
 * `SessionHost`'s half of RFC 0005 §1.1: which refusals it makes, and — the
 * part that matters — that it makes them *before* the agent is touched.
 *
 * The resolver here is a stub, deliberately. `@arcturn/cli`'s real one is
 * proved against real files in `context.test.ts`, and the whole path is proved
 * against a real provider in `serve.test.ts`. What is left for this file is the
 * policy this package owns: the vision gate, the mention-vs-attachment split,
 * and what a host with no resolver wired does.
 */

import { Agent } from "@arcturn/core";
import type { AgentEvent, ModelSpec, PromptAttachment, UserContent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  ContextRefusedError,
  type ContextResolver,
  PROMPT_ATTACHMENT_MAX_BYTES,
  type ResolvedPrompt,
} from "./prompt-context.js";
import { SessionHost, SessionHostError } from "./session-host.js";
import { createScriptedLLM, TEST_MODEL, textTurn } from "./test-helpers/fake-llm.js";

const VISION_MODEL: ModelSpec = {
  ...TEST_MODEL,
  id: "test/sees",
  displayName: "Seeing Model",
  capabilities: { ...TEST_MODEL.capabilities, vision: true },
};

const PIXEL = "AAAA";

/** A resolver scripted with what it should return, and a record of what it saw. */
function stubResolver(
  result: Partial<ResolvedPrompt> | ContextRefusedError,
): ContextResolver & { seen: Array<{ cwd: string; text: string }> } {
  const seen: Array<{ cwd: string; text: string }> = [];
  return {
    seen,
    async buildPrompt(request) {
      seen.push({ cwd: request.cwd, text: request.text });
      if (result instanceof ContextRefusedError) throw result;
      return { text: request.text, images: [], refusals: [], ...result };
    },
    async resolve(request) {
      return {
        query: request.query,
        path: `${request.cwd}/${request.query}`,
        relativePath: request.query,
        inWorkspace: true,
        exists: true,
        bytes: 3,
        kind: "file",
      };
    },
  };
}

interface Fixture {
  host: SessionHost;
  /**
   * Every value `SessionHost` actually handed `Agent.prompt`.
   *
   * Captured at that seam rather than off the `runStart` event, because
   * `Agent` normalizes a bare string into `[{ type: "text" }]` on the way in —
   * so the event cannot distinguish "the host passed a string" from "the host
   * built a one-block array", and one of the things worth pinning here is that
   * a prompt with no images stays the former.
   */
  prompts: unknown[];
}

function buildHost(options: { resolver?: ContextResolver; model?: ModelSpec } = {}): Fixture {
  const prompts: unknown[] = [];
  const llm = createScriptedLLM([textTurn("ok")]);
  const host = new SessionHost({
    agentFactory: (opts) => {
      const agent = new Agent({
        llm,
        model: options.model ?? TEST_MODEL,
        systemPrompt: "You are a test agent.",
        tools: [],
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      });
      const real = agent.prompt.bind(agent);
      agent.prompt = async (input) => {
        prompts.push(input);
        await real(input);
      };
      return agent;
    },
    defaultCwd: "/tmp/arcturn-context-test",
    ...(options.resolver === undefined ? {} : { contextResolver: options.resolver }),
  });
  return { host, prompts };
}

/** Flatten a recorded prompt to the text a model would read. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as UserContent[])
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

describe("SessionHost.prompt: mention expansion", () => {
  it("hands the agent what the resolver produced, not what the client sent", async () => {
    // The bug RFC 0005 §0 names, in one assertion: the served path used to pass
    // `text` through verbatim, so this was the client's string either way.
    const resolver = stubResolver({ text: "look at @a.ts\n\n@a.ts:\n```\nCONTENT\n```" });
    const { host, prompts } = buildHost({ resolver });
    const header = await host.createSession({});
    await host.prompt(header.sessionId, "look at @a.ts");

    expect(textOf(prompts[0] ?? "")).toContain("CONTENT");
  });

  it("resolves against the SESSION's cwd, not the server's default", async () => {
    const resolver = stubResolver({});
    const { host } = buildHost({ resolver });
    const header = await host.createSession({ cwd: "sub" });
    await host.prompt(header.sessionId, "hi");

    expect(resolver.seen[0]?.cwd).toBe(header.cwd);
    expect(header.cwd).toMatch(/sub$/);
  });

  it("turns each mention refusal into a notice an attached client can see", async () => {
    const resolver = stubResolver({
      refusals: [{ what: "@../secrets", reason: "resolves outside the workspace" }],
    });
    const { host } = buildHost({ resolver });
    const header = await host.createSession({});
    const events: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => events.push(event));

    await host.prompt(header.sessionId, "read @../secrets");

    const notice = events.find(
      (event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice",
    );
    expect(notice?.text).toContain("@../secrets");
    expect(notice?.text).toContain("outside the workspace");
    // Not fatal: the mention is one token in prose a person typed, and the TUI
    // has always carried on. What was missing was saying so.
    expect(events.some((event) => event.type === "runEnd")).toBe(true);
  });
});

describe("SessionHost.prompt: the vision gate", () => {
  it("refuses an image ATTACHMENT for a text-only model, before a run starts", async () => {
    const resolver = stubResolver({
      images: [
        {
          content: { type: "image", data: PIXEL, mimeType: "image/png" },
          source: "attachment",
          label: "shot.png",
        },
      ],
    });
    const { host, prompts } = buildHost({ resolver });
    const header = await host.createSession({});
    const events: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => events.push(event));

    await expect(host.prompt(header.sessionId, "what is this?")).rejects.toThrow(
      /cannot see images/,
    );

    // "Before the turn is spent" is these two lines. A refusal that arrived
    // after `runStart` would still throw, and would still have cost a turn.
    expect(prompts).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("names the model and the file in the refusal", async () => {
    const resolver = stubResolver({
      images: [
        {
          content: { type: "image", data: PIXEL, mimeType: "image/png" },
          source: "attachment",
          label: "shot.png",
        },
      ],
    });
    const { host } = buildHost({ resolver });
    const header = await host.createSession({});
    await expect(host.prompt(header.sessionId, "x")).rejects.toThrow(/Fake Test Model/);
    await expect(host.prompt(header.sessionId, "x")).rejects.toThrow(/shot\.png/);
  });

  it("degrades an image MENTION with a notice instead, exactly as the TUI does", async () => {
    const resolver = stubResolver({
      text: "look at @shot.png",
      images: [
        {
          content: { type: "image", data: PIXEL, mimeType: "image/png" },
          source: "mention",
          label: "shot.png",
        },
      ],
    });
    const { host, prompts } = buildHost({ resolver });
    const header = await host.createSession({});
    const events: AgentEvent[] = [];
    host.observe(header.sessionId, (event) => events.push(event));

    await host.prompt(header.sessionId, "look at @shot.png");

    expect(events.some((event) => event.type === "notice")).toBe(true);
    // The run happened, the image did not go, and the mention is still in the
    // text the model reads.
    expect(prompts).toHaveLength(1);
    expect(textOf(prompts[0] ?? "")).toContain("@shot.png");
    expect(typeof prompts[0]).toBe("string");
  });

  it("sends the image when the model can see one", async () => {
    const resolver = stubResolver({
      images: [
        {
          content: { type: "image", data: PIXEL, mimeType: "image/png" },
          source: "attachment",
          label: "shot.png",
        },
      ],
    });
    const { host, prompts } = buildHost({ resolver, model: VISION_MODEL });
    const header = await host.createSession({});
    await host.prompt(header.sessionId, "what is this?");

    const content = prompts[0] as UserContent[];
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((block) => block.type === "image")).toBe(true);
  });

  it("keeps a text-only prompt a plain string, so history is unchanged by this feature", async () => {
    const { host, prompts } = buildHost({ resolver: stubResolver({}) });
    const header = await host.createSession({});
    await host.prompt(header.sessionId, "hello");
    expect(prompts[0]).toBe("hello");
  });
});

describe("SessionHost.prompt: attachment refusals", () => {
  it("maps a resolver's refusal to invalidRequest, and spends no turn", async () => {
    const { host, prompts } = buildHost({
      resolver: stubResolver(new ContextRefusedError('Attachment "x" resolves outside')),
    });
    const header = await host.createSession({});
    await expect(host.prompt(header.sessionId, "x")).rejects.toMatchObject({
      code: "invalidRequest",
    });
    expect(prompts).toHaveLength(0);
  });

  it("refuses attachments outright when no resolver was wired", async () => {
    // A host assembled without one *is* the pre-RFC-0005 engine. Running the
    // turn without the attachments would be the silent drop; refusing is loud
    // and fixable.
    const { host, prompts } = buildHost();
    const header = await host.createSession({});
    const attachments: PromptAttachment[] = [{ kind: "file", path: "a.ts" }];
    await expect(host.prompt(header.sessionId, "x", attachments)).rejects.toBeInstanceOf(
      SessionHostError,
    );
    expect(prompts).toHaveLength(0);
  });

  it("still runs a plain prompt when no resolver was wired", async () => {
    const { host, prompts } = buildHost();
    const header = await host.createSession({});
    await host.prompt(header.sessionId, "hello");
    expect(prompts[0]).toBe("hello");
  });
});

describe("SessionHost.resolveContext", () => {
  it("answers from the session's cwd", async () => {
    const { host } = buildHost({ resolver: stubResolver({}) });
    const header = await host.createSession({ cwd: "sub" });
    const resolution = await host.resolveContext(header.sessionId, "a.ts");
    expect(resolution.path).toBe(`${header.cwd}/a.ts`);
  });

  it("refuses rather than guessing when no resolver was wired", async () => {
    const { host } = buildHost();
    const header = await host.createSession({});
    await expect(host.resolveContext(header.sessionId, "a.ts")).rejects.toMatchObject({
      code: "invalidRequest",
    });
  });

  it("refuses an unknown session", async () => {
    const { host } = buildHost({ resolver: stubResolver({}) });
    await expect(host.resolveContext("nope", "a.ts")).rejects.toMatchObject({
      code: "sessionNotFound",
    });
  });
});

describe("PROMPT_ATTACHMENT_MAX_BYTES", () => {
  it("is the wire's own backpressure threshold, not a round number", async () => {
    const { DEFAULT_BACKPRESSURE_THRESHOLD_BYTES } = await import("./ws-server.js");
    expect(PROMPT_ATTACHMENT_MAX_BYTES).toBe(DEFAULT_BACKPRESSURE_THRESHOLD_BYTES);
  });

  it("leaves headroom for base64 expansion inside the frame cap", async () => {
    const { DEFAULT_MAX_PAYLOAD_BYTES } = await import("./ws-server.js");
    // 1 MiB of attachment bytes is ~1.37 MiB of base64; the frame cap is 4 MiB,
    // above which `ws` closes the connection with 1009 and the client learns
    // nothing about why.
    expect(Math.ceil(PROMPT_ATTACHMENT_MAX_BYTES * (4 / 3))).toBeLessThan(
      DEFAULT_MAX_PAYLOAD_BYTES,
    );
  });
});

describe("the window context resolution opens", () => {
  /** A resolver that does not answer until the test lets it. */
  function slowResolver(): { resolver: ContextResolver; release: () => void } {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      release: () => release(),
      resolver: {
        async buildPrompt(request) {
          await gate;
          return { text: request.text, images: [], refusals: [] };
        },
        async resolve(request) {
          return {
            query: request.query,
            path: request.query,
            relativePath: request.query,
            inWorkspace: true,
            exists: true,
            bytes: 1,
            kind: "file",
          };
        },
      },
    };
  }

  it("counts a session as busy from the moment the prompt is taken, not when the run starts", async () => {
    // Expanding mentions is filesystem I/O, so `prompt` now awaits before it
    // reaches `agent.prompt` — and `Agent.isRunning` is still false in that
    // window. A second prompt arriving there used to sail past the busy check
    // and fail deep inside `Agent` with a raw error mapped to `internal`.
    const { resolver, release } = slowResolver();
    const { host } = buildHost({ resolver });
    const header = await host.createSession({});

    const first = host.prompt(header.sessionId, "one");
    await expect(host.prompt(header.sessionId, "two")).rejects.toMatchObject({
      code: "sessionBusy",
    });
    release();
    await first;
  });

  it("refuses to delete a session whose prompt is still resolving", async () => {
    // The sharper edge of the same window: the run has not started, but it is
    // about to, and deleting the file out from under an agent that is seconds
    // from appending to it is exactly what `deleteSession` refuses to do.
    const { resolver, release } = slowResolver();
    const { host } = buildHost({ resolver });
    const header = await host.createSession({});

    const first = host.prompt(header.sessionId, "one");
    await expect(host.deleteSession(header.sessionId)).rejects.toMatchObject({
      code: "sessionBusy",
    });
    release();
    await first;
  });

  it("releases the claim when the resolver refuses, so the session is usable again", async () => {
    const { host } = buildHost({
      resolver: stubResolver(new ContextRefusedError("nope")),
    });
    const header = await host.createSession({});
    await expect(host.prompt(header.sessionId, "x")).rejects.toMatchObject({
      code: "invalidRequest",
    });
    // A refused prompt that left the session marked busy would wedge it for the
    // life of the process. The second attempt is refused for the same reason as
    // the first — this stub always refuses — and the point is that it is *not*
    // refused as `sessionBusy`.
    await expect(host.prompt(header.sessionId, "y")).rejects.toMatchObject({
      code: "invalidRequest",
    });
  });
});

describe("SessionHost.resolveContext: the payload leaving the host", () => {
  it("drops a field the wire contract does not define", async () => {
    // The resolver is injected, so this host cannot assume what it hands over.
    // Same discipline `listModels` applies to the catalog, and for the same
    // reason: a credential value is the case that matters.
    const resolver = stubResolver({});
    const leaky: ContextResolver = {
      buildPrompt: resolver.buildPrompt.bind(resolver),
      resolve: async (request) => ({
        ...(await resolver.resolve(request)),
        secret: "leaked",
      }),
    };
    const { host } = buildHost({ resolver: leaky });
    const header = await host.createSession({});
    const resolution = await host.resolveContext(header.sessionId, "a.ts");
    expect("secret" in resolution).toBe(false);
  });

  it("refuses a resolution that claims an out-of-workspace path exists", async () => {
    const resolver = stubResolver({});
    const lying: ContextResolver = {
      buildPrompt: resolver.buildPrompt.bind(resolver),
      resolve: async (request) => ({
        ...(await resolver.resolve(request)),
        inWorkspace: false,
        exists: true,
      }),
    };
    const { host } = buildHost({ resolver: lying });
    const header = await host.createSession({});
    await expect(host.resolveContext(header.sessionId, "a.ts")).rejects.toThrow(
      /not a valid wire payload/,
    );
  });
});
