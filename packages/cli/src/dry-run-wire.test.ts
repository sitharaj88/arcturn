/**
 * The dry-run review loop, end to end on the real serve path.
 *
 * A real {@link ArcturnRuntime} built with `dryRun: true` (so the tool set is
 * genuinely overlay-wrapped and the shadow tree is a real directory under the
 * scratch home), a real {@link createServeHost}, a real {@link ArcturnServer}
 * on a real port, and a real {@link createProtocolClient}.
 *
 * ## What these assertions are on
 *
 * **The filesystem.** Not a returned status — a status is what a correct-
 * looking response says while nothing happened, which is the exact bug shape
 * this repo has already shipped once. So every claim here is `readFile` or
 * `stat` on the user's real file: unchanged after the agent wrote, changed
 * only after `applyChanges`, and *never* changed after `discardChanges`.
 */

import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProtocolClient } from "@arcturn/protocol";
import { ArcturnServer } from "@arcturn/server";
import type { AgentEvent } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ArcturnRuntime } from "./runtime.js";
import { createServeHost } from "./serve.js";
import {
  buildTestRuntime,
  makeScratch,
  type Scratch,
  writeFileAt,
} from "./test-helpers/scratch.js";

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
    // Edits auto-approve so the run reaches the overlay rather than parking on
    // a permission ask. The deny-rule test below turns this back off, because
    // that one is about a rule beating the mode.
    permissionMode: "acceptEdits",
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

/** One scripted turn that writes `content` to `path`, then a turn that stops. */
function writeTurns(
  files: readonly { path: string; content: string }[],
): Parameters<typeof buildTestRuntime>[1] {
  return [
    {
      toolCalls: files.map((file, index) => ({
        id: `c${String(index)}`,
        name: "write",
        arguments: { path: file.path, content: file.content },
      })),
    },
    { text: "done" },
  ];
}

/** Whether there is a file at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("the dry-run review loop over the wire", () => {
  it("holds an edit back, lists it, and lands it on disk only on applyChanges", async () => {
    const scratch = await makeScratch();
    const target = join(scratch.cwd, "src", "app.ts");
    await writeFileAt(target, 'export const boot = "old";\n');

    const harness = await serve(
      scratch,
      writeTurns([{ path: "src/app.ts", content: 'export const boot = "new";\n' }]),
      { dryRun: true },
    );
    await harness.client.prompt(harness.sessionId, "rewrite boot");

    // The whole promise of --dry-run: the run finished and the file did not.
    expect(await readFile(target, "utf8")).toBe('export const boot = "old";\n');

    const pending = await harness.client.pendingChanges(harness.sessionId);
    expect(pending?.dryRun).toBe(true);
    expect(pending?.changes.map((change) => change.path)).toEqual(["src/app.ts"]);
    expect(pending?.changes[0]?.kind).toBe("modified");
    // The list carries no content — that is the payload bound, asserted rather
    // than described.
    expect(pending?.changes[0]?.after).toBeUndefined();

    const one = await harness.client.pendingChanges(harness.sessionId, "src/app.ts");
    expect(one?.changes[0]?.after).toBe('export const boot = "new";\n');

    const applied = await harness.client.applyChanges(harness.sessionId);
    expect(applied.applied).toEqual(["src/app.ts"]);
    expect(applied.failed).toEqual([]);
    expect(applied.remaining).toBe(0);

    // The assertion this whole file exists for.
    expect(await readFile(target, "utf8")).toBe('export const boot = "new";\n');
  });

  it("leaves the file untouched after discardChanges, and stops listing it", async () => {
    const scratch = await makeScratch();
    const target = join(scratch.cwd, "src", "app.ts");
    await writeFileAt(target, 'export const boot = "old";\n');

    const harness = await serve(
      scratch,
      writeTurns([{ path: "src/app.ts", content: 'export const boot = "new";\n' }]),
      { dryRun: true },
    );
    await harness.client.prompt(harness.sessionId, "rewrite boot");
    expect((await harness.client.pendingChanges(harness.sessionId))?.changes).toHaveLength(1);

    const discarded = await harness.client.discardChanges(harness.sessionId);
    expect(discarded.discarded).toEqual(["src/app.ts"]);
    expect(discarded.remaining).toBe(0);

    // Unchanged, and still unchanged — a discard that quietly applied would
    // pass a status assertion and fail this one.
    expect(await readFile(target, "utf8")).toBe('export const boot = "old";\n');
    expect((await harness.client.pendingChanges(harness.sessionId))?.changes).toEqual([]);
  });

  it("applies only the selected file and leaves the rest pending", async () => {
    const scratch = await makeScratch();
    const kept = join(scratch.cwd, "keep.ts");
    const landed = join(scratch.cwd, "land.ts");
    await writeFileAt(kept, "old keep\n");
    await writeFileAt(landed, "old land\n");

    const harness = await serve(
      scratch,
      writeTurns([
        { path: "keep.ts", content: "new keep\n" },
        { path: "land.ts", content: "new land\n" },
      ]),
      { dryRun: true },
    );
    await harness.client.prompt(harness.sessionId, "rewrite both");

    const applied = await harness.client.applyChanges(harness.sessionId, ["land.ts"]);
    expect(applied.applied).toEqual(["land.ts"]);
    expect(applied.remaining).toBe(1);

    expect(await readFile(landed, "utf8")).toBe("new land\n");
    // The unselected file is the point: a selection that quietly applied
    // everything would pass every status assertion above.
    expect(await readFile(kept, "utf8")).toBe("old keep\n");
    expect((await harness.client.pendingChanges(harness.sessionId))?.changes).toHaveLength(1);
  });
});

describe("the review loop cannot reach outside the workspace", () => {
  it("refuses a selection naming a path the engine never listed", async () => {
    const scratch = await makeScratch();
    const outside = join(scratch.root, "outside.txt");
    await writeFile(outside, "untouched\n", "utf8");

    const harness = await serve(
      scratch,
      writeTurns([{ path: "inside.ts", content: "written\n" }]),
      { dryRun: true },
    );
    await harness.client.prompt(harness.sessionId, "write inside");

    for (const forged of ["../outside.txt", outside, "..\\outside.txt"]) {
      await expect(harness.client.applyChanges(harness.sessionId, [forged])).rejects.toThrow(
        /No pending change named/,
      );
    }
    // Nothing was applied — not even the legitimate pending change, because a
    // selection with a bad name refuses the whole request.
    expect(await readFile(outside, "utf8")).toBe("untouched\n");
    expect(await exists(join(scratch.cwd, "inside.ts"))).toBe(false);
    expect((await harness.client.pendingChanges(harness.sessionId))?.changes).toHaveLength(1);
  });

  it("refuses to apply a change whose real destination leaves the workspace by symlink", async () => {
    const scratch = await makeScratch();
    const secrets = join(scratch.root, "secrets");
    await mkdir(secrets, { recursive: true });
    // `bash` is not wrapped by the overlay, so a link like this really can
    // appear inside a workspace mid-run. The shadow copy lands at
    // <shadow>/escape/loot.txt; the REAL destination is outside the workspace.
    await symlink(secrets, join(scratch.cwd, "escape"));

    const harness = await serve(
      scratch,
      writeTurns([{ path: "escape/loot.txt", content: "exfiltrated\n" }]),
      { dryRun: true },
    );
    await harness.client.prompt(harness.sessionId, "write through the link");

    const pending = await harness.client.pendingChanges(harness.sessionId);
    expect(pending?.changes.map((change) => change.path)).toEqual(["escape/loot.txt"]);

    const applied = await harness.client.applyChanges(harness.sessionId);
    expect(applied.applied).toEqual([]);
    expect(applied.failed[0]?.path).toBe("escape/loot.txt");
    expect(applied.failed[0]?.message).toMatch(/resolves outside the workspace/);

    // The only assertion that matters: the file is not there.
    expect(await exists(join(secrets, "loot.txt"))).toBe(false);
  });

  it("cannot launder a write a deny rule refused: it never becomes a pending change", async () => {
    const scratch = await makeScratch();
    // A **directory-anchored** rule, which is the shape confinement actually
    // takes — `/workflow`'s worktree lanes deny writes outside their own
    // directory exactly this way — and the shape a shadow tree could plausibly
    // slip past, since the shadow copy of `<cwd>/secrets/key.pem` lives under
    // `<home>/overlays/<session>/` and is not inside the rule's directory at
    // all. It does not slip past, and this test is what says so: the loop
    // checks permissions against the tool call's **raw** path before the
    // overlay redirects anything, so the rule is matched against the real
    // file. What follows is that a denied write never becomes a pending
    // change, and therefore can never be applied.
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({
        permissions: [
          {
            tool: "write",
            specifier: `${join(scratch.cwd, "secrets")}/**`,
            action: "deny",
            scope: "project",
          },
        ],
      }),
    );
    const secret = join(scratch.cwd, "secrets", "key.pem");
    await writeFileAt(secret, "REAL KEY\n");

    const harness = await serve(
      scratch,
      writeTurns([{ path: "secrets/key.pem", content: "STOLEN\n" }]),
      // yolo, deliberately: a mode does not outrank a rule (rules are step 3,
      // modes are step 5), and this proves the review loop inherits that
      // rather than becoming a way around it.
      { dryRun: true, permissionMode: "yolo" },
    );
    await harness.client.prompt(harness.sessionId, "rewrite the key");

    const pending = await harness.client.pendingChanges(harness.sessionId);
    expect(pending?.changes).toEqual([]);

    const applied = await harness.client.applyChanges(harness.sessionId);
    expect(applied.applied).toEqual([]);
    expect(await readFile(secret, "utf8")).toBe("REAL KEY\n");
  });
});

describe("the review loop refuses mid-run", () => {
  it("answers sessionBusy and leaves the workspace alone while a turn is in flight", async () => {
    const scratch = await makeScratch();
    const target = join(scratch.cwd, "app.ts");
    await writeFileAt(target, "old\n");

    const harness = await serve(
      scratch,
      [
        {
          toolCalls: [{ id: "c0", name: "write", arguments: { path: "app.ts", content: "new\n" } }],
        },
        // The second turn stalls, so the run is still open when the verbs land.
        { text: "still working", delayMs: 400 },
      ],
      { dryRun: true },
    );

    const run = harness.client.prompt(harness.sessionId, "rewrite it");
    await new Promise((resolve) => setTimeout(resolve, 120));

    await expect(harness.client.applyChanges(harness.sessionId)).rejects.toThrow(/running a turn/);
    await expect(harness.client.discardChanges(harness.sessionId)).rejects.toThrow(
      /running a turn/,
    );
    // Reading is fine mid-run — /diff has never had a busy check, and a change
    // set you can watch grow is useful rather than dangerous.
    expect((await harness.client.pendingChanges(harness.sessionId))?.dryRun).toBe(true);
    expect(await readFile(target, "utf8")).toBe("old\n");

    await run;
    const applied = await harness.client.applyChanges(harness.sessionId);
    expect(applied.applied).toEqual(["app.ts"]);
    expect(await readFile(target, "utf8")).toBe("new\n");
  });
});

describe("an engine that is not in dry-run mode says so", () => {
  it("reports dryRun: false rather than an empty list, and refuses to apply", async () => {
    const scratch = await makeScratch();
    const target = join(scratch.cwd, "app.ts");
    await writeFileAt(target, "old\n");

    const harness = await serve(
      scratch,
      writeTurns([{ path: "app.ts", content: "new\n" }]),
      // No dryRun: this engine writes straight through.
      {},
    );
    await harness.client.prompt(harness.sessionId, "rewrite it");
    expect(await readFile(target, "utf8")).toBe("new\n");

    const pending = await harness.client.pendingChanges(harness.sessionId);
    expect(pending?.dryRun).toBe(false);
    expect(pending?.changes).toEqual([]);

    await expect(harness.client.applyChanges(harness.sessionId)).rejects.toThrow(
      /not running under --dry-run/,
    );
    await expect(harness.client.discardChanges(harness.sessionId)).rejects.toThrow(
      /not running under --dry-run/,
    );
  });
});

describe("the / menu lists the loop", () => {
  it("offers /diff, /apply and /discard, and refuses them as prompt text", async () => {
    const scratch = await makeScratch();
    const harness = await serve(scratch, [{ text: "hi" }], { dryRun: true });

    const listed = await harness.client.listCommands();
    const builtins = (listed?.commands ?? [])
      .filter((command) => command.kind === "builtin")
      .map((command) => command.name);
    expect(builtins).toContain("diff");
    expect(builtins).toContain("apply");
    expect(builtins).toContain("discard");

    // A listed built-in sent as prose is refused with the verb to call
    // instead — the menu and the executor read the same list.
    await expect(harness.client.prompt(harness.sessionId, "/apply")).rejects.toThrow(
      /applyChanges/,
    );
  });
});
