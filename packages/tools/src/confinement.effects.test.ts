/**
 * Workspace confinement, asserted on the filesystem rather than on a return
 * value.
 *
 * Every case here answers the same question the wrong way round from how the
 * tools' other tests ask it: not "did the call succeed", but "where did the
 * bytes land, and is that where the permission subject said they would".
 * A permission rule that confines an agent to a directory is only a wall if
 * the subject it matches against is the file that is actually written — the
 * `$SKILL_DIR` traversal shipped because nothing checked that.
 */

import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "./edit.js";
import { resolvePath, resolveSubjectPath } from "./path-utils.js";
import { createReadTool } from "./read.js";
import { createFakeContext, removeTempDir } from "./test-utils.js";
import { createWriteTool } from "./write.js";

/** True when `child` is strictly under `parent`, lexically. */
function isInside(parent: string, child: string): boolean {
  if (child === "") return false;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

describe("path-taking tools: a permission subject names where the bytes land", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(removeTempDir));
  });

  async function workspaceWithEscapeHatch(): Promise<{ cwd: string; outside: string }> {
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-confine-ws-"));
    const outside = await mkdtemp(join(tmpdir(), "arcturn-confine-out-"));
    dirs.push(cwd, outside);
    // The door: a symlink inside the workspace pointing at a directory outside it.
    await symlink(outside, join(cwd, "escape"));
    return { cwd, outside };
  }

  it("write: a symlinked directory cannot present an inside-the-workspace subject", async () => {
    const { cwd, outside } = await workspaceWithEscapeHatch();
    await writeFile(join(outside, "victim.txt"), "original\n");

    const tool = createWriteTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });
    const result = await tool.execute({ path: "escape/victim.txt", content: "pwned\n" }, ctx);
    expect(result.isError).toBeFalsy();

    // The write landed outside the workspace — that is the ground truth.
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("pwned\n");

    // So the subject the permission engine matched a rule against must say so.
    // A subject under `cwd` would match an `allow write <cwd>/**` rule while
    // the bytes went somewhere that rule never covered.
    const subject = permissionRequests[0]?.subject ?? "";
    expect(isInside(cwd, subject), `subject ${subject} claims to be inside ${cwd}`).toBe(false);
    expect(await readFile(subject, "utf8")).toBe("pwned\n");
  });

  it("write: the suggested 'always allow' rule cannot grant the workspace on an escape", async () => {
    const { cwd } = await workspaceWithEscapeHatch();

    const tool = createWriteTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });
    await tool.execute({ path: "escape/new-file.txt", content: "x" }, ctx);

    // Approving "always allow" must not hand out a directory inside the
    // workspace when the file being approved is not in the workspace at all.
    const specifier = permissionRequests[0]?.suggestedRule?.specifier ?? "";
    expect(isInside(cwd, specifier)).toBe(false);
  });

  it("write: a path that is itself a dangling symlink out of the workspace", async () => {
    const { cwd, outside } = await workspaceWithEscapeHatch();
    const target = join(outside, "not-yet-there.txt");
    await symlink(target, join(cwd, "innocent.txt"));

    const tool = createWriteTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });
    const result = await tool.execute({ path: "innocent.txt", content: "created\n" }, ctx);
    expect(result.isError).toBeFalsy();

    // The dangling link decided where the new file was created.
    expect(await readFile(target, "utf8")).toBe("created\n");
    const subject = permissionRequests[0]?.subject ?? "";
    expect(isInside(cwd, subject), `subject ${subject} claims to be inside ${cwd}`).toBe(false);
  });

  it("edit: a symlinked directory cannot present an inside-the-workspace subject", async () => {
    const { cwd, outside } = await workspaceWithEscapeHatch();
    await writeFile(join(outside, "victim.txt"), "keep me\n");

    const tool = createEditTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });
    const result = await tool.execute(
      { path: "escape/victim.txt", oldText: "keep me", newText: "clobbered" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("clobbered\n");

    const subject = permissionRequests[0]?.subject ?? "";
    expect(isInside(cwd, subject), `subject ${subject} claims to be inside ${cwd}`).toBe(false);
  });

  it("a `..` traversal still cannot present an inside-the-workspace subject", async () => {
    const { cwd } = await workspaceWithEscapeHatch();
    const tool = createWriteTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });

    await tool.execute({ path: "sub/../../sibling-escape.txt", content: "x" }, ctx);

    const subject = permissionRequests[0]?.subject ?? "";
    expect(isInside(cwd, subject)).toBe(false);
    // A path that never claimed to be inside the workspace keeps its literal
    // spelling: on macOS `/var` is a symlink to `/private/var`, and rewriting
    // an already-honest path would stop a user's `/tmp/**` rule from matching.
    expect(dirname(subject)).toBe(dirname(cwd));
  });

  it("an ordinary in-workspace path keeps its literal spelling as the subject", async () => {
    // The regression this fix must not cause: `os.tmpdir()` is `/var/folders/…`
    // on macOS and `/var` is a symlink to `/private/var`, so canonicalizing
    // unconditionally would stop every rule a user wrote against the path
    // their shell shows them from matching. Anchoring on `cwd` keeps them.
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-confine-plain-"));
    dirs.push(cwd);

    const tool = createWriteTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });
    await tool.execute({ path: "sub/deep/file.txt", content: "x" }, ctx);

    expect(permissionRequests[0]?.subject).toBe(join(cwd, "sub", "deep", "file.txt"));
    expect(permissionRequests[0]?.suggestedRule?.specifier).toBe(`${join(cwd, "sub", "deep")}/**`);
    expect(await readFile(join(cwd, "sub", "deep", "file.txt"), "utf8")).toBe("x");
  });

  it("writing through an in-workspace symlink keeps the workspace subject and the link", async () => {
    // A symlink that does *not* escape must stay ordinary: the subject is
    // still inside the workspace, and the link itself survives the write.
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-confine-inner-"));
    dirs.push(cwd);
    await writeFile(join(cwd, "target.txt"), "before\n");
    await symlink(join(cwd, "target.txt"), join(cwd, "alias.txt"));

    const tool = createWriteTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });
    await tool.execute({ path: "alias.txt", content: "after\n" }, ctx);

    expect(isInside(cwd, permissionRequests[0]?.subject ?? "")).toBe(true);
    expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("after\n");
    expect((await lstat(join(cwd, "alias.txt"))).isSymbolicLink()).toBe(true);
  });
});

describe("a write that leaves the workspace says so in its own result", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(removeTempDir));
  });

  it("names the file the path resolved to, so an escape is not invisible", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-confine-note-"));
    const outside = await mkdtemp(join(tmpdir(), "arcturn-confine-note-out-"));
    dirs.push(cwd, outside);
    await symlink(outside, join(cwd, "escape"));

    const tool = createWriteTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });
    const result = await tool.execute({ path: "escape/note.txt", content: "x" }, ctx);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(permissionRequests[0]?.subject ?? "<none>");
    expect(await readFile(join(outside, "note.txt"), "utf8")).toBe("x");
  });

  it("says nothing extra for an ordinary in-workspace write", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-confine-quiet-"));
    dirs.push(cwd);

    const tool = createWriteTool();
    const { ctx } = createFakeContext({ cwd });
    const result = await tool.execute({ path: "plain.txt", content: "x" }, ctx);

    expect((result.content[0] as { text: string }).text).toBe(
      `Created ${join(cwd, "plain.txt")} (1 bytes).`,
    );
  });
});

/**
 * The read side of the same door, now closed — from the other package.
 *
 * `write` and `edit` ask for permission themselves, so making their subject
 * truthful (see `resolveSubjectPath`) is enough to stop a symlink walking
 * around a rule. `read`/`grep`/`glob`/`ls` are in `DEFAULT_READ_ONLY_TOOLS`
 * and never call `requestPermission` at all: the *only* wall in front of them
 * is a stored `deny` rule, matched by `loop.ts` against the subject core
 * derives from the call's arguments.
 *
 * That subject used to be `defaultSubject`, which resolves `..` but not
 * symlinks — so `deny read <secrets>/**` denied `read("<secrets>/id_rsa")` and
 * allowed `read("keys/id_rsa")` through a `keys -> <secrets>` link, and the
 * key bytes came back in the tool result, which is to say into the model's
 * context. `loop.ts` now awaits `resolveSubject` instead, which routes a path
 * argument through core's own `resolveSubjectPath` — the same semantics as the
 * one below, pinned to it by a conformance test in
 * `packages/cli/src/symlink-subject.security.test.ts`.
 *
 * **What changed here is nothing, and that is the point.** The two facts these
 * tests pin are tool-side and were never the defect: `read` still follows an
 * escaping symlink (refusing to would be a host policy decision, and would
 * contradict `grep`, which deliberately *does* follow one so a
 * `docs -> ../shared-docs` subtree is searchable), and it still asks nobody.
 * Everything therefore still rests on the subject the engine is handed — which
 * is what the second test measures, and what the fix changed. The bytes-level
 * proof that the wall now holds needs a real engine and a real loop, so it
 * lives in the CLI package, which is the lowest one that can see both.
 */
describe("read-only tools: the wall is the subject, and the subject is now truthful", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(removeTempDir));
  });

  it("read follows a symlink out of the workspace, silently and without asking", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-readside-ws-"));
    const outside = await mkdtemp(join(tmpdir(), "arcturn-readside-secrets-"));
    dirs.push(cwd, outside);
    await writeFile(join(outside, "id_rsa"), "PRIVATE-KEY-BYTES\n");
    await symlink(outside, join(cwd, "keys"));

    const tool = createReadTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd });
    const result = await tool.execute({ path: "keys/id_rsa" }, ctx);

    // The tool itself does not police the link: it reads what it was pointed
    // at, exactly as `grep` walks into a symlinked subtree on purpose.
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("PRIVATE-KEY-BYTES");
    // And with no ask of its own: the rule engine is the only thing that can
    // stop this, so everything rests on the subject it was handed.
    expect(permissionRequests).toHaveLength(0);
  });

  it("and the subject a rule is matched against is the file, not the spelling", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-readside-subj-"));
    const outside = await mkdtemp(join(tmpdir(), "arcturn-readside-subj-out-"));
    dirs.push(cwd, outside);
    await writeFile(join(outside, "id_rsa"), "PRIVATE-KEY-BYTES\n");
    await symlink(outside, join(cwd, "keys"));

    // What a plain `resolve` computes, and what the engine used to be given:
    // a path inside the workspace, so a `deny read <outside>/**` rule never
    // matched it and an `allow read <cwd>/**` rule did.
    const lexical = resolvePath(cwd, "keys/id_rsa");
    expect(isInside(cwd, lexical)).toBe(true);

    // What `loop.ts` hands the engine now — via core's twin of this function,
    // which the conformance test holds to the same answers.
    const truthful = await resolveSubjectPath(cwd, lexical);
    expect(isInside(cwd, truthful)).toBe(false);
    expect(await readFile(truthful, "utf8")).toBe("PRIVATE-KEY-BYTES\n");
  });
});
