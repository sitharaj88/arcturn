/**
 * Minimal line-based unified diff generator (own implementation, no dependency).
 * Uses a classic LCS dynamic-programming table; for very large inputs it falls
 * back to a single "replace everything" hunk to avoid O(n*m) blowups.
 */

type DiffOpType = "equal" | "add" | "del";

interface DiffOp {
  type: DiffOpType;
  value: string;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Cells above this are treated as "too large" for the O(n*m) LCS table. */
const MAX_LCS_CELLS = 4_000_000;

function computeLcsOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > MAX_LCS_CELLS) {
    // Fallback: treat the whole file as replaced. Still a valid (if coarse) diff.
    const ops: DiffOp[] = [];
    for (const line of oldLines) ops.push({ type: "del", value: line });
    for (const line of newLines) ops.push({ type: "add", value: line });
    return ops;
  }

  // dp[i][j] = length of the LCS of oldLines[i..] and newLines[j..]
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const dpi = dp[i] as Uint32Array;
    const dpi1 = dp[i + 1] as Uint32Array;
    const oldLine = oldLines[i] as string;
    for (let j = m - 1; j >= 0; j--) {
      dpi[j] =
        oldLine === newLines[j]
          ? (dpi1[j + 1] as number) + 1
          : Math.max(dpi1[j] as number, dpi[j + 1] as number);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = oldLines[i] as string;
    const newLine = newLines[j] as string;
    if (oldLine === newLine) {
      ops.push({ type: "equal", value: oldLine });
      i++;
      j++;
    } else if ((dp[i + 1] as Uint32Array)[j]! >= (dp[i] as Uint32Array)[j + 1]!) {
      ops.push({ type: "del", value: oldLine });
      i++;
    } else {
      ops.push({ type: "add", value: newLine });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", value: oldLines[i] as string });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", value: newLines[j] as string });
    j++;
  }
  return ops;
}

function buildHunks(ops: DiffOp[], context: number): Hunk[] {
  const groups: Array<[number, number]> = [];
  let i = 0;
  while (i < ops.length) {
    if ((ops[i] as DiffOp).type === "equal") {
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && (ops[j] as DiffOp).type !== "equal") j++;
    groups.push([i, j]);
    i = j;
  }
  if (groups.length === 0) return [];

  const merged: Array<[number, number]> = [];
  for (const [start, end] of groups) {
    const last = merged[merged.length - 1];
    if (last && start - last[1] <= context * 2) {
      last[1] = end;
      continue;
    }
    merged.push([start, end]);
  }

  const oldLineNo: number[] = new Array(ops.length);
  const newLineNo: number[] = new Array(ops.length);
  let ol = 1;
  let nl = 1;
  for (let k = 0; k < ops.length; k++) {
    oldLineNo[k] = ol;
    newLineNo[k] = nl;
    const op = ops[k] as DiffOp;
    if (op.type !== "add") ol++;
    if (op.type !== "del") nl++;
  }

  const hunks: Hunk[] = [];
  for (const [start, end] of merged) {
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length, end + context);
    const oldStart = from < ops.length ? (oldLineNo[from] as number) : ol;
    const newStart = from < ops.length ? (newLineNo[from] as number) : nl;
    let oldLines = 0;
    let newLines = 0;
    const lines: string[] = [];
    for (let k = from; k < to; k++) {
      const op = ops[k] as DiffOp;
      if (op.type === "equal") {
        lines.push(` ${op.value}`);
        oldLines++;
        newLines++;
      } else if (op.type === "del") {
        lines.push(`-${op.value}`);
        oldLines++;
      } else {
        lines.push(`+${op.value}`);
        newLines++;
      }
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  }
  return hunks;
}

/**
 * Generate a unified diff between `oldText` and `newText`, labeled with `path`.
 * Splits on `\n`; does not attempt to preserve or detect CRLF line endings.
 */
export function createUnifiedDiff(
  path: string,
  oldText: string,
  newText: string,
  contextLines = 3,
): string {
  if (oldText === newText) return "";

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const ops = computeLcsOps(oldLines, newLines);
  const hunks = buildHunks(ops, contextLines);

  const header = `--- a/${path}\n+++ b/${path}`;
  const body = hunks
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
    )
    .join("\n");
  return `${header}\n${body}`;
}
