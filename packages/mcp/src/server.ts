/**
 * Arcturn as an MCP *server*: the inverse of the rest of this package.
 *
 * Everywhere else here, arcturn is the client — it connects out to servers it
 * chose, and their tools arrive namespaced `mcp__<server>__<tool>` and gated by
 * arcturn's own permission engine. This module points the same protocol the
 * other way: a foreign process (Claude Desktop, a second arcturn, any MCP
 * client) connects *in* and drives arcturn.
 *
 * ## Why the authority lives in a host, not here
 *
 * The peer on the other end of the pipe is a program nobody in this repository
 * wrote, speaking on behalf of a model, with no human approving individual
 * calls. So this module owns exactly one thing: the *shape* of what may be
 * asked. It validates every argument, closes every enum, caps every string and
 * every result, and refuses anything it does not recognise. It cannot read a
 * file, run a command, spend a token or resolve a path, because it holds no
 * capability to do any of those — every one of them arrives as a method on
 * {@link ArcturnMcpHost}, supplied by the CLI (`packages/cli/src/mcp-serve.ts`),
 * which is where the workspace boundary, the permission engine, the hooks and
 * the checkpoint store already live.
 *
 * That split is also the opt-in mechanism. `ask_arcturn` — the one tool that
 * makes arcturn *do* something rather than *answer* something — is advertised
 * if and only if {@link ArcturnMcpHost.askArcturn} exists. There is no boolean
 * to flip, no mode argument on the wire and no `initialize` option that widens
 * the surface: a read-only server is one whose host object does not carry the
 * function, so the authority is absent from the process rather than merely
 * disabled inside it. An MCP client therefore has no reachable path to escalate
 * its own permission mode, because permission mode is never a parameter it can
 * send.
 *
 * ## What is deliberately not here
 *
 * No `resources`, no `prompts`, no `logging`, no `completions`, no sampling and
 * no elicitation capability is advertised. Each is a channel that would let the
 * peer pull bytes out of, or push text into, a session on terms this module
 * does not control; the tool surface is small enough to reason about, and
 * everything a client needs is expressible on it.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool as McpToolDescriptor,
} from "@modelcontextprotocol/sdk/types.js";

import { withholdSensitive } from "./sensitive-paths.js";

/** Tool exposing the workspace code index. Always advertised. */
export const SEARCH_CODE_TOOL = "search_code";
/** Tool listing this workspace's stored sessions. Always advertised. */
export const LIST_SESSIONS_TOOL = "list_sessions";
/** Tool projecting one stored session into a transcript. Always advertised. */
export const READ_SESSION_TOOL = "read_session";
/** Tool prompting a real arcturn agent. Advertised only when the host grants it. */
export const ASK_ARCTURN_TOOL = "ask_arcturn";

/**
 * Ceilings on everything a client controls.
 *
 * These are not tuning knobs: each one closes a resource-exhaustion or
 * disclosure path that is otherwise unbounded, because the caller choosing the
 * number is the untrusted party. `MAX_RESULT_CHARS` in particular is the last
 * line — whatever a host returns, no single tool result leaves this process
 * larger than that.
 */
export const LIMITS = {
  /** Longest `query` / `path` filter accepted. */
  queryChars: 200,
  /** Longest `prompt` accepted by `ask_arcturn`. */
  promptChars: 20_000,
  /** Longest session id accepted, before the character-class check. */
  sessionIdChars: 128,
  /** `limit` ceiling for `search_code` and `list_sessions`. */
  listLimit: 50,
  /** Default `limit` when the client sends none. */
  defaultListLimit: 20,
  /** `limit` ceiling for `read_session`. */
  transcriptLimit: 200,
  /** Default transcript length. */
  defaultTranscriptLimit: 50,
  /** Longest single message body rendered into a transcript. */
  messageChars: 2_000,
  /**
   * Lines of body rendered for one `detail: "snippets"` hit.
   *
   * Deliberately below the host's own context window. `detail: "full"` was cut
   * so this tool could not become a bulk reader of arbitrary indexed paths, and
   * a snippet that is allowed to run to the end of a short chunk reopens that
   * door under a different name: for a file the index could not parse — a
   * config, a data file, anything holding a secret — the chunk *is* the file.
   * Four lines is an excerpt at any file length, and the window never slides,
   * so no number of calls widens it.
   */
  snippetLines: 4,
  /** Characters of body rendered for one hit, whichever cap bites first. */
  snippetChars: 320,
  /** Hard cap on the text of any one tool result. */
  resultChars: 60_000,
} as const;

/**
 * The index's whole-file fallback chunk kind.
 *
 * A hit of this kind is not a declaration inside a file, it is the file, so its
 * body is never excerpted: the address is the answer. See
 * {@link LIMITS.snippetLines}.
 */
const WHOLE_FILE_CHUNK_KIND = "file";

/** Detail levels a client may ask for. `full` is absent — see the tool description. */
export const SEARCH_DETAIL_LEVELS = ["signatures", "snippets"] as const;

/** One of {@link SEARCH_DETAIL_LEVELS}. */
export type SearchDetail = (typeof SEARCH_DETAIL_LEVELS)[number];

/** A validated `search_code` call. Every field is already range-checked. */
export interface McpSearchRequest {
  query: string;
  path?: string;
  kinds?: string[];
  limit: number;
  detail: SearchDetail;
}

/** One address returned by the index: never a file body, always a location. */
export interface McpSearchHit {
  /** Repository-relative path with POSIX separators. */
  path: string;
  /** 1-based line of the declaration. */
  line: number;
  kind: string;
  name: string;
  container?: string;
  /** Declaration line(s), collapsed. Present at both detail levels. */
  signature?: string;
  /** A few lines of body; present only when `detail: "snippets"` was asked for. */
  snippet?: string;
}

/** What the host found. What of it may be *said* is decided in `handleSearch`. */
export interface McpSearchOutcome {
  hits: McpSearchHit[];
  /**
   * How many chunks matched before the `limit` cap.
   *
   * Counted before withholding, and therefore never rendered verbatim: see
   * {@link WITHHOLDING_NOTICE} for why a total that moves with the credential
   * files a query happened to rank is the same oracle as a withheld count.
   */
  totalMatches: number;
  /**
   * Hits the host itself declined to disclose.
   *
   * Reported to the operator, never as a per-query number to the peer. A host
   * that filters silently would turn "credential file, not shown" into "no such
   * symbol in this repository", which is a worse answer than either — the
   * standing notice on every result is what keeps that from happening.
   */
  withheld?: number;
  /** True when the index was still being built as the query ran. */
  indexWarming?: boolean;
}

/** One stored session, as shown by `list_sessions`. */
export interface McpSessionSummary {
  sessionId: string;
  title?: string;
  /** Creation time as an ISO-8601 string; the host does the conversion. */
  createdAt: string;
}

/** One projected transcript line. Tool *results* and arguments never appear. */
export interface McpTranscriptEntry {
  role: "user" | "assistant";
  /** Message text, already free of images and reasoning traces. */
  text: string;
  /** Names of the tools this assistant turn called, in order. */
  tools?: string[];
}

/** A bounded projection of one session. */
export interface McpTranscript {
  sessionId: string;
  title?: string;
  entries: McpTranscriptEntry[];
  /** Entries dropped from the front because the transcript was longer than `limit`. */
  omitted: number;
}

/** A validated `ask_arcturn` call. */
export interface McpAskRequest {
  prompt: string;
}

/** What one agent run produced. */
export interface McpAskOutcome {
  text: string;
  /** Tool names the agent called, in order, with duplicates collapsed to counts. */
  tools: string[];
  turns: number;
  reason: "completed" | "aborted" | "error";
  errorMessage?: string;
  costUsd?: number;
}

/**
 * Every capability the server can offer, supplied by whoever launches it.
 *
 * A method that is absent is a tool that is never advertised — see this
 * module's header for why that is the opt-in mechanism rather than a flag.
 */
export interface ArcturnMcpHost {
  /** Declaration kinds the index understands, used to close the `kind` enum. */
  readonly chunkKinds: readonly string[];
  /** Rank workspace chunks for a query. Read-only; returns addresses, not bodies. */
  searchCode(request: McpSearchRequest, signal: AbortSignal): Promise<McpSearchOutcome>;
  /** Newest-first sessions stored for this workspace. */
  listSessions(limit: number): Promise<McpSessionSummary[]>;
  /** Project one session; the id has already been validated against a strict class. */
  readSession(sessionId: string, limit: number): Promise<McpTranscript>;
  /** Run a prompt through a real agent. Absent unless the operator opted in. */
  askArcturn?: (request: McpAskRequest, signal: AbortSignal) => Promise<McpAskOutcome>;
}

/** Construction options for {@link createArcturnMcpServer}. */
export interface ArcturnMcpServerOptions {
  host: ArcturnMcpHost;
  /** Advertised server identity. Defaults to `arcturn` at an unknown version. */
  serverInfo?: { name: string; version: string };
  /**
   * Where an unexpected failure's real message goes. Defaults to dropping it.
   *
   * It must not go to the client: an exception from the filesystem or from a
   * provider SDK carries absolute paths, environment names and occasionally a
   * URL with a token in it. The operator watching stderr may see all of that;
   * the peer may not.
   */
  onInternalError?: (toolName: string, error: unknown) => void;
  /**
   * Where the honest, per-query withholding numbers go. Defaults to dropping
   * them.
   *
   * They cannot go to the peer — a count that rises when the query matches a
   * credential file answers "is this string in your .env?" one bit at a time,
   * which is the question this whole module exists to refuse. The operator is
   * on the other side of that asymmetry: it is their workspace, so they may
   * have the number, and they are the only party who can act on a false
   * positive ("my `credentials.ts` stopped being searchable"). Same split as
   * {@link onInternalError}: real detail to the log, nothing to the pipe.
   */
  onWithheld?: (event: McpWithholdingEvent) => void;
}

/** How much one `search_code` call declined to disclose. Operator-facing only. */
export interface McpWithholdingEvent {
  /** Hits the host reported it had already filtered out. */
  hostWithheld: number;
  /**
   * Hits this server dropped from what the host handed over.
   *
   * Non-zero means the host's own filter did not run or does not agree with
   * this one — the defence-in-depth layer firing is a bug report, not routine.
   */
  serverWithheld: number;
}

/**
 * A failure the client is allowed to read verbatim.
 *
 * The dividing line matters: anything else thrown out of a handler — or out of
 * a {@link ArcturnMcpHost} method — is treated as an environment failure whose
 * message goes to the operator's log and never to the peer. A host that wants
 * to *explain* a refusal ("denied by a permission rule", "this server is
 * read-only") throws this instead, and accepts that the text crosses the pipe.
 */
export class McpRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRefusalError";
  }
}

const DEFAULT_SERVER_INFO = { name: "arcturn", version: "0.0.0" };

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Build the MCP server. Connect the returned object to a transport.
 *
 * @param options - See {@link ArcturnMcpServerOptions}.
 */
export function createArcturnMcpServer(options: ArcturnMcpServerOptions): Server {
  const { host } = options;
  const server = new Server(options.serverInfo ?? DEFAULT_SERVER_INFO, {
    // Tools only. Every other capability is a disclosure channel this server
    // does not want — see the module header.
    capabilities: { tools: {} },
    instructions:
      "Arcturn exposes its workspace code index and its stored session history. " +
      "search_code returns addresses (file:line), not file contents — read the file " +
      "yourself at the line it names. " +
      (host.askArcturn
        ? "ask_arcturn runs a real arcturn agent in this workspace under the permission " +
          "mode its operator started the server with; it cannot be widened from here."
        : "This server is read-only: it cannot edit files, run commands, or start an agent."),
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolDescriptors(host),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      switch (name) {
        case SEARCH_CODE_TOOL:
          return await handleSearch(host, args, extra.signal, options.onWithheld);
        case LIST_SESSIONS_TOOL:
          return await handleListSessions(host, args);
        case READ_SESSION_TOOL:
          return await handleReadSession(host, args);
        case ASK_ARCTURN_TOOL:
          return await handleAsk(host, args, extra.signal);
        default:
          // An unadvertised or misspelled name is the client's mistake, so it
          // gets a result rather than a protocol error — a model can read this
          // and correct itself, where a JSON-RPC error usually aborts the turn.
          return errorResult(
            `Unknown tool "${clip(String(name), 80)}". This server exposes: ` +
              `${toolDescriptors(host)
                .map((tool) => tool.name)
                .join(", ")}.`,
          );
      }
    } catch (error) {
      if (error instanceof McpRefusalError) return errorResult(error.message);
      // Everything else is a bug or an environment failure. The peer learns
      // that it failed and nothing about why.
      options.onInternalError?.(String(name), error);
      return errorResult(`"${clip(String(name), 80)}" failed. See the arcturn server's log.`);
    }
  });

  return server;
}

/** The advertised tool list, which depends only on which host methods exist. */
function toolDescriptors(host: ArcturnMcpHost): McpToolDescriptor[] {
  const tools: McpToolDescriptor[] = [
    {
      name: SEARCH_CODE_TOOL,
      description:
        "Search this workspace by symbol name or by meaning and get back ADDRESSES " +
        "(file:line) plus signatures — never whole file bodies. Backed by an offline " +
        "index that chunks source on declaration boundaries across TypeScript, " +
        "JavaScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP, C/C++, C#, Swift, shell " +
        "and Markdown. Identifiers are indexed split as well as whole, so `getUserById` " +
        'is found by "user id". Use it to find where something is DEFINED when you only ' +
        'half-remember the name, or to answer a structural question ("where is auth ' +
        'handled") before reading anything. Read the file yourself at the line returned.',
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A symbol name, or a few words describing the behaviour to find.",
            maxLength: LIMITS.queryChars,
          },
          path: {
            type: "string",
            description:
              "Restrict to files matching a glob ('src/**', '*.py') or containing a " +
              "substring ('/auth/'). Repo-relative, forward slashes, never absolute.",
            maxLength: LIMITS.queryChars,
          },
          kind: {
            description: "Restrict to one or more declaration kinds.",
            oneOf: [
              { type: "string", enum: [...host.chunkKinds] },
              { type: "array", items: { type: "string", enum: [...host.chunkKinds] } },
            ],
          },
          limit: {
            type: "integer",
            description: `Maximum hits. 1-${LIMITS.listLimit}, default ${LIMITS.defaultListLimit}.`,
            minimum: 1,
            maximum: LIMITS.listLimit,
          },
          detail: {
            type: "string",
            enum: [...SEARCH_DETAIL_LEVELS],
            description:
              `'signatures' (default) is one line per hit; 'snippets' adds up to ` +
              `${LIMITS.snippetLines} lines of a declaration's body. Whole bodies are not ` +
              "available over MCP, and a hit on a whole file (kind 'file') is always an " +
              "address only — read the file at the line returned instead.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: LIST_SESSIONS_TOOL,
      description:
        "List the arcturn sessions recorded for this workspace, newest first, with their " +
        "ids and titles. Pass an id to read_session to see what one of them did.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: `How many sessions. 1-${LIMITS.listLimit}, default ${LIMITS.defaultListLimit}.`,
            minimum: 1,
            maximum: LIMITS.listLimit,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: READ_SESSION_TOOL,
      description:
        "Read one recorded session as a transcript: what was asked, what arcturn " +
        "answered, and which tools each turn called. Tool ARGUMENTS and tool RESULTS are " +
        "not included — this answers 'what happened', not 'replay every byte'.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "A session id from list_sessions.",
            maxLength: LIMITS.sessionIdChars,
          },
          limit: {
            type: "integer",
            description:
              `How many of the most recent entries to return. 1-${LIMITS.transcriptLimit}, ` +
              `default ${LIMITS.defaultTranscriptLimit}.`,
            minimum: 1,
            maximum: LIMITS.transcriptLimit,
          },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];

  if (host.askArcturn) {
    tools.push({
      name: ASK_ARCTURN_TOOL,
      description:
        "Ask arcturn to work on something in this workspace. It runs as a real arcturn " +
        "agent with this workspace's tools, permission rules and lifecycle hooks, in the " +
        "permission mode the operator started this server with — which cannot be changed " +
        "from here. Anything the rules do not already allow is DENIED rather than " +
        "queued for approval, because nobody is watching this connection. Returns the " +
        "agent's answer and the names of the tools it ran.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What arcturn should do.",
            maxLength: LIMITS.promptChars,
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      // Truthful rather than reassuring: the operator may have started this
      // server in a mode where the agent can edit files.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    });
  }

  return tools;
}

// ------------------------------------------------------------------ handlers

/**
 * The one thing a `search_code` result ever says about withholding.
 *
 * WHY it is constant, and printed whether or not this query matched anything.
 * The line it replaces carried a count, and the count was computed *after* the
 * index had ranked the credential file — so `correcthorse` came back "1 result
 * withheld" and `wronghorse` came back with nothing, and a peer could read a
 * `.env` one guessed substring at a time over exactly the files the filter
 * exists to hide. Anything whose *presence, shape or number* varies with the
 * query is that same oracle, which is why the pre-filter `totalMatches` is no
 * longer rendered either: "2 shown of 5 matches" is a withheld count written as
 * subtraction, and a peer that sets `limit: 1` can push the credential hit off
 * the page and read the total on its own.
 *
 * Silent filtering was the defect this counter was introduced to fix, and that
 * fix is kept rather than reverted: an unconditional sentence tells every
 * caller, on every query, that "no matches" may mean "filtered" — the thing a
 * caller needs in order to stop concluding the file is absent from the
 * repository. It just says it without letting the workspace's contents modulate
 * it. The operator, who is entitled to the real numbers, gets them through
 * {@link ArcturnMcpServerOptions.onWithheld}.
 *
 * Wording note: no path, spelling or example that names a real filtered file
 * appears here — the notice must not itself become the disclosure.
 */
const WITHHOLDING_NOTICE =
  "Credential-shaped paths (dotenv files, private keys, SSH and cloud credential " +
  "stores) are never disclosed over MCP. Any results withheld for that reason are " +
  "not counted above, and this line is printed for every query — matched or not — " +
  "so it says nothing about what this workspace contains.";

/**
 * The body lines of one hit, bounded by {@link LIMITS.snippetLines}.
 *
 * @param snippet - Body text as the host rendered it.
 */
function snippetBodyLines(snippet: string): string[] {
  // `clip` marks its own cut, so only the line cap needs announcing here.
  const all = clip(snippet, LIMITS.snippetChars).split("\n");
  const shown = all.slice(0, LIMITS.snippetLines);
  if (all.length > shown.length) {
    shown.push("… snippet truncated — read the file at the address above.");
  }
  return shown;
}

async function handleSearch(
  host: ArcturnMcpHost,
  args: Record<string, unknown>,
  signal: AbortSignal,
  onWithheld?: (event: McpWithholdingEvent) => void,
): Promise<CallToolResult> {
  const query = requireString(args.query, "query", LIMITS.queryChars);
  const path = optionalString(args.path, "path", LIMITS.queryChars);
  if (path !== undefined && (path.includes("..") || /^([a-zA-Z]:)?[/\\]/.test(path))) {
    throw new McpRefusalError(
      "`path` must be a repo-relative filter — no leading separator and no '..'. " +
        "This server only ever searches its own workspace.",
    );
  }
  const kinds = parseKinds(args.kind, host.chunkKinds);
  const request: McpSearchRequest = {
    query,
    ...(path === undefined ? {} : { path }),
    ...(kinds === undefined ? {} : { kinds }),
    limit: parseLimit(args.limit, LIMITS.listLimit, LIMITS.defaultListLimit),
    detail: parseDetail(args.detail),
  };

  const outcome = await host.searchCode(request, signal);
  // Applied here as well as in the host: this is the boundary the bytes
  // actually cross, and a host that forgets must not turn a credential file
  // into a search result. See sensitive-paths.ts.
  const partition = withholdSensitive(outcome.hits);
  const kept = partition.kept;
  // The real numbers go to the operator's log and stop there. See
  // WITHHOLDING_NOTICE for what the peer is told instead.
  const hostWithheld = outcome.withheld ?? 0;
  if (hostWithheld > 0 || partition.withheld > 0) {
    onWithheld?.({ hostWithheld, serverWithheld: partition.withheld });
  }

  const lines: string[] = [];
  let wholeFileBodies = 0;
  if (kept.length === 0) {
    lines.push(`No matches for "${query}".`);
  } else {
    for (const hit of kept) {
      const where = hit.container ? `${hit.container}.${hit.name}` : hit.name;
      lines.push(`${hit.path}:${hit.line}  ${hit.kind} ${where}`);
      if (hit.signature) lines.push(`    ${clip(hit.signature, 300)}`);
      if (hit.snippet === undefined || hit.snippet === "") continue;
      // A whole-file chunk's body is the file, so it gets an address and
      // nothing else — `detail: "snippets"` must not be the whole-file read
      // that `detail: "full"` was cut for being. Everything else is a
      // declaration inside a file, and is excerpted.
      if (hit.kind === WHOLE_FILE_CHUNK_KIND) wholeFileBodies++;
      else for (const line of snippetBodyLines(hit.snippet)) lines.push(`    | ${line}`);
    }
    lines.push("");
    // Only what was actually disclosed is counted. `outcome.totalMatches`
    // counts pre-filter matches and stays in this process — see
    // WITHHOLDING_NOTICE.
    lines.push(
      `${kept.length} result${kept.length === 1 ? "" : "s"} shown — addresses, not bodies. ` +
        "Read a file at the line above for the rest.",
    );
    if (kept.length >= request.limit) {
      lines.push(`The \`limit\` of ${request.limit} was reached; raise it or narrow the query.`);
    }
    if (wholeFileBodies > 0) {
      lines.push(
        `${wholeFileBodies} of these are whole-file matches, shown as an address only: ` +
          "for a file the index stores as one chunk, a snippet would be the file.",
      );
    }
  }
  // Reported with a count, unlike the standing notice, because this counts a
  // *host* that handed over a credential path rather than anything about the
  // workspace: for a host that filters (every host in this repository) it is
  // always zero, so it cannot vary with the query, and when it is not zero the
  // caller is looking at a broken deployment and should hear the number.
  if (partition.withheld > 0) {
    lines.push(
      `${partition.withheld} result${partition.withheld === 1 ? "" : "s"} withheld: the host ` +
        "returned a credential-shaped path, which this server does not disclose. " +
        "Report this — the host was supposed to filter it first.",
    );
  }
  lines.push(WITHHOLDING_NOTICE);
  if (outcome.indexWarming === true) {
    lines.push("The index is still warming up — ask again for fuller coverage.");
  }
  return textResult(lines.join("\n"));
}

async function handleListSessions(
  host: ArcturnMcpHost,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const limit = parseLimit(args.limit, LIMITS.listLimit, LIMITS.defaultListLimit);
  const sessions = await host.listSessions(limit);
  if (sessions.length === 0) return textResult("No arcturn sessions recorded for this workspace.");
  const lines = sessions.map((session) => {
    const title = session.title ? `  ${clip(session.title, 120)}` : "";
    return `${session.sessionId}  ${session.createdAt}${title}`;
  });
  return textResult(lines.join("\n"));
}

async function handleReadSession(
  host: ArcturnMcpHost,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const sessionId = requireString(args.session_id, "session_id", LIMITS.sessionIdChars);
  // Checked before the host — and therefore before any path is built from it.
  // `arcturn blame` once shipped an arbitrary-file-read because an id from
  // outside was joined onto a directory unvalidated; the store validates too,
  // but a boundary that trusts a downstream check is not a boundary.
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new McpRefusalError(
      `Invalid session id. Ids are [A-Za-z0-9._-] only; use ${LIST_SESSIONS_TOOL} to get one.`,
    );
  }
  const limit = parseLimit(args.limit, LIMITS.transcriptLimit, LIMITS.defaultTranscriptLimit);
  const transcript = await host.readSession(sessionId, limit);

  const lines: string[] = [`session ${transcript.sessionId}`];
  if (transcript.title) lines.push(`title: ${clip(transcript.title, 200)}`);
  if (transcript.omitted > 0) {
    lines.push(`(${transcript.omitted} earlier entries omitted; raise limit to see more)`);
  }
  lines.push("");
  for (const entry of transcript.entries) {
    lines.push(`## ${entry.role}`);
    if (entry.text !== "") lines.push(clip(entry.text, LIMITS.messageChars));
    if (entry.tools && entry.tools.length > 0) lines.push(`[tools: ${entry.tools.join(", ")}]`);
    lines.push("");
  }
  return textResult(lines.join("\n"));
}

async function handleAsk(
  host: ArcturnMcpHost,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const ask = host.askArcturn;
  if (!ask) {
    // Reachable only if a client calls a name it was never offered.
    throw new McpRefusalError(
      `"${ASK_ARCTURN_TOOL}" is not available: this arcturn server was started read-only.`,
    );
  }
  const prompt = requireString(args.prompt, "prompt", LIMITS.promptChars);
  const outcome = await ask({ prompt }, signal);

  const lines = [outcome.text === "" ? "(the agent produced no text)" : outcome.text, ""];
  if (outcome.tools.length > 0) lines.push(`[tools run: ${outcome.tools.join(", ")}]`);
  lines.push(
    `[${outcome.turns} turn${outcome.turns === 1 ? "" : "s"}, ${outcome.reason}` +
      `${outcome.costUsd === undefined ? "" : `, $${outcome.costUsd.toFixed(4)}`}]`,
  );
  if (outcome.errorMessage !== undefined) lines.push(`[error: ${clip(outcome.errorMessage, 500)}]`);
  return textResult(lines.join("\n"), outcome.reason === "error");
}

// ------------------------------------------------------------- input parsing

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new McpRefusalError(`\`${field}\` is required and must be a non-empty string.`);
  }
  if (value.length > max) {
    throw new McpRefusalError(`\`${field}\` must be at most ${max} characters.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, field, max);
}

/**
 * Clamp a client-chosen `limit` into range.
 *
 * Out-of-range is clamped rather than rejected: the ceiling is the server's
 * business, and a model that asked for 1000 wants "as many as you will give
 * me", not an error turn. A non-number is rejected, because that is a bug in
 * the caller rather than an appetite.
 */
function parseLimit(value: unknown, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new McpRefusalError("`limit` must be a number.");
  }
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function parseKinds(value: unknown, allowed: readonly string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const kinds = raw.filter((item): item is string => typeof item === "string");
  const unknown = kinds.filter((kind) => !allowed.includes(kind));
  if (unknown.length > 0 || kinds.length !== raw.length) {
    throw new McpRefusalError(`\`kind\` must be one or more of: ${allowed.join(", ")}.`);
  }
  return kinds.length > 0 ? kinds : undefined;
}

function parseDetail(value: unknown): SearchDetail {
  if (value === undefined || value === null) return "signatures";
  if (typeof value === "string" && (SEARCH_DETAIL_LEVELS as readonly string[]).includes(value)) {
    return value as SearchDetail;
  }
  throw new McpRefusalError(
    `\`detail\` must be one of: ${SEARCH_DETAIL_LEVELS.join(", ")}. Whole file bodies are ` +
      "not available over MCP — read the file at the line a hit names.",
  );
}

// ------------------------------------------------------------------- results

/** Trim to `max` characters, marking the cut so nothing looks complete when it is not. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (truncated)`;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: clip(text, LIMITS.resultChars) }], isError };
}

function errorResult(text: string): CallToolResult {
  return textResult(text, true);
}
