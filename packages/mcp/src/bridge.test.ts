import type { PermissionRequest, ToolExecutionContext } from "@arcturn/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { McpToolBridge, mcpToolFullName, sanitizeMcpName, toolResultFromMcp } from "./bridge.js";
import {
  ANNOTATED_TOOL,
  BOOM_TOOL,
  createTestServer,
  ECHO_TOOL,
  PROGRESS_TOOL,
  recordingPermissionRequester,
  SNAPSHOT_TOOL,
  STRUCTURED_ONLY_TOOL,
  STRUCTURED_PAYLOAD,
  STRUCTURED_WITH_TEXT_TOOL,
  stubPermissionRequester,
  type TestServerHandle,
} from "./test-support.js";

describe("sanitizeMcpName / mcpToolFullName", () => {
  it("passes through already-safe characters", () => {
    expect(sanitizeMcpName("my-server_1")).toBe("my-server_1");
  });

  it("replaces disallowed characters with underscores", () => {
    expect(sanitizeMcpName("my server!/v2")).toBe("my_server__v2");
  });

  it("builds the mcp__<server>__<tool> naming convention, sanitizing both parts", () => {
    expect(mcpToolFullName("weird server", "do thing")).toBe("mcp__weird_server__do_thing");
  });
});

describe("toolResultFromMcp", () => {
  it("maps text content through unchanged", () => {
    const result = toolResultFromMcp({ content: [{ type: "text", text: "hi" }] });
    expect(result).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
  });

  it("maps image content to ImageContent", () => {
    const result = toolResultFromMcp({
      content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    });
    expect(result.content).toEqual([{ type: "image", data: "YWJj", mimeType: "image/png" }]);
  });

  it("maps text resources to a text block with a uri header", () => {
    const result = toolResultFromMcp({
      content: [{ type: "resource", resource: { uri: "file:///a.txt", text: "contents" } }],
    });
    expect(result.content).toEqual([{ type: "text", text: "[resource file:///a.txt]\ncontents" }]);
  });

  it("maps binary resources to a placeholder text block", () => {
    const result = toolResultFromMcp({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///a.png", blob: "YWJj", mimeType: "image/png" },
        },
      ],
    });
    expect(result.content).toEqual([
      { type: "text", text: "[resource file:///a.png] (binary, image/png)" },
    ]);
  });

  it("JSON-stringifies unrecognized content types", () => {
    const result = toolResultFromMcp({
      // @ts-expect-error -- exercising an unrecognized block type at runtime
      content: [{ type: "audio", data: "YWJj", mimeType: "audio/wav" }],
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ type: "audio", data: "YWJj", mimeType: "audio/wav" }),
      },
    ]);
  });

  it("passes isError through", () => {
    const result = toolResultFromMcp({ content: [{ type: "text", text: "oops" }], isError: true });
    expect(result.isError).toBe(true);
  });

  it("passes structuredContent through unchanged when content blocks are present", () => {
    const result = toolResultFromMcp({
      content: [{ type: "text", text: "human-readable summary" }],
      structuredContent: STRUCTURED_PAYLOAD,
    });
    expect(result.content).toEqual([{ type: "text", text: "human-readable summary" }]);
    expect(result.structuredContent).toEqual(STRUCTURED_PAYLOAD);
  });

  it("synthesizes a JSON text fallback from structuredContent when there are no content blocks", () => {
    const result = toolResultFromMcp({ content: [], structuredContent: STRUCTURED_PAYLOAD });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(STRUCTURED_PAYLOAD) }]);
    expect(result.structuredContent).toEqual(STRUCTURED_PAYLOAD);
  });

  it("omits structuredContent entirely when the MCP result didn't include one", () => {
    const result = toolResultFromMcp({ content: [{ type: "text", text: "hi" }] });
    expect(result).not.toHaveProperty("structuredContent");
  });
});

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/tmp",
    signal: new AbortController().signal,
    requestPermission: stubPermissionRequester("allow"),
    onUpdate: () => {},
    sessionId: "session-1",
    toolCallId: "call-1",
    ...overrides,
  };
}

describe("McpToolBridge (end-to-end over InMemoryTransport)", () => {
  let handle: TestServerHandle;
  let client: Client;

  afterEach(async () => {
    await client?.close();
    await handle?.server.close();
  });

  async function connect(
    options: Parameters<typeof createTestServer>[0] = {},
  ): Promise<McpToolBridge> {
    handle = createTestServer(options);
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(handle.clientTransport);
    const bridge = new McpToolBridge("myserver", client);
    await bridge.refresh();
    return bridge;
  }

  it("bridges tool definitions with sanitized names and a server-prefixed description", async () => {
    const bridge = await connect();
    const tools = bridge.tools();
    const echo = tools.find((t) => t.definition.name === "mcp__myserver__echo");
    expect(echo).toBeDefined();
    expect(echo?.definition.description).toBe("[myserver] Echoes back its input arguments.");
    expect(echo?.definition.parameters).toMatchObject({ type: "object" });
  });

  it("executes a tool and returns its content when permission is allowed", async () => {
    const bridge = await connect();
    const echo = bridge.tools().find((t) => t.definition.name === "mcp__myserver__echo");
    const result = await echo?.execute({ message: "hello" }, makeCtx());
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }], isError: false });
  });

  it("returns isError without calling the tool when permission is denied", async () => {
    const bridge = await connect();
    const echo = bridge.tools().find((t) => t.definition.name === "mcp__myserver__echo");
    const result = await echo?.execute(
      { message: "hello" },
      makeCtx({ requestPermission: stubPermissionRequester("deny", "nope") }),
    );
    expect(result?.isError).toBe(true);
    expect(result?.content).toEqual([{ type: "text", text: "nope" }]);
  });

  it("surfaces a server-side isError result", async () => {
    const bridge = await connect();
    const boom = bridge.tools().find((t) => t.definition.name === "mcp__myserver__boom");
    const result = await boom?.execute({}, makeCtx());
    expect(result?.isError).toBe(true);
    expect(result?.content).toEqual([{ type: "text", text: "boom failed on purpose" }]);
  });

  it("maps image results", async () => {
    const bridge = await connect();
    const snapshot = bridge.tools().find((t) => t.definition.name === "mcp__myserver__snapshot");
    const result = await snapshot?.execute({}, makeCtx());
    expect(result?.isError).toBe(false);
    expect(result?.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("never throws: SDK/transport errors become isError results", async () => {
    const bridge = await connect();
    const echo = bridge.tools().find((t) => t.definition.name === "mcp__myserver__echo");
    await client.close();
    const result = await echo?.execute({ message: "hello" }, makeCtx());
    expect(result?.isError).toBe(true);
    expect(result?.content[0]).toMatchObject({ type: "text" });
  });

  it("follows pagination to exhaustion when refreshing the tool list", async () => {
    const bridge = await connect({
      initialTools: [ECHO_TOOL, BOOM_TOOL, SNAPSHOT_TOOL],
      toolPageSize: 1,
    });
    const names = bridge
      .tools()
      .map((t) => t.definition.name)
      .sort();
    expect(names).toEqual([
      "mcp__myserver__boom",
      "mcp__myserver__echo",
      "mcp__myserver__snapshot",
    ]);
  });

  it("bridges tool annotations onto the arcturn Tool", async () => {
    const bridge = await connect({ initialTools: [ANNOTATED_TOOL] });
    const annotated = bridge.tools().find((t) => t.definition.name === "mcp__myserver__annotated");
    expect(annotated?.annotations).toEqual({
      title: "Annotated Tool",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("includes an annotation-hint suffix in the permission request description", async () => {
    const bridge = await connect({ initialTools: [ANNOTATED_TOOL] });
    const annotated = bridge.tools().find((t) => t.definition.name === "mcp__myserver__annotated");
    const requests: Omit<PermissionRequest, "id">[] = [];
    await annotated?.execute(
      {},
      makeCtx({ requestPermission: recordingPermissionRequester(requests) }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.description).toContain('Call MCP tool "annotated" on server "myserver".');
    expect(requests[0]?.description).toContain("(server hints: read-only, idempotent)");
  });

  it("omits the annotation-hint suffix for tools without annotations", async () => {
    const bridge = await connect();
    const echo = bridge.tools().find((t) => t.definition.name === "mcp__myserver__echo");
    const requests: Omit<PermissionRequest, "id">[] = [];
    await echo?.execute(
      { message: "hi" },
      makeCtx({ requestPermission: recordingPermissionRequester(requests) }),
    );
    expect(requests[0]?.description).not.toContain("server hints");
  });

  it("passes structuredContent through to the ToolResult, with a text fallback when content is empty", async () => {
    const bridge = await connect({ initialTools: [STRUCTURED_ONLY_TOOL] });
    const tool = bridge.tools().find((t) => t.definition.name === "mcp__myserver__structuredOnly");
    const result = await tool?.execute({}, makeCtx());
    expect(result?.content).toEqual([{ type: "text", text: JSON.stringify(STRUCTURED_PAYLOAD) }]);
    expect(result?.structuredContent).toEqual(STRUCTURED_PAYLOAD);
  });

  it("does not duplicate the fallback text when the server sends both content and structuredContent", async () => {
    const bridge = await connect({ initialTools: [STRUCTURED_WITH_TEXT_TOOL] });
    const tool = bridge
      .tools()
      .find((t) => t.definition.name === "mcp__myserver__structuredWithText");
    const result = await tool?.execute({}, makeCtx());
    expect(result?.content).toEqual([{ type: "text", text: "human-readable summary" }]);
    expect(result?.structuredContent).toEqual(STRUCTURED_PAYLOAD);
  });

  it("wires MCP progress notifications through to ctx.onUpdate", async () => {
    const bridge = await connect({ initialTools: [PROGRESS_TOOL] });
    const tool = bridge.tools().find((t) => t.definition.name === "mcp__myserver__progress");
    const updates: { text?: string; details?: Record<string, unknown> }[] = [];
    const result = await tool?.execute({}, makeCtx({ onUpdate: (update) => updates.push(update) }));
    expect(result?.isError).toBe(false);
    expect(updates).toEqual([
      { text: "step 1", details: { progress: 1, total: 2 } },
      { text: "step 2", details: { progress: 2, total: 2 } },
    ]);
  });
});
