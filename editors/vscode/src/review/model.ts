/**
 * A review of the working diff, delivered where problems already live.
 *
 * The engine has had `/review` since the git commands landed: it caps the
 * diff, asks a reviewer-prompted model, and prints prose. Prose is right for a
 * terminal and useless for an editor — the editor's native shape for "there is
 * something wrong at this line" is a **diagnostic**, which is clickable, lives
 * in the Problems panel, and (the reason this feature exists at all) is picked
 * up by the extension's existing Fix-with-Arcturn code action. Findings become
 * diagnostics, diagnostics offer the fix, the fix is reviewed again: the loop
 * closes inside the editor.
 *
 * So this module asks for **structured** findings — JSON, not prose — and
 * parses them defensively, because a model's compliance with a schema is a
 * probability rather than a contract. Everything here is pure: prompt in,
 * findings out, no editor and no engine.
 *
 * ## Line numbers are claims
 *
 * A finding's line is the model's reading of the diff, not a fact. It is
 * clamped by the renderer and anchored to a whole line rather than a range,
 * because pretending to column precision the model does not have would send
 * people staring at the wrong token. A finding with no usable line still
 * lands — at the top of its file, which is honest about what is known.
 */

/** How bad the model thinks a finding is. */
export type FindingSeverity = "error" | "warning" | "info";

/** One structured review finding. */
export interface ReviewFinding {
  /** Workspace-relative path, `a/`-`b/` prefixes stripped. */
  readonly path: string;
  /** 1-based line in the file's new version, or `undefined` when unusable. */
  readonly line?: number;
  readonly severity: FindingSeverity;
  /** One sentence naming the defect. */
  readonly title: string;
  /** The risk, in a sentence or two. May be empty. */
  readonly detail: string;
}

/**
 * Cap a diff for review, keeping the head.
 *
 * The opposite end from a command's output: a diff's file headers and hunk
 * headers come first and are what the reviewer needs to orient, whereas a
 * log's conclusion comes last. Marked when cut, and the marker counts against
 * the cap — the lesson `failures/model.ts` paid for.
 */
export const MAX_DIFF_CHARS = 60_000;

export function capDiff(diff: string, max = MAX_DIFF_CHARS): string {
  if (diff.length <= max) return diff;
  const marker = "\n… (diff truncated for review)";
  return `${diff.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

/**
 * The review prompt.
 *
 * Same review values as the engine's `/review` — real defects only, no style
 * commentary, "nothing found" is a legitimate answer — but the output contract
 * is JSON, because these findings are for a machine to place, not a person to
 * read. The "no findings" shape is stated explicitly: a model told only to
 * emit findings will invent one sooner than emit an empty array unprompted.
 */
export function reviewPrompt(diff: string): string {
  return [
    "You are a meticulous code reviewer. Review this diff for REAL defects only:",
    "correctness bugs, security vulnerabilities, and missed edge cases. Do not",
    "comment on style, formatting, or naming unless it causes an actual bug.",
    "",
    "Answer with ONLY a JSON object, no markdown fences, in exactly this shape:",
    '{"findings": [{"path": "src/file.ts", "line": 42, "severity": "error",',
    '"title": "one sentence naming the defect", "detail": "the risk, briefly"}]}',
    "",
    '- "path" is the file\'s path as the diff names it.',
    '- "line" is the line number in the NEW version of the file. Omit it if',
    "  the finding is about the file as a whole.",
    '- "severity" is "error" for a bug or vulnerability, "warning" for a likely',
    '  bug or missed edge case, "info" for something worth knowing.',
    '- If you find nothing worth flagging, answer {"findings": []} — do not',
    "  invent issues to fill the list.",
    "Do not use any tool; review only what is in the diff.",
    "",
    "```diff",
    capDiff(diff),
    "```",
  ].join("\n");
}

/**
 * Parse a model's answer into findings.
 *
 * Tolerant in the ways models actually fail: fences around the JSON, prose
 * before it, a bare array instead of the wrapping object, a `line` sent as a
 * string. Strict in the way that matters: an entry with no path or no title is
 * dropped, because a diagnostic that cannot be placed or read is noise wearing
 * a severity.
 *
 * @returns `undefined` when the answer contains no JSON at all — which the
 *   caller reports as "the review did not produce findings", distinct from a
 *   clean empty list.
 */
export function parseFindings(answer: string): ReviewFinding[] | undefined {
  const parsed = firstJson(answer);
  if (parsed === undefined) return undefined;
  const raw = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : undefined;
  if (raw === undefined) return undefined;

  const findings: ReviewFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const path = normalizePath(record.path);
    const title = textOf(record.title) ?? textOf(record.summary) ?? textOf(record.message);
    if (path === undefined || title === undefined) continue;
    const line = lineOf(record.line);
    findings.push({
      path,
      ...(line === undefined ? {} : { line }),
      severity: severityOf(record.severity),
      title,
      detail: textOf(record.detail) ?? textOf(record.description) ?? "",
    });
  }
  return findings;
}

/** The first JSON value in a string, fences and prose tolerated. */
function firstJson(answer: string): unknown {
  const stripped = answer.replace(/```(?:json)?/g, "");
  // Whichever bracket opens first is the document's shape. Trying "{" before
  // "[" unconditionally would, for a bare array of objects, land on the first
  // object *inside* it and parse one finding's fields as the whole answer.
  const brace = stripped.indexOf("{");
  const bracket = stripped.indexOf("[");
  const start = brace < 0 ? bracket : bracket < 0 ? brace : Math.min(brace, bracket);
  if (start < 0) return undefined;
  const closer = stripped[start] === "{" ? "}" : "]";
  // Progressively shorter suffixes from the last closer, because prose after
  // the JSON is common and JSON.parse wants exactness.
  for (
    let end = stripped.lastIndexOf(closer);
    end > start;
    end = stripped.lastIndexOf(closer, end - 1)
  ) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      // keep narrowing
    }
  }
  return undefined;
}

/** Strip diff prefixes and normalize separators; refuse an empty result. */
function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value
    .trim()
    .replace(/^[ab]\//, "")
    .replace(/\\/g, "/");
  return path === "" ? undefined : path;
}

/** A non-empty string, trimmed. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** A usable 1-based line number, from a number or a numeric string. */
function lineOf(value: unknown): number | undefined {
  const line =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(line)) return undefined;
  const whole = Math.floor(line);
  return whole >= 1 ? whole : undefined;
}

/** Clamp an unknown severity to the scale rather than dropping the finding. */
function severityOf(value: unknown): FindingSeverity {
  if (value === "error" || value === "warning" || value === "info") return value;
  // A finding whose severity the model fumbled is still a finding. `warning`
  // is the honest middle: not silently promoted to error, not buried as info.
  return "warning";
}

/** One line for the notification after a review. */
export function reviewSummary(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return "Review complete: no issues found.";
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const count = `${findings.length} ${findings.length === 1 ? "finding" : "findings"}`;
  return errors > 0
    ? `Review complete: ${count}, ${errors} ${errors === 1 ? "error" : "errors"}.`
    : `Review complete: ${count}.`;
}
