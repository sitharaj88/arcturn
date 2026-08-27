import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AuditEntry,
  auditedHookRunner,
  auditFilePath,
  auditObserver,
  createAuditLog,
  renderAudit,
} from "./audit.js";
import type { HookRunner, HookRunResult } from "./hooks.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcturn-audit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("createAuditLog", () => {
  it("round-trips entries through a temp file", async () => {
    const file = join(dir, "nested", "session.jsonl");
    const log = createAuditLog(file);

    const toolEntry: AuditEntry = {
      kind: "tool",
      ts: 1000,
      toolName: "bash",
      subject: "git status",
      ok: true,
    };
    const permEntry: AuditEntry = {
      kind: "permission",
      ts: 2000,
      toolName: "bash",
      subject: "git push",
      decision: "ask-deny",
    };

    await log.record(toolEntry);
    await log.record(permEntry);

    expect(await log.read()).toEqual([toolEntry, permEntry]);
  });

  it("creates the backing directory on demand, not eagerly", async () => {
    const file = join(dir, "does", "not", "exist", "yet", "s1.jsonl");
    const log = createAuditLog(file);
    // Reading before any write must not create the directory or throw.
    expect(await log.read()).toEqual([]);

    await log.record({ kind: "tool", ts: 1, toolName: "read", ok: true });
    const raw = await readFile(file, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("reads back an empty array for a file that was never written", async () => {
    const log = createAuditLog(join(dir, "missing.jsonl"));
    expect(await log.read()).toEqual([]);
  });

  it("tolerates a torn final line but not an earlier one", async () => {
    const file = join(dir, "torn.jsonl");
    const log = createAuditLog(file);
    await log.record({ kind: "tool", ts: 1, toolName: "read", ok: true });
    await log.record({ kind: "tool", ts: 2, toolName: "write", ok: true });

    // Simulate a crash mid-append: truncate the trailing bytes of the last line.
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const torn = `${lines[0]}\n${lines[1]!.slice(0, 10)}`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, torn);

    const entries = await log.read();
    expect(entries).toEqual([{ kind: "tool", ts: 1, toolName: "read", ok: true }]);
  });

  it("serializes concurrent appends so lines never interleave", async () => {
    const file = join(dir, "concurrent.jsonl");
    const log = createAuditLog(file);

    const count = 50;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        log.record({ kind: "tool", ts: index, toolName: `tool-${index}`, ok: index % 2 === 0 }),
      ),
    );

    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(count);
    // Every line must be independently valid JSON — proof nothing interleaved.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const entries = await log.read();
    expect(entries).toHaveLength(count);
    expect(new Set(entries.map((e) => (e as { toolName: string }).toolName)).size).toBe(count);
  });
});

describe("auditFilePath", () => {
  it("buckets by a hash of cwd under <home>/audit, mirroring sessions", () => {
    const a = auditFilePath({ home: "/h", cwd: "/work/repo" }, "sess-1");
    const b = auditFilePath({ home: "/h", cwd: "/work/other" }, "sess-1");
    expect(a).toContain(join("/h", "audit"));
    expect(a.endsWith("sess-1.jsonl")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("is stable for the same home/cwd/sessionId", () => {
    const first = auditFilePath({ home: "/h", cwd: "/w" }, "s1");
    const second = auditFilePath({ home: "/h", cwd: "/w" }, "s1");
    expect(first).toBe(second);
  });
});

describe("renderAudit", () => {
  it("formats each entry kind and tallies the summary", () => {
    const entries: AuditEntry[] = [
      {
        kind: "tool",
        ts: Date.UTC(2026, 0, 1, 14, 3, 12),
        toolName: "bash",
        subject: "git status",
        ok: true,
      },
      { kind: "tool", ts: Date.UTC(2026, 0, 1, 14, 3, 13), toolName: "write", ok: false },
      {
        kind: "permission",
        ts: Date.UTC(2026, 0, 1, 14, 3, 14),
        toolName: "bash",
        subject: "rm -rf /",
        decision: "ask-deny",
      },
      {
        kind: "hook",
        ts: Date.UTC(2026, 0, 1, 14, 3, 15),
        event: "preToolUse",
        decision: "deny",
        reason: "blocked",
      },
    ];

    const lines = renderAudit(entries);

    expect(lines[0]).toBe("14:03:12  tool  bash  git status  ✓");
    expect(lines[1]).toBe("14:03:13  tool  write  ✗");
    expect(lines[2]).toBe("14:03:14  perm  bash  rm -rf /  ask-deny");
    expect(lines[3]).toBe("14:03:15  hook  preToolUse  deny: blocked");
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe("2 tool calls, 1 denied, 1 hook veto");
  });

  it("pluralizes singular tallies correctly", () => {
    const entries: AuditEntry[] = [{ kind: "tool", ts: 0, toolName: "read", ok: true }];
    const lines = renderAudit(entries);
    expect(lines.at(-1)).toBe("1 tool call, 0 denied, 0 hook vetoes");
  });

  it("returns just the tally lines for an empty log", () => {
    expect(renderAudit([])).toEqual(["", "0 tool calls, 0 denied, 0 hook vetoes"]);
  });
});

describe("auditObserver", () => {
  function recordingLog() {
    const entries: AuditEntry[] = [];
    return {
      entries,
      log: {
        async record(entry: AuditEntry) {
          entries.push(entry);
        },
        async read() {
          return entries;
        },
      },
    };
  }

  it("maps a toolStart/toolEnd pair into a tool entry with a derived subject", () => {
    const { entries, log } = recordingLog();
    const observe = auditObserver(log, () => 42);

    observe({
      type: "toolStart",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "git status" },
    });
    observe({
      type: "toolEnd",
      toolCallId: "call-1",
      result: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [],
        isError: false,
        timestamp: 42,
      },
    });

    expect(entries).toEqual([
      { kind: "tool", ts: 42, toolName: "bash", subject: "git status", ok: true },
    ]);
  });

  it("marks a tool entry not-ok when the result was an error, without a subject when input is unknown", () => {
    const { entries, log } = recordingLog();
    const observe = auditObserver(log, () => 7);

    // No matching toolStart: toolEnd alone still records, using the result's toolName.
    observe({
      type: "toolEnd",
      toolCallId: "call-2",
      result: {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "write",
        content: [],
        isError: true,
        timestamp: 7,
      },
    });

    expect(entries).toEqual([{ kind: "tool", ts: 7, toolName: "write", ok: false }]);
  });

  it("maps a permissionRequest/permissionDecision pair into an ask-allow or ask-deny entry", () => {
    const { entries, log } = recordingLog();
    const observe = auditObserver(log, () => 99);

    observe({
      type: "permissionRequest",
      request: {
        id: "perm-1",
        toolName: "bash",
        toolCallId: "call-3",
        subject: "rm -rf /",
        description: "Run bash: rm -rf /",
      },
    });
    observe({
      type: "permissionDecision",
      decision: { requestId: "perm-1", behavior: "deny", message: "no" },
    });

    expect(entries).toEqual([
      { kind: "permission", ts: 99, toolName: "bash", subject: "rm -rf /", decision: "ask-deny" },
    ]);
  });

  it("does not record a permissionDecision that was never preceded by a request (rule/mode auto-resolved)", () => {
    const { entries, log } = recordingLog();
    const observe = auditObserver(log, () => 1);

    observe({
      type: "permissionDecision",
      decision: { requestId: "perm-unknown", behavior: "allow" },
    });

    expect(entries).toEqual([]);
  });

  it("ignores unrelated event types", () => {
    const { entries, log } = recordingLog();
    const observe = auditObserver(log, () => 1);
    const events: AgentEvent[] = [
      { type: "turnStart", turnIndex: 0 },
      { type: "notice", level: "info", text: "hi" },
    ];
    for (const event of events) observe(event);
    expect(entries).toEqual([]);
  });
});

describe("auditedHookRunner", () => {
  function recordingLog() {
    const entries: AuditEntry[] = [];
    return {
      entries,
      log: {
        async record(entry: AuditEntry) {
          entries.push(entry);
        },
        async read() {
          return entries;
        },
      },
    };
  }

  it("records the underlying runner's verdict and returns it unchanged", async () => {
    const { entries, log } = recordingLog();
    const result: HookRunResult = { decision: "deny", reason: "blocked by policy", warnings: [] };
    const inner: HookRunner = {
      async run() {
        return result;
      },
    };

    const wrapped = auditedHookRunner(inner, log, () => 5);
    const outcome = await wrapped.run("preToolUse", { toolName: "bash" });

    expect(outcome).toBe(result);
    expect(entries).toEqual([
      { kind: "hook", ts: 5, event: "preToolUse", decision: "deny", reason: "blocked by policy" },
    ]);
  });

  it("omits reason on an allow verdict", async () => {
    const { entries, log } = recordingLog();
    const inner: HookRunner = {
      async run() {
        return { decision: "allow", warnings: [] };
      },
    };

    const wrapped = auditedHookRunner(inner, log, () => 9);
    await wrapped.run("sessionStart");

    expect(entries).toEqual([{ kind: "hook", ts: 9, event: "sessionStart", decision: "allow" }]);
  });
});
