import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, PermissionDecision, PermissionRule } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import {
  defaultCaseInsensitivePaths,
  defaultSubject,
  globToRegExp,
  isPathLike,
  matchRules,
  matchSpecifier,
  PermissionEngine,
} from "./permissions.js";

const allow = async (): Promise<PermissionDecision> => ({ requestId: "", behavior: "allow" });
const deny = (message?: string): PermissionDecision => ({
  requestId: "",
  behavior: "deny",
  ...(message === undefined ? {} : { message }),
});

function check(engine: PermissionEngine, toolName: string, subject = "", toolCallId = "call1") {
  return engine.check({ toolName, toolCallId, subject });
}

describe("matchSpecifier", () => {
  it("matches everything for a missing or star specifier", () => {
    expect(matchSpecifier(undefined, "anything")).toBe(true);
    expect(matchSpecifier("*", "anything")).toBe(true);
  });

  it("matches command prefixes", () => {
    expect(matchSpecifier("git *", "git status")).toBe(true);
    expect(matchSpecifier("git *", "git")).toBe(true);
    expect(matchSpecifier("git *", "github-cli x")).toBe(false);
    expect(matchSpecifier("git *", "rm -rf /")).toBe(false);
  });

  it("matches exact strings", () => {
    expect(matchSpecifier("npm test", "npm test")).toBe(true);
    expect(matchSpecifier("npm test", "npm test -w core")).toBe(false);
  });

  it("matches path globs", () => {
    expect(matchSpecifier("src/*.ts", "src/agent.ts")).toBe(true);
    expect(matchSpecifier("src/*.ts", "src/nested/agent.ts")).toBe(false);
    expect(matchSpecifier("src/**", "src/nested/agent.ts")).toBe(true);
    expect(matchSpecifier("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(matchSpecifier("src/**/*.ts", "src/c.ts")).toBe(true);
    expect(matchSpecifier("?.ts", "a.ts")).toBe(true);
  });

  it("escapes regex metacharacters in globs", () => {
    expect(globToRegExp("a.b*").test("a.bc")).toBe(true);
    expect(globToRegExp("a.b*").test("axbc")).toBe(false);
  });
});

describe("matchRules", () => {
  const rules: PermissionRule[] = [
    { tool: "*", specifier: "*", action: "deny", scope: "user" },
    { tool: "bash", specifier: "git *", action: "allow", scope: "project" },
    { tool: "bash", specifier: "git push *", action: "deny", scope: "project" },
  ];

  it("prefers the more specific rule within a scope", () => {
    expect(matchRules(rules, "bash", "git push origin")?.action).toBe("deny");
    expect(matchRules(rules, "bash", "git status")?.action).toBe("allow");
  });

  it("prefers a nearer scope over a broader one", () => {
    const scoped: PermissionRule[] = [
      { tool: "bash", action: "deny", scope: "user" },
      { tool: "bash", action: "allow", scope: "session" },
    ];
    expect(matchRules(scoped, "bash", "ls")?.action).toBe("allow");
  });

  it("lets a deny win a tie of equal specificity and scope", () => {
    const tied: PermissionRule[] = [
      { tool: "bash", specifier: "ls", action: "allow", scope: "project" },
      { tool: "bash", specifier: "ls", action: "deny", scope: "project" },
    ];
    expect(matchRules(tied, "bash", "ls")?.action).toBe("deny");
  });

  it("falls back to a wildcard rule for unrelated tools", () => {
    expect(matchRules(rules, "write", "src/x.ts")?.action).toBe("deny");
  });

  it("returns undefined when nothing matches", () => {
    const narrow: PermissionRule[] = [
      { tool: "bash", specifier: "git *", action: "allow", scope: "project" },
    ];
    expect(matchRules(narrow, "write", "src/x.ts")).toBeUndefined();
    expect(matchRules(narrow, "bash", "npm test")).toBeUndefined();
  });
});

describe("PermissionEngine", () => {
  it("evaluates to ask when no rule matches", () => {
    expect(new PermissionEngine().evaluate("bash", "ls")).toBe("ask");
  });

  it("allows via a matching rule without prompting", async () => {
    const requester = vi.fn(allow);
    const engine = new PermissionEngine({
      rules: [{ tool: "bash", specifier: "git *", action: "allow", scope: "project" }],
      requester,
    });
    const decision = await check(engine, "bash", "git status");
    expect(decision.behavior).toBe("allow");
    expect(requester).not.toHaveBeenCalled();
  });

  it("denies via a matching rule without prompting", async () => {
    const requester = vi.fn(allow);
    const engine = new PermissionEngine({
      rules: [{ tool: "bash", specifier: "rm *", action: "deny", scope: "user" }],
      requester,
    });
    const decision = await check(engine, "bash", "rm -rf /");
    expect(decision.behavior).toBe("deny");
    expect(requester).not.toHaveBeenCalled();
  });

  it("asks when nothing matches and honours the answer", async () => {
    const requester = vi.fn(async () => deny("not today"));
    const engine = new PermissionEngine({ requester });
    const decision = await check(engine, "bash", "curl evil.example");
    expect(requester).toHaveBeenCalledTimes(1);
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toBe("not today");
  });

  it("denies unmatched checks when no requester is configured", async () => {
    const decision = await check(new PermissionEngine(), "bash", "ls");
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("no permission requester");
  });

  it("allows read-only tools by default", async () => {
    const requester = vi.fn(allow);
    const engine = new PermissionEngine({ requester });
    for (const tool of ["read", "grep", "glob", "ls", "fetch"]) {
      expect((await check(engine, tool, "/x")).behavior).toBe("allow");
    }
    expect(requester).not.toHaveBeenCalled();
  });

  it("still honours a deny rule against a read-only tool", async () => {
    const engine = new PermissionEngine({
      rules: [{ tool: "read", specifier: "/etc/**", action: "deny", scope: "user" }],
      requester: allow,
    });
    expect((await check(engine, "read", "/etc/shadow")).behavior).toBe("deny");
    expect((await check(engine, "read", "/src/a.ts", "call2")).behavior).toBe("allow");
  });

  describe("modes", () => {
    it("yolo allows everything unmatched", async () => {
      const requester = vi.fn(allow);
      const engine = new PermissionEngine({ mode: "yolo", requester });
      expect((await check(engine, "bash", "rm -rf /")).behavior).toBe("allow");
      expect(requester).not.toHaveBeenCalled();
    });

    it("yolo still respects an explicit deny rule", async () => {
      const engine = new PermissionEngine({
        mode: "yolo",
        rules: [{ tool: "bash", specifier: "rm *", action: "deny", scope: "session" }],
      });
      expect((await check(engine, "bash", "rm -rf /")).behavior).toBe("deny");
    });

    it("acceptEdits auto-allows write and edit but not bash", async () => {
      const requester = vi.fn(async () => deny());
      const engine = new PermissionEngine({ mode: "acceptEdits", requester });
      expect((await check(engine, "write", "src/a.ts")).behavior).toBe("allow");
      expect((await check(engine, "edit", "src/a.ts", "c2")).behavior).toBe("allow");
      expect((await check(engine, "bash", "ls", "c3")).behavior).toBe("deny");
      expect(requester).toHaveBeenCalledTimes(1);
    });

    it("plan denies mutating tools and allows read-only ones", async () => {
      const engine = new PermissionEngine({ mode: "plan", requester: allow });
      const denied = await check(engine, "write", "src/a.ts");
      expect(denied.behavior).toBe("deny");
      expect(denied.message).toContain("Plan mode");
      expect((await check(engine, "read", "src/a.ts", "c2")).behavior).toBe("allow");
    });

    it("plan overrides an allow rule for a mutating tool", async () => {
      const engine = new PermissionEngine({
        mode: "plan",
        rules: [{ tool: "write", action: "allow", scope: "session" }],
      });
      expect((await check(engine, "write", "src/a.ts")).behavior).toBe("deny");
    });
  });

  it("persists rules from a decision and reuses them", async () => {
    const persisted: PermissionRule[] = [];
    const requester = vi.fn(async () => ({
      requestId: "",
      behavior: "allow" as const,
      persistRule: { tool: "bash", specifier: "git *", action: "allow", scope: "session" } as const,
    }));
    const engine = new PermissionEngine({
      requester,
      onPersistRule: (r) => void persisted.push(r),
    });

    expect((await check(engine, "bash", "git status", "c1")).behavior).toBe("allow");
    expect(persisted).toHaveLength(1);
    expect((await check(engine, "bash", "git diff", "c2")).behavior).toBe("allow");
    expect(requester).toHaveBeenCalledTimes(1);
    expect(engine.rules).toHaveLength(1);
  });

  it("emits request and decision events", async () => {
    const events: AgentEvent[] = [];
    const engine = new PermissionEngine({ requester: allow, onEvent: (e) => events.push(e) });
    await check(engine, "bash", "ls");
    expect(events.map((e) => e.type)).toEqual(["permissionRequest", "permissionDecision"]);
    const [request, decision] = events;
    if (request?.type !== "permissionRequest" || decision?.type !== "permissionDecision") {
      throw new Error("unexpected events");
    }
    expect(request.request.subject).toBe("ls");
    expect(decision.decision.requestId).toBe(request.request.id);
  });

  it("passes state tools through silently", async () => {
    const events: AgentEvent[] = [];
    const engine = new PermissionEngine({ mode: "plan", onEvent: (e) => events.push(e) });
    expect((await check(engine, "todo", "")).behavior).toBe("allow");
    expect((await check(engine, "plan", "")).behavior).toBe("allow");
    expect(events).toHaveLength(0);
  });

  it("caches a decision for the duration of one tool call", async () => {
    const requester = vi.fn(allow);
    const engine = new PermissionEngine({ requester });
    await check(engine, "bash", "ls", "call1");
    await check(engine, "bash", "ls", "call1");
    expect(requester).toHaveBeenCalledTimes(1);

    engine.clearCallCache("call1");
    await check(engine, "bash", "ls", "call1");
    expect(requester).toHaveBeenCalledTimes(2);
  });

  it("ask() bypasses rules so plan approval cannot be pre-approved", async () => {
    const requester = vi.fn(async () => deny("revise it"));
    const engine = new PermissionEngine({
      mode: "yolo",
      rules: [{ tool: "*", action: "allow", scope: "session" }],
      requester,
    });
    const decision = await engine.ask({
      toolName: "plan",
      toolCallId: "c1",
      subject: "exitPlanMode",
      description: "approve?",
    });
    expect(requester).toHaveBeenCalledTimes(1);
    expect(decision.behavior).toBe("deny");
  });

  it("switches mode at runtime", () => {
    const engine = new PermissionEngine();
    expect(engine.mode).toBe("default");
    engine.setMode("plan");
    expect(engine.mode).toBe("plan");
  });
});

describe("path comparison policy", () => {
  it("tells a path from a command line or a URL", () => {
    for (const value of [
      "**/.env",
      "/repo/src/app.ts",
      "C:\\repo\\.env",
      "src/*.ts",
      "\\\\srv\\s",
    ]) {
      expect(isPathLike(value), value).toBe(true);
    }
    // A command has arguments; a URL has a scheme; neither is compared the
    // way a filesystem compares two names.
    for (const value of ["", "git status", "rm -rf /", "npm", "https://example.com/a/b"]) {
      expect(isPathLike(value), value).toBe(false);
    }
  });

  it("treats `/` and `\\` as the same separator in a glob", () => {
    // `**/` has to match a Windows path, or the documented `**/.env` deny
    // protects nothing on Windows.
    expect(globToRegExp("**/.env").test("C:\\repo\\.env")).toBe(true);
    expect(globToRegExp("**/.env").test("/repo/.env")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src\\a.ts")).toBe(true);
    // ...and `*` has to stop at one, or a single-directory grant becomes a
    // grant over the whole subtree.
    expect(globToRegExp("C:\\repo\\*").test("C:\\repo\\notes.md")).toBe(true);
    expect(globToRegExp("C:\\repo\\*").test("C:\\repo\\deep\\notes.md")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src\\deep\\a.ts")).toBe(false);
  });

  it("compiles case-insensitively only when asked", () => {
    expect(globToRegExp("**/*.ts").test("/repo/A.TS")).toBe(false);
    expect(globToRegExp("**/*.ts", { caseInsensitive: true }).test("/repo/A.TS")).toBe(true);
  });

  it("folds case for paths and never for commands", () => {
    const insensitive = { caseInsensitivePaths: true } as const;
    expect(matchSpecifier("**/.env", "/repo/.ENV", insensitive)).toBe(true);
    expect(matchSpecifier("/repo/notes.md", "/REPO/Notes.MD", insensitive)).toBe(true);
    // argv is case-sensitive on every platform, `cmd.exe` included, so a
    // command specifier stays byte-exact whatever the filesystem does.
    expect(matchSpecifier("npm test", "NPM TEST", insensitive)).toBe(false);
    expect(matchSpecifier("git *", "GIT status", insensitive)).toBe(false);
  });

  it("keeps case significant where the filesystem keeps it", () => {
    const sensitive = { caseInsensitivePaths: false } as const;
    expect(matchSpecifier("**/.env", "/repo/.env", sensitive)).toBe(true);
    expect(matchSpecifier("**/.env", "/repo/.ENV", sensitive)).toBe(false);
    expect(matchSpecifier("/repo/notes.md", "/REPO/notes.md", sensitive)).toBe(false);
  });

  it("matches an exact path rule across separators", () => {
    // `path.resolve` hands the engine backslashes on Windows; a rule typed
    // with forward slashes still names that file.
    expect(matchSpecifier("C:/repo/.env", "C:\\repo\\.env")).toBe(true);
    expect(matchSpecifier("C:\\repo\\.env", "C:/repo/.env")).toBe(true);
  });

  it("honours a forced subject kind", () => {
    const insensitive = { caseInsensitivePaths: true } as const;
    expect(matchSpecifier("/repo/a.md", "/REPO/a.md", { ...insensitive, kind: "text" })).toBe(
      false,
    );
    expect(matchSpecifier("deploy", "DEPLOY", { ...insensitive, kind: "path" })).toBe(true);
  });

  it("decides the default from the filesystem, not from process.platform", () => {
    const probe = mkdtempSync(join(tmpdir(), "arcturn-case-"));
    try {
      mkdirSync(join(probe, "Aa"));
      let insensitive: boolean;
      try {
        insensitive = statSync(join(probe, "aA")).isDirectory();
      } catch {
        insensitive = false;
      }
      expect(defaultCaseInsensitivePaths()).toBe(insensitive);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });

  it("lets an engine override the case policy", () => {
    const rules: PermissionRule[] = [
      { tool: "write", specifier: "**/.env", action: "deny", scope: "user" },
    ];
    expect(
      new PermissionEngine({ rules, caseInsensitivePaths: true }).evaluate("write", "/repo/.ENV"),
    ).toBe("deny");
    expect(
      new PermissionEngine({ rules, caseInsensitivePaths: false }).evaluate("write", "/repo/.ENV"),
    ).toBe("ask");
  });
});

describe("defaultSubject", () => {
  it("prefers well-known argument names", () => {
    expect(defaultSubject("bash", { command: "ls -la" })).toBe("ls -la");
    expect(defaultSubject("write", { file_path: "/a.ts", content: "x" })).toBe("/a.ts");
    expect(defaultSubject("fetch", { url: "https://x.dev" })).toBe("https://x.dev");
  });

  it("falls back to an empty subject", () => {
    expect(defaultSubject("weird", { foo: 1 })).toBe("");
  });
});
