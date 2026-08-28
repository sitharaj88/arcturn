/**
 * Reading a scout's `git diff` well enough to show it in a diff editor.
 *
 * A scout's work product arrives as unified-diff text, because the worktree it
 * was made in is deleted seconds after the diff is captured. VS Code's diff
 * editor wants two documents, not a patch — so the "before" has to be
 * reconstructed from the hunks, and the "after" from the hunks plus the
 * before.
 *
 * Reconstruction is exact where the patch covers, and honest where it does
 * not: a hunk's context lines are the only evidence of what the untouched
 * parts of a file looked like, so a file is rebuilt from its hunks alone and
 * the gaps between them are marked rather than invented. The alternative —
 * reading the real file off disk — is wrong twice over, because the scout
 * branched from a commit the working tree may have moved past, and because the
 * engine may not even be on this machine.
 *
 * Nothing here executes a patch or touches a file. It is string in, strings
 * out, which is what makes it testable and what keeps a malformed diff from
 * being anything worse than a rendering problem.
 */

/** How a file changed, in `git`'s vocabulary. */
export type PatchChange = "added" | "deleted" | "modified" | "renamed";

/** One file's worth of a unified diff. */
export interface PatchFile {
  /** Path before the change. Equal to {@link PatchFile.path} unless renamed. */
  readonly oldPath: string;
  /** Path after the change. For a deletion, the path that was removed. */
  readonly path: string;
  readonly change: PatchChange;
  /** Reconstructed pre-image, from context and removed lines. */
  readonly before: string;
  /** Reconstructed post-image, from context and added lines. */
  readonly after: string;
  readonly added: number;
  readonly removed: number;
  /**
   * True when the hunks do not cover the whole file, so the reconstruction has
   * gaps. The renderer says so rather than showing a partial file as complete.
   */
  readonly partial: boolean;
  /** True when git reported the file as binary; `before`/`after` are then empty. */
  readonly binary: boolean;
}

/** A marker line standing in for the parts of a file no hunk described. */
export const ELIDED_MARKER = "⋯";

interface Hunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: string[];
}

/**
 * Split a `git diff` into its files.
 *
 * Tolerant by construction: anything it cannot parse is skipped rather than
 * thrown over, because the input is a subprocess's stdout and a rendering
 * surface should degrade to "fewer files shown" rather than to an error
 * dialog. A caller comparing counts against `git`'s own summary would notice;
 * a user reading two approaches side by side is better served by the files
 * that did parse.
 */
export function parseUnifiedDiff(diff: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = diff.split("\n");
  // `split` on text ending in a newline leaves a trailing "", which would be
  // pushed into the last hunk as an empty context line and add a line to both
  // sides of the last file. A blank line *inside* a hunk is a different thing
  // and is kept: git writes it as a single space, or as "" once something has
  // stripped the trailing whitespace.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let index = 0;

  while (index < lines.length) {
    if (!lines[index]?.startsWith("diff --git ")) {
      index += 1;
      continue;
    }
    const header = lines[index] ?? "";
    index += 1;

    let oldPath = "";
    let newPath = "";
    let change: PatchChange = "modified";
    let binary = false;
    const hunks: Hunk[] = [];

    // The metadata block, up to the first hunk or the next file.
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.startsWith("@@") || line.startsWith("diff --git ")) break;
      if (line.startsWith("new file mode")) change = "added";
      else if (line.startsWith("deleted file mode")) change = "deleted";
      else if (line.startsWith("rename from ")) {
        change = "renamed";
        oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length);
      else if (line.startsWith("--- ")) oldPath = stripPathPrefix(line.slice(4));
      else if (line.startsWith("+++ ")) newPath = stripPathPrefix(line.slice(4));
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        binary = true;
      }
      index += 1;
    }

    // The hunks.
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.startsWith("diff --git ")) break;
      const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (range === null) {
        index += 1;
        continue;
      }
      index += 1;
      const body: string[] = [];
      while (index < lines.length) {
        const bodyLine = lines[index] ?? "";
        if (bodyLine.startsWith("@@") || bodyLine.startsWith("diff --git ")) break;
        // "\ No newline at end of file" annotates the previous line rather
        // than being one, and must not become content.
        if (!bodyLine.startsWith("\\")) body.push(bodyLine);
        index += 1;
      }
      hunks.push({
        oldStart: Number(range[1] ?? "1"),
        newStart: Number(range[3] ?? "1"),
        lines: body,
      });
    }

    // `--- /dev/null` leaves `oldPath` empty on an add, and the same for a
    // delete; the header is the only place both names always appear.
    if (oldPath === "" || newPath === "") {
      const named = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
      if (named !== null) {
        if (oldPath === "") oldPath = named[1] ?? "";
        if (newPath === "") newPath = named[2] ?? "";
      }
    }
    if (newPath === "" && oldPath === "") continue;

    const built = rebuild(hunks);
    files.push({
      oldPath: oldPath === "" ? newPath : oldPath,
      path: newPath === "" ? oldPath : newPath,
      change,
      before: binary ? "" : built.before,
      after: binary ? "" : built.after,
      added: built.added,
      removed: built.removed,
      partial: !binary && built.partial,
      binary,
    });
  }

  return files;
}

/** `a/src/x.ts` and `b/src/x.ts` both name `src/x.ts`; `/dev/null` names nothing. */
function stripPathPrefix(raw: string): string {
  const path = raw.split("\t")[0] ?? raw;
  if (path === "/dev/null") return "";
  return path.replace(/^[ab]\//, "");
}

/** Rebuild both sides from the hunks, marking the gaps between them. */
function rebuild(hunks: readonly Hunk[]): {
  before: string;
  after: string;
  added: number;
  removed: number;
  partial: boolean;
} {
  const before: string[] = [];
  const after: string[] = [];
  let added = 0;
  let removed = 0;
  let partial = false;
  let oldCursor = 1;
  let newCursor = 1;

  for (const hunk of hunks) {
    // A hunk that does not start where the last one ended means unseen lines
    // in between. They are marked, never guessed at — a reconstruction that
    // silently closed the gap would show two adjacent functions as adjacent
    // when a hundred lines sit between them.
    if (hunk.oldStart > oldCursor || hunk.newStart > newCursor) {
      if (before.length > 0 || after.length > 0 || hunk.oldStart > 1 || hunk.newStart > 1) {
        partial = true;
        before.push(ELIDED_MARKER);
        after.push(ELIDED_MARKER);
      }
    }
    for (const line of hunk.lines) {
      const marker = line.charAt(0);
      const text = line.slice(1);
      if (marker === "+") {
        after.push(text);
        added += 1;
        newCursor += 1;
      } else if (marker === "-") {
        before.push(text);
        removed += 1;
        oldCursor += 1;
      } else {
        // A context line, or an empty line git wrote with no leading space.
        const context = line === "" ? "" : text;
        before.push(context);
        after.push(context);
        oldCursor += 1;
        newCursor += 1;
      }
    }
  }

  return { before: before.join("\n"), after: after.join("\n"), added, removed, partial };
}

/** One approach's result, reduced to what a comparison needs. */
export interface ScoutApproachSummary {
  readonly name: string;
  readonly task: string;
  readonly status: string;
  readonly finalText: string;
  readonly costUsd?: number;
  readonly durationMs: number;
  readonly files: readonly PatchFile[];
}

/** One line summarising what an approach did, for a quick-pick row. */
export function approachSummaryLine(approach: ScoutApproachSummary): string {
  if (approach.status === "error") return "failed";
  const files = approach.files.length;
  if (files === 0) {
    return approach.status === "timeout" ? "timed out, changed nothing" : "changed nothing";
  }
  const added = approach.files.reduce((total, file) => total + file.added, 0);
  const removed = approach.files.reduce((total, file) => total + file.removed, 0);
  const shape = `${files} ${files === 1 ? "file" : "files"}, +${added} −${removed}`;
  return approach.status === "timeout" ? `${shape} (timed out)` : shape;
}

/**
 * Every path any approach touched, sorted, deduplicated.
 *
 * The union rather than an intersection, because the interesting question when
 * comparing approaches is usually "what did this one touch that the other did
 * not" — and an intersection would hide exactly that.
 */
export function touchedPaths(approaches: readonly ScoutApproachSummary[]): string[] {
  const paths = new Set<string>();
  for (const approach of approaches) {
    for (const file of approach.files) paths.add(file.path);
  }
  return [...paths].sort();
}

/**
 * Split what the user typed into approaches.
 *
 * The `|` separator and the optional `name:` prefix are the terminal's syntax,
 * copied exactly rather than reinvented: somebody who knows `/scout` should not
 * have to learn a second grammar to use the same feature from the panel. A
 * divergence between the two would be invisible until someone typed the same
 * line into both and got two different runs.
 */
export function parseApproaches(input: string): { name: string; task: string }[] {
  return input
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part, index) => {
      const named = /^([\w-]{1,24}):\s*(.+)$/.exec(part);
      return named
        ? { name: named[1] as string, task: named[2] as string }
        : { name: `approach-${index + 1}`, task: part };
    });
}

/** One run's settled results, as the wire delivers them. */
export type ScoutRunResults = readonly {
  name: string;
  task: string;
  status: string;
  finalText: string;
  costUsd?: number;
  diff?: string;
  durationMs: number;
}[];

/**
 * Turn a run's results into the summaries a comparison renders.
 *
 * An approach that changed nothing gets an empty file list rather than a
 * missing one — a scout that timed out before writing still has findings worth
 * reading, and the renderer should not have to guard against `undefined`.
 */
export function summarise(results: ScoutRunResults): ScoutApproachSummary[] {
  return results.map((result) => ({
    name: result.name,
    task: result.task,
    status: result.status,
    finalText: result.finalText,
    // No `?? 0`: an unpriced scout has an unknown cost, not a free one.
    ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    durationMs: result.durationMs,
    files: result.diff === undefined ? [] : parseUnifiedDiff(result.diff),
  }));
}
