/**
 * Append-only audit log: every tool call, permission decision, and hook
 * verdict, per session — the enterprise/trust trail.
 *
 * The on-disk format mirrors {@link @arcturn/core#JsonlSessionStore}: one
 * JSON object per line, writes serialized through a single promise queue so
 * concurrent `record()` calls never interleave their bytes, and the backing
 * directory is created lazily on first write. Unlike a session file there is
 * no header line — every {@link AuditEntry} already carries its own `kind`
 * and `ts`, so the file is self-describing from the first line.
 *
 * Three pieces turn a live run into entries:
 * - {@link auditObserver} maps the `AgentEvent` stream into `"tool"` and
 *   `"permission"` entries (a completed tool call; a decision the user was
 *   actually asked to make).
 * - {@link auditedHookRunner} wraps a `HookRunner` so every hook verdict
 *   (`preToolUse`, `postToolUse`, `sessionStart`, `runEnd`) is recorded as it
 *   is decided, without touching `hooks.ts`.
 * - {@link renderAudit} turns a read-back entry list into the lines `arcturn
 *   audit <sessionId>` prints.
 *
 * See `INTEGRATION-audit.md` at the repo root for how these wire into
 * `runtime.ts`, `paths.ts` and `args.ts`.
 *
 * @packageDocumentation
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultSubject } from "@arcturn/core";
import type { AgentEvent, AgentEventListener, PermissionRequest } from "@arcturn/types";
import type { HookEvent, HookRunner } from "./hooks.js";
import { type ArcturnPaths, cwdHash } from "./paths.js";

/** One completed tool call. */
export interface AuditToolEntry {
  kind: "tool";
  /** Epoch milliseconds, injected by the caller — never `Date.now()` here. */
  ts: number;
  toolName: string;
  /** Best-effort subject (command, path, url, ...), omitted when unknown. */
  subject?: string;
  /** `false` when the tool result was an error. */
  ok: boolean;
}

/**
 * `"allow"`/`"deny"` are reserved for a rule- or mode-resolved decision (no
 * human involved); `"ask-allow"`/`"ask-deny"` are what {@link auditObserver}
 * actually emits today, since only the interactive-ask path carries a
 * `toolName` and `subject` on the `AgentEvent` stream — see the module doc
 * in `permissions.ts` for why `permissionRequest` fires only at that step.
 */
export type AuditPermissionDecision = "allow" | "deny" | "ask-allow" | "ask-deny";

/** One permission decision — the human-in-the-loop trust trail. */
export interface AuditPermissionEntry {
  kind: "permission";
  ts: number;
  toolName: string;
  subject?: string;
  decision: AuditPermissionDecision;
}

/** One hook verdict (`preToolUse`, `postToolUse`, `sessionStart`, `runEnd`). */
export interface AuditHookEntry {
  kind: "hook";
  ts: number;
  event: HookEvent;
  decision: "allow" | "deny";
  reason?: string;
}

/** One line of the audit log. */
export type AuditEntry = AuditToolEntry | AuditPermissionEntry | AuditHookEntry;

/** An append-only, per-session audit log. */
export interface AuditLog {
  /**
   * Append one entry. Writes are serialized through an internal queue so
   * concurrent callers never produce an interleaved or torn line.
   */
  record(entry: AuditEntry): Promise<void>;
  /**
   * Every entry, in append order. A file that does not exist yet reads back
   * as `[]` rather than throwing — an audit log with nothing recorded is not
   * an error.
   */
  read(): Promise<AuditEntry[]>;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Best-effort JSON parse; `undefined` on any failure rather than throwing. */
function tryParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Open (or create, on first write) an append-only audit log backed by one
 * JSONL file.
 *
 * Mirrors {@link @arcturn/core#JsonlSessionStore.append}'s write-queue
 * pattern: each `record()` chains onto the previous write via a single
 * promise, so two concurrent callers still produce two whole, newline-
 * terminated lines rather than a corrupted interleaving. The directory is
 * created (`recursive: true`) lazily, on the first `record()`, not eagerly
 * at construction — a log nobody writes to never touches disk.
 *
 * @param file - Absolute path to the `.jsonl` file. Typically one per
 *   session, e.g. {@link auditFilePath}.
 */
export function createAuditLog(file: string): AuditLog {
  let writeQueue: Promise<void> = Promise.resolve();
  let dirReady: Promise<void> | undefined;

  async function ensureDir(): Promise<void> {
    dirReady ??= mkdir(dirname(file), { recursive: true }).then(() => undefined);
    await dirReady;
  }

  return {
    async record(entry: AuditEntry): Promise<void> {
      const next = writeQueue
        .catch(() => undefined)
        .then(async () => {
          await ensureDir();
          await appendFile(file, `${JSON.stringify(entry)}\n`);
        });
      writeQueue = next;
      await next;
    },

    async read(): Promise<AuditEntry[]> {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      const entries: AuditEntry[] = [];
      for (const [index, line] of lines.entries()) {
        // Mirror JsonlSessionStore: only the last line can be a torn write
        // from a crash mid-append, so only it is forgiven a parse failure.
        if (index === lines.length - 1) {
          const parsed = tryParseJson<AuditEntry>(line);
          if (parsed !== undefined) entries.push(parsed);
          continue;
        }
        entries.push(JSON.parse(line) as AuditEntry);
      }
      return entries;
    },
  };
}

/**
 * Per-session audit file path, mirroring {@link ArcturnPaths.sessions}'s
 * `<home>/sessions/<cwdHash>/` bucketing:
 * `<home>/audit/<cwdHash(cwd)>/<sessionId>.jsonl`.
 *
 * Kept as a standalone helper rather than a new `ArcturnPaths` field, since this
 * package's audit work adds only new files — see `INTEGRATION-audit.md` for
 * the `paths.ts` field this would become in a real wire-up.
 *
 * @param paths - The `home`/`cwd` a full {@link ArcturnPaths} already carries.
 * @param sessionId - Session the log belongs to.
 */
export function auditFilePath(
  paths: Pick<ArcturnPaths, "home" | "cwd">,
  sessionId: string,
): string {
  return join(paths.home, "audit", cwdHash(paths.cwd), `${sessionId}.jsonl`);
}

/**
 * Build an `AgentEvent` listener that records `"tool"` and `"permission"`
 * entries as a run proceeds.
 *
 * Pure mapping over the event stream plus two small correlation maps (a
 * `toolStart` is held until its matching `toolEnd`; a `permissionRequest` is
 * held until its matching `permissionDecision`) — never calls `Date.now()`
 * except through the injected `now`, so a test can drive it with a fake
 * clock and assert exactly what gets written.
 *
 * A `permissionDecision` with no matching `permissionRequest` was resolved
 * by a rule or the permission mode without ever asking a human — the engine
 * only emits `permissionRequest` at that step (see `permissions.ts`'s module
 * doc), so there is no `toolName`/`subject` to attribute it to here, and it
 * is intentionally not recorded as a `"permission"` entry. The tool call
 * itself is still captured via its `toolEnd`.
 *
 * @param log - Destination audit log.
 * @param now - Clock used to timestamp entries. Defaults to `Date.now`.
 */
export function auditObserver(log: AuditLog, now: () => number = Date.now): AgentEventListener {
  const pendingTools = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  const pendingRequests = new Map<string, PermissionRequest>();

  const observe = (event: AgentEvent): void => {
    // `subagentEvent` is deliberately NOT unwrapped here: the runtime
    // subscribes each sub-agent's own stream directly (see
    // ArcturnRuntime.createSubagent), which also covers children built outside a
    // tool call. Unwrapping as well would record every delegated call twice.
    switch (event.type) {
      case "toolStart": {
        pendingTools.set(event.toolCallId, { toolName: event.toolName, input: event.input });
        return;
      }
      case "toolEnd": {
        const pending = pendingTools.get(event.toolCallId);
        pendingTools.delete(event.toolCallId);
        const toolName = pending?.toolName ?? event.result.toolName;
        const subject = pending ? defaultSubject(toolName, pending.input) : "";
        const entry: AuditToolEntry = {
          kind: "tool",
          ts: now(),
          toolName,
          ok: !event.result.isError,
          ...(subject === "" ? {} : { subject }),
        };
        void log.record(entry).catch(() => undefined);
        return;
      }
      case "permissionRequest": {
        pendingRequests.set(event.request.id, event.request);
        return;
      }
      case "permissionDecision": {
        const request = pendingRequests.get(event.decision.requestId);
        pendingRequests.delete(event.decision.requestId);
        if (!request) return;
        const entry: AuditPermissionEntry = {
          kind: "permission",
          ts: now(),
          toolName: request.toolName,
          ...(request.subject === "" ? {} : { subject: request.subject }),
          decision: event.decision.behavior === "allow" ? "ask-allow" : "ask-deny",
        };
        void log.record(entry).catch(() => undefined);
        return;
      }
      default:
        return;
    }
  };

  return observe;
}

/**
 * Wrap a {@link HookRunner} so every verdict it produces is recorded as a
 * `"hook"` {@link AuditEntry}, without changing its behaviour.
 *
 * This is the integration point for hook auditing: `wrapToolsWithHooks`
 * (in `hooks.ts`, not edited by this package) only ever calls
 * `runner.run(...)`, so wrapping the `HookRunner` handed to it — and to the
 * `sessionStart`/`runEnd` calls `runtime.ts` makes directly — captures every
 * `preToolUse`, `postToolUse`, `sessionStart` and `runEnd` verdict from one
 * place.
 *
 * @param runner - The real runner to delegate to.
 * @param log - Destination audit log.
 * @param now - Clock used to timestamp entries. Defaults to `Date.now`.
 */
export function auditedHookRunner(
  runner: HookRunner,
  log: AuditLog,
  now: () => number = Date.now,
): HookRunner {
  return {
    async run(event, payload) {
      const result = await runner.run(event, payload);
      const entry: AuditHookEntry = {
        kind: "hook",
        ts: now(),
        event,
        decision: result.decision,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
      void log.record(entry).catch(() => undefined);
      return result;
    },
  };
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Format a timestamp as `HH:MM:SS`, in UTC so output is machine-independent. */
function formatTime(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function renderEntry(entry: AuditEntry): string {
  const time = formatTime(entry.ts);
  switch (entry.kind) {
    case "tool": {
      const subject = entry.subject ? `  ${entry.subject}` : "";
      const mark = entry.ok ? "✓" : "✗";
      return `${time}  tool  ${entry.toolName}${subject}  ${mark}`;
    }
    case "permission": {
      const subject = entry.subject ? `  ${entry.subject}` : "";
      return `${time}  perm  ${entry.toolName}${subject}  ${entry.decision}`;
    }
    case "hook": {
      const reason = entry.reason ? `: ${entry.reason}` : "";
      return `${time}  hook  ${entry.event}  ${entry.decision}${reason}`;
    }
  }
}

function isDenied(entry: AuditEntry): boolean {
  return (
    entry.kind === "permission" && (entry.decision === "deny" || entry.decision === "ask-deny")
  );
}

/**
 * Render a session's audit entries as human-readable lines, e.g.
 * `"14:03:12  tool  bash  git status  ✓"`, followed by a blank line and a
 * summary tally.
 *
 * @param entries - Entries in append order, typically from
 *   {@link AuditLog.read}.
 * @returns One line per entry, then a blank line, then the tally line.
 */
export function renderAudit(entries: readonly AuditEntry[]): string[] {
  const lines = entries.map(renderEntry);

  const toolCalls = entries.filter((entry) => entry.kind === "tool").length;
  const denied = entries.filter(isDenied).length;
  const hookVetoes = entries.filter(
    (entry) => entry.kind === "hook" && entry.decision === "deny",
  ).length;

  lines.push("");
  lines.push(
    `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, ${denied} denied, ` +
      `${hookVetoes} hook veto${hookVetoes === 1 ? "" : "es"}`,
  );
  return lines;
}
