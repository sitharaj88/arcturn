/**
 * `/rewind` on the real serve path, asserted on the filesystem.
 *
 * A real {@link ArcturnRuntime} (so the checkpoint store, the workspace
 * confinement and the conversation fork are the ones the TUI uses), a real
 * {@link createServeHost}, a real {@link ArcturnServer} on a real port, a real
 * {@link createProtocolClient}, and a real agent that actually writes files.
 *
 * **Every claim here is checked against the disk, not against a returned
 * status.** That distinction is the whole point of this file: the mention bug
 * RFC 0005 §0 exists to fix shipped for months behind a `{ ok: true }`, and a
 * `rewindTo` that answered "restored 2 files" while touching none would be the
 * same failure with worse consequences — a user carrying on against code they
 * believe they discarded. So a file created after a checkpoint has to be *gone*
 * afterwards, and a file that existed at that checkpoint has to be back with
 * its *old bytes*.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProtocolClient, type ProtocolRequestError } from "@arcturn/protocol";
import { ArcturnServer } from "@arcturn/server";
import type { AgentEvent } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ArcturnRuntime } from "./runtime.js";
import { createServeHost } from "./serve.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";

const servers: ArcturnServer[] = [];
const closers: (() => void)[] = [];
const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0)) await server.stop();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

interface Harness {
  runtime: ArcturnRuntime;
  client: ReturnType<typeof createProtocolClient>;
  sessionId: string;
  events: AgentEvent[];
  scratch: Scratch;
}

async function serve(
  scratch: Scratch,
  turns: Parameters<typeof buildTestRuntime>[1],
  overrides: Parameters<typeof buildTestRuntime>[2] = {},
): Promise<Harness> {
  const runtime = await buildTestRuntime(scratch, turns, {
    // `write` asks under the default mode, and this file is about what happens
    // to files, not about the permission round trip (`permissions-wire.test.ts`
    // owns that).
    permissionMode: "yolo",
    ...overrides,
  });
  runtimes.push(runtime);
  const server = new ArcturnServer({ sessionHost: createServeHost(runtime) });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
  closers.push(() => client.close());
  const events: AgentEvent[] = [];
  client.onEvent((_id, event) => events.push(event));
  const header = await client.createSession({ cwd: runtime.cwd });
  await client.openSession(header.sessionId);
  return { runtime, client, sessionId: header.sessionId, events, scratch };
}

/** Whether a path exists at all — the assertion a delete has to satisfy. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Two prompts, two files: one that already existed and gets changed, one the
 * agent creates. That pair is the whole shape of a rewind — content coming
 * back, and a file going away — and it is what every test below builds on.
 */
function twoTurnScript(cwd: string): Parameters<typeof buildTestRuntime>[1] {
  return [
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: join(cwd, "existing.ts"), content: "changed\n" },
        },
      ],
    },
    { text: "changed it" },
    {
      toolCalls: [
        {
          id: "w2",
          name: "write",
          arguments: { path: join(cwd, "created.ts"), content: "brand new\n" },
        },
      ],
    },
    { text: "created it" },
  ];
}

describe("listCheckpoints — a picker that says what a choice costs", () => {
  it("reports each turn's plan: how many files, how many deletions, and which", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch.cwd, "existing.ts"), "original\n", "utf8");
    const harness = await serve(scratch, twoTurnScript(scratch.cwd));

    await harness.client.prompt(harness.sessionId, "change the existing file");
    await harness.client.prompt(harness.sessionId, "create a new file");

    const list = await harness.client.listCheckpoints(harness.sessionId);
    expect(list?.available).toBe(true);
    expect(list?.checkpoints).toHaveLength(2);

    // Newest first, so [0] is the second prompt and [1] is the first.
    const second = list?.checkpoints[0];
    const first = list?.checkpoints[1];
    expect(second?.label).toBe("create a new file");
    expect(first?.label).toBe("change the existing file");

    // Rewinding to the second prompt only undoes the file it created.
    expect(second?.files).toEqual(["created.ts"]);
    expect(second?.fileCount).toBe(1);
    expect(second?.deleteCount).toBe(1);

    // Rewinding to the FIRST prompt spans both turns: `created.ts` goes away
    // and `existing.ts` comes back. This is the number a picker cannot compute
    // for itself, and the reason the verb reports a plan rather than a count of
    // what happened during one turn.
    expect(first?.files).toEqual(["created.ts", "existing.ts"]);
    expect(first?.fileCount).toBe(2);
    expect(first?.deleteCount).toBe(1);

    // Both turns began in this process, so both can fork the conversation.
    expect(first?.forksConversation).toBe(true);
    expect(second?.forksConversation).toBe(true);

    // Read-only: nothing moved.
    expect(await readFile(join(scratch.cwd, "existing.ts"), "utf8")).toBe("changed\n");
    expect(await exists(join(scratch.cwd, "created.ts"))).toBe(true);
  });
});

describe("rewindTo — the files actually move", () => {
  it("deletes a file created after the checkpoint and restores one that existed at it", async () => {
    const scratch = await makeScratch();
    const existing = join(scratch.cwd, "existing.ts");
    const created = join(scratch.cwd, "created.ts");
    await writeFile(existing, "original\n", "utf8");
    const harness = await serve(scratch, twoTurnScript(scratch.cwd));

    await harness.client.prompt(harness.sessionId, "change the existing file");
    await harness.client.prompt(harness.sessionId, "create a new file");

    // The workspace as the agent left it.
    expect(await readFile(existing, "utf8")).toBe("changed\n");
    expect(await readFile(created, "utf8")).toBe("brand new\n");

    const list = await harness.client.listCheckpoints(harness.sessionId);
    const target = list?.checkpoints[1];
    if (target === undefined) throw new Error("expected two checkpoints");

    const result = await harness.client.rewindTo(harness.sessionId, target.id, target.confirmation);

    // ---- The assertions that matter: the filesystem. --------------------
    expect(await exists(created)).toBe(false);
    expect(await readFile(existing, "utf8")).toBe("original\n");

    // ---- And the report describes what just happened to it. -------------
    expect(result.restored).toEqual(["existing.ts"]);
    expect(result.deleted).toEqual(["created.ts"]);
    expect(result.failed).toEqual([]);
    expect(result.conversationForked).toBe(true);
    expect(result.checkpointId).toBe(target.id);
  });

  it("forks the transcript, and sessionHistory replays the branch the agent is now on", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch.cwd, "existing.ts"), "original\n", "utf8");
    const harness = await serve(scratch, twoTurnScript(scratch.cwd));

    await harness.client.prompt(harness.sessionId, "change the existing file");
    await harness.client.prompt(harness.sessionId, "create a new file");

    const before = await harness.client.sessionHistory(harness.sessionId);
    expect(JSON.stringify(before?.events)).toContain("create a new file");

    // The SECOND turn — so the first one is kept, and the replay has something
    // it must still contain. Rewinding to the first turn instead leaves an
    // empty branch, and an empty transcript satisfies "the abandoned turn is
    // gone" whether or not anything was replayed at all: this test asserted
    // only absences for exactly that reason and passed while the fork replayed
    // nothing. Absence without presence is not a transcript assertion.
    const list = await harness.client.listCheckpoints(harness.sessionId);
    const target = list?.checkpoints[0];
    if (target === undefined) throw new Error("expected two checkpoints");
    await harness.client.rewindTo(harness.sessionId, target.id, target.confirmation);

    // The replay is the one transcript path — there is no second one — and it
    // must now describe the forked branch. The second prompt is gone from it;
    // the entries themselves are still in the session file on their own branch,
    // which is what makes a rewind non-destructive.
    const after = await harness.client.sessionHistory(harness.sessionId);
    const replayed = JSON.stringify(after?.events);
    expect(replayed).toContain("change the existing file");
    expect(replayed).toContain("changed it");
    expect(replayed).not.toContain("create a new file");
    expect(replayed).not.toContain("created it");

    // Every attached connection is told, not just the one that asked.
    const notice = harness.events.find(
      (event) => event.type === "notice" && /rewound to an earlier turn/i.test(event.text),
    );
    expect(notice).toBeDefined();
  });

  it("replays an empty transcript when the fork goes back past the first message", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch.cwd, "existing.ts"), "original\n", "utf8");
    const harness = await serve(scratch, twoTurnScript(scratch.cwd));

    await harness.client.prompt(harness.sessionId, "change the existing file");
    await harness.client.prompt(harness.sessionId, "create a new file");

    // Rewinding to the FIRST turn forks to before the root, and the agent that
    // comes back genuinely remembers nothing — `leafEntryId` is `null` and it
    // means an empty branch, not "I do not have a leaf". That distinction is
    // load-bearing: reading `null` as "fall back to the newest entry in the
    // file" would replay the whole abandoned conversation here, and it is the
    // tempting way to make a session re-attached in a fresh process replay.
    // The right fix for that one is to resume the agent (see `serve.test.ts`),
    // which gives it a real leaf and leaves this case alone.
    const list = await harness.client.listCheckpoints(harness.sessionId);
    const target = list?.checkpoints[1];
    if (target === undefined) throw new Error("expected two checkpoints");
    await harness.client.rewindTo(harness.sessionId, target.id, target.confirmation);

    const after = await harness.client.sessionHistory(harness.sessionId);
    expect(after?.events).toEqual([]);

    // Empty because the branch is empty, not because the replay gave up: the
    // very next turn appears in it, alone.
    await harness.client.prompt(harness.sessionId, "starting over");
    const restarted = await harness.client.sessionHistory(harness.sessionId);
    const replayed = JSON.stringify(restarted?.events);
    expect(replayed).toContain("starting over");
    expect(replayed).not.toContain("change the existing file");
    expect(replayed).not.toContain("create a new file");
  });

  it("keeps running turns after the fork, so the next rewind is still possible", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch.cwd, "existing.ts"), "original\n", "utf8");
    const harness = await serve(scratch, twoTurnScript(scratch.cwd));

    await harness.client.prompt(harness.sessionId, "change the existing file");
    await harness.client.prompt(harness.sessionId, "create a new file");
    const list = await harness.client.listCheckpoints(harness.sessionId);
    const target = list?.checkpoints[1];
    if (target === undefined) throw new Error("expected two checkpoints");
    await harness.client.rewindTo(harness.sessionId, target.id, target.confirmation);

    // A rewind that quietly stopped recording would disable rewinding, which
    // the user would only discover the next time they needed it.
    await harness.client.prompt(harness.sessionId, "after the fork");
    const again = await harness.client.listCheckpoints(harness.sessionId);
    expect(again?.checkpoints[0]?.label).toBe("after the fork");
  });
});

describe("rewindTo — the refusals", () => {
  it("refuses mid-run with sessionBusy, and touches nothing", async () => {
    const scratch = await makeScratch();
    const existing = join(scratch.cwd, "existing.ts");
    const created = join(scratch.cwd, "created.ts");
    await writeFile(existing, "original\n", "utf8");
    const harness = await serve(scratch, [
      ...twoTurnScript(scratch.cwd),
      // A slow final turn, so the third prompt is still in flight below.
      { text: "slow", delayMs: 400 },
    ]);

    await harness.client.prompt(harness.sessionId, "change the existing file");
    await harness.client.prompt(harness.sessionId, "create a new file");
    const list = await harness.client.listCheckpoints(harness.sessionId);
    const target = list?.checkpoints[1];
    if (target === undefined) throw new Error("expected two checkpoints");

    const run = harness.client.prompt(harness.sessionId, "take your time");
    await new Promise((resolve) => setTimeout(resolve, 60));

    const error = await harness.client
      .rewindTo(harness.sessionId, target.id, target.confirmation)
      .catch((e: unknown) => e);
    expect((error as ProtocolRequestError).code).toBe("sessionBusy");
    expect((error as Error).message).toMatch(/running a turn/i);

    // The refusal is a refusal on disk too, not merely in the response.
    expect(await readFile(existing, "utf8")).toBe("changed\n");
    expect(await exists(created)).toBe(true);

    await run;
  });

  it("refuses a stale confirmation — a client cannot rewind to a cost it never showed", async () => {
    const scratch = await makeScratch();
    const existing = join(scratch.cwd, "existing.ts");
    await writeFile(existing, "original\n", "utf8");
    const harness = await serve(scratch, twoTurnScript(scratch.cwd));

    await harness.client.prompt(harness.sessionId, "change the existing file");
    const stale = await harness.client.listCheckpoints(harness.sessionId);
    const row = stale?.checkpoints[0];
    if (row === undefined) throw new Error("expected a checkpoint");
    expect(row.fileCount).toBe(1);

    // A turn runs after the picker was rendered, and it changes what rewinding
    // to that row would cost — which is exactly the drift the token exists to
    // catch, and exactly the case `deleteSession`'s parameters could never have.
    await harness.client.prompt(harness.sessionId, "create a new file");

    const error = await harness.client
      .rewindTo(harness.sessionId, row.id, row.confirmation)
      .catch((e: unknown) => e);
    expect((error as ProtocolRequestError).code).toBe("invalidRequest");
    expect((error as Error).message).toMatch(/no longer costs what it did/i);

    // Nothing was restored on the strength of a stale row.
    expect(await readFile(existing, "utf8")).toBe("changed\n");
    expect(await exists(join(scratch.cwd, "created.ts"))).toBe(true);

    // Re-listing gives a row that works, which is what the message tells a
    // client to do.
    const fresh = await harness.client.listCheckpoints(harness.sessionId);
    const current = fresh?.checkpoints.find((entry) => entry.id === row.id);
    if (current === undefined) throw new Error("expected the row to still be listed");
    expect(current.fileCount).toBe(2);
    const result = await harness.client.rewindTo(
      harness.sessionId,
      current.id,
      current.confirmation,
    );
    expect(result.restored).toEqual(["existing.ts"]);
    expect(await readFile(existing, "utf8")).toBe("original\n");
  });

  it("refuses an unknown checkpoint id", async () => {
    const scratch = await makeScratch();
    const harness = await serve(scratch, [{ text: "hi" }]);
    await harness.client.prompt(harness.sessionId, "hello");
    const error = await harness.client
      .rewindTo(harness.sessionId, "not-a-turn", "not-a-confirmation")
      .catch((e: unknown) => e);
    expect((error as ProtocolRequestError).code).toBe("invalidRequest");
    expect((error as Error).message).toMatch(/No checkpoint/);
  });
});

describe("a turn that predates this process", () => {
  it("restores the files and says the transcript was left in place", async () => {
    // A session resumed from disk has snapshots but no in-memory record of the
    // entry each turn began at. The terminal restores the files and says so
    // rather than guessing a fork point; the wire reports the same fact, and
    // reports it in `listCheckpoints` so a client can warn BEFORE the click.
    const scratch = await makeScratch();
    const orphan = join(scratch.cwd, "orphan.ts");
    await writeFile(orphan, "kept\n", "utf8");
    const harness = await serve(scratch, [{ text: "hi" }]);
    await harness.client.prompt(harness.sessionId, "hello");

    // A turn record with no conversation link, which is exactly the shape a
    // resumed session's manifest has.
    const manifest = join(scratch.home, "checkpoints", harness.sessionId, "manifest.jsonl");
    const existing = await readFile(manifest, "utf8").catch(() => "");
    await writeFile(
      manifest,
      `${existing}${JSON.stringify({ kind: "turn", id: "older-turn", label: "from a previous run", timestamp: Date.now() })}\n${JSON.stringify({ kind: "file", turnId: "older-turn", path: orphan, blob: null, timestamp: Date.now() })}\n`,
      "utf8",
    );

    const list = await harness.client.listCheckpoints(harness.sessionId);
    const row = list?.checkpoints.find((entry) => entry.id === "older-turn");
    if (row === undefined) throw new Error("expected the orphan turn to be listed");
    expect(row.forksConversation).toBe(false);

    const result = await harness.client.rewindTo(harness.sessionId, row.id, row.confirmation);
    // The files still move; only the transcript does not.
    expect(await exists(orphan)).toBe(false);
    expect(result.deleted).toEqual(["orphan.ts"]);
    expect(result.conversationForked).toBe(false);
  });
});

describe("rewindTo — workspace confinement", () => {
  it("refuses a manifest record outside the session's workspace and leaves the file alone", async () => {
    const scratch = await makeScratch();
    // Outside the served workspace, inside the scratch tree so it is cleaned up.
    const outside = join(scratch.root, "outside.ts");
    await writeFile(outside, "untouched\n", "utf8");
    const inside = join(scratch.cwd, "inside.ts");

    const harness = await serve(scratch, [
      {
        toolCalls: [{ id: "w1", name: "write", arguments: { path: inside, content: "written\n" } }],
      },
      { text: "done" },
    ]);
    await harness.client.prompt(harness.sessionId, "write a file");

    // Forge the escape the confinement exists for: a manifest whose record
    // names a path outside the restore root. That is the shape a tampered
    // manifest takes, and — because snapshots are deliberately *not* confined
    // (capturing a pre-image is harmless) — the shape a legitimately recorded
    // out-of-tree file takes too. Either way the restore must refuse.
    const manifest = join(scratch.home, "checkpoints", harness.sessionId, "manifest.jsonl");
    const lines = (await readFile(manifest, "utf8")).trimEnd().split("\n");
    const turn = JSON.parse(lines[0] ?? "{}") as { id: string };
    lines.push(
      JSON.stringify({
        kind: "file",
        turnId: turn.id,
        path: outside,
        blob: null,
        timestamp: Date.now(),
      }),
    );
    await writeFile(manifest, `${lines.join("\n")}\n`, "utf8");

    // The picker never offers it: `files` is what would happen, and this would
    // not happen.
    const list = await harness.client.listCheckpoints(harness.sessionId);
    const row = list?.checkpoints[0];
    if (row === undefined) throw new Error("expected a checkpoint");
    expect(row.files).toEqual(["inside.ts"]);
    expect(row.fileCount).toBe(1);

    const result = await harness.client.rewindTo(harness.sessionId, row.id, row.confirmation);

    // The in-workspace file moved; the out-of-workspace one did not, and the
    // refusal is named rather than swallowed.
    expect(await exists(inside)).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("untouched\n");
    expect(result.deleted).toEqual(["inside.ts"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe(outside);
    expect(result.failed[0]?.message).toMatch(/outside the workspace/i);
  });
});
