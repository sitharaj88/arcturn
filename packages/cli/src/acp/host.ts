/**
 * Wires a {@link ArcturnRuntime} into the ACP adapter's {@link AcpAgentDeps} seam,
 * so `createAcpAgent` (from `./adapter.js`) can drive arcturn's real agent loop —
 * tools, permissions, checkpoints, sessions — instead of the scripted event
 * arrays `acp.test.ts` uses.
 *
 * ## One `Agent` per ACP session
 *
 * ACP's `session/new` may be called more than once on the same connection —
 * an editor can hold several conversation threads open against one agent
 * process. `ArcturnRuntime` itself only ever tracks a single "live" agent
 * (`runtime.agent`, swapped by `startNewSession`/`resumeSession`), which
 * exists for the interactive TUI and `--print`, where there is exactly one
 * conversation at a time. Swapping it out from under a second `session/new`
 * would silently discard the first ACP session's entire conversation state.
 *
 * Instead this host uses {@link ArcturnRuntime.buildSessionAgent} — the same
 * primitive `../serve.ts` uses to host several concurrent `arcturn serve`
 * sessions off one runtime — which builds an independent {@link Agent} (its
 * own checkpoint store, own message history) without touching
 * `runtime.agent`. Each ACP `sessionId` maps to exactly one such agent for
 * the lifetime of the connection.
 *
 * ## Permission routing is genuinely per-session
 *
 * An earlier version of this host rebound `ArcturnRuntime`'s single
 * `setPermissionRequester` slot to the prompting session immediately before
 * that session's turn started — correct only as long as at most one turn was
 * ever in flight, and racy the moment two `session/prompt` calls on
 * different sessions genuinely overlapped (session B's turn could rebind the
 * slot mid-flight and steal session A's pending approval prompt, or vice
 * versa).
 *
 * This host closes that race by never touching the shared slot at all.
 * `ArcturnRuntime.buildSessionAgent` now accepts an `onPermissionAsk` bound to
 * one specific agent (see `runtime.ts`); {@link createAcpHost} supplies one
 * per session, built from the adapter's own `acp.permissionPrompt(sessionId)`
 * factory (wired in via {@link AcpHost.bindPermissions}) and captured in a
 * closure over that session's id at the moment the session's `Agent` is
 * constructed — never mutated afterwards, never shared with any other
 * session. Two sessions' turns can now genuinely overlap: each agent's own
 * `PermissionEngine` instance (see `@arcturn/core`'s `Agent#permissions`)
 * asks only its own bound requester, so a decision can never reach the wrong
 * session's dialog. `host.test.ts`'s "two sessions, overlapping turns, each
 * needing a permission decision" test is the regression guard for this.
 *
 * `arcturn serve` (`../serve.ts` via `@arcturn/server`'s `SessionHost`) never
 * had this bug: it already binds each served session's requester directly on
 * that agent's own `agent.permissions.setRequester(...)`, bypassing
 * `ArcturnRuntime` entirely. This host now does the equivalent thing through
 * `buildSessionAgent`'s new parameter instead of reaching into
 * `agent.permissions` directly, which keeps `ArcturnRuntime`'s speculative-edit
 * and permission-policy-learning integration (`#ask`'s `speculation.begin`/
 * `settle` and `policy.observe`) working for ACP sessions too — something
 * bypassing straight to `agent.permissions.setRequester` would silently drop.
 */

import { calculateCostUsd } from "@arcturn/ai";
import { Agent } from "@arcturn/core";
import type { McpManager } from "@arcturn/mcp";
import type {
  AgentEvent,
  McpConfig,
  McpServerConfig,
  Message,
  PermissionMode,
  PermissionPrompt,
  Usage,
} from "@arcturn/types";
import { createCostGuard } from "../cost-guard.js";
import { type ArcturnRuntime, compactionOptionsFor } from "../runtime.js";
import {
  type AcpAgentDeps,
  type AcpImplementationInfo,
  type AcpMcpServer,
  type AcpNewSessionParams,
  type AcpPromptRequest,
  type AcpSessionUpdate,
  type AcpSessionUsage,
  toolKindFor,
} from "./adapter.js";
import { AcpError } from "./protocol.js";

/** Options for {@link createAcpHost}. */
export interface AcpHostOptions {
  /** Identifies arcturn in the ACP `initialize` response. Defaults to `adapter.ts`'s own default. */
  agentInfo?: AcpImplementationInfo;
  /**
   * USD cost ceiling applied independently to *each* ACP session (the ACP
   * equivalent of `--max-cost`), since `ArcturnRuntime`'s own cost guard only
   * ever watches `runtime.agent` — the TUI/`--print` "live" agent that
   * `arcturn acp` never prompts. Omit to disable. See `ACP-STATUS.md` gap on
   * `--max-cost`.
   */
  maxCostUsd?: number;
}

/**
 * The {@link AcpAgentDeps} implementation {@link createAcpHost} returns, plus
 * the extra lifecycle methods `arcturn acp`'s command handler must call.
 */
export interface AcpHost extends AcpAgentDeps {
  /**
   * Supply the permission-prompt factory — `acp.permissionPrompt` from the
   * {@link AcpAgent} `createAcpAgent(host)` returns.
   *
   * Wiring this is mandatory for gated tools to work at all: without it,
   * every session agent is built with no `onPermissionAsk` override, falls
   * back to `ArcturnRuntime`'s shared slot (see `runtime.ts`'s `#ask`), and that
   * slot fails closed (every check auto-denies) unless something else has
   * separately called `runtime.setPermissionRequester`.
   *
   * Must be called before the first `session/new` reaches this host — which
   * `main.ts`'s `runAcpCommand` guarantees by calling it before
   * `connection.listen()`. A session created earlier than this call (only
   * reachable by calling {@link AcpHost.createSession} directly, as some
   * tests do) is retroactively bound via that agent's own
   * `agent.permissions.setRequester(...)` once the factory arrives — correct
   * for routing, but forgoes `ArcturnRuntime`'s speculation/policy-learning
   * integration for that one session, since that integration lives in
   * `runtime.ts`'s `#ask` and is only reachable through the
   * `onPermissionAsk` constructor option, not a post-hoc `setRequester`.
   */
  bindPermissions(factory: (sessionId: string) => PermissionPrompt): void;
  /**
   * Tear down every per-session MCP connection this host opened (see gap 2
   * in `ACP-STATUS.md`). `arcturn acp`'s command handler calls this once, before
   * `runtime.dispose()`, when the ACP connection ends. Safe to call more than
   * once; a session with no MCP servers is a no-op.
   */
  dispose(): Promise<void>;
}

/** Convert one ACP `mcpServers` entry into a `@arcturn/mcp` server config. */
function toStdioServerConfig(server: AcpMcpServer, cwd: string): McpServerConfig {
  return {
    type: "stdio",
    command: server.command,
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.env === undefined
      ? {}
      : { env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])) }),
    cwd,
  };
}

/** Convert a materialized message list into replayable ACP `session/update`s, in order. */
function replayUpdatesFor(messages: readonly Message[]): AcpSessionUpdate[] {
  const updates: AcpSessionUpdate[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.length > 0) {
          updates.push({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: block.text },
          });
        }
      }
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.length > 0) {
          updates.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: block.text },
          });
        } else if (block.type === "thinking" && block.thinking.length > 0) {
          updates.push({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: block.thinking },
          });
        } else if (block.type === "toolCall") {
          // History: the call already ran. `status` is corrected below if a
          // matching `toolResult` message follows, exactly like the live
          // TurnMapper's `toolStart` → `toolEnd` pair, just replayed at once.
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId: block.id,
            title: block.name,
            kind: toolKindFor(block.name),
            status: "completed",
            rawInput: block.arguments,
          });
        }
      }
      continue;
    }
    // message.role === "toolResult"
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: message.toolCallId,
      status: message.isError ? "failed" : "completed",
      ...(text.length > 0
        ? { content: [{ type: "content" as const, content: { type: "text" as const, text } }] }
        : {}),
    });
  }
  return updates;
}

/**
 * Build the {@link AcpAgentDeps} that let `createAcpAgent` drive a real
 * {@link ArcturnRuntime}.
 *
 * The runtime is not disposed by this host — `arcturn acp`'s command handler
 * owns `buildRuntime`/`runtime.dispose()` and this file never calls either.
 *
 * @param runtime - A runtime from `buildRuntime`.
 * @param options - Agent identification and per-session cost ceiling.
 */
export function createAcpHost(runtime: ArcturnRuntime, options: AcpHostOptions = {}): AcpHost {
  const sessions = new Map<string, Agent>();
  const sessionMcp = new Map<string, McpManager>();
  let permissionPromptFactory: ((sessionId: string) => PermissionPrompt) | undefined;

  function requireSession(sessionId: string): Agent {
    const agent = sessions.get(sessionId);
    if (!agent) {
      // `adapter.ts` always calls `createSession` (via `session/new`) before
      // it can route a `session/prompt` to this `sessionId`, so reaching
      // this means the host and the adapter have disagreed about a session's
      // lifetime — a bug, not a client mistake worth a quieter message.
      throw new Error(`arcturn acp: no session agent is tracked for sessionId "${sessionId}".`);
    }
    return agent;
  }

  /** Connect an ACP `session/new`/`session/load`'s `mcpServers`, merging their tools in. */
  async function connectSessionMcp(
    sessionId: string,
    cwd: string,
    servers: readonly AcpMcpServer[] | undefined,
    agent: Agent,
  ): Promise<void> {
    if (!servers || servers.length === 0) return;
    const config: McpConfig = {
      servers: Object.fromEntries(servers.map((s) => [s.name, toStdioServerConfig(s, cwd)])),
    };
    // Loaded on demand: the MCP SDK is a heavy import that sessions without
    // their own servers should never pay for.
    const { McpManager: Manager } = await import("@arcturn/mcp");
    const manager = new Manager(config, { clientInfo: { name: "arcturn-acp", version: "0.1.0" } });
    await manager.connect();
    for (const [name, status] of Object.entries(manager.status())) {
      if (status.state === "failed") {
        process.stderr.write(
          `arcturn acp: session-scoped MCP server "${name}" (session ${sessionId}) failed: ` +
            `${status.error ?? "unknown error"}\n`,
        );
      }
    }
    sessionMcp.set(sessionId, manager);
    // Appended, not wrapped: these bypass ArcturnRuntime's hook/checkpoint/taint/
    // canary wrapping chain, which lives behind private runtime.ts state this
    // host cannot reach. Permission gating still applies — it is intrinsic to
    // Agent's tool-call loop (`PermissionEngine.check`), not one of those
    // wrapping layers. See ACP-STATUS.md gap 2.
    agent.setTools([...agent.tools, ...manager.tools()]);
  }

  /**
   * Wire a per-session USD cost ceiling, mirroring `runtime.ts`'s own cost
   * guard but scoped to one agent's own event stream and own `abort()`.
   *
   * `spentUsd` starts at `0` and only accumulates spend from *this*
   * process's lifetime for this agent — it does not add up a `session/load`-
   * resumed session's historical cost from before this process started. That
   * matches `ArcturnRuntime`'s own `--max-cost` guard, whose `runtime.metrics`
   * is reset to `0` by every session swap (`resumeSession` included, via
   * `#swap`), not just a brand-new session.
   */
  function attachCostGuard(agent: Agent, limitUsd: number): void {
    let spentUsd = 0;
    const guard = createCostGuard({
      limitUsd,
      getCostUsd: () => spentUsd,
      abort: () => agent.abort(),
      notify: (message) => {
        process.stderr.write(`arcturn acp: ${message} (session ${agent.sessionId})\n`);
      },
    });
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "turnEnd") {
        spentUsd += event.usage.costUsd ?? calculateCostUsd(agent.model, event.usage) ?? 0;
      }
      guard.onEvent(event);
    });
  }

  /** Bind (or rebind) one session's own `PermissionEngine` requester directly. */
  function rebindPermissions(sessionId: string, agent: Agent): void {
    if (!permissionPromptFactory) return;
    agent.permissions.setRequester(permissionPromptFactory(sessionId));
  }

  /** Finish registering a freshly built session agent: MCP, cost guard, bookkeeping. */
  async function register(
    sessionId: string,
    cwd: string,
    mcpServers: readonly AcpMcpServer[] | undefined,
    agent: Agent,
  ): Promise<void> {
    sessions.set(sessionId, agent);
    if (options.maxCostUsd !== undefined) attachCostGuard(agent, options.maxCostUsd);
    await connectSessionMcp(sessionId, cwd, mcpServers, agent);
  }

  return {
    ...(options.agentInfo === undefined ? {} : { agentInfo: options.agentInfo }),

    async createSession(params: AcpNewSessionParams, sessionId: string): Promise<void> {
      const agent = runtime.buildSessionAgent({
        sessionId,
        cwd: params.cwd,
        ...(permissionPromptFactory ? { onPermissionAsk: permissionPromptFactory(sessionId) } : {}),
      });
      await register(sessionId, params.cwd, params.mcpServers, agent);
    },

    async loadSession(
      params: { sessionId: string; cwd: string; mcpServers?: AcpMcpServer[] },
      replay: (update: AcpSessionUpdate) => void,
    ): Promise<void> {
      let resumed: Agent;
      try {
        resumed = await Agent.resume({
          llm: runtime.llm,
          model: runtime.model,
          systemPrompt: runtime.systemPrompt,
          // `runtime.tools` is `ArcturnRuntime.agent.tools` — the runtime's own
          // live agent's fully wrapped tool set (hooks, checkpoints, taint,
          // canary). Checkpoints in particular are keyed to *that* agent's
          // session, not this one, exactly the trade-off `../serve.ts`'s own
          // `ServableRuntime` fallback documents and accepts. Building a
          // properly session-scoped wrapped tool set needs the same private
          // `runtime.ts` state `buildSessionAgent` closes over, which is out
          // of this pass's authorized `runtime.ts` edit scope (permission
          // requester and `--max-cost` only) — see ACP-STATUS.md.
          tools: [...runtime.tools],
          cwd: params.cwd,
          sessionId: params.sessionId,
          sessionStore: runtime.store,
          compaction: compactionOptionsFor(runtime.model),
          permissions: {
            mode: runtime.permissionMode,
            rules: [...runtime.config.permissions],
          },
          ...(permissionPromptFactory
            ? { onPermissionAsk: permissionPromptFactory(params.sessionId) }
            : {}),
        });
      } catch (error) {
        throw AcpError.invalidParams(
          `arcturn acp: could not load session "${params.sessionId}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Spec: "The Agent replays conversation history via session/update
      // notifications before responding to session/load." `resumed.messages`
      // is the exact branch `Agent.resume` just materialized, so the replay
      // matches what the live agent actually remembers on the next prompt —
      // no separate, potentially-diverging materialization of our own.
      for (const update of replayUpdatesFor(resumed.messages)) replay(update);
      await register(params.sessionId, params.cwd, params.mcpServers, resumed);
    },

    getPermissionMode(sessionId: string): PermissionMode {
      return requireSession(sessionId).permissionMode;
    },

    setPermissionMode(sessionId: string, mode: PermissionMode): void {
      requireSession(sessionId).setPermissionMode(mode);
    },

    sessionUsage(sessionId: string, usage: Usage): AcpSessionUsage | undefined {
      const agent = sessions.get(sessionId);
      // A turn cannot end for a session this host does not track; answering
      // `undefined` rather than throwing keeps a stray event from failing an
      // otherwise-fine prompt over a purely cosmetic notification.
      if (!agent) return undefined;
      // `costUsd` when the provider reported it, priced from the model's own
      // catalog entry otherwise — the same order `attachCostGuard` uses, so
      // the editor's running total and the `--max-cost` guard cannot disagree.
      const costUsd = usage.costUsd ?? calculateCostUsd(agent.model, usage);
      return {
        contextWindow: agent.model.contextWindow,
        ...(costUsd === undefined ? {} : { costUsd }),
      };
    },

    async prompt(request: AcpPromptRequest, onEvent: (event: AgentEvent) => void): Promise<void> {
      const agent = requireSession(request.sessionId);
      const unsubscribe = agent.subscribe(onEvent);
      try {
        await agent.prompt(request.text);
      } finally {
        unsubscribe();
      }
    },

    abort(sessionId: string): void {
      sessions.get(sessionId)?.abort();
    },

    bindPermissions(factory: (sessionId: string) => PermissionPrompt): void {
      permissionPromptFactory = factory;
      // Sessions created before this call (see the JSDoc on
      // `AcpHost.bindPermissions`) get a best-effort retroactive bind.
      for (const [sessionId, agent] of sessions) rebindPermissions(sessionId, agent);
    },

    async dispose(): Promise<void> {
      const managers = [...sessionMcp.values()];
      sessionMcp.clear();
      await Promise.all(managers.map((manager) => manager.close()));
    },
  };
}
