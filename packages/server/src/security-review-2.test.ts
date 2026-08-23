/**
 * Adversarial security review #2 — server package.
 *
 * Each `it.fails` is a MINIMAL reproduction of a real enforcement gap; the
 * assertion states what a *correct* implementation would do, so the test fails
 * against the source as it stands. Do not weaken the assertions — fix the
 * source and flip `it.fails` to `it`.
 */

import { Agent } from "@arcturn/core";
import type { ServerMessage, Tool } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SessionHost } from "./session-host.js";
import { createScriptedLLM, TEST_MODEL, textTurn } from "./test-helpers/fake-llm.js";
import { createGuardedTool } from "./test-helpers/tools.js";
import { ArcturnServer } from "./ws-server.js";

const servers: ArcturnServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  for (const server of servers.splice(0)) await server.stop();
});

function buildSessionHost(tools: Tool[] = []): SessionHost {
  const llm = createScriptedLLM([textTurn("done")]);
  return new SessionHost({
    agentFactory: (opts) =>
      new Agent({
        llm,
        model: TEST_MODEL,
        systemPrompt: "You are a test agent.",
        tools,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
      }),
    defaultCwd: "/tmp/arcturn-ws-review2",
  });
}

async function startServer(host: SessionHost, token?: string): Promise<string> {
  const server = new ArcturnServer({
    sessionHost: host,
    ...(token === undefined ? {} : { token }),
  });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  return `ws://127.0.0.1:${port}`;
}

/** Connect, optionally forging the `Origin` header a browser would send. */
function connect(url: string, origin?: string): Promise<WebSocket> {
  const ws = new WebSocket(url, origin === undefined ? {} : { headers: { origin } });
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function collect(ws: WebSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString("utf8"))));
  return messages;
}

function responseFor(messages: readonly ServerMessage[], id: string): ServerMessage | undefined {
  return messages.find((message) => message.kind === "response" && message.id === id);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe("SERVE/ArcturnServer: the WebSocket upgrade is never Origin-checked", () => {
  it("a cross-origin browser connection must be refused in loopback no-token mode", async () => {
    // `resolveServeToken` (packages/cli/src/serve.ts) deliberately HONOURS
    // `--token ""` on a loopback host, on the stated reasoning that loopback
    // "narrows the attack surface to this machine". A browser breaks that
    // reasoning: WebSocket connections are exempt from CORS, so ANY web page
    // the user visits can open ws://127.0.0.1:<port> and drive this server.
    // `ArcturnServer.start` passes no `verifyClient`, and `#handleConnection`
    // never inspects the `Origin` header, so the handshake succeeds and the
    // attacker page gets full tool execution as the serving user.
    const host = buildSessionHost([createGuardedTool("shell")]);
    const url = await startServer(host); // token omitted == `arcturn serve --token ""`

    // The upgrade itself is refused, so the page never gets a socket at all.
    await expect(connect(url, "https://evil.example")).rejects.toThrow(/401|unexpected server/i);

    // A real client (no Origin header) still connects normally.
    const ws = await connect(url);
    const messages = collect(ws);
    ws.send(
      JSON.stringify({
        id: "1",
        method: "createSession",
        params: { cwd: "/tmp/arcturn-ws-review2" },
      }),
    );
    await settle();
    const response = responseFor(messages, "1");
    expect(response && response.kind === "response" && "result" in response).toBe(true);
  });

  it("a served session must not be rootable anywhere on disk by the client", async () => {
    // `createSession` takes `cwd` straight off the wire (it is in fact a
    // *required* protocol field) and `SessionHost.createSession` performs no
    // validation of any kind: not checked against `defaultCwd`, not required
    // to exist, not required to be inside the served workspace. Combined with
    // the CLI's per-session tools honouring `ctx.cwd`, a client picks the
    // filesystem root its session operates on.
    const host = buildSessionHost();
    const url = await startServer(host);
    const ws = await connect(url);
    const messages = collect(ws);

    ws.send(JSON.stringify({ id: "1", method: "createSession", params: { cwd: "/etc" } }));
    await settle();

    const response = responseFor(messages, "1");
    expect(response).toBeDefined();
    // A correct implementation confines a served session to the served
    // workspace (or at least refuses a cwd outside it).
    expect(response && response.kind === "response" && "result" in response).toBe(false);
  });
});
