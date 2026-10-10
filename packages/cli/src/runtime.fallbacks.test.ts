/**
 * `providers.anthropic.fallbacks` from config reaching the HTTP request.
 *
 * Builds a real runtime (no injected client) against a loopback server and
 * reads what the Anthropic SDK actually sent.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfigFile } from "./config.js";
import { buildRuntime } from "./runtime.js";
import { makeScratch } from "./test-helpers/scratch.js";

const SSE = [
  {
    type: "message_start",
    message: { id: "m", model: "x", usage: { input_tokens: 1, output_tokens: 0 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function requestFor(
  json: unknown,
): Promise<{ beta: unknown; body: Record<string, unknown> }> {
  const seen: { beta: unknown; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        beta: req.headers["anthropic-beta"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scratch = await makeScratch();
  try {
    const parsed = parseConfigFile(json, "user", "cfg", []);
    const runtime = await buildRuntime({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
      config: { ...DEFAULT_CONFIG, ...parsed },
      extensions: false,
      skipRepoLookup: true,
      sessionTitles: false,
      trustProject: true,
    });
    await runtime.agent.prompt("hello");
    await runtime.dispose();
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
  }
  const first = seen[0];
  if (!first) throw new Error("no request reached the server");
  return first;
}

describe("config: providers.anthropic.fallbacks", () => {
  it("puts the server-side-fallback beta on the wire when configured", async () => {
    const sent = await requestFor({ providers: { anthropic: { fallbacks: "default" } } });
    expect(String(sent.beta)).toContain("server-side-fallback-2026-07-01");
    expect(sent.body.fallbacks).toBe("default");
  });

  it("does not when it is not configured", async () => {
    const sent = await requestFor({});
    expect(String(sent.beta ?? "")).not.toContain("server-side-fallback");
    expect(sent.body).not.toHaveProperty("fallbacks");
  });
});
