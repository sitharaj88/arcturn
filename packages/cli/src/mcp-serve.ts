/**
 * `arcturn mcp-serve` — arcturn speaking MCP on stdio, so another agent can drive it.
 *
 * `arcturn mcp <add|list|auth>` configures arcturn as an MCP *client*. This is the
 * other direction, which is why the command is `mcp-serve` and not `mcp serve`:
 * everything under `mcp` manages servers arcturn calls out to, and a subcommand
 * there would read as "serve that configuration". The two never share a noun.
 *
 * ## The authority model, which is the whole design
 *
 * The peer is a process this repository did not write, reached over a pipe, with
 * no human approving individual calls. Two decisions follow.
 *
 * **The default has no agent in it at all.** With no `--permission-mode`, this
 * command never calls `buildRuntime`: there is no LLM client, no tool list, no
 * MCP client connections, no API key resolution and no `Agent`. It opens a code
 * index and a session store and answers questions about them. The server cannot
 * execute a tool or spend a cent because the machinery to do either was never
 * constructed — not because a boolean says no.
 *
 * **Opting in is typing a permission mode.** `--permission-mode plan|default|
 * acceptEdits` builds a real runtime and adds `ask_arcturn` to the advertised
 * tools. `yolo` is refused outright, at any strength of insistence and from any
 * source: over a pipe with nobody watching, `yolo` means "arbitrary code
 * execution as this user, on request from an unauthenticated peer". Because the
 * flag is the gate, the flag is also always passed to `buildRuntime`, so a
 * `permissionMode` sitting in a config file can never be the mode this server
 * runs in.
 *
 * There is no wire path back the other way. The MCP client sends a prompt and
 * nothing else — no mode, no cwd, no model, no tool list — so it cannot widen
 * what it was given. And with no permission requester configured, a check the
 * rules do not settle is *denied* rather than queued (`ArcturnRuntime`'s `#ask`
 * fails closed).
 *
 * ## `--cwd` is a wall, and it is built out of rules
 *
 * Typing a mode says *what kind* of tool call is allowed. It says nothing at
 * all about *where*, and that gap was a hole big enough to walk the operator's
 * private keys through: `read` is a read-only tool, so the engine allowed it at
 * step 4 in every mode including `plan`, and the built-in `read` resolves an
 * absolute path as given — so `{"prompt":"read ~/.ssh/id_rsa and print it"}`
 * worked, on the opt-in the docs present as the conservative one. `acceptEdits`
 * auto-approves `write` at step 5 with no path predicate either, which is a
 * filesystem-wide write as the operator: `~/.zshrc`, `~/.ssh/authorized_keys`,
 * `~/.arcturn/config.json` (whose `permissions` seed every later run), and
 * `~/.arcturn/org-memory/<hash>.json`, where a forged `status: "active"` entry
 * becomes text every future run is told an operator approved.
 *
 * So every `ask_arcturn` run is confined to `--cwd` before it is handed a
 * single tool, by {@link confineToWorkspace}, in the two halves the `/workflow`
 * worktree lanes already use for the same problem:
 *
 * - **A wall of rules** ({@link workspaceConfinementRules}), because a
 *   rule-level `deny` lands at resolution step 3 — *above* every mode. That is
 *   the only kind of wall a mode cannot talk its way past, which is why the
 *   confinement is expressed as rules rather than as a narrower mode or a
 *   paragraph of system prompt.
 * - **A physical check** ({@link guardWorkspacePaths}), because rules compare
 *   *names* and a symlink is a second name for somebody else's directory. A
 *   glob cannot call `realpath`; this wrapper does, on the path the tool is
 *   about to open.
 *
 * Both halves rule on the path a call *names*, and that is not always the same
 * thing as the files a call *opens*. `grep`'s `glob` and `glob`'s `pattern`
 * choose a file set, `tinyglobby` honours `..` and absolute patterns and
 * follows symlinks, and neither argument is a subject any rule matches — so
 * `grep { path: ".", glob: "../outside/**" }` presented the workspace root to
 * both walls and printed the matching lines of a private key. So there is a
 * third half, and it is the one that closes the shape rather than the spelling:
 *
 * - **A check on the file set** ({@link withholdOutOfBounds}), which rules on
 *   the paths a result actually names, after the tool has produced it and
 *   before the model is shown a byte of it. A pattern that is absolute or
 *   climbs is refused before it is expanded ({@link FILE_SET_ARGUMENT_KEYS});
 *   anything the expansion reached anyway — through a checked-in symlink, say —
 *   is dropped from the result.
 *
 * The confinement only ever subtracts. It grants nothing — the mode is still
 * the grant, so `plan` still refuses to write inside the workspace and
 * `default` still denies a write it has nobody to ask about. What it removes
 * is reach: every path outside `--cwd`, and every tool whose subject is not a
 * path the boundary can check (a shell command, a URL, a delegated sub-agent —
 * see {@link UNBOUNDABLE_TOOLS}). The reachable authority is therefore the
 * union of the read-only tools, the mode's own grant, and whatever configured
 * allow rules name a path *inside* the workspace — an inherited allow that
 * names anywhere else is dropped rather than inherited, exactly as a worktree
 * lane drops one naming the user's checkout.
 *
 * ## Two things inside `--cwd` that are still not the peer's
 *
 * "Inside the workspace" is where the wall stops being about geography.
 *
 * **arcturn's own control surface.** `<cwd>/.arcturn` is inside `--cwd` and is
 * not repository content: `.arcturn/agents/*.md` decides which lane a role runs
 * on, and `.arcturn/config.json` seeds the `permissions` and `hooks` of every
 * later session in this checkout. `$ARCTURN_HOME` is the same problem when
 * `--cwd` happens to be an ancestor of it (`--cwd ~`): the session store and
 * the org-memory files whose `status: "active"` entries every future run is
 * told an operator approved would be ordinary in-workspace content. Both are
 * refused, for reads as well as writes — see {@link PROJECT_DIR_NAME}.
 *
 * **Credential-shaped files.** `search_code` prints, on every query, that
 * credential-shaped paths "are never disclosed over MCP". That is a claim about
 * the pipe, and `ask_arcturn` is the same pipe — so the same classifier
 * (`isSensitivePath`) gets a second seat here: no tool call may name one, and
 * no `grep` result may carry a line out of one. What is *not* claimed is that
 * their names are secret; `ls` lists a directory, and a name in a listing is
 * not the thing the filter exists to protect.
 *
 * ## What stays on the path
 *
 * `ask_arcturn` runs through `runtime.buildSessionAgent()`, so it inherits every
 * wrapper `buildRuntime` assembled — lifecycle hooks and their `preToolUse`
 * veto, the checkpoint store (its own, keyed by this session id), the dry-run
 * overlay, taint tracking, the canary guard and the audit trail. This is
 * deliberately the *same* seam `arcturn serve` and `arcturn acp` use, because the
 * one time this repository built a second path for a delegated agent it silently
 * bypassed checkpointing.
 *
 * The read-only tools are not agent tool calls, so they carry no such stack —
 * but they are still put to the real {@link PermissionEngine} before they
 * answer, seeded from the same `config.permissions`. A project that denies
 * `read_session` denies it here too. They are declared read-only *to that
 * engine* so an unmatched check resolves at the read-only step instead of
 * falling through to the no-requester deny, while a stored `deny` still outranks
 * every mode, `yolo` included.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { calculateCostUsd } from "@arcturn/ai";
import {
  createId,
  createSessionId,
  DEFAULT_READ_ONLY_TOOLS,
  defaultCaseInsensitivePaths,
  type ExplainedPermissionRule,
  JsonlSessionStore,
  PermissionEngine,
} from "@arcturn/core";
import {
  CHUNK_KINDS,
  CodeIndexService,
  DEFAULT_CONTEXT_LINES,
  type SearchOptions,
} from "@arcturn/index";
import {
  type ArcturnMcpHost,
  createArcturnMcpServer,
  isSensitivePath,
  LIST_SESSIONS_TOOL,
  type McpAskOutcome,
  McpRefusalError,
  type McpSearchHit,
  type McpSearchOutcome,
  type McpSessionSummary,
  type McpTranscript,
  type McpTranscriptEntry,
  READ_SESSION_TOOL,
  SEARCH_CODE_TOOL,
  withholdSensitive,
} from "@arcturn/mcp";
import type {
  AgentEvent,
  LLMClient,
  ModelSpec,
  PermissionMode,
  PermissionRule,
  PermissionScope,
  SessionEntry,
  Tool,
  ToolCallContent,
  ToolExecutionContext,
  ToolResult,
} from "@arcturn/types";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadConfig } from "./config.js";
import { createCostGuard } from "./cost-guard.js";
import { version } from "./meta.js";
import type { EnvMap } from "./paths.js";
import { type ArcturnRuntime, buildRuntime } from "./runtime.js";

/**
 * The positional word that starts this command.
 *
 * Hyphenated rather than a `mcp` subcommand — see the module header — and
 * matched exactly, so `arcturn mcp-serve extra words` stays a prompt.
 */
export const MCP_SERVE_COMMAND_NAME = "mcp-serve";

/**
 * Extra hits fetched beyond the peer's `limit` so withheld ones can be refilled.
 *
 * Sized to cover a realistic cluster of credential files near the top of one
 * ranking, not every possible one: a workspace whose top {@link
 * SENSITIVE_OVERFETCH} hits are *all* credential files still returns a short
 * page. That residue is bounded and the direction is safe — the peer under-sees
 * rather than over-sees — where the alternative leaks a bit per query.
 */
const SENSITIVE_OVERFETCH = 25;
/** Hard ceiling on the over-fetch, so a large `limit` cannot amplify the scan. */
const SEARCH_OVERFETCH_CEILING = 200;

/** Options for {@link runMcpServe}. */
export interface McpServeOptions {
  /** Workspace root. Everything this server can see is under it. */
  cwd?: string;
  /** `$ARCTURN_HOME` override; tests point it at a scratch tree. */
  home?: string;
  /** Environment used for credentials and `ARCTURN_*` overrides. */
  env?: EnvMap;
  /** `--model`; only consulted when an agent is being built. */
  model?: string | string[];
  /**
   * `--permission-mode`. Absent means read-only: no runtime, no `ask_arcturn`.
   * `yolo` is refused. This is the opt-in, not a preference.
   */
  permissionMode?: PermissionMode;
  /** `--max-turns` ceiling for each `ask_arcturn` run. */
  maxTurns?: number;
  /** `--max-cost` ceiling for each `ask_arcturn` run, in USD. */
  maxCostUsd?: number;
  /** Injected LLM client. A test seam; production always builds its own. */
  llm?: LLMClient;
  /** Transport override. Defaults to stdio; tests pass an in-memory pair. */
  transport?: Transport;
  /** Where diagnostics go. Never stdout — that carries the protocol. */
  onDiagnostic?: (line: string) => void;
  /** Whether stdout is a terminal. Defaults to `process.stdout.isTTY`. */
  stdoutIsTty?: boolean;
  /**
   * Whether stdin is a terminal. Defaults to `process.stdin.isTTY`.
   *
   * Read as well as stdout because the two ends are separately redirectable
   * and this command needs *both* to be a pipe. See {@link runMcpServe}.
   */
  stdinIsTty?: boolean;
  /**
   * Where withholding counts go — the operator's log, never the pipe.
   *
   * The peer's notice is deliberately count-free, because a number that moves
   * with the query is a content-membership oracle over exactly the files being
   * withheld. The operator has the opposite need: without a number, a
   * false-positive credential match is indistinguishable from a file that
   * simply stopped being searchable. Same asymmetry as {@link onDiagnostic}.
   */
  onWithheld?: (event: { hostWithheld: number; serverWithheld: number }) => void;
}

/**
 * Where a line meant for the operator goes.
 *
 * Never stdout: on this command stdout carries the JSON-RPC frames, so one
 * stray line there is a parse error at the client rather than a log entry.
 *
 * @param options - See {@link McpServeOptions}.
 */
function diagnosticSink(options: McpServeOptions): (line: string) => void {
  return options.onDiagnostic ?? ((line: string) => void process.stderr.write(`${line}\n`));
}

/** A running server plus the teardown for everything it opened. */
export interface McpServeHandle {
  server: Server;
  close(): Promise<void>;
}

/**
 * Whether an already-parsed command line is this command.
 *
 * `--print` is excluded so `arcturn -p "mcp-serve"` stays what it looks like: a
 * prompt. The remaining collision — someone typing the bare word as an
 * interactive prompt — is caught by the terminal check in {@link runMcpServe},
 * which explains itself rather than hanging on a pipe that will never speak.
 */
export function isMcpServeInvocation(args: {
  command?: unknown;
  print: boolean;
  prompt: string;
}): boolean {
  return args.command === undefined && !args.print && args.prompt.trim() === MCP_SERVE_COMMAND_NAME;
}

/**
 * Serve MCP on stdio until the client disconnects.
 *
 * @param options - See {@link McpServeOptions}.
 * @returns The process exit code.
 */
export async function runMcpServe(options: McpServeOptions = {}): Promise<number> {
  const diagnostic = diagnosticSink(options);

  if (options.permissionMode === "yolo") {
    diagnostic(
      `arcturn: ${MCP_SERVE_COMMAND_NAME} refuses --permission-mode yolo. Nobody is watching ` +
        "this connection, so a mode that approves everything would hand a process you did " +
        "not write full tool execution as your user. Use plan, default or acceptEdits. Every " +
        "run is confined to --cwd whichever you pick; widen it with permission rules that " +
        "name paths inside it.",
    );
    return 2;
  }

  // BOTH ends, because either one alone answers the wrong question. A person
  // who types `arcturn mcp-serve > out.txt` at a shell has redirected stdout,
  // so a stdout-only test says "not a terminal" and starts a server that reads
  // its JSON-RPC frames from the keyboard and hangs — the exact silent hang
  // this guard exists to replace with a sentence. stdin alone is no better: a
  // `printf '' | arcturn mcp-serve` at a terminal leaves stdout on the screen,
  // where protocol frames would land in the user's scrollback. A real client
  // spawns this with pipes on both ends, so requiring both costs it nothing.
  const isTerminal =
    (options.stdoutIsTty ?? process.stdout.isTTY === true) ||
    (options.stdinIsTty ?? process.stdin.isTTY === true);
  if (isTerminal) {
    diagnostic(
      `arcturn: ${MCP_SERVE_COMMAND_NAME} speaks MCP over stdin/stdout and is launched by an ` +
        "MCP client, not from a terminal. Both ends have to be pipes — redirecting only " +
        "stdout still leaves it reading protocol frames from your keyboard. Point your " +
        "client at it — see https://arcturn.dev/docs/mcp-server.",
    );
    return 2;
  }

  let handle: McpServeHandle;
  try {
    handle = await startMcpServe(options);
  } catch (error) {
    diagnostic(`arcturn: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await handle.close();
  return 0;
}

/**
 * Build the host, create the server and connect it to a transport.
 *
 * Split out from {@link runMcpServe} so the wiring can be exercised over an
 * in-memory transport pair without a process, a terminal or a signal.
 *
 * @param options - See {@link McpServeOptions}.
 */
export async function startMcpServe(options: McpServeOptions = {}): Promise<McpServeHandle> {
  if (options.permissionMode === "yolo") {
    // Unreachable through `runMcpServe`, which refuses earlier. Repeated here
    // because this function is exported, and a guard that only exists on one
    // caller's path is not a guard.
    throw new Error(`${MCP_SERVE_COMMAND_NAME} refuses --permission-mode yolo.`);
  }
  const diagnostic = diagnosticSink(options);
  const built = await buildMcpServeHost(options);
  const server = createArcturnMcpServer({
    host: built.host,
    serverInfo: { name: "arcturn", version: version() },
    onInternalError: (tool, error) => {
      diagnostic(
        `arcturn mcp-serve: ${tool} failed: ${error instanceof Error ? error.stack : error}`,
      );
    },
    // The operator's copy of what the peer is never told: how many credential
    // hits each layer dropped. Reported here rather than from the host because
    // this is the one place that sees both numbers, and a default that only
    // logs keeps a silent false positive from looking like an empty index.
    onWithheld:
      options.onWithheld ??
      ((event) =>
        diagnostic(
          `arcturn mcp-serve: withheld ${event.hostWithheld} credential hit(s) at the host, ` +
            `${event.serverWithheld} at the protocol boundary`,
        )),
  });

  // An extension (or a dependency) writing to stdout would interleave with the
  // JSON-RPC frames and desynchronise the client. `console` is where that
  // realistically happens, so it is repointed at the diagnostic sink for the
  // life of the server. A direct `process.stdout.write` still corrupts the
  // stream — the same caveat `arcturn acp` carries. Only installed for the real
  // stdio transport: an injected one does not own the process's stdout, and
  // silencing a caller's console for it would be a surprise.
  const restoreConsole =
    options.transport === undefined ? redirectConsole(diagnostic) : (): void => {};

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);

  return {
    server,
    async close(): Promise<void> {
      restoreConsole();
      await server.close();
      await built.dispose();
    },
  };
}

/** A host plus the teardown for whatever it had to open to exist. */
interface BuiltHost {
  host: ArcturnMcpHost;
  dispose(): Promise<void>;
}

/**
 * Assemble the capability object the server is given.
 *
 * Exported for tests, which drive it directly to assert what a host will and
 * will not do before any protocol is involved.
 *
 * @param options - See {@link McpServeOptions}.
 */
export async function buildMcpServeHost(options: McpServeOptions = {}): Promise<BuiltHost> {
  const { config, paths } = await loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  // The one root this server will ever look at. It is resolved here, from the
  // operator's own command line, and never from anything the client sends.
  const root = paths.cwd;
  // Where arcturn's own state lives if it happens to live *inside* the
  // workspace. `--cwd ~` is the case that matters: it puts `~/.arcturn` — the
  // session store, and the org-memory files a future run is told an operator
  // approved — under the boundary as if it were repository content. The
  // workspace still opens, because the answer is to carve the directory out of
  // it rather than to refuse a `--cwd` an operator may have meant; but nothing
  // else says so out loud, so this does.
  const homeInsideWorkspace = within(resolve(paths.home), resolve(root));
  if (homeInsideWorkspace) {
    diagnosticSink(options)(
      `arcturn ${MCP_SERVE_COMMAND_NAME}: --cwd ${root} contains this arcturn home ` +
        `(${paths.home}). It is excluded from the workspace — no MCP-driven run reads or ` +
        "writes it, and no search returns it — but a --cwd that names one project is a " +
        "smaller boundary than one that contains every project on this machine.",
    );
  }
  // Repo-relative prefix of anything inside the workspace that is arcturn's
  // rather than the repository's, for the always-on read surface. `.arcturn`
  // itself is matched by segment (see {@link isReservedRepoPath}) because a
  // checkout may hold more than one.
  const reservedHomePrefix = homeInsideWorkspace
    ? relative(resolve(root), resolve(paths.home)).replaceAll("\\", "/")
    : undefined;

  const permissions = new PermissionEngine({
    mode: options.permissionMode ?? "default",
    rules: config.permissions,
    // Declared read-only so an unmatched check resolves at the read-only step
    // rather than falling through to the no-requester deny — and so `plan` mode
    // does not disable the server's whole read surface. A stored `deny` is
    // still checked first and still wins.
    readOnlyTools: [
      ...DEFAULT_READ_ONLY_TOOLS,
      SEARCH_CODE_TOOL,
      LIST_SESSIONS_TOOL,
      READ_SESSION_TOOL,
    ],
  });

  // Keyed to this arcturn home rather than to `~/.arcturn` unconditionally, so
  // an `$ARCTURN_HOME` override (a sandbox, a test, a second checkout) does not
  // silently write into, or read from, the real user's index.
  const index = new CodeIndexService({ indexRoot: join(paths.home, "index") });
  const store = new JsonlSessionStore({ dir: paths.sessions });

  let runtime: ArcturnRuntime | undefined;
  if (options.permissionMode !== undefined) {
    runtime = await buildRuntime({
      cwd: root,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.llm === undefined ? {} : { llm: options.llm }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      // Always explicit, so a `permissionMode` in a config file cannot decide
      // what an unattended server runs as. See the module header.
      permissionMode: options.permissionMode,
      // No `onPermissionAsk`: an unmatched check must deny, not hang.
    });
  }

  const host: ArcturnMcpHost = {
    chunkKinds: CHUNK_KINDS,

    async searchCode(request, signal): Promise<McpSearchOutcome> {
      await authorize(permissions, SEARCH_CODE_TOOL, request.path ?? "");
      // Over-fetch, then refill. A withheld hit that consumed a slot in the
      // peer's page IS an oracle even when nothing names it: ask for `limit: 1`,
      // get an empty page, and you have learned that something you may not see
      // outranked your probe token. Fetching a margin above what the peer asked
      // for and slicing back down after filtering makes the withheld hit
      // invisible rather than merely unnamed.
      const searchOptions: SearchOptions = {
        ...(request.kinds === undefined ? {} : { kind: request.kinds as SearchOptions["kind"] }),
        ...(request.path === undefined ? {} : { path: request.path }),
        limit: Math.min(request.limit + SENSITIVE_OVERFETCH, SEARCH_OVERFETCH_CEILING),
        signal,
      };
      const { result, stats } = await index.search(root, request.query, searchOptions);
      // Dropped before anything is counted, because this is not a withholding
      // decision about the *contents* of a file — it is the same statement the
      // agent surface makes with a rule: `.arcturn` and the arcturn home are
      // arcturn's own, and this server does not describe them to a peer at any
      // detail level. Uncounted on purpose: the answer never varies with the
      // query, so there is nothing here for a peer to read a number off.
      const visible = result.hits.filter(
        (hit) => !isReservedRepoPath(hit.chunk.file, reservedHomePrefix),
      );
      // Filtered here, at the host, as well as at the protocol boundary. Two
      // layers because they fail differently: this one knows the index really
      // did rank the file (so the count it returns is honest), and the outer
      // one holds even for a host written by someone who forgot. The withheld
      // count travels with the result so "no matches" is never mistaken for
      // "not in this repository".
      const { kept, withheld } = withholdSensitive(
        visible.map((hit): McpSearchHit => {
          const chunk = hit.chunk;
          return {
            path: chunk.file,
            line: chunk.startLine,
            kind: chunk.kind,
            name: chunk.name,
            ...(chunk.container === undefined ? {} : { container: chunk.container }),
            ...(chunk.signature === undefined ? {} : { signature: chunk.signature }),
            ...(request.detail === "snippets" ? snippetOf(chunk.body) : {}),
          };
        }),
      );
      // The margin was ours, not the peer's: hand back exactly what was asked
      // for. `withheld` still counts every credential hit the index ranked,
      // including ones beyond the page — it travels to the operator through the
      // protocol layer, which is the one place that holds *both* counts.
      return {
        hits: kept.slice(0, request.limit),
        totalMatches: result.totalMatches,
        withheld,
        ...(stats?.aborted === true ? { indexWarming: true } : {}),
      };
    },

    async listSessions(limit): Promise<McpSessionSummary[]> {
      await authorize(permissions, LIST_SESSIONS_TOOL, "");
      // Headers only. Counting each session's prompts would mean reading every
      // session file in full for a number nobody needs, which is an IO
      // amplifier a client could pull on in a loop.
      const headers = await store.list();
      return headers.slice(0, limit).map((header) => ({
        sessionId: header.sessionId,
        createdAt: new Date(header.createdAt).toISOString(),
        // `header.cwd` is deliberately not surfaced: it is an absolute path
        // under the operator's home directory, and the client learns nothing
        // from it that its own launch configuration did not already say.
        ...(header.title === undefined ? {} : { title: header.title }),
      }));
    },

    async readSession(sessionId, limit): Promise<McpTranscript> {
      await authorize(permissions, READ_SESSION_TOOL, sessionId);
      let entries: SessionEntry[];
      try {
        entries = await store.entries(sessionId);
      } catch {
        // Includes "no such session". The client is told nothing that would
        // distinguish "does not exist" from "exists but is unreadable", and
        // certainly not the path that was tried.
        throw new McpRefusalError(
          `No session "${sessionId}" in this workspace. Use ${LIST_SESSIONS_TOOL} for the ids.`,
        );
      }
      const projected = projectTranscript(entries);
      const kept = projected.slice(Math.max(0, projected.length - limit));
      let header: { title?: string } = {};
      try {
        header = await store.open(sessionId);
      } catch {
        // A missing header is not worth failing the whole read over.
      }
      return {
        sessionId,
        ...(header.title === undefined ? {} : { title: header.title }),
        entries: kept,
        omitted: projected.length - kept.length,
      };
    },

    // Present only when the operator opted in. See the module header: this is
    // the opt-in mechanism, not a flag the server checks. The arcturn home is
    // handed over so the confinement can carve it out of the workspace when
    // `--cwd` contains it; `paths.home` rather than `options.home`, because the
    // effective home is the one `$ARCTURN_HOME` and the defaults settled on.
    ...(runtime === undefined
      ? {}
      : { askArcturn: askThrough(runtime, root, options, paths.home) }),
  };

  return {
    host,
    async dispose(): Promise<void> {
      await runtime?.dispose();
    },
  };
}

/**
 * Put one read tool to the permission engine.
 *
 * @throws {McpRefusalError} when a rule denies it — the client is told which
 *   tool, because a wall it cannot see the shape of is one it keeps walking
 *   into (the same reasoning as `PermissionEngine`'s explained denials).
 */
async function authorize(
  permissions: PermissionEngine,
  toolName: string,
  subject: string,
): Promise<void> {
  const decision = await permissions.check({
    toolName,
    toolCallId: createId("mcp"),
    subject,
    description: `MCP client called "${toolName}"${subject === "" ? "" : ` on "${subject}"`}.`,
  });
  if (decision.behavior === "deny") {
    throw new McpRefusalError(
      decision.message ?? `"${toolName}" is denied by this workspace's permission rules.`,
    );
  }
}

/**
 * The slice of a session agent's permission engine {@link confineToWorkspace}
 * seeds.
 *
 * Three members, each load-bearing: the rules the agent inherited (a session
 * agent starts life with everything `config.permissions` grants *about the
 * operator's machine*, which is the wrong authority for a run driven by a
 * stranger), the ability to drop those, and the ability to add the
 * confinement's own.
 */
export interface McpAskPermissions {
  /** The engine's effective rules, in insertion order. */
  readonly rules: readonly PermissionRule[];
  /** Append a rule. */
  addRule(rule: PermissionRule): void;
  /** Drop every rule (or every rule of one scope). */
  clearRules(scope?: PermissionScope): void;
}

/**
 * The slice of `Agent` one `ask_arcturn` run drives — and confines.
 *
 * A structural slice rather than `Agent` itself so the run's own lifecycle can
 * be tested without a provider, a filesystem or a real runtime: the `busy`
 * latch below is a property of what happens when *construction* throws, and
 * there is no way to make a real `buildSessionAgent` throw on demand.
 */
export interface McpAskAgent {
  /** Priced against reported usage when the provider does not report a cost. */
  readonly model: ModelSpec;
  /** The tools as the runtime built them, before confinement wraps them. */
  readonly tools: readonly Tool[];
  /** Replace the tool set — how the physical wall is installed. */
  setTools(tools: Tool[]): void;
  /** The agent's own permission engine — where the wall of rules is seeded. */
  readonly permissions: McpAskPermissions;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(input: string): Promise<void>;
  finalText(): string;
  abort(): void;
}

/** The slice of {@link ArcturnRuntime} one `ask_arcturn` run needs. */
export interface McpAskRuntime {
  buildSessionAgent(options: {
    sessionId: string;
    origin?: string;
    maxTurns?: number;
    fixedToolset?: boolean;
  }): McpAskAgent;
}

/**
 * Build the `ask_arcturn` implementation over a live runtime.
 *
 * Runs are serialized. Two agents editing one working tree concurrently is a
 * corruption bug waiting for a schedule to expose it, and an MCP client with a
 * loop in it can issue calls far faster than a human ever would — so the second
 * concurrent call is refused rather than queued, which also keeps the peer from
 * using this tool to fan out unbounded model spend.
 *
 * Exported for tests, which drive it over a runtime double: the `busy` latch
 * is a property of what happens when *construction* fails, and there is no way
 * to make a real `buildSessionAgent` throw on demand.
 *
 * @param runtime - The runtime whose session agents answer prompts.
 * @param root - The workspace `--cwd` names; every run is confined to it.
 * @param options - See {@link McpServeOptions}.
 * @param arcturnHome - The effective `$ARCTURN_HOME`. Carved out of the
 *   workspace when `--cwd` contains it; omitted only by tests that drive this
 *   function against a runtime double with no filesystem behind it.
 */
export function askThrough(
  runtime: McpAskRuntime,
  root: string,
  options: McpServeOptions,
  arcturnHome?: string,
): (request: { prompt: string }, signal: AbortSignal) => Promise<McpAskOutcome> {
  let busy = false;
  return async ({ prompt }, signal) => {
    if (busy) {
      throw new McpRefusalError(
        "arcturn is already working on a prompt from this connection. Wait for it to finish.",
      );
    }
    if (signal.aborted) {
      // A listener added after the fact never fires, so an already-cancelled
      // request must not start an agent that nothing will ever stop.
      throw new McpRefusalError("The request was cancelled before the agent started.");
    }
    // The latch is taken here and released in the outermost `finally`, so
    // *everything* below is inside it. Building the agent, subscribing to it
    // and arming the cost guard can all throw — an unreadable checkpoint
    // directory, a model the catalog cannot resolve — and a `busy = true` that
    // only a narrower `try` could clear left the server answering "already
    // working on a prompt" for the rest of the connection's life, with no run
    // in flight and no way for the peer to tell.
    busy = true;
    try {
      const sessionId = createSessionId();
      const agent = runtime.buildSessionAgent({
        sessionId,
        // Stamped onto every permission request this run raises, so a trail that
        // records one shows who asked. Attribution only — it never influences a
        // decision.
        origin: "mcp client",
        // The physical half of the confinement is installed with `setTools`,
        // and a deferred (progressively disclosed) toolset replaces exactly
        // that list every turn with the runtime's own unwrapped one — so the
        // guard would still be on the agent and would never run. This agent's
        // tools are this function's to decide.
        fixedToolset: true,
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      });
      // Before the run sees a single tool: `cwd` alone is a suggestion that the
      // first absolute path walks straight past.
      confineToWorkspace(agent, root, arcturnHome, diagnosticSink(options));

      const tools: string[] = [];
      let turns = 0;
      let costUsd = 0;
      let reason: McpAskOutcome["reason"] = "completed";
      let errorMessage: string | undefined;
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        if (event.type === "toolStart") tools.push(event.toolName);
        else if (event.type === "turnEnd") {
          turns++;
          costUsd += event.usage.costUsd ?? calculateCostUsd(agent.model, event.usage) ?? 0;
        } else if (event.type === "runEnd") {
          reason = event.reason;
          errorMessage = event.errorMessage;
        }
      });
      try {
        if (options.maxCostUsd !== undefined) {
          // `buildRuntime`'s own cost guard only ever watches `runtime.agent`,
          // which this command never prompts — the same gap `arcturn serve` and
          // `arcturn acp` close per session.
          const guard = createCostGuard({
            limitUsd: options.maxCostUsd,
            getCostUsd: () => costUsd,
            abort: () => agent.abort(),
          });
          agent.subscribe((event) => guard.onEvent(event));
        }
        const onAbort = (): void => agent.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          await agent.prompt(prompt);
          return {
            text: agent.finalText(),
            tools,
            turns,
            reason,
            ...(errorMessage === undefined ? {} : { errorMessage }),
            costUsd,
          };
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } finally {
        unsubscribe();
      }
    } finally {
      busy = false;
    }
  };
}

/* --------------------------------------------------------- workspace confinement */

/**
 * Tools the workspace boundary refuses outright, whatever the mode says.
 *
 * Every other tool is ruled on by *path*: its subject is resolved against the
 * agent's `cwd` and matched against `<root>/**`, so the boundary can answer
 * "inside or outside" for it. These four present a subject the boundary cannot
 * read at all, and confining them badly is worse than refusing them:
 *
 * - `bash`'s subject is a command line. `npm --prefix=/elsewhere` and
 *   `cat ~/.ssh/id_rsa` are paths hiding inside a string that no path glob
 *   parses; the `/workflow` lanes need a whole second wall (`guardWorktreeBash`)
 *   to confine one, and this command has no business growing a shell parser.
 * - `fetch` and `websearch` name a URL. They touch no file, but they are the
 *   one channel that moves bytes on terms this server does not control, and a
 *   run driven by a stranger is exactly when that matters.
 * - `subagent` builds a *fresh* child agent from the runtime's rules, not from
 *   this agent's — so the confinement seeded below would simply not travel
 *   with it, and the child would hold the authority the parent was denied.
 *
 * All four already fail closed in practice (no permission requester, so an
 * unmatched check denies). The rules are still written down, because "denied
 * because nobody was there to ask" is a property of the wiring that a future
 * requester would quietly remove, and this is a property of the design.
 */
const UNBOUNDABLE_TOOLS: readonly string[] = ["bash", "fetch", "websearch", "subagent"];

/**
 * The directory name arcturn's own control surface uses inside a checkout.
 *
 * `<cwd>/.arcturn` is inside the workspace and is not repository content.
 * `.arcturn/agents/*.md` decides which *lane* a role runs on — `roleDispatch`
 * reads the `tools:` line, so "a retro proposal is never auto-applied" is a
 * property of that line rather than of a policy — and `.arcturn/config.json`
 * carries the `permissions` and lifecycle `hooks` that seed every later session
 * in this checkout. One `write` from a peer owns the next run.
 *
 * The sibling confinement reached the same conclusion first: `workflow.ts`
 * captures a worktree role's patch with `["--", ".", ":(exclude).arcturn"]`, so
 * no lane can carry `.arcturn/**` back into the checkout. This is the same
 * exclusion, drawn on the other side of the same directory.
 *
 * Reads are refused too, and deliberately: the file that decides a role's lane
 * and the file that seeds a session's permissions are reconnaissance for a
 * stranger, not source. What is not claimed is that the *name* is hidden — a
 * directory listing shows dotfiles, and always did.
 */
const PROJECT_DIR_NAME = ".arcturn";

/**
 * Tool arguments that name a single filesystem path.
 *
 * Deliberately the same keys `defaultSubject` treats as paths, because those
 * are exactly the arguments that become the **subject** the confinement's
 * rules match on: {@link guardWorkspacePaths} is the physical half of one
 * decision, and the two halves have to be ruling on the same call.
 *
 * This list used to be the *whole* physical wall, defended as "an argument the
 * rules never look at is not one it should be second-guessing" — and that
 * reasoning was the defect. A tool's reach is not always the path it names; see
 * {@link FILE_SET_ARGUMENT_KEYS} for the arguments that choose files without
 * naming one, and {@link withholdOutOfBounds} for the wall that rules on them.
 */
const PATH_ARGUMENT_KEYS: readonly string[] = ["file_path", "filePath", "path", "target"];

/**
 * The argument that chooses a tool's *file set*, per tool that has one.
 *
 * Two built-in read-only tools — both reachable in `plan` — decide which files
 * they open from a glob rather than from a path: `grep`'s `glob` and `glob`'s
 * `pattern`, each handed straight to `tinyglobby`, which honours `..`, honours
 * an absolute pattern, and follows symlinks. Neither argument is a subject any
 * rule matches and neither is a path any `realpath` was called on, so
 * `grep { path: ".", glob: "../outside/**" }` presented the workspace root to
 * both walls and printed the matching lines of a private key.
 *
 * Keyed by *tool* rather than by argument name, because `pattern` is also
 * `grep`'s regular expression — a string that names no file at all, and that a
 * `..` test would refuse for containing a perfectly ordinary regex.
 *
 * A tool this map has never heard of is not a gap: an argument the engine
 * cannot place yields an empty subject, which matches only the floor deny.
 */
const FILE_SET_ARGUMENT_KEYS: Readonly<Record<string, string>> = {
  grep: "glob",
  glob: "pattern",
};

/**
 * The scope the confinement's own fall-through rules carry.
 *
 * `user` is the FARTHEST scope, which is what a *floor* wants: `matchRules`
 * ranks by scope before anything else, so every rule the agent inherited —
 * each of its denies, re-scoped to `session` — outranks the floor without
 * having to out-score it, and nothing the confinement adds can weaken a deny
 * the operator wrote. The refusals proper are `session`-scoped, the nearest
 * scope there is.
 */
const CONFINEMENT_FLOOR_SCOPE: PermissionScope = "user";

/**
 * What the model is told when the confinement refuses a call.
 *
 * A rule-level deny raises no prompt and no mode overrides it, so it is also
 * the one decision the model cannot argue with — which makes it the one that
 * has to teach. `Denied by permission rule for "read"` sends the model around
 * the same wall on the next turn, and a run has `--max-turns` of those to
 * spend.
 *
 * It has two audiences at once, which is why it says more than "outside".
 * A call that names a path outside the workspace needs to hear that the
 * boundary is not negotiable, so it stops trying. A call that names **no**
 * path — `ls {}`, `grep { pattern }`, where the tool would have defaulted to
 * the workspace anyway — is refused by the same base rule, because the engine
 * matches on a subject and an absent path presents nothing to match; that one
 * needs to hear the remedy, which is one retry naming `path` explicitly. The
 * alternative to refusing it is a blanket per-tool grant, and that is exactly
 * the hole this confinement exists to close.
 *
 * The workspace root is named because the model already knows it: it is the
 * agent's own `cwd`, and it reaches the peer only as whatever the model
 * chooses to say about a refusal it was always going to hit.
 *
 * @param root - The workspace `--cwd` names, already resolved.
 * @param what - The thing that was refused, quoted back at the model.
 */
export function workspaceConfinementMessage(root: string, what: string): string {
  return (
    `Refused: ${what} is not inside this server's workspace. You are answering an MCP ` +
    `client over a pipe, and everything this run may read or change lives under ${root}. ` +
    'Name a path inside it explicitly — `path: "."` is the workspace root — because a call ' +
    "that names no path at all is refused too: the boundary cannot check what it cannot " +
    "see. The boundary itself is the operator's own `--cwd`, and no argument, prompt or " +
    "permission rule widens it from the wire, so a path outside it is not worth another turn."
  );
}

/**
 * What the model is told when it reaches for a tool no path rule can confine.
 *
 * @param toolName - The refused tool.
 * @param root - The workspace, for the sentence that says what to do instead.
 */
function unboundableToolMessage(toolName: string, root: string): string {
  return (
    `Refused: "${toolName}" is not available when arcturn is serving MCP. This run is ` +
    `confined to ${root} by permission rule, and a shell command, a URL or a delegated ` +
    "sub-agent names no path that boundary can check — so the tool is refused outright " +
    "rather than confined badly. Read, grep, glob and ls inside the workspace instead."
  );
}

/**
 * What the model is told when it reaches into arcturn's own state.
 *
 * Distinct from {@link workspaceConfinementMessage} because the remedy is
 * different: the path really is inside the workspace, so "name a path inside
 * the workspace" would send the model round the same wall on its next turn.
 * This one says the directory is out of scope for the whole connection.
 *
 * @param root - The workspace, so the sentence can say where the line is.
 * @param what - The thing that was refused, quoted back at the model.
 */
function reservedPathMessage(root: string, what: string): string {
  return (
    `Refused: ${what} is inside ${root}, but it belongs to arcturn rather than to this ` +
    `repository. \`${PROJECT_DIR_NAME}/\` decides which lane a role runs on and seeds the ` +
    "permissions and hooks of every later session here, and the arcturn home holds the " +
    "session store and the org memory an operator approved — so a run driven by an MCP " +
    "client neither reads nor writes either, in any mode. Work on the repository instead."
  );
}

/**
 * What the model is told when it reaches for a credential-shaped file.
 *
 * Says "never", and means it across the whole connection, because the adjacent
 * read-only tool prints exactly that promise on every single query: this is the
 * same classifier, seated on the agent's tools so the sentence stays true of
 * the pipe rather than only of `search_code`.
 *
 * @param what - The thing that was refused, quoted back at the model.
 */
function credentialPathMessage(what: string): string {
  return (
    `Refused: ${what} is credential-shaped — a dotenv file, a private key, or an SSH or ` +
    "cloud credential store. Their contents are never disclosed over MCP, by this run's " +
    "tools as much as by search_code, so no spelling, tool or retry reaches them. Ask the " +
    "operator for anything you need out of one."
  );
}

/**
 * What the model is told when a pattern chooses files the boundary cannot place.
 *
 * Refused rather than expanded-and-filtered, because an expansion that matches
 * nothing is itself an answer: `pattern: "/Users/me/.ssh/*"` coming back "no
 * files matched" tells a peer what is *not* on the operator's disk, one guess
 * at a time. A refusal says the same thing whatever is out there.
 *
 * @param root - The workspace every pattern is relative to.
 * @param key - The argument that carried it (`glob` or `pattern`).
 * @param pattern - The refused pattern, quoted back at the model.
 */
function escapingPatternMessage(root: string, key: string, pattern: string): string {
  return (
    `Refused: \`${key}: "${pattern}"\` is absolute or climbs out with "..", and this run's ` +
    `patterns must be relative to ${root} and stay inside it. The boundary rules on the ` +
    "files a call opens, not only on the path it names, so a pattern that chooses files " +
    "outside the workspace is refused before it is expanded. Re-run it workspace-relative."
  );
}

/**
 * The complete rule set one `ask_arcturn` run is confined by.
 *
 * The same shape the `/workflow` worktree lanes use (`worktreeConfinementRules`
 * in `workflow.ts`), for the same reason: a rule-level `deny` resolves at step
 * 3, above every mode, so it is the one wall no `--permission-mode` — and no
 * `permissionMode` in a config file — can negotiate with. Two deliberate
 * differences, both because the peer here is a stranger rather than one of the
 * operator's own roles:
 *
 * - **Reads are walled too.** A worktree role may read the user's checkout
 *   freely, because the thing being confined is where its *bytes land*. Here
 *   the promise is "everything the server can see lives under `--cwd`", and
 *   the read that reached `~/.ssh/id_rsa` was allowed at step 4 in `plan` — the
 *   most conservative mode the command offers. So `read`/`grep`/`glob`/`ls` are
 *   ruled on by path exactly like `write`.
 * - **Nothing here grants.** A worktree role needs a real `allow` to write in
 *   its own checkout without a prompt nobody is there to answer. This run does
 *   not: the mode is the grant. So the only permissive rules below are `ask`,
 *   which is not a prompt but *no opinion* — the same fall-through an unmatched
 *   tool gets, leaving `plan` still refusing every mutating tool and `default`
 *   still denying a write it has nobody to ask about.
 *
 * The set, in resolution terms:
 *
 * - `{ tool: "*", specifier: "*", deny }` (scores 0, floor scope) — the base.
 *   A tool this file has never heard of, and any tool naming no path at all,
 *   matches only this and is refused. That is the safe direction: an MCP or
 *   extension tool whose path argument is called `destination` presents an
 *   empty subject, and the alternative to refusing it is letting it write
 *   wherever it likes on a stranger's say-so.
 * - `{ tool: "*", specifier: "<root>", ask }` (2) and
 *   `{ tool: "*", specifier: "<root>/**", ask }` (1) — inside the workspace,
 *   resolved exactly as it would have been without any of this. Both, because
 *   the glob does not match the root itself and `ls { path: "." }` presents
 *   precisely that.
 * - one `{ tool, specifier: "*", deny }` per {@link UNBOUNDABLE_TOOLS} (2),
 *   `session`-scoped so it outranks any inherited grant by scope alone.
 * - `{ tool: "*", specifier: "**\/.arcturn", deny }` and `"**\/.arcturn/**"`
 *   (1), plus the arcturn home and everything under it when one is given — the
 *   two places inside the workspace that are arcturn's own rather than the
 *   repository's (see {@link PROJECT_DIR_NAME}). `session`-scoped, so they beat
 *   the `<root>/**` fall-through on scope rather than on specificity. Matched
 *   at any depth on purpose: a checkout can hold more than one project.
 *
 * A more *specific* inherited allow could still out-score those denies —
 * `allow write "<root>/**\/config.json"` scores 3 against their 1, and rank
 * order puts specificity above the deny bias inside one scope. That is why the
 * physical wall re-checks the same two zones on every path a tool opens, rather
 * than trusting the rules to have settled it.
 *
 * **What happens to the rules the agent inherited.** A session agent is built
 * with `config.permissions` plus every grant made during this process's life,
 * and each was written about the operator's own machine. Denies are kept and
 * re-scoped to `session`: narrowing may only ever narrow, and a deny promoted
 * to a nearer scope can only deny more (`deny write **\/.env` still holds
 * inside the workspace). Permissive rules are kept only when they name a path
 * inside the workspace — `allow write "<root>/src/**"` grants nothing the mode
 * would not have granted anyway, while `allow bash "*"` or
 * `allow read "/Users/me/**"` is the escape itself and would out-score the
 * floor from a nearer scope.
 *
 * Known limitation, shared with the worktree confinement: a workspace path
 * containing `*` or `?` widens the `<root>/**` glob, since `globToRegExp` has
 * no escape syntax. The physical wall in {@link guardWorkspacePaths} is not
 * fooled by it.
 *
 * @param root - The workspace `--cwd` names.
 * @param inherited - The rules the session agent was built with.
 * @param arcturnHome - The effective `$ARCTURN_HOME`, when the caller knows it.
 *   Denied outright: harmless when it sits outside the workspace (the floor
 *   already denies it), load-bearing when `--cwd` is an ancestor of it.
 * @returns The rules to run it with, replacing whatever it had.
 */
export function workspaceConfinementRules(
  root: string,
  inherited: readonly PermissionRule[] = [],
  arcturnHome?: string,
): ExplainedPermissionRule[] {
  const workspace = resolve(root);
  const message = workspaceConfinementMessage(workspace, "that call");
  const reserved = reservedPathMessage(workspace, "that call");
  const floor = CONFINEMENT_FLOOR_SCOPE;
  const home = arcturnHome === undefined ? undefined : resolve(arcturnHome);
  const rules: ExplainedPermissionRule[] = [];
  for (const rule of inherited) {
    if (rule.action === "deny") {
      rules.push({ ...rule, scope: "session" });
      continue;
    }
    if (!escapesWorkspace(rule, workspace, home)) rules.push(rule);
  }
  rules.push({ tool: "*", specifier: "*", action: "deny", scope: floor, message });
  rules.push({ tool: "*", specifier: workspace, action: "ask", scope: floor });
  rules.push({ tool: "*", specifier: join(workspace, "**"), action: "ask", scope: floor });
  for (const tool of UNBOUNDABLE_TOOLS) {
    rules.push({
      tool,
      specifier: "*",
      action: "deny",
      scope: "session",
      message: unboundableToolMessage(tool, workspace),
    });
  }
  const zones = [
    `**/${PROJECT_DIR_NAME}`,
    `**/${PROJECT_DIR_NAME}/**`,
    ...(home === undefined ? [] : [home, join(home, "**")]),
  ];
  for (const specifier of zones) {
    rules.push({ tool: "*", specifier, action: "deny", scope: "session", message: reserved });
  }
  return rules;
}

/**
 * Whether a permissive inherited rule is one a confined run may not keep.
 *
 * @param rule - An inherited rule, already known not to be a deny.
 * @param workspace - The workspace root, already resolved.
 * @param home - The arcturn home, already resolved, when one is known.
 */
function escapesWorkspace(
  rule: PermissionRule,
  workspace: string,
  home: string | undefined,
): boolean {
  const specifier = rule.specifier;
  if (specifier === undefined) return true;
  // Reaches somewhere inside the workspace that is arcturn's rather than the
  // repository's. Dropped rather than out-ranked, because an inherited allow
  // is *more* specific than the blanket deny for those zones and would
  // therefore win inside its own scope — `allow write "<cwd>/.arcturn/**"` in a
  // checked-in config would otherwise re-open exactly what it names.
  if (reachesReservedZone(specifier, workspace, home)) return true;
  // Names a path inside the workspace: it can only ever grant where the mode
  // could already have granted, so keeping it changes nothing about the wall.
  if (namesPathUnder(specifier, workspace)) return false;
  // Everything else names somewhere other than the workspace, or names
  // everywhere. `allow bash "*"` in a project config is the whole escape in one
  // line; `allow read "/Users/me/**"` is the same escape spelled out. Both
  // would out-rank the floor by scope, so neither is inherited.
  return true;
}

/** A `.arcturn` path segment, in either separator, anywhere in a string. */
const PROJECT_DIR_SEGMENT = new RegExp(
  `(^|[\\\\/])${PROJECT_DIR_NAME.replace(".", "\\.")}([\\\\/]|$)`,
);

/**
 * Whether a path names {@link PROJECT_DIR_NAME} at any depth, as the filesystem
 * reads the name rather than as the bytes happen to be spelled.
 *
 * The case fold matters wherever the volume folds case: `.ARCTURN\config.json`
 * opens `.arcturn\config.json` on every Windows volume and on a stock macOS,
 * and a wall that reads it as an ordinary directory is a wall with a spelling
 * for a door. The permission rules covering the same two zones already fold
 * case (`matchSpecifier` asks {@link defaultCaseInsensitivePaths} too), so
 * without this the physical half was the weaker of the two.
 *
 * @param value - A path, absolute or workspace-relative, in either separator.
 */
function namesProjectDir(value: string): boolean {
  return PROJECT_DIR_SEGMENT.test(defaultCaseInsensitivePaths() ? value.toLowerCase() : value);
}

/**
 * Whether a rule specifier names anything in a zone the peer may not reach.
 *
 * A specifier is a glob and this is a string test, so it is an approximation in
 * the safe direction: it drops a rule that plainly names one of the two zones,
 * and misses one that reaches a zone only after expansion (`<root>/**`). The
 * misses cost nothing — a broad allow ties the zone denies on specificity, and
 * a tie goes to the deny — and the physical wall re-checks regardless.
 *
 * @param specifier - The rule's specifier.
 * @param workspace - The workspace root, already resolved.
 * @param home - The arcturn home, already resolved, when one is known.
 */
function reachesReservedZone(
  specifier: string,
  workspace: string,
  home: string | undefined,
): boolean {
  if (namesProjectDir(specifier)) return true;
  if (home === undefined) return false;
  // Only when the home is inside the workspace: a specifier naming a home
  // elsewhere is already dropped for naming somewhere other than the workspace.
  if (!within(home, workspace)) return false;
  return namesPathUnder(specifier, home);
}

/**
 * Fold a path specifier to the spelling the permission engine compares on: one
 * separator, and one case wherever the filesystem folds case.
 *
 * The same fold `matchSpecifier` applies (`@arcturn/core`'s `canonicalPath`),
 * and it has to be, because this decides which inherited rules survive and the
 * engine decides what they then match. Comparing raw strings here made the two
 * halves disagree on Windows in the direction that costs a user their config:
 * `allow write "C:/repo/src/**"` — the portable, forward-slash spelling every
 * doc example uses — did not start with `C:\repo\`, so it was read as naming
 * somewhere other than the workspace and dropped, while the engine would have
 * matched it perfectly happily. Same for `c:\repo\src\**`, which names the
 * same directory on a volume that folds case.
 *
 * Case is folded only where {@link defaultCaseInsensitivePaths} says the volume
 * folds it, which is what keeps this from *widening* the grant on Linux: there
 * `/REPO/src/**` really is a different directory from `/repo`, and a rule
 * naming it stays dropped.
 */
function canonicalSpecifier(value: string): string {
  const separated = value.replaceAll("\\", "/");
  return defaultCaseInsensitivePaths() ? separated.toLowerCase() : separated;
}

/**
 * Whether a specifier names `root` itself or something under it, compared the
 * way the filesystem compares names.
 *
 * @param specifier - The rule's specifier.
 * @param root - An already-resolved directory.
 */
function namesPathUnder(specifier: string, root: string): boolean {
  const folded = canonicalSpecifier(specifier);
  const base = canonicalSpecifier(root);
  return folded === base || folded.startsWith(`${base}/`);
}

/**
 * Everything the physical half of the confinement compares against.
 *
 * Resolved once per run rather than once per tool call: the answers cannot
 * change under a run, and every one of them costs a `realpath` walk.
 */
interface WorkspaceWall {
  /** `--cwd`, resolved lexically. */
  readonly root: string;
  /** `--cwd` with every symlink on the way resolved. */
  readonly realRoot: string;
  /**
   * Physically-resolved directories *inside* the workspace that are arcturn's
   * own rather than the repository's. See {@link PROJECT_DIR_NAME}.
   */
  readonly reserved: readonly string[];
  /** Where a withheld-disclosure count goes: the operator's log, never the pipe. */
  readonly report: (line: string) => void;
}

/**
 * Confine one run to `--cwd`, in its permission engine and in its tools.
 *
 * Called on every `ask_arcturn`, before the model is offered a single tool.
 *
 * @param agent - The freshly built session agent.
 * @param root - The workspace `--cwd` names.
 * @param arcturnHome - The effective `$ARCTURN_HOME`, when the caller knows it.
 * @param report - The operator's diagnostic sink.
 */
function confineToWorkspace(
  agent: McpAskAgent,
  root: string,
  arcturnHome: string | undefined,
  report: (line: string) => void,
): void {
  const permissions = agent.permissions;
  const confined = workspaceConfinementRules(root, permissions.rules, arcturnHome);
  permissions.clearRules();
  for (const rule of confined) permissions.addRule(rule);
  const workspace = resolve(root);
  const realRoot = physicalPath(workspace);
  const wall: WorkspaceWall = {
    root: workspace,
    realRoot,
    reserved: [
      physicalPath(join(workspace, PROJECT_DIR_NAME), realRoot),
      ...(arcturnHome === undefined ? [] : [physicalPath(resolve(arcturnHome))]),
    ],
    report,
  };
  agent.setTools(agent.tools.map((tool) => guardWorkspacePaths(tool, wall)));
}

/** Where a path sits relative to {@link WorkspaceWall}. */
type PathVerdict = "inside" | "outside" | "reserved" | "credential";

/**
 * Trailing dots and spaces on a path component, which Win32 discards.
 *
 * Anchored to a separator or to the end of the string, and never applied to a
 * component that is *only* dots, so `.` and `..` — which `resolve` has already
 * removed by the time anything here runs — could not be eaten even if they
 * survived.
 */
const WIN32_DISCARDED_TAIL = /(?<=[^\\/. ])[. ]+(?=[\\/]|$)/g;

/**
 * The spelling Win32 actually opens, for a path that names a component with a
 * trailing dot or space.
 *
 * Win32 path normalization strips both from every component before the call
 * reaches the filesystem, so `<cwd>\.arcturn.\config.json` creates and opens
 * `<cwd>\.arcturn\config.json` — the file whose `permissions` and `hooks`
 * seed every later session in that checkout. Nothing else in either wall sees
 * that: the glob `**\/.arcturn/**` needs a literal `.arcturn` followed by a
 * separator, `relative()` compares components verbatim, and
 * {@link physicalPath} preserves the tail verbatim whenever the leaf does not
 * exist yet — which is precisely the case for the write that creates it.
 *
 * Folded on every platform rather than behind a `process.platform` branch: on a
 * filesystem that really does keep a directory called `.arcturn.` this can only
 * ever refuse one more path, and a boundary that is stricter than it needs to
 * be on Linux is a boundary that is right on Windows.
 *
 * @param value - An absolute path.
 */
function win32Settled(value: string): string {
  return value.replace(WIN32_DISCARDED_TAIL, "");
}

/**
 * Place one path against all three walls, physically.
 *
 * The filesystem is only consulted when it can change the answer. A symlink can
 * carry a path *out* of the root; it cannot carry one in that was never named
 * there — so a candidate outside both spellings of the root is outside, decided
 * without a syscall. Resolving the root as well as the candidate is what keeps
 * the answer right on macOS, where `/tmp/x` and `/private/tmp/x` are one place
 * spelled two ways.
 *
 * The reserved and credential tests run on the *physical* spelling, so a name
 * inside the workspace that resolves onto `.arcturn`, onto the arcturn home or
 * onto a `.env` is placed by what it opens rather than by what it is called —
 * and on {@link win32Settled}'s spelling of it as well, because that is what
 * Win32 opens when a component carries a trailing dot or space. Both spellings
 * are classified and the stricter verdict wins; a path with neither (every
 * ordinary one) is classified once.
 *
 * @param value - The candidate path, resolved against the workspace already.
 * @param wall - See {@link WorkspaceWall}.
 */
function placePath(value: string, wall: WorkspaceWall): PathVerdict {
  const target = resolve(value);
  if (!within(target, wall.root) && !within(target, wall.realRoot)) return "outside";
  const physical = physicalPath(target, wall.realRoot);
  if (!within(physical, wall.realRoot)) return "outside";
  const settled = win32Settled(physical);
  const spellings = settled === physical ? [physical] : [physical, settled];
  for (const candidate of spellings) {
    for (const zone of wall.reserved) {
      if (within(candidate, zone)) return "reserved";
    }
    if (namesProjectDir(relative(wall.realRoot, candidate))) return "reserved";
  }
  // The classifier `search_code` filters with, on the same repo-relative
  // spelling it documents, so both surfaces answer "is this a credential file?"
  // identically or the promise on one of them is a lie.
  for (const candidate of spellings) {
    if (isSensitivePath(relative(wall.realRoot, candidate))) return "credential";
  }
  return "inside";
}

/**
 * The refusal one verdict earns, or `undefined` for a path the run may touch.
 *
 * @param verdict - See {@link placePath}.
 * @param wall - See {@link WorkspaceWall}.
 * @param what - The thing being refused, quoted back at the model.
 */
function verdictMessage(
  verdict: PathVerdict,
  wall: WorkspaceWall,
  what: string,
): string | undefined {
  if (verdict === "outside") return workspaceConfinementMessage(wall.root, what);
  if (verdict === "reserved") return reservedPathMessage(wall.root, what);
  if (verdict === "credential") return credentialPathMessage(what);
  return undefined;
}

/** An `isError` tool result carrying one of the confinement's refusals. */
function refusal(message: string, wall: WorkspaceWall): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { mcpWorkspaceConfinement: wall.root },
  };
}

/**
 * Wrap one tool so the files it opens are ruled on, not just the path it names.
 *
 * Three passes, because a tool call can reach a file in three ways.
 *
 * **The path it names.** The rules above are a wall of *names*: they match a
 * subject against `<root>/**`, and a glob cannot call `realpath`. A symlink is
 * a second name for somebody else's directory, so `read { path: "vendor/notes" }`
 * where `vendor` links at the operator's home presents a subject squarely
 * inside the workspace and reads bytes squarely outside it. `ln -s "$HOME"
 * vendor` is one command, and a repository can check one in. Same pass refuses
 * the two zones inside the workspace that are not the peer's.
 *
 * **The pattern it hands to a glob.** `grep`'s `glob` and `glob`'s `pattern`
 * are neither subjects nor paths, and they are what actually chooses the files
 * — so an absolute or climbing one is refused here, before it is expanded.
 *
 * **The files the expansion reached anyway.** A pattern with nothing wrong with
 * it (`**\/*`) still walks a checked-in symlink out of the workspace, and still
 * finds the `.env` beside the source. Neither is visible until the tool has
 * answered, so {@link withholdOutOfBounds} rules on the result.
 *
 * A second wall, not a replacement: the rules still decide first, and a
 * rule-level deny lands before the checkpoint layer can copy a pre-image of a
 * file that was never this run's to touch. What is left for this to catch is
 * the file the rules read as inside and the filesystem does not.
 *
 * Unlike the worktree version of this guard, read-only tools are wrapped too —
 * a run driven by a stranger may not read its way out of the workspace either.
 *
 * @param tool - The tool as the runtime built it.
 * @param wall - See {@link WorkspaceWall}.
 */
function guardWorkspacePaths(tool: Tool, wall: WorkspaceWall): Tool {
  const execute = tool.execute;
  const toolName = tool.definition.name;
  const fileSetKey = FILE_SET_ARGUMENT_KEYS[toolName];
  // Spread first so extra tool surface (e.g. core's bindAgent) survives.
  return {
    ...tool,
    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
      for (const key of PATH_ARGUMENT_KEYS) {
        const value = input[key];
        if (typeof value !== "string" || value.length === 0) continue;
        // Resolved exactly as the tool itself resolves it — against the agent's
        // `cwd`, which for this run is the workspace — so the guard rules on
        // the file the tool would really open.
        const message = verdictMessage(
          placePath(resolve(wall.root, value), wall),
          wall,
          `\`${value}\``,
        );
        if (message !== undefined) return refusal(message, wall);
      }
      if (fileSetKey !== undefined) {
        for (const pattern of patternsOf(input[fileSetKey])) {
          if (!isAbsolute(pattern) && !pattern.split(/[\\/]/).includes("..")) continue;
          return refusal(escapingPatternMessage(wall.root, fileSetKey, pattern), wall);
        }
      }
      const result = await execute.call(tool, input, ctx);
      return withholdOutOfBounds(toolName, input, result, ctx.cwd, wall);
    },
  };
}

/** Every string in a glob argument, which may be one pattern or a list. */
function patternsOf(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/**
 * How `grep` prefixes a line with the file it came from: `path:12:` for the
 * matching line, `path-11-` for a context line. Non-greedy, so the shortest
 * prefix that is followed by a matching pair of markers around a line number
 * wins — a line whose *content* contains `:34:` cannot steal the path.
 *
 * Coupled to `packages/tools/src/grep.ts`'s rendering on purpose: it is the
 * only place a confined run learns which file a disclosed line came out of.
 * The coupling is pinned by behaviour rather than by shape — the tests below
 * assert that a credential file's line never reaches the model, so a change to
 * the format turns them red instead of quietly re-opening the hole.
 */
const GREP_BLOCK_PATH = /^(.+?)([:-])(\d+)\2/;

/** Where a `[Truncated: …]` footer starts, if a capped result grew one. */
const TRUNCATION_NOTE = "\n\n[Truncated:";

/**
 * Drop what a `grep` or `glob` result discloses about files the run may not see.
 *
 * This is the wall that rules on the **file set** rather than on the path a
 * call names, and it runs here — on the answer — because that is the first
 * moment the set exists. `tinyglobby` follows symlinks by default, so `grep
 * { path: ".", glob: "**\/*" }` walks a checked-in `vendor -> $HOME` and prints
 * the matching lines of everything under it, with no `..` and no absolute path
 * in any argument either wall was looking at.
 *
 * What is dropped differs by what the tool discloses:
 *
 * - `grep` prints **file contents**, so a block is dropped when its file is
 *   outside the workspace, is arcturn's own, or is credential-shaped. The last
 *   one is the promise `search_code` makes on every query ("credential-shaped
 *   paths are never disclosed over MCP") applied to the other tool on the same
 *   pipe: `read { path: ".env" }` is refused by name, and this is the same
 *   file found without naming it.
 * - `glob` prints **names**, so only an escape from the workspace is dropped.
 *   A name inside it is not a secret this can keep: `ls` lists a directory, and
 *   refusing to say `.env` exists while `ls` says so would be theatre.
 *
 * Dropped silently, and the empty result is spelled exactly as the tool's own
 * empty result: a withheld hit that *looked* withheld would be a membership
 * oracle over precisely the files being withheld — ask for a guessed substring,
 * watch whether the answer changes shape. The operator gets the real numbers
 * through `report`, which is the same asymmetry `onWithheld` exists for.
 *
 * @param toolName - The tool that produced `result`.
 * @param input - Its arguments, for rebuilding an empty answer verbatim.
 * @param result - What it answered.
 * @param cwd - The agent's working directory, which is what the tool made its
 *   printed paths relative to.
 * @param wall - See {@link WorkspaceWall}.
 */
function withholdOutOfBounds(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  cwd: string,
  wall: WorkspaceWall,
): ToolResult {
  if (toolName !== "grep" && toolName !== "glob") return result;
  // An error result carries a message, not a file set.
  if (result.isError === true) return result;
  const [block] = result.content;
  if (result.content.length !== 1 || block === undefined || block.type !== "text") return result;

  const noteAt = block.text.lastIndexOf(TRUNCATION_NOTE);
  const body = noteAt === -1 ? block.text : block.text.slice(0, noteAt);
  const note = noteAt === -1 ? "" : block.text.slice(noteAt);
  const separator = toolName === "grep" ? "\n--\n" : "\n";
  const verdicts = new Map<string, PathVerdict>();
  const kept: string[] = [];
  const dropped: PathVerdict[] = [];
  for (const piece of body.split(separator)) {
    const named = toolName === "grep" ? GREP_BLOCK_PATH.exec(piece)?.[1] : piece;
    // Text this cannot attribute to a file is text about the search itself
    // ("No matches found for …"), and it names nothing to withhold.
    if (named === undefined || named === "") {
      kept.push(piece);
      continue;
    }
    let verdict = verdicts.get(named);
    if (verdict === undefined) {
      verdict = placePath(resolve(cwd, named), wall);
      verdicts.set(named, verdict);
    }
    // `glob` discloses the name only; `grep` discloses the bytes.
    const discloses = toolName === "grep" ? verdict !== "inside" : verdict === "outside";
    if (discloses) dropped.push(verdict);
    else kept.push(piece);
  }
  if (dropped.length === 0) return result;

  wall.report(
    `arcturn ${MCP_SERVE_COMMAND_NAME}: withheld ${dropped.length} ${toolName} result(s) from ` +
      `an ask_arcturn run — ${tally(dropped)}. The peer was told nothing about them.`,
  );
  const text = kept.length === 0 ? emptyResultText(toolName, input, cwd) : kept.join(separator);
  return {
    ...result,
    // The footer counts what the tool found, so it goes with the body it
    // annotates and is dropped when nothing is left to annotate.
    content: [{ type: "text", text: kept.length === 0 ? text : `${text}${note}` }],
    ...(result.details === undefined
      ? {}
      : { details: withheldDetails(result.details, dropped.length) }),
  };
}

/** `2 outside the workspace, 1 credential-shaped`, for the operator's log. */
function tally(dropped: readonly PathVerdict[]): string {
  const names: Record<string, string> = {
    outside: "outside the workspace",
    reserved: "arcturn's own",
    credential: "credential-shaped",
  };
  const counts = new Map<PathVerdict, number>();
  for (const verdict of dropped) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  return [...counts].map(([verdict, count]) => `${count} ${names[verdict] ?? verdict}`).join(", ");
}

/**
 * What the tool itself would have said had it found nothing.
 *
 * Byte-identical to `grep`'s and `glob`'s own empty answers, because anything
 * else turns "everything you matched was withheld" into a distinguishable
 * outcome — which is the membership oracle this whole filter exists to avoid.
 *
 * @param toolName - `grep` or `glob`.
 * @param input - The call's arguments, which is where the echoed pattern is.
 * @param cwd - The agent's working directory.
 */
function emptyResultText(toolName: string, input: Record<string, unknown>, cwd: string): string {
  if (toolName === "glob") return "No files matched.";
  const root = resolve(cwd, typeof input.path === "string" ? input.path : ".");
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  return `No matches found for /${pattern}/ under ${root}.`;
}

/**
 * The tool's structured details, corrected for what the peer was not shown.
 *
 * `matchCount` is one per rendered block for `grep`, so subtracting the dropped
 * blocks is exact; for `glob` it counts every match including ones past the
 * cap, so subtracting is a lower bound. Both move the number in the same
 * direction as the text, which is the property that matters: a count that
 * disagreed with the body would put the withheld hit back on the wire.
 *
 * @param details - The tool's own details.
 * @param withheld - How many results were dropped.
 */
function withheldDetails(
  details: Record<string, unknown>,
  withheld: number,
): Record<string, unknown> {
  const count = details.matchCount;
  if (typeof count !== "number") return details;
  return { ...details, matchCount: Math.max(0, count - withheld) };
}

/**
 * The path a name really points at, every symlink on the way resolved.
 *
 * Comparing paths lexically compares *names*, and a symlink is a second name
 * for someone else's directory, so the wall has to be physical or it is not a
 * wall. A path that does not exist yet is the normal case for a write, so the
 * walk climbs to the nearest ancestor that *does* exist, resolves that and
 * puts the missing tail back on — the leaf cannot be a symlink if it is not
 * there, but any of its parents can be. Nothing here creates, opens or writes
 * anything, and a path whose every component is missing resolves to itself,
 * which leaves the decision exactly where a lexical one would have left it.
 *
 * The climb stops at `stopAt`, whose physical spelling the caller already
 * knows, so a path just inside the workspace costs one failed `realpathSync`
 * and no walk above it.
 *
 * Duplicated from `workflow.ts`'s private helper of the same name rather than
 * imported: that module owns the `/workflow` lanes and is another agent's to
 * change. If a third caller ever needs this, it belongs in a shared module.
 *
 * @param value - Any path; relative ones resolve against the process cwd.
 * @param stopAt - An ancestor whose own physical spelling is already known.
 * @returns The absolute, symlink-free spelling of `value`.
 */
function physicalPath(value: string, stopAt?: string): string {
  const absolute = resolve(value);
  let existing = absolute;
  const missing: string[] = [];
  for (;;) {
    if (existing === stopAt) return join(existing, ...missing);
    try {
      const real = realpathSync(existing);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(existing);
      // `/` resolves or nothing does; either way stop rather than loop.
      if (parent === existing) return absolute;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Whether `path` is `root` or something below it, by name alone. */
function within(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Whether a repo-relative path names something in the workspace that is
 * arcturn's own rather than the repository's.
 *
 * The always-on read surface's half of {@link placePath}: `search_code` runs
 * with no permission mode and no agent, so nothing else would keep a peer from
 * reading a role file's standing prompt — or, under `--cwd ~`, this machine's
 * session transcripts — straight out of the index. Matched by *segment*, so a
 * checkout holding more than one project is covered.
 *
 * @param file - A hit's repo-relative, POSIX-separated path.
 * @param homePrefix - Where the arcturn home sits inside the workspace, if it
 *   does; `""` means the workspace *is* the arcturn home.
 */
function isReservedRepoPath(file: string, homePrefix: string | undefined): boolean {
  const posix = file.replaceAll("\\", "/");
  if (posix.split("/").includes(PROJECT_DIR_NAME)) return true;
  if (homePrefix === undefined) return false;
  return homePrefix === "" || posix === homePrefix || posix.startsWith(`${homePrefix}/`);
}

/**
 * Project stored entries into the transcript the server may disclose.
 *
 * Everything dropped here is dropped for one reason: a transcript is the
 * densest secret store in the whole session tree. Tool *results* carry the
 * bodies of every file the agent read; tool *arguments* carry the bodies of
 * every file it wrote, the bash commands it ran and the URLs it fetched —
 * query strings and all. Reasoning traces carry provider-signed blobs, and
 * images carry base64 megabytes. What is left is the part the question "what
 * did arcturn do here?" actually wants: what was asked, what was answered, and
 * which tools ran.
 */
export function projectTranscript(entries: readonly SessionEntry[]): McpTranscriptEntry[] {
  const projected: McpTranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text !== "") projected.push({ role: "user", text });
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const tools = message.content
      .filter((block): block is ToolCallContent => block.type === "toolCall")
      .map((block) => block.name);
    if (text === "" && tools.length === 0) continue;
    projected.push({
      role: "assistant",
      text,
      ...(tools.length === 0 ? {} : { tools }),
    });
  }
  return projected;
}

/**
 * Route `console` output to `sink` until the returned function is called.
 *
 * Not a general-purpose facility: it exists because stdout is the protocol on
 * this command, and one stray `console.log` from a loaded extension turns a
 * working session into a parse error at the client.
 */
function redirectConsole(sink: (line: string) => void): () => void {
  const methods = ["log", "info", "warn", "error", "debug", "trace", "dir"] as const;
  const saved = methods.map((name) => [name, console[name]] as const);
  const write = (...args: unknown[]): void => {
    sink(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };
  for (const name of methods) console[name] = write;
  return () => {
    for (const [name, original] of saved) {
      (console as unknown as Record<string, unknown>)[name] = original;
    }
  };
}

/**
 * The first few body lines of a chunk, for `detail: "snippets"`.
 *
 * Bounded by the same context window the interactive `search_code` renders, so
 * an MCP client and a session see the same amount of code for the same ask —
 * and so "snippets" can never widen into the whole-file read that `detail:
 * "full"` would have been.
 */
function snippetOf(body: string | undefined): { snippet?: string } {
  if (body === undefined || body === "") return {};
  const lines = body.split("\n");
  const shown = lines.slice(0, DEFAULT_CONTEXT_LINES * 2 + 1);
  const suffix = lines.length > shown.length ? `\n… ${lines.length - shown.length} more lines` : "";
  return { snippet: `${shown.join("\n")}${suffix}` };
}
