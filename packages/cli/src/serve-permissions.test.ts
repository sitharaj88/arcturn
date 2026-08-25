/**
 * RFC 0005 §1.2 / §1.3 on the real serve path: a real {@link ArcturnRuntime}
 * (so `onPersistRule` is genuinely wired to `persistPermissionRule`, the
 * function that writes a permission config file), a real
 * {@link createServeHost}, a real {@link ArcturnServer} on a real port, and a
 * real {@link createProtocolClient}.
 *
 * `packages/server`'s `permissions-wire.test.ts` proves the *ordering* — a deny
 * rule beats `yolo` set over the wire. This file proves the thing only the CLI
 * can prove, because the CLI is where the writing happens: that a decision made
 * over the wire **does not reach the disk**. The assertions are on the bytes of
 * `~/.arcturn/config.json` and `<cwd>/.arcturn/config.json`, before and after,
 * not on a scope string.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createProtocolClient } from "@arcturn/protocol";
import { ArcturnServer } from "@arcturn/server";
import type { AgentEvent } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ArcturnRuntime } from "./runtime.js";
import { createServeHost } from "./serve.js";
import { INDEX_LINE_MAX_CHARS } from "./skill-tool.js";
import {
  buildTestRuntime,
  makeScratch,
  type Scratch,
  writeFileAt,
} from "./test-helpers/scratch.js";

const servers: ArcturnServer[] = [];
const closers: (() => void)[] = [];
const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0)) await server.stop();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

/**
 * Every `config.json` under a tree, keyed by relative path.
 *
 * Config files specifically, not the whole tree: a served session legitimately
 * writes its transcript under `~/.arcturn/sessions`, and asserting that nothing
 * at all changed would fail for the wrong reason and teach nobody anything.
 * `persistPermissionRule` writes exactly one kind of file — `config.json`, at
 * `paths.userConfig` or `paths.projectConfig` — so this is the surface the
 * claim "nothing persists to disk from a remote client" is actually about.
 * The map's *keys* matter as much as its values: a new config.json appearing
 * anywhere is as much a failure as an existing one changing.
 */
async function snapshotConfigs(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(full, key);
      else if (entry.name === "config.json") out[key] = await readFile(full, "utf8");
    }
  };
  await walk(root, "");
  return out;
}

interface Harness {
  runtime: ArcturnRuntime;
  client: ReturnType<typeof createProtocolClient>;
  sessionId: string;
  events: AgentEvent[];
  scratch: Scratch;
}

async function serve(
  scratch: Scratch,
  turns: Parameters<typeof buildTestRuntime>[1],
  overrides: Parameters<typeof buildTestRuntime>[2] = {},
): Promise<Harness> {
  const runtime = await buildTestRuntime(scratch, turns, overrides);
  runtimes.push(runtime);
  const server = new ArcturnServer({ sessionHost: createServeHost(runtime) });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
  closers.push(() => client.close());
  const events: AgentEvent[] = [];
  client.onEvent((_id, event) => events.push(event));
  const header = await client.createSession({ cwd: runtime.cwd });
  await client.openSession(header.sessionId);
  return { runtime, client, sessionId: header.sessionId, events, scratch };
}

describe("RFC 0005 §1.2 — nothing persists to disk from a remote client", () => {
  it('grants "allow for this session" without writing a single byte of config', async () => {
    const scratch = await makeScratch();
    // Seed both config files so the test can prove they are UNCHANGED rather
    // than merely absent: `persistPermissionRule` creates the file it writes,
    // so "no file" and "file untouched" are different proofs and the second is
    // the stronger one.
    await writeFileAt(join(scratch.home, "config.json"), '{\n  "permissions": []\n}\n');
    await writeFileAt(join(scratch.cwd, ".arcturn", "config.json"), '{\n  "permissions": []\n}\n');

    const harness = await serve(scratch, [
      { toolCalls: [{ id: "c1", name: "bash", arguments: { command: "echo hi" } }] },
      { toolCalls: [{ id: "c2", name: "bash", arguments: { command: "echo hi" } }] },
      { text: "done" },
    ]);
    const homeBefore = await snapshotConfigs(scratch.home);
    const projectBefore = await snapshotConfigs(join(scratch.cwd, ".arcturn"));

    harness.client.onEvent((_id, event) => {
      if (event.type !== "permissionRequest") return;
      void harness.client.respondToPermission(
        harness.sessionId,
        { requestId: event.request.id, behavior: "allow" },
        { scope: "session" },
      );
    });
    await harness.client.prompt(harness.sessionId, "run it twice");

    // It really was granted for the session: asked once, ran twice.
    expect(harness.events.filter((event) => event.type === "permissionRequest")).toHaveLength(1);
    const state = await harness.client.permissionState(harness.sessionId);
    expect(state?.rules).toContainEqual(
      expect.objectContaining({ tool: "bash", scope: "session" }),
    );

    // And it reached nothing durable. Every file under ~/.arcturn and
    // <cwd>/.arcturn is byte-identical to what it was before the grant.
    expect(await snapshotConfigs(scratch.home)).toEqual(homeBefore);
    expect(await snapshotConfigs(join(scratch.cwd, ".arcturn"))).toEqual(projectBefore);
    expect(await readFile(join(scratch.home, "config.json"), "utf8")).not.toContain("bash");
  });

  it("refuses a project-scoped allow, and the config file still says nothing", async () => {
    const scratch = await makeScratch();
    await writeFileAt(join(scratch.cwd, ".arcturn", "config.json"), '{\n  "permissions": []\n}\n');
    const harness = await serve(scratch, [
      { toolCalls: [{ id: "c1", name: "bash", arguments: { command: "echo hi" } }] },
      { text: "done" },
    ]);

    const refusals: unknown[] = [];
    harness.client.onEvent((_id, event) => {
      if (event.type !== "permissionRequest") return;
      void harness.client
        .respondToPermission(
          harness.sessionId,
          { requestId: event.request.id, behavior: "allow" },
          { scope: "project" },
        )
        .catch((error: unknown) => {
          refusals.push(error);
          void harness.client.respondToPermission(harness.sessionId, {
            requestId: event.request.id,
            behavior: "deny",
            message: "no",
          });
        });
    });
    await harness.client.prompt(harness.sessionId, "run it");

    expect(refusals).toHaveLength(1);
    expect(await readFile(join(scratch.cwd, ".arcturn", "config.json"), "utf8")).toBe(
      '{\n  "permissions": []\n}\n',
    );
  });

  it("the local TUI is unaffected: a project rule from the terminal still writes", async () => {
    // The wall is on the WIRE, not on the permission engine. A person at the
    // terminal answering their own prompt still persists a project rule — that
    // is the whole distinction RFC 0005 §1.2 draws, and a change that broke it
    // would have made the engine less capable rather than the wire safer.
    const scratch = await makeScratch();
    const { persistPermissionRule } = await import("./config.js");
    const { resolveArcturnPaths } = await import("./paths.js");
    const paths = resolveArcturnPaths({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
    });
    const file = await persistPermissionRule(
      { tool: "bash", specifier: "echo *", action: "allow", scope: "project" },
      paths,
    );
    expect(file).toBeDefined();
    expect(await readFile(file as string, "utf8")).toContain("echo *");
  });
});

describe("RFC 0005 §1.4 — permissionState reports what this engine can do", () => {
  it("names the real tool set, so a client can say 'this engine can browse' truthfully", async () => {
    const scratch = await makeScratch();
    const harness = await serve(scratch, [{ text: "hi" }]);
    const state = await harness.client.permissionState(harness.sessionId);

    expect(state?.mode).toBe(harness.runtime.permissionMode);
    // The web tools are the point of §1.4: no verb reports them, the tool list
    // does. A panel that renders a browse affordance reads this or renders none.
    expect(state?.tools).toContain("fetch");
    expect(state?.tools).toContain("websearch");
    expect(state?.tools).toContain("bash");
    // Names only — never a description or a schema.
    for (const name of state?.tools ?? []) expect(typeof name).toBe("string");
  });

  it("reports the full set under progressive disclosure, not the turn's facade", async () => {
    // With deferred tools on, the model is shown a facade that changes per
    // turn. A capabilities line driven by the facade would flicker for reasons
    // no user could explain, so this reports what the session CAN do.
    const scratch = await makeScratch();
    const harness = await serve(scratch, [{ text: "hi" }], {
      config: {
        ...(await import("./config.js")).DEFAULT_CONFIG,
        permissions: [],
        hooks: { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] },
        deferredTools: { enabled: true },
      },
    });

    const state = await harness.client.permissionState(harness.sessionId);
    expect(state?.tools).toContain("fetch");
    expect(state?.tools).toContain("websearch");
    expect(state?.tools).toContain("write");
  });
});

describe("RFC 0005 §1.3 — listCommands on the real serve path", () => {
  it("lists the workspace's skills with their source, and the reachable built-ins", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "skills", "review.md"),
      "---\ndescription: Review the diff\n---\n\nReview $ARGUMENTS.\n",
    );
    await writeFileAt(
      join(scratch.home, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship it\n---\n\nDeploy.\n",
    );
    const harness = await serve(scratch, [{ text: "hi" }]);

    const list = await harness.client.listCommands();
    const byName = new Map((list?.commands ?? []).map((command) => [command.name, command]));

    expect(byName.get("review")).toMatchObject({
      description: "Review the diff",
      kind: "skill",
      source: join(scratch.cwd, ".arcturn", "skills", "review.md"),
    });
    expect(byName.get("deploy")).toMatchObject({ kind: "skill", description: "Ship it" });

    // The built-ins that made the cut, and one that deliberately did not.
    expect(byName.get("model")).toMatchObject({ kind: "builtin" });
    expect(byName.get("permissions")).toMatchObject({ kind: "builtin" });
    expect(byName.get("sessions")).toMatchObject({ kind: "builtin" });
    expect(byName.get("clear")).toMatchObject({ kind: "builtin" });
    expect(byName.has("rewind")).toBe(false);
    expect(byName.has("export")).toBe(false);
    expect(byName.has("compact")).toBe(false);

    // Skills first, built-ins after — the order RFC 0005 §2 renders.
    const kinds = (list?.commands ?? []).map((command) => command.kind);
    expect(kinds.indexOf("builtin")).toBeGreaterThan(kinds.lastIndexOf("skill"));
  });

  it("sanitizes a hostile description before it reaches a client's menu", async () => {
    const scratch = await makeScratch();
    // A cloned repository controls <cwd>/.arcturn/skills. This description is
    // one line in frontmatter, so it cannot span lines, but it can be very long
    // and can carry control characters — both of which a menu renders.
    const hostile = `Do this[31m then ${"x".repeat(400)}`;
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "skills", "evil.md"),
      `---\ndescription: ${hostile}\n---\n\nbody\n`,
    );
    const harness = await serve(scratch, [{ text: "hi" }]);

    const list = await harness.client.listCommands();
    const evil = (list?.commands ?? []).find((command) => command.name === "evil");
    expect(evil).toBeDefined();
    const description = evil?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(INDEX_LINE_MAX_CHARS);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone is the point.
    expect(description).not.toMatch(/[ -]/);
    expect(description).not.toContain("\n");
    // Provenance travels with it, so a menu can show where it came from.
    expect(evil?.source).toBe(join(scratch.cwd, ".arcturn", "skills", "evil.md"));
  });

  it("keeps one skill collection: the wire lists exactly what the terminal registered", async () => {
    // Both roots define `dup`; `loadSkills` resolves the collision once, and
    // the wire reads that resolution rather than scanning again.
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.home, "skills", "dup.md"),
      "---\ndescription: the user's one\n---\n\nuser\n",
    );
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "skills", "dup.md"),
      "---\ndescription: the project's one\n---\n\nproject\n",
    );
    const harness = await serve(scratch, [{ text: "hi" }]);

    const list = await harness.client.listCommands();
    const dups = (list?.commands ?? []).filter((command) => command.name === "dup");
    expect(dups).toHaveLength(1);
    expect(dups[0]?.description).toBe("the project's one");
    expect(dups[0]?.source).toBe(harness.runtime.skills.find((s) => s.name === "dup")?.source);
  });
});

describe("RFC 0005 §1.2 — setPermissionMode on the real serve path", () => {
  it("changes the mode without touching the rules or the config file", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify(
        { permissions: [{ tool: "bash", specifier: "rm *", action: "deny", scope: "project" }] },
        null,
        2,
      ),
    );
    const before = await readFile(join(scratch.cwd, ".arcturn", "config.json"), "utf8");
    const harness = await serve(scratch, [{ text: "hi" }]);

    const state = await harness.client.setPermissionMode(harness.sessionId, "yolo");
    expect(state.mode).toBe("yolo");
    expect(state.rules).toContainEqual(
      expect.objectContaining({ tool: "bash", specifier: "rm *", action: "deny" }),
    );
    expect(await readFile(join(scratch.cwd, ".arcturn", "config.json"), "utf8")).toBe(before);
  });

  it("a config deny rule still beats yolo set over the wire, on the real tool set", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify(
        { permissions: [{ tool: "write", action: "deny", scope: "project" }] },
        null,
        2,
      ),
    );
    const target = join(scratch.cwd, "written.txt");
    const harness = await serve(scratch, [
      { toolCalls: [{ id: "w1", name: "write", arguments: { file_path: target, content: "x" } }] },
      { text: "done" },
    ]);

    await harness.client.setPermissionMode(harness.sessionId, "yolo");
    await harness.client.prompt(harness.sessionId, "write the file");

    // The decisive assertion: the file is not there. Not a mode string.
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });
});
