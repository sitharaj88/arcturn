/**
 * Re-audit of wave 2's *confinement and disclosure* surface, after the fixes.
 *
 * The first audit found that `ask_arcturn` was not confined to `--cwd` at all.
 * The fix is two walls: {@link workspaceConfinementRules}, a subtractive rule
 * set whose floor denies every subject it cannot place inside the workspace,
 * and `guardWorkspacePaths`, a `realpath` check on the path argument of every
 * tool. This file attacks *those*.
 *
 * Three labels, and they are load-bearing:
 *
 * - `FINDING:` — a defect in the tree as it stands. The test asserts the
 *   behaviour the design and `docs/mcp-server.md` claim, and it FAILS.
 *   Deleting one is not a fix.
 * - `CLOSED:` — a route that was tried and is genuinely shut. These pass, and
 *   they exist so nobody spends a second afternoon on a locked door.
 * - `LIMIT:` — a boundary of the design that is real, is not reachable from
 *   the wire, and is recorded so the next change does not make it reachable.
 *   These pass and describe what the wall actually is.
 */

import { link, mkdir, readFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_READ_ONLY_TOOLS, defaultSubject, PermissionEngine } from "@arcturn/core";
import { CodeIndexService } from "@arcturn/index";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpServe, workspaceConfinementRules } from "./mcp-serve.js";
import { type FakeLLM, fakeLLM, type ScriptedTurn } from "./test-helpers/fake-llm.js";
import { makeScratch, type Scratch, writeFileAt } from "./test-helpers/scratch.js";

/** The shipped documentation whose promises these tests hold the code to. */
const MCP_SERVE_DOC = fileURLToPath(
  new URL("../../../web/content/docs/mcp-server.md", import.meta.url),
);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A scratch workspace with something indexable and something confidential. */
async function workspace(): Promise<Scratch> {
  const scratch = await makeScratch();
  await writeFileAt(
    join(scratch.cwd, "src", "ok.ts"),
    "export function harmlessHelper(): number {\n  return 1;\n}\n",
  );
  await writeFileAt(join(scratch.cwd, ".env"), "AWS_SECRET_ACCESS_KEY=sk-live-do-not-leak\n");
  return scratch;
}

/** A private key next to the workspace but outside it. Returns its path. */
async function secretOutside(scratch: Scratch): Promise<string> {
  const outside = join(scratch.root, "outside", "id_rsa");
  await writeFileAt(outside, "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPER-SECRET-KEY\n");
  return outside;
}

interface Peer {
  client: Client;
  llm: FakeLLM;
}

/** Connect a client to a real `mcp-serve` server over an in-memory transport. */
async function connect(
  scratch: Scratch,
  options: { mode?: "plan" | "default" | "acceptEdits"; turns?: readonly ScriptedTurn[] } = {},
): Promise<Peer> {
  const llm = fakeLLM(options.turns ?? [{ text: "done" }]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const handle = await startMcpServe({
    cwd: scratch.cwd,
    home: scratch.home,
    env: scratch.env,
    transport: serverTransport,
    onDiagnostic: () => {},
    onWithheld: () => {},
    ...(options.mode === undefined ? {} : { permissionMode: options.mode, llm }),
  });
  const client = new Client({ name: "reaudit", version: "1.0.0" });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  return { client, llm };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Everything the run put in front of the model.
 *
 * Tool results land in the agent's context, so this is the honest test of
 * whether a boundary held: bytes that reach here are one "and print that
 * verbatim" away from the wire, whatever the scripted final turn says.
 */
function modelSaw(llm: FakeLLM): string {
  return JSON.stringify(llm.requests);
}

// =================================================================== findings

/**
 * The root cause behind every `FINDING` in this block.
 *
 * Both halves of the confinement rule on the path a call *names*:
 * `defaultSubject` picks one of `file_path`/`filePath`/`path`/`target` (or,
 * failing those, `command`/`url`/`pattern`/`query` as opaque text) and the
 * rules match that; `guardWorkspacePaths` calls `realpath` on the same four
 * keys. Neither looks at the arguments that actually decide which files the
 * tool opens.
 *
 * Two built-in tools have such an argument, and both are in
 * {@link DEFAULT_READ_ONLY_TOOLS}, so both are reachable in `plan` — the mode
 * `docs/mcp-server.md` presents as the conservative one:
 *
 * - `grep`'s `glob` is handed to `tinyglobby` with `cwd` set to the workspace,
 *   and `tinyglobby` honours `..` and absolute patterns and follows symlinks.
 *   `grep` then prints the *matching lines of every file it collected*.
 * - `glob`'s `pattern` is the same argument under a different name, and `glob`
 *   prints the paths.
 *
 * `path` is not even required to be present: `defaultSubject`'s key order puts
 * `pattern` after `path`, so a call that omits `path` presents its *pattern*
 * as the subject — and a pattern spelled `<root>/../…` starts with `<root>/`,
 * which is exactly what the confinement's `<root>/**` "ask" rule matches.
 *
 * The docs state the consequence as a table: for `plan`, "Outside `--cwd`:
 * Denied", and "The reachable authority is therefore: the read-only tools
 * inside `--cwd` … Nothing else." These tests assert that sentence.
 */
describe("FINDING: the confinement guards the path a call names, not the files it opens", () => {
  it("FINDING: grep's `glob` reads file bodies outside --cwd in plan mode", async () => {
    // The permission subject is `path: "."` → the workspace root, which the
    // confinement's own `{ tool: "*", specifier: <root>, ask }` matches, so the
    // check falls through to the read-only allow. `guardWorkspacePaths` then
    // realpaths that same "." and is satisfied. `glob` is never looked at by
    // either, and it is the argument that chooses the files.
    //
    // This is F1 reopened. The bytes of a private key outside the workspace are
    // back in the run's context, on the opt-in the docs call conservative, with
    // no symlink and no `..` in any argument the walls inspect.
    const scratch = await workspace();
    await secretOutside(scratch);
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "grep",
              arguments: { pattern: "SECRET", path: ".", glob: "../outside/**/*" },
            },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "find every secret near here" });

    expect(modelSaw(llm)).not.toContain("SUPER-SECRET-KEY");
  });

  it("FINDING: glob's `pattern` enumerates the filesystem outside --cwd", async () => {
    // Reading names is not reading bytes, but it is still "what the server can
    // see", and it is the reconnaissance step for everything else: one call
    // with `pattern: "../../../**/*"` maps the operator's home.
    const scratch = await workspace();
    await secretOutside(scratch);
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "glob", arguments: { path: ".", pattern: "../outside/**/*" } },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "list what is around here" });

    expect(modelSaw(llm)).not.toContain("id_rsa");
  });

  it("FINDING: a pattern spelled `<root>/..` satisfies the rule wall on its own", async () => {
    // Worth its own test because it breaks the *rule* wall rather than the
    // physical one, and it needs no `path` argument at all. With `path` absent,
    // `defaultSubject` falls to `pattern` — which it does NOT resolve, because
    // `pattern` is not in its path-key set. So the subject is the literal
    // string `<root>/../outside/*`, and `globToRegExp("<root>/**")` compiles to
    // `^<root>/.*$`, which that string matches. The confinement's own "inside
    // the workspace" rule is what lets it through.
    const scratch = await workspace();
    await secretOutside(scratch);
    const root = resolve(scratch.cwd);
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [
        {
          toolCalls: [{ id: "c1", name: "glob", arguments: { pattern: `${root}/../outside/*` } }],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "look around" });

    expect(modelSaw(llm)).not.toContain("id_rsa");
  });

  it("FINDING: grep follows the checked-in symlink the physical wall exists to catch", async () => {
    // `guardWorkspacePaths`'s own doc comment names this scenario: "`read
    // { path: "vendor/notes" }` where `vendor` links at the operator's home
    // presents a subject squarely inside the workspace and reads bytes squarely
    // outside it. `ln -s "$HOME" vendor` is one command, and a repository can
    // check one in."
    //
    // For `read` the guard catches it (mcp-serve.test.ts proves that). For
    // `grep` the guard inspects `path: "."` and waves the call through, and
    // `tinyglobby` follows the link with its default `followSymbolicLinks`.
    // Nothing in this call names the link: `**/*` finds it.
    const scratch = await workspace();
    await secretOutside(scratch);
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "grep",
              arguments: { pattern: "SUPER-SECRET", path: ".", glob: "**/*" },
            },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "audit this repo for keys" });

    expect(modelSaw(llm)).not.toContain("SUPER-SECRET-KEY");
  });
});

describe("FINDING: the credential filter is a property of one tool, not of the pipe", () => {
  it("FINDING: search_code refuses .env and ask_arcturn hands it over on the same connection", async () => {
    // `WITHHOLDING_NOTICE` is printed on every `search_code` result and says
    // "Credential-shaped paths (dotenv files, private keys, SSH and cloud
    // credential stores) are never disclosed over MCP." Over MCP — not "by this
    // tool". The docs repeat it: "Credential-shaped files never come back from
    // `search_code`, whatever the query."
    //
    // `ask_arcturn` is the same server, the same pipe and the same peer, and
    // `.env` is inside `--cwd`, so the confinement has no opinion about it and
    // `read` is allowed at the read-only step in `plan`. The question
    // `sensitive-paths.ts` exists to refuse is answered in full by the adjacent
    // tool, and nothing on the path filters an agent's tool results.
    const scratch = await workspace();
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "read", arguments: { path: ".env" } }] },
        { text: "done" },
      ],
    });

    // The read-only surface is as advertised: it will not say what is in .env.
    const searched = textOf(await call(client, "search_code", { query: "AWS_SECRET_ACCESS_KEY" }));
    expect(searched).not.toContain("sk-live-do-not-leak");
    expect(searched).toContain("never disclosed over MCP");

    // The agent surface, one tool call later, on the same connection.
    await call(client, "ask_arcturn", { prompt: "what is in the env file" });
    expect(modelSaw(llm)).not.toContain("sk-live-do-not-leak");
  });
});

describe("FINDING: the shipped docs still promise the withheld count that was removed", () => {
  it("FINDING: mcp-server.md tells operators a filtered hit shows as `1 result withheld`", async () => {
    // The per-query count was deliberately deleted: it moved with the query, so
    // it answered "is this string in your .env?" one guess at a time. The page
    // that documents the filter was not updated, and still tells the operator
    // that a false positive "shows up as `1 result withheld` rather than as a
    // mysteriously missing symbol" — which is now exactly what it shows up as,
    // because the real numbers go to `onWithheld` and stop there.
    //
    // Not a boundary defect. It is a defect in what an operator will believe
    // about their own workspace, which is the whole reason the notice exists.
    const doc = await readFile(MCP_SERVE_DOC, "utf8");
    // Control: the page still documents the filter, so this is drift and not a
    // missing section.
    expect(doc).toContain("Credential-shaped files never come back from `search_code`");
    // The two sentences that are now false on the wire.
    expect(doc).not.toMatch(/`1 result withheld`/);
    expect(doc).not.toMatch(/and \*counted\*/);
  });
});

// ============================================================== closed routes

describe("CLOSED: the path-argument tools stay inside the workspace", () => {
  it("refuses a write whose not-yet-existing leaf hangs under a symlinked parent", async () => {
    // The interesting half of `physicalPath`: the leaf cannot be a symlink if
    // it does not exist, so the walk climbs to the nearest ancestor that does,
    // resolves that, and puts the tail back. `vendor/` is the ancestor and it
    // points out of the workspace, so the not-yet-created file is placed
    // outside and refused before anything is written.
    const scratch = await workspace();
    await mkdir(join(scratch.root, "outside"), { recursive: true });
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    const { client } = await connect(scratch, {
      mode: "acceptEdits",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "write",
              arguments: { path: "vendor/nested/brand-new.txt", content: "pwned" },
            },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "write it" });

    await expect(
      readFile(join(scratch.root, "outside", "nested", "brand-new.txt")),
    ).rejects.toThrow();
  });

  it("refuses `ls` and `read` however the escape is spelled", async () => {
    // A sweep rather than one case, because each spelling is refused by a
    // different half: `..` by the resolved subject, the absolute path by the
    // rules, the symlink by `realpath`, and the doubled-back path by both.
    const scratch = await workspace();
    const outside = await secretOutside(scratch);
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "read", arguments: { path: "../outside/id_rsa" } },
            { id: "c2", name: "read", arguments: { path: outside } },
            { id: "c3", name: "read", arguments: { path: "vendor/id_rsa" } },
            { id: "c4", name: "read", arguments: { path: "src/../../outside/id_rsa" } },
            { id: "c5", name: "ls", arguments: { path: "../outside" } },
            { id: "c6", name: "ls", arguments: { path: "vendor" } },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "try every spelling" });

    const seen = modelSaw(llm);
    expect(seen).not.toContain("SUPER-SECRET-KEY");
    expect(seen).not.toContain("id_rsa\\n");
    expect(seen).toContain("not inside this server's workspace");
  });
});

describe("CLOSED: a tool whose path argument has another name reaches the floor deny", () => {
  it("denies every argument shape the confinement cannot place, in every mode", async () => {
    // The safe direction, and it is worth a test because it is the reason the
    // `grep`/`glob` finding above is a *seam* rather than a policy: an
    // unrecognised argument name yields an empty subject, which matches only
    // `{ tool: "*", specifier: "*", deny }`. That covers the runtime's own
    // `memory` (`slug`/`title`/`content`), `skill` (`name`/`args`) and
    // `subagent` (`task`/`agent`), and any MCP or extension tool that names its
    // destination something the engine has never heard of.
    const scratch = await makeScratch();
    const root = resolve(scratch.cwd);
    const shapes: Record<string, Record<string, unknown>> = {
      memory: { action: "write", slug: "../../../../../../etc/cron.d/x", content: "pwned" },
      skill: { name: "anything", args: "/Users/me/.ssh" },
      mcp__files__put: { destination: "/Users/me/.zshrc", body: "pwned" },
      ext__deploy: { dir: "/", recursive: true },
    };
    for (const mode of ["plan", "default", "acceptEdits", "yolo"] as const) {
      const engine = new PermissionEngine({ mode, rules: workspaceConfinementRules(root) });
      for (const [tool, input] of Object.entries(shapes)) {
        const subject = defaultSubject(tool, input, root);
        expect(subject, `${tool} in ${mode}`).toBe("");
        const decision = await engine.check({
          toolName: tool,
          toolCallId: `t-${tool}-${mode}`,
          subject,
          description: `${tool} with an unrecognised path argument`,
        });
        expect(decision.behavior, `${tool} in ${mode}`).toBe("deny");
      }
    }
  });

  it("keeps denying the four unboundable tools under an inherited blanket allow", async () => {
    // `bash`/`fetch`/`websearch`/`subagent` are the complete set of built-ins
    // whose subject is not a path: `createDefaultTools` ships nine tools and the
    // other five (`read`/`write`/`edit`/`grep`/`glob`/`ls` minus the overlap)
    // all take `path`. The runtime adds `search_code`, `todo`, `plan`,
    // `memory`, `subagent` and `skill`; `todo` and `plan` are pure state, and
    // the rest reach the floor deny by the test above.
    const scratch = await makeScratch();
    const root = resolve(scratch.cwd);
    const inherited = [
      { tool: "bash", specifier: "*", action: "allow" as const, scope: "session" as const },
      { tool: "*", specifier: "*", action: "allow" as const, scope: "session" as const },
      { tool: "fetch", specifier: "*", action: "allow" as const, scope: "session" as const },
    ];
    // The four are exactly the built-ins that are NOT read-only, minus the
    // three `acceptEdits` edit tools — i.e. the list has no gap against the
    // shipped tool set. Written as an assertion so a tenth built-in cannot be
    // added without this failing.
    expect([...DEFAULT_READ_ONLY_TOOLS].sort()).toEqual(["glob", "grep", "ls", "read"]);

    const engine = new PermissionEngine({
      mode: "yolo",
      rules: workspaceConfinementRules(root, inherited),
    });
    for (const tool of ["bash", "fetch", "websearch", "subagent"]) {
      const decision = await engine.check({
        toolName: tool,
        toolCallId: `t-${tool}`,
        subject: tool === "bash" ? "cat ~/.ssh/id_rsa" : "https://exfil.example/x",
        description: `${tool} under a blanket inherited allow`,
      });
      expect(decision.behavior, tool).toBe("deny");
    }
  });

  it("really does drop an inherited allow that names anywhere but the workspace", async () => {
    const scratch = await makeScratch();
    const root = resolve(scratch.cwd);
    const rules = workspaceConfinementRules(root, [
      { tool: "read", specifier: "/Users/me/**", action: "allow", scope: "user" },
      { tool: "read", specifier: join(root, "src", "**"), action: "allow", scope: "user" },
      { tool: "write", specifier: "**/*.env", action: "deny", scope: "user" },
    ]);
    expect(rules.some((rule) => rule.specifier === "/Users/me/**")).toBe(false);
    expect(rules.some((rule) => rule.specifier === join(root, "src", "**"))).toBe(true);
    // Every deny survives, re-scoped to the nearest scope so nothing outranks it.
    const kept = rules.find((rule) => rule.specifier === "**/*.env");
    expect(kept?.action).toBe("deny");
    expect(kept?.scope).toBe("session");
  });
});

describe("CLOSED: `escapesWorkspace`'s prefix test is lexical, and it does not matter", () => {
  it("keeps an allow spelled `<root>/../..` but the kept rule matches nothing", async () => {
    // A near miss worth writing down. `escapesWorkspace` decides with
    // `specifier.startsWith(root + sep)` and never normalizes, so
    // `allow read "<root>/../../.ssh/**"` in a checked-in config IS inherited
    // by a confined run — the one permissive rule that gets past the filter.
    //
    // It is inert anyway: rule specifiers are never resolved either, and
    // `globToRegExp` treats `..` as two literal dots, while `defaultSubject`
    // hands the engine an already-resolved subject that can never contain one.
    // The rule matches no reachable subject, so the escape needs BOTH halves to
    // start normalizing — which is the note for whoever fixes the prefix test.
    const scratch = await makeScratch();
    const root = resolve(scratch.cwd);
    const smuggled = `${root}/../../.ssh/**`;
    const rules = workspaceConfinementRules(root, [
      { tool: "read", specifier: smuggled, action: "allow", scope: "session" },
    ]);
    expect(rules.some((rule) => rule.specifier === smuggled)).toBe(true);

    const engine = new PermissionEngine({ mode: "plan", rules });
    const target = resolve(root, "..", "..", ".ssh", "id_rsa");
    const decision = await engine.check({
      toolName: "read",
      toolCallId: "t1",
      subject: defaultSubject("read", { path: target }, root),
      description: "read through the smuggled allow",
    });
    expect(decision.behavior).toBe("deny");
  });
});

describe("CLOSED: the always-on read-only surface stays inside --cwd", () => {
  it("does not index through a symlinked directory", async () => {
    // The read-only default needs no permission mode at all, so if the code
    // index walked a symlink the peer would get addresses (and, for a parsed
    // file, snippets) from outside the workspace with no opt-in whatsoever.
    // The walker uses `readdir(..., { withFileTypes: true })` and tests
    // `isDirectory()`/`isFile()`, both of which are false for a symlink, so the
    // link is skipped rather than followed.
    const scratch = await workspace();
    await writeFileAt(
      join(scratch.root, "outside", "leaky.ts"),
      "export function uniqueOutsideSymbol(): number {\n  return 42;\n}\n",
    );
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    const { client } = await connect(scratch);

    const text = textOf(await call(client, "search_code", { query: "uniqueOutsideSymbol" }));
    expect(text).not.toContain("leaky.ts");
    expect(text).toContain("No matches");

    // Positive control: the same query shape finds a file that really is inside.
    expect(textOf(await call(client, "search_code", { query: "harmlessHelper" }))).toContain(
      "src/ok.ts",
    );
  });

  it("says the same thing about withholding whichever query is asked", async () => {
    // The oracle the constant notice replaced. Three queries — one that only a
    // credential file answers, one that nothing answers, and one that a public
    // file answers — and the trailing notice is byte-identical in all three, so
    // nothing about the workspace modulates it.
    const scratch = await workspace();
    const { client } = await connect(scratch);
    const notice = (text: string): string => text.slice(text.indexOf("Credential-shaped paths"));

    const inEnv = textOf(await call(client, "search_code", { query: "sk-live-do-not-leak" }));
    const nowhere = textOf(await call(client, "search_code", { query: "zzqqxx-not-present" }));
    const public_ = textOf(await call(client, "search_code", { query: "harmlessHelper" }));

    expect(notice(inEnv)).toBe(notice(nowhere));
    expect(notice(public_)).toBe(notice(nowhere));
    // The only thing separating the first two answers is the echoed query.
    expect(inEnv.replace("sk-live-do-not-leak", "Q")).toBe(
      nowhere.replace("zzqqxx-not-present", "Q"),
    );
    expect(inEnv).not.toMatch(/\d+ results? withheld/);
    expect(inEnv).not.toMatch(/\d+ of \d+/);
  });

  it("keeps a credential hit from displacing a legitimate one at limit 1", async () => {
    // The over-fetch-and-refill fix, exercised at the smallest page there is:
    // `limit: 1` with a `.env` that outranks the public file must still return
    // the public file, or the empty page is itself the disclosure.
    const scratch = await makeScratch();
    await writeFileAt(join(scratch.cwd, ".env"), "SHAREDTOKEN=aaa\nSHAREDTOKEN_TWO=bbb\n");
    await writeFileAt(
      join(scratch.cwd, "src", "uses.ts"),
      "export function readSHAREDTOKEN(): string {\n  return process.env.SHAREDTOKEN ?? '';\n}\n",
    );
    const { client } = await connect(scratch);
    const text = textOf(await call(client, "search_code", { query: "SHAREDTOKEN", limit: 1 }));
    expect(text).toContain("src/uses.ts");
    expect(text).not.toContain(".env");
  });
});

describe("CLOSED: nothing replaces the guarded toolset after it is installed", () => {
  it("holds on a later turn of the same run and on a second call on the connection", async () => {
    // `fixedToolset: true` is what keeps a deferred toolset from replacing the
    // wrapped list every turn. The property that matters downstream is simply
    // "the guard is still there on turn N and on run 2", so that is what this
    // asserts rather than the flag: five turns, each a fresh escape attempt,
    // across two `ask_arcturn` calls on one connection.
    const scratch = await workspace();
    const outside = await secretOutside(scratch);
    const attempt = (id: string): ScriptedTurn => ({
      toolCalls: [{ id, name: "read", arguments: { path: outside } }],
    });
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [attempt("c1"), attempt("c2"), attempt("c3"), attempt("c4"), { text: "gave up" }],
    });
    await call(client, "ask_arcturn", { prompt: "keep trying" });
    await call(client, "ask_arcturn", { prompt: "keep trying again" });

    expect(modelSaw(llm)).not.toContain("SUPER-SECRET-KEY");
    // The wall was hit repeatedly rather than hit once and then forgotten.
    const refusals = modelSaw(llm).split("not inside this server's workspace").length - 1;
    expect(refusals).toBeGreaterThan(1);
  });
});

describe("LIMIT: the concurrency latch tracks the run, not the request", () => {
  it("a cancelled request frees the latch only once its run settles", async () => {
    // The latch moved inside its `try` so a construction failure clears it. A
    // cancellation is the other way to strand it, and the answer is "no, but
    // not instantly": `signal` fires `agent.abort()`, and the `finally` that
    // clears `busy` cannot run until `agent.prompt()` settles — which is a
    // property of the provider stream, not of this module. So a peer that
    // cancels and retries in the same breath is told "already working", with no
    // response to its cancelled call to tell it otherwise (MCP cancellation is
    // fire-and-forget). The connection does recover on its own, which is the
    // part that matters and the part this asserts.
    const scratch = await workspace();
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [{ text: "first", delayMs: 400 }, { text: "second" }],
    });
    const controller = new AbortController();
    const cancelled = client
      .callTool({ name: "ask_arcturn", arguments: { prompt: "slow one" } }, undefined, {
        signal: controller.signal,
      })
      .catch(() => undefined);
    // Cancel only once the run is genuinely in flight — otherwise the second
    // call below could simply be racing a run that had already finished, and
    // the latch would never have been under test at all.
    while (llm.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await cancelled;

    // Immediately after the cancellation the run is still unwinding.
    const immediate = await call(client, "ask_arcturn", { prompt: "right away" });
    expect(textOf(immediate)).toContain("already working on a prompt");

    // And it does unwind: the latch is not stranded for the connection's life,
    // which was the failure mode the `finally` was moved outwards to prevent.
    const deadline = Date.now() + 5_000;
    let recovered = "";
    while (Date.now() < deadline) {
      recovered = textOf(await call(client, "ask_arcturn", { prompt: "the next one" }));
      if (!recovered.includes("already working on a prompt")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(recovered).not.toContain("already working on a prompt");
  });
});

// ======================================================== recorded limitations

describe("LIMIT: the physical wall resolves names, so it is a symlink wall", () => {
  it("a hard link inside the workspace is read, and nothing on the wire can make one", async () => {
    // Stated rather than filed as a finding. `realpath` answers "what name does
    // this name lead to", and a hard link is not a second name for a directory
    // entry — it is a second directory entry for one inode, with nothing to
    // resolve. So a hard link inside `--cwd` pointing at a file outside it is
    // read, and no amount of `realpath` would have caught it.
    //
    // It is unreachable from the wire, which is why it is a `LIMIT`: `git` does
    // not carry hard links, `bash` is denied by rule, and the only mutating
    // tools the peer can reach (`write`/`edit`) create ordinary files. Somebody
    // who can already run `ln` on the operator's machine did not need this.
    const scratch = await workspace();
    const outside = await secretOutside(scratch);
    await link(outside, join(scratch.cwd, "notes.txt"));
    const { client, llm } = await connect(scratch, {
      mode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "read", arguments: { path: "notes.txt" } }] },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "read the notes" });

    // Documented, not asserted away: this is what the wall does today.
    expect(modelSaw(llm)).toContain("SUPER-SECRET-KEY");
  });
});

describe('LIMIT: `detail: "snippets"` is per chunk, and chunks tile a parsed file', () => {
  it("reassembles four lines of every declaration in one file across hits", async () => {
    // `LIMITS.snippetLines` is documented as "an excerpt at any file length,
    // and the window never slides, so no number of calls widens it". True per
    // chunk. Across chunks it is a strided sample: the chunker emits one chunk
    // per declaration, so a file of N short declarations yields N excerpts that
    // together cover most of it.
    //
    // Recorded rather than filed because the two things this actually protects
    // still hold: a credential-shaped path is withheld outright, and a file the
    // index cannot parse is one whole-file chunk, which is returned as an
    // address and never a body. What leaks is ordinary parsed source, which the
    // read-only surface exists to describe.
    const scratch = await makeScratch();
    const body = Array.from(
      { length: 6 },
      (_, i) => `export function tiledSymbol${i}(): string {\n  return "piece-${i}";\n}\n`,
    ).join("\n");
    await writeFileAt(join(scratch.cwd, "src", "tiled.ts"), body);
    const { client } = await connect(scratch);

    const text = textOf(
      await call(client, "search_code", { query: "tiledSymbol", detail: "snippets", limit: 20 }),
    );
    const recovered = Array.from({ length: 6 }, (_, i) => `piece-${i}`).filter((piece) =>
      text.includes(piece),
    );
    expect(recovered.length).toBeGreaterThan(3);
  });

  it("still returns a whole-file chunk as an address and never as a body", async () => {
    // The half of that design that is load-bearing, kept under test here so a
    // future widening of the snippet window cannot quietly take it with it.
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, "settings.conf"),
      "listen = 0.0.0.0\nadmin_password = hunter2-not-credential-shaped\n",
    );
    const { client } = await connect(scratch);
    const text = textOf(
      await call(client, "search_code", { query: "admin_password", detail: "snippets" }),
    );
    expect(text).toContain("settings.conf");
    expect(text).not.toContain("hunter2-not-credential-shaped");
    expect(text).toContain("address only");
  });
});

describe("CLOSED: the index service is per workspace root", () => {
  it("cannot be pointed anywhere but --cwd from the wire", async () => {
    // Belt and braces on the read-only surface: the root is captured from the
    // operator's own `--cwd` at construction, the `path` argument is only ever a
    // filter, and the protocol layer refuses a filter carrying `..`, a leading
    // separator or a drive letter before the host is called at all.
    const scratch = await workspace();
    const { client } = await connect(scratch);
    for (const path of ["../outside", "/etc", "C:\\Windows", "src/../../outside", "\\\\srv"]) {
      const result = await call(client, "search_code", { query: "id_rsa", path });
      expect(result.isError, path).toBe(true);
    }
    // And the service itself takes the root as an argument, so there is no
    // ambient default a request could shift.
    expect(new CodeIndexService({ indexRoot: join(scratch.home, "index") })).toBeDefined();
  });
});
