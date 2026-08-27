/**
 * The symlink door in front of the read-only tools, closed and pinned shut.
 *
 * `read`/`grep`/`glob`/`ls` are in `DEFAULT_READ_ONLY_TOOLS`: they never call
 * `requestPermission`, so a stored `deny` rule — matched by `loop.ts` against
 * the subject it derives from the call's arguments — is the *only* wall in
 * front of them. That subject used to be spelled lexically, so an ordinary
 * symlink inside the workspace walked straight around it: `deny read
 * <secrets>/**` refused `read("<secrets>/id_rsa")` and allowed
 * `read("keys/id_rsa")` through a `keys -> <secrets>` link, and the private
 * key came back in the tool result, which is to say into the model's context.
 *
 * These tests are deliberately end-to-end — a real {@link PermissionEngine},
 * a real rule, a real symlink, the real `read`/`grep` tools driven by the real
 * agent loop — and they assert on the **bytes in the tool result**, not on a
 * decision string. A decision string can be right while the file is read
 * anyway; the bytes cannot.
 *
 * This file lives in `@arcturn/cli` because it is the lowest package that
 * depends on both `@arcturn/core` (the engine and the loop) and
 * `@arcturn/tools` (the tools whose output is the evidence). Neither of those
 * two may depend on the other — see the conformance describe at the bottom,
 * which is what keeps their two copies of "where does this path really go"
 * answering the same thing.
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSubjectPath as coreResolveSubjectPath,
  createAgent,
  defaultSubject,
  type PermissionEngineOptions,
} from "@arcturn/core";
import {
  createGrepTool,
  createReadTool,
  resolveSubjectPath as toolsResolveSubjectPath,
} from "@arcturn/tools";
import type { AgentEvent, ModelSpec, PermissionRule, Tool } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { fakeLLM, type ScriptedTurn } from "./test-helpers/fake-llm.js";

const MODEL: ModelSpec = {
  id: "test/model",
  provider: "anthropic",
  model: "test-model",
  displayName: "Test Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: true, caching: true },
};

/** The bytes that must never reach a tool result. */
const KEY_BYTES = "PRIVATE-KEY-BYTES-DO-NOT-LEAK";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

interface CallOutcome {
  /** Concatenated text of the tool result the loop produced. */
  text: string;
  isError: boolean;
  /** How many times the user was actually asked. */
  asks: number;
}

/**
 * Run one scripted tool call through the real loop and report what came back.
 *
 * No `onPermissionAsk` is wired on purpose: a read-only tool must never reach
 * a prompt, so an ask here would itself be the news.
 */
async function runToolCall(
  cwd: string,
  tools: Tool[],
  call: { name: string; arguments: Record<string, unknown> },
  rules: PermissionRule[],
  permissions: Omit<PermissionEngineOptions, "rules"> = {},
): Promise<CallOutcome> {
  const turns: ScriptedTurn[] = [
    { toolCalls: [{ id: "tc_1", name: call.name, arguments: call.arguments }] },
    { text: "done" },
  ];
  const agent = createAgent({
    llm: fakeLLM(turns),
    model: MODEL,
    systemPrompt: "test",
    tools,
    cwd,
    permissions: { ...permissions, rules },
  });

  let text = "";
  let isError = false;
  let asks = 0;
  agent.on("toolEnd", (event) => {
    isError = event.result.isError === true;
    for (const part of event.result.content) {
      if (part.type === "text") text += part.text;
    }
  });
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "permissionRequest") asks++;
  });
  await agent.prompt("go");
  return { text, isError, asks };
}

/**
 * A workspace, a secrets directory outside it, and the door between them.
 *
 * The root is `realpath`ed first, so both the rule and the workspace are
 * spelled canonically — the shape of the real case, where a rule names
 * `<home>/.ssh` and `<home>` is a real directory. `os.tmpdir()` on macOS is
 * `/var/folders/…` and `/var` is itself a symlink to `/private/var`, which
 * would otherwise make this a test about that instead. See the LIMIT test
 * below, which records that corner deliberately.
 */
async function workspaceWithLinkedSecrets(): Promise<{ cwd: string; secrets: string }> {
  const root = await mkdtemp(join(tmpdir(), "arcturn-symlink-"));
  dirs.push(root);
  const real = await realpath(root);
  const cwd = join(real, "workspace");
  const secrets = join(real, "secrets");
  await mkdir(cwd);
  await mkdir(secrets);
  await writeFile(join(secrets, "id_rsa"), `${KEY_BYTES}\n`);
  // The door: an ordinary symlink inside the workspace. Creating it needs no
  // permission the agent has to hold — it may simply already be there.
  await symlink(secrets, join(cwd, "keys"));
  return { cwd, secrets };
}

describe("a stored deny is judged at the file the path really names", () => {
  it("read: the key bytes do not reach the model through an in-workspace symlink", async () => {
    const { cwd, secrets } = await workspaceWithLinkedSecrets();
    const rules: PermissionRule[] = [
      { scope: "user", tool: "read", specifier: `${secrets}/**`, action: "deny" },
    ];

    // The spelling the rule was written against: refused, as it always was.
    const direct = await runToolCall(
      cwd,
      [createReadTool()],
      { name: "read", arguments: { path: join(secrets, "id_rsa") } },
      rules,
    );
    expect(direct.isError).toBe(true);
    expect(direct.text).not.toContain(KEY_BYTES);

    // The spelling one hop past the wall: the same file, the same rule.
    const viaLink = await runToolCall(
      cwd,
      [createReadTool()],
      { name: "read", arguments: { path: "keys/id_rsa" } },
      rules,
    );
    expect(viaLink.text, "the private key reached the model's context").not.toContain(KEY_BYTES);
    expect(viaLink.isError).toBe(true);
    // And it was settled by the rule, not by asking anyone: a read-only tool
    // has no prompt to be saved by.
    expect(viaLink.asks).toBe(0);
  });

  it("read: a stored deny still outranks yolo when the path is spelled past a link", async () => {
    const { cwd, secrets } = await workspaceWithLinkedSecrets();
    const outcome = await runToolCall(
      cwd,
      [createReadTool()],
      { name: "read", arguments: { path: "keys/id_rsa" } },
      [{ scope: "user", tool: "read", specifier: `${secrets}/**`, action: "deny" }],
      { mode: "yolo" },
    );
    expect(outcome.text).not.toContain(KEY_BYTES);
    expect(outcome.isError).toBe(true);
  });

  it("grep: a denied file cannot be searched through a symlink either", async () => {
    const { cwd, secrets } = await workspaceWithLinkedSecrets();
    const outcome = await runToolCall(
      cwd,
      [createGrepTool()],
      { name: "grep", arguments: { pattern: "PRIVATE-KEY", path: "keys/id_rsa" } },
      [{ scope: "user", tool: "grep", specifier: `${secrets}/**`, action: "deny" }],
    );
    expect(outcome.text).not.toContain(KEY_BYTES);
    expect(outcome.isError).toBe(true);
  });

  it("LIMIT: a rule written against a symlinked PREFIX is still matched canonically", async () => {
    // Recorded, not fixed. The subject is canonical, so a rule must be spelled
    // canonically too: on macOS `/var` is a symlink to `/private/var`, and a
    // `deny read "/var/…/**"` rule does not match a subject resolved to
    // `/private/var/…`. This is not a regression — the lexical subject
    // (`<cwd>/keys/id_rsa`) did not match that rule either, so nothing that
    // used to be refused stops being refused. It is the boundary of what
    // resolving a path can do: the rule side is a glob and cannot be resolved.
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-symlink-prefix-ws-"));
    const secrets = await mkdtemp(join(tmpdir(), "arcturn-symlink-prefix-sec-"));
    dirs.push(cwd, secrets);
    await writeFile(join(secrets, "id_rsa"), `${KEY_BYTES}\n`);
    await symlink(secrets, join(cwd, "keys"));

    const canonical = await realpath(secrets);
    // Spelled the way the filesystem really spells it: the wall holds.
    const held = await runToolCall(
      cwd,
      [createReadTool()],
      { name: "read", arguments: { path: "keys/id_rsa" } },
      [{ scope: "user", tool: "read", specifier: `${canonical}/**`, action: "deny" }],
    );
    expect(held.text).not.toContain(KEY_BYTES);
    expect(held.isError).toBe(true);

    // Spelled through the platform's own symlinked prefix: it does not, and it
    // did not before either. Only meaningful where the two spellings differ.
    if (canonical !== secrets) {
      const missed = await runToolCall(
        cwd,
        [createReadTool()],
        { name: "read", arguments: { path: "keys/id_rsa" } },
        [{ scope: "user", tool: "read", specifier: `${secrets}/**`, action: "deny" }],
      );
      expect(missed.isError).toBe(false);
    }
  });

  it("the subject a workspace-confinement rule set sees is the escape, not the workspace", async () => {
    // The other shape of the same wall: allow the workspace, deny the rest.
    // Before the fix `keys/id_rsa` matched the allow and never met the floor.
    const { cwd } = await workspaceWithLinkedSecrets();
    const outcome = await runToolCall(
      cwd,
      [createReadTool()],
      { name: "read", arguments: { path: "keys/id_rsa" } },
      [
        { scope: "session", tool: "read", specifier: `${cwd}/**`, action: "allow" },
        { scope: "session", tool: "read", specifier: "*", action: "deny" },
      ],
    );
    expect(outcome.text).not.toContain(KEY_BYTES);
    expect(outcome.isError).toBe(true);
  });
});

describe("a symlink that does not escape stays an ordinary symlink", () => {
  it("read: an in-workspace link to an in-workspace file still reads under strict confinement", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-symlink-inner-"));
    dirs.push(cwd);
    await writeFile(join(cwd, "target.txt"), "ORDINARY-CONTENT\n");
    await symlink(join(cwd, "target.txt"), join(cwd, "alias.txt"));

    const outcome = await runToolCall(
      cwd,
      [createReadTool()],
      { name: "read", arguments: { path: "alias.txt" } },
      [
        { scope: "session", tool: "read", specifier: `${cwd}/**`, action: "allow" },
        { scope: "session", tool: "read", specifier: "*", action: "deny" },
      ],
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("ORDINARY-CONTENT");
  });

  it("grep: a symlinked subtree inside the workspace is still searchable under confinement", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-symlink-subtree-"));
    dirs.push(cwd);
    await mkdir(join(cwd, "shared-docs"));
    await writeFile(join(cwd, "shared-docs", "note.md"), "the NEEDLE is here\n");
    // The shape grep follows on purpose: `docs -> shared-docs`, both ends
    // inside the workspace, so nothing about it is an escape.
    await symlink(join(cwd, "shared-docs"), join(cwd, "docs"));

    const outcome = await runToolCall(
      cwd,
      [createGrepTool()],
      { name: "grep", arguments: { pattern: "NEEDLE", path: "docs" } },
      [
        { scope: "session", tool: "grep", specifier: `${cwd}/**`, action: "allow" },
        { scope: "session", tool: "grep", specifier: "*", action: "deny" },
      ],
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("NEEDLE");
  });

  it("grep still walks into a symlinked directory that leaves the workspace", async () => {
    // Searchability is not confinement: with no rule saying otherwise, the
    // `docs -> ../shared-docs` subtree grep deliberately follows is still
    // searched, and the matches still come back.
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-symlink-docs-ws-"));
    const shared = await mkdtemp(join(tmpdir(), "arcturn-symlink-docs-"));
    dirs.push(cwd, shared);
    await writeFile(join(shared, "guide.md"), "the NEEDLE lives outside\n");
    await symlink(shared, join(cwd, "docs"));

    const outcome = await runToolCall(
      cwd,
      [createGrepTool()],
      { name: "grep", arguments: { pattern: "NEEDLE", path: "docs" } },
      [],
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("NEEDLE");
  });
});

describe("renderers keep the cheap, pure subject", () => {
  it("defaultSubject stays synchronous and spells the path lexically", async () => {
    const { cwd } = await workspaceWithLinkedSecrets();
    const subject = defaultSubject("read", { path: "keys/id_rsa" }, cwd);
    // A string, not a promise: `display.ts` and `audit.ts` call this on a
    // render path and must not touch the filesystem to draw a line.
    expect(typeof subject).toBe("string");
    expect(subject).toBe(join(cwd, "keys", "id_rsa"));
  });
});

describe("core and tools agree on where a path really goes", () => {
  /**
   * The drift guard. `@arcturn/core` and `@arcturn/tools` are siblings —
   * neither may depend on the other — so each carries its own copy of this
   * resolution: core's runs at the loop's permission chokepoint for every
   * tool, tools' runs inside `write`/`edit` so the subject they hand to
   * `requestPermission` is truthful even when a host calls them directly.
   *
   * Two copies is how this class of bug returns, so the copies are held to
   * byte-identical answers over the cases that distinguish them.
   */
  it("returns the same answer for every shape that matters", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "arcturn-conformance-ws-"));
    const outside = await mkdtemp(join(tmpdir(), "arcturn-conformance-out-"));
    dirs.push(cwd, outside);
    await writeFile(join(outside, "secret.txt"), "x\n");
    await writeFile(join(cwd, "plain.txt"), "x\n");
    await symlink(outside, join(cwd, "escape"));
    await symlink(join(cwd, "plain.txt"), join(cwd, "alias.txt"));
    await symlink(join(outside, "never-created.txt"), join(cwd, "dangling.txt"));
    await symlink(join(cwd, "cycle"), join(cwd, "cycle"));

    const cases = [
      join(cwd, "plain.txt"),
      join(cwd, "alias.txt"),
      join(cwd, "escape", "secret.txt"),
      join(cwd, "escape", "does", "not", "exist.txt"),
      join(cwd, "dangling.txt"),
      join(cwd, "cycle"),
      join(cwd, "not-yet.txt"),
      join(cwd, "deep", "not", "yet.txt"),
      join(outside, "secret.txt"),
      cwd,
      "/etc/hosts",
    ];

    for (const path of cases) {
      const fromCore = await coreResolveSubjectPath(cwd, path);
      const fromTools = await toolsResolveSubjectPath(cwd, path);
      expect(fromCore, `core and tools disagree about ${path}`).toBe(fromTools);
    }
  });
});
