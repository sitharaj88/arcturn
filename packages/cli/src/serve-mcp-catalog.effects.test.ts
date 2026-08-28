/**
 * The two thirds of MCP Arcturn was not using.
 *
 * A server publishes tools, **resources** and **prompt templates**. Until now
 * only tools crossed the wire, so a Figma server could be called but the frame
 * it offers could not be attached, and a Linear server's "triage this issue"
 * template was invisible. These tests run against a real MCP server rather
 * than a stub of one, because the claims are all about what a *remote* thing
 * said and what happened to it on the way in.
 *
 * The load-bearing claim is the sanitizing one. A resource description is text
 * a remote server wrote that lands in a menu a person reads and clicks — the
 * same problem a cloned repository's skill frontmatter poses, and it gets the
 * same answer. A test that only checked well-behaved servers would pass
 * against a projection that forwarded raw bytes, so the server here is
 * deliberately hostile in the ways a real one could be by accident.
 */

import { McpManager } from "@arcturn/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { mcpPromptList, mcpPromptRender, mcpResourceList, mcpResourceRead } from "./serve-mcp.js";

const managers: McpManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
});

interface ServerFixture {
  resources?: { uri: string; name?: string; description?: string; mimeType?: string }[];
  resourceTemplates?: {
    uriTemplate: string;
    name?: string;
    description?: string;
    mimeType?: string;
  }[];
  prompts?: {
    name: string;
    description?: string;
    arguments?: { name: string; description?: string; required?: boolean }[];
  }[];
}

/**
 * A manager wired to one in-process MCP server.
 *
 * The server is built here rather than borrowed from `@arcturn/mcp`'s
 * `test-support`, which is not in that package's `exports` — and adding a
 * test-only entry point to a published package to reach it would be a worse
 * trade than forty lines of server. `oauth-flow.effects.test.ts` builds its
 * own for the same reason.
 */
async function connect(fixture: ServerFixture = {}) {
  const server = new Server(
    { name: "design", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: fixture.resources ?? [],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: fixture.resourceTemplates ?? [],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
    contents: [
      { uri: request.params.uri, mimeType: "text/plain", text: "the document's own bytes" },
    ],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: fixture.prompts ?? [] }));
  server.setRequestHandler(GetPromptRequestSchema, (request) => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: `rendered ${request.params.name}` },
      },
    ],
  }));

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const manager = new McpManager(
    { servers: { design: { type: "stdio", command: "unused" } } },
    { transportFactory: () => clientTransport },
  );
  managers.push(manager);
  await manager.connect();
  return { manager, server };
}

describe("listing what a server publishes", () => {
  it("carries a resource's uri, name and type across", async () => {
    const { manager } = await connect({
      resources: [
        {
          uri: "figma://file/abc/frame/1",
          name: "Checkout frame",
          description: "The checkout screen, latest revision.",
          mimeType: "text/plain",
        },
      ],
    });

    const listing = await mcpResourceList(manager);
    expect(listing.resources).toEqual([
      {
        server: "design",
        uri: "figma://file/abc/frame/1",
        name: "Checkout frame",
        description: "The checkout screen, latest revision.",
        mimeType: "text/plain",
      },
    ]);
  });

  it("lists templates beside resources, which is the half the manager was missing", async () => {
    // `McpManager` had `listResources` and no `listResourceTemplates` — an
    // omission rather than a decision, and one this listing needs: a template
    // is how a server offers resources it generates on demand.
    const { manager } = await connect({
      resourceTemplates: [
        {
          uriTemplate: "figma://file/{fileKey}/frame/{nodeId}",
          name: "Any frame",
          mimeType: "text/plain",
        },
      ],
    });

    const listing = await mcpResourceList(manager);
    expect(listing.templates).toEqual([
      {
        server: "design",
        uriTemplate: "figma://file/{fileKey}/frame/{nodeId}",
        name: "Any frame",
        mimeType: "text/plain",
      },
    ]);
  });

  it("sorts by server then uri, so two reads of an unchanged engine compare equal", async () => {
    const { manager } = await connect({
      resources: [
        { uri: "figma://z", name: "Z" },
        { uri: "figma://a", name: "A" },
        { uri: "figma://m", name: "M" },
      ],
    });
    const listing = await mcpResourceList(manager);
    expect(listing.resources.map((entry) => entry.uri)).toEqual([
      "figma://a",
      "figma://m",
      "figma://z",
    ]);
  });

  it("answers empty for an engine with no MCP servers rather than failing", async () => {
    // An engine without MCP has no resources. That is a fact, not an error,
    // and it is the shape `mcpStatus` already uses.
    await expect(mcpResourceList(undefined)).resolves.toEqual({ resources: [], templates: [] });
    await expect(mcpPromptList(undefined)).resolves.toEqual({ prompts: [] });
  });
});

describe("text a remote server wrote, on its way into a menu", () => {
  const HOSTILE = {
    uri: "evil://resource",
    name: "Row one\nRow two",
    description: `First line, which is the only one that should survive.
Second line pretending to be another entry.
\u0007\u001b[31mAnd control characters.`,
  };

  it("keeps only the first line of a description", async () => {
    // A multi-line description in a list is a description that can be made to
    // look like several rows. Same treatment a skill's frontmatter gets.
    const { manager } = await connect({ resources: [HOSTILE] });
    const [entry] = (await mcpResourceList(manager)).resources;
    expect(entry?.description).toBe("First line, which is the only one that should survive.");
    expect(entry?.description).not.toContain("Second line");
  });

  it("collapses control characters, which a terminal would otherwise obey", async () => {
    const { manager } = await connect({ resources: [HOSTILE] });
    const [entry] = (await mcpResourceList(manager)).resources;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone is the point.
    expect(entry?.description ?? "").not.toMatch(/[\u0000-\u001f]/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: as above.
    expect(entry?.name ?? "").not.toMatch(/[\u0000-\u001f]/);
  });

  it("sanitizes the name too, not only the description", async () => {
    // The name is the label. A label with a newline in it is two labels.
    const { manager } = await connect({ resources: [HOSTILE] });
    const [entry] = (await mcpResourceList(manager)).resources;
    expect(entry?.name).toBe("Row one");
  });

  it("caps a description that would otherwise fill the menu", async () => {
    const { manager } = await connect({
      resources: [{ uri: "x://y", name: "n", description: "a".repeat(5_000) }],
    });
    const [entry] = (await mcpResourceList(manager)).resources;
    expect((entry?.description ?? "").length).toBeLessThan(500);
    expect(entry?.description).toMatch(/…$/);
  });

  it("sanitizes a prompt's description and its argument descriptions", async () => {
    // Arguments are rendered as form labels, which is the same surface with a
    // different name.
    const { manager } = await connect({
      prompts: [
        {
          name: "triage",
          description: "Triage an issue.\nAnd a second line.",
          arguments: [{ name: "issueId", description: "The id.\nAnd more.", required: true }],
        },
      ],
    });
    const [prompt] = (await mcpPromptList(manager)).prompts;
    expect(prompt?.description).toBe("Triage an issue.");
    expect(prompt?.arguments?.[0]).toEqual({
      name: "issueId",
      description: "The id.",
      required: true,
    });
  });
});

describe("reading a resource", () => {
  it("returns the server's content unsanitized, because truncating it would destroy it", async () => {
    // The opposite decision to the listing's, and deliberately: a schema or a
    // design document cut to its first line is not the thing the user asked
    // for. The wire type marks it untrusted instead, and rendering it as text
    // rather than markup is the client's rule to keep.
    const { manager } = await connect({
      resources: [{ uri: "db://schema", name: "Schema", mimeType: "text/plain" }],
    });

    const read = await mcpResourceRead(manager, "design", "db://schema");
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]?.uri).toBe("db://schema");
    expect(typeof read.contents[0]?.text).toBe("string");
  });

  it("fails loudly for a server that is not configured", async () => {
    const { manager } = await connect();
    await expect(mcpResourceRead(manager, "no-such-server", "x://y")).rejects.toThrow();
  });

  it("fails loudly with no MCP at all, rather than answering empty", async () => {
    // Unlike a *listing*, an empty read is a lie: the caller asked for one
    // specific document and would inject nothing while believing it had it.
    await expect(mcpResourceRead(undefined, "design", "x://y")).rejects.toThrow(
      /no MCP servers configured/i,
    );
  });
});

describe("rendering a prompt template", () => {
  it("flattens the server's messages to role and text", async () => {
    const { manager } = await connect({
      prompts: [{ name: "greet", description: "Say hello." }],
    });
    const rendered = await mcpPromptRender(manager, "design", "greet");
    expect(rendered.messages.length).toBeGreaterThan(0);
    for (const message of rendered.messages) {
      expect(typeof message.role).toBe("string");
      expect(typeof message.text).toBe("string");
    }
  });

  it("fails loudly with no MCP at all", async () => {
    await expect(mcpPromptRender(undefined, "design", "greet")).rejects.toThrow(
      /no MCP servers configured/i,
    );
  });
});
