/**
 * The safety layer, asserted on **effects** rather than on decisions.
 *
 * Every test here drives a real {@link ArcturnRuntime} — real config files,
 * the real tool set, the real permission engine, the real lifecycle hooks —
 * and then asks the filesystem what happened. A returned `"deny"` is not
 * evidence: the two defects that shipped most recently both returned exactly
 * the right string while the wrong thing happened on disk.
 *
 * So the assertions are `stat`/`readFile`/`readdir` on the user's real files:
 * a file that must not exist, a file whose bytes must be unchanged, a config
 * document compared byte for byte. Where a claim is enforced twice (a rule
 * wall *and* a physical wall), each half is exercised on its own so that
 * removing one leaves the other visibly standing.
 */

import { mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PermissionRule } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { persistPermissionRule } from "./config.js";
import { resolveArcturnPaths } from "./paths.js";
import type { ArcturnRuntime } from "./runtime.js";
import type { ScriptedTurn } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";

const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

/** These drive a real POSIX shell through the real `bash` tool. */
const itPosix = it.skipIf(process.platform === "win32");

/** Whether a path exists at all — the only question most of these tests ask. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write `<cwd>/.arcturn/config.json` (the project layer) for a scratch tree. */
async function projectConfig(scratch: Scratch, body: Record<string, unknown>): Promise<string> {
  await mkdir(join(scratch.cwd, ".arcturn"), { recursive: true });
  const file = join(scratch.cwd, ".arcturn", "config.json");
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

/** Write `$ARCTURN_HOME/config.json` (the user layer) for a scratch tree. */
async function userConfig(scratch: Scratch, body: Record<string, unknown>): Promise<string> {
  await mkdir(scratch.home, { recursive: true });
  const file = join(scratch.home, "config.json");
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

/** Build a runtime whose prompts are always refused, so nothing rides an ask. */
async function run(
  scratch: Scratch,
  turns: readonly ScriptedTurn[],
  overrides: Parameters<typeof buildTestRuntime>[2] = {},
): Promise<ArcturnRuntime> {
  const runtime = await buildTestRuntime(scratch, turns, {
    onPermissionAsk: async (request) => ({
      requestId: request.id,
      behavior: "deny" as const,
      message: "no interactive user in this test",
    }),
    ...overrides,
  });
  runtimes.push(runtime);
  await runtime.agent.prompt("go");
  return runtime;
}

/* ------------------------------------------------------------------ *
 * A deny rule is the one decision no mode can talk its way past.
 * ------------------------------------------------------------------ */

describe("a deny rule beats yolo, on the filesystem", () => {
  itPosix("a blanket bash deny means the process never runs", async () => {
    const scratch = await makeScratch();
    const marker = join(scratch.cwd, "ran.txt");
    await projectConfig(scratch, {
      permissions: [{ tool: "bash", specifier: "*", action: "deny", scope: "project" }],
    });

    await run(
      scratch,
      [
        {
          toolCalls: [{ id: "c1", name: "bash", arguments: { command: `printf ran > ${marker}` } }],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await exists(marker)).toBe(false);
  });

  it("a write deny means the file is never created", async () => {
    const scratch = await makeScratch();
    const secret = join(scratch.cwd, ".env");
    await projectConfig(scratch, {
      permissions: [{ tool: "write", specifier: "**/.env", action: "deny", scope: "project" }],
    });

    await run(
      scratch,
      [
        {
          toolCalls: [{ id: "c1", name: "write", arguments: { path: ".env", content: "TOKEN=1" } }],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await exists(secret)).toBe(false);
  });

  it("`**/.env` refuses `.ENV` wherever the volume folds case", async () => {
    const scratch = await makeScratch();
    await projectConfig(scratch, {
      permissions: [{ tool: "write", specifier: "**/.env", action: "deny", scope: "project" }],
    });

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: ".ENV", content: "TOKEN=1" } },
            { id: "c2", name: "write", arguments: { path: ".Env", content: "TOKEN=2" } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    // On a case-insensitive volume (Windows, stock macOS) all three spellings
    // are one file and the deny has to cover every one of them. On a
    // case-sensitive volume they are different files and only `.env` is
    // claimed by the rule — so the assertion that holds everywhere is that the
    // file the rule names was not written under any spelling that opens it.
    const insensitive = process.platform === "win32" || process.platform === "darwin";
    if (insensitive) {
      expect(await exists(join(scratch.cwd, ".ENV"))).toBe(false);
      expect(await exists(join(scratch.cwd, ".Env"))).toBe(false);
    }
    expect(await exists(join(scratch.cwd, ".env"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Shell chaining and a deny rule.
 * ------------------------------------------------------------------ */

describe("a command-prefix deny cannot be walked around by chaining", () => {
  itPosix("the documented allow/deny cookbook pair holds when a segment is appended", async () => {
    // `web/content/docs/permissions.md` ships this exact pair as the way to
    // "Allow all git subcommands, but hard-deny the destructive ones". If
    // appending a harmless second segment turns the deny off, the recommended
    // recipe is a recipe for a bypass.
    const scratch = await makeScratch();
    const danger = join(scratch.cwd, "danger.txt");
    const safe = join(scratch.cwd, "safe.txt");
    await projectConfig(scratch, {
      permissions: [
        { tool: "bash", specifier: "printf *", action: "allow", scope: "project" },
        { tool: "bash", specifier: "printf DANGER *", action: "deny", scope: "project" },
      ],
    });

    await run(scratch, [
      {
        toolCalls: [
          {
            id: "c1",
            name: "bash",
            arguments: { command: `printf DANGER > ${danger} && printf SAFE > ${safe}` },
          },
        ],
      },
      { text: "done" },
    ]);

    expect(await exists(danger)).toBe(false);
  });

  itPosix("a lone deny still fires when an innocuous segment is prepended", async () => {
    // No allow rule at all: the deny is the user's whole policy, and the run
    // is in `yolo`. If chaining stops the deny matching, `yolo` allows the
    // call at step 5 and the destructive half runs.
    const scratch = await makeScratch();
    const victim = join(scratch.cwd, "victim.txt");
    await writeFile(victim, "important", "utf8");
    await projectConfig(scratch, {
      permissions: [{ tool: "bash", specifier: "rm *", action: "deny", scope: "project" }],
    });

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "bash", arguments: { command: `true && rm -f ${victim}` } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await readFile(victim, "utf8")).toBe("important");
  });

  itPosix("every operator the splitter knows about is covered", async () => {
    const scratch = await makeScratch();
    await projectConfig(scratch, {
      permissions: [{ tool: "bash", specifier: "rm *", action: "deny", scope: "project" }],
    });

    const victims = ["a", "b", "c", "d", "e"].map((name) => join(scratch.cwd, `${name}.txt`));
    for (const victim of victims) await writeFile(victim, "important", "utf8");
    const commands = [
      `true; rm -f ${victims[0]}`,
      `true && rm -f ${victims[1]}`,
      `true || rm -f ${victims[2]}`,
      `true\nrm -f ${victims[3]}`,
      `true & rm -f ${victims[4]}`,
    ];

    await run(
      scratch,
      [
        {
          toolCalls: commands.map((command, index) => ({
            id: `c${index}`,
            name: "bash",
            arguments: { command },
          })),
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    for (const victim of victims) {
      expect(await readFile(victim, "utf8")).toBe("important");
    }
  });

  itPosix("an allow prefix still grants the chain whose every segment it covers", async () => {
    // The other half: narrowing the deny must not narrow the allow. `every`
    // is still the right rule for a permissive prefix.
    const scratch = await makeScratch();
    const first = join(scratch.cwd, "one.txt");
    const second = join(scratch.cwd, "two.txt");
    await projectConfig(scratch, {
      permissions: [{ tool: "bash", specifier: "printf *", action: "allow", scope: "project" }],
    });

    await run(scratch, [
      {
        toolCalls: [
          {
            id: "c1",
            name: "bash",
            arguments: { command: `printf one > ${first} && printf two > ${second}` },
          },
        ],
      },
      { text: "done" },
    ]);

    expect(await readFile(first, "utf8")).toBe("one");
    expect(await readFile(second, "utf8")).toBe("two");
  });

  itPosix("an allow prefix still refuses a chain with a segment it does not cover", async () => {
    const scratch = await makeScratch();
    const wanted = join(scratch.cwd, "wanted.txt");
    const smuggled = join(scratch.cwd, "smuggled.txt");
    await projectConfig(scratch, {
      permissions: [{ tool: "bash", specifier: "printf *", action: "allow", scope: "project" }],
    });

    await run(scratch, [
      {
        toolCalls: [
          {
            id: "c1",
            name: "bash",
            arguments: { command: `printf ok > ${wanted}; touch ${smuggled}` },
          },
        ],
      },
      { text: "done" },
    ]);

    expect(await exists(wanted)).toBe(false);
    expect(await exists(smuggled)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Scope precedence.
 * ------------------------------------------------------------------ */

describe("a checked-in project config cannot cancel the user's own deny", () => {
  it("an equally specific project allow does not out-rank a user deny", async () => {
    // The threat the engine's own comment names: "a checked-in project config
    // could escalate its own privileges just by being cloned". The mitigation
    // shipped only for a *broader* project allow; an allow that ties the
    // deny's specificity walked straight past it on scope alone.
    const scratch = await makeScratch();
    await userConfig(scratch, {
      permissions: [{ tool: "write", specifier: "**/.env", action: "deny", scope: "user" }],
    });
    await projectConfig(scratch, {
      permissions: [{ tool: "write", specifier: "**/.env", action: "allow", scope: "project" }],
    });

    await run(scratch, [
      {
        toolCalls: [{ id: "c1", name: "write", arguments: { path: ".env", content: "TOKEN=1" } }],
      },
      { text: "done" },
    ]);

    expect(await exists(join(scratch.cwd, ".env"))).toBe(false);
  });

  it("a strictly more specific project allow is still honoured", async () => {
    // The carve-out the docs promise, and the shape the "restrict edits to
    // src/" cookbook depends on: a narrow allow beats a broad deny.
    const scratch = await makeScratch();
    await userConfig(scratch, {
      permissions: [{ tool: "write", specifier: "*", action: "deny", scope: "user" }],
    });
    await projectConfig(scratch, {
      permissions: [{ tool: "write", specifier: "**/src/**", action: "allow", scope: "project" }],
    });

    await run(scratch, [
      {
        toolCalls: [
          { id: "c1", name: "write", arguments: { path: "src/app.ts", content: "export {};" } },
        ],
      },
      { text: "done" },
    ]);

    expect(await readFile(join(scratch.cwd, "src", "app.ts"), "utf8")).toBe("export {};");
  });
});

/* ------------------------------------------------------------------ *
 * Modes.
 * ------------------------------------------------------------------ */

describe("plan mode leaves the filesystem alone", () => {
  itPosix("nothing a mutating tool was asked to do reaches disk", async () => {
    const scratch = await makeScratch();
    const existing = join(scratch.cwd, "kept.txt");
    await writeFile(existing, "original", "utf8");

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "new.txt", content: "x" } },
            {
              id: "c2",
              name: "edit",
              arguments: { path: "kept.txt", old_string: "original", new_string: "rewritten" },
            },
            {
              id: "c3",
              name: "bash",
              arguments: { command: `printf shell > ${join(scratch.cwd, "shell.txt")}` },
            },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "plan" },
    );

    expect(await exists(join(scratch.cwd, "new.txt"))).toBe(false);
    expect(await exists(join(scratch.cwd, "shell.txt"))).toBe(false);
    expect(await readFile(existing, "utf8")).toBe("original");
  });

  it("a stored allow rule cannot buy a write in plan mode", async () => {
    const scratch = await makeScratch();
    await projectConfig(scratch, {
      permissions: [{ tool: "write", specifier: "*", action: "allow", scope: "project" }],
    });

    await run(
      scratch,
      [
        {
          toolCalls: [{ id: "c1", name: "write", arguments: { path: "new.txt", content: "x" } }],
        },
        { text: "done" },
      ],
      { permissionMode: "plan" },
    );

    expect(await exists(join(scratch.cwd, "new.txt"))).toBe(false);
  });
});

describe("acceptEdits accepts edits and nothing else", () => {
  itPosix("the write lands and the shell command does not run", async () => {
    const scratch = await makeScratch();
    const shellMarker = join(scratch.cwd, "shell.txt");

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "edited.txt", content: "written" } },
            { id: "c2", name: "bash", arguments: { command: `printf shell > ${shellMarker}` } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "acceptEdits" },
    );

    expect(await readFile(join(scratch.cwd, "edited.txt"), "utf8")).toBe("written");
    expect(await exists(shellMarker)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Lifecycle hooks.
 * ------------------------------------------------------------------ */

describe("a preToolUse hook that vetoes prevents the effect", () => {
  itPosix("exit 2 stops the tool before it runs", async () => {
    const scratch = await makeScratch();
    const marker = join(scratch.cwd, "written.txt");
    await projectConfig(scratch, {
      hooks: { preToolUse: [{ command: "exit 2", matcher: "write" }] },
    });

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "written.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await exists(marker)).toBe(false);
  });

  itPosix('a JSON {"decision":"deny"} on stdout stops it too', async () => {
    const scratch = await makeScratch();
    const marker = join(scratch.cwd, "written.txt");
    await projectConfig(scratch, {
      hooks: {
        preToolUse: [{ command: `printf '{"decision":"deny","reason":"policy"}'` }],
      },
    });

    await run(
      scratch,
      [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "written.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
      { permissionMode: "yolo" },
    );

    expect(await exists(marker)).toBe(false);
  });

  itPosix("the veto still holds when the permission engine would have allowed", async () => {
    const scratch = await makeScratch();
    const marker = join(scratch.cwd, "shell.txt");
    await projectConfig(scratch, {
      permissions: [{ tool: "bash", specifier: "*", action: "allow", scope: "project" }],
      hooks: { preToolUse: [{ command: "exit 2", matcher: "bash" }] },
    });

    await run(scratch, [
      {
        toolCalls: [{ id: "c1", name: "bash", arguments: { command: `printf x > ${marker}` } }],
      },
      { text: "done" },
    ]);

    expect(await exists(marker)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Workspace confinement, on every path-taking surface reachable here.
 * ------------------------------------------------------------------ */

describe("a write grant confined to the workspace cannot be escaped", () => {
  const shapes = [
    ["dot-dot traversal", "../outside/pwned.txt"],
    ["nested traversal", "src/../../outside/pwned.txt"],
  ] as const;

  it.each(shapes)("%s does not land outside the grant", async (_label, spelling) => {
    const scratch = await makeScratch();
    const root = resolve(scratch.cwd);
    await projectConfig(scratch, {
      permissions: [
        { tool: "*", specifier: "*", action: "deny", scope: "project" },
        { tool: "write", specifier: join(root, "**"), action: "allow", scope: "project" },
      ],
    });

    await run(scratch, [
      {
        toolCalls: [{ id: "c1", name: "write", arguments: { path: spelling, content: "pwned" } }],
      },
      { text: "done" },
    ]);

    expect(await exists(join(scratch.root, "outside", "pwned.txt"))).toBe(false);
  });

  it("an absolute path outside the grant does not land", async () => {
    const scratch = await makeScratch();
    const root = resolve(scratch.cwd);
    const outside = join(scratch.root, "outside.txt");
    await projectConfig(scratch, {
      permissions: [
        { tool: "*", specifier: "*", action: "deny", scope: "project" },
        { tool: "write", specifier: join(root, "**"), action: "allow", scope: "project" },
      ],
    });

    await run(scratch, [
      {
        toolCalls: [{ id: "c1", name: "write", arguments: { path: outside, content: "pwned" } }],
      },
      { text: "done" },
    ]);

    expect(await exists(outside)).toBe(false);
  });

  itPosix("a real symlink pointing out of the workspace does not carry a write out", async () => {
    const scratch = await makeScratch();
    const root = resolve(scratch.cwd);
    await mkdir(join(scratch.root, "outside"), { recursive: true });
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    await projectConfig(scratch, {
      permissions: [
        { tool: "*", specifier: "*", action: "deny", scope: "project" },
        { tool: "write", specifier: join(root, "**"), action: "allow", scope: "project" },
      ],
    });

    await run(scratch, [
      {
        toolCalls: [
          { id: "c1", name: "write", arguments: { path: "vendor/pwned.txt", content: "pwned" } },
        ],
      },
      { text: "done" },
    ]);

    // The subject the rules see is `path.resolve`d, which is lexical — so on
    // the rule wall alone `<root>/vendor/pwned.txt` sits squarely inside the
    // `<root>/**` grant while the bytes land outside it. What closes it is the
    // *tool* naming its subject honestly: `write` realpaths the target
    // (`resolveSubjectPath`) before asking, so the engine is handed the path
    // the bytes will actually reach and the floor deny claims it.
    //
    // The consequence worth stating: this guarantee lives in the tool, not in
    // the engine. A tool that takes a path and does NOT resolve it before
    // asking gets the lexical subject and this escape back. That is why the
    // floor rule below is `deny`-by-default rather than an allow-list.
    expect(await exists(join(scratch.root, "outside", "pwned.txt"))).toBe(false);
  });

  itPosix("a deny rule naming the real destination also stops the symlinked write", async () => {
    // The independent half: no floor deny and a blanket allow, so the ONLY
    // thing that can refuse is a rule written about where the bytes land.
    // It fires, which is only possible because the subject was resolved.
    //
    // The specifier is built from `realpath(root)`, not from `root`, and that
    // is not test hygiene — it is the cost of the resolution above, written
    // down. Once a tool presents the canonical destination as its subject, a
    // rule spelled the way the user reaches the path stops matching whenever
    // any ANCESTOR is a link: on macOS `os.tmpdir()` is `/var/folders/...`
    // and `/var` is a symlink to `/private/var`, so `deny write
    // "/var/folders/x/outside/**"` misses a subject of
    // `/private/var/folders/x/outside/pwned.txt`. A rule must be written in
    // canonical spelling to be reliable.
    const scratch = await makeScratch();
    const realRoot = await realpath(scratch.root);
    await mkdir(join(scratch.root, "outside"), { recursive: true });
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    await projectConfig(scratch, {
      permissions: [
        { tool: "write", specifier: "*", action: "allow", scope: "project" },
        {
          tool: "write",
          specifier: join(realRoot, "outside", "**"),
          action: "deny",
          scope: "project",
        },
      ],
    });

    await run(scratch, [
      {
        toolCalls: [
          { id: "c1", name: "write", arguments: { path: "vendor/pwned.txt", content: "pwned" } },
        ],
      },
      { text: "done" },
    ]);

    expect(await exists(join(scratch.root, "outside", "pwned.txt"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Persisting a rule: the right file, the right scope, nothing else moved.
 * ------------------------------------------------------------------ */

describe("persisting a rule touches exactly one file and changes nothing else in it", () => {
  it("keeps every unrelated key and every existing rule byte for byte", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ home: scratch.home, cwd: scratch.cwd, env: {} });
    const before = {
      model: "anthropic/claude-sonnet-4",
      permissionMode: "default",
      nested: { keep: [1, 2, 3], deep: { flag: true } },
      permissions: [{ tool: "bash", specifier: "git *", action: "allow", scope: "project" }],
      hooks: { preToolUse: [{ command: "true" }] },
    };
    await projectConfig(scratch, before);
    await userConfig(scratch, { model: "user-model" });
    const userBytes = await readFile(paths.userConfig, "utf8");

    const rule: PermissionRule = {
      tool: "write",
      specifier: "**/*.ts",
      action: "allow",
      scope: "project",
    };
    const written = await persistPermissionRule(rule, paths);

    expect(written).toBe(paths.projectConfig);
    const after = JSON.parse(await readFile(paths.projectConfig, "utf8")) as typeof before;
    expect(after.model).toBe(before.model);
    expect(after.permissionMode).toBe(before.permissionMode);
    expect(after.nested).toEqual(before.nested);
    expect(after.hooks).toEqual(before.hooks);
    expect(after.permissions[0]).toEqual(before.permissions[0]);
    expect(after.permissions).toHaveLength(2);
    expect(after.permissions[1]).toEqual(rule);

    // The other person-owned file is untouched, byte for byte.
    expect(await readFile(paths.userConfig, "utf8")).toBe(userBytes);
  });

  it("a session-scoped rule is written nowhere at all", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ home: scratch.home, cwd: scratch.cwd, env: {} });
    await projectConfig(scratch, { permissions: [] });
    await userConfig(scratch, {});
    const projectBytes = await readFile(paths.projectConfig, "utf8");
    const userBytes = await readFile(paths.userConfig, "utf8");

    const written = await persistPermissionRule(
      { tool: "bash", specifier: "*", action: "allow", scope: "session" },
      paths,
    );

    expect(written).toBeUndefined();
    expect(await readFile(paths.projectConfig, "utf8")).toBe(projectBytes);
    expect(await readFile(paths.userConfig, "utf8")).toBe(userBytes);
  });

  it("a user-scoped rule never lands in the project file", async () => {
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ home: scratch.home, cwd: scratch.cwd, env: {} });
    await projectConfig(scratch, { permissions: [] });
    await userConfig(scratch, {});
    const projectBytes = await readFile(paths.projectConfig, "utf8");

    const written = await persistPermissionRule(
      { tool: "bash", specifier: "npm *", action: "allow", scope: "user" },
      paths,
    );

    expect(written).toBe(paths.userConfig);
    expect(await readFile(paths.projectConfig, "utf8")).toBe(projectBytes);
    const user = JSON.parse(await readFile(paths.userConfig, "utf8")) as {
      permissions: PermissionRule[];
    };
    expect(user.permissions).toEqual([
      { tool: "bash", specifier: "npm *", action: "allow", scope: "user" },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * A gap the rule wall cannot close on its own.
 * ------------------------------------------------------------------ */

describe("GAP: a rule wall only sees the ONE argument defaultSubject picks", () => {
  // `defaultSubject` derives exactly one subject per tool call, from the first
  // present key of a fixed list. For a tool whose *root* is one argument and
  // whose *file selector* is another, the subject names the root — which the
  // wall happily places inside the workspace — while the selector decides what
  // is actually opened and is never looked at.
  //
  // This is not fixable in the engine: only the tool knows which of its
  // arguments are paths. `grep`'s `pattern` is a REGEX and `glob`'s is a PATH,
  // both under keys the engine would have to treat identically, so a
  // tool-agnostic "check every path-shaped argument" rule would either miss
  // these or refuse ordinary regexes. The fix belongs in the tools: confine
  // the file set each one collects to the root its subject named. `mcp-serve`
  // does exactly that with `guardWorkspacePaths` plus its own tool subset,
  // which is why `wave2-reaudit-confinement.review.test.ts` is green — the
  // promise-making surface is walled. A plain CLI run driven by rules alone is
  // not.
  //
  // These tests assert the CURRENT behaviour on purpose, so the gap is a
  // change detector rather than a red build. When the tools are fixed, each
  // `toBe(true)` below becomes `toBe(false)` and the describe drops "GAP:".

  async function secretOutside(scratch: Scratch): Promise<void> {
    await mkdir(join(scratch.root, "outside"), { recursive: true });
    await writeFile(join(scratch.root, "outside", "id_rsa"), "SUPER-SECRET-KEY", "utf8");
  }

  /** The subtractive wall the `/workflow` lanes and `--cwd` runs are built from. */
  async function walledConfig(scratch: Scratch): Promise<void> {
    const root = resolve(scratch.cwd);
    await projectConfig(scratch, {
      permissions: [
        { tool: "*", specifier: "*", action: "deny", scope: "project" },
        { tool: "*", specifier: root, action: "allow", scope: "project" },
        { tool: "*", specifier: join(root, "**"), action: "allow", scope: "project" },
      ],
    });
  }

  function modelSaw(runtime: ArcturnRuntime): string {
    return JSON.stringify(runtime.agent.messages);
  }

  it("grep's `glob` reads bytes the wall never ruled on", async () => {
    const scratch = await makeScratch();
    await secretOutside(scratch);
    await walledConfig(scratch);

    const runtime = await run(scratch, [
      {
        toolCalls: [
          {
            id: "c1",
            name: "grep",
            arguments: { pattern: "SECRET", path: ".", glob: "../outside/**" },
          },
        ],
      },
      { text: "done" },
    ]);

    // MUST become `false`.
    expect(modelSaw(runtime).includes("SUPER-SECRET-KEY")).toBe(true);
  });

  it("the same call IS refused when the escape is spelled in `path`", async () => {
    // The control, and the reason this is a gap rather than a missing wall:
    // the wall works perfectly on the argument it is shown.
    const scratch = await makeScratch();
    await secretOutside(scratch);
    await walledConfig(scratch);

    const runtime = await run(scratch, [
      {
        toolCalls: [
          { id: "c1", name: "grep", arguments: { pattern: "SECRET", path: "../outside" } },
        ],
      },
      { text: "done" },
    ]);

    expect(modelSaw(runtime).includes("SUPER-SECRET-KEY")).toBe(false);
  });

  it("`read` with the same escape is refused, so the wall itself is sound", async () => {
    const scratch = await makeScratch();
    await secretOutside(scratch);
    await walledConfig(scratch);

    const runtime = await run(scratch, [
      {
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "../outside/id_rsa" } }],
      },
      { text: "done" },
    ]);

    expect(modelSaw(runtime).includes("SUPER-SECRET-KEY")).toBe(false);
  });

  it("glob's `pattern` enumerates names outside the wall", async () => {
    const scratch = await makeScratch();
    await secretOutside(scratch);
    await walledConfig(scratch);

    const runtime = await run(scratch, [
      {
        toolCalls: [{ id: "c1", name: "glob", arguments: { path: ".", pattern: "../outside/**" } }],
      },
      { text: "done" },
    ]);

    // MUST become `false`.
    expect(modelSaw(runtime).includes("id_rsa")).toBe(true);
  });

  itPosix("grep with no glob at all still follows a checked-in symlink out", async () => {
    // Worth its own case because no argument is suspicious: `path: "."` is the
    // workspace, and `walk()` follows a symlinked directory by design (its own
    // doc comment says so, to stay consistent with the tinyglobby path). One
    // `ln -s "$HOME" vendor` in a repository is the whole escape.
    const scratch = await makeScratch();
    await secretOutside(scratch);
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    await walledConfig(scratch);

    const runtime = await run(scratch, [
      {
        toolCalls: [{ id: "c1", name: "grep", arguments: { pattern: "SECRET", path: "." } }],
      },
      { text: "done" },
    ]);

    // MUST become `false`.
    expect(modelSaw(runtime).includes("SUPER-SECRET-KEY")).toBe(true);
  });
});
