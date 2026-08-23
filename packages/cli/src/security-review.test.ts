/**
 * Adversarial security review — CLI package.
 *
 * Targets the CHECKPOINTS and MENTIONS seams called out in the review brief.
 * Each `it.fails` below is a MINIMAL reproduction of a real gap, written to
 * demonstrate the current (buggy) behavior rather than to assert the fixed
 * one. Do not "fix" these by loosening the assertions — fix the source and
 * flip `it.fails` to `it` instead.
 */

import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCheckpointStore } from "./checkpoints.js";
import { expandMentions } from "./mentions.js";
import { buildTestRuntime, makeScratch, writeFileAt } from "./test-helpers/scratch.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("CHECKPOINTS: sub-agent writes are snapshotted (fixed)", () => {
  it("a yolo sub-agent's write tool call records a checkpoint for the mutated file", async () => {
    const scratch = await makeScratch();
    const target = join(scratch.cwd, "victim.txt");
    await writeFileAt(target, "original content");

    // Parent runtime in yolo mode: createSubagent() then hands the child
    // the *full* tool set (including write/edit), built from
    // `this.#baseTools` directly — see runtime.ts `createSubagent()`.
    // Compare with `#agentOptions()`, used for the *parent* agent, which
    // always wraps with `wrapToolsWithCheckpoints(...)` before handing
    // tools to an Agent. createSubagent() never does that wrap.
    const runtime = await buildTestRuntime(
      scratch,
      [
        {
          toolCalls: [
            {
              id: "t1",
              name: "write",
              arguments: { path: target, content: "pwned by sub-agent" },
            },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    const child = runtime.createSubagent("overwrite the victim file");
    expect(child.tools.map((t) => t.definition.name)).toContain("write");

    await child.prompt("please overwrite victim.txt");

    // The write really happened (no permission gate blocked it — yolo mode).
    expect(await readFile(target, "utf8")).toBe("pwned by sub-agent");

    // But the runtime's checkpoint store — the one `/rewind` reads — has
    // recorded NOTHING for this mutation. A user who runs `/rewind` after
    // delegating a task to a sub-agent has no way back to "original
    // content": there is no turn, and no file record, for this write.
    const turns = await runtime.checkpoints.listTurns();
    const totalFileRecords = turns.reduce((sum, t) => sum + t.fileCount, 0);
    // EXPECTED (bug): this is 0 — proving the sub-agent's write bypassed
    // checkpointing entirely. A fixed implementation would have at least
    // one file record referencing `target`.
    expect(totalFileRecords).toBeGreaterThan(0);

    await runtime.dispose();
  });

  it("contrast: the SAME mutation via the parent agent IS checkpointed", async () => {
    const scratch = await makeScratch();
    const target = join(scratch.cwd, "victim.txt");
    await writeFileAt(target, "original content");

    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "t1", name: "write", arguments: { path: target, content: "v2" } }] },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    await runtime.agent.prompt("overwrite victim.txt");
    expect(await readFile(target, "utf8")).toBe("v2");

    const turns = await runtime.checkpoints.listTurns();
    const totalFileRecords = turns.reduce((sum, t) => sum + t.fileCount, 0);
    // The parent agent's tools go through `#agentOptions()`, which DOES wrap
    // with `wrapToolsWithCheckpoints`, so this one is protected.
    expect(totalFileRecords).toBeGreaterThan(0);

    await runtime.dispose();
  });
});

describe("CHECKPOINTS: restore() is confined to the restore root (fixed)", () => {
  it("restore() refuses an absolute path outside the workspace restore root", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcturn-cli-checkpoint-confinement-"));
    const storeDir = join(root, "store");
    // Stands in for a file the user never intended Arcturn to touch, entirely
    // outside any notion of "workspace" the checkpoint store knows about
    // (checkpoints.ts has no cwd/root concept at all).
    const outsideDir = join(root, "outside-workspace");
    await mkdir(outsideDir, { recursive: true });
    const victim = join(outsideDir, "not-in-any-workspace.txt");
    await writeFile(victim, "sensitive original content", "utf8");

    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const store = createCheckpointStore(storeDir, { restoreRoot: workspace });
    await store.beginTurn("turn touching an out-of-workspace file");
    // This is exactly what `wrapToolsWithCheckpoints` calls before letting
    // write/edit through — `store.snapshot(absolutePath)` — and it is
    // reachable for ANY absolute path a write/edit call resolves to
    // (`resolvePath` does not confine to cwd either; see path-utils.ts).
    await store.snapshot(victim);

    // Now the file changes (simulating the mutation that followed).
    await writeFile(victim, "attacker-modified content", "utf8");

    const turns = await store.listTurns();
    const turnId = turns[0]?.id;
    if (!turnId) throw new Error("no turn recorded");

    const result = await store.restore(turnId);

    // EXPECTED (bug): restore() happily writes back to `victim`, an
    // absolute path with no relationship to any workspace/cwd boundary —
    // there is no check anywhere in `restore()` that the path being
    // written to is inside an expected root. A poisoned/crafted manifest
    // entry (e.g. appended by anything with write access to
    // `~/.arcturn/checkpoints/<sessionId>/manifest.jsonl`) can make restore()
    // write attacker-controlled blob content, or delete, any absolute
    // path on disk the user running `/rewind` can write to — with no
    // permission prompt at all, since restore() is not tool-mediated.
    //
    // A fixed implementation would either reject/skip paths outside a
    // known root, or this test's assertion would need restore() to have
    // refused the path. We assert the (desired, currently false) safe
    // behavior below so this test FAILS against current code.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(await readFile(victim, "utf8")).toBe("attacker-modified content");
  });
});

describe("MENTIONS: symlinks cannot escape the workspace (fixed)", () => {
  it("an @-mention through a symlink pointing outside the workspace is ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcturn-cli-mentions-symlink-"));
    const cwd = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });

    const secretPath = join(outside, "secret.txt");
    await writeFile(secretPath, "TOP SECRET OUTSIDE THE WORKSPACE", "utf8");

    // A symlink *inside* the workspace pointing at a directory *outside*
    // it. `resolveInside()` only does a lexical `resolve()` + string
    // prefix check — it never calls `realpath`/`lstat` — so the mention
    // text `@link/secret.txt` resolves (lexically) to
    // `<cwd>/link/secret.txt`, which passes the `startsWith(root + sep)`
    // check even though the real file lives entirely outside `cwd`.
    const linkPath = join(cwd, "link");
    await symlink(outside, linkPath, "dir");

    const { text } = await expandMentions("please look at @link/secret.txt", cwd);

    // EXPECTED (bug): the secret content ends up injected into the
    // prompt text, even though it was never inside the workspace root.
    expect(text).not.toContain("TOP SECRET OUTSIDE THE WORKSPACE");
  });
});

describe("MENTIONS: text-file size cap applies before the read (fixed)", () => {
  it("a huge non-image mention is skipped with a note instead of being buffered", async () => {
    const scratch = await makeScratch();
    const bigPath = join(scratch.cwd, "huge.log");

    // Comfortably past the 200KB/2000-line cap `truncateText()` applies —
    // large enough that reading it whole (rather than capping the read
    // itself) is the actual behavior under test, not just its outcome.
    const bigContent = "x".repeat(20 * 1024 * 1024); // 20MB, single line
    await writeFile(bigPath, bigContent, "utf8");

    // Files past the pre-read cap are never buffered at all: the mention is
    // answered with a "(too large to inline)" note instead of content —
    // mirroring the image branch's stat-before-read guard.
    const result = await expandMentions("@huge.log", scratch.cwd);
    expect(result.text).toContain("(too large to inline)");
    expect(result.text).not.toContain("xxxx");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(300 * 1024);
  });
});

// Keep this reference so lint doesn't flag it as unused if a future edit
// trims a test above without removing the import.
void exists;
