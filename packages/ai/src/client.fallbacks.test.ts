/**
 * `fallbacks: "default"` reaching the wire through the public `createClient`.
 *
 * The adapter-level tests inject a fake SDK client; this one dials a real
 * loopback server, so what is asserted is the HTTP request the Anthropic SDK
 * actually sends: the beta header, the `?beta=true` surface and the body key.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { requireModel } from "./catalog.js";
import { createClient } from "./client.js";

interface Seen {
  url: string | undefined;
  beta: string | string[] | undefined;
  body: Record<string, unknown>;
}

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

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

async function listen(seen: Seen[]): Promise<string> {
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        beta: req.headers["anthropic-beta"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function ask(options: Parameters<typeof createClient>[0], id: string): Promise<void> {
  const client = createClient({ retry: false, apiKey: "sk-test", ...options });
  await client.complete({
    model: requireModel(id),
    system: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 }],
    maxOutputTokens: 100,
  });
}

describe("createClient fallbacks", () => {
  it("sends the beta header and the fallbacks body key when configured", async () => {
    const seen: Seen[] = [];
    const baseUrl = await listen(seen);
    await ask({ baseUrl, fallbacks: "default" }, "anthropic/claude-sonnet-5-5");
    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.beta)).toContain("server-side-fallback-2026-07-01");
    expect(seen[0]?.body.fallbacks).toBe("default");
  });

  it("sends neither when not configured", async () => {
    const seen: Seen[] = [];
    const baseUrl = await listen(seen);
    await ask({ baseUrl }, "anthropic/claude-sonnet-5-5");
    expect(String(seen[0]?.beta ?? "")).not.toContain("server-side-fallback");
    expect(seen[0]?.body).not.toHaveProperty("fallbacks");
  });

  it("never sends them to a model that has no server-side fallback", async () => {
    const seen: Seen[] = [];
    const baseUrl = await listen(seen);
    await ask({ baseUrl, fallbacks: "default" }, "anthropic/claude-haiku-5-5");
    expect(String(seen[0]?.beta ?? "")).not.toContain("server-side-fallback");
    expect(seen[0]?.body).not.toHaveProperty("fallbacks");
  });

  it("does not leak to anthropic-compatible endpoints, even for a spec that claims support", async () => {
    const seen: Seen[] = [];
    const baseUrl = await listen(seen);
    const client = createClient({ retry: false, apiKey: "sk-test", fallbacks: "default" });
    await client.complete({
      model: {
        ...requireModel("anthropic/claude-sonnet-5-5"),
        id: "gateway/claude-sonnet-5-5",
        provider: "anthropic-compatible",
        baseUrl,
      },
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 }],
      maxOutputTokens: 100,
    });
    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.beta ?? "")).not.toContain("server-side-fallback");
    expect(seen[0]?.body).not.toHaveProperty("fallbacks");
  });
});
