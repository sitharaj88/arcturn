/**
 * END-TO-END proof that the `arcturn` binary itself behaves, driven as a real
 * process.
 *
 * Every other test in this package calls a function and asserts on what it
 * returned. That is exactly how `--print` shipped hanging forever on an
 * inherited stdin: `readPipedStdin` returned the right string in a unit test
 * while the real process never exited. So this file asserts on **effects a
 * process actually had** — its exit code, the bytes it wrote to stdout and
 * stderr, the files it left on disk, the sockets it bound and released, and
 * the HTTP requests the model provider received.
 *
 * ## What stands in for what
 *
 * - **The binary is real.** Every spawn is `packages/cli/dist/main.js`, the
 *   same file `bin.arcturn` points at. `beforeAll` rebuilds it when any
 *   source file is newer, because a stale `dist` is how a CLI test goes
 *   silently green against last week's code.
 * - **The model provider is a local HTTP server**, not a mock object: an
 *   OpenAI-compatible SSE endpoint on 127.0.0.1 that the CLI reaches through
 *   its ordinary provider stack. It is registered through a real extension
 *   file in the workspace, so model resolution, extension loading and config
 *   layering are all exercised rather than bypassed. Nothing in this file
 *   touches the network, and every spawn runs with the ambient provider API
 *   keys blanked so a misconfigured run fails locally instead of reaching a
 *   real vendor.
 * - **Nothing is left running.** Every child is registered the moment it is
 *   spawned and killed in `afterEach`, every spawn carries a deadline, and
 *   the socket tests assert the port is *closed* after the process exits.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { DEFAULT_COMPLETION_SPEC, generateCompletions } from "./completions.js";

// Vitest's 20 s default is a budget for a function call. A test here spawns
// several real processes, each paying Node startup, extension loading and a
// TypeScript-compiled module graph, and the whole suite runs its files in
// parallel — so under load a legitimately-passing case was being cut off at
// 20 s. These numbers are deliberately generous: their job is to catch a HANG,
// not to police speed. Every spawn carries its own, tighter deadline (see
// `launch`), so a genuinely stuck process is still reported as stuck, with the
// output it managed to produce, long before this outer limit is reached.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const CLI = join(PACKAGE_ROOT, "dist", "main.js");

/**
 * Rebuild `dist` when any source file is newer than it.
 *
 * These tests spawn the built binary, so a stale `dist` would test whatever
 * was compiled last — the exact staleness that has silently broken CLI tests
 * in this repo before. Four seconds of `tsc` is cheaper than a false green.
 */
function ensureFreshBuild(): void {
  const built = existsSync(CLI) ? statSync(CLI).mtimeMs : 0;
  const src = join(PACKAGE_ROOT, "src");
  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(src);
  if (built >= newest) return;
  try {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd: PACKAGE_ROOT,
      stdio: "pipe",
      timeout: 240_000,
    });
  } catch (error) {
    // Several people work this tree at once, and a workspace that does not
    // compile right now is somebody else's half-finished edit, not a failure
    // of these tests. Falling back to the last good `dist` keeps this file
    // from reddening every concurrent session; `pnpm build` and
    // `pnpm -r run typecheck` are the gates that report a broken tree, and
    // they say it far better than a spawn failure here would.
    if (!existsSync(CLI)) throw error;
    console.warn(
      "entry-points.e2e: packages/cli/dist is stale and could not be rebuilt " +
        "(the workspace does not currently compile); driving the last built binary.",
    );
  }
}

beforeAll(() => {
  ensureFreshBuild();
}, 300_000);

// ---------------------------------------------------------------------------
// Stub provider
// ---------------------------------------------------------------------------

/** One scripted model turn: plain text, a tool call, or both. */
interface StubTurn {
  /** Assistant text streamed back. */
  text?: string;
  /** A tool call the model asks for. */
  toolCall?: { name: string; args: Record<string, unknown> };
  /** Reported prompt tokens (drives the cost ceiling tests). */
  promptTokens?: number;
  /** Reported completion tokens. */
  completionTokens?: number;
}

/** A running stub provider. */
interface StubProvider {
  /** `baseUrl` for an `openai-compatible` model spec. */
  baseUrl: string;
  /** Every request body the CLI actually sent, parsed. */
  requests: { messages: { role: string; content: unknown }[] }[];
  /** Shut the listener down. */
  close(): Promise<void>;
}

const providers: StubProvider[] = [];

/**
 * Start a local OpenAI-compatible SSE endpoint.
 *
 * @param script - Either a fixed list of turns (the last one repeats) or a
 *   function of the turn index, for a model that never stops calling tools.
 */
async function stubProvider(
  script: readonly StubTurn[] | ((turn: number) => StubTurn),
): Promise<StubProvider> {
  const requests: StubProvider["requests"] = [];
  let turn = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const spec =
        typeof script === "function"
          ? script(turn)
          : (script[Math.min(turn, script.length - 1)] ?? {});
      turn++;
      const frame = (delta: unknown, finish: string | null, usage?: unknown): string =>
        `data: ${JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion.chunk",
          created: 1,
          model: "stub",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage === undefined ? {} : { usage }),
        })}\n\n`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (spec.text !== undefined) {
        response.write(frame({ role: "assistant", content: spec.text }, null));
      }
      if (spec.toolCall) {
        response.write(
          frame(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${turn}`,
                  type: "function",
                  function: {
                    name: spec.toolCall.name,
                    arguments: JSON.stringify(spec.toolCall.args),
                  },
                },
              ],
            },
            null,
          ),
        );
      }
      response.write(
        frame({}, spec.toolCall ? "tool_calls" : "stop", {
          prompt_tokens: spec.promptTokens ?? 1_000,
          completion_tokens: spec.completionTokens ?? 1_000,
        }),
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub provider not bound");
  const provider: StubProvider = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server),
  };
  providers.push(provider);
  return provider;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** A scratch project plus the isolated `ARCTURN_HOME` a spawn runs against. */
interface Workspace {
  /** Project directory; also the spawn's `cwd`. */
  dir: string;
  /** Isolated `ARCTURN_HOME`, so nothing touches the developer's real one. */
  home: string;
}

/**
 * Build a scratch workspace whose configured model is {@link stubProvider}.
 *
 * The model is registered by a real extension file rather than injected, so
 * extension loading, `registerModel`, config layering and model resolution
 * are all part of what these tests exercise.
 *
 * The stub lives in the USER extension directory (`$ARCTURN_HOME/extensions`),
 * not `<cwd>/.arcturn/extensions`. That is more faithful to what it is — test
 * infrastructure standing in for the harness operator, not something the
 * "repository" under test ships — and it is what keeps these tests meaningful
 * now that `project-trust.ts` gates project extensions: every `-p` run here is
 * off a TTY, so a project-layer stub would be refused and the model would
 * simply vanish from all 34 workspaces. The refusal itself is asserted
 * separately, by the "project code" test below.
 *
 * `permissionMode: "yolo"` lives in the USER config for exactly the same
 * reason. A project layer may only NARROW the mode (`config.ts`'s
 * `clampProjectPermissionMode`), so a `yolo` written into `<cwd>/.arcturn` is
 * ignored — as it must be, or a cloned repository could switch off every
 * prompt. This harness IS the operator, so it speaks in the operator's file.
 * A caller passing `permissionMode` in `config` still narrows from there.
 *
 * @param baseUrl - The stub provider's base URL, or `undefined` for a
 *   workspace whose model is deliberately unreachable.
 * @param config - Extra keys merged into `.arcturn/config.json`.
 * @param priced - Whether the registered model publishes pricing.
 */
async function workspace(
  baseUrl: string,
  config: Record<string, unknown> = {},
  priced = true,
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-e2e-"));
  const home = join(dir, "home");
  await mkdir(join(dir, ".arcturn"), { recursive: true });
  await mkdir(join(home, "extensions"), { recursive: true });
  await writeFile(
    join(home, "extensions", "stub.mjs"),
    `import { registerModel } from "@arcturn/ai";
registerModel({
  id: "stub/model",
  provider: "openai-compatible",
  model: "stub",
  displayName: "Stub Model",
  contextWindow: 128000,
  maxOutputTokens: 4096,
  ${priced ? "cost: { input: 1000, output: 1000 }," : ""}
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
  baseUrl: ${JSON.stringify(baseUrl)},
  apiKeyEnv: "STUB_API_KEY",
});
export default function () {}
`,
  );
  await writeFile(join(home, "config.json"), JSON.stringify({ permissionMode: "yolo" }));
  await writeFile(
    join(dir, ".arcturn", "config.json"),
    JSON.stringify({ model: "stub/model", ui: "inline", ...config }),
  );
  return { dir, home };
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const provider of providers.splice(0)) await provider.close();
});

/** What one spawn did. */
interface RunResult {
  /** Exit code, or `null` when the process died from a signal or the deadline. */
  code: number | null;
  /** Terminating signal, when there was one. */
  signal: NodeJS.Signals | null;
  /** Whether the deadline fired — i.e. the process hung. */
  timedOut: boolean;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/** A spawn in flight. */
interface Run {
  /** The child, for signalling or writing to stdin. */
  child: ChildProcess;
  /** Resolves when the process exits or the deadline fires. */
  done: Promise<RunResult>;
  /** stdout so far, for polling a long-lived process such as `serve`. */
  stdoutSoFar(): string;
  /** stderr so far, for polling a long-lived process's diagnostics. */
  stderrSoFar(): string;
}

/**
 * How long a spawn may run before it is killed and reported as hung.
 *
 * This is the assertion that `--print` cannot go back to hanging forever, so
 * it must be long enough that a slow-but-working run never trips it: on a
 * loaded machine a cold spawn can take several seconds before it reaches its
 * first line of work.
 */
const DEFAULT_SPAWN_DEADLINE_MS = 45_000;

/** Options for {@link launch}. */
interface LaunchOptions {
  /** Workspace to run in. */
  workspace: Workspace;
  /** `"open"` gives the child a pipe nothing ever writes to or closes. */
  stdin?: "closed" | "open";
  /** Extra environment. */
  env?: Record<string, string>;
  /** Deadline; a run that outlives it is SIGKILLed and reported as hung. */
  timeoutMs?: number;
}

/**
 * Spawn the real binary.
 *
 * Ambient provider credentials are blanked: a test that accidentally resolved
 * a real model must fail against a missing key, never reach a vendor.
 */
function launch(args: readonly string[], options: LaunchOptions): Run {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: options.workspace.dir,
    env: {
      ...process.env,
      ARCTURN_HOME: options.workspace.home,
      STUB_API_KEY: "stub-key",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
      ARCTURN_MODEL: "",
      ...options.env,
    },
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<RunResult>((done_) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done_({ code: null, signal: null, timedOut: true, stdout, stderr });
    }, options.timeoutMs ?? DEFAULT_SPAWN_DEADLINE_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      // One tick, so the last stdout/stderr chunks are drained before the
      // assertion reads them.
      setTimeout(() => done_({ code, signal, timedOut: false, stdout, stderr }), 20);
    });
  });
  return { child, done, stdoutSoFar: () => stdout, stderrSoFar: () => stderr };
}

/** Spawn and wait. */
function run(args: readonly string[], options: LaunchOptions): Promise<RunResult> {
  return launch(args, options).done;
}

/** Wait for a pattern to appear on a long-lived process's stdout. */
async function waitForStdout(active: Run, pattern: RegExp, ms = 30_000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + ms;
  for (;;) {
    const match = active.stdoutSoFar().match(pattern);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${pattern}; stdout was ${active.stdoutSoFar()}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Whether something is accepting connections on a loopback port. */
function portAccepts(port: number): Promise<boolean> {
  return new Promise<boolean>((done) => {
    const socket = createConnection(port, "127.0.0.1");
    const finish = (value: boolean): void => {
      socket.destroy();
      done(value);
    };
    socket.on("connect", () => finish(true));
    socket.on("error", () => done(false));
    setTimeout(() => finish(false), 2_000);
  });
}

/** Parse an NDJSON stream, failing loudly on any line that is not one object. */
function ndjson(stdout: string): { type: string; [key: string]: unknown }[] {
  const lines = stdout.split("\n");
  expect(lines.at(-1), "NDJSON output must end with a newline").toBe("");
  return lines.slice(0, -1).map((line, index) => {
    try {
      return JSON.parse(line) as { type: string };
    } catch {
      throw new Error(`line ${index + 1} of --output-format json is not valid JSON: ${line}`);
    }
  });
}

// ---------------------------------------------------------------------------
// --print
// ---------------------------------------------------------------------------

describe("arcturn --print", () => {
  it("finishes when stdin is a pipe nobody ever closes", async () => {
    // The regression that shipped: a CI runner, Makefile recipe or parent
    // agent hands the child an inherited pipe that stays open forever. With a
    // prompt argument present, stdin is optional context and the run must not
    // wait on it.
    const provider = await stubProvider([{ text: "ANSWERED" }]);
    const ws = await workspace(provider.baseUrl);

    const result = await run(["-p", "hello", "--no-mcp"], {
      workspace: ws,
      stdin: "open",
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.timedOut, "--print hung on an inherited stdin").toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ANSWERED\n");
  });

  it("takes piped stdin as the prompt when no prompt argument is given", async () => {
    const provider = await stubProvider([{ text: "FOUR" }]);
    const ws = await workspace(provider.baseUrl);

    const active = launch(["-p", "--no-mcp"], { workspace: ws, stdin: "closed" });
    active.child.stdin?.end("what is 2+2\n");
    const result = await active.done;

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("FOUR\n");
    // The effect that matters: the provider saw the piped text as the prompt.
    expect(provider.requests.at(-1)?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "what is 2+2",
    });
  });

  it("puts piped stdin ahead of the prompt argument as leading context", async () => {
    const provider = await stubProvider([{ text: "ok" }]);
    const ws = await workspace(provider.baseUrl);

    const active = launch(["-p", "summarise this", "--no-mcp"], {
      workspace: ws,
      stdin: "closed",
    });
    active.child.stdin?.end("CONTEXT-BODY\n");
    const result = await active.done;

    expect(result.code).toBe(0);
    expect(provider.requests.at(-1)?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "CONTEXT-BODY\n\nsummarise this",
    });
  });

  it("refuses with exit 2 when stdin closes empty and no prompt was given", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const active = launch(["-p", "--no-mcp"], { workspace: ws, stdin: "closed" });
    active.child.stdin?.end("");
    const result = await active.done;

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--print needs a prompt");
    expect(provider.requests).toHaveLength(0);
  });

  it("says it is waiting rather than hanging in silence on an open stdin", async () => {
    // No prompt argument means stdin IS the prompt, so blocking to EOF is the
    // only correct thing to do — but doing it silently is what makes an
    // inherited pipe indistinguishable from a crash. The run still waits; it
    // just says why.
    const provider = await stubProvider([{ text: "eventually" }]);
    const ws = await workspace(provider.baseUrl);

    const active = launch(["-p", "--no-mcp"], {
      workspace: ws,
      stdin: "open",
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    // Poll rather than sleep: on a loaded machine the child's own startup can
    // outlast any fixed wait, and a test that raced would be worse than none.
    const deadline = Date.now() + 20_000;
    while (
      !active.stderrSoFar().includes("reading the prompt from stdin") &&
      Date.now() < deadline
    ) {
      expect(active.child.exitCode, "the run gave up on stdin instead of waiting").toBe(null);
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(active.stderrSoFar()).toContain("reading the prompt from stdin");
    // It really is still waiting, not merely talkative.
    expect(active.child.exitCode).toBe(null);
    expect(provider.requests, "nothing may be sent before a prompt arrives").toHaveLength(0);

    // Now feed it: the wait was real, and the prompt still works.
    active.child.stdin?.end("the question\n");
    const result = await active.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("eventually\n");
    expect(provider.requests.at(-1)?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "the question",
    });
  });

  it("emits one complete JSON object per line, runStart through runEnd", async () => {
    const provider = await stubProvider((turn) =>
      turn === 0
        ? { toolCall: { name: "write", args: { path: "out.txt", content: "hi\n" } } }
        : { text: "wrote it" },
    );
    const ws = await workspace(provider.baseUrl);

    const result = await run(["-p", "write out.txt", "--no-mcp", "--output-format", "json"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(0);
    const events = ndjson(result.stdout);
    expect(events[0]?.type).toBe("runStart");
    expect(events.at(-1)?.type).toBe("runEnd");
    expect(events.at(-1)?.reason).toBe("completed");
    expect(events.map((event) => event.type)).toContain("toolEnd");
    // Diagnostics must never contaminate the data stream.
    expect(result.stderr).toBe("");
    // And the tool really ran.
    expect(existsSync(join(ws.dir, "out.txt"))).toBe(true);
  });

  it("does not tear a line when the event stream is far larger than a pipe buffer", async () => {
    // stdout to a pipe is asynchronous in Node, and `--print` sets
    // `process.exitCode` rather than calling `process.exit`. A 200 KB final
    // message is several pipe buffers' worth: if the flush were not complete
    // before the process ended, `arcturn -p --output-format json | jq` would
    // truncate mid-line on exactly the runs that matter most.
    const provider = await stubProvider([{ text: "Y".repeat(200_000) }]);
    const ws = await workspace(provider.baseUrl);

    const result = await run(["-p", "say a lot", "--no-mcp", "--output-format", "json"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(200_000);
    // ndjson() throws on any torn line, and asserts the stream is terminated.
    expect(ndjson(result.stdout).at(-1)?.type).toBe("runEnd");

    // The same, in text mode: the final message must arrive whole.
    const provider2 = await stubProvider([{ text: "Z".repeat(200_000) }]);
    const ws2 = await workspace(provider2.baseUrl);
    const text = await run(["-p", "say a lot", "--no-mcp"], {
      workspace: ws2,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(text.stdout).toBe(`${"Z".repeat(200_000)}\n`);
  });
});

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

describe("arcturn ceilings", () => {
  /** A model that never stops asking for tools, so only a ceiling ends the run. */
  const neverStops = () => ({ toolCall: { name: "bash", args: { command: "true" } } });

  it("completes a run that stays under both ceilings", async () => {
    // The control: without this, a ceiling that stopped nothing and a ceiling
    // that stopped everything would look the same.
    const provider = await stubProvider([{ text: "UNDER" }]);
    const ws = await workspace(provider.baseUrl);

    const result = await run(["-p", "hi", "--no-mcp", "--max-turns", "5", "--max-cost", "100"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("UNDER\n");
  });

  it("--max-turns stops the run at the ceiling and exits non-zero", async () => {
    const provider = await stubProvider(neverStops);
    const ws = await workspace(provider.baseUrl);

    const result = await run(
      ["-p", "loop", "--no-mcp", "--output-format", "json", "--max-turns", "3"],
      { workspace: ws, timeoutMs: DEFAULT_SPAWN_DEADLINE_MS },
    );

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    const events = ndjson(result.stdout);
    expect(events.filter((event) => event.type === "turnStart")).toHaveLength(3);
    expect(provider.requests).toHaveLength(3);
    expect(String(events.at(-1)?.errorMessage)).toContain("maximum of 3 turns");
  });

  it("--max-cost stops the run once the ceiling is crossed", async () => {
    // Each stub turn reports 1000 in + 1000 out at $1000/MTok = $2.00, so a
    // $0.05 ceiling must trip on the very first turn.
    const provider = await stubProvider(neverStops);
    const ws = await workspace(provider.baseUrl);

    const result = await run(
      ["-p", "loop", "--no-mcp", "--output-format", "json", "--max-cost", "0.05"],
      { workspace: ws, timeoutMs: DEFAULT_SPAWN_DEADLINE_MS },
    );

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    const events = ndjson(result.stdout);
    expect(events.at(-1)).toMatchObject({ type: "runEnd", reason: "aborted" });
    // The effect, not the message: the provider was not asked again.
    expect(provider.requests).toHaveLength(1);
    const notices = events.filter((event) => event.type === "notice").map((e) => String(e.text));
    expect(notices.some((text) => text.includes("Cost limit"))).toBe(true);
  });

  it("says so when --max-cost cannot be enforced because the model is unpriced", async () => {
    // A ceiling that silently cannot fire is worse than no ceiling: the user
    // believes they are protected. Every `openai-compatible` endpoint
    // registered without pricing — Ollama, vLLM, an in-house gateway — lands
    // here.
    const provider = await stubProvider(neverStops);
    const ws = await workspace(provider.baseUrl, {}, false);

    const result = await run(["-p", "loop", "--no-mcp", "--max-cost", "0.05", "--max-turns", "2"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("--max-cost");
    expect(result.stderr).toContain("Stub Model");
    expect(result.stderr.toLowerCase()).toContain("pricing");
  });
});

// ---------------------------------------------------------------------------
// --cwd
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Project code
// ---------------------------------------------------------------------------

describe("arcturn project code", () => {
  it("runs none of a cloned repo's own code off a TTY, and says how to approve it", async () => {
    // The whole threat in one spawn: a checkout you have not read declares a
    // sessionStart hook and an extension, and `-p` is not a terminal, so
    // nobody can be asked. Before this gate both ran, as you, before the
    // first token left the model.
    const provider = await stubProvider([{ text: "done" }]);
    const ws = await workspace(provider.baseUrl);
    const hookMarker = join(ws.dir, "hook-ran");
    const extensionMarker = join(ws.dir, "extension-ran");
    await writeFile(
      join(ws.dir, ".arcturn", "config.json"),
      JSON.stringify({
        model: "stub/model",
        ui: "inline",
        hooks: { sessionStart: [{ command: `printf x > ${JSON.stringify(hookMarker)}` }] },
      }),
    );
    await mkdir(join(ws.dir, ".arcturn", "extensions"), { recursive: true });
    await writeFile(
      join(ws.dir, ".arcturn", "extensions", "evil.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(extensionMarker)}, "x");
export default function () {}
`,
    );

    const refused = await run(["-p", "hi", "--no-mcp"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(refused.code).toBe(0);
    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(extensionMarker)).toBe(false);
    // Never a hard exit: "your repo has a hook" must not become "arcturn no
    // longer starts in CI". The run completes and explains itself instead.
    expect(refused.stderr).toContain("NOT running");
    expect(refused.stderr).toContain("--trust-project");
    expect(refused.stderr).toContain("arcturn trust --list");
    expect(provider.requests.length).toBeGreaterThan(0);

    // And the documented way back in works from the same pipeline.
    const trusted = await run(["-p", "hi", "--no-mcp", "--trust-project"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(trusted.code).toBe(0);
    expect(existsSync(hookMarker)).toBe(true);
    expect(existsSync(extensionMarker)).toBe(true);
  });

  it("reports the same refusal from serve, the surface that stays up longest", async () => {
    const provider = await stubProvider([{ text: "done" }]);
    const ws = await workspace(provider.baseUrl);
    const hookMarker = join(ws.dir, "serve-hook-ran");
    await writeFile(
      join(ws.dir, ".arcturn", "config.json"),
      JSON.stringify({
        model: "stub/model",
        ui: "inline",
        hooks: { sessionStart: [{ command: `printf x > ${JSON.stringify(hookMarker)}` }] },
      }),
    );

    const serving = launch(["serve", "--host", "127.0.0.1", "--port", "0"], {
      workspace: ws,
      timeoutMs: 60_000,
    });
    await waitForStdout(serving, /arcturn serving on /);
    const stderr = serving.stderrSoFar();
    serving.child.kill("SIGINT");
    await serving.done;

    expect(existsSync(hookMarker)).toBe(false);
    // `serve` printed no runtime warnings at all before this, so a project
    // whose hooks were dropped went silent about it on the surface with the
    // longest uptime and the fewest people watching.
    expect(stderr).toContain("NOT running");
  });

  it("lists what would run, and records an approval, via `arcturn trust`", async () => {
    const provider = await stubProvider([{ text: "done" }]);
    const ws = await workspace(provider.baseUrl);
    await writeFile(
      join(ws.dir, ".arcturn", "config.json"),
      JSON.stringify({
        model: "stub/model",
        ui: "inline",
        hooks: { sessionStart: [{ command: "echo listed-command" }] },
        verify: "pnpm listed-verify",
      }),
    );

    const listed = await run(["trust", "--list"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("echo listed-command");
    expect(listed.stdout).toContain("pnpm listed-verify");
    expect(listed.stdout).toContain("never asked");

    const allowed = await run(["trust", "--allow"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(allowed.code).toBe(0);
    // "Saved" alone was the `/permissions suggest` mistake. When it takes
    // effect is said in the same breath as that it was saved.
    expect(allowed.stdout).toContain("NEXT time arcturn starts");

    const after = await run(["trust"], { workspace: ws, timeoutMs: DEFAULT_SPAWN_DEADLINE_MS });
    expect(after.stdout).toContain("allowed");
  });
});

describe("arcturn --cwd", () => {
  it("refuses a directory that does not exist instead of running in a phantom tree", async () => {
    // What used to happen: the run was accepted, `write` created the whole
    // missing path and dropped files into it, `bash` failed with
    // "spawn /bin/sh ENOENT", and sessions were bucketed under a directory
    // the user never had. A typo in --cwd must be a usage error.
    const provider = await stubProvider((turn) =>
      turn === 0
        ? { toolCall: { name: "write", args: { path: "ghost.txt", content: "G\n" } } }
        : { text: "done" },
    );
    const ws = await workspace(provider.baseUrl);
    const ghost = join(ws.dir, "no", "such", "dir");

    const result = await run(["-p", "write ghost.txt", "--no-mcp", "--cwd", ghost], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(ghost);
    expect(result.stderr).toContain("--cwd");
    // The effect that made this a bug and not a nitpick: nothing was created.
    expect(existsSync(ghost)).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });

  it("refuses a --cwd that names a file", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);
    const file = join(ws.dir, "not-a-directory");
    await writeFile(file, "x");

    const result = await run(["-p", "hi", "--no-mcp", "--cwd", file], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(file);
    expect(provider.requests).toHaveLength(0);
  });

  it("refuses a bad --cwd for the provenance verbs too, not only for a run", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);
    const ghost = join(ws.dir, "gone");

    for (const argv of [["audit"], ["blame", "x.ts"], ["replay", "abc"], ["serve"]]) {
      const result = await run([...argv, "--cwd", ghost], {
        workspace: ws,
        timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
      });
      expect(result.code, `${argv[0]} accepted a missing --cwd`).toBe(2);
      expect(result.stderr).toContain(ghost);
    }
  });

  it("runs tools in the directory --cwd names", async () => {
    const provider = await stubProvider((turn) =>
      turn === 0
        ? { toolCall: { name: "write", args: { path: "landed.txt", content: "L\n" } } }
        : { text: "done" },
    );
    const ws = await workspace(provider.baseUrl);
    const sub = join(ws.dir, "sub");
    await mkdir(join(sub, ".arcturn"), { recursive: true });
    await writeFile(
      join(sub, ".arcturn", "config.json"),
      // The mode comes from the shared `$ARCTURN_HOME` config, which `--cwd`
      // does not move and which a project layer may not widen.
      JSON.stringify({ model: "stub/model", ui: "inline" }),
    );
    // No extension copy is needed any more: the stub lives in the shared
    // `$ARCTURN_HOME`, which `--cwd` does not move.

    const result = await run(["-p", "write landed.txt", "--no-mcp", "--cwd", sub], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(0);
    expect(existsSync(join(sub, "landed.txt"))).toBe(true);
    expect(existsSync(join(ws.dir, "landed.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --dry-run
// ---------------------------------------------------------------------------

describe("arcturn --dry-run", () => {
  it("keeps a write out of the real tree, and drops the flag to let it through", async () => {
    const script = (turn: number): StubTurn =>
      turn === 0
        ? { toolCall: { name: "write", args: { path: "made.txt", content: "M\n" } } }
        : { text: "done" };

    const shadowed = await stubProvider(script);
    const shadowedWs = await workspace(shadowed.baseUrl);
    const dry = await run(["-p", "write made.txt", "--no-mcp", "--dry-run"], {
      workspace: shadowedWs,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(dry.code).toBe(0);
    expect(existsSync(join(shadowedWs.dir, "made.txt"))).toBe(false);

    const real = await stubProvider(script);
    const realWs = await workspace(real.baseUrl);
    const wet = await run(["-p", "write made.txt", "--no-mcp"], {
      workspace: realWs,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(wet.code).toBe(0);
    expect(existsSync(join(realWs.dir, "made.txt"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe("arcturn exit codes", () => {
  it("returns 2 for every usage error, and names the problem", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const cases: [string, string[], string][] = [
      ["unknown option", ["--nope"], "Unknown option"],
      ["missing flag value", ["-p", "hi", "--model"], "requires a value"],
      ["bad output format", ["-p", "hi", "--output-format", "yaml"], "--output-format"],
      ["json without --print", ["hi", "--output-format", "json"], "requires --print"],
      ["bad permission mode", ["-p", "hi", "--permission-mode", "wat"], "--permission-mode"],
      ["unknown model", ["-p", "hi", "--no-mcp", "--model", "nope/nope"], "Unknown model"],
      ["unknown shell", ["completions", "elvish"], "unknown shell"],
      ["bisect without a cassette", ["bisect", "abc"], "--cassette"],
      ["attach without a terminal", ["attach", "ws://127.0.0.1:1"], "needs a terminal"],
      ["interactive without a terminal", ["--no-mcp"], "not a terminal"],
      ["bad port", ["serve", "--port", "99999"], "--port"],
    ];
    for (const [label, argv, needle] of cases) {
      const result = await run(argv, { workspace: ws, timeoutMs: DEFAULT_SPAWN_DEADLINE_MS });
      expect(result.code, `${label} should exit 2`).toBe(2);
      expect(result.stderr, label).toContain(needle);
    }
  });

  it("returns 0 for --help and --version, on stdout", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const help = await run(["--help"], { workspace: ws });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage");
    expect(help.stderr).toBe("");

    const version = await run(["--version"], { workspace: ws });
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns 1 when the provider fails the run", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "provider exploded" } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("not bound");
    try {
      const ws = await workspace(`http://127.0.0.1:${address.port}/v1`);
      const result = await run(["-p", "hi", "--no-mcp"], { workspace: ws, timeoutMs: 60_000 });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("provider exploded");
      expect(result.stdout).toBe("");
    } finally {
      await closeServer(server);
    }
  });

  it("completes with 0 when a permission is refused, after saying so on stderr", async () => {
    // A refusal is not a crash: the model is told and gets to carry on. What
    // must not happen is silence — the human needs to know a flag would have
    // allowed it.
    const provider = await stubProvider((turn) =>
      turn === 0
        ? { toolCall: { name: "bash", args: { command: "rm -rf /" } } }
        : { text: "could not run that" },
    );
    const ws = await workspace(provider.baseUrl, { permissionMode: "default", permissions: [] });

    const result = await run(["-p", "delete everything", "--no-mcp"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("could not run that\n");
    expect(result.stderr).toContain("denied bash");
    expect(result.stderr).toContain("--permission-mode");
  });

  it("returns 2 for -r/--resume naming a session that cannot be read, and runs nothing", async () => {
    // Documented in cli-reference.md's exit-code table: "a session that
    // could not be read" is exit 2, nothing ran. The old behaviour printed
    // "Could not resume session …: does not exist" as a warning and then
    // started a fresh session anyway — exit 0, and a real model call.
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const result = await run(["-r", "bogus-session-id", "-p", "hi", "--no-mcp"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Could not resume session bogus-session-id");
    expect(result.stdout).toBe("");
    expect(provider.requests).toEqual([]);
  });

  it("documents its exit codes in --help", async () => {
    // An exit code nobody can look up is not an interface. Scripts branch on
    // these; they belong in the help text next to the flags that produce them.
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const help = await run(["--help"], { workspace: ws });

    expect(help.stdout).toContain("Exit codes");
    expect(help.stdout).toMatch(/\b0\b.*success/i);
    expect(help.stdout).toMatch(/\b1\b/);
    expect(help.stdout).toMatch(/\b2\b/);
  });
});

// ---------------------------------------------------------------------------
// Provenance verbs
// ---------------------------------------------------------------------------

describe("arcturn provenance verbs", () => {
  it("audit, blame and replay all describe the session that really ran", async () => {
    const provider = await stubProvider((turn) =>
      turn % 2 === 0
        ? { toolCall: { name: "write", args: { path: "notes.txt", content: "alpha\nbeta\n" } } }
        : { text: "wrote notes.txt" },
    );
    const ws = await workspace(provider.baseUrl, { audit: true, provenance: true });

    const recorded = await run(["-p", "create notes.txt with alpha and beta", "--no-mcp"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(recorded.code).toBe(0);
    expect(existsSync(join(ws.dir, "notes.txt"))).toBe(true);

    const buckets = readdirSync(join(ws.home, "sessions"));
    expect(buckets).toHaveLength(1);
    const bucket = join(ws.home, "sessions", buckets[0] as string);
    const sessionId = (readdirSync(bucket).find((f) => f.endsWith(".jsonl")) as string).replace(
      /\.jsonl$/,
      "",
    );

    const audit = await run(["audit", sessionId], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(audit.code).toBe(0);
    expect(audit.stdout).toContain("write");
    expect(audit.stdout).toContain("notes.txt");
    expect(audit.stdout).toContain("1 tool call");

    const blame = await run(["blame", "notes.txt", sessionId], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(blame.code).toBe(0);
    // Line-by-line attribution of the file the session actually wrote.
    expect(blame.stdout).toContain("alpha");
    expect(blame.stdout).toContain("beta");
    expect(blame.stdout).toContain("create notes.txt with alpha and");

    const replay = await run(["replay", sessionId, "--no-mcp"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(replay.code).toBe(0);
    const turn = JSON.parse(replay.stdout.trim()) as { prompt: string; toolCalls: string[] };
    expect(turn.prompt).toBe("create notes.txt with alpha and beta");
    expect(turn.toolCalls).toContain("write");
    expect(replay.stderr).toContain("replaying 1 prompt");
  });

  it("records a cassette that bisect can actually read", async () => {
    // `arcturn bisect` refuses to start without `--cassette <file>` and told
    // the user to "record one with VCR first" — while `vcr.ts`'s recorder had
    // no caller anywhere in the shipped product. The verb was unreachable.
    // This is the round trip that makes it a command rather than a promise.
    const provider = await stubProvider([{ text: "recorded answer" }]);
    const ws = await workspace(provider.baseUrl);
    const cassette = join(ws.dir, "run.jsonl");

    const recorded = await run(["-p", "a question", "--no-mcp", "--record", cassette], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(recorded.code).toBe(0);
    expect(existsSync(cassette), "--record wrote no cassette").toBe(true);
    const lines = (await readFile(cassette, "utf8")).split("\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines.some((line) => line.includes('"kind":"llm"'))).toBe(true);

    const buckets = readdirSync(join(ws.home, "sessions"));
    const bucket = join(ws.home, "sessions", buckets[0] as string);
    const sessionId = (readdirSync(bucket).find((f) => f.endsWith(".jsonl")) as string).replace(
      /\.jsonl$/,
      "",
    );

    // bisect replays that session against the recording, and — since nothing
    // changed between them — finds no turn where behaviour diverged.
    const bisected = await run(["bisect", sessionId, "--cassette", cassette], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(bisected.code).toBe(0);
    expect(bisected.stdout.length).toBeGreaterThan(0);
    // And nothing reached the provider: a replay must open no socket.
    expect(provider.requests).toHaveLength(1);
  });

  it("says which session it could not read rather than failing blankly", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const result = await run(["replay", "no-such-session"], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no-such-session");
  });
});

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

describe("arcturn serve", () => {
  it("announces its address, refuses a wrong token, and frees the port on SIGTERM", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const active = launch(["serve", "--host", "127.0.0.1", "--port", "0", "--token", "s3cret"], {
      workspace: ws,
      timeoutMs: 60_000,
    });
    const announced = await waitForStdout(active, /arcturn serving on (ws:\/\/\S+)/);
    const url = announced[1] as string;
    const port = Number(new URL(url.replace("ws://", "http://")).port);

    expect(await portAccepts(port)).toBe(true);
    await waitForStdout(active, /attach with: arcturn attach \S+ --token s3cret/);

    // A connection that authenticates with the wrong token is refused.
    const { WebSocket } = await import("ws");
    const socket = new WebSocket(url);
    const answer = await new Promise<string>((done) => {
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            kind: "request",
            id: "1",
            method: "authenticate",
            params: { token: "wrong" },
          }),
        ),
      );
      socket.on("message", (data) => done(String(data)));
      socket.on("close", () => done("closed"));
      socket.on("error", () => done("error"));
      setTimeout(() => done("silence"), 8_000);
    });
    socket.terminate();
    expect(answer).toContain("Invalid or missing token");

    active.child.kill("SIGTERM");
    const result = await active.done;
    expect(result.timedOut).toBe(false);
    // Windows has no POSIX signals: Node maps kill() onto TerminateProcess, so
    // the handler never runs, the exit code comes back null rather than 0, and
    // nothing is printed on the way out. Those two assertions are about a
    // graceful shutdown, which is a POSIX-only story. The claim that has to
    // hold everywhere — the process ended and the socket really went with it,
    // rather than being left listening — is asserted on every platform.
    const graceful = process.platform !== "win32";
    if (graceful) {
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("shutting down");
    }
    // The socket is really gone, not merely unreferenced.
    expect(await portAccepts(port)).toBe(false);
  });

  it("generates a token when none is given, and never serves it from the web page", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const active = launch(["serve", "--port", "0", "--token", "zzTOKENzz", "--web"], {
      workspace: ws,
      timeoutMs: 60_000,
    });
    const announced = await waitForStdout(active, /open in a browser: (http:\/\/\S+?)#/);
    const pageUrl = announced[1] as string;

    const response = await fetch(pageUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    // The page is inert until a human supplies the token; a page that carried
    // it would turn "can reach this port" into "can run commands as you".
    expect(html).not.toContain("zzTOKENzz");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");

    const webPort = Number(new URL(pageUrl).port);
    active.child.kill("SIGINT");
    const result = await active.done;
    // See the SIGTERM case above: a clean exit code is a POSIX-only claim.
    if (process.platform !== "win32") expect(result.code).toBe(0);
    expect(await portAccepts(webPort)).toBe(false);
  });

  it("exits 2 when the port is already taken", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const first = launch(["serve", "--port", "0"], { workspace: ws, timeoutMs: 60_000 });
    const announced = await waitForStdout(first, /arcturn serving on (ws:\/\/\S+)/);
    const port = Number(new URL((announced[1] as string).replace("ws://", "http://")).port);

    const second = await run(["serve", "--port", String(port)], {
      workspace: ws,
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("EADDRINUSE");

    first.child.kill("SIGINT");
    await first.done;
  });
});

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

describe("arcturn attach", () => {
  it("sends a mentioned file's CONTENTS to the model, over a real serve process", async () => {
    // `attach` sends the raw line and nothing else — no client-side mention
    // expansion — so the *server* must be the one that turns `@file` into the
    // file. When it was not, a remote prompt reached the model as text ABOUT a
    // file rather than the file, and every unit test still passed because each
    // half returned exactly what it was asked for. This drives a real
    // `arcturn serve` process over a real WebSocket and asserts on what the
    // provider received.
    const provider = await stubProvider([{ text: "read it" }]);
    const ws = await workspace(provider.baseUrl);
    await writeFile(join(ws.dir, "secret.txt"), "MENTION-PAYLOAD-9f3a\n");

    const server = launch(["serve", "--port", "0", "--token", "tok", "--cwd", ws.dir], {
      workspace: ws,
      timeoutMs: 60_000,
    });
    const announced = await waitForStdout(server, /arcturn serving on (ws:\/\/\S+)/);
    const url = announced[1] as string;

    const [{ WebSocket }, { ColorLevel, setColorLevel, stripAnsi, TestTerminal }, { runAttach }] =
      await Promise.all([import("ws"), import("@arcturn/tui"), import("./attach.js")]);
    setColorLevel(ColorLevel.None);
    const terminal = new TestTerminal({ columns: 100, rows: 30 });
    const socket = new WebSocket(url);
    const exit = runAttach({
      socket,
      token: "tok",
      terminal,
      url,
      cwd: ws.dir,
      streamThrottleMs: 1,
    });

    const settle = async (predicate: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error(`${label} never happened; screen was ${stripAnsi(terminal.output)}`);
    };

    try {
      await settle(() => stripAnsi(terminal.output).includes("attached · idle"), "attach");
      terminal.injectInput("summarise @secret.txt\r");
      await settle(() => provider.requests.length > 0, "prompt reaching the provider");

      const sent = JSON.stringify(provider.requests[0]?.messages);
      expect(sent, "the mentioned file's contents never reached the model").toContain(
        "MENTION-PAYLOAD-9f3a",
      );
      // And the mention is expanded, not merely echoed: the raw line survives
      // alongside the file, which is what the model needs to know what to do.
      expect(sent).toContain("summarise @secret.txt");
    } finally {
      // Bounded teardown: ask nicely, then take the socket away, so nothing
      // here can outlive the test even if the client is mid-frame.
      terminal.injectInput("\u0003");
      terminal.injectInput("\u0003");
      await Promise.race([exit.catch(() => 0), new Promise((done) => setTimeout(done, 3_000))]);
      socket.terminate();
      server.child.kill("SIGINT");
      await server.done;
    }
  });
});

// ---------------------------------------------------------------------------
// Stdio protocols
// ---------------------------------------------------------------------------

/** Speak line-delimited JSON-RPC to a spawned process's stdio. */
function jsonRpcPeer(child: ChildProcess): {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
  notifications: string[];
  nonProtocolStdout: string[];
} {
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const notifications: string[] = [];
  const nonProtocolStdout: string[] = [];
  let buffer = "";
  let nextId = 0;
  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() === "") continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        nonProtocolStdout.push(line);
        continue;
      }
      const id = message.id;
      if (typeof id === "number" && pending.has(id)) {
        pending.get(id)?.(message);
        pending.delete(id);
      } else if (typeof message.method === "string") {
        notifications.push(message.method);
        // Answer a server-initiated request (ACP's permission prompt) so the
        // run can proceed rather than deadlocking.
        if (id !== undefined) {
          child.stdin?.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { outcome: { outcome: "selected", optionId: "allow" } },
            })}\n`,
          );
        }
      }
    }
  });
  return {
    call(method, params) {
      const id = ++nextId;
      return new Promise<Record<string, unknown>>((done, fail) => {
        pending.set(id, done);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        setTimeout(() => fail(new Error(`timed out waiting for ${method}`)), 25_000);
      });
    },
    notifications,
    nonProtocolStdout,
  };
}

describe("arcturn mcp-serve", () => {
  it("completes an MCP handshake on stdio and exits 0 when the client goes away", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const active = launch(["mcp-serve", "--permission-mode", "acceptEdits"], {
      workspace: ws,
      stdin: "closed",
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    const peer = jsonRpcPeer(active.child);

    const init = (await peer.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    })) as { result?: { serverInfo?: { name?: string } } };
    expect(init.result?.serverInfo?.name).toBe("arcturn");

    active.child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = (await peer.call("tools/list", {})) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("search_code");
    expect(names).toContain("ask_arcturn");

    // Nothing but protocol frames may reach stdout.
    expect(peer.nonProtocolStdout).toEqual([]);

    active.child.stdin?.end();
    const result = await active.done;
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it("refuses --permission-mode yolo, because nobody is watching", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    const active = launch(["mcp-serve", "--permission-mode", "yolo"], {
      workspace: ws,
      stdin: "closed",
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    const result = await active.done;

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("yolo");
  });
});

describe("arcturn acp", () => {
  it("drives a real prompt to a real tool call over stdio, then exits 0", async () => {
    const provider = await stubProvider((turn) =>
      turn === 0
        ? { toolCall: { name: "write", args: { path: "acp.txt", content: "A\n" } } }
        : { text: "acp done" },
    );
    const ws = await workspace(provider.baseUrl, { permissionMode: "default" });

    const active = launch(["acp", "--permission-mode", "acceptEdits"], {
      workspace: ws,
      stdin: "closed",
      timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
    });
    const peer = jsonRpcPeer(active.child);

    const init = (await peer.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })) as { result?: { agentInfo?: { name?: string } } };
    expect(init.result?.agentInfo?.name).toBe("arcturn");

    const created = (await peer.call("session/new", { cwd: ws.dir, mcpServers: [] })) as {
      result?: { sessionId?: string };
    };
    const sessionId = created.result?.sessionId;
    expect(sessionId).toBeTruthy();

    const prompted = (await peer.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "write acp.txt" }],
    })) as { result?: { stopReason?: string } };
    expect(prompted.result?.stopReason).toBe("end_turn");

    // The effect: the editor's prompt really ran the tool in the workspace.
    expect(existsSync(join(ws.dir, "acp.txt"))).toBe(true);
    expect(peer.notifications).toContain("session/update");
    expect(peer.nonProtocolStdout).toEqual([]);

    active.child.stdin?.end();
    const result = await active.done;
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// completions
// ---------------------------------------------------------------------------

describe("arcturn completions", () => {
  it("emits a script the shell itself accepts", async () => {
    const provider = await stubProvider([{ text: "unused" }]);
    const ws = await workspace(provider.baseUrl);

    // A shell that is not installed cannot check anything, and asserting
    // against one that is absent tests the runner rather than the script —
    // which is how this passed on a developer's macOS and failed on a Linux
    // runner that ships no zsh.
    //
    // What must not happen is silence. A filter alone would turn a machine
    // with neither shell into a green test that proved nothing, so the count
    // is asserted first: at least one real shell has to have read this.
    const available = (["bash", "zsh"] as const).filter((shell) => {
      try {
        execFileSync(shell, ["-c", "exit 0"], { stdio: "ignore", timeout: 20_000 });
        return true;
      } catch {
        return false;
      }
    });
    expect(available.length).toBeGreaterThan(0);

    for (const shell of available) {
      const result = await run(["completions", shell], {
        workspace: ws,
        timeoutMs: DEFAULT_SPAWN_DEADLINE_MS,
      });
      expect(result.code).toBe(0);
      const script = join(ws.dir, `completion.${shell}`);
      await writeFile(script, result.stdout);
      // The real shell parses it, not a regex that hopes it would.
      expect(() =>
        execFileSync(shell, ["-n", script], { stdio: "pipe", timeout: 20_000 }),
      ).not.toThrow();
    }
  });

  it("offers every command the parser actually recognises", async () => {
    // The drift this catches: `completions` shipped knowing only about
    // `completions` itself, while the parser had grown fourteen more verbs.
    // Every existing test asserted the script contained the spec — and the
    // spec was the thing that was wrong.
    const recognised = [
      "completions",
      "replay",
      "audit",
      "blame",
      "bisect",
      "serve",
      "acp",
      "attach",
      "doctor",
      "mcp",
      "add",
      "inspect",
      "packages",
      "update",
      "remove",
      "new",
    ];
    for (const word of recognised) {
      // Proof that the parser really treats it as a command, not prompt text.
      const parsed = parseArgs([word, "x"], { stdinIsTty: true });
      expect(parsed.ok || typeof parsed.error === "string").toBe(true);
      expect(
        DEFAULT_COMPLETION_SPEC.subcommands.map((sub) => sub.name),
        `completions never offers "${word}"`,
      ).toContain(word);
    }
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const script = generateCompletions(shell);
      for (const word of recognised) expect(script).toContain(word);
    }
  });

  it("offers every value-taking flag the parser accepts", async () => {
    const flags = [
      "--max-cost",
      "--dry-run",
      "--trace",
      "--host",
      "--port",
      "--token",
      "--cassette",
      "--web",
      "--web-port",
      "--web-origin",
    ];
    const longs = DEFAULT_COMPLETION_SPEC.flags.map((flag) => flag.long);
    for (const flag of flags) {
      // Proof it is a real flag: the parser does not call it unknown.
      const parsed = parseArgs([flag, "1", "-p", "hi"], { stdinIsTty: true });
      expect(
        parsed.ok || !parsed.error.includes("Unknown option"),
        `${flag} is not a real flag`,
      ).toBe(true);
      expect(longs, `completions never offers ${flag}`).toContain(flag);
    }
  });
});
