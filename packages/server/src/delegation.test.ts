/**
 * `background-agents.ts` and `org-memory.ts` in isolation: the projections, the
 * cap, and the refusals a host makes when the injection is missing.
 *
 * The behaviour these verbs actually produce — a record on disk, a file a
 * background agent could not write, an entry that does not reach a role's
 * prompt — is asserted against real managers and a real server in
 * `@arcturn/cli`'s `delegation-wire.test.ts`. This file is about the payload
 * contract.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_AGENT_TEXT_MAX_CHARS,
  BACKGROUND_AGENTS_MAX_ROWS,
  BACKGROUND_TRANSCRIPT_MAX_BYTES,
  type BackgroundAgentRecord,
  type BackgroundAgentRegistry,
  capTranscript,
  projectBackgroundAgent,
  projectBackgroundAgents,
} from "./background-agents.js";
import { type OrgMemoryRecord, type OrgMemoryStoreAccess, projectOrgMemory } from "./org-memory.js";
import { SessionHost, SessionHostError } from "./session-host.js";

const RECORD: BackgroundAgentRecord = {
  id: "bg-a1b2c3d4",
  sessionId: "sess_child",
  task: "fix the flaky retry test",
  modelId: "anthropic/claude-sonnet-4-5",
  status: "running",
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_100,
  elapsedMs: 1200,
  costUsd: 0.42,
};

/** A host with no delegation injections at all. */
function bareHost(): SessionHost {
  return new SessionHost({
    agentFactory: () => {
      throw new Error("not used");
    },
    defaultCwd: "/repo",
  });
}

describe("projectBackgroundAgent", () => {
  it("names every field rather than copying the record", () => {
    // A field the manager grows tomorrow must be absent by default, not
    // present until somebody notices. `usage` is the one that exists today.
    const withExtras = {
      ...RECORD,
      usage: { inputTokens: 10, outputTokens: 5 },
      cwd: "/somebody/else",
    } as unknown as BackgroundAgentRecord;
    const row = projectBackgroundAgent(withExtras);
    expect(Object.keys(row).sort()).toEqual([
      "costUsd",
      "createdAt",
      "elapsedMs",
      "id",
      "modelId",
      "sessionId",
      "startedAt",
      "status",
      "task",
    ]);
  });

  it("clamps a negative elapsed or cost rather than passing it on", () => {
    const row = projectBackgroundAgent({ ...RECORD, elapsedMs: -5, costUsd: -1 });
    expect(row.elapsedMs).toBe(0);
    expect(row.costUsd).toBe(0);
  });

  it("omits endedAt and error while an agent is still going", () => {
    const row = projectBackgroundAgent(RECORD);
    expect("endedAt" in row).toBe(false);
    expect("error" in row).toBe(false);
  });

  it("previews the model-authored strings rather than carrying them whole", () => {
    // `finalText` is unbounded at the source. A listing that carried a hundred
    // of them in full is the frame that wedges the socket.
    const row = projectBackgroundAgent({
      ...RECORD,
      task: "t".repeat(5_000),
      finalText: "f".repeat(5_000),
      error: "e".repeat(5_000),
    });
    expect(row.task).toHaveLength(BACKGROUND_AGENT_TEXT_MAX_CHARS);
    expect(row.finalText).toHaveLength(BACKGROUND_AGENT_TEXT_MAX_CHARS);
    expect(row.error).toHaveLength(BACKGROUND_AGENT_TEXT_MAX_CHARS);
    expect(row.finalText?.endsWith("…")).toBe(true);
  });

  it("keeps a short string exactly as it was", () => {
    expect(projectBackgroundAgent(RECORD).task).toBe(RECORD.task);
  });

  it("carries a transcript only when one was fetched", () => {
    expect(projectBackgroundAgents([RECORD]).agents[0]?.transcript).toBeUndefined();
    const withTranscript = projectBackgroundAgents(
      [RECORD],
      new Map([[RECORD.id, { lines: ["> go"], truncated: false, droppedLines: 0 }]]),
    );
    expect(withTranscript.agents[0]?.transcript?.lines).toEqual(["> go"]);
  });
});

describe("projectBackgroundAgents", () => {
  it("keeps the newest rows and REPORTS the drop", () => {
    // Newest-first in, so the tail is the oldest. Dropping it keeps the answer
    // to "what is running" complete, which is the question the verb is for.
    const records = Array.from({ length: 5 }, (_, i) => ({ ...RECORD, id: `bg-${String(i)}` }));
    const listing = projectBackgroundAgents(records, new Map(), 2);
    expect(listing.agents.map((a) => a.id)).toEqual(["bg-0", "bg-1"]);
    expect(listing.truncated).toBe(true);
    expect(listing.droppedAgents).toBe(3);
  });

  it("says truncated: false when everything fits", () => {
    const listing = projectBackgroundAgents([RECORD]);
    expect(listing).toMatchObject({ truncated: false, droppedAgents: 0 });
  });

  it("defaults to a row budget that keeps a year of daily agents inside 1 MiB", () => {
    expect(BACKGROUND_AGENTS_MAX_ROWS).toBe(200);
  });
});

describe("capTranscript", () => {
  it("keeps everything under the budget and says so", () => {
    const result = capTranscript(["a", "b", "c"]);
    expect(result).toEqual({ lines: ["a", "b", "c"], truncated: false, droppedLines: 0 });
  });

  it("drops from the FRONT, because the end of an unattended run is the point", () => {
    // Ten lines of five bytes each (four characters plus the newline the
    // budget counts), with room for two.
    const lines = ["aaaa", "bbbb", "cccc", "dddd", "eeee"];
    const result = capTranscript(lines, 10);
    expect(result.lines).toEqual(["dddd", "eeee"]);
    expect(result.truncated).toBe(true);
    expect(result.droppedLines).toBe(3);
  });

  it("counts bytes rather than characters", () => {
    // Four astral characters is sixteen bytes, so a fifteen-byte budget keeps
    // nothing. A character count would have kept it and blown the budget.
    const result = capTranscript(["🙂🙂🙂🙂"], 15);
    expect(result.lines).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("defaults to the same 1 MiB every other bounded payload uses", () => {
    expect(BACKGROUND_TRANSCRIPT_MAX_BYTES).toBe(1024 * 1024);
    const big = Array.from({ length: 40_000 }, () => "x".repeat(64));
    const result = capTranscript(big);
    expect(result.truncated).toBe(true);
    const bytes = result.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(BACKGROUND_TRANSCRIPT_MAX_BYTES);
  });
});

describe("a host with no background-agent manager", () => {
  it("refuses all four verbs rather than answering an empty list", async () => {
    // An empty list would say "this engine has no background agents", which is
    // a different and false claim.
    const host = bareHost();
    await expect(host.backgroundAgents()).rejects.toBeInstanceOf(SessionHostError);
    expect(() => host.startBackgroundAgent("go")).toThrow(/without a background-agent manager/);
    expect(() => host.cancelBackgroundAgent("bg-1")).toThrow(SessionHostError);
    await expect(host.adoptBackgroundAgent("s1", "bg-1")).rejects.toThrow(SessionHostError);
  });
});

describe("startBackgroundAgent", () => {
  /** A registry that records what it was asked to start. */
  function recordingRegistry(): BackgroundAgentRegistry & { started: string[] } {
    const started: string[] = [];
    return {
      started,
      list: () => [],
      get: () => undefined,
      start: (task: string) => {
        started.push(task);
        return { id: "bg-1", sessionId: "sess_1" };
      },
      cancel: () => false,
      transcript: () => Promise.resolve(undefined),
      adoption: () => undefined,
    };
  }

  it("passes the task through and nothing else — there is nothing else to pass", () => {
    const registry = recordingRegistry();
    const host = new SessionHost({
      agentFactory: () => {
        throw new Error("not used");
      },
      defaultCwd: "/repo",
      backgroundAgents: registry,
    });
    expect(host.startBackgroundAgent("do a thing")).toEqual({ id: "bg-1", sessionId: "sess_1" });
    expect(registry.started).toEqual(["do a thing"]);
  });

  it("turns the registry's own refusal into invalidRequest", () => {
    const registry = recordingRegistry();
    const host = new SessionHost({
      agentFactory: () => {
        throw new Error("not used");
      },
      defaultCwd: "/repo",
      backgroundAgents: {
        ...registry,
        start: () => {
          throw new Error("task must be a non-empty string");
        },
      },
    });
    expect(() => host.startBackgroundAgent(" ")).toThrow(/non-empty/);
  });
});

describe("projectOrgMemory", () => {
  const entry = (over: Partial<OrgMemoryRecord> = {}): OrgMemoryRecord => ({
    id: "m1",
    role: "developer",
    text: "a lesson",
    status: "proposed",
    createdAt: 1,
    ...over,
  });

  it("sorts by role then id so two reads of an unchanged store compare equal", () => {
    const listing = projectOrgMemory({
      entries: [
        entry({ id: "m2", role: "reviewer" }),
        entry({ id: "m3", role: "developer" }),
        entry({ id: "m1", role: "developer" }),
      ],
      warnings: [],
    });
    expect(listing.entries.map((e) => `${e.role}/${e.id}`)).toEqual([
      "developer/m1",
      "developer/m3",
      "reviewer/m2",
    ]);
  });

  it("carries the warnings, because an empty store and a refused one differ", () => {
    const listing = projectOrgMemory({ entries: [], warnings: ["file is too large"] });
    expect(listing).toEqual({ entries: [], warnings: ["file is too large"] });
  });

  it("omits an absent origin rather than inventing one", () => {
    expect("origin" in projectOrgMemory({ entries: [entry()], warnings: [] }).entries[0]!).toBe(
      false,
    );
  });
});

describe("a host with no org-memory store", () => {
  it("refuses all three verbs rather than reporting an empty store", async () => {
    const host = bareHost();
    await expect(host.orgMemory()).rejects.toThrow(/without an org-memory store/);
    await expect(host.proposeOrgMemory("developer", "x")).rejects.toThrow(SessionHostError);
    await expect(host.revokeOrgMemory("m1")).rejects.toThrow(SessionHostError);
  });
});

describe("proposeOrgMemory", () => {
  /** A store that files whatever it is told, so the host's own gate is testable. */
  function storeThatFiles(status: "proposed" | "active"): OrgMemoryStoreAccess {
    const record: OrgMemoryRecord = {
      id: "m1",
      role: "developer",
      text: "a lesson",
      status,
      createdAt: 1,
    };
    return {
      read: () => Promise.resolve({ entries: [record], warnings: [] }),
      propose: () => Promise.resolve({ value: record }),
      revoke: () => Promise.resolve({ value: { entries: [record], warnings: [] } }),
    };
  }

  function hostWith(store: OrgMemoryStoreAccess): SessionHost {
    return new SessionHost({
      agentFactory: () => {
        throw new Error("not used");
      },
      defaultCwd: "/repo",
      orgMemory: store,
    });
  }

  it("answers with the inert entry and the store", async () => {
    const result = await hostWith(storeThatFiles("proposed")).proposeOrgMemory("developer", "x");
    expect(result.entry.status).toBe("proposed");
    expect(result.store.entries).toHaveLength(1);
  });

  it("REFUSES to answer when the store somehow filed an active entry", async () => {
    // The gate's last engine-side check. An entry that reached a client marked
    // "proposed" while sitting active in the file is the exact failure the
    // whole feature turns on, so this throws rather than reporting.
    await expect(
      hostWith(storeThatFiles("active")).proposeOrgMemory("developer", "x"),
    ).rejects.toThrow(/must be approved by a person/);
  });

  it("passes the store's own refusal through verbatim", async () => {
    // "at most 160 characters; clipping can invert a lesson" is the sentence a
    // person needs, not "invalid request".
    const store: OrgMemoryStoreAccess = {
      read: () => Promise.resolve({ entries: [], warnings: [] }),
      propose: () => Promise.resolve({ error: "An org memory entry is one line of at most 160" }),
      revoke: () => Promise.resolve({ error: "no" }),
    };
    await expect(hostWith(store).proposeOrgMemory("developer", "x")).rejects.toThrow(/160/);
  });
});
