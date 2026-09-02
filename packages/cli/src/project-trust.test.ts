/**
 * Units for the project-code trust gate: what the digest covers, what it
 * ignores, and how the store behaves when the file on disk is not what anyone
 * hoped for.
 *
 * The digest is the whole content-addressing guarantee, so its edges are
 * pinned here rather than left to the end-to-end tests: an ordering rule that
 * quietly stopped holding would turn "this approval covers these exact
 * contents" into "this approval covers whatever `readdir` returned first".
 */

import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveArcturnPaths } from "./paths.js";
import {
  collectProjectCodeSurface,
  lookupTrustRecord,
  PROJECT_TRUST_VERSION,
  projectCodeRefusalWarning,
  projectSurfaceBlob,
  projectSurfaceDigest,
  readProjectTrustStore,
  renderProjectTrustPrompt,
  revokeProjectTrust,
  sanitizeForTerminal,
  trustedProjectMatches,
  writeProjectTrustDecision,
} from "./project-trust.js";
import { makeScratch, writeFileAt } from "./test-helpers/scratch.js";

/** A merged config carrying only what the surface collector reads. */
function config(overrides: Record<string, unknown> = {}): never {
  return {
    hooks: { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] },
    ...overrides,
  } as never;
}

/** Surface of a scratch tree, with the project layer's paths resolved. */
async function surfaceOf(scratch: Awaited<ReturnType<typeof makeScratch>>, cfg = config()) {
  const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
  return collectProjectCodeSurface({ paths, config: cfg });
}

describe("projectSurfaceDigest", () => {
  it("is stable across calls and versioned", () => {
    const input = {
      hooks: [{ event: "sessionStart" as const, command: "echo hi" }],
      extensionFiles: [{ path: "index.ts", hash: "sha256:aa" }],
      mcpServers: [],
    };
    expect(projectSurfaceDigest(input)).toBe(projectSurfaceDigest(input));
    expect(projectSurfaceBlob(input).split("\n")[0]).toBe(`v${PROJECT_TRUST_VERSION}`);
    expect(projectSurfaceDigest(input)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not depend on the order entries arrive in", () => {
    const hooks = [
      { event: "sessionStart" as const, command: "a" },
      { event: "preToolUse" as const, command: "b", matcher: "bash" },
    ];
    const files = [
      { path: "b.ts", hash: "sha256:2" },
      { path: "a.ts", hash: "sha256:1" },
    ];
    const servers = [
      { transport: "stdio" as const, name: "z", command: "node", args: ["z.js"], env: [] },
      { transport: "stdio" as const, name: "a", command: "node", args: ["a.js"], env: ["K=v"] },
      { transport: "http" as const, name: "r", url: "https://b.test", headers: ["A: 1"] },
      { transport: "http" as const, name: "q", url: "https://a.test", headers: [] },
    ];
    const one = projectSurfaceDigest({
      hooks,
      extensionFiles: files,
      mcpServers: servers,
    });
    const other = projectSurfaceDigest({
      hooks: [...hooks].reverse(),
      extensionFiles: [...files].reverse(),
      mcpServers: [...servers].reverse(),
    });
    expect(other).toBe(one);
  });

  it("cannot be forged by a value that contains the field separator's neighbours", () => {
    // Fields are `\0`-separated, which no shell command or filename can
    // contain, so no single value can impersonate two.
    const a = projectSurfaceDigest({
      hooks: [{ event: "sessionStart", command: "echo a", matcher: "b" }],
      extensionFiles: [],
      mcpServers: [],
    });
    const b = projectSurfaceDigest({
      hooks: [{ event: "sessionStart", command: "echo a b" }],
      extensionFiles: [],
      mcpServers: [],
    });
    expect(a).not.toBe(b);
  });
});

describe("collectProjectCodeSurface", () => {
  it("hashes a NESTED extension file, not only the entry point", async () => {
    const scratch = await makeScratch();
    const dir = join(scratch.cwd, ".arcturn", "extensions", "pack");
    await writeFileAt(join(dir, "index.ts"), "import './helper.js';\nexport default () => {};\n");
    await writeFileAt(join(dir, "helper.ts"), "export const x = 1;\n");
    const before = await surfaceOf(scratch);
    // `discoverExtensionFiles` would only ever return `pack/index.ts`. The
    // helper is what `index.ts` imports, so a change to it changes what runs.
    expect(before.extensionFiles.map((file) => file.path)).toEqual([
      "pack/helper.ts",
      "pack/index.ts",
    ]);

    await writeFileAt(join(dir, "helper.ts"), "export const x = 2; // now hostile\n");
    const after = await surfaceOf(scratch);
    expect(after.digest).not.toBe(before.digest);
  });

  it("hashes a dotfile and an underscore file the loader would skip", async () => {
    // `discoverExtensionFiles` skips both, but `index.ts` can still import them.
    const scratch = await makeScratch();
    const dir = join(scratch.cwd, ".arcturn", "extensions");
    await writeFileAt(join(dir, "index.ts"), "export default () => {};\n");
    const before = await surfaceOf(scratch);
    await writeFileAt(join(dir, "_payload.ts"), "export const p = 1;\n");
    const after = await surfaceOf(scratch);
    expect(after.digest).not.toBe(before.digest);
    expect(after.extensionFiles.map((file) => file.path)).toContain("_payload.ts");
  });

  it("records a symlink by its target string and never follows it", async () => {
    const scratch = await makeScratch();
    const dir = join(scratch.cwd, ".arcturn", "extensions");
    await writeFileAt(join(dir, "keep.ts"), "export default () => {};\n");
    const outside = join(scratch.root, "outside.ts");
    await writeFile(outside, "export default () => {};\n", "utf8");
    await symlink(outside, join(dir, "link.ts"));

    const surface = await surfaceOf(scratch);
    const link = surface.extensionFiles.find((file) => file.path === "link.ts");
    expect(link?.hash).toBe(`symlink:${outside}`);
    // Following it would have hashed the bytes instead, and would have let a
    // link into a directory outside the checkout drive the walk.
    expect(link?.hash.startsWith("sha256:")).toBe(false);

    // Re-pointing the link is a change even though no hashed byte moved:
    // `link.ts` now runs a different file, so the approval must not carry.
    const other = join(scratch.root, "other.ts");
    await writeFile(other, "export default () => { /* different */ };\n", "utf8");
    await unlink(join(dir, "link.ts"));
    await symlink(other, join(dir, "link.ts"));
    expect((await surfaceOf(scratch)).digest).not.toBe(surface.digest);
  });

  it("ignores project DATA — skills, agents, memory, ARCTURN.md, and the config's model", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "extensions", "index.ts"),
      "export default () => {};\n",
    );
    const before = await surfaceOf(scratch);

    await writeFileAt(join(scratch.cwd, "README.md"), "# hi\n");
    await writeFileAt(join(scratch.cwd, "src", "app.ts"), "export const a = 1;\n");
    await writeFileAt(join(scratch.cwd, ".arcturn", "skills", "s.md"), "# skill\n");
    await writeFileAt(join(scratch.cwd, ".arcturn", "agents", "a.md"), "# agent\n");
    await writeFileAt(join(scratch.cwd, ".arcturn", "memory", "m.md"), "# memory\n");
    await writeFileAt(join(scratch.cwd, "ARCTURN.md"), "# repo notes\n");

    const after = await surfaceOf(scratch, config({ model: "anthropic/claude-haiku-4-5" }));
    // A gate that re-asks for a README edit gets clicked through. This is the
    // no-noise property, and it is a security property.
    expect(after.digest).toBe(before.digest);
  });

  it("counts and digests only PROJECT-scoped hooks and verify", async () => {
    const scratch = await makeScratch();
    const withUserHook = await surfaceOf(
      scratch,
      config({
        hooks: {
          preToolUse: [],
          postToolUse: [],
          sessionStart: [{ command: "user-hook", scope: "user" }],
          runEnd: [],
        },
        verify: { command: "user-verify", scope: "user", runOn: "edit" },
      }),
    );
    expect(withUserHook.empty).toBe(true);
    expect(withUserHook.counts).toEqual({ hook: 0, verify: 0, extension: 0, mcp: 0 });

    const withProjectHook = await surfaceOf(
      scratch,
      config({
        hooks: {
          preToolUse: [],
          postToolUse: [],
          sessionStart: [{ command: "project-hook", scope: "project" }],
          runEnd: [],
        },
      }),
    );
    expect(withProjectHook.counts.hook).toBe(1);
    expect(withProjectHook.empty).toBe(false);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the `${…}` spelling is the fixture.
  it("reads BOTH transports without expanding ${ENV}", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "mcp.json"),
      JSON.stringify({
        servers: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: mcp.json's own env syntax.
          spawner: { type: "stdio", command: "node", args: ["s.js"], env: { K: "${HOME}" } },
          // An `http` entry is not a process on this machine and is covered
          // anyway: its tool names and descriptions become model input, and
          // its arguments become egress. See the module doc.
          // biome-ignore lint/suspicious/noTemplateCurlyInString: mcp.json's own env syntax.
          remote: { type: "http", url: "https://example.test", headers: { A: "${TOKEN}" } },
        },
      }),
    );
    const surface = await surfaceOf(scratch);
    expect(surface.counts.mcp).toBe(2);
    const spawner = surface.mcpServers.find((server) => server.name === "spawner");
    const remote = surface.mcpServers.find((server) => server.name === "remote");
    // Verbatim: expanding it would put the user's environment into a digest,
    // and `loadMcpConfig` throws outright on an unset variable — a hostile
    // repo could otherwise crash the gate that judges it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal output.
    expect(spawner?.transport === "stdio" && spawner.env).toEqual(["K=${HOME}"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal output.
    expect(remote?.transport === "http" && remote.headers).toEqual(["A: ${TOKEN}"]);
  });

  it("changes the digest when a server's transport flips at the same name", async () => {
    const scratch = await makeScratch();
    const file = join(scratch.cwd, ".arcturn", "mcp.json");
    await writeFileAt(
      file,
      JSON.stringify({ servers: { srv: { type: "stdio", command: "node", args: ["s.js"] } } }),
    );
    const asStdio = await surfaceOf(scratch);
    await writeFileAt(
      file,
      JSON.stringify({ servers: { srv: { type: "http", url: "https://example.test" } } }),
    );
    // A grant for "srv spawns node s.js" must not stand in for "srv is egress
    // to a host the repository picked".
    expect((await surfaceOf(scratch)).digest).not.toBe(asStdio.digest);
  });

  it("survives an mcp.json that is not valid JSON", async () => {
    const scratch = await makeScratch();
    await writeFileAt(join(scratch.cwd, ".arcturn", "mcp.json"), "{ not json");
    const surface = await surfaceOf(scratch);
    expect(surface.counts.mcp).toBe(0);
    expect(surface.warnings.join(" ")).toContain("not valid JSON");
  });

  it("gives the same digest to two trees whose files were created in opposite orders", async () => {
    const a = await makeScratch();
    const b = await makeScratch();
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      await writeFileAt(join(a.cwd, ".arcturn", "extensions", name), `// ${name}\n`);
    }
    for (const name of ["c.ts", "b.ts", "a.ts"]) {
      await writeFileAt(join(b.cwd, ".arcturn", "extensions", name), `// ${name}\n`);
    }
    expect((await surfaceOf(b)).digest).toBe((await surfaceOf(a)).digest);
  });
});

describe("the trust store", () => {
  it("round-trips a decision and keeps other projects' records", async () => {
    const scratch = await makeScratch();
    const file = join(scratch.home, "trust.json");
    const record = {
      digest: "sha256:abc",
      decision: "allow" as const,
      decidedAt: "2026-01-01T00:00:00.000Z",
      counts: { hook: 1, verify: 0, extension: 2, mcp: 0 },
    };
    await writeProjectTrustDecision(file, "/one/project", record);
    await writeProjectTrustDecision(file, "/two/project", { ...record, decision: "deny" });

    const store = await readProjectTrustStore(file);
    expect(lookupTrustRecord(store, "/one/project", false)?.decision).toBe("allow");
    expect(lookupTrustRecord(store, "/two/project", false)?.decision).toBe("deny");

    expect(await revokeProjectTrust(file, "/one/project")).toBe(true);
    const after = await readProjectTrustStore(file);
    expect(lookupTrustRecord(after, "/one/project", false)).toBeUndefined();
    expect(lookupTrustRecord(after, "/two/project", false)?.decision).toBe("deny");
    expect(await revokeProjectTrust(file, "/one/project")).toBe(false);
  });

  it("stores counts and never the commands themselves", async () => {
    const scratch = await makeScratch();
    const file = join(scratch.home, "trust.json");
    await writeProjectTrustDecision(file, "/p", {
      digest: "sha256:abc",
      decision: "allow",
      decidedAt: "2026-01-01T00:00:00.000Z",
      counts: { hook: 1, verify: 1, extension: 1, mcp: 1 },
    });
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("sha256:abc");
    // Nothing an attacker wrote is on disk here, so no future reader of this
    // file inherits an obligation to sanitise it.
    expect(raw).not.toContain("command");
  });

  it("reads a missing, corrupt, mistyped or wrong-version file as NO consent", async () => {
    const scratch = await makeScratch();
    const missing = join(scratch.home, "does-not-exist.json");
    expect((await readProjectTrustStore(missing)).size).toBe(0);

    const cases: Record<string, string> = {
      "bad.json": "{ not json at all",
      "array.json": "[]",
      "wrong-version.json": JSON.stringify({
        version: 99,
        projects: { "/p": { digest: "x", decision: "allow" } },
      }),
      "no-projects.json": JSON.stringify({ version: PROJECT_TRUST_VERSION }),
      "bad-decision.json": JSON.stringify({
        version: PROJECT_TRUST_VERSION,
        projects: { "/p": { digest: "x", decision: "maybe" } },
      }),
    };
    for (const [name, body] of Object.entries(cases)) {
      const file = join(scratch.home, name);
      await writeFileAt(file, body);
      // Never a throw, and never an approval.
      const store = await readProjectTrustStore(file);
      expect(lookupTrustRecord(store, "/p", false)).toBeUndefined();
    }
  });
});

describe("trustedProjects patterns", () => {
  it("matches an exact directory and a /* subtree, and nothing else", () => {
    expect(trustedProjectMatches("/work/repo", "/work/repo", false)).toBe(true);
    expect(trustedProjectMatches("/work/repo", "/work/repo2", false)).toBe(false);
    expect(trustedProjectMatches("/work/*", "/work/repo", false)).toBe(true);
    expect(trustedProjectMatches("/work/*", "/work/a/b/c", false)).toBe(true);
    expect(trustedProjectMatches("/work/*", "/work", false)).toBe(true);
    // The prefix must end on a separator, or `/work-other` would ride
    // `/work/*` — the classic string-prefix path bug.
    expect(trustedProjectMatches("/work/*", "/work-other/repo", false)).toBe(false);
    expect(trustedProjectMatches("", "/work/repo", false)).toBe(false);
  });
});

describe("sanitizeForTerminal", () => {
  it("removes every sequence a terminal would obey, leaving the text visible", () => {
    const hostile =
      "\u001b[2J\u001b[1;1Hrm -rf /\r" +
      "\u001b]8;;https://evil.test\u0007label\u001b]8;;\u0007" +
      "\u009b31m\u009d0;title\u0007\u001b(B";
    const clean = sanitizeForTerminal(hostile);
    expect(clean).not.toContain("\u001b");
    expect(clean).not.toContain("\r");
    expect(clean).not.toContain("\u009b");
    expect(clean).not.toContain("\u009d");
    expect(clean).not.toContain("\u0007");
    expect(clean).toContain("rm -rf /");
    expect(clean).toContain("label");
  });

  it("turns a newline into a space rather than deleting it", () => {
    // Deleting would render `rm -rf<LF>/` as `rm -rf/`, a different command.
    expect(sanitizeForTerminal("rm -rf\n/")).toBe("rm -rf /");
  });

  it("leaves ordinary text, including non-ASCII, untouched", () => {
    expect(sanitizeForTerminal("pnpm test — ünïcode ✓")).toBe("pnpm test — ünïcode ✓");
  });
});

describe("projectCodeRefusalWarning", () => {
  it("keeps subject-verb agreement when the project declares exactly one hook", async () => {
    // Regression: with a single hook, describeProjectCodeKinds used the
    // singular noun "hook" but the sentence always ends in the plural verb
    // "are NOT running" — "this project's hook are NOT running" reads as a
    // typo. The noun must agree with the fixed plural verb.
    const scratch = await makeScratch();
    const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: {} });
    const surface = await surfaceOf(
      scratch,
      config({
        hooks: {
          preToolUse: [],
          postToolUse: [],
          sessionStart: [{ command: "./setup.sh", scope: "project" }],
          runEnd: [],
        },
      }),
    );
    const message = projectCodeRefusalWarning(surface, paths, "declined");
    expect(message).toContain("this project's hooks are NOT running.");
    expect(message).not.toContain("hook are NOT running");
  });
});

describe("renderProjectTrustPrompt", () => {
  it("says the pointer limitation out loud", async () => {
    const scratch = await makeScratch();
    const rendered = renderProjectTrustPrompt(
      await surfaceOf(
        scratch,
        config({
          hooks: {
            preToolUse: [],
            postToolUse: [],
            sessionStart: [{ command: "./setup.sh", scope: "project" }],
            runEnd: [],
          },
        }),
      ),
    );
    // The digest covers extension CONTENTS but only a hook's spelling. Saying
    // so is the whole reason there is no best-effort path extraction: a
    // guarantee the prompt implies but does not have is worse than none.
    expect(rendered).toContain("Commands run through your shell");
    expect(rendered).toContain("cannot see");
  });
});
