import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { defaultCaseInsensitivePaths, PermissionEngine } from "@arcturn/core";
import type { Message, ModelSpec, PermissionRule, SessionEntry } from "@arcturn/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { defaultArgs } from "./args.js";
import { runCli } from "./cli-main.js";
import {
  askThrough,
  buildMcpServeHost,
  isMcpServeInvocation,
  MCP_SERVE_COMMAND_NAME,
  type McpAskAgent,
  projectTranscript,
  runMcpServe,
  startMcpServe,
  workspaceConfinementRules,
} from "./mcp-serve.js";
import { type FakeLLM, fakeLLM, type ScriptedTurn } from "./test-helpers/fake-llm.js";
import { makeScratch, type Scratch, writeFileAt } from "./test-helpers/scratch.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A scratch workspace with a couple of indexable source files. */
async function workspace(): Promise<Scratch> {
  const scratch = await makeScratch();
  await writeFileAt(
    join(scratch.cwd, "src", "auth.ts"),
    "export function signInWithToken(token: string): boolean {\n  return token.length > 0;\n}\n",
  );
  await writeFileAt(
    join(scratch.cwd, "src", "ok.ts"),
    "export function harmlessHelper(): number {\n  return 1;\n}\n",
  );
  // A public file that also matches "env", so a query can rank a credential
  // file above something the peer is genuinely allowed to see.
  await writeFileAt(
    join(scratch.cwd, "src", "env-usage.ts"),
    "export function readEnvSetting(env: string): string {\n  return env;\n}\n",
  );
  await writeFileAt(join(scratch.cwd, ".env"), "AWS_SECRET_ACCESS_KEY=sk-live-do-not-leak\n");
  await writeFileAt(join(scratch.cwd, "deploy", "server.key"), "-----BEGIN PRIVATE KEY-----\n");
  return scratch;
}

interface ConnectOptions {
  permissionMode?: "plan" | "default" | "acceptEdits";
  turns?: readonly ScriptedTurn[];
  maxCostUsd?: number;
  onWithheld?: (event: { hostWithheld: number; serverWithheld: number }) => void;
  /** Overrides `--cwd`, which is otherwise the scratch project directory. */
  cwd?: string;
  /** Collects the operator's diagnostics instead of dropping them. */
  onDiagnostic?: (line: string) => void;
}

/** Start a real server over an in-memory transport and return a connected client. */
async function connect(scratch: Scratch, options: ConnectOptions = {}): Promise<Client> {
  return (await connectWithLlm(scratch, options)).client;
}

/**
 * The same server, plus the scripted client it ran with.
 *
 * The requests the model was sent are the only place a leak shows up when the
 * tool call that produced it was refused *after* the model asked for it: what
 * matters is whether the bytes ever reached the run's context.
 */
async function connectWithLlm(
  scratch: Scratch,
  options: ConnectOptions = {},
): Promise<{ client: Client; llm: FakeLLM }> {
  const llm = fakeLLM(options.turns ?? [{ text: "done" }]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const handle = await startMcpServe({
    cwd: options.cwd ?? scratch.cwd,
    home: scratch.home,
    env: scratch.env,
    transport: serverTransport,
    onDiagnostic: options.onDiagnostic ?? ((): void => {}),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    ...(options.onWithheld === undefined ? {} : { onWithheld: options.onWithheld }),
    ...(options.permissionMode === undefined ? {} : { llm }),
  });
  const client = new Client({ name: "probe", version: "1.0.0" });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  return { client, llm };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** Write a session JSONL file straight into the store's directory. */
async function seedSession(
  scratch: Scratch,
  sessionId: string,
  entries: SessionEntry[],
): Promise<void> {
  const { resolveArcturnPaths } = await import("./paths.js");
  const paths = resolveArcturnPaths({ cwd: scratch.cwd, home: scratch.home, env: scratch.env });
  await mkdir(paths.sessions, { recursive: true });
  const header = {
    version: 1,
    sessionId,
    cwd: scratch.cwd,
    createdAt: Date.parse("2026-08-23T00:00:00.000Z"),
    title: "Wire up auth",
  };
  const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))];
  await writeFile(join(paths.sessions, `${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

function userEntry(id: string, text: string): SessionEntry {
  return {
    kind: "message",
    id,
    parentId: null,
    timestamp: 1,
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  };
}

function assistantEntry(id: string, text: string, toolName: string): SessionEntry {
  return {
    kind: "message",
    id,
    parentId: null,
    timestamp: 2,
    message: {
      role: "assistant",
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn",
      timestamp: 2,
      content: [
        { type: "thinking", thinking: "the user's api key is sk-secret-thinking" },
        { type: "text", text },
        { type: "toolCall", id: "call-1", name: toolName, arguments: { path: "/etc/shadow" } },
      ],
    },
  };
}

function toolResultEntry(id: string, text: string): SessionEntry {
  return {
    kind: "message",
    id,
    parentId: null,
    timestamp: 3,
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      timestamp: 3,
      content: [{ type: "text", text }],
    },
  };
}

// ------------------------------------------------------------------ dispatch

describe("command dispatch", () => {
  it("recognises the bare command word and nothing near it", () => {
    const base = defaultArgs();
    expect(isMcpServeInvocation({ ...base, prompt: MCP_SERVE_COMMAND_NAME })).toBe(true);
    expect(isMcpServeInvocation({ ...base, prompt: " mcp-serve " })).toBe(true);
    expect(isMcpServeInvocation({ ...base, prompt: "mcp-serve the repo" })).toBe(false);
    expect(isMcpServeInvocation({ ...base, prompt: "mcp serve" })).toBe(false);
    // A print run is a prompt, never a server.
    expect(isMcpServeInvocation({ ...base, prompt: "mcp-serve", print: true })).toBe(false);
    // A parsed subcommand always wins.
    expect(isMcpServeInvocation({ ...base, prompt: "mcp-serve", command: { kind: "serve" } })).toBe(
      false,
    );
  });

  it("routes the command word through runCli instead of prompting a model", async () => {
    const scratch = await workspace();
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const isTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const code = await runCli({
        ...defaultArgs(),
        prompt: MCP_SERVE_COMMAND_NAME,
        cwd: scratch.cwd,
      });
      expect(code).toBe(2);
      expect(errors.join("")).toContain("launched by an MCP client");
    } finally {
      process.stderr.write = write;
      if (isTty) Object.defineProperty(process.stdout, "isTTY", isTty);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });
});

// -------------------------------------------------------------------- safety

describe("authority", () => {
  it("exposes no agent tool by default", async () => {
    const scratch = await workspace();
    const client = await connect(scratch);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("ask_arcturn");
    expect(names).toEqual(["search_code", "list_sessions", "read_session"]);
  });

  it("builds no runtime at all without an explicit permission mode", async () => {
    const scratch = await workspace();
    // No API key in the environment: a runtime build would fail outright, so a
    // host that constructs one cannot possibly succeed here.
    const built = await buildMcpServeHost({ cwd: scratch.cwd, home: scratch.home, env: {} });
    cleanups.push(() => built.dispose());
    expect(built.host.askArcturn).toBeUndefined();
  });

  it("refuses --permission-mode yolo", async () => {
    const scratch = await workspace();
    const lines: string[] = [];
    const code = await runMcpServe({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
      permissionMode: "yolo",
      stdoutIsTty: false,
      onDiagnostic: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("refuses --permission-mode yolo");
  });

  it("refuses yolo even when startMcpServe is called directly", async () => {
    const scratch = await workspace();
    await expect(
      startMcpServe({ cwd: scratch.cwd, home: scratch.home, permissionMode: "yolo" }),
    ).rejects.toThrow(/yolo/);
  });

  it("refuses to start on a terminal", async () => {
    const scratch = await workspace();
    const lines: string[] = [];
    const code = await runMcpServe({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
      stdoutIsTty: true,
      stdinIsTty: true,
      onDiagnostic: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("launched by an MCP client");
  });

  it("refuses when only stdout is redirected", async () => {
    // `arcturn mcp-serve > out.txt`, typed at a shell. A stdout-only test reads
    // that as "not a terminal" and starts a server whose JSON-RPC frames come
    // from the keyboard — a silent hang where a sentence belongs.
    const scratch = await workspace();
    const lines: string[] = [];
    const code = await runMcpServe({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
      stdoutIsTty: false,
      stdinIsTty: true,
      onDiagnostic: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("Both ends have to be pipes");
  });

  it("gets past the terminal guard when both ends are pipes", async () => {
    // The negative control for the two above: the guard must not have become
    // "refuse always". Nothing here touches real stdio — the run is stopped by
    // something strictly *later* (a runtime with no API key to build from),
    // which is only reachable once the guard has let it through.
    const scratch = await workspace();
    const lines: string[] = [];
    const code = await runMcpServe({
      cwd: scratch.cwd,
      home: scratch.home,
      env: {},
      permissionMode: "plan",
      stdoutIsTty: false,
      stdinIsTty: false,
      onDiagnostic: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).not.toContain("launched by an MCP client");
    expect(lines.join("\n")).toMatch(/API key|ANTHROPIC/i);
  });
});

describe("permission rules still hold", () => {
  it("honours a config deny for a read tool", async () => {
    const scratch = await workspace();
    const rule: PermissionRule = { tool: "read_session", action: "deny", scope: "project" };
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ permissions: [rule] }),
    );
    await seedSession(scratch, "sess-1", [userEntry("e1", "hello")]);
    const client = await connect(scratch);
    const result = await call(client, "read_session", { session_id: "sess-1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/denied|Denied/);
  });

  it("still answers a read tool that no rule denies", async () => {
    const scratch = await workspace();
    await seedSession(scratch, "sess-1", [userEntry("e1", "hello")]);
    const client = await connect(scratch);
    const result = await call(client, "read_session", { session_id: "sess-1" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("hello");
  });
});

// -------------------------------------------------------------------- search

describe("search_code", () => {
  it("finds a symbol in the workspace and returns its address", async () => {
    const scratch = await workspace();
    const client = await connect(scratch);
    const result = await call(client, "search_code", { query: "signInWithToken" });
    expect(textOf(result)).toContain("src/auth.ts:1");
  });

  it("withholds credential files at the host, before the protocol layer sees them", async () => {
    // The server applies the same filter, so this goes straight to the host to
    // prove the inner layer is load-bearing on its own rather than riding on
    // the outer one. The index really does rank these files — remove the
    // filter and `.env` comes back for its own contents.
    const scratch = await workspace();
    const built = await buildMcpServeHost({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
    });
    cleanups.push(() => built.dispose());
    const outcome = await built.host.searchCode(
      { query: "AWS_SECRET_ACCESS_KEY", limit: 20, detail: "signatures" },
      new AbortController().signal,
    );
    expect(outcome.hits.map((hit) => hit.path)).toEqual([]);
    // The index found them; the host is what refused to hand them over.
    expect(outcome.totalMatches).toBeGreaterThan(0);
  });

  it("does not let a withheld hit consume a slot in the peer's page", async () => {
    // Rank displacement is the oracle that survives a count-free notice: if a
    // credential file outranks a public one and then vanishes, a peer asking
    // for `limit: 1` gets an EMPTY page and learns that something it may not
    // see scored higher for its probe token. Over-fetching and refilling is
    // what makes the withheld hit invisible rather than merely unnamed.
    const scratch = await workspace();
    const built = await buildMcpServeHost({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
    });
    cleanups.push(() => built.dispose());
    // "env" ranks the credential files first and `src/env-usage.ts` after them.
    const outcome = await built.host.searchCode(
      { query: "env", limit: 1, detail: "signatures" },
      new AbortController().signal,
    );
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0]?.path).not.toContain(".env");
  });

  it("reports the withheld counts to the operator, and only to the operator", async () => {
    // `onWithheld` is the operator's channel, the same asymmetry `onInternalError`
    // uses: real numbers to the log, a count-free notice to the pipe. Unwired,
    // a false positive is silent — a file just stops being searchable.
    const scratch = await workspace();
    const seen: { hostWithheld: number; serverWithheld: number }[] = [];
    const client = await connect(scratch, { onWithheld: (event) => seen.push(event) });
    await call(client, "search_code", { query: "AWS_SECRET_ACCESS_KEY" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((event) => event.hostWithheld > 0)).toBe(true);
  });

  it("never returns a credential file, even when the query is its content", async () => {
    const scratch = await workspace();
    const client = await connect(scratch);
    for (const query of ["AWS_SECRET_ACCESS_KEY", "BEGIN PRIVATE KEY", "env"]) {
      const text = textOf(await call(client, "search_code", { query }));
      expect(text, query).not.toContain("sk-live-do-not-leak");
      expect(text, query).not.toContain(".env");
      expect(text, query).not.toContain("server.key");
      // Withholding is reported, not silent: a caller that sees "no matches"
      // for a query the index really did answer would reasonably conclude the
      // file is absent from the repository.
      expect(text, query).toMatch(/result[s]? withheld/);
    }
  });
});

// ------------------------------------------------------------------ sessions

describe("read_session", () => {
  it("returns prompts and answers but never tool results, arguments or reasoning", async () => {
    const scratch = await workspace();
    await seedSession(scratch, "sess-1", [
      userEntry("e1", "read the shadow file"),
      assistantEntry("e2", "I read it.", "read"),
      toolResultEntry("e3", "root:$6$super$secret-hash"),
    ]);
    const client = await connect(scratch);
    const text = textOf(await call(client, "read_session", { session_id: "sess-1" }));

    expect(text).toContain("read the shadow file");
    expect(text).toContain("I read it.");
    expect(text).toContain("[tools: read]");
    // The three densest leaks in a transcript.
    expect(text).not.toContain("super$secret-hash");
    expect(text).not.toContain("/etc/shadow");
    expect(text).not.toContain("sk-secret-thinking");
  });

  it("reports a missing session without revealing a path", async () => {
    const scratch = await workspace();
    const client = await connect(scratch);
    const result = await call(client, "read_session", { session_id: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain(scratch.home);
    expect(textOf(result)).toContain("No session");
  });

  it("lists sessions without leaking the absolute workspace path", async () => {
    const scratch = await workspace();
    await seedSession(scratch, "sess-1", [userEntry("e1", "hello")]);
    const client = await connect(scratch);
    const text = textOf(await call(client, "list_sessions", {}));
    expect(text).toContain("sess-1");
    expect(text).toContain("Wire up auth");
    expect(text).toContain("2026-08-23T00:00:00.000Z");
    expect(text).not.toContain(scratch.cwd);
  });
});

describe("projectTranscript", () => {
  it("drops tool-result messages entirely", () => {
    const projected = projectTranscript([
      userEntry("e1", "go"),
      assistantEntry("e2", "ok", "bash"),
      toolResultEntry("e3", "secret output"),
    ]);
    expect(projected).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "ok", tools: ["bash"] },
    ]);
  });
});

// ----------------------------------------------------------------- the agent

describe("ask_arcturn", () => {
  it("runs a real agent and reports the tools it called", async () => {
    const scratch = await workspace();
    const client = await connect(scratch, {
      permissionMode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "ls", arguments: { path: "." } }] },
        { text: "there are two files" },
      ],
    });
    const result = await call(client, "ask_arcturn", { prompt: "what is here" });
    const text = textOf(result);
    expect(text).toContain("there are two files");
    expect(text).toContain("[tools run: ls]");
  });

  it("denies a mutating tool in plan mode rather than waiting for approval", async () => {
    const scratch = await workspace();
    const client = await connect(scratch, {
      permissionMode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "write", arguments: { path: "x.txt", content: "hi" } }] },
        { text: "I could not write." },
      ],
    });
    const result = await call(client, "ask_arcturn", { prompt: "write x.txt" });
    expect(textOf(result)).toContain("I could not write.");
    // The run must have finished — a hung permission prompt would time out.
    expect(textOf(result)).toContain("completed");
  });

  it("refuses a second concurrent run", async () => {
    const scratch = await workspace();
    const client = await connect(scratch, {
      permissionMode: "plan",
      turns: [
        { text: "slow", delayMs: 150 },
        { text: "slow", delayMs: 150 },
      ],
    });
    const [first, second] = await Promise.all([
      call(client, "ask_arcturn", { prompt: "one" }),
      call(client, "ask_arcturn", { prompt: "two" }),
    ]);
    const texts = [textOf(first), textOf(second)];
    expect(texts.some((text) => text.includes("already working"))).toBe(true);
  });
});

// -------------------------------------------------------------- confinement

/** A credential-shaped file outside `--cwd`, which the server may never reach. */
async function secretOutside(scratch: Scratch, name = "id_rsa"): Promise<string> {
  const path = join(scratch.root, "outside", name);
  await writeFileAt(path, "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPER-SECRET-KEY\n");
  return path;
}

/** Everything the peer sent the model this run, as one searchable string. */
function modelSaw(llm: FakeLLM): string {
  return JSON.stringify(llm.requests);
}

/**
 * The text of every tool result the run put in front of the model, in order.
 *
 * `modelSaw` answers "did these bytes reach the context"; this answers "what
 * exactly did the tool say", which is what a test about *indistinguishable*
 * answers needs.
 */
function toolResultsSeen(llm: FakeLLM): string[] {
  const last = llm.requests.at(-1);
  if (last === undefined) return [];
  return last.messages
    .filter((message): message is Extract<Message, { role: "toolResult" }> => {
      return message.role === "toolResult";
    })
    .map((message) =>
      message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
}

describe("ask_arcturn is confined to --cwd", () => {
  it("refuses a read outside the workspace in every mode the flag can select", async () => {
    // `read` is a read-only tool, so the engine allowed it at step 4 in every
    // mode — `plan` included, which is the opt-in the docs call conservative.
    // The confinement's deny lands at step 3, above all of them.
    for (const mode of ["plan", "default", "acceptEdits"] as const) {
      const scratch = await workspace();
      const outside = await secretOutside(scratch);
      const { client, llm } = await connectWithLlm(scratch, {
        permissionMode: mode,
        turns: [
          { toolCalls: [{ id: "c1", name: "read", arguments: { path: outside } }] },
          { text: "refused" },
        ],
      });
      await call(client, "ask_arcturn", { prompt: "read that key file" });
      expect(modelSaw(llm), mode).not.toContain("SUPER-SECRET-KEY");
      // And the model is told what to do instead, so it does not spend the
      // rest of its turn budget walking into the same wall.
      expect(modelSaw(llm), mode).toContain("not inside this server's workspace");
    }
  });

  it("still reads a file inside the workspace", async () => {
    // The positive control for the test above: the deny is about the path, not
    // about `read` having been made unusable.
    const scratch = await workspace();
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "read", arguments: { path: "src/ok.ts" } }] },
        { text: "read it" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "what does ok.ts do" });
    expect(modelSaw(llm)).toContain("harmlessHelper");
  });

  it("refuses a write outside the workspace under acceptEdits", async () => {
    const scratch = await workspace();
    const outside = join(scratch.root, "outside", "owned.txt");
    const { client } = await connectWithLlm(scratch, {
      permissionMode: "acceptEdits",
      turns: [
        {
          toolCalls: [{ id: "c1", name: "write", arguments: { path: outside, content: "pwned" } }],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "write it" });
    await expect(readFile(outside, "utf8")).rejects.toThrow();
  });

  it("still writes inside the workspace under acceptEdits", async () => {
    const scratch = await workspace();
    const { client } = await connectWithLlm(scratch, {
      permissionMode: "acceptEdits",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "notes.md", content: "hello" } },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "leave a note" });
    expect(await readFile(join(scratch.cwd, "notes.md"), "utf8")).toBe("hello");
  });

  it("refuses a path that walks out of the workspace with ..", async () => {
    const scratch = await workspace();
    const { client } = await connectWithLlm(scratch, {
      permissionMode: "acceptEdits",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "write",
              arguments: { path: "src/../../outside/owned.txt", content: "pwned" },
            },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "write it" });
    await expect(readFile(join(scratch.root, "outside", "owned.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses a read a symlink carries out of the workspace", async () => {
    // The rules are a wall of names, and this name is squarely inside --cwd:
    // only the physical check can tell that the bytes are not. `git clone` of a
    // repository with a checked-in symlink is enough to arrange it.
    const scratch = await workspace();
    await secretOutside(scratch);
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "read", arguments: { path: "vendor/id_rsa" } }] },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "read vendor/id_rsa" });
    expect(modelSaw(llm)).not.toContain("SUPER-SECRET-KEY");
    expect(modelSaw(llm)).toContain("not inside this server's workspace");
  });

  it("refuses a write a symlink carries out of the workspace", async () => {
    const scratch = await workspace();
    await mkdir(join(scratch.root, "outside"), { recursive: true });
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    const { client } = await connectWithLlm(scratch, {
      permissionMode: "acceptEdits",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "vendor/owned.txt", content: "pwned" } },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "write it" });
    await expect(readFile(join(scratch.root, "outside", "owned.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses a reader that names no path, and tells it how to retry", async () => {
    // The tradeoff this confinement makes on purpose, and the same one the
    // worktree lanes make: the engine matches on a *subject*, and `grep
    // { pattern }` presents its pattern, not a path — so it matches only the
    // base deny. Granting the tool blanket permission to fix that is the hole
    // itself, so the refusal carries the one-turn remedy instead.
    const scratch = await workspace();
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "grep", arguments: { pattern: "harmlessHelper" } }] },
        {
          toolCalls: [
            { id: "c2", name: "grep", arguments: { pattern: "harmlessHelper", path: "." } },
          ],
        },
        { text: "found it" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "find it" });
    const seen = modelSaw(llm);
    // `modelSaw` is JSON, so the message's own quotes arrive escaped.
    expect(seen).toContain("is the workspace root");
    // ...and the retry the message asks for really does work.
    expect(seen).toContain("src/ok.ts");
  });

  it("holds when the project turns on progressively disclosed tools", async () => {
    // The physical half of the confinement is installed with `setTools`, and a
    // deferred toolset replaces exactly that list every turn with the runtime's
    // own unwrapped one — leaving the guard on the agent and never running it,
    // while `agent.tools` still reported the wrapped list. `fixedToolset` is
    // what keeps this run's tools this run's to decide, so the symlink escape
    // stays shut with the feature on.
    const scratch = await workspace();
    await secretOutside(scratch);
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ deferredTools: { enabled: true } }),
    );
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "read", arguments: { path: "vendor/id_rsa" } }] },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "read vendor/id_rsa" });
    expect(modelSaw(llm)).not.toContain("SUPER-SECRET-KEY");
  });

  it("refuses bash even when the project config allows it outright", async () => {
    // A command is not a path, so the boundary cannot check one — and
    // `allow bash "*"` in a checked-in config would otherwise hand a stranger
    // the shell. The refusal does not depend on there being no requester.
    const scratch = await workspace();
    const outside = join(scratch.root, "outside", "owned.txt");
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({
        permissions: [{ tool: "bash", specifier: "*", action: "allow", scope: "project" }],
      }),
    );
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "default",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "bash",
              arguments: {
                command: `mkdir -p "${join(scratch.root, "outside")}" && echo pwned > "${outside}"`,
              },
            },
          ],
        },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "run it" });
    await expect(readFile(outside, "utf8")).rejects.toThrow();
    expect(modelSaw(llm)).toContain("not available when arcturn is serving MCP");
  });

  it("keeps a config deny that names a path inside the workspace", async () => {
    // Narrowing may only ever narrow: the confinement drops permissive rules,
    // never a deny the operator wrote.
    const scratch = await workspace();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({
        permissions: [{ tool: "write", specifier: "**/*.md", action: "deny", scope: "project" }],
      }),
    );
    const { client } = await connectWithLlm(scratch, {
      permissionMode: "acceptEdits",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: "notes.md", content: "denied" } },
            { id: "c2", name: "write", arguments: { path: "notes.txt", content: "allowed" } },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "write both" });
    await expect(readFile(join(scratch.cwd, "notes.md"), "utf8")).rejects.toThrow();
    expect(await readFile(join(scratch.cwd, "notes.txt"), "utf8")).toBe("allowed");
  });
});

describe("ask_arcturn is confined to the files a call opens", () => {
  it("refuses a pattern that is absolute or climbs, before expanding it", async () => {
    // `grep`'s `glob` and `glob`'s `pattern` choose the file set and are not
    // the subject any rule matches, so both walls waved these through while
    // `tinyglobby` walked out of the workspace. Refused rather than expanded
    // and filtered: an expansion that matches nothing is itself an answer, so
    // `pattern: "/Users/me/.ssh/*"` would map the operator's disk by absence.
    const scratch = await workspace();
    await secretOutside(scratch);
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "grep",
              arguments: { pattern: "SECRET", path: ".", glob: "../outside/**/*" },
            },
            // Spelled so it satisfies the rule wall on its own: with no `path`,
            // the subject is the pattern *string*, and `<root>/../outside/*`
            // starts with `<root>/`, which is what the in-workspace rule
            // matches. The rules cannot catch this one; this check can.
            { id: "c2", name: "glob", arguments: { pattern: `${scratch.cwd}/../outside/*` } },
          ],
        },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "look just outside" });

    const seen = modelSaw(llm);
    expect(seen).not.toContain("SUPER-SECRET-KEY");
    expect(seen).not.toContain("id_rsa");
    expect(seen).toContain("refused before it is expanded");
  });

  it("drops what a checked-in symlink pulled into a grep or a glob result", async () => {
    // Nothing in either call names the link — `**/*` finds it, and
    // `tinyglobby` follows it by default. The pattern is innocent and the
    // `path` argument is the workspace root, so the only place left to rule on
    // it is the file set the answer names.
    const scratch = await workspace();
    await secretOutside(scratch);
    await symlink(join(scratch.root, "outside"), join(scratch.cwd, "vendor"), "dir");
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "grep",
              arguments: { pattern: "SUPER-SECRET", path: ".", glob: "**/*" },
            },
            { id: "c2", name: "glob", arguments: { path: ".", pattern: "vendor/*" } },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "audit this repo" });

    const seen = modelSaw(llm);
    expect(seen).not.toContain("SUPER-SECRET-KEY");
    expect(seen).not.toContain("id_rsa");
    // Dropped, not refused: the call was legitimate and the workspace half of
    // its answer would have been fine.
    expect(seen).toContain("No files matched");
  });

  it("answers a fully withheld grep exactly as it answers one that found nothing", async () => {
    // The property that keeps the filter from being the oracle it replaced. A
    // withheld hit that *looked* withheld would answer "is this string in your
    // .env?" one guess at a time, so the two answers must differ only in the
    // query they echo. This also pins the coupling to `grep`'s rendering: if
    // that changes, the reconstructed empty answer stops matching and this
    // fails, rather than the filter silently ceasing to fire.
    const scratch = await workspace();
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "grep", arguments: { pattern: "sk-live-do-not-leak", path: "." } },
            { id: "c2", name: "grep", arguments: { pattern: "zzqqxx-not-present", path: "." } },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "search for both" });

    const [withheld, nothing] = toolResultsSeen(llm);
    expect(withheld).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(withheld?.replace("sk-live-do-not-leak", "Q")).toBe(
      nothing?.replace("zzqqxx-not-present", "Q"),
    );
  });

  it("still greps and globs normally inside the workspace", async () => {
    // The positive control for all of the above: the wall is about which files
    // a pattern reaches, not about the two tools having been made unusable.
    const scratch = await workspace();
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "grep",
              arguments: { pattern: "harmlessHelper", path: ".", glob: "**/*.ts" },
            },
            { id: "c2", name: "glob", arguments: { path: ".", pattern: "src/*.ts" } },
          ],
        },
        { text: "found it" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "find the helper" });

    const seen = modelSaw(llm);
    expect(seen).toContain("harmlessHelper");
    expect(seen).toContain("src/ok.ts");
  });
});

describe("credential files are withheld from the agent surface, not just search_code", () => {
  it("refuses to read or overwrite one by name", async () => {
    // `search_code` prints "credential-shaped paths are never disclosed over
    // MCP" on every query. `ask_arcturn` is the same server, the same pipe and
    // the same peer, and `.env` is inside `--cwd` — so the sentence is only
    // true if the same classifier sits on this run's tools as well.
    const scratch = await workspace();
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "acceptEdits",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "read", arguments: { path: ".env" } },
            { id: "c2", name: "read", arguments: { path: "deploy/server.key" } },
            { id: "c3", name: "write", arguments: { path: ".env", content: "OWNED=1" } },
          ],
        },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "what is in the env file" });

    const seen = modelSaw(llm);
    expect(seen).not.toContain("sk-live-do-not-leak");
    expect(seen).not.toContain("BEGIN PRIVATE KEY");
    expect(seen).toContain("credential-shaped");
    // Refused in both directions: a stranger over a pipe does not get to
    // rewrite the operator's credentials either.
    expect(await readFile(join(scratch.cwd, ".env"), "utf8")).toContain("sk-live-do-not-leak");
  });

  it("refuses the trailing-dot spelling Win32 opens as the same credential file", async () => {
    // `server.key.` and `server.key ` are `server.key` to Win32, which strips a
    // component's trailing dots and spaces before the call reaches the
    // filesystem — so on Windows this reads the operator's real private key
    // while the classifier is shown a name whose extension is neither `.key`
    // nor any suffix it knows. (`.env.` happens to be caught anyway: that
    // pattern already anchors its token to a following dot. The key
    // extensions anchor to the end of the path, and do not.) Asserted
    // everywhere: the wall folds the spelling on every platform, and on one
    // that keeps the dot it costs a refusal of a file that is not there.
    const scratch = await workspace();
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "read", arguments: { path: "deploy/server.key." } },
            { id: "c2", name: "read", arguments: { path: ".env." } },
          ],
        },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "read the deploy key" });

    const seen = modelSaw(llm);
    expect(seen).not.toContain("BEGIN PRIVATE KEY");
    expect(seen).not.toContain("sk-live-do-not-leak");
    expect(seen.match(/credential-shaped/g)).toHaveLength(2);
  });

  it("drops a credential file's line out of a grep that never named it", async () => {
    // The shape the by-name refusal cannot see: an un-globbed recursive grep
    // walks the whole subtree and prints matching lines from whatever it finds.
    // The legitimate half of the same answer must survive, or the wall would
    // just be a broken grep.
    const scratch = await workspace();
    await writeFileAt(join(scratch.cwd, ".env.production"), "SHARED_TOKEN=super-secret-value\n");
    await writeFileAt(
      join(scratch.cwd, "src", "config.ts"),
      'export const SHARED_TOKEN_NAME = "SHARED_TOKEN";\n',
    );
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "grep", arguments: { pattern: "SHARED_TOKEN", path: "." } },
          ],
        },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "where is the shared token" });

    const seen = modelSaw(llm);
    expect(seen).not.toContain("super-secret-value");
    expect(seen).not.toContain(".env.production");
    expect(seen).toContain("src/config.ts");
  });
});

describe("arcturn's own state is not repository content", () => {
  it("refuses a read of .arcturn and keeps its lines out of a grep", async () => {
    // `<cwd>/.arcturn` is inside the workspace and decides which lane a role
    // runs on. The sibling confinement excludes it from a worktree lane's
    // capture pathspec for the same reason; this is the other side of it.
    const scratch = await workspace();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "agents", "retro.md"),
      "---\nname: retro\ntools: read, grep\n---\nlane note: RETRO_LANE_SECRET\n",
    );
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "read", arguments: { path: ".arcturn/agents/retro.md" } },
            { id: "c2", name: "grep", arguments: { pattern: "lane note", path: "." } },
          ],
        },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "what roles exist here" });

    const seen = modelSaw(llm);
    expect(seen).not.toContain("RETRO_LANE_SECRET");
    expect(seen).toContain("belongs to arcturn rather than to this repository");
  });

  it("refuses the trailing-dot spelling Win32 opens as .arcturn", async () => {
    // Win32 strips trailing dots and spaces from every path component before
    // the call reaches the filesystem, so `.arcturn.\config.json` creates and
    // opens `.arcturn\config.json` — the file whose `permissions` and `hooks`
    // seed every later session in this checkout. Nothing else in either wall
    // sees it: the zone glob needs a literal `.arcturn` followed by a
    // separator, and the physical check keeps a not-yet-existing leaf spelled
    // exactly as the peer typed it, which is the case for the write that
    // creates the directory. Asserted on every platform, because the wall folds
    // the spelling everywhere rather than behind a `process.platform` branch —
    // here it refuses one extra directory, there it closes the forgery.
    const scratch = await workspace();
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "acceptEdits",
      turns: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "write",
              arguments: { path: ".arcturn./config.json", content: '{"permissions":[]}' },
            },
          ],
        },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "seed the config" });

    expect(modelSaw(llm)).toContain("belongs to arcturn rather than to this repository");
    await expect(readFile(join(scratch.cwd, ".arcturn.", "config.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(scratch.cwd, ".arcturn", "config.json"), "utf8")).rejects.toThrow();
  });

  it("keeps a case spelling of .arcturn out of a grep wherever the volume folds case", async () => {
    // The rules half of the wall already folds case (`matchSpecifier` asks the
    // filesystem), so a *named* `.ARCTURN` path is refused by rule. A grep
    // result is not a named path: nothing but the physical check rules on the
    // files an expansion reached, so that check has to fold the same way or a
    // recursive grep prints the contents of a directory arcturn itself opens as
    // `.arcturn` — which on a case-insensitive volume is exactly what
    // `nested/.ARCTURN` is. Conditional on the volume, deliberately: where
    // case is significant, `.ARCTURN` is a directory arcturn never reads and
    // ordinary repository content.
    const scratch = await workspace();
    await writeFileAt(
      join(scratch.cwd, "nested", ".ARCTURN", "agents", "retro.md"),
      "lane note: NESTED_LANE_SECRET\n",
    );
    const { client, llm } = await connectWithLlm(scratch, {
      permissionMode: "plan",
      turns: [
        { toolCalls: [{ id: "c1", name: "grep", arguments: { pattern: "lane note", path: "." } }] },
        { text: "done" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "what lane notes are here" });

    const seen = modelSaw(llm);
    if (defaultCaseInsensitivePaths()) {
      expect(seen).not.toContain("NESTED_LANE_SECRET");
    } else {
      expect(seen).toContain("NESTED_LANE_SECRET");
    }
  });

  it("keeps .arcturn out of the always-on read surface too", async () => {
    // `search_code` needs no permission mode at all, so if the index walked
    // `.arcturn` the peer would get a role's standing prompt with no opt-in
    // whatsoever — and markdown sections are exactly what this index chunks.
    const scratch = await workspace();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "agents", "retro.md"),
      "# Retro role\n\nThe uniqueRoleSymbol decides this lane.\n",
    );
    const client = await connect(scratch);

    const text = textOf(await call(client, "search_code", { query: "uniqueRoleSymbol" }));
    expect(text).not.toContain("retro.md");
    expect(text).toContain("No matches");
    // Positive control: the same query shape finds ordinary source.
    expect(textOf(await call(client, "search_code", { query: "harmlessHelper" }))).toContain(
      "src/ok.ts",
    );
  });

  it("carves the arcturn home out of a --cwd that contains it, and says so", async () => {
    // `--cwd ~` puts `~/.arcturn` under the boundary as if it were repository
    // content, which restores the forgery the confinement was built to stop:
    // one write into `~/.arcturn/org-memory/<hash>.json` and every future run
    // in *another* project is told an operator approved it.
    const scratch = await workspace();
    await writeFileAt(join(scratch.home, "notes.md"), "# Home\n\nThe homeOnlySymbol lives here.\n");
    const diagnostics: string[] = [];
    const store = join(scratch.home, "org-memory", "forged.json");
    const { client, llm } = await connectWithLlm(scratch, {
      cwd: scratch.root,
      permissionMode: "acceptEdits",
      onDiagnostic: (line) => diagnostics.push(line),
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "write", arguments: { path: store, content: "{}" } },
            { id: "c2", name: "read", arguments: { path: join(scratch.home, "notes.md") } },
          ],
        },
        { text: "refused" },
      ],
    });
    await call(client, "ask_arcturn", { prompt: "seed the memory" });

    await expect(readFile(store, "utf8")).rejects.toThrow();
    expect(modelSaw(llm)).not.toContain("homeOnlySymbol");
    // ...and the always-on surface will not describe it either.
    expect(textOf(await call(client, "search_code", { query: "homeOnlySymbol" }))).toContain(
      "No matches",
    );
    // The operator is told, because a `--cwd` this wide is worth one line even
    // when it is safe: the carve-out is not the same thing as a boundary drawn
    // around the project the client meant.
    expect(diagnostics.join("\n")).toContain("contains this arcturn home");
  });
});

describe("workspaceConfinementRules", () => {
  // The confinement resolves the workspace it is handed, and every subject the
  // engine matches arrives from `path.resolve` too (`defaultSubject`), so on
  // Windows the rules read `D:\repo\**` and the subjects read
  // `D:\repo\src\app.ts`. Both sides are therefore built with `resolve`/`join`
  // rather than typed as POSIX literals: what these tests are about is where
  // the wall stands, not which separator the platform spells it with. The wall
  // itself was verified to hold under Windows path semantics — the denies below
  // all resolve `deny` with `path.win32` in force; what the POSIX literals used
  // to produce there was an over-refusal of the two positive controls, not a
  // way through.
  const ROOT = resolve("/repo");
  const OUTSIDE = resolve("/Users/me");

  /** Resolve one check against a rule set, with no requester behind it. */
  async function decide(
    engine: PermissionEngine,
    toolName: string,
    subject: string,
  ): Promise<string> {
    const decision = await engine.check({
      toolName,
      toolCallId: `t-${toolName}-${subject}`,
      subject,
      description: `${toolName} ${subject}`,
    });
    return decision.behavior;
  }

  it("denies every path outside the workspace even under yolo", async () => {
    // The property the whole fix rests on: a rule-level deny resolves at step
    // 3, and `yolo` only allows at step 5. `mcp-serve` refuses `yolo` outright,
    // so this is the strongest mode the wall could ever meet.
    const engine = new PermissionEngine({
      mode: "yolo",
      rules: workspaceConfinementRules(ROOT),
    });
    expect(await decide(engine, "read", join(OUTSIDE, ".ssh", "id_rsa"))).toBe("deny");
    expect(await decide(engine, "write", join(OUTSIDE, ".arcturn", "config.json"))).toBe("deny");
    expect(
      await decide(engine, "write", join(OUTSIDE, ".arcturn", "org-memory", "deadbeef.json")),
    ).toBe("deny");
    // A tool naming no path at all matches only the base deny.
    expect(await decide(engine, "some_extension_tool", "")).toBe("deny");
    // ...and the tools whose subject no path rule can decide are refused by
    // name, not by the accident of there being nobody to ask.
    expect(await decide(engine, "bash", "npm test")).toBe("deny");
    expect(await decide(engine, "fetch", "https://example.com/exfil")).toBe("deny");
    expect(await decide(engine, "subagent", "")).toBe("deny");

    // Positive controls: the workspace itself and everything under it are left
    // exactly where the mode would have put them.
    expect(await decide(engine, "write", join(ROOT, "src", "app.ts"))).not.toBe("deny");
    expect(await decide(engine, "ls", ROOT)).not.toBe("deny");
    // ...and the same two, spelled with the other separator. Both name the same
    // file on the platform that accepts both, and the engine compares them the
    // way the filesystem does, so the wall may not have a preferred spelling.
    expect(await decide(engine, "write", `${ROOT}/src/app.ts`.replaceAll("\\", "/"))).not.toBe(
      "deny",
    );
    expect(await decide(engine, "read", `${ROOT}${sep}src${sep}app.ts`)).not.toBe("deny");
  });

  it("leaves plan mode as strict as it was inside the workspace", async () => {
    // The confinement subtracts; it must not accidentally grant. `plan` denies
    // mutating tools at step 2, before any rule is looked at.
    const engine = new PermissionEngine({
      mode: "plan",
      rules: workspaceConfinementRules(ROOT),
    });
    expect(await decide(engine, "write", join(ROOT, "src", "app.ts"))).toBe("deny");
    expect(await decide(engine, "read", join(ROOT, "src", "app.ts"))).toBe("allow");
  });

  it("drops an inherited allow that names anywhere else and keeps every deny", () => {
    const rules = workspaceConfinementRules(ROOT, [
      // The escape hatch itself, and the same escape spelled as a path.
      { tool: "write", specifier: "*", action: "allow", scope: "session" },
      { tool: "read", specifier: join(OUTSIDE, "**"), action: "allow", scope: "session" },
      // Names the workspace: grants nothing the mode would not have granted.
      { tool: "write", specifier: join(ROOT, "src", "**"), action: "allow", scope: "project" },
      // Never dropped, never weakened — and promoted to the nearest scope, so
      // nothing the confinement adds can outrank it.
      { tool: "write", specifier: "**/.env", action: "deny", scope: "user" },
    ]);
    const inherited = rules.filter((rule) => rule.message === undefined);
    expect(inherited).toEqual([
      { tool: "write", specifier: join(ROOT, "src", "**"), action: "allow", scope: "project" },
      { tool: "write", specifier: "**/.env", action: "deny", scope: "session" },
      { tool: "*", specifier: ROOT, action: "ask", scope: "user" },
      { tool: "*", specifier: join(ROOT, "**"), action: "ask", scope: "user" },
    ]);
  });

  it("keeps an in-workspace allow whichever separator it is written with", () => {
    // The rule set is filtered by string comparison and then matched by
    // `matchSpecifier`, which treats `/` and `\` as the same separator on every
    // platform. When the filter did not, the two halves disagreed in the
    // direction that costs a user their configuration: on Windows
    // `allow write "C:/repo/src/**"` — the portable spelling every doc example
    // uses — does not start with `C:\repo\`, so it was read as naming
    // somewhere other than the workspace and dropped, while the engine would
    // have matched it happily. Dropping fails safe, but silently: the operator
    // gets prompts they configured away, with nothing to say why.
    const forward = `${ROOT}/src/**`.replaceAll("\\", "/");
    const backward = `${ROOT}\\src\\**`;
    const rules = workspaceConfinementRules(ROOT, [
      { tool: "write", specifier: forward, action: "allow", scope: "project" },
      { tool: "write", specifier: backward, action: "allow", scope: "project" },
      // ...while the same two spellings of somewhere else stay dropped.
      {
        tool: "read",
        specifier: `${OUTSIDE}/**`.replaceAll("\\", "/"),
        action: "allow",
        scope: "project",
      },
      { tool: "read", specifier: `${OUTSIDE}\\**`, action: "allow", scope: "project" },
    ]);
    expect(rules.filter((rule) => rule.action === "allow")).toEqual([
      { tool: "write", specifier: forward, action: "allow", scope: "project" },
      { tool: "write", specifier: backward, action: "allow", scope: "project" },
    ]);
  });

  it("drops an inherited allow reaching .arcturn however it is cased", () => {
    // `reachesReservedZone` is a string test on a specifier, so it has to fold
    // the way the volume does or `allow write "<cwd>/.ARCTURN/**"` in a
    // checked-in config re-opens, on every Windows volume and a stock macOS,
    // exactly what the blanket zone deny exists to close — an inherited allow
    // is *more* specific than that deny and wins inside its own scope.
    const rules = workspaceConfinementRules(ROOT, [
      { tool: "write", specifier: join(ROOT, ".ARCTURN", "**"), action: "allow", scope: "project" },
    ]);
    const kept = rules.filter((rule) => rule.action === "allow");
    expect(kept).toEqual(defaultCaseInsensitivePaths() ? [] : rules.slice(0, 1));
  });
});

// ------------------------------------------------------------- the busy latch

/** A session agent that answers immediately and touches nothing. */
function fakeAskAgent(): McpAskAgent {
  const model: ModelSpec = {
    id: "test/model",
    provider: "anthropic",
    model: "test",
    displayName: "Test",
    contextWindow: 1000,
    maxOutputTokens: 100,
    capabilities: { tools: true, vision: false, thinking: false, caching: false },
  };
  return {
    model,
    tools: [],
    setTools: () => {},
    permissions: { rules: [], addRule: () => {}, clearRules: () => {} },
    subscribe: () => () => {},
    prompt: async () => {},
    finalText: () => "answered",
    abort: () => {},
  };
}

describe("ask_arcturn's concurrency latch", () => {
  it("is released when building the agent throws", async () => {
    // `busy = true` used to sit above the `try` that clears it, so one failed
    // construction — an unreadable checkpoint directory, a model the catalog
    // cannot resolve — latched the server into "already working on a prompt"
    // for the life of the connection, with no run in flight and no way for the
    // peer to tell the difference.
    let attempts = 0;
    const ask = askThrough(
      {
        buildSessionAgent(): McpAskAgent {
          attempts++;
          if (attempts === 1) throw new Error("checkpoint store is unreadable");
          return fakeAskAgent();
        },
      },
      "/repo",
      {},
    );
    const signal = new AbortController().signal;
    await expect(ask({ prompt: "one" }, signal)).rejects.toThrow("unreadable");
    const second = await ask({ prompt: "two" }, signal);
    expect(second.text).toBe("answered");
    expect(attempts).toBe(2);
  });

  it("still refuses a genuinely concurrent second run", async () => {
    // The latch's actual job, kept honest by the test above.
    let release = (): void => {};
    const ask = askThrough(
      {
        buildSessionAgent: (): McpAskAgent => ({
          ...fakeAskAgent(),
          prompt: () => new Promise<void>((resolve) => (release = resolve)),
        }),
      },
      "/repo",
      {},
    );
    const signal = new AbortController().signal;
    const first = ask({ prompt: "one" }, signal);
    await expect(ask({ prompt: "two" }, signal)).rejects.toThrow("already working");
    release();
    await first;
  });
});
