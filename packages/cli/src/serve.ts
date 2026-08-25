/**
 * `arcturn serve` — expose this machine's Arcturn sessions over a WebSocket, so
 * another terminal (or another machine) can attach with `arcturn attach`.
 *
 * {@link runServe} wires a {@link ArcturnRuntime} (built by {@link buildRuntime}
 * in `runtime.ts`) into `@arcturn/server`'s {@link SessionHost} and
 * {@link ArcturnServer}: the runtime supplies the LLM client, resolved model,
 * system prompt, tool set and session store; `SessionHost` turns those into
 * one live {@link Agent} per connected session; `ArcturnServer` speaks the wire
 * protocol over `ws`.
 *
 * ## Threat model
 *
 * A connection that completes authentication (or, when no token is
 * configured, *any* connection) gets full tool execution as the user running
 * `arcturn serve` — the same `bash`, `write`, `edit` and network tools the local
 * CLI has, gated by the same permission rules. Holding the token is
 * equivalent to holding a shell as this user for anything the configured
 * permission mode allows. Treat the token like a credential: do not log it,
 * put it in shell history unquoted, or send it over an unencrypted channel
 * to an untrusted network — `arcturn serve` speaks plain `ws://`, not `wss://`,
 * so prefer binding loopback and tunnelling (SSH port-forward, Tailscale,
 * etc.) over exposing a non-loopback interface directly.
 *
 * With {@link RunServeOptions.web} a second, tiny HTTP listener also serves
 * the browser client (`web/page.ts`) — one self-contained page that speaks the
 * same wire protocol from a phone. It never serves the token: the page is
 * inert until someone supplies one, and the WebSocket handshake is what
 * authenticates. See `web/server.ts` and `docs/web-client.md`.
 *
 * A token is generated automatically whenever one is not supplied, on every
 * interface, including loopback: a same-machine login without a token would
 * otherwise let any other local user (or any process, browser tab, or
 * malware) connect and get full tool execution too — loopback narrows the
 * attack surface to "this machine" but does not make every process on it
 * trustworthy. Binding a non-loopback interface without a token at all is a
 * hard refusal: see {@link ServeBindError} and {@link resolveServeToken}.
 */

import { randomBytes } from "node:crypto";
import { calculateCostUsd } from "@arcturn/ai";
import { Agent } from "@arcturn/core";
import type { AgentFactoryOptions } from "@arcturn/server";
import { ArcturnServer, SessionHost } from "@arcturn/server";
import type {
  LLMClient,
  ModelSpec,
  PermissionMode,
  PermissionRule,
  SessionStore,
  Tool,
} from "@arcturn/types";
import { createCostGuard } from "./cost-guard.js";
import type { EnvMap } from "./paths.js";
import {
  type ArcturnRuntime,
  buildRuntime,
  compactionOptionsFor,
  modelCatalogEntries,
  registerBundledCatalog,
  resolveModelSpec,
} from "./runtime.js";
import { startWebClientServer, type WebClientServer, webClientOrigins } from "./web/server.js";

/**
 * Raised by {@link resolveServeToken} (and, transitively, {@link runServe})
 * when a caller asks to bind a non-loopback interface with authentication
 * explicitly disabled. See the module TSDoc for why this is a hard refusal.
 */
export class ServeBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeBindError";
  }
}

/**
 * Hosts treated as "this machine only". Matches what {@link ArcturnServer.start}
 * and Node's `http`/`ws` servers accept as a loopback bind address; a
 * hostname that merely *resolves* to loopback (e.g. a `/etc/hosts` entry) is
 * deliberately not treated as loopback here — the check is on the literal
 * bind argument, not a DNS lookup.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

/** Whether `host` is one of the recognised loopback bind addresses. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** Generate a random 32-hex-character shared-secret token. */
export function generateServeToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Resolve the token {@link runServe} hands to {@link ArcturnServer}.
 *
 * - `token` omitted → a fresh {@link generateServeToken} value, on every host
 *   (including loopback — see the module TSDoc).
 * - `token` a non-empty string → used as-is, on every host.
 * - `token` the empty string → an explicit "run without authentication"
 *   request. Honoured on a loopback host; rejected everywhere else.
 *
 * @param host - The interface `runServe` is about to bind.
 * @param token - The caller-supplied `--token` value, if any.
 * @throws {ServeBindError} When `token` is `""` and `host` is not loopback.
 */
export function resolveServeToken(host: string, token?: string): string | undefined {
  if (token === "") {
    if (!isLoopbackHost(host)) {
      throw new ServeBindError(
        `Refusing to bind ${host} without a token: anyone who can reach this port would get ` +
          `full tool execution as this user. Omit --token to auto-generate one, or bind a ` +
          `loopback address (127.0.0.1) instead.`,
      );
    }
    return undefined;
  }
  return token ?? generateServeToken();
}

/** Render a `ws://` URL, bracketing a literal IPv6 host. */
export function formatServeUrl(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ws://${bracketed}:${port}`;
}

/**
 * The minimal slice of {@link ArcturnRuntime} {@link createServeHost} needs to
 * turn one `AgentFactoryOptions` into an {@link Agent}. `ArcturnRuntime` already
 * satisfies this structurally — nothing in `runtime.ts` had to change.
 *
 * ### Known limitation
 *
 * `tools` and `systemPrompt` are read once, from the runtime's state at the
 * moment {@link createServeHost} is called; every served session shares that
 * one snapshot. In particular `tools` here is `ArcturnRuntime.tools`, which is
 * `this.agent.tools` on the runtime's *own* singleton agent — checkpoint-
 * wrapped against that agent's checkpoint store, not a per-served-session
 * one. Practically: `write`/`edit` calls from served sessions still work,
 * but their checkpoints land in the runtime's own session's checkpoint
 * directory rather than each served session's, so `/rewind`-style recovery
 * does not cleanly isolate concurrently served sessions from each other or
 * from the runtime's own. Likewise `cwd` is accepted per session
 * (`AgentFactoryOptions.cwd`) and threaded into the constructed `Agent`, but
 * the *tools themselves* were built once against `runtime.cwd` (inside
 * `buildRuntime`'s `createDefaultTools` call), so a served session opened
 * with a different `cwd` gets tools that still operate against the
 * runtime's original working directory.
 *
 * Fixing both precisely — a checkpoint store and a tool set built fresh per
 * served session — needs a method on `ArcturnRuntime` that mirrors its private
 * `#createAgent`/`#agentOptions` but is parameterized by `sessionId`/`cwd`
 * instead of closing over the runtime's singleton `this.checkpoints`; e.g.:
 *
 * ```ts
 * buildSessionAgent(opts: { sessionId: string; cwd: string; model?: string }): Agent
 * ```
 *
 * That is exactly `#createAgent`/`#agentOptions` today, minus the implicit
 * dependence on `this.agent`/`this.checkpoints`. This module does not add it
 * (editing `runtime.ts` was out of scope here) — it is the one accessor a
 * fully-correct multi-session server needs.
 */
export interface ServableRuntime {
  readonly llm: LLMClient;
  readonly model: ModelSpec;
  readonly cwd: string;
  readonly env: EnvMap;
  readonly store: SessionStore;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly config: { permissions: PermissionRule[]; permissionMode: PermissionMode };
  /**
   * Optional: build a fully isolated agent for one served session. A real
   * `ArcturnRuntime` provides it; stubs may omit it and get the generic assembly.
   */
  buildSessionAgent?: (options: { sessionId: string; cwd?: string; model?: ModelSpec }) => Agent;
  dispose(): Promise<void>;
}

/**
 * Wire a per-session USD cost ceiling directly onto one served `Agent`.
 *
 * `ArcturnRuntime`'s own `--max-cost` guard (`runtime.ts`'s `costGuard`) only
 * ever watches `runtime.agent` — the TUI/`--print` "live" agent — never the
 * agents `buildServedAgent` mints, so `arcturn serve` needs its own guard, scoped
 * to each agent's own event stream and its own `abort()`. Mirrors
 * `acp/host.ts`'s `attachCostGuard`, which has the identical gap for the same
 * reason (see `ACP-STATUS.md`).
 */
function attachCostGuard(agent: Agent, limitUsd: number): void {
  let spentUsd = 0;
  const guard = createCostGuard({
    limitUsd,
    getCostUsd: () => spentUsd,
    abort: () => agent.abort(),
    notify: (message) => {
      process.stderr.write(`arcturn serve: ${message} (session ${agent.sessionId})\n`);
    },
  });
  agent.subscribe((event) => {
    if (event.type === "turnEnd") {
      spentUsd += event.usage.costUsd ?? calculateCostUsd(agent.model, event.usage) ?? 0;
    }
    guard.onEvent(event);
  });
}

/**
 * The one place a wire-level model id becomes a real {@link ModelSpec} for a
 * served session.
 *
 * A model id is a label; a `ModelSpec` is the provider, endpoint and
 * credential the next request actually uses. Both wire routes that carry a
 * bare id — `createSession({ model })` and `setModel` — go through this
 * single function, against the same catalog and the same environment
 * `--list-models` and the `listModels` verb read, so a client can never pick
 * an id off the catalog and have it resolve to something else (or to
 * nothing) on the way in.
 *
 * `registerBundledCatalog` runs on every call rather than once at startup:
 * it is idempotent, and an extension may register a model after the server is
 * already up — the same reason `createServeHost`'s `modelCatalog` re-reads.
 *
 * @throws {ModelResolutionError} For an unknown id, or one whose provider key
 *   is not set. Callers surface it; nothing falls back to a guess.
 */
function serveModelResolver(env: EnvMap): (modelId: string) => ModelSpec {
  return (modelId) => {
    registerBundledCatalog();
    return resolveModelSpec(modelId, env);
  };
}

/** Build the `Agent` backing one served session. See {@link ServableRuntime}. */
function buildServedAgent(
  runtime: ServableRuntime,
  opts: AgentFactoryOptions,
  maxCostUsd: number | undefined,
  resolveModel: (modelId: string) => ModelSpec,
): Agent {
  const model = opts.model === undefined ? runtime.model : resolveModel(opts.model);
  // A real ArcturnRuntime builds a properly isolated agent — its own checkpoint
  // store keyed by this session, so one served session's /rewind never
  // touches another's files. The structural fallback below keeps this
  // function testable with a minimal stub runtime.
  const agent = runtime.buildSessionAgent
    ? runtime.buildSessionAgent({
        sessionId: opts.sessionId,
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        model,
      })
    : new Agent({
        llm: runtime.llm,
        model,
        systemPrompt: runtime.systemPrompt,
        tools: [...runtime.tools],
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        sessionStore: runtime.store,
        compaction: compactionOptionsFor(model),
        permissions: {
          mode: runtime.config.permissionMode,
          rules: [...runtime.config.permissions],
        },
      });
  if (maxCostUsd !== undefined) attachCostGuard(agent, maxCostUsd);
  return agent;
}

/**
 * Assemble a {@link SessionHost} around a runtime's LLM, model, tools and
 * session store.
 *
 * Exported (separately from {@link runServe}) so tests can exercise the
 * `SessionHost`/`ArcturnServer` wiring against a cheap, scripted runtime instead
 * of the full {@link buildRuntime} (config/extension/skill/MCP loading).
 *
 * @param runtime - Anything shaped like {@link ServableRuntime}; a real
 *   {@link ArcturnRuntime} satisfies this without modification.
 * @param options - `maxCostUsd` applies an independent `--max-cost`-style
 *   ceiling to each served session (see {@link buildServedAgent}'s
 *   `attachCostGuard`).
 */
export function createServeHost(
  runtime: ServableRuntime,
  options: { maxCostUsd?: number } = {},
): SessionHost {
  const resolveModel = serveModelResolver(runtime.env);
  return new SessionHost({
    agentFactory: (opts) => buildServedAgent(runtime, opts, options.maxCostUsd, resolveModel),
    sessionStore: runtime.store,
    defaultCwd: runtime.cwd,
    // ---- Model injection: both halves, deliberately adjacent. ----
    // These are one feature, not two. `modelCatalog` is what a remote picker
    // is *offered*; `resolveModel` is what a pick actually *does* — which
    // provider, which endpoint, which credential. They read the same catalog
    // and the same environment, and they sit together because wiring only one
    // is not a partial feature but a wrong one: a `setModel` that reaches a
    // host with no resolver used to be answered by a synthesized spec, which
    // sent the session's next prompt to whichever provider the guess named.
    //
    // The `listModels` verb answers from the same catalog `--list-models`
    // prints — `registerBundledCatalog` first, so the presets are in it, and
    // it is idempotent. Re-read on every call rather than snapshotted: an
    // extension may register a model after the server is already up.
    modelCatalog: () => {
      registerBundledCatalog();
      return modelCatalogEntries(runtime.env);
    },
    resolveModel,
  });
}

/** Options for {@link runServe}. */
export interface RunServeOptions {
  /** Working directory for the served runtime. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Interface to bind. Defaults to `"127.0.0.1"`. */
  host?: string;
  /** Port to bind, or omitted/`0` for an OS-assigned ephemeral port. */
  port?: number;
  /**
   * Shared-secret token clients must present. Omit to auto-generate one;
   * pass `""` to explicitly run without authentication (loopback only — see
   * {@link resolveServeToken}).
   */
  token?: string;
  /** Model id override, as accepted by `--model`. */
  model?: string;
  /**
   * USD cost ceiling applied independently to *each* served session (the
   * `--max-cost` equivalent for `arcturn serve`). Omit to disable. See
   * {@link createServeHost}.
   */
  maxCostUsd?: number;
  /**
   * Also serve the browser client (`web/page.ts`) over HTTP, so a phone or
   * another machine can drive a session without `arcturn attach`. Off by default:
   * it opens a second listener, and the same threat model applies — anyone who
   * can reach the WebSocket port *and* holds the token gets tool execution.
   */
  web?: boolean;
  /**
   * Port for the browser client's HTTP listener. Omitted (or `0`), the OS
   * picks one; the chosen port is reported as {@link RunServeResult.webUrl}.
   */
  webPort?: number;
  /**
   * Extra browser origins allowed to open the WebSocket, e.g.
   * `https://arcturn.my-tailnet.ts.net`. Loopback names, the bound address and
   * this machine's own LAN addresses are allowed automatically; a tunnel or
   * reverse-proxy hostname cannot be guessed and must be listed here. See
   * {@link webClientOrigins}.
   */
  webOrigins?: readonly string[];
}

/** What {@link runServe} hands back to its caller (`main.ts`). */
export interface RunServeResult {
  /** `ws://host:port` clients connect to. */
  url: string;
  /** The token clients must authenticate with, or `undefined` when disabled. */
  token: string | undefined;
  /**
   * `http://host:port` of the browser client, when {@link RunServeOptions.web}
   * asked for it. Deliberately token-free: append `#token=<token>` to hand
   * someone a one-tap link (a fragment is never sent to a server), or let the
   * page prompt for it.
   */
  webUrl?: string;
  /** Stop accepting connections, close every socket, and dispose the runtime. */
  stop: () => Promise<void>;
}

/**
 * Build a runtime and expose it over WebSocket.
 *
 * The token is resolved (and, for a non-loopback bind with no token,
 * refused) *before* the runtime is built, so a doomed invocation fails fast
 * without paying for config/extension/skill loading first.
 *
 * @throws {ServeBindError} See {@link resolveServeToken}.
 */
export async function runServe(options: RunServeOptions = {}): Promise<RunServeResult> {
  const host = options.host ?? "127.0.0.1";
  const token = resolveServeToken(host, options.token);

  const runtime: ArcturnRuntime = await buildRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  const sessionHost = createServeHost(
    runtime,
    options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd },
  );

  // The page server binds *first*: a browser always stamps an `Origin` on the
  // WebSocket upgrade, and `ArcturnServer` refuses every origin it was not given
  // at construction — which means it has to know the page's port already. The
  // reverse dependency (the page needs the socket's port) is resolved lazily,
  // per request, through the `wsPort` callback.
  let wsPort = 0;
  let web: WebClientServer | undefined;
  if (options.web === true) {
    try {
      web = await startWebClientServer({
        host,
        ...(options.webPort === undefined ? {} : { port: options.webPort }),
        wsPort: () => wsPort,
      });
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  const server = new ArcturnServer({
    sessionHost,
    ...(token === undefined ? {} : { token }),
    ...(web === undefined
      ? {}
      : { allowedOrigins: webClientOrigins(host, web.port, options.webOrigins ?? []) }),
  });

  let port: number;
  try {
    port = await server.start({
      host,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  } catch (error) {
    if (web) await web.stop();
    await runtime.dispose();
    throw error;
  }
  wsPort = port;

  let stopped = false;
  return {
    url: formatServeUrl(host, port),
    token,
    ...(web === undefined ? {} : { webUrl: web.url }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop();
      if (web) await web.stop();
      await runtime.dispose();
    },
  };
}
