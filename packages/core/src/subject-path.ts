/**
 * Where a path argument *really goes*, for the permission engine to judge.
 *
 * ## Why this exists at all
 *
 * `path.resolve` normalizes `..` away, which is why a traversal cannot dodge a
 * directory grant. A *symlink* is not normalized away by anything lexical: a
 * link at `<workspace>/keys` pointing at `<home>/.ssh` makes `keys/id_rsa`
 * resolve to `<workspace>/keys/id_rsa` — a path that matches an
 * `allow <workspace>/**` rule and misses a `deny <home>/.ssh/**` one — while
 * `open()` follows the link and hands back the private key.
 *
 * That gap is at its widest in front of the read-only tools
 * (`read`, `grep`, `glob`, `ls` — see `DEFAULT_READ_ONLY_TOOLS`). Those tools never call `requestPermission`,
 * so a stored `deny` matched in `loop.ts` is the *only* wall in front of them
 * — and a stored `deny` is also the one decision no mode, `yolo` included, can
 * override. A wall is only a wall if it cannot be walked around by renaming
 * the door, so the subject has to be the destination.
 *
 * ## Why it does not canonicalize everything
 *
 * Canonicalizing unconditionally breaks the *other* direction: `os.tmpdir()`
 * is `/var/folders/…` on macOS and `/var` is itself a symlink to
 * `/private/var`, so a rule a user wrote against the path their shell shows
 * them would stop matching a subject spelled `/private/var/…`. So exactly one
 * case is rewritten — the one that lies:
 *
 * - The path does not claim to be inside `cwd` in the first place: returned
 *   verbatim. Nothing is disguised, and a rule written against `/tmp/**` still
 *   matches on macOS.
 * - It claims to be inside `cwd` and really is: re-spelled under the caller's
 *   own spelling of `cwd`, byte-identical to `path.resolve`'s answer for any
 *   path with no symlink in it. An in-workspace link to an in-workspace file
 *   therefore stays an ordinary symlink, and `grep`'s deliberate following of
 *   a symlinked subtree keeps working.
 * - It claims to be inside `cwd` and is not: reported canonically, so the
 *   escape is what the rules see.
 *
 * ## Why there are two copies of this
 *
 * `@arcturn/tools` carries the same resolution in `src/path-utils.ts`, because
 * `write` and `edit` compute their own permission subject and must be truthful
 * even when a host calls them directly, without this loop. `@arcturn/core` and
 * `@arcturn/tools` are siblings — both depend only on `@arcturn/types`,
 * neither on the other — and neither dependency edge is worth buying for one
 * function: core would drag every tool implementation (and `tinyglobby`) into
 * the runtime, and tools would drag the whole agent loop into a package whose
 * point is to be droppable into someone else's.
 *
 * Two answers to "where does this path really go" is exactly how this class of
 * bug returns, so the copies are pinned together by a conformance test in the
 * lowest package that sees both:
 * `packages/cli/src/symlink-subject.security.test.ts`. Change one, change the
 * other, or that test fails.
 */

import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * How many symlink hops {@link canonicalizePath} will follow before giving up.
 * Matches the conventional `SYMLOOP_MAX`; a cycle is the only way to exceed it.
 */
const MAX_LINK_HOPS = 40;

/**
 * The path `path` *actually names on disk*, with every symlink in it resolved,
 * even when the path does not exist yet.
 *
 * `fs.realpath` alone cannot answer this: it throws `ENOENT` for a file about
 * to be created, and for a dangling symlink. So this walks the problem
 * instead — resolve what exists, follow a dangling link to its target and
 * retry, otherwise step up to the parent and carry the trailing segments
 * along — and reassembles the answer from the deepest resolvable ancestor.
 *
 * Falls back to the lexical path if nothing resolves (a nonexistent root, a
 * symlink cycle). **Nothing in here throws**, and that is deliberate: see the
 * failure-direction note on {@link resolveSubjectPath}.
 */
async function canonicalizePath(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...[...tail].reverse());
    } catch {
      // `current` does not fully resolve; fall through and take it apart.
    }
    let target: string | undefined;
    try {
      if ((await lstat(current)).isSymbolicLink()) target = await readlink(current);
    } catch {
      // Not a symlink, or not there at all.
    }
    if (target !== undefined) {
      // A dangling symlink still decides where a write lands: follow it.
      current = resolve(dirname(current), target);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) break;
    tail.push(basename(current));
    current = parent;
  }
  return tail.length === 0 ? current : join(current, ...[...tail].reverse());
}

/**
 * The path a permission subject should name: where the tool call's bytes will
 * actually come from or land, not where the argument's spelling suggests.
 *
 * ## The failure direction, and why it is this one
 *
 * This never rejects and never signals failure. A path that cannot be resolved
 * — a nonexistent file, an unreadable parent (`EACCES`), a symlink cycle —
 * degrades to the deepest resolvable ancestor plus the literal remainder, and
 * in the limit to the lexical path this was handed. Three reasons, in order of
 * weight:
 *
 * 1. **A failure can never be worse than the status quo.** The fallback is
 *    exactly the subject the engine received before this existed, so the
 *    change is monotone: it can only ever move a subject to a truer place,
 *    never to a laxer one, and a resolution that fails leaves the old wall
 *    standing rather than removing it.
 * 2. **The failure cannot be steered.** To profit, a caller would need the
 *    resolution to fail *on the hop that redirects* — but anything that
 *    redirects bytes is a symlink that exists, and an existing symlink is
 *    exactly what `realpath`/`readlink` resolve. A dangling link is followed
 *    by name, so even a link aimed at a not-yet-created file outside the
 *    workspace yields the truthful outside path.
 * 3. **Refusing on failure would break the common case.** A file that does not
 *    exist yet is the normal argument to `write`; "cannot resolve, therefore
 *    deny" would refuse every new file in the workspace.
 *
 * @param cwd - The tool call's working directory.
 * @param absolutePath - The already-resolved path the tool will operate on.
 */
export async function resolveSubjectPath(cwd: string, absolutePath: string): Promise<string> {
  if (!isUnder(cwd, absolutePath)) return absolutePath;
  const real = await canonicalizePath(absolutePath);
  if (real === absolutePath) return absolutePath;
  const realCwd = await canonicalizePath(cwd);
  if (isUnder(realCwd, real)) return join(cwd, relative(realCwd, real));
  return real;
}

/** Whether `path` is strictly under `root`, comparing spellings only. */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
